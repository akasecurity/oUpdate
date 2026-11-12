import { afterEach, expect, test } from "bun:test";
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getWithBackoff, get, HttpError, parseRetryAfter } from "../acceptance/http.ts";
import { budgetedGetter, PATH_MARKER, pathKey, prefetchAll, readVerifiedSample, SAMPLE_BUDGET_MS, sampleZip, sha256Hex, verifyPins, writeAtomic, type Getter } from "../acceptance/samples.ts";

const RUN_PATH = join(import.meta.dir, "..", "acceptance", "run.ts");
const dirs: string[] = [];
const tmp = () => (dirs.push(mkdtempSync(join(tmpdir(), "samples-test-"))), dirs[dirs.length - 1]!);
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const enc = (s: string) => new TextEncoder().encode(s);
const same = (a: Uint8Array | Buffer, b: Uint8Array | Buffer) => Buffer.from(a).equals(Buffer.from(b));
const zipBytes = new Uint8Array([0x50, 0x4b, 3, 4, 0, 255, 1, 2, 9, 9, 9, 9]);
const pin = sha256Hex(zipBytes);
const RAW = "https://raw.githubusercontent.com/DataDog/x";

// A getter that serves a listing for each dataset path and the zip bytes for each path, and records its calls.
const fakeGetter = (files: Record<string, Uint8Array> = { p: zipBytes }, name = "pkg.zip") => {
  const calls: string[] = [];
  const getter: Getter = async (url) => {
    calls.push(url);
    if (url.startsWith(RAW)) return files[url.slice(RAW.length + 1)]!;
    const path = url.slice(url.indexOf("/samples/") + "/samples/".length);
    if (!(path in files)) throw new HttpError(404, url);
    return enc(JSON.stringify([{ name: "README.md", download_url: `${RAW}/readme` }, { name, download_url: `${RAW}/${path}` }]));
  };
  return { calls, getter };
};
const base = (extra: Partial<Parameters<typeof sampleZip>[0]> = {}) => ({ id: "c1", path: "p", sha256: pin, workDir: tmp(), cacheDir: tmp(), offline: false, warn: () => {}, ...extra });
const entryDir = (cacheDir: string, sha = pin, path = "p") => join(cacheDir, sha, pathKey(path));
const cacheFile = (cacheDir: string, sha = pin, name = "pkg.zip", path = "p") => join(entryDir(cacheDir, sha, path), name);
const seedCache = (cacheDir: string, bytes: Uint8Array, sha = pin, name = "pkg.zip", path = "p") => { mkdirSync(entryDir(cacheDir, sha, path), { recursive: true }); writeFileSync(cacheFile(cacheDir, sha, name, path), bytes); };

// ---- http: backoff ----
const resp = (status: number, headers: Record<string, string> = {}, body = "x") => new Response(body, { status, headers });
const stubFetch = (...rs: (Response | Error)[]) => {
  const seen: string[] = [];
  const fetchImpl = (async (u: string | URL | Request) => {
    seen.push(String(u));
    const r = rs.shift()!;
    if (r instanceof Error) throw r;
    return r;
  }) as unknown as typeof fetch;
  return { seen, fetchImpl };
};
const sleeps = () => { const delays: number[] = []; return { delays, sleep: async (ms: number) => void delays.push(ms) }; };
const U = "http://x.example/a";
// A sleep that advances the same clock the getter reads, as a real wait does.
const clocked = () => { let t = 0; return { now: () => t, sleep: async (ms: number) => void (t += ms) }; };
const OLD = 20 * 60_000; // older than the 15 min after which a leftover temporary file is stale
const age = (file: string, ms: number) => { const t = new Date(Date.now() - ms); utimesSync(file, t, t); };

test("backoff: a 403 waits, the delay doubles, then the download succeeds", async () => {
  const { fetchImpl, seen } = stubFetch(resp(403, { "retry-after": "0" }), resp(403, { "retry-after": "0" }), resp(403, { "retry-after": "0" }), resp(200, {}, "ok"));
  const { delays, sleep } = sleeps();
  expect(new TextDecoder().decode(await getWithBackoff(U, { fetchImpl, sleep, random: () => 0 }))).toBe("ok");
  expect(seen.length).toBe(4);
  expect(delays).toEqual([2000, 4000, 8000]);
});

test("backoff: jitter adds up to 20 percent", async () => {
  const { fetchImpl } = stubFetch(resp(500), resp(200));
  const { delays, sleep } = sleeps();
  await getWithBackoff(U, { fetchImpl, sleep, random: () => 1 });
  expect(delays).toEqual([2400]);
});

test("backoff: 429, 5xx and a network error retry; a 404 does not", async () => {
  const { fetchImpl, seen } = stubFetch(resp(429), resp(503), new TypeError("connection reset"), resp(200, {}, "ok"));
  const { delays, sleep } = sleeps();
  await getWithBackoff(U, { fetchImpl, sleep, random: () => 0 });
  expect(seen.length).toBe(4);
  expect(delays).toEqual([2000, 4000, 8000]);
  const nf = stubFetch(resp(404));
  const s2 = sleeps();
  await expect(getWithBackoff(U, { fetchImpl: nf.fetchImpl, sleep: s2.sleep })).rejects.toThrow(`404 ${U}`);
  expect(s2.delays).toEqual([]);
});

test("backoff: a malformed url fails at once, with no fetch and no wait", async () => {
  const { fetchImpl, seen } = stubFetch(resp(200));
  const { delays, sleep } = sleeps();
  await expect(getWithBackoff("not a url", { fetchImpl, sleep })).rejects.toBeInstanceOf(TypeError);
  expect(seen.length).toBe(0);
  expect(delays).toEqual([]);
});

test("backoff: Retry-After longer than the delay is honored and clamped to 60 s", async () => {
  const { fetchImpl } = stubFetch(resp(429, { "retry-after": "7" }), resp(403, { "retry-after": "99999" }), resp(500), resp(200));
  const { delays, sleep } = sleeps();
  await getWithBackoff(U, { fetchImpl, sleep, random: () => 0, totalMs: 200_000 }); // a bigger call budget, so the 60 s wait itself fits
  expect(delays).toEqual([7000, 60_000, 8000]); // 99999 s is clamped to the 60 s cap
});

test("backoff: a Retry-After that is zero, negative, fractional, a past date or garbage never gives less than the doubling delay", async () => {
  const now = Date.parse("2026-01-01T00:00:00Z");
  for (const ra of ["0", "-1", "1.5", "soon", "Thu, 01 Jan 2015 00:00:00 GMT", "2026-01-01"]) {
    const { fetchImpl } = stubFetch(resp(429, { "retry-after": ra }), resp(200));
    const { delays, sleep } = sleeps();
    await getWithBackoff(U, { fetchImpl, sleep, random: () => 0 });
    expect(delays).toEqual([2000]);
  }
  expect(parseRetryAfter("3", now)).toBe(3000);
  expect(parseRetryAfter("Thu, 01 Jan 2026 00:00:10 GMT", now)).toBe(10_000);
  for (const bad of ["1.5", "-1", "soon", "1e3", "01 Jan 2026", "2026-01-01T00:00:10Z"]) expect(parseRetryAfter(bad, now)).toBeUndefined();
});

