import { describe, expect, test } from "bun:test";
import { classifyJs } from "../src/install-closure.ts";

// A const (or let/var, or a later assignment) bound to `.constructor.prototype` is the loader when the file assigns or
// defines `.prototype` on a module root: Module.prototype is a writable property of a plain function (OUP-331 hole 3).
const held = (body: string) => classifyJs("lib/x.js", body).pkg;
const SWAP = `const O = module.constructor.prototype;\nmodule.constructor.prototype = module.constructor;\n`;
const USE = `module.constructor.prototype = O;\nP._load(__dirname + "/../da" + "ta/h.js", null, false);\n`;

describe("a prototype const is bound when the file writes .prototype on a module root", () => {
  test.each([
    ["single line", `${SWAP}const P = module.constructor.prototype;\n${USE}`],
    ["let then assign", `${SWAP}let P; P = module.constructor.prototype;\n${USE}`],
    ["var then assign", `${SWAP}var P; P = module.constructor.prototype;\n${USE}`],
    ["line breaks (held on main)", `${SWAP}const P = module\n.constructor\n.prototype;\n${USE}`],
    ["require.main root", `const O = require.main.constructor.prototype;\nrequire.main.constructor.prototype = require.main.constructor;\nconst P = require.main.constructor.prototype;\nrequire.main.constructor.prototype = O;\nP._load(__dirname + "/../da" + "ta/h.js", null, false);\n`],
    ["alias of the constructor, prototype read from the alias", `const M = module.constructor;\nconst O = M.prototype;\nM.prototype = M;\nconst P = M.prototype;\nM.prototype = O;\nP._load(__dirname + "/../da" + "ta/h.js", null, false);\n`],
    ["alias of the constructor, let then assign", `const M = module.constructor;\nM.prototype = M;\nlet P; P = M.prototype;\nP._load(__dirname + "/../da" + "ta/h.js", null, false);\n`],
    ["defineProperty", `Object.defineProperty(module.constructor, "prototype", { value: module.constructor });\nconst P = module.constructor.prototype;\nP._load(__dirname + "/../da" + "ta/h.js", null, false);\n`],
    ["Reflect.set", `Reflect.set(module.constructor, "prototype", module.constructor);\nconst P = module.constructor.prototype;\nP._load(__dirname + "/../da" + "ta/h.js", null, false);\n`],
  ])("%s is held", (_n, body) => expect(held(body)).toBe(true));
});

describe("controls: the same shapes without a .prototype write stay as on main", () => {
  test.each([
    ["const prototype, single line, no write (released on main)", `const P = module.constructor.prototype;\nP._load(__dirname + "/../da" + "ta/h.js", null, false);\n`, false],
    ["let then assign, no write (released on main)", `let P; P = module.constructor.prototype;\nP._load(__dirname + "/../da" + "ta/h.js", null, false);\n`, false],
    ["a write on something that is not a module root", `function F() {}\nF.prototype = {};\nconst P = module.constructor.prototype;\nP.x = 1;\n`, false],
    ["alias prototype read, no write", `const M = module.constructor;\nconst P = M.prototype;\nP.x = 1;\n`, false],
    ["prototype write on an unrelated alias", `const M = Foo;\nM.prototype = M;\nconst P = M.prototype;\nP.x = 1;\n`, false],
    ["a plain const module binding stays held", `const M = module.constructor;\nM._load(__dirname + "/../da" + "ta/h.js", null, false);\n`, true],
    ["no module root at all", `const P = Object.prototype;\nObject.defineProperty(Foo, "prototype", { value: 1 });\n`, false],
  ])("%s", (_n, body, want) => expect(held(body)).toBe(want));
});

