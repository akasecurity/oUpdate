// Reads a release artifact (tgz, tar, wheel/zip) into a path -> bytes map.
// Static only: it lists members, refuses unsafe names, unpacks into a private
// temp dir with bsdtar, reads regular files and symlinks and removes the dir. Nothing in the
// artifact is installed, imported or run.

import { closeSync, mkdtempSync, openSync, readdirSync, readFileSync, readlinkSync, readSync, lstatSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { hasZipEnd, tarMagic, zipNameNotes } from "./zip-names.ts";
import { isLink, markLink, markLabeled, markTarNotes, noteKey, tarNoteEntries, type FileMap, type TarNote } from "./prepass.ts";

const MAX_TOTAL_BYTES = 300_000_000;
const MAX_ENTRIES = 100_000;

// bsdtar lists a non-ASCII member name as octal escapes under the C locale (a minimal env, a LaunchDaemon), so every
// bsdtar call runs with a UTF-8 locale. A locale the system lacks is not an error to bsdtar: it prints this line, keeps
// the C locale and exits 0.
export const LOCALE_FAILED = /Failed to set default locale/;
let tarLocale: string | null | undefined;

/** The UTF-8 locale bsdtar takes: C.UTF-8, else one `locale -a` lists (C.utf8, en_US.UTF-8 first); null if none. */
export function bsdtarLocale(): string | null {
  if (tarLocale !== undefined) return tarLocale;
  const dec = new TextDecoder();
  const takes = (loc: string) => {
    const p = Bun.spawnSync(["bsdtar", "--version"], { stdout: "ignore", stderr: "pipe", env: { ...process.env, LC_ALL: loc } });
    return p.exitCode === 0 && !LOCALE_FAILED.test(dec.decode(p.stderr));
  };
  let listed: string[] = [];
  try {
    listed = dec.decode(Bun.spawnSync(["locale", "-a"], { stdout: "pipe", stderr: "ignore" }).stdout).split("\n").map((l) => l.trim()).filter((l) => /\.utf-?8$/i.test(l));
  } catch {
    // No locale command: only C.UTF-8 is tried.
  }
  const order = [...new Set(["C.UTF-8", ...listed.filter((l) => /^(c|en_us)\.utf-?8$/i.test(l)), ...listed])];
  tarLocale = order.find(takes) ?? null;
  return tarLocale;
}

export function bsdtarEnv(): Record<string, string | undefined> {
  return { ...process.env, LC_ALL: bsdtarLocale() ?? "C.UTF-8" };
}

// `localeLost`: bsdtar ran under the C locale, so the names it printed are octal escapes, not the member names.
function run(args: string[]): { text: string; localeLost: boolean } {
  const p = Bun.spawnSync(["bsdtar", ...args], { stdout: "pipe", stderr: "pipe", env: bsdtarEnv() });
  const err = new TextDecoder().decode(p.stderr);
  if (p.exitCode !== 0) throw new Error(`bsdtar ${args[0]} failed: ${err.trim()}`);
  // One char per byte: bsdtar can print a name's lead byte raw and escape the rest (a format character), so the text
  // is decoded as UTF-8 only after unescapeMember has the bytes back.
  return { text: Buffer.from(p.stdout).toString("latin1"), localeLost: LOCALE_FAILED.test(err) };
}

/**
 * The format bsdtar itself reports for an archive (the last line of `bsdtar -tvv`, "Archive Format: ZIP 2.0 (deflation),
 * Compression: none"): "ZIP" for a zip, "POSIX ustar format", "ASCII cpio (SVR4 with no CRC)", "7-Zip" and so on for the
 * rest. Empty if bsdtar prints none.
 */
export function bsdtarFormat(path: string): string {
  const lines = run(["-tvv", "-f", path]).text.split("\n").filter(Boolean);
  const m = /^Archive Format: (.*?),\s+Compression: /.exec(lines[lines.length - 1] ?? "");
  return m?.[1] ?? "";
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

// The path the unpacked tree holds a member at: a leading, inner or repeated "./" and "/" collapsed.
function diskKey(member: string): string {
  return collapseMember(normalize(member));
}

// npm strip:1 drops the first component and does not normalize "." first.
// `./package/install.js` and `package/package/install.js` are one path, and the
// later member wins. A one-component name stays, so a root file is not dropped.
function npmStripMember(member: string): string | null {
  const parts = member.split("/");
  if (parts.length < 2) return null;
  const rest = parts.slice(1).join("/");
  if (!rest || rest.endsWith("/")) return null;
  // Stripped as spelled, then stored collapsed: `package/Dir/./x` is written at Dir/x.
  return collapseMember(rest) || null;
}

// A wheel's `name-version.dist-info` / `.data` dir with the version replaced: file paths and tar note keys share it.
function versionless(p: string): string {
  return p.replace(/^([A-Za-z0-9_.]+?)-[0-9][^/]*?\.(dist-info|data)\//, "$1-VERSION.$2/");
}

// A note's paths (and a hardlink's target) moved the way the step moved the files, with the key recomputed. `sources`
// are every path the step moved: where two distinct ones land on one path, a note touching it is marked collided, and
// the path gets a "path collision" note of its own, which always holds.
function movedNotes(notes: readonly TarNote[], move: (p: string) => string, sources: Iterable<string>, fromRaw = false): TarNote[] {
  const from = new Map<string, Set<string>>();
  for (const s of sources) {
    const to = move(s);
    // Two spellings of one member (x/./a and x/a) are one file on disk, not a collision: they count once.
    (from.get(to) ?? from.set(to, new Set()).get(to)!).add(fromRaw ? diskKey(s) : s);
  }
  // A move can also make two names that differ only in case or form (one/Dir/x.py and two/dir/x.py after npm's strip):
  // a filesystem that folds them writes one path. Every destination component path, directories too, is grouped by
  // foldKey; each group of twins gets a case-fold note, and a note on or under a twin is collided.
  const fold = new Map<string, Set<string>>();
  for (const to of from.keys()) {
    const parts = to.split("/");
    for (let j = 1; j <= parts.length; j++) {
      const p = parts.slice(0, j).join("/");
      const k = foldKey(p);
      (fold.get(k) ?? fold.set(k, new Set()).get(k)!).add(p);
    }
  }
  const twins = new Set<string>();
  for (const g of fold.values()) if (g.size > 1) for (const p of g) twins.add(p);
  const underTwin = (p: string) => {
    if (twins.size === 0) return false;
    const parts = p.split("/");
    for (let j = 1; j <= parts.length; j++) if (twins.has(parts.slice(0, j).join("/"))) return true;
    return false;
  };
  const folds: TarNote[] = [];
  for (const g of fold.values()) if (g.size > 1) {
    const sorted = [...g].sort();
    if (sorted.every((p) => p.includes("/") && twins.has(p.slice(0, p.lastIndexOf("/"))))) continue;
    folds.push({ note: `case-fold ${sorted.join(" ")}`, key: JSON.stringify(["case-fold", ...sorted]), kind: "case-fold", paths: sorted, collided: true });
  }
  const clash = (p: string) => (from.get(p)?.size ?? 0) > 1 || underTwin(p);
  const collisions: TarNote[] = [...from].filter(([, s]) => s.size > 1).map(([to, s]) => ({ note: `path collision ${to} (${[...s].sort().join(", ")})`, key: JSON.stringify(["path collision", to]), kind: "path collision", paths: [to], collided: true }));
  return [...collisions, ...folds, ...notes.map((n) => {
    if (!n.paths) return n;
    const paths = fromRaw && n.raw ? n.raw.map(move) : n.paths.map(move);
    const t = fromRaw ? n.rawTarget : n.target;
    const target = t === undefined || t === null ? t : move(t);
    const collided = n.collided || paths.some(clash) || (typeof target === "string" && clash(target));
    const m: TarNote = { ...n, paths, ...(target === undefined ? {} : { target }), ...(collided ? { collided } : {}) };
    return { ...m, key: noteKey(m) };
  })];
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
  // Only members that are files are sources: a directory entry (package/, ./package/) holds no bytes to hide.
  const fileMembers = members.filter((m) => files.has(diskKey(m)));
  markTarNotes(out, movedNotes(tarNoteEntries(files), (m) => npmStripMember(m) ?? diskKey(m), fileMembers, true));
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
  const move = (k: string) => versionless(strip ? k.slice(k.indexOf("/") + 1) : k);
  for (const [k, v] of src) out.set(move(k), v);
  // Twins the move makes are checked for every archive: twins in the archive itself are already a note from its
  // member list (a tar's or a zip's), which a folding filesystem cannot merge away.
  markTarNotes(out, movedNotes(tarNoteEntries(src), move, src.keys()));
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

// The key two member names share when one filesystem can store them as one file. It starts from the decomposed lower
// case, so canonically equal names (an NFC/NFD twin, Greek dialytika and tonos in either order or case) always match,
// then applies compatibility decomposition (a Kelvin sign, a fullwidth letter) and an upper-then-lower case fold (ß/SS,
// final sigma, dotless i) until the string stops changing. Folding more than a filesystem does only adds a hold.
export function foldKey(name: string): string {
  let s = name.normalize("NFD").toLowerCase();
  for (let i = 0; i < 8; i++) {
    const t = s.normalize("NFKD").toUpperCase().toLowerCase().normalize("NFKD");
    if (t === s) break;
    s = t;
  }
  return s;
}

// bsdtar prints a backslash in a member name as `\\`, a control character as a C escape (`\t`, `\n`) or `\ooo`, and an
// invalid UTF-8 byte as `\ooo`, even under a UTF-8 locale. Read back, those are the name's own bytes; a byte that is not UTF-8 stays unmatched (U+FFFD).
const C_ESCAPES: Record<string, number> = { "\\": 0x5c, a: 7, b: 8, f: 12, n: 10, r: 13, t: 9, v: 11 };
// `listed` holds one char per byte as bsdtar printed it (latin1); the result is the name decoded as UTF-8.
export function unescapeMember(listed: string): string {
  if (!/[\\\u0080-\u00ff]/.test(listed)) return listed;
  const bytes: number[] = [];
  for (let i = 0; i < listed.length; ) {
    const m = /^\\(\\|[0-7]{3}|[abfnrtv])/.exec(listed.slice(i, i + 4));
    if (m) {
      const c = C_ESCAPES[m[1]!];
      if (c !== undefined) bytes.push(c);
      else bytes.push(parseInt(m[1]!, 8) & 0xff);
      i += m[0].length;
    } else {
      bytes.push(listed.charCodeAt(i) & 0xff);
      i += 1;
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

function nonAscii(name: string): boolean {
  for (const ch of name) if (ch.codePointAt(0)! > 127) return true;
  return false;
}

// The member list, not the extracted tree. A link, a repeated path, a case-fold collision, a second top directory, a root
// file, a bundled node_modules member, or a non-ASCII name is a note. A note holds unless the old release had the same
// one (see the pre-pass); a repeated path, a case-fold collision, an unreadable entry and node_modules always hold.
// `listed`: the member names as bsdtar printed them (escaped), which the -tv lines hold; `members` are unescaped.
function archiveNotes(listing: string[], members: string[], listed: readonly string[] = members): TarNote[] {
  if (listing.length !== members.length) return [{ note: "unreadable tar entry", key: "unreadable tar entry", kind: "unreadable tar entry" }];
  const notes: TarNote[] = [];
  const at = (kind: string, name: string, raw: string[], extra: Partial<TarNote> = {}) => {
    const n: TarNote = { note: `${kind} ${name}`, key: "", kind, raw, paths: raw.map(diskKey), ...extra };
    notes.push({ ...n, key: noteKey(n) });
  };
  const rawOf = new Map<string, string>();
  const paths: string[] = [];
  const seen = new Set<string>();
  const dup = new Set<string>();
  const fold = new Map<string, Set<string>>();
  for (let i = 0; i < members.length; i++) {
    const line = listing[i] ?? "";
    const type = line[0] ?? "";
    if (!TAR_TYPES.includes(type)) {
      notes.push({ note: "unreadable tar entry", key: "unreadable tar entry", kind: "unreadable tar entry" });
      continue;
    }
    const shown = normalize(members[i] ?? "").replace(/\/+$/, "");
    const name = collapseMember(shown);
    if (!name || name === ".") continue;
    const raw = members[i]!;
    if (!rawOf.has(name)) rawOf.set(name, raw);
    if (nonAscii(shown)) at("non-ascii", name, [raw]);
    paths.push(name);
    if (type !== "d" && !name.includes("/")) at("root file", name, [raw]);
    if (name.split("/").includes("node_modules")) at("node_modules", name, [raw]);
    if (seen.has(name)) dup.add(name);
    else seen.add(name);
    // Every component path, directories too: two twin directories merge on disk even when their leaf names differ.
    const parts = name.split("/");
    for (let j = 1; j <= parts.length; j++) {
      const p = parts.slice(0, j).join("/");
      const key = foldKey(p);
      (fold.get(key) ?? fold.set(key, new Set()).get(key)!).add(p);
    }
    if (type === "l") at("symlink", name, [raw]);
    else if (type === "h") {
      // The target name, read from the listing after the date column: `<member> link to <target>`. A line this cannot
      // read leaves it unread (a hold).
      const cols = /^\S+\s+\d+\s+\d+\s+\d+\s+\d+\s+\S+\s+\d+\s+\S+\s/.exec(line);
      const lead = cols ? `${listed[i] ?? raw} link to ` : "";
      const target = cols && line.startsWith(lead, cols[0].length) ? unescapeMember(line.slice(cols[0].length + lead.length)) : null;
      at("hardlink", name, [raw], { rawTarget: target, target: target === null ? null : diskKey(target) });
    }
  }
  for (const name of [...dup].sort()) at("duplicate path", name, [rawOf.get(name)!]);
  const twins = new Set<string>();
  for (const group of fold.values()) if (group.size > 1) for (const g of group) twins.add(g);
  for (const group of fold.values()) if (group.size > 1) {
    const sorted = [...group].sort();
    // One note for the outermost twins: paths whose parents are twins already are inside that note's directories.
    if (sorted.every((g) => g.includes("/") && twins.has(g.slice(0, g.lastIndexOf("/"))))) continue;
    at("case-fold", sorted.join(" "), sorted.map((g) => rawOf.get(g) ?? g));
  }
  const tops = [...new Set(paths.filter((p) => p.includes("/")).map((p) => p.split("/")[0] ?? ""))].filter(Boolean).sort();
  // A versioned top dir pair (x-1.0/, x-1.1/ beside a second one) keys on the versioned names, so it never matches: it holds.
  if (tops.length > 1) {
    const n: TarNote = { note: `top dirs ${tops.join(" ")}`, key: "", kind: "top dirs", words: tops };
    notes.push({ ...n, key: noteKey(n) });
  }
  return notes;
}

/** File, symlink and hardlink members the unpacked tree does not hold under their own name. */
export function unstoredMembers(listing: readonly string[], members: readonly string[], out: FileMap): Set<string> {
  const unstored = new Set<string>();
  members.forEach((m, i) => {
    if ("-lh".includes(listing[i]?.[0] || "d") && !out.has(collapseMember(normalize(m)))) unstored.add(m);
  });
  return unstored;
}

/**
 * Each note naming an unstored member, marked collided: that member was never read, so the note holds. Each unstored
 * member also gets a note of its own, which holds whether or not another note names it.
 */
export function markUnstored(notes: readonly TarNote[], unstored: ReadonlySet<string>): TarNote[] {
  const own: TarNote[] = [...unstored].sort().map((m) => {
    const n: TarNote = { note: `not stored under its own name ${diskKey(m)}`, key: "", kind: "unstored member", raw: [m], paths: [diskKey(m)], collided: true };
    return { ...n, key: noteKey(n) };
  });
  return [...notes.map((n) => (n.raw?.some((r) => unstored.has(r)) ? { ...n, collided: true } : n)), ...own];
}

export async function readArtifact(path: string, opts: { passphrase?: string; maxBytes?: number; maxEntries?: number } = {}): Promise<FileMap> {
  const maxBytes = opts.maxBytes ?? MAX_TOTAL_BYTES;
  const maxEntries = opts.maxEntries ?? MAX_ENTRIES;
  // Before anything is written: the entry count and the sum of declared sizes (fifth column with numeric owners).
  const listed = run(["-tv", "--numeric-owner", "-f", path]);
  const listing = listed.text.split("\n").filter(Boolean);
  if (listing.length > maxEntries) throw new Error(`artifact has ${listing.length} entries, over the ${maxEntries} cap: ${path}`);
  let declared = 0;
  for (const l of listing) {
    const m = /^\S+\s+\d+\s+\d+\s+\d+\s+(\d+)\s/.exec(l);
    if (!m) throw new Error(`unreadable entry size in ${path}: ${l.slice(0, 200)}`);
    declared += Number(m[1]);
  }
  if (declared > maxBytes) throw new Error(`artifact declares ${declared} bytes, over the ${maxBytes} cap: ${path}`);
  const names = run(["-tf", path]);
  const listedNames = names.text.split("\n").filter(Boolean);
  const members = listedNames.map(unescapeMember);
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
    // A file or link member the tree does not hold under its own name (a filesystem stored two names as one file, or
    // kept another form of the name): it was never read, so each note naming it is collided and holds.
    // With no UTF-8 locale the names are escapes: every name-based check would read the wrong name, so it holds.
    const lost: TarNote[] = listed.localeLost || names.localeLost ? [{ note: "unreadable tar entry names (bsdtar has no UTF-8 locale)", key: "unreadable tar entry names", kind: "unreadable tar entry" }] : [];
    // A zip is what zipfile opens: "PK" first, or an end record behind a prepended stub in a file named as a zip. A tar
    // that also ends in a zip end record gets the zip checks too, so a polyglot holds.
    const zipEnd = hasZipEnd(path);
    // A tar (or a compressed stream) that also ends in a zip end record is a polyglot: bsdtar reads the tar, zipfile the
    // zip. No real wheel or sdist is both, so it holds. A .tar.gz whose compressed tail happens to hold the 4-byte
    // signature (about 1 in 100,000) holds too: that fails closed.
    const head = new Uint8Array(512);
    const fd = openSync(path, "r");
    try {
      readSync(fd, head, 0, 512, 0);
    } finally {
      closeSync(fd);
    }
    // Any file zipfile opens that bsdtar reads in another format (cpio, 7z, xar, iso9660, ar, rar) is the same: the format
    // is bsdtar's own report, not a guess from magic bytes.
    const format = zipEnd ? bsdtarFormat(path) : "";
    const notZip = zipEnd && !/^ZIP\b/.test(format);
    const polyglot: TarNote[] = notZip || (zipEnd && tarMagic(head)) ? [{ note: `a tar that is also a zip: bsdtar reads one (${format || "unknown format"}), zipfile the other`, key: "tar and zip polyglot", kind: "unreadable tar entry" }] : [];
    if (polyglot.length || (!isZip(path) && !(zipEnd && /\.(whl|zip|egg)$/i.test(path)))) {
      markTarNotes(out, [...lost, ...polyglot, ...markUnstored(archiveNotes(listing, members, listedNames), unstoredMembers(listing, members, out)), ...(zipEnd ? zipNameNotes(path, members, out) : [])]);
      NPM_MEMBERS.set(out, members);
    } else {
      // A zip (a wheel) gets the name checks only: twins by case or form, a repeated name (bsdtar on macOS lists both
      // forms of a name in one form), and a member not stored under its own name. Its other shapes (a root module, a
      // non-ascii name) are what a wheel normally holds.
      const nameKinds = new Set(["case-fold", "duplicate path", "unreadable tar entry"]);
      const twins = archiveNotes(listing, members, listedNames).filter((n) => nameKinds.has(n.kind));
      // And every member Python's zipfile, so pip, reads otherwise than bsdtar did (src/zip-names.ts).
      markTarNotes(out, [...lost, ...markUnstored(twins, unstoredMembers(listing, members, out)), ...zipNameNotes(path, members, out)]);
    }
    return out;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && Buffer.compare(a, b) === 0;
const sameEntry = (a: Uint8Array | undefined, b: Uint8Array | undefined) => (!a && !b) || (!!a && !!b && sameBytes(a, b) && isLink(a) === isLink(b));

const PAIR_CALLS = new WeakMap<FileMap, number>();

/** The id of one merge call (an artifact instance, never its label: two artifacts with one label never share or dedupe notes). */
function nextPair(into: FileMap): string {
  const calls = (PAIR_CALLS.get(into) ?? 0) + 1;
  PAIR_CALLS.set(into, calls);
  return String(calls);
}

/**
 * An artifact whose bytes another merged file already has: its files are read once, through that copy, but its notes
 * are its own, from an artifact with no old side, so each holds. `placed` is where that first copy put each of its
 * paths (what mergeArtifactPair returned), so a note points at the merged file it is about.
 */
export function mergeUnpairedNotes(into: { old: FileMap; new: FileMap }, label: string, now: FileMap, placed?: ReadonlyMap<string, string>): void {
  const pair = nextPair(into.new);
  markTarNotes(into.new, tarNoteEntries(now).map((n) => ({ ...n, pair, from: label, ...(n.paths && placed ? { paths: n.paths.map((p) => placed.get(p) ?? `\0unplaced ${p}`) } : {}) })));
}

/**
 * Folds one old/new artifact pair (a wheel or the sdist of a release) into merged maps. A new file with the same
 * bytes (and link mark) as one already merged at its path is read once, when that merged copy is shown whole (it
 * has no old side) or its old side matches too; any other goes in at its path when that is free, else under
 * `label/`, with its old copy beside it. Matching new bytes alone is not enough: EVIL->EVIL merged first would
 * hide this artifact's clean->EVIL. A link always goes in, so it resolves to its own artifact's target, and so does a
 * package.json, so its entries resolve in its own artifact. Returns where each of the new file's paths went.
 */
export function mergeArtifactPair(into: { old: FileMap; new: FileMap }, label: string, old: FileMap, now: FileMap): Map<string, string> {
  const free = (k: string) => !into.old.has(k) && !into.new.has(k);
  const members: ReadonlySet<string> = new Set(now.keys());
  // Where each of this pair's paths went: a note's link is read at its merged key, not at a same-named path of another artifact.
  const placedNew = new Map<string, string>();
  const placedOld = new Map<string, string>();
  for (const [p, b] of now) {
    // A link or package.json is never folded: its target or entries are this artifact's files, which the merged copy's
    // artifact may not share.
    if (!isLink(b) && p !== "package.json" && !p.endsWith("/package.json") && into.new.has(p) && sameEntry(into.new.get(p), b) && (!into.old.has(p) || sameEntry(into.old.get(p), old.get(p)))) continue;
    let k = p;
    for (let i = 1; !free(k); i++) k = `${label}${i > 1 ? `#${i}` : ""}/${p}`;
    into.new.set(k, b);
    placedNew.set(p, k);
    markLabeled(into.new, k, p, members);
    const o = old.get(p);
    if (o) {
      into.old.set(k, o);
      placedOld.set(p, k);
    }
  }
  for (const [p, b] of old)
    if (!now.has(p) && free(p)) {
      into.old.set(p, b);
      placedOld.set(p, p);
    }
  // Each side keeps its own notes, tagged with this pair, so the pre-pass compares a note only with its own pair's old
  // side. A path this pair did not place (folded or crowded out) is marked unplaced, so its link never reads another's file.
  // The pair is this call, not the label: two artifacts with one label (two sdists) never share or dedupe notes.
  const pair = nextPair(into.new);
  const tag = (notes: readonly TarNote[], placed: Map<string, string>) =>
    notes.map((n) => ({ ...n, pair, from: label, ...(n.paths ? { paths: n.paths.map((p) => placed.get(p) ?? `\0unplaced ${p}`) } : {}) }));
  markTarNotes(into.old, tag(tarNoteEntries(old), placedOld));
  markTarNotes(into.new, tag(tarNoteEntries(now), placedNew));
  return placedNew;
}
