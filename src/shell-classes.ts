// Classes of install-script shell forms that run code the scan cannot name from the text. `flagBody(text)` reads one
// shell body and returns one hit per class it finds; the caller reads every file of the package for each hit, as it
// does for an unrecognised runner. It never removes a widening, it only adds one, and it never dispatches.
//
// Only these classes are reported. Anything else (an unknown command, an expanded command word, `node -e/-p` code,
// `npx`, a dependency's bin) is left to the existing scan:
//   interp-flag   an interpreter or shell flag that loads or runs other code (--loader, -r, -m, --env-file, --run, --rcfile ...)
//   interp-stdin  an interpreter or shell that reads its program from stdin (`node -`, `sh`, `sh < f`); a pipeline sink
//                 (`echo x | sh`) is left to the existing scan
//   heredoc       a heredoc or here-string feeding an interpreter or shell, or a heredoc that does not terminate
//   cd-relative   a relative script, shell file or path command run after a `cd`
//   writer-exec   a file this body wrote by a redirect, cp/mv/ln/install, tee, curl -o or wget -O is then run: by name,
//                 by the name node resolves (`node b` for b.js, `node .` for index.js), or from inside a directory the
//                 body wrote (`cp -r t lib && node lib/x.js`), or edited in place (`sed -i`, `perl -pi`, `ruby -i`). Not covered:
//                 tar/unzip/patch/dd output and `ed`/`ex`/`awk -i inplace` edits (the files they write are unknown; the
//                 existing scan holds those)
//   program-file  `sed -f`, `awk -f`, `awk` with system/getline, `make -f`: the program is in a file
//   env-assign    a NODE_OPTIONS, NODE_PATH, npm_config_*, BASH_ENV, PERL5OPT, RUBYOPT, PYTHONPATH, PYTHONSTARTUP,
//                 LD_PRELOAD or DYLD_INSERT_LIBRARIES assignment (leading, after `env`, or `export`)
//   computed-command  the command word itself is an expansion (`$N -r ./p.js a.js`, `$(echo node) a.js`): it can be any interpreter
//   over-cap      a body longer than MAX_LEN characters, which is not parsed (fails closed)
//   unparsed      a structure the parser gives up on (nesting past MAX_DEPTH, fuel out, a trailing backslash, an
//                 empty redirect target): fails closed
//
// The parse is one linear pass with a fuel counter. It reads case/function/`$'..'`/process-substitution forms. A body
// whose structure it gives up on fails closed (`unparsed`, `over-cap`). An unclosed quote, backtick or paren, or a paren
// inside a word, reports nothing and leaves the existing scan's result: the shell would reject those, and reporting
// them would widen 15 of 77 quiet bodies in the real clean set (JSON-escaped quotes copied out of binding.gyp).

export type ClassName = "over-cap" | "unparsed" | "interp-flag" | "interp-stdin" | "heredoc" | "cd-relative" | "writer-exec" | "program-file" | "env-assign" | "computed-command";
export interface Hit { cls: ClassName; why: string }

interface Word { text: string; plain: boolean; q?: boolean } // plain: no $ or backtick expansion (a backslash only quotes)
interface Stage { unit: number; tm?: boolean; loops: number[]; words: Word[]; assigns: string[]; writes: string[]; varWrites: string[]; clobber: string[]; cond: boolean; fn?: string; fnDef?: string; pipeOut: boolean; reads: string[]; subs: string[]; hereSubs: string[]; heredoc: boolean; piped: boolean }

export const MAX_LEN = 20000;
export const LIMITS = { fuel: 200000 }; // a test lowers it
const MAX_DEPTH = 4;
let FUEL = 0; // one budget for a whole flagBody call: nested bodies and retries share it

class ParseFail extends Error {
  constructor(message: string, readonly cls?: ClassName, readonly pos = 0) { super(message); }
}
// The end of a backtick span starting at text[i] (the opening backtick), skipping backslash-escaped characters, and the
// text inside it with \` \\ and \$ unescaped. Throws a class-less failure when it is not closed.
function backtickSpan(text: string, i: number): { inner: string; end: number } {
  let inner = "";
  for (let j = i + 1; j < text.length; j++) {
    const c = text[j]!;
    if (c === "\\" && j + 1 < text.length) {
      const n = text[j + 1]!;
      inner += n === "`" || n === "\\" || n === "$" ? n : c + n;
      j++;
      continue;
    }
    if (c === "`") return { inner, end: j };
    inner += c;
  }
  return fail("backtick");
}
// Does the text start with a ( whose partner is its last character: `(a)` and not `(a) && (b)`?
function wrapsAll(t: string): boolean {
  if (!t.startsWith("(") || !t.endsWith(")")) return false;
  let d = 0;
  for (let i = 0; i < t.length; i++) { // parentheses inside quotes and after a backslash are text
    const c = t[i];
    if (c === "\\") i++;
    else if (c === "'") { const e = t.indexOf("'", i + 1); if (e < 0) return false; i = e; }
    else if (c === '"') { for (i++; i < t.length && t[i] !== '"'; i++) if (t[i] === "\\") i++; }
    else if (c === "(") d++;
    else if (c === ")" && --d === 0) return i === t.length - 1;
  }
  return false;
}
// Text inside (( )) that reads as a command rather than arithmetic: a word followed by a flag, a path or another word.
const COMMANDISH = /[A-Za-z_][\w.]*[ \t]+[-.\/A-Za-z_]/;
// Start of the token the parser is on; a class-less failure records it so the lines before it can still be read.
let AT = 0;
const fail = (why: string, cls?: ClassName): never => { throw new ParseFail(why, cls, AT); };

const KW_SKIP = new Set(["if", "then", "elif", "else", "fi", "while", "until", "do", "done", "{", "}", "!"]);

// The $(..) and backtick spans of an unquoted heredoc body (the body's own quotes mean nothing; the quotes inside a
// span do). An unclosed span ends the extraction.
function extractSubs(body: string, spend: () => void): string[] {
  const out: string[] = [];
  for (let i = 0; i < body.length; i++) {
    spend();
    const c = body[i]!;
    if (c === "\\") { i++; continue; }
    if (c === "`") { const e = body.indexOf("`", i + 1); if (e < 0) break; out.push(body.slice(i + 1, e)); i = e; continue; }
    if (c === "$" && body[i + 1] === "(") {
      let d = 1; let j = i + 2;
      for (; j < body.length && d > 0; j++) {
        spend();
        const k = body[j]!;
        if (k === "\\") { j++; continue; }
        if (k === "'") { const e = body.indexOf("'", j + 1); if (e < 0) return out; j = e; continue; }
        if (k === '"') { j++; while (j < body.length && body[j] !== '"') { spend(); if (body[j] === "\\") j++; j++; } continue; }
        if (k === "(") d++; else if (k === ")") d--;
      }
      if (d > 0) break;
      const inner = body.slice(i + 2, j - 1);
      if (body[i + 2] === "(" && inner.endsWith(")")) out.push(...extractSubs(inner.slice(1, -1), spend)); // arithmetic: only the substitutions in it run
      else out.push(inner);
      i = j - 1;
    }
  }
  return out;
}

