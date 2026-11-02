// Classes of install-script shell forms that run code the scan cannot name from the text. `flagBody(text)` reads one
// shell body and returns one hit per class it finds; the caller reads every file of the package for each hit, as it
// does for an unrecognised runner. It never removes a widening, it only adds one, and it never dispatches.
//
// Only these classes are reported. Anything else (an unknown command, an expanded command word, `node -e/-p` code,
// `npx`, a dependency's bin) is left to the existing scan:
//   interp-flag   an interpreter or shell flag that loads or runs other code (--loader, -r, -m, -c, -e, -C ...)
//   interp-stdin  an interpreter or shell that reads its program from stdin (`node -`, `sh`, `echo x | sh`)
//   heredoc       a heredoc or here-string feeding an interpreter or shell, or a heredoc that does not terminate
//   cd-relative   a relative script, shell file or path command run after a `cd`
//   writer-exec   a stage that writes new bytes (tar x, curl -o, tee, redirect, cp ...) in a body that also runs code
//                 (a shell, interpreter, package runner or path command), or runs a file the body just wrote
//   program-file  `sed -f`, `awk -f`, `awk` with system/getline, `make -f`: the program is in a file
//   env-assign    a NODE_OPTIONS or npm_config_* assignment (leading, after `env`, or `export`)
//
//   over-cap      a body longer than MAX_LEN characters, which is not parsed (fails closed)
//
// The parse is one linear pass with a fuel counter. A body it cannot parse (unclosed quote, stray paren, fuel or
// depth cap) reports nothing: the existing scan keeps its own result for it. Reporting those too would widen 15 of
// 77 quiet bodies in the real clean set (JSON-escaped quotes copied out of binding.gyp), so they stay out.

export type ClassName = "over-cap" | "interp-flag" | "interp-stdin" | "heredoc" | "cd-relative" | "writer-exec" | "program-file" | "env-assign";
export interface Hit { cls: ClassName; why: string }

interface Word { text: string; plain: boolean } // plain: no expansion, no escape trickery
interface Stage { words: Word[]; assigns: string[]; writes: string[]; reads: string[]; subs: string[]; hereSubs: string[]; heredoc: boolean; piped: boolean }

export const MAX_LEN = 20000;
const FUEL = 200000;
const MAX_DEPTH = 4;

class ParseFail extends Error {
  constructor(message: string, readonly cls?: ClassName) { super(message); }
}
const fail = (why: string, cls?: ClassName): never => { throw new ParseFail(why, cls); };

const KW_SKIP = new Set(["if", "then", "elif", "else", "fi", "while", "until", "do", "done", "{", "}", "!"]);

