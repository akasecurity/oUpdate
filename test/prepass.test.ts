import { describe, expect, test } from "bun:test";
import { prepass, type FileMap } from "../src/prepass.ts";

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
      files({ "package/package.json": pkg({ install: "node-gyp rebuild" }) }),
      files({ "package/package.json": pkg({ install: "node-gyp rebuild" }) }),
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
