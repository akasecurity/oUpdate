import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { prepass, type FileMap } from "../src/prepass.ts";

const enc = (s: string) => new TextEncoder().encode(s);
const files = (o: Record<string, string>): FileMap => new Map(Object.entries(o).map(([k, v]) => [k, enc(v)]));
const holds = (old: FileMap, now: FileMap) => prepass("npm", old, now).hard.some((s) => s.kind === "install-script");

// A backslash outside quotes inside a command line. The shell makes the next character literal and drops the backslash: `l\ib/evil.js`
// is lib/evil.js, `a\;b` is one word, and `node .` after `echo a\b ;` still runs the package's main. Only <dir>/evil.js changes
// between the releases (it is the package's main). The hook is the line itself (inline), `sh install.sh` with the line in that file
// (file), or `node run.js` where run.js executes the line (execSync, or spawnSync("sh", ["-c", line])).
type Mode = "inline" | "file" | "exec" | "spawn";
const release = (v: string, line: string, dir: string, mode: Mode, changed = true): Record<string, string> => ({
  "package.json": JSON.stringify({ name: "p", version: v, main: `${dir}/evil.js`, scripts: { postinstall: mode === "inline" ? line : mode === "file" ? "sh install.sh" : "node run.js" } }),
  ...(mode === "file" ? { "install.sh": line + "\n" } : {}),
  ...(mode === "exec" ? { "run.js": `require("child_process").execSync(${JSON.stringify(line)});\n` } : {}),
  ...(mode === "spawn" ? { "run.js": `require("child_process").spawnSync("sh", ["-c", ${JSON.stringify(line)}]);\n` } : {}),
  "lib/a.js": "console.log(1)\n",
  [`${dir}/other.js`]: "console.log(2)\n",
  [`${dir}/ev\\il.js`]: "console.log(3)\n",
  [`${dir}/evil.js`]: changed ? `EVIL ${v}\n` : "EVIL\n",
});
const held = (line: string, dir: string, mode: Mode) => holds(files(release("1.0.0", line, dir, mode, false)), files(release("1.0.1", line, dir, mode)));

