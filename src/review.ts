// Reviews one version bump through every layer and records a verdict per layer:
// cooldown -> advisory -> prepass -> reviewer -> gate. Any stop or error holds
// the update. Later layers still run after an earlier stop, so a replay shows
// what each layer would have done on its own.

import { cooldownVerdict } from "./cooldown.ts";
import { prepass, type Ecosystem, type FileMap, type PrepassResult } from "./prepass.ts";
import type { Registry } from "./adapters/ecosystem/types.ts";
import type { Advisory, AdvisoryFeed } from "./adapters/advisory/osv.ts";
import { newFindings, type Finding } from "./adapters/scanner/types.ts";
import { renderLineDiff } from "./linediff.ts";

export type LayerName = "cooldown" | "advisory" | "prepass" | "scan" | "reviewer" | "gate";
export const LAYERS: LayerName[] = ["cooldown", "advisory", "prepass", "scan", "reviewer", "gate"];

export interface LayerVerdict {
  layer: LayerName;
  verdict: "pass" | "stop" | "error" | "skipped";
  detail: string;
}

export interface Reviewer {
  name: string;
  review(prompt: string): Promise<string>;
}

/** A static rule scanner (e.g. GuardDog in a sandbox) run on each release; only findings new in the new release count. */
export interface Scanner {
  name: string;
  scan(eco: Ecosystem, files: FileMap): Promise<Finding[]>;
}

export interface Gate {
  name: string;
  run(): Promise<{ ok: boolean; detail: string }>;
}

export interface ReviewInput {
  eco: Ecosystem;
  name: string;
  from: string;
  to: string;
  registry: Registry;
  advisories: AdvisoryFeed;
  reviewer: Reviewer | undefined;
  gate?: Gate;
  scanner?: Scanner;
  cooldownDays: number;
  now: Date;
  advisoryFix?: boolean;
  loadArtifacts: () => Promise<{ old: FileMap; new: FileMap }>;
  only?: LayerName[];
  chunkChars?: number;
  /** Diffs needing more model calls than this are held for a human (default 12). */
  maxParts?: number;
}

export interface ReviewResult {
  eco: Ecosystem;
  name: string;
  from: string;
  to: string;
  decision: "land" | "hold";
  layers: LayerVerdict[];
  /** Ids of known-malicious advisories on the target version: the release is malware, not merely vulnerable. */
  malicious?: string[];
  prepass?: PrepassResult;
  reviewerText?: string[];
}

const OSV_ECOSYSTEM: Record<Ecosystem, string> = { npm: "npm", pypi: "PyPI" };

export const VERDICT_CONTRACT = `Output format: line 1 is parsed literally, and anything unexpected there is read as FLAG.
  Line 1: the single word APPROVE or FLAG, alone. No reason, no punctuation, no package name on that line.
  Line 2 onward: your reasoning.
In an APPROVE, do not write a "Verdict:" line, the uppercase words FLAG/HOLD/REJECT/DENY/BLOCK, or a recommendation to flag, hold, reject, block or not land the update; each is read as a second, contradicting verdict. Write "no attack indicators found" instead. Never use the word "block" or "blocks" in an APPROVE; call a code block, or a Ruby install or service block, a "stanza", "section" or "clause".`;

