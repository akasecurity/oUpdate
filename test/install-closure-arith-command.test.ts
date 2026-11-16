import { expect, test } from "bun:test";
import { prepass, type FileMap } from "../src/prepass.ts";

const enc = (s: string) => new TextEncoder().encode(s);
const files = (o: Record<string, string>): FileMap => new Map(Object.entries(o).map(([k, v]) => [k, enc(v)]));
const holds = (old: FileMap, now: FileMap) => prepass("npm", old, now).hard.filter((s) => s.kind === "install-script").map((s) => s.detail);

// One file of the package changes between the two releases; the hook names none of them. name.txt holds the path of lib/evil.js.
const release = (v: string, hook: string, changed: "lib/evil.js" | "docs/evil.js" | "lib/ok.js" | "none", extra: Record<string, string> = {}) =>
  files({
    "package.json": JSON.stringify({ name: "p", version: v, scripts: { postinstall: hook } }),
    "lib/evil.js": changed === "lib/evil.js" && v !== "1.0.0" ? `console.log("evil ${v}")\n` : "console.log('evil')\n",
    "docs/evil.js": changed === "docs/evil.js" && v !== "1.0.0" ? `console.log("evil ${v}")\n` : "console.log('evil')\n",
    "lib/ok.js": changed === "lib/ok.js" && v !== "1.0.0" ? `console.log("ok ${v}")\n` : "console.log('ok')\n",
    "name.txt": "lib/evil.js\n",
    ...extra,
  });
const N = "$(cat name.txt)";

// A bare `(( ... ))` command evaluates its text as arithmetic, as `let` and `$(( ))` do: a variable that holds `a[$(cmd)]`, or a
// substitution in it (single-quoted too: bash 5 reads the text of `(( ))` as if in double quotes), runs the command. Checked with
// bash 5.2 and bash 3.2 on `x=$(cat name.txt); (( x == 0 ))` with name.txt holding `a[$(echo RAN >&2)]`: both run the command.
const held: [string, string][] = [
  ["a variable set from a substitution, compared on the next line", `x=${N}\n(( x == 0 ))`],
  ["the same on one line", `x=${N}; (( x == 0 ))`],
  ["a variable set from a substitution in an if", `x=${N}; if (( x )); then echo yes; fi`],
  ["a variable set from a substitution in an if, on lines", `x=${N}\nif (( x )); then\n  echo yes\nfi`],
  ["a variable set from a substitution after an and, on lines", `x=${N}\ntrue && (( x > 1 )) && echo big`],
  ["a variable set from a substitution, assigned in the command, on lines", `x=${N}\n(( y = x + 1 ))`],
  ["a variable set from a substitution, incremented, on lines", `x=${N}\n(( x++ ))`],
  ["a variable set from a backtick substitution", "x=`cat name.txt`\n(( x == 0 ))"],
  ["a variable set by a declaration", `declare x=${N}\n(( x == 0 ))`],
  ["a variable set from a substitution, a variable on the left", `x=${N}\n(( 0 == x ))`],
  ["a substitution in the expression, on a line", `echo start\n(( ${N} == 0 ))`],
  ["a single-quoted substitution on a line", `echo start\n(( '${N}' == 0 ))`],
  ["a variable set from a substitution after an and", `x=${N} && (( x > 1 )) && echo big`],
  ["a variable set from a substitution, assigned in the command", `x=${N}; (( y = x + 1 ))`],
  ["a variable set from a substitution, incremented", `x=${N}; (( x++ ))`],
  ["a substitution in the expression", `(( ${N} == 0 ))`],
  ["a single-quoted substitution in the expression", `(( '${N}' == 0 ))`],
  ["a substitution after a plain operand", `(( 1 + ${N} ))`],
  ["a variable and a single-quoted substitution", `x=1; (( x + '${N}' ))`],
];
for (const [label, hook] of held) {
  for (const changed of ["lib/evil.js", "docs/evil.js"] as const) {
    test(`${label} reads every file: a changed ${changed} holds`, () => {
      expect(holds(release("1.0.0", hook, "none"), release("1.0.1", hook, changed)).length).toBeGreaterThan(0);
    });
  }
}

