#!/usr/bin/env bun
// Limit eval: how often does the model reviewer catch attacks disclosed after its training cutoff?
// A held-out case is an attack whose `disclosed` date is later than the reviewer's cutoff (models.json).
// The reviewer is stochastic, so each held-out attack runs N times and is reported as k/N with a Wilson 95%
// interval. The deterministic pre-pass runs once per case. Every run starts fresh and writes
// results/<version>.{json,md}; nothing is copied forward from an earlier release.
//   usage: bun eval/limits/run.ts --reviewer <spec.json> [--repeats N] [--out <dir>]
// <spec.json> is one reviewer spec (the same JSON the gate takes); keep it outside the repo.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { runGate } from "../../src/gate.ts";
import { makeReviewer, parseReviewerSpec } from "../../src/adapters/reviewer/spec.ts";
import { reviewUpdate, type Reviewer } from "../../src/review.ts";
import type { Registry } from "../../src/adapters/ecosystem/types.ts";
import type { Forge } from "../../src/adapters/forge/types.ts";
import { CASES as FC_CASES, type Case, type Pkg } from "../2026-10-28-function-color-postinstall-hidden-download/cases.ts";
import { readScope, scopeNote, wilson, type Scope } from "./stats.ts";
import { MORE_CLEAN } from "./clean-cases.ts";
import { HELDOUT } from "./heldout-cases.ts";
import { GAP } from "./gap-cases.ts";
import { evasionReport, writeEvasions } from "./evasions.ts";
import { INSTALL_ATTACKS, INSTALL_CLEAN } from "./install-cases.ts";

/** An attack with the date it became public. Add new write-ups here; never use them to tune prompts. */
export interface LimitCase extends Case {
  disclosed: string;
}
export const CASES: LimitCase[] = FC_CASES.filter((c) => c.kind === "attack").map((c) => ({ ...c, disclosed: "2026-10-22" })).concat(HELDOUT, INSTALL_ATTACKS, GAP.map((c) => ({ ...c, disclosed: "" })));
/** Attacks the pre-pass passes: only the reviewer can stop them, so they are reported apart from held-out and earlier attacks. */
const GAP_IDS = new Set(GAP.map((c) => c.id));

/** Clean cases (the control and the look-alikes the reviewer should let land): a hold here is a false hold. */
export const CLEAN: Case[] = [...FC_CASES.filter((c) => c.expect === "land"), ...MORE_CLEAN, ...INSTALL_CLEAN];

/** Releases held by policy are reported apart from false holds: an install script that downloads a binary (held with the reason in the hold text so the user can approve it), and the pre-pass install-script hard signal on package.json, which holds the release; the reviewer still runs and its verdict is the one counted. */
export const POLICY_HOLD = new Set(["lookalike-prebuilt-update", "clean-funding-notice"]);

const arg = (n: string) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : undefined; };
const here = dirname(new URL(import.meta.url).pathname);
const models = await Bun.file(join(here, "models.json")).json() as { reviewer: { label: string; cutoff: string }; repeats: number };
const version = (await Bun.file(join(here, "../../package.json")).json()).version as string;
const repeats = Number(arg("repeats") ?? models.repeats);
const specFile = arg("reviewer");
if (!specFile) { console.error("--reviewer <spec.json> is required"); process.exit(2); }
const reviewer: Reviewer = makeReviewer(parseReviewerSpec(await Bun.file(specFile).text()));

const registry: Registry = { latest: async () => undefined, publishedAt: async () => new Date("2026-01-01T00:00:00Z"), artifactUrls: async () => [] };
const lock = (pkgs: Pkg[]) => JSON.stringify({ lockfileVersion: 1, packages: Object.fromEntries(pkgs.map((p) => [p.name, [`${p.name}@${p.version}`, "", {}]])) });

