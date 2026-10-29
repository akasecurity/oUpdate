import { describe, expect, test } from "bun:test";
import { prepass, STAR_KEY_MAX, type FileMap } from "../src/prepass.ts";
import { entryPaths } from "../src/review.ts";

const enc = new TextEncoder();
const bmp = (js: string) => enc.encode("BM=0;" + js + "/*\0*/");
const map = (f: Record<string, string | Uint8Array>): FileMap =>
  new Map(Object.entries(f).map(([k, v]) => [k, typeof v === "string" ? enc.encode(v) : v]));
const pj = (scripts: object, extra: object = {}) => JSON.stringify({ name: "x", version: "1", scripts, ...extra });
const A = "assets/x.bmp";
const oldB = bmp("1");
const newB = bmp("require('child_process').execSync('id')");

function hard(oldF: Record<string, string | Uint8Array>, newF: Record<string, string | Uint8Array>) {
  return prepass("npm", map(oldF), map(newF)).hard.filter((s) => s.kind === "install-script");
}
function held(oldF: Record<string, string | Uint8Array>, newF: Record<string, string | Uint8Array>, reason: RegExp) {
  const h = hard(oldF, newF);
  expect(h.length).toBeGreaterThan(0);
  expect(h.map((s) => s.detail).join(" ")).toMatch(reason);
}

