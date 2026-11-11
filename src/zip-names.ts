// A zip's members as Python's zipfile (and so pip) reads them, from the central directory, compared with what bsdtar
// listed and unpacked. Where the two readers disagree, the file reviewed is not the file installed, so each such member
// is a note that always holds.

import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { inflateRawSync } from "node:zlib";
import { foldKey } from "./artifact.ts";
import { isLink, type FileMap, type TarNote } from "./prepass.ts";

// cp437, the name encoding zipfile uses when flag bit 11 (UTF-8) is clear: bytes 0x80-0xFF.
const CP437_HIGH = "ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ";
const CP437 = [...CP437_HIGH];

function cp437(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b < 0x80 ? String.fromCharCode(b) : CP437[b - 0x80]!;
  return s;
}

/** One central directory entry, the fields zipfile and pip act on. */
export type ZipEntry = {
  /** The name as zipfile reads it: UTF-8 when flag bit 11 is set, else cp437, cut at a NUL. */
  name: string;
  /** The high 16 bits of the external attributes, which zipfile and pip read as a Unix mode whatever the host byte. */
  mode: number;
  size: number;
  /** Extra field ids in the central and the local header. */
  extras: number[];
  /** A file member's bytes as zipfile reads them, or why it cannot; undefined for a directory entry. */
  content?: Uint8Array | { error: string };
  /** The local header's compression method or flag bit 3 (data descriptor) differs from the central directory's. */
  headerDiff?: string;
};

// zipfile reads a member with the central directory's method and sizes from the local header's data start: stored or
// deflated (pip's wheels), the first `usize` bytes, checked against the central CRC. Anything else is an error here.
function zipfileBytes(data: Uint8Array, method: number, usize: number, crc: number, flags: number): Uint8Array | { error: string } {
  if (flags & 0x1) return { error: "encrypted" };
  let bytes: Uint8Array;
  if (method === 0) bytes = data.subarray(0, usize);
  else if (method === 8) {
    try {
      bytes = new Uint8Array(inflateRawSync(data, { maxOutputLength: Math.max(1, usize) })).subarray(0, usize);
    } catch (e) {
      return { error: `deflate: ${String(e instanceof Error ? e.message : e).slice(0, 80)}` };
    }
  } else return { error: `compression method ${method}` };
  if (bytes.length !== usize) return { error: `${bytes.length} bytes, the directory says ${usize}` };
  if ((Bun.hash.crc32(bytes) >>> 0) !== crc) return { error: "CRC does not match the directory's" };
  return bytes;
}

const U16 = (b: Uint8Array, o: number) => b[o]! | (b[o + 1]! << 8);
const U32 = (b: Uint8Array, o: number) => (b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) | (b[o + 3]! << 24)) >>> 0;
const U64 = (b: Uint8Array, o: number) => U32(b, o) + U32(b, o + 4) * 2 ** 32;

function extraIds(extra: Uint8Array): { ids: number[]; zip64?: Uint8Array } {
  const ids: number[] = [];
  let zip64: Uint8Array | undefined;
  for (let i = 0; i + 4 <= extra.length; ) {
    const id = U16(extra, i);
    const len = U16(extra, i + 2);
    ids.push(id);
    if (id === 0x0001) zip64 = extra.subarray(i + 4, i + 4 + len);
    i += 4 + len;
  }
  return { ids, zip64 };
}

type Reader = (at: number, n: number) => Uint8Array;

// The last end-of-central-directory signature in the final 64 KiB + 22 bytes, as zipfile looks for it.
function endRecord(read: Reader, size: number): { tail: Uint8Array; at: number; tailAt: number } {
  const tailAt = Math.max(0, size - 22 - 65535);
  const tail = read(tailAt, size - tailAt);
  for (let i = tail.length - 22; i >= 0; i--) if (U32(tail, i) === 0x06054b50) return { tail, at: i, tailAt };
  return { tail, at: -1, tailAt };
}

/** Whether zipfile finds an end record: it opens such a file as a zip whatever its first bytes are (a prepended stub). */
export function hasZipEnd(path: string): boolean {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const read: Reader = (at, n) => {
      const buf = new Uint8Array(Math.max(0, Math.min(n, size - at)));
      if (buf.length) readSync(fd, buf, 0, buf.length, at);
      return buf;
    };
    return endRecord(read, size).at >= 0;
  } finally {
    closeSync(fd);
  }
}

