import { describe, expect, test } from "bun:test";
import { prepass, type FileMap } from "../src/prepass.ts";

// A release is held when an install hook, a script it reaches through any runner,
// or a config value it reads changes.
const enc = new TextEncoder();
const map = (f: Record<string, string>): FileMap => new Map(Object.entries(f).map(([k, v]) => [k, enc.encode(v)]));
const pj = (scripts: object, extra: object = {}) => JSON.stringify({ name: "x", version: "1", scripts, ...extra });
const held = (oldF: Record<string, string>, newF: Record<string, string>) =>
  prepass("npm", map(oldF), map(newF)).hard.some((s) => s.kind === "install-script");

describe("hook gaps: indirection", () => {
  const runners = [
    "npm t",
    "npm tst",
    "npm run-script setup",
    "pnpm run-script setup",
    "pnpm -r run setup",
    "pnpm --filter x run setup",
    "yarn run -s setup",
    "yarn -s run setup",
    "bun run --bun setup",
    "run-s -l setup",
    "run-p -l setup",
    "npm-run-all -s setup",
    "npm-run-all --parallel setup",
    "npm-run-all --serial setup",
    "npm-run-all -p setup",
    "yarn setup",
    "pnpm setup2",
    "yarn test",
    "pnpm test",
    "pnpm start",
    "npx run-s setup",
    "corepack yarn run setup",
  ];
  for (const hook of runners) {
    test(`script reached through "${hook}" holds when it changes`, () => {
      const name = /\b(t|tst|test)\b/.test(hook) ? "test" : /\bstart\b/.test(hook) ? "start" : hook.includes("setup2") ? "setup2" : "setup";
      const mk = (body: string) => ({ "package.json": pj({ postinstall: hook, [name]: body }) });
      expect(held(mk("node a.js"), mk("node evil.js"))).toBe(true);
    });
  }
});

describe("hook gaps: surface changes", () => {
  const gyp = "{'targets':[{'target_name':'a','sources':['a.c']}]}";
  test("gypfile false removed beside binding.gyp holds", () => {
    const base = { "binding.gyp": gyp, "a.c": "int x;\n" };
    expect(held({ ...base, "package.json": pj({}, { gypfile: false }) }, { ...base, "package.json": pj({}) })).toBe(true);
  });
  test("a deleted preinstall beside binding.gyp holds", () => {
    const base = { "binding.gyp": gyp, "a.c": "int x;\n", "s.js": "1\n" };
    expect(held({ ...base, "package.json": pj({ preinstall: "node s.js", install: "node s.js" }) }, { ...base, "package.json": pj({ install: "node s.js" }) })).toBe(true);
  });
  test("a deleted hook while another install hook remains holds", () => {
    const base = { "s.js": "1\n" };
    expect(held({ ...base, "package.json": pj({ preinstall: "node s.js", postinstall: "node s.js" }) }, { ...base, "package.json": pj({ postinstall: "node s.js" }) })).toBe(true);
  });
  test("a script renamed to install via a scripts change holds", () => {
    expect(held({ "package.json": pj({ install: "node a.js" }), "a.js": "1\n" }, { "package.json": pj({ install: "node a.js", preinstall: "node a.js" }), "a.js": "1\n" })).toBe(true);
  });
});

describe("hook gaps: config reads", () => {
  const cfg = (c: object, scripts: object) => JSON.stringify({ name: "x", version: "1", config: c, scripts });
  const hooks: [string, string][] = [
    ["dollar", "node $npm_package_config_f"],
    ["braced", "node ${npm_package_config_f}"],
    ["quoted", 'node "$npm_package_config_f"'],
    ["default", "node ${npm_package_config_f:-a.js}"],
  ];
  for (const [label, hook] of hooks) {
    test(`shell ${label} read of a config value holds when it changes`, () => {
      const f = (v: string) => ({ "package.json": cfg({ f: v }, { postinstall: hook }), "a.js": "1\n", "evil.js": "2\n" });
      expect(held(f("a.js"), f("evil.js"))).toBe(true);
    });
  }
  test("a nested config object key read holds", () => {
    const f = (v: string) => ({ "package.json": cfg({ f: v }, { postinstall: "node hook.js" }), "hook.js": "require(process.env.npm_package_config_f)\n", "evil.js": "2\n", "a.js": "1\n" });
    expect(held(f("./a.js"), f("./evil.js"))).toBe(true);
  });
  test("a config read through a reached script holds", () => {
    const f = (v: string) => ({ "package.json": cfg({ f: v }, { postinstall: "yarn run setup", setup: "node $npm_package_config_f" }), "a.js": "1\n", "evil.js": "2\n" });
    expect(held(f("a.js"), f("evil.js"))).toBe(true);
  });
  test("a config change nothing reads does not hold", () => {
    const f = (v: string) => ({ "package.json": cfg({ f: v }, { postinstall: "node hook.js" }), "hook.js": "1\n" });
    expect(held(f("a"), f("b"))).toBe(false);
  });
});
