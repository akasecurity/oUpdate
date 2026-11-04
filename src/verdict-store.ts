// One verdict per release across hosts. The same package update reaches every Mac, and a review answer depends only on
// the reviewer and the prompt (which carries the template, the package and the release diff), so the answer is stored
// under a hash of those two and a host that meets the same release reads it instead of paying for another review.
// The roll-up reports one hold per release and reason with the hosts that hit it. The directory is any path hosts share.

import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, isAbsolute, sep } from "node:path";
import { parseVerdict, stripTerminal, type Reviewer, type ReviewResult } from "./review.ts";
import type { ReviewerSpec } from "./adapters/reviewer/spec.ts";

// Where and how a reviewer is reached, not what it answers with: these differ per host and must not split the store.
const LOCAL_ONLY = new Set(["baseUrls", "timeoutMs", "retryDelaysMs", "headers", "expectHeaders", "apiKeyEnv", "workRoot"]);

const canon = (v: unknown): unknown => (Array.isArray(v) ? v.map(canon) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v as object).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, x]) => [k, canon(x)])) : v);

/** Hash of the reviewer settings that shape an answer (model, token limit, extra body, command line), so a changed model under the same name is not served an old verdict. */
export function reviewerFingerprint(spec: ReviewerSpec): string {
  const kept = Object.fromEntries(Object.entries(spec).filter(([k]) => !LOCAL_ONLY.has(k)));
  return new Bun.CryptoHasher("sha256").update(JSON.stringify(canon(kept))).digest("hex");
}

/** Content hash of what an answer depends on. A changed prompt, release diff, reviewer name or reviewer fingerprint is a different key. */
export function verdictKey(reviewerName: string, prompt: string, fingerprint = ""): string {
  return new Bun.CryptoHasher("sha256").update(`${reviewerName.length}:${reviewerName}\n${fingerprint.length}:${fingerprint}\n${prompt}`).digest("hex");
}

