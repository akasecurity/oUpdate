// The dataset samples for acceptance/run.ts. The dataset is fetched from the GitHub API without a token, which answers 403 once several
// shards list at the same time; a local cache fills once (serially, with backoff) and every later run reads it.
//
// Identity: every datadog case in cases.json pins the sha256 of its zip (source.sha256). A sample is used only when its bytes hash to
// the pin, wherever they come from: the work dir, the cache or a fresh fetch. So the cache cannot change what a case reviews: a planted
// file, a truncated download or a symlink is refused or replaced, never served. A case without a pin is refused (its bytes have no
// identity to check).
// The dataset path of the case is part of the cache key, so a case whose path was edited without its pin misses and is fetched, and
// fails loudly on the pin if that was not updated too. Cache layout: <cache>/<sha256>/<first 16 hex of sha256 of the path>/<zip name>;
// one rename publishes a zip, so a reader never sees a partial file and two shards filling the same sample at once are safe. In the
// work dir, <work>/<id>/bad holds only the zip (as before); the dataset path of that zip is kept in <work>/<id>/.meta/dataset-path.txt,
// written before the zip, and a zip that a marker says came from another path is a miss. A zip with no marker (a work dir filled by an
// earlier version or by hand) is accepted, because its hash still pins the bytes. A wrong zip is renamed into .meta, never deleted.
// Every directory from the cache root or work dir down to the file must be a real directory: a symbolic link is never followed (nothing
// is read, removed or written through it). A cache or work dir that cannot be used is a warning, not an error: the fetched bytes are
// still used.
// Time: one stateless rule, nothing is remembered between samples. Each request retries up to 4 attempts (2 s, 4 s and 8 s between,
// getWithBackoff), and all requests of one sample (listing and download together) share a hard budget of 60 s on a monotonic clock:
// nothing starts after it and a request is cut to what is left. A lasting outage therefore costs at most 60 s per sample, 25 samples
// at most 25 minutes, and a server that comes back is used by the very next sample.
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { createHash } from "node:crypto";
import { BACKOFF, GaveUpError, getWithBackoff, JSON_TIMEOUT_MS } from "./http.ts";

export const DATASET_API = "https://api.github.com/repos/DataDog/malicious-software-packages-dataset/contents/samples";
export const DOWNLOAD_HOST = "raw.githubusercontent.com";
export const DEFAULT_CACHE = join(homedir(), ".cache", "oupdate-acceptance", "samples");
export const PATH_MARKER = "dataset-path.txt";
export const SAMPLE_BUDGET_MS = 60_000; // everything one sample may spend on the network, listing and download, retries included
export const STALE_TMP_MS = 15 * 60_000; // a temporary file untouched for longer than this was left by a dead writer

export type Getter = (url: string, opts?: { accept?: string; timeoutMs?: number }) => Promise<Uint8Array>;
export type SampleSource = "work" | "cache" | "fetched";

