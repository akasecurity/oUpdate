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

// A gyp `<!(...)` command is read like a hook line: a script it reaches, and an unresolved stage in the command itself.
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

test("an unresolved stage in the gyp command itself reads every file", () => {
  const gyp = (v: string, changed: boolean) =>
    files({
      "package.json": JSON.stringify({ name: "p", version: v, scripts: { install: "node-gyp rebuild" } }),
      "binding.gyp": "{'targets':[{'target_name':'a','sources':['<!(node $(cat name.txt) | cat)']}]}",
      "lib/evil.js": changed ? `console.log("evil ${v}")\n` : "console.log('evil')\n",
      "name.txt": "lib/evil.js\n",
    });
  expect(holds(gyp("1.0.0", false), gyp("1.0.1", true)).length).toBeGreaterThan(0);
});

// Quiet controls: only docs/evil.js changes, and nothing here runs a file the text does not name.
const quietLines: [string, string][] = [
  ["a non-reader with a substitution argument in a substitution", "x=$(dirname $(which node)):$PATH && node lib/ok.js"],
  ["a remover with a substitution path and a redirect", 'rm -rf "$(pwd)/b" 2>/dev/null'],
  ["a runner whose script argument is named, with a substitution after it", ': $(node lib/ok.js "$(date)")'],
  ["a copy with a substituted source", ': $(cp $(node -p "1") dist)'],
  ["a stdin runner after && with an unresolved word elsewhere", '[ "$CI" = true ] || command -v node > /dev/null && node lib/ok.js | cat'],
  ["a bare runner after ; on a line with a substitution", "echo $(date); node lib/ok.js | cat"],
  ["an arithmetic expansion", "echo $(( $N + 1 )) | cat"],
  ["an arithmetic expansion in an assignment", "x=$(( 1 + 2 )); node lib/ok.js | cat"],
  ["a comment that mentions a substitution", "echo hi # $(node $(cat name.txt)) | cat"],
  ["a comment inside a substitution", ": $(echo hi # $(node $(cat name.txt))\n)"],
  ["a cd inside an assignment", "x=$(cd lib && pwd) | cat"],
  ["a variable that no substitution set, as an option value", "node --max-old-space-size=$MEM lib/ok.js | cat"],
];

for (const [label, hook] of quietLines) {
  test(`${label} stays quiet: a changed docs/evil.js is not an install change`, () => {
    expect(holds(release("1.0.0", hook, "none"), release("1.0.1", hook, "docs/evil.js"))).toEqual([]);
  });
}

// Holes: code inside a `${...}`, escaped backticks, and a variable set from a substitution on the same line.
const holeLines: [string, string][] = [
  ["a substitution in a default value", "echo ${X:-$(node $(cat name.txt))} | cat"],
  ["a substitution in an assigned default", ": ${X:=$(node $(cat name.txt))}"],
  ["a substitution in a default inside double quotes", 'echo "${X:-$(node $(cat name.txt))}" | cat'],
  ["a substitution in arithmetic", "echo $(( $(node $(cat name.txt)) + 1 )) | cat"],
  ["escaped backticks inside backticks", "echo `node \\`cat name.txt\\`` | cat"],
  ["an escaped dollar inside backticks", "echo `node \\$(cat name.txt)` | cat"],
  ["a variable set from a substitution used as a preload", 'F=$(cat name.txt); node --require="$F" lib/ok.js | cat'],
  ["a variable set from a substitution run under timeout", 'F=$(cat name.txt); timeout 9 node "$F" | cat'],
  ["a variable set from a substitution used as an argument", 'F=$(cat name.txt); node "$F"'],
  ["a here-string into a shell with a substitution", 'sh <<< "node $(cat name.txt)"'],
  ["a piped shell with a substitution", 'echo "node $(cat name.txt)" | sh'],
  ["a piped shell after |&", 'echo "node $(cat name.txt)" |& sh'],
];

for (const [label, hook] of holeLines) {
  for (const changed of ["lib/evil.js", "docs/evil.js"] as const) {
    test(`${label} reads every file: a changed ${changed} holds`, () => {
      expect(holds(release("1.0.0", hook, "none"), release("1.0.1", hook, changed)).length).toBeGreaterThan(0);
    });
  }
}

