import { expect, test } from "bun:test";
import { classifyJs } from "../src/install-closure.ts";
import { prepass, type FileMap } from "../src/prepass.ts";

const enc = (s: string) => new TextEncoder().encode(s);
const files = (o: Record<string, string>): FileMap => new Map(Object.entries(o).map(([k, v]) => [k, enc(v)]));
const holds = (old: FileMap, now: FileMap) => prepass("npm", old, now).hard.some((s) => s.kind === "install-script");

// An entry loads or runs docs/evil.js through a name the entry builds. Only docs/evil.js changes between the releases.
const release = (v: string, entry: string, body: string, hook = "postinstall") =>
  files({
    "package.json": JSON.stringify({ name: "p", version: v, scripts: { [hook]: `node ${entry}` }, config: { n: "evil.js" } }),
    [entry]: body,
    "lib/a.js": "module.exports = 1\n",
    "a.js": "module.exports = 1\n",
    "name.txt": "evil.js\n",
    "names.json": `{"n":"evil.js"}\n`,
    "docs/evil.js": `console.log("evil ${v}")\n`,
  });
const held = (entry: string, body: string, hook = "postinstall") => holds(release("1.0.0", entry, body, hook), release("1.0.1", entry, body, hook));

// Rule 1: a name built only from literals and calls or members on literals, in a concatenated require or an exec command.
const siblings: [string, string, string][] = [
  ["String.fromCharCode", `const n = String.fromCharCode(101, 118, 105, 108, 46, 106, 115);`, "n"],
  ["a destructured member of a literal object", `const { n } = { n: ["evil", "js"].join(".") };`, "n"],
  ["a member of an object built from literals", `const o = { n: ["evil", "js"].join(".") };`, "o.n"],
  ["a local arrow function applied to literals", `const f = (a) => a.join(".");\nconst n = f(["evil", "js"]);`, "n"],
  ["Array.of", `const n = Array.of("evil", "js").join(".");`, "n"],
  ["decodeURIComponent", `const n = decodeURIComponent("evil%2Ejs");`, "n"],
];
const placements: [string, string, string, string][] = [
  ["the package root", "x.js", "./docs/", "postinstall"],
  ["a nested entry", "lib/x.js", "../docs/", "postinstall"],
  ["a deeper entry", "a/b/x.js", "../../docs/", "postinstall"],
  ["a preinstall hook", "lib/x.js", "../docs/", "preinstall"],
];
for (const [label, decl, use] of siblings) {
  for (const [where, entry, dir, hook] of placements) {
    test(`${label} in a concatenated require at ${where} holds the changed docs/evil.js`, () => {
      expect(held(entry, `${decl}\nrequire("${dir}" + ${use});\n`, hook)).toBe(true);
    });
  }
  test(`${label} in a template require holds the changed docs/evil.js`, () => {
    expect(held("lib/x.js", `${decl}\nrequire(\`../docs/\${${use}}\`);\n`)).toBe(true);
  });
  test(`${label} in an exec command holds the changed docs/evil.js`, () => {
    expect(held("lib/x.js", `const cp = require("child_process");\n${decl}\ncp.execSync("node docs/" + ${use}, { stdio: "inherit" });\n`)).toBe(true);
  });
}
test("a local function declaration applied to literals holds the changed docs/evil.js", () => {
  expect(held("lib/x.js", `function f(a) { return a.join("."); }\nconst n = f(["evil", "js"]);\nrequire("../docs/" + n);\n`)).toBe(true);
});
// New holds: main read these as quiet (a call on a literal is a name built from literals).
test("new hold: a method call on a literal and a chain of replaces hold the changed docs/evil.js", () => {
  expect(held("lib/x.js", `const n = "EVIL.JS".toLowerCase();\nrequire("../docs/" + n);\n`)).toBe(true);
  expect(held("lib/x.js", `const n = "eXil.jZ".replace("X", "v").replace("Z", "s");\nrequire("../docs/" + n);\n`)).toBe(true);
});