export const sha256Hex = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function writeAtomic(file: string, bytes: Uint8Array | string): void {
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    writeFileSync(tmp, bytes);
    renameSync(tmp, file);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

// "ok" for a real directory, "missing" when there is nothing, else the reason it must not be used (a symbolic link, a file, unreadable).
function realDir(p: string): "ok" | "missing" | string {
  try {
    const st = lstatSync(p);
    if (st.isSymbolicLink()) return `${p} is a symbolic link`;
    return st.isDirectory() ? "ok" : `${p} is not a directory`;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : `cannot read ${p}: ${msg(e)}`;
  }
}

// A temporary file left by a writer that died between the write and the rename. Only a file named exactly as writeAtomic names it
// (<name>.<pid>.<base36>.tmp, name being a file this code writes there: the sample zip, or the path marker) and untouched for longer
// than STALE_TMP_MS is removed. Age alone decides, so a live fill of another shard (any host, any pid namespace) is never
// touched, and neither is any other file. Without names, any name ending in .zip counts.
function removeStaleTmp(dir: string, names?: string[]): void {
  try {
    const files = readdirSync(dir);
    for (const f of files) {
      const m = /^(.+)\.\d+\.[a-z0-9]+\.tmp$/.exec(f);
      if (!m || !(names ? names.includes(m[1]!) : m[1]!.endsWith(".zip"))) continue;
      const p = join(dir, f);
      const st = lstatSync(p);
      if (st.isFile() && Date.now() - st.mtimeMs > STALE_TMP_MS) rmSync(p, { force: true });
    }
  } catch { /* best effort */ }
}

// The first problem on a chain of directories (outermost first): a symbolic link, a file, an unreadable entry. A missing one is not a
// problem (nothing is there yet).
function chainProblem(chain: string[]): string | undefined {
  for (const p of chain) {
    const r = realDir(p);
    if (r === "missing") return undefined;
    if (r !== "ok") return r;
  }
  return undefined;
}

// The one zip of the last directory of a chain with its bytes checked against the pin. Only *.zip counts (a .DS_Store or a leftover
// .tmp beside it is ignored). A linked directory anywhere on the chain, two zips, a zip that is not a regular file, one that cannot be
// read or bytes with another hash are a problem, and the caller treats it as a miss.
type Checked = { kind: "none" } | { kind: "bad"; problem: string; files: string[] } | { kind: "ok"; file: string; bytes: Uint8Array };
function checkZipDir(chain: string[], pin: string): Checked {
  const dir = chain[chain.length - 1]!;
  const cp = chainProblem(chain);
  if (cp) return { kind: "bad", problem: cp, files: [] };
  if (realDir(dir) === "missing") return { kind: "none" };
  let names: string[];
  try {
    names = readdirSync(dir).filter((f) => f.endsWith(".zip")).sort();
  } catch (e) {
    return { kind: "bad", problem: `cannot read ${dir}: ${msg(e)}`, files: [] };
  }
  if (names.length === 0) return { kind: "none" };
  const files = names.map((n) => join(dir, n));
  if (names.length > 1) return { kind: "bad", problem: `more than one zip in ${dir}`, files };
  const file = files[0]!;
  try {
    if (!lstatSync(file).isFile()) return { kind: "bad", problem: `${file} is not a regular file`, files };
    const bytes = readFileSync(file);
    const got = sha256Hex(bytes);
    if (got !== pin) return { kind: "bad", problem: `${file} has sha256 ${got}, pinned ${pin}`, files };
    return { kind: "ok", file, bytes };
  } catch (e) {
    return { kind: "bad", problem: `cannot read ${file}: ${msg(e)}`, files };
  }
}

// The dataset path a work-dir zip was fetched for, when the marker says one other than the case's. No .meta and no marker (or one that
// is not a regular file) say nothing: the hash already pins the bytes. A .meta that is a symbolic link, a file or unreadable is a
// problem (never a pass): the zip is not used from the work dir and nothing is written through the link.
function markerMismatch(meta: string, path: string): string | undefined {
  try {
    const m = realDir(meta);
    if (m === "missing") return undefined;
    if (m !== "ok") return `${m}; the path marker cannot be checked`;
    const marker = join(meta, PATH_MARKER);
    if (!lstatSync(marker).isFile()) return undefined;
    const recorded = readFileSync(marker, "utf8").trim();
    return recorded === path ? undefined : `the zip was fetched for dataset path ${recorded}, the case now says ${path}`;
  } catch {
    return undefined;
  }
}

export const pathKey = (path: string) => sha256Hex(new TextEncoder().encode(path)).slice(0, 16);
const cacheChain = (cacheDir: string, pin: string, path: string) => [cacheDir, join(cacheDir, pin), join(cacheDir, pin, pathKey(path))];
const unique = () => `${process.pid}.${randomBytes(6).toString("hex")}`;

// Best-effort: an unusable, unwritable or full cache warns and the run goes on with the bytes it has. Never writes or removes through a
// symbolic link; a stray zip in the entry is removed with unlink (never recursively).
function storeInCache(cacheDir: string, pin: string, path: string, name: string, bytes: Uint8Array, warn: (m: string) => void): boolean {
  try {
    const chain = cacheChain(cacheDir, pin, path);
    const dir = chain[chain.length - 1]!;
    const cp = chainProblem(chain);
    if (cp) throw new Error(cp);
    mkdirSync(dir, { recursive: true });
    const after = chainProblem(chain);
    if (after || realDir(dir) !== "ok") throw new Error(after ?? `${dir} is not a real directory`);
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".zip") || f === name) continue;
      const p = join(dir, f);
      if (!lstatSync(p).isDirectory()) rmSync(p, { force: true });
    }
    removeStaleTmp(dir, [name]);
    writeAtomic(join(dir, name), bytes);
    return true;
  } catch (e) {
    warn(`warning: cannot write the sample cache ${cacheDir}: ${msg(e)}`);
    return false;
  }
}

