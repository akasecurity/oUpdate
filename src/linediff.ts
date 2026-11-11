// Ordered diff for the reviewer prompt. Replaces a set-based diff that dropped any line
// present anywhere in both versions, which made changed files look truncated to the
// model (node-ipc 12.0.0's `}` in the 10-27 extended eval).

export type Op = { op: "=" | "-" | "+"; v: string };

// Myers O(ND) diff after trimming the common prefix and suffix. Undefined when the edit
// distance passes maxD or the diagonal walk passes maxWork.
export function diffSeq(a: string[], b: string[], maxD = 4000, maxWork = 50_000_000): Op[] | undefined {
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const A = a.slice(pre, a.length - suf);
  const B = b.slice(pre, b.length - suf);
  const n = A.length;
  const m = B.length;
  const head: Op[] = a.slice(0, pre).map((v) => ({ op: "=", v }));
  const tail: Op[] = a.slice(a.length - suf).map((v) => ({ op: "=", v }));
  if (!n || !m) return [...head, ...A.map((v): Op => ({ op: "-", v })), ...B.map((v): Op => ({ op: "+", v })), ...tail];

  const max = Math.min(n + m, maxD);
  const off = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  let work = 0;
  let found = -1;
  for (let d = 0; d <= max && found < 0; d++) {
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1]! < v[off + k + 1]!) ? v[off + k + 1]! : v[off + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && A[x] === B[y]) { x++; y++; work++; }
      v[off + k] = x;
      if (x >= n && y >= m) { found = d; break; }
    }
    trace.push(v.slice(off - d, off + d + 1));
    work += d + 1;
    if (work > maxWork) return undefined;
  }
  if (found < 0) return undefined;

  const mid: Op[] = [];
  let x = n;
  let y = m;
  for (let d = found; d > 0; d--) {
    const prev = trace[d - 1]!;
    const at = (k: number) => prev[k + d - 1]!;
    const k = x - y;
    const pk = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const px = at(pk);
    const py = px - pk;
    while (x > px && y > py) { mid.push({ op: "=", v: A[--x]! }); y--; }
    if (pk === k + 1) mid.push({ op: "+", v: B[--y]! });
    else mid.push({ op: "-", v: A[--x]! });
  }
  while (x > 0 && y > 0) { mid.push({ op: "=", v: A[--x]! }); y--; }
  return [...head, ...mid.reverse(), ...tail];
}

// Lines this long are treated as minified: a changed pair is shown as its changed tokens.
const LONG = 500;
const CONTEXT = 60;

// A minifier's rename: one short identifier for another. Keywords are left out, so `aF`->`in` stays a shown change.
const SHORT_ID = /^[A-Za-z_$][\w$]{0,2}$/;
const KEYWORD = new Set(["do", "if", "in", "of", "for", "let", "new", "try", "var"]);
const renameable = (s: string) => SHORT_ID.test(s) && !KEYWORD.has(s);
const RENAMES_SHOWN = 40;
const renameList = (pairs: string[]) => pairs.slice(0, RENAMES_SHOWN).join(", ") + (pairs.length > RENAMES_SHOWN ? ` and ${pairs.length - RENAMES_SHOWN} more` : "");
// Characters the reviewer cannot see: written as \uXXXX wherever a line is shown.
const INVISIBLE = /[\r\u2028\u2029\u0085\v\f]/;
const INVISIBLE_G = /[\r\u2028\u2029\u0085\v\f]/g;
const visible = (s: string) => s.replace(INVISIBLE_G, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
const SHOWN_WHOLE = 2000;

// The short identifiers of a whole file (lazily): a rename is only believed when the new name is absent from the
// whole old file and the old name from the whole new file, as a minifier renames every use.
const SHORT_ID_ALL = /(?<![\w$])[A-Za-z_$][\w$]{0,2}(?![\w$])/g;
const shortIds = (text: string) => new Set<string>([...text.matchAll(SHORT_ID_ALL)].map((m) => m[0]));
export type FileIds = { old: () => Set<string>; neu: () => Set<string> };

// 1 for each char inside a quoted string of the line (a quote not closed counts to the end).
function stringMask(line: string): Uint8Array {
  const m = new Uint8Array(line.length);
  let q = "";
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (q) {
      m[i] = 1;
      if (c === "\\") {
        if (i + 1 < line.length) m[++i] = 1;
      } else if (c === q) q = "";
    } else if (c === '"' || c === "'" || c === "`") {
      q = c;
      m[i] = 1;
    }
  }
  return m;
}
const prevChar = (line: string, pos: number) => {
  let j = pos - 1;
  while (j >= 0 && /\s/.test(line[j]!)) j--;
  return j >= 0 ? line[j]! : "";
};

