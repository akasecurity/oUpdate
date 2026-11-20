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

function tokenDiff(oldLine: string, newLine: string): string | undefined {
  const tok = (s: string) => s.match(/\w+|\s+|[^\w\s]/g) ?? [];
  const ops = diffSeq(tok(oldLine), tok(newLine), 3000);
  if (!ops) return undefined;
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
  for (let i = 0; i < ops.length; ) {
    const o = ops[i]!;
    if (o.op === "=") { eq += o.v; i++; continue; }
    flushEq(false);
    started = true;
    let del = "";
    let add = "";
    while (i < ops.length && ops[i]!.op !== "=") {
      // A whitespace token as JSON, so a space or a tab inside a minified line is visible.
      const bit = /^\s+$/.test(ops[i]!.v) ? JSON.stringify(ops[i]!.v) : ops[i]!.v;
      if (ops[i]!.op === "-") del += bit;
      else add += bit;
      i++;
    }
    if (del) out += `[-${del}-]`;
    if (add) out += `{+${add}+}`;
  }
  flushEq(true);
  return out;
}

// Renders the change between two file texts for the reviewer: hunks in file order with
// `@@ -oldLine +newLine @@` positions, `-`/`+` lines, and `~` lines for changed minified
// lines ([-removed-]{+added+} with context). Lines are compared exactly: a whitespace change can be code (a shell
// heredoc delimiter "EOF " vs "EOF"), so it is shown, and a hunk with a CR or trailing whitespace in any of its
// lines shows every line as a JSON string so the change is visible. Only a whole-file CRLF<->LF conversion is named instead of listed.
const QUOTE_NOTE = " [lines below are exact text as JSON strings, to show a CR or trailing whitespace]";
const needsQuote = (l: string) => l.includes("\r") || /[ \t]$/.test(l);

/** True when the two texts differ only by every line ending being converted between LF and CRLF. Counts newlines first, so it builds a copy only when the lengths fit. */
export function lineEndingsOnly(before: string, after: string): boolean {
  if (before === after) return false;
  const [lf, other] = before.length <= after.length ? [before, after] : [after, before];
  let n = 0;
  for (let i = lf.indexOf("\n"); i >= 0; i = lf.indexOf("\n", i + 1)) n++;
  return n > 0 && other.length === lf.length + n && other === lf.replaceAll("\n", "\r\n");
}

export function renderLineDiff(before: string | undefined, after: string | undefined, getOps?: (a: string[], b: string[]) => Op[] | undefined): string {
  if (before !== undefined && after !== undefined && lineEndingsOnly(before, after)) {
    return "[line endings only: every line converted between CRLF and LF]\n";
  }
  const split = (s: string | undefined) => (s === undefined ? [] : s.split("\n"));
  const oldLines = split(before);
  const newLines = split(after);
  const ops = getOps ? getOps(oldLines, newLines) : diffSeq(oldLines, newLines); // a caller that also needs the ops passes one memoized call
  if (!ops) {
    // Too many edits to order: show the whole new version. Dropping lines both versions hold would hide a
    // reorder (an activation line moved above its payload); the review's size holds bound the length.
    const q = newLines.some(needsQuote);
    const show = (l: string) => (q ? JSON.stringify(l) : l);
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
    const show = (l: string) => (q ? JSON.stringify(l) : l);
    out += `@@ -${o0 + 1} +${n0 + 1} @@${q ? QUOTE_NOTE : ""}\n`;
    if (del.length === add.length && del.every((l, j) => l.length > LONG && add[j]!.length > LONG)) {
      for (let j = 0; j < del.length; j++) {
        const t = tokenDiff(del[j]!, add[j]!);
        out += t === undefined ? `-${show(del[j]!)}\n+${show(add[j]!)}\n` : `~${t}\n`;
      }
    } else {
      out += del.map((l) => `-${show(l)}\n`).join("") + add.map((l) => `+${show(l)}\n`).join("");
    }
  }
  return out;
}

