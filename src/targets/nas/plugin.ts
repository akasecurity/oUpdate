// unraid-plugin over the broker-script reach (spec §4). It is the port of the script's plugin section, plus the review
// the script never did. plugin.check lists each installed plugin with its candidate version and a private copy on the
// NAS. For each newer plugin (skipping unRAIDServer*, as the script skips it) it reads the old and new .plg through
// plugin.file, checks each one's bytes against its PLG row's sha, and holds the plugin on the .plg rules (a payload with
// no hash, an inline fetch, a second install; the broker applies the same rules with entity expansion and is
// authoritative). It then sends an ordered line diff with context and every Run and INLINE body of both files to both
// models; a change too large for that is held. Only with `apply: true` on a real run does it ask
// plugin.update, one plugin per request.

import { createHash } from "node:crypto";
import { parseVerdict } from "../../review.ts";
import type { LegResult, ParityFacts, PluginLeg } from "../model.ts";
import type { OpenNas } from "../reach.ts";
import type { LegContext } from "../run.ts";
import { decodePluginCheck, decodePluginFile, type PluginRow } from "./answer.ts";
import { brokerRead, brokerWrite, evidenceSha, writeSummary, writeLine } from "./broker.ts";
import { plgPrompt } from "./prompt.ts";
import { reviewTwice, type NasReviewers } from "./review.ts";
import { isOsPlugin } from "./verbs.ts";

export interface PlgFindings {
  hold: string[];
  flags: string[];
  payloads: string[];
}

/** CRB-b128 §2.4's inline-fetch words, matched case-insensitively on the unexpanded text. */
const FETCH = ["://", "wget", "curl", "fetch", "aria2c", "nc ", "ncat", "socat", "/dev/tcp", "python", "perl", "php", "plugin install", "plugin update"];

export function plgRules(text: string): PlgFindings {
  const out: PlgFindings = { hold: [], flags: [], payloads: [] };
  for (const m of text.matchAll(/<FILE\b([^>]*)>([\s\S]*?)<\/FILE>/g)) {
    const attrs = m[1]!;
    const body = m[2]!;
    const name = /\bName="([^"]*)"/.exec(attrs)?.[1] ?? "?";
    const url = /<URL>([\s\S]*?)<\/URL>/.exec(body)?.[1]?.trim();
    const sha = /<SHA256>\s*([^<\s]+)\s*<\/SHA256>/.exec(body)?.[1];
    const md5 = /<MD5>\s*([^<\s]+)\s*<\/MD5>/.exec(body)?.[1];
    if (url) {
      out.payloads.push(`${name}: ${url} ${sha ? `sha256 ${sha}` : md5 ? `md5 ${md5}` : "no hash"}`);
      if (!sha && !md5) out.hold.push(`payload without a hash: ${url}`);
      else if (!sha) out.flags.push(`MD5 only: ${url}`);
    }
    const run = /\bRun="([^"]*)"/.exec(attrs)?.[1] ?? "";
    const inline = /<INLINE>([\s\S]*?)<\/INLINE>/.exec(body)?.[1] ?? "";
    for (const [what, t] of [["Run", run], ["INLINE", inline]] as const) {
      const w = FETCH.find((f) => t.toLowerCase().includes(f));
      if (w) out.hold.push(`${name} ${what} contains ${JSON.stringify(w)}`);
    }
  }
  return out;
}

const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const dec = new TextDecoder("utf-8", { fatal: false });

async function plgFile(nas: OpenNas, p: PluginRow, which: "old" | "new"): Promise<{ ok: true; text: string } | { ok: false; why: string }> {
  const r = await brokerRead(nas.broker, nas.exec, nas.session, "plugin.file", { plugin: p.name, which, copy: p.copy });
  if (!r.ok) return r;
  const d = decodePluginFile(r.rows);
  if (!d.ok) return d;
  if (sha256(d.value) !== (which === "old" ? p.installedSha : p.copySha)) return { ok: false, why: `sha256 of the ${which} .plg does not match its PLG row` };
  return { ok: true, text: dec.decode(d.value) };
}

/** Past this many cells the middle of a diff is shown whole (every old line removed, every new line added): still in order. */
const LCS_CELLS = 4_000_000;
/** A .plg change bigger than this (diff plus both files' script bodies) is held, not reviewed. */
export const PLG_REVIEW_CAP = 64 * 1024;

