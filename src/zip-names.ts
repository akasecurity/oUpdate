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

// CPython's _EndRecData: the last 22 bytes when they are an end record with no comment, else the last signature
// anywhere in the final 64 KiB + 22 bytes. A signature with fewer than 22 bytes after it is a truncated record, which
// zipfile refuses (BadZipFile): `truncated` is set, and zipfile opens no archive at all.
function endRecord(read: Reader, size: number): { tail: Uint8Array; at: number; tailAt: number; truncated?: boolean } {
  if (size >= 22) {
    const last = read(size - 22, 22);
    if (last.length === 22 && U32(last, 0) === 0x06054b50 && last[20] === 0 && last[21] === 0) return { tail: last, at: 0, tailAt: size - 22 };
  }
  const tailAt = Math.max(0, size - 22 - 65535);
  const tail = read(tailAt, size - tailAt);
  const at = Buffer.from(tail).lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (at < 0) return { tail, at: -1, tailAt };
  return { tail, at, tailAt, ...(tail.length - at < 22 ? { truncated: true } : {}) };
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
    // A truncated record counts: bsdtar may read the file as a zip while zipfile refuses it, which holds as unreadable.
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
export function zipDirectory(path: string, readBudget = ZIP_READ_BUDGET): { entries: ZipEntry[]; endDiff?: string; tarBefore?: boolean } {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const read = (at: number, n: number) => {
      const buf = new Uint8Array(Math.max(0, Math.min(n, size - at)));
      if (buf.length) readSync(fd, buf, 0, buf.length, at);
      return buf;
    };
    const { tail, at: eocd, tailAt, truncated } = endRecord(read, size);
    if (eocd < 0) throw new Error("no end of central directory");
    if (truncated) throw new Error("truncated end of central directory record");
    let count = U16(tail, eocd + 10);
    let cdSize = U32(tail, eocd + 12);
    let cdOffset = U32(tail, eocd + 16);
    let end = tailAt + eocd;
    // A ZIP64 locator right before the end record is read whatever the ordinary fields say, as zipfile does: a small
    // archive may carry one, and its directory then starts that much earlier. The record sits right before the locator.
    const loc = end >= 20 ? read(end - 20, 20) : new Uint8Array();
    let endDiff: string | undefined;
    let recAt = end;
    if (loc.length === 20 && U32(loc, 0) === 0x07064b50) {
      // Patched zipfile (3.11.17, 3.12.15, 3.14.10) reads the record at the locator's offset first, and the record may be
      // followed by extensible data up to the locator; only when no record signature sits there does it take the one
      // right before the locator (a stub shifts every offset). A reader that always takes the one before the locator reads
      // another directory, so a file where the two differ holds.
      const justBefore = end - 76;
      if (justBefore < 0 || U32(loc, 4) !== 0 || U32(loc, 16) > 1) throw new Error("corrupt zip64 end record locator");
      const reloff = U64(loc, 8);
      if (reloff > justBefore) throw new Error("corrupt zip64 end record locator");
      const sigAt = (o: number) => {
        const r = read(o, 56);
        return r.length === 56 && U32(r, 0) === 0x06064b50 ? r : undefined;
      };
      const viaLocator = sigAt(reloff);
      const beforeLocator = sigAt(justBefore);
      const rec = viaLocator ?? beforeLocator;
      if (!rec) throw new Error("corrupt zip64 end record");
      recAt = viaLocator ? reloff : justBefore;
      const [c64, s64, o64] = [U64(rec, 32), U64(rec, 40), U64(rec, 48)];
      // The record plus its extensible data ends at the locator, and with no stub the directory ends where it starts.
      if (U64(rec, 4) + 12 !== end - 20 - recAt) throw new Error("corrupt zip64 end record: its size field does not reach the locator");
      // reloff is the record's offset as the writer stored it (without any prefix), as the directory's own offset is.
      if (o64 + s64 !== reloff) throw new Error("corrupt zip64 end record: the directory does not end where the record starts");
      // Extensible data between the record and the locator hides the record from a reader that looks just before the locator
      // (older zipfile), and a second directory can sit in it; real wheels carry none.
      if (viaLocator && reloff !== justBefore) endDiff = beforeLocator ? `the ZIP64 locator names a record at ${reloff}, the bytes before the locator hold another at ${justBefore}` : `the ZIP64 record is not directly before its locator (the locator names ${reloff}, not ${justBefore}), so a reader that looks just before the locator misses it`;
      const differs = (ord: number, max: number, v: number) => ord !== max && ord !== v;
      if (differs(count, 0xffff, c64) || differs(cdSize, 0xffffffff, s64) || differs(cdOffset, 0xffffffff, o64)) {
        endDiff = [endDiff, `the end record names ${count} entries at ${cdOffset}, the ZIP64 record ${c64} at ${o64}`].filter(Boolean).join("; ");
      }
      count = c64;
      cdSize = s64;
      cdOffset = o64;
      end = recAt;
    } else if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw new Error("no zip64 locator");
    // Bytes before the archive (a self-extractor stub): zipfile shifts every offset by them.
    const concat = end - cdSize - cdOffset;
    const cd = read(cdOffset + concat, cdSize);
    const out: ZipEntry[] = [];
    let budget = readBudget;
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
      const localName = flags & 0x800 ? new TextDecoder().decode(localRaw) : cp437(localRaw);
      if (!okLocal) entry.headerDiff = "no local header at its offset";
      else if (localName !== orig) entry.headerDiff = "the local header names another file (zipfile refuses it)";
      else if (U16(lh, 8) !== method) entry.headerDiff = `local method ${U16(lh, 8)}, central ${method}`;
      else if ((U16(lh, 6) & 0x8) !== (flags & 0x8)) entry.headerDiff = "the data descriptor flag differs between the local and central header";
      const refused = flags & 0x20 ? "compressed patched data (flag bit 5)" : flags & 0x40 ? "strong encryption (flag bit 6)" : needs > 63 ? `it needs zip version ${(needs / 10).toFixed(1)}` : undefined;
      if (refused) entry.content = { error: refused };
      else if (!name.endsWith("/")) {
        // A budget on what the compare reads and decodes, the artifact cap's size: past it a member holds unread.
        budget -= Math.max(csize, usize);
        if (budget < 0) entry.content = { error: `the compare's read budget of ${readBudget} bytes is spent` };
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

// The artifact cap's size (MAX_TOTAL_BYTES): each member counts once, at the larger of its two sizes, so a wheel that fits
// the cap never spends it.
export const ZIP_READ_BUDGET = 300_000_000;

const RECORD_CAP = 10_000;
const S_IFMT = 0o170000;
const S_IFDIR = 0o040000;
const S_IFREG = 0o100000;
// Info-ZIP Unicode Path and Unicode Comment: bsdtar takes the name from them, zipfile never does.
const UNICODE_EXTRAS = new Set([0x7075, 0x6375]);

// Python's str.splitlines: \n \r \r\n and the vertical tab, form feed, file/group/record separators, NEL and the two
// Unicode line and paragraph separators.
const LINE_BREAK = /\r\n|[\n\r\x0b\x0c\x1c\x1d\x1e\x85\u2028\u2029]/;

/** The first field of each row, as pip reads RECORD: csv.reader(text.splitlines()) with the default dialect. */
export function recordPaths(text: string): { paths: string[]; bad?: string } {
  const paths: string[] = [];
  let bad: string | undefined;
  const lines = text.split(LINE_BREAK);
  // A final line break leaves one empty piece that splitlines does not return.
  if (lines[lines.length - 1] === "") lines.pop();
  // _csv.c's states: a quote opens a quoted field only at a field's start (inside an unquoted field it is a plain
  // character), "" inside a quoted field is one quote, a line end inside a quoted field adds nothing (the field goes on
  // in the next line), and a quote followed by anything but a comma or the line end drops back into an ordinary field.
  let state: "record" | "start" | "field" | "quoted" | "quote" = "record";
  let field = "";
  let saved = 0;
  const save = () => {
    if (saved === 0) paths.push(field);
    saved++;
    field = "";
  };
  for (const line of lines) {
    if (line.includes(" ")) return { paths, bad: "a NUL character" };
    if (state === "record") {
      if (line === "") {
        bad ??= "a blank row, which pip's RECORD reader fails on";
        continue;
      }
      state = "start";
      saved = 0;
    }
    for (const c of line) {
      if (state === "start") {
        if (c === '"') state = "quoted";
        else if (c === ",") save();
        else (field += c), (state = "field");
      } else if (state === "field") {
        if (c === ",") (save(), (state = "start"));
        else field += c;
      } else if (state === "quoted") {
        if (c === '"') state = "quote";
        else field += c;
      } else if (c === '"') (field += c), (state = "quoted");
      else if (c === ",") (save(), (state = "start"));
      else (field += c), (state = "field");
      if (field.length > 131072) return { paths, bad: "a field over csv's 131072-character limit" };
    }
    if (state !== "quoted") (save(), (state = "record"));
  }
  if (state === "quoted") save();
  if (paths.some((p) => p === "")) bad ??= "an empty path, which pip resolves to the install directory itself";
  return { paths: paths.filter((p) => p !== ""), ...(bad === undefined ? {} : { bad }) };
}

/** Python's str.strip(): its whitespace set (str.isspace) is not JavaScript's (it has \x1c-\x1f and \x85, not \uFEFF). */
const PY_SPACE = "\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const PY_STRIP = new RegExp(`^[${PY_SPACE}]+|[${PY_SPACE}]+$`, "g");
const pyStrip = (t: string) => t.replace(PY_STRIP, "");

/**
 * What pip does with .data/scripts members for the entry points of the single raw top-level dist-info directory, or "unclear"
 * when the file is not read cleanly (several or no dist-info, a second member reaching the same path, not UTF-8, a BOM, an
 * odd line end, text outside a section, an entry without "=", a repeated section). This copies importlib.metadata's Sectioned:
 * each line is stripped (Python's whitespace), empty and "#" lines are dropped, a line that starts with "[" and ends with "]"
 * is a section named by strip("[]") (case-sensitive), and an entry splits at the first "=" with both sides stripped.
 * Two things lose a reviewed scripts member: pip skips it when its basename is EP, EP.exe, EP-script.py or EP.pya for an
 * entry EP (is_entrypoint_wrapper), and it is overwritten when its path is a launcher pip (distlib) writes: EP, EP.exe (a
 * ".py*" extension of EP dropped first), and for pip and easy_install their versioned names (pip's launcher maker has
 * add_launchers on, so it never writes EP.py or EP.pyw).
 */
function launcherNames(entries: readonly ZipEntry[], out: FileMap, dist: string | undefined): "unclear" | { skipped: Set<string>; written: Set<string>; versioned: RegExp[] } {
  const skipped = new Set<string>();
  const written = new Set<string>();
  const versioned: RegExp[] = [];
  const none = { skipped, written, versioned };
  if (dist === undefined) return entries.some((e) => /\.dist-info\/entry_points\.txt$/i.test(e.name)) ? "unclear" : none;
  const want = foldKey(`${dist}/entry_points.txt`);
  const members = entries.filter((e) => !e.name.endsWith("/") && foldKey(writtenAt(e.name)) === want);
  if (members.length === 0) return none;
  if (members.length !== 1 || members[0]!.name !== `${dist}/entry_points.txt`) return "unclear";
  const raw = out.get(members[0]!.name) ?? out.get(byNfdEarly(out, members[0]!.name) ?? "");
  if (!raw) return "unclear";
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(raw);
  } catch {
    return "unclear";
  }
  if (text.startsWith("\uFEFF") || /\r(?!\n)|[\v\f\x1c-\x1e\x85\u2028\u2029]/.test(text)) return "unclear";
  const seen = new Set<string>();
  let section: boolean | undefined;
  for (const line of text.split("\n")) {
    const l = pyStrip(line);
    if (l === "" || l.startsWith("#")) continue;
    if (l.startsWith("[") && l.endsWith("]")) {
      // Both readers pip has: importlib.metadata takes strip("[]") and pkg_resources takes the text between the outer brackets
      // stripped, so a section counts when either reading is console_scripts or gui_scripts.
      const names = [l.replace(/^[[\]]+|[[\]]+$/g, ""), pyStrip(l.slice(1, -1))];
      if (names.some((n) => seen.has(n))) return "unclear";
      for (const n of names) seen.add(n);
      section = names.some((n) => n === "console_scripts" || n === "gui_scripts");
      continue;
    }
    if (section === undefined) return "unclear";
    if (!section) continue;
    const eq = l.indexOf("=");
    if (eq <= 0) return "unclear";
    const name = pyStrip(l.slice(0, eq));
    // distlib finds the launcher's name with its own pattern (from the last space), so a name with whitespace or any odd
    // character is not modeled: it holds every scripts member.
    if (!/^[A-Za-z0-9._-]+$/.test(name)) return "unclear";
    const lower = name.toLowerCase();
    for (const n of [name, `${name}.exe`, `${name}-script.py`, `${name}.pya`]) skipped.add(foldKey(n));
    const ext = /\.py[^.]*$/i.exec(name);
    for (const n of [name, `${name}.exe`, ...(ext ? [`${name.slice(0, ext.index)}.exe`] : [])]) written.add(foldKey(n));
    if (lower === "pip") versioned.push(/^pip\d*(?:\.\d+)?(?:\.exe)?$/i);
    if (lower === "easy_install") versioned.push(/^easy_install(?:-\d+\.\d+)?(?:\.exe)?$/i);
  }
  return { skipped, written, versioned };
}

function wheelRecord(entries: readonly ZipEntry[], treeGet: (path: string) => Uint8Array | undefined): { paths: string[]; bad?: string } {
  // pip installs a member at its collapsed path, so x-1.dist-info/./RECORD and x-1.dist-info//RECORD are the RECORD it
  // uninstalls by; the last member written there wins.
  const recs = entries.filter((e) => !e.name.endsWith("/") && /^[^/]+\.dist-info\/RECORD$/.test(writtenAt(e.name)));
  const rec = recs[recs.length - 1];
  const bytes = rec && treeGet(writtenAt(rec.name));
  if (!bytes) return { paths: [] };
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return { paths: [], bad: "RECORD is not UTF-8, which pip refuses" };
  }
  return recordPaths(text);
}

/**
 * Notes for each member zipfile and bsdtar read differently: a name bsdtar did not list, a Unicode Path or Comment
 * extra, a backslash in a name, a mode whose type is not what pip writes (pip writes a directory only for a name ending
 * in "/", and a regular file for any other), a directory entry with data, and a wheel RECORD path with no member.
 */
export function zipNameNotes(path: string, listed: readonly string[], out: FileMap, readBudget?: number): TarNote[] {
  const notes: TarNote[] = [];
  const at = (why: string, name: string) => {
    const n: TarNote = { note: `zip member ${name}: ${why}`, key: "", kind: "zip member", raw: [name], paths: [name] };
    notes.push({ ...n, key: JSON.stringify(["zip member", why, name]) });
  };
  let entries: ZipEntry[];
  try {
    const dir = zipDirectory(path, readBudget);
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
  // A console_scripts or gui_scripts name in entry_points.txt (the one raw top-level dist-info's) is a launcher pip generates
  // in the scripts directory (on Windows name.exe and name-script.py; pip and easy_install also write versioned names),
  // replacing a reviewed .data/scripts member of that name. pip strips each line and splits an entry at the first "=", so
  // the parse here does the same and holds every .data/scripts member whenever the file is not read cleanly.
  const launchers = launcherNames(entries, out, distDirs.size === 1 ? [...distDirs][0] : undefined);
  for (const e of entries) {
    const w = writtenAt(e.name);
    if (e.name.endsWith("/") || !w.split("/", 1)[0]!.endsWith(".data")) continue;
    const [, scheme, ...rest] = w.split("/");
    if (scheme?.toLowerCase() !== "scripts" || rest.length === 0) continue;
    const path = rest.join("/");
    if (launchers === "unclear" || launchers.written.has(foldKey(path)) || launchers.skipped.has(foldKey(rest[rest.length - 1]!)) || launchers.versioned.some((re) => re.test(path))) {
      at(launchers === "unclear" ? "a scripts member beside an entry_points.txt that cannot be read the way pip reads it, so a generated launcher may be written over it" : "a scripts member with the name of a console_scripts or gui_scripts entry point, whose generated launcher pip writes over it", e.name);
    }
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
    if (e.name.endsWith("/")) {
      // zipfile makes a directory of it; the unpacked tree holding a file or link at that path means bsdtar read it
      // as another entry (a cpio file of the same name ahead of the zip).
      const dpath = writtenAt(e.name);
      const dkey = dpath === "" ? undefined : out.has(dpath) ? dpath : byNfd.get(dpath.normalize("NFD"));
      const held = dkey === undefined ? undefined : out.get(dkey);
      if (held) at(`zipfile makes a directory of it, the unpacked archive has ${isLink(held) ? "a link" : "a file"} at ${dpath}`, e.name);
    }
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
  // Normalized names are compared in NFD (bsdtar on macOS writes a zip's names decomposed) to tell the two holds apart.
  const tree = new Set([...out.keys()].map((k) => k.normalize("NFD")));
  // A name the zip wrote counts as exact too (when the tree has that file): a host without name normalization installs it
  // even where this extraction (macOS) holds it decomposed.
  const exact = new Set([...out.keys(), ...entries.map((e) => writtenAt(e.name))]);
  const rec = wheelRecord(entries, (p) => (out.has(p) ? out.get(p) : byNfd.has(p.normalize("NFD")) ? out.get(byNfd.get(p.normalize("NFD"))!) : undefined));
  if (rec.bad) at(`the wheel RECORD cannot be read as pip reads it: ${rec.bad}`, "(archive)");
  // Each distinct path once; a RECORD over the cap holds, so no row past it goes unchecked.
  const distinct = [...new Set(rec.paths)];
  if (distinct.length > RECORD_CAP) at(`the wheel RECORD lists ${distinct.length} distinct paths, over the ${RECORD_CAP} that are checked`, "(archive)");
  // A row that names no tree file as written holds. One that matches only after normalization names a file a host
  // without name normalization does not have, so it holds with its own reason. An exact match stays quiet.
  for (const p of distinct.slice(0, RECORD_CAP)) {
    const inTree = tree.has(p.normalize("NFD"));
    if (inTree && exact.has(p)) continue;
    if (inTree) at("the wheel RECORD names it, the unpacked archive has a file of that name only after Unicode normalization", p);
    else at("the wheel RECORD names it, the unpacked archive has no such file", p);
  }
  return notes;
}
