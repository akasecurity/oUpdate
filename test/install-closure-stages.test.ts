import { expect, test } from "bun:test";
import { prepass, type FileMap } from "../src/prepass.ts";

const enc = (s: string) => new TextEncoder().encode(s);
const files = (o: Record<string, string>): FileMap => new Map(Object.entries(o).map(([k, v]) => [k, enc(v)]));
const holds = (old: FileMap, now: FileMap) => prepass("npm", old, now).hard.filter((s) => s.kind === "install-script").map((s) => s.detail);

// A hook line that is not split into commands (a pipe, a redirect, a subshell, a function definition) still runs the commands
// in it. `evil` is a script of the package that runs lib/evil.js; only lib/evil.js changes between the two releases.
const release = (v: string, hook: string, scripts: Record<string, string> = {}) =>
  files({
    "package.json": JSON.stringify({ name: "p", version: "1.0." + v, scripts: { postinstall: hook, evil: "node lib/evil.js", quiet: "echo hi", ...scripts } }),
    "lib/evil.js": `console.log("evil ${v}")\n`,
    "lib/ok.js": "console.log('ok')\n",
    "in.txt": "hello\n",
  });

const runs: [string, string][] = [
  ["npm run through a pipe", "npm run evil | cat"],
  ["npm run with a redirect", "npm run evil > out.log"],
  ["npm run in a subshell", "(npm run evil)"],
  ["npm run in a function body called on the line", "f() { npm run evil; }; f"],
  ["yarn run in a function body", "f() { yarn run evil; }; f"],
  ["pnpm run after a pipe stage", "echo hi | pnpm run evil"],
  ["npm run after a redirect on the line", "echo hi > out.log; npm run evil"],
  ["npm run in a function body on its own lines", "f() {\n  npm run evil | tee out.log\n}\nf"],
  ["npm run behind a keyword in a subshell", "( if true; then npm run evil; fi )"],
];

runs.push(
  ["an assignment prefix on a piped runner", "FOO=1 npm run evil | cat"],
  ["an assignment prefix with a build script name", "NODE_ENV=production npm run evil | tee log"],
  ["env before a piped runner", "env npm run evil | cat"],
  ["command before a piped runner", "command npm run evil | cat"],
  ["nohup before a piped runner", "nohup npm run evil | cat"],
  ["nice with a value before a piped runner", "nice -n 5 npm run evil | cat"],
  ["time before a piped runner", "time npm run evil | cat"],
  ["exec before a piped runner", "exec npm run evil | cat"],
  ["stdbuf before a piped runner", "stdbuf -oL npm run evil | cat"],
  ["a shell -c body after a pipe", "sh -c 'npm run evil' | cat"],
  ["a bash -c body with a prefix", "bash -c 'FOO=1 npm run evil' | cat"],
  ["xargs with a runner", "echo evil | xargs npm run"],
  ["a quoted runner word", '"npm" run evil | cat'],
  ["a backslash in the runner word", "n\\pm run evil | cat"],
  ["env by path", "/usr/bin/env npm run evil | cat"],
  ["npx run-s", "npx run-s evil | cat"],
  ["npm exec -- run-s", "npm exec -- run-s evil | cat"],
  ["corepack pnpm run", "corepack pnpm run evil | cat"],
  ["a function keyword body", "function f { npm run evil; }; f"],
  ["a runner on a line after a comment line", "# note\nnpm run evil | cat"],
);

for (const [label, hook] of runs) {
  test(`${label}: the script it runs is read, so the changed lib/evil.js holds`, () => {
    expect(holds(release("0", hook), release("1", hook)).length).toBeGreaterThan(0);
  });
}

const quiet: [string, string][] = [
  ["a function that only prints", "f() { echo hi; }; f"],
  ["a pipe of plain readers", "echo hi | cat"],
  ["a script that does not run the changed file, through a pipe", "npm run quiet | cat"],
  ["a redirect with no runner", "echo hi > out.log"],
  ["npm ls through a pipe runs no script", "npm ls | head -3"],
  ["yarn install through a pipe runs no script", "yarn install | cat"],
  ["a read with no runner", "read x < in.txt; echo $x"],
];

quiet.push(
  ["a runner in a comment after a plain command", "echo hi # ; npm run evil | cat"],
  ["a runner in a quoted heredoc body", "cat <<'EOF'\nnpm run evil\nEOF"],
  ["a runner word as a redirect operand", "echo hi > npm run evil"],
  ["a runner in a single-quoted echo", "echo 'npm run evil' | cat"],
);

for (const [label, hook] of quiet) {
  test(`${label} stays quiet: the changed lib/evil.js is not an install change`, () => {
    expect(holds(release("0", hook), release("1", hook))).toEqual([]);
  });
}

test("the same runner line with the same bytes holds nothing", () => {
  const hook = "f() { npm run evil | cat; }; f";
  expect(holds(release("0", hook), release("0", hook))).toEqual([]);
});

// Lifecycle scripts a command runs without naming them: the script is set to run the changed file.
const lifecycle: [string, string, Record<string, string>][] = [
  ["npm it runs test", "npm it | cat", { test: "node lib/evil.js" }],
  ["npm install-test runs test", "npm install-test | cat", { test: "node lib/evil.js" }],
  ["npm pack runs prepack", "npm pack | cat", { prepack: "node lib/evil.js" }],
  ["npm pack runs prepare", "npm pack | cat", { prepare: "node lib/evil.js" }],
  ["npm pack runs postpack", "(npm pack)", { postpack: "node lib/evil.js" }],
  ["npm pack with a prefix", "FOO=1 npm pack | cat", { prepack: "node lib/evil.js" }],
];

for (const [label, hook, scripts] of lifecycle) {
  test(`${label} in a split line: the script it runs is read`, () => {
    expect(holds(release("0", hook, scripts), release("1", hook, scripts)).length).toBeGreaterThan(0);
  });
}

test("npm pack in a split line with no lifecycle script stays quiet", () => {
  expect(holds(release("0", "npm pack | cat"), release("1", "npm pack | cat"))).toEqual([]);
});

// Read-only npm subcommands and name lookups run no script, though a lifecycle script or the runner is named in the line.
const lookups: [string, string][] = [
  ["npm view with a lifecycle word as an operand", "npm view pack version | cat"],
  ["npm config get with a script name as an operand", "npm config get test | cat"],
  ["npm ls with a script name as an operand", "npm ls test | cat"],
  ["npm help run", "npm help run | cat"],
  ["command -v only looks the runner up", "command -v npm run evil | cat"],
  ["command -V only looks the runner up", "command -V npm run evil | cat"],
  ["type only looks the runner up", "type npm run evil | cat"],
  ["which only looks the runner up", "which npm run evil | cat"],
  ["hash only looks the runner up", "hash npm run evil | cat"],
];

for (const [label, hook] of lookups) {
  test(`${label} stays quiet with test, prepack and prepare scripts that run the changed file`, () => {
    const scripts = { test: "node lib/evil.js", prepack: "node lib/evil.js", postpack: "node lib/evil.js" };
    expect(holds(release("0", hook, scripts), release("1", hook, scripts))).toEqual([]);
  });
}