/**
 * An order-sensitive line diff with `context` lines around each change, in unified form: `@@ old line N, new line M @@`,
 * then " " context, "-" removed and "+" added lines. A moved line or a duplicate added or removed shows. Empty when equal.
 */
export function orderedDiff(oldText: string, newText: string, context = 3): string[] {
  const a = oldText.split("\n");
  const b = newText.split("\n");
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  const am = a.slice(p, a.length - s);
  const bm = b.slice(p, b.length - s);
  const ops: { k: " " | "-" | "+"; l: string }[] = a.slice(0, p).map((l) => ({ k: " " as const, l }));
  if (am.length * bm.length > LCS_CELLS) ops.push(...am.map((l) => ({ k: "-" as const, l })), ...bm.map((l) => ({ k: "+" as const, l })));
  else {
    // lcs[i][j]: the longest common subsequence of am[i..] and bm[j..].
    const w = bm.length + 1;
    const lcs = new Uint32Array((am.length + 1) * w);
    for (let i = am.length - 1; i >= 0; i--)
      for (let j = bm.length - 1; j >= 0; j--) lcs[i * w + j] = am[i] === bm[j] ? lcs[(i + 1) * w + j + 1]! + 1 : Math.max(lcs[(i + 1) * w + j]!, lcs[i * w + j + 1]!);
    let i = 0;
    let j = 0;
    while (i < am.length || j < bm.length) {
      if (i < am.length && j < bm.length && am[i] === bm[j]) ops.push({ k: " ", l: am[i++]! }), j++;
      else if (i < am.length && (j === bm.length || lcs[(i + 1) * w + j]! >= lcs[i * w + j + 1]!)) ops.push({ k: "-", l: am[i++]! });
      else ops.push({ k: "+", l: bm[j++]! });
    }
  }
  ops.push(...a.slice(a.length - s).map((l) => ({ k: " " as const, l })));
  const out: string[] = [];
  let last = -1;
  let ol = 1;
  let nl = 1;
  const at: { o: number; n: number }[] = ops.map((op) => {
    const here = { o: ol, n: nl };
    if (op.k !== "+") ol++;
    if (op.k !== "-") nl++;
    return here;
  });
  for (let x = 0; x < ops.length; x++) {
    if (ops[x]!.k === " ") continue;
    const from = Math.max(x - context, last + 1);
    if (from > last + 1 || last < 0) out.push(`@@ old line ${at[from]!.o}, new line ${at[from]!.n} @@`);
    let y = from;
    for (; y < ops.length && (y <= x || (y <= x + context && ops[y]!.k === " ")); y++) out.push(`${ops[y]!.k}${ops[y]!.l}`);
    // Extend through further changes within reach of this hunk's trailing context.
    while (y < ops.length && ops.slice(y, y + context + 1).some((o) => o.k !== " ")) {
      const nx = ops.findIndex((o, k) => k >= y && o.k !== " ");
      for (; y <= nx; y++) out.push(`${ops[y]!.k}${ops[y]!.l}`);
      for (; y < ops.length && y <= nx + context && ops[y]!.k === " "; y++) out.push(`${ops[y]!.k}${ops[y]!.l}`);
    }
    last = y - 1;
    x = last;
  }
  return out;
}

/** Every FILE's Run attribute and INLINE body in a .plg, whole, labeled by the FILE's Name. */
export function plgBodies(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/<FILE\b([^>]*)>([\s\S]*?)<\/FILE>/g)) {
    const name = /\bName="([^"]*)"/.exec(m[1]!)?.[1] ?? "?";
    const run = /\bRun="([^"]*)"/.exec(m[1]!)?.[1];
    const inline = /<INLINE>([\s\S]*?)<\/INLINE>/.exec(m[2]!)?.[1];
    if (run !== undefined) out.push(`${name} Run: ${run}`);
    if (inline !== undefined) out.push(`${name} INLINE:${inline.replace(/\n$/, "")}`);
  }
  return out;
}

