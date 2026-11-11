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

for (const [label, hook] of quiet) {
  test(`${label} stays quiet: the changed lib/evil.js is not an install change`, () => {
    expect(holds(release("0", hook), release("1", hook))).toEqual([]);
  });
}

test("the same runner line with the same bytes holds nothing", () => {
  const hook = "f() { npm run evil | cat; }; f";
  expect(holds(release("0", hook), release("0", hook))).toEqual([]);
});