// The same inside a file the hook runs.
test("a (( )) on a variable set from a substitution in a script the hook runs reads every file", () => {
  const extra = { "run.sh": `x=${N}\n(( x == 0 ))\n` };
  expect(holds(release("1.0.0", "sh run.sh", "none", extra), release("1.0.1", "sh run.sh", "docs/evil.js", extra)).length).toBeGreaterThan(0);
});

// Controls: an arithmetic command on plain values, a variable the arithmetic never reads, and text that only looks like one.
const quiet: [string, string][] = [
  ["a counter", "i=0\n(( i++ ))\nnode lib/ok.js"],
  ["a literal comparison", "n=1; (( n == 0 )) || node lib/ok.js"],
  ["a variable set from a substitution that is not in the arithmetic", `x=${N}; echo $x; (( 1 + 1 ))\nnode lib/ok.js`],
  ["a variable set to a plain value", "x=5; (( x == 0 ))\nnode lib/ok.js"],
  ["double parentheses in quotes", `x=${N}; echo "(( x == 0 ))"\nnode lib/ok.js`],
  ["a for loop on plain counters", "for (( i = 0; i < 3; i++ )); do echo $i; done\nnode lib/ok.js"],
];
for (const [label, hook] of quiet) {
  test(`${label} stays quiet: a changed docs/evil.js is not an install change`, () => {
    expect(holds(release("1.0.0", hook, "none"), release("1.0.1", hook, "docs/evil.js"))).toEqual([]);
  });
  test(`${label} still holds the file the hook runs`, () => {
    expect(holds(release("1.0.0", hook, "none"), release("1.0.1", hook, "lib/ok.js")).length).toBeGreaterThan(0);
  });
}

// Never narrower than before: the widening of a (( )) line must not hide a retarget of main (held when the line was not read).
const retarget = (hook: string) => (v: string) =>
  files({
    "package.json": JSON.stringify({ name: "p", version: v, main: v === "1.0.0" ? "lib/ok.js" : "docs/evil.js", scripts: { postinstall: hook } }),
    "lib/ok.js": "console.log('ok')\n",
    "docs/evil.js": "console.log('evil')\n",
    "name.txt": "lib/ok.js\n",
  });
for (const hook of [`x=${N}\n(( x ))\nnode .`, `(( '${N}' ))\nnode .`]) {
  test(`pin: a retarget of main still holds after ${JSON.stringify(hook)}`, () => {
    const mk = retarget(hook);
    expect(holds(mk("1.0.0"), mk("1.0.1")).length).toBeGreaterThan(0);
  });
}

// The widening of a bare (( )) line is a kind of reach of its own: it must not hide a retarget of main that the backslash reading
// resolves (`\node .`, `node \.`), which is held when the (( )) line is not there. Both files are the same bytes on both sides.
const escRetarget = (hook: string) => (v: string) =>
  files({
    "package.json": JSON.stringify({ name: "p", version: v, main: v === "1.0.0" ? "lib/ok.js" : "docs/evil.js", scripts: { postinstall: hook } }),
    "lib/ok.js": "console.log('ok')\n",
    "docs/evil.js": "console.log('ok')\n",
    "name.txt": "lib/ok.js\n",
  });
const BS = "\\";
for (const run of [`${BS}node .`, `node ${BS}.`, `echo a${BS}b ; node .`]) {
  for (const arith of [`x=${N}\n(( x ))`, `x=${N}\n(( x == 0 ))`, `(( '${N}' ))`]) {
    const hook = `${arith}\n${run}`;
    test(`a retarget of main the backslash reading resolves still holds after ${JSON.stringify(hook)}`, () => {
      const mk = escRetarget(hook);
      expect(holds(mk("1.0.0"), mk("1.0.1")).length).toBeGreaterThan(0);
    });
  }
  test(`pin: the same without the (( )) line holds: ${JSON.stringify(run)}`, () => {
    const mk = escRetarget(run);
    expect(holds(mk("1.0.0"), mk("1.0.1")).length).toBeGreaterThan(0);
  });
}