/** The central directory, read the way zipfile reads it (including data prepended to the archive); throws if unreadable. */
export function zipEntries(path: string): ZipEntry[] {
  return zipDirectory(path).entries;
}

/**
 * The central directory and what in its end records readers can take two ways: an ordinary end record whose fields
 * (not ZIP64 placeholders) name another directory than the ZIP64 record does. zipfile takes the ZIP64 one; a reader
 * that takes the ordinary one sees other members.
 */
export function zipDirectory(path: string): { entries: ZipEntry[]; endDiff?: string; tarBefore?: boolean } {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const read = (at: number, n: number) => {
      const buf = new Uint8Array(Math.max(0, Math.min(n, size - at)));
      if (buf.length) readSync(fd, buf, 0, buf.length, at);
      return buf;
    };
    const { tail, at: eocd, tailAt } = endRecord(read, size);
    if (eocd < 0) throw new Error("no end of central directory");
    let count = U16(tail, eocd + 10);
    let cdSize = U32(tail, eocd + 12);
    let cdOffset = U32(tail, eocd + 16);
    let end = tailAt + eocd;
    // A ZIP64 locator right before the end record is read whatever the ordinary fields say, as zipfile does: a small
    // archive may carry one, and its directory then starts that much earlier. The record sits right before the locator.
    const loc = end >= 20 ? read(end - 20, 20) : new Uint8Array();
    let endDiff: string | undefined;
    if (loc.length === 20 && U32(loc, 0) === 0x07064b50) {
      const rec = end >= 76 ? read(end - 76, 56) : new Uint8Array();
      if (rec.length !== 56 || U32(rec, 0) !== 0x06064b50) throw new Error("corrupt zip64 end record");
      const [c64, s64, o64] = [U64(rec, 32), U64(rec, 40), U64(rec, 48)];
      const differs = (ord: number, max: number, v: number) => ord !== max && ord !== v;
      if (differs(count, 0xffff, c64) || differs(cdSize, 0xffffffff, s64) || differs(cdOffset, 0xffffffff, o64)) {
        endDiff = `the end record names ${count} entries at ${cdOffset}, the ZIP64 record ${c64} at ${o64}`;
      }
      count = c64;
      cdSize = s64;
      cdOffset = o64;
      end -= 20 + 56;
    } else if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw new Error("no zip64 locator");
    // Bytes before the archive (a self-extractor stub): zipfile shifts every offset by them.
    const concat = end - cdSize - cdOffset;
    const cd = read(cdOffset + concat, cdSize);
    const out: ZipEntry[] = [];
    let budget = ZIP_READ_BUDGET;
    let firstLocal = Infinity;
    // zipfile walks the directory by its byte size, not by the end record's count: a count that differs holds.
    let i = 0;
    for (let n = 0; i < cd.length; n++) {
      if (i + 46 > cd.length || U32(cd, i) !== 0x02014b50) throw new Error(`bad central directory entry ${n}`);
      const needs = cd[i + 6]!;
      const flags = U16(cd, i + 8);
      const method = U16(cd, i + 10);
      const crc = U32(cd, i + 16);
      let csize = U32(cd, i + 20);
      let usize = U32(cd, i + 24);
      const nameLen = U16(cd, i + 28);
      const extraLen = U16(cd, i + 30);
      const commentLen = U16(cd, i + 32);
      const attr = U32(cd, i + 38);
      let local = U32(cd, i + 42);
      const raw = cd.subarray(i + 46, i + 46 + nameLen);
      const { ids, zip64 } = extraIds(cd.subarray(i + 46 + nameLen, i + 46 + nameLen + extraLen));
      if (zip64) {
        let at = 0;
        if (usize === 0xffffffff) (usize = U64(zip64, at)), (at += 8);
        if (csize === 0xffffffff) (csize = U64(zip64, at)), (at += 8);
        if (local === 0xffffffff) local = U64(zip64, at);
      }
      const orig = flags & 0x800 ? new TextDecoder().decode(raw) : cp437(raw);
      let name = orig;
      const nul = name.indexOf("\0");
      if (nul >= 0) name = name.slice(0, nul);
      firstLocal = Math.min(firstLocal, local + concat);
      const lh = read(local + concat, 30);
      const okLocal = lh.length === 30 && U32(lh, 0) === 0x04034b50;
      const localIds = okLocal ? extraIds(read(local + concat + 30 + U16(lh, 26), U16(lh, 28))).ids : [];
      const entry: ZipEntry = { name, mode: attr >>> 16, size: usize, extras: [...ids, ...localIds] };
      const localRaw = okLocal ? read(local + concat + 30, U16(lh, 26)) : new Uint8Array();
      const localName = U16(lh, 6) & 0x800 ? new TextDecoder().decode(localRaw) : cp437(localRaw);
      if (!okLocal) entry.headerDiff = "no local header at its offset";
      else if (localName !== orig) entry.headerDiff = "the local header names another file (zipfile refuses it)";
      else if (U16(lh, 8) !== method) entry.headerDiff = `local method ${U16(lh, 8)}, central ${method}`;
      else if ((U16(lh, 6) & 0x8) !== (flags & 0x8)) entry.headerDiff = "the data descriptor flag differs between the local and central header";
      const refused = flags & 0x20 ? "compressed patched data (flag bit 5)" : flags & 0x40 ? "strong encryption (flag bit 6)" : needs > 63 ? `it needs zip version ${(needs / 10).toFixed(1)}` : undefined;
      if (refused) entry.content = { error: refused };
      else if (!name.endsWith("/")) {
        // A budget on what the compare reads and decodes, the artifact cap's size: past it a member holds unread.
        budget -= csize + usize;
        if (budget < 0) entry.content = { error: `the compare's read budget of ${ZIP_READ_BUDGET} bytes is spent` };
        else entry.content = okLocal ? zipfileBytes(read(local + concat + 30 + U16(lh, 26) + U16(lh, 28), csize), method, usize, crc, flags) : { error: "no local header" };
      }
      out.push(entry);
      i += 46 + nameLen + extraLen + commentLen;
    }
    if (out.length !== count) endDiff = [endDiff, `the end record counts ${count} entries, the directory holds ${out.length}`].filter(Boolean).join("; ");
    // Bytes before the first member that hold a tar header: bsdtar may read that tar while zipfile reads the zip. No real
    // wheel carries one; a self-extractor stub (a script) does not match.
    const before = Number.isFinite(firstLocal) ? read(0, Math.min(firstLocal, 4_000_000)) : new Uint8Array();
    const tarBefore = Buffer.from(before).includes("ustar\0") || Buffer.from(before).includes("ustar  \0");
    return { entries: out, ...(endDiff ? { endDiff } : {}), ...(tarBefore ? { tarBefore } : {}) };
  } finally {
    closeSync(fd);
  }
}

