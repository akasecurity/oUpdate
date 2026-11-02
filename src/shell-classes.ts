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
//                 body wrote (`cp -r t lib && node lib/x.js`). Not covered: tar/unzip/patch/dd output (the files they
//                 write are unknown; the existing scan holds those)
//   program-file  `sed -f`, `awk -f`, `awk` with system/getline, `make -f`: the program is in a file
//   env-assign    a NODE_OPTIONS, NODE_PATH, npm_config_*, BASH_ENV, PERL5OPT, RUBYOPT, PYTHONPATH, PYTHONSTARTUP,
//                 LD_PRELOAD or DYLD_INSERT_LIBRARIES assignment (leading, after `env`, or `export`)
//   over-cap      a body longer than MAX_LEN characters, which is not parsed (fails closed)
//   unparsed      a structure the parser gives up on (nesting past MAX_DEPTH, fuel out, a trailing backslash, an
//                 empty redirect target): fails closed
//
// The parse is one linear pass with a fuel counter. It reads case/function/`$'..'`/process-substitution forms. A body
// whose structure it gives up on fails closed (`unparsed`, `over-cap`). An unclosed quote, backtick or paren, or a paren
// inside a word, reports nothing and leaves the existing scan's result: the shell would reject those, and reporting
// them would widen 15 of 77 quiet bodies in the real clean set (JSON-escaped quotes copied out of binding.gyp).

export type ClassName = "over-cap" | "unparsed" | "interp-flag" | "interp-stdin" | "heredoc" | "cd-relative" | "writer-exec" | "program-file" | "env-assign";
export interface Hit { cls: ClassName; why: string }

interface Word { text: string; plain: boolean } // plain: no $ or backtick expansion (a backslash only quotes)
interface Stage { words: Word[]; assigns: string[]; writes: string[]; reads: string[]; subs: string[]; hereSubs: string[]; heredoc: boolean; piped: boolean }

export const MAX_LEN = 20000;
export const LIMITS = { fuel: 200000 }; // a test lowers it
const MAX_DEPTH = 4;