// The lexical context each line starts in: code, or inside a block comment, a template literal (with its `${` holes and the
// braces inside them), a string continued over a line end, or a Python triple-quoted string. One light pass; a regex literal
// is guessed from the previous token (a keyword that is not a property, an operator that is not `++`/`--`, or the `)` of an
// if/while/for/with head), and a comment is transparent to that guess. A misread cannot hide a line that both versions read the
// same way wrongly, and a line is shown as changed when its start context differs between the two versions. The context of a
// line is the stack depth plus two running hashes of the stack's kinds under a per-run random seed (so a text cannot be built
// to collide), kept as one short string per line: nothing is interned and nothing grows beyond the stack itself.
const REGEX_AFTER = /[(,=:[!&|?{};+\-*%<>~^}/]/; // a slash that was a division is an operator too
const REGEX_WORDS = new Set(["return", "typeof", "case", "in", "of", "void", "delete", "throw", "new", "else", "do", "yield", "await", "instanceof"]);
const PAREN_WORDS = new Set(["if", "while", "for", "with"]);
const TERMINATOR_JS = /[\u2028\u2029\r]/;
const TERMINATOR_PY = /\r/; // CPython ends a line at CR or LF only
const IDENT_CHAR = /[\p{ID_Continue}$\u200c\u200d\ud800-\udfff]/u; // a surrogate half counts: an astral letter is a name part
const isId = (c: string) => IDENT_CHAR.test(c);
const oddBackslashes = (l: string) => { let n = 0; for (let k = l.length - 1; k >= 0 && l[k] === "\\"; k--) n++; return n % 2 === 1; };

export type LexMode = "js" | "py";

/** The runtime a `#!` first line names: every word is read (its basename, with an optional version suffix), so `env` options and their arguments, `-S`, and wrappers (npx, bunx, uv run) cannot hide it. A false hit only adds noise; a miss hides a shift. */
function shebangMode(text: string): LexMode | undefined {
  const first = text.replace(/^\uFEFF/, "").split(/[\r\n\u2028\u2029]/, 1)[0]!;
  if (!first.startsWith("#!")) return undefined;
  const names = first.slice(2).trim().split(/\s+/).map((w) => w.slice(w.lastIndexOf("/") + 1));
  if (names.some((w) => /^(?:node(?:js)?|bun|deno|tsx|ts-node(?:-esm)?|zx|vite-node|esno)[\d.]*$/i.test(w))) return "js";
  if (names.some((w) => /^(?:python|pypy|uv|pipx)[\d.]*$/i.test(w))) return "py";
  return undefined;
}

/** The lexer a file gets: .js .mjs .cjs .jsx .ts .mts .cts .tsx (node loads any unknown extension as .js, so a JSX or TSX file is read as code too), .py and .pyw, and any other file whose first line is a node-like or python `#!` line (pass the text for that). Anything else keeps the plain diff. */
export function lexMode(path: string, text?: string): LexMode | undefined {
  if (/\.(?:[cm]?[jt]sx?)$/i.test(path)) return "js";
  if (/\.pyw?$/i.test(path)) return "py";
  return text === undefined ? undefined : shebangMode(text);
}

/** What a stack top means to a reader: a template hole and a brace in one are code. */
function contextLabel(top: string): string {
  if (top === "" || top === "${" || top === "{") return "code";
  if (top === "/*") return "comment";
  if (top === "`") return "template";
  if (top === '"' || top === "'") return "string";
  return "python-docstring";
}

export type LexSeed = [number, number];
export const newSeed = (): LexSeed => {
  const r = crypto.getRandomValues(new Uint32Array(2));
  return [r[0]!, r[1]!];
};

export function lineStates(lines: string[], mode: LexMode, seed: LexSeed): { states: string[]; kinds: string[] } {
  const py = mode === "py";
  const TERMINATOR = py ? TERMINATOR_PY : TERMINATOR_JS;
  const out: string[] = [];
  const kindsOut: string[] = [];
  const stk: string[] = []; // "/*", "`", "${" (a hole), "{" (a brace in a hole), a triple quote, or a quote kept over a line end
  const h1: number[] = [seed[0]];
  const h2: number[] = [seed[1]];
  const push = (kind: string) => {
    let c = 0;
    for (let k = 0; k < kind.length; k++) c = (c * 31 + kind.charCodeAt(k)) | 0;
    stk.push(kind);
    h1.push(Math.imul(h1[h1.length - 1]! ^ c, 0x9e3779b1) + 0x7f4a7c15 | 0);
    h2.push(Math.imul(h2[h2.length - 1]! + c + 1, 0x85ebca6b) ^ (h2.length << 7) | 0);
  };
  const pop = () => { stk.pop(); h1.pop(); h2.pop(); };
  const top = () => (stk.length === 0 ? "" : stk[stk.length - 1]!);
  let prev = ""; // the last significant character of code
  let prev2 = ""; // the one before it
  let word = ""; // the identifier that ends at prev
  let prevWord = ""; // the identifier before it, when only whitespace separates them (`for await`)
  let prevWordDot = false; // ... and that one is a property
  let wordDot = false; // that identifier is a property (`.return`)
  let gap = false; // whitespace or a comment since the last token: the next word starts a new one
  const parens: boolean[] = []; // per open paren: did an if/while/for/with head open it
  let parenRegex = false; // the last token was the `)` that closes such a head: a slash after it starts a regex
  let cmt: [string, string, string, boolean, boolean] | undefined; // the token state a block comment was opened in
  const reset = () => { prev2 = prev; prev = ")"; word = ""; wordDot = false; parenRegex = false; gap = false; };
  let last = "";
  // A construct whose reading depends on the runtime (an HTML-style comment in a script, a Python 3.12 f-string hole that holds the
  // string's own quote) is lexed one way and taints every later line: a line after it never has the same state as in a text without it.
  let tainted = false;
  let fStr = false; // the Python string open now has an f prefix
  let fDepth = 0; // its braces so far: `{` +1, `}` -1, every one counted
  const fOpen = (l: string, at: number) => {
    let j = at;
    while (j > 0 && j > at - 2 && /[A-Za-z]/.test(l[j - 1]!)) j--;
    fStr = /f/i.test(l.slice(j, at)) && (j === 0 || !isId(l[j - 1]!));
    fDepth = 0;
  };
  const fClose = () => { if (fStr && fDepth !== 0) tainted = true; fStr = false; };
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li]!.endsWith("\r") ? lines[li]!.slice(0, -1) : lines[li]!;
    const now = stk.length === 0 && !tainted ? "" : `${stk.length}:${h1[h1.length - 1]}:${h2[h2.length - 1]}${tainted ? ":x" : ""}`;
    out.push(now === last ? last : (last = now));
    kindsOut.push(contextLabel(top()));
    let ran = false; // some part of this line runs as code in this version
    gap = true;
    let i = 0;
    if (li === 0 && !py) {
      const bom = line.startsWith("\uFEFF") ? 1 : 0; // a byte order mark before the hashbang is dropped, as the runtime does
      if (line.startsWith("#!", bom)) {
        // a hashbang line is a comment, to any line terminator
        const m = TERMINATOR.exec(line);
        if (!m) continue;
        i = m.index + 1;
        gap = true;
      }
    }
    while (i < line.length) {
      const t = top();
      const c = line[i]!;
      if (t === "/*") {
        if (c === "*" && line[i + 1] === "/") {
          pop();
          i += 2;
          // a comment is transparent: the token before it is still the previous token
          if (cmt) [prev, prev2, word, wordDot, parenRegex] = cmt;
          gap = true;
        } else i++;
      } else if (t === "`") {
        if (c === "\\") i += 2;
        else if (c === "`") { pop(); i++; reset(); }
        else if (c === "$" && line[i + 1] === "{") { ran = true; push("${"); i += 2; prev2 = prev; prev = "{"; word = ""; wordDot = false; parenRegex = false; }
        else i++;
      } else if (t === '"""' || t === "'''") {
        if (c === "\\") i += fStr && (line[i + 1] === "{" || line[i + 1] === "}") ? 1 : 2;
        else if (line.startsWith(t, i)) { pop(); fClose(); i += 3; reset(); }
        else { if (fStr) fDepth += c === "{" ? 1 : c === "}" ? -1 : 0; i++; }
      } else if (t === '"' || t === "'") {
        if (c === "\\") i += fStr && (line[i + 1] === "{" || line[i + 1] === "}") ? 1 : 2;
        else if (c === t) { pop(); fClose(); i++; reset(); }
        else { if (fStr) fDepth += c === "{" ? 1 : c === "}" ? -1 : 0; i++; }
      } else {
        // code: the top is empty, a hole or a brace inside one
        const inHole = t === "${" || t === "{";
        const fresh = !ran; // no code before this character on the line
        if (!ran && !/\s/.test(c) && !(c === "/" && (line[i + 1] === "*" || (line[i + 1] === "/" && !py))) && !(c === "#" && py)) ran = true;
        if (c === "/" && line[i + 1] === "*") { cmt = [prev, prev2, word, wordDot, parenRegex]; push("/*"); i += 2; }
        else if ((c === "/" && line[i + 1] === "/" && !py) || (c === "#" && py) || (!py && (line.startsWith("<!--", i) || (fresh && line.startsWith("-->", i))))) {
          // a line comment ends at a line terminator: LF, CR, U+2028, U+2029. `<!--` and a `-->` that starts a line are comments in a script (CommonJS) and operators in a module: read as a comment, and taint
          if (c === "<" || c === "-") tainted = true;
          const m = TERMINATOR.exec(line.slice(i));
          if (!m) break;
          i += m.index + 1;
          gap = true;
        } else if (TERMINATOR.test(c)) { i++; gap = true; }
        else if (c === "`") { push("`"); i++; }
        else if (py && (line.startsWith('"""', i) || line.startsWith("'''", i))) { fOpen(line, i); push(line.slice(i, i + 3)); i += 3; }
        else if (c === '"' || c === "'") { if (py) fOpen(line, i); push(c); i++; }
        else if (inHole && c === "{") { push("{"); i++; prev2 = prev; prev = "{"; word = ""; wordDot = false; parenRegex = false; }
        else if (inHole && c === "}") { pop(); i++; prev2 = prev; prev = "}"; word = ""; wordDot = false; parenRegex = false; }
        else if (c === "/" && !py && (prev === "" || (REGEX_AFTER.test(prev) && !((prev === "+" || prev === "-") && prev2 === prev)) || (prev === "." && prev2 === ".") || (prev === ")" && parenRegex) || (isId(prev) && !wordDot && (REGEX_WORDS.has(word))))) {
          // a regex literal: to the closing slash on this line, a class kept whole
          let j = i + 1;
          let cls = false;
          while (j < line.length && (cls || line[j] !== "/")) {
            if (line[j] === "\\") j++;
            else if (line[j] === "[") cls = true;
            else if (line[j] === "]") cls = false;
            j++;
          }
          i = j + 1;
          reset();
        } else {
          if (c === "(") parens.push(!wordDot && (PAREN_WORDS.has(word) || (word === "await" && prevWord === "for" && !prevWordDot)));
          const closed = c === ")" ? parens.pop() === true : false;
          if (/\s/.test(c)) gap = true;
          else {
            if (isId(c)) {
              if (!gap && isId(prev) && word) word += c;
              else { prevWord = gap && isId(prev) ? word : ""; prevWordDot = wordDot; word = c; wordDot = prev === "." || prev === "#"; }
            } else { word = ""; wordDot = false; }
            gap = false;
            prev2 = prev;
            prev = c;
            parenRegex = closed;
          }
          i++;
        }
      }
    }
    // a line that starts in a comment or a string and still runs code after a closing delimiter or in a hole is code
    if (ran) kindsOut[li] = "code";
    // a single-quoted string ends at the line end unless a backslash continues it
    while ((top() === '"' || top() === "'") && !oddBackslashes(line)) { pop(); fClose(); }
  }
  return { states: out, kinds: kindsOut };
}