// Any command that is not a plain one runs what a substitution in its arguments names; only the plain commands stay quiet.
const U = "$(cat name.txt)";
const runnerLines: [string, string][] = [
  ["node -e with the file as an argument", `node -e "require(process.argv[1])" ${U}`],
  ["sh -c with the file as a positional argument", `sh -c 'node "$1"' _ ${U}`],
  ["node -r before a substituted script", `node -r ./lib/ok.js ${U}`],
  ["node with a flag value before the script", `node --title test "${U}" | cat`],
  ["deno run", `deno run "${U}" | cat`],
  ["npx -p then node", `npx -p node@18 node ${U}`],
  ["npm exec -- node", `npm exec -- node "${U}" | cat`],
  ["nice -n before the runner", `nice -n 10 node ${U} | cat`],
  ["sudo -u before the runner", `sudo -u nobody node ${U} | cat`],
  ["env -u before the runner", `env -u X node ${U} | cat`],
  ["exec -a before the runner", `exec -a x node ${U} | cat`],
  ["timeout -s before the runner", `timeout -s KILL 9 node ${U} | cat`],
  ["timeout -k before the runner", `timeout -k 5 9 node ${U} | cat`],
  ["stdbuf -o before the runner", `stdbuf -o L node ${U} | cat`],
  ["bunx", `bunx ${U} | cat`],
  ["ash", `ash ${U} | cat`],
  ["cross-env", `cross-env A=1 node ${U} | cat`],
  ["parallel", `parallel node "${U}" | cat`],
  ["flock", `flock x node ${U} | cat`],
  ["busybox sh", `busybox sh ${U} | cat`],
  ["awk -f", `awk -f ${U} x | cat`],
  ["arch", `arch node ${U} | cat`],
  ["su -c", `su -c "node ${U}" x | cat`],
  ["cmake -P", `cmake -P "${U}" | cat`],
  ["find -exec", `find . -exec node ${U} \\; | cat`],
];

for (const [label, hook] of runnerLines) {
  test(`${label} reads every file: a changed lib/evil.js holds`, () => {
    expect(holds(release("1.0.0", hook, "none"), release("1.0.1", hook, "lib/evil.js")).length).toBeGreaterThan(0);
  });
}

// The stdin rule: a shell with no script reads what the stage before it, or a here-string or heredoc, feeds it.
const stdinLines: [string, string][] = [
  ["a here-string with a substitution into sh", `sh <<< "node ${U}"`],
  ["an unquoted heredoc with a substitution into sh", `sh <<EOF\nnode ${U}\nEOF`],
  ["a pipe into a subshell that runs sh", `echo "node ${U}" | (cd lib; sh)`],
  ["a pipe from a substitution into sh", `cat ${U} | sh`],
  ["a pipe from a printed substitution into bash", `printf '%s\\n' "node ${U}" | bash`],
];

for (const [label, hook] of stdinLines) {
  test(`${label} reads every file: a changed lib/evil.js holds`, () => {
    expect(holds(release("1.0.0", hook, "none"), release("1.0.1", hook, "lib/evil.js")).length).toBeGreaterThan(0);
  });
}

const stdinQuiet: [string, string][] = [
  ["a shell fed by a pipe that holds no expansion, with a substitution on another stage", `echo hi | sh; echo ${"$(date)"}`],
  ["a shell fed a here-string with no expansion", `sh <<< "echo hi"; echo $(date)`],
  ["a shell fed a quoted heredoc", `sh <<'EOF'\necho $(cat name.txt)\nEOF`],
  ["a shell fed an unquoted heredoc with no expansion", `sh <<EOF\necho hi\nEOF`],
];

for (const [label, hook] of stdinQuiet) {
  test(`${label} stays quiet: a changed docs/evil.js is not an install change`, () => {
    expect(holds(release("1.0.0", hook, "none"), release("1.0.1", hook, "docs/evil.js"))).toEqual([]);
  });
}

// Parsing: `$((node x) )` is a subshell in a substitution, a single quote in a double-quoted ${...} is an ordinary character.
const parseLines: [string, string][] = [
  ["a subshell in a substitution that looks like arithmetic", `x=$((node ${U}) )`],
  ["a single quote inside a double-quoted default value", `echo "\${X:-'$(node ${U})'}" | cat`],
  ["a variable set by export and used as a preload", `export F=${U}; node --require="$F" lib/ok.js`],
  ["a variable set by a for loop and used as a preload", `for x in ${U}; do node --require=$x lib/ok.js; done`],
  ["a variable copied from a tainted one", `G=${U}; H=$G; node -r $H lib/ok.js`],
  ["a variable used inside a substitution body", `F=${U}; echo $(node -r "$F" lib/ok.js)`],
  ["a variable used as the argument of a path command", `F=${U}; ./lib/ok.js "$F" | cat`],
];