describe("install closure", () => {
  const same = (scripts: object, extra: object = {}) => {
    const p = pj(scripts, extra);
    return [{ "package.json": p, [A]: oldB }, { "package.json": p, [A]: newB }] as const;
  };

  test("a resolved install hook holds when the file it runs changes", () => {
    const cases: [string, object, object?][] = [
      ["npm run", { postinstall: "npm run setup", setup: "node assets/x.bmp" }],
      ["pre script", { postinstall: "npm run build", build: "echo ok", prebuild: "node assets/x.bmp" }],
      ["post script", { postinstall: "npm run build", build: "echo ok", postbuild: "node assets/x.bmp" }],
      ["npm t", { postinstall: "npm t", test: "node assets/x.bmp" }],
      ["npm restart", { postinstall: "npm restart", start: "node assets/x.bmp" }],
      ["npm run --loglevel", { postinstall: "npm run --loglevel silent setup", setup: "node assets/x.bmp" }],
      ["node --run", { postinstall: "node --run setup", setup: "node assets/x.bmp" }],
    ];
    for (const [label, scripts, extra] of cases) {
      const [oldF, newF] = same(scripts, extra);
      held(oldF, newF, /file|script/);
      expect(entryPaths(map(newF)).has(A), label).toBe(true);
    }
  });

  test("an unresolved command does not hold when the closed bytes match", () => {
    const quiet: object[] = [
      { postinstall: "yarn setup", setup: "node assets/x.bmp" },
      { postinstall: "pnpm setup2", setup2: "node assets/x.bmp" },
      { postinstall: "bun setup2", setup2: "node assets/x.bmp" },
      { postinstall: "sh -c 'npm run setup'", setup: "node assets/x.bmp" },
      { postinstall: "(npm run setup)", setup: "node assets/x.bmp" },
      { postinstall: "npm exec -- run-s setup", setup: "node assets/x.bmp" },
      { postinstall: "run-s 'setup --x'", setup: "node assets/x.bmp" },
      { postinstall: "yarn run-s setup", setup: "node assets/x.bmp" },
    ];
    for (const scripts of quiet) {
      const [oldF, newF] = same(scripts);
      expect(hard(oldF, newF)).toEqual([]);
    }
    // No file argument: the runner's surface is every non-doc file, so x.bmp holds.
    // The same bytes do not.
    const widened: object[] = [
      { postinstall: "cross-env A=1 npm run setup", setup: "node assets/x.bmp" },
      { postinstall: "env npm run setup", setup: "node assets/x.bmp" },
      { postinstall: "npx run-s setup", setup: "node assets/x.bmp" },
    ];
    for (const scripts of widened) {
      const [oldF, newF] = same(scripts);
      held(oldF, newF, /file/);
      const p = pj(scripts);
      expect(hard({ "package.json": p, [A]: oldB }, { "package.json": p, [A]: oldB })).toEqual([]);
    }
    const [cfgOld, cfgNew] = same({ postinstall: "node ${npm_package_config_e:-a.js}" }, { config: { e: "assets/x.bmp" } });
    expect(hard(cfgOld, cfgNew)).toEqual([]);
    const capped: object[] = [
      { postinstall: "node assets/x.bm?" },
      { postinstall: "node assets/" + "*".repeat(300) + "x.bmp" },
    ];
    for (const scripts of capped) {
      const [oldF, newF] = same(scripts);
      held(oldF, newF, /glob|pattern length/);
    }
    const changed = pj({ postinstall: "yarn setup", setup: "node assets/x.bmp" });
    const retarget = pj({ postinstall: "yarn setup now", setup: "node assets/x.bmp" });
    held({ "package.json": changed, [A]: oldB }, { "package.json": retarget, [A]: oldB }, /script|yarn setup now/);
  });

  test("a hook file that reads the manifest holds when that read is not a plain config path", () => {
    const bodies = [
      ["backtick", "require(process.env[`npm_package_config_e`])", "./assets/x.bmp", A],
      ["destructure", "const {npm_package_config_e: f} = process.env; require(f)", "./assets/x.bmp", A],
      ["alias", "const e = process.env; require(e.npm_package_config_e)", "./assets/x.bmp", A],
      ["optional", "require(process.env?.npm_package_config_e)", "./assets/x.bmp", A],
      ["concat", "require(process.env['npm_package_'+'config_e'])", "./assets/x.bmp", A],
      ["root", "require('./'+process.env.npm_package_config_e)", "x.bmp", "x.bmp"],
      ["path.join", "require(require('path').join(__dirname, process.env.npm_package_config_e))", "x.bmp", "x.bmp"],
    ] as const;
    for (const [label, body, val, watch] of bodies) {
      const p = pj({ postinstall: "node hook.js" }, { config: { e: val } });
      const oldF = { "package.json": p, "hook.js": body, [watch]: oldB };
      const newF = { "package.json": p, "hook.js": body, [watch]: newB };
      held(oldF, newF, /unresolved|file/);
      expect(label).toBeTruthy();
    }
  });

  test("a plain config path in a hook file is the file that hook loads", () => {
    const p = pj({ postinstall: "node hook.js" }, { config: { e: "./assets/x.bmp" } });
    const body = "require(process.env.npm_package_config_e)";
    const oldF = { "package.json": p, "hook.js": body, [A]: oldB };
    const newF = { "package.json": p, "hook.js": body, [A]: newB };
    held(oldF, newF, /file/);
    expect(entryPaths(map(newF)).has(A)).toBe(true);
    const sh = pj({ postinstall: "sh hook.sh" }, { config: { e: "./assets/x.bmp" } });
    const shBody = "node \"$npm_package_config_e\"";
    held({ "package.json": sh, "hook.sh": shBody, [A]: oldB }, { "package.json": sh, "hook.sh": shBody, [A]: newB }, /file/);
    expect(entryPaths(map({ "package.json": sh, "hook.sh": shBody, [A]: newB })).has(A)).toBe(true);
  });

  test("binding.gyp is an install entry wherever npm would see it, and an empty install still rebuilds", () => {
    const base = JSON.stringify({ name: "x", version: "1" });
    const gyp = "{'targets':[{'target_name':'a','sources':['<!(node -e \"require(\\'child_process\\').execSync(\\'id\\')\")']}]}";
    held({ "package.json": base }, { "package.json": base, "binding.gyp": gyp }, /unresolved|file|binding/);
    held({ "package.json": base }, { "package.json": base, "Binding.gyp": gyp }, /unresolved|file|binding/);
    held(
      { "package/package.json": base, "package/a.js": "1" },
      { "package/package.json": base, "package/a.js": "1", "z/binding.gyp": gyp },
      /unresolved|file|binding/,
    );
    const g2 = "{'targets':[{'target_name':'a','sources':['<!(node tools/gen.bmp)']}]}";
    const scripts: [string, object][] = [
      ["no install", {}],
      ["empty install", { install: "" }],
    ];
    for (const [label, s] of scripts) {
      const p = JSON.stringify({ name: "x", version: "1", scripts: s });
      const oldF = { "package.json": p, "binding.gyp": g2, "tools/gen.bmp": oldB };
      const newF = { "package.json": p, "binding.gyp": g2, "tools/gen.bmp": newB };
      held(oldF, newF, /file/);
      expect(entryPaths(map(newF)).has("tools/gen.bmp"), label).toBe(true);
    }
    const built = JSON.stringify({ name: "x", version: "1", scripts: { install: "npm run build", build: "node-gyp rebuild" } });
    held(
      { "package.json": built, "binding.gyp": g2, "tools/gen.bmp": oldB },
      { "package.json": built, "binding.gyp": g2, "tools/gen.bmp": newB },
      /gen\.bmp|file/,
    );
  });

  test("a test script edit and a key reorder are not install holds", () => {
    const h = (s: object) => JSON.stringify({ name: "x", version: "1", scripts: s });
    expect(hard(
      { "package.json": h({ postinstall: "node i.js", test: "jest" }), "i.js": "1" },
      { "package.json": h({ postinstall: "node i.js", test: "vitest" }), "i.js": "1" },
    )).toEqual([]);
    expect(hard(
      { "package.json": h({ postinstall: "node i.js", test: "jest" }), "i.js": "1" },
      { "package.json": h({ test: "jest", postinstall: "node i.js" }), "i.js": "1" },
    )).toEqual([]);
  });

  test("a gyp file node-gyp reads holds when it changes or its form does not resolve", () => {
    const bare = JSON.stringify({ name: "x", version: "1" });
    const gyp = "{'targets':[{'target_name':'a','sources':['a.c']}]}";
    held(
      { "package.json": bare, "binding.gyp": gyp, "a.c": "int x;\n", "common.gypi": "{'variables':{'x':'1'}}", "gen.js": "p\n" },
      { "package.json": bare, "binding.gyp": gyp, "a.c": "int x;\n", "common.gypi": "{'variables':{'x':'<!(node gen.js)'}}", "gen.js": "p\n" },
      /common\.gypi|gypi/,
    );
    const inc = "{'includes':['inc.gypi'],'targets':[{'target_name':'a','sources':['a.c']}]}";
    held(
      { "package.json": bare, "binding.gyp": inc, "a.c": "int x;\n", "inc.gypi": "{'variables':{'x':'1'}}", "gen.js": "p\n" },
      { "package.json": bare, "binding.gyp": inc, "a.c": "int x;\n", "inc.gypi": "{'variables':{'x':'<!(node gen.js)'}}", "gen.js": "p\n" },
      /inc\.gypi|includes|unresolved/,
    );
    const act = "{'targets':[{'target_name':'a','sources':['a.c'],'actions':[{'action_name':'g','inputs':['gen.js'],'outputs':['out.h'],'action':['node','gen.js']}]}]}";
    held(
      { "package.json": bare, "binding.gyp": act, "a.c": "int x;\n", "gen.js": "benign\n" },
      { "package.json": bare, "binding.gyp": act, "a.c": "int x;\n", "gen.js": "payload\n" },
      /gen\.js|actions|unresolved/,
    );
    const same = { "package.json": bare, "binding.gyp": act, "a.c": "int x;\n", "gen.js": "benign\n" };
    expect(hard(same, same)).toEqual([]);
  });

  test("node-gyp-build closes over the prebuilds it loads", () => {
    const p = pj({ install: "node-gyp-build" });
    const file = "prebuilds/darwin-arm64/a.node";
    const base = { "package.json": p, "binding.gyp": "{'targets':[]}\n", [file]: "same" };
    expect(hard(base, { ...base, "README.md": "x" })).toEqual([]);
    held(base, { ...base, [file]: "changed" }, /file/);
    const opt = pj({ install: "node-gyp-build-optional" });
    const optBase = { "package.json": opt, [file]: "same" };
    expect(hard(optBase, { ...optBase, "README.md": "x" })).toEqual([]);
  });

  test("a prebuild-install download does not hold when the surface matches", () => {
    const p = pj({ install: "prebuild-install || node-gyp rebuild" });
    const sameGyp = { "package.json": p, "binding.gyp": "{}\n" };
    expect(hard(sameGyp, sameGyp)).toEqual([]);
    held(sameGyp, { ...sameGyp, "binding.gyp": "{'targets':[]}\n" }, /binding\.gyp|file/);
    const gyp = pj({ install: "node-pre-gyp install --fallback-to-build" });
    expect(hard({ "package.json": gyp }, { "package.json": gyp })).toEqual([]);
  });

  test("node-gyp-build resolves only with no args, and a prebuild does not hide a gyp byte", () => {
    const arg = pj({ install: "node-gyp-build echo hi" });
    expect(hard({ "package.json": arg }, { "package.json": arg })).toEqual([]);
    const gyp = "{'targets':[{'target_name':'a','sources':['<!(cc -v 2>&1 | perl -ne \\'print $1\\')']}]}";
    const file = "prebuilds/darwin-arm64/a.node";
    const base = { "package.json": pj({ install: "node-gyp-build" }), "binding.gyp": gyp, [file]: "same" };
    expect(hard(base, { ...base, "README.md": "x" })).toEqual([]);
    const bare = { "package.json": pj({ install: "node-gyp-build" }), "binding.gyp": "{'targets':[{'action':['node','gen.js']}]}\n", "gen.js": "a\n" };
    held(bare, { ...bare, "gen.js": "b\n" }, /gen\.js|unresolved/);
    const packs = pj({ install: "node-gyp-build-optional-packages" });
    const packBase = { "package.json": packs, [file]: "same" };
    expect(hard(packBase, { ...packBase, "README.md": "x" })).toEqual([]);
    const tested = pj({ install: "node-gyp-build" }, { prebuild: { test: "check.js" } });
    held(
      { "package.json": tested, "check.js": "a\n", [file]: "same" },
      { "package.json": tested, "check.js": "b\n", [file]: "same" },
      /check\.js|file/,
    );
    const forced = "{'targets':[{'sources':['<(kept)']}]}";
    const forcedBase = { "package.json": tested, "check.js": "a\n", [file]: "same", "binding.gyp": forced };
    expect(hard(forcedBase, forcedBase)).toEqual([]);
    held(forcedBase, { ...forcedBase, "binding.gyp": "{'targets':[{'sources':['<(kept2)']}]}\n" }, /binding\.gyp|file/);
    const bin = pj({ install: "node-gyp-build" }, { binary: { module_name: "x" } });
    const binBase = { "package.json": bin, [file]: "same" };
    expect(hard(binBase, binBase)).toEqual([]);
  });

  test("a redirect does not hide a later node-gyp, and a redirect alone does not scan", () => {
    const install = "node buildcheck.js > buildcheck.gypi && node-gyp rebuild";
    const p = pj({ install });
    const gyp = "deps/cpu_features/cpu_features.gyp";
    const base = { "package.json": p, "binding.gyp": "{}\n", "buildcheck.js": "a\n", [gyp]: "a\n" };
    expect(hard(base, base)).toEqual([]);
    held(base, { ...base, [gyp]: "b\n" }, /cpu_features\.gyp|file/);
    held(base, { ...base, "buildcheck.js": "b\n" }, /buildcheck\.js|file/);
    const safe = pj({ install: "node safe.js > out" });
    const safeBase = { "package.json": safe, "safe.js": "a\n", "binding.gyp": "{}\n", [gyp]: "a\n" };
    expect(hard(safeBase, { ...safeBase, [gyp]: "b\n" })).toEqual([]);
  });

  test("node-gyp with an argument holds when the gyp changes, and any binding.gyp is in the closure", () => {
    const py = pj({ install: "node-gyp --python=tool.py rebuild" });
    const pyBase = { "package.json": py, "tool.py": "a\n", "binding.gyp": "{}\n" };
    expect(hard(pyBase, pyBase)).toEqual([]);
    held(pyBase, { ...pyBase, "binding.gyp": "{'targets':[]}\n" }, /binding\.gyp|file/);
    const rebuild = pj({ install: "node-gyp rebuild" });
    expect(hard({ "package.json": rebuild }, { "package.json": rebuild })).toEqual([]);
    const hook = pj({ postinstall: "node ok.js" });
    const gypi = "deps/common.gypi";
    held(
      { "package.json": hook, "ok.js": "1\n", "deps/binding.gyp": "{}\n", [gypi]: "a\n" },
      { "package.json": hook, "ok.js": "1\n", "deps/binding.gyp": "{}\n", [gypi]: "b\n" },
      /common\.gypi|gypi|file/,
    );
  });

  test("a gyp action outside actions, and a <( argument, hold", () => {
    const bare = JSON.stringify({ name: "x", version: "1" });
    const rules = "{'targets':[{'target_name':'a','rules':[{'rule_name':'r','action':['node','gen.js']}]}]}";
    held(
      { "package.json": bare, "binding.gyp": rules, "gen.js": "a\n" },
      { "package.json": bare, "binding.gyp": rules, "gen.js": "b\n" },
      /gen\.js|action|unresolved/,
    );
    const angled = "{'targets':[{'target_name':'a','sources':['<(foo)']}]}";
    const angledBase = { "package.json": bare, "binding.gyp": angled };
    expect(hard(angledBase, angledBase)).toEqual([]);
    held(angledBase, { ...angledBase, "binding.gyp": "{'targets':[{'target_name':'a','sources':['<(bar)']}]}\n" }, /binding\.gyp|file/);
  });

  test("node on a directory holds, and a bin change beside a hook holds", () => {
    const dir = pj({ postinstall: "node lib" });
    held(
      { "package.json": dir, "lib/package.json": JSON.stringify({ main: "payload.js" }), "lib/payload.js": "a\n" },
      { "package.json": dir, "lib/package.json": JSON.stringify({ main: "payload.js" }), "lib/payload.js": "b\n" },
      /payload|file/,
    );
    const index = pj({ postinstall: "node lib" });
    held(
      { "package.json": index, "lib/index.js": "a\n" },
      { "package.json": index, "lib/index.js": "b\n" },
      /index\.js|file/,
    );
    const bin = (target: string) => JSON.stringify({ name: "x", version: "1", bin: { x: target }, scripts: { postinstall: "node i.js" } });
    held(
      { "package.json": bin("a.js"), "i.js": "1\n", "a.js": "1\n", "b.js": "1\n" },
      { "package.json": bin("b.js"), "i.js": "1\n", "a.js": "1\n", "b.js": "1\n" },
      /bin/,
    );
    const dbin = (folder: string) => JSON.stringify({ name: "x", version: "1", directories: { bin: folder }, scripts: { postinstall: "node i.js" } });
    held(
      { "package.json": dbin("bin"), "i.js": "1\n" },
      { "package.json": dbin("tools"), "i.js": "1\n" },
      /bin/,
    );
    const quiet = (target: string) => JSON.stringify({ name: "x", version: "1", bin: { x: target } });
    expect(hard(
      { "package.json": quiet("a.js"), "a.js": "1\n", "b.js": "1\n" },
      { "package.json": quiet("b.js"), "a.js": "1\n", "b.js": "1\n" },
    )).toEqual([]);
  });

  test("patch-package closes over the patch files it applies", () => {
    const p = pj({ prepare: "patch-package" });
    const same = { "package.json": p, "patches/x+1.0.0.patch": "a\n" };
    expect(hard(same, { ...same, "README.md": "x" })).toEqual([]);
    held(same, { ...same, "patches/x+1.0.0.patch": "b\n" }, /file /);
    const named = pj({ prepare: "patch-package left-pad" });
    expect(hard({ "package.json": named }, { "package.json": named })).toEqual([]);
  });

  test("a star export under the key cap stays a review, and over the cap holds", () => {
    expect(STAR_KEY_MAX).toBe(4096);
    const p = JSON.stringify({ name: "x", version: "1", exports: { "./assets/*": "./assets/*" } });
    const underOld = { "package.json": p, [A]: oldB };
    const underNew = { "package.json": p, [A]: newB };
    expect(hard(underOld, underNew)).toEqual([]);
    expect(entryPaths(map(underNew)).has(A)).toBe(true);
    const fill: Record<string, string> = {};
    for (let i = 0; i < 4100; i++) fill[`a/f${i}.md`] = "x";
    const overOld = { "package.json": p, ...fill, [A]: oldB };
    const overNew = { "package.json": p, ...fill, [A]: newB };
    held(overOld, overNew, /key count/);
    const q = JSON.stringify({ name: "x", version: "1", scripts: { postinstall: "node assets/*.bmp" } });
    held({ "package.json": q, ...fill, [A]: oldB }, { "package.json": q, ...fill, [A]: newB }, /key count/);
  });
});
