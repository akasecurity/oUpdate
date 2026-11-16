import { expect, test } from "bun:test";
import { prepass, type FileMap } from "../src/prepass.ts";

const enc = (s: string) => new TextEncoder().encode(s);
const files = (o: Record<string, string>): FileMap => new Map(Object.entries(o).map(([k, v]) => [k, enc(v)]));
const holds = (old: FileMap, now: FileMap) => prepass("npm", old, now).hard.some((s) => s.kind === "install-script");
const BS = "\\";
const NL = "\n";
const U5 = "\u0005";

type Fix = (v: string) => Record<string, string>;
const held = (fix: Fix) => holds(files(fix("1.0.0")), files(fix("1.0.1")));
const pkg = (v: string, hook: string, more: Record<string, unknown> = {}) => JSON.stringify({ name: "p", version: v, scripts: { postinstall: hook }, ...more });

// A package whose main is docs/evil.js; only docs/evil.js changes. The line runs `node .` (or the file) after a `cd` the shell skips or undoes.
const mainFix = (hook: string, extra: Record<string, string> = {}): Fix => (v) => ({
  "package.json": pkg(v, hook, { main: "docs/evil.js" }),
  "sub/a.js": "console.log(1)\n",
  ...extra,
  "docs/evil.js": v === "1.0.0" ? "EVIL\n" : "EVIL 1.0.1\n",
});
// The hook is `sh install.sh` and the line is in that file.
const inFile = (line: string, extra: Record<string, string> = {}): Fix => mainFix("sh install.sh", { "install.sh": line + NL, ...extra });
// The package config holds a command the line runs through an expansion; only docs/evil.js changes.
const cfgFix = (hook: string): Fix => (v) => ({
  "package.json": pkg(v, hook, { config: { x: "echo" } }),
  "lib/a.js": "console.log(1)\n",
  "docs/evil.js": v === "1.0.0" ? "EVIL\n" : "EVIL 1.0.1\n",
});
// Only the version changes (or lib/other.js does): the line runs no changed file.
const quietFix = (hook: string, extra: Record<string, string> = {}, changed = false): Fix => (v) => ({
  "package.json": pkg(v, hook),
  "lib/a.js": "console.log(1)\n",
  "lib/other.js": changed && v !== "1.0.0" ? "1;\n" : "0;\n",
  ...extra,
});

// Held on public main, and the shell runs the file: a `cd` in a comment, or one that `true ||` skips, does not move the shell, and
// a `cd sub` then `cd ..` ends in the root. The re-read of the line must not carry the `cd` to the next line or skip a script read.
const lost: [string, Fix][] = [
  ["a cd in a comment, then node . on the next line", mainFix(`# ; cd sub ${BS}${NL}node .`)],
  ["a cd before a comment that ends in a backslash, then cd .. and node .", mainFix(`cd sub # ${BS}${NL}cd .. && node .`)],
  ["the same, running a script that runs node .", mainFix(`cd sub # ${BS}${NL}cd .. && sh run.sh`, { "run.sh": "node .\n" })],
  ["a cd that || skips, an escaped word, node . on the next line", mainFix(`true || cd sub ; echo a${BS}b${NL}node .`)],
  ["the same with a ..-path to the file", mainFix(`true || cd sub ; echo a${BS}b${NL}node lib/../docs/evil.js`)],
  ["the same with an unresolved variable on the escaped line", mainFix(`true || cd sub ; echo a${BS}b "$X"${NL}node .`)],
  ["pin: the cd-in-a-comment line in a file the hook runs", inFile(`# ; cd sub ${BS}${NL}node .`)],
  ["pin: the cd that || skips in a file the hook runs", inFile(`true || cd sub ; echo a${BS}b${NL}node .`)],
  // An unresolved config expansion on a line with a backslash: main held it by the rule (the line reads every file).
  ["eval with an escaped word and a config expansion", cfgFix(`true${NL}eval echo a${BS}b $npm_package_config_x`)],
  ["sh -c of a config expansion after an escaped word", cfgFix(`true${NL}echo a${BS}b && sh -c "$npm_package_config_x"`)],
  // The new reading must not mark run.sh read (under the skipped cd) before main's reading of the same text reads it from the root.
  ["a cd that || skips, an escaped word, sh run.sh on the same line", mainFix(`true || cd sub ; echo a${BS}b ; sh run.sh`, { "run.sh": "node .\n" })],
  ["a cd in a comment, then an escaped word and sh run.sh", mainFix(`# ; cd sub ${BS}${NL}echo a${BS}b ; sh run.sh`, { "run.sh": "node .\n" })],
  ["a cd that || skips, an escaped word, an unresolved variable, sh run.sh", mainFix(`true || cd sub ; echo a${BS}b "$X" ; sh run.sh`, { "run.sh": "node .\n" })],
  ["the same, sh run.sh again on the next line", mainFix(`true || cd sub ; echo a${BS}b "$X" ; sh run.sh${NL}sh run.sh`, { "run.sh": "node .\n" })],
  ["an unresolved line, then the skipped cd, an escaped word and sh run.sh", mainFix(`echo "$X"${NL}true || cd sub ; echo a${BS}b ; sh run.sh`, { "run.sh": "node .\n" })],
  // An escaped line reached from readParts after a pipe elsewhere in the body: main noted the raw line.
  ["eval with an escaped word and a config expansion after a pipe", cfgFix(`true | cat${NL}eval echo a${BS}b $npm_package_config_x`)],
  // A control byte after an escaped word: main held the line by the rule.
  ["an escaped word and a U+0005 byte on a one-line body", (v) => ({ "package.json": pkg(v, `echo a${BS}b${U5}`), "docs/evil.js": v === "1.0.0" ? "EVIL\n" : "EVIL 1.0.1\n" })],
];
for (const [label, fix] of lost) {
  test(`${label} holds the changed docs/evil.js`, () => {
    expect(held(fix)).toBe(true);
  });
}
// The cd is real: the same lines without the cd's skip hold the file the shell runs.
test("node . in the root after cd sub and cd .. holds as the line without a backslash does", () => {
  expect(held(mainFix(`cd sub ; cd .. ; node .`))).toBe(true);
  expect(held(mainFix(`node .`))).toBe(true);
});