function tokenDiff(oldLine: string, newLine: string, ids?: FileIds): string | undefined {
  const tok = (s: string) => s.match(/\w+|\s+|[^\w\s]/g) ?? [];
  const ops = diffSeq(tok(oldLine), tok(newLine), 3000);
  if (!ops) return undefined;
  // Bundlers rename locals between builds, so a line can differ only by `aF`->`dF`. A short-identifier swap that
  // maps one to one within the line is written as its new name and listed at the end, so the real changes stand out.
  const chunks: { del: string; add: string; ok: boolean }[] = [];
  const oldMask = stringMask(oldLine);
  const newMask = stringMask(newLine);
  let oPos = 0;
  let nPos = 0;
  for (let i = 0; i < ops.length; ) {
    if (ops[i]!.op === "=") { oPos += ops[i]!.v.length; nPos += ops[i]!.v.length; i++; continue; }
    let del = "";
    let add = "";
    const o0 = oPos;
    const n0 = nPos;
    while (i < ops.length && ops[i]!.op !== "=") {
      if (ops[i]!.op === "-") { del += ops[i]!.v; oPos += ops[i]!.v.length; }
      else { add += ops[i]!.v; nPos += ops[i]!.v.length; }
      i++;
    }
    // A name in a string or after a dot (a host, a method, a property) is data, not a local the minifier renamed.
    const ok = renameable(del) && renameable(add) && !oldMask[o0] && !newMask[n0] && prevChar(oldLine, o0) !== "." && prevChar(newLine, n0) !== ".";
    chunks.push({ del, add, ok });
  }
  const to = new Map<string, Set<string>>();
  const from = new Map<string, Set<string>>();
  for (const { del, add, ok } of chunks) {
    if (!ok) continue;
    (to.get(del) ?? to.set(del, new Set()).get(del)!).add(add);
    (from.get(add) ?? from.set(add, new Set()).get(add)!).add(del);
  }
  // A minifier renames every use, so the new name is absent from the old line and the old name from the new one: aF->bQ
  // beside an unchanged bQ merges two names (a call now goes elsewhere) and is shown as a change. The same holds for the
  // whole file: a name that the rest of the file already uses (`var n=..,t=..` then `f(n)` -> `f(t)`) is a swap.
  const oldToks = new Set(tok(oldLine));
  const newToks = new Set(tok(newLine));
  const isRenameChunk = (c: { del: string; add: string; ok: boolean }) =>
    c.ok && to.get(c.del)?.size === 1 && from.get(c.add)?.size === 1 && !oldToks.has(c.add) && !newToks.has(c.del) && !!ids && !ids.old().has(c.add) && !ids.neu().has(c.del);
  const pairs: string[] = [];
  for (const c of chunks) if (isRenameChunk(c) && !pairs.includes(`${c.del}→${c.add}`)) pairs.push(`${c.del}→${c.add}`);
  // The line is shown whole with its new names (a rename list alone could hide a changed name).
  if (pairs.length && chunks.every(isRenameChunk)) {
    const shown = newLine.length <= SHOWN_WHOLE ? newLine : `${newLine.slice(0, SHOWN_WHOLE)}… [${newLine.length} chars]`;
    return `${visible(shown)} [only identifiers renamed: ${renameList(pairs)}]`;
  }
  // Walk the ops, keeping CONTEXT chars of unchanged text around each change.
  let out = "";
  let eq = "";
  let started = false;
  const flushEq = (last: boolean) => {
    if (!started) out += eq.length > CONTEXT ? "…" + eq.slice(-CONTEXT) : eq;
    else if (last) out += eq.length > CONTEXT ? eq.slice(0, CONTEXT) + "…" : eq;
    else out += eq.length > 2 * CONTEXT ? eq.slice(0, CONTEXT) + " … " + eq.slice(-CONTEXT) : eq;
    eq = "";
  };
  let ci = 0;
  for (let i = 0; i < ops.length; ) {
    const o = ops[i]!;
    if (o.op === "=") { eq += o.v; i++; continue; }
    const chunk = chunks[ci++]!;
    let del = "";
    let add = "";
    let rawDel = "";
    let rawAdd = "";
    while (i < ops.length && ops[i]!.op !== "=") {
      // A whitespace token as JSON, so a space or a tab inside a minified line is visible.
      const bit = /^\s+$/.test(ops[i]!.v) ? JSON.stringify(ops[i]!.v) : ops[i]!.v;
      if (ops[i]!.op === "-") { del += bit; rawDel += ops[i]!.v; }
      else { add += bit; rawAdd += ops[i]!.v; }
      i++;
    }
    if (isRenameChunk(chunk)) { eq += rawAdd; continue; }
    flushEq(false);
    started = true;
    if (del) out += `[-${del}-]`;
    if (add) out += `{+${add}+}`;
  }
  flushEq(true);
  return pairs.length ? `${out} [renamed: ${renameList(pairs)}]` : out;
}

