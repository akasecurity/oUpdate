import { afterEach, describe, expect, test } from "bun:test";
import { allowFaults } from "./fault-guard.ts";
import { classifyJs, installView, provablyStatic, scannerFaultCount, setJsScanSteps } from "../src/install-closure.ts";

const CLOSED = { all: true, pkg: true, tests: true, flows: true, same: false, dirs: [], lits: [] };
afterEach(() => setJsScanSteps(undefined));

describe("JS scan step budget", () => {
  test("a file past the budget is held in every kind and the fault is counted once", () => {
    allowFaults();
    setJsScanSteps(10);
    const before = scannerFaultCount();
    expect(classifyJs("a.js", "foo(bar(1));\nbaz(2);\n")).toEqual(CLOSED);
    expect(scannerFaultCount() - before).toBe(1);
  });
  test("the same file under the default budget is read normally, and the next scan starts fresh", () => {
    allowFaults();
    const src = "foo(bar(1));\nbaz(2);\n";
    setJsScanSteps(10);
    classifyJs("a.js", src);
    setJsScanSteps(undefined);
    expect(classifyJs("a.js", src).all).toBe(false);
  });
  test("the answer does not depend on how many scans ran before", () => {
    const src = "foo(bar(1));\n".repeat(50);
    const answers = new Set<string>();
    for (let i = 0; i < 80; i++) answers.add(JSON.stringify(classifyJs("a.js", src)));
    expect(answers.size).toBe(1);
  });
  test("a long comment is charged: a budget smaller than its span holds the file", () => {
    allowFaults();
    setJsScanSteps(1000);
    expect(classifyJs("a.js", "/*" + "x".repeat(1_000_000) + "*/")).toEqual(CLOSED);
  });
  test("provablyStatic runs under the same budget and answers closed (false) past it", () => {
    allowFaults();
    expect(provablyStatic("const a = 1;\n")).toBe(true);
    setJsScanSteps(1);
    expect(provablyStatic("const a = 1;\n")).toBe(false);
  });
  test("20,000 nested setTimeout( calls are held at once, with one fault", () => {
    allowFaults();
    const before = scannerFaultCount();
    const t = performance.now();
    const tier = classifyJs("a.js", "setTimeout(".repeat(20000) + "1" + ")".repeat(20000));
    expect(performance.now() - t).toBeLessThan(15000);
    expect(tier).toEqual(CLOSED);
    expect(scannerFaultCount() - before).toBe(1);
  }, 60000);
  test("an ordinary 2 MB hook is far under the default budget and is not held", () => {
    const tier = classifyJs("a.js", "const fs = require('fs');\n" + "foo(bar(baz(1, 'a')), [1, 2].map((x) => x));\n".repeat(50_000));
    expect(tier.all).toBe(false);
  }, 60000);
});

describe("the loops the budget charges", () => {
  test("thousands of createRequire aliases are held with one fault, not read for minutes", () => {
    allowFaults();
    const src = Array.from({ length: 16000 }, (_, i) => `const { createRequire: c${i} } = require("module");\n`).join("");
    const before = scannerFaultCount();
    const t = performance.now();
    const tier = classifyJs("a.js", src);
    expect(performance.now() - t).toBeLessThan(20000);
    expect(tier.all).toBe(true);
    expect(scannerFaultCount() - before).toBe(1);
  }, 60000);
  test("a long line of slashes that open no regular expression is held with one fault", () => {
    allowFaults();
    const before = scannerFaultCount();
    const t = performance.now();
    const tier = classifyJs("a.js", `")/[`.repeat(60000));
    expect(performance.now() - t).toBeLessThan(20000);
    expect(tier.all).toBe(true);
    expect(scannerFaultCount() - before).toBe(1);
  }, 60000);
});

describe("a clean file with many Object.assign calls is not held by the budget", () => {
  const free = (src: string) => {
    const t = classifyJs("a.js", src);
    expect(t.all || t.pkg || t.tests || t.flows).toBe(false);
  };
  test("30,000 lines of Object.assign({}, c.settings) (1 MB)", () => {
    free("const c = { settings: {} };\n" + "x = Object.assign({}, c.settings);\n".repeat(30000));
  }, 60000);
  test("543 Object.assign calls in an 8 MB file", () => {
    const filler = "const fs = require('fs');\nfunction f(a, b) { return a + b; }\n".repeat(Math.ceil((8 * 1024 * 1024) / 543 / 64));
    free("const c = { settings: {} };\n" + Array.from({ length: 543 }, (_, i) => `${filler}x${i} = Object.assign({}, c.settings);\n`).join(""));
  }, 120000);
});

describe("the budget is per entry and does not depend on history", () => {
  test("the same call under the same limit gives the same answer and the same fault count, 20 times", () => {
    allowFaults();
    setJsScanSteps(29200);
    const src = "setTimeout(foo,1);\n".repeat(200);
    const runs: string[] = [];
    for (let i = 0; i < 20; i++) {
      const before = scannerFaultCount();
      runs.push(`${provablyStatic(src)}/${scannerFaultCount() - before}`);
    }
    expect(new Set(runs).size).toBe(1);
  });
  test("classifyJs is the same 20 times in a row with a tiny limit", () => {
    allowFaults();
    setJsScanSteps(5000);
    const src = "foo(bar(baz(1)));\n".repeat(400);
    const runs = new Set<string>();
    for (let i = 0; i < 20; i++) runs.add(JSON.stringify(classifyJs("a.js", src)));
    expect(runs.size).toBe(1);
  });
});

