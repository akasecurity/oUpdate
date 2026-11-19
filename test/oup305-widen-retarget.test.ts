// A widen-all hook (a computed load, a runner fold) puts every file on both sides in the reached set, which used to hide a
// manifest-driven retarget between two byte-unchanged files: main (or bin) moved docs/a.js -> docs/b.js with the hook text the same.
import { describe, expect, test } from "bun:test";
import { installView, setJsScanSteps } from "../src/install-closure.ts";
import { prepass, type FileMap } from "../src/prepass.ts";
import { allowFaults } from "./fault-guard.ts";

const enc = new TextEncoder();
const map = (f: Record<string, string>): FileMap => new Map(Object.entries(f).map(([k, v]) => [k, enc.encode(v)]));
const held = (oldF: Record<string, string>, newF: Record<string, string>) => prepass("npm", map(oldF), map(newF)).hard.some((s) => s.kind === "install-script");

const A = "module.exports = 1;\n";
const B = 'require("fs").readFileSync("/etc/hosts");\n';
const rel = (main: string, hook: string, x: string, extra: object = {}) => ({
  "package.json": JSON.stringify({ name: "x", version: "1", main, scripts: { postinstall: hook }, ...extra }),
  "lib/x.js": x,
  "docs/a.js": A,
  "docs/b.js": B,
  "lib/a.js": A,
  "lib/b.js": B,
  "lib/w.js": "require(process.argv[2]);\n",
  "lib/s.js": 'const k = process.env.K;\nrequire("./" + k);\n',
});
const pair = (hook: string, x: string, extra: (m: string) => object = () => ({}), from = "docs/a.js", to = "docs/b.js") => [rel(from, hook, x, extra(from)), rel(to, hook, x, extra(to))] as const;

// What the hook's own script does: the first is no widening at all (the base case, held before), the rest widen to every file.
const NARROW = 'const cp = require("child_process");\nconst args = ["--version"];\nargs.push("--help");\ncp.spawnSync(process.execPath, args);\n';
const WIDE: [string, string][] = [
  ["a load of process.argv[2]", "require(process.argv[2]);\n"],
  ["a computed load (control: widens only to lib/, which holds neither docs file; held on the parent too)", 'const k = process.env.K;\nrequire("./" + k);\n'],
];