// Rule 2: a part read from the package's own files can be any file.
const CPX = `const cp = require("child_process");\n`;
const reads: [string, string][] = [
  ["an fs read of a name file", `const fs = require("fs");\nconst n = fs.readFileSync(__dirname + "/../name.txt", "utf8").trim();`],
  ["a require of a data file", `const n = require("../names.json").n;`],
  ["a JSON.parse of an fs read", `const n = JSON.parse(require("fs").readFileSync(__dirname + "/../names.json", "utf8")).n;`],
  ["a readdirSync pick", `const fs = require("fs");\nconst n = fs.readdirSync(__dirname + "/../docs").find((f) => f.startsWith("ev"));`],
  ["a package.json config field", `const n = require("../package.json").config.n;`],
  ["an env value or a package.json config field", `const n = process.env.npm_package_config_n || require("../package.json").config.n;`],
  ["an fs read through a second name", `const fs = require("fs");\nconst raw = fs.readFileSync(__dirname + "/../name.txt");\nconst n = raw.toString().trim();`],
];
for (const [label, decl] of reads) {
  test(`${label} in a concatenated require holds the changed docs/evil.js`, () => {
    expect(held("lib/x.js", `${decl}\nrequire("../docs/" + n);\n`)).toBe(true);
  });
  test(`${label} in an exec command holds the changed docs/evil.js`, () => {
    expect(held("lib/x.js", `${CPX}${decl}\ncp.execSync("node docs/" + n, { stdio: "inherit" });\n`)).toBe(true);
  });
}
test("an fs name inside a path.join(__dirname, ...) require holds the changed docs/evil.js", () => {
  const body = `const p = require("path"), fs = require("fs");\nconst n = fs.readFileSync(p.join(__dirname, "..", "name.txt"), "utf8").trim();\nrequire(p.join(__dirname, "..", "docs", n));\n`;
  expect(held("lib/x.js", body)).toBe(true);
});
test("a require result used as a path part holds the changed docs/evil.js", () => {
  expect(held("lib/x.js", `const n = require("./a.js");\nrequire("../docs/" + n);\n`)).toBe(true);
});

// Rule 3: a value that came from child_process runs a command whatever way it is reached.
const F = `const n = ["evil", "js"].join(".");\n`;
const O = `, { stdio: "inherit" }`;
const receivers: [string, string][] = [
  ["inline require(cp).execSync", F + `require("child_process").execSync("node docs/" + n${O});\n`],
  ["inline require(node:cp).execSync", F + `require("node:child_process").execSync("node docs/" + n${O});\n`],
  ["renamed destructure", `const { execSync: run } = require("child_process");\n` + F + `run("node docs/" + n${O});\n`],
  ["const x = cp", `const cp = require("child_process"); const x = cp;\n` + F + `x.execSync("node docs/" + n${O});\n`],
  ["node: prefix const cp", `const cp = require("node:child_process");\n` + F + `cp.execSync("node docs/" + n${O});\n`],
  ["optional call cp?.execSync", `const cp = require("child_process");\n` + F + `cp?.execSync("node docs/" + n${O});\n`],
  ["optional call cp.execSync?.()", `const cp = require("child_process");\n` + F + `cp.execSync?.("node docs/" + n${O});\n`],
  ["bracket cp['execSync']", `const cp = require("child_process");\n` + F + `cp["execSync"]("node docs/" + n${O});\n`],
  ["property alias run = cp.execSync", `const cp = require("child_process"); const run = cp.execSync;\n` + F + `run("node docs/" + n${O});\n`],
  ["function param receives cp", `function go(c, m) { c.execSync("node docs/" + m${O}); }\n` + F + `go(require("child_process"), n);\n`],
  ["module.require(cp)", F + `module.require("child_process").execSync("node docs/" + n${O});\n`],
  ["spawnSync shell option", `const cp = require("child_process");\n` + F + `cp.spawnSync("node docs/" + n, [], { shell: true, stdio: "inherit" });\n`],
  ["spawn shell option (async)", `const cp = require("child_process");\n` + F + `cp.spawn("node docs/" + n, { shell: true, stdio: "inherit" });\n`],
  ["execSync.call", `const cp = require("child_process");\n` + F + `cp.execSync.call(null, "node docs/" + n${O});\n`],
  ["Reflect.apply", `const cp = require("child_process");\n` + F + `Reflect.apply(cp.execSync, cp, ["node docs/" + n${O}]);\n`],
  ["let cp = require then cp.exec", `let cp = require("child_process");\n` + F + `cp.exec("node docs/" + n);\n`],
  ["var { exec } destructure", `var { exec } = require("child_process");\n` + F + `exec("node docs/" + n);\n`],
  ["import * as (esm)", `import * as cp from "node:child_process";\n` + F + `cp.execSync("node docs/" + n${O});\n`],
  ["import default (esm)", `import cp from "node:child_process";\n` + F + `cp.execSync("node docs/" + n${O});\n`],
  ["import { execSync as run } (esm)", `import { execSync as run } from "node:child_process";\n` + F + `run("node docs/" + n${O});\n`],
  ["await import(cp) (esm)", F + `const cp = await import("node:child_process");\ncp.execSync("node docs/" + n${O});\n`],
  ["mainModule require", F + `(process.mainModule ?? module).require("child_process").execSync("node docs/" + n${O});\n`],
  ["let cp; cp = require", `let cp; cp = require("child_process");\n` + F + `cp.execSync("node docs/" + n${O});\n`],
  ["an alias of an alias", `const cp = require("child_process"); const a = cp; const b = a;\n` + F + `b.execSync("node docs/" + n${O});\n`],
  ["apply with an argument array", `const cp = require("child_process");\n` + F + `cp.execSync.apply(cp, ["node docs/" + n]);\n`],
  ["a bound alias", `const cp = require("child_process"); const run = cp.execSync.bind(cp);\n` + F + `run("node docs/" + n${O});\n`],
  ["a decode instead of a join", `const n = Buffer.from("ZXZpbC5qcw==", "base64").toString();\nrequire("child_process").execSync("node docs/" + n${O});\n`],
  ["a read name instead of a join", `const n = require("fs").readFileSync(__dirname + "/../name.txt", "utf8").trim();\nrequire("child_process").execSync("node docs/" + n${O});\n`],
];
for (const [label, body] of receivers) {
  test(`${label} runs a folded name and holds the changed docs/evil.js`, () => {
    expect(held("lib/x.js", body)).toBe(true);
  });
}
test("a receiver run holds from the package root and from a preinstall hook", () => {
  const body = `const { execSync: run } = require("child_process");\n${F}run("node docs/" + n${O});\n`;
  expect(held("x.js", body)).toBe(true);
  expect(held("lib/x.js", body, "preinstall")).toBe(true);
});

