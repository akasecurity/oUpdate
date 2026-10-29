import { describe, expect, test } from "bun:test";
import { prepass, starMatch, STAR_PATTERN_MAX, type FileMap } from "../src/prepass.ts";

const enc = (s: string) => new TextEncoder().encode(s);
const files = (o: Record<string, string>): FileMap => new Map(Object.entries(o).map(([k, v]) => [k, enc(v)]));

describe("prepass: python", () => {
  const base = files({
    "litellm/__init__.py": "VERSION = '1.0.0'\n",
    "pyproject.toml": "[project]\nname = 'x'\n",
  });

  test("an unchanged-shape bump has no hard signals", () => {
    const next = files({
      "litellm/__init__.py": "VERSION = '1.0.1'\n",
      "pyproject.toml": "[project]\nname = 'x'\n",
    });
    const r = prepass("pypi", base, next);
    expect(r.hard).toEqual([]);
  });

  test("a new .pth at the root is hard", () => {
    const next = files({ ...Object.fromEntries([...base].map(([k, v]) => [k, new TextDecoder().decode(v)])), "cook.pth": "import cook\n" });
    const r = prepass("pypi", base, next);
    expect(r.hard.map((s) => s.kind)).toContain("startup-hook");
    expect(r.hard.find((s) => s.kind === "startup-hook")?.path).toBe("cook.pth");
  });

  test("sitecustomize.py and usercustomize.py are hard wherever they appear", () => {
    const next = files({ "litellm/__init__.py": "", "pyproject.toml": "", "sitecustomize.py": "", "pkg/usercustomize.py": "" });
    const r = prepass("pypi", base, next);
    const paths = r.hard.filter((s) => s.kind === "startup-hook").map((s) => s.path).sort();
    expect(paths).toEqual(["pkg/usercustomize.py", "sitecustomize.py"]);
  });

  test("a .pth inside a wheel .data/purelib dir is hard", () => {
    const next = files({ "x-1.0.data/purelib/evil.pth": "import os" });
    expect(prepass("pypi", base, next).hard.map((s) => s.kind)).toContain("startup-hook");
  });

  test("a new data/include directive in pyproject is hard", () => {
    const next = files({ "litellm/__init__.py": "", "pyproject.toml": "[project]\nname = 'x'\n[tool.x]\ndata = \"cook\"\n" });
    const r = prepass("pypi", base, next);
    expect(r.hard.map((s) => s.kind)).toContain("build-include");
  });

  test("an existing .pth that was already there is soft, not hard", () => {
    const old = files({ "x.pth": "a" });
    const next = files({ "x.pth": "b" });
    const r = prepass("pypi", old, next);
    expect(r.hard).toEqual([]);
    expect(r.soft.map((s) => s.kind)).toContain("startup-hook-changed");
  });
});