// A contradiction is a verdict, not a word: "try block", "feature flag" and "holds a reference" are plain English (Opus calibration 10-21).
const CONTRADICTION = [
  /verdict\s*:/i,
  /\b(FLAG|FLAGGED|HOLD|REJECT|DENY|BLOCK)\b/,
  /\b(i|we)\s+(would|should|must|recommend|suggest)?\s*(to\s+)?(flag|hold|reject|deny|block)\b/i,
  /\b(should|must|needs? to)\s+(be\s+)?(flagged|held|rejected|denied|blocked)\b/i,
  /\b(do not|don't|should not|must not)\s+(land|merge|approve|install|ship)\b/i,
];

export function parseVerdict(text: string): "APPROVE" | "FLAG" {
  const [first = "", ...rest] = text.split("\n");
  const head = first.trim().replace(/\.$/, "");
  if (head !== "APPROVE") return "FLAG";
  const body = rest.join("\n");
  if (CONTRADICTION.some((re) => re.test(body))) return "FLAG";
  return "APPROVE";
}

const dec = new TextDecoder("utf-8", { fatal: false });

function isBinary(b: Uint8Array): boolean {
  const n = Math.min(b.length, 8000);
  for (let i = 0; i < n; i++) if (b[i] === 0) return true;
  return false;
}

function fileDiff(path: string, before: Uint8Array | undefined, after: Uint8Array | undefined): string[] {
  const state = !before ? "added" : !after ? "removed" : "changed";
  const head = `=== ${path} (${state}) ===\n`;
  if ((after && isBinary(after)) || (before && isBinary(before))) {
    const h = after ? new Bun.CryptoHasher("sha256").update(after).digest("hex") : "-";
    return [`${head}[binary, ${after?.length ?? 0} bytes, sha256 ${h}]\n`];
  }
  return [head, renderLineDiff(before && dec.decode(before), after && dec.decode(after))];
}

// Files that never execute: images, fonts, source maps, type declarations, prose.
// Everything else, including unknown extensions, stays in the diff.
const INERT = /(\.(png|jpe?g|gif|webp|ico|svg|bmp|woff2?|ttf|otf|eot|map|d\.ts|d\.mts|d\.cts|md|markdown|rst)$|(^|\/)(LICEN[CS]E|COPYING|NOTICE|AUTHORS|CHANGELOG|HISTORY)(\.[a-z]+)?$)/i;

// Splits the diff into prompt-sized chunks on line boundaries. Only inert files
// (INERT) are left out; long lines are sliced, not dropped. `only` as a set keeps those
// paths in sorted order; as an array it keeps them in the array's order (a ranking).
export function chunkDiff(oldFiles: FileMap, newFiles: FileMap, cap: number, only?: Set<string> | string[]): string[] {
  const paths = Array.isArray(only) ? only : [...new Set([...oldFiles.keys(), ...newFiles.keys()])].filter((p) => !only || only.has(p)).sort();
  const chunks: string[] = [];
  let cur = "";
  const push = (piece: string) => {
    // A single line longer than the cap (minified or encoded payloads) is sliced.
    for (let i = 0; i < piece.length; i += cap) {
      const part = piece.slice(i, i + cap);
      if (cur.length + part.length > cap && cur.length > 0) {
        chunks.push(cur);
        cur = "";
      }
      cur += part;
    }
  };
  for (const p of paths) {
    const a = oldFiles.get(p);
    const b = newFiles.get(p);
    if (INERT.test(p)) continue;
    if (a && b && a.length === b.length && a.every((x, i) => x === b[i])) continue;
    for (const piece of fileDiff(p, a, b)) push(piece);
  }
  if (cur) chunks.push(cur);
  return chunks;
}

// Manifests and the files an install or interpreter start runs.
const PRIORITY_NAME = /(^|\/)(package\.json|setup\.py|setup\.cfg|pyproject\.toml|MANIFEST\.in|sitecustomize\.py|usercustomize\.py|[^/]+\.pth)$/;
const INSTALL_NAME = /(^|\/)(setup\.py|sitecustomize\.py|usercustomize\.py|[^/]+\.pth)$/;

// The files an attack needs, for a diff over budget: any pre-pass signal, new files, manifests and
// install or startup files. What is left is changed files with no signal.
/**
 * The files a release adds or changes, and the old copies of the changed paths. The scanner sees only these: GuardDog
 * 3.2.0 stops each rule after max_hits matches per package in sorted walk order, so unchanged code that sorts first
 * (litellm/ before litellm-1.107.0.data/) can spend a rule's budget and hide a new file.
 */
export function changedFiles(old: FileMap, now: FileMap): { old: FileMap; new: FileMap } {
  const o: FileMap = new Map();
  const n: FileMap = new Map();
  for (const [p, bytes] of now) {
    const prev = old.get(p);
    if (prev && Buffer.compare(Buffer.from(prev), Buffer.from(bytes)) === 0) continue;
    n.set(p, bytes);
    if (prev) o.set(p, prev);
  }
  return { old: o, new: n };
}

/** Files with a pre-pass or scanner signal, plus manifests and install or startup files: the last tier before a human. */
export function signalPaths(pre: PrepassResult): Set<string> {
  const out = new Set<string>([...pre.hard, ...pre.soft].map((s) => s.path));
  for (const p of [...pre.added, ...pre.changed]) if (PRIORITY_NAME.test(p)) out.add(p);
  return out;
}

export function priorityPaths(pre: PrepassResult): Set<string> {
  const out = new Set<string>([...pre.hard, ...pre.soft].map((s) => s.path));
  for (const p of pre.added) out.add(p);
  for (const p of pre.changed) if (PRIORITY_NAME.test(p)) out.add(p);
  return out;
}

/**
 * The priority files (signal files plus new files) in review order, for a diff whose signal files alone are over
 * budget: hard pre-pass signals, scanner hits, install or startup files, manifests, new files, then changed files
 * with a soft signal. Ties go to the file with more signals, then by path.
 */
export function rankPriorityPaths(pre: PrepassResult, scanHits: Set<string> = new Set()): string[] {
  const hard = new Set(pre.hard.map((s) => s.path));
  const added = new Set(pre.added);
  const count = new Map<string, number>();
  for (const s of [...pre.hard, ...pre.soft]) count.set(s.path, (count.get(s.path) ?? 0) + 1);
  const tier = (p: string) => (hard.has(p) ? 0 : scanHits.has(p) ? 1 : INSTALL_NAME.test(p) ? 2 : PRIORITY_NAME.test(p) ? 3 : added.has(p) ? 4 : 5);
  return [...priorityPaths(pre)].sort((a, b) => tier(a) - tier(b) || (count.get(b) ?? 0) - (count.get(a) ?? 0) || (a < b ? -1 : a > b ? 1 : 0));
}

type Scope = "all" | "priority" | "signal" | "ranked";

const SCOPE_NOTE: Record<Scope, string> = {
  all: "",
  priority: "\nThe full diff is over budget, so these parts hold priority files only: files with a pre-pass signal, new files, manifests and install or startup files. Changed files with no signal are left out.",
  signal: "\nThe full diff is over budget even as priority files, so these parts hold signal files only: files with a pre-pass or scanner signal, manifests and install or startup files. Everything else is left out.",
  ranked: "\nThe full diff is over budget even as signal files, so these parts hold the top-ranked priority files only: hard pre-pass signals first, then scanner hits, install or startup files, manifests, new files and changed files with a soft signal. Everything else is left out.",
};

function reviewPrompt(input: ReviewInput, pre: PrepassResult, chunk: string, i: number, n: number, scope: Scope): string {
  const signals = [...pre.hard.map((s) => `HARD ${s.kind} ${s.path}: ${s.detail}`), ...pre.soft.map((s) => `soft ${s.kind} ${s.path}: ${s.detail}`)];
  return `You are reviewing a dependency update for supply-chain attacks before it is installed.
Package: ${input.eco} ${input.name} ${input.from} -> ${input.to}
The diff below is between the two published release artifacts (what installs), part ${i + 1} of ${n}.${SCOPE_NOTE[scope]}${n > 1 ? `\nEach part goes to a separate review call, and a FLAG on any part holds the update. Judge what this part shows: FLAG for a concrete attack indicator in it. Not seeing the other parts, or the contents of a dependency, is not by itself a reason to FLAG.` : ""}
Diff format: \`@@ -a +b @@\` gives the old and new line numbers of a change; \`-\` lines are removed, \`+\` lines added; a \`~\` line is a changed minified line, shown as its [-removed-] and {+added+} tokens with some unchanged text around them (… marks text left out). Unchanged lines are not shown.
Look for: code that runs at install or interpreter start, credential or token reads, network calls to new hosts, downloads of further code, obfuscated or encoded payloads, and changes unrelated to the stated purpose of a release.
Deterministic pre-pass signals (pointers, not conclusions):
${signals.length ? signals.join("\n") : "(none)"}

${VERDICT_CONTRACT}

--- diff part ${i + 1}/${n} ---
${chunk}`;
}

export async function reviewUpdate(input: ReviewInput): Promise<ReviewResult> {
  const on = (l: LayerName) => !input.only || input.only.includes(l);
  const layers: LayerVerdict[] = [];
  const result: ReviewResult = { eco: input.eco, name: input.name, from: input.from, to: input.to, decision: "hold", layers };

  if (on("cooldown")) {
    try {
      const v = cooldownVerdict({ publishedAt: await input.registry.publishedAt(input.name, input.to), now: input.now, days: input.cooldownDays, advisoryFix: !!input.advisoryFix });
      layers.push({ layer: "cooldown", verdict: v.eligible ? "pass" : "stop", detail: v.reason });
    } catch (e) {
      layers.push({ layer: "cooldown", verdict: "error", detail: String(e) });
    }
  } else layers.push({ layer: "cooldown", verdict: "skipped", detail: "not selected" });

  if (on("advisory")) {
    try {
      // Malicious entries always stop. A vulnerability stops only when this update brings it in:
      // one the old version already has is no reason to keep the old version.
      const eco = OSV_ECOSYSTEM[input.eco];
      const all = await input.advisories.query([{ ecosystem: eco, name: input.name, version: input.to }, ...(input.from ? [{ ecosystem: eco, name: input.name, version: input.from }] : [])]);
      const onTo = all.filter((a) => a.pkg.version === input.to);
      const onFrom = new Set(all.filter((a) => input.from && a.pkg.version === input.from && !a.malicious).map((a) => a.id));
      const mal = onTo.filter((a) => a.malicious);
      const vulns = onTo.filter((a) => !a.malicious);
      const introduced = vulns.filter((a) => !onFrom.has(a.id));
      const carried = vulns.filter((a) => onFrom.has(a.id));
      const fixes = [...onFrom].filter((id) => !vulns.some((a) => a.id === id));
      const fmt = (as: Advisory[]) => as.map((a) => `${a.id} (${a.severity}, published ${a.published ?? "?"}): ${a.summary}`).join("; ");
      const parts = [
        mal.length ? `malicious: ${fmt(mal)}` : "",
        introduced.length ? `introduces: ${fmt(introduced)}` : "",
        carried.length ? `already in ${input.from}: ${carried.map((a) => a.id).join(", ")}` : "",
        fixes.length ? `fixes: ${fixes.join(", ")}` : "",
      ].filter(Boolean);
      if (mal.length) result.malicious = mal.map((a) => a.id);
      layers.push({ layer: "advisory", verdict: mal.length || introduced.length ? "stop" : "pass", detail: parts.length ? parts.join(" | ") : `no advisory on ${input.name} ${input.to}` });
    } catch (e) {
      layers.push({ layer: "advisory", verdict: "error", detail: String(e) });
    }
  } else layers.push({ layer: "advisory", verdict: "skipped", detail: "not selected" });

  let artifacts: { old: FileMap; new: FileMap } | undefined;
  let pre: PrepassResult | undefined;
  const scanHits = new Set<string>();
  const needArtifacts = on("prepass") || on("reviewer") || (on("scan") && !!input.scanner);
  let artifactError: string | undefined;
  if (needArtifacts) {
    try {
      artifacts = await input.loadArtifacts();
      pre = prepass(input.eco, artifacts.old, artifacts.new);
      result.prepass = pre;
    } catch (e) {
      artifactError = `artifacts unavailable: ${String(e)}`;
    }
  }

  if (on("prepass")) {
    if (!pre) layers.push({ layer: "prepass", verdict: "error", detail: artifactError ?? "no artifacts" });
    else
      layers.push(
        pre.hard.length
          ? { layer: "prepass", verdict: "stop", detail: pre.hard.map((s) => `${s.kind} ${s.path}`).join("; ") }
          : { layer: "prepass", verdict: "pass", detail: `no hard signals; ${pre.soft.length} soft` },
      );
  } else layers.push({ layer: "prepass", verdict: "skipped", detail: "not selected" });

  // New scanner findings are soft signals: they go to the reviewer and into its priority files.
  if (on("scan") && input.scanner) {
    if (!artifacts || !pre) layers.push({ layer: "scan", verdict: "error", detail: artifactError ?? "no artifacts" });
    else
      try {
        const ch = changedFiles(artifacts.old, artifacts.new);
        if (ch.new.size === 0) layers.push({ layer: "scan", verdict: "pass", detail: `${input.scanner.name}: no changed files` });
        else {
          const found = newFindings(ch.old.size ? await input.scanner.scan(input.eco, ch.old) : [], await input.scanner.scan(input.eco, ch.new));
          for (const f of found) {
            pre.soft.push({ kind: `${input.scanner.name}:${f.rule}`, path: f.path, detail: f.detail });
            scanHits.add(f.path);
          }
          layers.push({ layer: "scan", verdict: "pass", detail: `${input.scanner.name}: ${ch.new.size} changed file(s) scanned, ${found.length} new finding(s)${found.length ? ": " + found.map((f) => `${f.rule} ${f.path}`).join("; ") : ""}` });
        }
      } catch (e) {
        layers.push({ layer: "scan", verdict: "error", detail: String(e) });
      }
  } else layers.push({ layer: "scan", verdict: "skipped", detail: input.scanner ? "not selected" : "no scanner given" });

  if (on("reviewer")) {
    if (!input.reviewer) layers.push({ layer: "reviewer", verdict: "error", detail: "no reviewer configured" });
    else if (!artifacts || !pre) layers.push({ layer: "reviewer", verdict: "error", detail: artifactError ?? "no artifacts" });
    else {
      const cap = input.chunkChars ?? 60_000;
      const maxParts = input.maxParts ?? 12;
      const reviewable = [...new Set([...pre.added, ...pre.changed])].filter((p) => !INERT.test(p));
      const leftOut = (keep: Set<string>) => reviewable.filter((p) => !keep.has(p)).length;
      let scope: Scope = "all";
      let chunks = chunkDiff(artifacts.old, artifacts.new, cap);
      let note = "";
      let overPriority = "";
      let overFull = "";
      if (chunks.length > maxParts) {
        const keep = priorityPaths(pre);
        if (leftOut(keep)) overFull = `too large for model review: ${chunks.length} parts > ${maxParts} (full diff)`;
        chunks = chunkDiff(artifacts.old, artifacts.new, cap, keep);
        scope = "priority";
        note = `; priority files only, ${leftOut(keep)} lower-priority file(s) not reviewed`;
        if (chunks.length > maxParts) {
          overPriority = `too large for model review: ${chunks.length} parts > ${maxParts} (priority files alone)`;
          const sig = signalPaths(pre);
          chunks = sig.size ? chunkDiff(artifacts.old, artifacts.new, cap, sig) : [];
          scope = "signal";
          note = `${leftOut(sig)} file(s) not reviewed`;
          if (chunks.length > maxParts) {
            // Still over: review the top-ranked parts. The rest is never read, so this tier can stop, never land.
            const ranked = chunkDiff(artifacts.old, artifacts.new, cap, rankPriorityPaths(pre, scanHits));
            chunks = ranked.slice(0, maxParts);
            const read = new Set([...chunks.join("").matchAll(/^=== (.+) \((?:added|removed|changed)\) ===$/gm)].map((m) => m[1]!));
            scope = "ranked";
            overPriority = `too large for model review: ${ranked.length} parts > ${maxParts} (signal files alone)`;
            note = `${ranked.length - maxParts} parts not reviewed, ${leftOut(read)} file(s) not reviewed`;
          }
        }
      }
      if (scope === "signal" && !chunks.length) layers.push({ layer: "reviewer", verdict: "stop", detail: `${overPriority}; needs a human` });
      else if (scope === "priority" && !chunks.length) layers.push({ layer: "reviewer", verdict: "stop", detail: `${overFull}; no priority files to review${note}; needs a human` });
      else try {
        const texts: string[] = [];
        for (let i = 0; i < chunks.length; i++) texts.push(await input.reviewer.review(reviewPrompt(input, pre, chunks[i]!, i, chunks.length, scope)));
        result.reviewerText = texts;
        const flagged = texts.map((t, i) => [parseVerdict(t), i] as const).filter(([v]) => v === "FLAG");
        const parts = flagged.map(([, i]) => i + 1).join(",");
        if (scope === "ranked")
          layers.push(
            flagged.length
              ? { layer: "reviewer", verdict: "stop", detail: `${input.reviewer.name} FLAG on ranked part(s) ${parts} of ${chunks.length} reviewed; ${note}` }
              : { layer: "reviewer", verdict: "stop", detail: `${overPriority}; ${input.reviewer.name} APPROVE on the top ${chunks.length} ranked part(s); ${note}; needs a human` },
          );
        else if (scope === "signal")
          // A narrowed review never lands an update: an APPROVE leaves the unread files for a human.
          layers.push(
            flagged.length
              ? { layer: "reviewer", verdict: "stop", detail: `${input.reviewer.name} FLAG on signal part(s) ${parts} of ${chunks.length}; ${note}` }
              : { layer: "reviewer", verdict: "stop", detail: `${overPriority}; ${input.reviewer.name} APPROVE on the signal files (${chunks.length} part(s)), ${note}; needs a human` },
          );
        else if (scope === "priority" && overFull && !flagged.length)
          // OUP-19: an unread file can carry the attack (xrpl 4.2.1 landed this way), so this APPROVE holds for a human.
          layers.push({ layer: "reviewer", verdict: "stop", detail: `${overFull}; ${input.reviewer.name} APPROVE on the priority files (${chunks.length} part(s))${note}; needs a human` });
        else
          layers.push(
            flagged.length
              ? { layer: "reviewer", verdict: "stop", detail: `${input.reviewer.name} FLAG on part(s) ${parts} of ${chunks.length}${note}` }
              : { layer: "reviewer", verdict: "pass", detail: `${input.reviewer.name} APPROVE on ${chunks.length} part(s)${note}` },
          );
      } catch (e) {
        layers.push({ layer: "reviewer", verdict: "error", detail: String(e) });
      }
    }
  } else layers.push({ layer: "reviewer", verdict: "skipped", detail: "not selected" });

  if (on("gate") && input.gate) {
    try {
      const g = await input.gate.run();
      layers.push({ layer: "gate", verdict: g.ok ? "pass" : "stop", detail: g.detail });
    } catch (e) {
      layers.push({ layer: "gate", verdict: "error", detail: String(e) });
    }
  } else layers.push({ layer: "gate", verdict: "skipped", detail: input.gate ? "not selected" : "no gate given" });

  result.decision = layers.some((l) => l.verdict === "stop" || l.verdict === "error") ? "hold" : "land";
  return result;
}

export type Outcome = "stopped" | "held-human" | "error" | "passed";

/** How a review ended: a detection stopped it, only "too large for model review" held it for a human, a layer errored, or it passed through. */
export function classifyOutcome(r: ReviewResult): Outcome {
  const tooLarge = (l: LayerVerdict) => l.layer === "reviewer" && l.verdict === "stop" && l.detail.startsWith("too large for model review");
  if (r.layers.some((l) => l.verdict === "stop" && !tooLarge(l))) return "stopped";
  if (r.layers.some(tooLarge)) return "held-human";
  if (r.layers.some((l) => l.verdict === "error")) return "error";
  return r.decision === "land" ? "passed" : "error";
}
