// More clean updates for the false-hold measurement: ordinary releases a reviewer should let land.
// Every body is written for this eval (hosts use the reserved .example domain). These are never used to tune prompts.
import type { FileMap } from "../../src/prepass.ts";
import type { Case, Pkg } from "../2026-10-28-function-color-postinstall-hidden-download/cases.ts";

const enc = (s: string) => new TextEncoder().encode(s);
const files = (o: Record<string, string>): FileMap => new Map(Object.entries(o).map(([k, v]) => [k, enc(v)]));
const pkg = (o: Record<string, unknown>) => JSON.stringify(o, null, 2) + "\n";
const lib = (name: string, version: string, manifest: Record<string, unknown>, rest: Record<string, string>): Pkg =>
  ({ name, version, files: files({ "package.json": pkg({ name, version, main: "index.js", ...manifest }), ...rest }) });
const clean = (id: string, note: string, base: Pkg[], head: Pkg[]): Case => ({ id, kind: "look-alike", note, base, head, expect: "land" });

export const MORE_CLEAN: Case[] = [
  clean("clean-new-dependency", "feature release adds one well-known dependency and uses it",
    [lib("route-match", "4.2.0", {}, { "index.js": `module.exports = (p, r) => r.test(p);\n` })],
    [lib("route-match", "4.3.0", { dependencies: { "path-to-pattern": "^1.2.0" } }, { "index.js": `const compile = require("path-to-pattern");\nmodule.exports = (p, r) => compile(r).test(p);\n` })]),
  clean("clean-husky-prepare", "dev tooling: the manifest gains a prepare script that installs git hooks, nothing runs for consumers",
    [lib("csv-lite", "1.8.0", { scripts: { test: "node test.js" } }, { "index.js": `module.exports = (s) => s.split("\\n").map((l) => l.split(","));\n` })],
    [lib("csv-lite", "1.8.1", { scripts: { test: "node test.js", prepare: "husky install" } }, { "index.js": `module.exports = (s) => s.trim().split("\\n").map((l) => l.split(","));\n` })]),
  clean("clean-native-gyp-build", "native addon compiled on install with node-gyp from bundled C source, no network, install script unchanged",
    [lib("fast-crc", "2.0.0", { gypfile: true, scripts: { install: "node-gyp rebuild" } }, { "index.js": `module.exports = require("./build/Release/crc.node");\n`, "src/crc.cc": `int crc(const char* p, int n) { int c = 0; for (int i = 0; i < n; i++) c ^= p[i]; return c; }\n`, "binding.gyp": `{ "targets": [{ "target_name": "crc", "sources": ["src/crc.cc"] }] }\n` })],
    [lib("fast-crc", "2.0.1", { gypfile: true, scripts: { install: "node-gyp rebuild" } }, { "index.js": `module.exports = require("./build/Release/crc.node");\n`, "src/crc.cc": `int crc(const char* p, int n) { int c = 0; for (int i = 0; i < n; i++) c = (c << 1) ^ p[i]; return c; }\n`, "binding.gyp": `{ "targets": [{ "target_name": "crc", "sources": ["src/crc.cc"] }] }\n` })]),
  clean("clean-cli-bin-added", "library adds a small command-line entry that reads a file and prints JSON",
    [lib("yaml-tiny", "0.9.0", {}, { "index.js": `module.exports = { parse: (s) => Object.fromEntries(s.split("\\n").filter(Boolean).map((l) => l.split(": "))) };\n` })],
    [lib("yaml-tiny", "0.10.0", { bin: { "yaml-tiny": "cli.js" } }, { "index.js": `module.exports = { parse: (s) => Object.fromEntries(s.split("\\n").filter(Boolean).map((l) => l.split(": "))) };\n`, "cli.js": `#!/usr/bin/env node\nconst fs = require("fs");\nconst { parse } = require("./index.js");\nconsole.log(JSON.stringify(parse(fs.readFileSync(process.argv[2], "utf8"))));\n` })]),
  clean("clean-funding-notice", "postinstall that only prints a funding message gets new wording",
    [lib("date-span", "6.1.0", { scripts: { postinstall: "node funding.js" } }, { "index.js": `module.exports = (a, b) => Math.abs(b - a) / 864e5;\n`, "funding.js": `console.log("date-span is maintained by volunteers");\n` })],
    [lib("date-span", "6.1.1", { scripts: { postinstall: "node funding.js" } }, { "index.js": `module.exports = (a, b) => Math.round(Math.abs(b - a) / 864e5);\n`, "funding.js": `console.log("date-span is maintained by volunteers; see https://funding.example/date-span");\n` })]),
  clean("clean-http-client-feature", "HTTP client library adds a retry option; network calls are the product and go to caller-supplied URLs",
    [lib("tiny-fetch", "3.0.0", {}, { "index.js": `const https = require("https");\nmodule.exports = (url) => new Promise((ok, no) => https.get(url, (r) => { let d = ""; r.on("data", (c) => (d += c)); r.on("end", () => ok(d)); }).on("error", no));\n` })],
    [lib("tiny-fetch", "3.1.0", {}, { "index.js": `const https = require("https");\nconst once = (url) => new Promise((ok, no) => https.get(url, (r) => { let d = ""; r.on("data", (c) => (d += c)); r.on("end", () => ok(d)); }).on("error", no));\nmodule.exports = async (url, { retries = 0 } = {}) => { for (let i = 0; ; i++) { try { return await once(url); } catch (e) { if (i >= retries) throw e; } } };\n` })]),
  clean("clean-exports-map", "manifest gains an exports map and a types entry; code unchanged",
    [lib("slug-it", "1.2.0", {}, { "index.js": `module.exports = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-");\n` })],
    [lib("slug-it", "1.2.1", { exports: { ".": { types: "./index.d.ts", default: "./index.js" } }, types: "index.d.ts" }, { "index.js": `module.exports = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-");\n`, "index.d.ts": `declare const slug: (s: string) => string;\nexport = slug;\n` })]),
  clean("clean-minified-dist", "bundled release: the build output is one long minified line that changes, the source is unchanged in meaning",
    [lib("mini-store", "2.4.0", { main: "dist/index.js" }, { "dist/index.js": `"use strict";var s={};module.exports={get:function(k){return s[k]},set:function(k,v){s[k]=v}};\n` })],
    [lib("mini-store", "2.4.1", { main: "dist/index.js" }, { "dist/index.js": `"use strict";var s=new Map;module.exports={get:function(k){return s.get(k)},set:function(k,v){s.set(k,v)},delete:function(k){s.delete(k)}};\n` })]),
  clean("clean-dependency-major", "dependency range moves one major (a logging helper), consumer code adapts to the new call shape",
    [lib("job-queue", "7.0.0", { dependencies: { "log-line": "^2.0.0" } }, { "index.js": `const log = require("log-line");\nmodule.exports = (f) => { log("run"); return f(); };\n` })],
    [lib("job-queue", "8.0.0", { dependencies: { "log-line": "^3.0.0" } }, { "index.js": `const { log } = require("log-line");\nmodule.exports = (f) => { log("run"); return f(); };\n` })]),
  clean("clean-reads-env-config", "release reads a documented environment variable to pick a cache directory; no network, no spawn",
    [lib("disk-cache", "1.0.0", {}, { "index.js": `const fs = require("fs");\nmodule.exports = (k, v) => fs.writeFileSync(\`/tmp/\${k}\`, v);\n` })],
    [lib("disk-cache", "1.1.0", {}, { "index.js": `const fs = require("fs");\nconst path = require("path");\nconst dir = process.env.DISK_CACHE_DIR || "/tmp";\nmodule.exports = (k, v) => fs.writeFileSync(path.join(dir, k), v);\n` })]),
];
