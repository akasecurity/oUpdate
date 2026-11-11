import { expect, test } from "bun:test";
import { prepass, type FileMap } from "../src/prepass.ts";

const enc = (s: string) => new TextEncoder().encode(s);
const files = (o: Record<string, string>): FileMap => new Map(Object.entries(o).map(([k, v]) => [k, enc(v)]));
const holds = (old: FileMap, now: FileMap) => prepass("npm", old, now).hard.filter((s) => s.kind === "install-script").map((s) => s.detail);

// A hook line the shell reader cannot split (a pipe, a redirect, a subshell) that also holds an expansion it cannot resolve
// runs a file the text does not name. Only one file of the package changes between the two releases.
const release = (v: string, hook: string, changed: "lib/evil.js" | "docs/evil.js" | "none") =>
  files({
    "package.json": JSON.stringify({ name: "p", version: v, scripts: { postinstall: hook } }),
    "lib/evil.js": changed === "lib/evil.js" ? `console.log("evil ${v}")\n` : "console.log('evil')\n",
    "docs/evil.js": changed === "docs/evil.js" ? `console.log("evil ${v}")\n` : "console.log('evil')\n",
    "lib/ok.js": "console.log('ok')\n",
    "name.txt": "lib/evil.js\n",
  });

const unresolved: [string, string][] = [
  ["a printf-built file name before a pipe", 'node $(printf "%s" "lib/evil.js") | cat'],
  ["a substituted file name before a pipe into tee", "node $(cat name.txt) | tee out"],
  ["a substituted script for sh before a pipe", "sh $(cat name.txt) | grep x"],
  ["a backtick file name before a pipe", "node `cat name.txt` | cat"],
  ["a substituted file name at the end of a pipe", "echo ok | node $(cat name.txt)"],
  ["a substituted file name with a redirect", "node $(cat name.txt) 2>&1 | cat"],
  ["a substituted file name in a subshell", "(node $(cat name.txt)) | cat"],
  ["a substituted file name in the middle of a long pipe", "node $(cat name.txt) | cat | wc"],
  ["an assigned substitution that runs a package file", "x=$(node $(cat name.txt)) | cat"],
  ["an unresolved command word before a pipe", "$(echo node) lib/evil.js | cat"],
];

for (const [label, hook] of unresolved) {
  for (const changed of ["lib/evil.js", "docs/evil.js"] as const) {
    test(`${label} reads every file: a changed ${changed} holds`, () => {
      expect(holds(release("1.0.0", hook, "none"), release("1.0.1", hook, changed)).length).toBeGreaterThan(0);
    });
  }
}

const controls: [string, string][] = [
  ["an echo of a substitution into a pipe", "echo $(date) | cat"],
  ["a literal node file into a pipe, the other file changed", "node lib/ok.js | cat"],
  ["a plain pipe of readers", "true | cat"],
  ["an echo of a substitution", "echo $(date)"],
  ["a printf of a substitution into a reader", 'printf "%s" $(date) | grep x'],
];

for (const [label, hook] of controls) {
  test(`${label} stays quiet when an unrelated file changes`, () => {
    expect(holds(release("1.0.0", hook, "none"), release("1.0.1", hook, "lib/evil.js"))).toEqual([]);
  });
}

// Code inside a substitution, a reader piped into a shell, and quotes and escapes in the stage cutter.
const nested: [string, string][] = [
  ["a node run inside a substitution of a no-op", ': $(node $(printf "%s" "lib/evil.js"))'],
  ["a node run inside a substitution of echo into a pipe", "echo $(node $(cat name.txt)) | cat"],
  ["a shell run inside a substitution with a redirect", "true $(sh $(cat name.txt)) > log"],
  ["a node run after a separator inside an assigned substitution", "x=$(echo; node $(cat name.txt)) | cat"],
  ["a substitution inside the arguments of a make inside a substitution", "x=$(make -C sub $(node $(cat name.txt)))"],
  ["a reader's output piped into sh", "echo node $(cat name.txt) | sh"],
  ["a substituted file piped into sh", "cat $(cat name.txt) | sh"],
  ["a reader's output piped into bash", "echo node $(cat name.txt) | bash"],
  ["a reader's output piped into node", "echo $(cat name.txt) | node"],
  ["a reader's output piped into python", "echo $(cat name.txt) | python3"],
  ["a reader's output piped into eval", "echo $(cat name.txt) | eval"],
  ["a quote opened by an escaped quote hides the stage", "echo 'it'\\''s'; node $(cat name.txt) | cat"],
  ["an escaped double quote hides the stage", 'echo \\"; node $(cat name.txt) | cat; echo \\"'],
  ["a path word that is a package file named like a reader", "./tools/cat $(cat name.txt) | cat"],
  ["sort with a program option", "sort --compress-program=$(cat name.txt) x | cat"],
  ["env in front of a runner", "env node $(cat name.txt) | cat"],
];

