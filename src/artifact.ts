// Reads a release artifact (tgz, tar, wheel/zip) into a path -> bytes map.
// Static only: it lists members, refuses unsafe names, unpacks into a private
// temp dir with bsdtar, reads regular files and symlinks and removes the dir. Nothing in the
// artifact is installed, imported or run.

import { mkdtempSync, readdirSync, readFileSync, readlinkSync, lstatSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { isLink, markLink, markLabeled, type FileMap } from "./prepass.ts";

const MAX_TOTAL_BYTES = 300_000_000;
const MAX_ENTRIES = 100_000;

function run(args: string[]): string {
  const p = Bun.spawnSync(["bsdtar", ...args], { stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(`bsdtar ${args[0]} failed: ${new TextDecoder().decode(p.stderr).trim()}`);
  return new TextDecoder().decode(p.stdout);
}

function normalize(name: string): string {
  return name.replace(/^(\.\/)+/, "");
}

export function isUnsafeMember(name: string): boolean {
  const n = normalize(name);
  return n.startsWith("/") || n.split("/").includes("..") || /^[A-Za-z]:/.test(n);
}

// Makes two versions of one package comparable path by path: drops a top dir
// shared by every member (sdist `name-version/`, npm `package/`) and replaces
// the version in wheel `name-version.dist-info` / `.data` dirs.
export function normalizePaths(files: FileMap): FileMap {
  const keys = [...files.keys()];
  const tops = new Set(keys.map((k) => k.split("/")[0]));
  const strip = tops.size === 1 && keys.every((k) => k.includes("/"));
  const out: FileMap = new Map();
  for (const [k, v] of files) {
    let p = strip ? k.slice(k.indexOf("/") + 1) : k;
    p = p.replace(/^([A-Za-z0-9_.]+?)-[0-9][^/]*?\.(dist-info|data)\//, "$1-VERSION.$2/");
    out.set(p, v);
  }
  return out;
}

export async function readArtifact(path: string, opts: { passphrase?: string; maxBytes?: number; maxEntries?: number } = {}): Promise<FileMap> {
  const maxBytes = opts.maxBytes ?? MAX_TOTAL_BYTES;
  const maxEntries = opts.maxEntries ?? MAX_ENTRIES;
  // Before anything is written: the entry count and the sum of declared sizes (fifth column with numeric owners).
  const listing = run(["-tv", "--numeric-owner", "-f", path]).split("\n").filter(Boolean);
  if (listing.length > maxEntries) throw new Error(`artifact has ${listing.length} entries, over the ${maxEntries} cap: ${path}`);
  let declared = 0;
  for (const l of listing) {
    const m = /^\S+\s+\d+\s+\d+\s+\d+\s+(\d+)\s/.exec(l);
    if (!m) throw new Error(`unreadable entry size in ${path}: ${l.slice(0, 200)}`);
    declared += Number(m[1]);
  }
  if (declared > maxBytes) throw new Error(`artifact declares ${declared} bytes, over the ${maxBytes} cap: ${path}`);
  const members = run(["-tf", path]).split("\n").filter(Boolean);
  for (const m of members) {
    if (isUnsafeMember(m)) throw new Error(`unsafe member in ${path}: ${m}`);
  }
  const dir = mkdtempSync(join(tmpdir(), "oupdate-unpack-"));
  try {
    run(["-xf", path, "-C", dir, "--no-same-owner", "--no-same-permissions", ...(opts.passphrase ? ["--passphrase", opts.passphrase] : [])]);
    const out: FileMap = new Map();
    let total = 0;
    const walk = (rel: string) => {
      for (const name of readdirSync(join(dir, rel))) {
        const r = rel ? `${rel}/${name}` : name;
        const st = lstatSync(join(dir, r));
        if (st.isDirectory()) walk(r);
        else if (st.isFile()) {
          total += st.size;
          if (total > maxBytes) throw new Error(`artifact over ${maxBytes} bytes unpacked: ${path}`);
          out.set(r, new Uint8Array(readFileSync(join(dir, r))));
        } else if (st.isSymbolicLink()) {
          // Not followed: the entry is its target, which is what pip writes for a wheel's symlink entry.
          const bytes = markLink(new Uint8Array(readlinkSync(join(dir, r), { encoding: "buffer" })));
          total += bytes.length;
          if (total > maxBytes) throw new Error(`artifact over ${maxBytes} bytes unpacked: ${path}`);
          out.set(r, bytes);
        } else throw new Error(`special file in ${path}: ${r}`);
      }
    };
    walk("");
    return out;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && Buffer.compare(a, b) === 0;
const sameEntry = (a: Uint8Array | undefined, b: Uint8Array | undefined) => (!a && !b) || (!!a && !!b && sameBytes(a, b) && isLink(a) === isLink(b));

/**
 * Folds one old/new artifact pair (a wheel or the sdist of a release) into merged maps. A new file with the same
 * bytes (and link mark) as one already merged at its path is read once, when that merged copy is shown whole (it
 * has no old side) or its old side matches too; any other goes in at its path when that is free, else under
 * `label/`, with its old copy beside it. Matching new bytes alone is not enough: EVIL->EVIL merged first would
 * hide this artifact's clean->EVIL. A link always goes in, so it resolves to its own artifact's target, and so does a
 * package.json, so its entries resolve in its own artifact.
 */
export function mergeArtifactPair(into: { old: FileMap; new: FileMap }, label: string, old: FileMap, now: FileMap): void {
  const free = (k: string) => !into.old.has(k) && !into.new.has(k);
  const members: ReadonlySet<string> = new Set(now.keys());
  for (const [p, b] of now) {
    // A link or package.json is never folded: its target or entries are this artifact's files, which the merged copy's
    // artifact may not share.
    if (!isLink(b) && p !== "package.json" && !p.endsWith("/package.json") && into.new.has(p) && sameEntry(into.new.get(p), b) && (!into.old.has(p) || sameEntry(into.old.get(p), old.get(p)))) continue;
    let k = p;
    for (let i = 1; !free(k); i++) k = `${label}${i > 1 ? `#${i}` : ""}/${p}`;
    into.new.set(k, b);
    markLabeled(into.new, k, p, members);
    const o = old.get(p);
    if (o) into.old.set(k, o);
  }
  for (const [p, b] of old) if (!now.has(p) && free(p)) into.old.set(p, b);
}
