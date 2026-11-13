import { posix } from "node:path";
import { bytesEqual, LARGE_FILE_BYTES, type FileMap, type Signal } from "./prepass.ts";

// Soft signals for build-time and CI surfaces that a release can ship inside an npm or PyPI artifact:
// a Rust build script, Go code generation or cgo, and GitHub Actions workflow files. Each only points the
// reviewer at the file; none is a hold. Read as text, by path and by the lines the release adds.

const dec = new TextDecoder("utf-8", { fatal: false });

const base = (p: string) => p.slice(p.lastIndexOf("/") + 1);
const text = (f: FileMap, p: string) => {
  const b = f.get(p);
  // Over the cap the pre-pass already raises large-file; read nothing past it, the same line.
  return b && b.length <= LARGE_FILE_BYTES ? dec.decode(b) : undefined;
};

/** A Rust build script (build.rs) runs at build time, before any of the crate's own code. */
export const isRustBuildScript = (p: string) => base(p) === "build.rs";
/** A Go source file. `go generate` reads test files too; cgo does not build in them. */
export const isGoSource = (p: string) => p.endsWith(".go");
const isGoTest = (p: string) => p.endsWith("_test.go");
/** A workflow file under .github/workflows, or an action.yml / action.yaml (a composite or JavaScript action). */
export const isWorkflowFile = (p: string) => /(^|\/)\.github\/workflows\/[^/]+\.ya?ml$/.test(p) || /(^|\/)action\.ya?ml$/.test(p);

const GO_GENERATE = /^\s*\/\/go:generate\b/;
// Read on goCode's output, where every string is "" except the path "C". A one-path import: `import`, an optional name
// (`.`, which needs no space, or `_` or an identifier after one), then "C". An import group: its contents to the closing
// paren, split into tokens; a path with its name may be one token (`_"C"`). Both start only at the keyword, and the group
// stops at any paren, so a scan costs linear time. A Go identifier is Unicode letters, digits and _, so the keyword's
// boundary and a name are read with Unicode classes (a field named αimport is no import).
const GO_IMPORT_C = /(?<![\p{L}\p{Nd}_.])import(?:\s*\.|\s+[\p{L}_][\p{L}\p{Nd}_]*)?\s*"C"/u;
const GO_IMPORT_GROUP = /(?<![\p{L}\p{Nd}_.])import\s*\(([^()]*)\)/gu;
const GO_C_TOKEN = /^(?:\.|[\p{L}_][\p{L}\p{Nd}_]*)?"C"$/u;
// An interpreted string that is one escape for C (\x43, \103, \u0043, \U00000043) unquotes to the same import path.
const GO_ESCAPED_C = /^\\(?:x43|103|u0043|U00000043)$/;
/**
 * Go source with its comments taken out (a block comment's newlines kept) and every string and rune turned into "" or ''
 * ("C" for a string that is exactly C, raw or not, or one escape for it: the same import path), read in one pass the way
 * the Go scanner reads it: a backquote or a quote inside a comment or another string opens nothing. A carriage return is
 * no line end in Go, so it reads as a space.
 */
function goCode(src: string): string {
  let out = "";
  let i = 0;
  let from = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i]!;
    if (c === "/" && src[i + 1] === "/") {
      out += src.slice(from, i);
      const e = src.indexOf("\n", i);
      i = from = e < 0 ? n : e;
    } else if (c === "/" && src[i + 1] === "*") {
      out += src.slice(from, i) + " ";
      const e = src.indexOf("*/", i + 2);
      const end = e < 0 ? n : e + 2;
      out += src.slice(i, end).replace(/[^\n]+/g, "");
      i = from = end;
    } else if (c === "`") {
      out += src.slice(from, i);
      const e = src.indexOf("`", i + 1);
      const end = e < 0 ? n : e + 1;
      out += src.slice(i + 1, end - 1).replace(/\r/g, "") === "C" ? '"C"' : '""';
      i = from = end;
    } else if (c === '"' || c === "'") {
      // An interpreted string or a rune: to its closing quote, past escapes, never past a newline.
      out += src.slice(from, i);
      let j = i + 1;
      while (j < n && src[j] !== c && src[j] !== "\n") j += src[j] === "\\" ? 2 : 1;
      const body = src.slice(i + 1, j);
      out += c === '"' && (body === "C" || GO_ESCAPED_C.test(body)) ? '"C"' : c + c;
      i = from = Math.min(j + 1, n);
    } else i++;
  }
  return (out + src.slice(from)).replace(/\r/g, " ");
}
// Known limit: a .c, .s or .h file added beside an existing import "C" is compiled by cgo but raises nothing here.
const hasImportC = (src: string) => {
  const t = goCode(src);
  if (GO_IMPORT_C.test(t)) return true;
  for (const g of t.matchAll(GO_IMPORT_GROUP)) if (g[1]!.split(/[\s;]+/).some((tok) => GO_C_TOKEN.test(tok))) return true;
  return false;
};
const GO_CGO_LINE = /^(?:\/\/\s*)?#cgo\b/;

const lines = (t: string | undefined) => (t ?? "").split(/\r?\n/);
const lineSet = (t: string | undefined) => new Set(lines(t).map((l) => l.trim()));
const fresh = (before: Set<string>, now: string, re: RegExp) => lines(now).map((l) => l.trim()).filter((l) => re.test(l) && !before.has(l));

const sameBytes = (a: Uint8Array | undefined, b: Uint8Array | undefined) => !!a && !!b && bytesEqual(a, b);

function rustSignals(oldFiles: FileMap, newFiles: FileMap, p: string): Signal[] {
  const prev = oldFiles.get(p);
  const now = newFiles.get(p)!;
  if (sameBytes(prev, now)) return [];
  return [{ kind: prev ? "rust-build-script-changed" : "rust-build-script-added", path: p, detail: prev ? "build.rs changed; it runs at build time" : "new build.rs; it runs at build time" }];
}

