// Upstream taps (apply.upstreamTaps): the tap IS the project's source repo, so a release diff is
// hundreds of source files. The review reads only the supply-chain surface of that diff: what brew
// or a build would run or fetch (install and build scripts, formula, manifests, lockfiles, CI and
// release workflows, packaging, new executables) and any binary. Plain source files are counted,
// not read. Deterministic findings on the surface FLAG before any reviewer call.

import { benignBinary } from "../benign-binary.ts";
import type { Exec } from "./exec.ts";

export type GitResult = { rc: number; out: string; truncated?: true };
export type Git = (dir: string, args: string[]) => Promise<GitResult>;

/** A git read that did not give its whole answer: it failed, or it was stopped over the output bound (rc 125, truncated). */
export const gitFailed = (r: GitResult) => r.rc !== 0 || r.truncated === true;

/** git -C dir <args> through an Exec, keeping what a gate needs to tell a whole answer from a cut one. */
export const gitVia = (x: Exec): Git => async (dir, args) => {
  const res = await x(["git", "-C", dir, ...args]);
  return { rc: res.rc, out: res.out, ...(res.truncated ? { truncated: true as const } : {}) };
};

const MANIFEST = /^(setup\.py|setup\.cfg|pyproject\.toml|MANIFEST\.in|Pipfile(\.lock)?|requirements[^/]*\.txt|package(-lock)?\.json|bun\.lockb?|yarn\.lock|pnpm-lock\.yaml|uv\.lock|poetry\.lock|Cargo\.(toml|lock)|build\.rs|Package\.(swift|resolved)|Gemfile(\.lock)?|go\.(mod|sum)|CMakeLists\.txt|GNUmakefile|[Mm]akefile|Dockerfile[^/]*|install[^/]*)$/;
const DIRS = /^(Formula|HomebrewFormula|Casks|\.github|\.circleci|packaging|scripts?|bin|ci)\//;
const EXT = /\.(sh|bash|zsh|lock|cmake|plist|rb|podspec|gemspec|pbxproj|xcconfig|entitlements|mk)$/;

/** Files brew or a build may run, fetch or resolve dependencies from. */
export function isSurfaceFile(path: string): boolean {
  return DIRS.test(path) || EXT.test(path) || MANIFEST.test(path.slice(path.lastIndexOf("/") + 1));
}

