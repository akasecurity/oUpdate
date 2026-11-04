import { test, expect } from "bun:test";
import { reviewUpdate } from "../src/review.ts";
import type { FileMap } from "../src/prepass.ts";

// Parity generator: one payload, placed in every map field, written in every form, read by every loader style, must reach the reviewer
// the same way in a small map and in a padded one. Every loader really runs the field it reads (the sources entry is stripped of its "../" prefix first). The cross product is fixed; the seed only picks the payload's words (WORD and NEW_WORD), so a run is
// deterministic and a failure names its case. Cases known to hide the payload are listed in KNOWN_HIDDEN: a case that starts showing the
// payload, or any other case that hides it, fails the run.
// Scope: every loader names ".map" as a constant, so the review shows each map in full; a loader that builds the name at run time keeps the map hashed and is not covered here.
const SEED = 116;
const rng = (a: number) => () => {
  a = (a + 0x6d2b79f5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const rand = rng(SEED);
const pick = <T,>(xs: T[]): T => xs[Math.floor(rand() * xs.length)]!;
const enc = (s: string) => new TextEncoder().encode(s);
const files = (o: Record<string, string>): FileMap => new Map(Object.entries(o).map(([k, v]) => [k, enc(v)]));

type Pos = "sources" | "names" | "sourcesContent" | "mappings";
type Form = "plain" | "template" | "concat" | "escape";
type Loader = "explicit" | "readdir" | "shebang-bin" | "bare-entry";
const POS: Pos[] = ["sources", "names", "sourcesContent", "mappings"];
const FORM: Form[] = ["plain", "template", "concat", "escape"];
const LOADER: Loader[] = ["explicit", "readdir", "shebang-bin", "bare-entry"];

// The token the reviewer must be shown: distinctive, and absent from the padding and from the clean side.
const WORD = pick(["zq", "kx", "vw", "jm"]) + Math.floor(rand() * 900 + 100);
// A carried row also adds a second word that only the new map holds, so a review that shows just the old side cannot pass it.
const NEW_WORD = "nw" + Math.floor(rand() * 900 + 100);
const CMD = "process.env." + WORD;
const payload = (form: Form): string => {
  switch (form) {
    case "plain": return `require('child_process').exec(${CMD})`;
    case "template": return `require('child_process').exec(\`echo \${${CMD}}\`)`;
    case "concat": return `require('child_' + 'process')['ex' + 'ec'](${CMD})`;
    case "escape": return payload("plain");
  }
};
// The escape form stores the command as \u escapes in the JSON text; it decodes to the same string the plain form holds.
const uEsc = (m: string) => [...m].map((c) => (c === "." ? c : "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"))).join("");
const jsonText = (form: Form, o: object) => {
  const s = JSON.stringify(o);
  return form === "escape" ? s.replace(/process\.env\.\w+/g, uEsc) : s;
};

const PAD = "CAAO,aAAP,OAAO,uBAAP;";
const mapOf = (seed: string, big: boolean, pos: Pos, pay: string | null, form: Form) => {
  const body = ("AAAA" + seed + PAD).repeat(big ? 250_000 : 20);
  const p = pay ?? "";
  return jsonText(form, {
    version: 3, file: "index.js",
    sources: [pos === "sources" && pay ? "../" + p : "../src/index.ts"],
    names: pos === "names" && pay ? [p.slice(0, 20), p.slice(20)] : [],
    sourcesContent: [pos === "sourcesContent" && pay ? p : "ok"],
    mappings: pos === "mappings" && pay ? p + ";" + body : body,
  });
};

const FIELD: Record<Pos, string> = { sources: "m.sources[0].slice(3)", names: "m.names.join('')", sourcesContent: "m['sources'+'Content'][0]", mappings: "m.mappings" };
const run = (f: string) => `require('vm').runInThisContext(${f});\n`;
const LOAD_EXPLICIT = (f: string) => `const m = JSON.parse(require('fs').readFileSync(__filename + '.map', 'utf8'));\n${run(f)}exports.v = 2;\n`;
const LOAD_READDIR = (expr: string, up: string) => `const fs = require('fs');\nconst f = fs.readdirSync(__dirname + '${up}').find((x) => x.endsWith('.map'));\nconst m = JSON.parse(fs.readFileSync(__dirname + '${up}/' + f, 'utf8'));\n${run(expr)}`;
const loaderFiles = (l: Loader, f: string): Record<string, string> => {
  switch (l) {
    case "explicit": return { "lib/index.js": LOAD_EXPLICIT(f) };
    case "readdir": return { "lib/index.js": LOAD_READDIR(f, "") + "exports.v = 2;\n" };
    case "shebang-bin": return { "bin/cli": "#!/usr/bin/env node\n" + LOAD_READDIR(f, "/../lib") };
    case "bare-entry": return { "lib/loader": LOAD_READDIR(f, ""), "bin/cli": "exports.v = 2;\n" };
  }
};
const PKG = (v: string, l: Loader) => JSON.stringify({ name: "lib", version: v, main: l === "bare-entry" ? "lib/loader" : "lib/index.js", bin: { cli: "bin/cli" } });

// Known base weaknesses: cases whose payload the reviewer does not see. Key is "<pos>/<form>/<loader>/<size>", and carried rows carry a "carried/" segment before the size: "<pos>/<form>/<loader>/carried/<size>".
const KNOWN_HIDDEN = new Set<string>([]);

// Carried cases: the old map already holds the payload at the same place and the new map adds NEW_WORD to it; the row passes only if NEW_WORD, which exists nowhere but the new map, reaches the reviewer.
type Row = { pos: Pos; form: Form; loader: Loader; carried: boolean };
const rows: Row[] = [];
for (const pos of POS) for (const form of FORM) for (const loader of LOADER) rows.push({ pos, form, loader, carried: false });
for (const pos of POS) rows.push({ pos, form: "plain", loader: "explicit", carried: true });

for (const big of [false, true]) for (const { pos, form, loader, carried } of rows) {
  const key = `${pos}/${form}/${loader}/${carried ? "carried/" : ""}${big ? "big" : "small"}`;
  test(`parity ${key}`, async () => {
    const pay = payload(form);
    const NEWCMD = "process.env." + NEW_WORD;
    const reviewed: string[] = [];
    await reviewUpdate({
      eco: "npm", name: "lib", from: "1.0.0", to: "1.0.1",
      registry: { latest: async () => undefined, publishedAt: async () => new Date("2020-01-01"), artifactUrls: async () => [] },
      advisories: { query: async () => [] },
      reviewer: { name: "fake", review: async (p) => (reviewed.push(p), "APPROVE\nno attack indicators found") },
      cooldownDays: 1, now: new Date("2026-10-21T00:00:00Z"), chunkChars: 60000,
      loadArtifacts: async () => ({
        old: files({ "package.json": PKG("a", loader), "lib/index.js": "exports.v = 1;\n", "lib/index.js.map": mapOf("a", big, pos, carried ? pay : null, form) }),
        new: files({ "package.json": PKG("b", loader), "lib/index.js": "exports.v = 2;\n", ...loaderFiles(loader, FIELD[pos]), "lib/index.js.map": mapOf("b", big, pos, carried ? pay + ";" + NEWCMD : pay, form) }),
      }),
    });
    // A small map is shown as a token diff that can split the command across tokens, so the look-up is for the distinctive word, as the file spells it or decoded.
    const all = reviewed.join("");
    const word = carried ? NEW_WORD : WORD;
    const shown = all.includes(word) || all.includes(uEsc(word));
    expect({ key, payloadShown: shown }).toEqual({ key, payloadShown: !KNOWN_HIDDEN.has(key) });
  }, 60000);
}