function parse(text: string, depth: number): Stage[] {
  if (depth > MAX_DEPTH) fail("nesting is deeper than " + MAX_DEPTH, "unparsed");
  if (text.length > MAX_LEN) fail("body is over the " + MAX_LEN + " character cap", "over-cap");
  const stages: Stage[] = [];
  // open compound commands: "c" an if/while/until/for/case/select body, "f" a function body, "g" a { } group. An assignment in a
  // "c" or "f" may not run; the stack is popped by fi, done, esac and }.
  const open: string[] = [];
  // "gc" is a { } group after &&, || or a pipe: it may not run
  const openAt: number[] = []; // the index of the first stage of each open compound
  let lastGroup: { start: number; n: number } | undefined; // the { } group just closed
  let loopSeq = 0;
  const openLoop: (number | undefined)[] = []; // the id of each open for/while/until/select, undefined for the other compounds
  const curLoops = (): number[] => openLoop.filter((x): x is number => x !== undefined);
  const pushOpen = (e: string, loop = false): void => { open.push(e); openAt.push(stages.length); openLoop.push(loop ? ++loopSeq : undefined); st.loops = curLoops(); };
  const popOpen = (): void => { openLoop.pop(); const e = open.pop(); const at = openAt.pop(); if (e === "c" && at !== undefined && stages[at]?.piped) for (let k = at; k < stages.length; k++) stages[k]!.cond = true; // a compound on the right of a pipe runs in a subshell
    lastGroup = (e === "g" || e === "gc" || e === "c") && at !== undefined ? { start: at, n: stages.length } : undefined; };
  // a { } group that is followed by | or & runs in a subshell: nothing inside it is unconditional in this shell
  const subshellGroup = (): void => { if (lastGroup && lastGroup.n === stages.length && st.words.length === 0) for (let k = lastGroup.start; k < stages.length; k++) stages[k]!.cond = true; lastGroup = undefined; };
  let fnNext = false; // the next { opens a function body
  let fnName = ""; // ... and this is its name
  const innermostFn = (): string | undefined => { for (let k = open.length - 1; k >= 0; k--) if (open[k]!.startsWith("f:")) return open[k]!.slice(2); return undefined; };
  let compound = false;
  const syncCompound = () => { compound = open.some((e) => e === "c" || e === "gc" || e.startsWith("f:")); };
  let nextCond = false; // the previous separator was && or ||: this stage may not run
  let unitNo = 0; // the input line a command is on: an alias takes effect from the next one (a compound is read whole, so it is one line)
  const fresh = (): Stage => ({ unit: unitNo, words: [], assigns: [], writes: [], varWrites: [], clobber: [], cond: compound || nextCond, fn: innermostFn(), loops: curLoops(), pipeOut: false, reads: [], subs: [], hereSubs: [], heredoc: false, piped: false });
  // names an arithmetic text assigns (N=1, N++, --N, N+=2) and ${N:=v}
  const noteClobber = (arith: string): void => {
    for (const m of arith.matchAll(/(?<![\w$])([A-Za-z_]\w*)\s*(?:\+\+|--|(?:<<|>>|[-+*\/%&|^])?=(?!=))/g)) st.clobber.push(m[1]!);
    for (const m of arith.matchAll(/(?:\+\+|--)\s*(?<![\w$])([A-Za-z_]\w*)/g)) st.clobber.push(m[1]!);
  };
  const noteBraceClobber = (inner: string): void => {
    for (const m of inner.matchAll(/\$\{([A-Za-z_]\w*)(?:\[[^\]]*\])?:?=/g)) st.clobber.push(m[1]!); // := nested in a default word
    const m = /^([A-Za-z_]\w*):?=/.exec(inner); if (m) st.clobber.push(m[1]!);
    const sub = /^!?[A-Za-z_]\w*\[([^\]]*)\]/.exec(inner); if (sub) noteClobber(sub[1]!); // ${x[N=0]}: the subscript is arithmetic
    const off = /^[A-Za-z_]\w*(?:\[[^\]]*\])?:(?![-=+?])([\s\S]*)$/.exec(inner); if (off) noteClobber(off[1]!); // ${x:N=2}: the offset and length are arithmetic
  }; // ${N:=v} sets N; ${X:-k=v} sets nothing
  let st: Stage = fresh();
  let cur: Word | undefined;
  const pendingHere: { delim: string; strip: boolean; active: boolean; st: Stage }[] = [];
  let casePat = false; // the words up to the next ) are a case pattern, not a command
  const endWord = () => {
    if (!cur) return;
    const w = cur; cur = undefined;
    if (st.words.length > 0 && !w.q && (/^[A-Za-z_][A-Za-z0-9_]*\+?=/.test(w.text) || ARRAY_ASSIGN.test(w.text))) { const pk = prefixKind(st.words); if (pk) { st.words = []; if (pk.time) st.tm = true; } } // time N=b.js: bash runs it as the assignment, dash runs time(1): not known after it
    if (st.words.length === 0 && !w.q && /^[A-Za-z_][A-Za-z0-9_]*\[[^\]]*\]\+?=/.test(w.text)) { st.clobber.push(w.text.slice(0, w.text.indexOf("["))); { const sb = /^[A-Za-z_]\w*\[([^\]]*)\]/.exec(w.text); if (sb) noteClobber(sb[1]!); } return; } // N[0]=b.js sets N; a[N=2]=x sets N too
    if (st.words.length === 0 && !w.q && /^[A-Za-z_][A-Za-z0-9_]*\+?=/.test(w.text)) { st.assigns.push(w.text); return; }
    if (st.words.length === 0 && w.plain && !w.q && KW_SKIP.has(w.text)) {
      if (/^(?:if|while|until)$/.test(w.text)) { const fb = fnNext && st.fnDef !== undefined; pushOpen(fb ? "f:" + fnName : "c", !fb && w.text !== "if"); if (fb) { fnNext = false; st.fn = fnName; } syncCompound(); }
      else if (w.text === "{") { pushOpen(fnNext ? "f:" + fnName : st.cond || st.piped ? "gc" : "g"); fnNext = false; syncCompound(); if (open[open.length - 1]!.startsWith("f:")) { st.cond = true; st.fn = fnName; } }
      else if (/^(?:fi|done|\})$/.test(w.text)) { popOpen(); syncCompound(); }
      if (/^(?:then|elif|else|do)$/.test(w.text)) st.cond = true; // what follows runs only when the condition said so
      return;
    }
    if (w.plain && w.text === "{" && st.words[0]?.text === "function") { fnName = st.words[1]?.text ?? ""; pushOpen("f:" + fnName); fnNext = false; syncCompound(); st.cond = true; st.fn = fnName; st.words = []; return; } // function name { ... }
    if (w.plain && w.text === "{" && st.words.length > 0 && st.words.every((x) => x.plain && !x.q && /^(?:time|!|-p)$/.test(x.text))) { pushOpen(st.cond || st.piped ? "gc" : "g"); syncCompound(); st.words = []; return; } // time { ...; }
    if (st.words.length === 0 && w.plain && /^(?:for|case|select)$/.test(w.text)) { const fb = fnNext && st.fnDef !== undefined; pushOpen(fb ? "f:" + fnName : "c", !fb && w.text !== "case"); if (fb) { fnNext = false; st.fn = fnName; } syncCompound(); } // f() case ... esac: the compound is the body
    if (st.words.length === 0 && w.plain && w.text === "esac") { popOpen(); syncCompound(); }
    if (st.words.length === 0 && w.plain && w.text === "function") fnNext = true;
    st.words.push(w);
    if (w.plain && w.text === "in" && st.words[0]?.text === "case") casePat = true;
    if (w.plain && w.text === "esac") casePat = false;
  };
  const defName = (): string | undefined => st.fnDef ?? (st.words[0]?.text === "function" && st.words[1]?.plain ? st.words[1].text : undefined); // f() body, function f body: the name is recorded whatever the body is
  const endStage = () => {
    endWord();
    if (st.words[0] && (DECL.has(st.words[0].text) || st.words[0].text === "read")) for (const w of st.words.slice(1)) for (const m of w.text.matchAll(/\[([^\]]*)\]/g)) noteClobber(m[1]!); // read a[N=2], declare a[N=2]=x: the subscript is arithmetic
    if (st.fnDef === undefined) st.fnDef = defName();
    const empty = !(st.words.length || st.assigns.length || st.clobber.length || st.writes.length || st.reads.length || st.subs.length || st.heredoc || st.fnDef !== undefined);
    if (!empty) stages.push(st);
    const keepPipe = empty && st.piped; // `a |` then a newline: the next stage is still piped
    st = fresh(); st.piped = keepPipe;
  };
  // A quote or backslash in the tilde prefix, or before the ~ of a word, makes the ~ a literal character: ./~+/x names a file called ~+.
  // The same in the value of an assignment (N='~+/x'). An empty quote before the ~ ("" then ~) is also in front of it.
  const lit = (t: string, next: string): string => {
    const m = /^([A-Za-z_]\w*\+?=)(~[^/]*)?$/.exec(t);
    if (m) return m[2] !== undefined || next === "~" ? m[1] + "./" + (m[2] ?? "") : t;
    return /^~[^/]*$/.test(t) || (t === "" && next === "~") ? "./" + t : t;
  };
  const add = (c: string, plain = true) => { const had = cur !== undefined; cur ??= { text: "", plain: true }; if (had && c === "~" && cur.text === "") cur.text = "./"; cur.text += c; if (!plain) cur.plain = false; };
  const matchClose = (i: number, open: string, close: string): number => {
    let d = 1;
    const pend: { delim: string; strip: boolean }[] = []; // heredocs opened inside the span: their bodies are not shell
    for (; i < text.length; i++) {
      if (--FUEL < 0) fail("parse budget used up", "unparsed");
      const c = text[i]!;
      if (open === "(" && c === "\n" && pend.length) {
        for (const h of pend) {
          let p = i + 1;
          for (;;) {
            if (--FUEL < 0) fail("parse budget used up", "unparsed");
            const nl = text.indexOf("\n", p); const line = text.slice(p, nl < 0 ? text.length : nl).replace(/\r$/, "");
            if ((h.strip ? line.replace(/^\t+/, "") : line) === h.delim) { i = nl < 0 ? text.length : nl; break; }
            if (nl < 0) return fail("unclosed (");
            p = nl + 1;
          }
        }
        pend.length = 0;
        continue;
      }
      if (open === "(" && c === "<" && text[i + 1] === "<" && text[i + 2] !== "<") {
        let j = i + 2; const strip = text[j] === "-"; if (strip) j++;
        while (text[j] === " " || text[j] === "\t") j++;
        let e = j; while (e < text.length && !/[\s;&|()<>]/.test(text[e]!)) e++;
        const delim = text.slice(j, e).replace(/['"\\]/g, "");
        if (delim && !/^\d+$/.test(delim)) pend.push({ delim, strip }); // `1 << 2` is a shift
        i = e - 1; continue;
      }
      if (c === "\\") { i++; continue; }
      if (c === "#" && (i === 0 || /[\s;&|(]/.test(text[i - 1]!)) && open === "(") { while (i < text.length && text[i] !== "\n") i++; i--; continue; } // a comment in $( ): the newline after it still counts
      if (c === "'" && text[i - 1] === "$") { // $'..': a backslash escapes the quote
        let e = i + 1; for (; e < text.length && text[e] !== "'"; e++) { if (--FUEL < 0) fail("parse budget used up", "unparsed"); if (text[e] === "\\") e++; }
        if (e >= text.length) fail("quote"); i = e; continue;
      }
      if (c === "'") { const e = text.indexOf("'", i + 1); if (e < 0) fail("quote"); i = e; continue; }
      if (c === '"') { // a double-quoted string: a substitution, ${ } or backtick inside it opens a new quoting context
        i++;
        while (i < text.length && text[i] !== '"') {
          if (--FUEL < 0) fail("parse budget used up", "unparsed");
          const k = text[i]!;
          if (k === "\\") i++;
          else if (k === "$" && text[i + 1] === "(") i = matchClose(i + 2, "(", ")");
          else if (k === "$" && text[i + 1] === "{") i = matchClose(i + 2, "{", "}");
          else if (k === "`") { const e = text.indexOf("`", i + 1); if (e < 0) fail("backtick"); i = e; }
          i++;
        }
        if (i >= text.length) fail("quote");
        continue;
      }
      if (c === "$" && text[i + 1] === "{" && open === "(") { i = matchClose(i + 2, "{", "}"); continue; }
      if (c === "<" && text[i + 1] === "<" && text[i + 2] === "<" && open === "(") { i += 2; continue; } // a here-string
      if (c === open) d++;
      else if (c === close && --d === 0) return i;
    }
    return fail("unclosed " + open);
  };
  const isBreak = (c: string) => c === " " || c === "\t" || c === "\n" || c === "\r" || c === ";" || c === "&" || c === "|" || c === "(" || c === ")" || c === "<" || c === ">";
  const matchBracket = (i: number): number => { let d = 1; for (; i < text.length; i++) { if (text[i] === "[") d++; else if (text[i] === "]" && --d === 0) return i; } return -1; };
  const spend0 = () => { if (--FUEL < 0) fail("parse budget used up", "unparsed"); };
  let wordSubs: string[] = []; // command substitutions inside the word readWordAt just read (a redirect target, a delimiter)
  const readWordAt = (i: number): { w: Word; next: number } => {
    wordSubs = [];
    while (text[i] === " " || text[i] === "\t") i++;
    let t = ""; let plain = true; let started = false;
    for (; i < text.length; i++) {
      if (--FUEL < 0) fail("parse budget used up", "unparsed");
      const c = text[i]!;
      if (isBreak(c)) break;
      if (c === "'") { const e = text.indexOf("'", i + 1); if (e < 0) fail("quote"); t = lit(t, text[i + 1] ?? ""); started = true; t += text.slice(i + 1, e); i = e; continue; }
      if (c === '"') {
        let e = i + 1;
        t = lit(t, text[i + 1] ?? ""); started = true;
        for (; e < text.length && text[e] !== '"'; e++) {
          if (--FUEL < 0) fail("parse budget used up", "unparsed");
          const d = text[e]!;
          if (d === "\\") { // in double quotes a backslash escapes only $ ` " \ and a newline
            const n = text[e + 1] ?? "";
            if (n === "\n") { e++; continue; }
            t += /[$`"\\]/.test(n) ? n : "\\" + n; e++; plain = plain && !/[$`]/.test(n); continue;
          }
          if (d === "$" && text[e + 1] === "(") { const k = matchClose(e + 2, "(", ")"); wordSubs.push(text.slice(e + 2, k)); plain = false; t += "\u0001"; e = k; continue; }
          if (d === "`") { const b = backtickSpan(text, e); wordSubs.push(b.inner); plain = false; t += "\u0001"; e = b.end; continue; }
          if (d === "$" && text[e + 1] === "{") noteBraceClobber(text.slice(e + 2, matchClose(e + 2, "{", "}")));
          if (d === "$") plain = false;
          t += d;
        }
        if (e >= text.length) fail("quote");
        i = e; continue;
      }
      if (c === "$" && text[i + 1] === "'") {
        let j = i + 2;
        for (; j < text.length && text[j] !== "'"; j++) { if (--FUEL < 0) fail("parse budget used up", "unparsed"); if (text[j] === "\\") j++; }
        if (j >= text.length) fail("quote");
        t = lit(t, text[i + 2] ?? ""); started = true; t += text.slice(i + 2, j); plain = false; i = j; continue;
      }
      if (c === "\\") { t = lit(t, text[i + 1] ?? ""); started = true; t += text[i + 1] ?? ""; i++; continue; }
      if (c === "$" && text[i + 1] === "(") { const e = matchClose(i + 2, "(", ")"); wordSubs.push(text.slice(i + 2, e)); plain = false; t += "\u0001"; i = e; continue; }
      if (c === "$" && text[i + 1] === "{") { const e = matchClose(i + 2, "{", "}"); const inner = text.slice(i + 2, e); noteBraceClobber(inner); if (/\$\(|`/.test(inner)) wordSubs.push(inner); t += "${" + inner + "}"; plain = false; i = e; continue; }
      if (c === "`") { const b = backtickSpan(text, i); wordSubs.push(b.inner); plain = false; t += "\u0001"; i = b.end; continue; }
      if (c === "$") plain = false;
      if (c === "~" && started && t === "") t = "./";
      t += c;
    }
    return { w: { text: t, plain }, next: i };
  };
  for (let i = 0; i < text.length; i++) {
    if (--FUEL < 0) fail("parse budget used up", "unparsed");
    const c = text[i]!;
    AT = i;
    if (c === "\\") {
      if (text[i + 1] === "\n") { i++; continue; }
      if (i + 1 >= text.length) fail("trailing backslash", "unparsed");
      if (cur) cur.text = lit(cur.text, text[i + 1] ?? ""); else if (text[i + 1] === "~") add("./"); // a quoted ~ or a quote inside the tilde prefix starts no tilde expansion: ./~+/x is a file called ~+
      add(text[i + 1]!); if (!cur!.text.includes("=")) cur!.q = true; i++; continue;
    }
    if (c === "'") { const e = text.indexOf("'", i + 1); if (e < 0) fail("quote"); cur ??= { text: "", plain: true }; if (!cur.text.includes("=")) cur.q = true; cur.text = lit(cur.text, text[i + 1] ?? ""); cur.text += text.slice(i + 1, e); if (e === i + 1 && text[e + 1] === "~" && ASSIGN_VALUE_START.test(cur.text)) cur.text += "./"; i = e; continue; }
    if (c === '"') {
      cur ??= { text: "", plain: true };
      if (!cur.text.includes("=")) cur.q = true;
      cur.text = lit(cur.text, text[i + 1] ?? "");
      let j = i + 1;
      for (; j < text.length && text[j] !== '"'; j++) {
        if (--FUEL < 0) fail("parse budget used up", "unparsed");
        if (text[j] === "\\") { const n = text[j + 1] ?? ""; if (n !== "\n") cur.text += /[$`"\\]/.test(n) ? n : "\\" + n; j++; continue; } // only $ ` " \ and a newline are escaped
        if (text[j] === "$" && text[j + 1] === "(") {
          const e = matchClose(j + 2, "(", ")"); const inner = text.slice(j + 2, e);
          if (text[j + 2] === "(" && wrapsAll(inner)) { const a = inner.slice(1, -1); noteClobber(a); const found = extractSubs(a, spend0); st.subs.push(...found); if (!found.length && COMMANDISH.test(a.slice(0, 400))) st.subs.push(a); } // "$((N=1))" is arithmetic: it sets N here
          else st.subs.push(inner);
          cur.text += "\u0001"; cur.plain = false; j = e; continue;
        }
        if (text[j] === "`") { const b = backtickSpan(text, j); st.subs.push(b.inner); cur.text += "\u0001"; cur.plain = false; j = b.end; continue; }
        if (text[j] === "$" && text[j + 1] === "[") { const e = matchBracket(j + 2); if (e > 0) noteClobber(text.slice(j + 2, e)); }
        if (text[j] === "$" && text[j + 1] === "{") noteBraceClobber(text.slice(j + 2, matchClose(j + 2, "{", "}"))); // "${N:=v}" sets N too
        if (text[j] === "$") cur.plain = false;
        cur.text += text[j];
      }
      if (j >= text.length) fail("quote");
      if (j === i + 1 && text[j + 1] === "~" && ASSIGN_VALUE_START.test(cur.text)) cur.text += "./"; // N=''~+/x: the ~ is not at the start of the value
      i = j; continue;
    }
    if (c === "`") { const b = backtickSpan(text, i); st.subs.push(b.inner); add("\u0001", false); i = b.end; continue; }
    if (c === "$") {
      if (text[i + 1] === "[") { const e = matchBracket(i + 2); if (e < 0) fail("unclosed $["); const a = text.slice(i + 2, e); noteClobber(a); st.subs.push(...extractSubs(a, spend0)); add("\u0001", false); i = e; continue; } // $[N=2] is old arithmetic
      if (text[i + 1] === "(") {
        const dbl = text[i + 2] === "(";
        const e = matchClose(i + 2, "(", ")");
        const inner = text.slice(i + 2, e);
        if (!dbl) st.subs.push(inner);
        else if (!wrapsAll(inner)) st.subs.push(inner); // `$( (a) && (b) )`: two subshells in a substitution, not arithmetic
        else { const a = inner.slice(1, -1); noteClobber(a); const found = extractSubs(a, spend0); st.subs.push(...found); if (!found.length && COMMANDISH.test(a.slice(0, 400))) st.subs.push(a); }
        add("\u0001", false); i = e; continue; // the substitution's value is unknown
      }
      if (text[i + 1] === "[") { const e = matchClose(i + 2, "[", "]"); st.subs.push(...extractSubs(text.slice(i + 2, e), spend0)); add("", false); i = e; continue; }
      if (text[i + 1] === "{") { const e = matchClose(i + 2, "{", "}"); const inner = text.slice(i + 2, e); noteBraceClobber(inner); if (/\$\(|`/.test(inner)) st.subs.push(inner); add("${" + inner + "}", false); i = e; continue; }
      if (text[i + 1] === "'") {
        // ANSI-C quoting: a quoted word whose escapes the scan does not decode, so it is not plain.
        let j = i + 2;
        for (; j < text.length && text[j] !== "'"; j++) { if (--FUEL < 0) fail("parse budget used up", "unparsed"); if (text[j] === "\\") j++; }
        if (j >= text.length) fail("quote");
        if (cur) cur.text = lit(cur.text, text[i + 2] ?? ""); else if (text[i + 2] === "~") add("./");
        add(text.slice(i + 2, j), false); i = j; continue;
      }
      add("$", false); continue;
    }
    if ((c === "<" || c === ">") && text[i + 1] === "(") { const e = matchClose(i + 2, "(", ")"); st.subs.push(text.slice(i + 2, e)); add("", false); i = e; continue; }
    if (c === "[" && text[i + 1] === "[" && !cur && st.words.every((w) => w.plain && !w.q && (w.text === "time" || w.text === "!" || w.text === "-p")) && (text[i + 2] === " " || text[i + 2] === "\t")) {
      // `[[ cond ]]`: parens and operators inside are not shell syntax; only an expansion in it runs anything
      let e = i + 2;
      for (;; e++) {
        if (--FUEL < 0) fail("parse budget used up", "unparsed");
        if (e >= text.length) fail("[[ is not closed");
        const k = text[e]!;
        if (k === "\\") { e++; continue; }
        if (k === "'") { const q = text.indexOf("'", e + 1); if (q < 0) fail("quote"); e = q; continue; }
        if (k === '"') { e++; while (e < text.length && text[e] !== '"') { if (text[e] === "\\") e++; e++; } continue; }
        if (k === "]" && text[e + 1] === "]" && /\s/.test(text[e - 1] ?? "") && (e + 2 >= text.length || /[\s;&|)]/.test(text[e + 2]!))) break;
      }
      for (const sub of extractSubs(text.slice(i + 2, e), () => { if (--FUEL < 0) fail("parse budget used up", "unparsed"); })) st.subs.push(sub);
      for (const m of text.slice(i + 2, e).matchAll(/("[^"]*"|'[^']*'|\S+)\s+-(?:eq|ne|lt|le|gt|ge)\s+("[^"]*"|'[^']*'|\S+)/g)) noteClobber(m[1] + " " + m[2]); // the operands of -eq ... are arithmetic
      st.words.push({ text: "[[", plain: true }); i = e + 1; continue;
    }
    if (c === "(") {
      if (cur && !st.words.length && text[i + 1] === "(" && /^(?:for|select|if|while|until|elif)$/.test(cur.text)) { cur = undefined; st.words = [{ text: "for", plain: true }]; } // for((i=0;i<n;i++)): no space
      if (!cur && text[i + 1] === "(" && st.words.length === 1 && st.words[0]!.plain && /^(?:for|select)$/.test(st.words[0]!.text)) { // for ((i=0;i<n;i++))
        const e = matchClose(i + 1, "(", ")");
        const found = extractSubs(text.slice(i + 2, e - 1), spend0); st.subs.push(...found);
        st.words = []; i = e; continue;
      }
      if (!cur && ((st.words.length && st.words[st.words.length - 1]!.text === "in") || (casePat && !st.words.length))) { endStage(); casePat = false; i = matchClose(i + 1, "(", ")"); continue; } // case (pattern), also after ;;
      if (cur && /^[@?*+!]$/.test(cur.text.slice(-1))) { // extglob @(a|b) in a word or a case pattern
        const e = matchClose(i + 1, "(", ")");
        cur.text += text.slice(i, e + 1); cur.plain = false; i = e; continue;
      }
      if (cur && (!st.words.length || DECL.has(st.words[0]!.text)) && /^[A-Za-z_][A-Za-z0-9_]*\+?=$/.test(cur.text)) { // arr=(a b $(cmd)), declare -a arr=(..)
        const e = matchClose(i + 1, "(", ")");
        for (const sub of extractSubs(text.slice(i + 1, e), () => { if (--FUEL < 0) fail("parse budget used up", "unparsed"); })) st.subs.push(sub);
        cur.text += "(" + text.slice(i + 1, e) + ")"; cur.plain = false; i = e; continue;
      }
      if (!cur && st.words.length && st.words.every((w) => w.plain && !w.q && /^(?:time|coproc|!|-p)$/.test(w.text))) st.words = []; // time ( cmd ), coproc ( cmd ): a subshell
      if (cur || st.words.length) {
        // `name() { ... }` defines a function: drop the name, the body is read as the stages that follow.
        let j = i + 1; while (text[j] === " " || text[j] === "\t") j++;
        const n = st.words.length + (cur ? 1 : 0);
        if (text[j] === ")" && (n === 1 || (n === 2 && st.words[0]?.text === "function"))) { fnName = (cur ? cur.text : st.words[n === 2 ? 1 : 0]?.text) ?? ""; cur = undefined; st.words = []; st.fnDef = fnName; fnNext = true; i = j; continue; }
        fail("paren inside a word"); // a shell syntax error, and the JSON-escaped quotes of binding.gyp bodies
      }
      const e = matchClose(i + 1, "(", ")");
      const inner = text.slice(i + 1, e);
      // `((expr))` is arithmetic: only a $(..) or backtick inside it runs anything
      if (wrapsAll(inner)) { const a = inner.slice(1, -1); noteClobber(a); const found = extractSubs(a, spend0); st.subs.push(...found); if (!found.length && COMMANDISH.test(a.slice(0, 400))) st.subs.push(a); }
      else st.subs.push(inner);
      i = e; continue;
    }
    if (c === ")") { // a case pattern `x)` ends the pattern: its words are not a command
      if (casePat) { // keep the substitutions of the subject and the pattern: they run
        cur = undefined;
        const keep = st.subs;
        const keepClob = st.clobber;
        const def = defName();
        st = fresh();
        if (keep.length || keepClob.length || def !== undefined) { st.subs.push(...keep); st.clobber.push(...keepClob); st.fnDef = def; endStage(); }
        casePat = false; continue;
      }
      endStage(); continue;
    }
    if (c === "<" && text[i + 1] === "<" && text[i + 2] !== "<") {
      const fd = cur && /^[0-9]+$/.test(cur.text) && cur.plain ? cur.text : "";
      if (fd) cur = undefined; else endWord(); // 0<<EOF: the 0 is the descriptor
      let j = i + 2; const strip = text[j] === "-"; if (strip) j++;
      const { w, next } = readWordAt(j);
      if (!w.text) fail("heredoc delimiter", "heredoc");
      const raw = text.slice(j, next).trim();
      if (fd === "" || fd === "0") st.heredoc = true; // on another descriptor it is not the program's stdin
      pendingHere.push({ delim: w.text, strip, active: !/['"\\]/.test(raw), st });
      i = next - 1; continue;
    }
    if (c === "<" && text[i + 1] === "<" && text[i + 2] === "<") { const fd = cur && /^[0-9]+$/.test(cur.text) && cur.plain ? cur.text : ""; if (fd) cur = undefined; else endWord(); const { next } = readWordAt(i + 3); st.subs.push(...wordSubs); if (fd === "" || fd === "0") { st.heredoc = true; st.reads.push("<<<"); } i = next - 1; continue; }
    if (c === ">" || c === "<") {
      if (cur && /^[0-9]+$/.test(cur.text) && cur.plain) cur = undefined; else endWord(); // 2>x, 10>x
      let j = i + 1; let op = c;
      if (text[j] === ">" || text[j] === "|" || text[j] === "&") { op += text[j]; j++; }
      if (op === ">&" || op === "<&") { const { w, next } = readWordAt(j); st.subs.push(...wordSubs); if (!/^[0-9-]+$/.test(w.text)) { if (w.plain) st.writes.push(w.text); else st.varWrites.push(w.text); } i = next - 1; continue; }
      let q = j; while (text[q] === " " || text[q] === "\t") q++;
      if ((text[q] === "<" || text[q] === ">") && text[q + 1] === "(") { // `< <(cmd)`, `> >(cmd)`
        const e = matchClose(q + 2, "(", ")"); st.subs.push(text.slice(q + 2, e)); i = e; continue;
      }
      const { w, next } = readWordAt(j);
      st.subs.push(...wordSubs);
      if (!w.text && wordSubs.length === 0) fail("redirect target", "unparsed");
      if (c === ">" || op === "<>") { if (w.text && w.text !== "/dev/null" && w.plain) st.writes.push(w.text); else if (w.text && !w.plain) st.varWrites.push(w.text); }
      if (c === "<") st.reads.push(w.text); // <> opens the file for reading as well
      i = next - 1; continue;
    }
    if (c === "&" && text[i + 1] === ">") { endWord(); const { w, next } = readWordAt(text[i + 2] === ">" ? i + 3 : i + 2); st.subs.push(...wordSubs); if (!w.text && wordSubs.length === 0) fail("redirect target", "unparsed"); if (w.text !== "/dev/null" && w.plain) st.writes.push(w.text); else if (w.text && w.text !== "/dev/null") st.varWrites.push(w.text); i = next - 1; continue; }
    if (c === "|" && casePat) { cur = undefined; continue; } // a|b) separates case patterns
    if (c === "|" && text[i + 1] !== "|") { endWord(); subshellGroup(); st.pipeOut = true; endStage(); st.piped = true; nextCond = false; if (text[i + 1] === "&") i++; continue; }
    if (c === "&" && text[i + 1] !== "&") { endWord(); subshellGroup(); st.pipeOut = true; } // a background command runs in a subshell
    if (c === "|" || c === "&" || c === ";") { endStage(); const dbl = text[i + 1] === c; if (dbl) i++; if (c === ";" && dbl) casePat = true; if (c === ";" && !dbl && text[i + 1] === "&") { i++; casePat = true; } nextCond = dbl && c !== ";"; st.cond = compound || nextCond; continue; } // only ;; ends a case item
    if (c === "\n") {
      // a newline after && or || continues the list: the next command is still conditional
      const idle = !(st.words.length || st.assigns.length || st.clobber.length || st.writes.length || st.varWrites.length || st.reads.length || st.subs.length || st.heredoc);
      const goesOn = idle && (nextCond || st.piped); // after a trailing && || or | the shell has not finished the list: the next line is the same input line
      endStage(); if (!idle) nextCond = false; st.cond = compound || nextCond;
      if (open.length === 0 && !goesOn) { unitNo++; st.unit = unitNo; }
      if (pendingHere.length) {
        for (const h of pendingHere) {
          let p = i + 1; let found = false;
          const bodyStart = p;
          while (p <= text.length) {
            if (--FUEL < 0) fail("parse budget used up", "unparsed");
            const nl = text.indexOf("\n", p); const line = text.slice(p, nl < 0 ? text.length : nl).replace(/\r$/, "");
            if ((h.strip ? line.replace(/^\t+/, "") : line) === h.delim) {
              if (h.active) for (const sub of extractSubs(text.slice(bodyStart, p), () => { if (--FUEL < 0) fail("parse budget used up", "unparsed"); })) h.st.hereSubs.push(sub);
              i = nl < 0 ? text.length : nl; found = true; break;
            }
            if (nl < 0) break;
            p = nl + 1;
          }
          if (!found) fail("heredoc is not terminated", "heredoc");
        }
        pendingHere.length = 0;
      }
      continue;
    }
    if (c === " " || c === "\t" || c === "\r") { endWord(); continue; }
    if (c === "#" && !cur) { while (i < text.length && text[i] !== "\n") i++; i--; continue; }
    add(c);
  }
  if (pendingHere.length) fail("heredoc is not terminated", "heredoc");
  endStage();
  return stages;
}

const COPIES = new Set(["cp", "mv", "ln", "install", "tee"]);
// Wrappers that run the command behind them, with the options that take a value (the next word, or attached).
const WRAP: Record<string, { val: string[]; dur?: boolean }> = {
  env: { val: ["-u", "-C", "-P", "--unset", "--chdir"] },
  nohup: { val: [] },
  time: { val: ["-o", "-f", "--output", "--format"] },
  exec: { val: ["-a"] },
  command: { val: [] },
  builtin: { val: [] },
  nice: { val: ["-n", "--adjustment"] },
  ionice: { val: ["-c", "-n", "-p", "-P", "-u", "-t"] },
  timeout: { val: ["-s", "-k", "--signal", "--kill-after"], dur: true },
  sudo: { val: ["-u", "-g", "-h", "-p", "-C", "-D", "-R", "-T", "-r", "-t", "-U", "--user", "--group", "--host", "--chdir"] },
  doas: { val: ["-u", "-C"] },
  stdbuf: { val: ["-i", "-o", "-e", "--input", "--output", "--error"] },
  setsid: { val: [] },
  arch: { val: ["-arch"] },
  xargs: { val: ["-n", "-I", "-P", "-L", "-d", "-E", "-s", "-a", "-J", "--max-args", "--max-procs", "--delimiter", "--arg-file", "--replace"] },
  busybox: { val: [] },
  coproc: { val: [] },
  caffeinate: { val: ["-t", "-w"] },
};
const INTERP = /^(?:node|nodejs|bun|deno|python\d*(?:\.\d+)?|ruby\d*(?:\.\d+)?|perl\d*(?:\.\d+)?|php\d*(?:\.\d+)?|lua\d*(?:\.\d+)?)$/;
const SHELL = /^(?:sh|bash|zsh|dash|ksh|ash)$/;
const PM = /^(?:npm|yarn|pnpm|bun|npx|pnpx|bunx|corepack)$/;
// Flags that make the interpreter load or run code from somewhere the script text does not name. Inline code
// (`node -e`, `python -c`, `perl -e`) is not in this list: the existing scan reads it. Short flags can be clustered
// (`python3 -Bm pkg`, `perl -wMFoo`, `ruby -wrfoo`), so the letter classes match inside a cluster.
const LOADS: Record<string, RegExp> = {
  node: /^(?:-r|--require|--import|--loader|--experimental-loader|--env-file|--env-file-if-exists|--run|--preload|--test|--snapshot-blob|--experimental-config-file|--experimental-default-config-file|--openssl-config)(?:=|$)|^-r./,
  python: /^-[BEIOPRSbdiqsuvx]*m/, // -m MODULE; not the value of -W or -X (-Wmodule)
  ruby: /^-[A-Za-z0-9]*[rI]/,
  perl: /^-[A-Za-z]*[MmI]/,
  php: /^-[cz]|^-d(?:auto_(?:pre|ap)pend_file|extension|zend_extension|include_path)/,
  lua: /^-l/,
  deno: /^--(?:import-map|config|preload|import|cert|lock)(?:=|$)|^-c$/,
};
// ruby -r LIB / -I DIR load or add a path, as letters of a cluster before a flag that takes its value attached
// (-Ebinary, -Csrc, -Kutf8, -Tn, -xdir, -W2, -Fsep, -0777, -e CODE): the letters inside that value are not flags.
function rubyLoads(a: string): boolean {
  if (!a.startsWith("-") || a.startsWith("--")) return false;
  for (const c of a.slice(1)) { if (c === "r" || c === "I") return true; if ("ECKTxWFX0e".includes(c)) return false; }
  return false;
}
// -e CODE (also -we, -ne ...): the letter e before any flag that takes its value attached.
function rubyInline(a: string): boolean {
  if (!a.startsWith("-") || a.startsWith("--")) return /^--eval$/.test(a);
  for (const c of a.slice(1)) { if (c === "e") return true; if ("ECKTxWFX0".includes(c)) return false; }
  return false;
}
// Inline code per interpreter: node -e/-p, python -c, perl -e/-E, ruby -e, php -r, lua -e. (deno -r is --reload, perl -p a loop flag, perl -c a syntax check.)
function isInline(kind: string, a: string): boolean {
  if (kind === "ruby") return rubyInline(a);
  if (kind === "node") return /^-[A-Za-z]*[ep]$|^--(?:eval|print)$|^--(?:eval|print)=/.test(a); // -e, -p, -pe and clusters ending in e or p
  if (kind === "python") return /^-[A-Za-z]*c$/.test(a);
  if (kind === "perl") return /^-[A-Za-z]*[eE]$/.test(a);
  if (kind === "php") return a === "-r";
  if (kind === "lua") return a === "-e";
  return false;
}
const INLINE = /^(?:-p|-pe|-c|-r|-pi|--eval|--print)$|^--(?:eval|print)=|^-[A-Za-z]*[ecE]$/; // -e, -le, -we, -Bc ...
// Flags whose value is the next word, per interpreter (so the value is not taken for the script).
const VALUED: Record<string, string[]> = {
  node: ["--title", "-C", "--conditions", "--input-type", "--inspect-port", "--disable-warning", "--watch-path", "--diagnostic-dir", "--report-dir", "--cpu-prof-dir", "--cpu-prof-name", "--heap-prof-dir", "--heap-prof-name", "--report-filename", "--report-signal", "--max-http-header-size", "--unhandled-rejections", "--dns-result-order", "--experimental-default-type", "--redirect-warnings", "--openssl-config", "--icu-data-dir", "--tls-cipher-list", "--test-name-pattern", "--test-reporter", "--secure-heap", "--heapsnapshot-signal", "--trace-event-categories", "--stack-size"],
  python: ["-W", "-X", "-Q"],
  ruby: ["-E", "-C", "--encoding", "--external-encoding", "--internal-encoding"],
  perl: [],
  php: ["-d", "-c", "-z"],
  deno: ["--config", "-c", "--import-map"],
  lua: [],
};
// Node and V8 options that are switches: they take no value, so the word after one is the script.
const NODE_BOOL = /^--(?:no-|experimental-|enable-|disable-|trace-|abort-|expose|harmony|pending-|throw-|use-|preserve-|allow-|force-|frozen-|prof|inspect|check|interactive|test|watch|zero-fill|deprecation|warnings|jitless|insecure|openssl-|tls-|verify-|v8-|stack-)/;
const PHP_INI = /^(?:auto_(?:pre|ap)pend_file|extension|zend_extension|include_path|user_ini\.\w+)/;
// Loading flags whose value is the next word.
const VALUE_AFTER = new Set(["-l", "-c", "-z", "-r", "--require", "--import", "--loader", "--experimental-loader", "--env-file", "--env-file-if-exists", "--preload", "-I"]);
// $@, $*, "${A[@]}", ${X:-a b}: one word of text that expands to several; {a,b}: bash brace expansion.
const MULTIWORD = /\$\{?[@*]|\[[@*]\]\}|\$\{[A-Za-z_]\w*:?[-=+?](?:[^}]*\s|-)/; // "$@", "${A[@]}", ${X:-a b} and ${X:--r}: one word of text that can expand to several or to a flag
const WORD_CAP = 400; // the pattern tests below look at most this far into a word: a longer one that holds the shape counts as a hit
const braceTest = (re: RegExp, t: string): boolean => (t.length > WORD_CAP ? t.includes("{") && (t.includes(",") || t.includes("..")) && t.includes("}") : re.test(t));
const multiTest = (t: string): boolean => (t.length > WORD_CAP ? t.includes("${") || /\$[@*]/.test(t) : MULTIWORD.test(t));
const BRACE_ANY = /\{[^\s]*,[^\s]*\}|\{[^\s,{}]*\.\.[^\s,{}]*\}/; // any brace expansion (a command word made by one can be anything)
const BRACE_WORD = /^-[^\s]*\{[^\s]*,[^\s]*\}|\{-[^\s]*,[^\s]*\}|\{[^\s]*,-[^\s]*\}|\{[^{}\s]*\{[^\s]*,[^\s]*\}|\{[^\s]*,[^\s]*\{/; // a brace expansion that can make a flag or the command (a{1,2}.js is only two file names)
const STDIN_PATH = /^(?:\/dev\/stdin|\/dev\/fd\/0|\/proc\/self\/fd\/0)$/;
const FD_PATH = /^\/(?:dev|proc\/self)\/fd\/[1-9][0-9]*$/; // a program read from another descriptor (node /dev/fd/3 3<file)
const NO_PROGRAM = /^(?:-v|-V|-VV|--version|-h|--help|--v8-options|--check|-\?)$/;
const NO_PROGRAM_PHP = /^(?:-m|-i|--modules|--info|--ini)$/; // php -m lists modules, php -i prints the configuration
const BAD_ENV = /^(?:NODE_OPTIONS|NODE_PATH|NODE_EXTRA_CA_CERTS|BASH_ENV|PERL5OPT|PERL5LIB|RUBYOPT|RUBYLIB|PYTHONPATH|PYTHONSTARTUP|PYTHONHOME|LD_PRELOAD|LD_LIBRARY_PATH|DYLD_INSERT_LIBRARIES|DYLD_LIBRARY_PATH|OPENSSL_CONF|OPENSSL_MODULES|PHP_INI_SCAN_DIR|PHPRC|GCONV_PATH|LD_AUDIT|npm_config_\w+)\+?=/i;
const BAD_NAME = new RegExp(BAD_ENV.source.replace(/\\\+\?=$/, "$"), "i");
// More loaders: shell startup files, Lua and Perl library paths, the prompt string (run by `sh -x`), and a PATH or
// HOME with an entry that is not absolute and comes before the system ones (it points inside the package or at the working directory).
const BAD_ENV2 = /^(?:PERL5DB|ZDOTDIR|ENV|LUA_INIT\w*|LUA_PATH|LUA_CPATH|PERLLIB|PS4|PROMPT_COMMAND|SHELLOPTS|BASH_XTRACEFD|MAKEFILES|BASH_FUNC_[^=]*)\+?=/;
const TOOL_VAR = /^(?:PYTHON|CC|CXX|CPP|LD|AR|MAKE|SHELL|NODE_GYP_FORCE_PYTHON|LINK|(?:CC|CXX|LINK|LD|AR)_(?:host|target))=(.*)$/; // a compiler, interpreter or shell named by a relative path runs from the package
function badEnv(t: string): boolean {
  if (BAD_ENV.test(t) || BAD_ENV2.test(t)) return true;
  const tv = TOOL_VAR.exec(t);
  if (tv) return /\//.test(tv[1]!) && (!/^\/|^~(?![+-]|\d)/.test(tv[1]!) && !/^\$(?!\{?PWD\b)/.test(tv[1]!) || /^\$\{?PWD\b/.test(tv[1]!) || tv[1]!.startsWith("\u0001")); // $PWD and a substitution are inside the package or unknown
  // compiler flags that run or load a file from a path (-B dir, -fplugin=, -specs=, -fuse-ld=), and a Python user base: not absolute
  const fl = /^(?:C|CXX|CPP|LD|OBJC|OBJCXX|AS|F)FLAGS=([\s\S]*)$/.exec(t);
  if (fl) return /(?:^|\s)(?:-B\s*|-fplugin=|-specs=|-fuse-ld=|-Wl,[^\s]*-plugin=)(?![/])\S/.test(fl[1]!);
  const ub = /^PYTHONUSERBASE=([\s\S]*)$/.exec(t);
  if (ub) return ub[1] !== "" && !/^[/~]/.test(ub[1]!) && !/^\$(?!\{?PWD\b)/.test(ub[1]!);
  const m = /^(PATH|HOME)\+?=([\s\S]*)$/.exec(t);
  if (!m) return false;
  let es = m[2]!.split(":");
  if (m[1] === "PATH") { const k = es.findIndex((e) => /^\$\{?PATH\}?$/.test(e)); if (k >= 0) es = es.slice(0, k); } // appended entries come after the system ones
  return es.some((e) => !/^\/|^~(?![+-]|\d)|^\$\{?(?:PATH|HOME)\}?(?:\/|$)/.test(e)); // $PWD or a substitution is not known to be absolute
}
const BAD_NAME2 = new RegExp(BAD_ENV2.source.replace(/\\\+\?=$/, "$"));
const DECL = new Set(["export", "declare", "typeset", "readonly", "local"]);
// A default is taken only for a name that looks like the script's own: lower or mixed case, or a short upper-case word with no
// underscore. Shell names (_, REPLY, OPTARG, PWD, RANDOM), names the package manager or CI sets (PNPM_*, GITHUB_*, npm_*, INIT_CWD,
// HOME, TMPDIR) and upper-case names with an underscore are environment-shaped: they may hold a value, so the default is not known.
const ASSIGN_VALUE_START = /^[A-Za-z_]\w*\+?=(?:[^]*:)?$/; // the text of a word that is `NAME=` or ends in `:` after it: where an unquoted ~ would expand
// The words before an assignment that the shell reads as keywords: `time`, then `-p`, then `!`s; or `!`s alone. Anything else is a command.
const prefixKind = (ws: Word[]): { time: boolean } | undefined => {
  let i = 0; let time = false;
  const at = (t: string): boolean => ws[i] !== undefined && ws[i]!.plain && !ws[i]!.q && ws[i]!.text === t;
  if (at("time")) { time = true; i++; if (at("-p")) i++; }
  while (at("!")) i++;
  return i === ws.length ? { time } : undefined;
};
const ARRAY_ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*\[[^\]]*\]\+?=/;
const SHELL_NAMES = /^(?:REPLY|OPTARG|OPTIND|OPTERR|PWD|OLDPWD|HOME|PATH|TMPDIR|TMP|TEMP|CI|SHELL|USER|LANG|TERM|RANDOM|SECONDS|LINENO|HOSTNAME|SHLVL|UID|EUID|PPID|IFS|EDITOR|PS[1-4]|CDPATH|ENV|MAIL|LOGNAME|TZ|DISPLAY|COLUMNS|LINES|HISTFILE|BASH|BASHPID|FUNCNAME|MACHTYPE|OSTYPE|HOSTTYPE|GROUPS|DIRSTACK|PIPESTATUS|COMP_\w+)$/;
const SCRIPT_NAME = { test: (n: string): boolean => /^[A-Za-z][A-Za-z0-9]*$/.test(n) && !SHELL_NAMES.test(n) && !/^(?:npm|pnpm|yarn|bun|xdg|github|runner)$/i.test(n) || /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/.test(n) && !/^(?:npm|pnpm|yarn|bun|xdg)_/.test(n) } as const;
const BASE = (w: string) => w.replace(/^.*\//, "");
const norm = (f: string) => {
  f = f.replace(/^~(?:[+-]\d*|\d+)\/+/, ""); // ~+/b.js is b.js in the working directory
  const abs = f.startsWith("/");
  const out: string[] = [];
  for (const seg of f.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === ".." && out.length && out[out.length - 1] !== "..") out.pop(); else out.push(seg);
  }
  return (abs ? "/" : "") + out.join("/");
};

// A sed script that runs a command: an `e` command (optionally addressed) or an `s///e` flag. The script is split on
// `;`, newline and braces, so an `e` inside a pattern with `;` is not seen; a miss there leaves the existing scan. A
// script over SED_CAP characters is not read and counts as running one (fails closed).
const SED_CAP = 4000;
// A sed address regex: /re/ or \cREc with any delimiter c; `n` is the number of the capture group that holds the delimiter.
const reAddr = (n: number): string => "(?:\\/(?:[^/\\\\]|\\\\.)*\\/|\\\\([^\\\\\\n])(?:(?!\\" + n + ").)*?\\" + n + ")[IM]*";
const ADDR = new RegExp("^(?:\\d+(?:~\\d+)?|\\$|" + reAddr(1) + ")(?:,(?:\\d+|\\$|\\+\\d+|~\\d+|" + reAddr(2) + "))?!?\\s*");
// The files a sed script writes: the `w file` command and the `w` flag of `s///`.
function sedWrites(script: string): string[] {
  const out: string[] = [];
  if (script.length > SED_CAP) return out;
  for (const part of script.split(/[;\n{}]/)) {
    const c = part.trim().replace(ADDR, "");
    const m = /^w\s+(\S+)/.exec(c);
    if (m) out.push(m[1]!);
    if (c.length > 3 && c[0] === "s") {
      const d = c[1]!; let n = 0; let j = 2;
      for (; j < c.length && n < 2; j++) { if (c[j] === "\\") j++; else if (c[j] === d) n++; }
      const f = n === 2 ? /^[gpiIme0-9]*w\s+(\S+)/.exec(c.slice(j)) : null;
      if (f) out.push(f[1]!);
    }
  }
  return out;
}
function sedExecs(script: string): boolean {
  if (script.length > SED_CAP) return true;
  for (const part of script.split(/[;\n{}]/)) {
    let c = part.trim();
    c = c.replace(ADDR, "");
    if (c === "e" || /^e\s/.test(c)) return true;
    if (c.length > 3 && c[0] === "s") {
      const d = c[1]!; let n = 0; let j = 2;
      for (; j < c.length && n < 2; j++) { if (c[j] === "\\") j++; else if (c[j] === d) n++; }
      if (n === 2 && c.slice(j).includes("e") && /^[gpiIme0-9]+/.test(c.slice(j))) return true;
    }
  }
  return false;
}

// What a nested body inherits: the files written so far are shared (they are on disk), a cd is copied in.
interface State { cwd: boolean; written: Set<string>; vars?: Map<string, string>; aliases?: Map<string, string>; flags?: { unknownWrite: boolean; wild?: boolean }; unk?: Set<string>; sub?: boolean; fns?: Map<string, Set<string>>; fn?: string; ints?: Set<string>; refs?: Map<string, Set<string>> }

export function flagBody(text: string): Hit[] {
  const hits: Hit[] = [];
  FUEL = LIMITS.fuel;
  if (text.includes("\u0001")) { // the placeholder this reader puts in a word: a body that holds it cannot be told apart
    hits.push({ cls: "unparsed", why: "the body holds a control character this reader uses" });
    return hits;
  }
  try {
    walk(text, 0, hits, { cwd: false, written: new Set() });
  } catch (e) {
    hits.push({ cls: "unparsed", why: "the reader failed: " + (e instanceof Error ? e.message.slice(0, 80) : "error") }); // fail closed
  }
  return hits;
}

/**
 * The script an alias stands for with the words after it. An alias text that ends in a blank lets the next word be an alias too, and so on
 * down the chain, but only an unquoted word is looked up as an alias. A word that held a quote, an operator or a # keeps it quoted so it is
 * still one word: single quotes for a word without an expansion, double quotes (the $ left live) for a word with one.
 */
const ALIAS_DEF = /^([^\s'"`$\\=;&|<>()]+)=([\s\S]*)$/; // NAME=text: a shell accepts any name but blanks, quotes, $ \ = and metacharacters (dash takes a/b, ./x and x/)

function aliasScript(aliases: Map<string, string>, name: string, args: Word[], active: (n: string) => boolean): string {
  let text = aliases.get(name)!, rest = args;
  while (/\s$/.test(text) && rest.length && !rest[0]!.q && rest[0]!.plain && aliases.has(rest[0]!.text) && active(rest[0]!.text)) { text += aliases.get(rest[0]!.text)!; rest = rest.slice(1); } // rest shrinks each step: the chain ends
  const quote = (w: Word): string => {
    const asg = !w.q ? /^([A-Za-z_]\w*\+?=)([\s\S]*)$/.exec(w.text) : null; // NAME=value stays an assignment: only the value is quoted
    if (asg) return asg[1] + quote({ text: asg[2]!, plain: w.plain });
    if (!w.q && !/[\s#;&|<>()'"`\\]/.test(w.text)) return w.text; // a word that was quoted stays quoted: it is a command or an argument, never an assignment or an alias
    return w.plain ? `'${w.text.replace(/'/g, "'\\''")}'` : `"${w.text.replace(/[\\"`]/g, "\\$&")}"`;
  };
  return `${text} ${rest.map(quote).join(" ")}`;
}

function walk(text: string, depth: number, hits: Hit[], parent: State): void {
  // A function may be called before the one it calls is defined: a first pass over the text records what every body assigns.
  if (!parent.fns && /\(\s*\)|\bfunction\b/.test(text)) {
    const pre = new Map<string, Set<string>>();
    const size = (): number => { let n = pre.size; for (const v of pre.values()) n += v.size; return n; };
    let before = -1, round = 0;
    for (; round < 8 && before !== size(); round++) { // a chain h -> g -> f reaches f's names one round later
      before = size();
      walk(text, depth, [], { cwd: parent.cwd, written: new Set(parent.written), vars: new Map(parent.vars ?? []), aliases: parent.aliases ? new Map(parent.aliases) : undefined, unk: new Set(parent.unk ?? []), sub: parent.sub, fns: pre });
    }
    if (before !== size()) hits.push({ cls: "unparsed", why: "functions call each other too deep to follow" }); // not converged: what a call sets is unknown
    parent = { ...parent, fns: pre };
  }
  let stages: Stage[] | undefined;
  while (!stages) {
    try {
      stages = parse(text, depth);
    } catch (e) {
      if (!(e instanceof ParseFail)) throw e;
      if (e.cls) { hits.push({ cls: e.cls, why: e.message }); return; }
      // A syntax error the scan cannot read. On one line the shell runs nothing (and the JSON-escaped quotes of binding.gyp
      // bodies land here), so nothing is reported. In a body of several lines the shell runs the complete lines before the
      // error, so those are read (one retry per cut line, sharing the call's budget); the lines from the error on are not.
      const cut = text.lastIndexOf("\n", e.pos);
      if (cut <= 0) return;
      text = text.slice(0, cut);
    }
  }
  const hit = (cls: ClassName, why: string) => { if (!hits.some((h) => h.cls === cls && h.why === why)) hits.push({ cls, why }); };
  let cwd = parent.cwd;
  const copyTargets = parent.written;
  let stageCwd = false; // env -C, sudo -D and ruby -C move one command, not the rest of the body
  const nested = (t: string, sub = true) => walk(t, depth + 1, hits, { cwd: cwd || stageCwd, written: copyTargets, vars: nestedVars, aliases, flags, fns: fnVars, fn: curFn, unk: nestedUnk, sub, ints: intVars, refs });
  const written = (f: string) => {
    const n = norm(f);
    const T = new Set([...copyTargets].map(norm).filter(Boolean)); // "" (the directory ".") would match every absolute path
    if (T.has(n)) return true;
    for (const t of T) if (n.startsWith(t + "/")) return true; // inside a directory the body wrote (cp -r t lib)
    const entries = n === "." || n === "" ? ["index.js", "index.cjs", "index.mjs", "package.json"] : [n + ".js", n + ".cjs", n + ".mjs", n + ".json", n + "/index.js", n + "/index.cjs", n + "/index.mjs", n + "/package.json"];
    return entries.some((e) => T.has(e)); // node b -> b.js, node . -> index.js
  };
  const envHit = () => hit("env-assign", "a variable that loads code or config (NODE_OPTIONS, npm_config_*, BASH_ENV, LD_PRELOAD ...)");
  let later: string[] = [];
  const aliases = parent.aliases ?? new Map<string, string>(); // shared with nested bodies: a subshell and a -c string see them
  const aliasAt = new Map<string, number>(); // the input line each alias was defined on in this body; one from an outer body is active from the start
  const activeAlias = (name: string, unit: number): boolean => (aliasAt.get(name) ?? -1) < unit;
  const vars = parent.vars ?? new Map<string, string>(); // variables the body assigned a literal (or a value built from such)
  let nestedVars = vars; // what a nested body sees: the variables, plus this command's prefix assignments
  const unk = parent.unk ?? new Set<string>(); // variables the body assigned something it cannot read
  let nestedUnk = unk; // ... and the names those assignments gave a value that is not read
  const inSub = parent.sub === true; // a subshell, substitution or -c string: its assignments are not kept as literals
  const flags: { unknownWrite: boolean; wild?: boolean } = parent.flags ?? { unknownWrite: false }; // wild: a nameref with a target the body cannot name was written, so any name may hold anything; a redirect target the body cannot name: any file it runs may be that one
  // The text with every $NAME and ${NAME} replaced by the literal the body gave it; undefined when one is not known.
  const expand = (t: string): string | undefined => {
    let ok = true;
    // ${NAME:-word}, ${NAME-word}, ${NAME:=word}: the word when NAME is unset or empty (or not known to be anything else)
    t = t.replace(/\$\{([A-Za-z_]\w*)(:?)([-=])([^{}]*)\}/g, (m0, n, colon, _op, word) => {
      if (!own(n)) { ok = false; return m0; }
      const v = vars.get(n);
      if (v !== undefined && (colon === "" || v !== "")) return v;
      if (flags.wild || unk.has(n) || !SCRIPT_NAME.test(n)) { ok = false; return m0; } // assigned something the body cannot read, or set by npm or the shell (PWD names the package): not the default
      if ((/['"]/.test(word) && /\\/.test(word)) || (word.includes("'") && word.includes("$"))) { ok = false; return m0; } // quotes mixed with a backslash or a $: not read
      const d = expand(word.replace(/\\(.)|['"]/g, "$1")); // quote removal on the default word
      if (d === undefined) { ok = false; return m0; }
      return d;
    });
    // $PWD is the package directory only as the start of a path
    const r = t.replace(/\$\{(\w+)\}|\$(\w+)/g, (m0, a, b, off: number) => { const n = a ?? b; if (n === "PWD") { if (off > 1 || (off === 1 && !/^["']/.test(t))) { ok = false; return m0; } return "."; } const v = vars.get(n); if (v === undefined || !own(n)) { ok = false; return m0; } return v; });
    return ok && !/[$`\u0001]/.test(r) ? r : undefined;
  };
  const SPECIAL_BUILTINS = new Set([":", ".", "eval", "exec", "export", "readonly", "set", "shift", "trap", "unset", "exit", "return", "break", "continue", "times"]);
  const fnVars = parent.fns ?? new Map<string, Set<string>>(); // function name -> the names its body assigns
  let curFn: string | undefined; // the function whose body the current stage is in
  // A function body runs when it is called: a name it reads that it did not set itself may hold anything by then.
  const fnOwn = new Map<string, Set<string>>();
  const own = (n: string): boolean => curFn === undefined || fnOwn.get(curFn)?.has(n) === true;
  const markOwn = (n: string): void => { if (curFn !== undefined) { const set = fnOwn.get(curFn) ?? new Set<string>(); set.add(n); fnOwn.set(curFn, set); } };
  const loopDone = new Set<number>();
  const intVars = parent.ints ?? new Set<string>(); // names declared -i or -n
  const refs = parent.refs ?? new Map<string, Set<string>>(); // declare -n NAME=TARGET: a write to NAME writes TARGET ("*": a target the body cannot name)
  const addRef = (a: string): void => { // declare -n NAME=TARGET
    const n = a.split("=")[0]!.replace(/\[.*$/, "");
    const eq = a.indexOf("=");
    const t = eq < 0 ? "" : a.slice(eq + 1);
    const set = refs.get(n) ?? new Set<string>();
    set.add(/^[A-Za-z_]\w*$/.test(t) ? t : "*");
    refs.set(n, set);
  };
  const forgetOne = (n: string): void => { vars.delete(n); unk.add(n); if (curFn !== undefined) { const set = fnVars.get(curFn) ?? new Set<string>(); set.add(n); fnVars.set(curFn, set); } }; // the value is not known from here on
  // A write to a nameref writes the name it refers to (declare -n N=M; N=b.js sets M); a target the body cannot name may be any name.
  const forget = (n: string, seen = new Set<string>()): void => {
    forgetOne(n);
    if (seen.has(n)) return;
    seen.add(n);
    const r = refs.get(n);
    if (!r) return;
    if (r.has("*")) {
      for (const k of [...vars.keys()]) forgetOne(k);
      flags.wild = true; // a name never set is not known either: its ${N:-default} is not what it holds
      if (curFn !== undefined) { const set = fnVars.get(curFn) ?? new Set<string>(); set.add("*"); fnVars.set(curFn, set); } // calling the function does the same
    }
    for (const t of r) if (t !== "*") forget(t, seen);
  };
  // A write to a name the body cannot tell is not one that a package file can be run from when it is outside the package
  // ($TMPDIR, $HOME, /tmp/x, ${LOG:-/dev/null}) or when the command writing it is a program (its own output: node a.js > $OUT).
  const skipUnknown = (target: string, _head?: string, _words?: Word[]): boolean => {
    if (flags.wild) return false; // a nameref with an unnameable target was written: $HOME, $TMPDIR or a default may name a package file
    // Only a place that is outside the package whatever the variables hold. A variable the body assigned or could not read,
    // a positional parameter and npm's own ($npm_package_* is set by the package) can all name a package file; and no
    // program's own output is trusted (npx, npm exec, npm run, make, node a script ... can print any file).
    if (/\$\{?(?:npm_|[0-9@*#])/.test(target)) return false;
    for (const m of target.matchAll(/\$\{?([A-Za-z_]\w*)/g)) if (vars.has(m[1]!) || unk.has(m[1]!)) return false;
    // The whole word is the outside prefix plus a literal tail: no expansion, no backquote and no `..` segment (which climbs
    // out of the place), and ${V:-/dev/null} only as the whole word.
    const t = target.replace(/^["']|["']$/g, "");
    const dn = /^\$\{(\w+):[-=]\/dev\/null\}$/.exec(t);
    if (dn) return SCRIPT_NAME.test(dn[1]!);
    const m = /^(?:(?=\/)|~(?![+-]|\d)[^/$`]*(?=\/|$)|\$\{?(?:TMPDIR|HOME|TMP|TEMP|XDG_\w+)\}?(?=\/|$))([^$`\u0001]*)$/.exec(t);
    return !!m && !/(?:^|\/)\.\.(?:\/|$)/.test(t);
  };
  const assign = (a: string, keep = true): void => {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)(\+?)=([\s\S]*)$/.exec(a);
    if (!m) return;
    if (intVars.has(m[1]!)) { forget(m[1]!); return; } // declare -i: the value is evaluated as arithmetic
    const v = m[2] || !keep ? undefined : expand(m[3]!); // N+=x is not tracked; neither is an assignment that may not run
    if (v === undefined) forget(m[1]!); else { vars.set(m[1]!, v); markOwn(m[1]!); }
  };
  // The builtin a stage runs and its arguments: command, builtin and time (and their options) are skipped.
  const builtinOf = (s: Stage): { h: string; args: string[]; words: Word[] } => {
    const t = s.words.map((w) => w.text);
    let at = 0;
    while (at < t.length && ["command", "builtin", "time"].includes(t[at]!)) { at++; while (at < t.length && t[at]!.startsWith("-")) at++; }
    return { h: t[at] ?? "", args: t.slice(at + 1), words: s.words.slice(at + 1) };
  };
  // A stage whose command word is an alias runs the alias text, a whole script, with the other words after it. Both readings count: the alias read
  // as written (an alias named eval does not expand after command, and an alias of true may hide the real builtin) and the text it stands for.
  // undefined: no alias; null: its text does not parse.
  const aliasStages = (s: Stage, d: number, used: Set<string>, fresh = false): { stages: Stage[] | null; text: string; name: string } | undefined => {
    const { h, words } = builtinOf(s);
    const al = fresh || activeAlias(h, s.unit) ? aliases.get(h) : undefined;
    if (al === undefined || used.has(h) || d > MAX_DEPTH) return undefined;
    const text = aliasScript(aliases, h, words, (n) => fresh || activeAlias(n, s.unit));
    try { return { stages: parse(text, d), text, name: h }; } catch (e) { if (!(e instanceof ParseFail)) throw e; return { stages: null, text, name: h }; }
  };
  // The NAME=TARGET words of the nameref links a stage makes: declare/typeset/local -n, a for whose variable is a nameref (it repoints it at each word), and eval or an alias of either.
  const refLinks = (s: Stage, d = depth + 1, used = new Set<string>(), fresh = false): string[] => {
    const out: string[] = [];
    const al = aliasStages(s, d, used, fresh);
    if (al?.stages) for (const o of al.stages) out.push(...refLinks(o, d + 1, new Set(used).add(al.name), true));
    const { h, args } = builtinOf(s);
    if ((h === "declare" || h === "typeset" || h === "local") && args.some((a) => /^-[A-Za-z]*n/.test(a))) out.push(...args.filter((a) => !a.startsWith("-")));
    if (h === "for" && args[1] === "in" && args[0] && refs.has(args[0])) out.push(...args.slice(2).map((w) => `${args[0]}=${w}`));
    if (h === "for" && args[0] && args[1] !== "in" && refs.has(args[0])) out.push(`${args[0]}=*`); // for N: the positional parameters repoint a nameref anywhere
    if (h === "eval" && args.length && d < MAX_DEPTH) {
      try { for (const o of parse((args[0] === "--" ? args.slice(1) : args).join(" "), d)) out.push(...refLinks(o, d + 1, used, true)); } catch (e) { if (!(e instanceof ParseFail)) throw e; }
    }
    return out;
  };
  // The names a stage may set: its assignments, arithmetic, and the builtins that set a name.
  const namesSet = (s: Stage, d = depth + 1, used = new Set<string>(), fresh = false): string[] => {
    const out: string[] = [...s.clobber];
    for (const a of s.assigns) { const m = /^([A-Za-z_]\w*)/.exec(a); if (m) out.push(m[1]!); }
    const al = aliasStages(s, d, used, fresh);
    if (al?.stages) for (const o of al.stages) out.push(...namesSet(o, d + 1, new Set(used).add(al.name), true));
    else if (al) for (const n of al.text.match(/[A-Za-z_]\w*/g) ?? []) out.push(n); // an alias text that does not parse: every name in it may be set
    const { h, args } = builtinOf(s);
    if (DECL.has(h)) for (const a of args) { if (!a.startsWith("-")) out.push(a.split("=")[0]!.replace(/\[.*$/, "")); }
    else if (h === "read" || h === "mapfile" || h === "readarray" || h === "getopts" || h === "printf") for (const a of args) { if (/^[A-Za-z_]\w*$/.test(a)) out.push(a); const v = /^-v([A-Za-z_]\w*)/.exec(a); if (v) out.push(v[1]!); }
    else if (h === "for" || h === "select") { if (args[0] && /^[A-Za-z_]\w*$/.test(args[0])) out.push(args[0]); } // for NAME in words: only NAME is set
    else if (h === "let") for (const a of args) { for (const m of a.matchAll(/([A-Za-z_]\w*)\s*(?:\+\+|--|[-+*\/%&|^<>]*=)/g)) out.push(m[1]!); for (const m of a.matchAll(/(?:\+\+|--)\s*([A-Za-z_]\w*)/g)) out.push(m[1]!); }
    if (h === "eval" && args.length) { // the text eval runs sets names on every pass of a loop
      if (args[0] === "--") for (const n of args.slice(1).join(" ").match(/[A-Za-z_]\w*/g) ?? []) out.push(n); // dash's eval does not skip --
      const text = (args[0] === "--" ? args.slice(1) : args).join(" ");
      try { // one parse: a second one would spend the budget again, and a failure there must also fall back to every name
        if (d <= MAX_DEPTH) {
          const os = parse(text, d), defd = new Set<string>();
          for (const o of os) out.push(...namesSet(o, d + 1, used, true));
          // a use of an alias the text defines: its text may end in ; or && so that a NAME=value argument is an assignment
          for (const o of os) { const b = builtinOf(o); if (b.h === "alias") for (const a of b.args) { const m = ALIAS_DEF.exec(a); if (m) defd.add(m[1]!); } }
          if (defd.size) for (const o of os) { const b = builtinOf(o); if (defd.has(b.h)) for (const a of b.args) { const m = /^([A-Za-z_]\w*)\+?=/.exec(a); if (m) out.push(m[1]!); } }
        }
      } catch (e) { if (!(e instanceof ParseFail)) throw e; for (const n of text.match(/[A-Za-z_]\w*/g) ?? []) out.push(n); } // a shell runs the lines before a syntax error: every name in the text may be set
    }
    if (h === "alias") for (const a of args) { const m = ALIAS_DEF.exec(a); if (m) for (const n of m[2]!.match(/[A-Za-z_]\w*/g) ?? []) out.push(n); } // an alias defined here may run later in the same body (in an eval text it is not in the map yet): the names its text names may be set
    if (h === "getopts") out.push("OPTARG", "OPTIND");
    if (h === "read") out.push("REPLY");
    const called = fnVars.get(h); // a function called in the body sets the names its body sets, on every pass
    if (called) for (const n of called) out.push(n);
    return out;
  };
  for (const st of stages) {
    // a loop's second pass reads what its first pass set: those names are not known inside it
    for (const id of st.loops) {
      if (loopDone.has(id)) continue;
      loopDone.add(id);
      // a nameref declared in the body links its name to its target from the second pass on: link them before the names are forgotten
      // a for over a nameref variable links only once the nameref is declared, wherever in the body that comes: repeat until no link is new
      for (let round = 0, before = -1; round < 4 && before !== [...refs.values()].reduce((n, v) => n + v.size, refs.size); round++) {
        before = [...refs.values()].reduce((n, v) => n + v.size, refs.size);
        for (const o of stages) if (o.loops.includes(id)) for (const l of refLinks(o)) addRef(l);
      }
      for (const o of stages) if (o.loops.includes(id)) for (const n of namesSet(o)) forget(n);
    }
    stageCwd = false;
    curFn = st.fn ?? parent.fn;
    if (st.fn !== undefined && !fnVars.has(st.fn)) fnVars.set(st.fn, new Set());
    if (st.fnDef !== undefined && !fnVars.has(st.fnDef)) fnVars.set(st.fnDef, new Set()); // f() ( ... ) too
    nestedVars = vars;
    nestedUnk = unk;
    if (st.words.length && st.assigns.length) { // N=b.js eval '...': the assignment is the command's environment, seen by the code it runs
      nestedVars = new Map(vars);
      for (const a of st.assigns) { const pm = /^([A-Za-z_]\w*)=([\s\S]*)$/.exec(a); const pv = pm ? expand(pm[2]!) : undefined; const m = pm && pv !== undefined ? [a, pm[1]!, pv] : null; if (m) nestedVars.set(m[1]!, m[2]!); else { const n = /^([A-Za-z_]\w*)=/.exec(a); if (n) { nestedVars.delete(n[1]!); if (nestedUnk === unk) nestedUnk = new Set(unk); nestedUnk.add(n[1]!); } } }
    }
    // A redirect empties its target before the command runs, so a stage does not run its own output file.
    for (const t of later) copyTargets.add(t);
    // a target built from a variable the body assigned a literal to (`N=b.js; cat x > "$N"`) is a known file
    for (const n of st.clobber) forget(n); // words and targets expand before the redirects are opened: what they assign is seen by the targets
    const resolved: string[] = [];
    for (const t of st.varWrites) { const e = expand(t); if (e === undefined) { if (!skipUnknown(t, st.words[0]?.text, st.words)) flags.unknownWrite = true; } else resolved.push(e); }
    later = [...st.writes, ...resolved];
    // an assignment in front of a command is that command's environment; one in a branch, a pipeline, a function or a
    // subshell may not run, or runs elsewhere: the value is not known afterwards
    if (!st.words.length) for (const a of st.assigns) { if (st.tm) { const n = /^([A-Za-z_]\w*)/.exec(a); if (n) forget(n[1]!); } else assign(a, !(st.cond || st.pipeOut || st.piped || inSub)); }
    for (const s of st.subs) nested(s);
    for (const s of st.hereSubs) nested(s);
    if (st.assigns.some((a) => badEnv(a))) envHit();
    let w = st.words;
    // `function name {` and a leading `{` open a body that the next words continue.
    while (w.length && ((w[0]!.plain && w[0]!.text === "function") || (!w[0]!.q && (w[0]!.text === "{" || w[0]!.text === "!")))) {
      w = w[0]!.text === "function" ? w.slice(Math.min(2, w.length)) : w.slice(1);
    }
    if (w.length && w[0]!.plain && (SPECIAL_BUILTINS.has(BASE(w[0]!.text)) || fnVars.has(BASE(w[0]!.text)))) for (const as of st.assigns) { const n = /^([A-Za-z_]\w*)\+?=/.exec(as); if (n) forget(n[1]!); } // sh keeps a prefix assignment of a special builtin (also exec with only redirections)
    let lookup = false;
    let viaXargs = false;
    let xargsRepl = "{}"; // xargs -I STR: the string standing for each input line
    for (let n = 0; w.length; n++) {
      const spec = WRAP[BASE(w[0]!.text)];
      if (!spec || !w[0]!.plain || (w[0]!.text.includes("/") && !w[0]!.text.startsWith("/"))) break; // ./timeout is a file of the package, not the wrapper
      if (n >= 8) { hit("unparsed", "more than 8 wrappers before the command"); break; }
      const name = BASE(w[0]!.text);
      let k = 1;
      for (; k < w.length; k++) {
        if (name === "command" && /^-[pvV]*[vV][pvV]*$/.test(w[k]!.text)) { lookup = true; break; } // command -v node: a lookup, nothing runs
        const t = w[k]!.text;
        if (name === "coproc" && k === 1 && w[2]?.text === "{") { k = 2; break; } // coproc NAME { ...; }
        if (name === "env" ? /^[^-=][^=]*=/.test(t) : /^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) { if (badEnv(t)) envHit(); continue; }
        if (t === "--") { k++; break; }
        if (name === "env" && t === "-") continue; // env - : an empty environment, the command follows
        if (!t.startsWith("-") || t === "-") break;
        if (name === "env" && (t === "-S" || t === "--split-string")) { if (w[k + 1]) { if (!w[k + 1]!.plain) hit("computed-command", "env -S runs text built by an expansion"); nested(w[k + 1]!.text); } k++; continue; }
        if (name === "env" && t.startsWith("--split-string=")) { nested(t.slice(15)); continue; }
        if (name === "env" && (t === "-C" || t === "--chdir" || t.startsWith("--chdir="))) stageCwd = true;
        if (name === "sudo" && (t === "-D" || t === "--chdir" || t.startsWith("--chdir=") || (t.startsWith("-D") && t.length > 2))) stageCwd = true;
        if (spec.val.includes(t)) k++;
        else if (name === "env" && t.startsWith("-S") && t.length > 2) nested(t.slice(2));
        else if (name === "env" && t.startsWith("-C") && t.length > 2) stageCwd = true;
      }
      if (spec.dur && k < w.length) k++;
      const w0 = w;
      w = w.slice(k);
      while (w.length && !w[0]!.q && (w[0]!.text === "{" || w[0]!.text === "!")) w = w.slice(1); // time { cmd; }
      if (name === "xargs") {
        viaXargs = true;
        for (let q = 1; q < k; q++) { // -I STR, -ISTR, -J STR, -iSTR, -i, --replace[=STR]
          const t = w0[q]!.text;
          if (t === "-I" || t === "-J") { xargsRepl = w0[q + 1]?.text ?? "{}"; q++; }
          else if (/^-[IJ]./.test(t)) xargsRepl = t.slice(2);
          else if (t === "-i" || t === "--replace") xargsRepl = "{}";
          else if (/^-i./.test(t)) xargsRepl = t.slice(2);
          else if (t.startsWith("--replace=")) xargsRepl = t.slice(10);
        }
      }
    }
    while (w.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(w[0]!.text)) { if (badEnv(w[0]!.text)) envHit(); w = w.slice(1); } // env -- NAME=v cmd: the assignment after -- is the first word
    if (lookup || !w.length) continue;
    if (w[0]!.plain && braceTest(BRACE_ANY, w[0]!.text)) { hit("computed-command", "a brace expansion in the command word"); continue; }
    if (!w[0]!.plain && /^\$\{?npm_node_execpath\}?$/.test(w[0]!.text)) w = [{ text: "node", plain: true }, ...w.slice(1)]; // it is node itself
    const head = w[0]!;
    if (!head.plain) {
      // npm's own variables are resolved by the existing scan ($npm_execpath is the npm runner, ${npm_package_config_x} is a value of the manifest)
      if (!/^\$\{?(?:npm_execpath|npm_node_execpath|npm_package_config_\w+)\}?$/.test(head.text)) hit("computed-command", "the command word is an expansion (a variable, a substitution)");
      continue;
    } // it can name any interpreter
    const b = BASE(head.text);
    // sh keeps a prefix assignment of a POSIX special builtin (N=b.js : / export X / set --): the name changes for the rest of the body
    if (head.plain && (SPECIAL_BUILTINS.has(b) || fnVars.has(b))) for (const as of st.assigns) { const n = /^([A-Za-z_]\w*)\+?=/.exec(as); if (n) forget(n[1]!); }
    const args = w.slice(1);
    // dash (and any POSIX sh) expands an alias defined earlier in the script: its text is read as the command
    if (b === "alias") { for (const a of args) { const m = ALIAS_DEF.exec(a.text); if (m) { aliases.set(m[1]!, m[2]!); aliasAt.set(m[1]!, st.unit); } } continue; }
    const called = fnVars.get(b); // calling a function runs its assignments: forget every name its body sets
    if (called) for (const n of called) { if (n === "*") { flags.wild = true; for (const k of [...vars.keys()]) forgetOne(k); } else forget(n); }
    const ab = aliases.has(head.text) ? head.text : b; // the alias is named by the whole word (dash accepts a/b); an alias named b still matches sub/b when no alias named sub/b exists (it over-holds)
    const al = activeAlias(ab, st.unit) ? aliases.get(ab) : undefined;
    const declMaybe = (b === "local" && curFn === undefined) || b === "declare" || b === "typeset"; // local outside a function fails in sh and bash, declare and typeset fail in dash: the name keeps its old value
    const aliased = al !== undefined && head.plain && !head.q; // the alias may not expand (bash without expand_aliases): what the stage as written sets is then only maybe set
    if (aliased) { // the alias text is read without this alias (a shell does not expand it again)
      const rest2 = new Map(aliases); rest2.delete(ab);
      const script = aliasScript(aliases, ab, args, (n) => activeAlias(n, st.unit));
      walk(script, depth + 1, hits, { cwd: cwd || stageCwd, written: copyTargets, vars: nestedVars, aliases: rest2, flags, fns: fnVars, fn: curFn, unk: nestedUnk, sub: inSub || st.cond || st.pipeOut || st.piped, ints: intVars, refs });
      // bash does not expand aliases in a script unless expand_aliases is on, and sh and dash do: the names the text sets are known on one reading only
      try { for (const o of parse(script, depth + 1)) for (const n of namesSet(o, depth + 2, new Set([ab]), true)) forget(n); } catch (e) { if (!(e instanceof ParseFail)) throw e; }
      // no continue: bash without expand_aliases runs the stage as written (alias node=true; node -r ./p.js runs the real node)
    }
    const stdin = (what: string) => { if (st.reads.length && !st.heredoc && st.reads.every((r) => r === "/dev/null")) return; if (!st.piped || st.heredoc || st.reads.length) hit(st.heredoc ? "heredoc" : "interp-stdin", `${what} reads its program from stdin`); };
    const ranWritten = (f: string) => { if (written(f) || (flags.unknownWrite && !f.startsWith("/")) || (flags.wild && /[$`\u0001]/.test(f) && copyTargets.size > 0)) hit("writer-exec", `runs ${f}, written or copied by this body (or by a write to a name it cannot tell)`); };
    // A script path held in a variable: known when the body assigned it
    const scriptWord = (w: Word): Word | undefined => {
      if (w.plain) { if (braceTest(BRACE_ANY, w.text)) hit("computed-command", "a script path with a brace expansion: the file is not the one named"); return w; }
      if (/^["']?\$\{?npm_/.test(w.text)) return undefined; // the existing scan reads npm's own variables
      const e = expand(w.text);
      if (e !== undefined) { hit("computed-command", "a script path the existing scan cannot see: it is built from a variable"); return { text: e, plain: true }; }
      // a variable the body assigned something it cannot read names a script nothing can name; an unassigned one stays as it was
      // (a lone variable is the script; the existing scan reads $npm_* values)
      for (const m of w.text.matchAll(/\$\{?([A-Za-z_]\w*)/g)) if (unk.has(m[1]!) || !own(m[1]!)) { hit("computed-command", "a script path built from a variable whose value the body does not give literally"); break; }
      return undefined;
    };
    if (head.text.includes("/")) ranWritten(head.text); // ./node, ./sh, /tmp/x: a command this body wrote
    if (b === "printf") { const vi = args.findIndex((a) => a.text === "-v"); if (vi >= 0 && args[vi + 1]) forget(args[vi + 1]!.text.replace(/\[.*$/, "")); for (const a of args) if (/^-v./.test(a.text)) forget(a.text.slice(2).replace(/\[.*$/, "")); } // printf -v N, -vN
    if (b === "getopts") { if (args[1]) forget(args[1]!.text); forget("OPTARG"); forget("OPTIND"); continue; } // getopts spec NAME sets NAME
    if (b === "mapfile" || b === "readarray") { for (const a of args) if (!a.text.startsWith("-") && /^[A-Za-z_]\w*$/.test(a.text)) forget(a.text); continue; }
    if (b === "let") { for (const a of args) { for (const m of a.text.matchAll(/(?<![\w$])([A-Za-z_]\w*)\s*(?:\+\+|--|(?:<<|>>|[-+*\/%&|^])?=(?!=))/g)) forget(m[1]!); for (const m of a.text.matchAll(/(?:\+\+|--)\s*(?<![\w$])([A-Za-z_]\w*)/g)) forget(m[1]!); } continue; }
    if (b === "unset") { for (const a of args) if (!a.text.startsWith("-")) forget(a.text.replace(/\[.*$/, "")); continue; }
    if (b === "read") { forget("REPLY"); for (const a of args) if (!a.text.startsWith("-")) { const n = a.text.replace(/\[.*$/, ""); forget(n); if (badEnv(n + "=./x")) envHit(); } continue; } // read PATH: the value is not known, and may be a loader variable // read N: the value is not known
    if (b === "for" && args.length >= 1 && args[1]?.text !== "in") { if (refs.has(args[0]!.text)) addRef(`${args[0]!.text}=*`); forget(args[0]!.text); if (badEnv(args[0]!.text + "=./x")) envHit(); continue; } // for N; do: the positional parameters
    if (b === "for" && args.length >= 2 && args[1]!.text === "in") { // for N in LIST: one literal is known
      const lst = args.slice(2);
      const lit = lst.length === 1 ? expand(lst[0]!.text) : undefined;
      if (refs.has(args[0]!.text)) for (const x of lst) addRef(`${args[0]!.text}=${x.text}`); // a nameref loop variable is repointed at each word
      if (lit === undefined || aliased || st.cond || inSub || st.piped || st.pipeOut || refs.has(args[0]!.text)) forget(args[0]!.text); else { vars.set(args[0]!.text, lit); markOwn(args[0]!.text); }
      if ((lst.length ? lst : [{ text: "./x" }]).some((x) => badEnv(args[0]!.text + "=" + (expand(x.text) ?? x.text)))) envHit(); // for PATH in /usr/bin ./bin
      continue;
    }
    if (DECL.has(b)) { for (const a of args) assign(a.text, !(aliased || declMaybe || st.cond || st.pipeOut || st.piped || inSub)); if (b !== "export" && b !== "readonly" && args.some((a) => /^-[A-Za-z]*[in]/.test(a.text))) for (const a of args) if (!a.text.startsWith("-")) { const n = a.text.split("=")[0]!.replace(/\[.*$/, ""); forget(n); intVars.add(n); if (args.some((x) => /^-[A-Za-z]*n/.test(x.text))) addRef(a.text); } if (args.some((a) => !a.plain && /[\u0001$]/.test(a.text.split("=")[0]!) && !/^\$\{?npm_(?!package_)\w+\}?$/.test(a.text.split("=")[0]!))) hit("env-assign", `${b} of names or values built by an expansion (they can be NODE_OPTIONS, LD_PRELOAD ...)`); if (args.some((a) => badEnv(a.text) || BAD_NAME.test(a.text) || BAD_NAME2.test(a.text))) envHit(); continue; }
    if (b === "dd") { // dd of=FILE writes FILE
      for (const a of args) { const m = /^of=([\s\S]*)$/.exec(a.text); if (!m) continue; const e = a.plain ? m[1]! : expand(m[1]!); if (e === undefined) { if (!skipUnknown(m[1]!, b)) flags.unknownWrite = true; } else copyTargets.add(norm(e)); }
      continue;
    }
    if (COPIES.has(b)) {
      // a target held in a variable: known when the body assigned it, a write to a name it cannot tell otherwise (the last operand, or any of tee's)
      const operands = args.filter((a) => !a.text.startsWith("-"));
      let tdir0: string | undefined; // the -t directory, if any
      for (let k = 0; k < args.length; k++) {
        const t = args[k]!.text;
        if (t === "-t" || t === "--target-directory") { tdir0 = args[k + 1]?.text; k++; }
        else if (t.startsWith("--target-directory=")) tdir0 = t.slice(19);
        else if (/^-[A-Za-z]*t./.test(t) && !t.startsWith("--")) tdir0 = t.replace(/^-[A-Za-z]*?t/, "");
      }
      const hasT = tdir0 !== undefined && !skipUnknown(tdir0, undefined); // sources into a directory outside the package name nothing in it
      for (let k = 0; k < operands.length; k++) {
        const o = operands[k]!;
        if (o.plain) continue;
        if (expand(o.text) !== undefined) continue;
        if ((b === "tee" || hasT || (tdir0 === undefined && k === operands.length - 1)) && !skipUnknown(o.text, undefined)) flags.unknownWrite = true; // with -t every operand is a source: its name becomes the file's
      }
      // -t DIR, -tDIR and --target-directory[=DIR] name the directory the sources go to
      const ops: string[] = [];
      let tdir: string | undefined;
      for (let k = 0; k < args.length; k++) {
        const t = args[k]!.text;
        if (t === "-t" || t === "--target-directory") { tdir = args[k + 1]?.text; k++; }
        else if (t.startsWith("--target-directory=")) tdir = t.slice(19);
        else if (/^-[A-Za-z]*t./.test(t) && !t.startsWith("--")) tdir = t.replace(/^-[A-Za-z]*?t/, "");
        else if (!t.startsWith("-")) ops.push(args[k]!.plain ? t : (expand(t) ?? t));
      }
      if (tdir !== undefined) {
        const e = expand(tdir);
        if (e === undefined && /[$\u0001]/.test(tdir)) { if (!skipUnknown(tdir, undefined)) flags.unknownWrite = true; continue; } // an unknown directory: an unknown write
        tdir = e ?? tdir;
        const nd = norm(tdir); copyTargets.add(nd); for (const o of ops) copyTargets.add((nd ? nd + "/" : "") + BASE(o)); continue;
      }
      for (const o of ops) copyTargets.add(norm(o));
      const dest = ops[ops.length - 1];
      if (dest !== undefined && ops.length > 1) for (const o of ops.slice(0, -1)) { const nd = norm(dest); copyTargets.add((nd ? nd + "/" : "") + BASE(o)); } // cp a.js dir/ -> dir/a.js; cp a.js . -> a.js
      continue;
    }
    if (b === "eval") {
      if (args.some((a) => !a.plain)) hit("computed-command", "eval runs text built by an expansion");
      const dd = args[0]?.text === "--"; // bash's eval skips --; dash's runs a command named -- and sets nothing: either may be the shell, so the names the text names are no longer known
      const t = (dd ? args.slice(1) : args).map((a) => a.text).join(" ");
      if (t) {
        nested(t, inSub || st.cond || st.pipeOut || st.piped);
        // X=1 eval 'N=b.js': the nested walk saw copies of the maps; what it changed counts here too
        if (nestedVars !== vars) { for (const [k, v] of nestedVars) if (vars.get(k) !== v) forget(k); for (const k of [...vars.keys()]) if (!nestedVars.has(k)) forget(k); }
        if (nestedUnk !== unk) for (const k of nestedUnk) if (!unk.has(k)) forget(k);
        if (dd) for (const n of t.match(/[A-Za-z_]\w*/g) ?? []) forget(n); // after the walk, which would set them again
      }
      continue; // eval runs in this shell: its assignments count
    }
    if (b === "trap") { const code = args[0]?.text === "--" ? args[1] : args[0]; if (code && !code.text.startsWith("-")) nested(code.text); continue; } // trap 'code' EXIT runs code // eval joins its words and runs them as shell
    if (b === "cd" || b === "pushd" || b === "popd") { cwd = true; continue; }
    if (b === "make") { if (args.some((a) => badEnv(a.text))) envHit(); if (args.some((a) => /^-[A-Za-z]*f/.test(a.text) || /^--(?:file|makefile)(?:=|$)/.test(a.text))) hit("program-file", "make -f"); continue; }
    if (/^(?:awk|gawk|mawk|nawk)$/.test(b)) {
      let prog = ""; // the first operand is the program text (without -f), after the values of -F and -v
      for (let k = 0; k < args.length; k++) {
        const t = args[k]!.text;
        if (t === "--source") { prog = args[k + 1]?.text ?? ""; break; }
        if (t.startsWith("--source=")) { prog = t.slice(9); break; }
        if (t === "-F" || t === "-v" || t === "-W") { k++; continue; }
        if (t.startsWith("-")) continue;
        prog = t;
        break;
      }
      for (const m of prog.matchAll(/\bprintf?\b[^;}>]*>>?\s*"([^"]+)"/g)) copyTargets.add(norm(m[1]!)); // print > "file" writes a file
      if (args.some((a) => /^-f|^--file/.test(a.text) || /^-[iEl]$|^--(?:include|load|exec)/.test(a.text)) || /\bsystem\s*\(|\bgetline\b|\|\s*"|\|&|@include|@load/.test(prog) || /(?<!\|)\|(?!\|)\s*[A-Za-z_]/.test(prog.replace(/(^|[\s(,~!{;])\/(?:[^\/\\\n;{}"]|\\.)*\//g, "$1 "))) hit("program-file", "awk program file, include or system()");
      continue;
    }
    if (b === "sed") {
      // -i takes its suffix attached and -e its script: the letters after them are not flags (sed -ifoo, -nfoo).
      const sedFlag = (a: string, letter: string): boolean => {
        if (!a.startsWith("-") || a.startsWith("--")) return false;
        for (const c of a.slice(1)) { if (c === letter) return true; if (c === "i" || c === "e" || c === "l") return false; } // -s takes no value
        return false;
      };
      const inplace = args.some((a) => sedFlag(a.text, "i") || /^--in-place/.test(a.text));
      if (inplace) { // sed -i rewrites the files it names; they are then run like a written file
        const files = args.filter((a) => !a.text.startsWith("-")).map((a) => a.text);
        const viaFlag = args.some((a) => sedFlag(a.text, "e") || sedFlag(a.text, "f") || /^--(?:expression|file)/.test(a.text));
        for (const f of viaFlag ? files : files.slice(1)) copyTargets.add(norm(f));
      }
      if (args.some((a) => sedFlag(a.text, "f") || /^--file/.test(a.text))) hit("program-file", "sed -f");
      else {
        const scripts: string[] = [];
        for (let k = 0; k < args.length; k++) {
          const t = args[k]!.text;
          if (/^-[A-Za-z]*e$/.test(t) || t === "--expression") { if (args[k + 1]) scripts.push(args[k + 1]!.text); k++; }
          else if (/^-[A-Za-z]*e./.test(t) && !t.startsWith("--")) scripts.push(t.replace(/^-[A-Za-z]*?e/, ""));
          else if (t.startsWith("--expression=")) scripts.push(t.slice(13));
          else if (!t.startsWith("-") && scripts.length === 0) scripts.push(t); // the first operand is the script (the rest are files)
        }
        for (const sc of scripts) for (const f of sedWrites(sc)) copyTargets.add(norm(f));
        if (scripts.some(sedExecs)) hit("program-file", "sed e command or s///e");
      }
      continue;
    }
    if (b === "curl" || b === "wget") {
      const urlName = (u: string) => u.replace(/[?#].*$/, "").replace(/\/+$/, "").replace(/^.*\//, "");
      let named = false; // an output name was given
      let prefix = ""; // wget -P dir, curl --output-dir dir
      const urls: string[] = [];
      for (let k = 0; k < args.length; k++) {
        const t = args[k]!.text;
        const out = (v: string | undefined) => { if (v) { copyTargets.add((prefix ? norm(prefix) + "/" : "") + norm(v)); named = true; } };
        if (b === "curl" ? /^--output$|^-[A-Za-z]*o$/.test(t) : /^--output-document$|^-[A-Za-z]*O$/.test(t)) { out(args[k + 1]?.text); k++; }
        else if (b === "curl" && (t === "--output-dir")) { prefix = args[k + 1]?.text ?? ""; k++; }
        else if (b === "curl" && t.startsWith("--output-dir=")) prefix = t.slice(13);
        else if (b === "curl" && (/^-[A-Za-z]*J[A-Za-z]*$/.test(t) || t === "--remote-header-name")) hit("writer-exec", "curl -J: the server picks the file name");
        else if (b === "curl" && /^--output=./.test(t)) out(t.slice(9));
        else if (b === "curl" && /^-[A-Za-z]*o./.test(t) && !/^--/.test(t)) out(t.replace(/^-[A-Za-z]*?o/, ""));
        else if (b === "wget" && /^--output-document=./.test(t)) out(t.slice(18));
        else if (b === "wget" && /^-[A-Za-z]*O./.test(t)) out(t.replace(/^-[A-Za-z]*?O/, ""));
        else if (b === "wget" && (t === "-P" || t === "--directory-prefix")) { prefix = args[k + 1]?.text ?? ""; k++; }
        else if (b === "wget" && /^-P./.test(t)) prefix = t.slice(2);
        else if (b === "wget" && t.startsWith("--directory-prefix=")) prefix = t.slice(19);
        else if (b === "curl" && (/^-[A-Za-z]*O[A-Za-z]*$/.test(t) || t === "--remote-name")) named = false, urls.push("\0remote");
        else if (!t.startsWith("-") && /\//.test(t)) urls.push(t);
      }
      // `curl -O URL` and `wget URL` write the file named by the URL
      if (!named && (b === "wget" || urls.includes("\0remote"))) for (const u of urls) if (u !== "\0remote" && urlName(u)) copyTargets.add((prefix ? norm(prefix) + "/" : "") + urlName(u));
      continue;
    }
    if (b === "source" || b === ".") { if (args[0] && !args[0].plain) hit("computed-command", "a sourced file named by an expansion"); if (args[0]?.plain && STDIN_PATH.test(args[0].text)) { stdin(b); continue; } if (args[0]?.plain) { if ((cwd || stageCwd) && !args[0].text.startsWith("/")) hit("cd-relative", "sourced file after cd"); ranWritten(args[0].text); } continue; }
    if (SHELL.test(b)) {
      const rest: Word[] = [];
      let code: Word | undefined; let wantCode = false; let stdinFlag = false; let noProgram = false;
      for (let k = 0; k < args.length; k++) {
        const a = args[k]!;
        const t = a.text;
        if (t === "--") continue;
        if (/^[-+][A-Za-z]*[oO]$/.test(t)) { if (t.startsWith("-") && t.includes("c")) wantCode = true; k++; continue; } // -o NAME, -euo NAME, +O NAME; -co NAME 'code' 
        if (/^--(?:rcfile|init-file)$/.test(t)) { hit("interp-flag", `${b} ${t}`); k++; continue; }
        if (/^--(?:version|help)$/.test(t)) { noProgram = true; continue; } // bash --version (-v and -h are verbose and hashall)
        if (/^-[A-Za-z]*s[A-Za-z]*$/.test(t) && !wantCode && !t.includes("c")) { stdinFlag = true; continue; }
        if (/^-[A-Za-z]+$/.test(t) && t.includes("c")) { wantCode = true; continue; } // -c, -ec, -xc, -lc
        if (t.startsWith("-") || t.startsWith("+")) { if (!a.plain) hit("interp-flag", `${b} flag is escaped or expanded`); continue; }
        if (wantCode) { code = a; break; }
        rest.push(a); break; // the first operand is the script; what follows is its arguments
      }
      if (wantCode) { if (code) { if (code.text.includes("\u0001") || /^\$/.test(code.text)) hit("computed-command", `${b} -c code built by an expansion`); walk(code.text, depth + 1, hits, { cwd: cwd || stageCwd, written: copyTargets, vars: code.plain ? new Map() : nestedVars, aliases: new Map(), flags, fns: fnVars, fn: curFn, unk: code.plain ? new Set([...nestedVars.keys(), ...nestedUnk]) : nestedUnk, sub: true }); } continue; } // a double-quoted string with $ or \\ is walked as written; a new shell has no aliases
      if (noProgram && rest.length === 0) continue;
      if (viaXargs && rest.length === 0 && !wantCode) { hit("interp-stdin", `xargs ${b}: the script comes from stdin`); continue; }
      if (rest.length === 0 || stdinFlag) { stdin(b); continue; }
      const f = rest[0]!;
      if (viaXargs && f.text.includes(xargsRepl)) { hit("interp-stdin", `xargs ${b} ${xargsRepl}: the script comes from stdin`); continue; }
      const f2 = scriptWord(f);
      if (!f2) { if (flags.wild && copyTargets.size > 0) hit("writer-exec", `runs a file named by an expansion after a nameref write the body cannot name`); continue; }
      if (STDIN_PATH.test(f2.text)) { stdin(b); continue; }
      if (FD_PATH.test(f2.text)) { hit("interp-stdin", `${b} reads its program from a file descriptor`); continue; }
      if (f2.text.startsWith("/")) { ranWritten(f2.text); continue; }
      if (cwd || stageCwd) hit("cd-relative", `${b} file after cd`);
      ranWritten(f2.text);
      continue;
    }
    if (b === "bun") { // config, working directory and preload flags: before the subcommand or script
      for (let k = 0; k < args.length && args[k]!.text.startsWith("-"); k++) {
        if (/^(?:-c|--config|--cwd|--tsconfig-override|--preload|--import|--require|-r|--env-file)(?:=|$)/.test(args[k]!.text)) { hit("interp-flag", `bun ${args[k]!.text}`); if (!args[k]!.text.includes("=")) k++; }
      }
      if (args[0]?.text === "run") { for (let k = 1; k < args.length && args[k]!.text.startsWith("-"); k++) if (/^(?:--preload|--import|--require|-r|--env-file|--config|-c|--cwd)(?:=|$)/.test(args[k]!.text)) { hit("interp-flag", `bun run ${args[k]!.text}`); k++; } }
      if (args[0]?.text === "run") { // bun run FILE runs a file (a name without a dot or slash is a package script)
        let tgt: Word | undefined;
        for (let k = 1; k < args.length; k++) {
          const t = args[k]!.text;
          if (/^--?(?:preload|import|require|r)(?:=|$)|^--(?:config|env-file|tsconfig-override)(?:=|$)|^-c(?:=|$)/.test(t)) { hit("interp-flag", `bun run ${t}`); if (!t.includes("=")) k++; continue; } // loads code
          if (/^(?:--cwd|--filter|--shell|--elide-lines)$/.test(t)) { k++; continue; } // takes a value
          if (!t.startsWith("-")) { tgt = args[k]; break; }
        }
        if (tgt) {
          const t2 = scriptWord(tgt);
          if (t2 && (t2.text.includes("/") || /\.(?:[cm]?[jt]sx?|json|sh)$/.test(t2.text))) { if (!t2.text.startsWith("/") && (cwd || stageCwd)) hit("cd-relative", "bun run file after cd"); ranWritten(t2.text); }
        }
      }
    }
    if (INTERP.test(b) && !(b === "bun" && args[0] && /^(?:run|x|install|i|add|remove|create|exec|link|update|pm|test|build|dev|repl|init)$/.test(args[0].text))) {
      const kind = b.replace(/[\d.]+$/, "").replace(/^nodejs$/, "node").replace(/^bun$/, "node");
      const loads = LOADS[kind];
      const valued = VALUED[kind] ?? [];
      let file: Word | undefined; let inline = false; let noProgram = false;
      // -i, as a letter of a cluster before any flag that takes its value attached (ruby -Ilib is not -i)
      const inplaceFlag = (a: string): boolean => {
        if (!a.startsWith("-") || a.startsWith("--")) return false;
        for (const c of a.slice(1)) { if (c === "i") return true; if ("IrCEFKTxXWMme".includes(c)) return false; }
        return false;
      };
      const inplace = (kind === "perl" || kind === "ruby") && args.some((a) => inplaceFlag(a.text));
      let rest = args;
      if (kind === "deno") {
        // flags before the subcommand (deno --preload ./e.ts a.ts) load code too
        for (let k = 0; k < rest.length && rest[k]!.text.startsWith("-"); k++) if (loads?.test(rest[k]!.text)) { hit("interp-flag", `deno ${rest[k]!.text}`); if (VALUE_AFTER.has(rest[k]!.text)) k++; }
        let q = 0; while (q < rest.length && rest[q]!.text.startsWith("-")) q++; // global flags (deno -q run a.ts)
        const sub2 = rest[q]?.text;
        if (!sub2 || !/^(?:run|test|bench|serve)$/.test(sub2)) continue; // eval, repl, task, install ...: not a script run
        rest = rest.slice(q + 1);
      }
      for (let k = 0; k < rest.length; k++) {
        let a = rest[k]!;
        if (!a.plain) { const e = expand(a.text); if (e !== undefined && e.startsWith("-") && !/\s/.test(e)) { hit("interp-flag", `${b} a flag held in a variable`); a = { text: e, plain: true }; } } // a variable that holds a flag is that flag
        if (a.text === "-") { stdin(b); inline = true; break; }
        if (a.text.startsWith("-")) {
          if (!a.plain) { hit("interp-flag", `${b} flag is escaped or expanded`); continue; }
          if (braceTest(BRACE_WORD, a.text)) { hit("interp-flag", `${b} a brace expansion can produce flags`); noProgram = true; continue; }
          if (kind === "ruby" && /^-[CX]/.test(a.text)) stageCwd = true; // ruby -C dir / -X dir (attached or not) runs the script from there
          if (kind === "ruby" && /^-x./.test(a.text)) stageCwd = true; // -xdir: the same, after the leading text is skipped
          if (kind === "php" && a.text === "-f" && rest[k + 1]) { file = rest[k + 1]; break; } // php -f file: the script
          if (kind === "php" && a.text === "-d" && rest[k + 1] && PHP_INI.test(rest[k + 1]!.text)) { hit("interp-flag", "php -d " + rest[k + 1]!.text.split("=")[0]); k++; continue; }
          if (kind === "ruby" ? rubyLoads(a.text) : loads?.test(a.text)) {
            hit("interp-flag", `${b} ${a.text}`);
            if (kind === "python" || a.text === "--run" || a.text === "--test") { noProgram = true; break; } // -m MODULE: what follows is the module's
            if (VALUE_AFTER.has(a.text)) k++;
            continue;
          }
          if (isInline(kind, a.text)) { // inline code is read by the existing scan; later flags still load code (node -e 1 -r x, perl -e 1 -MX)
            inline = true;
            if (kind === "python") break; // after python -c CODE the rest is sys.argv
            if (!a.text.includes("=") && rest[k + 1] && !rest[k + 1]!.text.startsWith("-")) k++; // --eval=CODE carries its code
            continue;
          }
          if ((NO_PROGRAM.test(a.text) && !(kind === "python" && a.text === "-v")) || (kind === "php" && NO_PROGRAM_PHP.test(a.text))) noProgram = true;
          else if (valued.includes(a.text) || (kind === "node" && /^--max-[a-z-]+$/.test(a.text))) k++;
          else if (kind === "node" && a.text.startsWith("--") && !NODE_BOOL.test(a.text) && !a.text.includes("=") && rest[k + 1] && !rest[k + 1]!.text.startsWith("-") && k + 2 < rest.length && !rest.some((x) => isInline("node", x.text)) && !/\.(?:[cm]?[jt]s|json)$|\//.test(rest[k + 1]!.text)) {
            // An option this does not know, followed by a word that is not a script and another word: the first may take the second as its value, and which one is the script is unknown.
            hit("interp-flag", `${b} ${a.text} with a value this does not know`);
          }
          continue;
        }
        if (inline) { // the words after inline code are its arguments (the files, for perl -pi / ruby -i)
          if (inplace) for (const f of rest.slice(k)) if (!f.text.startsWith("-")) copyTargets.add(norm(f.text));
          break;
        }
        if (!a.plain && multiTest(a.text) && !/^["']?\$\{?npm_/.test(a.text)) { hit("interp-flag", `${b} an expansion that can hold several words, flags among them`); noProgram = true; continue; }
        if (!a.plain) { const e = expand(a.text); if (e !== undefined && /\s/.test(e)) { hit("interp-flag", `${b} a variable that holds several words`); noProgram = true; continue; } }
        if (a.plain && braceTest(BRACE_WORD, a.text)) { hit("interp-flag", `${b} a brace expansion can produce flags`); noProgram = true; continue; }
        if (!a.plain && k < rest.length - 1 && expand(a.text) === undefined) { hit("interp-flag", `${b} an expanded word before the script (it can hold flags)`); continue; }
        file = a; break;
      }
      if (inline) continue;
      if (!file) { if (viaXargs && !noProgram) hit("interp-stdin", `xargs ${b}: the script comes from stdin`); else if (!noProgram) stdin(b); continue; }
      if (viaXargs && file.text.includes(xargsRepl)) { hit("interp-stdin", `xargs ${b} ${xargsRepl}: the script comes from stdin`); continue; }
      const file2 = scriptWord(file);
      if (!file2) { if (flags.wild && copyTargets.size > 0) hit("writer-exec", `runs a file named by an expansion after a nameref write the body cannot name`); continue; }
      if (STDIN_PATH.test(file2.text)) { stdin(b); continue; } // node /dev/stdin reads the program from stdin
      if (FD_PATH.test(file2.text)) { hit("interp-stdin", `${b} reads its program from a file descriptor`); continue; }
      if (file2.text.startsWith("/")) { ranWritten(file2.text); continue; }
      if (cwd || stageCwd) hit("cd-relative", `${b} script after cd`);
      ranWritten(file2.text);
      continue;
    }
    if (head.text.includes("/") && !PM.test(b)) {
      if (head.text.startsWith("/") || (head.text.startsWith("../") && !(cwd || stageCwd))) continue; // after a cd, ../x is not the package's
      if (cwd || stageCwd) hit("cd-relative", "path command after cd");
      ranWritten(head.text);
    }
  }
  for (const t of later) copyTargets.add(t.replace(/^\.\//, "")); // a subshell's last redirect is on disk for what follows
}