// Quiet: runtime input, a read that is not in a load path, and calls that are not runs.
const quiet: [string, string, string][] = [
  ["a platform part", "lib/x.js", `require("./lib/" + process.platform);\n`],
  ["an argv name", "lib/x.js", `const n = process.argv[2];\nrequire("./lib/" + n);\n`],
  ["an env name", "lib/x.js", `const n = process.env.X;\nrequire("./lib/" + n);\n`],
  ["a platform name with a suffix", "lib/x.js", `const n = process.platform + ".js";\nrequire("./lib/" + n);\n`],
  ["a __dirname part", "lib/x.js", `require(__dirname + "/lib/" + process.arch);\n`],
  ["an argv exec command", "lib/x.js", `${CPX}cp.execSync("node lib/" + process.argv[2]);\n`],
  ["an env exec command through a renamed destructure", "lib/x.js", `const { execSync: run } = require("child_process");\nrun("node lib/" + process.env.X);\n`],
  ["an fs read that is printed beside a path built from the platform", "lib/x.js", `const s = require("fs").readFileSync(__dirname + "/../name.txt", "utf8");\nconsole.log(s);\nconst n = process.platform;\nrequire("./lib/" + n);\n`],
  ["a run of a literal through a renamed destructure", "lib/x.js", `const { execSync: run } = require("child_process");\nconst n = ["a", "b"].join("");\nrun("echo hi");\nconsole.log(n);\n`],
  ["a folded name that is only an option of an aliased run", "lib/x.js", `const cp = require("child_process");\nconst x = cp;\nconst n = ["a", "b"].join("");\nx.execSync("echo hi", { cwd: n });\n`],
];
for (const [label, entry, body] of quiet) {
  test(`${label} stays quiet when only docs/evil.js changes`, () => {
    expect(held(entry, body)).toBe(false);
  });
}