// One attempt: the listing, then the zip.
async function fetchOnce(path: string, getter: Getter): Promise<{ name: string; bytes: Uint8Array }> {
  const listing = JSON.parse(new TextDecoder().decode(await getter(`${DATASET_API}/${path}`, { accept: "application/vnd.github+json", timeoutMs: JSON_TIMEOUT_MS }))) as { name: string; download_url: string }[];
  const zips = listing.filter((x) => typeof x.name === "string" && x.name.endsWith(".zip"));
  if (zips.length === 0) throw new Error(`no zip in dataset path ${path}`);
  if (zips.length > 1) throw new Error(`more than one zip in dataset path ${path}: ${zips.map((z) => z.name).join(", ")}`);
  const z = zips[0]!;
  if (basename(z.name) !== z.name || z.name.includes("\\") || z.name.startsWith(".")) throw new Error(`unsafe file name in dataset path ${path}: ${z.name}`);
  const u = new URL(z.download_url);
  if (u.protocol !== "https:" || u.hostname !== DOWNLOAD_HOST) throw new Error(`download url for ${path} is not on https://${DOWNLOAD_HOST}: ${z.download_url}`);
  return { name: z.name, bytes: await getter(z.download_url) };
}

// The real getter, made fresh for each sample: backoff on a busy server, all of the sample's requests inside one budget
// (SAMPLE_BUDGET_MS, a real deadline: nothing starts after it and a request is cut to what is left). now is monotonic; wallNow
// (rate-limit resets are epoch times) is only for getWithBackoff's rate-limit headers.
export function budgetedGetter(deps: { fetchImpl?: typeof fetch; sleep?: (ms: number) => Promise<void>; now?: () => number; wallNow?: () => number; random?: () => number; budgetMs?: number } = {}): Getter {
  const now = deps.now ?? (() => performance.now());
  const budgetMs = deps.budgetMs ?? SAMPLE_BUDGET_MS;
  const started = now();
  return async (url, opts) => {
    const left = budgetMs - (now() - started);
    if (left <= 0) throw new GaveUpError(`gave up after 0 attempts: ${url}: the ${Math.round(budgetMs / 1000)} s budget of this sample is used`);
    return getWithBackoff(url, { ...opts, fetchImpl: deps.fetchImpl, sleep: deps.sleep, random: deps.random, now, wallNow: deps.wallNow, totalMs: Math.min(BACKOFF.totalMs, left) });
  };
}

// Fetch one sample and check its hash; a mismatch is fetched once more, then fails loudly.
export async function fetchVerified(path: string, pin: string, getter: Getter = budgetedGetter()): Promise<{ name: string; bytes: Uint8Array }> {
  let got = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const f = await fetchOnce(path, getter);
    got = sha256Hex(f.bytes);
    if (got === pin) return f;
  }
  throw new Error(`dataset path ${path}: fetched bytes have sha256 ${got} twice, pinned ${pin}`);
}

interface Opts { id: string; path: string; sha256?: string; workDir: string; cacheDir: string; offline: boolean; getter?: Getter; warn?: (m: string) => void }

function requirePin(o: { id: string; sha256?: string }): string {
  if (!o.sha256 || !/^[0-9a-f]{64}$/.test(o.sha256)) throw new Error(`case ${o.id}: no sha256 pin in cases.json (source.sha256); a dataset sample without a pin is refused`);
  return o.sha256;
}