test("backoff: a 403 with x-ratelimit-remaining 0 waits until the reset when it is within the cap", async () => {
  const now = Date.parse("2026-01-01T00:00:00Z");
  const reset = String(now / 1000 + 30);
  const { fetchImpl, seen } = stubFetch(resp(403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": reset }), resp(200));
  const { delays, sleep } = sleeps();
  await getWithBackoff(U, { fetchImpl, sleep, random: () => 0, wallNow: () => now });
  expect(seen.length).toBe(2);
  expect(delays).toEqual([31_000]);
});

test("backoff: a 403 whose rate limit resets beyond the cap fails at once and says when", async () => {
  const now = Date.parse("2026-01-01T00:00:00Z");
  const { fetchImpl, seen } = stubFetch(resp(403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(now / 1000 + 3000) }), resp(200));
  const { delays, sleep } = sleeps();
  await expect(getWithBackoff(U, { fetchImpl, sleep, wallNow: () => now })).rejects.toThrow(/^rate limited until \d\d:\d\d: /);
  expect(seen.length).toBe(1);
  expect(delays).toEqual([]);
});

test("backoff: doubling stops at the cap and the run gives up after 4 attempts with a clear error", async () => {
  const { fetchImpl, seen } = stubFetch(...Array.from({ length: 8 }, () => resp(403, { "retry-after": "0" })));
  const { delays, sleep } = sleeps();
  await expect(getWithBackoff(U, { fetchImpl, sleep, random: () => 0, capMs: 5_000 })).rejects.toThrow(`gave up after 4 attempts: ${U}: 403 ${U}`);
  expect(seen.length).toBe(4);
  expect(delays).toEqual([2000, 4000, 5000]);
});

test("get keeps its status error type with the Retry-After and rate-limit headers", async () => {
  const { fetchImpl } = stubFetch(resp(403, { "retry-after": "5", "x-ratelimit-remaining": "0", "x-ratelimit-reset": "100" }));
  const e = await get(U, { fetchImpl }).catch((x) => x);
  expect(e).toBeInstanceOf(HttpError);
  expect(e.status).toBe(403);
  expect(e.retryAfterMs).toBe(5000);
  expect(e.rateLimit).toEqual({ remaining: 0, resetAtMs: 100_000 });
});

// ---- samples ----
test("a miss fetches once (listing and download), fills the cache by hash and the work dir; the next work dir is filled from the cache alone", async () => {
  const o = base();
  const { calls, getter } = fakeGetter();
  const r = await sampleZip({ ...o, getter });
  expect(r).toMatchObject({ file: join(o.workDir, "c1", "bad", "pkg.zip"), source: "fetched", sha256: pin });
  expect(calls.length).toBe(2);
  expect(same(readFileSync(cacheFile(o.cacheDir)), zipBytes)).toBe(true);
  expect(same(readFileSync(r.file!), zipBytes)).toBe(true);
  const w2 = tmp();
  const r2 = await sampleZip({ ...o, workDir: w2, getter });
  expect(r2.source).toBe("cache");
  expect(r2.file).toBe(join(w2, "c1", "bad", "pkg.zip"));
  expect(calls.length).toBe(2);
  expect(same(readFileSync(r2.file!), zipBytes)).toBe(true);
});

test("a sample in the work dir with the pinned hash is used as it is, with no cache and no fetch", async () => {
  const o = base({ offline: true });
  mkdirSync(join(o.workDir, "c1", "bad"), { recursive: true });
  writeFileSync(join(o.workDir, "c1", "bad", "mine.zip"), zipBytes);
  const { calls, getter } = fakeGetter();
  const r = await sampleZip({ ...o, getter });
  expect(r).toMatchObject({ file: join(o.workDir, "c1", "bad", "mine.zip"), source: "work", sha256: pin });
  expect(calls.length).toBe(0);
});

test("a work file with the wrong hash is replaced online and refused offline", async () => {
  const o = base();
  const bad = join(o.workDir, "c1", "bad");
  mkdirSync(bad, { recursive: true });
  writeFileSync(join(bad, "old.zip"), "OLD");
  await expect(sampleZip({ ...o, offline: true, getter: fakeGetter().getter })).rejects.toThrow(/offline: no sample for c1.*work: .*old\.zip has sha256/);
  const r = await sampleZip({ ...o, getter: fakeGetter().getter });
  expect(r.source).toBe("fetched");
  expect(readdirSync(bad)).toEqual(["pkg.zip"]); // the work bad dir holds only the zip; the wrong one was renamed aside into .meta, not deleted
  const meta = join(o.workDir, "c1", ".meta");
  const aside = readdirSync(meta).find((f) => f.startsWith("old.zip.") && f.endsWith(".bad"))!;
  expect(readFileSync(join(meta, aside), "utf8")).toBe("OLD");
  expect(same(readFileSync(r.file!), zipBytes)).toBe(true);
});

test("--offline with no sample refuses, naming the case, the cache and the work dir, and fetches nothing", async () => {
  const o = base({ offline: true });
  const { calls, getter } = fakeGetter();
  await expect(sampleZip({ ...o, getter })).rejects.toThrow(
    `offline: no sample for c1 (dataset path p) with sha256 ${pin} in cache ${o.cacheDir} or work ${join(o.workDir, "c1", "bad")}; run once without --offline or with --prefetch to fill the cache`,
  );
  expect(calls.length).toBe(0);
});

test("--offline reads a sample the cache holds", async () => {
  const o = base({ offline: true });
  seedCache(o.cacheDir, zipBytes);
  const r = await sampleZip({ ...o, getter: async () => { throw new Error("no fetch"); } });
  expect(r.source).toBe("cache");
  expect(same(readFileSync(r.file!), zipBytes)).toBe(true);
});

test("row path change: a cache filled for the old bytes is not served for a case whose path and pin changed", async () => {
  const oldBytes = enc("OLD zip bytes");
  const o = base();
  seedCache(o.cacheDir, oldBytes, sha256Hex(oldBytes)); // what the old pin cached
  const { getter } = fakeGetter({ "new/path": zipBytes });
  const r = await sampleZip({ ...o, path: "new/path", getter });
  expect(r.source).toBe("fetched");
  expect(same(readFileSync(r.file!), zipBytes)).toBe(true);
  // a pin that no longer matches what the new path serves fails loudly instead of using anything stale
  const stale = sha256Hex(enc("pin of nothing"));
  await expect(sampleZip({ ...base({ cacheDir: o.cacheDir }), sha256: stale, path: "new/path", getter })).rejects.toThrow(/fetched bytes have sha256 .* twice, pinned/);
});

test("row planted file: wrong bytes in the cache entry are replaced online and refused offline", async () => {
  const o = base();
  seedCache(o.cacheDir, enc("PLANTED"));
  await expect(sampleZip({ ...o, offline: true, getter: fakeGetter().getter })).rejects.toThrow(/offline: .*cache: .*pkg\.zip has sha256/);
  const { calls, getter } = fakeGetter();
  const r = await sampleZip({ ...o, getter });
  expect(r.source).toBe("fetched");
  expect(calls.length).toBe(2);
  expect(same(readFileSync(r.file!), zipBytes)).toBe(true);
  expect(same(readFileSync(cacheFile(o.cacheDir)), zipBytes)).toBe(true); // the cache is repaired
});

test("row symlink: a symlink in the cache is not followed even when its target has the right bytes; online replaces the link, offline refuses", async () => {
  const o = base();
  const target = join(tmp(), "target.zip");
  writeFileSync(target, zipBytes);
  mkdirSync(entryDir(o.cacheDir), { recursive: true });
  symlinkSync(target, cacheFile(o.cacheDir));
  await expect(sampleZip({ ...o, offline: true, getter: fakeGetter().getter })).rejects.toThrow(/not a regular file/);
  const r = await sampleZip({ ...o, getter: fakeGetter().getter });
  expect(r.source).toBe("fetched");
  expect(lstatSync(cacheFile(o.cacheDir)).isFile()).toBe(true);
  expect(same(readFileSync(target), zipBytes)).toBe(true); // the link's target was not written through
  // a symlink in the work dir is refused the same way
  const w = base();
  mkdirSync(join(w.workDir, "c1", "bad"), { recursive: true });
  symlinkSync(target, join(w.workDir, "c1", "bad", "l.zip"));
  const r2 = await sampleZip({ ...w, getter: fakeGetter().getter });
  expect(r2.source).toBe("fetched");
  expect(lstatSync(r2.file!).isFile()).toBe(true);
});

test("row truncated body: a short 200 is never cached or used; one re-fetch that is whole succeeds, two short ones fail loudly", async () => {
  const short = zipBytes.slice(0, 5);
  const o = base();
  let n = 0;
  const whole = fakeGetter().getter;
  const flaky: Getter = async (url, opts) => (url.startsWith(RAW) && n++ === 0 ? short : whole(url, opts));
  const ok = await sampleZip({ ...o, getter: flaky });
  expect(same(readFileSync(ok.file!), zipBytes)).toBe(true);
  const o2 = base();
  const { getter } = fakeGetter({ p: short });
  await expect(sampleZip({ ...o2, getter })).rejects.toThrow(/fetched bytes have sha256 .* twice, pinned/);
  expect(existsSync(join(o2.cacheDir, pin))).toBe(false);
  expect(existsSync(join(o2.workDir, "c1", "bad"))).toBe(false);
});

test("a .DS_Store or a leftover .tmp beside the zip is ignored; two zips in one entry are refused", async () => {
  const o = base({ offline: true });
  seedCache(o.cacheDir, zipBytes);
  writeFileSync(join(entryDir(o.cacheDir), ".DS_Store"), "junk");
  writeFileSync(join(entryDir(o.cacheDir), "pkg.zip.123.tmp"), "junk");
  expect((await sampleZip(o)).source).toBe("cache");
  writeFileSync(join(entryDir(o.cacheDir), "other.zip"), zipBytes);
  await expect(sampleZip({ ...o, workDir: tmp() })).rejects.toThrow(/more than one zip/);
});

test("a case without a pin is refused", async () => {
  await expect(sampleZip({ ...base({ sha256: undefined }), getter: fakeGetter().getter })).rejects.toThrow("case c1: no sha256 pin in cases.json");
});

test("a download url off raw.githubusercontent.com, or an unsafe file name, is refused", async () => {
  const lst = (name: string, url: string): Getter => async () => enc(JSON.stringify([{ name, download_url: url }]));
  await expect(sampleZip({ ...base(), getter: lst("pkg.zip", "https://evil.example/pkg.zip") })).rejects.toThrow("is not on https://raw.githubusercontent.com");
  await expect(sampleZip({ ...base(), getter: lst("pkg.zip", "http://raw.githubusercontent.com/pkg.zip") })).rejects.toThrow("is not on https://raw.githubusercontent.com");
  await expect(sampleZip({ ...base(), getter: lst("../pkg.zip", `${RAW}/x`) })).rejects.toThrow("unsafe file name");
});

test("a cache that cannot be written warns and the case still gets its sample in the work dir", async () => {
  const o = base();
  const blocker = join(tmp(), "file");
  writeFileSync(blocker, "not a dir");
  const warned: string[] = [];
  const r = await sampleZip({ ...o, cacheDir: blocker, warn: (m) => warned.push(m), getter: fakeGetter().getter });
  expect(r.source).toBe("fetched");
  expect(same(readFileSync(r.file!), zipBytes)).toBe(true);
  expect(warned.some((m) => m.includes("cannot write the sample cache"))).toBe(true);
});

test("a rename that fails removes the temporary file", () => {
  const d = tmp();
  mkdirSync(join(d, "target.zip")); // renaming a file over a directory fails after the temporary file was written
  expect(() => writeAtomic(join(d, "target.zip"), zipBytes)).toThrow();
  expect(readdirSync(d)).toEqual(["target.zip"]);
});

test("two shards filling the same sample at once, both fetching before either stores, both succeed and leave one whole zip", async () => {
  const cacheDir = tmp();
  let arrived = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const { getter } = fakeGetter();
  const slow: Getter = async (url, opts) => {
    const b = await getter(url, opts);
    if (url.startsWith(RAW)) { if (++arrived === 2) release(); await gate; } // a download only returns once both are in flight
    return b;
  };
  const [a, b] = await Promise.all([sampleZip({ ...base({ cacheDir }), getter: slow }), sampleZip({ ...base({ cacheDir }), getter: slow })]);
  expect(a.source).toBe("fetched");
  expect(b.source).toBe("fetched");
  expect(arrived).toBe(2);
  expect(readdirSync(entryDir(cacheDir))).toEqual(["pkg.zip"]);
  expect(same(readFileSync(cacheFile(cacheDir)), zipBytes)).toBe(true);
});

test("prefetch: serial, skips what the cache holds, catches per case, and returns every failed id", async () => {
  const cacheDir = tmp();
  const other = enc("second");
  const logs: string[] = [];
  const warned: string[] = [];
  seedCache(cacheDir, zipBytes);
  const { calls, getter } = fakeGetter({ p2: other });
  const failed = await prefetchAll(
    [
      { id: "have", path: "p", sha256: pin },
      { id: "new", path: "p2", sha256: sha256Hex(other) },
      { id: "gone", path: "missing", sha256: sha256Hex(enc("x")) },
      { id: "unpinned", path: "p2" },
      { id: "after", path: "p2", sha256: sha256Hex(other) },
    ],
    cacheDir,
    { getter, log: (m) => logs.push(m), warn: (m) => warned.push(m) },
  );
  expect(failed).toEqual(["gone", "unpinned"]);
  expect(logs).toEqual([`sample have: cache sha256:${pin}`, `sample new: fetched sha256:${sha256Hex(other)}`, `sample after: cache sha256:${sha256Hex(other)}`]);
  expect(calls.length).toBe(3); // new: listing and download; gone: one listing that answers 404
  expect(warned.length).toBe(2);
  expect(existsSync(cacheFile(cacheDir, sha256Hex(other), "pkg.zip", "p2"))).toBe(true);
});

// ---- round 2 ----
test("row symlinked dirs: a sha dir, the cache root or the work bad dir that is a symbolic link is never read, emptied or written through", async () => {
  const keep = tmp();
  writeFileSync(join(keep, "unrelated.zip"), "KEEP");
  writeFileSync(join(keep, "notes.txt"), "KEEP");
  const snapshot = () => readdirSync(keep).sort().join(",");
  // the sha dir
  const o = base();
  symlinkSync(keep, join(o.cacheDir, pin));
  const r = await sampleZip({ ...o, getter: fakeGetter().getter });
  expect(r.source).toBe("fetched");
  expect(same(r.bytes, zipBytes)).toBe(true);
  expect(snapshot()).toBe("notes.txt,unrelated.zip");
  expect(readFileSync(join(keep, "unrelated.zip"), "utf8")).toBe("KEEP");
  // the cache root
  const o2 = base();
  const root = join(tmp(), "samples");
  symlinkSync(keep, root);
  await sampleZip({ ...o2, cacheDir: root, getter: fakeGetter().getter });
  expect(snapshot()).toBe("notes.txt,unrelated.zip");
  // <work>/<id>/bad, with a wrong zip behind the link
  const o3 = base();
  mkdirSync(join(o3.workDir, "c1"), { recursive: true });
  symlinkSync(keep, join(o3.workDir, "c1", "bad"));
  const r3 = await sampleZip({ ...o3, getter: fakeGetter().getter });
  expect(same(r3.bytes, zipBytes)).toBe(true);
  expect(r3.file).toBeUndefined(); // not kept in a linked dir
  expect(snapshot()).toBe("notes.txt,unrelated.zip");
  // offline refuses a linked cache dir instead of reading through it
  const o4 = base({ offline: true });
  writeFileSync(join(keep, "pkg.zip"), zipBytes);
  symlinkSync(keep, join(o4.cacheDir, pin));
  await expect(sampleZip(o4)).rejects.toThrow(/is a symbolic link/);
});

test.skipIf(process.getuid?.() === 0)("row unreadable cache zip: an unreadable file is a miss that is fetched, not an abort", async () => {
  const o = base();
  seedCache(o.cacheDir, zipBytes);
  chmodSync(cacheFile(o.cacheDir), 0o000);
  const warned: string[] = [];
  const r = await sampleZip({ ...o, warn: (m) => warned.push(m), getter: fakeGetter().getter });
  expect(r.source).toBe("fetched");
  expect(warned.some((m) => m.includes("cannot read"))).toBe(true);
  await expect(sampleZip({ ...base({ cacheDir: o.cacheDir, offline: true }), getter: fakeGetter().getter })).resolves.toBeDefined(); // repaired by the fetch above
});

test("row 429 with remaining 0 and a far reset fails at once", async () => {
  const now = Date.parse("2026-01-01T00:00:00Z");
  const { fetchImpl, seen } = stubFetch(resp(429, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(now / 1000 + 40 * 60) }), resp(200));
  const { delays, sleep } = sleeps();
  await expect(getWithBackoff(U, { fetchImpl, sleep, wallNow: () => now })).rejects.toThrow(/^rate limited until \d\d:\d\d: /);
  expect(seen.length).toBe(1);
  expect(delays).toEqual([]);
});