describe("a main retarget between byte-unchanged files is held whatever the hook's script widens", () => {
  for (const [runner, hook] of [["node .", "node lib/x.js && node ."], ["npx . (self-run)", "node lib/x.js && npx ."]] as const) {
    test(`${runner}: a hook script that does not widen (control: held on the parent too)`, () => {
      const [o, n] = pair(hook, NARROW);
      expect(held(o, n)).toBe(true);
    });
    for (const [what, src] of WIDE) {
      test(`${runner}: ${what}`, () => {
        const [o, n] = pair(hook, src);
        expect(held(o, n)).toBe(true);
      });
    }
  }
  // The shell hook itself widens (widenAll, not a script's scan): a computed word, an unknown tool, xargs, a path above the package.
  for (const widening of ["node ./$(cat n)", "sometool $(cat n)", "xargs npm run", "node ../y.js", `node -e "require('./lib/$(cat n)')"`]) {
    test(`a hook that widens as ${JSON.stringify(widening)}, then runs the package: main retarget held`, () => {
      const [o, n] = pair(`${widening} && node .`, "console.log(1);\n");
      expect(held(o, n)).toBe(true);
    });
  }
  // widenAll again, from the other call sites: a root .npmrc, `node --test`, `make`, an unknown npx package.
  for (const [what, hook, extra, from, to] of [
    ["a root .npmrc and npx .", "npx .", { ".npmrc": "registry=https://registry.example/\n" }, "docs/a.js", "docs/b.js"],
    ["node --test then node .", "node --test && node .", {}, "docs/a.js", "docs/b.js"],
    ["make then node . (main outside docs)", "make && node .", {}, "lib/a.js", "lib/b.js"],
    ["npx other then node . (main outside docs)", "npx other && node .", {}, "lib/a.js", "lib/b.js"],
  ] as const) {
    test(`widenAll through ${what}: main retarget held`, () => {
      const o = { ...rel(from, hook, "console.log(1);\n"), ...extra };
      const n = { ...rel(to, hook, "console.log(1);\n"), ...extra };
      expect(held(o, n)).toBe(true);
    });
  }
  // Rows that only the narrow reads' own comparisons can hold.
  test("control (held on the parent too): a computed load, main outside docs: src/a.js -> src/b.js is held", () => {
    const mk = (main: string) => ({ ...rel("docs/a.js", "node lib/x.js && node .", 'const k = process.env.K;\nrequire("./" + k);\n'), "src/a.js": A, "src/b.js": B, "package.json": JSON.stringify({ name: "x", version: "1", main, scripts: { postinstall: "node lib/x.js && node ." } }) });
    atLimits(() => held(mk("src/a.js"), mk("src/b.js")));
  });
  test("a string bin and a renamed package (the command `a` runs docs/a.js on one side only): held through the narrow self-run sets", () => {
    const mk = (name: string) => ({ ...rel("docs/a.js", "node lib/x.js && npx . && a", "require(process.argv[2]);\n"), "package.json": JSON.stringify({ name, version: "1", bin: "./docs/a.js", scripts: { postinstall: "node lib/x.js && npx . && a" } }) });
    atLimits(() => held(mk("a"), mk("b")));
  });
  test("one side's main widens to every file and the other's does not: held, and no narrow read is assumed on the side that has none", () => {
    const mk = (main: string) => ({ ...rel(main, "node .", "console.log(1);\n"), "docs/wide.js": "require(process.argv[2]);\n", "docs/narrow.js": "module.exports=1;\n" });
    atLimits(() => held(mk("docs/wide.js"), mk("docs/narrow.js")) && held(mk("docs/narrow.js"), mk("docs/wide.js")));
  });
  test("a bin retarget is held under a widening hook too (control: binStamp holds it on the parent too)", () => {
    const [o, n] = pair("node lib/x.js && x", "require(process.argv[2]);\n", (m) => ({ bin: { x: m } }));
    expect(held(o, n)).toBe(true);
  });
  // The other widenings: the script's own directory, the whole package, and one side widening while the other does not.
  const LIMITS: (number | undefined)[] = [undefined, 3000];
  const atLimits = (f: () => boolean) => {
    try {
      for (const lim of LIMITS) {
        setJsScanSteps(lim);
        expect({ lim, held: f() }).toEqual({ lim, held: true });
      }
    } finally {
      setJsScanSteps(undefined);
    }
  };
  test("a script that widens to its own directory (a computed load): main moved inside that directory is held", () => {
    const [o, n] = pair("node lib/x.js && node .", 'const k = process.env.K;\nrequire("./" + k);\n', () => ({}), "lib/a.js", "lib/b.js");
    atLimits(() => held(o, n));
  });
  test("a script that widens to a named directory (a literal-headed load): main moved inside that directory is held", () => {
    const over = (main: string) => ({ "pkg/a.js": A, "pkg/b.js": B, "package.json": JSON.stringify({ name: "x", version: "1", main, scripts: { postinstall: "node x.js && node ." } }), "x.js": 'const k = process.env.K;\nrequire("./pkg/" + k);\n' });
    atLimits(() => held(over("pkg/a.js"), over("pkg/b.js")));
  });
  test("a .ts hook script (same-directory widening through narrowWiden): main moved inside the directory is held", () => {
    const [o, n] = pair("node lib/x.ts && node .", 'const k = process.env.K;\nrequire("./" + k);\n', () => ({}), "lib/a.js", "lib/b.js");
    const rename = (r: Record<string, string>) => ({ ...r, "lib/x.ts": r["lib/x.js"]! });
    atLimits(() => held(rename(o), rename(n)));
  });
  // One row per widening function, with main in the same directory as the hook script (nothing else puts the retarget in the narrow set).
  test("widenEvery: a load of process.argv[2], main lib/a.js -> lib/b.js", () => {
    const [o, n] = pair("node lib/x.js && node .", "require(process.argv[2]);\n", () => ({}), "lib/a.js", "lib/b.js");
    atLimits(() => held(o, n));
  });
  test("widenAll: a shell hook that reads every file, main lib/a.js -> lib/b.js", () => {
    for (const w of ["sometool $(cat n)", "node ./$(cat n)"]) {
      const [o, n] = pair(`${w} && node .`, "console.log(1);\n", () => ({}), "lib/a.js", "lib/b.js");
      atLimits(() => held(o, n));
    }
  });
  // main moved from a docs file to a lib file with the same bytes (what the widening alone cannot show): the rows that kill the
  // `widened = true` marks of widenEvery and widenAll (found by diffing the head against a mutant on a 122,500-row grid).
  test("widenEvery: main docs/a.js -> lib/a.js (same bytes), the hook script loads process.argv[2]", () => {
    const [o, n] = pair("node lib/x.js && node .", "require(process.argv[2]);\n", () => ({}), "docs/a.js", "lib/a.js");
    atLimits(() => held(o, n));
  });
  test("widenAll: main docs/a.js -> lib/a.js (same bytes), a shell hook that reads every file", () => {
    for (const w of ["node ./$(cat n)", "sometool $(cat n)", "node ../y.js"]) {
      for (const run of ["node .", "npx ."]) {
        const [o, n] = pair(`${w} && ${run}`, "console.log(1);\n", () => ({}), "docs/a.js", "lib/a.js");
        atLimits(() => held(o, n));
      }
    }
  });
  test("a script that widens to the whole package: main moved is held", () => {
    const [o, n] = pair("node lib/x.js && node .", 'require("child_process").execSync("node " + process.argv[2]);\n', () => ({}), "lib/a.js", "lib/b.js");
    atLimits(() => held(o, n));
  });
  test("one side widens to every file and the other widens to its directory only: main moved from one to the other is held", () => {
    for (const [from, to] of [["lib/w.js", "lib/s.js"], ["lib/s.js", "lib/w.js"]] as const) {
      const [o, n] = pair("node .", "console.log(1);\n", () => ({}), from, to);
      atLimits(() => held(o, n));
    }
  });
  test("at every scan-step limit (50, 200, 800, 3000 and 1..60) the retarget is held, never released", () => {
    allowFaults(); // a step limit this low makes the scanner fault on purpose: that is a widening
    try {
      for (const lim of [50, 200, 800, 3000, ...Array.from({ length: 60 }, (_, i) => i + 1)]) {
        setJsScanSteps(lim);
        for (const hook of ["node lib/x.js && node .", "node lib/x.js && npx ."]) {
          const [o, n] = pair(hook, "require(process.argv[2]);\n");
          expect({ lim, hook, held: held(o, n) }).toEqual({ lim, hook, held: true });
        }
      }
    } finally {
      setJsScanSteps(undefined);
    }
  });
  test("no retarget, nothing else changed: released (control) (a widening hook alone is not a hold)", () => {
    const [o] = pair("node lib/x.js && node .", "require(process.argv[2]);\n");
    expect(held(o, structuredClone(o))).toBe(false);
  });
});