class ParseFail extends Error {
  constructor(message: string, readonly cls?: ClassName, readonly pos = 0) { super(message); }
}
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
      out.push(body[i + 2] === "(" && inner.endsWith(")") ? inner.slice(1, -1) : inner);
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
  let fuel = LIMITS.fuel;
  const pendingHere: { delim: string; strip: boolean; active: boolean; st: Stage }[] = [];
  const endWord = () => {
    if (!cur) return;
    const w = cur; cur = undefined;
    if (st.words.length === 0 && /^[A-Za-z_][A-Za-z0-9_]*\+?=/.test(w.text)) { st.assigns.push(w.text); return; }
    if (st.words.length === 0 && KW_SKIP.has(w.text) && w.plain) return;
    st.words.push(w);
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
      if (--fuel < 0) fail("parse budget used up", "unparsed");
      const c = text[i]!;
      if (open === "(" && c === "\n" && pend.length) {
        for (const h of pend) {
          let p = i + 1;
          for (;;) {
            if (--fuel < 0) fail("parse budget used up", "unparsed");
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
        if (delim) pend.push({ delim, strip });
        i = e - 1; continue;
      }
      if (c === "\\") { i++; continue; }
      if (c === "#" && (i === 0 || /[\s;&|(]/.test(text[i - 1]!)) && open === "(") { while (i < text.length && text[i] !== "\n") i++; continue; } // a comment in $( )
      if (c === "'") { const e = text.indexOf("'", i + 1); if (e < 0) fail("quote"); i = e; continue; }
      if (c === '"') { i++; while (i < text.length && text[i] !== '"') { if (--fuel < 0) fail("parse budget used up", "unparsed"); if (text[i] === "\\") i++; i++; } continue; }
      if (c === open) d++;
      else if (c === close && --d === 0) return i;
    }
    return fail("unclosed " + open);
  };
  const isBreak = (c: string) => c === " " || c === "\t" || c === "\n" || c === "\r" || c === ";" || c === "&" || c === "|" || c === "(" || c === ")" || c === "<" || c === ">";
  let wordSubs: string[] = []; // command substitutions inside the word readWordAt just read (a redirect target, a delimiter)
  const readWordAt = (i: number): { w: Word; next: number } => {
    wordSubs = [];
    while (text[i] === " " || text[i] === "\t") i++;
    let t = ""; let plain = true;
    for (; i < text.length; i++) {
      if (--fuel < 0) fail("parse budget used up", "unparsed");
      const c = text[i]!;
      if (isBreak(c)) break;
      if (c === "'") { const e = text.indexOf("'", i + 1); if (e < 0) fail("quote"); t += text.slice(i + 1, e); i = e; continue; }
      if (c === '"') {
        let e = i + 1;
        for (; e < text.length && text[e] !== '"'; e++) { if (--fuel < 0) fail("parse budget used up", "unparsed"); if (text[e] === "\\") e++; }
        if (e >= text.length) fail("quote");
        const inner = text.slice(i + 1, e); if (/[$`]/.test(inner.replace(/\\./g, ""))) plain = false; for (const sub of extractSubs(inner, () => { if (--fuel < 0) fail("parse budget used up", "unparsed"); })) wordSubs.push(sub); t += inner.replace(/\\(["$`\\])/g, "$1"); i = e; continue;
      }
      if (c === "\\") { t += text[i + 1] ?? ""; i++; continue; }
      if (c === "$" && text[i + 1] === "(") { const e = matchClose(i + 2, "(", ")"); wordSubs.push(text.slice(i + 2, e)); plain = false; i = e; continue; }
      if (c === "$" && text[i + 1] === "{") { const e = matchClose(i + 2, "{", "}"); const inner = text.slice(i + 2, e); if (/\$\(|`/.test(inner)) wordSubs.push(inner); t += "${" + inner + "}"; plain = false; i = e; continue; }
      if (c === "`") { const e = text.indexOf("`", i + 1); if (e < 0) fail("backtick"); wordSubs.push(text.slice(i + 1, e)); plain = false; i = e; continue; }
      if (c === "$") plain = false;
      t += c;
    }
    return { w: { text: t, plain }, next: i };
  };
  for (let i = 0; i < text.length; i++) {
    if (--fuel < 0) fail("parse budget used up", "unparsed");
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
        if (--fuel < 0) fail("parse budget used up", "unparsed");
        if (text[j] === "\\") { cur.text += text[j + 1] ?? ""; j++; continue; }
        if (text[j] === "$" && text[j + 1] === "(") { const e = matchClose(j + 2, "(", ")"); st.subs.push(text.slice(j + 2, e)); cur.plain = false; j = e; continue; }
        if (text[j] === "`") { const e = text.indexOf("`", j + 1); if (e < 0) fail("backtick"); st.subs.push(text.slice(j + 1, e)); cur.plain = false; j = e; continue; }
        if (text[j] === "$") cur.plain = false;
        cur.text += text[j];
      }
      if (j >= text.length) fail("quote");
      i = j; continue;
    }
    if (c === "`") { const e = text.indexOf("`", i + 1); if (e < 0) fail("backtick"); st.subs.push(text.slice(i + 1, e)); add("", false); i = e; continue; }
    if (c === "$") {
      if (text[i + 1] === "(") {
        const dbl = text[i + 2] === "(";
        const e = matchClose(i + 2, "(", ")");
        const inner = text.slice(i + 2, e);
        if (!dbl) st.subs.push(inner); else if (/[$`]\(|`/.test(inner)) st.subs.push(inner.slice(1, -1));
        add("", false); i = e; continue;
      }
      if (text[i + 1] === "[") { const e = matchClose(i + 2, "[", "]"); const inner = text.slice(i + 2, e); if (/\$\(|`/.test(inner)) st.subs.push(inner); add("", false); i = e; continue; }
      if (text[i + 1] === "{") { const e = matchClose(i + 2, "{", "}"); const inner = text.slice(i + 2, e); if (/\$\(|`/.test(inner)) st.subs.push(inner); add("${" + inner + "}", false); i = e; continue; }
      if (text[i + 1] === "'") {
        // ANSI-C quoting: a quoted word whose escapes the scan does not decode, so it is not plain.
        let j = i + 2;
        for (; j < text.length && text[j] !== "'"; j++) { if (--fuel < 0) fail("parse budget used up", "unparsed"); if (text[j] === "\\") j++; }
        if (j >= text.length) fail("quote");
        add(text.slice(i + 2, j), false); i = j; continue;
      }
      add("$", false); continue;
    }
    if ((c === "<" || c === ">") && text[i + 1] === "(") { const e = matchClose(i + 2, "(", ")"); st.subs.push(text.slice(i + 2, e)); add("", false); i = e; continue; }
    if (c === "[" && text[i + 1] === "[" && !cur && st.words.length === 0 && (text[i + 2] === " " || text[i + 2] === "\t")) {
      // `[[ cond ]]`: parens and operators inside are not shell syntax; only an expansion in it runs anything
      let e = i + 2;
      for (;;) {
        e = text.indexOf("]]", e);
        if (e < 0) fail("[[ is not closed");
        if (/\s/.test(text[e - 1] ?? "") && (e + 2 >= text.length || /[\s;&|)]/.test(text[e + 2]!))) break;
        e += 2;
      }
      for (const sub of extractSubs(text.slice(i + 2, e), () => { if (--fuel < 0) fail("parse budget used up", "unparsed"); })) st.subs.push(sub);
      st.words.push({ text: "[[", plain: true }); i = e + 1; continue;
    }
    if (c === "(") {
      if (!cur && st.words.length && st.words[st.words.length - 1]!.text === "in") { endStage(); i = matchClose(i + 1, "(", ")"); continue; } // case (pattern)
      if (cur && !st.words.length && /^[A-Za-z_][A-Za-z0-9_]*\+?=$/.test(cur.text)) { // arr=(a b $(cmd))
        const e = matchClose(i + 1, "(", ")");
        for (const sub of extractSubs(text.slice(i + 1, e), () => { if (--fuel < 0) fail("parse budget used up", "unparsed"); })) st.subs.push(sub);
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
      if (inner.startsWith("(") && inner.endsWith(")")) { const a = inner.slice(1, -1); if (/\$\(|`/.test(a)) st.subs.push(a); }
      else st.subs.push(inner);
      i = e; continue;
    }
    if (c === ")") { endStage(); continue; } // a case pattern `x)` ends the pattern
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
      if (cur && /^[0-9]$/.test(cur.text) && cur.plain) cur = undefined; else endWord();
      let j = i + 1; let op = c;
      if (text[j] === ">" || text[j] === "|" || text[j] === "&") { op += text[j]; j++; }
      if (op === ">&" || op === "<&") { const { w, next } = readWordAt(j); st.subs.push(...wordSubs); if (!/^[0-9-]+$/.test(w.text)) st.writes.push(w.text); i = next - 1; continue; }
      const { w, next } = readWordAt(j);
      st.subs.push(...wordSubs);
      if (!w.text && wordSubs.length === 0) fail("redirect target", "unparsed");
      if (c === ">") { if (w.text && w.text !== "/dev/null" && w.plain) st.writes.push(w.text); } else st.reads.push(w.text);
      i = next - 1; continue;
    }
    if (c === "&" && text[i + 1] === ">") { endWord(); const { w, next } = readWordAt(i + 2); st.subs.push(...wordSubs); if (!w.text && wordSubs.length === 0) fail("redirect target", "unparsed"); if (w.text !== "/dev/null" && w.plain) st.writes.push(w.text); i = next - 1; continue; }
    if (c === "|" && text[i + 1] !== "|") { endStage(); st.piped = true; if (text[i + 1] === "&") i++; continue; }
    if (c === "|" || c === "&" || c === ";") { endStage(); if (text[i + 1] === c) i++; continue; }
    if (c === "\n") {
      endStage();
      if (pendingHere.length) {
        for (const h of pendingHere) {
          let p = i + 1; let found = false;
          const bodyStart = p;
          while (p <= text.length) {
            if (--fuel < 0) fail("parse budget used up", "unparsed");
            const nl = text.indexOf("\n", p); const line = text.slice(p, nl < 0 ? text.length : nl).replace(/\r$/, "");
            if ((h.strip ? line.replace(/^\t+/, "") : line) === h.delim) {
              if (h.active) for (const sub of extractSubs(text.slice(bodyStart, p), () => { if (--fuel < 0) fail("parse budget used up", "unparsed"); })) h.st.hereSubs.push(sub);
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
  env: { val: ["-u", "-C", "--unset", "--chdir"] },
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
const INTERP = /^(?:node|nodejs|bun|deno|python\d*(?:\.\d+)?|ruby\d*|perl\d*|php\d*|lua\d*)$/;
const SHELL = /^(?:sh|bash|zsh|dash|ksh|ash)$/;
const PM = /^(?:npm|yarn|pnpm|bun|npx|pnpx|bunx|corepack)$/;
// Flags that make the interpreter load or run code from somewhere the script text does not name. Inline code
// (`node -e`, `python -c`, `perl -e`) is not in this list: the existing scan reads it. Short flags can be clustered
// (`python3 -Bm pkg`, `perl -wMFoo`, `ruby -wrfoo`), so the letter classes match inside a cluster.
const LOADS: Record<string, RegExp> = {
  node: /^(?:-r|--require|--import|--loader|--experimental-loader|--env-file|--env-file-if-exists|--run|--preload|--test)(?:=|$)|^-r./,
  python: /^-[A-Za-z]*m/,
  ruby: /^-[A-Za-z0-9]*[rI]/,
  perl: /^-[A-Za-z]*[MmI]/,
  php: /^-f$/,
  deno: /^--(?:import-map|config|preload|import|cert|lock)(?:=|$)|^-c$/,
};
const INLINE = /^(?:-e|-p|-pe|-c|-r|-ne|-pi|--eval|--print)$/;
// Flags whose value is the next word, per interpreter (so the value is not taken for the script).
const VALUED: Record<string, string[]> = {
  node: ["--title", "-C", "--conditions", "--input-type", "--inspect-port", "--disable-warning", "--watch-path", "--diagnostic-dir", "--report-dir", "--redirect-warnings", "--openssl-config", "--icu-data-dir", "--tls-cipher-list", "--test-name-pattern", "--test-reporter", "--secure-heap", "--heapsnapshot-signal", "--trace-event-categories", "--stack-size"],
  python: ["-W", "-X", "-Q"],
  ruby: ["-E", "-C", "--encoding", "--external-encoding", "--internal-encoding"],
  perl: [],
  php: ["-d", "-c", "-z"],
  deno: ["--config", "-c", "--import-map", "--cached-only"],
  lua: [],
};
// Loading flags whose value is the next word.
const VALUE_AFTER = new Set(["-r", "--require", "--import", "--loader", "--experimental-loader", "--env-file", "--env-file-if-exists", "--preload", "-I"]);
const NO_PROGRAM = /^(?:-v|-V|--version|-h|--help|--v8-options|--check|-\?)$/;
const BAD_ENV = /^(?:NODE_OPTIONS|NODE_PATH|NODE_EXTRA_CA_CERTS|BASH_ENV|PERL5OPT|PERL5LIB|RUBYOPT|RUBYLIB|PYTHONPATH|PYTHONSTARTUP|PYTHONHOME|LD_PRELOAD|LD_LIBRARY_PATH|DYLD_INSERT_LIBRARIES|DYLD_LIBRARY_PATH|npm_config_\w+)\+?=/i;
const DECL = new Set(["export", "declare", "typeset", "readonly", "local"]);
const BASE = (w: string) => w.replace(/^.*\//, "");

// A sed script that runs a command: an `e` command (optionally addressed) or an `s///e` flag. The script is split on
// `;`, newline and braces, so an `e` inside a pattern with `;` is not seen; a miss there leaves the existing scan.
const ADDR = /^(?:\d+|\$|\/(?:[^/\\]|\\.)*\/)(?:,(?:\d+|\$|\/(?:[^/\\]|\\.)*\/))?!?\s*/;
function sedExecs(script: string): boolean {
  if (script.length > 4000) return false;
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
  walk(text, 0, hits, { cwd: false, written: new Set() });
  return hits;
}

function walk(text: string, depth: number, hits: Hit[], parent: State): void {
  let stages: Stage[];
  try {
    stages = parse(text, depth);
  } catch (e) {
    if (!(e instanceof ParseFail)) throw e;
    if (e.cls) { hits.push({ cls: e.cls, why: e.message }); return; }
    // A syntax error the scan cannot read. On one line the shell runs nothing (and the JSON-escaped quotes of binding.gyp
    // bodies land here), so nothing is reported. In a body of several lines the shell runs the complete lines before the
    // error, so those are read; the lines from the error on are not.
    const cut = text.lastIndexOf("\n", e.pos);
    if (cut > 0) walk(text.slice(0, cut), depth, hits, parent);
    return;
  }
  const hit = (cls: ClassName, why: string) => { if (!hits.some((h) => h.cls === cls && h.why === why)) hits.push({ cls, why }); };
  let cwd = parent.cwd;
  const copyTargets = parent.written;
  const nested = (t: string) => walk(t, depth + 1, hits, { cwd, written: copyTargets });
  const written = (f: string) => {
    const n = f.replace(/^(?:\.\/)+/, "").replace(/\/+$/, "");
    if (copyTargets.has(n)) return true;
    for (const t of copyTargets) if (n.startsWith(t + "/")) return true; // inside a directory the body wrote (cp -r t lib)
    const entries = n === "." || n === "" ? ["index.js", "index.cjs", "index.mjs", "package.json"] : [n + ".js", n + ".cjs", n + ".mjs", n + ".json", n + "/index.js", n + "/index.cjs", n + "/index.mjs", n + "/package.json"];
    return entries.some((e) => copyTargets.has(e)); // node b -> b.js, node . -> index.js
  };
  const envHit = () => hit("env-assign", "a variable that loads code or config (NODE_OPTIONS, npm_config_*, BASH_ENV, LD_PRELOAD ...)");
  let later: string[] = [];
  for (const st of stages) {
    for (const s of st.subs) nested(s);
    for (const s of st.hereSubs) nested(s);
    // A redirect empties its target before the command runs, so a stage does not run its own output file.
    for (const t of later) copyTargets.add(t.replace(/^\.\//, ""));
    later = st.writes;
    if (st.assigns.some((a) => BAD_ENV.test(a))) envHit();
    let w = st.words;
    // `function name {` and a leading `{` open a body that the next words continue.
    while (w.length && ((w[0]!.plain && w[0]!.text === "function") || w[0]!.text === "{" || w[0]!.text === "!")) {
      w = w[0]!.text === "function" ? w.slice(Math.min(2, w.length)) : w.slice(1);
    }
    for (let n = 0; w.length; n++) {
      const spec = WRAP[BASE(w[0]!.text)];
      if (!spec || !w[0]!.plain) break;
      if (n >= 8) { hit("unparsed", "more than 8 wrappers before the command"); break; }
      const name = BASE(w[0]!.text);
      let k = 1;
      for (; k < w.length; k++) {
        const t = w[k]!.text;
        if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) { if (BAD_ENV.test(t)) envHit(); continue; }
        if (t === "--") { k++; break; }
        if (name === "env" && t === "-") continue; // env - : an empty environment, the command follows
        if (!t.startsWith("-") || t === "-") break;
        if (name === "env" && (t === "-S" || t === "--split-string")) { if (w[k + 1]) nested(w[k + 1]!.text); k++; continue; }
        if (name === "env" && (t === "-C" || t === "--chdir" || t.startsWith("--chdir="))) cwd = true;
        if (spec.val.includes(t)) k++;
        else if (name === "env" && t.startsWith("-S") && t.length > 2) nested(t.slice(2));
        else if (name === "env" && t.startsWith("-C") && t.length > 2) cwd = true;
      }
      if (spec.dur && k < w.length) k++;
      w = w.slice(k);
    }
    while (w.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(w[0]!.text)) { if (BAD_ENV.test(w[0]!.text)) envHit(); w = w.slice(1); } // env -- NAME=v cmd: the assignment after -- is the first word
    if (!w.length) continue;
    const head = w[0]!;
    if (!head.plain) continue; // an expanded command word is not one of the reported classes
    const b = BASE(head.text);
    const args = w.slice(1);
    const stdin = (what: string) => { if (!st.piped || st.heredoc) hit(st.heredoc ? "heredoc" : "interp-stdin", `${what} reads its program from stdin`); };
    const ranWritten = (f: string) => { if (written(f)) hit("writer-exec", `runs ${f}, written or copied by this body`); };
    if (DECL.has(b)) { if (args.some((a) => BAD_ENV.test(a.text))) envHit(); continue; }
    if (COPIES.has(b)) { for (const a of args) if (!a.text.startsWith("-")) copyTargets.add(a.text.replace(/^\.\//, "")); continue; }
    if (b === "eval") { const t = args.map((a) => a.text).join(" "); if (t) nested(t); continue; } // eval joins its words and runs them as shell
    if (b === "cd" || b === "pushd" || b === "popd") { cwd = true; continue; }
    if (b === "make") { if (args.some((a) => /^-[A-Za-z]*f/.test(a.text) || /^--(?:file|makefile)(?:=|$)/.test(a.text))) hit("program-file", "make -f"); continue; }
    if (/^(?:awk|gawk|mawk|nawk)$/.test(b)) { if (args.some((a) => /^-[A-Za-z]*f/.test(a.text) || /^--file/.test(a.text) || /system|getline/.test(a.text))) hit("program-file", "awk program file or system()"); continue; }
    if (b === "sed") {
      if (args.some((a) => /^-[A-Za-z]*f/.test(a.text) || /^--file/.test(a.text))) hit("program-file", "sed -f");
      else if (args.some((a) => !a.text.startsWith("-") && sedExecs(a.text))) hit("program-file", "sed e command or s///e");
      continue;
    }
    if (b === "curl" || b === "wget") {
      for (let k = 0; k < args.length; k++) {
        const t = args[k]!.text;
        const m = b === "curl" ? /^(?:-o|--output)$/.test(t) : /^(?:-O|--output-document)$/.test(t);
        if (m && args[k + 1]) copyTargets.add(args[k + 1]!.text.replace(/^\.\//, ""));
        else if (b === "curl" && /^--output=./.test(t)) copyTargets.add(t.slice(9).replace(/^\.\//, ""));
        else if (b === "curl" && /^-o./.test(t)) copyTargets.add(t.slice(2).replace(/^\.\//, ""));
        else if (b === "wget" && /^--output-document=./.test(t)) copyTargets.add(t.slice(18).replace(/^\.\//, ""));
        else if (b === "wget" && /^-O./.test(t)) copyTargets.add(t.slice(2).replace(/^\.\//, ""));
      }
      continue;
    }
    if (b === "source" || b === ".") { if (args[0]?.plain) { if (cwd && !args[0].text.startsWith("/")) hit("cd-relative", "sourced file after cd"); ranWritten(args[0].text); } continue; }
    if (SHELL.test(b)) {
      const rest: Word[] = [];
      let code: Word | undefined; let wantCode = false; let stdinFlag = false;
      for (let k = 0; k < args.length; k++) {
        const a = args[k]!;
        const t = a.text;
        if (t === "--") continue;
        if (/^[-+]o$|^-O$/.test(t)) { k++; continue; }
        if (/^--(?:rcfile|init-file)$/.test(t)) { hit("interp-flag", `${b} ${t}`); k++; continue; }
        if (/^-[A-Za-z]*s[A-Za-z]*$/.test(t) && !wantCode && !t.includes("c")) { stdinFlag = true; continue; }
        if (/^-[A-Za-z]+$/.test(t) && t.includes("c")) { wantCode = true; continue; } // -c, -ec, -xc, -lc
        if (t.startsWith("-") || t.startsWith("+")) { if (!a.plain) hit("interp-flag", `${b} flag is escaped or expanded`); continue; }
        if (wantCode) { code = a; break; }
        rest.push(a); break; // the first operand is the script; what follows is its arguments
      }
      if (wantCode) { if (code) nested(code.text); continue; } // a double-quoted string with $ or \\ is walked as written
      if (rest.length === 0 || stdinFlag) { stdin(b); continue; }
      const f = rest[0]!;
      if (!f.plain || f.text.startsWith("/")) continue;
      if (cwd) hit("cd-relative", `${b} file after cd`);
      ranWritten(f.text);
      continue;
    }
    if (INTERP.test(b) && !(b === "bun" && args[0] && /^(?:run|x|install|i|add|remove|create|exec|link|update|pm|test|build|dev|repl|init)$/.test(args[0].text))) {
      const kind = b.replace(/[\d.]+$/, "").replace(/^nodejs$/, "node").replace(/^bun$/, "node");
      const loads = LOADS[kind];
      const valued = VALUED[kind] ?? [];
      let file: Word | undefined; let inline = false; let noProgram = false;
      let rest = args;
      if (kind === "deno") {
        const sub = rest[0]?.text;
        if (!sub || !/^(?:run|test|bench|serve)$/.test(sub)) continue; // eval, repl, task, install ...: not a script run
        rest = rest.slice(1);
      }
      for (let k = 0; k < rest.length; k++) {
        const a = rest[k]!;
        if (a.text === "-") { stdin(b); inline = true; break; }
        if (a.text.startsWith("-")) {
          if (!a.plain) { hit("interp-flag", `${b} flag is escaped or expanded`); continue; }
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
          if (NO_PROGRAM.test(a.text)) noProgram = true;
          else if (valued.includes(a.text)) k++;
          continue;
        }
        if (inline) break; // the words after inline code are its arguments
        if (!a.plain && k < rest.length - 1 && /^\$\{?[A-Za-z_][A-Za-z0-9_]*\}?$|^\$[@*]$/.test(a.text)) { hit("interp-flag", `${b} a bare variable before the script (it can hold flags)`); continue; }
        file = a; break;
      }
      if (inline) continue;
      if (!file) { if (!noProgram) stdin(b); continue; }
      if (!file.plain || file.text.startsWith("/")) continue;
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