test("row path-only change: the same pin with a new dataset path misses a warm cache and a warm work dir and is fetched from the new path", async () => {
  const o = base();
  const old = fakeGetter({ "old/path": zipBytes });
  await sampleZip({ ...o, path: "old/path", getter: old.getter });
  expect(existsSync(cacheFile(o.cacheDir, pin, "pkg.zip", "old/path"))).toBe(true);
  // same cache, same work dir, new path
  const next = fakeGetter({ "new/path": zipBytes });
  const r = await sampleZip({ ...o, path: "new/path", getter: next.getter });
  expect(r.source).toBe("fetched");
  expect(next.calls.length).toBe(2);
  expect(existsSync(cacheFile(o.cacheDir, pin, "pkg.zip", "new/path"))).toBe(true);
  expect(readFileSync(join(o.workDir, "c1", ".meta", "dataset-path.txt"), "utf8").trim()).toBe("new/path");
  // offline refuses the stale entry
  const o2 = base();
  await sampleZip({ ...o2, path: "old/path", getter: old.getter });
  await expect(sampleZip({ ...o2, path: "new/path", offline: true })).rejects.toThrow(/was fetched for dataset path old\/path, the case now says new\/path/);
  // and a path that now serves other bytes than the unchanged pin fails loudly
  const o3 = base();
  await sampleZip({ ...o3, path: "old/path", getter: old.getter });
  await expect(sampleZip({ ...o3, path: "other/path", getter: fakeGetter({ "other/path": enc("different") }).getter })).rejects.toThrow(/twice, pinned/);
});