function writeAtomic(path: string, text: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

/** The release a review is for, written into each stored entry so a person can find and forget it. */
export interface Release {
  eco: string;
  name: string;
  from: string;
  to: string;
}

const isFlag = (text: unknown): text is string => typeof text === "string" && !!text.trim() && parseVerdict(text) === "FLAG";

export interface CachedReviewer extends Reviewer {
  /** How many answers this wrapper served from the store instead of asking the reviewer. */
  storeHits: number;
}

/** The reviewer, answering from the store when the same prompt was FLAGged before. Only a FLAG is stored and only a FLAG is served: the store can add a hold, never an approval, so a planted entry cannot land a release. */
export function cachedReviewer(inner: Reviewer, dir: string, host: string, fingerprint = "", release?: Release): CachedReviewer {
  const out: CachedReviewer = {
    name: inner.name,
    storeHits: 0,
    ...(inner.ready ? { ready: () => inner.ready!() } : {}),
    async review(prompt) {
      const file = join(dir, `${verdictKey(inner.name, prompt, fingerprint)}.json`);
      try {
        const hit = JSON.parse(readFileSync(file, "utf8"));
        if (isFlag(hit?.text)) {
          out.storeHits++;
          return hit.text;
        }
      } catch {} // absent or damaged: a miss
      const text = await inner.review(prompt);
      if (isFlag(text)) {
        try {
          const meta = release ? { eco: release.eco, name: release.name, from: release.from, to: release.to } : {};
          writeAtomic(file, JSON.stringify({ reviewer: inner.name, host, ...meta, at: new Date().toISOString(), text }));
        } catch {} // an unwritable store must not lose the answer just paid for
      }
      return text;
    },
  };
  return out;
}

/** Appended to the reviewer layer's reason when any part of its answer came from the store. */
export const STORE_MARK = " (from shared store)";

/** The result with its reviewer reason marked when the reviewer answered from the store (hits > 0). */
export function markStoreAnswer(r: ReviewResult, hits: number): ReviewResult {
  if (hits <= 0) return r;
  return { ...r, layers: r.layers.map((l) => (l.layer === "reviewer" && !l.detail.endsWith(STORE_MARK) ? { ...l, detail: l.detail + STORE_MARK } : l)) };
}

export interface StoreEntry {
  key: string;
  file: string;
  reviewer?: string;
  host?: string;
  eco?: string;
  name?: string;
  from?: string;
  to?: string;
  at?: string;
}

const KEY = /^[0-9a-f]{64}$/;
const META = ["reviewer", "host", "eco", "name", "from", "to", "at"] as const;

/** The stored FLAG entries, by key. Entries written before the release fields existed list without them. */
export function storeEntries(dir: string): StoreEntry[] {
  let names: string[];
  try {
    names = readdirSync(dir).filter((f) => f.endsWith(".json") && KEY.test(f.slice(0, -5))).sort();
  } catch {
    return [];
  }
  const out: StoreEntry[] = [];
  for (const f of names) {
    let e: Record<string, unknown>;
    try {
      e = JSON.parse(readFileSync(join(dir, f), "utf8"));
    } catch {
      continue;
    }
    if (!e || !isFlag(e.text)) continue;
    const row: StoreEntry = { key: f.slice(0, -5), file: join(dir, f) };
    for (const k of META) if (typeof e[k] === "string") row[k] = e[k] as string;
    out.push(row);
  }
  return out;
}

export const FORGET_USAGE = "usage: oupdate verdicts --verdict-dir DIR --forget <key>|<eco>:<name>@<from>><to>  (key: the 64-hex file name without .json; release e.g. 'npm:left-pad@1.0.0>1.0.1', from empty for a new package)";

/** Deletes the entry with that key, or every entry recorded for that release; returns the files deleted. */
export function forgetEntries(dir: string, target: string): string[] {
  if (KEY.test(target)) {
    const file = join(dir, `${target}.json`);
    if (!existsSync(file)) return [];
    unlinkSync(file);
    return [file];
  }
  const m = /^([^:]+):(.+)@([^@>]*)>([^@>]+)$/.exec(target);
  if (!m) throw new Error(`${FORGET_USAGE}; got ${stripTerminal(target)}`);
  const [, eco, name, from, to] = m;
  const hits = storeEntries(dir).filter((e) => e.eco === eco && e.name === name && e.from === from && e.to === to);
  for (const e of hits) unlinkSync(e.file);
  return hits.map((e) => e.file);
}

const releaseId = (r: ReviewResult) => new Bun.CryptoHasher("sha256").update(JSON.stringify([r.eco, r.name, r.from, r.to])).digest("hex");
const safe = (s: string) => encodeURIComponent(s).replace(/\./g, "%2E");

/** Records what this host decided for a release; a later record for the same release replaces it. */
export async function recordResult(dir: string, host: string, r: ReviewResult): Promise<void> {
  writeAtomic(join(dir, "results", safe(host), `${releaseId(r)}.json`), JSON.stringify({ host, result: r }));
}

export interface HoldRow {
  eco: string;
  name: string;
  from: string;
  to: string;
  reason: string;
  hosts: string[];
}

/** One row per held release and reason, hosts sorted, rows by package. */
export async function rollupHolds(dir: string): Promise<HoldRow[]> {
  const root = join(dir, "results");
  if (!existsSync(root)) return [];
  const rows = new Map<string, HoldRow>();
  for (const h of readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)) {
    let files: string[];
    try {
      files = readdirSync(join(root, h)).filter((x) => x.endsWith(".json") && KEY.test(x.slice(0, -5))); // a file under the old hyphen-joined name is a stale record next to its hashed successor
    } catch {
      continue;
    }
    for (const f of files) {
      let rec: { host: string; result: ReviewResult };
      try {
        rec = JSON.parse(readFileSync(join(root, h, f), "utf8"));
      } catch {
        continue;
      }
      const r = rec?.result;
      const str = (x: unknown) => typeof x === "string";
      if (!r || !str(rec.host) || !str(r.eco) || !str(r.name) || !str(r.from) || !str(r.to) || !Array.isArray(r.layers) || !r.layers.every((l) => l && str(l.layer) && str(l.verdict) && str(l.detail))) continue;
      if (r.decision !== "hold") continue;
      // A cooldown stop is a wait, not a block, and its text carries a per-host age: it never names a hold, and a release held only by cooldown is not listed.
      const blocking = r.layers.filter((l) => l.layer !== "cooldown");
      const bad = blocking.find((l) => l.verdict === "stop") ?? blocking.find((l) => l.verdict === "error");
      if (!bad && r.layers.some((l) => l.layer === "cooldown" && l.verdict === "stop")) continue;
      // A reused answer is the same hold as the one paid for: one row for both.
      const detail = bad && bad.detail.endsWith(STORE_MARK) ? bad.detail.slice(0, -STORE_MARK.length) : bad?.detail;
      const reason = stripTerminal(bad ? `${bad.layer}: ${detail}` : "no layer read the code");
      const key = JSON.stringify([r.eco, r.name, r.from, r.to, reason]);
      const row = rows.get(key) ?? { eco: stripTerminal(r.eco), name: stripTerminal(r.name), from: stripTerminal(r.from), to: stripTerminal(r.to), reason, hosts: [] };
      const host = stripTerminal(rec.host);
      if (!row.hosts.includes(host)) row.hosts.push(host);
      rows.set(key, row);
    }
  }
  return [...rows.values()].map((x) => ({ ...x, hosts: x.hosts.sort() })).sort((a, b) => `${a.name}${a.reason}`.localeCompare(`${b.name}${b.reason}`));
}

const real = (p: string): string => {
  const abs = resolve(p);
  const rest: string[] = [];
  let at = abs;
  while (!existsSync(at) && dirname(at) !== at) (rest.unshift(basename(at)), (at = dirname(at)));
  return join(realpathSync(at), ...rest);
};
const within = (child: string, root: string) => {
  const r = relative(root, child);
  return r === "" || (r !== ".." && !r.startsWith(".." + sep) && !isAbsolute(r));
};

/** Throws when dir lies inside the git checkout found above the working directory or the CI workspace (the working directory alone is not a root: it is / under launchd and $HOME in a shell): a pull request's branch could ship its own entries there. */
export function verdictDirOutsideRepo(dir: string, cwd: string, env: Record<string, string | undefined>): void {
  const roots: string[] = [];
  for (let at = real(cwd); ; at = dirname(at)) {
    if (existsSync(join(at, ".git"))) {
      roots.push(at);
      break;
    }
    if (dirname(at) === at) break;
  }
  if (env.GITHUB_WORKSPACE) roots.push(real(env.GITHUB_WORKSPACE));
  const target = real(dir);
  const hit = roots.find((r) => within(target, r));
  if (hit) throw new Error(`--verdict-dir ${dir} is inside the checked-out repo or workspace (${hit}); a pull request could ship its own entries there. Use a directory outside it.`);
}