// Shadowed built-ins, a destructuring that takes nothing away, and the other classes added in review.
const more: [string, string][] = [
  ["a shadowed String", `const String = ["evil", "js"].join(".");\nconst n = String.concat();\nrequire("../docs/" + n);\n`],
  ["a shadowed Object", `const Object = ["evil", "js"].join(".");\nconst n = Object.concat();\nrequire("../docs/" + n);\n`],
  ["a shadowed parseInt", `const parseInt = ["evil", "js"].join(".");\nconst n = parseInt.concat();\nrequire("../docs/" + n);\n`],
  ["a destructuring of the same name elsewhere (prefix)", `const prefix = "ev";\nconst n = prefix + "il.js";\nrequire("../docs/" + n);\nfunction g(opts) { const { prefix } = opts; }\n`],
  ["a destructuring of the same name elsewhere (+=)", `let n = "ev";\nn += "il.js";\nconst { n: q } = x;\nrequire("../docs/" + n);\n`],
  ["a destructuring of the same name elsewhere (template)", "const a = \"evil\";\nconst n = `${a}.js`;\nconst { a: z } = {};\nrequire(\"../docs/\" + n);\n"],
  ["an fs read through a renamed destructure", `const { readFileSync: read } = require("fs");\nconst n = read(__dirname + "/../name.txt", "utf8").trim();\nrequire("../docs/" + n);\n`],
  ["an fs read through a plain destructure", `const { readFileSync } = require("fs");\nconst n = readFileSync(__dirname + "/../name.txt", "utf8").trim();\nrequire("../docs/" + n);\n`],
  ["an fs/promises read through a renamed import", `import { readFile as rd } from "fs/promises";\nconst n = (await rd("n.txt", "utf8")).trim();\nrequire("../docs/" + n);\n`],
  ["an fs.readFile callback parameter", `const fs = require("fs");\nfs.readFile("n.txt", (err, n) => require("../docs/" + n.trim()));\n`],
  ["an fs promises then parameter", `const fs = require("fs");\nfs.promises.readFile("n.txt", "utf8").then((n) => require("../docs/" + n.trim()));\n`],
  ["a decode of an fs read", `const out = require("fs").readFileSync(__dirname + "/../name.txt");\nrequire("../docs/" + Buffer.from(out).toString());\n`],
  ["an inline decodeURIComponent", `require("../docs/" + decodeURIComponent("evil%2Ejs"));\n`],
  ["an inline String.fromCharCode", `require("../docs/" + String.fromCharCode(101, 118, 105, 108, 46, 106, 115));\n`],
  ["an array bound to a name then joined", `const parts = ["evil", "js"];\nconst n = parts.join(".");\nrequire("../docs/" + n);\n`],
];
for (const [label, body] of more) {
  test(`${label} holds the changed docs/evil.js`, () => {
    expect(held("lib/x.js", body)).toBe(true);
  });
}
const more2: [string, string, string?][] = [
  ["a joined literal fold (join of a +)", `const { join } = require("path");\nconst n = join("ev" + "il.js");\nrequire("../docs/" + n);\n`],
  ["a joined array join", `const { join } = require("path");\nconst n = join(["evil", "js"].join("."));\nrequire("../docs/" + n);\n`],
  ["a joined template", "const { join } = require(\"path\");\nconst a = \"evil\";\nconst n = join(`${a}.js`);\nrequire(\"../docs/\" + n);\n"],
  ["an imported join of a fold", `import { join } from "path";\nconst n = join("ev" + "il.js");\nrequire("../docs/" + n);\n`],
  ["a name read through a destructuring that names another fold (require)", `const x = "";\nconst n = x + "evil.js";\nfunction z() { const { x } = n; }\nrequire("../docs/" + x + n);\n`],
  ["the same after a harmless require of the first name", `const x = "";\nconst n = x + "evil.js";\nfunction z() { const { x } = n; }\nrequire("./lib/" + x);\nrequire("../docs/" + n);\n`],
  ["the same in an exec command", `${CPX}const x = "";\nconst n = x + "evil.js";\nfunction z() { const { x } = n; }\ncp.execSync("node docs/" + x + n);\n`],
  ["a for-of over a readdir", `const fs = require("fs"), path = require("path");\nconst d = __dirname + "/../docs";\nfor (const f of fs.readdirSync(d)) require(path.join(d, f));\n`],
  ["a forEach over a readdir", `const fs = require("fs");\nfs.readdirSync(__dirname).forEach((f) => require("./" + f));\n`],
  ["a promisified fs.readFile awaited", `const fs = require("fs"), util = require("util");\nconst rf = util.promisify(fs.readFile);\n(async () => { const n = await rf("n.txt", "utf8"); require("../docs/" + n.trim()); })();\n`],
  ["a bracket fs read", `const fs = require("fs");\nconst n = fs["readFileSync"](__dirname + "/../name.txt", "utf8");\nrequire("../docs/" + n);\n`],
  ["a numeric Buffer decode", `const n = Buffer.from([101, 118, 105, 108, 46, 106, 115]).toString();\nrequire("../docs/" + n);\n`],
  ["a regex replacement on a literal", `const n = "eXil.js".replace(/X/, "v");\nrequire("../docs/" + n);\n`],
  ["a data file of a bare package", `const n = require("name-provider/names.json").n;\nrequire("../docs/" + n);\n`],
  ["npm's package config env value", `const n = process.env.npm_package_config_n;\nrequire("../docs/" + n);\n`],
  ["a template require of a data file", "const n = require(`${__dirname}/../names.json`).n;\nrequire(\"../docs/\" + n);\n"],
  ["a createRequire result loading child_process", `import { createRequire } from "module";\nconst n = [\"evil\", \"js\"].join(\".\");\nconst req = createRequire(import.meta.url);\nreq("child_process").execSync("node docs/" + n);\n`],
  ["a name bound to child_process then required", `const n = ["evil", "js"].join(".");\nconst c = "child_process";\nrequire(c).execSync("node docs/" + n);\n`],
  ["an argument array held by a name", `${CPX}const n = ["evil", "js"].join(".");\nconst args = ["docs/" + n];\ncp.spawnSync(process.execPath, args);\n`],
  ["an execution function passed as a parameter", `const n = ["evil", "js"].join(".");\nfunction go(run, m) { run("node docs/" + m); }\ngo(require("child_process").execSync, n);\n`],
  ["an execution function passed to a function called more than 50 times", `const n = ["evil", "js"].join(".");\nfunction go(run, m) { run("node docs/" + m); }\n${"go(null, 1);\n".repeat(60)}go(require("child_process").execSync, n);\n`],
  ["nested arrow functions", `const n = a => a => a => a => a => a => a => a => a => "x";\nrequire("./lib/" + n);\n`],
];
for (const [label, body] of more2) {
  test(`${label} holds the changed docs/evil.js`, () => {
    expect(held("lib/x.js", body)).toBe(true);
  });
}
test("a createRequire result loading child_process holds in an .mjs entry", () => {
  expect(held("lib/x.mjs", `import { createRequire } from "module";\nconst n = ["evil", "js"].join(".");\nconst req = createRequire(import.meta.url);\nreq("child_process").execSync("node docs/" + n);\n`)).toBe(true);
});
const rec = `const n = ["evil", "js"].join(".");\n`;
const receivers2: [string, string][] = [
  ["a holder object { proc: cp }", `const cp = require("child_process");\nconst o = { proc: cp };\n${rec}o.proc.execSync("node docs/" + n);\n`],
  ["util.promisify(cp.exec)", `const cp = require("child_process");\nconst util = require("util");\nconst run = util.promisify(cp.exec);\n${rec}run("node docs/" + n);\n`],
  ["promisify(exec)", `const { exec } = require("child_process");\nconst { promisify } = require("util");\nconst run = promisify(exec);\n${rec}run("node docs/" + n);\n`],
  ["import(cp).then with a destructured parameter", `${rec}import("child_process").then(({ execSync }) => execSync("node docs/" + n));\n`],
  ["import(cp).then with a module parameter", `${rec}import("child_process").then((cp) => cp.execSync("node docs/" + n));\n`],
  ["process.getBuiltinModule", `${rec}process.getBuiltinModule("node:child_process").execSync("node docs/" + n);\n`],
  ['require("child_" + "process")', `${rec}require("child_" + "process").execSync("node docs/" + n);\n`],
  ["cp.execSync.bind(cp, command)", `const cp = require("child_process");\n${rec}const r = cp.execSync.bind(cp, "node docs/" + n);\nr();\n`],
];
for (const [label, body] of receivers2) {
  test(`${label} runs a folded name and holds the changed docs/evil.js`, () => {
    expect(held("lib/x.js", body)).toBe(true);
  });
}