/** One case as a pull request through the gate; true when the layer under test holds it. The reviewer layer needs the pre-pass output, so both run, but only the reviewer layer's own verdict is read: a pre-pass stop cannot stand in for the model. */
async function heldOnce(c: Case, layers: "prepass" | "reviewer"): Promise<{ stop: boolean; scope: Scope }> {
  const byKey = new Map([...c.base, ...c.head].map((p) => [`${p.name}@${p.version}`, p.files]));
  const files: Record<string, string> = { "b:bun.lock": lock(c.base), "h:bun.lock": lock(c.head) };
  const forge: Forge = {
    self: async () => "gate",
    openPulls: async () => [{ number: 1, headRef: "renovate/update", headSha: "h", baseSha: "b", author: "renovate[bot]", headRepo: "o/r", baseRepo: "o/r" }],
    readFile: async (_r, sha, path) => files[`${sha}:${path}`],
    changedFiles: async () => ["bun.lock"],
    statusOf: async () => undefined,
    setStatus: async () => {},
    ownComment: async () => undefined,
    upsertComment: async () => {},
  };
  const [pr] = await runGate({
    forge, repo: "o/r",
    review: (ch) => reviewUpdate({
      eco: ch.eco, name: ch.name, from: ch.from ?? "", to: ch.to, registry,
      advisories: { query: async () => [] }, reviewer: layers === "reviewer" ? reviewer : undefined,
      cooldownDays: 0, now: new Date("2026-10-28T12:00:00Z"),
      loadArtifacts: async () => ({ old: ch.from ? byKey.get(`${ch.name}@${ch.from}`)! : new Map(), new: byKey.get(`${ch.name}@${ch.to}`)! }),
      only: layers === "reviewer" ? ["prepass", "reviewer"] : ["prepass"],
    }),
  });
  const ls = pr!.results.flatMap((r) => r.layers.filter((l) => l.layer === layers));
  if (!ls.length) throw new Error(`${layers} layer produced no result on ${c.id}`);
  const bad = ls.find((l) => l.verdict === "error");
  if (bad) throw new Error(`${layers} layer error on ${c.id}: ${bad.detail}`);
  if (process.env.LIMITS_VERBOSE) for (const l of ls) if (l.verdict === "stop") console.error(`[${c.id}] ${l.layer}: ${String(l.detail).slice(0, 1500)}`);
  const stop = ls.filter((l) => l.verdict === "stop");
  return { stop: stop.length > 0, scope: readScope(stop.map((l) => String(l.detail)).join(" ")) };
}

/** The router answers 502 now and then; a reviewer error is retried before it aborts the run, so one blip does not cost the whole run. */
async function held(c: Case, layers: "prepass" | "reviewer"): Promise<{ stop: boolean; scope: Scope }> {
  for (let i = 1; ; i++) {
    try { return await heldOnce(c, layers); }
    catch (e) { if (i >= 4) throw e; console.error(`retry ${i} on ${c.id}: ${String(e).slice(0, 200)}`); await Bun.sleep(30_000 * i); }
  }
}

const cutoff = models.reviewer.cutoff;
const rows = [];
for (const c of CASES.filter((x) => !arg("only") || arg("only")!.split(",").includes(x.id))) {
  const heldOut = c.disclosed > cutoff;
  const prepass = (await held(c, "prepass")).stop;
  let k = 0;
  const reads = { full: 0, priority: 0, signal: 0, ranked: 0, none: 0 };
  const started = Date.now();
  for (let i = 0; i < repeats; i++) { const h = await held(c, "reviewer"); if (h.stop) k++; reads[h.scope]++; }
  const secPerReview = Math.round((Date.now() - started) / repeats / 100) / 10;
  rows.push({ id: c.id, gap: GAP_IDS.has(c.id), disclosed: c.disclosed, held_out: heldOut, prepass_blocked: prepass, k, n: repeats, reads, sec_per_review: secPerReview, ...wilson(k, repeats) });
}
const cleanRows = [];
for (const c of CLEAN.filter((x) => !arg("only") || arg("only")!.split(",").includes(x.id))) {
  const prepass = (await held(c, "prepass")).stop;
  let k = 0;
  const reads = { full: 0, priority: 0, signal: 0, ranked: 0, none: 0 };
  const started = Date.now();
  for (let i = 0; i < repeats; i++) { const h = await held(c, "reviewer"); if (h.stop) k++; reads[h.scope]++; }
  cleanRows.push({ id: c.id, policy_hold: POLICY_HOLD.has(c.id), prepass_blocked: prepass, k, n: repeats, reads, sec_per_review: Math.round((Date.now() - started) / repeats / 100) / 10, ...wilson(k, repeats) });
}
const sum = (rs: typeof rows) => { const k = rs.reduce((a, r) => a + r.k, 0), n = rs.reduce((a, r) => a + r.n, 0); return { k, n, ...wilson(k, n) }; };
const tot = (rs: typeof cleanRows) => { const k = rs.reduce((a, r) => a + r.k, 0), n = rs.reduce((a, r) => a + r.n, 0); return { k, n, ...wilson(k, n) }; };
const cleanTotal = tot(cleanRows.filter((r) => !r.policy_hold));
const policyTotal = tot(cleanRows.filter((r) => r.policy_hold));
const summary = { tool_version: version, reviewer: models.reviewer.label, cutoff, repeats, held_out: sum(rows.filter((r) => r.held_out)), earlier: sum(rows.filter((r) => !r.held_out && !r.gap)), gap: sum(rows.filter((r) => r.gap)), false_holds: cleanTotal, policy_holds: policyTotal };

