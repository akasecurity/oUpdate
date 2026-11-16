import { expect, test } from "bun:test";
import { prepass, type FileMap } from "../src/prepass.ts";

const enc = (s: string) => new TextEncoder().encode(s);
const files = (o: Record<string, string>): FileMap => new Map(Object.entries(o).map(([k, v]) => [k, enc(v)]));
const holds = (old: FileMap, now: FileMap) => prepass("npm", old, now).hard.some((s) => s.kind === "install-script");
const BS = "\\";
const NL = "\n";

type Fix = (v: string) => Record<string, string>;
const held = (fix: Fix) => holds(files(fix("1.0.0")), files(fix("1.0.1")));
const js = (v: string) => `console.log(${JSON.stringify(v)});\n`;

// The backslash reading (the commands a split reads only by taking a backslash, a JS string read by its decoded value) reads on
// records of its own: it must not mark a script read for the reading main had of the same package, nor empty the new-files check
// that catches a retarget of main.

// A package whose main is docs/evil.js; only docs/evil.js changes. run.sh runs node . from the root.
const rootFix = (scripts: Record<string, string>, extra: Record<string, string> = {}, config?: Record<string, string>): Fix => (v) => ({
  "package.json": JSON.stringify({ name: "p", version: v, main: "docs/evil.js", ...(config ? { config } : {}), scripts }),
  "sub/a.js": "console.log(1)\n",
  "run.sh": "node .\n",
  ...extra,
  "docs/evil.js": v === "1.0.0" ? "EVIL\n" : "EVIL 1.0.1\n",
});
// A commented-out `cd sub ; sh run.sh` (or one a `true ||` skips) marked run.sh read from sub; the real `sh run.sh` after it was skipped.
const poisoned: [string, Fix][] = [
  ["a comment with a backslash in preinstall, a real sh run.sh in postinstall", rootFix({ preinstall: `# see C:${BS}foo ; cd sub ; sh run.sh`, postinstall: "sh run.sh" })],
  ["pin: the same comment in a file the hook runs", rootFix({ postinstall: "sh a.sh ; sh run.sh" }, { "a.sh": `# see C:${BS}foo ; cd sub ; sh run.sh\n` })],
  ["pin: the same comment on the line before a real sh run.sh", rootFix({ postinstall: `# see C:${BS}foo ; cd sub ; sh run.sh${NL}sh run.sh` })],
  ["pin: a skipped cd and an escaped word in preinstall, a real sh run.sh in postinstall", rootFix({ preinstall: `true || cd sub ; echo a${BS}b ; sh run.sh`, postinstall: "sh run.sh" })],
  ["pin: a skipped cd, a config-named script, an unresolved variable, then sh run.sh", rootFix({ postinstall: `true || cd sub ; true || sh $npm_package_config_s ; echo a${BS}b "$X"${NL}sh run.sh` }, {}, { s: "run.sh" })],
];
for (const [label, fix] of poisoned) {
  test(`${label} holds the changed docs/evil.js`, () => {
    expect(held(fix)).toBe(true);
  });
}

// A string in code read by its decoded value reaches docs/a.js on the old release too: the retarget of main to docs/a.js, which
// holds on main, must still show as a new file reached.
const retarget = (runjs: string): Fix => (v) => ({
  "package.json": JSON.stringify({ name: "p", version: v, main: v === "1.0.0" ? "run.js" : "docs/a.js", scripts: { postinstall: "node run.js ; node ." } }),
  "run.js": runjs,
  "docs/a.js": "require('child_process').execSync('id')\n",
});
test("a retarget of main to a file only a decoded string names still holds", () => {
  expect(held(retarget('if (false) require("child_process").execSync("node d\\\\ocs/a.js");\n'))).toBe(true);
});
const same = (runjs: string, changed: boolean): Fix => (v) => ({
  "package.json": JSON.stringify({ name: "p", version: v, main: "run.js", scripts: { postinstall: "node run.js ; node ." } }),
  "run.js": runjs,
  "docs/a.js": changed ? js(v) : "require('child_process').execSync('id')\n",
});
test("a decoded string that names an unchanged file stays quiet", () => {
  expect(held(same('if (false) require("child_process").execSync("node d\\\\ocs/a.js");\n', false))).toBe(false);
});
test("a decoded string that names a changed file holds", () => {
  expect(held(same('require("child_process").execSync("node d\\\\ocs/a.js");\n', true))).toBe(true);
});