// Put the verified bytes in <work>/<id>/bad (best-effort), after moving aside whatever wrong zips were there (into .meta, under a name
// with the pid and random bytes, so a second fill never overwrites it). The path marker is written before the zip. After a failed
// install nothing is put back into bad/ and no wrong zip stays there (extract.ts takes the first file of bad/ without a hash check):
// whatever wrong zip is still in bad/ is moved up next to it, into <work>/<id>, so extract says "nothing to extract".
function installInWork(o: Opts, bad: string, name: string, bytes: Uint8Array, aside: string[], warn: (m: string) => void): string | undefined {
  const meta = join(o.workDir, o.id, ".meta");
  try {
    const chain = [o.workDir, join(o.workDir, o.id), bad];
    const cp = chainProblem([...chain.slice(0, 2), meta]) ?? chainProblem(chain);
    if (cp) throw new Error(cp);
    mkdirSync(bad, { recursive: true });
    mkdirSync(meta, { recursive: true });
    const after = chainProblem([...chain.slice(0, 2), meta]) ?? chainProblem(chain);
    if (after) throw new Error(after);
    for (const f of aside) {
      const to = join(meta, `${basename(f)}.${unique()}.bad`);
      renameSync(f, to);
      warn(`sample ${o.id}: moved ${f} aside to ${to}`);
    }
    removeStaleTmp(bad, [name]);
    removeStaleTmp(meta, [PATH_MARKER]);
    try { writeAtomic(join(meta, PATH_MARKER), o.path + "\n"); } catch { /* a marker that cannot be written only loses the path check */ }
    const dest = join(bad, name);
    writeAtomic(dest, bytes);
    return dest;
  } catch (e) {
    warn(`warning: sample ${o.id} is not kept in the work dir: ${msg(e)}`);
    const caseDir = join(o.workDir, o.id);
    if (chainProblem([o.workDir, caseDir]) === undefined) {
      for (const f of aside) {
        try { if (existsSync(f) && dirname(f) === bad) renameSync(f, join(caseDir, `${basename(f)}.${unique()}.bad`)); } catch { /* best effort */ }
      }
    }
    return undefined;
  }
}

// The sample zip for a case, hash-checked against the pin: <work>/<id>/bad if it passes, else the cache, else (unless offline) a fetch.
// The verified bytes are returned; read them with readVerifiedSample. file is where they are kept in the work dir (absent when the work
// dir cannot be used).
export async function sampleZip(o: Opts): Promise<{ file?: string; source: SampleSource; sha256: string; bytes: Uint8Array }> {
  try {
    return await sampleZipInner(o);
  } finally {
    // Every way out: a temporary file left in bad/ by a killed run is never read by extract.ts. Not through a linked or odd directory.
    if (o.id && chainProblem([o.workDir, join(o.workDir, o.id), join(o.workDir, o.id, "bad")]) === undefined) removeStaleTmp(join(o.workDir, o.id, "bad"));
  }
}

async function sampleZipInner(o: Opts): Promise<{ file?: string; source: SampleSource; sha256: string; bytes: Uint8Array }> {
  const pin = requirePin(o);
  const warn = o.warn ?? ((m) => console.warn(m));
  const bad = join(o.workDir, o.id, "bad");
  const w = checkZipDir([o.workDir, join(o.workDir, o.id), bad], pin);
  const mm = w.kind === "ok" ? markerMismatch(join(o.workDir, o.id, ".meta"), o.path) : undefined;
  if (w.kind === "ok" && !mm) return { file: w.file, source: "work", sha256: pin, bytes: w.bytes };
  const problems = w.kind === "bad" ? [`work: ${w.problem}`] : mm ? [`work: ${mm}`] : [];
  const asideFiles = w.kind === "bad" ? w.files : w.kind === "ok" ? [w.file] : [];
  let source: SampleSource = "cache";
  let name: string;
  let bytes: Uint8Array;
  const c = checkZipDir(cacheChain(o.cacheDir, pin, o.path), pin);
  if (c.kind === "ok") {
    name = basename(c.file);
    bytes = c.bytes;
  } else {
    if (c.kind === "bad") problems.push(`cache: ${c.problem}`);
    if (o.offline) {
      const why = problems.length ? ` (${problems.join("; ")})` : "";
      throw new Error(`offline: no sample for ${o.id} (dataset path ${o.path}) with sha256 ${pin} in cache ${o.cacheDir} or work ${bad}${why}; run once without --offline or with --prefetch to fill the cache`);
    }
    for (const p of problems) warn(`sample ${o.id}: ${p}; fetching`);
    ({ name, bytes } = await fetchVerified(o.path, pin, o.getter ?? budgetedGetter()));
    source = "fetched";
    storeInCache(o.cacheDir, pin, o.path, name, bytes, warn);
  }
  const file = installInWork(o, bad, name, bytes, asideFiles, warn);
  return { file, source, sha256: pin, bytes };
}