// A named directory read by a shell word with an unresolved part (`node docs/$(cat n)`, `node ./pkg/$K`, a node -e with `'./pkg/' + k`)
// widens to every file under that directory (addUnder): the widening is left out of the narrow read like the others, so a main moved
// between two byte-unchanged files of that directory is held (it was released with the widening in both sides).
describe("a main retarget inside a named directory a shell word widens to is held", () => {
  const mk = (dir: string, main: string, hook: string, extra: Record<string, string> = {}) => ({
    "package.json": JSON.stringify({ name: "x", version: "1", main, scripts: { postinstall: hook } }),
    [`${dir}/a.js`]: A,
    [`${dir}/b.js`]: B,
    ...extra,
  });
  const forms: [string, string, string, Record<string, string>][] = [
    ["node docs/$(cat n) && node .", "docs", "an inert directory (docs)", {}],
    ["node pkg/$(cat n) && node .", "pkg", "a directory", {}],
    [`node -e "const k = process.env.K; require('./pkg/' + k)" && node .`, "pkg", "a node -e with a computed tail", {}],
    ["node ./pkg/$K && node .", "pkg", "a variable tail", {}],
    [`node "pkg/$(cat n)" && node .`, "pkg", "a quoted substitution", {}],
    ["node pkg/${K}.js && node .", "pkg", "a braced variable before an extension", {}],
    ["sh x.sh && node .", "pkg", "a shell script sourcing ./pkg/$K", { "x.sh": "source ./pkg/$K\n" }],
  ];
  for (const [hook, dir, what, extra] of forms) {
    test(`${what}: ${JSON.stringify(hook)}`, () => {
      expect(held(mk(dir, `${dir}/a.js`, hook, extra), mk(dir, `${dir}/b.js`, hook, extra))).toBe(true);
    });
  }
});

