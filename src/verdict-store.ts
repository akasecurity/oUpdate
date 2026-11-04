// One verdict per release across hosts. The same package update reaches every Mac, and a review answer depends only on
// the reviewer and the prompt (which carries the template, the package and the release diff), so the answer is stored
// under a hash of those two and a host that meets the same release reads it instead of paying for another review.
// The roll-up reports one hold per release and reason with the hosts that hit it. The directory is any path hosts share.

import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, writeFileSync } from "node:fs";
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

/** The reviewer, answering from the store when the same prompt was FLAGged before. Only a FLAG is stored and only a FLAG is served: the store can add a hold, never an approval, so a planted entry cannot land a release. */
export function cachedReviewer(inner: Reviewer, dir: string, host: string, fingerprint = ""): Reviewer {
  return {
    name: inner.name,
    ...(inner.ready ? { ready: () => inner.ready!() } : {}),
    async review(prompt) {
      const file = join(dir, `${verdictKey(inner.name, prompt, fingerprint)}.json`);
      try {
        const hit = JSON.parse(readFileSync(file, "utf8"));
        if (typeof hit?.text === "string" && hit.text.trim() && parseVerdict(hit.text) === "FLAG") return hit.text;
      } catch {} // absent or damaged: a miss
      const text = await inner.review(prompt);
      if (text.trim() && parseVerdict(text) === "FLAG") {
        try {
          writeAtomic(file, JSON.stringify({ reviewer: inner.name, host, text }));
        } catch {} // an unwritable store must not lose the answer just paid for
      }
      return text;
    },
  };
}

const releaseId = (r: ReviewResult) => `${r.eco}-${r.name}-${r.from}-${r.to}`;
const safe = (s: string) => encodeURIComponent(s).replace(/\./g, "%2E");

/** Records what this host decided for a release; a later record for the same release replaces it. */
export async function recordResult(dir: string, host: string, r: ReviewResult): Promise<void> {
  writeAtomic(join(dir, "results", safe(host), `${safe(releaseId(r))}.json`), JSON.stringify({ host, result: r }));
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
      files = readdirSync(join(root, h)).filter((x) => x.endsWith(".json"));
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
      const reason = stripTerminal(bad ? `${bad.layer}: ${bad.detail}` : "no layer read the code");
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
