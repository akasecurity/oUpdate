import { expect, test } from "bun:test";
import { prepass, type FileMap } from "../src/prepass.ts";

const enc = (s: string) => new TextEncoder().encode(s);
const files = (o: Record<string, string>): FileMap => new Map(Object.entries(o).map(([k, v]) => [k, enc(v)]));
const holds = (old: FileMap, now: FileMap) => prepass("npm", old, now).hard.some((s) => s.kind === "install-script");

// Lines the install-closure read held before a backslash outside quotes was read as the shell does, and must still hold. Only
// <changed> differs between the releases; the line is the hook itself (inline), or the code of run.js, which the hook runs.
const BS = "\\";
const NL = "\n";
type Row = { hook: string; run?: string; bin?: boolean; main?: string; same?: Record<string, string>; changed: string };
const release = (v: string, r: Row, changed: boolean): Record<string, string> => ({
  "package.json": JSON.stringify({ name: "p", version: v, ...(r.main ? { main: r.main } : {}), ...(r.bin ? { bin: { mytool: "docs/evil.js" } } : {}), scripts: { postinstall: r.run ? "node run.js" : r.hook } }),
  ...(r.run ? { "run.js": r.run + "\n" } : {}),
  "lib/a.js": "console.log(1)\n",
  ...r.same,
  [r.changed]: changed ? `EVIL ${v}\n` : "EVIL\n",
});
const held = (r: Row) => holds(files(release("1.0.0", r, false)), files(release("1.0.1", r, true)));
const inline = (hook: string, o: Partial<Row> = {}): Row => ({ hook, changed: "docs/evil.js", ...o });
const code = (run: string): Row => ({ hook: "", run, bin: true, changed: "docs/evil.js" });
const cp = (call: string) => `require("child_process").${call};`;

// Each is held on public main and on the line without the backslash.
const lost: [string, Row][] = [
  // An unresolved expansion on a line with a backslash: every file is read.
  ["a command substitution in an option of curl after an escaped word", inline(`echo a${BS}b ; curl -K"$(cat cfg)" lib/a.js`, { changed: "lib/evil.js", same: { cfg: "s/x/y/\n" } })],
  // A comment that ends in a backslash does not continue the line: the next line runs.
  ["node . after a comment that ends in a backslash", inline(`# note ${BS}${NL}node .`, { main: "docs/evil.js" })],
  ["node . after such a comment inside sh -c", inline(`sh -c '# note ${BS}${NL}node .'`, { main: "docs/evil.js" })],
  ["a bin after a comment that ends in a backslash", inline(`# trailing ${BS}${NL}mytool`, { bin: true })],
  // A decoded string in code does not end the read of the strings that follow it.
  ["execSync of an escaped string plus a bin name", code(cp(`execSync("echo a${BS}${BS}b; " + "mytool")`))],
  ["execSync of an escaped template string plus a bin name", code(cp("execSync(`echo a" + BS + BS + 'b; ` + "mytool")'))],
  ["execSync of a template string plus a bin name", code(cp('execSync(`echo hi; ` + "mytool")'))],
  ["execSync of a string with escaped quotes plus a bin name", code(cp(`execSync("echo ${BS}"ok${BS}"; " + "mytool")`))],
  ["spawnSync sh -c of an escaped string plus a bin name", code(cp(`spawnSync("sh", ["-c", "echo a${BS}${BS}b; " + "mytool"])`))],
  ["spawnSync sh -c of a tab escape plus a bin name", code(cp(`spawnSync("sh", ["-c", "${BS}t" + "mytool"])`))],
];
for (const [label, row] of lost) {
  test(`${label} holds the changed file`, () => {
    expect(held(row)).toBe(true);
  });
}
// Main holds this one too, though the shell does not run mytool (it is $0): never narrower than main.
test("pin: a word after an escaped -c string holds as on main", () => {
  expect(held(code(cp(`spawnSync("sh", ["-c", "echo a${BS}${BS}b", "mytool"])`)))).toBe(true);
});

// The lines without a backslash, held before and now.
const refs: [string, Row][] = [
  ["pin: node . after a comment with no backslash", inline(`# note${NL}node .`, { main: "docs/evil.js" })],
  ["pin: a bin after a comment with no backslash", inline(`# trailing${NL}mytool`, { bin: true })],
  ["pin: execSync of a plain string", code(cp(`execSync("mytool")`))],
];
for (const [label, row] of refs) {
  test(`${label} holds the changed file`, () => {
    expect(held(row)).toBe(true);
  });
}
const quiet: [string, Row][] = [
  ["a comment that ends in a backslash and a command that is not the bin", inline(`# trailing ${BS}${NL}othertool`, { bin: true })],
  ["an escaped string plus another name", code(cp(`execSync("echo a${BS}${BS}b; " + "other")`))],
  ["a template string plus another name", code(cp('execSync(`echo hi; ` + "other")'))],
];
for (const [label, row] of quiet) {
  test(`${label} stays quiet`, () => {
    expect(held(row)).toBe(false);
  });
}
