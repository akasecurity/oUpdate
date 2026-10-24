// Chunked review of a formula, tap or source diff, ported from the previous updater's
// su_chunked_review. The diff is split into chunks under a line cap and a byte cap; each
// chunk is reviewed with reviewChunk (at most two calls); the first chunk that does not
// APPROVE stops the review, which is then a FLAG and is notified once.
//
// Splitting: whole "=== <name> (status: …) ===" file blocks are packed while they fit both
// caps. A block that does not fit a chunk on its own is cut by lines; each continuation
// starts with a "(continued, part k)" header and repeats up to OVERLAP lines of the previous
// part (only as many as still leave room for the line that forced the cut, and at most a quarter
// of the byte cap, so long lines still make progress), so nothing hides
// on a cut. A line over the byte cap less 512 bytes (room for the prompt around it), or one that
// does not fit beside its own continuation header, fails closed: it cannot be split without
// cutting code.

import type { Reviewer } from "../review.ts";
import { ground } from "./ground.ts";
import { reviewChunk } from "./verdict.ts";

export const DEFAULT_CAPS = { lines: 1000, maxChunks: 40, bytes: 200000 };
const OVERLAP = 50;
const HEADER = /^=== .* \(status: [^)]*\) ===$/;

export interface Caps {
  lines?: number;
  maxChunks?: number;
  bytes?: number;
}

// Caps are validated, not trusted: a tiny or non-numeric chunk size once made the splitter
// emit a chunk per line.
export function validCaps(c: Caps = {}): Required<Caps> {
  const ok = (v: unknown, min: number) => typeof v === "number" && Number.isInteger(v) && v >= min;
  return {
    lines: ok(c.lines, 100) ? c.lines! : DEFAULT_CAPS.lines,
    maxChunks: ok(c.maxChunks, 1) ? c.maxChunks! : DEFAULT_CAPS.maxChunks,
    bytes: ok(c.bytes, 10000) ? c.bytes! : DEFAULT_CAPS.bytes,
  };
}

export interface Chunk {
  text: string;
  /** 1-based range of the original diff lines this chunk starts and ends at (overlap included). */
  from: number;
  to: number;
}

export type Split = { ok: true; chunks: Chunk[]; lines: number } | { ok: false; why: "toolong" | "badcaps" | "toomany"; lines: number };

const TOO_MANY = Symbol("too many chunks");

/** Splits under the caps; stops as soon as a chunk past maxChunks would open (never holds more). */
export function splitDiff(diff: string, lines: number, bytes: number, maxChunks = Number.POSITIVE_INFINITY, onOpen?: () => void): Split {
  try {
    return split(diff, lines, bytes, maxChunks, onOpen);
  } catch (e) {
    if (e === TOO_MANY) return { ok: false, why: "toomany", lines: diff.split("\n").length - (diff.endsWith("\n") ? 1 : 0) };
    throw e;
  }
}

function split(diff: string, lines: number, bytes: number, maxChunks: number, onOpen?: () => void): Split {
  const line = diff.split("\n");
  if (line.length > 1 && line.at(-1) === "") line.pop();
  const n = line.length;
  if (!(lines >= 100) || !(bytes >= 10000)) return { ok: false, why: "badcaps", lines: n };
  const sz = line.map((l) => Buffer.byteLength(l) + 1);
  if (sz.some((s) => s > bytes - 512)) return { ok: false, why: "toolong", lines: n };
  const start: number[] = [];
  line.forEach((l, i) => {
    if (HEADER.test(l)) start.push(i);
  });
  if (start[0] !== 0) start.unshift(0);
  start.push(n);

  const chunks: { body: string[]; from: number; to: number; bytes: number }[] = [];
  let cur: (typeof chunks)[number] | undefined;
  const open = (first: number) => {
    if (chunks.length >= maxChunks) throw TOO_MANY;
    onOpen?.();
    cur = { body: [], from: first + 1, to: first + 1, bytes: 0 };
    chunks.push(cur);
  };
  const emit = (s: string) => {
    cur!.body.push(s);
    cur!.bytes += Buffer.byteLength(s) + 1;
  };
  for (let f = 0; f + 1 < start.length; f++) {
    const s = start[f]!;
    const e = start[f + 1]! - 1;
    if (e < s) continue;
    const len = e - s + 1;
    let blockBytes = 0;
    for (let i = s; i <= e; i++) blockBytes += sz[i]!;
    if (len <= lines && blockBytes <= bytes) {
      if (!cur || cur.body.length + len > lines || cur.bytes + blockBytes > bytes) open(s);
      for (let i = s; i <= e; i++) emit(line[i]!);
      cur!.to = e + 1;
      continue;
    }
    const name = line[s]!.replace(/^=== /, "").replace(/ \(status: [^)]*\) ===$/, "");
    open(s);
    let part = 1;
    let fresh = 0;
    for (let i = s; i <= e; i++) {
      if (fresh > 0 && (cur!.body.length + 1 > lines || cur!.bytes + sz[i]! > bytes)) {
        cur!.to = i;
        part++;
        // The header repeats the file name, which the diff controls: count its bytes, and fail
        // closed when it leaves no room for the line that forced the cut.
        const header = `=== ${name} (continued, part ${part}) ===`;
        const hb = Buffer.byteLength(header) + 1;
        if (hb + sz[i]! > bytes) return { ok: false, why: "toolong", lines: n };
        let o = i;
        let ob = 0;
        while (o - 1 >= s && i - (o - 1) <= OVERLAP && ob + sz[o - 1]! <= bytes / 4 && hb + ob + sz[o - 1]! + sz[i]! <= bytes) {
          o--;
          ob += sz[o]!;
        }
        open(o);
        emit(header);
        for (let j = o; j < i; j++) emit(line[j]!);
        fresh = 0;
      }
      emit(line[i]!);
      fresh++;
    }
    cur!.to = e + 1;
  }
  return { ok: true, chunks: chunks.map((c) => ({ text: c.body.join("\n"), from: c.from, to: c.to })), lines: n };
}