// Ground truth for the lines in inline form: the real shells run the line in a copy of the new release; the node shim records a run of
// a file that holds EVIL.
const SHELLS = ["bash", "sh", ...(existsSync("/bin/dash") ? ["/bin/dash"] : [])];
const ranUnder = (line: string, dir: string): boolean[] => {
  const root = mkdtempSync(join(tmpdir(), "bss-"));
  try {
    const shim = join(root, "bin", "node");
    mkdirSync(dirname(shim), { recursive: true });
    writeFileSync(shim, 'for f in "$@"; do [ "$f" = . ] && f="' + dir + '/evil.js"; grep -q EVIL "$f" 2>/dev/null && echo ran > "$MARK"; done\nexit 0\n');
    chmodSync(shim, 0o755);
    const pkg = join(root, "p");
    for (const [name, text] of Object.entries(release("1.0.1", line, dir, "inline"))) {
      if (name === "package.json") continue;
      mkdirSync(dirname(join(pkg, name)), { recursive: true });
      writeFileSync(join(pkg, name), text);
    }
    return SHELLS.map((sh, k) => {
      const mark = join(root, `ran-${k}`);
      spawnSync(sh, ["-c", line], { cwd: pkg, env: { ...process.env, PATH: `${join(root, "bin")}:${process.env.PATH}`, MARK: mark }, stdio: "ignore", timeout: 20_000 });
      return existsSync(mark);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

const bs = (d: string) => `${d[0]}\\${d.slice(1)}`; // a backslash before the second character: l\ib
// [label, line, modes where the line is already held on main (pin), the modes it is not held on main (red)]
const ALL: Mode[] = ["inline", "file", "exec", "spawn"];
const forms: [string, (d: string) => string, Mode[]][] = [
  // The path word has the backslash: held on main for a script and a file, not for a string in code.
  ["a backslash inside the directory of a path word", (d) => `node ${bs(d)}/evil.js`, ["inline", "file"]],
  ["a backslash in the directory of a cd", (d) => `cd ${bs(d)} && node evil.js`, ["inline", "file"]],
  ["a backslash before the slash", (d) => `node ${d}\\/evil.js`, ["inline", "file"]],
  ["an escaped word before a path word", (d) => `echo a\\b ; node ${d}/evil.js`, ["inline", "file"]],
  // The command is `node .` (or a name resolved by the package) and a backslash sits elsewhere on the line: the line was not split.
  ["node . after an escaped word", () => `echo a\\b ; node .`, []],
  ["node . after an escaped word and &&", () => `echo a\\b && node .`, []],
  ["node . before an escaped word", () => `node . ; echo a\\b`, []],
  ["node . after an escaped space", () => `echo a\\ b ; node .`, []],
  ["node . after an escaped first character", () => `echo \\a ; node .`, []],
  ["node . after a doubled backslash", () => `echo a\\\\b ; node .`, []],
  ["node . with a quoted dot after an escaped word", () => `echo a\\b ; node "."`, []],
  ["a path with dots after an escaped word", (d) => `echo a\\b ; node ${d}/../${d}/evil.js`, []],
];
for (const dir of ["lib", "docs", "test"]) {
  for (const [label, form, pinned] of forms) {
    for (const mode of ALL) {
      // `node .` is not read from a string in code on main either: those rows are for the lines that name a path.
      if (mode === "exec" || mode === "spawn") {
        const line = form(dir);
        if (/node \.|node "\."|\.\.\/|cd /.test(line)) continue;
      }
      const pin = pinned.includes(mode) ? "pin: " : "";
      test(`${pin}${label} holds the changed ${dir}/evil.js (${mode})`, () => {
        expect(held(form(dir), dir, mode)).toBe(true);
      });
    }
  }
}
// The held lines are held for a reason: every shell runs the file.
test("every held line runs the changed file under bash, sh and dash", () => {
  for (const dir of ["lib", "docs"]) {
    for (const [label, form] of forms) {
      const ran = ranUnder(form(dir), dir);
      expect([label, ran]).toEqual([label, SHELLS.map(() => true)]);
    }
  }
});

// Lines that must stay quiet when only <dir>/evil.js changes: the backslash makes a character literal or the file is another one.
const quiet: [string, (d: string) => string][] = [
  ["an escaped word and another unchanged file", (d) => `echo a\\b ; node ${d}/other.js`],
  ["an escaped semicolon makes the node word an argument of echo", () => `echo a\\; node .`],
  ["a doubled backslash in the file name, a different file", (d) => `node ${d}/ev\\\\il.js`],
  ["a backslash in the directory, another unchanged file", (d) => `node ${bs(d)}/other.js`],
  ["a backslash inside double quotes, a different file", (d) => `node "${d}/ev\\il.js"`],
];
for (const dir of ["lib", "docs", "test"]) {
  for (const [label, form] of quiet) {
    for (const mode of ALL) {
      test(`${label} stays quiet when only ${dir}/evil.js changes (${mode})`, () => {
        // In code the string `ev\\il.js` has a doubled backslash once decoded.
        const line = form(dir);
        expect(held(line, dir, mode)).toBe(false);
      });
    }
  }
}
test("the quiet lines do not run the changed file under bash, sh and dash", () => {
  for (const [label, form] of quiet) {
    const ran = ranUnder(form("docs"), "docs");
    expect([label, ran]).toEqual([label, SHELLS.map(() => false)]);
  }
});

// Held as the line without the backslash is: `--name=ab` already reads the whole directory on public main (an option with an `=` may
// name a path), so `--name=a\ b` is read the same way now. Before, the backslash made the line unreadable and it was quiet.
for (const mode of ["inline", "file"] as const) {
  test(`an escaped space in an option with = holds the changed lib/evil.js like the line without it (${mode})`, () => {
    expect(held("node lib/a.js --name=a\\ b", "lib", mode)).toBe(true);
    expect(held("node lib/a.js --name=ab", "lib", mode)).toBe(true);
  });
}
