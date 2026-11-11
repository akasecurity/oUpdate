import { expect, test } from "bun:test";
import { prepass, type FileMap } from "../src/prepass.ts";

const enc = (s: string) => new TextEncoder().encode(s);
const files = (o: Record<string, string>): FileMap => new Map(Object.entries(o).map(([k, v]) => [k, enc(v)]));
const holds = (old: FileMap, now: FileMap) => prepass("npm", old, now).hard.filter((s) => s.kind === "install-script").map((s) => s.detail);

// A hook path with a `.` or `..` segment names the file it resolves to, so a changed file there must hold,
// docs/ and test/ included.
const release = (v: string, hook: string, target: string) =>
  files({
    "package.json": JSON.stringify({ name: "p", version: v, scripts: { postinstall: hook } }),
    "lib/ok.js": "console.log('ok')\n",
    "lib2/a.js": "console.log('a')\n",
    [target]: `console.log("evil ${v}")\n`,
  });
const held = (hook: string, target: string) => holds(release("1.0.0", hook, target), release("1.0.1", hook, target)).length > 0;

const forms = (d: string): [string, string][] => [
  ["a path that goes up and back down", `node lib2/../${d}/evil.js`],
  ["a path with a ./ segment", `node ./${d}/./evil.js`],
  ["a path with a ./ segment and no leading dot", `node ${d}/./evil.js`],
  ["a path that goes up from its own directory", `node ${d}/../${d}/evil.js`],
  ["a quoted path with a .. segment", `node "lib2/../${d}/evil.js"`],
  ["a path with a .. segment inside sh -c", `sh -c 'node lib2/../${d}/evil.js'`],
  ["a path with a ./ segment inside sh -c", `sh -c "node ./${d}/./evil.js"`],
  ["a path that leaves the package", `node ../${d}/evil.js`],
];
for (const d of ["lib", "docs", "test"]) {
  for (const [label, hook] of forms(d)) {
    test(`${label}: a changed ${d}/evil.js holds`, () => expect(held(hook, `${d}/evil.js`)).toBe(true));
  }
}

// The plain spellings held before and still hold.
for (const d of ["lib", "docs", "test"]) {
  for (const hook of [`node ${d}/evil.js`, `node ./${d}/evil.js`, `node ${d}//evil.js`]) {
    test(`${hook}: a changed ${d}/evil.js holds`, () => expect(held(hook, `${d}/evil.js`)).toBe(true));
  }
}

// Paths that resolve to a file that did not change stay quiet.
const controls: [string, string][] = [
  ["a plain path", "node lib/ok.js"],
  ["a ./ path", "node ./lib/ok.js"],
  ["a path that resolves to an unchanged file", "node lib/../lib/ok.js"],
  ["a ./ segment on an unchanged file", "node ./lib/./ok.js"],
  ["a command with no file", "echo hi"],
];
for (const [label, hook] of controls) {
  test(`${label}: a changed unrelated docs/evil.js stays quiet`, () => expect(held(hook, "docs/evil.js")).toBe(false));
}
test("a path that resolves to the changed file holds even from an unchanged-looking spelling", () =>
  expect(held("node lib/../lib/ok.js", "lib/ok.js")).toBe(true));

// After a `cd` a dotted path is resolved from that directory, not from the package root.
test("cd lib && node ../lib/ok.js: a changed unrelated docs/evil.js stays quiet", () =>
  expect(held("cd lib && node ../lib/ok.js", "docs/evil.js")).toBe(false));
test("cd lib && node ./../lib/ok.js: a changed unrelated docs/evil.js stays quiet", () =>
  expect(held("cd lib && node ./../lib/ok.js", "docs/evil.js")).toBe(false));
for (const d of ["x", "docs", "test"]) {
  test(`cd lib && node ../${d}/evil.js: a changed ${d}/evil.js holds`, () =>
    expect(held(`cd lib && node ../${d}/evil.js`, `${d}/evil.js`)).toBe(true));
}
test("cd lib && node ../../evil.js leaves the package: a changed docs/evil.js holds", () =>
  expect(held("cd lib && node ../../evil.js", "docs/evil.js")).toBe(true));