// Run read() on a private copy of the verified bytes, re-hashed right before the read, so the hash covers the bytes that are extracted
// (not whatever the work dir holds by then). Residual window: between that hash and the reader opening the file, a process of the same
// user could swap the file inside the private 0700 temp dir; nothing else can.
export async function readVerifiedSample<T>(s: { bytes: Uint8Array; sha256: string }, read: (path: string) => Promise<T>, hooks: { beforeRead?: (path: string) => void } = {}): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "oupdate-verified-"));
  try {
    const p = join(dir, "sample.zip");
    writeFileSync(p, s.bytes, { mode: 0o600 });
    hooks.beforeRead?.(p);
    const now = sha256Hex(readFileSync(p));
    if (now !== s.sha256) throw new Error(`the verified sample changed before it was read: sha256 ${now}, pinned ${s.sha256}`);
    return await read(p);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

type PrefetchCase = { id: string; path: string; sha256?: string };

// --prefetch: make sure the cache holds the verified sample of every case; one at a time. Returns the ids that failed.
export async function prefetchAll(cases: PrefetchCase[], cacheDir: string, o: { getter?: Getter; warn?: (m: string) => void; log?: (m: string) => void; budget?: Parameters<typeof budgetedGetter>[0] } = {}): Promise<string[]> {
  const log = o.log ?? ((m) => console.log(m));
  const warn = o.warn ?? ((m) => console.warn(m));
  const failed: string[] = [];
  for (const c of cases) {
    try {
      const pin = requirePin(c);
      const chain = cacheChain(cacheDir, pin, c.path);
      const cp = chainProblem(chain);
      if (cp) throw new Error(cp);
      if (checkZipDir(chain, pin).kind === "ok") {
        log(`sample ${c.id}: cache sha256:${pin}`);
        continue;
      }
      const { name, bytes } = await fetchVerified(c.path, pin, o.getter ?? budgetedGetter(o.budget));
      if (!storeInCache(cacheDir, pin, c.path, name, bytes, warn)) throw new Error("the cache could not be written");
      // The same lookup an offline run makes: an entry it cannot use (a second zip, a directory named *.zip) is a failure here, left in place.
      const again = checkZipDir(chain, pin);
      if (again.kind !== "ok") throw new Error(`the cache entry cannot be used by an offline run: ${again.kind === "bad" ? again.problem : "no zip after the write"}`);
      log(`sample ${c.id}: fetched sha256:${pin}`);
    } catch (e) {
      failed.push(c.id);
      warn(`prefetch ${c.id} failed: ${msg(e)}`);
    }
  }
  return failed;
}

// --prefetch --verify-pins: fetch every sample fresh (the cache is not read or written) and compare its sha256 with the pin, one at a
// time. One line per case. Returns the ids whose pin does not match or whose fetch failed.
export async function verifyPins(cases: PrefetchCase[], o: { getter?: Getter; warn?: (m: string) => void; log?: (m: string) => void; budget?: Parameters<typeof budgetedGetter>[0] } = {}): Promise<string[]> {
  const log = o.log ?? ((m) => console.log(m));
  const warn = o.warn ?? ((m) => console.warn(m));
  const failed: string[] = [];
  for (const c of cases) {
    try {
      const pin = requirePin(c);
      const got = sha256Hex((await fetchOnce(c.path, o.getter ?? budgetedGetter(o.budget))).bytes); // a fresh budget for each case
      if (got === pin) log(`pin ${c.id}: match sha256:${pin}`);
      else { failed.push(c.id); warn(`pin ${c.id}: MISMATCH pinned ${pin}, upstream ${got}`); }
    } catch (e) {
      failed.push(c.id);
      warn(`pin ${c.id}: failed: ${msg(e)}`);
    }
  }
  return failed;
}
