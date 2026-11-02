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
    for (const cmd of ["yarn dlx some-pkg", "pnpm dlx some-pkg", "bunx some-pkg", "bun x some-pkg"]) {
      expect(hardFor({ postinstall: cmd }).length, cmd).toBeGreaterThan(0);
    }
    // Naming a local file does not make a remote fetch resolved.
    for (const cmd of ["yarn dlx some-pkg ./assets/other.js", "bun x some-pkg ./assets/other.js"]) expect(hardFor({ postinstall: cmd }).length, cmd).toBeGreaterThan(0);
  });

  test("pnpm --filter holds when the script is in another package", () => {
    for (const cmd of ["pnpm --filter other build", "pnpm -F other build", "pnpm --filter=other build", "pnpm -Fother build"]) {
      expect(hardFor({ postinstall: cmd }).length, cmd).toBeGreaterThan(0);
    }
  });

  test("pnpm -C/--dir and -r/--recursive without --filter widen", () => {
    for (const cmd of ["pnpm -C sub build", "pnpm -Csub build", "pnpm --dir sub build", "pnpm --dir=sub build", "pnpm -r build", "pnpm --recursive build", "pnpm --recursive=true build", "pnpm -C sub run build", "pnpm --silent -r run build", "pnpm -w build", "pnpm --workspace-root build", "pnpm --filter-prod sub build", "pnpm --filter-prod=sub build", "pnpm -rs build", "pnpm --prefix sub build", "pnpm recursive run build", "pnpm m run build", "pnpm multi run build"]) {
      expect(hardFor({ postinstall: cmd, build: "echo ok" }).length, cmd).toBeGreaterThan(0);
    }
  });

  test("yarn and bun workspace forms widen", () => {
    for (const cmd of ["yarn workspace sub build", "yarn workspaces foreach run build", "yarn workspaces run build", "yarn --cwd sub build", "yarn --cwd=sub build", "bun --filter sub build", "bun run --filter sub build", "bun --cwd sub build", "bun --cwd=sub run build", "bun -F sub build", "bun run --workspaces build"]) {
      expect(hardFor({ postinstall: cmd, build: "echo ok" }).length, cmd).toBeGreaterThan(0);
    }
  });

  test("bun run <file> follows the file instead of looking up a script", () => {
    expect(hardFor({ postinstall: "bun run ./assets/x.js" }).length).toBeGreaterThan(0);
    expect(hardFor({ postinstall: "bun run ./assets/other.js" })).toEqual([]);
    expect(hardFor({ postinstall: "bun run missing.ts" }).length).toBeGreaterThan(0);
    // a script named exactly like the path wins and is followed
    expect(hardFor({ postinstall: "bun run build.js", "build.js": "node assets/x.js" }).length).toBeGreaterThan(0);
  });

  test("pnpm --filter after other leading flags widens", () => {
    for (const cmd of ["pnpm -r --filter other build", "pnpm --recursive -F other build", "pnpm -r --filter=other build", "pnpm --silent -Fother build", "pnpm -C sub --filter other build", "pnpm --dir sub -F other build", "pnpm --workspace-concurrency 1 --filter x build"]) {
      expect(hardFor({ postinstall: cmd }).length, cmd).toBeGreaterThan(0);
    }
  });

  test("a package runner with a local file argument still holds", () => {
    for (const cmd of ["bunx some-pkg ./assets/other.js", "npx some-pkg ./assets/other.js", "npx -y some-pkg ./assets/other.js", "npx --package=pkg ./assets/other.js", "npx -p pkg ./assets/other.js", "bunx --package pkg ./assets/other.js", "bun x some-pkg ./assets/other.js", "npx @scope/pkg ./assets/other.js", "npx github:user/repo ./assets/other.js", "npx user/repo ./assets/other.js", "npx https://example.com/pkg.tgz ./assets/other.js", "npx --cache ./cache some-pkg ./assets/other.js", "npx --userconfig ./npmrc some-pkg ./assets/other.js", "npx evil.js ./assets/other.js", "bunx evil.js ./assets/other.js"]) {
      expect(hardFor({ postinstall: cmd }).length, cmd).toBeGreaterThan(0);
    }
  });

  test("a script named like a builtin does not shadow the builtin", () => {
    // dlx and bun x fetch remote code and widen even when a same-named script exists.
    for (const cmd of ["yarn dlx some-pkg", "pnpm dlx some-pkg", "bun x some-pkg"]) {
      const name = cmd.split(" ")[1]!;
      expect(hardFor({ postinstall: cmd, [name]: "node assets/other.js" }).length, cmd).toBeGreaterThan(0);
    }
    // exec names a file that resolves, so the same-named script must not run in its place.
    for (const bin of ["yarn", "pnpm"]) {
      expect(hardFor({ postinstall: `${bin} exec tool ./assets/other.js`, exec: "node assets/x.js" }), bin).toEqual([]);
    }
    // run <name> still runs the script of that name.
    expect(hardFor({ postinstall: "yarn run dlx", dlx: "node assets/x.js" }).length).toBeGreaterThan(0);
  });

  test("an unchanged tree stays quiet", () => {
    const p = pj({ postinstall: "yarn dlx some-pkg" });
    const f = { "package.json": p, [A]: "1" };
    expect(prepass("npm", map(f), map(f)).hard.filter((s) => s.kind === "install-script")).toEqual([]);
  });
});
