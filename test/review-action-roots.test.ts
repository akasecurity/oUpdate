import { describe, expect, test } from "bun:test";
import { actionEntryPaths, entryPaths, reviewUpdate } from "../src/review.ts";
import type { Registry } from "../src/adapters/ecosystem/types.ts";
import { markLink, type FileMap } from "../src/prepass.ts";

const enc = (s: string) => new TextEncoder().encode(s);
const files = (o: Record<string, string>): FileMap => new Map(Object.entries(o).map(([k, v]) => [k, enc(v)]));
const now = new Date("2026-10-21T18:00:00Z");
const registry: Registry = {
  latest: async () => undefined,
  publishedAt: async () => new Date(now.getTime() - 10 * 86_400_000),
  artifactUrls: async (_n, v) => [`https://files.example/${v}`],
};
const pj = (main = "index.js") => JSON.stringify({ name: "act", version: "1.0.0", main });
const code = { "package.json": pj(), "index.js": "a()\n", "dist/x.js": "x()\n", "dist/pre.js": "p()\n", "dist/post.js": "q()\n" };
const roots = (o: Record<string, string>, nested = false) => [...actionEntryPaths(files(o), undefined, nested)].sort();
const yml = (main: string) => `runs:\n  using: node20\n  main: ${main}\n`;

