// Ordered diff for the reviewer prompt. Replaces a set-based diff that dropped any line
// present anywhere in both versions, which made changed files look truncated to the
// model (node-ipc 12.0.0's `}` in the 10-27 extended eval, an earlier change).

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

export function renderLineDiff(before: string | undefined, after: string | undefined): string {
  if (before !== undefined && after !== undefined && before !== after && (after === before.replaceAll("\n", "\r\n") || before === after.replaceAll("\n", "\r\n"))) {
    return "[line endings only: every line converted between CRLF and LF]\n";
  }
  const split = (s: string | undefined) => (s === undefined ? [] : s.split("\n"));
  const oldLines = split(before);
  const newLines = split(after);
  const ops = diffSeq(oldLines, newLines);
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
