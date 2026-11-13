import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { prepass, type FileMap } from "../src/prepass.ts";

const enc = (s: string) => new TextEncoder().encode(s);
const files = (o: Record<string, string>): FileMap => new Map(Object.entries(o).map(([k, v]) => [k, enc(v)]));
const holds = (old: FileMap, now: FileMap) => prepass("npm", old, now).hard.some((s) => s.kind === "install-script");

// A backslash outside quotes is removed by the shell and leaves the next character as it is: `d\ocs/evil.js` is docs/evil.js, and a
// backslash before a newline vanishes. Only <dir>/evil.js changes between the releases. The hook is the line itself ("inline") or
// `sh install.sh` with the line in that file ("file").
type Mode = "inline" | "file";
const release = (v: string, line: string, dir: string, mode: Mode, changed = true): Record<string, string> => ({
  "package.json": JSON.stringify({ name: "p", version: v, scripts: { postinstall: mode === "inline" ? line : "sh install.sh" } }),
  ...(mode === "file" ? { "install.sh": line + "\n" } : {}),
  "lib/a.js": "console.log(1)\n",
  [`${dir}/other.js`]: "console.log(2)\n",
  [`${dir}/ev\\il.js`]: "console.log(3)\n",
  [`${dir}/evil.js`]: changed ? `EVIL ${v}\n` : "EVIL\n",
});
const held = (line: string, dir: string, mode: Mode) => holds(files(release("1.0.0", line, dir, mode)), files(release("1.0.1", line, dir, mode)));