// Quiet: names that are not literals, reads that are not of the read family, strings that only mention fs, path joins, numbers.
const quiet2: [string, string][] = [
  ["a literal command that names fs.js", `${CPX}cp.execSync("node scripts/fs.js");\n`],
  ["a literal command that copies fs.node", `${CPX}cp.execSync("cp build/Release/fs.node lib/");\n`],
  ["a literal command that holds a require string", `${CPX}cp.execSync('node -e "require(\\'./build\\')"');\n`],
  ["a destructured join of literals in a command", `const { join } = require("path");\nconst BIN = join("vendor", "bin");\nrequire("child_process").execSync(join(__dirname, BIN, "tool"));\n`],
];
quiet2.push(
  ["a joined literal pair", `const { join } = require("path");\nconst n = join("vendor", "bin");\nrequire("../docs/" + n);\n`],
  ["a renamed key whose value is a plain join", `const path = require("path");\nconst { bin: binMap } = require("./package.json");\nconst bin = path.join(__dirname, "vendor", "tool");\nrequire("child_process").execSync(bin + " install");\n`],
  ["an argument array held by a name, all literal", `${CPX}const args = ["--version"];\ncp.spawnSync(process.execPath, args);\n`],
);
for (const [label, body] of quiet2) {
  test(`${label} stays quiet when only docs/evil.js changes`, () => {
    expect(held("lib/x.js", body)).toBe(false);
  });
}