// Renders the change between two file texts for the reviewer: hunks in file order with
// `@@ -oldLine +newLine @@` positions, `-`/`+` lines, and `~` lines for changed minified
// lines ([-removed-]{+added+} with context). Lines are compared exactly: a whitespace change can be code (a shell
// heredoc delimiter "EOF " vs "EOF"), so it is shown, and a hunk with a CR or trailing whitespace in any of its
// lines shows every line as a JSON string so the change is visible. Only a whole-file CRLF<->LF conversion is named instead of listed.
const QUOTE_NOTE = " [lines below are exact text as JSON strings, to show a CR, a line-break character or trailing whitespace]";
const needsQuote = (l: string) => INVISIBLE.test(l) || /[ \t]$/.test(l);
const quoteLine = (l: string) => visible(JSON.stringify(l));

// The `=` mark is for code files in a language this reads: JavaScript and TypeScript, and Python. Anything else is never marked.
export type MarkLang = "js" | "py";
export const markLanguage = (path: string): MarkLang | undefined =>
  /\.(?:[cm]?[jt]sx?)$/.test(path) && !/\.d\.[cm]?ts$/.test(path) ? "js" : /\.pyw?$/.test(path) ? "py" : undefined;

// Shorter lines (`}`, `return x;`) recur everywhere, so finding one in the old release says nothing.
const PRESENT_MIN = 24;

// One key per line, or undefined when the line is not plainly code: inside or touching a block comment, a template or a
// triple-quoted string, holding a comment, a space character other than space and tab (a CR, U+2028, U+2029, NEL, a
// no-break space), or shorter than PRESENT_MIN. Spaces and tabs around the line are dropped. Inside the line they are
// collapsed only when it holds no quote (a space in a string is data); Python keeps its indentation.
export function codeKeys(lines: string[], lang: MarkLang): (string | undefined)[] {
  const out: (string | undefined)[] = [];
  let block = false;
  let tpl = false;
  let triple = "";
  for (const l of lines) {
    let clean = !/[^\S \t]/.test(l);
    if (block || tpl || triple) clean = false;
    let hasQuote = false;
    for (let i = 0; i < l.length; i++) {
      const c = l[i]!;
      if (lang === "py") {
        if (triple) {
          clean = false;
          if (l.startsWith(triple, i)) { triple = ""; i += 2; }
        } else if (c === "#") { clean = false; break; }
        else if (c === '"' || c === "'") {
          hasQuote = true;
          if (l.startsWith(c.repeat(3), i)) { triple = c.repeat(3); clean = false; i += 2; }
          else { i++; while (i < l.length && l[i] !== c) { if (l[i] === "\\") i++; i++; } }
        }
        continue;
      }
      if (block) {
        clean = false;
        if (c === "*" && l[i + 1] === "/") { block = false; i++; }
      } else if (tpl) {
        clean = false;
        if (c === "\\") i++;
        else if (c === "`") tpl = false;
      } else if (c === "/" && l[i + 1] === "*") { block = true; clean = false; i++; }
      else if (c === "/" && l[i + 1] === "/") { clean = false; break; }
      else if (c === "`") { tpl = true; hasQuote = true; clean = false; }
      else if (c === '"' || c === "'") {
        hasQuote = true;
        i++;
        while (i < l.length && l[i] !== c) { if (l[i] === "\\") i++; i++; }
      }
    }
    if (!clean) { out.push(undefined); continue; }
    const k = lang === "py" ? l.replace(/[ \t]+$/, "") : hasQuote ? l.trim() : l.trim().replace(/[ \t]+/g, " ");
    out.push(k.replace(/[ \t]/g, "").length >= PRESENT_MIN ? k : undefined);
  }
  return out;
}