export interface ChunkedReviewInput {
  /** The prompt's own words, e.g. "Type B formula review"; shown in the log. */
  title: string;
  /** The package as the notice names it, e.g. "wm (formula)". */
  label: string;
  /** "1.0 → 1.1". */
  upgrade: string;
  head: string;
  tail: string;
  diff: string;
  diffLabel?: string;
  caps?: Caps;
  host: string;
  logFile?: string;
  notify: (text: string) => void | Promise<void>;
}

export interface ChunkedReviewResult {
  approved: boolean;
  calls: number;
  log: string[];
  /** Why it was not approved; also the notice's second line. */
  reason?: string;
}

export async function chunkedReview(r: Reviewer, a: ChunkedReviewInput): Promise<ChunkedReviewResult> {
  const log: string[] = [];
  let calls = 0;
  let reason: string | undefined;
  try {
    reason = await decide();
  } catch (e) {
    log.push(`${a.label}: review aborted before a verdict: FLAG`);
    reason = `Review aborted before a verdict (${e instanceof Error ? e.name : "error"}). Manual review required.`;
  }
  if (reason === undefined) return { approved: true, calls, log };
  // One notice per FLAG; a failed notice is logged and the FLAG still stands.
  try {
    await a.notify(`⚠️ <b>${a.host} Type B FLAG — ${a.label}</b>\n${reason}\nUpgrade: ${a.upgrade}\nLog: ${a.logFile ?? "-"}`);
  } catch {
    log.push(`${a.label}: the FLAG notice could not be sent`);
  }
  return { approved: false, calls, log, reason };

  // The reason the review did not approve, or undefined when every chunk APPROVEd.
  async function decide(): Promise<string | undefined> {
    const caps = validCaps(a.caps);
    const split = splitDiff(a.diff, caps.lines, caps.bytes, caps.maxChunks);
    if (!split.ok) {
      const reason =
        split.why === "toolong"
          ? `line too long for automated review (> ${caps.bytes} bytes): manual review`
          : split.why === "toomany"
            ? `diff too large for automated review (${split.lines} lines, over ${caps.maxChunks} chunks): manual review`
            : `could not split the ${split.lines}-line diff into review chunks: manual review`;
      log.push(`${a.label}: ${reason}: FLAG`);
      return reason;
    }
    const n = split.chunks.length;
    if (n === 0) return "no review chunks: manual review";
    if (n > 1) log.push(`reviewing in ${n} chunks (≤ ${caps.lines} lines / ${caps.bytes} bytes each)`);
    for (const [k, c] of split.chunks.entries()) {
      const i = k + 1;
      const prompt = `${a.head}\nChunk ${i} of ${n}\n\n${a.diffLabel ?? "GitHub compare API source diff:"}\n${c.text}\n\n${a.tail}`;
      const box = `${a.title}: ${a.label}${n > 1 ? ` [chunk ${i}/${n}]` : ""}`;
      const v = await reviewChunk(r, prompt, { ground: (t) => ground(t, c.text), box, chunk: i });
      calls += v.calls;
      log.push(...v.log);
      if (v.verdict === "APPROVE") {
        log.push(`review chunk ${i}/${n}: APPROVE (lines ${c.from}-${c.to})`);
        continue;
      }
      log.push(`review chunk ${i}/${n}: FLAG (lines ${c.from}-${c.to})`);
      let reason = v.reason ?? "FLAG";
      if (n > 1) reason += ` (chunk ${i}/${n}, lines ${c.from}-${c.to})`;
      return reason;
    }
    return undefined;
  }
}