// Quiet on public main and still quiet: a version-only change of a line with a quoted newline and an unquoted backslash was read to the
// script depth cap and held; a backslash before a newline continues the line and is not a command.
const quiet: [string, Fix][] = [
  ["a quoted newline and an escaped space (inline)", quietFix(`echo "Done.${NL}Run it" ; cp a${BS} b c`)],
  ["a quoted newline and an escaped space (file)", quietFix("sh install.sh", { "install.sh": `echo "Done.${NL}Run it" ; cp a${BS} b c${NL}` })],
  ["sh -c with a quoted newline and an escaped character", quietFix(`sh -c 'echo "a${NL}b"; echo x${BS}y'`)],
  ["sh -c with a quoted newline and an escaped character (file)", quietFix("sh install.sh", { "install.sh": `sh -c 'echo "a${NL}b"; echo x${BS}y'${NL}` })],
  ["a single-quoted newline and an escaped space", quietFix(`echo 'a${NL}b' ; echo c${BS} d`)],
  ["a continued line after true &&", quietFix(`true && ${BS}${NL}  echo ok`, {}, true)],
  ["a continued line after echo a &&", quietFix(`echo a && ${BS}${NL}  echo b`, {}, true)],
  ["a continued line after node lib/a.js &&", quietFix(`node lib/a.js && ${BS}${NL}  node lib/b.js`, { "lib/b.js": "1;\n" }, true)],
];
for (const [label, fix] of quiet) {
  test(`${label} stays quiet`, () => {
    expect(held(fix)).toBe(false);
  });
}
// The quiet lines still hold when they run a file that changed.
test("the continued line holds when the file it continues to changes", () => {
  const fix: Fix = (v) => ({ "package.json": pkg(v, `node lib/a.js && ${BS}${NL}  node lib/b.js`), "lib/a.js": "console.log(1)\n", "lib/b.js": v === "1.0.0" ? "1;\n" : "2;\n" });
  expect(held(fix)).toBe(true);
});
test("a quoted newline, an escaped space and a changed file the line runs hold", () => {
  const fix: Fix = (v) => ({ "package.json": pkg(v, `echo "Done.${NL}Run it" ; cp a${BS} b c ; node docs/evil.js`), "docs/evil.js": v === "1.0.0" ? "EVIL\n" : "EVIL 1.0.1\n" });
  expect(held(fix)).toBe(true);
});

// Time: one long line with a quoted newline and many escaped spaces reads in a small multiple of the same line without the backslashes.
test("a long line with a quoted newline and escaped spaces reads in linear time", () => {
  const body = (esc: boolean) => `echo "x${NL}y" ; ` + (esc ? `a${BS} ` : "a ").repeat(20_000);
  const time = (line: string) => {
    const t = performance.now();
    held(quietFix(line));
    return performance.now() - t;
  };
  time(body(false));
  const plain = Math.max(time(body(false)), 5);
  const escaped = time(body(true));
  expect(escaped).toBeLessThan(plain * 20 + 500);
});
