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
// is guessed from what comes before the slash (a keyword, an operator, or the `)` of an if/while/for/with head). A misread
// cannot hide a line: a line is shown as changed when its start context differs between the two versions, and both are read
// the same way. Contexts are interned (a stack of kinds as a chain of ids), so equal stacks have equal ids, depth is not capped
// and nothing grows with the number of lines but one id per line.
const REGEX_AFTER = /[(,=:[!&|?{};+\-*%<>~^}]/;
const REGEX_WORDS = new Set(["return", "typeof", "case", "in", "of", "void", "delete", "throw", "new", "else", "do", "yield", "await", "instanceof"]);
const PAREN_WORDS = new Set(["if", "while", "for", "with"]);

export type LexMode = "js" | "py";

/** The lexer a path gets: the JS family and Python only. Any other file keeps the plain diff. */
export function lexMode(path: string): LexMode | undefined {
  if (/\.(?:[cm]?[jt]s|[jt]sx)$/i.test(path)) return "js";
  if (/\.py$/i.test(path)) return "py";
  return undefined;
}

type Interner = Map<string, number>;

export function lineStates(lines: string[], mode: LexMode, interner: Interner): number[] {
  const py = mode === "py";
  const out: number[] = [];
  // the stack is a chain of interned nodes: id -> (parent id, kind) is the key, so equal stacks share an id
  const kinds: string[] = []; // node id -> kind (for the top)
  const parents: number[] = [];
  const nodeOf = (parent: number, kind: string): number => {
    const key = `${parent}|${kind}`;
    let id = interner.get(key);
    if (id === undefined) {
      id = interner.size + 1;
      interner.set(key, id);
    }
    kinds[id] = kind;
    parents[id] = parent;
    return id;
  };
  let cur = 0; // the current top node, 0 for plain code
  const push = (kind: string) => { cur = nodeOf(cur, kind); };
  const pop = () => { cur = parents[cur] ?? 0; };
  const top = () => (cur === 0 ? "" : kinds[cur]!);
  let prev = ""; // the last significant character of code
  let word = ""; // the identifier that ends at prev
  let gap = false; // whitespace since the last token: the next word starts a new one
  const parens: boolean[] = []; // per open paren: did an if/while/for/with head open it
  let parenRegex = false; // the last token was the `)` that closes such a head: a slash after it starts a regex
  const reset = () => { prev = ")"; word = ""; parenRegex = false; gap = false; };
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li]!.endsWith("\r") ? lines[li]!.slice(0, -1) : lines[li]!;
    out.push(cur);
    let i = 0;
    if (li === 0 && !py && line.startsWith("#!")) continue; // a hashbang line is a comment
    while (i < line.length) {
      const t = top();
      const c = line[i]!;
      if (t === "/*") {
        if (c === "*" && line[i + 1] === "/") { pop(); i += 2; reset(); } else i++;
      } else if (t === "`") {
        if (c === "\\") i += 2;
        else if (c === "`") { pop(); i++; reset(); }
        else if (c === "$" && line[i + 1] === "{") { push("${"); i += 2; prev = "{"; word = ""; parenRegex = false; }
        else i++;
      } else if (t === '"""' || t === "'''") {
        if (c === "\\") i += 2;
        else if (line.startsWith(t, i)) { pop(); i += 3; reset(); }
        else i++;
      } else if (t === '"' || t === "'") {
        if (c === "\\") i += 2;
        else if (c === t) { pop(); i++; reset(); }
        else i++;
      } else {
        // code: the top is empty, a hole or a brace inside one
        const inHole = t === "${" || t === "{";
        if (c === "/" && line[i + 1] === "*") { push("/*"); i += 2; }
        else if (c === "/" && line[i + 1] === "/" && !py) break;
        else if (c === "#" && py) break;
        else if (c === "`") { push("`"); i++; }
        else if (py && (line.startsWith('"""', i) || line.startsWith("'''", i))) { push(line.slice(i, i + 3)); i += 3; }
        else if (c === '"' || c === "'") { push(c); i++; }
        else if (inHole && c === "{") { push("{"); i++; prev = "{"; word = ""; parenRegex = false; }
        else if (inHole && c === "}") { pop(); i++; prev = "}"; word = ""; parenRegex = false; }
        else if (c === "/" && !py && (prev === "" || REGEX_AFTER.test(prev) || (prev === ")" && parenRegex) || (/[\w$]/.test(prev) && REGEX_WORDS.has(word)))) {
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
          if (c === "(") parens.push(PAREN_WORDS.has(word));
          const closed = c === ")" ? parens.pop() === true : false;
          if (/\s/.test(c)) gap = true;
          else {
            if (/[\w$]/.test(c)) word = !gap && /[\w$]/.test(prev) && word ? word + c : c;
            else word = "";
            gap = false;
            prev = c;
            parenRegex = closed;
          }
          i++;
        }
      }
    }
    // a single-quoted string ends at the line end unless a backslash continues it
    while ((top() === '"' || top() === "'") && !line.endsWith("\\")) pop();
  }
  return out;
}

// A line both versions hold is not shown by the diff, but its meaning changed when it went from a comment, a template or a
// string to code (or back): removing `/*` and `*/` turns the lines between them into code. The rendering of the diff is left
// exactly as it is; each such line is added after it as its own whole removed and added pair, never merged into a hunk of the
// diff and never token-rendered, so everything the plain rendering shows is still shown.
export function renderShifted(a: string[], b: string[], ops: Op[] | undefined, mode: LexMode | undefined): string {
  if (!ops || !mode || !ops.some((o) => o.op !== "=")) return "";
  const interner: Interner = new Map();
  const sa = lineStates(a, mode, interner);
  const sb = lineStates(b, mode, interner);
  let oi = 0;
  let ni = 0;
  let out = "";
  for (const o of ops) {
    if (o.op === "-") oi++;
    else if (o.op === "+") ni++;
    else {
      if (sa[oi] !== sb[ni]) {
        const q = needsQuote(o.v);
        const show = q ? JSON.stringify(o.v) : o.v;
        out += `@@ -${oi + 1} +${ni + 1} @@ [context changed: the line is the same text, now read differently]${q ? QUOTE_NOTE : ""}\n-${show}\n+${show}\n`;
      }
      oi++;
      ni++;
    }
  }
  return out;
}
