// Reads a release artifact (tgz, tar, wheel/zip) into a path -> bytes map.
// Static only: it lists members, refuses unsafe names, unpacks into a private
// temp dir with bsdtar, reads regular files and symlinks and removes the dir. Nothing in the
// artifact is installed, imported or run.

import { closeSync, mkdtempSync, openSync, readdirSync, readFileSync, readlinkSync, readSync, lstatSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { isLink, markLink, markLabeled, markTarNotes, tarNotes, type FileMap } from "./prepass.ts";

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

// Original tar member names, kept so normalizePaths can apply npm's strip.
// The extracted tree has already dropped a leading "./".
const NPM_MEMBERS = new WeakMap<FileMap, readonly string[]>();

function diskKey(member: string): string {
  return member.replace(/^(\.\/)+/, "").replace(/\/+$/, "");
}

// npm strip:1 drops the first component and does not normalize "." first.
// `./package/install.js` and `package/package/install.js` are one path, and the
// later member wins. A one-component name stays, so a root file is not dropped.
function npmStripMember(member: string): string | null {
  const parts = member.split("/");
  if (parts.length < 2) return null;
  const rest = parts.slice(1).join("/");
  if (!rest || rest.endsWith("/")) return null;
  return rest;
}

function applyNpmStrip(files: FileMap): FileMap {
  const members = NPM_MEMBERS.get(files);
  if (!members) return files;
  const out: FileMap = new Map();
  const claimed = new Set<string>();
  for (const member of members) {
    const disk = diskKey(member);
    if (!disk) continue;
    const bytes = files.get(disk);
    if (!bytes) continue;
    out.set(npmStripMember(member) ?? disk, bytes);
    claimed.add(disk);
  }
  for (const [k, v] of files) if (!claimed.has(k) && !out.has(k)) out.set(k, v);
  markTarNotes(out, tarNotes(files));
  return out;
}

// Makes two versions of one package comparable path by path: drops a top dir
// shared by every member (sdist `name-version/`, npm `package/`) and replaces
// the version in wheel `name-version.dist-info` / `.data` dirs. Tar members
// are stripped the way npm strip:1 strips them before that.
export function normalizePaths(files: FileMap): FileMap {
  const src = applyNpmStrip(files);
  const keys = [...src.keys()];
  const tops = new Set(keys.map((k) => k.split("/")[0]));
  const strip = tops.size === 1 && keys.every((k) => k.includes("/"));
  const out: FileMap = new Map();
  for (const [k, v] of src) {
    let p = strip ? k.slice(k.indexOf("/") + 1) : k;
    p = p.replace(/^([A-Za-z0-9_.]+?)-[0-9][^/]*?\.(dist-info|data)\//, "$1-VERSION.$2/");
    out.set(p, v);
  }
  markTarNotes(out, tarNotes(src));
  return out;
}

const TAR_TYPES = "-dlcbpsh";

function isZip(path: string): boolean {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(4);
    const n = readSync(fd, buf, 0, 4, 0);
    return n >= 2 && buf[0] === 0x50 && buf[1] === 0x4b;
  } finally {
    closeSync(fd);
  }
}

// "." and empty segments are the same member. ".." stays, and a directory
// entry such as `package/` is not a root file.
function collapseMember(name: string): string {
  return name.split("/").filter((s) => s !== "" && s !== ".").join("/");
}

function nonAscii(name: string): boolean {
  for (const ch of name) if (ch.codePointAt(0)! > 127) return true;
  return false;
}

// The member list, not the extracted tree. A link, a repeated path, a
// case-fold collision, a second top directory, a root file, a bundled
// node_modules member, or a non-ASCII name is a hold on its own.
function archiveNotes(listing: string[], members: string[]): string[] {
  if (listing.length !== members.length) return ["unreadable tar entry"];
  const notes: string[] = [];
  const paths: string[] = [];
  const seen = new Set<string>();
  const dup = new Set<string>();
  const fold = new Map<string, string[]>();
  for (let i = 0; i < members.length; i++) {
    const line = listing[i] ?? "";
    const type = line[0] ?? "";
    if (!TAR_TYPES.includes(type)) {
      notes.push("unreadable tar entry");
      continue;
    }
    const shown = normalize(members[i] ?? "").replace(/\/+$/, "");
    const name = collapseMember(shown);
    if (!name || name === ".") continue;
    if (nonAscii(shown)) notes.push(`non-ascii ${name}`);
    paths.push(name);
    if (type !== "d" && !name.includes("/")) notes.push(`root file ${name}`);
    if (name.split("/").includes("node_modules")) notes.push(`node_modules ${name}`);
    if (seen.has(name)) dup.add(name);
    else {
      seen.add(name);
      const key = name.toLowerCase();
      const group = fold.get(key);
      if (group) group.push(name);
      else fold.set(key, [name]);
    }
    if (type === "l") notes.push(`symlink ${name}`);
    else if (type === "h") notes.push(`hardlink ${name}`);
  }
  for (const name of [...dup].sort()) notes.push(`duplicate path ${name}`);
  for (const group of fold.values()) if (group.length > 1) notes.push(`case-fold ${[...group].sort().join(" ")}`);
  const tops = [...new Set(paths.filter((p) => p.includes("/")).map((p) => p.split("/")[0] ?? ""))].filter(Boolean).sort();
  if (tops.length > 1) notes.push(`top dirs ${tops.join(" ")}`);
  return notes;
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
    if (!isZip(path)) {
      markTarNotes(out, archiveNotes(listing, members));
      NPM_MEMBERS.set(out, members);
    }
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
  const notes = [...tarNotes(old), ...tarNotes(now)];
  if (notes.length) {
    markTarNotes(into.old, notes);
    markTarNotes(into.new, notes);
  }
}