/** Why the plugin is held, or undefined when both models approved it. */
async function review(nas: OpenNas, p: PluginRow, reviewers: NasReviewers, lines: string[]): Promise<string | undefined> {
  const old = await plgFile(nas, p, "old");
  if (!old.ok) return old.why;
  const now = await plgFile(nas, p, "new");
  if (!now.ok) return now.why;
  const rules = plgRules(now.text);
  if (rules.hold.length) return rules.hold.join("; ");
  const diff = orderedDiff(old.text, now.text);
  const oldBodies = plgBodies(old.text);
  const newBodies = plgBodies(now.text);
  const size = [...diff, ...oldBodies, ...newBodies].reduce((n, l) => n + l.length + 1, 0);
  if (size > PLG_REVIEW_CAP) return `the .plg change is too large to review (${size} bytes of diff and script bodies, cap ${PLG_REVIEW_CAP})`;
  const v = await reviewTwice(reviewers, plgPrompt({ name: p.name, from: p.installed, to: p.candidate, payloads: rules.payloads, flags: rules.flags, diff, oldBodies, newBodies }), (t) => parseVerdict(t) === "APPROVE");
  lines.push(...v.lines);
  if (v.approved) return undefined;
  return v.router !== "APPROVE" ? `review: router ${v.router}` : `review: on-prem ${v.onprem}`;
}

export async function pluginLeg(leg: PluginLeg, ctx: LegContext, nas: OpenNas, reviewers: NasReviewers): Promise<LegResult> {
  const lines: string[] = [];
  const r = await brokerRead(nas.broker, nas.exec, nas.session, "plugin.check");
  if (!r.ok) return { lines, summary: `not checked — ${r.why}`, trouble: true };
  const pc = decodePluginCheck(r.rows);
  if (!pc.ok) return { lines, summary: `not checked — ${pc.why}`, trouble: true };
  if (pc.value.skipped) lines.push(`${pc.value.skipped} .plg files with a name outside the plugin rule were skipped on the NAS`);
  const newer: PluginRow[] = [];
  for (const p of pc.value.plugins) {
    if (isOsPlugin(p.name)) continue;
    if (!p.installed || !p.candidate) lines.push(`  ${p.name}: could not read version — skipping`);
    // Date-formatted versions (YYYY.MM.DD): the script's lexicographic comparison.
    else if (p.candidate > p.installed) {
      lines.push(`  ${p.name}: ${p.installed} -> ${p.candidate}`);
      newer.push(p);
    } else lines.push(`  ${p.name}: up to date (${p.installed})`);
  }
  const parity: ParityFacts = { plugins: newer.map((p) => `${p.name} ${p.installed} -> ${p.candidate}`).sort() };
  if (!newer.length) return { lines, summary: "nothing to update", trouble: false, parity };

  const cleared: PluginRow[] = [];
  const blocked: string[] = [];
  for (const p of newer) {
    const why = await review(nas, p, reviewers, lines);
    if (why) blocked.push(`${p.name}: ${why}`);
    else cleared.push(p);
  }
  const parts: string[] = [];
  let trouble = blocked.length > 0;
  if (cleared.length && (!leg.apply || ctx.dryRun)) parts.push(`would update: ${cleared.map((p) => p.name).join(" ")}`);
  else if (cleared.length) {
    const updated: string[] = [];
    // One plugin.update per plugin, its verdict naming only that plugin and an empty hold list (open question O-5,
    // confirmed by the design's rev 3e §4.8). An update that is not ok stops the rest: no other write this run.
    for (const [i, p] of cleared.entries()) {
      const verdict = { items: { [p.name]: "APPROVE" as const }, reviewers: { router: reviewers.router!.name, onprem: reviewers.onprem!.name }, evidence_sha256: evidenceSha(nas.session) };
      const w = await brokerWrite(nas.broker, nas.exec, nas.session, "plugin.update", verdict, []);
      lines.push(writeLine(w));
      if (w.outcome === "ok") {
        updated.push(p.name);
        continue;
      }
      trouble = true;
      parts.push(`${p.name} ${writeSummary(w)}`);
      for (const q of cleared.slice(i + 1)) blocked.push(`${q.name}: not tried after a failed update`);
      break;
    }
    if (updated.length) parts.unshift(`updated: ${updated.join(" ")}`);
  }
  if (blocked.length) parts.push(`blocked (${blocked.join("; ")})`);
  return { lines, summary: parts.join(" · "), trouble, parity };
}
