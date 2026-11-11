import { expect, test } from "bun:test";
import { prepass, type FileMap } from "../src/prepass.ts";

const enc = (s: string) => new TextEncoder().encode(s);
const files = (o: Record<string, string>): FileMap => new Map(Object.entries(o).map(([k, v]) => [k, enc(v)]));
const holds = (old: FileMap, now: FileMap) => prepass("npm", old, now).hard.filter((s) => s.kind === "install-script").map((s) => s.detail);

// A package-controlled file reached only through a word the scan cannot resolve (a command substitution, a variable) runs at
// install. Only lib/evil.js changes between the two releases; name.txt names it or a script that runs it.
const release = (v: string, hook: string) =>
  files({
    "package.json": JSON.stringify({ name: "p", version: v, scripts: { postinstall: hook, evil: "node lib/evil.js" } }),
    "lib/evil.js": `console.log("evil ${v}")\n`,
    "name.txt": "evil\n",
  });

const unresolved: [string, string][] = [
  ["npm run with a substituted script name", 'npm run "$(cat name.txt)"'],
  ["npm run-script with a backtick script name", "npm run-script `cat name.txt`"],
  ["npm run with a variable script name", 'npm run "$FOO"'],
  ["node with a substituted file name", "node $(cat name.txt)"],
  ["node with a partly substituted file name", "node ./lib/$(cat name.txt).js"],
  ["yarn with a substituted subcommand", "yarn $(cat name.txt)"],
  ["pnpm with a variable subcommand", "pnpm $FOO"],
  ["a variable command word", "$npm_execpath run evil"],
  ["a substituted command word", "$(echo node) lib/evil.js"],
] as const;

for (const [label, hook] of unresolved) {
  test(`${label} reads every file: the changed lib/evil.js holds`, () => {
    expect(holds(release("1.0.0", hook), release("1.0.1", hook)).length).toBeGreaterThan(0);
  });
}

test("controls: a literal script name still reads only that script's closure", () => {
  const hook = "node lib/other.js";
  const rel = (v: string) =>
    files({
      "package.json": JSON.stringify({ name: "p", version: v, scripts: { postinstall: hook } }),
      "lib/other.js": "console.log('other')\n",
      "lib/evil.js": `console.log("evil ${v}")\n`,
    });
  expect(holds(rel("1.0.0"), rel("1.0.1"))).toEqual([]);
});