// A `.node` file the wide read never counts (settled) is no file for the scan cap in the narrow read either: with a chain of 63 files
// that ends the scan at the cap exactly, the narrow read stopped on the addon the wide read skipped and held a package whose version only moved.
describe("a stem-named .node file is no file for the cap in the narrow read", () => {
  const chain = (version: string, n: number) => {
    const f: Record<string, string> = {
      "package.json": JSON.stringify({ name: "x", version, main: "lib/c0.js", scripts: { postinstall: "node lib/x.js && node ." } }),
      "lib/x.js": 'require(process.argv[2]);\nrequire("path").join(__dirname, "addon");\nrequire("./c0.js");\n',
      "lib/addon.node": "\0",
    };
    for (let i = 0; i < n; i++) f[`lib/c${i}.js`] = i + 1 < n ? `require("./c${i + 1}.js");\n` : "1;\n";
    return f;
  };
  test("63 chained files and an addon named by a stem: a version bump is not held", () => {
    expect(held(chain("1", 63), chain("2", 63))).toBe(false);
  });
  test("control: 64 chained files reach the cap in the wide read too, and hold", () => {
    expect(held(chain("1", 64), chain("2", 64))).toBe(true);
  });
});

// Accepted over-hold (OUP-305): a bare file name in a script (`spawnSync("node", ["helper.js"])`) names a file only while it is the only file of
// that name. A package with a widening hook that adds an inert test/helper.js makes the name ambiguous: the narrow read stops reaching lib/helper.js
// and the package is held with no main or bin change. The wide read cannot tell the two (it reads every file); the parent released it. Safe
// direction: nothing is released.
describe("a same-named file added to a package with a widening hook is an accepted over-hold", () => {
  const mk = (extra: Record<string, string> = {}) => ({
    "package.json": JSON.stringify({ name: "x", version: "1", main: "docs/a.js", scripts: { postinstall: "node lib/x.js" } }),
    "docs/a.js": A,
    "lib/x.js": 'const k = process.env.K;\nrequire("./" + k);\nrequire("child_process").spawnSync("node", ["helper.js"]);\n',
    "lib/helper.js": "console.log(1)\n",
    ...extra,
  });
  test("an added test/helper.js: held (the bare name helper.js is no longer unique)", () => {
    expect(held(mk(), mk({ "test/helper.js": "console.log(2)\n" }))).toBe(true);
  });
  test("control: an added test/other.js (no name clash) is not held", () => {
    expect(held(mk(), mk({ "test/other.js": "console.log(2)\n" }))).toBe(false);
  });
});

// The cap neighborhood, for a `.node` file reached by name (the wide read counts it, as it always did) and by a bare stem next to a widening
// hook (only the narrow read adds it; it is no file for the cap there). Chains of c0..c(n-1), each requiring the next.
describe("the scan cap and a .node file: by name the wide read counts it, by stem the narrow read does not", () => {
  const mk = (version: string, n: number, shape: "name" | "stem") => {
    const f: Record<string, string> = {
      "package.json": JSON.stringify({ name: "x", version, main: shape === "name" ? "docs/a.js" : "lib/c0.js", scripts: { postinstall: shape === "name" ? "node lib/x.js" : "node lib/x.js && node ." } }),
      "docs/a.js": A,
      "lib/x.js": shape === "name" ? 'require("./c0.js");\n' : 'require(process.argv[2]);\nrequire("path").join(__dirname, "addon");\nrequire("./c0.js");\n',
      "lib/addon.node": "\0",
    };
    for (let i = 0; i < n; i++) f[`lib/c${i}.js`] = i + 1 < n ? `require("./c${i + 1}.js");\n` : shape === "name" ? 'require("./addon.node");\n' : "1;\n";
    return f;
  };
  for (const n of [60, 61, 62, 63, 64, 65, 66, 70]) {
    test(`a version bump, a chain of ${n} files, the addon required by name: held from 63 files (the wide read counts the .node file)`, () => {
      expect(held(mk("1", n, "name"), mk("2", n, "name"))).toBe(n >= 63);
    });
    test(`a version bump, a chain of ${n} files, the addon named by a stem beside a widening hook: held from 64 files (the narrow read does not count it)`, () => {
      // 63 files: x.js and the chain reach the cap exactly; the .node file the wide read skips by stem is no file for it in the narrow read.
      expect(held(mk("1", n, "stem"), mk("2", n, "stem"))).toBe(n >= 64);
    });
  }
});

