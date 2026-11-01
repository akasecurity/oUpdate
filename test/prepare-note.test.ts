import { describe, expect, test } from "bun:test";
import { prepareChangedInert } from "../src/review.ts";
import type { FileMap } from "../src/prepass.ts";

const enc = new TextEncoder();
const map = (f: Record<string, string>): FileMap => new Map(Object.entries(f).map(([k, v]) => [k, enc.encode(v)]));
const pj = (scripts: object) => JSON.stringify({ name: "x", version: "1", scripts });

describe("prepareChangedInert", () => {
  test("a changed prepare with no other entry point is inert", () => {
    expect(prepareChangedInert(map({ "package.json": pj({ test: "t" }) }), map({ "package.json": pj({ test: "t", prepare: "husky install" }) }))).toBe(true);
    expect(prepareChangedInert(map({ "package/package.json": pj({}) }), map({ "package/package.json": pj({ prepare: "husky install" }) }))).toBe(true);
  });
  test("an unchanged prepare, a postinstall, a binding.gyp or a bundled install script is not", () => {
    const same = map({ "package.json": pj({ prepare: "a" }) });
    expect(prepareChangedInert(same, same)).toBe(false);
    const post = (p: string) => map({ "package.json": pj({ postinstall: "node s.js", prepare: p }) });
    expect(prepareChangedInert(post("a"), post("b"))).toBe(false);
    const gyp = (p: string) => map({ "package.json": pj({ prepare: p }), "binding.gyp": "{}" });
    expect(prepareChangedInert(gyp("a"), gyp("b"))).toBe(false);
    const bun = (p: string) => map({ "package.json": pj({ prepare: p }), "node_modules/h/package.json": pj({ postinstall: "x" }) });
    expect(prepareChangedInert(bun("a"), bun("b"))).toBe(false);
  });
});
