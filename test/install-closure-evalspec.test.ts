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
