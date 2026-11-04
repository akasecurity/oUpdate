// A waiver is a person's recorded acceptance of one binary in one release: the review holds a release for a shipped binary
// it cannot read, and a waiver names that binary by its hash. It covers exactly the package, version and bytes recorded here;
// a new version or any change to the bytes is not covered. The store is one JSON file in the state directory that `oupdate review` and `oupdate gate` read with --state-dir; the host and targets paths do not read it.

import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export interface Waiver {
  eco: "npm" | "pypi";
  name: string;
  version: string;
  /** Lowercase hex sha256 of the binary file's bytes (the hash the review prints for it). */
  sha256: string;
  reason: string;
  who: string;
  /** ISO time the waiver was recorded. */
  at: string;
}

export type WaiverKey = Pick<Waiver, "eco" | "name" | "version" | "sha256">;

export const waiversPath = (stateDir: string) => join(stateDir, "waivers.json");

export const sha256Hex = (b: Uint8Array) => new Bun.CryptoHasher("sha256").update(b).digest("hex");

const same = (a: WaiverKey, b: WaiverKey) => a.eco === b.eco && a.name === b.name && a.version === b.version && a.sha256 === b.sha256;

function check(w: unknown, where: string): Waiver {
  const o = (w ?? {}) as Record<string, unknown>;
  const s = (k: string) => (typeof o[k] === "string" ? (o[k] as string) : "");
  if (o.eco !== "npm" && o.eco !== "pypi") throw new Error(`${where}: eco must be npm or pypi`);
  if (!/^[0-9a-f]{64}$/.test(s("sha256"))) throw new Error(`${where}: sha256 must be 64 lowercase hex digits`);
  for (const k of ["name", "version", "reason", "who", "at"]) if (!s(k).trim()) throw new Error(`${where}: ${k} is required`);
  return { eco: o.eco, name: s("name"), version: s("version"), sha256: s("sha256"), reason: s("reason").trim(), who: s("who").trim(), at: s("at") };
}

/** The records of a state dir; [] only when the file is missing. A file that cannot be read or parsed throws, so a damaged store never reads as no waivers and never as every waiver. */
export function listWaivers(stateDir: string): Waiver[] {
  const p = waiversPath(stateDir);
  if (!existsSync(p)) return [];
  try {
    const v = JSON.parse(readFileSync(p, "utf8"));
    if (!Array.isArray(v)) throw new Error("not a list");
    return v.map((w, i) => check(w, `record ${i + 1}`));
  } catch (e) {
    throw new Error(`${p}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function save(stateDir: string, list: Waiver[]) {
  const p = waiversPath(stateDir);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(`${p}.tmp`, JSON.stringify(list, null, 2) + "\n");
  renameSync(`${p}.tmp`, p);
}

/** Records a waiver; the same package, version and hash again replaces the earlier record. */
export function addWaiver(stateDir: string, w: Waiver): void {
  const rec = check(w, "waiver");
  save(stateDir, [...listWaivers(stateDir).filter((x) => !same(x, rec)), rec]);
}

/** Removes the matching record; returns how many were removed. */
export function removeWaiver(stateDir: string, k: WaiverKey): number {
  const all = listWaivers(stateDir);
  const kept = all.filter((x) => !same(x, k));
  if (kept.length !== all.length) save(stateDir, kept);
  return all.length - kept.length;
}

/** The waiver for this binary of this release, if one is recorded. */
export function findWaiver(list: Waiver[] | undefined, k: WaiverKey): Waiver | undefined {
  return list?.find((x) => same(x, k));
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

/** Throws when dir lies inside the git checkout found above the working directory or the CI workspace (the working directory alone is not a root: it is / under launchd and $HOME in a shell): a pull request's branch could ship its own waivers.json there and waive its own binary. */
export function stateDirOutsideRepo(dir: string, cwd: string, env: Record<string, string | undefined>): void {
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
  if (hit) throw new Error(`--state-dir ${dir} is inside the checked-out repo or workspace (${hit}); a pull request could ship its own waivers there. Use a directory outside it.`);
}