test("a wrong zip in the work dir is moved aside with a printed line, never deleted", async () => {
  const o = base();
  const bad = join(o.workDir, "c1", "bad");
  mkdirSync(bad, { recursive: true });
  writeFileSync(join(bad, "mine.zip"), "MINE");
  const warned: string[] = [];
  await sampleZip({ ...o, warn: (m) => warned.push(m), getter: fakeGetter().getter });
  expect(warned.some((m) => m.includes("moved") && m.includes("mine.zip") && m.includes(".meta"))).toBe(true);
  const meta = join(o.workDir, "c1", ".meta");
  expect(readdirSync(meta).some((f) => f.startsWith("mine.zip.") && f.endsWith(".bad") && readFileSync(join(meta, f), "utf8") === "MINE")).toBe(true);
});

test("the review reads a private copy of the verified bytes, re-hashed just before the read", async () => {
  const o = base();
  const s = await sampleZip({ ...o, getter: fakeGetter().getter });
  writeFileSync(s.file!, "SWAPPED AFTER THE CHECK"); // the work file changes after verification
  let seenPath = "";
  const got = await readVerifiedSample(s, async (p) => ((seenPath = p), readFileSync(p)));
  expect(same(got, zipBytes)).toBe(true);
  expect(existsSync(seenPath)).toBe(false); // the private copy is removed
  await expect(readVerifiedSample(s, async () => "never", { beforeRead: (p) => writeFileSync(p, "tampered") })).rejects.toThrow(/changed before it was read/);
});