/** The custom build script a Cargo.toml names under [package] (`build = "<path>"`), relative to the crate; undefined for none or the default. */
export function cargoBuildScript(toml: string | undefined): string | undefined {
  const key = toml === undefined ? undefined : readCargoBuild(toml).key;
  return typeof key === "string" ? key : undefined;
}

/** What a Cargo.toml says under [package] build: the key (see below) and the list form, from one read of the text. */
type CargoBuild = { key: string | false | undefined; list: string[] | undefined };

/**
 * The [package] build key: the script path it names, false when it turns the build script off, undefined when absent
 * (or true: the crate root's build.rs).
 * A list of scripts (build = ["a.rs", "b.rs"], an unstable Cargo form) reads as undefined here, so the crate root's
 * build.rs is followed as usual; the list form is read from the same result, and cargoListSignals raises a soft signal for it and for
 * each listed script that is added or changed.
 * Known limit: whether Cargo accepts a list, and which listed script runs, is not checked; every listed file is treated
 * as a script that runs.
 * The manifest is read once and both forms are taken from that one result. The line reader runs only when the TOML parser
 * refuses the text, or the manifest has so many keys and tables that the parser would be slow on it.
 */
function readCargoBuild(toml: string): CargoBuild {
  if (!parserIsSlow(toml)) {
    try {
      const build = (Bun.TOML.parse(toml) as { package?: { build?: unknown } }).package?.build;
      return {
        key: typeof build === "string" ? build.replace(/^\.\//, "") : build === false ? false : undefined,
        list: Array.isArray(build) ? listEntries(flatStrings(build)) : undefined,
      };
    } catch {
      // The parser refuses the text: the line reader below.
    }
  }
  return readCargoLines(toml);
}

/** The TOML parser's time grows with the square of the keys and tables in one document (a manifest of 8,000 small tables
 * takes about 0.1 s, of 130,000 about half a minute), not with its size: a manifest of one big string or array parses in
 * a few milliseconds per megabyte. Each `=` and `[` counts as a key or table; text with more of them than this goes to
 * the line reader. */
const CARGO_PARSE_MARKS = 4096;
function parserIsSlow(toml: string): boolean {
  let marks = 0;
  for (let i = 0; i < toml.length; i++) {
    const c = toml.charCodeAt(i);
    if ((c === 61 || c === 91) && ++marks > CARGO_PARSE_MARKS) return true;
  }
  return false;
}

/** The strings of a parsed array, nested arrays included (a string inside an inline table is no entry). */
function flatStrings(a: unknown[]): string[] {
  const out: string[] = [];
  const todo: unknown[] = [a];
  while (todo.length) {
    const v = todo.pop();
    if (typeof v === "string") out.push(v);
    else if (Array.isArray(v)) for (let i = v.length - 1; i >= 0; i--) todo.push(v[i]);
  }
  return out;
}

const ESCAPES: Record<string, string> = { b: "\b", t: "\t", n: "\n", f: "\f", r: "\r", e: "\x1b", '"': '"', "\\": "\\" };
/** A basic string's escapes, decoded; a bad escape stays as written. In a multi-line string a backslash at a line end
 * also takes the whitespace after the break. */
function unescapeBasic(s: string): string {
  if (!s.includes("\\")) return s;
  return s.replace(/\\[ \t]*\r?\n\s*|\\(u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|x[0-9a-fA-F]{2}|[\s\S])/g, (m, e: string | undefined) => {
    if (e === undefined) return "";
    if (e.length > 1) {
      const cp = parseInt(e.slice(1), 16);
      return cp > 0x10ffff || (cp >= 0xd800 && cp < 0xe000) ? m : String.fromCodePoint(cp);
    }
    return ESCAPES[e] ?? m;
  });
}

/** Multi-line string delimiters (`"""`, `'''`) known to have no closing delimiter after them in the text being read: nothing
 * later can close such a string either, so a later opener is not searched for a closer again. */
type NoCloser = Set<string>;

/** The end (just past the closing delimiter) of a multi-line string whose body starts at `from`; -1 when it runs on. */
function multiEnd(s: string, from: number, q3: string): number {
  const c = q3[0]!;
  for (let i = from; i < s.length; i++) {
    if (c === '"' && s[i] === "\\") i++;
    else if (s.startsWith(q3, i)) {
      let e = i + 3;
      while (s[e] === c && e < i + 5) e++; // up to two quotes of the body may sit right before the closing three
      return e;
    }
  }
  return -1;
}

/** The TOML string that opens at `src[i]` (a quote): its value and the index after it. Undefined when it never closes (a
 * one-line string ends at the line end; a multi-line one runs to the end of the text). `none` remembers a multi-line
 * delimiter that found no closer, so a text of many unclosed openers is read in one pass. */
function tomlString(src: string, i: number, none?: NoCloser): { value: string; end: number } | undefined {
  const c = src[i]!;
  const q3 = c.repeat(3);
  if (src.startsWith(q3, i)) {
    if (none?.has(q3)) return undefined;
    const e = multiEnd(src, i + 3, q3);
    if (e < 0) {
      none?.add(q3);
      return undefined;
    }
    let body = src.slice(i + 3, e - 3).replace(/^\r?\n/, "").replace(/\r\n/g, "\n");
    if (c === '"') body = unescapeBasic(body);
    return { value: body, end: e };
  }
  let j = i + 1;
  while (j < src.length && src[j] !== c && src[j] !== "\n") j += c === '"' && src[j] === "\\" ? 2 : 1;
  if (src[j] !== c) return undefined;
  const body = src.slice(i + 1, j);
  return { value: c === '"' ? unescapeBasic(body) : body, end: j + 1 };
}

/** A blank that is no line end: a space or tab, and the other whitespace a loose reader treats as a blank (form feed,
 * vertical tab, a no-break space and the like). */
const isBlank = (c: string | undefined) => c === " " || c === "\t" || (c !== undefined && c !== "\n" && c !== "\r" && c.trim() === "");
const skipSpace = (s: string, i: number) => {
  while (i < s.length && isBlank(s[i])) i++;
  return i;
};

const BARE_KEY = /[A-Za-z0-9_-]+/y;
/** A key path (`a`, `"a".b`, `a . 'b'`) at `s[i]`: its parts and the index after it. */
function tomlKeyPath(s: string, i = 0, none?: NoCloser): { path: string[]; end: number } | undefined {
  const path: string[] = [];
  for (;;) {
    i = skipSpace(s, i);
    const c = s[i];
    if (c === '"' || c === "'") {
      const r = tomlString(s, i, none);
      if (!r) return undefined;
      path.push(r.value);
      i = r.end;
    } else {
      BARE_KEY.lastIndex = i;
      const m = BARE_KEY.exec(s);
      if (!m) return undefined;
      path.push(m[0]);
      i += m[0].length;
    }
    i = skipSpace(s, i);
    if (s[i] !== ".") return { path, end: i };
    i++;
  }
}

/** A line with its trailing comment cut (one-line strings kept whole). */
function lineCode(line: string): string {
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (c === "#") return line.slice(0, i);
    if (c === '"' || c === "'") {
      i++;
      while (i < line.length && line[i] !== c) i += c === '"' && line[i] === "\\" ? 2 : 1;
    }
  }
  return line;
}