describe("prepass: npm", () => {
  const pkg = (scripts: Record<string, string>) => JSON.stringify({ name: "x", version: "1.0.0", scripts });

  test("a new install script is hard", () => {
    const r = prepass("npm", files({ "package/package.json": pkg({}) }), files({ "package/package.json": pkg({ postinstall: "node x.js" }) }));
    expect(r.hard.map((s) => s.kind)).toContain("install-script");
  });

  test("a changed install script is hard", () => {
    const r = prepass(
      "npm",
      files({ "package/package.json": pkg({ install: "node-gyp rebuild" }) }),
      files({ "package/package.json": pkg({ install: "curl x | sh" }) }),
    );
    expect(r.hard.map((s) => s.kind)).toContain("install-script");
  });

  test("an unchanged install script is not flagged", () => {
    const r = prepass(
      "npm",
      files({ "package/package.json": pkg({ install: "node ok.js" }) }),
      files({ "package/package.json": pkg({ install: "node ok.js" }) }),
    );
    expect(r.hard).toEqual([]);
  });

  test("non-install scripts are ignored", () => {
    const r = prepass("npm", files({ "package/package.json": pkg({}) }), files({ "package/package.json": pkg({ test: "bun test" }) }));
    expect(r.hard).toEqual([]);
  });

  test("a followed install script is hard when the script it runs changes", () => {
    const body = (setup: string) => pkg({ postinstall: "npm run setup", setup });
    const r = prepass("npm", files({ "package/package.json": body("node a.js") }), files({ "package/package.json": body("node evil.js") }));
    expect(r.hard.map((s) => s.kind)).toContain("install-script");
  });

  test("an unchanged followed install script is not flagged", () => {
    const body = pkg({ postinstall: "npm run setup", setup: "node a.js" });
    expect(prepass("npm", files({ "package/package.json": body }), files({ "package/package.json": body })).hard).toEqual([]);
  });

  test("run-s and a package field inside an install script are followed", () => {
    const body = (bin: string) => JSON.stringify({ name: "x", config: { bin }, scripts: { postinstall: "run-s build", build: "node $npm_package_config_bin" } });
    const r = prepass("npm", files({ "package/package.json": body("a.js") }), files({ "package/package.json": body("evil.js") }));
    expect(r.hard.map((s) => s.kind)).toContain("install-script");
  });

  test("a run-s glob with many stars finishes quickly and still matches", () => {
    const glob = "*a".repeat(12);
    const scripts: Record<string, string> = { postinstall: `run-s ${glob} build:*`, "build:js": "node a.js" };
    for (let i = 0; i < 40; i++) scripts[`${"a".repeat(16 + i)}b`] = "node ok.js";
    const old = JSON.stringify({ name: "x", scripts });
    const now = JSON.stringify({ name: "x", scripts: { ...scripts, "build:js": "node evil.js" } });
    const t = performance.now();
    const r = prepass("npm", files({ "package/package.json": old }), files({ "package/package.json": now }));
    expect(performance.now() - t).toBeLessThan(100);
    expect(r.hard.map((s) => s.kind)).toContain("install-script");
  });

  test("a star pattern past the cap matches nothing", () => {
    expect(starMatch("*".repeat(STAR_PATTERN_MAX + 1), "aaaa")).toBe(false);
    expect(starMatch("*", "a/b")).toBe(true);
    expect(starMatch("*a".repeat(12), `${"a".repeat(20)}b`)).toBe(false);
    expect(starMatch("*a".repeat(12), `${"a".repeat(20)}a`)).toBe(true);
  });

  test("a version bump with the same install hook is not flagged", () => {
    const old = JSON.stringify({ name: "x", version: "1.0.0", scripts: { postinstall: "node hook.js" } });
    const now = JSON.stringify({ name: "x", version: "1.0.1", scripts: { postinstall: "node hook.js" } });
    expect(prepass("npm", files({ "package/package.json": old }), files({ "package/package.json": now })).hard).toEqual([]);
  });

  test("a script an install hook reaches through another runner is hard when it changes", () => {
    const hooks = [
      "yarn run setup",
      "pnpm --silent run setup",
      "bun run setup",
      "npm rum setup",
      "npm urn setup",
      "npm --prefix . run setup",
      "npm --silent run setup",
      "npm-run-all setup",
      "npm-run-all --max-parallel 1 setup",
      "npm start",
      "npm stop",
      "npm restart",
    ];
    for (const hook of hooks) {
      const life = hook.startsWith("npm start") ? "start" : hook.startsWith("npm stop") ? "stop" : hook.startsWith("npm restart") ? "restart" : "setup";
      const scripts = { postinstall: hook, [life]: "node a.js" };
      const next = { postinstall: hook, [life]: "node evil.js" };
      const r = prepass("npm", files({ "package/package.json": pkg(scripts) }), files({ "package/package.json": pkg(next) }));
      expect(r.hard.map((s) => s.kind), hook).toContain("install-script");
    }
    const oldTest = pkg({ postinstall: "npm test", test: "node a.js" });
    const newTest = pkg({ postinstall: "npm test", test: "node evil.js" });
    expect(prepass("npm", files({ "package/package.json": oldTest }), files({ "package/package.json": newTest })).hard.map((s) => s.kind)).toContain("install-script");
  });

  test("an unchanged script reached through another runner is not flagged", () => {
    const body = pkg({ postinstall: "yarn --silent run setup", setup: "node a.js" });
    expect(prepass("npm", files({ "package/package.json": body }), files({ "package/package.json": body })).hard).toEqual([]);
  });

  test("an unfollowed script change is not an install hold; the hook text is", () => {
    const bare = pkg({ postinstall: "yarn setup", setup: "node evil.js" });
    const bareOld = pkg({ postinstall: "yarn setup", setup: "node a.js" });
    expect(prepass("npm", files({ "package/package.json": bareOld }), files({ "package/package.json": bare })).hard.filter((s) => s.kind === "install-script")).toEqual([]);
    const hook = pkg({ postinstall: "yarn setup now", setup: "node a.js" });
    expect(prepass("npm", files({ "package/package.json": bareOld }), files({ "package/package.json": hook })).hard.map((s) => s.kind)).toContain("install-script");
  });

  test("a test-script edit beside binding.gyp is not an install hold; a removed install, a gyp edit, or a config retarget is", () => {
    const gyp = "{ 'targets': [ { 'action': [ '<!(node evil.js)' ] } ] }\n";
    const same = "same\n";
    const scripts = prepass(
      "npm",
      files({ "package/package.json": pkg({ test: "node a.js" }), "package/binding.gyp": gyp, "package/evil.js": same }),
      files({ "package/package.json": pkg({ test: "node b.js" }), "package/binding.gyp": gyp, "package/evil.js": same }),
    );
    expect(scripts.hard.filter((s) => s.kind === "install-script")).toEqual([]);
    const removed = prepass(
      "npm",
      files({ "package/package.json": pkg({ install: "node safe.js" }), "package/binding.gyp": gyp, "package/evil.js": same, "package/safe.js": "s\n" }),
      files({ "package/package.json": pkg({}), "package/binding.gyp": gyp, "package/evil.js": same, "package/safe.js": "s\n" }),
    );
    expect(removed.hard.map((s) => s.kind)).toContain("install-script");
    const gypOnly = prepass(
      "npm",
      files({ "package/package.json": pkg({}), "package/binding.gyp": gyp, "package/evil.js": same }),
      files({ "package/package.json": pkg({}), "package/binding.gyp": `${gyp}\n`, "package/evil.js": same }),
    );
    expect(gypOnly.hard.map((s) => s.kind)).toContain("install-script");
    const body = (f: string) => JSON.stringify({ name: "x", config: { f }, scripts: { postinstall: "node hook.js" } });
    const hook = "require(process.env.npm_package_config_f)\n";
    const cfg = prepass(
      "npm",
      files({ "package/package.json": body("./ok.js"), "package/hook.js": hook, "package/ok.js": same, "package/evil.js": same }),
      files({ "package/package.json": body("./evil.js"), "package/hook.js": hook, "package/ok.js": same, "package/evil.js": same }),
    );
    expect(cfg.hard.map((s) => s.kind)).toContain("install-script");
    const noHook = (f: string) => JSON.stringify({ name: "x", config: { f } });
    expect(prepass("npm", files({ "package/package.json": noHook("a") }), files({ "package/package.json": noHook("b") })).hard).toEqual([]);
  });
});

describe("prepass: content signals (soft)", () => {
  test("a long base64 blob in an added line is soft", () => {
    const blob = "A".repeat(600);
    const r = prepass("pypi", files({ "a.py": "x = 1\n" }), files({ "a.py": `x = 1\npayload = "${blob}"\n` }));
    expect(r.soft.map((s) => s.kind)).toContain("encoded-blob");
  });

  test("exec of decoded data in an added line is soft", () => {
    const r = prepass("pypi", files({ "a.py": "" }), files({ "a.py": "exec(base64.b64decode(s))\n" }));
    expect(r.soft.map((s) => s.kind)).toContain("dynamic-exec");
  });

  test("credential path reads in added lines are soft", () => {
    const r = prepass("pypi", files({ "a.py": "" }), files({ "a.py": "open(os.path.expanduser('~/.aws/credentials'))\n" }));
    expect(r.soft.map((s) => s.kind)).toContain("credential-path");
  });

  test("signals on lines that already existed are not reported", () => {
    const line = "exec(base64.b64decode(s))\n";
    const r = prepass("pypi", files({ "a.py": line }), files({ "a.py": line + "y = 2\n" }));
    expect(r.soft.map((s) => s.kind)).not.toContain("dynamic-exec");
  });
});