export type DiffOpts = {
  // Show an added line as `=` when the OLD TEXT OF THE SAME FILE has that line as code, once for each time it had it.
  // Set only for a changed code file that ran before; never for an added file, a file this release starts to run,
  // or a manifest.
  mark?: MarkLang;
};

export function renderLineDiff(before: string | undefined, after: string | undefined, opts: DiffOpts = {}): string {
  if (before !== undefined && after !== undefined && before !== after && (after === before.replaceAll("\n", "\r\n") || before === after.replaceAll("\n", "\r\n"))) {
    return "[line endings only: every line converted between CRLF and LF]\n";
  }
  const split = (s: string | undefined) => (s === undefined ? [] : s.split("\n"));
  const oldLines = split(before);
  const newLines = split(after);
  const ops = diffSeq(oldLines, newLines);
  // How many times each key may still be marked: the old file's count, less the lines that are unchanged in place.
  let budget: Map<string, number> | undefined;
  let newKeys: (string | undefined)[] | undefined;
  const setup = () => {
    budget = new Map();
    const oldKeys = codeKeys(oldLines, opts.mark!);
    for (const k of oldKeys) if (k !== undefined) budget.set(k, (budget.get(k) ?? 0) + 1);
    let oi2 = 0;
    for (const o of ops ?? []) {
      if (o.op === "=") {
        const k = oldKeys[oi2];
        if (k !== undefined) budget.set(k, (budget.get(k) ?? 1) - 1);
      }
      if (o.op !== "+") oi2++;
    }
    newKeys = codeKeys(newLines, opts.mark!);
  };
  // A line starting `==` stays `+`, so a marked line never reads as a `=== path ===` file header.
  const mark = (l: string, idx: number) => {
    if (!opts.mark || before === undefined || l.startsWith("==")) return "+";
    if (!budget) setup();
    const k = newKeys![idx];
    if (k === undefined) return "+";
    const left = budget!.get(k) ?? 0;
    if (left <= 0) return "+";
    budget!.set(k, left - 1);
    return "=";
  };
  // Short identifiers of the two whole files, for the rename check.
  let oldIds: Set<string> | undefined;
  let newIds: Set<string> | undefined;
  const ids: FileIds = { old: () => (oldIds ??= shortIds(before ?? "")), neu: () => (newIds ??= shortIds(after ?? "")) };
  if (!ops) {
    // Too many edits to order: show the whole new version, every line `+`: marking lines both versions hold would hide a
    // reorder (an activation line moved above its payload); the review's size holds bound the length.
    const q = newLines.some(needsQuote);
    const show = (l: string) => (q ? quoteLine(l) : l);
    return [`[too many changes to show in order: the whole new version follows]${q ? QUOTE_NOTE : ""}\n`, ...newLines.map((l) => `+${show(l)}\n`)].join("");
  }

  let out = "";
  let oi = 0;
  let ni = 0;
  for (let i = 0; i < ops.length; ) {
    if (ops[i]!.op === "=") { oi++; ni++; i++; continue; }
    const del: string[] = [];
    const add: string[] = [];
    const o0 = oi;
    const n0 = ni;
    while (i < ops.length && ops[i]!.op !== "=") {
      if (ops[i]!.op === "-") del.push(oldLines[oi++]!);
      else add.push(newLines[ni++]!);
      i++;
    }
    const q = [...del, ...add].some(needsQuote);
    const show = (l: string) => (q ? quoteLine(l) : l);
    out += `@@ -${o0 + 1} +${n0 + 1} @@${q ? QUOTE_NOTE : ""}\n`;
    if (del.length === add.length && del.every((l, j) => l.length > LONG && add[j]!.length > LONG)) {
      for (let j = 0; j < del.length; j++) {
        const t = tokenDiff(del[j]!, add[j]!, ids);
        out += t === undefined ? `-${show(del[j]!)}\n+${show(add[j]!)}\n` : `~${t}\n`;
      }
    } else {
      out += del.map((l) => `-${show(l)}\n`).join("") + add.map((l, j) => `${mark(l, n0 + j)}${show(l)}\n`).join("");
    }
  }
  return out;
}