test("run.ts reviews the verified bytes, not the work-dir path", () => {
  const src = readFileSync(RUN_PATH, "utf8");
  expect(src).toContain("readVerifiedSample(sample, (zip) => readSample(zip,");
  expect(src).not.toMatch(/readSample\(sample\.file/);
});

test("backoff: a missing host, a certificate error and a bug fail at once; a reset connection retries", async () => {
  const withCode = (code: string, message: string) => Object.assign(new Error(message), { code });
  for (const e of [withCode("ENOTFOUND", "getaddrinfo ENOTFOUND x.example"), withCode("CERT_HAS_EXPIRED", "certificate has expired"), new TypeError("boom")]) {
    const { fetchImpl, seen } = stubFetch(e, resp(200));
    const { delays, sleep } = sleeps();
    await expect(getWithBackoff(U, { fetchImpl, sleep })).rejects.toThrow();
    expect(seen.length).toBe(1);
    expect(delays).toEqual([]);
  }
  const { fetchImpl, seen } = stubFetch(withCode("ECONNRESET", "socket hang up"), resp(200));
  await getWithBackoff(U, { fetchImpl, sleep: sleeps().sleep });
  expect(seen.length).toBe(2);
});

test("backoff: the whole call is bounded by a time budget", async () => {
  let t = 0;
  const { fetchImpl, seen } = stubFetch(...Array.from({ length: 8 }, () => resp(500)));
  const delays: number[] = [];
  await expect(getWithBackoff(U, { fetchImpl, sleep: async (ms) => void ((t += ms), delays.push(ms)), now: () => t, random: () => 0, totalMs: 7000 })).rejects.toThrow(`gave up after 3 attempts: ${U}: 500 ${U}`);
  expect(delays).toEqual([2000, 4000]); // the next wait (8 s) would pass the budget
  expect(seen.length).toBe(3);
});

test("a stale temporary file of a zip is removed when the entry is written; a fresh one, and any other name, are kept", async () => {
  const o = base();
  const dir = entryDir(o.cacheDir);
  mkdirSync(dir, { recursive: true });
  const old = join(dir, "pkg.zip.2147483646.abc123.tmp");
  const fresh = join(dir, `pkg.zip.${process.ppid}.abc123.tmp`);
  const notes = join(dir, "notes.123.ab.tmp");
  for (const f of [old, fresh, notes]) writeFileSync(f, "x");
  age(old, OLD);
  age(notes, OLD);
  await sampleZip({ ...o, getter: fakeGetter().getter });
  expect(existsSync(old)).toBe(false);
  expect(existsSync(fresh)).toBe(true);
  expect(existsSync(notes)).toBe(true);
});

test("verifyPins compares each pin with a fresh fetch, serially, and reports every mismatch", async () => {
  const logs: string[] = [], warned: string[] = [];
  const { getter } = fakeGetter({ p: zipBytes, q: enc("changed upstream") });
  const failed = await verifyPins([{ id: "ok", path: "p", sha256: pin }, { id: "moved", path: "q", sha256: pin }, { id: "gone", path: "nope", sha256: pin }, { id: "after", path: "p", sha256: pin }], { getter, log: (m) => logs.push(m), warn: (m) => warned.push(m) });
  expect(failed).toEqual(["moved", "gone"]);
  expect(logs).toEqual([`pin ok: match sha256:${pin}`, `pin after: match sha256:${pin}`]);
  expect(warned[0]).toContain("MISMATCH");
});

// ---- round 3 ----
// Every directory level that sampleZip reads or writes. A level that is replaced by a symbolic link must never be read, emptied or
// written through, online or offline. The rows are generated from this list, so a new level gets its rows by being added here.
type Setup = { workDir: string; cacheDir: string };
const LEVELS: { name: string; path: (s: Setup) => string; side: "work" | "cache"; onZipPath: boolean }[] = [
  { name: "work root", path: (s) => s.workDir, side: "work", onZipPath: true },
  { name: "work/<id>", path: (s) => join(s.workDir, "c1"), side: "work", onZipPath: true },
  { name: "work/<id>/bad", path: (s) => join(s.workDir, "c1", "bad"), side: "work", onZipPath: true },
  { name: "work/<id>/.meta", path: (s) => join(s.workDir, "c1", ".meta"), side: "work", onZipPath: true },
  { name: "cache root", path: (s) => s.cacheDir, side: "cache", onZipPath: true },
  { name: "cache/<sha>", path: (s) => join(s.cacheDir, pin), side: "cache", onZipPath: true },
  { name: "cache/<sha>/<path key>", path: (s) => entryDir(s.cacheDir), side: "cache", onZipPath: true },
];
// Every file under dir with its content, to see that nothing was added, removed or changed.
const snapshotOf = (dir: string): string => {
  const out: string[] = [];
  const walk = (d: string) => { for (const f of readdirSync(d).sort()) { const p = join(d, f); if (lstatSync(p).isDirectory()) { out.push(`${p}/`); walk(p); } else out.push(`${p}=${readFileSync(p).toString("hex")}`); } };
  walk(dir);
  return out.join("\n");
};
const stripZips = (dir: string) => { for (const f of readdirSync(dir, { recursive: true }) as string[]) if (f.endsWith(".zip")) rmSync(join(dir, f), { force: true }); };

for (const level of LEVELS) {
  for (const mode of ["online", "offline"] as const) {
    test(`row linked level: ${level.name} as a symbolic link, ${mode}: the link target is untouched`, async () => {
      const s: Setup = { workDir: join(tmp(), "work"), cacheDir: join(tmp(), "cache") };
      const { getter } = fakeGetter();
      await sampleZip({ id: "c1", path: "p", sha256: pin, ...s, offline: false, warn: () => {}, getter }); // fills every level with real directories
      // online: the sample is available elsewhere so the case can go on; offline: nothing else holds it, so the link is the only copy
      if (mode === "offline") rmSync(level.side === "work" ? s.cacheDir : join(s.workDir, "c1"), { recursive: true, force: true });
      else if (level.side === "cache") rmSync(join(s.workDir, "c1"), { recursive: true, force: true });
      const real = level.path(s);
      expect(existsSync(real)).toBe(true);
      const victim = join(tmp(), "victim");
      cpSync(real, victim, { recursive: true });
      if (mode === "online") stripZips(victim); // a write through the link would show as a new zip
      writeFileSync(join(victim, "canary.txt"), "CANARY");
      const before = snapshotOf(victim);
      renameSync(real, `${real}.real`);
      symlinkSync(victim, real);
      const out = await sampleZip({ id: "c1", path: "p", sha256: pin, ...s, offline: mode === "offline", warn: () => {}, getter }).then((r) => r, (e) => e as Error);
      expect(snapshotOf(victim)).toBe(before);
      if (mode === "offline" && level.onZipPath) expect(out).toBeInstanceOf(Error);
      else { expect(out).not.toBeInstanceOf(Error); expect(same((out as { bytes: Uint8Array }).bytes, zipBytes)).toBe(true); }
    });
  }
}

test("row marker: a cache entry written by an earlier layout (no path key) is a miss: offline fails naming the dataset path, online fetches", async () => {
  const o = base();
  mkdirSync(join(o.cacheDir, pin), { recursive: true });
  writeFileSync(join(o.cacheDir, pin, "pkg.zip"), zipBytes); // right bytes, right sha dir, but not under this path's key
  await expect(sampleZip({ ...o, offline: true })).rejects.toThrow(/offline: no sample for c1 \(dataset path p\)/);
  const r = await sampleZip({ ...o, getter: fakeGetter().getter });
  expect(r.source).toBe("fetched");
  expect(existsSync(cacheFile(o.cacheDir))).toBe(true);
});

test("row marker: a work zip with no path marker is used (its hash pins it); a marker that is a directory does not move a good zip aside, run after run", async () => {
  const o = base({ offline: true });
  const bad = join(o.workDir, "c1", "bad");
  mkdirSync(bad, { recursive: true });
  writeFileSync(join(bad, "mine.zip"), zipBytes); // as left by an earlier version or by hand
  expect((await sampleZip(o)).source).toBe("work");
  mkdirSync(join(o.workDir, "c1", ".meta", "dataset-path.txt"), { recursive: true });
  for (let i = 0; i < 3; i++) expect((await sampleZip(o)).source).toBe("work");
  expect(readdirSync(join(o.workDir, "c1", ".meta"))).toEqual(["dataset-path.txt"]);
  expect(readdirSync(bad)).toEqual(["mine.zip"]);
});

test("row aside names: two wrong zips moved aside in the same millisecond are both kept", async () => {
  const realNow = Date.now;
  Date.now = () => 1_700_000_000_000;
  try {
    const o = base();
    for (let i = 0; i < 2; i++) {
      const bad = join(o.workDir, "c1", "bad");
      rmSync(bad, { recursive: true, force: true });
      mkdirSync(bad, { recursive: true });
      writeFileSync(join(bad, "mine.zip"), `MINE ${i}`);
      await sampleZip({ ...o, getter: fakeGetter().getter });
    }
    const kept = readdirSync(join(o.workDir, "c1", ".meta")).filter((f) => f.endsWith(".bad")).map((f) => readFileSync(join(o.workDir, "c1", ".meta", f), "utf8")).sort();
    expect(kept).toEqual(["MINE 0", "MINE 1"]);
  } finally {
    Date.now = realNow;
  }
});

test("budget: the deadline cuts the request that is running and no request starts after it", async () => {
  const hang = (async (_u: unknown, init?: RequestInit) => new Promise<Response>((_res, rej) => {
    const sig = init?.signal;
    if (!sig) return;
    sig.addEventListener("abort", () => rej(sig.reason));
  })) as unknown as typeof fetch;
  const started = Date.now();
  await expect(getWithBackoff(U, { fetchImpl: hang, sleep: sleeps().sleep, random: () => 0, totalMs: 300 })).rejects.toThrow(/gave up after \d+ attempts/);
  expect(Date.now() - started).toBeLessThan(4000); // the default request limit is 120 s
});

test("budget: a sample whose budget is used starts no further request", async () => {
  let t = 0;
  const { fetchImpl, seen } = stubFetch(resp(200), resp(200));
  const g = budgetedGetter({ fetchImpl, sleep: sleeps().sleep, now: () => t, budgetMs: 1000 });
  await g(U);
  t = 1000;
  await expect(g(U)).rejects.toThrow(/gave up after 0 attempts.*budget of this sample is used/);
  expect(seen.length).toBe(1);
});

test("budget: the default per-sample budget is 60 s", () => {
  expect(SAMPLE_BUDGET_MS).toBe(60_000);
});

test("budget: the listing and the download of one sample share the budget, and a request is cut to the time left", async () => {
  let t = 0;
  const calls: string[] = [];
  const fetchImpl = (async (u: string | URL | Request, init?: RequestInit) => {
    calls.push(String(u));
    if (calls.length === 1) { t += 100; return resp(200); } // the listing takes 100 ms of the 300 ms budget
    return new Promise<Response>((_res, rej) => { init?.signal?.addEventListener("abort", () => rej(init.signal!.reason)); }); // the download never answers
  }) as unknown as typeof fetch;
  const g = budgetedGetter({ fetchImpl, sleep: sleeps().sleep, now: () => t, random: () => 0, budgetMs: 300 });
  await g(U);
  const started = Date.now();
  await expect(g("http://x.example/zip")).rejects.toThrow(/gave up after 1 attempts: http:\/\/x\.example\/zip: timed out after 0\.2 s/);
  expect(Date.now() - started).toBeLessThan(4000); // the request limit was cut from 120 s to the 200 ms left
  expect(calls.length).toBe(2);
});

test("budget: verify-pins gives every case its own budget", async () => {
  let t = 0;
  const lst = (path: string) => resp(200, {}, JSON.stringify([{ name: "pkg.zip", download_url: `${RAW}/${path}` }]));
  const { fetchImpl } = stubFetch(lst("p"), resp(200, {}, "x"), lst("p"), resp(200, {}, "x"));
  const inner = fetchImpl as unknown as (u: unknown, i?: RequestInit) => Promise<Response>;
  const wrapped = (async (u: string | URL | Request, init?: RequestInit) => { const r = await inner(u, init); if (String(u).startsWith(RAW)) t += 50_000; return r; }) as unknown as typeof fetch; // each case takes 50 s in all, so the two together pass one 60 s budget
  const warned: string[] = [];
  const failed = await verifyPins([{ id: "a", path: "p", sha256: sha256Hex(enc("x")) }, { id: "b", path: "p", sha256: sha256Hex(enc("x")) }], { warn: (m) => warned.push(m), log: () => {}, budget: { fetchImpl: wrapped, sleep: sleeps().sleep, now: () => t } });
  expect(warned).toEqual([]);
  expect(failed).toEqual([]);
});

// ---- stateless outage rule ----
test("row outage: 25 samples against a server that always answers 503 cost at most 60 s each and 4 attempts per call", async () => {
  const clock = clocked();
  let requests = 0;
  const fetchImpl = (async () => { requests++; return resp(503); }) as unknown as typeof fetch;
  const errs: string[] = [];
  for (let i = 0; i < 25; i++) {
    const before = requests, t0 = clock.now();
    await budgetedGetter({ fetchImpl, sleep: clock.sleep, now: clock.now, random: () => 0 })(U).catch((e) => errs.push((e as Error).message));
    expect(requests - before).toBeLessThanOrEqual(4);
    expect(clock.now() - t0).toBeLessThanOrEqual(60_000);
  }
  expect(errs.length).toBe(25);
  expect(errs.every((m) => m.includes(`gave up after 4 attempts: ${U}: 503 ${U}`))).toBe(true);
  expect(clock.now()).toBeLessThanOrEqual(25 * 60_000);
  expect(requests).toBe(100);
});

test("row flaky: [503, 200] succeeds on any sample, including one right after a sample that used every attempt", async () => {
  const clock = clocked();
  const mk = (rs: Response[]) => { const f = stubFetch(...rs); return { f, g: budgetedGetter({ fetchImpl: f.fetchImpl, sleep: clock.sleep, now: clock.now, random: () => 0 }) }; };
  const first = mk(Array.from({ length: 4 }, () => resp(503)));
  await expect(first.g(U)).rejects.toThrow("gave up after 4 attempts");
  for (let i = 0; i < 3; i++) {
    const s = mk([resp(503), resp(200, {}, "ok")]);
    expect(new TextDecoder().decode(await s.g(U))).toBe("ok");
    expect(s.f.seen.length).toBe(2);
  }
});

test("budget: a wall-clock step does not change a deadline (the default clock is monotonic)", async () => {
  const realNow = Date.now;
  let wall = realNow();
  Date.now = () => (wall += 3 * 3600_000); // every read of the wall clock jumps three hours, far past the call budget
  try {
    const { fetchImpl, seen } = stubFetch(...Array.from({ length: 4 }, () => resp(500)));
    await expect(getWithBackoff(U, { fetchImpl, sleep: sleeps().sleep, random: () => 0 })).rejects.toThrow("gave up after 4 attempts");
    expect(seen.length).toBe(4);
    const g = budgetedGetter({ ...stubFetch(resp(200)), sleep: sleeps().sleep });
    await g(U);
  } finally {
    Date.now = realNow;
  }
});

// ---- round 4 ----
const stale = (dir: string) => join(dir, "pkg.zip.2147483646.abc123.tmp");
const staleOld = (dir: string) => { writeFileSync(stale(dir), "partial"); age(stale(dir), OLD); };

test("row stale tmp: a leftover temporary file beside a verified work zip is removed (work hit, cache hit, failed install)", async () => {
  const o = base({ offline: true });
  const bad = join(o.workDir, "c1", "bad");
  mkdirSync(bad, { recursive: true });
  writeFileSync(join(bad, "pkg.zip"), zipBytes);
  staleOld(bad);
  expect((await sampleZip(o)).source).toBe("work");
  expect(existsSync(stale(bad))).toBe(false);
  expect(readdirSync(bad)).toEqual(["pkg.zip"]);
  // cache hit whose install fails (a .meta that is a file): the tmp is still removed
  const o2 = base({ offline: true });
  seedCache(o2.cacheDir, zipBytes);
  const bad2 = join(o2.workDir, "c1", "bad");
  mkdirSync(bad2, { recursive: true });
  writeFileSync(join(o2.workDir, "c1", ".meta"), "not a dir");
  staleOld(bad2);
  expect((await sampleZip(o2)).source).toBe("cache");
  expect(existsSync(stale(bad2))).toBe(false);
  // a fresh file of the right name and an old file of another name are kept; an old marker temp file in .meta is removed
  const fresh = join(bad, `pkg.zip.${process.ppid}.abc123.tmp`);
  const notes = join(bad, "notes.123.ab.tmp");
  writeFileSync(fresh, "x");
  writeFileSync(notes, "x");
  age(notes, OLD);
  await sampleZip(o);
  expect(existsSync(fresh)).toBe(true);
  expect(existsSync(notes)).toBe(true);
});

test("row stale tmp: the work dir's .meta loses an old marker temp file, not a fresh one", async () => {
  const o = base();
  const meta = join(o.workDir, "c1", ".meta");
  mkdirSync(meta, { recursive: true });
  const old = join(meta, `${PATH_MARKER}.2147483646.abc123.tmp`);
  const fresh = join(meta, `${PATH_MARKER}.2147483645.abc123.tmp`);
  writeFileSync(old, "x");
  writeFileSync(fresh, "x");
  age(old, OLD);
  await sampleZip({ ...o, getter: fakeGetter().getter });
  expect(existsSync(old)).toBe(false);
  expect(existsSync(fresh)).toBe(true);
});

test("row failed install: a wrong zip is not put back into bad/ and extract.ts says there is nothing to extract", async () => {
  const work = tmp();
  const id = "litellm-1.82.8";
  const o = { id, path: "p", sha256: pin, workDir: work, cacheDir: tmp(), offline: false, warn: () => {}, getter: fakeGetter().getter };
  const bad = join(work, id, "bad");
  mkdirSync(bad, { recursive: true });
  writeFileSync(join(bad, "old.zip"), "WRONG BYTES");
  writeFileSync(join(work, id, ".meta"), "a file, so the install fails");
  const r = await sampleZip(o);
  expect(r.file).toBeUndefined();
  expect(same(r.bytes, zipBytes)).toBe(true);
  expect(readdirSync(bad)).toEqual([]);
  expect(readdirSync(join(work, id)).some((f) => f.startsWith("old.zip.") && f.endsWith(".bad"))).toBe(true); // kept, not deleted
  const out = await extract(work);
  expect(out.out).toContain(`nothing to extract for ${id}`);
  expect(existsSync(join(work, id, "tree-bad"))).toBe(false);
});

test("row prefetch recheck: a cache entry that offline lookup cannot use is a prefetch failure and is left in place", async () => {
  const cacheDir = tmp();
  mkdirSync(join(entryDir(cacheDir), "junk.zip"), { recursive: true });
  const warned: string[] = [];
  const failed = await prefetchAll([{ id: "c1", path: "p", sha256: pin }], cacheDir, { getter: fakeGetter().getter, log: () => {}, warn: (m) => warned.push(m) });
  expect(failed).toEqual(["c1"]);
  expect(warned.join("\n")).toContain("more than one zip");
  expect(lstatSync(join(entryDir(cacheDir), "junk.zip")).isDirectory()).toBe(true);
  await expect(sampleZip({ id: "c1", path: "p", sha256: pin, workDir: tmp(), cacheDir, offline: true, warn: () => {} })).rejects.toThrow("more than one zip");
});

test("row .meta: a symbolic link .meta is refused loudly: online refetches without writing through, offline fails naming the link", async () => {
  const o = base();
  await sampleZip({ ...o, getter: fakeGetter().getter }); // work and cache filled
  const meta = join(o.workDir, "c1", ".meta");
  const victim = join(tmp(), "victim");
  mkdirSync(victim);
  writeFileSync(join(victim, PATH_MARKER), "other/path\n"); // a marker that would say another path, or none
  rmSync(meta, { recursive: true, force: true });
  symlinkSync(victim, meta);
  const warned: string[] = [];
  const online = await sampleZip({ ...o, warn: (m) => warned.push(m), getter: fakeGetter().getter });
  expect(online.source).toBe("cache"); // the work zip is not trusted with a marker that cannot be checked
  expect(warned.some((m) => m.includes("is a symbolic link"))).toBe(true);
  expect(readdirSync(victim)).toEqual([PATH_MARKER]);
  expect(readFileSync(join(victim, PATH_MARKER), "utf8")).toBe("other/path\n");
  // offline with the link as the only copy
  rmSync(o.cacheDir, { recursive: true, force: true });
  mkdirSync(join(o.workDir, "c1", "bad"), { recursive: true });
  writeFileSync(join(o.workDir, "c1", "bad", "pkg.zip"), zipBytes); // the work copy is the only one
  await expect(sampleZip({ ...o, offline: true })).rejects.toThrow(/is a symbolic link/);
});

test("row .meta: a .meta that is a file is refused the same way (online warns, offline fails)", async () => {
  const o = base();
  await sampleZip({ ...o, getter: fakeGetter().getter });
  const meta = join(o.workDir, "c1", ".meta");
  rmSync(meta, { recursive: true, force: true });
  writeFileSync(meta, "file");
  const warned: string[] = [];
  expect((await sampleZip({ ...o, warn: (m) => warned.push(m), getter: fakeGetter().getter })).source).toBe("cache");
  expect(warned.some((m) => m.includes("is not a directory"))).toBe(true);
  expect(readFileSync(meta, "utf8")).toBe("file");
  rmSync(o.cacheDir, { recursive: true, force: true });
  mkdirSync(join(o.workDir, "c1", "bad"), { recursive: true });
  writeFileSync(join(o.workDir, "c1", "bad", "pkg.zip"), zipBytes); // the work copy is the only one
  await expect(sampleZip({ ...o, offline: true })).rejects.toThrow(/is not a directory/);
});

test("a reader that runs while another shard is filling sees the whole zip or a clean miss, never part of one", async () => {
  const cacheDir = tmp(), workDir = tmp();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const { getter } = fakeGetter();
  const slow: Getter = async (url, opts) => { const b = await getter(url, opts); if (url.startsWith(RAW)) await gate; return b; };
  const filling = sampleZip({ ...base({ cacheDir }), getter: slow });
  for (let i = 0; i < 5; i++) {
    const r = await sampleZip({ id: "c1", path: "p", sha256: pin, workDir, cacheDir, offline: true, warn: () => {} }).then((x) => x, (e) => e as Error);
    if (r instanceof Error) expect(r.message).toContain("offline: no sample");
    else expect(same(r.bytes, zipBytes)).toBe(true);
  }
  release();
  await filling;
  expect((await sampleZip({ id: "c1", path: "p", sha256: pin, workDir, cacheDir, offline: true, warn: () => {} })).source).toBe("cache");
});

// extract.ts reads what run.ts left in <work>/<id>/bad, as it always did: any file there, not only a zip
const wheelFixture = (dir: string) => {
  const src = tmp();
  mkdirSync(join(src, "fx-1.0.dist-info"), { recursive: true });
  writeFileSync(join(src, "fx-1.0.dist-info", "METADATA"), "Name: fx\nVersion: 1.0\n");
  writeFileSync(join(src, "fx.py"), "x = 1\n");
  const out = join(dir, "package.whl");
  Bun.spawnSync(["bsdtar", "--format", "zip", "-cf", out, "-C", src, "."]);
  return out;
};
const EXTRACT = join(import.meta.dir, "..", "acceptance", "extract.ts");
const extract = async (work: string) => {
  const p = Bun.spawn([process.execPath, EXTRACT, "--work", work], { stdout: "pipe", stderr: "pipe" });
  const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
  return { out, code };
};

test("extract.ts: a bad side holding only package.whl is extracted, as before; an empty bad side says nothing was extracted", async () => {
  const work = tmp();
  const bad = join(work, "litellm-1.82.7", "bad");
  mkdirSync(bad, { recursive: true });
  wheelFixture(bad);
  mkdirSync(join(work, "litellm-1.82.7", ".meta"), { recursive: true });
  writeFileSync(join(work, "litellm-1.82.7", ".meta", "dataset-path.txt"), "p\n");
  mkdirSync(join(work, "litellm-1.82.8", "bad"), { recursive: true });
  const r = await extract(work);
  expect(r.out).toContain("extracted litellm-1.82.7");
  expect(readFileSync(join(work, "litellm-1.82.7", "tree-bad", "fx.py"), "utf8")).toBe("x = 1\n");
  expect(r.out).toContain("nothing to extract for litellm-1.82.8");
  expect(r.out).not.toContain("extracted litellm-1.82.8");
});

test("extract.ts: stale temporary files beside a verified zip are skipped; the tree comes from the zip", async () => {
  const work = tmp();
  const bad = join(work, "litellm-1.82.7", "bad");
  mkdirSync(bad, { recursive: true });
  renameSync(wheelFixture(bad), join(bad, "x.zip"));
  // leftovers of the writeAtomic name shape that sort before x.zip, so without the filter the first listed entry is a partial file
  for (let n = 1; n <= 8; n++) writeFileSync(join(bad, `a.zip.${n}.ab${n}c.tmp`), "partial");
  const r = await extract(work);
  expect(r.out).toContain("extracted litellm-1.82.7");
  expect(r.out).not.toContain("extract failed");
  expect(readFileSync(join(work, "litellm-1.82.7", "tree-bad", "fx.py"), "utf8")).toBe("x = 1\n");
});

test("extract.ts: a lone archive named fixture.tmp is still extracted, as before; only the writer's own temporary name is skipped", async () => {
  const work = tmp();
  const bad = join(work, "litellm-1.82.7", "bad");
  mkdirSync(bad, { recursive: true });
  renameSync(wheelFixture(bad), join(bad, "fixture.tmp"));
  const r = await extract(work);
  expect(r.out).toContain("extracted litellm-1.82.7");
  expect(readFileSync(join(work, "litellm-1.82.7", "tree-bad", "fx.py"), "utf8")).toBe("x = 1\n");
});

// ---- the pins in cases.json ----
const DATADOG = (JSON.parse(readFileSync(join(import.meta.dir, "..", "acceptance", "cases.json"), "utf8")) as { id: string; source?: { type: string; path?: string; sha256?: string } }[]).filter((c) => c.source?.type === "datadog");

test("every datadog case pins a 64-hex lowercase sha256", () => {
  expect(DATADOG.length).toBeGreaterThan(0);
  for (const c of DATADOG) expect(c.source!.sha256, c.id).toMatch(/^[0-9a-f]{64}$/);
});

// Opt-in, needs the network and the dataset: OUPDATE_LIVE_PINS=1 bun test test/acceptance-samples.test.ts
test.skipIf(!process.env.OUPDATE_LIVE_PINS)("every pin matches a fresh fetch of the live dataset (--prefetch --verify-pins --set all)", async () => {
  const r = await run(["--prefetch", "--verify-pins", "--set", "all"], tmp(), tmp());
  expect(r.err).toBe("");
  expect(r.out).toContain(`verify-pins: ${DATADOG.length} dataset samples in set all, ${DATADOG.length} match upstream, 0 failed`);
  expect(r.code).toBe(0);
}, 900_000);

// ---- run.ts wiring (a real process; every path here stops before any fetch) ----
const RUN = RUN_PATH;
const run = async (args: string[], cwd: string, home: string) => {
  const p = Bun.spawn([process.execPath, RUN, ...args], { cwd, env: { ...process.env, HOME: home }, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { out, err, code };
};
const controlId = () => (JSON.parse(readFileSync(join(import.meta.dir, "..", "acceptance", "controls.json"), "utf8")) as { id: string }[])[0]!.id;

test("run.ts: --prefetch with --offline is rejected", async () => {
  const r = await run(["--prefetch", "--offline"], tmp(), tmp());
  expect(r.code).not.toBe(0);
  expect(r.err).toContain("--prefetch downloads, so it cannot be combined with --offline");
});

test("run.ts: --prefetch reports the cache it uses (--cache, else the home default) and exits 0 when no dataset sample is selected", async () => {
  const home = tmp(), cache = tmp();
  const a = await run(["--prefetch", "--only", controlId(), "--cache", cache], tmp(), home);
  expect(a.code).toBe(0);
  expect(a.out).toContain(`prefetch: 0 dataset samples in set core, 0 in the cache, 0 failed, cache ${cache}`);
  const b = await run(["--prefetch", "--only", controlId()], tmp(), home);
  expect(b.out).toContain(`cache ${join(home, ".cache", "oupdate-acceptance", "samples")}`);
});

test("run.ts: --offline with an empty work dir and cache fails the case with the clear message naming the cache and work dir", async () => {
  const home = tmp(), cache = tmp(), work = join(tmp(), "w");
  const id = "litellm-1.82.7";
  const result = (cwd: string) => readFileSync(join(cwd, "acceptance-results", `${id}.json`), "utf8");
  const cwd1 = tmp();
  await run(["--offline", "--only", id, "--layers", "prepass", "--work", work, "--cache", cache], cwd1, home);
  expect(result(cwd1)).toContain(`offline: no sample for ${id}`);
  expect(result(cwd1)).toContain(cache);
  expect(result(cwd1)).toContain(join(work, id, "bad"));
  const cwd2 = tmp(); // no --cache: the cache is under the home directory
  await run(["--offline", "--only", id, "--layers", "prepass", "--work", work], cwd2, home);
  expect(result(cwd2)).toContain(join(home, ".cache", "oupdate-acceptance", "samples"));
});