for (const [label, hook] of parseLines) {
  test(`${label} reads every file: a changed lib/evil.js holds`, () => {
    expect(holds(release("1.0.0", hook, "none"), release("1.0.1", hook, "lib/evil.js")).length).toBeGreaterThan(0);
  });
}

const noiseLines: [string, string][] = [
  ["a single quote in a double-quoted default", `echo "\${X:-it's}" | cat`],
  ["arithmetic with a plain number", "echo $((1+2)) | cat"],
  ["a flag value on a node run of a literal script", "node lib/ok.js --out=$(date) | cat"],
  ["a for loop over a plain command", "for f in a b; do echo $f; done"],
  ["npm ls with a substitution", "npm ls $(echo x) | cat"],
];

for (const [label, hook] of noiseLines) {
  test(`${label} stays quiet: a changed docs/evil.js is not an install change`, () => {
    expect(holds(release("1.0.0", hook, "none"), release("1.0.1", hook, "docs/evil.js"))).toEqual([]);
  });
}

// An unknown executor reads every file, an inert docs file included: the target may sit in docs/ as well as lib/.
const executorLines: [string, string][] = [
  ...runnerLines,
  ["deno run -A", `deno run -A ${U}`],
  ["npx node", `npx node ${U}`],
  ["parallel with :::", `parallel node ::: ${U}`],
  ["awk -f stdin with a here-string", `awk -f /dev/stdin <<< "BEGIN{system(\"node ${U}\")}"`],
  ["script -q", `script -q /dev/null node ${U}`],
  ["cmake -E env", `cmake -E env node ${U}`],
  ["xcrun", `xcrun node ${U}`],
  ["perl -e with system", `perl -e 'system("node",@ARGV)' ${U}`],
];

for (const [label, hook] of executorLines) {
  test(`${label} reads every file: a changed docs/evil.js holds`, () => {
    expect(holds(release("1.0.0", hook, "none"), release("1.0.1", hook, "docs/evil.js")).length).toBeGreaterThan(0);
  });
}

// Commands that can run a program or load code from an option: a substitution in an argument reads every file, docs and tests
// included, with or without a pipe or a redirect.
const optionRunners: [string, string][] = [
  ["sed with an e command", `sed -e "e sh ${U}" input.txt | cat`],
  ["sed with an e command and no pipe", `sed -e "e sh ${U}" input.txt`],
  ["sed with the e flag", `sed "s/a/b/e" ${U} | cat`],
  ["openssl with a provider path", `openssl list -provider "${U}" | cat`],
  ["tar with an abbreviated compress program option", `tar --use-compress-prog="${U}" -cf out.tar input.txt | cat`],
  ["tar with an abbreviated to-command option", `tar --to-comm="${U}" -xf a.tar | cat`],
  ["tar with -I", `tar -I "${U}" -cf out.tar input.txt | cat`],
  ["tar with a checkpoint action", `tar --checkpoint-action=exec="${U}" -cf out.tar input.txt | cat`],
  ["tar with an rsh command", `tar --rsh-command="${U}" -cf out.tar input.txt | cat`],
  ["sort with a compress program", `sort --compress-program=${U} in | cat`],
  ["grep with a substituted pattern file", `grep -f ${U} in | cat`],
  ["curl with a substituted config", `curl -K ${U} | cat`],
  ["find with an exec", `find . -exec sh ${U} \\; | cat`],
];

for (const [label, hook] of optionRunners) {
  for (const changed of ["lib/evil.js", "docs/evil.js"] as const) {
    test(`${label} reads every file: a changed ${changed} holds`, () => {
      expect(holds(release("1.0.0", hook, "none"), release("1.0.1", hook, changed)).length).toBeGreaterThan(0);
    });
  }
}

// Plain commands run nothing an argument names: quiet with or without a pipe or a redirect.
const plainQuiet: [string, string][] = [
  ["rm of a substituted path", 'rm -rf "$(pwd)/b"'],
  ["rm of a substituted path into a pipe", 'rm -rf "$(pwd)/b" | cat'],
  ["mkdir of a substituted directory", "mkdir -p $(dirname x)"],
  ["mkdir of a substituted directory into a pipe", "mkdir -p $(dirname x) | cat"],
  ["a copy to a substituted path", 'cp a "$(pwd)/b" > /dev/null'],
  ["a list of a substituted path", "ls $(pwd) | wc -l"],
];

for (const [label, hook] of plainQuiet) {
  test(`${label} stays quiet: a changed docs/evil.js is not an install change`, () => {
    expect(holds(release("1.0.0", hook, "none"), release("1.0.1", hook, "docs/evil.js"))).toEqual([]);
  });
}