describe("action.yml entries", () => {
  test("main, pre and post of a node action, quoted or not, any node version", () => {
    for (const using of ["node16", "node20", "node24"]) {
      const r = roots({ ...code, "action.yml": `name: a\nruns:\n  using: ${using}\n  pre: "./dist/pre.js"\n  main: 'dist/x.js'\n  post: dist/post.js\n` });
      expect(r).toEqual(["dist/post.js", "dist/pre.js", "dist/x.js"]);
    }
  });

  test("action.yaml works; a missing file adds nothing", () => {
    expect(roots({ ...code, "action.yaml": yml("dist/x.js") })).toEqual(["dist/x.js"]);
    expect(roots({ ...code, "action.yml": yml("dist/none.js") })).toEqual([]);
  });

  test("an alias to an anchored value resolves", () => {
    expect(roots({ ...code, "action.yml": "x: &m dist/x.js\nruns:\n  using: node20\n  main: *m\n" })).toEqual(["dist/x.js"]);
  });

  test("docker names no node file; a composite step names only what node, bun, sh, bash or python run", () => {
    expect(roots({ ...code, "action.yml": "runs:\n  using: docker\n  image: Dockerfile\n  main: dist/x.js\n" })).toEqual([]);
    const comp = (run: string) => `runs:\n  using: composite\n  steps:\n    - run: ${run}\n      shell: bash\n`;
    expect(roots({ ...code, "action.yml": comp("node dist/x.js") })).toEqual(["dist/x.js"]);
    expect(roots({ ...code, "action.yml": comp('node "${{ github.action_path }}/dist/pre.js"') })).toEqual(["dist/pre.js"]);
    expect(roots({ ...code, "action.yml": comp("bash dist/post.js") })).toEqual(["dist/post.js"]);
    const block = "runs:\n  using: composite\n  steps:\n    - shell: bash\n      run: |\n        echo hi\n        node $GITHUB_ACTION_PATH/dist/post.js --flag\n";
    expect(roots({ ...code, "action.yml": block })).toEqual(["dist/post.js"]);
    // Other commands' arguments are no script, and an extensionless target is no entry.
    for (const run of ["echo dist/x.js", "cat dist/x.js", "cp dist/x.js .", "source dist/x.js", "./dist/x.js", "node dist/none"]) expect(roots({ ...code, "action.yml": comp(run) })).toEqual([]);
  });

  test("a composite step takes the script, not the files the script is given", () => {
    const comp = (run: string) => `runs:\n  using: composite\n  steps:\n    - run: ${JSON.stringify(run)}\n      shell: bash\n`;
    const A = "${{ github.action_path }}";
    const forms: [string, string[]][] = [
      [`node ${A}/dist/x.js ${A}/assets/logo.png`, ["dist/x.js"]],
      [`bash -c "cp $GITHUB_ACTION_PATH/assets/logo.png ."`, []],
      ["bash dist/post.js ./assets/logo.png", ["dist/post.js"]],
      ["sh -x dist/pre.js assets/logo.png", ["dist/pre.js"]],
      ["node -r ./dist/pre.js dist/x.js ./assets/logo.png", ["dist/pre.js", "dist/x.js"]],
      ["node --import=./dist/pre.js dist/x.js", ["dist/pre.js", "dist/x.js"]],
      ["bun run dist/x.js ./assets/logo.png", ["dist/x.js"]],
      ["python dist/x.py assets/logo.png", ["dist/x.py"]],
      ["node -e \"require('./dist/x.js')\" ./assets/logo.png", []],
      ["FOO=1 node dist/x.js && cp assets/logo.png .", ["dist/x.js"]],
    ];
    for (const [run, want] of forms) {
      const r = roots({ ...code, "dist/x.py": "", "assets/logo.png": "", "action.yml": comp(run) });
      expect([run, r]).toEqual([run, want]);
    }
  });

  test("./ and .. are normalized; absolute, variable and outside-the-package paths name nothing", () => {
    expect(roots({ ...code, "action.yml": yml("./dist/../dist/x.js") })).toEqual(["dist/x.js"]);
    for (const bad of ["../../dist/x.js", "../dist/x.js", "/dist/x.js", "$HOME/dist/x.js", "\\dist\\x.js"]) expect(roots({ ...code, "action.yml": yml(bad) })).toEqual([]);
    expect(roots({ ...code, "sub/action.yml": yml("../dist/x.js"), "sub/x": "" }, true)).toEqual(["dist/x.js"]);
  });

  test("only the package root's action.yml counts: a subdirectory or vendored one is no entry", () => {
    const o = { ...code, "sub/action.yml": yml("dist/s.js"), "sub/dist/s.js": "s()\n", "node_modules/dep/action.yml": yml("dist/d.js"), "node_modules/dep/dist/d.js": "d()\n", "examples/a/action.yaml": yml("x.js"), "examples/a/x.js": "" };
    expect(roots(o)).toEqual([]);
    expect(roots({ ...o, "action.yml": yml("dist/x.js") })).toEqual(["dist/x.js"]);
    expect(roots(o, true)).toEqual(["examples/a/x.js", "node_modules/dep/dist/d.js", "sub/dist/s.js"]);
  });

  test("a link action.yml is skipped", () => {
    const f = files({ ...code });
    f.set("action.yml", markLink(enc(yml("dist/x.js"))));
    expect([...actionEntryPaths(f)]).toEqual([]);
    f.set("action.yml", enc(yml("dist/x.js")));
    expect([...actionEntryPaths(f)]).toEqual(["dist/x.js"]);
  });
});

describe("action.yml read as lines when the YAML parser refuses it", () => {
  test("keys under runs: are read", () => {
    expect(roots({ ...code, "action.yml": "runs:\n  using: node20\n  main: dist/x.js\n  post: 'dist/post.js'\nbad: [\n" })).toEqual(["dist/post.js", "dist/x.js"]);
    expect(roots({ ...code, "action.yml": "runs:\n  using: composite\n  steps:\n    - run: node dist/x.js\n    - run: |\n        node dist/post.js\nbad: [\n" })).toEqual(["dist/post.js", "dist/x.js"]);
  });

  test("a main outside runs: and a docker action's main name nothing", () => {
    expect(roots({ ...code, "action.yml": "name: example\nmain: dist/x.js\nbad: [\n" })).toEqual([]);
    expect(roots({ ...code, "action.yml": "runs:\n  using: docker\n  main: dist/x.js\nbad: [\n" })).toEqual([]);
    expect(roots({ ...code, "action.yml": "runs:\n  using: node20\n  main: /dist/x.js\nbad: [\n" })).toEqual([]);
    expect(roots({ ...code, "action.yml": "runs:\n  using: node20\n  with:\n    main: dist/x.js\nbad: [\n" })).toEqual([]);
  });
});