/** A line that starts a table: `[` or `[[` and a word that is no value (a bare key, not true, false, inf, nan). The same
 * text inside an array can only be the entries of an array the file forgot to close. */
const HEADER_LIKE = /\[\[?[ \t]*(?!(?:true|false|inf|nan)(?![A-Za-z0-9_-]))[A-Za-z_]/y;

/** Where the package's build key gets a value: the span of text from the value on to its end. */
type Span = { from: number; to: number };

/**
 * The spans of every value the text gives the package's build key, in file order, read in one pass over the text:
 * `build = ..` under [package] (the header may be spaced, quoted or end in a comment), a dotted or quoted key
 * (`package.build`, `"build"`) at the top, and `package = { build = .. }`. A header of an array of tables ([[bin]]) or any
 * other table ends [package]. Values are skipped as TOML reads them, over lines: strings (multi-line ones whole),
 * arrays and inline tables nest to any depth, comments are cut, so a line inside any of them is no table header and no
 * key. An array the file never closes ends at a line that starts a table or a new key, and an inline table at a line that
 * starts a table.
 */
function buildSpans(s: string): Span[] {
  const out: Span[] = [];
  const n = s.length;
  const none: NoCloser = new Set();
  const eol = (i: number) => {
    const e = s.indexOf("\n", i);
    return e < 0 ? n : e;
  };
  const skipBlank = (i: number) => {
    for (;;) {
      const c = s[i];
      if (c === "\r" || c === "\n" || isBlank(c)) i++;
      else if (c === "#") i = eol(i);
      else return i;
    }
  };
  const lineStart = (i: number) => {
    let j = i;
    while (j > 0 && isBlank(s[j - 1])) j--;
    return j === 0 || s[j - 1] === "\n" ? j : -1;
  };
  /** The start of the line `i` begins when the text there is the end of a container that was left open, else -1. */
  const leftOpen = (i: number, inArray: boolean) => {
    const c = s[i]!;
    const isHeader = c === "[" && ((HEADER_LIKE.lastIndex = i), HEADER_LIKE.test(s));
    const isKey = inArray && !isHeader && c !== "[" && c !== "]" && c !== "{" && c !== "," && (() => {
      const k = tomlKeyPath(s, i, none);
      return !!k && s[skipSpace(s, k.end)] === "=" && s[skipSpace(s, k.end) + 1] !== "=";
    })();
    return isHeader || isKey ? lineStart(i) : -1;
  };
  type Entry = (path: string[], from: number, to: number) => void;
  /** The end of the value at `start`, read with an explicit stack so nesting has no depth limit. A container left open ends
   * at the line start that shows it. `entry` is told each key and value span of the outermost inline table. The stack is
   * two flat arrays (container kind, and where its last element began), not an object per bracket, so a long run of
   * brackets costs a few bytes each. */
  const value = (start: number, entry?: Entry): number => {
    let kinds = new Uint8Array(64); // 1: array, 2: inline table
    let ats = new Int32Array(64);
    let depth = 0;
    let key: string[] | undefined; // the outermost inline table's key whose value is being read
    let keyFrom = 0;
    let i = start;
    for (;;) {
      // The value at i: a string or scalar gives its end; a container is opened and its elements read below.
      const c = s[i];
      let end = -1;
      if (c === '"' || c === "'") {
        const r = tomlString(s, i, none);
        end = r ? r.end : s.startsWith(c.repeat(3), i) ? n : eol(i);
      } else if (c === "[" || c === "{") {
        if (depth === kinds.length) {
          const k2 = new Uint8Array(depth * 2);
          k2.set(kinds);
          kinds = k2;
          const a2 = new Int32Array(depth * 2);
          a2.set(ats);
          ats = a2;
        }
        kinds[depth] = c === "[" ? 1 : 2;
        ats[depth++] = i;
        i++;
      } else {
        // A number, boolean, date or junk: to the comma, bracket, brace, comment or line end.
        let j = i;
        while (j < n) {
          const d = s[j];
          if (d === "," || d === "]" || d === "}" || d === "#" || d === "\n") break;
          j++;
        }
        end = j;
      }
      for (;;) {
        if (end >= 0) {
          // A value ended at `end`: hand it to the container it sits in.
          if (depth === 0) return end;
          if (depth === 1 && key) {
            entry?.(key, keyFrom, end);
            key = undefined;
          }
          const at = ats[depth - 1]!;
          i = end > at ? end : at + 1;
          end = -1;
        }
        i = skipBlank(i);
        if (i >= n) return n;
        const d = s[i]!;
        const arr = kinds[depth - 1] === 1;
        if (d === (arr ? "]" : "}")) {
          depth--;
          end = i + 1;
          continue;
        }
        if (d === ",") {
          i++;
          continue;
        }
        const left = leftOpen(i, arr);
        if (left >= 0) return left;
        ats[depth - 1] = i;
        if (arr) break; // an element: read its value
        const k = tomlKeyPath(s, i, none);
        const eq = k ? skipSpace(s, k.end) : -1;
        if (!k || s[eq] !== "=") {
          // Not an entry: past the junk to the next comma, brace or line end.
          let j = i;
          while (j < n && s[j] !== "," && s[j] !== "}" && s[j] !== "\n") j++;
          i = j > i ? j : i + 1;
          continue;
        }
        i = skipSpace(s, eq + 1);
        if (depth === 1) {
          key = k.path;
          keyFrom = i;
        }
        break;
      }
    }
  };

  // Where the keys read now belong: the top of the file, the [package] table, or any other table (or an array of tables).
  // Kept as a kind so no key line copies the table's path, which can have any number of parts.
  const ROOT = 0, PACKAGE = 1, OTHER = 2;
  let section = ROOT;
  let i = 0;
  while (i < n) {
    i = skipBlank(i);
    if (i >= n) break;
    if (s[i] === "[") {
      const e = eol(i);
      const code = lineCode(s.slice(i, e)).trim();
      if (code.startsWith("[[")) section = OTHER;
      else if (code.endsWith("]")) {
        const inner = code.slice(1, -1);
        const k = tomlKeyPath(inner);
        const named = k && k.end >= inner.trimEnd().length ? k.path : undefined;
        section = named?.length === 1 && named[0] === "package" ? PACKAGE : OTHER;
      }
      i = e;
      continue;
    }
    const k = tomlKeyPath(s, i, none);
    const eq = k ? skipSpace(s, k.end) : -1;
    if (!k || s[eq] !== "=") {
      i = eol(i);
      continue;
    }
    const from = skipSpace(s, eq + 1);
    const p = k.path;
    if ((section === PACKAGE && p.length === 1 && p[0] === "build") || (section === ROOT && p.length === 2 && p[0] === "package" && p[1] === "build")) {
      i = value(from);
      out.push({ from, to: i });
    } else if (section === ROOT && p.length === 1 && p[0] === "package" && s[from] === "{") {
      // package = { name = "x", build = .. }: the inline table may run over lines.
      i = value(from, (p, a, b) => {
        if (p.length === 1 && p[0] === "build") out.push({ from: a, to: b });
      });
    } else i = value(from);
    if (i > 0 && s[i - 1] !== "\n") i = eol(i);
  }
  return out;
}

/** The line reader: the build key and list from the text, for a Cargo.toml the TOML parser refuses or would be slow on. */
function readCargoLines(toml: string): CargoBuild {
  let key: string | false | undefined;
  let list: string[] | undefined;
  for (const sp of buildSpans(toml)) {
    const v = toml.slice(sp.from, sp.to).trim();
    if (key === undefined) {
      if (v === "false") key = false;
      else if (v[0] === '"' || v[0] === "'") {
        const r = tomlString(v, 0);
        if (r && r.end === v.length) key = r.value.replace(/^\.\//, "");
      }
    }
    // The array may run over several lines: read from the bracket to its close.
    if (list === undefined && v[0] === "[") list = listEntries(tomlStringArray(v.slice(1)));
  }
  return { key, list };
}

/** The strings of a TOML array, from just after its opening bracket to the closing one: basic and literal strings (escapes
 * decoded, multi-line strings whole), nested arrays' strings too, comments skipped, one pass. An unterminated string is
 * dropped. An array the file never closes ends where a new key or table header starts (a bare word before `=`, a quoted
 * key before `=`, a `[name]` or `[[name]]` line), so strings of later keys are not read as entries. */
function tomlStringArray(src: string): string[] {
  const out: string[] = [];
  const none: NoCloser = new Set();
  const n = src.length;
  let i = 0;
  let lineStart = true;
  let depth = 0; // nested arrays
  let braces = 0; // inline tables: their strings are keys and values, no entries
  while (i < n) {
    const c = src[i]!;
    if (c === "]") {
      if (depth === 0) break;
      depth--;
      i++;
    } else if (c === "\n") {
      lineStart = true;
      i++;
    } else if (/\s/.test(c)) i++;
    else {
      const atStart = lineStart;
      lineStart = false;
      if (c === '"' || c === "'") {
        const q3 = c.repeat(3);
        const s = tomlString(src, i, none);
        if (!s) {
          // Unterminated: a multi-line opener is skipped (nothing after it closes it), a one-line string runs to the line end.
          if (src.startsWith(q3, i)) i += 3;
          else {
            const e = src.indexOf("\n", i);
            i = e < 0 ? n : e;
          }
          continue;
        }
        const after = skipSpace(src, s.end);
        if (braces === 0 && (src[after] === "=" || src[after] === ".")) break; // a quoted key, not an entry
        if (braces === 0) out.push(s.value);
        i = s.end;
      } else if (c === "#") {
        while (i < n && src[i] !== "\n") i++;
      } else if (c === "[" && atStart && ((HEADER_LIKE.lastIndex = i), HEADER_LIKE.test(src))) {
        break; // a table header at a line start
      } else if (c === "[") {
        depth++;
        i++;
      } else if (c === "{") {
        braces++;
        i++;
      } else if (c === "}") {
        if (braces > 0) braces--;
        i++;
      } else if (c === "," || c === "=") i++;
      else {
        // A bare token: a number or boolean entry, or a bare key that starts the next assignment.
        let j = i;
        while (j < n && !/[\s,\][{}#"'=]/.test(src[j]!)) j++;
        if (braces === 0 && src[skipSpace(src, j)] === "=") break;
        i = j > i ? j : i + 1;
      }
    }
  }
  return out;
}

/** Every entry as the file writes it and, where it differs, with its spaces trimmed (a leading ./ removed from both). */
const listEntries = (all: string[]) => [...new Set(all.flatMap((e) => [e.replace(/^\.\//, ""), e.trim().replace(/^\.\//, "")]))];

/**
 * Soft signals for a list-form build key. One on the manifest when the list is new or its entries changed (provided a
 * listed file ships), and one per listed script that is added (not named by the old manifest, or not in the old files) or
 * changed. A listed build.rs is read on its own path, as the string form is.
 */
function cargoListSignals(oldFiles: FileMap, newFiles: FileMap, p: string, unchanged: (path: string) => boolean, built: Built): Signal[] {
  const list = built(newFiles, p)?.list;
  if (!list?.length) return [];
  const old = built(oldFiles, p);
  const dir = p.includes("/") ? p.slice(0, p.lastIndexOf("/") + 1) : "";
  const norm = (e: string) => posix.normalize(dir + e);
  const paths = [...new Set(list.map(norm))].filter((sp) => newFiles.has(sp));
  if (!paths.length) return [];
  const oldList = old?.list;
  const oldScript = typeof old?.key === "string" ? old.key : undefined;
  const oldNamed = new Set([...(oldList ?? []), ...(oldScript !== undefined ? [oldScript] : [])].map(norm));
  const out: Signal[] = [];
  const key = (l: string[]) => [...new Set(l.map(norm))].sort().join("\n");
  if (!oldList || key(oldList) !== key(list)) {
    const kind = oldList ? "rust-build-script-changed" : "rust-build-script-added";
    out.push({ kind, path: p, detail: `${oldList ? "changed" : "new"} list of custom build scripts in ${p}; they run at build time`.slice(0, 160) });
  }
  for (const sp of paths) {
    const named = oldNamed.has(sp);
    const prev = oldFiles.get(sp);
    // A script shipped before and unchanged raises nothing of its own: the list signal covers a newly listed one.
    if (prev && unchanged(sp)) continue;
    if (isRustBuildScript(sp) && (named || !prev || !unchanged(sp))) continue;
    const added = !named || !prev;
    out.push({ kind: added ? "rust-build-script-added" : "rust-build-script-changed", path: sp, detail: `${added ? "new" : "changed"} custom build script named in ${p}; it runs at build time` });
  }
  return out;
}

/** Per release: `seen`, the signal already reported for each build script path (one per path, however many manifests
 * name it, and a build.rs read on its own path counts); `same`, each path's old-versus-new byte comparison, made once
 * however many manifests share the script. */
type CargoState = { seen: Map<string, Signal>; same: Map<string, boolean>; byText: Map<string, CargoBuild>; byPath: Map<FileMap, Map<string, CargoBuild | undefined>> };
/** A manifest's build key and list, each manifest text read once per release: by path on each side, and by text, so the
 * same manifest under many paths is read once too. */
type Built = (files: FileMap, p: string) => CargoBuild | undefined;
function builtReader(st: CargoState): Built {
  return (files, p) => {
    let paths = st.byPath.get(files);
    if (!paths) st.byPath.set(files, (paths = new Map()));
    if (paths.has(p)) return paths.get(p);
    const t = text(files, p);
    let b: CargoBuild | undefined;
    if (t !== undefined) {
      b = st.byText.get(t);
      if (!b) st.byText.set(t, (b = readCargoBuild(t)));
    }
    paths.set(p, b);
    return b;
  };
}
/** One signal per script path. A script that is new to one manifest and changed under another is reported as added
 * (it now runs where it did not): the added signal takes the place of the changed one, where that was reported. */
function oncePerPath(st: CargoState, sig: Signal | undefined): Signal[] {
  if (!sig) return [];
  const prev = st.seen.get(sig.path);
  if (!prev) {
    st.seen.set(sig.path, sig);
    return [sig];
  }
  if (prev.kind === "rust-build-script-changed" && sig.kind === "rust-build-script-added") Object.assign(prev, sig);
  return [];
}
function cargoSignals(oldFiles: FileMap, newFiles: FileMap, p: string, st: CargoState): Signal[] {
  const unchanged = (path: string) => {
    let v = st.same.get(path);
    if (v === undefined) st.same.set(path, (v = sameBytes(oldFiles.get(path), newFiles.get(path))));
    return v;
  };
  const built = builtReader(st);
  return [oncePerPath(st, cargoSignal(oldFiles, newFiles, p, unchanged, built)), ...cargoListSignals(oldFiles, newFiles, p, unchanged, built).map((s) => oncePerPath(st, s))].flat();
}
function cargoSignal(oldFiles: FileMap, newFiles: FileMap, p: string, unchanged: (path: string) => boolean, built: Built): Signal | undefined {
  const key = built(newFiles, p)?.key;
  if (key === false) return undefined;
  const old = built(oldFiles, p);
  const oldPresent = old !== undefined; // false when the old manifest is absent or over the size cap
  const oldKey = old?.key;
  const dir = p.includes("/") ? p.slice(0, p.lastIndexOf("/") + 1) : "";
  const root = posix.normalize(dir + "build.rs");
  const runsRoot = (k: string | false | undefined) => k === undefined || (typeof k === "string" && posix.normalize(dir + k) === root);
  if (runsRoot(key)) {
    // The crate root's build.rs runs. A new one is raised on its own path; one the old manifest turned off, or passed over
    // for another script, starts running now: added, and said to be changed too when it is (in place of the changed signal
    // its own path raises).
    if (!oldPresent || runsRoot(oldKey) || !newFiles.has(root)) return undefined;
    const changed = !unchanged(root);
    if (changed && !oldFiles.has(root)) return undefined;
    const why = oldKey === false ? "no longer turns the build script off" : "no longer names another build script";
    return { kind: "rust-build-script-added", path: root, detail: `build.rs now runs${changed ? ", changed" : ""}: ${p} ${why}`.slice(0, 160) };
  }
  const sp = posix.normalize(dir + key!);
  if (!newFiles.has(sp)) return undefined;
  // Compared as normalized paths: "./gen.rs" and "gen.rs" are the same script.
  const oldScript = typeof old?.key === "string" ? old.key : undefined;
  const named = oldScript !== undefined && posix.normalize(dir + oldScript) === sp;
  const prev = oldFiles.get(sp);
  // A build.rs is read on its own path (a new or changed one is raised there). Followed from here: a script under another
  // name, and a build.rs elsewhere that the manifest newly names while it was already shipped (it did not run before, and
  // its own path raises nothing when it is unchanged).
  if (isRustBuildScript(sp) && (named || !prev || !unchanged(sp))) return undefined;
  if (named && unchanged(sp)) return undefined;
  const added = !named || !prev;
  return { kind: added ? "rust-build-script-added" : "rust-build-script-changed", path: sp, detail: `${added ? "new" : "changed"} custom build script named in ${p}; it runs at build time` };
}

function goSignals(oldFiles: FileMap, newFiles: FileMap, p: string): Signal[] {
  const now = text(newFiles, p);
  if (now === undefined) return [];
  const prev = text(oldFiles, p);
  const before = lineSet(prev);
  const out: Signal[] = [];
  const gen = fresh(before, now, GO_GENERATE);
  if (gen.length) out.push({ kind: "go-generate-added", path: p, detail: gen[0]!.slice(0, 160) });
  if (!isGoTest(p) && hasImportC(now)) {
    const cgo = fresh(before, now, GO_CGO_LINE);
    const newImport = prev === undefined || !hasImportC(prev);
    if (newImport || cgo.length) out.push({ kind: "go-cgo-added", path: p, detail: (cgo[0] ?? 'import "C"').slice(0, 160) });
  }
  return out;
}

// Workflows are read with the YAML parser; the line reader below is the fallback for a file it refuses, so broken YAML is still checked.
// Known limit: a workflow file inside a package never runs for the people who install it; the signal is for a reviewer reading the release, or a repo built from it.
// [\s\S]* (not .*) to the end: . stops at a lone \r, and $ would then fail and retry from every later "#".
const stripComment = (l: string) => l.replace(/(^|\s)#[\s\S]*$/, "$1");
const indentOf = (l: string) => l.length - l.trimStart().length;
/** A YAML scalar without its surrounding single or double quotes. */
const unq = (v: string) => v.trim().replace(/^(["'])(.*)\1$/, "$2");
// A key, quoted or not, at the start of a line or after a list dash: group 1 the dash, 2 the key, 3 the rest.
const KEY = /^\s*(-\s+)?["']?([A-Za-z0-9_-]+)["']?\s*:(?:\s+([\s\S]*)|\s*)$/;
// A "<scope>: write" pair inside a flow map; the key and the value may be quoted. A match starts only where a name starts
// (the lookbehind), so a long run of letters is not retried from every position inside it.
const FLOW_WRITE = /(?<![A-Za-z-])["']?([A-Za-z-]+)["']?\s*:\s*["']?write["']?\s*(?=[,}]|$)/g;
// A value that opens a block scalar (`|`, `>`, with chomping or indent marks).
const BLOCK_SCALAR = /(?::|^\s*-)\s+[|>][-+0-9]*\s*$/;
// Keys whose contents are data (action inputs, environment, outputs), never a grant.
const DATA_KEYS = new Set(["with", "env", "inputs", "outputs"]);

/** The column of a line's key: past a list dash, if there is one. */
const keyCol = (l: string) => {
  const m = /^(\s*-\s+)["']?[A-Za-z0-9_-]+["']?\s*:/.exec(l);
  return m ? m[1]!.length : indentOf(l);
};
/** Scan one line for flow brackets outside quoted strings: the change in depth, and the quote still open at its end. */
const scanBrackets = (l: string, quote: string): { delta: number; quote: string } => {
  let d = 0;
  let q = quote;
  for (const c of l) {
    if (q) { if (c === q) q = ""; }
    else if (c === '"' || c === "'") q = c;
    else if (c === "[" || c === "{") d++;
    else if (c === "]" || c === "}") d--;
  }
  return { delta: d, quote: q };
};
/** A flow value is joined over at most this many following non-blank lines. */
const MAX_FLOW_JOIN = 200;

/**
 * The YAML lines that carry structure: comments cut, blank lines and block scalar bodies dropped, a flow value spread over
 * lines joined into one. The bracket depth is kept as lines are added (never a rescan of the joined text), and a join stops
 * at a line back at indent 0 (a closing ] or } there still belongs to it) or after MAX_FLOW_JOIN non-blank lines, so an
 * unclosed bracket costs linear time and does not swallow the rest of the file.
 */
function yamlLogical(src: string): string[] {
  // YAML ends a line at a lone \r too (a Go or TOML reader does not).
  const raw = src.split(/\r\n|\r|\n/).map(stripComment);
  const out: string[] = [];
  let scalarCol = -1;
  for (let i = 0; i < raw.length; i++) {
    let l = raw[i]!;
    if (!l.trim()) continue;
    if (scalarCol >= 0 && indentOf(l) > scalarCol) continue;
    scalarCol = -1;
    let { delta: depth, quote } = scanBrackets(l, "");
    const parts = [l];
    for (let n = 0; depth > 0 && n < MAX_FLOW_JOIN && i + 1 < raw.length; ) {
      const next = raw[i + 1]!;
      const t = next.trim();
      if (t && indentOf(next) === 0 && !/^[\]}]/.test(t)) break;
      i++;
      if (!t) continue;
      n++;
      parts.push(t);
      const r = scanBrackets(t, quote);
      depth += r.delta;
      quote = r.quote;
    }
    l = parts.join(" ");
    out.push(l);
    if (BLOCK_SCALAR.test(l)) scalarCol = keyCol(l);
  }
  return out;
}

/** The write grants of each permissions block: the workflow level (undefined: no block) and each job's own block. */
interface Permissions {
  workflow?: Set<string>;
  jobs: Map<string, Set<string> | undefined>;
}
interface Workflow {
  perms: Permissions;
  triggers: Set<string>;
}

// Triggers that run with the base repository's token and secrets on an event an outside user can cause (opening an issue
// or a discussion, or commenting on one, needs no write access).
const RISKY = new Set(["pull_request_target", "workflow_run", "issue_comment", "pull_request_review_comment", "issues", "discussion", "discussion_comment"]);
const isMap = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** "write-all" and "<scope> write" from a parsed permissions value. */
function grantsOf(v: unknown): Set<string> {
  const out = new Set<string>();
  if (v === "write-all") out.add("write-all");
  else if (isMap(v)) for (const [k, x] of Object.entries(v)) if (x === "write") out.add(`${k} write`);
  return out;
}

/** A workflow or action file read with the YAML parser (anchors resolved); the line reader when the parser refuses it. */
function readWorkflow(src: string): Workflow {
  let doc: unknown;
  try {
    doc = Bun.YAML.parse(src);
  } catch {
    return { perms: linesPermissions(src), triggers: linesTriggers(src) };
  }
  // Several documents (an array) are no workflow the parser can place: read them as lines. An empty file or a scalar holds nothing.
  if (Array.isArray(doc)) return { perms: linesPermissions(src), triggers: linesTriggers(src) };
  if (!isMap(doc)) return { perms: { jobs: new Map() }, triggers: new Set() };
  const jobs = new Map<string, Set<string> | undefined>();
  if (isMap(doc.jobs)) for (const [name, job] of Object.entries(doc.jobs)) jobs.set(name, isMap(job) && Object.hasOwn(job, "permissions") ? grantsOf(job.permissions) : undefined);
  const on = doc.on;
  const names = typeof on === "string" ? [on] : Array.isArray(on) ? on.filter((x): x is string => typeof x === "string") : isMap(on) ? Object.keys(on) : [];
  return {
    perms: { workflow: Object.hasOwn(doc, "permissions") ? grantsOf(doc.permissions) : undefined, jobs },
    triggers: new Set(names.filter((n) => RISKY.has(n))),
  };
}

/** The line reader's permissions: for a file the YAML parser refuses. */
function linesPermissions(src: string): Permissions {
  const r: Permissions = { jobs: new Map() };
  const ls = yamlLogical(src);
  let dataCol = -1;
  let inJobs = false;
  let jobCol = -1;
  let job = "";
  // The block permissions key whose lines are being read: one pass, closed when a line comes back to its column.
  let open: { col: number; set: Set<string> } | undefined;
  for (let i = 0; i < ls.length; i++) {
    const l = ls[i]!;
    const ind = indentOf(l);
    if (open && ind <= open.col) open = undefined;
    if (dataCol >= 0 && ind > dataCol) continue;
    dataCol = -1;
    const k = KEY.exec(l);
    if (open && k && k[3] !== undefined && unq(k[3]) === "write") open.set.add(`${k[2]} write`);
    if (ind === 0) {
      inJobs = !!k && k[2] === "jobs" && !k[3];
      jobCol = -1;
      job = "";
    } else if (inJobs) {
      if (jobCol < 0) jobCol = ind;
      if (ind === jobCol && k && !k[1]) { job = k[2]!; r.jobs.set(job, undefined); continue; }
    }
    if (!k) continue;
    const col = keyCol(l);
    if (DATA_KEYS.has(k[2]!) && !k[3]) { dataCol = col; continue; }
    // A permissions key inside an open block is one of its lines: the outer block stays open and keeps its grants.
    if (k[2] !== "permissions" || open) continue;
    const set = new Set<string>();
    if (ind === 0) r.workflow = set;
    else if (job) r.jobs.set(job, set);
    const rest = (k[3] ?? "").trim();
    if (unq(rest) === "write-all") set.add("write-all");
    else if (rest.startsWith("{")) for (const g of rest.matchAll(FLOW_WRITE)) set.add(`${g[1]} write`);
    else if (!rest) open = { col, set };
  }
  return r;
}

/** Every write grant a workflow or action file holds, at the workflow level or in any job: "write-all" and "<scope> write". */
export function workflowWriteGrants(src: string): Set<string> {
  const { workflow, jobs } = readWorkflow(src).perms;
  return new Set([...(workflow ?? []), ...[...jobs.values()].flatMap((s) => [...(s ?? [])])]);
}

/**
 * The grants the new file adds, per effective scope. The workflow block against the old workflow block (an old
 * workflow-level write-all covers it). A job the old file also had, against its own old block, or the old workflow block
 * when it had none. A new or renamed job, against the old grants pooled over the workflow block and every job (a job-level
 * write-all left out: it covers only its own job), so a renamed job or a grant moved between levels is no change.
 * Known limit: a job renamed while it widens to a grant some other old job had is not flagged.
 */
function widenedGrants(o: Permissions, n: Permissions): string[] {
  const ow = o.workflow ?? new Set<string>();
  const out = new Set<string>();
  const add = (s: Iterable<string>, base: Set<string>) => {
    if (!base.has("write-all")) for (const g of s) if (!base.has(g)) out.add(g);
  };
  add(n.workflow ?? [], ow);
  const pool = new Set([...ow, ...[...o.jobs.values()].flatMap((s) => [...(s ?? [])].filter((g) => g !== "write-all"))]);
  for (const [j, s] of n.jobs) {
    if (!s) continue;
    if (o.jobs.has(j)) add(s, o.jobs.get(j) ?? ow);
    else add(s, pool);
  }
  return [...out];
}

/**
 * Where the repository or organization default (which can be read-write) now applies and did not before: a permissions
 * block the old file had and the new one drops (the workflow level when a job is left with no block of its own, unless
 * the old workflow block was write-all, which no default exceeds; a job still present when the workflow level has none),
 * then a new or renamed job with no block of its own when every old job had one (nothing was removed there).
 */
export function permissionsRemoved(oldSrc: string, newSrc: string): string[] {
  const { removed, unset } = defaultApplies(readWorkflow(oldSrc).perms, readWorkflow(newSrc).perms);
  return [...removed, ...unset];
}
function defaultApplies(o: Permissions, n: Permissions): { removed: string[]; unset: string[] } {
  const removed: string[] = [];
  const unset: string[] = [];
  if (n.workflow) return { removed, unset };
  if (o.workflow && !o.workflow.has("write-all") && [...n.jobs.values()].some((s) => !s)) removed.push("workflow");
  for (const [j, s] of o.jobs) if (s && n.jobs.has(j) && !n.jobs.get(j)) removed.push(`job ${j}`);
  // A new or renamed job with no block of its own, where every old job had one (and no workflow block): the default
  // applies to a job where none did before.
  if (!o.workflow && o.jobs.size && [...o.jobs.values()].every((s) => s)) for (const [j, s] of n.jobs) if (!s && !o.jobs.has(j)) unset.push(`job ${j}`);
  return { removed, unset };
}

/** The risky triggers (pull_request_target, workflow_run, issue_comment, pull_request_review_comment, issues, discussion, discussion_comment) the file names under its top-level `on:` key. */
export const workflowTriggers = (src: string | undefined): Set<string> => readWorkflow(src ?? "").triggers;

/** The line reader's triggers, in the scalar, flow list, flow map, block list or block map form of `on:`. */
function linesTriggers(src: string): Set<string> {
  const out = new Set<string>();
  const add = (name: string) => RISKY.has(name) && out.add(name);
  const ls = yamlLogical(src);
  for (let i = 0; i < ls.length; i++) {
    const k = KEY.exec(ls[i]!);
    if (!k || k[1] || indentOf(ls[i]!) !== 0 || k[2] !== "on") continue;
    const rest = (k[3] ?? "").trim();
    if (rest.startsWith("[") || rest.startsWith("{")) {
      // Flow form: only the names at the first level, not a value nested inside one ({ workflow_run: { workflows: [x] } }).
      let depth = 0;
      let tok = "";
      for (const c of rest) {
        if (c === "[" || c === "{") { if (depth === 1) add(unq(tok)); depth++; tok = ""; }
        else if (c === "]" || c === "}") { if (depth === 1) add(unq(tok)); depth--; tok = ""; }
        else if (depth === 1 && (c === "," || c === ":")) { add(unq(tok)); tok = ""; }
        else if (depth === 1) tok += c;
      }
    } else if (rest) add(unq(rest));
    else {
      let childCol = -1;
      for (let j = i + 1; j < ls.length; j++) {
        const n = ls[j]!;
        const ind = indentOf(n);
        if (ind === 0) break;
        if (childCol < 0) childCol = ind;
        if (ind !== childCol) continue;
        const item = /^\s*-\s+([\s\S]*)$/.exec(n);
        if (item) add(unq(item[1]!));
        else {
          const c = KEY.exec(n);
          if (c) add(c[2]!);
        }
      }
    }
  }
  return out;
}

function workflowSignals(oldFiles: FileMap, newFiles: FileMap, p: string): Signal[] {
  const now = text(newFiles, p);
  if (now === undefined) return [];
  const prev = text(oldFiles, p);
  const n = readWorkflow(now);
  const o = readWorkflow(prev ?? "");
  const out: Signal[] = [];
  const widened = widenedGrants(o.perms, n.perms);
  const { removed, unset } = prev === undefined ? { removed: [], unset: [] } : defaultApplies(o.perms, n.perms);
  const parts = [
    ...(widened.length ? [`write access added: ${widened.slice(0, 6).join("; ")}`] : []),
    // Short labels, so all three parts and their names fit under the 160-character cut.
    ...(removed.length ? [`permissions removed, default applies: ${removed.slice(0, 6).join(", ")}`] : []),
    ...(unset.length ? [`no permissions block, default applies: ${unset.slice(0, 6).join(", ")}`] : []),
  ];
  if (parts.length) out.push({ kind: "workflow-permissions-widened", path: p, detail: parts.join("; ").slice(0, 160) });
  const added = [...n.triggers].filter((t) => !o.triggers.has(t));
  if (added.length) out.push({ kind: "workflow-trigger-added", path: p, detail: `new trigger: ${added.join(", ")}` });
  return out;
}

/** Soft signals for a new or changed build.rs (or Cargo.toml custom build script), Go generate / cgo, and workflow permission or trigger changes. Never hard. */
export function ecosystemSignals(oldFiles: FileMap, newFiles: FileMap): Signal[] {
  const out: Signal[] = [];
  const cargoState: CargoState = { seen: new Map(), same: new Map(), byText: new Map(), byPath: new Map() };
  for (const p of newFiles.keys()) {
    if (isRustBuildScript(p)) out.push(...rustSignals(oldFiles, newFiles, p).flatMap((s) => oncePerPath(cargoState, s)));
    else if (base(p) === "Cargo.toml") out.push(...cargoSignals(oldFiles, newFiles, p, cargoState));
    else if (isGoSource(p)) out.push(...goSignals(oldFiles, newFiles, p));
    else if (isWorkflowFile(p)) out.push(...workflowSignals(oldFiles, newFiles, p));
  }
  return out;
}
