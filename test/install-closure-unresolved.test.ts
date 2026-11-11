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

// The same class: forms that were deliberate non-holds and dropped without widening.
const rel2 = (v: string, hook: string) =>
  files({
    "package.json": JSON.stringify({ name: "p", version: v, scripts: { postinstall: hook } }),
    "lib/evil.js": `console.log("evil ${v}")\n`,
  });

test("node -e inline code that loads a computed path reads the package: the changed lib/evil.js holds", () => {
  const hook = `node -e "require('./lib/' + 'ev' + 'il')"`;
  expect(holds(rel2("1.0.0", hook), rel2("1.0.1", hook)).length).toBeGreaterThan(0);
});

test("node -p inline code with a computed require reads the package", () => {
  const hook = `node -p "require('./lib/' + 'evil')"`;
  expect(holds(rel2("1.0.0", hook), rel2("1.0.1", hook)).length).toBeGreaterThan(0);
});

test("patch-package with a flag it does not model reads every file", () => {
  const hook = "patch-package --exclude x";
  expect(holds(rel2("1.0.0", hook), rel2("1.0.1", hook)).length).toBeGreaterThan(0);
});

test("a static file over 1 MB still names the files it loads", () => {
  const pad = "// " + "x".repeat(80) + "\n";
  const big = (v: string) => `require("./other.js")\n` + pad.repeat(13000) + `var v = "${v}"\n`;
  const rel = (v: string) =>
    files({
      "package.json": JSON.stringify({ name: "p", version: v, scripts: { postinstall: "node lib/big.js" } }),
      "lib/big.js": big("1"),
      "lib/other.js": `console.log("other ${v}")\n`,
    });
  expect(holds(rel("1.0.0"), rel("1.0.1")).length).toBeGreaterThan(0);
});
