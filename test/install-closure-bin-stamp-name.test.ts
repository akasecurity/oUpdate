import { expect, test } from "bun:test";
import { prepass, type FileMap } from "../src/prepass.ts";

const enc = (s: string) => new TextEncoder().encode(s);
const files = (o: Record<string, string>): FileMap => new Map(Object.entries(o).map(([k, v]) => [k, enc(v)]));
const holds = (a: FileMap, b: FileMap): boolean => prepass("npm", a, b).hard.some((s) => s.kind === "install-script" && s.detail === "bin");
const holdsAny = (a: FileMap, b: FileMap): boolean => prepass("npm", a, b).hard.some((s) => s.kind === "install-script");

// The stamp of a package's bin names the package name too: a self-run by name (`npx p`) runs the package whose name it is, so a rename moves it. npm reads a truthy name that is not a
// string as String(name) when bin is a string (["q"] -> .bin/q, 2 -> .bin/2), so the stamp must tell ["p"] from ["q"] and 1 from 2 there. The files are byte-identical on both sides and the
// install runs a hook, so only the stamp can hold the release.
const side = (version: string, name: unknown, bin: unknown): FileMap => {
  const pj: Record<string, unknown> = { version, bin, scripts: { postinstall: "echo hi" } };
  if (name !== undefined) pj.name = name;
  return files({ "package.json": JSON.stringify(pj), "x.js": "console.log(1)\n" });
};
const renamed = (from: unknown, to: unknown, bin: unknown) => holds(side("1.0.0", from, bin), side("1.0.1", to, bin));
const releasedAll = (from: unknown, to: unknown, bin: unknown) => !holdsAny(side("1.0.0", from, bin), side("1.0.1", to, bin));

test("a string bin and a name that is an array, renamed: held", () => {
  expect(renamed(["p"], ["q"], "x.js")).toBe(true);
});
test("a string bin and a number name, 1 to 2: held", () => {
  expect(renamed(1, 2, "x.js")).toBe(true);
});
test("a string bin and a string name, renamed: held (the bin row that was already read)", () => {
  expect(renamed("p", "q", "x.js")).toBe(true);
});
test("control: a string bin and the same non-string name on both sides releases", () => {
  expect(releasedAll(["p"], ["p"], "x.js")).toBe(true);
});
test("control: an object bin does not read the name, so a non-string name renamed releases", () => {
  expect(releasedAll(["p"], ["q"], { p: "x.js" })).toBe(true);
});
test("control: a falsy name (0, empty array is truthy but 0 and null are not) is no name: 0 to null with a string bin releases", () => {
  expect(releasedAll(0, null, "x.js")).toBe(true);
});
test("a name that goes from a string to missing with a string bin: held", () => {
  expect(holds(side("1.0.0", "p", "x.js"), side("1.0.1", undefined, "x.js"))).toBe(true);
});
test("a name that goes from missing to an array with a string bin: held", () => {
  expect(holds(side("1.0.0", undefined, "x.js"), side("1.0.1", ["q"], "x.js"))).toBe(true);
});