const FETCH_EXEC: [RegExp, string][] = [
  [/\b(curl|wget|fetch)\b[^\n]*\|\s*(sudo\s+)?(ba|z|da)?sh\b/, "fetch piped into a shell"],
  [/\b(ba|z|da)?sh\s+-c\s+["']?\$\(\s*(curl|wget)/, "shell run on fetched code"],
  [/base64\s+(-d|-D|--decode)|\bb64decode\b|marshal\.loads|zlib\.decompress/, "encoded payload decoded at run time"],
];
const NET_FETCH: [RegExp, string][] = [
  [/(^|[\s;&|(`"'])(curl|wget)\s/, "network fetch (curl/wget)"],
  [/\b(urllib|urlopen|requests\.(get|post|put)|httpx\.|http\.client|create_connection)\b|\/dev\/tcp\/|\bgit\s+clone\b/, "network access from a build step"],
];
const DEP_SOURCE: [RegExp, string][] = [
  [/git\+|@\s*(https?|git|file):|--(extra-)?index-url|--trusted-host|--find-links|\bdependency_links\b/, "dependency from a url, vcs or another index"],
  [/^\+\s*"(?!homepage"|url"|repository"|bugs"|funding"|author)[^"]+"\s*:\s*"(https?:|git\+|git:|github:|file:)/, "dependency from a url or vcs"],
  [/^\+\s*"(preinstall|postinstall|install|prepare)"\s*:/, "package install hook"],
  [/^\+\s*\w[\w-]*\s*=\s*\{[^}]*\b(git|path)\s*=/, "dependency from a git or path source"],
];
const isManifest = (p: string) => /(^|\/)(requirements[^/]*\.txt|pyproject\.toml|setup\.(py|cfg)|package\.json|Cargo\.toml|Pipfile|Gemfile|go\.mod|Package\.swift)$/.test(p);

/** One finding per file: the first suspicious thing added to it. Removed lines never count. */
export function scanSurface(files: { path: string; diff: string }[]): string[] {
  const out: string[] = [];
  for (const f of files) {
    const added = f.diff.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++"));
    const rules = [...FETCH_EXEC, ...(f.path.startsWith(".github/") ? [] : NET_FETCH), ...(isManifest(f.path) ? DEP_SOURCE : [])];
    for (const [re, why] of rules) {
      const hit = added.find((l) => re.test(l));
      if (hit) {
        out.push(`${f.path}: ${why} (${hit.slice(0, 120).trim()})`);
        break;
      }
    }
  }
  return out;
}

export interface Surface {
  files: { path: string; diff: string }[];
  /** Deterministic findings: each one FLAGs. */
  findings: string[];
  /** Changed files outside the surface, counted and not read. */
  otherCount: number;
}

export type SurfaceResult = { ok: true; surface: Surface } | { ok: false; why: string };

// git's text wrapper turns a PNG's 0x89 into a replacement character, so the magic bytes come from the blob.
// Only the first bytes are read (the longest signature in BENIGN_BINARY ends at byte 36): a blob of any size costs a few bytes of memory,
// git is stopped once they are in, and a read past the deadline gives up (it was spawnSync of the whole blob, with no bound and no timeout).
// On a partial clone (--filter=blob:none, appBundleUpgrade's src.git) cat-file fetches a missing blob, as the whole-blob read did: that is
// kept (a clean release whose binary numstat did not fetch must still pass). The fetch is bounded instead: git runs in its own process
// group, killed as a whole when the read ends, and the read gives up at the deadline, so a stalled fetch (or a child that holds the pipe
// past git's own death) costs the deadline and leaves no process.
const BLOB_HEAD_BYTES = 64;
export const BLOB_READ_MS = 30_000;
type Kill = (pid: number, sig: NodeJS.Signals) => void;
export async function blobBytes(dir: string, rev: string, path: string, o: { git?: string; ms?: number; kill?: Kill } = {}): Promise<Uint8Array | undefined> {
  let p: Bun.Subprocess<"ignore", "pipe", "ignore">;
  try {
    p = Bun.spawn([o.git ?? "git", "-C", dir, "cat-file", "blob", "--", `${rev}:${path}`], {
      stdin: "ignore", stdout: "pipe", stderr: "ignore", detached: true, env: { ...process.env },
    } as never) as unknown as Bun.Subprocess<"ignore", "pipe", "ignore">;
  } catch {
    return undefined;
  }
  const head = new Uint8Array(BLOB_HEAD_BYTES);
  let got = 0;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let out: Uint8Array | undefined;
  try {
    reader = p.stdout.getReader();
    const late = new Promise<"late">((res) => {
      timer = setTimeout(() => res("late"), o.ms ?? BLOB_READ_MS);
    });
    out = await (async () => {
      while (got < BLOB_HEAD_BYTES) {
        const r = await Promise.race([reader!.read(), late]);
        if (r === "late") return undefined;
        if (r.done) break;
        const take = Math.min(r.value.length, BLOB_HEAD_BYTES - got);
        head.set(r.value.subarray(0, take), got);
        got += take;
      }
      // A blob shorter than the head ends by itself: only a clean exit counts. One cut at the head size is stopped below, on purpose: the exit
      // status of a git we stop is not read (a git that prints 64 bytes and then fails passes once the magic is in; real git does that only
      // on a corrupt local object).
      if (got < BLOB_HEAD_BYTES) {
        const code = await Promise.race([p.exited, late]);
        if (code !== 0) return undefined;
      }
      return head.subarray(0, got);
    })();
  } catch {
    out = undefined;
  } finally {
    clearTimeout(timer);
    // However this ends (enough bytes, a deadline, an error): stop git and anything it started, even after git itself exited (a lazy
    // fetch child outlives it). The group is git's own (detached), so this reaches nothing else. Only ESRCH (or EPERM once git has exited (waited for 250 ms)) means the group is gone; any other
    // error leaves a child we could not stop: git itself is killed by pid, and the read is flagged (undefined).
    const kill = o.kill ?? ((pid: number, sig: NodeJS.Signals) => void process.kill(pid, sig));
    try {
      kill(-p.pid, "SIGKILL");
    } catch (e) {
      const code = (e as NodeJS.ErrnoException)?.code;
      // macOS answers EPERM, not ESRCH, for a group that is only zombies (git exited, not yet reaped by us): that is gone too, once git has exited (waited for 250 ms).
      let gone = code === "ESRCH";
      if (code === "EPERM") {
        let t2: ReturnType<typeof setTimeout> | undefined;
        gone = await Promise.race([p.exited.then(() => true), new Promise<boolean>((res) => (t2 = setTimeout(() => res(false), 250)))]);
        clearTimeout(t2);
      }
      if (!gone) {
        out = undefined;
        try {
          kill(p.pid, "SIGKILL");
        } catch {
          // the pid is gone too, or not ours to stop
        }
        try {
          p.kill("SIGKILL");
        } catch {
          // already gone
        }
      }
    }
    void reader?.cancel().catch(() => {});
  }
  return out;
}

/** The surface of the diff oldRev..head in the tap checkout. */
export async function gatherSurface(git: Git, dir: string, oldRev: string, head: string): Promise<SurfaceResult> {
  const range = `${oldRev}..${head}`;
  const base = ["-c", "core.quotepath=false", "diff", "--no-renames"];
  const raw = await git(dir, [...base, "--raw", range]);
  const num = await git(dir, [...base, "--numstat", range]);
  if (gitFailed(raw) || gitFailed(num)) return { ok: false, why: "git could not list the release diff" };
  const modes = new Map<string, { from: string; to: string; status: string }>();
  for (const l of raw.out.split("\n")) {
    const m = l.match(/^:(\d+) (\d+) \S+ \S+ (\S+)\t(.+)$/);
    if (m) modes.set(m[4]!, { from: m[1]!, to: m[2]!, status: m[3]! });
  }
  const binary = new Set<string>();
  for (const l of num.out.split("\n")) {
    const m = l.match(/^-\t-\t(.+)$/);
    if (m) binary.add(m[1]!);
  }
  const findings: string[] = [];
  const read: string[] = [];
  let otherCount = 0;
  for (const [path, m] of modes) {
    const execNew = m.to === "100755" && m.from !== "100755";
    const link = m.to === "120000" && m.from !== "120000";
    if (binary.has(path)) {
      const rev = m.status.startsWith("D") ? oldRev : head;
      if (!benignBinary(path, await blobBytes(dir, rev, path))) findings.push(`${path}: binary file added or changed`);
    }
    if (isSurfaceFile(path) || execNew || link) read.push(path);
    else otherCount++;
  }
  const files: { path: string; diff: string }[] = [];
  for (const path of read.sort()) {
    const d = await git(dir, [...base, "-U0", range, "--", path]);
    if (gitFailed(d)) return { ok: false, why: `git could not read the diff of ${path}` };
    const body = d.out.slice(d.out.search(/^@@|^Binary files|^new file|^deleted file/m) >= 0 ? d.out.search(/^@@|^Binary files|^new file|^deleted file/m) : 0);
    files.push({ path, diff: body });
  }
  findings.push(...scanSurface(files));
  return { ok: true, surface: { files, findings, otherCount } };
}