describe("a package without an action entry is read as before", () => {
  const scopes = [{}, { scripts: true }, { nested: false }, { runtime: true }, { surface: true, runtime: true }];
  test("entryPaths is the same with an action.yml beside it, in every scope", () => {
    const withAction = files({ ...code, "action.yml": yml("dist/x.js") });
    const without = files(code);
    for (const scope of scopes) expect([...entryPaths(withAction, undefined, scope)].filter((p) => p !== "action.yml").sort()).toEqual([...entryPaths(without, undefined, scope)].sort());
  });
});

describe("action.yml in a release", () => {
  const run = async (old: FileMap, next: FileMap, extra: Record<string, unknown> = {}) => {
    const prompts: string[] = [];
    const r = await reviewUpdate({
      eco: "npm",
      name: "act",
      from: "1.0.0",
      to: "1.0.1",
      registry,
      advisories: { query: async () => [] },
      reviewer: { name: "fake", review: async (p) => (prompts.push(p), "APPROVE\nno attack indicators found") },
      cooldownDays: 7,
      now,
      loadArtifacts: async () => ({ old, new: next }),
      ...extra,
    });
    return { r, prompts, text: prompts.join("") };
  };

  // A file the old release had only as an action entry was not loaded by the npm package, so naming it from
  // package.json main, or requiring it from changed code, shows it like any other newly reached file.
  test("old action.yml entry: package.json main newly names the file", async () => {
    const o = files({ "package.json": pj("index.js"), "index.js": "a()\n", "dist/x.js": "x_one()\n", "action.yml": yml("dist/x.js") });
    const n = files({ "package.json": pj("dist/x.js"), "index.js": "a()\n", "dist/x.js": "x_one()\n", "action.yml": yml("dist/x.js") });
    const { text } = await run(o, n);
    expect(text).toContain("=== dist/x.js (now loaded by package.json, unchanged) ===");
  });

  test("old action.yml entry: changed code newly requires the file", async () => {
    const o = files({ "package.json": pj(), "index.js": "a()\n", "hidden.js": "steal_hidden()\n", "action.yml": yml("hidden.js") });
    const n = files({ "package.json": pj(), "index.js": "a()\nrequire('./hidden.js')\n", "hidden.js": "steal_hidden()\n", "action.yml": yml("hidden.js") });
    const { text } = await run(o, n);
    expect(text).toContain("steal_hidden()");
  });

  test("an unchanged file an action.yml names is not shown, newly named or not", async () => {
    const base = { "package.json": pj(), "index.js": "a()\n", "dist/x.js": "steal_action_named()\n" };
    for (const [oldYml, newYml] of [[yml("dist/x.js"), yml("dist/x.js")], [yml("index.js"), yml("dist/x.js")]] as const) {
      const { text } = await run(files({ ...base, "action.yml": oldYml }), files({ ...base, "index.js": "b()\n", "action.yml": newYml }));
      expect(text).not.toContain("steal_action_named()");
    }
  });

  // A root alone must not change what the part budget does for the files in the diff: with room for one part,
  // both changed files are reviewed in one part, as with no action.yml.
  test("part budget: an action.yml naming an unchanged big file keeps both changed files in the one part", async () => {
    const big = Array.from({ length: 200 }, (_, i) => `unchanged_line_${i}();`).join("\n") + "\n";
    const budget = { chunkChars: 1000, maxParts: 1, maxStages: 1 };
    const oldSide = { "package.json": pj(), "index.js": "a1()\n", "b.js": "b1()\n", "big.js": big };
    const newSide = { ...oldSide, "index.js": "a2()\n", "b.js": "b2()\n" };
    const plain = await run(files(oldSide), files(newSide), budget);
    expect(plain.prompts.length).toBe(1);
    for (const [o, n] of [
      [{ ...oldSide, "action.yml": yml("index.js") }, { ...newSide, "action.yml": yml("big.js") }],
      [oldSide, { ...newSide, "action.yml": yml("big.js") }],
    ] as const) {
      const { prompts, r } = await run(files(o), files(n), budget);
      expect(prompts.length).toBe(1);
      expect(prompts[0]).toContain("a2()");
      expect(prompts[0]).toContain("b2()");
      expect(r.decision).not.toBe("hold");
    }
  });

  test("a changed extensionless file runs.main names is parsed as code", async () => {
    const o = files({ ...code, "dist/run": "a()\n", "action.yml": yml("dist/run") });
    const n = files({ ...code, "dist/run": "a( {{{ \n", "action.yml": yml("dist/run") });
    const named = await run(o, n);
    const unnamed = await run(files({ ...code, "dist/run": "a()\n" }), files({ ...code, "dist/run": "a( {{{ \n" }));
    expect(named.r.decision).toBe("hold");
    expect(JSON.stringify(named.r.layers)).toContain("parser rejected");
    expect(JSON.stringify(unnamed.r.layers)).not.toContain("parser rejected");
  });

  test("composite steps: a script or a file other commands use is no entry, so a release changing it reviews as before", async () => {
    const comp = "runs:\n  using: composite\n  steps:\n    - shell: bash\n      run: ${{ github.action_path }}/scripts/setup\n    - shell: bash\n      run: cp $GITHUB_ACTION_PATH/assets/logo.png .\n";
    const base = { ...code, "scripts/setup": "#!/bin/bash\necho one\n", "assets/logo.png": "\x89PNG one" };
    const next = { ...base, "scripts/setup": "#!/bin/bash\nif [ x ]; then\n", "assets/logo.png": "\x89PNG two" };
    const withAction = await run(files({ ...base, "action.yml": comp }), files({ ...next, "action.yml": comp }));
    const without = await run(files(base), files(next));
    expect(withAction.r.decision).toBe(without.r.decision);
    expect(JSON.stringify(withAction.r.layers)).toBe(JSON.stringify(without.r.layers));
    expect(withAction.text).toBe(without.text);
  });

  // An action entry applies only to a file this release adds or changes. An unchanged extensionless file it names
  // is read as it is without an action.yml: not as code, so nothing it holds seeds, shows or holds anything.
  const budget = { chunkChars: 1000, maxParts: 1, maxStages: 1 };
  const action = yml("dist/run");
  const bin = (...b: number[]) => new Uint8Array(b);

  test("unchanged extensionless action entry: its \".map\" string leaves source-map summarizing alone", async () => {
    const map = (c: string, n: number) => JSON.stringify({ version: 3, file: "a.js", sources: ["a.js"], names: [], mappings: c.repeat(n) });
    const side = (v: string, c: string, n: number) => ({ "package.json": pj(), "index.js": `a${v}()\n`, "b.js": `b${v}()\n`, "a.map": map(c, n), run: 'const suffix = ".map";\n', "action.yml": yml("run") });
    const plain = (o: Record<string, string>) => Object.fromEntries(Object.entries(o).filter(([k]) => k !== "action.yml"));
    const withAction = await run(files(side("1", "A;", 1000)), files(side("2", "B;", 1100)), budget);
    const without = await run(files(plain(side("1", "A;", 1000))), files(plain(side("2", "B;", 1100))), budget);
    expect(without.prompts.length).toBe(1);
    expect(withAction.prompts.length).toBe(1);
    expect(withAction.text).toBe(without.text);
    expect(withAction.r.decision).toBe(without.r.decision);
  });

  test("unchanged extensionless action entry that requires an unchanged file adds no part and shows nothing", async () => {
    const big = Array.from({ length: 200 }, (_, i) => `unchanged_line_${i}();`).join("\n") + "\n";
    const side = (v: string) => ({ "package.json": pj(), "index.js": `a${v}()\n`, "b.js": `b${v}()\n`, "big.js": big, "dist/run": "require('./big.js')\n", "action.yml": action });
    const o = side("1");
    const n = side("2");
    const { prompts, r } = await run(files({ ...o, "dist/run": "require('../big.js')\n" }), files({ ...n, "dist/run": "require('../big.js')\n" }), budget);
    expect(prompts.length).toBe(1);
    expect(prompts[0]).toContain("a2()");
    expect(prompts[0]).toContain("b2()");
    expect(prompts[0]).not.toContain("unchanged_line_");
    expect(r.decision).not.toBe("hold");
  });

  test("unchanged extensionless action entry that requires an unchanged binary or unparsable file adds no hold", async () => {
    const side = (v: string, extra: Record<string, string | Uint8Array>) => new Map<string, Uint8Array>(Object.entries({ "package.json": pj(), "index.js": `a${v}()\n`, "dist/run": "require('../build/Release/addon.node'); require('../lib/odd.js')\n", "action.yml": action, "lib/odd.js": "a( {{{ \n", ...extra }).map(([k, x]) => [k, typeof x === "string" ? enc(x) : x]));
    const addon = bin(0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0, 9, 9, 9, 9);
    const withAction = await run(side("1", { "build/Release/addon.node": addon }), side("2", { "build/Release/addon.node": addon }));
    const without = await run(
      new Map([...side("1", { "build/Release/addon.node": addon })].filter(([k]) => k !== "action.yml")),
      new Map([...side("2", { "build/Release/addon.node": addon })].filter(([k]) => k !== "action.yml")),
    );
    expect(withAction.r.decision).toBe(without.r.decision);
    expect(JSON.stringify(withAction.r.layers)).toBe(JSON.stringify(without.r.layers));
    expect(withAction.text).toBe(without.text);
  });

  test("composite run: a changed benign logo.png given as an argument to a script (or to cp) still lands", async () => {
    const png = (v: number) => bin(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52, v);
    const base = (v: number, runBody: string): FileMap => {
      const m = files({ ...code, "action.yml": `runs:\n  using: composite\n  steps:\n    - shell: bash\n      run: ${JSON.stringify(runBody)}\n` });
      m.set("assets/logo.png", png(v));
      return m;
    };
    const A = "${{ github.action_path }}";
    const plain = (v: number): FileMap => {
      const m = files(code);
      m.set("assets/logo.png", png(v));
      return m;
    };
    const without = await run(plain(1), plain(2));
    for (const body of [`node ${A}/dist/x.js ${A}/assets/logo.png`, `bash -c "cp $GITHUB_ACTION_PATH/assets/logo.png ."`, "bash dist/post.js ./assets/logo.png"]) {
      const withAction = await run(base(1, body), base(2, body));
      expect([body, withAction.r.decision]).toEqual([body, without.r.decision]);
      expect(withAction.text).toBe(without.text);
    }
  });

  test("a changed benign-looking binary that runs.main names is not passed as benign", async () => {
    const png = (v: number) => bin(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52, v);
    const side = (v: number, y: string): FileMap => {
      const m = files({ ...code, "action.yml": y });
      m.set("dist/logo.png", png(v));
      return m;
    };
    const named = await run(side(1, yml("dist/logo.png")), side(2, yml("dist/logo.png")));
    const unnamed = await run(side(1, yml("dist/x.js")), side(2, yml("dist/x.js")));
    expect(JSON.stringify(named.r.layers)).toContain("binary");
    expect(JSON.stringify(unnamed.r.layers)).not.toContain("binary");
  });

  // Fixtures shaped like the action.yml files of five widely used actions (names and entry paths follow their layouts).
  // A release that changes only the bundles reads the same with the action.yml as without it.
  const controls: Record<string, Record<string, string>> = {
    "rust-cache": { "action.yml": "name: Rust Cache\ninputs:\n  key:\n    default: ''\nruns:\n  using: node20\n  main: dist/restore/index.js\n  post: dist/save/index.js\n  post-if: success()\n", "dist/restore/index.js": "restore(1)\n", "dist/save/index.js": "save(1)\n" },
    "docker-login": { "action.yml": "name: Docker Login\nruns:\n  using: node20\n  main: dist/index.js\n  post: dist/index.js\n", "dist/index.js": "login(1)\n" },
    "docker-build-push": { "action.yml": "name: Build and push\nruns:\n  using: node20\n  main: dist/index.js\n  post: dist/index.js\n", "dist/index.js": "build(1)\n" },
    "setup-python": { "action.yml": "name: Setup Python\nruns:\n  using: node24\n  main: dist/setup/index.js\n  post: dist/cache-save/index.js\n  post-if: success()\n", "dist/setup/index.js": "setup(1)\n", "dist/cache-save/index.js": "save(1)\n" },
    gradle: { "setup-gradle/action.yml": "name: Setup Gradle\nruns:\n  using: node20\n  main: ../dist/setup-gradle/main/index.js\n  post: ../dist/setup-gradle/post/index.js\n", "dist/setup-gradle/main/index.js": "main(1)\n", "dist/setup-gradle/post/index.js": "post(1)\n" },
  };
  for (const [name, fx] of Object.entries(controls)) {
    test(`control ${name}: a bundle-only release reviews the same with the action.yml present`, async () => {
      const meta = { "package.json": JSON.stringify({ name: "act", version: "1.0.0", private: true }) };
      const bump = (o: Record<string, string>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, k.endsWith("index.js") ? v.replace("(1)", "(2)") : v]));
      const withAction = await run(files({ ...meta, ...fx }), files({ ...meta, ...bump(fx) }));
      const stripped = Object.fromEntries(Object.entries(fx).filter(([k]) => !k.endsWith("action.yml")));
      const without = await run(files({ ...meta, ...stripped }), files({ ...meta, ...bump(stripped) }));
      expect(withAction.r.decision).toBe(without.r.decision);
      expect(withAction.text).toBe(without.text);
    });
  }
});

