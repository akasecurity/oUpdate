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

interface Word { text: string; plain: boolean } // plain: no $ or backtick expansion (a backslash only quotes)
interface Stage { words: Word[]; assigns: string[]; writes: string[]; reads: string[]; subs: string[]; hereSubs: string[]; heredoc: boolean; piped: boolean }

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
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (c === "(") d++;
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
  const fresh = (): Stage => ({ words: [], assigns: [], writes: [], reads: [], subs: [], hereSubs: [], heredoc: false, piped: false });
  let st: Stage = fresh();
  let cur: Word | undefined;
  const pendingHere: { delim: string; strip: boolean; active: boolean; st: Stage }[] = [];
  let casePat = false; // the words up to the next ) are a case pattern, not a command
  const endWord = () => {
    if (!cur) return;
    const w = cur; cur = undefined;
    if (st.words.length === 0 && /^[A-Za-z_][A-Za-z0-9_]*\+?=/.test(w.text)) { st.assigns.push(w.text); return; }
    if (st.words.length === 0 && KW_SKIP.has(w.text) && w.plain) return;
    st.words.push(w);
    if (w.plain && w.text === "in" && st.words[0]?.text === "case") casePat = true;
    if (w.plain && w.text === "esac") casePat = false;
  };
  const endStage = () => {
    endWord();
    const empty = !(st.words.length || st.assigns.length || st.writes.length || st.reads.length || st.subs.length || st.heredoc);
    if (!empty) stages.push(st);
    const keepPipe = empty && st.piped; // `a |` then a newline: the next stage is still piped
    st = fresh(); st.piped = keepPipe;
  };
  const add = (c: string, plain = true) => { cur ??= { text: "", plain: true }; cur.text += c; if (!plain) cur.plain = false; };
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
  const spend0 = () => { if (--FUEL < 0) fail("parse budget used up", "unparsed"); };
  let wordSubs: string[] = []; // command substitutions inside the word readWordAt just read (a redirect target, a delimiter)
  const readWordAt = (i: number): { w: Word; next: number } => {
    wordSubs = [];
    while (text[i] === " " || text[i] === "\t") i++;
    let t = ""; let plain = true;
    for (; i < text.length; i++) {
      if (--FUEL < 0) fail("parse budget used up", "unparsed");
      const c = text[i]!;
      if (isBreak(c)) break;
      if (c === "'") { const e = text.indexOf("'", i + 1); if (e < 0) fail("quote"); t += text.slice(i + 1, e); i = e; continue; }
      if (c === '"') {
        let e = i + 1;
        for (; e < text.length && text[e] !== '"'; e++) {
          if (--FUEL < 0) fail("parse budget used up", "unparsed");
          const d = text[e]!;
          if (d === "\\") { // in double quotes a backslash escapes only $ ` " \ and a newline
            const n = text[e + 1] ?? "";
            if (n === "\n") { e++; continue; }
            t += /[$`"\\]/.test(n) ? n : "\\" + n; e++; plain = plain && !/[$`]/.test(n); continue;
          }
          if (d === "$" && text[e + 1] === "(") { const k = matchClose(e + 2, "(", ")"); wordSubs.push(text.slice(e + 2, k)); plain = false; e = k; continue; }
          if (d === "`") { const b = backtickSpan(text, e); wordSubs.push(b.inner); plain = false; e = b.end; continue; }
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
        t += text.slice(i + 2, j); plain = false; i = j; continue;
      }
      if (c === "\\") { t += text[i + 1] ?? ""; i++; continue; }
      if (c === "$" && text[i + 1] === "(") { const e = matchClose(i + 2, "(", ")"); wordSubs.push(text.slice(i + 2, e)); plain = false; i = e; continue; }
      if (c === "$" && text[i + 1] === "{") { const e = matchClose(i + 2, "{", "}"); const inner = text.slice(i + 2, e); if (/\$\(|`/.test(inner)) wordSubs.push(inner); t += "${" + inner + "}"; plain = false; i = e; continue; }
      if (c === "`") { const b = backtickSpan(text, i); wordSubs.push(b.inner); plain = false; i = b.end; continue; }
      if (c === "$") plain = false;
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
      add(text[i + 1]!); i++; continue;
    }
    if (c === "'") { const e = text.indexOf("'", i + 1); if (e < 0) fail("quote"); cur ??= { text: "", plain: true }; cur.text += text.slice(i + 1, e); i = e; continue; }
    if (c === '"') {
      cur ??= { text: "", plain: true };
      let j = i + 1;
      for (; j < text.length && text[j] !== '"'; j++) {
        if (--FUEL < 0) fail("parse budget used up", "unparsed");
        if (text[j] === "\\") { const n = text[j + 1] ?? ""; if (n !== "\n") cur.text += /[$`"\\]/.test(n) ? n : "\\" + n; j++; continue; } // only $ ` " \ and a newline are escaped
        if (text[j] === "$" && text[j + 1] === "(") { const e = matchClose(j + 2, "(", ")"); st.subs.push(text.slice(j + 2, e)); cur.text += "\u0001"; cur.plain = false; j = e; continue; }
        if (text[j] === "`") { const b = backtickSpan(text, j); st.subs.push(b.inner); cur.text += "\u0001"; cur.plain = false; j = b.end; continue; }
        if (text[j] === "$") cur.plain = false;
        cur.text += text[j];
      }
      if (j >= text.length) fail("quote");
      i = j; continue;
    }
    if (c === "`") { const b = backtickSpan(text, i); st.subs.push(b.inner); add("\u0001", false); i = b.end; continue; }
    if (c === "$") {
      if (text[i + 1] === "(") {
        const dbl = text[i + 2] === "(";
        const e = matchClose(i + 2, "(", ")");
        const inner = text.slice(i + 2, e);
        if (!dbl) st.subs.push(inner);
        else if (!wrapsAll(inner)) st.subs.push(inner); // `$( (a) && (b) )`: two subshells in a substitution, not arithmetic
        else { const a = inner.slice(1, -1); const found = extractSubs(a, spend0); st.subs.push(...found); if (!found.length && COMMANDISH.test(a.slice(0, 400))) st.subs.push(a); }
        add("\u0001", false); i = e; continue; // the substitution's value is unknown
      }
      if (text[i + 1] === "[") { const e = matchClose(i + 2, "[", "]"); st.subs.push(...extractSubs(text.slice(i + 2, e), spend0)); add("", false); i = e; continue; }
      if (text[i + 1] === "{") { const e = matchClose(i + 2, "{", "}"); const inner = text.slice(i + 2, e); if (/\$\(|`/.test(inner)) st.subs.push(inner); add("${" + inner + "}", false); i = e; continue; }
      if (text[i + 1] === "'") {
        // ANSI-C quoting: a quoted word whose escapes the scan does not decode, so it is not plain.
        let j = i + 2;
        for (; j < text.length && text[j] !== "'"; j++) { if (--FUEL < 0) fail("parse budget used up", "unparsed"); if (text[j] === "\\") j++; }
        if (j >= text.length) fail("quote");
        add(text.slice(i + 2, j), false); i = j; continue;
      }
      add("$", false); continue;
    }
    if ((c === "<" || c === ">") && text[i + 1] === "(") { const e = matchClose(i + 2, "(", ")"); st.subs.push(text.slice(i + 2, e)); add("", false); i = e; continue; }
    if (c === "[" && text[i + 1] === "[" && !cur && st.words.every((w) => w.plain && (w.text === "time" || w.text === "!" || w.text === "-p")) && (text[i + 2] === " " || text[i + 2] === "\t")) {
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
      st.words.push({ text: "[[", plain: true }); i = e + 1; continue;
    }
    if (c === "(") {
      if (cur && !st.words.length && text[i + 1] === "(" && /^(?:for|select|if|while|until|elif)$/.test(cur.text)) { cur = undefined; st.words = [{ text: "for", plain: true }]; } // for((i=0;i<n;i++)): no space
      if (!cur && text[i + 1] === "(" && st.words.length === 1 && st.words[0]!.plain && /^(?:for|select)$/.test(st.words[0]!.text)) { // for ((i=0;i<n;i++))
        const e = matchClose(i + 1, "(", ")");
        const found = extractSubs(text.slice(i + 2, e - 1), spend0); st.subs.push(...found);
        st.words = []; i = e; continue;
      }
      if (!cur && st.words.length && st.words[st.words.length - 1]!.text === "in") { endStage(); i = matchClose(i + 1, "(", ")"); continue; } // case (pattern)
      if (cur && /^[@?*+!]$/.test(cur.text.slice(-1))) { // extglob @(a|b) in a word or a case pattern
        const e = matchClose(i + 1, "(", ")");
        cur.text += text.slice(i, e + 1); cur.plain = false; i = e; continue;
      }
      if (cur && (!st.words.length || DECL.has(st.words[0]!.text)) && /^[A-Za-z_][A-Za-z0-9_]*\+?=$/.test(cur.text)) { // arr=(a b $(cmd)), declare -a arr=(..)
        const e = matchClose(i + 1, "(", ")");
        for (const sub of extractSubs(text.slice(i + 1, e), () => { if (--FUEL < 0) fail("parse budget used up", "unparsed"); })) st.subs.push(sub);
        cur.text += "(" + text.slice(i + 1, e) + ")"; cur.plain = false; i = e; continue;
      }
      if (cur || st.words.length) {
        // `name() { ... }` defines a function: drop the name, the body is read as the stages that follow.
        let j = i + 1; while (text[j] === " " || text[j] === "\t") j++;
        const n = st.words.length + (cur ? 1 : 0);
        if (text[j] === ")" && (n === 1 || (n === 2 && st.words[0]?.text === "function"))) { cur = undefined; st.words = []; i = j; continue; }
        fail("paren inside a word"); // a shell syntax error, and the JSON-escaped quotes of binding.gyp bodies
      }
      const e = matchClose(i + 1, "(", ")");
      const inner = text.slice(i + 1, e);
      // `((expr))` is arithmetic: only a $(..) or backtick inside it runs anything
      if (wrapsAll(inner)) { const a = inner.slice(1, -1); const found = extractSubs(a, spend0); st.subs.push(...found); if (!found.length && COMMANDISH.test(a.slice(0, 400))) st.subs.push(a); }
      else st.subs.push(inner);
      i = e; continue;
    }
    if (c === ")") { // a case pattern `x)` ends the pattern: its words are not a command
      if (casePat) { cur = undefined; st = fresh(); casePat = false; continue; }
      endStage(); continue;
    }
    if (c === "<" && text[i + 1] === "<" && text[i + 2] !== "<") {
      endWord();
      let j = i + 2; const strip = text[j] === "-"; if (strip) j++;
      const { w, next } = readWordAt(j);
      if (!w.text) fail("heredoc delimiter", "heredoc");
      const raw = text.slice(j, next).trim();
      st.heredoc = true;
      pendingHere.push({ delim: w.text, strip, active: !/['"\\]/.test(raw), st });
      i = next - 1; continue;
    }
    if (c === "<" && text[i + 1] === "<" && text[i + 2] === "<") { endWord(); const { next } = readWordAt(i + 3); st.subs.push(...wordSubs); st.heredoc = true; st.reads.push("<<<"); i = next - 1; continue; }
    if (c === ">" || c === "<") {
      if (cur && /^[0-9]+$/.test(cur.text) && cur.plain) cur = undefined; else endWord(); // 2>x, 10>x
      let j = i + 1; let op = c;
      if (text[j] === ">" || text[j] === "|" || text[j] === "&") { op += text[j]; j++; }
      if (op === ">&" || op === "<&") { const { w, next } = readWordAt(j); st.subs.push(...wordSubs); if (!/^[0-9-]+$/.test(w.text)) st.writes.push(w.text); i = next - 1; continue; }
      let q = j; while (text[q] === " " || text[q] === "\t") q++;
      if ((text[q] === "<" || text[q] === ">") && text[q + 1] === "(") { // `< <(cmd)`, `> >(cmd)`
        const e = matchClose(q + 2, "(", ")"); st.subs.push(text.slice(q + 2, e)); i = e; continue;
      }
      const { w, next } = readWordAt(j);
      st.subs.push(...wordSubs);
      if (!w.text && wordSubs.length === 0) fail("redirect target", "unparsed");
      if (c === ">") { if (w.text && w.text !== "/dev/null" && w.plain) st.writes.push(w.text); } else st.reads.push(w.text);
      i = next - 1; continue;
    }
    if (c === "&" && text[i + 1] === ">") { endWord(); const { w, next } = readWordAt(text[i + 2] === ">" ? i + 3 : i + 2); st.subs.push(...wordSubs); if (!w.text && wordSubs.length === 0) fail("redirect target", "unparsed"); if (w.text !== "/dev/null" && w.plain) st.writes.push(w.text); i = next - 1; continue; }
    if (c === "|" && casePat) { cur = undefined; continue; } // a|b) separates case patterns
    if (c === "|" && text[i + 1] !== "|") { endStage(); st.piped = true; if (text[i + 1] === "&") i++; continue; }
    if (c === "|" || c === "&" || c === ";") { endStage(); if (text[i + 1] === c) i++; if (c === ";" && text[i] === ";") casePat = true; continue; }
    if (c === "\n") {
      endStage();
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
const INLINE = /^(?:-p|-pe|-c|-r|-pi|--eval|--print)$|^-[A-Za-z]*[ec]$/; // -e, -le, -we, -Bc ...
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
const NO_PROGRAM = /^(?:-v|-V|-VV|--version|-h|--help|--v8-options|--check|-\?)$/;
const NO_PROGRAM_PHP = /^(?:-m|-i|--modules|--info|--ini)$/; // php -m lists modules, php -i prints the configuration
const BAD_ENV = /^(?:NODE_OPTIONS|NODE_PATH|NODE_EXTRA_CA_CERTS|BASH_ENV|PERL5OPT|PERL5LIB|RUBYOPT|RUBYLIB|PYTHONPATH|PYTHONSTARTUP|PYTHONHOME|LD_PRELOAD|LD_LIBRARY_PATH|DYLD_INSERT_LIBRARIES|DYLD_LIBRARY_PATH|OPENSSL_CONF|OPENSSL_MODULES|PHP_INI_SCAN_DIR|PHPRC|GCONV_PATH|LD_AUDIT|npm_config_\w+)\+?=/i;
const BAD_NAME = new RegExp(BAD_ENV.source.replace(/\\\+\?=$/, "$"), "i");
// More loaders: shell startup files, Lua and Perl library paths, the prompt string (run by `sh -x`), and a PATH or
// HOME with an entry that is not absolute and comes before the system ones (it points inside the package or at the working directory).
const BAD_ENV2 = /^(?:ZDOTDIR|ENV|LUA_INIT\w*|LUA_PATH|LUA_CPATH|PERLLIB|PS4|PROMPT_COMMAND|SHELLOPTS|BASH_XTRACEFD|MAKEFILES|BASH_FUNC_[^=]*)\+?=/;
const TOOL_VAR = /^(?:PYTHON|CC|CXX|CPP|LD|AR|MAKE|SHELL)=(.*)$/; // a compiler, interpreter or shell named by a relative path runs from the package
function badEnv(t: string): boolean {
  if (BAD_ENV.test(t) || BAD_ENV2.test(t)) return true;
  const tv = TOOL_VAR.exec(t);
  if (tv) return /\//.test(tv[1]!) && (!/^[/~]/.test(tv[1]!) && !/^\$(?!\{?PWD\b)/.test(tv[1]!) || /^\$\{?PWD\b/.test(tv[1]!) || tv[1]!.startsWith("\u0001")); // $PWD and a substitution are inside the package or unknown
  const m = /^(PATH|HOME)\+?=([\s\S]*)$/.exec(t);
  if (!m) return false;
  let es = m[2]!.split(":");
  if (m[1] === "PATH") { const k = es.findIndex((e) => /^\$\{?PATH\}?$/.test(e)); if (k >= 0) es = es.slice(0, k); } // appended entries come after the system ones
  return es.some((e) => !/^[/~]|^\$\{?(?:PATH|HOME)\}?(?:\/|$)/.test(e)); // $PWD or a substitution is not known to be absolute
}
const DECL = new Set(["export", "declare", "typeset", "readonly", "local"]);
const BASE = (w: string) => w.replace(/^.*\//, "");
const norm = (f: string) => {
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
interface State { cwd: boolean; written: Set<string> }

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

function walk(text: string, depth: number, hits: Hit[], parent: State): void {
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
  const nested = (t: string) => walk(t, depth + 1, hits, { cwd, written: copyTargets });
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
  const aliases = new Map<string, string>();
  for (const st of stages) {
    // A redirect empties its target before the command runs, so a stage does not run its own output file.
    for (const t of later) copyTargets.add(t);
    later = st.writes;
    for (const s of st.subs) nested(s);
    for (const s of st.hereSubs) nested(s);
    if (st.assigns.some((a) => badEnv(a))) envHit();
    let w = st.words;
    // `function name {` and a leading `{` open a body that the next words continue.
    while (w.length && ((w[0]!.plain && w[0]!.text === "function") || w[0]!.text === "{" || w[0]!.text === "!")) {
      w = w[0]!.text === "function" ? w.slice(Math.min(2, w.length)) : w.slice(1);
    }
    let lookup = false;
    let viaXargs = false;
    for (let n = 0; w.length; n++) {
      const spec = WRAP[BASE(w[0]!.text)];
      if (!spec || !w[0]!.plain || (w[0]!.text.includes("/") && !w[0]!.text.startsWith("/"))) break; // ./timeout is a file of the package, not the wrapper
      if (w[0]!.text.includes("/") && !w[0]!.text.startsWith("/") && written(w[0]!.text)) hit("writer-exec", `runs ${w[0]!.text}, written or copied by this body`);
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
        if (name === "env" && (t === "-C" || t === "--chdir" || t.startsWith("--chdir="))) cwd = true;
        if (spec.val.includes(t)) k++;
        else if (name === "env" && t.startsWith("-S") && t.length > 2) nested(t.slice(2));
        else if (name === "env" && t.startsWith("-C") && t.length > 2) cwd = true;
      }
      if (spec.dur && k < w.length) k++;
      w = w.slice(k);
      while (w.length && (w[0]!.text === "{" || w[0]!.text === "!")) w = w.slice(1); // time { cmd; }
      if (name === "xargs") viaXargs = true;
    }
    while (w.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(w[0]!.text)) { if (badEnv(w[0]!.text)) envHit(); w = w.slice(1); } // env -- NAME=v cmd: the assignment after -- is the first word
    if (lookup || !w.length) continue;
    const head = w[0]!;
    if (!head.plain) {
      // npm's own variables are resolved by the existing scan ($npm_execpath is the npm runner, ${npm_package_config_x} is a value of the manifest)
      if (!/^\$\{?(?:npm_execpath|npm_node_execpath|npm_package_config_\w+)\}?$/.test(head.text)) hit("computed-command", "the command word is an expansion (a variable, a substitution)");
      continue;
    } // it can name any interpreter
    const b = BASE(head.text);
    const args = w.slice(1);
    // dash (and any POSIX sh) expands an alias defined earlier in the script: its text is read as the command
    if (b === "alias") { for (const a of args) { const m = /^([A-Za-z_][\w.-]*)=([\s\S]*)$/.exec(a.text); if (m && a.plain) aliases.set(m[1]!, m[2]!); } continue; }
    const al = aliases.get(b);
    if (al !== undefined && head.plain) { nested(al + " " + args.map((a) => a.text).join(" ")); continue; }
    const stdin = (what: string) => { if (st.reads.length && !st.heredoc && st.reads.every((r) => r === "/dev/null")) return; if (!st.piped || st.heredoc || st.reads.length) hit(st.heredoc ? "heredoc" : "interp-stdin", `${what} reads its program from stdin`); };
    const ranWritten = (f: string) => { if (written(f)) hit("writer-exec", `runs ${f}, written or copied by this body`); };
    if (head.text.includes("/")) ranWritten(head.text); // ./node, ./sh, /tmp/x: a command this body wrote
    if (DECL.has(b)) { if (args.some((a) => badEnv(a.text) || BAD_NAME.test(a.text))) envHit(); continue; }
    if (COPIES.has(b)) {
      const ops = args.filter((a) => !a.text.startsWith("-")).map((a) => a.text);
      for (const o of ops) copyTargets.add(norm(o));
      const dest = ops[ops.length - 1];
      if (dest !== undefined && ops.length > 1) for (const o of ops.slice(0, -1)) { const nd = norm(dest); copyTargets.add((nd ? nd + "/" : "") + BASE(o)); } // cp a.js dir/ -> dir/a.js; cp a.js . -> a.js
      continue;
    }
    if (b === "eval") {
      if (args.some((a) => !a.plain)) hit("computed-command", "eval runs text built by an expansion");
      const t = args.map((a) => a.text).join(" "); if (t) nested(t); continue;
    }
    if (b === "trap") { if (args[0] && !args[0].text.startsWith("-")) nested(args[0].text); continue; } // trap 'code' EXIT runs code // eval joins its words and runs them as shell
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
      if (args.some((a) => /^-f|^--file/.test(a.text) || /^-[iEl]$|^--(?:include|load|exec)/.test(a.text)) || /\bsystem\s*\(|\bgetline\b|\|\s*"|\|&|@include|@load/.test(prog)) hit("program-file", "awk program file, include or system()");
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
      let prefix = ""; // wget -P dir
      const urls: string[] = [];
      for (let k = 0; k < args.length; k++) {
        const t = args[k]!.text;
        const out = (v: string | undefined) => { if (v) { copyTargets.add(norm(v)); named = true; } };
        if (b === "curl" ? /^--output$|^-[A-Za-z]*o$/.test(t) : /^--output-document$|^-[A-Za-z]*O$/.test(t)) { out(args[k + 1]?.text); k++; }
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
    if (b === "source" || b === ".") { if (args[0] && !args[0].plain) hit("computed-command", "a sourced file named by an expansion"); if (args[0]?.plain) { if (cwd && !args[0].text.startsWith("/")) hit("cd-relative", "sourced file after cd"); ranWritten(args[0].text); } continue; }
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
      if (wantCode) { if (code) { if (code.text.includes("\u0001") || /^\$/.test(code.text)) hit("computed-command", `${b} -c code built by an expansion`); nested(code.text); } continue; } // a double-quoted string with $ or \\ is walked as written
      if (noProgram && rest.length === 0) continue;
      if (rest.length === 0 || stdinFlag) { stdin(b); continue; }
      const f = rest[0]!;
      if (!f.plain) continue;
      if (f.text.startsWith("/")) { ranWritten(f.text); continue; }
      if (cwd) hit("cd-relative", `${b} file after cd`);
      ranWritten(f.text);
      continue;
    }
    if (b === "bun") { // config, working directory and preload flags: before the subcommand or script
      for (let k = 0; k < args.length && args[k]!.text.startsWith("-"); k++) {
        if (/^(?:-c|--config|--cwd|--tsconfig-override|--preload|--import|--require|-r|--env-file)(?:=|$)/.test(args[k]!.text)) { hit("interp-flag", `bun ${args[k]!.text}`); if (!args[k]!.text.includes("=")) k++; }
      }
      if (args[0]?.text === "run") { for (let k = 1; k < args.length && args[k]!.text.startsWith("-"); k++) if (/^(?:--preload|--import|--require|-r|--env-file|--config|-c|--cwd)(?:=|$)/.test(args[k]!.text)) { hit("interp-flag", `bun run ${args[k]!.text}`); k++; } }
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
        const a = rest[k]!;
        if (a.text === "-") { stdin(b); inline = true; break; }
        if (a.text.startsWith("-")) {
          if (!a.plain) { hit("interp-flag", `${b} flag is escaped or expanded`); continue; }
          if (kind === "php" && a.text === "-f" && rest[k + 1]) { file = rest[k + 1]; break; } // php -f file: the script
          if (kind === "php" && a.text === "-d" && rest[k + 1] && PHP_INI.test(rest[k + 1]!.text)) { hit("interp-flag", "php -d " + rest[k + 1]!.text.split("=")[0]); k++; continue; }
          if (loads?.test(a.text)) {
            hit("interp-flag", `${b} ${a.text}`);
            if (kind === "python" || a.text === "--run" || a.text === "--test") { noProgram = true; break; } // -m MODULE: what follows is the module's
            if (VALUE_AFTER.has(a.text)) k++;
            continue;
          }
          if (INLINE.test(a.text)) { // inline code is read by the existing scan; later flags still load code (node -e 1 -r x, perl -e 1 -MX)
            inline = true;
            if (kind === "python") break; // after python -c CODE the rest is sys.argv
            if (rest[k + 1] && !rest[k + 1]!.text.startsWith("-")) k++;
            continue;
          }
          if (kind === "ruby" && a.text.startsWith("-C")) cwd = true; // ruby -C dir runs the script from there
          if ((NO_PROGRAM.test(a.text) && !(kind === "python" && a.text === "-v")) || (kind === "php" && NO_PROGRAM_PHP.test(a.text))) noProgram = true;
          else if (valued.includes(a.text) || (kind === "node" && /^--max-[a-z-]+$/.test(a.text))) k++;
          else if (kind === "node" && a.text.startsWith("--") && !NODE_BOOL.test(a.text) && !a.text.includes("=") && rest[k + 1] && !rest[k + 1]!.text.startsWith("-") && k + 2 < rest.length && !rest.some((x) => INLINE.test(x.text)) && !/\.(?:[cm]?[jt]s|json)$|\//.test(rest[k + 1]!.text)) {
            // An option this does not know, followed by a word that is not a script and another word: the first may take the second as its value, and which one is the script is unknown.
            hit("interp-flag", `${b} ${a.text} with a value this does not know`);
          }
          continue;
        }
        if (inline) { // the words after inline code are its arguments (the files, for perl -pi / ruby -i)
          if (inplace) for (const f of rest.slice(k)) if (!f.text.startsWith("-")) copyTargets.add(norm(f.text));
          break;
        }
        if (!a.plain && k < rest.length - 1) { hit("interp-flag", `${b} an expanded word before the script (it can hold flags)`); continue; }
        file = a; break;
      }
      if (inline) continue;
      if (!file) { if (viaXargs && !noProgram) hit("interp-stdin", `xargs ${b}: the script comes from stdin`); else if (!noProgram) stdin(b); continue; }
      if (!file.plain) continue;
      if (file.text.startsWith("/")) { ranWritten(file.text); continue; }
      if (cwd) hit("cd-relative", `${b} script after cd`);
      ranWritten(file.text);
      continue;
    }
    if (head.text.includes("/") && !PM.test(b)) {
      if (head.text.startsWith("/") || (head.text.startsWith("../") && !cwd)) continue; // after a cd, ../x is not the package's
      if (cwd) hit("cd-relative", "path command after cd");
      ranWritten(head.text);
    }
  }
  for (const t of later) copyTargets.add(t.replace(/^\.\//, "")); // a subshell's last redirect is on disk for what follows
}