// Quiet: literals, runtime input and the allowlisted parts, in every position.
const quiet3: [string, string][] = [
  ["a db exec of a literal statement", `const db = { exec() {} };\ndb.exec("select 1");\nrequire("./lib/" + process.platform);\n`],
  ["a node-gyp fallback with a literal argument array", `${CPX}cp.spawnSync("node-gyp", ["rebuild"], { stdio: "inherit" });\n`],
  ["a plain bare-package require", `require("left-pad");\nrequire("@scope/pkg");\nimport("./lib/a.js");\n`],
  ["an os.platform() part and a template of allowed parts", "const os = require(\"os\");\nrequire(\"./lib/\" + os.platform());\nrequire(`./lib/${process.arch}-${process.platform}.js`);\n"],
  ["a path.join of runtime parts", `const path = require("path");\nrequire(path.join(__dirname, "lib", process.platform));\nrequire(path.resolve(process.cwd(), "lib"));\n`],
  ["a name bound only to allowed parts", `const dir = __dirname + "/lib/";\nconst file = dir + process.arch;\nrequire(file);\n`],
  ["a command built from __dirname", `${CPX}cp.execSync("node " + __dirname + "/x.js");\ncp.spawnSync(process.execPath, [__dirname + "/x.js", process.argv[2]]);\n`],
  ["a createRequire handle called with a literal", `import { createRequire } from "module";\nconst req = createRequire(import.meta.url);\nreq("./a.js");\n`],
  ["an import() of import.meta.dirname", "await import(`${import.meta.dirname}/lib/a.js`);\n"],
  ["a package resolve inside a path.join", `const path = require("path");\nrequire(path.join(path.dirname(require.resolve("left-pad")), "package.json"));\n`],
  ["a regex with a quote inside the callback of a literal exec", `${CPX}cp.exec("git rev-parse HEAD", (e, out) => console.log(out.replace(/"/g, "")));\n`],
  ["a path.dirname beside an os name bound in one statement", `const os = require("os"), path = require("path");\nrequire("./lib/" + path.dirname(__filename));\n`],
  ["a destructured basename", `const { basename } = require("path");\nrequire("./lib/" + basename(__filename));\n`],
  ["hex and decimal number literals", `require("./lib/" + 0x10 + 1.5);\n`],
  ["a name declared empty and given constant values", `${CPX}let bin;\nif (process.platform === "win32") bin = "tool.exe"; else bin = "tool";\ncp.execFileSync(bin);\n`],
  ["a name that extends itself", `let bin = "tool";\nif (process.platform === "win32") bin = bin + ".exe";\nrequire("./lib/" + bin);\n`],
  ["a long wrapper function in a file naming child_process", `${CPX}(async () => {\n${"  await 1;\n".repeat(80)}})();\n`],
  ["a string that only mentions a call", `console.log("run exec(cmd) or require(name) by hand");\nrequire("./lib/" + process.platform);\n`],
];
for (const [label, body] of quiet3) {
  test(`${label} stays quiet when only docs/evil.js changes`, () => {
    expect(held("lib/x.js", body)).toBe(false);
  });
}

// Accepted cost: any dynamic part that is not literal or on the allowlist reads as naming any file.
const widens: [string, string][] = [
  ["a name from a function parameter", `function load(name) { return require("../docs/" + name); }\nload(process.platform);\n`],
  ["a loop variable", `for (const name of ["a", "b"]) require("../docs/" + name);\n`],
  ["a counter", `for (let i = 0; i < 2; i++) require("../docs/" + i);\n`],
  ["a function result", `const f = (a) => a;\nrequire("../docs/" + f(process.platform));\n`],
  ["data read from a package file", `const n = require("../names.json").n;\nrequire("../docs/" + n);\n`],
  ["a destructured env name", `const { n } = process.env;\nrequire("../docs/" + n);\n`],
  ["a method on an allowed part", `require("../docs/" + process.platform.toUpperCase());\n`],
  ["a call on a local object that only looks like fs", `const reader = { readFileSync() { return process.platform; } };\nconst n = reader["readFileSync"]();\nrequire("../docs/" + n);\n`],
  ["a literal array indexed in a path", `const names = ["a", "b"];\nrequire("../docs/" + names[0]);\n`],
  ["a method call on a literal", `const n = "A.JS".toLowerCase();\nrequire("../docs/" + n);\n`],
  ["an encode that is not a decode", `${CPX}const s = Buffer.alloc(1);\ncp.spawnSync("c", ["-e", s.toString("base64")]);\n`],
  ["a decode of a value read by the file", `const out = process.argv[2];\nrequire("../docs/" + Buffer.from(out).toString());\n`],
  ["a ternary of allowed parts", `const n = process.env.X ? process.platform : process.arch;\nrequire("../docs/" + n);\n`],
  ["a numeric helper in a command", `${CPX}cp.execSync("tool " + Math.max(1, 2));\n`],
  ["an exec of a name from a parameter on any receiver", `${CPX}function run(db, sql) { db.exec(sql); }\nrun({ exec() {} }, "select 1");\n`],
  ["a spawn argument array element from a parameter", `${CPX}function go(f) { cp.spawn("node", [f]); }\ngo("x.js");\n`],
  ["a parameter called as a function beside child_process", `${CPX}cp.execSync("echo hi");\nfunction go(run) { run("node docs/evil.js"); }\ngo(cp.execSync);\n`],
  ["a computed member call beside child_process", `${CPX}const k = "exec" + "Sync";\ncp[k]("node docs/evil.js");\n`],
  ["a child_process name spelled in pieces", `const m = "child_" + "process";\nrequire(m)["exec" + "Sync"]("node docs/evil.js");\n`],
  ["a nested join deeper than the cap", `const path = require("path");\nrequire(${"path.join(".repeat(12)}"a"${")".repeat(12)});\n`],
  ["more than 200 names in one path", `${Array.from({ length: 210 }, (_, i) => `const v${i} = "a";\n`).join("")}require("./" + ${Array.from({ length: 210 }, (_, i) => `v${i}`).join(" + ")});\n`],
];
for (const [label, body] of widens) {
  // The tier itself is asserted: a literal ../docs/ head is held by the prefix tier of the existing rules even without this rule.
  test(`${label} widens to every file`, () => {
    expect(classifyJs("lib/x.js", body).all).toBe(true);
  });
}
test("a template with an inner backtick is no template of allowed parts", () => {
  expect(classifyJs("lib/x.js", "const n = foo();\nrequire(`` + n + ``);\n").all).toBe(true);
  expect(classifyJs("lib/x.js", `${CPX}const c = foo();\ncp.execSync(\`\` + c + \`\`);\n`).all).toBe(true);
});

