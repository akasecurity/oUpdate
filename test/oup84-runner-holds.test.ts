import { describe, expect, test } from "bun:test";
import { prepass, type FileMap } from "../src/prepass.ts";

const enc = new TextEncoder();
const map = (f: Record<string, string>): FileMap => new Map(Object.entries(f).map(([k, v]) => [k, enc.encode(v)]));
const pj = (scripts: object) => JSON.stringify({ name: "x", version: "1", scripts });
const A = "assets/x.js";
const B = "assets/other.js";

// The hook names a runner form; only A changes between old and new.
function hardFor(scripts: object, extra: Record<string, string> = {}) {
  const p = pj(scripts);
  const base = { "package.json": p, [B]: "1", ...extra };
  return prepass("npm", map({ ...base, [A]: "1" }), map({ ...base, [A]: "require('child_process').execSync('id')" })).hard.filter(
    (s) => s.kind === "install-script",
  );
}

describe("unresolved package-manager runners hold", () => {
  test("yarn exec <cmd> reaches the package files", () => {
    expect(hardFor({ postinstall: "yarn exec some-tool" }).length).toBeGreaterThan(0);
  });

  test("bun <file> follows a resolvable file like node", () => {
    expect(hardFor({ postinstall: "bun ./assets/x.js" }).length).toBeGreaterThan(0);
    // A resolved file is the entry; an unrelated changed file is not reached.
    expect(hardFor({ postinstall: "bun ./assets/other.js" })).toEqual([]);
  });

  test("bun <file> holds when the file does not resolve", () => {
    expect(hardFor({ postinstall: "bun ./missing.ts" }).length).toBeGreaterThan(0);
  });

  test("dlx fetches remote code and holds", () => {
    for (const cmd of ["yarn dlx some-pkg", "pnpm dlx some-pkg", "bunx some-pkg"]) {
      expect(hardFor({ postinstall: cmd }).length, cmd).toBeGreaterThan(0);
    }
    // Naming a local file does not make a remote fetch resolved.
    expect(hardFor({ postinstall: "yarn dlx some-pkg ./assets/other.js" }).length).toBeGreaterThan(0);
  });

  test("pnpm --filter holds when the script is in another package", () => {
    for (const cmd of ["pnpm --filter other build", "pnpm -F other build", "pnpm --filter=other build"]) {
      expect(hardFor({ postinstall: cmd }).length, cmd).toBeGreaterThan(0);
    }
  });

  test("an unchanged tree stays quiet", () => {
    const p = pj({ postinstall: "yarn dlx some-pkg" });
    const f = { "package.json": p, [A]: "1" };
    expect(prepass("npm", map(f), map(f)).hard.filter((s) => s.kind === "install-script")).toEqual([]);
  });
});