// A comment is not a command: a backslash in it splits nothing, and a bracket in it is not a glob.
const okFix = (hook: string, changed: string[] = []): Fix => (v) => ({
  "package.json": JSON.stringify({ name: "p", version: v, scripts: { postinstall: hook } }),
  "lib/ok.js": changed.includes("lib/ok.js") ? js(v) : "console.log(1);\n",
  "lib/unused.js": changed.includes("lib/unused.js") ? js(v) : "console.log(2);\n",
});
const comments: [string, string][] = [
  ["a comment with a Windows path and a bracket", `# Windows: C:${BS}Users${BS}foo [optional]${NL}node lib/ok.js`],
  ["a comment with a Windows path", `# Windows: C:${BS}Users${BS}foo${NL}node lib/ok.js`],
];
for (const [label, hook] of comments) {
  test(`${label} stays quiet on a version-only change`, () => {
    expect(held(okFix(hook))).toBe(false);
  });
  test(`${label} stays quiet when an unused file changes`, () => {
    expect(held(okFix(hook, ["lib/unused.js"]))).toBe(false);
  });
  test(`${label} holds when the file the next line runs changes`, () => {
    expect(held(okFix(hook, ["lib/ok.js"]))).toBe(true);
  });
}

// Nested eval: each level reads its text once on the backslash reading too, so the time grows with the size, not with 2^levels.
const dq = (s: string) => `"${s.replace(/[\\"$`]/g, (m) => BS + m)}"`;
const nested = (levels: number, esc: boolean, inner = "node lib/a.js"): string => {
  const echo = esc ? `echo a${BS}b` : "echo ab";
  let body = inner;
  for (let i = 0; i < levels; i++) body = `${echo}${NL}eval ${dq(body)}`;
  return body;
};
const nestFix = (hook: string, changed = false): Fix => (v) => ({
  "package.json": JSON.stringify({ name: "p", version: v, scripts: { postinstall: hook } }),
  "lib/a.js": changed && v !== "1.0.0" ? js(v) : "console.log(1);\n",
});
test("eval nested fourteen levels with an escaped word reads in a small multiple of the line without it", () => {
  // One warm-up read per side, then five samples taken in turn (plain, escaped, plain, ...) so a burst of noise hits both sides, and the
  // smallest of each: a slow run (a busy machine) only adds time. Reading each level twice makes fourteen levels thousands of times
  // slower, so a multiple of 15 still catches it.
  const hooks = { plain: nested(14, false), escaped: nested(14, true) };
  const read = (hook: string): number => {
    const t = performance.now();
    held(nestFix(hook));
    return performance.now() - t;
  };
  read(hooks.plain);
  read(hooks.escaped);
  let plain = Infinity;
  let escaped = Infinity;
  for (let i = 0; i < 5; i++) {
    plain = Math.min(plain, read(hooks.plain));
    escaped = Math.min(escaped, read(hooks.escaped));
  }
  expect(escaped).toBeLessThan(Math.max(plain, 5) * 15 + 100);
}, 30_000);
test("eval nested three levels with an escaped word holds the changed file it runs", () => {
  expect(held(nestFix(nested(3, true), true))).toBe(true);
});
test("an escaped word, then an eval of a command that runs a changed file, holds", () => {
  const fix: Fix = (v) => ({ "package.json": JSON.stringify({ name: "p", version: v, scripts: { postinstall: `echo a${BS}b${NL}eval "node lib/evil.js"` } }), "lib/evil.js": js(v) });
  expect(held(fix)).toBe(true);
});

// The same for the other bodies that read a text again: sh -c nested fourteen levels, each with an escaped word.
const nestedSh = (levels: number, esc: boolean): string => {
  const echo = esc ? `echo a${BS}b` : "echo ab";
  let body = "node lib/a.js";
  for (let i = 0; i < levels; i++) body = `${echo}${NL}sh -c ${dq(body)}`;
  return body;
};
test("sh -c nested fourteen levels with an escaped word reads in a small multiple of the line without it", () => {
  const time = (esc: boolean): number => {
    const hook = nestedSh(14, esc);
    const t = performance.now();
    held(nestFix(hook));
    return performance.now() - t;
  };
  time(false);
  const plain = Math.max(time(false), 5);
  const escaped = time(true);
  expect(escaped).toBeLessThan(plain * 40 + 400);
});
test("pin: sh -c nested three levels with an escaped word holds the changed file it runs", () => {
  expect(held(nestFix(nestedSh(3, true), true))).toBe(true);
});