// A long action.yml is read once. Each shape is timed at n and 4n against its own run: a linear reader costs about 4x,
// a quadratic one about 16x, so a ratio under 8 separates them. The small size is above 10 ms so a quadratic cannot
// hide under a floor.
describe("action.yml perf shape", () => {
  const steps = (n: number) => {
    let s = "name: big\nruns:\n  using: composite\n  steps:\n";
    for (let i = 0; i < n; i++) s += `    - name: step ${i}\n      shell: bash\n      env:\n        K${i}: v${i}\n      run: |\n        echo ${i}\n        node dist/x.js --n ${i}\n`;
    return s;
  };
  // One long run string aliased by every step.
  const alias = (n: number) => `s: &s\n  run: echo ${"a".repeat(2000)}\n  shell: bash\nruns:\n  using: composite\n  steps:\n${"    - *s\n".repeat(n)}`;
  const fallback = (n: number) => steps(n) + "bad: [\n";
  const sep = (n: number) => `runs:\n  using: composite\n  steps:\n    - run:${" ".repeat(n)}x y\nbad: [\n`;
  const shapes: Record<string, [(n: number) => string, number]> = {
    steps: [steps, 10_000],
    alias: [alias, 220_000],
    fallback: [fallback, 10_000],
  };
  const time = (src: string) => {
    const f = files({ ...code, "action.yml": src });
    const t = performance.now();
    const r = actionEntryPaths(f);
    return [performance.now() - t, r] as const;
  };
  const best = (src: string) => Math.min(time(src)[0], time(src)[0]);
  for (const [name, [make, n]] of Object.entries(shapes)) {
    test(`${name}: 4x the input costs about 4x`, () => {
      time(make(n));
      const a = best(make(n));
      const b = best(make(n * 4));
      console.log(`action perf ${name} n=${n}: ${a.toFixed(1)} ms, 4n: ${b.toFixed(1)} ms`);
      expect(a).toBeGreaterThan(10);
      expect(b / a).toBeLessThan(8);
      expect(b).toBeLessThan(10_000);
    });
  }
  test("separator: a line of 300000 spaces then a line separator is read at once", () => {
    const [ms, r] = time(sep(300_000));
    console.log(`action perf separator: ${ms.toFixed(1)} ms`);
    expect(ms).toBeLessThan(1000);
    expect([...r]).toEqual([]);
  });

  test("the steps shape still finds its script", () => {
    expect([...time(steps(50))[1]]).toEqual(["dist/x.js"]);
    expect([...time(fallback(50))[1]]).toEqual(["dist/x.js"]);
  });
});