// The path a member is written at: a leading, inner or repeated "./" and "/" collapsed, as the unpacked tree holds it.
function writtenAt(name: string): string {
  return name.split("/").filter((p) => p !== "" && p !== ".").join("/");
}

type Install = {
  /** Every place pip could write the member, over the install modes pip has (folded for comparing). */
  keys: string[];
  /** The path to name in a note. */
  show: string;
  /** The top-level names --target moves into the target root for this member, each with the home it moves from. */
  tops: { home: string; name: string }[];
};

const TRAILING = "ending in a period or space";
/** Why Windows would read a path segment as another name or refuse it, if it would. */
function byNfdEarly(out: FileMap, path: string): string | undefined {
  for (const k of out.keys()) if (k.normalize("NFD") === path.normalize("NFD")) return k;
  return undefined;
}

function windowsNameProblem(seg: string): string | undefined {
  if (seg === "" || seg === "." || seg === "..") return undefined;
  if (/[. ]$/.test(seg)) return TRAILING;
  if (seg.includes(":")) return "holding a colon (an NTFS stream or a drive-relative path)";
  if (/[<>"|?*\x00-\x1f]/.test(seg)) return "holding a character Windows refuses";
  const short = /^([^.]*~[0-9]+)(\.[^.]{0,3})?$/.exec(seg)?.[1];
  if (short !== undefined && short.length <= 8) return "an 8.3 short name";
  // A device name is the part before the first dot, with trailing spaces and periods dropped (CON .py is CON).
  if (/^(con|conin\$|conout\$|prn|aux|nul|com[0-9\u00b9\u00b2\u00b3]|lpt[0-9\u00b9\u00b2\u00b3])$/i.test(seg.split(".")[0]!.replace(/[ .]+$/, ""))) return "a reserved device name";
  return undefined;
}

// A Windows user-layout directory in front of a scheme path: Python, Python39, Python313-32, Python313t, PyPy310.
const PY_DIR = /^py(?:thon|py)[\w.-]*$/i;

/**
 * The root's home from the WHEEL file. pip reads WHEEL with Python's email parser, which ends the header block at the first
 * line it does not take for a header, so this does not model the parser: the root is purelib or platlib only when EVERY line
 * before the first blank line is a clean header (a name of letters, digits and hyphens, then ": " and a printable ASCII value
 * with no trailing space), with no BOM, no CR outside CRLF and no continuation line, and exactly one Root-Is-Purelib whose
 * value is true or false in any case. Anything else is the third home "root?", which meets both purelib and platlib, so a
 * parse difference between this and pip can only add a hold. Real WHEEL files only have clean headers.
 */
export function rootHomeOf(wheel: Uint8Array | undefined): string {
  if (!wheel) return "root?";
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(wheel);
  } catch {
    return "root?";
  }
  if (text.startsWith("\uFEFF") || /\r(?!\n)/.test(text)) return "root?";
  let value: string | undefined;
  let count = 0;
  for (const line of text.split("\n")) {
    const l = line.endsWith("\r") ? line.slice(0, -1) : line;
    if (l === "") break;
    const m = /^([A-Za-z0-9][A-Za-z0-9-]*): ([\x20-\x7e]*[\x21-\x7e])$/.exec(l);
    if (!m) return "root?";
    if (m[1]!.toLowerCase() !== "root-is-purelib") continue;
    count++;
    if (m[1] !== "Root-Is-Purelib") return "root?";
    value = m[2];
  }
  if (count !== 1) return "root?";
  if (value !== undefined && /^true$/i.test(value)) return "purelib";
  if (value !== undefined && /^false$/i.test(value)) return "platlib";
  return "root?";
}

/**
 * Where pip could install a member. pip (install/wheel.py) sends a member under a first directory ending ".data" (tested
 * on the raw name, case-sensitive; any such name) to a scheme directory by its second component, and the scheme directories
 * differ by install mode (venv, --prefix, --user, --home, Windows, --target), so one member has several possible places
 * and the review cannot know which. Every place is kept next to the others, never one in place of another, and two members
 * that share any place hold:
 * - purelib and platlib are the wheel's root directory (one directory in most modes, so both count whichever
 *   Root-Is-Purelib says), and so is a path in any scheme through site-packages, dist-packages or lib/python/ (the
 *   --target and --home layouts).
 * - scripts and a data path under bin/ or Scripts/ (also behind a Python39/ directory, the Windows user layout) are one
 *   place; headers and a data path under include/site/pythonX.Y/<d>/, include/pythonX.Y/<d>/ or Include/<d>/ are one place
 *   (the dist name <d> is any name); a data path itself is a place under the prefix.
 * - the .data directory's own name is dropped, all matching is without regard to case, and a later file wins.
 * - on a --target upgrade pip moves each top-level name over the root's, so the top-level names a member can end up with
 *   (moveTops: a data member's own first segment and the scheme aliases bin/Scripts or include/Include; a scripts or
 *   headers member's aliases) must not meet a root member's.
 */
function installOf(name: string, rootHome: string): Install {
  const own = writtenAt(name);
  const first = name.split("/", 1)[0]!;
  if (!first.endsWith(".data")) return { keys: [own], show: own, tops: [{ home: rootHome, name: own.split("/")[0]! }] };
  const [, scheme, ...rest] = own.split("/");
  if (!rest.length) return { keys: [`\0${own}`], show: own, tops: [] };
  const sub = rest.join("/");
  if (scheme === "purelib" || scheme === "platlib") return { keys: [sub], show: sub, tops: [{ home: scheme, name: rest[0]! }] };
  const keys = new Set<string>();
  const tops: { home: string; name: string }[] = [];
  let show = sub;
  const site = rest.findIndex((p) => /^(site|dist)-packages$/i.test(p));
  if (site >= 0 && site < rest.length - 1) {
    show = rest.slice(site + 1).join("/");
    keys.add(show);
    // Only the data scheme has lib homes, each its own directory (lib and lib64 are two homes).
    if (scheme === "data") tops.push({ home: `datalib:${foldKey(rest.slice(0, site).join("/"))}`, name: rest[site + 1]! });
  }
  // Any first directory followed by python or pypy is a lib directory (platlibdir can be any name): its contents are the
  // root's, and the top-level names move from there.
  if (rest.length > 2 && /^py(?:thon|py)$/i.test(rest[1]!)) {
    show = rest.slice(2).join("/");
    keys.add(show);
    if (scheme === "data") tops.push({ home: `datalib:${foldKey(rest[0]!)}`, name: rest[2]! });
  }
  // The scheme path behind any Windows user-layout directories.
  let k = 0;
  while (k < 2 && k < rest.length - 1 && PY_DIR.test(rest[k]!)) k++;
  const tail = rest.slice(k).join("/");
  // Every way a data path can read as a headers path (the dist directory is any name, so a path can read two ways): all kept.
  const headers = scheme === "headers" ? [sub] : scheme === "data" ? [/^include\/(?:site\/)?py(?:thon|py)[^/]*\/[^/]+\/(.+)$/i.exec(tail)?.[1], /^include\/[^/]+\/(.+)$/i.exec(tail)?.[1]].filter((h): h is string => h !== undefined) : [];
  const script = scheme === "scripts" ? sub : scheme === "data" ? /^(?:bin|scripts)\/(.+)$/i.exec(tail)?.[1] : undefined;
  // In the --target home layout headers stage under the data home's include/ and scripts under its bin/, so they move
  // from the data home with the data members (the separate keys stay for the other schemes).
  for (const header of headers) {
    keys.add(`\0headers/${header}`);
    tops.push({ home: "data", name: "include" }, { home: "data", name: "Include" });
    show = `include/${header}`;
  }
  if (script !== undefined) {
    keys.add(`\0scripts/${script}`);
    tops.push({ home: "data", name: "bin" }, { home: "data", name: "Scripts" });
    show = `bin/${script}`;
  }
  if (scheme === "data") {
    keys.add(`\0prefix/${sub}`);
    tops.push({ home: "data", name: rest[0]! });
  } else if (scheme === "scripts") keys.add(`\0prefix/bin/${sub}`);
  else if (scheme !== "headers") keys.add(`\0${own}`);
  return { keys: [...keys], show, tops };
}

/** A tar or a compressed stream by its first bytes: gzip, bzip2, xz, zstd, or ustar's magic at 257. */
export function tarMagic(head: Uint8Array): boolean {
  const at = (o: number, ...b: number[]) => b.every((v, k) => head[o + k] === v);
  return at(0, 0x1f, 0x8b) || at(0, 0x42, 0x5a, 0x68) || at(0, 0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00) || at(0, 0x28, 0xb5, 0x2f, 0xfd) || at(257, 0x75, 0x73, 0x74, 0x61, 0x72);
}

const ZIP_READ_BUDGET = 300_000_000;

const S_IFMT = 0o170000;
const S_IFDIR = 0o040000;
const S_IFREG = 0o100000;
// Info-ZIP Unicode Path and Unicode Comment: bsdtar takes the name from them, zipfile never does.
const UNICODE_EXTRAS = new Set([0x7075, 0x6375]);

function wheelRecord(entries: readonly ZipEntry[], out: FileMap): string[] {
  const rec = entries.find((e) => /^[^/]+\.dist-info\/RECORD$/.test(e.name));
  const bytes = rec && out.get(rec.name);
  if (!bytes) return [];
  // The first field of each CSV record, read over the whole text: a quoted field ("a,b", "" for a quote) may hold a
  // newline, which a member name can.
  const text = new TextDecoder().decode(bytes);
  const paths: string[] = [];
  let i = 0;
  while (i < text.length) {
    let field = "";
    if (text[i] === '"') {
      for (i++; i < text.length; i++) {
        if (text[i] === '"' && text[i + 1] === '"') (field += '"'), i++;
        else if (text[i] === '"') break;
        else field += text[i];
      }
      i++;
    } else while (i < text.length && text[i] !== "," && text[i] !== "\n" && text[i] !== "\r") field += text[i++];
    if (field) paths.push(field);
    // The rest of the record: other fields, quoted ones included, up to the record's end.
    let quoted = false;
    for (; i < text.length; i++) {
      if (text[i] === '"') quoted = !quoted;
      else if (!quoted && text[i] === "\n") break;
    }
    i++;
  }
  return paths;
}

/**
 * Notes for each member zipfile and bsdtar read differently: a name bsdtar did not list, a Unicode Path or Comment
 * extra, a backslash in a name, a mode whose type is not what pip writes (pip writes a directory only for a name ending
 * in "/", and a regular file for any other), a directory entry with data, and a wheel RECORD path with no member.
 */
export function zipNameNotes(path: string, listed: readonly string[], out: FileMap): TarNote[] {
  const notes: TarNote[] = [];
  const at = (why: string, name: string) => {
    const n: TarNote = { note: `zip member ${name}: ${why}`, key: "", kind: "zip member", raw: [name], paths: [name] };
    notes.push({ ...n, key: JSON.stringify(["zip member", why, name]) });
  };
  let entries: ZipEntry[];
  try {
    const dir = zipDirectory(path);
    entries = dir.entries;
    if (dir.endDiff) at(`the end records and the directory disagree: ${dir.endDiff}`, "(archive)");
    if (dir.tarBefore) at("a tar header sits before the zip: bsdtar can read the tar, zipfile reads the zip", "(archive)");
  } catch (e) {
    return [{ note: `unreadable zip directory: ${String(e instanceof Error ? e.message : e).slice(0, 120)}`, key: "unreadable zip directory", kind: "unreadable tar entry" }];
  }
  // bsdtar on macOS lists names decomposed, so both sides compare in NFD; twins by form are the fold check's.
  const pool = new Map<string, number>();
  for (const l of listed) pool.set(l.normalize("NFD"), (pool.get(l.normalize("NFD")) ?? 0) + 1);
  for (const e of entries) {
    const k = e.name.normalize("NFD");
    const left = pool.get(k) ?? 0;
    if (left > 0) pool.set(k, left - 1);
    else at("bsdtar lists no member by this name", e.name);
    if (e.extras.some((id) => UNICODE_EXTRAS.has(id))) at("a Unicode Path or Comment extra field names it otherwise to bsdtar", e.name);
    if (e.name.includes("\\")) at("a backslash in the name (pip writes it as part of the file name)", e.name);
    const type = e.mode & S_IFMT;
    const dir = e.name.endsWith("/");
    if (!dir && type !== 0 && type !== S_IFREG) at(`mode ${(e.mode >>> 0).toString(8)} is not a regular file, which pip writes`, e.name);
    if (dir && e.size > 0) at(`a directory entry with ${e.size} bytes of data`, e.name);
  }
  for (const [k, left] of pool) if (left > 0) at("bsdtar lists it, the central directory does not", k);
  // Content: zipfile's bytes against the file bsdtar wrote (looked up in NFD, as bsdtar on macOS writes the name).
  // Where pip could write each member (a .data directory sends it by scheme): two members sharing a place hold. On a
  // --target upgrade pip moves each top-level name from its home (the root, purelib, platlib, data, a data lib directory,
  // scripts or headers) into the target, replacing a whole directory, so one top-level name in two homes holds.
  const installs = new Map<ZipEntry, Install>();
  const places = new Map<string, Set<ZipEntry>>();
  // The root's home is purelib when the wheel says Root-Is-Purelib: true, platlib otherwise (pip's rule), so a .data copy in
  // the same directory shares its home; the two stay separate homes (lib and lib64 can differ).
  // pip takes the single top-level directory whose raw first path component ends in .dist-info and reads that exact WHEEL
  // member; any other shape (none, several, another member reaching the same path through ./, // or another case) is unknown.
  const distDirs = new Set(entries.map((e) => e.name.split("/", 1)[0]!).filter((d) => d.endsWith(".dist-info")));
  const wheelName = distDirs.size === 1 ? `${[...distDirs][0]}/WHEEL` : undefined;
  const wheelMembers = wheelName === undefined ? [] : entries.filter((e) => !e.name.endsWith("/") && foldKey(writtenAt(e.name)) === foldKey(wheelName));
  const wheelOk = wheelName !== undefined && wheelMembers.length === 1 && wheelMembers[0]!.name === wheelName;
  const wheelBytes = !wheelOk ? undefined : out.get(wheelName) ?? out.get(byNfdEarly(out, wheelName) ?? "");
  const rootHome = rootHomeOf(wheelBytes);
  const homesOf = new Map<string, Set<string>>();
  for (const e of entries) {
    if (e.name.endsWith("/")) continue;
    const inst = installOf(e.name, rootHome);
    installs.set(e, inst);
    for (const k of inst.keys) places.set(foldKey(k), (places.get(foldKey(k)) ?? new Set()).add(e));
    for (const t of inst.tops) homesOf.set(foldKey(t.name), (homesOf.get(foldKey(t.name)) ?? new Set()).add(t.home));
  }
  // A path component that Windows reads as another name, or refuses: one file for two members there, or an install that
  // writes elsewhere. No real wheel has one, so each holds (the whole raw name is checked, which covers the part left
  // after a .data/<scheme>/ prefix).
  for (const e of entries) {
    for (const seg of e.name.split("/")) {
      const why = windowsNameProblem(seg);
      if (why === undefined) continue;
      at(why === TRAILING ? `a path component ends in a period or space (${JSON.stringify(seg)}), which Windows reads as the name without it` : `a path component (${JSON.stringify(seg)}) is ${why}, which Windows reads as another name or refuses`, e.name);
      break;
    }
  }
  const byNfd = new Map<string, string>();
  for (const k of out.keys()) if (!byNfd.has(k.normalize("NFD"))) byNfd.set(k.normalize("NFD"), k);
  for (const e of entries) {
    if (e.headerDiff) at(`local and central headers differ: ${e.headerDiff}`, e.name);
    if (!e.content) continue;
    if (!(e.content instanceof Uint8Array) && e.name.endsWith("/")) {
      at(`zipfile cannot read it: ${e.content.error}`, e.name);
      continue;
    }
    if (!(e.content instanceof Uint8Array)) {
      at(`zipfile cannot read it: ${e.content.error}`, e.name);
      continue;
    }
    const path = writtenAt(e.name);
    const inst = installs.get(e)!;
    const installed = inst.show;
    if (inst.keys.some((k) => (places.get(foldKey(k))?.size ?? 0) > 1)) {
      at(`two members zipfile reads are written at ${installed}${installed === path ? "" : " (pip installs a .data member at that path, and the later copy wins)"}`, e.name);
      continue;
    }
    const clash = inst.tops.find((t) => (homesOf.get(foldKey(t.name))?.size ?? 0) > 1);
    if (clash !== undefined) {
      at(`pip --target replaces ${clash.name}/ from one home with ${clash.name}/ from another (${[...homesOf.get(foldKey(clash.name))!].join(" and ")}) on an upgrade`, e.name);
      continue;
    }
    const key = out.has(path) ? path : byNfd.get(path.normalize("NFD"));
    const got = key === undefined ? undefined : out.get(key);
    if (!got) at(`zipfile writes it, the unpacked archive has no file at ${path}`, e.name);
    else if (isLink(got)) at(`zipfile writes a file, the unpacked archive has a link at ${path}`, e.name);
    else if (got.length !== e.content.length || Buffer.compare(got, e.content) !== 0) at("content zipfile reads differs from the extracted file", e.name);
  }
  // Against the unpacked tree, not the directory: a member bsdtar wrote under another name leaves its RECORD path empty.
  // Both in NFD: bsdtar on macOS writes a zip's names decomposed.
  const tree = new Set([...out.keys()].map((k) => k.normalize("NFD")));
  for (const p of wheelRecord(entries, out).slice(0, 10_000)) if (!tree.has(p.normalize("NFD"))) at("the wheel RECORD names it, the unpacked archive has no such file", p);
  return notes;
}