const out = arg("out") ?? join(here, "results");
mkdirSync(out, { recursive: true });
writeFileSync(join(out, `${version}.json`), JSON.stringify({ summary, rows, clean_rows: cleanRows }, null, 2) + "\n");
const evasions = evasionReport(await writeEvasions(version, out));
const pct = (x: number) => `${(x * 100).toFixed(0)}%`;
const line = (n: string, s: { k: number; n: number; lo: number; hi: number }) => `${n}: ${s.k}/${s.n} runs flagged, ${pct(s.k / (s.n || 1))} (95% interval ${pct(s.lo)}-${pct(s.hi)})`;
const md = [
  `oupdate ${version}, ${models.reviewer.label}, training cutoff ${cutoff}, ${repeats} runs per case`, "",
  "| case | disclosed | held-out | pre-pass | reviewer k/N | 95% interval | read | s/review |", "|---|---|---|---|---|---|---|---|",
  ...rows.map((r) => `| ${r.id} | ${r.disclosed} | ${r.held_out ? "yes" : "no"} | ${r.prepass_blocked ? "blocked" : "passed"} | ${r.k}/${r.n} | ${pct(r.lo)}-${pct(r.hi)} | ${scopeNote(r.reads)} | ${r.sec_per_review} |`),
  "", `layers: pre-pass alone blocks ${rows.filter((r) => r.prepass_blocked).length} of ${rows.length} attacks; the reviewer flags ${rows.filter((r) => !r.prepass_blocked && r.k > 0).length} more that the pre-pass passes; ${rows.filter((r) => !r.prepass_blocked && r.k === 0).length} are missed by both`,
  "", ...(summary.held_out.n ? [line("held-out attacks", summary.held_out)] : []), ...(summary.earlier.n ? [line("earlier attacks", summary.earlier)] : []), ...(summary.gap.n ? [line("attacks the pre-pass passes (reviewer only)", summary.gap)] : []), `evasions (no model, own file ${version}-evasions.json): ${evasions.line}`, "",
  ...(cleanRows.length ? ["| clean case | policy hold | pre-pass | false holds k/N | 95% interval | read | s/review |", "|---|---|---|---|---|---|---|"] : []),
  ...cleanRows.map((r) => `| ${r.id} | ${r.policy_hold ? "yes" : "no"} | ${r.prepass_blocked ? "blocked" : "passed"} | ${r.k}/${r.n} | ${pct(r.lo)}-${pct(r.hi)} | ${scopeNote(r.reads)} | ${r.sec_per_review} |`),
  ...(cleanRows.length ? ["", line("false holds (reviewer, policy holds excluded)", summary.false_holds), line("policy holds (install-script signal or binary download)", summary.policy_holds)] : []), "",
].join("\n");
writeFileSync(join(out, `${version}.md`), md);
console.log(md);
if (evasions.failed) process.exit(1);