// OUP-331 hole 1 (a hook file writes its own shadow of a tool under node_modules/.bin: npm puts it first on PATH) and
// hole 2 (the file puts its own folder first on PATH). The loader text sits in a string, so main released the no-flag forms.
const LOADER = "#!/usr/bin/env node\\nmodule.constructor.register(process.cwd() + '/da' + 'ta/h.m' + 'js', 'file:///');\\n";
const WB = (tool: string) => `const fs = require("fs");\nconst cp = require("child_process");\nfs.mkdirSync("node_modules/.bin", { recursive: true });\nfs.writeFileSync("node_modules/.bin/${tool}", "${LOADER}", { mode: 0o755 });\n`;
describe("a file that writes under .bin or puts its own folder on PATH is held", () => {
  test.each([
    ["B1a no flag", WB("mkdir") + `cp.spawnSync("mkdir", ["out"]);\n`],
    ["B1a other tool shadowed", WB("ls") + `cp.spawnSync("ls", ["out"]);\n`],
    ["B1a async write", `const fs = require("fs");\nfs.writeFile("node_modules/.bin/cp", "x", () => {});\n`],
    ["B1a path.join", `const fs = require("fs"); const path = require("path");\nfs.writeFileSync(path.join("node_modules", ".bin", "mkdir"), "x");\n`],
    ["B2 parenthesized", `const cp = require("child_process");\n(process.env.PATH) = "bin:" + process.env.PATH;\ncp.spawnSync("mkdir", ["x"]);\n`],
    ["B2 plain", `const cp = require("child_process");\nprocess.env.PATH = "bin:" + process.env.PATH;\ncp.spawnSync("mkdir", ["x"]);\n`],
    ["B2 bracket key", `const cp = require("child_process");\nprocess.env["PATH"] = "bin:" + process.env.PATH;\ncp.spawnSync("mkdir", ["x"]);\n`],
    ["B2 aliased env", `const cp = require("child_process");\nconst e = process.env;\ne.PATH = "bin:" + e.PATH;\ncp.spawnSync("mkdir", ["x"]);\n`],
    ["B2 compound", `const cp = require("child_process");\nprocess.env.PATH += ":bin";\ncp.spawnSync("mkdir", ["x"]);\n`],
    ["B2 Object.assign", `const cp = require("child_process");\nObject.assign(process.env, { PATH: "bin:" + process.env.PATH });\ncp.spawnSync("mkdir", ["x"]);\n`],
  ])("%s is held", (_n, body) => expect(held(body)).toBe(true));

  test.each([
    ["a write to a path without .bin", `const fs = require("fs");\nfs.writeFileSync("out/a.txt", "x");\n`],
    ["a read of .bin", `const fs = require("fs");\nfs.readdirSync("node_modules/.bin");\n`],
    ["a PATH read beside a spawn", `const cp = require("child_process");\nconst p = process.env.PATH;\ncp.spawnSync("mkdir", ["x"]);\n`],
    ["a PATH comparison", `const cp = require("child_process");\nif (process.env.PATH == "") cp.spawnSync("mkdir", ["x"]);\n`],
    ["a PATH write with no spawn word", `process.env.PATH = "bin:" + process.env.PATH;\nconsole.log(1);\n`],
  ])("control, released as on main: %s", (_n, body) => expect(held(body)).toBe(false));
});

