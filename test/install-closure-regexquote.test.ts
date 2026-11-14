import { describe, expect, test } from "bun:test";
import { installView, regexQuotesBlanked, setJsScanSteps } from "../src/install-closure.ts";
import { prepass } from "../src/prepass.ts";
import { allowFaults } from "./fault-guard.ts";

const enc = new TextEncoder();
const map = (f: Record<string, string>) => new Map(Object.entries(f).map(([k, v]) => [k, enc.encode(v)]));
const pj = JSON.stringify({ name: "x", version: "1", scripts: { postinstall: "node hook.js" } });
const cp = 'const cp = require("child_process");\n';
const spawn = 'cp.spawnSync("node", ["./docs/evil.js"]);';
const hard = (o: Record<string, string>, n: Record<string, string>) => prepass("npm", map(o), map(n)).hard.filter((s) => s.kind === "install-script");
// The hook runs docs/evil.js after `pre` on the same line; the new version of docs/evil.js runs a command.
const changed = (pre: string, post = spawn) => {
  const o = { "package.json": pj, "hook.js": `${cp}${pre} ${post}\n`, "docs/evil.js": "1;\n" };
  return hard(o, { ...o, "docs/evil.js": "require('child_process').execSync('id');\n" });
};
// The same hook, and only a file nothing reaches changes.
const unrelated = (pre: string, post = spawn) => {
  const o = { "package.json": pj, "hook.js": `${cp}${pre} ${post}\n`, "docs/evil.js": "1;\n", "other/x.txt": "1\n" };
  return hard(o, { ...o, "other/x.txt": "2\n" });
};

describe("a quote inside a regular expression literal opens no string", () => {
  test.each([
    ['const r = /"/;'],
    ['const r = /"/g;'],
    ['const r = /[/"]/;'],
    ['const r = /\\/"/;'],
    ['const r = /\\"/;'],
    ['return /"/.test(x);'],
    ['typeof /"/;'],
    ['f(a, /"/);'],
    ['x = { a: /"/ };'],
    ['x = "a/b" / 2; y = /"/;'],
  ])("%s before a spawn of a changed file on the same line: held", (pre) => {
    expect(changed(pre).map((s) => s.detail).join(" ")).toMatch(/docs\/evil\.js/);
  });
  test("an execSync command after the regex is read too", () => {
    expect(changed('const r = /"/;', 'cp.execSync("node ./docs/evil.js");').length).toBeGreaterThan(0);
  });
  test.each([["const r = /'/;"], ["const r = /`/;"], ['x = a / "s" / b;'], ['const x = a / b / c; const s = "q";'], ['if (x) /"/.test(y);'],
    ['const t = `${/"/.test(x)}`;'], ['x = a[0] / "s" / 2;']])("stays held as on main: %s", (pre) => {
    expect(changed(pre).length).toBeGreaterThan(0);
  });
  test.each([['const r = /"/;'], ['x = a / "s" / b;'], ['const x = a / b / c; const s = "q";'], ['x = (a) / 2; s = "q";'],
    ['const t = `a${b / 2}"c`;']])("control: %s with only an unrelated file changed stays quiet", (pre) => {
    expect(unrelated(pre)).toEqual([]);
  });
  test("control: a regex-like text inside a string or a comment is not a regex", () => {
    for (const pre of ['const s = "/\\"/";', "const s = '/\"/';"]) expect(changed(pre).length).toBeGreaterThan(0);
    expect(unrelated('const s = "/\\"/";')).toEqual([]);
  });
});

describe("each / is decided by the main scan", () => {
  test.each([
    ['let π = 1; π / "["; const r = /"/;'],
    ['x = 1. / 2 + "["; const r = /"/;'],
    ['let café = 1; café / 2 + "["; const r = /"/;'],
    ['obj./**/return / 2 + "["; const r = /"/;'],
    ['class C { #in = 1; f() { return this.#in / 2 + "["; } } const r = /"/;'],
    ['f([...typeof /"/]);'],
  ])("a division the pass must not take for a regex start, then /\"/ and a spawn of a changed file on the same line: held (%s)", (pre) => {
    expect(changed(pre).map((s) => s.detail).join(" ")).toMatch(/docs\/evil\.js/);
  });
  test("a division after ) or } that would swallow a backtick or a brace does not hide a later /\"/", () => {
    for (const first of ["x = (a) / 2 + `q/`;", "const t = `${(n) / 2}/x`;", "x = (a) / `q/,`.length;", "const t = `${(n) / 2}/;`;", "if (x) /`/.test(y);"]) {
      const o = { "package.json": pj, "hook.js": `${cp}${first}\nconst r = /"/; ${spawn}\n`, "docs/evil.js": "1;\n" };
      expect(hard(o, { ...o, "docs/evil.js": "require('child_process').execSync('id');\n" }).length).toBeGreaterThan(0);
    }
  });
  test("the pass blanks only regex bodies the main scan reads, and nothing in a file it cannot read", () => {
    expect(regexQuotesBlanked('x = obj.return / "a" / 2;')).toBeUndefined();
    expect(regexQuotesBlanked('let π = 1; π / "a" / 2;')).toBeUndefined();
    expect(regexQuotesBlanked('x = typeof /"/;')).toBe("x = typeof / /;");
    expect(regexQuotesBlanked('f([...typeof /"/]);')).toBe("f([...typeof / /]);");
    // An unclear / the main scan refuses: the file is a process hazard already (read as running anything).
    expect(regexQuotesBlanked('if (x) /"a b/.test(y) + "c";')).toBeUndefined();
  });
  test("control: a long line of division-like slashes with only an unrelated file changed stays quiet", () => {
    const worker = 'cp.spawnSync("node", ["./worker.js"]);';
    for (const line of ['x=obj.return/"[";'.repeat(1200), 'x = a /"[" + b;'.repeat(800)]) {
      const o = { "package.json": pj, "hook.js": `${cp}${line} ${worker}\n`, "worker.js": "1;\n", "other/x.txt": "1\n" };
      expect(hard(o, { ...o, "other/x.txt": "2\n" })).toEqual([]);
    }
  });
});

describe("budget: the regex reading is charged, and linear", () => {
  test("twice the regex literals cost about twice the steps", () => {
    // Each limit below the cost is a budget fault on purpose.
    allowFaults();
    const view = (body: string) => {
      const o = { "package.json": JSON.stringify({ name: "p", version: "1.0.0", scripts: { postinstall: "node lib/a.js" } }), "lib/a.js": body };
      return installView(new Map(Object.entries(o).map(([k, v]) => [k, enc.encode(v)])));
    };
    const fewest = (body: string): number => {
      let lo = 1;
      let hi = 100_000_000;
      while (lo < hi) {
        const m = Math.floor((lo + hi) / 2);
        setJsScanSteps(m);
        if (view(body).hold) lo = m + 1;
        else hi = m;
      }
      setJsScanSteps(undefined);
      return lo;
    };
    const lines = (k: number) => `${cp}${'x = /"/; y = "a";\n'.repeat(k)}`;
    const one = fewest(lines(200));
    const two = fewest(lines(400));
    const four = fewest(lines(800));
    expect(four - two).toBeLessThan(2.5 * (two - one));
    // One long line of slashes that open a class and never close: each / is read once, not rescanned to the line end.
    const long = (k: number) => `${cp}${"(a)/[ ".repeat(k)}]/ +1;\n`;
    const a = fewest(long(500));
    const b = fewest(long(1000));
    const c = fewest(long(2000));
    expect(c - b).toBeLessThan(2.5 * (b - a));
  });
});