describe("package-level controls", () => {
  const enc = new TextEncoder();
  const view = (files: Record<string, string>) => installView(new Map(Object.entries(files).map(([k, v]) => [k, enc.encode(v)])));
  test("a small hook that loads 5.4 MB of other JS is not held by the budget, and widens as it did", () => {
    allowFaults();
    const filler = "const fs = require('fs');\nfunction f(a, b) { return a + b; }\n".repeat(Math.ceil((900 * 1024) / 64));
    const files: Record<string, string> = {
      "package.json": JSON.stringify({ name: "p", version: "1.0.0", scripts: { postinstall: "node a.js" } }),
      "a.js": Array.from({ length: 6 }, (_, i) => `require('./lib/f${i}.js');\n`).join("") + "const n = process.argv[2];\nrequire('./x/' + n);\n",
    };
    for (let i = 0; i < 6; i++) files[`lib/f${i}.js`] = filler;
    const before = scannerFaultCount();
    const r = view(files);
    expect(scannerFaultCount() - before).toBe(0);
    expect(r.hold).toBeUndefined();
    expect(r.files).toContain("lib/f5.js");
  }, 60000);
  test("a nested file that runs out of budget is held as a scanner fault, also when it names the package's own config", () => {
    allowFaults();
    const stall = Array.from({ length: 16000 }, (_, i) => `const { createRequire: c${i} } = require("module");\n`).join("");
    const r = view({
      "package.json": JSON.stringify({ name: "p", version: "1.0.0", scripts: { postinstall: "node a.js" } }),
      "a.js": "require('./b.js');\n",
      "b.js": stall + "const v = process.env.npm_package_config_x + y;\n",
    });
    expect(r.hold).toBe("scanner fault");
  }, 120000);
  test("a widen that runs out of budget is held as a scanner fault, never narrower than main", () => {
    allowFaults();
    const stall = Array.from({ length: 16000 }, (_, i) => `const { createRequire: c${i} } = require("module");\n`).join("");
    const r = view({
      "package.json": JSON.stringify({ name: "p", version: "1.0.0", scripts: { postinstall: "node a.js" } }),
      "a.js": stall + "spawn('node', [path.join(__dirname, 'c.js')]);\n",
      "c.js": "const v = require(process.env.npm_package_config_x);\n",
    });
    expect(r.hold).toBe("scanner fault");
  }, 120000);
  test("control: a clean .py reached from a small hook with large matched-call arguments is not held", () => {
    allowFaults();
    const big = "subprocess.run([" + "'a',".repeat(300_000) + "])\n";
    const before = scannerFaultCount();
    const r = view({
      "package.json": JSON.stringify({ name: "p", version: "1.0.0", scripts: { postinstall: "node a.js" } }),
      "a.js": "require('./t.py');\n",
      "t.py": big.repeat(8),
    });
    expect(scannerFaultCount() - before).toBe(0);
    expect(r.hold).toBeUndefined();
  }, 120000);
  test("a fault in the manifest-hold path of a nested file is counted", () => {
    allowFaults();
    const stall = Array.from({ length: 16000 }, (_, i) => `const { createRequire: c${i} } = require("module");\n`).join("");
    const before = scannerFaultCount();
    view({
      "package.json": JSON.stringify({ name: "p", version: "1.0.0", scripts: { postinstall: "node a.js" } }),
      "a.js": "require('./b.js');\n",
      "b.js": stall + "const v = process.env.npm_package_config_x + y;\n",
    });
    expect(scannerFaultCount() - before).toBeGreaterThan(0);
  }, 120000);
  test("a non-JS hook whose literals cannot be read under a tiny limit is held as a scanner fault", () => {
    allowFaults();
    const files = {
      "package.json": JSON.stringify({ name: "p", version: "1.0.0", scripts: { postinstall: "python3 t.py" } }),
      "t.py": "import subprocess\nsubprocess.run(['sh', 'dir/' + n])\n",
      "z/unrelated.txt": "x\n",
    };
    expect(view(files).hold).toBeUndefined();
    setJsScanSteps(3);
    expect(view(files).hold).toBe("scanner fault");
  });
  test("a python hook that runs out of budget before the file it imports is held, not narrower than main", () => {
    allowFaults();
    const r = view({
      "package.json": JSON.stringify({ name: "p", version: "1.0.0", scripts: { postinstall: "python3 t.py" } }),
      "t.py": "import b\n" + ("__import__(".repeat(190) + "'x'" + ")".repeat(190) + "\n").repeat(100),
      "b.py": "import subprocess\nsubprocess.run(['node', 'c.js'])\n",
      "c.js": "const v = require(process.env.npm_package_config_x);\n",
    });
    expect(r.hold).toBe("scanner fault");
  }, 120000);
  test("a tripped scan whose config names a path outside the package is held", () => {
    allowFaults();
    const stall = Array.from({ length: 16000 }, (_, i) => `const { createRequire: c${i} } = require("module");\n`).join("");
    const r = view({
      "package.json": JSON.stringify({ name: "p", version: "1.0.0", config: { x: "/etc/x.js" }, scripts: { postinstall: "node a.js" } }),
      "a.js": stall + "require(process.env.npm_package_config_x);\n",
    });
    expect(r.hold).toBeDefined();
  }, 120000);
  test("a comment that mentions the config in a file the stalled scan never read does not hold as a manifest", () => {
    allowFaults();
    const stall = Array.from({ length: 16000 }, (_, i) => `const { createRequire: c${i} } = require("module");\n`).join("");
    const r = view({
      "package.json": JSON.stringify({ name: "p", version: "1.0.0", scripts: { postinstall: "node a.js" } }),
      "a.js": stall,
      "docs/example.js": "// npm_package_config_x is an example\n",
    });
    expect(r.hold).toBe("scanner fault");
  }, 120000);
});