// Ground truth: the line run by the real shells in a copy of the new release. The node shim records a run of a file that holds EVIL.
const SHELLS = ["bash", "sh", ...(existsSync("/bin/dash") ? ["/bin/dash"] : [])];
const ranUnder = (line: string, dir: string, mode: Mode): boolean[] => {
  const root = mkdtempSync(join(tmpdir(), "bs-"));
  try {
    const shim = join(root, "bin", "node");
    mkdirSync(dirname(shim), { recursive: true });
    writeFileSync(shim, 'grep -q EVIL "$1" 2>/dev/null && echo ran > "$MARK"\nexit 0\n');
    chmodSync(shim, 0o755);
    const pkg = join(root, "p");
    for (const [name, text] of Object.entries(release("1.0.1", line, dir, mode))) {
      if (name === "package.json") continue;
      mkdirSync(dirname(join(pkg, name)), { recursive: true });
      writeFileSync(join(pkg, name), text);
    }
    return SHELLS.map((sh) => {
      const mark = join(root, `ran-${SHELLS.indexOf(sh)}`);
      spawnSync(sh, mode === "inline" ? ["-c", line] : ["install.sh"], { cwd: pkg, env: { ...process.env, PATH: `${join(root, "bin")}:${process.env.PATH}`, MARK: mark }, stdio: "ignore", timeout: 20_000 });
      return existsSync(mark);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

// Each form names <dir>/evil.js, and every shell runs it.
const forms: [string, (d: string) => string][] = [
  ["a backslash inside the directory name", (d) => `node ${d[0]}\\${d.slice(1)}/evil.js`],
  ["a backslash inside the file name", (d) => `node ${d}/e\\vil.js`],
  ["a backslash before the slash", (d) => `node ${d}\\/evil.js`],
  ["a backslash at the start of the word", (d) => `node \\${d}/evil.js`],
  ["a backslash before the dot", (d) => `node ${d}/evil\\.js`],
  ["a backslash before every character", (d) => `node ${[...`${d}/evil.js`].map((c) => `\\${c}`).join("")}`],
  ["a backslash in the directory and in the file", (d) => `node ${d[0]}\\${d.slice(1)}/e\\vil.js`],
  ["a line continuation inside the file name", (d) => `node ${d}/ev\\\nil.js`],
  ["a line continuation inside double quotes", (d) => `node "${d}/ev\\\nil.js"`],
  ["a backslash before a quote in double quotes", (d) => `node "${d}/evil.js" "\\""`],
  ["an escaped quote earlier on the line", (d) => `echo \\'; node ${d}/evil.js`],
  ["an escaped double quote earlier on the line", (d) => `echo \\"; node ${d}/evil.js`],
  ["an escaped space earlier on the line", (d) => `echo a\\ b; node ${d}/evil.js`],
  ["a backslash in the directory of a cd", (d) => `cd ${d[0]}\\${d.slice(1)} && node evil.js`],
  ["a backslash in the directory of a cd after an escaped quote", (d) => `echo \\'; cd ${d[0]}\\${d.slice(1)} && node evil.js`],
  ["a backslash next to a single-quoted part", (d) => `node ${d[0]}\\${d.slice(1)}'/'evil.js`],
];
for (const dir of ["lib", "docs", "test"]) {
  for (const mode of ["inline", "file"] as const) {
    for (const [label, form] of forms) {
      const line = form(dir);
      test(`${label} holds the changed ${dir}/evil.js (${mode})`, () => {
        expect(held(line, dir, mode)).toBe(true);
      });
    }
  }
}
// The held forms are held for a reason: every shell runs the file.
test("every held form runs the changed file under bash, sh and dash", () => {
  for (const dir of ["lib", "docs"]) {
    for (const [label, form] of forms) {
      const ran = ranUnder(form(dir), dir, "inline");
      expect([label, ran]).toEqual([label, SHELLS.map(() => true)]);
    }
  }
});

// Benign lines that must stay quiet: a backslash that does not name the changed file.
const quiet: [string, (d: string) => string, Mode[]?][] = [
  ["an escaped space in an argument", () => "echo a\\ b\nnode lib/a.js"],
  ["a line continuation in an unrelated command", () => "echo one \\\n  two && node lib/a.js", ["inline"]],
  ["an escaped space in an argument of a package script", () => "node lib/a.js --name=a\\ b"],
  ["a doubled backslash in the file name, a different file", (d) => `node ${d}/ev\\\\il.js`],
  ["a backslash inside double quotes, a different file", (d) => `node "${d}/ev\\il.js"`],
  ["a backslash inside single quotes, a different file", (d) => `node '${d}/ev\\il.js'`],
  ["a backslash that names another unchanged file", (d) => `node ${d}/oth\\er.js`],
  ["a backslash in the directory, another unchanged file", (d) => `node ${d[0]}\\${d.slice(1)}/other.js`],
  ["an escaped dollar sign", () => "echo \\$HOME\nnode lib/a.js"],
];
for (const dir of ["lib", "docs", "test"]) {
  for (const mode of ["inline", "file"] as const) {
    for (const [label, form, only] of quiet) {
      if (only && !only.includes(mode)) continue;
      const line = form(dir);
      test(`${label} stays quiet when only ${dir}/evil.js changes (${mode})`, () => {
        expect(held(line, dir, mode)).toBe(false);
      });
    }
  }
}
test("the quiet lines do not run the changed file under bash, sh and dash", () => {
  for (const [label, form] of quiet) {
    const ran = ranUnder(form("docs"), "docs", "inline");
    expect([label, ran]).toEqual([label, SHELLS.map(() => false)]);
  }
});

// Time. A long run of backslashes and many words with backslashes: 0.125, 1 and 8 MB (the words from 0.0625 to 1 MB). Each size must
// stay within a small multiple of the same size of plain lines, plus a floor that grows with the size, and must grow no faster than the
// size from one size to the next (a quadratic scan takes seconds at 0.125 MB and minutes at 1 MB).
const grows = (small: number, large: number, factor: number, floor = 2): boolean => large < 3 * factor * Math.max(small, floor);
const rep = (mb: number, unit: string) => unit.repeat(Math.max(1, Math.floor((mb * 1_000_000) / unit.length)));
const timed = (line: string): { ms: number; held: boolean } => {
  const old = files(release("1.0.0", "sh install.sh", "docs", "file"));
  const now = files(release("1.0.1", "sh install.sh", "docs", "file"));
  old.set("install.sh", enc(line));
  now.set("install.sh", enc(line));
  const s = performance.now();
  const h = holds(old, now);
  return { ms: performance.now() - s, held: h };
};
// The control is the same size of plain lines, or for many words the same words with quotes where the others have backslashes.
const shapes: [string, number[], (mb: number) => string, (mb: number) => string][] = [
  ["a run of doubled backslashes", [0.125, 1, 8], (mb) => `echo ${rep(mb, "\\\\")}; node d\\ocs/evil.js\n`, (mb) => `${rep(mb, "echo ab cd ef\n")}node docs/evil.js\n`],
  ["many words with backslashes", [0.0625, 0.25, 1], (mb) => `${rep(mb, "a\\ b\\\\c ")}\nnode d\\ocs/evil.js\n`, (mb) => `${rep(mb, "a 'b' 'bc' ")}\nnode docs/evil.js\n`],
];
for (const [label, sizes, make, plain] of shapes) {
  test(`${label} grow with the file and still hold`, () => {
    let prev = 0;
    let prevMb = 0;
    for (const mb of sizes) {
      const r = timed(make(mb));
      const control = timed(plain(mb)).ms;
      expect(r.held).toBe(true);
      expect(r.ms).toBeLessThan(6 * control + 100 * mb + 100);
      if (prev > 0) expect(grows(prev, r.ms, mb / prevMb)).toBe(true);
      prev = r.ms;
      prevMb = mb;
    }
  }, 90_000);
}