function parse(text: string, depth: number): Stage[] {
  if (depth > MAX_DEPTH) fail("nesting");
  if (text.length > MAX_LEN) fail("body is over the " + MAX_LEN + " character cap", "over-cap");
  const stages: Stage[] = [];
  const fresh = (): Stage => ({ words: [], assigns: [], writes: [], reads: [], subs: [], hereSubs: [], heredoc: false, piped: false });
  let st: Stage = fresh();
  let cur: Word | undefined;
  let fuel = FUEL;
  const pendingHere: { delim: string; strip: boolean; active: boolean; st: Stage }[] = [];
  const endWord = () => {
    if (!cur) return;
    const w = cur; cur = undefined;
    if (st.words.length === 0 && /^[A-Za-z_][A-Za-z0-9_]*\+?=/.test(w.text)) { st.assigns.push(w.text); return; }
    if (st.words.length === 0 && KW_SKIP.has(w.text) && w.plain) return;
    st.words.push(w);
  };
  const endStage = () => { endWord(); if (st.words.length || st.assigns.length || st.writes.length || st.reads.length || st.subs.length || st.heredoc) stages.push(st); st = fresh(); };
  const add = (c: string, plain = true) => { cur ??= { text: "", plain: true }; cur.text += c; if (!plain) cur.plain = false; };
  const matchClose = (i: number, open: string, close: string): number => {
    let d = 1;
    for (; i < text.length; i++) {
      if (--fuel < 0) fail("fuel");
      const c = text[i]!;
      if (c === "\\") { i++; continue; }
      if (c === "'") { const e = text.indexOf("'", i + 1); if (e < 0) fail("quote"); i = e; continue; }
      if (c === '"') { i++; while (i < text.length && text[i] !== '"') { if (--fuel < 0) fail("fuel"); if (text[i] === "\\") i++; i++; } continue; }
      if (c === open) d++;
      else if (c === close && --d === 0) return i;
    }
    return fail("unclosed " + open);
  };
  const isBreak = (c: string) => c === " " || c === "\t" || c === "\n" || c === "\r" || c === ";" || c === "&" || c === "|" || c === "(" || c === ")" || c === "<" || c === ">";
  const readWordAt = (i: number): { w: Word; next: number } => {
    while (text[i] === " " || text[i] === "\t") i++;
    let t = ""; let plain = true;
    for (; i < text.length; i++) {
      if (--fuel < 0) fail("fuel");
      const c = text[i]!;
      if (isBreak(c)) break;
      if (c === "'") { const e = text.indexOf("'", i + 1); if (e < 0) fail("quote"); t += text.slice(i + 1, e); i = e; continue; }
      if (c === '"') { const e = text.indexOf('"', i + 1); if (e < 0) fail("quote"); const inner = text.slice(i + 1, e); if (/[$`\\]/.test(inner)) plain = false; t += inner; i = e; continue; }
      if (c === "\\") { plain = false; t += text[i + 1] ?? ""; i++; continue; }
      if (c === "$" || c === "`") plain = false;
      t += c;
    }
    return { w: { text: t, plain }, next: i };
  };
  for (let i = 0; i < text.length; i++) {
    if (--fuel < 0) fail("fuel");
    const c = text[i]!;
    if (c === "\\") {
      if (text[i + 1] === "\n") { i++; continue; }
      if (i + 1 >= text.length) fail("trailing backslash");
      add(text[i + 1]!, false); i++; continue;
    }
    if (c === "'") { const e = text.indexOf("'", i + 1); if (e < 0) fail("quote"); cur ??= { text: "", plain: true }; cur.text += text.slice(i + 1, e); i = e; continue; }
    if (c === '"') {
      cur ??= { text: "", plain: true };
      let j = i + 1;
      for (; j < text.length && text[j] !== '"'; j++) {
        if (--fuel < 0) fail("fuel");
        if (text[j] === "\\") { cur.plain = false; cur.text += text[j + 1] ?? ""; j++; continue; }
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
        if (!dbl) st.subs.push(inner); else if (/[$`]\(|`/.test(inner)) st.subs.push(inner.slice(1));
        add("", false); i = e; continue;
      }
      if (text[i + 1] === "{") { const e = matchClose(i + 2, "{", "}"); const inner = text.slice(i + 2, e); if (/\$\(|`/.test(inner)) st.subs.push(inner); add("", false); i = e; continue; }
      if (text[i + 1] === "'") fail("ansi-c quote");
      add("$", false); continue;
    }
    if ((c === "<" || c === ">") && text[i + 1] === "(") fail("process substitution");
    if (c === "(") {
      if (cur || st.words.length) fail("paren in word");
      const e = matchClose(i + 1, "(", ")");
      st.subs.push(text.slice(i + 1, e)); i = e; continue;
    }
    if (c === ")") fail("stray paren");
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
    if (c === "<" && text[i + 1] === "<" && text[i + 2] === "<") { endWord(); const { next } = readWordAt(i + 3); st.heredoc = true; st.reads.push("<<<"); i = next - 1; continue; }
    if (c === ">" || c === "<") {
      if (cur && /^[0-9]$/.test(cur.text) && cur.plain) cur = undefined; else endWord();
      let j = i + 1; let op = c;
      if (text[j] === ">" || text[j] === "|" || text[j] === "&") { op += text[j]; j++; }
      if (op === ">&" || op === "<&") { const { w, next } = readWordAt(j); if (!/^[0-9-]+$/.test(w.text)) st.writes.push(w.text); i = next - 1; continue; }
      const { w, next } = readWordAt(j);
      if (!w.text) fail("redirect target");
      if (c === ">") { if (w.text !== "/dev/null" && w.plain) st.writes.push(w.text); } else st.reads.push(w.text);
      i = next - 1; continue;
    }
    if (c === "&" && text[i + 1] === ">") { endWord(); const { w, next } = readWordAt(i + 2); if (w.text !== "/dev/null" && w.plain) st.writes.push(w.text); i = next - 1; continue; }
    if (c === "|" && text[i + 1] !== "|") { endStage(); st.piped = true; if (text[i + 1] === "&") i++; continue; }
    if (c === "|" || c === "&" || c === ";") { endStage(); if (text[i + 1] === c) i++; continue; }
    if (c === "\n") {
      endStage();
      if (pendingHere.length) {
        for (const h of pendingHere) {
          let p = i + 1; let found = false;
          while (p <= text.length) {
            if (--fuel < 0) fail("fuel");
            const nl = text.indexOf("\n", p); const line = text.slice(p, nl < 0 ? text.length : nl);
            if ((h.strip ? line.replace(/^\t+/, "") : line) === h.delim) { i = nl < 0 ? text.length : nl; found = true; break; }
            if (h.active && /\$\(|`/.test(line)) h.st.hereSubs.push(line);
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
const WRAP = new Set(["env", "nohup", "time", "exec", "command", "nice", "timeout", "sudo"]);
const INTERP = /^(?:node|nodejs|bun|deno|python\d*(?:\.\d+)?|ruby\d*|perl\d*|php\d*|lua\d*)$/;
const SHELL = /^(?:sh|bash|zsh|dash|ksh|ash)$/;
const PM = /^(?:npm|yarn|pnpm|bun|npx|pnpx|bunx|corepack)$/;
// Flags that make the interpreter load or run code from somewhere the script text does not name. Inline code
// (`node -e`, `python -c`, `perl -e`) is not in this list: the existing scan reads it.
const LOADS: Record<string, RegExp> = {
  node: /^(?:-r|--require|--import|--loader|--experimental-loader|--env-file|--env-file-if-exists|--run|--preload)(?:=|$)|^-r./,
  python: /^-m/,
  ruby: /^-r|^-I/,
  perl: /^-M|^-m|^-I/,
  php: /^-f$|^-r$/,
  deno: /^--(?:import-map|config|preload)/,
};
const BAD_ENV = /^(?:NODE_OPTIONS|npm_config_\w+)\+?=/i;
const DECL = new Set(["export", "declare", "typeset", "readonly", "local"]);
const BASE = (w: string) => w.replace(/^.*\//, "");

export function flagBody(text: string): Hit[] {
  const hits: Hit[] = [];
  walk(text, 0, hits);
  return hits;
}

function walk(text: string, depth: number, hits: Hit[]): void {
  let stages: Stage[];
  try {
    stages = parse(text, depth);
  } catch (e) {
    if (e instanceof ParseFail) { if (e.cls) hits.push({ cls: e.cls, why: e.message }); return; }
    throw e;
  }
  const hit = (cls: ClassName, why: string) => { if (!hits.some((h) => h.cls === cls && h.why === why)) hits.push({ cls, why }); };
  let cwd = false;
  const copyTargets = new Set<string>();
  const written = (f: string) => copyTargets.has(f.replace(/^\.\//, ""));
  for (const st of stages) {
    for (const s of st.subs) walk(s, depth + 1, hits);
    for (const s of st.hereSubs) walk(s, depth + 1, hits);
    for (const t of st.writes) copyTargets.add(t.replace(/^\.\//, ""));
    if (st.assigns.some((a) => BAD_ENV.test(a))) hit("env-assign", "NODE_OPTIONS or npm_config_* assignment");
    let w = st.words;
    for (let n = 0; n < 4 && w.length; n++) {
      if (!WRAP.has(BASE(w[0]!.text))) break;
      const isTimeout = BASE(w[0]!.text) === "timeout";
      let k = 1;
      while (k < w.length && (w[k]!.text.startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(w[k]!.text) || (isTimeout && k === 1))) {
        if (BAD_ENV.test(w[k]!.text)) hit("env-assign", "NODE_OPTIONS or npm_config_* assignment");
        k++;
      }
      w = w.slice(k);
    }
    if (!w.length) continue;
    const head = w[0]!;
    if (!head.plain) continue; // an expanded command word is not one of the reported classes
    const b = BASE(head.text);
    const args = w.slice(1);
    const stdin = (what: string) => { if (!st.piped || st.heredoc) hit(st.heredoc ? "heredoc" : "interp-stdin", `${what} reads its program from stdin`); };
    const ranWritten = (f: string) => { if (written(f)) hit("writer-exec", `runs ${f}, written or copied by this body`); };
    if (DECL.has(b)) { if (args.some((a) => BAD_ENV.test(a.text))) hit("env-assign", "NODE_OPTIONS or npm_config_* assignment"); continue; }
    if (COPIES.has(b)) { for (const a of args) if (!a.text.startsWith("-")) copyTargets.add(a.text.replace(/^\.\//, "")); continue; }
    if (b === "cd" || b === "pushd" || b === "popd") { cwd = true; continue; }
    if (b === "make") { if (args.some((a) => a.text === "-f" || /^--(?:file|makefile)(?:=|$)/.test(a.text))) hit("program-file", "make -f"); continue; }
    if (b === "awk") { if (args.some((a) => a.text === "-f" || /^--file/.test(a.text) || /system|getline/.test(a.text))) hit("program-file", "awk program file or system()"); continue; }
    if (b === "sed") {
      if (args.some((a) => a.text === "-f" || /^--file/.test(a.text) || /^-[A-Za-z]*f$/.test(a.text))) hit("program-file", "sed -f");
      continue;
    }
    if (SHELL.test(b)) {
      const rest: Word[] = [];
      let code: Word | undefined; let stdinFlag = false;
      for (let k = 0; k < args.length; k++) {
        const a = args[k]!;
        if (a.text === "-c") { code = args[k + 1]; k++; continue; }
        if (a.text === "-s") { stdinFlag = true; continue; }
        if (/^--(?:rcfile|init-file)$/.test(a.text)) { hit("interp-flag", `${b} ${a.text}`); k++; continue; }
        if (a.text === "--") continue;
        if (a.text.startsWith("-") || a.text.startsWith("+")) continue;
        rest.push(a); break; // the first operand is the script; what follows is its arguments
      }
      if (code) { if (code.plain) walk(code.text, depth + 1, hits); continue; }
      if (rest.length === 0 || stdinFlag) { stdin(b); continue; }
      const f = rest[0]!;
      if (!f.plain || f.text.startsWith("/")) continue;
      if (cwd) hit("cd-relative", `${b} file after cd`);
      ranWritten(f.text);
      continue;
    }
    if (INTERP.test(b) && !(b === "bun" && args[0] && /^(?:run|x|install|i|add|remove|create|exec|link|update|pm|test|build|dev|repl|init)$/.test(args[0].text))) {
      const loads = LOADS[b.replace(/[\d.]+$/, "").replace(/^nodejs$/, "node").replace(/^bun$/, "node")];
      let file: Word | undefined; let inline = false;
      for (const a of args) {
        if (a.text === "-") { stdin(b); inline = true; break; }
        if (a.text.startsWith("-")) {
          if (!a.plain) { inline = true; break; }
          if (loads?.test(a.text)) hit("interp-flag", `${b} ${a.text}`);
          else if (/^(?:-e|-p|-pe|-c|-ne|-pi|--eval|--print)$/.test(a.text)) inline = true; // inline code: read by the existing scan
          continue;
        }
        file = a; break;
      }
      if (inline) continue;
      if (!file) { if (!args.some((a) => a.text.startsWith("-"))) stdin(b); continue; }
      if (!file.plain || file.text.startsWith("/")) continue;
      if (cwd) hit("cd-relative", `${b} script after cd`);
      ranWritten(file.text);
      continue;
    }
    if (head.text.includes("/") && !PM.test(b)) {
      if (head.text.startsWith("/") || head.text.startsWith("../")) continue;
      if (cwd) hit("cd-relative", "path command after cd");
      ranWritten(head.text);
    }
  }
}