// A line both versions hold is not shown by the diff, but its meaning changed when it went from a comment, a template or a
// string to code (or back): removing `/*` and `*/` turns the lines between them into code. The rendering of the diff is left
// exactly as it is; each such line is added after it as its own whole removed and added pair, never merged into a hunk of the
// diff and never token-rendered, so everything the plain rendering shows is still shown.
export function renderShifted(a: string[], b: string[], ops: Op[] | undefined, mode: LexMode | undefined): string {
  if (!ops || !mode || !ops.some((o) => o.op !== "=")) return "";
  const seed = newSeed();
  const { states: sa, kinds: ka } = lineStates(a, mode, seed);
  const { states: sb, kinds: kb } = lineStates(b, mode, seed);
  let oi = 0;
  let ni = 0;
  let out = "";
  for (const o of ops) {
    if (o.op === "-") oi++;
    else if (o.op === "+") ni++;
    else {
      if (sa[oi] !== sb[ni]) {
        const q = needsQuote(o.v) || /[\u2028\u2029]/.test(o.v);
        const show = q ? JSON.stringify(o.v).replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029") : o.v;
        out += `@@ -${oi + 1} +${ni + 1} @@ [context changed: ${ka[oi]}->${kb[ni]}]${q ? QUOTE_NOTE : ""}\n-${show}\n+${show}\n`;
      }
      oi++;
      ni++;
    }
  }
  return out;
}