for (const [label, hook] of nested) {
  for (const changed of ["lib/evil.js", "docs/evil.js"] as const) {
    test(`${label} reads every file: a changed ${changed} holds`, () => {
      expect(holds(release("1.0.0", hook, "none"), release("1.0.1", hook, changed)).length).toBeGreaterThan(0);
    });
  }
}

// Argument positions and redirection operands are not command words: an unresolved variable or a reader's substitution there
// reads nothing more than the line did before.
const quiet: [string, string][] = [
  ["a variable argument with redirects", 'node lib/ok.js "$INIT_CWD" > /dev/null 2>&1'],
  ["a guarded run with a variable test", '[ "$CI" = true ] || node lib/ok.js 2>/dev/null'],
  ["an exit status", "node lib/ok.js 2>/dev/null; exit $?"],
  ["a variable redirection operand", 'node lib/ok.js > "$TMPDIR/log"'],
  ["an arithmetic argument into a pipe", "node lib/ok.js --n=$((1+1)) | cat"],
  ["env in front of a reader", "env echo $(date) | cat"],
  ["command in front of a reader", "command echo $(date) | cat"],
  ["a quoted reader name", '"echo" $(date) | cat'],
  ["a here-string operand", 'cat <<< "$(date)"'],
  ["a substitution as a redirection operand", 'echo $(date) > "$(date)"'],
  ["an escaped separator", "echo \\; $(date) | cat"],
  ["a brace group", "{ echo $(date); } | cat"],
  ["a make inside an assigned substitution", "x=$(make -C lib) > log"],
];

for (const [label, hook] of quiet) {
  test(`${label} stays quiet when an unrelated file changes`, () => {
    expect(holds(release("1.0.0", hook, "none"), release("1.0.1", hook, "docs/evil.js"))).toEqual([]);
  });
}

test("a path word with an unresolved part into a pipe keeps the directory-scoped read, as without the pipe", () => {
  expect(holds(release("1.0.0", "./tools/$N.sh | cat", "none"), release("1.0.1", "./tools/$N.sh | cat", "docs/evil.js"))).toEqual([]);
});

// A gyp `<!(...)` command is exempt from the unresolved-stage rule for its own text only: a script it reaches is read as a hook line.
const gypRelease = (v: string, x: string, changed: string) =>
  files({
    "package.json": JSON.stringify({ name: "p", version: v, scripts: { install: "node-gyp rebuild", x } }),
    "binding.gyp": "{'targets':[{'target_name':'a','sources':['<!(npm run x)']}]}",
    "lib/evil.js": changed === "lib/evil.js" ? `console.log("evil ${v}")\n` : "console.log('evil')\n",
    "name.txt": "lib/evil.js\n",
  });

test("a script reached from a gyp command is read as a hook line: an unresolved stage in it reads every file", () => {
  const x = "node $(cat name.txt) | cat";
  expect(holds(gypRelease("1.0.0", x, "none"), gypRelease("1.0.1", x, "lib/evil.js")).length).toBeGreaterThan(0);
});

test("a gyp command with its own dollar word stays quiet when an unrelated file changes", () => {
  const gyp = (v: string, extra: string) =>
    files({
      "package.json": JSON.stringify({ name: "p", version: v, scripts: { install: "node-gyp rebuild" } }),
      "binding.gyp": "{'targets':[{'target_name':'a','sources':['<!(cc -v 2>&1 | perl -ne \\'print $1\\')']}]}",
      "src/a.cc": "int a;\n",
      "README.md": extra,
    });
  expect(holds(gyp("1.0.0", "x"), gyp("1.0.1", "y"))).toEqual([]);
});
