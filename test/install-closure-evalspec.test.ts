import { expect, test } from "bun:test";
import { prepass, type FileMap } from "../src/prepass.ts";

const enc = (s: string) => new TextEncoder().encode(s);
const files = (o: Record<string, string>): FileMap => new Map(Object.entries(o).map(([k, v]) => [k, enc(v)]));
const holds = (old: FileMap, now: FileMap) => prepass("npm", old, now).hard.filter((s) => s.kind === "install-script").map((s) => s.detail);

// A part of a spec, a file name or a command word that the scan could not resolve (an expansion) may name any file of the
// package, so a changed file under lib/, docs/ or test/ must hold.
const release = (v: string, hook: string, changed: string, extra: Record<string, unknown> = {}) =>
  files({
    "package.json": JSON.stringify({ name: "p", version: v, scripts: { postinstall: hook, evil: "node lib/evil.js" }, ...extra }),
    "lib/a.js": "console.log('a')\n",
    "lib/evil.js": changed === "lib/evil.js" ? `console.log("evil ${v}")\n` : "console.log('x')\n",
    "docs/payload.txt": changed === "docs/payload.txt" ? `payload ${v}\n` : "p\n",
    "test/t.js": changed === "test/t.js" ? `t ${v}\n` : "t\n",
    "name.txt": "evil\n",
  });
const held = (hook: string, changed: string) => holds(release("1.0.0", hook, changed), release("1.0.1", hook, changed)).length > 0;

const forms: [string, string][] = [
  ["node -e with a substituted require spec", `node -e "require('./lib/$(cat name.txt)')"`],
  ["node -p with a substituted require spec", `node -p "require('./lib/$(cat name.txt)')"`],
  ["node --eval with a substituted require spec", `node --eval "require('./lib/$(cat name.txt)')"`],
  ["node -e with a variable in the require spec", `node -e "require('./lib/$FOO')"`],
  ["node -e with a backtick in the require spec", "node -e \"require('./lib/`cat name.txt`')\""],
];
for (const [label, hook] of forms) {
  for (const changed of ["lib/evil.js", "docs/payload.txt", "test/t.js"]) {
    test(`${label}: a changed ${changed} holds`, () => expect(held(hook, changed)).toBe(true));
  }
}

const bare: [string, string][] = [
  ["node -r with a bare substituted file", "node -r $(cat name.txt) lib/a.js"],
  ["node --import with a bare substituted file", "node --import $(cat name.txt) lib/a.js"],
  ["an unresolved command word with a script argument", "$(cat name.txt) lib/a.js"],
  ["an unresolved npm subcommand", "npm $(cat name.txt) evil"],
  ["an unresolved command word inside sh -c", `sh -c "$(cat name.txt) lib/a.js"`],
];
for (const [label, hook] of bare) {
  for (const changed of ["docs/payload.txt", "test/t.js"]) {
    test(`${label}: a changed ${changed} holds`, () => expect(held(hook, changed)).toBe(true));
  }
}

test("yarn run with an unresolved script name reads docs and tests too", () => {
  expect(held('yarn run "$(cat name.txt)"', "docs/payload.txt")).toBe(true);
});

for (const [label, hook] of [
  ["a literal require spec in node -e", `node -e "require('./lib/a')"`],
  ["a literal require spec in node -p", `node -p "require('./lib/a')"`],
  ["a literal file argument", "node lib/a.js"],
] as const) {
  test(`control: ${label} leaves an unrelated changed file alone`, () => expect(held(hook, "lib/evil.js")).toBe(false));
}

test("control: a path word with an unresolved part keeps its directory-scoped read", () => {
  expect(held("sh ./lib/$N.sh", "docs/payload.txt")).toBe(false);
});

// A path word with an unresolved part reads its directory, inert files included (`./` is the package root).
const pathWords: [string, string, string[]][] = [
  ["a root-relative path word", "node ./$(cat name.txt)", ["lib/evil.js", "docs/payload.txt", "test/t.js"]],
  ["a path word under docs/", "node docs/$(cat name.txt)", ["docs/payload.txt"]],
  ["a path word under test/", "node test/$(cat name.txt)", ["test/t.js"]],
  ["a path word under docs/ with backticks", "node docs/`cat name.txt`", ["docs/payload.txt"]],
  ["a path word with an unresolved directory", "node $(cat name.txt)/x.js", ["docs/payload.txt", "test/t.js"]],
];
for (const [label, hook, changed] of pathWords) {
  for (const c of changed) test(`${label}: a changed ${c} holds`, () => expect(held(hook, c)).toBe(true));
}

test("control: a path word under docs/ leaves a changed test file alone", () => {
  expect(held("node docs/$(cat name.txt)", "test/t.js")).toBe(false);
});

// The code of -e is read as the shell passes it: escaped quotes are plain quotes, and -pe / -ep are -p plus -e.
for (const [label, hook] of [
  ["node -e with escaped double quotes", `node -e "require(\\"./lib/$(cat name.txt)\\")"`],
  ["node -e with escaped double quotes and backticks", 'node -e "require(\\"./lib/`cat name.txt`\\")"'],
  ["node -pe with a substituted require spec", `node -pe "require('./lib/$(cat name.txt)')"`],
  ["node -ep with a substituted require spec", `node -ep "require('./lib/$(cat name.txt)')"`],
] as const) {
  for (const changed of ["lib/evil.js", "docs/payload.txt", "test/t.js"]) {
    test(`${label}: a changed ${changed} holds`, () => expect(held(hook, changed)).toBe(true));
  }
}

// A backtick alone reaches -r, --require= and --import like $(...).
for (const [label, hook] of [
  ["node -r with a backtick path", "node -r ./`cat name.txt` lib/a.js"],
  ["node --require= with a backtick path", "node --require=./`cat name.txt` lib/a.js"],
  ["node --import with a backtick path", "node --import ./`cat name.txt` lib/a.js"],
] as const) {
  for (const changed of ["docs/payload.txt", "test/t.js"]) {
    test(`${label}: a changed ${changed} holds`, () => expect(held(hook, changed)).toBe(true));
  }
}

test("control: node -e with escaped quotes and a literal spec leaves an unrelated file alone", () => {
  expect(held(`node -e "require(\\"./lib/a\\")"`, "lib/evil.js")).toBe(false);
});