// Round 2 (OUP-331): structural premises. M1: PATH given to the child without touching process.env. M2: any `prototype` key (dot, bracket,
// destructured, Object.assign) on a module root or its constructor alias. M3: any write-capable fs call or spawned cp/mv/ln/install beside a child-process
// call with a command that is not an absolute literal.
const L2 = "module.constructor.register(process.cwd() + '/da' + 'ta/h.m' + 'js', 'file:///');";
const SH = `"#!/usr/bin/env node\\n${L2}\\n"`;
const FS = `const fs = require("fs");\nconst cp = require("child_process");\n`;
const D = `__dirname + "/../da" + "ta/h.js"`;
const PWRAP = (bind: string) => `const O = module.constructor.prototype;\nmodule.constructor.prototype = module.constructor;\n${bind}\nmodule.constructor.prototype = O;\nP._load(${D}, null, false);\n`;
describe("round 2: structural rules", () => {
  test.each([
    ["M1 env option", `${FS}cp.spawnSync("mkdir", ["out"], { env: { ...process.env, PATH: "bin:" + process.env.PATH } });\n`],
    ["M1 env shorthand", `${FS}const env = { PATH: "bin" };\ncp.spawnSync("mkdir", ["out"], { env });\n`],
    ["M1 PATH= in exec string", `${FS}cp.execSync("PATH=bin:$PATH mkdir out");\n`],
    ["M2 bracket write", `const O = module.constructor.prototype;\nmodule.constructor["prototype"] = module.constructor;\nconst P = module.constructor.prototype;\nmodule.constructor["prototype"] = O;\nP._load(${D}, null, false);\n`],
    ["M2 destructured bind", PWRAP(`const { prototype: P } = module.constructor;`)],
    ["M2 destructured shorthand", `const O = module.constructor.prototype;\nmodule.constructor.prototype = module.constructor;\nconst { prototype } = module.constructor;\nmodule.constructor.prototype = O;\nprototype._load(${D}, null, false);\n`],
    ["M2 parenthesized bind", PWRAP(`const P = (module.constructor).prototype;`)],
    ["M2 bracket read bind", PWRAP(`const P = module.constructor["prototype"];`)],
    ["M2 optional bind", PWRAP(`const P = module.constructor?.prototype;`)],
    ["M2 Object.assign write", `const O = module.constructor.prototype;\nObject.assign(module.constructor, { prototype: module.constructor });\nconst P = module.constructor.prototype;\nP._load(${D}, null, false);\n`],
    ["M2 alias bracket write", `const M = module.constructor;\nconst O = M.prototype;\nM["prototype"] = M;\nconst P = M.prototype;\nM["prototype"] = O;\nP._load(${D}, null, false);\n`],
    ["M2 alias destructured", `const M = module.constructor;\nM.prototype = M;\nconst { prototype: P } = M;\nP._load(${D}, null, false);\n`],
    ["M3 any write beside a bare command", `${FS}fs.writeFileSync("out/a.txt", "x");\ncp.spawnSync("mkdir", ["x"]);\n`],
    ["M3 path in variable", `${FS}const p = "node_modules/.bin/mkdir";\nfs.writeFileSync(p, ${SH}, { mode: 0o755 });\ncp.spawnSync("mkdir", ["out"]);\n`],
    ["M3 openSync + writeSync", `${FS}const fd = fs.openSync("node_modules/.bin/mkdir", "w", 0o755);\nfs.writeSync(fd, ${SH});\ncp.spawnSync("mkdir", ["out"]);\n`],
    ["M3 cpSync dir", `${FS}fs.cpSync("shadow", "node_modules/.bin", { recursive: true });\ncp.spawnSync("mkdir", ["out"]);\n`],
    ["M3 spawned cp", `${FS}cp.spawnSync("cp", ["shadow.js", "node_modules/.bin/mkdir"]);\ncp.spawnSync("mkdir", ["out"]);\n`],
    ["M3 promises.writeFile", `${FS}const d = require("path").join("node_modules", ".bin");\nfs.promises.writeFile(d + "/mkdir", ${SH});\ncp.spawnSync("mkdir", ["out"]);\n`],
    ["M3 command in a variable", `${FS}const c = "mkdir";\nfs.writeFileSync("node_modules/.bin/" + c, ${SH});\ncp.spawnSync(c, ["out"]);\n`],
  ])("%s is held", (_n, body) => expect(held(body)).toBe(true));

  test.each([
    ["an env key with no child-process word", `const o = { env: 1 };\nconsole.log(o);\n`],
    ["a prototype write with no module root", `function F() {}\nF["prototype"] = {};\nconst { prototype: P } = F;\nP.x = 1;\n`],
    ["a prototype destructure of the constructor, no write", `const { prototype: P } = module.constructor;\nP.x = 1;\n`],
    ["a write beside an absolute-path command", `${FS}fs.writeFileSync("out/a.txt", "x");\ncp.spawnSync("/bin/mkdir", ["out"]);\n`],
    ["a spawn with no write", `${FS}cp.spawnSync("mkdir", ["out"]);\n`],
    ["a write with no child-process", `const fs = require("fs");\nfs.writeFileSync("out/a.txt", "x");\nfs.copyFileSync("a", "b");\n`],
  ])("control, released as on main: %s", (_n, body) => expect(held(body)).toBe(false));
});

// Hole 1b (a file writes a loader file that a later hook command runs) over-holds ordinary packages (6 npm files): ruled separately.
describe("pending a ruling", () => {
  test.skip("B1b: fs.writeFileSync('lib/gen.js', loader text) with no mkdir line, run later by a hook command", () => {});
  test.skip("B1b: the same with mkdir -p lib spawned first", () => {});
});

// Speed (OUP-331): a long run of whitespace after `.PATH`, or many alias lines, must not make the scan quadratic. Decided on the fastest of three runs
// per size; a linear scan grows about 8x from 8,000 to 64,000 characters, a quadratic one about 64x.
const fastest = (body: () => string): number => {
  let best = Infinity;
  for (let i = 0; i < 3; i++) {
    const src = body();
    const t0 = performance.now();
    classifyJs("lib/x.js", src);
    best = Math.min(best, performance.now() - t0);
  }
  return best;
};
describe("the PATH and prototype scans stay linear", () => {
  const CP = `const cp = require("child_process");\ncp.spawnSync("mkdir", ["out"]);\n`;
  test.each([
    ["spaces after .PATH", (n: number) => `${CP}process.env.PATH${" ".repeat(n)}+ "x";\n`],
    ["spaces after .PATH and a parenthesis", (n: number) => `${CP}(process.env.PATH)${" ".repeat(n)}+ "x";\n`],
    ["spaces after constructor.prototype", (n: number) => `module.constructor.prototype${" ".repeat(n)}+ 1;\nconst P = (module.constructor)${" ".repeat(n)}.x;\n`],
  ])("%s", (_n, make) => {
    const small = Math.max(fastest(() => make(8000)), 1);
    const big = fastest(() => make(64000));
    expect(big / small).toBeLessThan(24);
  });
  test("many alias lines", () => {
    const make = (n: number) => `const M = module.constructor;\nM.prototype = M;\n${"const P = M.prototype;\n".repeat(n)}`;
    const small = Math.max(fastest(() => make(2000)), 1);
    const big = fastest(() => make(16000));
    expect(big / small).toBeLessThan(24);
  });
});