// Time. Each shape is classified at a small and a large size; the answer must hold at both, the time must grow no faster than the
// size (grows below), and the large file must be within a small multiple of the same size of plain statements (the control).
// grows: a linear scan takes `factor` times as long on a `factor` times larger file, a quadratic one `factor` squared. Three times
// linear is allowed for noise; the floor is the smallest time worth believing.
export const grows = (small: number, large: number, factor: number, floor = 2): boolean => large < 3 * factor * Math.max(small, floor);
test("the growth check fails pure-quadratic samples and passes linear ones", () => {
  for (const [factor, small] of [[8, 1], [8, 8], [8, 100], [32, 1], [32, 7], [32, 100], [16, 0.5]] as const) {
    expect(grows(small, small * factor * factor, factor)).toBe(false);
    expect(grows(small, small * factor, factor)).toBe(true);
    expect(grows(small, small * factor * 2.5, factor)).toBe(true);
  }
  expect(grows(1, 64, 8)).toBe(false); // samples 1 to 64 ms over 8 times the size
});
const all = (body: string): { ms: number; all: boolean } => {
  const s = performance.now();
  const tier = classifyJs("lib/x.js", body);
  return { ms: performance.now() - s, all: tier.all };
};
const median = (f: () => number, n = 3): number => [...Array(n)].map(f).sort((a, b) => a - b)[n >> 1]!;
const rep = (mb: number, unit: string, head = "", tail = "") => head + unit.repeat(Math.max(1, Math.floor((mb * 1_000_000) / unit.length))) + tail;
const control = (mb: number) => rep(mb, "const c = 1;\n", "", `require("./lib/" + process.platform);\n`);
const nest = (mb: number, open: string, inner: string, close: string, head = "", tail = "") => {
  const n = Math.max(1, Math.floor((mb * 1_000_000) / (open.length + close.length)));
  return head + open.repeat(n) + inner + close.repeat(n) + tail;
};
const P = `const path = require("path");\n`;
const SMALL = 0.25;
const LARGE = 2;
const ws = (mb: number) => " ".repeat(Math.floor(mb * 100_000));
const calls = (mb: number, init: string, call: string, ratioInits: number, ratioCalls: number) => {
  const per = ratioInits * init.length + ratioCalls * call.length;
  const n = Math.max(1, Math.floor((mb * 1_000_000) / per));
  return CPX + init.repeat(n * ratioInits) + call.repeat(n * ratioCalls);
};
// [label, body at a size in MB, whether the file widens to every file]
const perf: [string, (mb: number) => string, boolean][] = [
  ["nested path.join calls", (mb) => nest(mb, "path.join(", `"a"`, ")", `${P}require(`, ");\n"), true],
  ["nested path.join calls inside templates", (mb) => nest(mb, "path.join(`${", "process.arch", "}`)", `${P}require(`, ");\n"), true],
  ["nested arrow functions", (mb) => nest(mb, "a => ", `"x"`, "", "const n = ", `;\nrequire("../docs/" + n);\n`), true],
  ["nested parenthesized arrows", (mb) => nest(mb, "(a) => (", `"x"`, ")", "const n = ", `;\nrequire("../docs/" + n);\n`), true],
  ["repeated function definitions", (mb) => rep(mb, "function f(a, b) { return a; }\n", "", `require("../docs/" + f(1));\n`), true],
  ["default-parameter functions", (mb) => rep(mb, "function f(a = g(1), b = h(2, [3])) { return a; }\n", CPX, `require("./lib/" + a);\n`), true],
  ["many names, one used", (mb) => rep(mb, "const n = 1;\nlet m = n;\n", "", `require("./lib/" + m);\n`), true],
  ["many declared names and a quiet path", (mb) => rep(mb, "const n = 1, m = 2;\n", "", `require("./lib/" + process.platform);\n`), false],
  ["many destructurings and parameter lists", (mb) => rep(mb, "const [a, b] = x; ({ c } = y);\nfunction f(a, b = 1) { }\n", "", `require("./lib/" + process.platform);\n`), false],
  ["whitespace runs", (mb) => `require(${ws(mb)}"./lib/" +${ws(mb)}process.platform${ws(mb)});\n${ws(mb)}a${ws(mb)}.${ws(mb)}b${ws(mb)}(${ws(mb)})\n`, false],
  ["a long chain of members and of spaced members", (mb) => `${CPX}cp${".a".repeat(Math.floor(mb * 100_000))}.b("x");\n${"a. ".repeat(Math.floor(mb * 100_000))}b;\nrequire("./lib/" + process.platform);\n`, false],
  ["many quiet exec calls", (mb) => rep(mb, `cp.execSync("echo " + process.arch);\n`, CPX), false],
  ["many unclosed openers in a file naming child_process", (mb) => rep(mb, "f( [ {\n", CPX, `require("./lib/" + process.platform);\n`), true],
  ["many calls of a parameter beside child_process", (mb) => calls(mb, "", "go(1);\n", 0, 1) + "function go(cb) { cb(); }\n", true],
];
const controls = new Map<number, number>();
const controlMs = (mb: number): number => {
  if (!controls.has(mb)) controls.set(mb, all(control(mb)).ms);
  return controls.get(mb)!;
};
for (const [label, make, want] of perf) {
  test(`${label}: holds at both sizes and grows with the file`, () => {
    const body = make(SMALL);
    const small = median(() => all(body).ms);
    const large = all(make(LARGE));
    expect([all(body).all, large.all]).toEqual([want, want]);
    expect(grows(small, large.ms, LARGE / SMALL)).toBe(true);
    expect(large.ms).toBeLessThan(3 * controlMs(LARGE) + 300);
  }, 60_000);
}
// A name bound many times and called many times beside child_process: 0.125, 1 and 8 MB, each size compared with the next.
const a1: [string, (mb: number) => string][] = [
  ["as many bindings of one function name as calls of it", (mb) => calls(mb, "f=()=>1;\n", "f();\n", 1, 1)],
  ["many bindings of one function name and one call", (mb) => calls(mb, "f=()=>1;\n", "f();\n", 1, 0) + "f();\n"],
  ["one binding of a function name and many calls", (mb) => `${CPX}const f = () => 1;\n` + "f();\n".repeat(Math.floor((mb * 1_000_000) / 5))],
];
for (const [label, make] of a1) {
  test(`${label}: holds and grows with the file from 0.125 to 8 MB`, () => {
    const sizes = [0.125, 1, 8];
    const runs = sizes.map((mb, i) => (i === 0 ? { ms: median(() => all(make(mb)).ms), all: all(make(mb)).all } : all(make(mb))));
    expect(runs.map((r) => r.all)).toEqual([false, false, false]);
    for (let i = 1; i < sizes.length; i++) expect(grows(runs[i - 1]!.ms, runs[i]!.ms, sizes[i]! / sizes[i - 1]!)).toBe(true);
  }, 60_000);
}
test("many require calls hold from 0.25 to 8 MB and grow with the file", () => {
  const body = (mb: number) => rep(mb, `require("./lib/" + process.platform);\nrequire("./a.js");\n`);
  const small = median(() => all(body(0.25)).ms);
  const large = all(body(8));
  expect(large.all).toBe(false);
  expect(grows(small, large.ms, 32)).toBe(true);
}, 60_000);
test("a name left unresolved among many require calls widens at every size", () => {
  const runs = [0.25, 2].map((mb) => all(rep(mb, `require("./lib/" + process.platform);\n`, "", `require("./lib/" + x);\n`)));
  expect(runs.map((r) => r.all)).toEqual([true, true]);
}, 60_000);
// Main's own scans are not linear on this shape, so it is read small: the answer holds and the time stays bounded.
test("nested default-parameter functions beside child_process hold and stay bounded", () => {
  const runs = [0.02, 0.08].map((mb) => all(nest(mb, "function f(a = ", "1", ") { return a; }", CPX, `\nrequire("./lib/" + a);\n`)));
  expect(runs.map((r) => r.all)).toEqual([true, true]);
  expect(runs[1]!.ms).toBeLessThan(3000);
});