// One-line mutants of the narrow read, each with the witness that tells it apart (the agy read of c8abdf4b).
describe("each guard of the narrow read has a row that goes red without it", () => {
  const details = (o: Record<string, string>, n: Record<string, string>) => prepass("npm", map(o), map(n)).hard.filter((s) => s.kind === "install-script").map((s) => s.detail);
  // prepass.ts: the `narrow read: <hold>` push. A tar member `package/C:/addon.node` keys as `C:/addon.node`: the wide read adds it by name (no path
  // check) and settled() skips it, the narrow read adds it by stem and the path check stops the read. Without the push the retarget is released.
  test("a stop only the narrow read makes holds the package (`narrow read: unresolved: path`)", () => {
    const f = (main: string) => ({
      "package.json": JSON.stringify({ name: "x", version: "1", main, scripts: { postinstall: "node lib/x.js && node ." } }),
      "lib/x.js": 'require(process.argv[2]);\nrequire("path").join(__dirname, "addon");\n',
      "C:/addon.node": "\0",
      "docs/a.js": A,
      "docs/b.js": B,
    });
    expect(details(f("docs/a.js"), f("docs/b.js"))).toContain("narrow read: unresolved: path");
  });
  // install-closure.ts addUnder: `widened = true`. The commented `require('./docs/' + x)` is no computed load for the widenJs (provablyStatic), so
  // addUnder alone is the widening: without its mark there is no narrow read and the retarget is released.
  test("addUnder's own widened mark is the only widening of a node -e whose comment names a computed load under docs/", () => {
    const f = (main: string) => ({
      "package.json": JSON.stringify({ name: "x", version: "1", main, scripts: { postinstall: "node -e \"// require('./docs/' + x)\" && node ." } }),
      "docs/a.js": A,
      "docs/b.js": B,
    });
    expect(details(f("docs/a.js"), f("docs/b.js")).sort()).toEqual(["file docs/a.js", "file docs/b.js"]);
  });
  // prepass.ts: `oldV.narrow || newV.narrow`. Only one side widens (the old main loads process.argv[2]); the other side's non-widening read adds
  // http/ through addStdlibShadow (s.py imports http), so both sides reach the same files and only the narrow reads differ.
  test("a narrow read on one side only is compared (`||`, not `&&`)", () => {
    const f = (main: string, body: string) => ({
      "package.json": JSON.stringify({ name: "x", version: "1", main, scripts: { postinstall: "node ." } }),
      "http/wide.js": "require(process.argv[2]);\n",
      "http/narrow.js": body,
      "s.py": "import http\n",
    });
    expect(details(f("http/wide.js", 'require("../s.py");\n'), f("http/narrow.js", 'require("../s.py");\n')).sort()).toEqual(["file http/narrow.js", "file s.py"]);
  });
  // installView: the narrow read exists only when a widening happened (`!widened`, and `widened = false` at the start), and not when the caller asked for none.
  test("a hook with no widening has no narrow read", () => {
    expect(installView(map({ "package.json": JSON.stringify({ name: "x", version: "1", main: "docs/a.js", scripts: { postinstall: "node docs/a.js" } }), "docs/a.js": A })).narrow).toBeUndefined();
  });
  test("a widening hook has a narrow read, unless the caller asks for the wide read only", () => {
    const m = map(rel("docs/a.js", "node lib/x.js && node .", "require(process.argv[2]);\n"));
    expect(installView(m).narrow).toBeDefined();
    expect(installView(m, { narrow: false }).narrow).toBeUndefined();
  });
});
