// Install-time closure of one npm artifact. A command we cannot reduce to a known
// form holds the release. Caps hold too: a long pattern, a glob we do not expand,
// or more keys than the star walk is allowed to touch.
import { flagBody } from "./shell-classes.ts";
import { gypCommands, starMatch, STAR_KEY_MAX, STAR_PATTERN_MAX, STAR_TEXT_MAX, surfaceCap, type FileMap } from "./prepass.ts";

export interface InstallView {
  hold?: string;
  manifest: string;
  files: string[];
  gypFiles: string[];
  missing: string[];
  scripts: Record<string, string>;
  gyp?: string;
  // Set when a preinstall, install, postinstall, or prepare script is non-empty.
  hook: boolean;
  // package.json `bin` and `directories.bin`, compared only while a hook exists.
  binStamp: string;
}

const LIFECYCLE = ["preinstall", "install", "postinstall"] as const;

/** True when the tarball has an install-time entry point besides the root pre/install/postinstall scripts: a root binding.gyp or `gypfile: true` (an implicit node-gyp rebuild; yarn runs it even with `gypfile: false`), or anything under node_modules (bundled dependencies run their lifecycle scripts) with a lifecycle script or a binding.gyp. Any of them can run `npm run prepare` through indirection. */
export function otherInstallEntry(files: FileMap, manifest: string): boolean {
  const dir = manifest.includes("/") ? manifest.slice(0, manifest.lastIndexOf("/") + 1) : "";
  const nested = `${dir}node_modules/`;
  for (const [k, bytes] of files) {
    if (!k.startsWith(dir)) continue;
    const rel = k.slice(dir.length);
    const base = rel.slice(rel.lastIndexOf("/") + 1).toLowerCase();
    if (base === "binding.gyp" && (!rel.includes("/") || k.startsWith(nested))) return true;
    if (base === "package.json" && k.startsWith(nested)) {
      try {
        const v = JSON.parse(new TextDecoder("utf-8", { fatal: false }).decode(bytes)) as { scripts?: unknown; gypfile?: unknown };
        const sc = v && typeof v.scripts === "object" && v.scripts ? (v.scripts as Record<string, unknown>) : {};
        if (v?.gypfile === true || LIFECYCLE.some((n) => typeof sc[n] === "string" && (sc[n] as string).trim().length > 0)) return true;
      } catch {
        return true;
      }
    } else if (base === "package.json" && !rel.includes("/")) {
      try {
        const v = JSON.parse(new TextDecoder("utf-8", { fatal: false }).decode(bytes)) as { gypfile?: unknown };
        if (v?.gypfile === true) return true;
      } catch {
        return true;
      }
    }
  }
  return false;
}

const INSTALL = ["preinstall", "install", "postinstall", "prepare"] as const;

/** npm, pnpm, yarn and bun do not run `prepare` when they install a registry tarball (only for git and local dependencies, and at the root), so a change to it alone is no install-time signal. That holds only when nothing else can start it: any non-empty preinstall, install or postinstall keeps `prepare` a signal, because the script or a file it runs can call `npm run prepare` (or preprepare/postprepare) through indirection no static read resolves (a file that shells out, an escaped name, `$(...)`, eval). The files it names are still read by the reviewer. */
export function prepareInert(scripts: Record<string, unknown>, otherEntry = false): boolean {
  if (otherEntry) return false;
  return !LIFECYCLE.some((k) => typeof scripts[k] === "string" && (scripts[k] as string).trim().length > 0);
}
const PRIMARY_EXT = [".js", ".json", ".node", ".cjs", ".mjs", ".jsx", ".tsx", ".cts", ".mts", ".ts"];
const BOOL_FLAGS = new Set(["--silent", "--quiet", "-s", "-q", "--if-present"]);
const VALUE_FLAGS = new Set(["--loglevel", "--prefix", "-C", "--userconfig", "--max-parallel", "--jobs", "-j"]);
const RUN_SUB = new Set(["run", "run-script", "rum", "urn"]);
const TOKEN = /^[A-Za-z0-9_./@+-]+$/;
const PLAIN_REQUIRE = /require\(\s*process\.env(?:\.npm_package_config_([A-Za-z0-9_]+)|\s*\[\s*(["'])npm_package_config_([A-Za-z0-9_]+)\2\s*\])\s*\)/g;
const DEPTH = 64;

const dec = new TextDecoder("utf-8", { fatal: false });

interface Ctx {
  hold?: string;
  noEnvIgnore?: boolean; // inside a wrapper other than env: a leading assignment is a command word, not the environment
  ignoreHooks?: boolean; // --ignore-scripts or npm_config_ignore_scripts: no pre/post script runs, and no lifecycle script of pack/version/it
  files: Set<string>;
  gypFiles: Set<string>;
  missing: Set<string>;
  scripts: Record<string, string>;
  seen: Set<string>;
  scanned: Set<string>;
  ranSh: Set<string>;
  depth: number;
  // Directories a cd or a directory flag moved a run into: their files are not inert whatever the folder name.
  movedDirs: Set<string>;
  // True while a `node` command's operands are read: only a program that runs a directory as a module reads a root `main`.
  rootRuns?: boolean;
  // The directory the last `cd` of the hook moved to, relative to the package root.
  cwd: string;
  // The shell scan was not sure what a body does: the widen reads every file, inert paths included.
  widenInert: boolean;
  // A package runner (npm, pnpm, yarn, bun, npx, bunx, corepack) was reached by the hook.
  sawRunner: boolean;
  sawNodeGyp: boolean;
  // A binary field, prebuild-install, or node-pre-gyp can still compile binding.gyp.
  reachGyp: boolean;
  fromGyp: boolean;
  fileCount: number;
  // Paths a hook command names directly.
  hookNamed: Set<string>;
  logical: Map<string, string>;
  raw: Record<string, unknown>;
  config: Record<string, unknown>;
  bytes: FileMap;
}

function fail(ctx: Ctx, reason: string): void {
  // A download, an eval, or an unresolved runner is not a hold on its own.
  // Caps stay holds: the closure below them is not the whole surface.
  if (!surfaceCap(reason)) return;
  if (!ctx.hold) ctx.hold = reason;
}

function binName(token: string): string {
  const slash = Math.max(token.lastIndexOf("/"), token.lastIndexOf("\\"));
  const base = slash >= 0 ? token.slice(slash + 1) : token;
  return base.replace(/\.cmd$/i, "");
}

// `pnpm@9` and `yarn@1.22.22` are the pinned form of the runner. Only the runner comparison strips it.
function runnerName(token: string): string {
  // Only a version, range or tag follows the name. `pnpm@file:x.tgz` and `pnpm@npm:other` stay unknown.
  // A spec that starts with a dot (`pnpm@.`, `pnpm@..`) is a directory, not a version.
  // A spec ending .tgz, .tar or .zip is a local archive, not a version.
  return binName(token).replace(/^(.+?)@(?![0-9A-Za-z.^~<>=*+-]*\.(?:tgz|tar|zip|gz)$)[0-9A-Za-z^~<>=*+-][0-9A-Za-z.^~<>=*+-]*$/i, "$1");
}

function words(cmd: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: string | undefined;
  let started = false; // a quote has opened in this word: an unquoted ~ after empty quotes is not at the start of the word
  // A quote or backslash inside the tilde prefix (up to the first /) makes the prefix literal: ./~+ names a file called ~+.
  const tildePrefix = (next: string): boolean => /^~[^/]*$/.test(cur) || (cur === "" && next === "~");
  for (let ci = 0; ci < cmd.length; ci++) {
    const c = cmd[ci]!;
    if (quote) {
      // In double quotes a backslash before a quote, a backslash, a dollar or a backtick leaves that character (`\"` is `"`).
      if (c === "\\" && quote === '"' && /["\\$`]/.test(cmd[ci + 1] ?? "")) cur += cmd[++ci]!;
      else if (c === quote) quote = undefined;
      else cur += c;
      continue;
    }
    if (c === "'" || c === '"') {
      if (tildePrefix(cmd[ci + 1] ?? "")) cur = "./" + cur;
      started = true;
      quote = c;
      continue;
    }
    if (c === "\\" && tildePrefix(cmd[ci + 1] ?? "")) { cur = "./" + cur + (cmd[ci + 1] ?? ""); ci++; continue; }
    if (/\s/.test(c)) {
      if (cur) out.push(cur);
      cur = "";
      started = false;
      continue;
    }
    if (c === "~" && started && cur === "") cur = "./";
    cur += c;
  }
  if (cur) out.push(cur);
  return out;
}

function normalize(token: string): string {
  let t = token.replace(/\/{2,}/g, "/").replace(/^~(?:[+-]\d*|\d+)\/+/, ""); // ~0/x and ~+/x are x in the working directory
  while (t.startsWith("./")) t = t.slice(2);
  return t;
}

function badPath(logical: string): boolean {
  if (!logical || logical.startsWith("/") || /^[A-Za-z]:/.test(logical)) return true;
  return logical.split("/").some((s) => s === "" || s === "." || s === "..");
}

function configVal(ctx: Ctx, key: string): string | undefined {
  const v = ctx.config[key];
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return String(v);
  return undefined;
}

// Stands where an expansion the scan cannot resolve was, when a body is read leniently.
const UNRESOLVED = "\u0005"; // not a character the closure uses elsewhere (\u0001-\u0003 mark fed files)

// The index just past the `)` that closes a construct opened before `i`, with quotes, escapes, comments, heredocs and
// nested parentheses followed; -1 when it is not closed. The same for a backtick span (endTick) and for `${` (endBrace).
// The scans below call each other for nested spans: past this depth a span counts as not closed.
const SPAN_DEPTH = 64;
let spanDepth = 0;
function bounded(f: () => number): number {
  if (spanDepth >= SPAN_DEPTH) return -1;
  spanDepth++;
  try {
    return f();
  } finally {
    spanDepth--;
  }
}
function endParen(t: string, i: number): number {
  return bounded(() => endParenCore(t, i));
}
function endParenCore(t: string, i: number): number {
  let d = 1;
  let esc = false;
  const pend: { delim: string; strip: boolean }[] = [];
  for (let j = i; j < t.length; j++) {
    const c = t[j]!;
    const wasEsc = esc;
    esc = false;
    if (c === "\\") {
      j++;
      esc = true;
    } else if (c === "#" && (j === i || (/[\s;&|(]/.test(t[j - 1]!) && !wasEsc))) {
      while (j < t.length && t[j] !== "\n") j++; // a comment: its quotes and parentheses mean nothing
      j--;
    } else if (c === "'") {
      const e = t.indexOf("'", j + 1);
      if (e < 0) return -1;
      j = e;
    } else if (c === "$" && t[j + 1] === "'") j = endAnsi(t, j + 1);
    else if (c === "$" && t[j + 1] === "{") {
      const e = endBrace(t, j + 2);
      if (e < 0) return -1;
      j = e - 1;
    } else if (c === '"') j = endDq(t, j);
    else if (c === "`") {
      const e = endTick(t, j);
      if (e < 0) return -1;
      j = e - 1;
    } else if (c === "<" && t[j + 1] === "<" && t[j + 2] === "<") j += 2; // a here-string
    else if (c === "<" && t[j + 1] === "<") {
      const h = heredocWord(t, j + 2);
      if (h.delim && !/^\d+$|^=/.test(h.delim)) pend.push(h); // `1 << 2` and `n <<= 1` are shifts
      j = h.end - 1;
    } else if (c === "\n" && pend.length) {
      j = skipHeredocs(t, j + 1, pend) - 1;
      pend.length = 0;
    } else if (c === "(") d++;
    else if (c === ")" && --d === 0) return j + 1;
  }
  return -1;
}
function endTick(t: string, i: number): number {
  for (let j = i + 1; j < t.length; j++) {
    if (t[j] === "\\") j++;
    else if (t[j] === "`") return j + 1;
  }
  return -1;
}
function endBrace(t: string, i: number, dq = false): number {
  return bounded(() => endBraceCore(t, i, dq));
}
// `dq`: the brace sits in double quotes, where a single quote is an ordinary character.
function endBraceCore(t: string, i: number, dq: boolean): number {
  let d = 1;
  for (let j = i; j < t.length; j++) {
    const c = t[j]!;
    if (c === "\\") j++;
    else if (c === "'" && !dq) {
      const e = t.indexOf("'", j + 1);
      if (e < 0) return -1;
      j = e;
    } else if (c === "$" && t[j + 1] === "'" && !dq) j = endAnsi(t, j + 1);
    else if (c === "$" && t[j + 1] === "(") {
      const e = endParen(t, j + 2);
      if (e < 0) return -1;
      j = e - 1;
    } else if (c === "`") {
      const e = endTick(t, j);
      if (e < 0) return -1;
      j = e - 1;
    } else if (c === '"') j = endDq(t, j); // a nested double quote opens a quoted string, even inside double quotes
    else if (c === "{") d++;
    else if (c === "}" && --d === 0) return j + 1;
  }
  return -1;
}
// ANSI-C `$'..'` (i is the opening quote): the index of the closing quote; a backslash escapes the next character.
function endAnsi(t: string, i: number): number {
  let j = i + 1;
  for (; j < t.length && t[j] !== "'"; j++) if (t[j] === "\\") j++;
  return j;
}
// A double-quoted string opened at t[i]: the index of its closing quote. Substitutions and `${ }` inside it can hold quotes.
function endDq(t: string, i: number): number {
  const r = bounded(() => endDqCore(t, i));
  return r < 0 ? t.length : r;
}
function endDqCore(t: string, i: number): number {
  let j = i + 1;
  for (; j < t.length && t[j] !== '"'; j++) {
    const c = t[j]!;
    if (c === "\\") j++;
    else if (c === "$" && t[j + 1] === "(") {
      const e = endParen(t, j + 2);
      if (e < 0) return t.length;
      j = e - 1;
    } else if (c === "$" && t[j + 1] === "{") {
      const e = endBrace(t, j + 2, true);
      if (e < 0) return t.length;
      j = e - 1;
    } else if (c === "`") {
      const e = endTick(t, j);
      if (e < 0) return t.length;
      j = e - 1;
    }
  }
  return j;
}
// The delimiter word of a heredoc (i is just after `<<`): quotes and backslashes removed as the shell does.
function heredocWord(t: string, i: number): { delim: string; strip: boolean; quoted: boolean; end: number } {
  let j = i;
  let quoted = false;
  const strip = t[j] === "-";
  if (strip) j++;
  while (t[j] === " " || t[j] === "\t") j++;
  let delim = "";
  let k = j;
  for (; k < t.length && !/[\s;&|()<>]/.test(t[k]!); k++) {
    const d = t[k]!;
    if (d === "'" || d === '"' || d === "\\") quoted = true;
    if (d === "'") {
      const e = t.indexOf("'", k + 1);
      const stop = e < 0 ? t.length : e;
      delim += t.slice(k + 1, stop);
      k = stop;
    } else if (d === '"') {
      let e = k + 1;
      while (e < t.length && t[e] !== '"') {
        if (t[e] === "\\") e++;
        e++;
      }
      delim += t.slice(k + 1, Math.min(e, t.length)).replace(/\\([$`"\\])/g, "$1"); // in double quotes a backslash escapes only $ ` " \\
      k = e;
    } else if (d === "\\") {
      delim += t[k + 1] ?? "";
      k++;
    } else delim += d;
  }
  return { delim, strip, quoted, end: Math.min(k, t.length) };
}
// The index after the heredoc texts that start at i (each runs up to its terminator line).
function skipHeredocs<H extends { delim: string; strip: boolean; quoted?: boolean }>(t: string, i: number, pend: H[], body?: (text: string, h: H) => void): number {
  for (const h of pend) {
    const start = i;
    let end = i;
    while (i < t.length) {
      const nl = t.indexOf("\n", i);
      const l = t.slice(i, nl < 0 ? t.length : nl).replace(/\r$/, "");
      end = i;
      i = nl < 0 ? t.length : nl + 1;
      if ((h.strip ? l.replace(/^\t+/, "") : l) === h.delim) break;
      end = i;
    }
    // The text of a heredoc whose word is not quoted is expanded: its substitutions run.
    if (body && !h.quoted) body(t.slice(start, end), h);
  }
  return i;
}

// Replaces `${npm_package_config_x}` forms by their value. An expansion it cannot resolve makes the text unreadable
// (null), or, when `loose`, is replaced by UNRESOLVED so that the commands around it can still be read.
function subst(ctx: Ctx, body: string, loose = false): string | null {
  // A backslash in the tilde prefix (~\+/x, \~+/x) makes it a literal name: ./~+/x. Said here so the later scans see no backslash.
  body = body.replace(/(^|[\s;&|(])\\~/g, "$1./~").replace(/(^|[\s;&|(])(~[^\s/\\'"$`]*)\\([^\s\\])/g, "$1./$2$3");
  let out = "";
  let inDq = false;
  let escAt = -1; // the index of the last escaped character
  for (let i = 0; i < body.length; ) {
    const c = body[i]!;
    if (loose) {
      if (c === "\\") { // an escaped character is not an expansion or a quote
        out += c + (body[i + 1] ?? "");
        escAt = i + 1;
        i += 2;
        continue;
      }
      if (c === '"') inDq = !inDq;
      else if (!inDq && c === "'") { // nothing expands inside single quotes (a backslash escapes in $'..')
        const e = body[i - 1] === "$" && escAt !== i - 1 ? endAnsi(body, i) : body.indexOf("'", i + 1);
        const end = e < 0 ? body.length : Math.min(e + 1, body.length);
        out += body.slice(i, end);
        i = end;
        continue;
      }
    }
    if (c === "`" || (c === "$" && body[i + 1] === "(")) {
      if (!loose) {
        fail(ctx, "unresolved: shell");
        return null;
      }
      const e = c === "`" ? endTick(body, i) : endParen(body, i + 2);
      out += UNRESOLVED;
      i = e < 0 ? body.length : e;
      continue;
    }
    if (c === "$") {
      let key: string | undefined;
      let next = i + 1;
      if (body[next] === "{") {
        const end = body.indexOf("}", next + 1);
        const m = end < 0 ? null : /^npm_package_config_([A-Za-z0-9_]+)$/.exec(body.slice(next + 1, end));
        if (m) {
          key = m[1];
          next = end + 1;
        } else {
          if (!loose) {
            fail(ctx, "unresolved: env");
            return null;
          }
          out += UNRESOLVED;
          const eb = endBrace(body, i + 2);
          i = eb < 0 ? body.length : eb;
          continue;
        }
      } else {
        const m = /^npm_package_config_([A-Za-z0-9_]+)/.exec(body.slice(next));
        if (m) {
          key = m[1];
          next += m[0]!.length;
        } else {
          if (!loose) {
            fail(ctx, "unresolved: env");
            return null;
          }
          const t = /^(?:[A-Za-z_][A-Za-z0-9_]*|[0-9@*#?$!-])/.exec(body.slice(next));
          out += UNRESOLVED;
          i = next + (t ? t[0].length : 0);
          continue;
        }
      }
      const val = configVal(ctx, key!);
      if (val === undefined || !TOKEN.test(val) || val.split("/").includes("..")) {
        if (!loose) {
          fail(ctx, "unresolved: env");
          return null;
        }
        out += UNRESOLVED;
        i = next;
        continue;
      }
      out += val;
      i = next;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

function splitCommands(ctx: Ctx, body: string): string[] | null {
  const out: string[] = [];
  let cur = "";
  let quote: string | undefined;
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!;
    if (quote) {
      cur += c;
      // In double quotes a backslash escapes the next character: `\"` does not close the quote.
      if (c === "\\" && quote === '"' && i + 1 < body.length) cur += body[++i]!;
      else if (c === quote) quote = undefined;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      cur += c;
      continue;
    }
    if (c === "`" || c === "(" || c === ")" || c === "<" || c === ">" || c === "\\") {
      fail(ctx, "unresolved: shell");
      return null;
    }
    if (c === "|" || c === "&") {
      if (body[i + 1] !== c) {
        fail(ctx, "unresolved: shell");
        return null;
      }
      if (cur.trim()) out.push(cur.trim());
      cur = "";
      i++;
      continue;
    }
    if (c === ";" || c === "\n") {
      if (cur.trim()) out.push(cur.trim());
      cur = "";
      continue;
    }
    cur += c;
  }
  if (quote) {
    fail(ctx, "unresolved: shell");
    return null;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function foldCount(ctx: Ctx, logical: string): number {
  const want = logical.toLowerCase();
  let n = 0;
  for (const key of ctx.logical.keys()) if (key.toLowerCase() === want) n++;
  return n;
}

// Exact file, then Node's added extensions. A dotted name still tries .js, .json,
// and .node (`install.js` → `install.js.js`). `.npmignore` falls back to the
// sibling `.gitignore` that pacote renames on extract. A directory manifest
// resolves `main`, or `index.js` when main is absent.
function findKey(ctx: Ctx, logical: string): string | undefined {
  if (foldCount(ctx, logical) > 1) {
    fail(ctx, "case-fold");
    return undefined;
  }
  const manifest = ctx.logical.get(`${logical}/package.json`);
  if (manifest) {
    const pj = parseJson(ctx.bytes.get(manifest));
    if (pj && pj.main !== undefined && typeof pj.main !== "string") return undefined;
    const main = pj && typeof pj.main === "string" ? pj.main : "index.js";
    const rel = normalize(main);
    if (!rel || /[*?[]/.test(rel)) return undefined;
    if (badPath(rel)) {
      // A main with a `.` or `..` segment or a trailing slash resolves from the manifest's directory; one that leaves the
      // package reads every file.
      const inside = rel.startsWith("/") || /^[A-Za-z]:/.test(rel) || /[\u0005$~]/.test(rel) ? undefined : joinDir(logical, rel);
      if (inside === undefined) {
        if (/(^|\/)\.\.(\/|$)/.test(rel)) {
          ctx.widenInert = true;
          widenAll(ctx);
        }
        return undefined;
      }
      return findFile(ctx, inside || "index");
    }
    const next = joinLogical(`${logical}/package.json`, rel);
    if (!next) return undefined;
    return findFile(ctx, next);
  }
  return findFile(ctx, logical);
}

function findFile(ctx: Ctx, logical: string): string | undefined {
  if (foldCount(ctx, logical) > 1) {
    fail(ctx, "case-fold");
    return undefined;
  }
  const direct = ctx.logical.get(logical);
  if (direct) return direct;
  const base = logical.slice(logical.lastIndexOf("/") + 1);
  if (base === ".npmignore") {
    const dir = logical.includes("/") ? logical.slice(0, logical.lastIndexOf("/")) : "";
    const git = dir ? `${dir}/.gitignore` : ".gitignore";
    const hit = ctx.logical.get(git);
    if (hit) return hit;
  }
  const nodeExt = [".js", ".json", ".node"];
  for (const ext of nodeExt) {
    const hit = ctx.logical.get(logical + ext);
    if (hit) return hit;
  }
  if (!base.includes(".")) {
    for (const ext of PRIMARY_EXT) {
      const hit = ctx.logical.get(logical + ext);
      if (hit) return hit;
    }
  }
  for (const ext of PRIMARY_EXT) {
    const hit = ctx.logical.get(`${logical}/index${ext}`);
    if (hit) return hit;
  }
  const want = logical.toLowerCase();
  let folded: string | undefined;
  for (const key of ctx.logical.keys()) {
    if (key.toLowerCase() !== want) continue;
    if (folded) return undefined;
    folded = ctx.logical.get(key);
  }
  return folded;
}

// A relative require/import is resolved from the file that contains it. `..` that
// stays inside the package is that file. A path that escapes is not a named file.
function relFrom(fromKey: string, spec: string): string | undefined {
  if (!spec.startsWith(".")) return undefined;
  const dir = fromKey.includes("/") ? fromKey.slice(0, fromKey.lastIndexOf("/")) : "";
  const parts = (dir ? `${dir}/${spec}` : spec).split("/");
  const out: string[] = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (out.length === 0) return undefined;
      out.pop();
      continue;
    }
    out.push(part);
  }
  const logical = out.join("/");
  if (!logical || badPath(logical)) return undefined;
  return logical;
}

function isManifest(logical: string): boolean {
  return logical.slice(logical.lastIndexOf("/") + 1).toLowerCase() === "package.json";
}

// A literal require/import is followed exactly. A bare name that resolves inside a
// bundled node_modules package closes that package. Anything else is not a path.
/** A string literal's text as JavaScript reads it: \x41, \u0041, \u{41} and the one-character escapes; undefined when unsure. */
function decodeJsString(raw: string): string | undefined {
  let out = "";
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]!;
    if (c !== "\\") {
      out += c;
      continue;
    }
    const n = raw[++i];
    if (n === undefined) return undefined;
    const simple: Record<string, string> = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", v: "\v", "'": "'", '"': '"', "\\": "\\", "/": "/" };
    if (n in simple) out += simple[n]!;
    else if (n === "x") {
      const h = raw.slice(i + 1, i + 3);
      if (!/^[0-9a-fA-F]{2}$/.test(h)) return undefined;
      out += String.fromCharCode(parseInt(h, 16));
      i += 2;
    } else if (n === "u") {
      const m = /^(?:\{([0-9a-fA-F]{1,6})\}|([0-9a-fA-F]{4}))/.exec(raw.slice(i + 1));
      if (!m) return undefined;
      const cp = parseInt((m[1] ?? m[2])!, 16);
      if (cp > 0x10ffff) return undefined;
      out += String.fromCodePoint(cp);
      i += m[0].length;
    } else if (/[0-9\r\n\u2028\u2029]/.test(n)) return undefined;
    else out += n;
  }
  return out;
}

function followLoads(ctx: Ctx, key: string, text: string): void {
  try {
    followLoadsScan(ctx, key, text);
  } catch {
    scannerFaults++;
    fail(ctx, "scanner fault");
  }
}
function followLoadsScan(ctx: Ctx, key: string, text: string): void {
  for (const m of (codeOnly(text, [], true) ?? text).matchAll(new RegExp(LITERAL_LOAD.source, "g"))) {
    if (ctx.hold) return;
    let spec = m[2] || m[4] || m[6] || "";
    if (spec.includes("\\")) {
      const decoded = decodeJsString(spec);
      if (decoded === undefined) {
        fail(ctx, "unresolved: path");
        return;
      }
      spec = decoded;
    }
    if (spec.startsWith(".")) {
      const logical = relFrom(key, spec);
      if (logical) addLogical(ctx, logical);
      continue;
    }
    const root = resolveBundledRoot(ctx, key, spec);
    if (root) addBundled(ctx, root);
  }
}

// `helper` and `@scope/pkg` and their subpaths. Relative and node: specs are not bundled.
function bundledName(spec: string): string | undefined {
  if (!spec || spec.startsWith(".") || spec.startsWith("/") || spec.startsWith("node:") || spec.includes("..") || spec.includes("\\")) return undefined;
  const parts = spec.split("/");
  if (parts[0]!.startsWith("@")) {
    if (!parts[1]) return undefined;
    return `${parts[0]}/${parts[1]}`;
  }
  return parts[0] || undefined;
}

function bundledExists(ctx: Ctx, root: string): boolean {
  const prefix = `${root}/`;
  for (const logical of ctx.logical.keys()) {
    if (logical === root || logical.startsWith(prefix)) return true;
  }
  return false;
}

// Node walks node_modules from the requiring file upward. The first directory that exists is the package.
function resolveBundledRoot(ctx: Ctx, fromKey: string, spec: string): string | undefined {
  const name = bundledName(spec);
  if (!name) return undefined;
  let dir = fromKey.includes("/") ? fromKey.slice(0, fromKey.lastIndexOf("/")) : "";
  for (;;) {
    const root = dir ? `${dir}/node_modules/${name}` : `node_modules/${name}`;
    if (bundledExists(ctx, root)) return root;
    if (!dir) return undefined;
    const slash = dir.lastIndexOf("/");
    dir = slash < 0 ? "" : dir.slice(0, slash);
  }
}

function addBundled(ctx: Ctx, root: string): void {
  // Resolve the package entry so a dangerous file there still widens the package.
  addLogical(ctx, root);
  const prefix = `${root}/`;
  for (const [logical, key] of ctx.logical) {
    if (logical !== root && !logical.startsWith(prefix)) continue;
    if (isManifest(logical) || omitInert(ctx, logical)) continue;
    ctx.files.add(key);
    if (ctx.fromGyp) ctx.gypFiles.add(key);
  }
}

// Literal loads the precise walk already follows, plus the modeled config require.
// Between a keyword and its string: none at all is valid (from"x"). Comments are taken out of the text first (codeOnly in
// keep mode), so whitespace is the only gap left; no pattern here ever scans a comment.
const GAP = String.raw`\s`;
const LITERAL_LOAD = new RegExp(
  String.raw`(?:\brequire|\bimport)\s*\(\s*(['"])([^'"]+)\1\s*\)|\bfrom${GAP}*(['"])([^'"]+)\3|\bimport${GAP}*(['"])([^'"]+)\5`,
  "g",
);
// Anything still able to name a file. module.exports is removed first; it is the static CJS assignment.
const UNSAFE_JS = /\brequire\b|import\s*\(|\bmodule\b|\bFunction\b|\beval\b|\bWorker\b|\bvm\b|\bprocess\.binding\b|\bdlopen\b|\b(?:globalThis|global|window)\s*\[|\bconstructor\b|\bReflect\b|\bProxy\b/;
// child_process only counts as the name of a module being loaded; the word inside a message does not.
// A load of the process module by name, in any shape.
const LOADS_PROCESS = /(?:\brequire\s*\(|\brequire\s*\.\s*resolve\s*\(|\bimport\s*\(|\bfrom|\bimport)\s*(['"`])(?:node:)?process\1/;
const DANGEROUS_KEY = /^(?:constructor|getBuiltinModule|mainModule|_?linkedBinding|createRequire|prepareStackTrace|getThis|getFunction)$/;
// The value of a key made only of string literals, template literals of literals, + and parentheses; undefined for anything else.
function pureLiteralKey(key: string): string | undefined {
  let i = 0;
  let out = "";
  const ws = () => { while (i < key.length && /[\s()]/.test(key[i]!)) i++; };
  for (;;) {
    ws();
    const m = /^(?:"([^"\\\n]*)"|'([^'\\\n]*)'|`((?:[^`\\$]|\$(?!\{)|\$\{\s*(?:"[^"\\\n]*"|'[^'\\\n]*')\s*\})*)`)/.exec(key.slice(i));
    if (!m) return undefined;
    out += (m[1] ?? m[2] ?? m[3] ?? "").replace(/\$\{\s*(?:"([^"]*)"|'([^']*)')\s*\}/g, (_x, a: string | undefined, b: string | undefined) => a ?? b ?? "");
    i += m[0].length;
    ws();
    if (i >= key.length) return out;
    if (key[i] !== "+") return undefined;
    i++;
  }
}
// True when the file holds a string whose value is a property name reaching Function or a loader, in any position a value can
// take (a computed key, a binding, an array element, an argument, a returned or conditional value). Escapes are decoded.
// A comparison (key === "constructor"), a case label, the left side of in and an object key are guards or names, not uses.
// Names of variables that steer the next process. The strong ones are refused as keys and entries anywhere; PATH and ENV only
// as members of process.env (an object key named ENV or PATH is an ordinary option). Case does not matter (Windows).
const STEERING_STRONG_RE = /^(?:NODE_OPTIONS|NODE_PATH|LD_PRELOAD|DYLD_INSERT_LIBRARIES|DYLD_LIBRARY_PATH|BASH_ENV|PYTHONPATH|PYTHONSTARTUP|PERL5OPT|PERL5LIB|RUBYOPT|RUBYLIB|NODE_EXTRA_CA_CERTS|npm_config_.*)$/i;
const STEERING_NAME = { test: (v: string) => STEERING_STRONG_RE.test(v) };
// True when the object literal that holds position "at" spreads process.env or is the value of an env key: PATH and ENV
// steer the next process there.
function envObjectLiteral(code: string, at: number, raw?: string): boolean {
  const chain = bracketChain(code, at);
  const top = chain[0];
  if (top && top[0] < 0) return true;
  if (!top || code[top[0]] !== "{") return false;
  const memo = bracketIndex(code).memo;
  const spreadKey = "s" + top[0];
  let spreads = memo.get(spreadKey);
  if (spreads === undefined) {
    spreads = /\.\.\.\s*process\s*(?:\?\.|\.)\s*env(?![\w$])/.test(code.slice(top[0], top[1] + 1));
    memo.set(spreadKey, spreads);
  }
  if (spreads) return true;
  const [t1, t1At] = prevTok(code, top[0]);
  if (t1 === ":") {
    const k = prevTok(code, t1At)[0];
    // A quoted key is blanked in the scan: the raw text tells whether it is "env".
    return k === "env" || (raw !== undefined && /(['"])env\1\s*$/.test(raw.slice(0, t1At))) || (raw === undefined && /^["']$/.test(k));
  }
  // opts.env = { ... } and Object.assign({}, process.env, { ... }).
  // opts.env = { ... } and the compound forms (||=, ??=, &&=).
  if (t1 === "=") {
    let [k, kAt] = prevTok(code, t1At);
    while (k === "|" || k === "?" || k === "&") [k, kAt] = prevTok(code, kAt);
    if (k === "env") return true;
  }
  const outer = chain[1];
  if (outer === undefined || outer[0] < 0 || code[outer[0]] !== "(") return false;
  const callKey = "c" + outer[0];
  let handles = memo.get(callKey);
  if (handles === undefined) {
    handles = /(?:^|[^\w$.]|\.\.\.)process\s*(?:\?\.|\.)\s*env(?![\w$])/.test(code.slice(outer[0], outer[1] + 1));
    memo.set(callKey, handles);
  }
  return handles;
}
const STATEMENT_KEYWORDS = new Set(["await", "yield", "return", "export", "default", "case", "throw", "typeof", "void", "new", "delete", "in", "of", "else", "do", "instanceof", "extends"]);

// The kept text with strings, regular expressions and template text blanked, so brackets can be matched.
function maskSpans(out: string, spans: SpanNote[]): string {
  const parts: string[] = [];
  let at = 0;
  for (const s of [...spans].sort((x, y) => x.at - y.at)) {
    parts.push(out.slice(at, s.at), " ".repeat(s.len));
    at = s.at + s.len;
  }
  parts.push(out.slice(at));
  return parts.join("");
}

// True when the brace or bracket that holds "at" is a destructuring pattern, not an object or array literal: it follows const,
// let or var, it is closed by = or of or in, or it is a parameter or a catch binding. Unmatched brackets count as a pattern.
function inPattern(code: string, at: number): boolean {
  const chain = bracketChain(code, at);
  if (chain.length === 0 || code[chain[0]![0]] === "(") return false;
  if (chain.some((e) => e[0] === -1)) return true;
  let top = chain[0]!;
  let next = 1;
  // Climb while the bracket is the value or element of the one around it ({ k: { ... } }, [{ ... }]).
  const prevChar = (o: number) => {
    let p = o;
    while (p > 0 && /\s/.test(code[p - 1]!)) p--;
    return p > 0 ? code[p - 1]! : "";
  };
  for (; next < chain.length; next++) {
    const e = chain[next]!;
    if (code[e[0]] === "(" || !/[:,\[{]/.test(prevChar(top[0]))) break;
    top = e;
  }
  if (top[1] >= code.length) return true;
  let p = top[0];
  while (p > 0 && /\s/.test(code[p - 1]!)) p--;
  if (/(?<![\w$.])(?:const|let|var)$/.test(code.slice(Math.max(0, p - 6), p))) return true;
  if (/^(?:=(?![=>])|of(?![\w$])|in(?![\w$]))/.test(codeAfter(code, top[1] + 1, 8))) return true;
  const paren = chain[next];
  if (paren && code[paren[0]] === "(") {
    const closer = codeAfter(code, paren[1] + 1, 5);
    if (/^=>/.test(closer)) return true;
    // A brace after the parenthesis is a function body (a parameter list) unless the keyword makes it a condition.
    if (/^\{/.test(closer)) {
      let p = paren[0];
      while (p > 0 && /\s/.test(code[p - 1]!)) p--;
      if (!/(?<![\w$.])(?:if|while|for|switch|with)$/.test(code.slice(Math.max(0, p - 8), p))) return true;
    }
  }
  return false;
}

// True when the file holds a string whose value is a property name reaching Function or a loader, in any position a value can
// take (a computed key, a binding, an array element, an argument, a returned or conditional value). Escapes are decoded.
// A comparison (key === "constructor"), a case label, the left side of in and a key of an object literal are guards or names,
// not uses; the key of a destructuring pattern binds the property and is one. A string that names a variable that steers the
// next process (NODE_OPTIONS, PATH, ...) as a key of an object is a use too.
function dangerousStringUse(source: string): boolean {
  const spans: SpanNote[] = [];
  const out = codeOnly(source, [], true, spans);
  if (out === undefined) return false;
  const masked = maskSpans(out, spans);
  for (const s of spans) {
    if (s.mask) continue;
    const v = s.raw.includes("\\") ? decodeJsString(s.raw) : s.raw;
    if (v === undefined) continue;
    const danger = DANGEROUS_KEY.test(v);
    const steering = STEERING_NAME.test(v);
    if (!danger && !steering && !/^(?:PATH|Path|ENV)$/.test(v)) continue;
    let q = s.at;
    while (q > 0 && /\s/.test(masked[q - 1]!)) q--;
    const before = masked.slice(Math.max(0, q - 12), q);
    const after = codeAfter(masked, s.at + s.len, 40);
    const key = (q === 0 || /[{,]$/.test(before)) && after.startsWith(":");
    if (!steering && !danger) {
      if (key && /[{,]$/.test(before) && envObjectLiteral(masked, s.at, out)) return true;
      // An entries pair ["PATH", dir] in a file that handles the environment.
      if (/\[$/.test(before) && after.startsWith(",") && !/[\w$)\]]/.test(prevTok(masked, q - 1)[0]) && /(?:^|[^\w$.]|\.\.\.)process\s*(?:\?\.|\.)\s*env(?![\w$])/.test(masked)) return true;
      continue;
    }
    if (steering && !danger) {
      if (key && /[{,]$/.test(before)) return true;
      // The first element of an array literal ([["NODE_OPTIONS", v]] for Object.fromEntries) names an entry the same way.
      if (/\[$/.test(before) && after.startsWith(",") && !/[\w$)\]]/.test(masked.slice(Math.max(0, q - 14), q - 1).trimEnd().slice(-1))) return true;
      // A computed key ({ ["NODE_OPTIONS"]: x }) and an index that is written (env["NODE_OPTIONS"] = x).
      if (/\[$/.test(before) && after.startsWith("]")) {
        const next = codeAfter(masked, s.at + s.len + masked.slice(s.at + s.len).indexOf("]") + 1, 3);
        if (/^:/.test(next) || /^(?:\|\||&&|\?\?|\*\*|>>>|<<|>>|[-+*\/%&|^])?=(?![=>])/.test(next)) return true;
      }
      continue;
    }
    if (/[!=]==?$/.test(before) || /^[!=]==?/.test(after)) continue;
    if (/(?:^|[^\w$.])case$/.test(before) || /^in(?![\w$])/.test(after)) continue;
    if (key && !inPattern(masked, s.at)) continue;
    return true;
  }
  return false;
}
// True when a bracket expression is only literals and spells a dangerous property name.
function dangerousLiteralKey(keep: string): boolean {
  for (const m of keep.matchAll(/\[((?:"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`[^`]*`|[^\]\["'`])*)\]/g)) {
    const v = pureLiteralKey(m[1]!);
    if (v !== undefined && DANGEROUS_KEY.test(v)) return true;
  }
  return false;
}
const LOADS_CHILD_PROCESS = /(?:\brequire\s*\(|\bimport\s*\(|\bfrom|\bimport)\s*['"](?:node:)?(?:child_process|vm|module|worker_threads)\b/;
// The plain reads of the process object, or of a name for the process module, a static file may make. Any other use (an
// alias, a computed member, binding, getBuiltinModule, mainModule, an argument to a call) can reach a loader or a native
// module, so it is not static; the loader words and a bare or computed use also widen the closure to the whole package.
const PROCESS_LOADER_WORDS = /\b(?:getBuiltinModule|mainModule|_?linkedBinding|prepareStackTrace|getThis|getFunction)\b|\.\s*binding\b/;
const PROCESS_READ = "(?:env\\s*(?:\\?\\.|\\.)\\s*[A-Za-z_$][\\w$]*|platform\\b|arch\\b|(?:version\\b|versions\\b(?:\\s*(?:\\?\\.|\\.)\\s*[A-Za-z_$][\\w$]*)?)|argv\\b|title\\b|cwd\\s*\\(\\s*\\)|exit\\s*\\(|exitCode\\b|std(?:out|err)\\s*\\.\\s*write\\s*\\()";
// `const p = require("process")` or `import p from "node:process"`: the only loads of the process module that stay static.
const PROCESS_ALIAS = new RegExp(
  String.raw`\b(?:(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*require\(\s*(['"])(?:node:)?process\2\s*\)|import(?:${GAP}+|(?=\*))(?:\*${GAP}*as${GAP}+)?([A-Za-z_$][\w$]*)${GAP}+from${GAP}*(['"])(?:node:)?process\4)\s*;?`,
  "g",
);

// A static file may require these. Any other bare builtin is unsafe, so the load stays in the text.
const STATIC_BUILTINS = new Set(["fs", "path", "os", "util", "events", "assert", "url", "crypto", "stream", "zlib", "buffer"]);
const NODE_BUILTINS = new Set([
  ...STATIC_BUILTINS,
  "async_hooks", "child_process", "cluster", "console", "constants", "dgram", "diagnostics_channel",
  "dns", "domain", "http", "http2", "https", "inspector", "module", "net", "perf_hooks", "process",
  "punycode", "querystring", "readline", "repl", "sqlite", "string_decoder", "sys", "test", "timers",
  "tls", "trace_events", "tty", "v8", "vm", "wasi", "worker_threads",
]);

function builtinRoot(spec: string): string | undefined {
  if (!spec || spec.startsWith(".") || spec.startsWith("/") || spec.includes("\\")) return undefined;
  let name = spec.startsWith("node:") ? spec.slice(5) : spec;
  const cut = name.indexOf("/");
  if (cut >= 0) name = name.slice(0, cut);
  return name || undefined;
}

// Relative loads and package names are followed elsewhere. An allowlisted builtin is data.
// Any other node builtin can run code, so that require is left for UNSAFE_JS.
/** The module a literal load names once its escapes are read, or undefined when they cannot be. */
function loadedSpec(raw: string): string | undefined {
  return raw.includes("\\") ? decodeJsString(raw) : raw;
}

function stripLiteralLoad(raw: string): boolean {
  let spec = raw;
  if (spec.includes("\\")) {
    const decoded = decodeJsString(spec);
    if (decoded === undefined) return false;
    spec = decoded;
  }
  if (spec.startsWith(".") || spec.startsWith("/")) return true;
  const root = builtinRoot(spec);
  if (!root) return true;
  if (STATIC_BUILTINS.has(root)) return true;
  // A node: name that is not on the allowlist is a builtin too, including one this list does not know yet.
  if (spec.startsWith("node:")) return false;
  return !NODE_BUILTINS.has(root);
}

// One predicate for JS. A file that fails it widens by the shape of its computed loads.
// A name for the process module is a whole statement: when the next token continues the expression (a member, a call,
// a computed member, a ? or a template), the load is not a plain name and is left in the text.
// The index of the first character at or after "from" that is not whitespace or a comment.
function skipTrivia(whole: string, from: number): number {
  let i = from;
  for (;;) {
    while (i < whole.length && /\s/.test(whole[i]!)) i++;
    if (whole.startsWith("//", i)) {
      while (i < whole.length && !/[\n\r\u2028\u2029]/.test(whole[i]!)) i++;
    } else if (whole.startsWith("/*", i)) {
      const end = whole.indexOf("*/", i + 2);
      i = end < 0 ? whole.length : end + 2;
    } else return i;
  }
}

function stripProcessAliases(text: string, aliases: string[]): string {
  return text.replace(PROCESS_ALIAS, (m, a1, _q, a2, _q4, at: number, whole: string) => {
    const i = skipTrivia(whole, at + m.length);
    if (whole.startsWith("<!--", i) || whole.startsWith("-->", i)) return m;
    if (i < whole.length && ".[(?`".includes(whole[i]!)) return m;
    aliases.push(String(a1 || a2));
    // An import declaration is a statement; a const statement without ; continues as an expression after its ) and is a
    // name. The second scan is safe only because the first scan, on the original text, refuses every ambiguous span.
    return removedText(a1 === undefined || m.trimEnd().endsWith(";"), m.slice(m.trimEnd().length));
  });
}

/** Keywords after which a / starts a regular expression; none of these can be a name. */
const KEYWORD_REGEX = new Set(["return", "typeof", "case", "delete", "void", "throw", "new", "else", "do", "instanceof", "in", "default", "extends"]);
/** Words after which a statement may end at a line break, so a / on the next line can start a regular expression. */
const LINE_END_WORDS = new Set(["break", "continue", "debugger"]);
/** Words that are keywords in some positions and names in others: a / after one is read once, with the span check. */
const KEYWORD_MAYBE = new Set(["yield", "await", "of"]);
// Sticky, so a token is matched in place and the text is never copied.
const TOK_PRIVATE = /#[A-Za-z_$][\w$]*/y;
const TOK_WORD = /(?:[A-Za-z_$][\w$]*|[^\x00-\x7f]+)/y;
const TOK_NUMBER = /(?:0[xXbBoO][0-9a-fA-F_]*n?|\d[\d_]*(?:\.(?!\.)\d*)?(?:[eE][+-]?\d+)?n?)/y;
const TOK_PUNCT = /(?:\.\.\.|\+\+|--|\?\.(?!\d))/y;

/** Words a span read as a regular expression must not hold: with the process names they are what the checks look for. */
const DANGER_WORDS = ["require", "eval", "Function", "module", "import", "vm", "Worker", "process", "globalThis", "global", "Reflect", "Proxy", "constructor", "child_process", "dlopen", "exports"];

/**
 * The code of a JavaScript file with string and template text, regular-expression bodies and comments blanked, or
 * undefined when the scan ends inside one of them or cannot tell a regular expression from a division. Whether a / opens a
 * regular expression is decided from the previous token this scan emitted, never from the source text before it: text
 * inside a string, template or regular expression is not a token.
 */
const TEMPLATE_LITERAL = /(?:[^`\\$\n]|\$(?!\{)|\$\{\s*(?:"[^"\\\n]*"|'[^'\\\n]*')\s*\})*`/y;

// A span of the kept text: a string (raw is its text) or text to blank when brackets are matched (a regular expression, template text).
type SpanNote = { raw: string; at: number; len: number; mask?: boolean };
function codeOnly(text: string, watch: string[] = [], keep = false, strings?: SpanNote[]): string | undefined {
  type Tok = { k: "word" | "num" | "str" | "tpl" | "regex" | "punct" | "priv"; t: string };
  let out = "";
  let t1: Tok | undefined;
  let t2: Tok | undefined;
  let atLineStart = true; // only whitespace or comments since the last line break
  let nlSince = false; // a line break since the last token
  const push = (k: Tok["k"], t: string) => {
    t2 = t1;
    t1 = { k, t };
    atLineStart = false;
    nlSince = false;
  };
  const braces: boolean[] = [];
  let i = 0;
  const n = text.length;
  const names = [...DANGER_WORDS, ...KEYWORD_REGEX, ...KEYWORD_MAYBE, ...watch].map((w) => w.replace(/\$/g, "\\$&"));
  const danger = new RegExp(`['"\`\\\\\\u0080-\\uffff(){}\\[\\]]|(?<![\\w$])(?:${names.join("|")})(?![\\w$])|<!--|-->`);
  const eol = (c: string | undefined) => c === "\n" || c === "\r" || c === "\u2028" || c === "\u2029";
  let opened = false;
  const template = (st: number): boolean => {
    opened = false;
    for (; i < n; i++) {
      const c = text[i]!;
      if (c === "\\") i++;
      else if (c === "`") {
        i++;
        // A closing backtick leaves "" so the tokens on either side of a template never join in the output.
        // A template that opens here and holds no substitution is one plain string, whose escapes are read like a quoted one.
        if (text[st] === "`") strings?.push({ raw: text.slice(st + 1, i - 1), at: out.length, len: i - st });
        else strings?.push({ raw: "", at: out.length, len: i - st, mask: true });
        out += keep ? text.slice(st, i) : '""';
        return true;
      } else if (c === "$" && text[i + 1] === "{") {
        i += 2;
        braces.push(true);
        strings?.push({ raw: "", at: out.length, len: i - st - 2, mask: true });
        out += keep ? text.slice(st, i) : " `${";
        opened = true;
        return true;
      }
    }
    return false;
  };
  const afterTemplate = (st: number): boolean => {
    if (!template(st)) return false;
    if (opened) push("punct", "{");
    else push("tpl", "");
    return true;
  };
  // The end of a regular expression body that starts after the / at "at", or -1.
  const regexEnd = (at: number): number => {
    let cls = false;
    for (let j = at + 1; j < n && !eol(text[j]); j++) {
      const d = text[j]!;
      if (d === "\\") j++;
      else if (d === "[") cls = true;
      else if (d === "]") cls = false;
      else if (d === "/" && !cls) return j;
    }
    return -1;
  };
  // A span ends in a name or a number. The keyword exclusion is defense in depth: a keyword is also in "danger", so a span
  // ending in one is already refused.
  const endsInOperand = (span: string): boolean => {
    const m = /([A-Za-z_$][\w$]*|\d[\w.]*)\s*$/.exec(span);
    return m !== null && !KEYWORD_REGEX.has(m[1]!) && !KEYWORD_MAYBE.has(m[1]!);
  };
  // What follows a closing / must not be a name, a flag, a number or another / : only the end of an expression.
  const closesCleanly = (at: number): boolean => {
    let q = at;
    while (q < n && /\s/.test(text[q]!)) q++;
    return q >= n || ").;,]}".includes(text[q]!);
  };
  // "regex" or "div" when the previous token settles it, "amb" when a / could be either.
  const slashKind = (): "regex" | "div" | "amb" => {
    if (!t1) return "regex";
    if (t1.k === "punct") {
      if (t1.t === ")" || t1.t === "}" || t1.t === "++" || t1.t === "--") return "amb";
      return t1.t === "]" ? "div" : "regex";
    }
    if (t1.k !== "word") return "div";
    if (t2 && t2.k === "punct" && (t2.t === "." || t2.t === "?.")) return "div";
    // break, continue and debugger end a statement at a line break, so a / on the next line starts a regular expression.
    if (nlSince && (LINE_END_WORDS.has(t1.t) || (t2 && t2.k === "word" && (t2.t === "break" || t2.t === "continue")))) return "amb";
    if (KEYWORD_REGEX.has(t1.t)) return "regex";
    return KEYWORD_MAYBE.has(t1.t) ? "amb" : "div";
  };
  if (text.startsWith("#!")) while (i < n && !eol(text[i])) i++;
  while (i < n) {
    const c = text[i]!;
    if (/\s/.test(c)) {
      out += c;
      if (eol(c)) {
        atLineStart = true;
        nlSince = true;
      }
      i++;
    } else if (c === "'" || c === '"') {
      const st = i;
      i++;
      for (; i < n && text[i] !== c && !eol(text[i]); i++) if (text[i] === "\\") i++;
      if (text[i] !== c) return undefined;
      i++;
      strings?.push({ raw: text.slice(st + 1, i - 1), at: out.length, len: i - st });
      out += keep ? text.slice(st, i) : '""';
      push("str", "");
    } else if (c === "`") {
      const st = i;
      i++;
      // A template made only of text and ${"literal"} is a plain string (require(`process`)). A tagged one is a call: not changed.
      TEMPLATE_LITERAL.lastIndex = i;
      const lit = TEMPLATE_LITERAL.exec(text);
      if (lit && !/[\w$)\]]\s*$/.test(out)) {
        const value = lit[0].slice(0, -1).replace(/\$\{\s*(?:"([^"]*)"|'([^']*)')\s*\}/g, (_m, a: string | undefined, b: string | undefined) => a ?? b ?? "");
        if (!/["\\\n\r\u2028\u2029]/.test(value)) {
          i += lit[0].length;
          strings?.push({ raw: value, at: out.length, len: value.length + 2 });
          out += keep ? `"${value}"` : '""';
          push("str", "");
          continue;
        }
      }
      if (!afterTemplate(st)) return undefined;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < n && !eol(text[i])) i++;
    } else if (c === "/" && text[i + 1] === "*") {
      const e = text.indexOf("*/", i + 2);
      if (e < 0) return undefined;
      const multi = /[\n\r\u2028\u2029]/.test(text.slice(i, e));
      out += multi ? "\n" : " ";
      if (multi) {
        atLineStart = true;
        nlSince = true;
      }
      i = e + 2;
    } else if (c === "/") {
      const kind = slashKind();
      const end = kind === "div" ? -1 : regexEnd(i);
      if (kind === "regex" && end < 0) return undefined;
      // Both readings must see the same names: the span holds none, and what follows the closing / is not a name,
      // a flag or another / that could start a comment.
      // Read as a division, the closing / must also divide: the span has to end in a name or a number (a bracket in a span is refused above),
      // or the two readings would fall out of step. Read as a regex, what follows must end an expression.
      if (kind === "amb" && end >= 0) {
        const span = text.slice(i + 1, end);
        if (danger.test(span) || !endsInOperand(span) || !closesCleanly(end + 1)) return undefined;
      }
      if (end >= 0) {
        if (keep) {
          strings?.push({ raw: "", at: out.length, len: end + 1 - i, mask: true });
          out += text.slice(i, end + 1);
        }
        i = end + 1;
        if (!keep) out += "/0/"; // a body no identifier can match: a regex literal is never a name
        push("regex", "");
      } else {
        out += "/";
        i++;
        push("punct", "/");
      }
    } else {
      if (c === "<" && text.startsWith("<!--", i)) return undefined;
      if (c === "-" && atLineStart && text.startsWith("-->", i)) return undefined;
      if (c === "}") {
        const tpl = braces.pop();
        if (tpl) {
          i++;
          out += "}";
          if (!afterTemplate(i)) return undefined;
          continue;
        }
      }
      if (c === "{") braces.push(false);
      let tok: string;
      let m: RegExpExecArray | null;
      const at = (re: RegExp): RegExpExecArray | null => {
        re.lastIndex = i;
        return re.exec(text);
      };
      if ((m = at(TOK_PRIVATE))) {
        tok = m[0];
        push("priv", tok);
      } else if ((m = at(TOK_WORD))) {
        tok = m[0];
        push("word", tok);
      } else if ((m = at(TOK_NUMBER))) {
        // A dot ends a number literal only after plain decimal digits (1. in x); after 0x10, 1e3, 1n or 07 it is a property dot.
        tok = m[0];
        // 0[0-7]+ is a legacy octal literal (the dot after it is a property dot); a leading-zero literal with an 8 or 9 is decimal.
        if (/^0[0-7]+\./.test(tok)) tok = tok.slice(0, tok.indexOf("."));
        push("num", tok);
      } else if ((m = at(TOK_PUNCT))) {
        tok = m[0];
        push("punct", tok);
      } else {
        tok = c;
        push("punct", tok);
      }
      out += tok;
      i += tok.length;
    }
  }
  // An open template interpolation or brace at the end is a file Bun rejects: not static, like any unterminated span.
  if (braces.length > 0) return undefined;
  return out;
}

// A backslash or a non-ASCII character in code can spell or hide a name (an escaped identifier, a no-break space), and no
// test below would see it. The file is not static; text inside strings and comments does not count.
function hidesNames(code: string | undefined): boolean {
  return code === undefined || /[^\x00-\x7f\\]|\\/.test(code);
}

// Stands in for text the second scan removed: a plain identifier, so a . after it stays a property dot and the token
// before what follows is a name, never a number or a keyword.
const REMOVED = "__removed_text__";

/**
 * What the second scan sees where text was removed. A removed expression (a require call, a plain load) is a name; a removed
 * statement (an import declaration, an alias statement ending in ;) is a name and a ; so a / after it opens a regular
 * expression as it does after a real statement. Whitespace the match took is put back, and a space always follows, so the
 * placeholder never joins the next word.
 */
function removedText(statement: boolean, spaceAfter = ""): string {
  return `${REMOVED}${statement ? ";" : ""}${spaceAfter || " "}`;
}

// True when the previous non-whitespace character is a dot, however much whitespace lies between.
function dotBefore(text: string, at: number): boolean {
  let j = at;
  while (j > 0 && /\s/.test(text[j - 1]!)) j--;
  return j > 0 && text[j - 1] === ".";
}

const READ_AFTER = new RegExp(`\\s*(?:\\?\\.|\\.)\\s*${PROCESS_READ}`, "y");
// Reads of the global object that cannot reach process or a loader.
const HARMLESS_GLOBAL = /^\s*(?:\?\.|\.)\s*(?:crypto|document|window|location|localStorage|sessionStorage|atob|btoa|isNaN|parseInt|parseFloat|encodeURIComponent|decodeURIComponent|addEventListener|setTimeout|setInterval|setImmediate|clearTimeout|clearInterval|clearImmediate|queueMicrotask|console|URL|URLSearchParams|TextEncoder|TextDecoder|performance|navigator|fetch|structuredClone|Promise|Symbol|JSON|Math|Date|Array|Object|AbortController|AbortSignal|Intl|Event|EventTarget|Blob|File|FormData|Headers|Request|Response|ReadableStream|WritableStream|TransformStream|Map|Set|WeakMap|WeakSet|WeakRef|FinalizationRegistry|BigInt|Number|String|Boolean|RegExp|Buffer|Uint8Array|Int32Array|Float64Array|ArrayBuffer|DataView)\b/;
// Members of process that run no code the file does not show and hand out no loader.
const HARMLESS_MEMBER = /^\s*\.\s*(?:env|report|features|version|versions|argv|exitCode|cwd|nextTick|hrtime|memoryUsage|cpuUsage|uptime|umask|emitWarning|on|once|off|emit|addListener|removeListener|stdout|stderr|stdin|title|pid|ppid|execPath|execArgv|argv0|release|getuid|getgid|geteuid|getegid|getgroups|platform|arch)\b/;
const MEMBER_AFTER = /\s*\.\s*[A-Za-z_$][\w$]*/y;
const SAFE_SUFFIX = /\.\s*(?:length\b|(?:slice|split|includes|startsWith|endsWith|indexOf|toString|toLowerCase|toUpperCase|trim|join|forEach|map|filter|some|every|find|replace)\s*\()/y;
// env is not here: it binds the live environment object to a name the scan does not follow.
const DESTRUCTURE_OK = "(?:platform|arch|versions?|argv|cwd|exit|exitCode)(?![\\w$])";

// True when the expression that starts at "i" (right after an allowlisted read) ends there: the next token is not a member,
// a call, a template or an optional chain. A few string and array methods and a numeric index are read through.
// A write through a read is harmless only for exitCode, title and an environment variable that does not steer the next run.
const STEERING_ENV = { test: (v: string) => STEERING_NAME.test(v) || /^(?:path|env)$/i.test(v) };
function harmlessTarget(target: string | undefined): boolean {
  if (target === undefined) return false;
  if (/^\s*(?:\?\.|\.)\s*(?:exitCode|title)$/.test(target)) return true;
  const env = /^\s*(?:\?\.|\.)\s*env\s*(?:\?\.|\.)\s*([A-Za-z_$][\w$]*)$/.exec(target);
  return env !== null && !STEERING_ENV.test(env[1]!);
}
// True when the expression at "at" starts a statement: after ; { } or the start, or after a line break that ends the previous one
// (an identifier, a literal or a closing bracket, never a keyword such as await, return, export default or else).
function stmtStartAt(code: string, j: number, at: number, prev: string): boolean {
  if (prev === "" || prev === ";" || prev === "{" || prev === "}") return true;
  if (!/[\n\r]/.test(code.slice(j, at)) || !/[\w$)\]"']/.test(prev)) return false;
  const word = /[A-Za-z_$][\w$]*$/.exec(code.slice(Math.max(0, j - 20), j));
  return !(word && STATEMENT_KEYWORDS.has(word[0]));
}
// True when the next token of a dropped statement (an event-handler call that ends a line) cannot continue the expression.
function statementEnds(code: string, at: number): boolean {
  const rest = code.slice(at);
  if (/^[ \t]*(?:;|\}|$)/.test(rest)) return true;
  const nl = /^[ \t]*\r?\n\s*/.exec(rest);
  if (!nl) return false;
  const next = rest[nl[0].length];
  return next === undefined || /[A-Za-z_$}{;"'\d]/.test(next);
}

// The "len" characters that follow position "at" after the white space, and the ones that precede "at" before the white space.
function codeAfter(code: string, at: number, len: number): string {
  let i = at;
  while (i < code.length && /\s/.test(code[i]!)) i++;
  return code.slice(i, i + len);
}
function codeBefore(code: string, at: number, len: number): string {
  let i = at;
  while (i > 0 && /\s/.test(code[i - 1]!)) i--;
  return code.slice(Math.max(0, i - len), i);
}
// The last token before position "at", skipping white space without limit: [token, index where it starts].
function prevTok(code: string, at: number): [string, number] {
  let q = at;
  while (q > 0 && /\s/.test(code[q - 1]!)) q--;
  if (q === 0) return ["", 0];
  const word = /[A-Za-z_$][\w$]*$|\d[\w.]*$/.exec(code.slice(Math.max(0, q - 64), q));
  if (word) return [word[0], q - word[0].length];
  const op = /(?:\.\.\.|\+\+|--|=>|\?\.)$/.exec(code.slice(Math.max(0, q - 3), q));
  if (op) return [op[0], q - op[0].length];
  return [code[q - 1]!, q - 1];
}
// One pass over a text gives, for every position, the innermost bracket around it, and each bracket's partner. Kept for the last few
// texts scanned, so the many lookups of one scan never walk the file again.
type BracketIndex = { inner: Int32Array; closer: Int32Array; opener: Int32Array; memo: Map<string, boolean>; mismatch: boolean };
const bracketCache: Array<{ code: string; idx: BracketIndex }> = [];
function bracketIndex(code: string): BracketIndex {
  for (const e of bracketCache) if (e.code === code) return e.idx;
  const inner = new Int32Array(code.length);
  const closer = new Int32Array(code.length).fill(-1);
  const opener = new Int32Array(code.length).fill(-1);
  const stack: number[] = [];
  let mismatch = false;
  for (let i = 0; i < code.length; i++) {
    inner[i] = stack.length > 0 ? stack[stack.length - 1]! : -1;
    const c = code[i]!;
    if (c === "(" || c === "[" || c === "{") stack.push(i);
    else if (c === ")" || c === "]" || c === "}") {
      const o = stack.pop();
      if (o === undefined || code[o] !== (c === ")" ? "(" : c === "]" ? "[" : "{")) mismatch = true;
      if (o !== undefined) {
        closer[o] = i;
        opener[i] = o;
      }
    }
  }
  if (stack.length > 0) mismatch = true;
  const idx: BracketIndex = { inner, closer, opener, memo: new Map(), mismatch };
  bracketCache.push({ code, idx });
  if (bracketCache.length > 4) bracketCache.shift();
  return idx;
}
const CHAIN_CAP = 64;
// The brackets that enclose a position, innermost first, as [opener, closer] pairs. A chain deeper than the cap ends in the
// pair [-1, length]: callers read it as "unknown" and take the cautious answer.
function bracketChain(code: string, at: number): Array<[number, number]> {
  const idx = bracketIndex(code);
  if (idx.mismatch) return [[-1, code.length]];
  const chain: Array<[number, number]> = [];
  let o = at >= 0 && at < code.length ? idx.inner[at]! : -1;
  while (o >= 0) {
    if (chain.length >= CHAIN_CAP) {
      chain.push([-1, code.length]);
      break;
    }
    chain.push([o, idx.closer[o]! >= 0 ? idx.closer[o]! : code.length]);
    o = idx.inner[o]!;
  }
  return chain;
}
function enclosingBrackets(code: string, at: number[]): Map<number, Array<[number, number]>> {
  const out = new Map<number, Array<[number, number]>>();
  for (const a of at) out.set(a, bracketChain(code, a));
  return out;
}

// True when a member of process at "at" (its chain ends at "end") is written other than by a plain assignment: a destructuring
// target, a for-in or for-of head, an operand of ++, -- or delete. The target rule then applies to the write.
function writtenOddly(code: string, at: number, end: number, around: Array<[number, number]>): { chain: string } | undefined {
  let chain = /^(?:\s*(?:\?\.|\.)\s*[A-Za-z_$][\w$]*)*/.exec(code.slice(end))![0];
  let after = end + chain.length;
  // An index after the chain (process.env[k]) names a key the file does not show.
  for (let guard = 0; guard < 4; guard++) {
    let k = after;
    while (k < code.length && /\s/.test(code[k]!)) k++;
    if (code[k] !== "[") break;
    const e = bracketIndex(code).closer[k]! >= 0 ? bracketIndex(code).closer[k]! : code.length;
    if (e >= code.length) return { chain: chain + "[]" };
    chain += "[]";
    after = e + 1;
  }
  // Parentheses around the target ([(process.env.X)] = v, delete (process.env.X)) are transparent.
  let a = at;
  let e = after;
  let arr = around;
  while (arr.length > 0 && code[arr[0]![0]] === "(" && prevTok(code, a)[1] === arr[0]![0] && codeAfter(code, e, 1) === ")" && code.indexOf(")", e) === arr[0]![1]) {
    a = arr[0]![0];
    e = arr[0]![1] + 1;
    arr = arr.slice(1);
  }
  const tail = codeAfter(code, e, 12);
  // ++ and -- before the member are prefix operators unless they end an expression on the same line (i++ then a line break).
  const [t1, t1At] = prevTok(code, a);
  let prefix = false;
  if (t1 === "++" || t1 === "--") {
    const [t0, t0At] = prevTok(code, t1At);
    prefix = !(/^[\w$]+$|^["'\]]$/.test(t0) && !STATEMENT_KEYWORDS.has(t0) && !/[\n\r]/.test(code.slice(t0At + t0.length, t1At)));
  }
  let d = t1;
  let dAt = t1At;
  while (d === "(") [d, dAt] = prevTok(code, dAt);
  if (/^(?:\+\+|--)/.test(tail) || prefix || d === "delete") return { chain };
  if (/^(?:of|in)(?![\w$])/.test(tail) && t1 === "(") {
    const [f1, f1At] = prevTok(code, t1At);
    if (f1 === "for" || (f1 === "await" && prevTok(code, f1At)[0] === "for")) return { chain };
  }
  // The member must be the target itself: an element of the pattern, not an index into another value (a[process.env.X]), a
  // computed key ([process.platform]: x) or a default initializer (x = process.cwd()) of another target.
  const inner = arr[0];
  if (!inner || code[inner[0]] === "(") return undefined;
  const sig = (from: number) => {
    let p = from;
    while (p > 0 && /\s/.test(code[p - 1]!)) p--;
    if (code.slice(0, p).endsWith("...")) {
      p -= 3;
      while (p > 0 && /\s/.test(code[p - 1]!)) p--;
    }
    return p > 0 ? code[p - 1]! : "";
  };
  const wordBefore = (o: number) => {
    let p = o;
    while (p > 0 && /\s/.test(code[p - 1]!)) p--;
    const w = /[A-Za-z_$][\w$]*$/.exec(code.slice(Math.max(0, p - 20), p));
    return w ? w[0] : "";
  };
  // An index follows an expression; a keyword (else, return, ...) before the bracket starts an array instead.
  const afterHeader = (o: number) => {
    let p = o;
    while (p > 0 && /\s/.test(code[p - 1]!)) p--;
    if (code[p - 1] !== ")") return false;
    const open = bracketIndex(code).opener[p - 1]!;
    return open >= 0 && /^(?:if|while|for|switch|with)$/.test(prevTok(code, open)[0]);
  };
  const indexes = (o: number) => /[\w$)\]]/.test(sig(o)) && !STATEMENT_KEYWORDS.has(wordBefore(o)) && !afterHeader(o);
  if (code[inner[0]] === "[" && indexes(inner[0])) return undefined;
  if (code[inner[0]] === "[" && /^:/.test(codeAfter(code, inner[1] + 1, 1))) return undefined;
  if (!/[\[,:{]/.test(sig(a))) return undefined;
  const nextSig = /^\s*(.)(.?)/.exec(code.slice(e));
  if (!nextSig || !(/[,\]}]/.test(nextSig[1]!) || (nextSig[1] === "=" && nextSig[2] !== "=" && nextSig[2] !== ">"))) return undefined;
  for (const [o, c] of arr) {
    if (o < 0) return { chain };
    if (code[o] === "(") continue;
    if (code[o] === "[" ? indexes(o) : sig(o) === "$") continue;
    if (/^(?:=(?![=>])|of(?![\w$])|in(?![\w$]))/.test(codeAfter(code, c + 1, 8))) return { chain };
  }
  return undefined;
}

// A bare process.env (the live object) is harmless only as a read that cannot keep it: a spread into a new object, an operand
// of typeof or in, or a destructuring that takes strings out of it. Bound, returned, passed on (to a spawn, to Object.keys,
// to any function) or held in an object, the live object can be written later through an alias the scan does not follow.
function bareEnvOk(code: string, at: number): boolean {
  let q = at;
  while (q > 0 && /\s/.test(code[q - 1]!)) q--;
  if (code.slice(0, q).endsWith("...")) return true;
  if (/(?:^|[^\w$.])(?:typeof|in)$/.test(code.slice(Math.max(0, q - 7), q))) return true;
  // const { PATH: p } = process.env copies strings out of it.
  return /(?<![\w$.])(?:const|let|var)\s*\{[^{}]*\}\s*=$/.test(code.slice(Math.max(0, q - 300), q));
}

function readEnds(code: string, start: number, lenient = false, target?: string): boolean {
  let i = start;
  let indexed = false;
  for (let guard = 0; guard < 64; guard++) {
    while (i < code.length && /\s/.test(code[i]!)) i++;
    const c = code[i];
    if (c === undefined) return true;
    if (c === "." && lenient) {
      // Widening only: a plain member or call chain is fine unless it reaches a constructor.
      const m = /^\.\s*([A-Za-z_$][\w$]*)/.exec(code.slice(i, i + 80));
      if (!m || m[1] === "constructor" || m[1] === "__proto__") return false;
      i += m[0].length;
      while (i < code.length && /\s/.test(code[i]!)) i++;
      if (code[i] === "(") {
        const args = argsOf(code, i);
        if (args === undefined) return false;
        i += args.length + 2;
      }
      continue;
    }
    if (c === "?" && code[i + 1] === "." && lenient && code[i + 2] === "(") {
      const args = argsOf(code, i + 2);
      if (args === undefined) return false;
      i += args.length + 4;
      continue;
    }
    if (c === "?" && code[i + 1] === "." && lenient && /[A-Za-z_$]/.test(code[i + 2] ?? "")) {
      i += 2;
      const m = /^[A-Za-z_$][\w$]*/.exec(code.slice(i, i + 80));
      if (!m || m[0] === "constructor" || m[0] === "__proto__") return false;
      i += m[0].length;
      continue;
    }
    if (c === ".") {
      // Pure string and array methods with no arguments or literal arguments only: a callback or any other argument can
      // hand the value to code that is not read here.
      const m = /^\.\s*(?:length\b|(?:toString|toLowerCase|toUpperCase|trim|split|slice|indexOf|startsWith|endsWith|includes|join)\s*\()/.exec(code.slice(i, i + 40));
      if (!m) return false;
      i += m[0].length;
      if (m[0].endsWith("(")) {
        const args = argsOf(code, i - 1);
        if (args === undefined || !/^\s*(?:(?:""|-?\d+)\s*(?:,\s*(?:""|-?\d+)\s*)*)?$/.test(args)) return false;
        i += args.length + 1;
      }
      continue;
    }
    if (c === "[") {
      // One index by a number or a plain name (process.argv[i]); a second index or a key built from strings is not read through.
      const m = /^\[\s*[\w$\s+\-*]+\]/.exec(code.slice(i, i + 40));
      if (!m || indexed) return false;
      indexed = true;
      i += m[0].length;
      continue;
    }
    // An assignment through a read, plain or compound (process.env.X = ..., process.env.X += ...): the target decides, not the right side.
    if (/^(?:\|\||&&|\?\?|\*\*|>>>|<<|>>|[-+*\/%&|^])=(?!=)/.test(code.slice(i, i + 4)) || (c === "=" && code[i + 1] !== "=" && code[i + 1] !== ">")) {
      return !indexed && harmlessTarget(target);
    }
    if (c === "(" || c === "`") return false;
    if (c === "?" && code[i + 1] === "." && !/[0-9]/.test(code[i + 2] ?? "")) return false;
    return true;
  }
  return false;
}

// Decides on the identifier, never on text near it. "code" has no strings or comments. True when any name in "names" (the
// process object, or a name for the process module) is used as anything but a complete allowlisted read: an alias, a
// computed member, a spread, a template or call argument, a returned or assigned value, a read followed by a chained
// call, or the bare global object. A property named like the name (x.process()), an object key (process: 1) and a method
// definition are not the object. A parameter or variable of that name is not told apart from the global: it counts.
function processValueUse(code: string, names: string[], lenient = false, strict = false): boolean {
  const alt = names.map((n) => n.replace(/\$/g, "\\$")).join("|");
  const L = "(?<![\\w$])(?<![^\\x00-\\x7f\\s])";
  const R = "(?![\\w$])(?![^\\x00-\\x7f\\s])";
  // The scan writes a template as a lone backtick and ${; argsOf would read the backtick as an open quote.
  let rest = code.replace(/`/g, " ");
  // A parameter list that only declares plain names binds them: the declaration is not a use (a use of it in the body still is).
  const id = "[A-Za-z_$][\\w$]*";
  const params = `\\(\\s*${id}(?:\\s*,\\s*${id})*\\s*\\)`;
  const declared = (list: string) => list.replace(new RegExp(`${L}(?:${alt})${R}`, "g"), "_");
  rest = rest.replace(new RegExp(`(?<![\\w$])(?<![^\\x00-\\x7f\\s])function(?![\\w$])\\s*\\*?\\s*(?:[A-Za-z_$][\\w$]*)?\\s*(${params})`, "g"), (m, p: string, at: number, whole: string) => {
    // A property (api. function(...)), an object key or a class field named function is not a declaration.
    let j = at;
    while (j > 0 && /\s/.test(whole[j - 1]!)) j--;
    if (whole[j - 1] === ".") return m;
    if (/^function\s*[:=,}]/.test(m)) return m;
    return m.slice(0, m.length - p.length) + declared(p);
  });
  rest = rest.replace(new RegExp(`(${params})(?=\\s*=>)`, "g"), (p: string) => declared(p));
  rest = rest.replace(/(?<![\w$.])(?<![^\x00-\x7f\s])(?:globalThis|global)\s*(?:\?\.|\.)\s*process(?![\w$])(?![^\x00-\x7f\s])/g, "process");
  // process taken out of the global object by a pattern or a spread.
  if (/\{[^{}]*(?<![\w$.])process(?![\w$])[^{}]*\}\s*=\s*(?:globalThis|global)(?![\w$])/.test(rest)) return true;
  // Destructuring of allowlisted members only.
  const member = DESTRUCTURE_OK;
  rest = rest.replace(
    new RegExp(`\\b(?:const|let|var)\\s*\\{\\s*${member}(?:\\s*,\\s*${member})*\\s*,?\\s*\\}\\s*=\\s*(?:${alt})${R}(?!\\s*[.\\[(?\`])`, "g"),
    " ",
  );
  const re = new RegExp(`${L}(?:${alt})${R}`, "g");
  // Object.assign(process.env, ...) and its relatives write through a bare argument.
  if (new RegExp(`(?<![\\w$.])(?:Object|Reflect)\\s*\\.\\s*(?:assign|defineProperty|defineProperties|set|deleteProperty|setPrototypeOf)\\s*\\(\\s*(?:${alt})${R}`).test(rest)) return true;
  const around = enclosingBrackets(rest, [...rest.matchAll(re)].map((x) => x.index ?? 0));
  for (const m of rest.matchAll(re)) {
    const at = m.index ?? 0;
    const end = at + m[0].length;
    {
      let q = at;
      while (q > 0 && /\s/.test(rest[q - 1]!)) q--;
      if (rest[q - 1] !== "." || rest.slice(0, q).endsWith("...")) {
        const w = writtenOddly(rest, at, end, around.get(at) ?? []);
        if (w && !harmlessTarget(w.chain)) return true;
      }
    }
    let j = at;
    while (j > 0 && /\s/.test(rest[j - 1]!)) j--;
    const prev = j > 0 ? rest[j - 1]! : "";
    if (prev === "." && !rest.slice(0, j).endsWith("...")) continue;
    READ_AFTER.lastIndex = end;
    const read = READ_AFTER.exec(rest);
    if (read) {
      let after = end + read[0].length;
      if (read[0].endsWith("(") && !/\(\s*\)$/.test(read[0])) {
        const args = argsOf(rest, after - 1);
        if (args === undefined) return true;
        after += args.length + 1;
      }
      if (readEnds(rest, after, false, read[0])) continue;
      return true;
    }
    if (/(?:^|[^\w$.])(?:typeof|in)$/.test(rest.slice(Math.max(0, j - 7), j)) && readEnds(rest, end)) continue;
    // process.on("exit", cb) as a statement with a literal event name: the value is dropped and the callback is code of this file.
    {
      MEMBER_AFTER.lastIndex = end;
      const ev = MEMBER_AFTER.exec(rest);
      if (ev && /^\s*\.\s*(?:on|once|off|addListener|removeListener)$/.test(ev[0]) && stmtStartAt(rest, j, at, prev)) {
        let p2 = end + ev[0].length;
        while (p2 < rest.length && /\s/.test(rest[p2]!)) p2++;
        const args = rest[p2] === "(" ? argsOf(rest, p2) : undefined;
        if (args !== undefined && args.trimStart().startsWith('""') && statementEnds(rest, p2 + args.length + 2)) continue;
      }
    }
    if (lenient) {
      // Any other plain member (nextTick, on, hrtime) is not static, but it does not reach a loader unless a chain follows it.
      MEMBER_AFTER.lastIndex = end;
      const mem = MEMBER_AFTER.exec(rest);
      if (mem) {
        if (!HARMLESS_MEMBER.test(mem[0])) return true;
        let after = end + mem[0].length;
        // process.env[name] reads one value from the environment.
        if (/^\s*\.\s*env$/.test(mem[0])) {
          let k = after;
          while (k < rest.length && /\s/.test(rest[k]!)) k++;
          if (rest[k] === "[") {
            let depth = 0;
            let e2 = k;
            for (; e2 < rest.length; e2++) {
              if (rest[e2] === "[") depth++;
              else if (rest[e2] === "]" && --depth === 0) break;
            }
            if (e2 < rest.length) after = e2 + 1;
          }
        }
        // A bare process.env that is bound, returned or passed on can be written later (const e = process.env; e.PATH = x).
        if (/^\s*\.\s*env$/.test(mem[0]) && after === end + mem[0].length) {
          let k = after;
          while (k < rest.length && /\s/.test(rest[k]!)) k++;
          if (rest[k] !== "." && !(rest[k] === "?" && rest[k + 1] === ".") && !bareEnvOk(rest, at)) return true;
        }
        let j2 = after;
        while (j2 < rest.length && /\s/.test(rest[j2]!)) j2++;
        if (rest[j2] === "(") {
          const args = argsOf(rest, j2);
          if (args === undefined) return true;
          after = j2 + args.length + 2;
        }
        // on, once, off, addListener and removeListener return the object: only as a statement whose value is dropped (emit returns a boolean).
        if (/^\s*\.\s*(?:on|once|off|addListener|removeListener)\b/.test(mem[0])) {
          const stmtStart = stmtStartAt(rest, j, at, prev);
          if (!stmtStart || !statementEnds(rest, after)) return true;
        }
        // process.env[k] = v writes a key the file does not show.
        const computedEnv = /^\s*\.\s*env$/.test(mem[0]) && after > end + mem[0].length;
        if (readEnds(rest, after, true, computedEnv ? undefined : mem[0])) continue;
        return true;
      }
    }
    const tail = rest.slice(end, end + 200);
    if ((prev === "{" || prev === ",") && /^\s*:/.test(tail)) continue;
    // A label (process: for (...)), break/continue process, a class field (process = 1;) and an assignment to the name do not read it.
    if ((prev === "{" || prev === "}" || prev === ";" || prev === "") && /^\s*(?::|=(?!=))/.test(tail)) continue;
    if (/(?:^|[^\w$.])(?:break|continue)$/.test(rest.slice(Math.max(0, j - 9), j))) continue;
    if ((prev === "{" || prev === "}" || prev === "," || prev === ";" || prev === "") && /^\s*\([^()]*\)\s*\{/.test(tail)) continue;
    return true;
  }
  // The global object handed on (bound, passed, returned, put in an array, a default value, new f(globalThis)) can be read for
  // process later. Only a member read of it (globalThis.name) and typeof / in are not a hand-over. At the top level of a
  // CommonJS file this is the exports object, so a bare top-level this counts the same.
  for (const m of rest.matchAll(/(?<![\w$])(?<![^\x00-\x7f\s])(?:globalThis|global)(?![\w$])(?![^\x00-\x7f\s])/g)) {
    const at = m.index ?? 0;
    // An object key (global: true) is a name, not the global object.
    const nextText = rest.slice(at + m[0].length, at + m[0].length + 8);
    let pj = at;
    while (pj > 0 && /\s/.test(rest[pj - 1]!)) pj--;
    const before = pj === 0 ? "" : rest[pj - 1]!;
    if (m[0] !== "this" && /^\s*:/.test(nextText) && (before === "" || /[{,;}]/.test(before))) continue;
    if (m[0] !== "this" && /(?:^|[^\w$.])(?:break|continue)\s*$/.test(rest.slice(Math.max(0, at - 12), at))) continue;
    // A class field (global = 1) is a name too.
    if (m[0] !== "this" && /^\s*=(?!=)/.test(nextText) && (before === "" || /[{;}]/.test(before))) continue;
    let j = at;
    while (j > 0 && /\s/.test(rest[j - 1]!)) j--;
    if (rest[j - 1] === "." && !rest.slice(0, j).endsWith("...")) continue;
    if (/(?:^|[^\w$.])(?:typeof|in|instanceof)$/.test(rest.slice(Math.max(0, j - 11), j))) {
      if (readEnds(rest, at + m[0].length)) continue;
      // typeof globalThis.name is one property read whose value is a string: no hand-over, whatever the name.
      const prop = /^\s*(?:\?\.|\.)\s*[A-Za-z_$][\w$]*/.exec(rest.slice(at + m[0].length, at + m[0].length + 80));
      if (m[0] !== "this" && /(?:^|[^\w$.])typeof$/.test(rest.slice(Math.max(0, j - 11), j)) && prop && readEnds(rest, at + m[0].length + prop[0].length)) continue;
    }
    if (m[0] !== "this" && HARMLESS_GLOBAL.test(rest.slice(at + m[0].length, at + m[0].length + 40))) continue;
    return true;
  }
  return thisOrArgumentsLeaks(rest, strict);
}

type BraceKind = "fn" | "arrow" | "class" | "object" | "block";

// The index just after the last non-space character before `end`.
function skipSpaceBack(code: string, end: number): number {
  let i = end;
  while (i > 0 && /\s/.test(code[i - 1]!)) i--;
  return i;
}

// A character of an identifier: ID_Continue, $, the joiners, and the halves of a surrogate pair (an astral name stays whole).
// Whitespace and line terminators (no-break space, U+FEFF, U+2028 and the like) are not ID_Continue, so they end a word.
function identChar(c: string): boolean {
  return /[\p{ID_Continue}$\u200c\u200d\ud800-\udfff]/u.test(c);
}

// The identifier that ends at `end` (no window: the whole identifier). A backslash never reaches here: the hazard check refuses
// a file with one first, so a \u escape in a name is not read.
function identBack(code: string, end: number): { word: string; start: number } {
  let i = end;
  while (i > 0 && identChar(code[i - 1]!)) i--;
  return { word: code.slice(i, end), start: i };
}

// The word function at `start` is the keyword and not a property name (o.function, o. function, o?.function).
function notProperty(code: string, start: number): boolean {
  const r = skipSpaceBack(code, start);
  return code[r - 1] !== "." || code.slice(r - 3, r) === "...";
}

// A ( at index k opens the parameter list of a function head: function (a), function f(a), function* f(a), async function f(a).
// The scan runs over the whole text: a long name or long gaps never cut the keyword off.
function isFunctionHead(code: string, k: number): boolean {
  let p = skipSpaceBack(code, k);
  let id = identBack(code, p);
  if (id.word === "") {
    if (code[p - 1] !== "*") return false;
    p = skipSpaceBack(code, p - 1);
    id = identBack(code, p);
    return id.word === "function" && notProperty(code, id.start);
  }
  if (id.word === "function") return notProperty(code, id.start);
  let q = skipSpaceBack(code, id.start);
  if (code[q - 1] === "*") q = skipSpaceBack(code, q - 1);
  const kw = identBack(code, q);
  return kw.word === "function" && notProperty(code, kw.start);
}

// A method or accessor at member position of an object literal or class body: name(...) {, get name(...) {, async *name(...) {,
// [key](...) {. A call statement (f(1)) inside a block is not a member.
function isMethodHead(code: string, k: number, outer: BraceKind | undefined): boolean {
  if (outer === "class") return true;
  if (outer !== "object") return false;
  let p = skipSpaceBack(code, k);
  if (code[p - 1] === "]") {
    let depth = 0;
    let i = p - 1;
    for (; i >= 0; i--) {
      if (code[i] === "]") depth++;
      else if (code[i] === "[" && --depth === 0) break;
    }
    if (i < 0) return false;
    p = skipSpaceBack(code, i);
  } else if (/["'`]/.test(code[p - 1] ?? "")) {
    // A quoted name ("m"(a) {): the text has its strings blanked, so the literal is its two quotes.
    const open = code.lastIndexOf(code[p - 1]!, p - 2);
    if (open < 0) return false;
    p = skipSpaceBack(code, open);
  } else {
    const id = identBack(code, p);
    if (id.word === "") return false;
    p = skipSpaceBack(code, id.start);
  }
  for (;;) {
    if (code[p - 1] === "*") {
      p = skipSpaceBack(code, p - 1);
      continue;
    }
    const m = identBack(code, p);
    if (/^(?:get|set|async|static)$/.test(m.word)) {
      p = skipSpaceBack(code, m.start);
      continue;
    }
    break;
  }
  return code[p - 1] === "{" || code[p - 1] === ",";
}

// A { at index `at` (j: the end of the text before it) opens a class body when a real class keyword stands in the same statement
// before it. The keyword is a whole word, not a member name (o.class, o. class, o?.class, o.#class), a key (class: ...) or a
// method or call (class(...)). The word is found in a bounded stretch back to the last brace or semicolon, and judged against
// the whole text, so a cut never splits a longer name into the keyword.
function opensClassBody(code: string, j: number): boolean {
  let lo = j - 1;
  while (lo >= 0 && j - lo <= 200 && code[lo] !== "{" && code[lo] !== "}" && code[lo] !== ";") lo--;
  const from = Math.max(0, lo + 1);
  for (let i = code.indexOf("class", from); i >= 0 && i < j; i = code.indexOf("class", i + 1)) {
    if ((i > 0 && identChar(code[i - 1]!)) || identChar(code[i + 5] ?? " ")) continue;
    const r = skipSpaceBack(code, i);
    if (code[r - 1] === "#" || (code[r - 1] === "." && code.slice(r - 3, r) !== "...")) continue;
    let k = i + 5;
    while (k < code.length && /\s/.test(code[k]!)) k++;
    if (/[:(=,)]/.test(code[k] ?? "")) continue;
    return true;
  }
  return false;
}

// Where a { opens: a function body ("fn"), an arrow body, a class body, an object literal or a plain block. `outer` is the kind
// of the brace around it.
function braceKind(code: string, at: number, outer?: BraceKind): BraceKind {
  const j = skipSpaceBack(code, at);
  if (code.slice(Math.max(0, j - 2), j) === "=>") return "arrow";
  // The word class opens a class body, not an object key (class: function () {}) or a member (x.class, x. class, x?.#class).
  if (opensClassBody(code, j)) return "class";
  if (code[j - 1] === ")") {
    let depth = 0;
    let k = j - 1;
    for (; k >= 0; k--) {
      if (code[k] === ")") depth++;
      else if (code[k] === "(" && --depth === 0) break;
    }
    const word = identBack(code, skipSpaceBack(code, Math.max(0, k))).word;
    if (/^(?:if|for|while|switch|catch|with)$/.test(word)) return "block";
    // A { on the next line after a ) that is not a function head or a member of an object or class is a block after a finished
    // statement, by automatic semicolon insertion: (1)\n{ ... }, void (0)\n{ ... }, f(1)\n{ ... }.
    if (/[\r\n\u2028\u2029]/.test(code.slice(j, at)) && !isFunctionHead(code, k) && !isMethodHead(code, k, outer)) return "block";
    return "fn";
  }
  // An object literal follows an operator, an opening bracket or a comma (across line ends), or a keyword that takes a value on
  // the same line (return, yield and the like end a statement at a line end; await, yield and of are plain names in sloppy
  // code).
  const prev = code[j - 1] ?? "";
  if (code.slice(j - 3, j) === "...") return "object";
  if (/[=,(\[?|&!*%<>^~]/.test(prev) || ((prev === "+" || prev === "-") && code[j - 2] !== prev)) return "object";
  const w = identBack(code, j).word;
  if (w !== "" && !/[\r\n\u2028\u2029]/.test(code.slice(j, at)) && /^(?:return|yield|await|throw|typeof|void|new|in|of|delete|instanceof|default)$/.test(w)) return "object";
  // The value of a key (a: {) in an object literal, or the alternate of a ternary (c ? a : {).
  if (prev === ":" && (outer === "object" || closesTernary(code, j - 1))) return "object";
  return "block";
}

// The : at index c closes a ? of a conditional expression in the same statement (scanned back a bounded way; no answer is false).
function closesTernary(code: string, c: number): boolean {
  let pending = 0;
  let depth = 0;
  for (let i = c - 1; i >= 0 && c - i < 2000; i--) {
    const ch = code[i]!;
    if (ch === ")" || ch === "]" || ch === "}") depth++;
    else if (ch === "(" || ch === "[" || ch === "{") {
      if (--depth < 0) return false;
    } else if (ch === ";" && depth === 0) return false;
    else if (depth === 0 && ch === ":") pending++;
    else if (depth === 0 && ch === "?" && code[i + 1] !== "." && code[i + 1] !== "?" && code[i - 1] !== "?") {
      if (pending === 0) return true;
      pending--;
    }
  }
  return false;
}

// A this in sloppy code is the global object inside a plain function call, and this at the top of a CommonJS file or
// arguments there are the module wrapper's (exports, require, module). So this that is handed on or read through a
// computed or process-like member, and arguments outside a function of its own, are not provably harmless. this.name and
// this.method() stay. Strict code (a class body, "use strict", import/export) has no global this.
function thisOrArgumentsLeaks(code: string, strictFile: boolean): boolean {
  const stack: BraceKind[] = [];
  for (const m of code.matchAll(/[{}]|(?<![\w$])(?:this|arguments)(?![\w$])/g)) {
    const at = m.index ?? 0;
    if (m[0] === "{") {
      stack.push(braceKind(code, at, stack[stack.length - 1]));
      continue;
    }
    if (m[0] === "}") {
      stack.pop();
      continue;
    }
    // A member named this or arguments (x.this) is a name; the dots of a spread (...this) are not a member access.
    let pj = at;
    while (pj > 0 && /\s/.test(code[pj - 1]!)) pj--;
    if (code[pj - 1] === "." && !code.slice(0, pj).endsWith("...")) continue;
    const after = code.slice(at + m[0].length, at + m[0].length + 60);
    if (m[0] === "arguments") {
      if (/^\s*\.\s*length\b/.test(after)) continue;
      let own = false;
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i] === "fn") {
          own = true;
          break;
        }
      }
      if (own) continue;
      return true;
    }
    // Inside a class body, or inside a function of a strict file, a plain call has no global this. The top level of a file
    // (and an arrow there) is still the exports object or the module's this, so it counts in strict files too.
    if (stack.includes("class") || (strictFile && stack.includes("fn"))) continue;
    // (this && this.__x) is a test: its value is the right side. A comparison does not hand it on either.
    if (/^\s*(?:&&|[!=]==?)/.test(after)) continue;
    let j = at;
    while (j > 0 && /\s/.test(code[j - 1]!)) j--;
    // typeof / in / instanceof is not a hand-over only when the operand ends there (typeof this[k][g](...) is a call).
    if (/(?:^|[^\w$.])(?:typeof|in|instanceof)$/.test(code.slice(Math.max(0, j - 11), j)) && readEnds(code, at + m[0].length)) continue;
    const member = /^\s*(?:\?\.|\.)\s*([A-Za-z_$][\w$]*)/.exec(after);
    if (member && !/^(?:process|globalThis|global|constructor|__proto__|execve|loadEnvFile|dlopen|reallyExit|_debugProcess)$/.test(member[1]!)) continue;
    return true;
  }
  return false;
}

// Words after which a [ opens an array literal, not a member access.
const BEFORE_ARRAY = /(?:^|[^\w$.])(?:return|typeof|case|in|of|new|delete|void|throw|yield|await|else|do|instanceof|export|default)$/;

// Names that provably hold a number: the counter of a for header that starts at a number, or a let/var/const set to a number
// literal and never assigned anything else.
function numericNames(code: string): Set<string> {
  const names = new Set<string>();
  for (const m of code.matchAll(/(?<![\w$.])(?:for\s*\(\s*)?(?:let|var|const)\s+([A-Za-z_$][\w$]*)\s*=\s*-?\d[\d._]*\s*(?=[;,\n)])/g)) names.add(m[1]!);
  for (const m of code.matchAll(/\bfor\s*\(\s*([A-Za-z_$][\w$]*)\s*=\s*-?\d/g)) names.add(m[1]!);
  // A symbol is not a string: it cannot be "constructor".
  for (const m of code.matchAll(/(?<![\w$.])(?:let|var|const)\s+([A-Za-z_$][\w$]*)\s*=\s*Symbol\b/g)) names.add(m[1]!);
  for (const n of [...names]) {
    const esc = n.replace(/\$/g, "\\$");
    const assigned = [...code.matchAll(new RegExp(`(?<![\\w$.])${esc}\\s*(?:=(?!=)|[-+*/%]=)`, "g"))].length;
    const declared = [...code.matchAll(new RegExp(`(?<![\\w$.])(?:let|var|const)\\s+${esc}\\s*=`, "g"))].length + [...code.matchAll(new RegExp(`\\bfor\\s*\\(\\s*${esc}\\s*=`, "g"))].length;
    // only the declaration, ++ / --, or += and -= by a number literal
    const byNumber = [...code.matchAll(new RegExp(`(?<![\\w$.])${esc}\\s*[-+]=\\s*\\d`, "g"))].length;
    if (assigned > declared + byNumber) names.delete(n);
  }
  return names;
}

// A key that is a number for sure: digits, a counter, x.length, Math.* and arithmetic on those.
function numericKey(key: string, nums: Set<string>): boolean {
  if (/^Symbol\s*[.(]/.test(key)) return true;
  const flat = key.replace(/[A-Za-z_$][\w$]*\s*\.\s*length\b/g, "0").replace(/\bMath\s*\.\s*[A-Za-z]+\s*\(/g, "(");
  if (!/^[\w$\s+\-*/%()]+$/.test(flat)) return false;
  return (flat.match(/[A-Za-z_$][\w$]*/g) ?? []).every((id) => nums.has(id));
}

// True when a computed member access whose key is not a number or one plain string literal is then called, indexed again or
// used with new: x[k](...), x[k][j], new x[k]. Any value reaches Function through ""["con"+"structor"]["con"+"structor"](...)(),
// so such a chain can run what the text never spells. A plain read (arr[i], obj[key] as a value) is not a chain.
// "code" has no strings or comments: a string is "" and a key built from strings is more than that.
function computedCallChain(code: string): boolean {
  let nums: Set<string> | undefined;
  for (let i = code.indexOf("["); i >= 0; i = code.indexOf("[", i + 1)) {
    let j = i;
    while (j > 0 && /\s/.test(code[j - 1]!)) j--;
    const prev = j > 0 ? code[j - 1]! : "";
    if (!/[\w$)\]"'`\u0080-\uffff]/.test(prev)) continue;
    if (BEFORE_ARRAY.test(code.slice(Math.max(0, j - 12), j))) continue;
    let depth = 0;
    let end = -1;
    for (let k = i; k < code.length; k++) {
      if (code[k] === "[") depth++;
      else if (code[k] === "]" && --depth === 0) {
        end = k;
        break;
      }
    }
    if (end < 0) return true;
    let e = end + 1;
    while (e < code.length && /\s/.test(code[e]!)) e++;
    const next = code[e];
    const tail = code.slice(e, e + 3);
    const chained = next === "(" || next === "[" || (next === "?" && code[e + 1] === "." && (code[e + 2] === "(" || code[e + 2] === "[")) || /(?<![\w$.])new\s+[\w$.\s]*$/.test(code.slice(Math.max(0, j - 80), i));
    void tail;
    if (!chained) continue;
    const key = code.slice(i + 1, end).trim();
    if (/^\d+$/.test(key) || key === '""') continue;
    nums ??= numericNames(code);
    if (numericKey(key, nums)) continue;
    return true;
  }
  return false;
}

// "use strict" as a complete directive statement in the prologue, or import / export declarations (whole words): strict code.
// A directive is a string alone on its statement: ended by ; or by a line end after which the next token does not continue the
// expression (a binary operator, member dot, call, index, ?, comma, template tag or the words in / instanceof; ! ~ and ++ --
// start a new statement). A template literal is not a directive.
const DIRECTIVE = /\s*(['"])([^'"\\\n]*)\1[ \t]*/y;
const CONTINUES = /^(?:[*\/%<>=&|^?,.(\[`]|!==?|\+(?!\+)|-(?!-)|(?:in|instanceof)(?![\w$]))/;
const DECLARATION = /(?:^|\n)([ \t\r\n]*)(?:import(?![\w$])\s*(?:[\w$*{]|"")|export(?![\w$])\s*(?:default\b|const\b|let\b|var\b|function\b|class\b|async\b|[{*]))/g;
// The leading quoted strings of the source, comments between them skipped. The kept text writes a plain template as a quoted
// string, so a directive is real only when the source spells the same string with ' or " at the same place in the prologue.
function rawPrologue(raw: string): string[] {
  const out: string[] = [];
  let i = 0;
  // A leading hashbang line is not code: the prologue starts after it.
  if (raw.startsWith("#!")) while (i < raw.length && raw[i] !== "\n") i++;
  for (;;) {
    for (;;) {
      while (i < raw.length && /\s/.test(raw[i]!)) i++;
      if (raw.startsWith("//", i)) {
        while (i < raw.length && raw[i] !== "\n") i++;
      } else if (raw.startsWith("/*", i)) {
        const e = raw.indexOf("*/", i + 2);
        if (e < 0) return out;
        i = e + 2;
      } else break;
    }
    const q = raw[i];
    if (q !== '"' && q !== "'") return out;
    let j = i + 1;
    while (j < raw.length && raw[j] !== q && raw[j] !== "\n" && raw[j] !== "\\") j++;
    if (raw[j] !== q) return out;
    out.push(raw.slice(i + 1, j));
    i = j + 1;
    // Skip to the end of the statement: only a directive keeps the prologue going.
    while (i < raw.length && /[ \t]/.test(raw[i]!)) i++;
    if (raw[i] === ";") i++;
  }
}

function strictFileOf(keep: string, code: string, raw: string): boolean {
  let pos = 0;
  let nth = 0;
  const lits = rawPrologue(raw);
  for (;;) {
    DIRECTIVE.lastIndex = pos;
    const m = DIRECTIVE.exec(keep);
    if (!m) break;
    let end = DIRECTIVE.lastIndex;
    if (end < keep.length && keep[end] !== ";" && keep[end] !== "\n" && keep[end] !== "\r") break;
    if (keep[end] === ";") end++;
    else if (end < keep.length) {
      let k = end;
      while (k < keep.length && /\s/.test(keep[k]!)) k++;
      if (CONTINUES.test(keep.slice(k, k + 12))) break;
    }
    if (m[2] === "use strict" && lits[nth] === "use strict") return true;
    nth++;
    pos = end;
  }
  for (const d of code.matchAll(DECLARATION)) {
    // o.\nimport\nx is a member named import, not a declaration.
    let k = (d.index ?? 0) - 1;
    while (k >= 0 && /\s/.test(code[k]!)) k--;
    if (k >= 0 && code[k] === ".") continue;
    return true;
  }
  return false;
}

// A scanner that throws must not make a file look safe: a fault reads as "not static" and "widen everything".
let scannerFaults = 0;
export function scannerFaultCount(): number {
  return scannerFaults;
}
export function provablyStatic(source: string): boolean {
  try {
    return provablyStaticScan(source);
  } catch {
    scannerFaults++;
    return false;
  }
}
function provablyStaticScan(source: string): boolean {
  if (source.includes(REMOVED)) return false;
  // Comments out first, strings kept: the patterns below read code, and a comment can neither hide nor fake a load.
  const text = codeOnly(source, [], true);
  if (text === undefined) return false;
  const aliases: string[] = ["process"];
  let viaOther = false;
  let rest = stripProcessAliases(text, aliases);
  if (hidesNames(codeOnly(text, aliases))) return false;
  rest = rest.replace(new RegExp(PLAIN_REQUIRE.source, "g"), removedText(false));
  rest = rest.replace(new RegExp(LITERAL_LOAD.source, "g"), (full, _a, spec1, _b, spec2, _c, spec3, at: number, whole: string) => {
    const spec = String(spec1 || spec2 || spec3 || "");
    if (builtinRoot(loadedSpec(spec) ?? "") === "process") viaOther = true;
    if (!stripLiteralLoad(spec)) {
      // A require call stays in the text and UNSAFE_JS sees it; an import declaration or export-from has no such word, so a
      // builtin that can run or load code (cluster, inspector, v8, sqlite, http, ...) makes the file not static here.
      if (spec1 === undefined) viaOther = true;
      return full;
    }
    // from "x" and import "x" end an import declaration only when the string is on the keyword's line and no . comes before
    // it (a variable named from, a property named import, are not declarations). Anything else is read as an expression, and
    // a / right after it could be a regular expression or a division: not static.
    const declaration = spec1 === undefined && !/[\n\r\u2028\u2029]/.test(full) && !dotBefore(whole, at);
    if (spec1 === undefined && !declaration && whole[skipTrivia(whole, at + full.length)] === "/") viaOther = true;
    return removedText(declaration);
  });
  if (viaOther) return false;
  // No space after this one on purpose: a property access can follow it (module.exports.in is a property).
  rest = rest.replace(/\bmodule\s*\.\s*exports\b/g, REMOVED);
  // Any other load of the process module (a bare require, a named import) is not a plain name for it.
  if (/(?:\brequire\s*\(|\bfrom|\bimport)\s*(['"])(?:node:)?process\1/.test(rest)) return false;
  if (LOADS_CHILD_PROCESS.test(rest) || dangerousStringUse(source) || dangerousLiteralKey(rest)) return false;
  const code = codeOnly(rest, aliases);
  if (code === undefined) return false;
  // Strings are gone from this text: a loader word or the word process inside a message is not a use.
  if (PROCESS_LOADER_WORDS.test(code) || UNSAFE_JS.test(code) || timerGetsCode(code) || steeringKey(code) || computedCallChain(code)) return false;
  // Brackets that do not pair up (a file Bun rejects) are read by nothing below: not static.
  if (bracketIndex(code).mismatch) return false;
  return !processValueUse(code, aliases, false, strictFileOf(text, code, source));
}

// exec/eval/compile, a dynamic import, or a loader that runs another file.
// A static `import helper` does not match. Docs stay out unless a literal names them.
export function runsOtherFile(text: string): boolean {
  if (/\b(?:exec|eval|compile)\s*\(/.test(text)) return true;
  if (/\b(?:__import__|importlib|import_module|execfile|runpy|run_path|load_source|SourceFileLoader)\b/.test(text)) return true;
  // Raw text on purpose: callers here are shell, Python and Ruby, where // and /* are not comments.
  if (/import\s*\(/.test(text)) return true;
  return false;
}

function scanJs(ctx: Ctx, key: string): void {
  if (ctx.hold || ctx.scanned.has(key) || !/\.(?:js|cjs|mjs)$/i.test(key)) return;
  const text = dec.decode(ctx.bytes.get(key));
  if (text.length > 1_000_000) {
    ctx.scanned.add(key);
    if (stripPkgJsonEnv(text).includes("npm_package_")) fail(ctx, "unresolved: manifest");
    if (!provablyStatic(text)) widenJs(ctx, key, text);
    else followLoads(ctx, key, text); // a large static file still names the files it loads
    return;
  }
  if (ctx.scanned.size >= DEPTH) {
    fail(ctx, "unresolved: script depth");
    return;
  }
  ctx.scanned.add(key);
  followLoads(ctx, key, text);
  // The precise walk above is the whole surface only when the file cannot name another path.
  if (!provablyStatic(text)) widenJs(ctx, key, text);
  // npm_package_json is the path of this package's manifest, not a config key.
  const body = stripPkgJsonEnv(text);
  if (!body.includes("npm_package_")) return;
  const re = new RegExp(PLAIN_REQUIRE.source, "g");
  const keys: string[] = [];
  for (const m of text.matchAll(re)) keys.push(m[1] || m[3] || "");
  if (body.replace(new RegExp(PLAIN_REQUIRE.source, "g"), "").includes("npm_package_")) {
    fail(ctx, "unresolved: manifest");
    return;
  }
  for (const keyName of keys) {
    const val = configVal(ctx, keyName);
    if (val === undefined || !TOKEN.test(val) || val.split("/").includes("..")) {
      fail(ctx, "unresolved: manifest");
      return;
    }
    addRef(ctx, val);
  }
}

function addLogical(ctx: Ctx, logical: string): void {
  if (ctx.hold) return;
  if (badPath(logical)) {
    fail(ctx, "unresolved: path");
    return;
  }
  const key = findKey(ctx, logical);
  // Node tries the file (logical, logical.js, ...) before the directory, and findKey reads a directory manifest first:
  // a path that reads both ways has both in the closure.
  const fileKey = ctx.hold ? undefined : findFile(ctx, logical);
  if (!key && !fileKey) {
    ctx.missing.add(logical);
    return;
  }
  // Node's require tries only X, X.js, X.json and X.node before the directory: when the file found is another extension
  // (.cjs, .ts), Node goes on to the directory's index, so that is in the closure too.
  const nodeHit = fileKey !== undefined && ["", ".js", ".json", ".node"].some((e) => ctx.logical.get(logical + e) === fileKey);
  const dirKey = ctx.hold || !fileKey || nodeHit ? undefined : findFile(ctx, `${logical}/index`);
  for (const k of new Set([key, fileKey, dirKey])) {
    if (!k) continue;
    // The manifest is not a surface file. Hook text and bin are compared on their own,
    // and a version bump always changes these bytes.
    if (isManifest(k)) continue;
    // A file the walk reached by name stays, including docs, markdown, and workflows.
    // Inert exclusion applies only inside widenAll, addBundled, and the same-directory widen.
    ctx.files.add(k);
    if (ctx.fromGyp) ctx.gypFiles.add(k);
    scanAdded(ctx, k);
  }
}

function addRef(ctx: Ctx, token: string): void {
  if (ctx.hold) return;
  if (token.includes("?") || token.includes("[")) {
    fail(ctx, "glob");
    return;
  }
  if (token.includes("*")) {
    const pat = normalize(token);
    if (token.length > STAR_PATTERN_MAX || pat.length > STAR_PATTERN_MAX) {
      fail(ctx, "pattern length");
      return;
    }
    if (ctx.fileCount > STAR_KEY_MAX) {
      fail(ctx, `key count ${ctx.fileCount} > ${STAR_KEY_MAX}`);
      return;
    }
    for (const logical of ctx.logical.keys()) {
      if (logical.length > STAR_TEXT_MAX) {
        fail(ctx, "pattern length");
        return;
      }
      if (starMatch(pat, logical)) addLogical(ctx, logical);
    }
    return;
  }
  addLogical(ctx, normalize(token));
}

// `require('./l/' + …)` names the directory `l`. A finished `require('./file')` does not.
function dynamicRequireDirs(code: string): string[] {
  const out: string[] = [];
  const re = /(?:require|import)\(\s*(['"])(\.[^'"]*)\1/g;
  for (const m of code.matchAll(re)) {
    const after = code.slice((m.index ?? 0) + m[0].length);
    if (/^\s*\)/.test(after)) continue;
    const dir = normalize(m[2] ?? "").replace(/\/+$/, "");
    if (!dir || badPath(dir)) continue;
    out.push(dir);
  }
  return out;
}

function addUnder(ctx: Ctx, dir: string): boolean {
  let any = false;
  for (const logical of ctx.logical.keys()) {
    if (logical !== dir && !logical.startsWith(`${dir}/`)) continue;
    addLogical(ctx, logical);
    any = true;
  }
  return any;
}

// README*, markdown, a doc/ or docs/ segment, tests, and .github/workflows are not install surface
// unless a command or a string literal names that file. `contest` is not a test directory.
function isInertSurface(logical: string): boolean {
  const base = logical.slice(logical.lastIndexOf("/") + 1);
  if (/^readme/i.test(base) || base.toLowerCase().endsWith(".md")) return true;
  if (/\.(?:test|spec)\./i.test(base)) return true;
  const parts = logical.split("/");
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!.toLowerCase();
    if (part === "doc" || part === "docs" || part === "test" || part === "tests" || part === "__tests__") return true;
    if (part === ".github" && parts[i + 1]?.toLowerCase() === "workflows") return true;
  }
  return false;
}

function omitInert(ctx: Ctx, logical: string): boolean {
  return isInertSurface(logical) && !ctx.hookNamed.has(logical);
}

function parentDir(logical: string): string {
  const slash = logical.lastIndexOf("/");
  return slash < 0 ? "" : logical.slice(0, slash);
}

// `. ./file` or `source file` clears safe names. So does any `eval` word, in any
// position, including after `then`, `builtin`, or `command`. Quotes and backslashes
// are not part of the word. A lone `.` does not match. Over-matching only widens.
function sourcesOtherFile(text: string): boolean {
  for (const stmt of splitOutside(text, "stmt")) {
    for (const seg of splitOutside(stmt, "pipe")) {
      const tokens: string[] = [];
      for (const w of shellWords(seg)) {
        for (const part of w.text.replace(/\\/g, "").split(/\s+/)) if (part) tokens.push(part);
      }
      for (let i = 0; i < tokens.length; i++) {
        const bare = tokens[i] ?? "";
        const base = bare.split("/").pop() ?? bare;
        if (base === "eval") return true;
        if ((bare === "." || bare === "source") && i + 1 < tokens.length) return true;
      }
    }
  }
  return false;
}

// `cd`, `pushd`, or `popd` changes what a later relative path means. The closure
// is from the package root, so any of those words widens the file to every file.
// Quotes and backslashes are not part of the word. Over-matching only widens.
function changesDirectory(text: string): boolean {
  for (const stmt of splitOutside(text, "stmt")) {
    for (const seg of splitOutside(stmt, "pipe")) {
      for (const w of shellWords(seg)) {
        for (const part of w.text.replace(/\\/g, "").split(/\s+/)) {
          if (!part) continue;
          const base = part.split("/").pop() ?? part;
          if (base === "cd" || base === "pushd" || base === "popd") return true;
        }
      }
    }
  }
  return false;
}

type PyImp = { root: string; name: string };

// Every import token in masked code, including one after `:`. `from . import`
// is relative and yields nothing. The `import` of a from-clause is not a second import.
function pyImports(text: string): PyImp[] {
  const mask = maskCode(text);
  const out: PyImp[] = [];
  const re = /\b(from|import)\b/g;
  let skipUntil = 0;
  for (const m of mask.matchAll(re)) {
    const at = m.index ?? 0;
    if (at < skipUntil) continue;
    const kind = m[1]!;
    const after = at + kind.length;
    if (kind === "from") {
      const rest = mask.slice(after);
      const mod = /^\s+(\.+)?([A-Za-z_][A-Za-z0-9_.]*)?\s+import\b/.exec(rest);
      if (!mod) continue;
      skipUntil = after + mod[0].length;
      if (mod[1]) continue;
      const name = mod[2] ?? "";
      const root = name.split(".")[0] ?? "";
      if (root) out.push({ root, name });
      continue;
    }
    const clause = /^\s+([^\n;#]+)/.exec(mask.slice(after));
    if (!clause) continue;
    for (const part of clause[1]!.split(",")) {
      const name = part.trim().split(/\s+/)[0] ?? "";
      const root = name.split(".")[0] ?? "";
      if (root) out.push({ root, name });
    }
  }
  return out;
}

function pyImportRoots(text: string): string[] {
  const roots: string[] = [];
  for (const imp of pyImports(text)) {
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(imp.root)) roots.push(imp.root);
  }
  return roots;
}

// A literal import_module, __import__, run_module, or run_path name. The receiver
// may be anything, including a bare call or an alias (il.import_module). A join
// of literals counts only when it is one identifier. A variable does not.
function pyDynamicRoots(text: string): string[] {
  const mask = maskCode(text);
  const re = /\b(?:import_module|__import__|run_module|run_path)\s*\(/g;
  const roots: string[] = [];
  for (const m of mask.matchAll(re)) {
    const paren = (m.index ?? 0) + m[0].length - 1;
    const args = argsOf(text, paren);
    if (args === undefined) continue;
    const hit = classifyExpr(positionals(args)[0] ?? "", "import", false, "py");
    if (hit === "open" || hit.length !== 1 || hit[0]!.t !== "lit") continue;
    const root = hit[0]!.path.split(".")[0] ?? "";
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(root)) roots.push(root);
  }
  return roots;
}

// A local X.py is followed for every import. A stdlib name also shadows X.pyc, X.so,
// X.abi3.so, X.cpython-*.so, the .pyd forms, and every file under X/. A literal
// __import__, import_module, run_module, or run_path shadows that name even when it is not in the stdlib
// set, because the call stays on the named file. Those extras are recorded without
// a scan: a .pyc is not a script, and a package tree must not trip the depth cap.
function followPyImports(ctx: Ctx, key: string, text: string): void {
  const dir = parentDir(key);
  const seen = new Set<string>();
  const dynamic = new Set(pyDynamicRoots(text));
  for (const name of [...pyImportRoots(text), ...dynamic]) {
    if (ctx.hold || seen.has(name)) continue;
    seen.add(name);
    const py = dir ? `${dir}/${name}.py` : `${name}.py`;
    if (ctx.logical.has(py)) addLogical(ctx, py);
    if (dynamic.has(name) || PY_STDLIB.has(name)) addStdlibShadow(ctx, dir, name);
  }
}

function addStdlibShadow(ctx: Ctx, dir: string, name: string): void {
  const root = dir ? `${dir}/${name}` : name;
  const exact = new Set([
    `${name}.py`,
    `${name}.pyc`,
    `${name}.so`,
    `${name}.pyd`,
    `${name}.abi3.so`,
    `${name}.abi3.pyd`,
  ]);
  const tagged = new RegExp(`^${name}\\.cpython-.+\\.(?:so|pyd)$`);
  for (const [logical, fileKey] of ctx.logical) {
    if (isManifest(logical)) continue;
    const under = logical.startsWith(`${root}/`);
    const base = logical.slice(logical.lastIndexOf("/") + 1);
    const sibling = parentDir(logical) === dir && (exact.has(base) || tagged.test(base));
    if (!under && !sibling) continue;
    ctx.files.add(fileKey);
    if (ctx.fromGyp) ctx.gypFiles.add(fileKey);
  }
}

// Recorded, not scanned, so a directory widen does not cascade or trip the depth cap.
function addSameDir(ctx: Ctx, fromKey: string): void {
  const dir = parentDir(fromKey);
  for (const [logical, key] of ctx.logical) {
    if (parentDir(logical) !== dir) continue;
    if (isManifest(logical) || omitInert(ctx, logical)) continue;
    ctx.files.add(key);
    if (ctx.fromGyp) ctx.gypFiles.add(key);
  }
}

function addNative(ctx: Ctx): void {
  for (const [logical, key] of ctx.logical) {
    const base = logical.slice(logical.lastIndexOf("/") + 1);
    const prebuild = base.toLowerCase().includes("prebuild") && /\.(?:js|cjs|mjs|sh|py)$/i.test(base);
    if (base.toLowerCase() !== "binding.gyp" && base.toLowerCase() !== "binding.cc" && !prebuild) continue;
    ctx.files.add(key);
    if (ctx.fromGyp) ctx.gypFiles.add(key);
  }
}

function addScannedLiterals(ctx: Ctx): void {
  const keys = [...ctx.scanned];
  for (const key of keys) {
    if (ctx.hold) return;
    for (const tok of quotedTokens(dec.decode(ctx.bytes.get(key)))) addLiteralToken(ctx, tok);
  }
}

function addPrefixDir(ctx: Ctx, dir: string): void {
  if (!dir || badPath(dir)) return;
  for (const [logical, key] of ctx.logical) {
    if (logical !== dir && !logical.startsWith(`${dir}/`)) continue;
    if (isManifest(logical)) continue;
    ctx.files.add(key);
    if (ctx.fromGyp) ctx.gypFiles.add(key);
  }
}

// Docs stay out. Tests and workflows stay out unless the computed tail could name them.
function widenPackage(ctx: Ctx, reachTests: boolean, reachFlows: boolean): void {
  for (const [logical, key] of ctx.logical) {
    if (isManifest(logical) || isDocSurface(logical)) continue;
    if (!reachTests && isTestSurface(logical)) continue;
    if (!reachFlows && isWorkflowSurface(logical)) continue;
    ctx.files.add(key);
    if (ctx.fromGyp) ctx.gypFiles.add(key);
  }
}

function widenEvery(ctx: Ctx): void {
  for (const [logical, key] of ctx.logical) {
    if (isManifest(logical)) continue;
    ctx.files.add(key);
    if (ctx.fromGyp) ctx.gypFiles.add(key);
  }
}

// A non-static JS file with no computed file load keeps its own directory.
// Python, shell, and extensionless entries use that same floor.
function narrowWiden(ctx: Ctx, fromKey: string): void {
  addSameDir(ctx, fromKey);
  addNative(ctx);
  addScannedLiterals(ctx);
}

function widenJs(ctx: Ctx, key: string, text: string): void {
  try {
    widenJsScan(ctx, key, text);
  } catch {
    scannerFaults++;
    widenEvery(ctx);
  }
}
function addSameDirIf(ctx: Ctx, key: string, tier: JsTier): void {
  if (tier.pkg || tier.dirs.length === 0 || tier.same) addSameDir(ctx, key);
}
function widenJsScan(ctx: Ctx, key: string, text: string): void {
  const tier = classifyJs(key, text);
  if (tier.all) widenEvery(ctx);
  else {
    if (tier.pkg) widenPackage(ctx, tier.tests, tier.flows);
    // The package tier leaves docs out; a directory a literal-headed load names, and the hook's own folder, stay in whole.
    if (!tier.pkg || tier.same) addSameDirIf(ctx, key, tier);
    for (const dir of tier.dirs) addPrefixDir(ctx, dir);
  }
  for (const path of tier.lits) addLogical(ctx, path);
  addNative(ctx);
  addScannedLiterals(ctx);
}

type JsEffect =
  | { t: "none" }
  | { t: "same" }
  | { t: "lit"; path: string }
  | { t: "prefix"; dir: string }
  | { t: "pkg"; tests: boolean; flows: boolean }
  | { t: "all" };

export type JsTier = { all: boolean; pkg: boolean; tests: boolean; flows: boolean; same: boolean; dirs: string[]; lits: string[] };

// eval/Function/vm of a value we cannot see can load any file, docs included.
// A string literal or a read of a literal path is not that shape.
// The local names bound to the path module and to its join and resolve: const path = require("path"), import path from "node:path",
// const { join } = require("path"), import { resolve as r } from "path", const { join } = path.
function pathNames(keep: string): { mods: Set<string>; fns: Set<string> } {
  const mods = new Set<string>();
  const fns = new Set<string>();
  const SPEC = String.raw`['"](?:node:)?path(?:\/(?:posix|win32))?['"]`;
  const id = String.raw`[A-Za-z_$][\w$]*`;
  for (const m of keep.matchAll(new RegExp(String.raw`\b(?:const|let|var)\s+(${id})\s*=\s*require\(\s*${SPEC}\s*\)`, "g"))) mods.add(m[1]!);
  for (const m of keep.matchAll(new RegExp(String.raw`\bimport\s+(?:\*\s*as\s+)?(${id})\s+from\s*${SPEC}`, "g"))) mods.add(m[1]!);
  for (const m of keep.matchAll(new RegExp(String.raw`\b(?:const|let|var)\s+(${id})\s*=\s*require\(\s*${SPEC}\s*\)\s*\.\s*(?:(?:posix|win32)\s*\.\s*)?(?:join|resolve)(?=[ \t]*(?:;|,|\r?\n|$|\}))`, "g"))) fns.add(m[1]!);
  const members = (list: string) => {
    for (const part of list.split(",")) {
      const mm = /^\s*(join|resolve)\s*(?:(?::|\bas\b)\s*([A-Za-z_$][\w$]*))?\s*$/.exec(part);
      if (mm) fns.add(mm[2] ?? mm[1]!);
    }
  };
  for (const m of keep.matchAll(new RegExp(String.raw`\b(?:const|let|var)\s*\{([^{}]*)\}\s*=\s*require\(\s*${SPEC}\s*\)`, "g"))) members(m[1]!);
  for (const m of keep.matchAll(new RegExp(String.raw`\bimport\s*\{([^{}]*)\}\s*from\s*${SPEC}`, "g"))) members(m[1]!);
  for (const name of mods) {
    for (const m of keep.matchAll(new RegExp(String.raw`\b(?:const|let|var)\s*\{([^{}]*)\}\s*=\s*${name.replace(/\$/g, "\\$")}(?![\w$])`, "g"))) members(m[1]!);
  }
  for (const name of mods) {
    for (const m of keep.matchAll(new RegExp(String.raw`\b(?:const|let|var)\s+(${id})\s*=\s*${name.replace(/\$/g, "\\$")}\s*\.\s*(?:(?:posix|win32)\s*\.\s*)?(?:join|resolve)(?=[ \t]*(?:;|,|\r?\n|$|\}))`, "g"))) fns.add(m[1]!);
  }
  return { mods, fns };
}
// True when text ends in a call of path.join or path.resolve through a name bound to the path module.
function endsInPathCall(before: string, names: { mods: Set<string>; fns: Set<string> }): boolean {
  const m = /(?<![\w$.])([A-Za-z_$][\w$]*)(?:\s*\.\s*(?:posix|win32))?(?:\s*\.\s*(join|resolve))?\s*\(\s*$/.exec(before);
  if (!m) return false;
  return m[2] !== undefined ? names.mods.has(m[1]!) : names.fns.has(m[1]!);
}
export function processHazard(source: string): boolean {
  try {
    return processHazardScan(source);
  } catch {
    scannerFaults++;
    return true;
  }
}
function processHazardScan(source: string): boolean {
  // Comments out first (strings kept) so the alias statements can be read, then strings out so no word inside a message counts.
  const names = ["process"];
  const keep = codeOnly(source, [], true);
  // A file the scan cannot read is a hazard only when it can name the process object or spell a name with an escape.
  const unreadable = () => /process|global|\\/.test(source);
  if (keep === undefined) return unreadable();
  const code = codeOnly(stripProcessAliases(keep, names), names);
  if (code === undefined) return unreadable();
  if (PROCESS_LOADER_WORDS.test(code) || steeringKey(code)) return true;
  if (bracketIndex(code).mismatch) return unreadable();
  // A computed member of the global object can be the process object.
  if (/(?<![\w$.])(?:globalThis|global)\s*(?:\?\.)?\s*\[/.test(code)) return true;
  // An escape in code can spell process or a loader word.
  if (code.includes("\\")) return true;
  // Any load of the process module other than the plain alias statement (require("process")[..], import("process"),
  // import { default as p } from "process") is a name for it that is not tracked.
  if (LOADS_PROCESS.test(stripProcessAliases(keep, [])) || dangerousStringUse(source) || dangerousLiteralKey(keep)) return true;
  // A require, import() or require.resolve whose argument reads process cannot be classified, unless every read is a complete
  // read put in front of a string (process.cwd() + "/tools/") or the manifest path (dirname(process.env.npm_package_json)).
  const flat = code.replace(/`/g, " ");
  const pathBindings = pathNames(keep);
  const word = new RegExp(`(?<![\\w$])(?<![^\\x00-\\x7f\\s])(?:${names.join("|").replace(/\$/g, "\\$")})(?![\\w$])(?![^\\x00-\\x7f\\s])`, "g");
  for (const m of flat.matchAll(/(?:\brequire(?:\s*\.\s*resolve)?|\bimport)\s*\(/g)) {
    const args = argsOf(flat, (m.index ?? 0) + m[0].length - 1);
    if (args === undefined) return true;
    for (const w of args.matchAll(word)) {
      const at = w.index ?? 0;
      READ_AFTER.lastIndex = at + w[0].length;
      const read = READ_AFTER.exec(args);
      if (!read) return true;
      const after = args.slice(at + w[0].length + read[0].length);
      const prefixed = /^\s*\+\s*""/.test(after) && (/^\s*\.\s*cwd\s*\(\s*\)$/.test(read[0]) || /^\s*\.\s*env\s*\.\s*INIT_CWD$/.test(read[0]));
      const manifest = /\.\s*npm_package_json$/.test(read[0]) && /dirname\s*\(\s*$/.test(args.slice(0, at));
      // platform and arch name one of a few fixed values: a file-name selector, not a path.
      const selector = /^\s*\.\s*(?:platform|arch)$/.test(read[0]);
      // path.join(process.cwd(), "x.js") and path.resolve(process.cwd(), ...): the root, then literal segments.
      const joined = (/^\s*\.\s*cwd\s*\(\s*\)$/.test(read[0]) || /^\s*\.\s*env\s*\.\s*INIT_CWD$/.test(read[0])) && endsInPathCall(args.slice(0, at), pathBindings) && /^(?:\s*,\s*"")+\s*\)/.test(after);
      if (!prefixed && !manifest && !selector && !joined) return true;
    }
  }
  return processValueUse(code, names, true, strictFileOf(keep, code, source));
}

// setTimeout or setInterval whose first argument is a string or built from one: that string is run as code.
function timerGetsCode(code: string): boolean {
  // The scan writes a template as a lone backtick, which argsOf would read as an open quote.
  const plain = code.replace(/`/g, "§");
  for (const m of plain.matchAll(/(?<![\w$.])(?:(?:globalThis|global|window|self)\s*(?:\?\.|\.)\s*)?(?:setTimeout|setInterval)\s*\(/g)) {
    const args = argsOf(plain, (m.index ?? 0) + m[0].length - 1);
    if (args === undefined) return true;
    const first = firstArg(args).trim();
    if (first.startsWith('""') || first.startsWith("§") || (/\+/.test(first) && !/=>|function/.test(first))) return true;
  }
  return false;
}

// An identifier key that names a variable steering the next process, as the key of an object literal ({ NODE_OPTIONS: x }).
function steeringKey(code: string): boolean {
  for (const m of code.matchAll(/(?<![\w$.?])([A-Za-z_$][\w$]*)\s*:(?!:)/g)) {
    const strong = STEERING_NAME.test(m[1]!);
    if (!strong && !/^(?:PATH|Path|ENV)$/.test(m[1]!)) continue;
    let q = m.index ?? 0;
    while (q > 0 && /\s/.test(code[q - 1]!)) q--;
    if ((q === 0 || /[{,]/.test(code[q - 1]!)) && (strong || envObjectLiteral(code, m.index ?? 0))) return true;
  }
  // A computed key in an object literal that spreads process.env or sits under env: the name is not shown.
  for (const m of code.matchAll(/[{,]\s*\[/g)) {
    const open = (m.index ?? 0) + m[0].length - 1;
    const close = bracketIndex(code).closer[open]! >= 0 ? bracketIndex(code).closer[open]! : code.length;
    if (close < code.length && codeAfter(code, close + 1, 1) === ":" && envObjectLiteral(code, open)) return true;
  }
  const mentionsEnv = /(?:^|[^\w$.]|\.\.\.)process\s*(?:\?\.|\.)\s*env(?![\w$])/.test(code);
  // Any assignment to a member with such a name (env.NODE_OPTIONS = x on a copied environment); PATH and ENV where the file
  // handles the environment at all.
  for (const m of code.matchAll(/(?:\?\.|\.)\s*([A-Za-z_$][\w$]*)\s*(?:\|\||&&|\?\?|\*\*|>>>|<<|>>|[-+*\/%&|^])?=(?![=>])/g)) {
    if (STEERING_NAME.test(m[1]!) || (mentionsEnv && /^(?:PATH|Path|ENV)$/.test(m[1]!))) return true;
  }
  // A shorthand key ({ ...process.env, PATH }).
  for (const m of code.matchAll(/[{,]\s*(PATH|Path|ENV)\s*(?=[,}])/g)) {
    if (envObjectLiteral(code, (m.index ?? 0) + m[0].indexOf(m[1]!))) return true;
  }
  return false;
}

const CALL_OK = new Set(["require", "fs", "path", "readFileSync", "readFile", "open", "__dirname", "__filename", "join", "resolve", "toString", "String", "utf8", "posix"]);
// `text` is comment-free; `source` is the file's own text for the checks that need it (a template literal is not a directive).
export function hasUnbounded(text: string, source: string): boolean {
  try {
    return hasUnboundedScan(text, source);
  } catch {
    scannerFaults++;
    return true;
  }
}
function hasUnboundedScan(text: string, source: string): boolean {
  if (processHazard(source)) return true;
  // Indirect and optional eval, new Function, the global object's eval, a computed member of a global, and a timer given code.
  const plain = codeOnly(text) ?? text;
  if (/(?<![\w$.])(?<!instanceof\s+)(?:eval|Function)\b(?!\s*\()/.test(plain)) return true;
  if (/(?<![\w$.])(?:globalThis|global|window|self)\s*(?:\?\.|\.)\s*(?:eval|Function)\b|(?<![\w$.])window\s*(?:\?\.)?\s*\[/.test(plain)) return true;
  if (timerGetsCode(plain) || computedCallChain(plain)) return true;
  // .constructor.constructor and .constructor[ reach Function; .constructor( is read like Function( below.
  if (/(?:\?\.|\.)\s*constructor\s*(?:\?\.|\.)\s*constructor\b|(?:\?\.|\.)\s*constructor\s*(?:\?\.\s*)?\[/.test(plain)) return true;
  // A pattern that binds a constructor key ({ constructor: { constructor: F } }) reaches Function without a dot.
  for (const m of plain.matchAll(/(?<![\w$.])constructor(?![\w$])\s*:/g)) if (inPattern(plain, m.index ?? 0)) return true;
  // .constructor( is read like Function(: the comment-free text, so a comment or a message does not count.
  for (const m of plain.matchAll(/(?:\?\.|\.)\s*constructor\s*\(/g)) {
    const args = argsOf(plain, (m.index ?? 0) + m[0].length - 1);
    if (args === undefined) return true;
    const arg = firstArg(args).trim();
    if (/^(['"`])[^'"`\\]*\1$/.test(arg)) continue;
    const bare = arg.replace(/['"][^'"]*['"]/g, " ").replace(/`[^`$]*`/g, " ");
    if (bare.includes("${")) return true;
    if (!(bare.match(/[A-Za-z_$][\w$]*/g) ?? []).every((id) => CALL_OK.has(id))) return true;
  }
  const re = /\b(?:eval|Function)\s*\(|\bvm\s*\.\s*(?:runInThisContext|runInNewContext|runInContext|compileFunction)\s*\(/g;
  const ok = CALL_OK;
  for (const m of text.matchAll(re)) {
    const paren = (m.index ?? 0) + m[0].lastIndexOf("(");
    const args = argsOf(text, paren);
    if (args === undefined) return true;
    const arg = firstArg(args).trim();
    if (/^(['"`])[^'"`\\]*\1$/.test(arg)) continue;
    const bare = arg.replace(/['"][^'"]*['"]/g, " ").replace(/`[^`$]*`/g, " ");
    if (bare.includes("${")) return true;
    const ids = bare.match(/[A-Za-z_$][\w$]*/g) ?? [];
    if (!ids.every((id) => ok.has(id))) return true;
  }
  return false;
}

// Takes the file's own source: the hazard check reads the raw text (a template literal is not a directive, which the comment-free
// text below cannot tell), and the load scan reads the comment-free text, so a comment inside an eval argument cannot end its
// argument list early. Unreadable text stays raw.
export function classifyJs(fromKey: string, source: string): JsTier {
  try {
    return classifyJsScan(fromKey, source);
  } catch {
    scannerFaults++;
    return { all: true, pkg: true, tests: true, flows: true, same: false, dirs: [], lits: [] };
  }
}
function classifyJsScan(fromKey: string, source: string): JsTier {
  const tier: JsTier = { all: false, pkg: false, tests: false, flows: false, same: false, dirs: [], lits: [] };
  const text = codeOnly(source, [], true) ?? source;
  if (hasUnbounded(text, source)) tier.all = true;
  cls = { text, ...pathNames(text), bind: new Map(), memo: new Map(), visiting: new Set(), steps: 0, defSteps: 0 };
  try {
    classifyLoads(tier, fromKey, text);
  } finally {
    cls = undefined;
  }
  // A hit we do not classify can name any non-doc file, including tests and workflows.
  if (!tier.all && unclassifiedUnsafe(text)) {
    tier.pkg = true;
    tier.tests = true;
    tier.flows = true;
  }
  return tier;
}
// require without a call: not `require(`, `require.resolve(`, `typeof require`, `require.main/cache/extensions`, not a member name, not a parameter of the
// module wrapper. module.require and createRequire(...) results count when they are not called on the spot.
// `r = `, `const r = `, `export const r = `, `const a = 1, r = ` before a createRequire call (optionally through a member chain).
const BOUND_STMT = /^\s*(?:export\s+)?(?:(?:const|let|var)\s+(?:[A-Za-z_$][\w$]*\s*(?:=\s*[^,;()[\]{}]*)?,\s*)*)?[A-Za-z_$][\w$]*\s*=\s*(?:[\w$]+\s*\.\s*)*$/;
function handedOn(text: string, aliases: string[], keptKeys = ""): boolean {
  const names = new Set(["require", ...aliases]);
  for (const m of text.matchAll(/(?<![\w$.])[A-Za-z_$][\w$]*(?![\w$])/g)) {
    const name = m[0];
    if (!names.has(name)) continue;
    const at = m.index ?? 0;
    const after = text.slice(at + name.length, at + name.length + 60);
    const before = text.slice(Math.max(0, at - 40), at);
    if (/^\s*\(/.test(after)) continue; // a direct call
    if (/^\s*\.\s*(?:resolve\s*\(|main\b|cache\b|extensions\b|paths\b)/.test(after)) continue;
    if (/\btypeof\s+$/.test(before)) continue;
    if (/\b(?:const|let|var|function)\s+$/.test(before)) continue;
    if (/^\s*=(?!=)/.test(after)) continue; // its own binding
    if (/[{,]\s*$/.test(before) && /^\s*:/.test(after) && !keyBindsLoader(text, at + name.length)) continue; // a property name ({ require: true }), not a key that binds a name ({ require: r } = module, a parameter, a catch or for-of binding)
    if (inParamList(text, at, name.length)) continue; // a parameter named like the loader
    if (name === "require" && /(?:^|[;\n}])\s*module\s*\.\s*exports\s*=\s*$/.test(before) && /^[ \t]*(?:;|\r?\n|$)/.test(after) && !exportsUsed(text)) continue; // module.exports = require; and nothing reads the export

    return true;
  }
  // A computed member key (module["require"], module[`require`]) is a name, not text.
  if (computedRequire(keptKeys)) return true;
  // Reflect.get(module, "require"), Object.getOwnPropertyDescriptor(module, "require"): the loader read by a string key through a call.
  for (const m of keptKeys.matchAll(/(?<![\w$.])(?:Reflect|Object)\s*\.\s*\w+\s*\(/g)) {
    const args = argsOf(keptKeys, (m.index ?? 0) + m[0].length - 1);
    if (args === undefined) return true;
    const list = splitTop(args, ",");
    if (list.slice(1).some((a) => /^\s*(["'`])require\1\s*$/.test(a))) return true;
  }
  // A read by a key the file builds (a name, an expression) from module, require.main, module.parent or a name bound to one. The code is read
  // with strings, template text and regular-expression bodies blanked by the scan, so a quote inside a regex starts no string.
  // The scan leaves a lone backtick where a template opens a substitution; read as a space the brackets balance.
  const flat = text.replace(/`/g, " ");
  for (const m of flat.matchAll(/(?<![\w$.])(?:Reflect|Object)\s*\.\s*(get|getOwnPropertyDescriptors?|entries|values|assign|fromEntries|getOwnPropertyNames|ownKeys)\s*\(/g)) {
    const args = argsOf(flat, (m.index ?? 0) + m[0].length - 1);
    if (args === undefined || splitTop(args, ",").some((a) => mentionsModule(a, flat))) return true;
  }
  // module.require handed on (a bare mention, .bind(...)).
  for (const m of text.matchAll(/(?<![\w$.])module\s*\.\s*require\b(?!\s*\()/g)) if (!/^\s*\.\s*(?:paths|cache)\b/.test(text.slice((m.index ?? 0) + m[0].length, (m.index ?? 0) + m[0].length + 12))) return true;
  // A createRequire(...) result that is neither called on the spot nor bound to a plain name (a member, an argument, a ternary).
  for (const m of text.matchAll(/(?<![\w$])createRequire\s*\(/g)) {
    const inner = argsOf(text, (m.index ?? 0) + m[0].length - 1);
    if (inner === undefined) return true;
    const end = (m.index ?? 0) + m[0].length + inner.length + 1;
    if (/^\s*\(/.test(text.slice(end, end + 6))) continue;
    const { from } = statementStart(text, m.index ?? 0);
    const stmt = text.slice(from, m.index ?? 0);
    if (BOUND_STMT.test(stmt)) continue;
    if (/\bconst\s*\{[^}]*\}\s*=\s*require\s*\(\s*["']module["']\s*\)\s*$/.test(stmt)) continue;
    return true;
  }
  return false;
}

// A `require:` key ending at `end` binds a name when it sits in a destructuring left side or its value is a plain name (a parameter, a
// catch or for-of binding, a pattern of any depth). It is data only when its value is true, false, null, a number or a string.
function keyBindsLoader(text: string, end: number): boolean {
  if (keyInPattern(text, end)) return true;
  const value = /^\s*:\s*([A-Za-z_$][\w$]*)/.exec(text.slice(end, end + 80));
  return value !== null && !/^(?:true|false|null|function|async|class|new|typeof|void|this|await|delete)$/.test(value[1]!);
}
// The { that holds the key ending at `end` is the left side of a destructuring ({ require: r } = module, nested too), not an object literal.
function keyInPattern(text: string, end: number): boolean {
  let d = 0;
  for (let j = end; j < text.length && j - end < 400; j++) {
    const c = text[j];
    if (c === ";") return false;
    if (c === "{" || c === "[" || c === "(") d++;
    else if (c === ")" || c === "]") {
      d--;
      if (d < 0) return false;
    } else if (c === "}") {
      d--;
      if (d < 0) {
        const nx = nextNonSpace(text, j + 1);
        const n1 = text[nx];
        const n2 = text[nx + 1];
        if (n1 === "=" && n2 !== "=" && n2 !== ">") return true;
        if (n1 !== "}" && n1 !== ",") return false;
        d = 0; // inside an enclosing brace of the same left side
      }
    }
  }
  return false;
}
// The expression names module, require, require.main, module.parent or a name assigned from one of them (module.exports, require.cache and
// the like are not the loader).
function mentionsModule(expr: string, text: string): boolean {
  const names = new Set(["module", "require"]);
  for (const m of text.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)\s*=\s*(?:module|require)(?![\w$])(?!\s*\()(?!\s*\.\s*(?:exports|cache|extensions|resolve|paths|id|filename|loaded)\b)/g)) names.add(m[1]!);
  // The text is already blanked by the scan: strings are text and a key before a colon is a name of data, not a reference.
  const code = expr;
  for (const name of names) {
    const n = name.replace(/\$/g, "\\$");
    for (const m of code.matchAll(new RegExp(`(?<![\\w$.])${n}(?![\\w$])(?!\\s*\\()(?!\\s*\\.\\s*(?:exports|cache|extensions|resolve|paths|id|filename|loaded)\\b)`, "g"))) {
      const k = m.index ?? 0;
      let b = k - 1;
      while (b >= 0 && /\s/.test(code[b]!)) b--;
      if (code[nextNonSpace(code, k + name.length)] === ":" && (code[b] === "{" || code[b] === ",")) continue; // { module: 1 }, whatever the white space
      return true; // a parameter of the same name proves nothing about what the call passes: it may hold the real module
    }
  }
  return false;
}
// A computed ["require"] member holds whatever the receiver is (module, an alias, a flow, a call result, a data object): no receiver is provably
// not a module object, so none is excused.
function computedRequire(text: string): boolean {
  return /\[\s*(["'`])require\1\s*\]/.test(text);
}
// The next character after white space of any length, and where it is.
function nextNonSpace(text: string, from: number): number {
  let i = from;
  while (i < text.length && /\s/.test(text[i]!)) i++;
  return i;
}
// The ) at `close` is followed by a function body on the same line. A line break before the { is never accepted: the { may open a block
// (a label, a case, an if body), so a loader name before it is a call, not a method head.
function bodyFollows(text: string, close: number): boolean {
  const i = nextNonSpace(text, close + 1);
  return text[i] === "{" && !/[\n\r\u2028\u2029]/.test(text.slice(close + 1, i));
}
// module.exports = require is read through only when nothing else reads module.exports: a call or an alias of it runs the loader.
function exportsUsed(text: string): boolean {
  for (const m of text.matchAll(/(?<![\w$.])module\s*\.\s*exports\b/g)) {
    const rest = text.slice((m.index ?? 0) + m[0].length, (m.index ?? 0) + m[0].length + 40);
    if (/^\s*=(?!=)/.test(rest) || /^\s*\.\s*[\w$]+\s*=(?!=)/.test(rest)) continue;
    return true;
  }
  return false;
}
// The text before a ( ends in a method head: a name (after { , ; } or a modifier) in an object literal or a class body, a getter, a setter, an
// async or generator method, or a catch clause. Keywords that take a ( and a block (if, while, for, switch, with) are not methods.
function methodHead(head: string): boolean {
  if (/(?:^|[{,;}])\s*(?:(?:static|async|get|set)\s+)*\*?\s*(?:(?:""|'')|\[[^\]]*\])\s*$/.test(head)) return true; // a quoted or computed method name
  const m = /(?:^|[{,;}]|\b(?:static|async|get|set)\b|\*|\bcatch\b)\s*(?:\*\s*)?([A-Za-z_$][\w$]*)?\s*$/.exec(head);
  if (!m) return false;
  if (/\bcatch\s*$/.test(head)) return true;
  return m[1] !== undefined && !/^(?:if|while|for|switch|with|return|typeof|else|do|catch|function|static|async|get|set)$/.test(m[1]);
}
// The name at `at` sits in a parameter list: (require, exports, module) before a body or an arrow.
function inParamList(text: string, at: number, len: number): boolean {
  // Only a bare name in a declaration slot is a parameter: right after the ( or a top-level comma, followed by , ) or a default.
  // A loader inside a default (cb = require, a = [require], a = x || require) is a value.
  if (!/[(,]\s*$/.test(text.slice(Math.max(0, at - 40), at)) || !/^\s*(?:[,)]|=(?![=>]))/.test(text.slice(at + len, at + len + 12))) return false;
  let depth = 0;
  let sq = 0;
  let k = at - 1;
  for (; k >= 0 && at - k < 300; k--) {
    const c = text[k];
    if (c === ")") depth++;
    else if (c === "]") sq++;
    else if (c === "[") {
      if (sq === 0) return false;
      sq--;
    } else if (c === "(") {
      if (depth === 0) break;
      depth--;
    } else if (c === "{" || c === ";") return false;
  }
  if (k < 0 || text[k] !== "(") return false;
  let d = 0;
  let j = at + len;
  for (; j < text.length && j - at < 300; j++) {
    const c = text[j];
    if (c === "(") d++;
    else if (c === ")") {
      if (d === 0) break;
      d--;
    }
  }
  if (text[j] !== ")") return false;
  const head = text.slice(Math.max(0, k - 60), k);
  return /(?<![\w$.])function\s*\*?\s*[\w$]*\s*$/.test(head) || text.startsWith("=>", nextNonSpace(text, j + 1)) || (methodHead(head) && bodyFollows(text, j));
}
const FUNCTION_START = /^(?:async\s+)?(?:function\b|\([^()]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/;
function classifyLoads(tier: JsTier, fromKey: string, text: string): void {
  loaderOverflow = false;
  const callers = new Set(["require", "import", "fork", "execFile", "execFileSync", ...loaderNames(text)]);
  if (loaderOverflow) {
    // A createRequire statement too long to read: any call may be a load.
    tier.pkg = true;
    tier.tests = true;
    tier.flows = true;
  }
  // The files a spawn names are read from the package root (the working directory) and from this file's folder (a cwd option,
  // __dirname): both bases, merged.
  const rootBases = fromKey === "package.json" || !fromKey.includes("/") ? [fromKey] : [fromKey, "package.json"];
  // One pass over every call, whatever it is called through, keeps a file with thousands of aliases linear.
  for (const m of text.matchAll(/(?<![\w$])([A-Za-z_$][\w$]*)\s*\(/g)) {
    const callee = m[1]!;
    if (!callers.has(callee)) continue;
    // After a dot a require( is a member call (module.require, require.main.require, module.parent.require, m.require, an object
    // holding require) and is read as a load; process calls (child_process.fork) too. Other names after a dot are not loads.
    const dotted = /\.\s*$/.test(text.slice(Math.max(0, (m.index ?? 0) - 3), m.index ?? 0));
    if (dotted && !/^(?:require|import|fork|execFile|execFileSync)$/.test(callee)) continue;
    const args = argsOf(text, (m.index ?? 0) + m[0].length - 1);
    if (args === undefined) continue;
    // A method definition (`{ require(x) { ... } }`, `class C { load(x) { } }`) is no call: `) {` on the same line can only open a body; after a line break only inside an object literal or class.
    if (!dotted && /(?:^|[{,])\s*(?:(?:static|async|get|set)\s+)*\*?\s*$/.test(text.slice(Math.max(0, (m.index ?? 0) - 40), m.index ?? 0)) && bodyFollows(text, (m.index ?? 0) + m[0].length + args.length)) continue;
    const arg = firstArg(args);
    const spawns = /^(?:fork|execFile|execFileSync)$/.test(callee);
    // An alias, a member call and a name held string leave the hook's own folder in the set: only a direct literal-headed argument restricts.
    const direct = !dotted && /^(?:require|import|fork|execFile|execFileSync)$/.test(callee);
    const floor = !direct || /^[A-Za-z_$][\w$]*$/.test(arg.trim());
    if (spawns) for (const base of rootBases) loadEffect(tier, base, arg, text, floor);
    else loadEffect(tier, fromKey, arg, text, floor);
  }
  for (const m of text.matchAll(/(?<![\w$.])require\s*\.\s*resolve\s*\(/g)) {
    const args = argsOf(text, (m.index ?? 0) + m[0].length - 1);
    if (args !== undefined) loadEffect(tier, fromKey, firstArg(args), text, true);
  }
  // createRequire(...)(x) loads x like require does.
  for (const m of text.matchAll(new RegExp(`\\b(?:${createRequireNames(text).join("|")})\\s*\\(`, "g"))) {
    const open = (m.index ?? 0) + m[0].length - 1;
    const inner = argsOf(text, open);
    if (inner === undefined) continue;
    const after = open + inner.length + 2;
    const call = /^\s*\(/.exec(text.slice(after));
    if (!call) continue;
    const args = argsOf(text, after + call[0].length - 1);
    if (args !== undefined) loadEffect(tier, fromKey, firstArg(args), text, true);
  }
  // A code-running builtin that loads a file by name (cluster.setupPrimary({ exec }), module.register(...), Module._load(...)).
  if ((/(?:\bfrom\s*|\brequire\s*\(\s*|\bimport\s*\(\s*)["'`](?:node:)?(?:cluster|module)["'`]/.test(text) && /\b(?:setupPrimary|setupMaster)\s*\(|\bsettings\s*\.\s*exec\b|\bregister\s*\(|\b_load\s*\(/.test(text)) || /\b(?:module|constructor)\s*\.\s*(?:constructor\s*\.\s*)?_load\b/.test(text)) {
    tier.pkg = true;
    tier.tests = true;
    tier.flows = true;
  }
  // Any other mention of require, module.require or a createRequire result that is not itself an immediate call is a loader handed on as a value.
  const blank = codeOnly(text, [], false) ?? text;
  if (handedOn(blank, [...callers].filter((n) => !/^(?:require|import|fork|execFile|execFileSync)$/.test(n)), text)) {
    tier.pkg = true;
    tier.tests = true;
    tier.flows = true;
  }
  // require or import handed on as a value (`list.map(require)`, `[require]`) loads whatever it is called with later.
  for (const m of blank.matchAll(/(?:[(,[:?]|\breturn|=>)\s*(?:require|import)(?![\w$])(?!\s*[(.])/g)) {
    const at = (m.index ?? 0) + m[0].search(/(?:require|import)$/);
    const name = m[0].endsWith("require") ? "require" : "import";
    // A parameter or a property name is a name, not the loader: function (require, exports, module), { a: 1, require: x }.
    if (inParamList(blank, at, name.length)) continue;
    if (m[0].startsWith(",") && /^\s*:/.test(blank.slice(at + name.length, at + name.length + 6)) && !keyBindsLoader(blank, at + name.length)) continue;
    tier.pkg = true;
    tier.tests = true;
    tier.flows = true;
    break;
  }
  // A process call whose argument vector holds an element that is not a plain string names a file the same way. The vector may
  // be a literal, a name bound to one (through other names), a parameter, or an expression such as process.argv.slice(2).
  const vectorOf = (t: string, depth: number): string[] => {
    if (!/^[A-Za-z_$][\w$]*$/.test(t) || depth > 3) return [t];
    const inits = bindingsOf(t);
    return inits.length ? inits.flatMap((init) => vectorOf(init.trim(), depth + 1)) : [t];
  };
  for (const m of text.matchAll(/(?<![\w$])(?:spawn|spawnSync|execFile|execFileSync|fork)\s*\(/g)) {
    const args = argsOf(text, (m.index ?? 0) + m[0].length - 1);
    if (args === undefined) continue;
    const list = splitTop(args, ",");
    // An options object that sets cwd moves every relative file of the call (the package), when the program is node or a path;
    // a named tool (node-gyp, git) runs its own files.
    if (/\bcwd\s*:/.test(args)) {
      const program = list[0]?.trim() ?? "";
      const lit = strLit(program);
      const named = lit !== undefined && /^[\w.-]+$/.test(lit) && !/^(?:node|nodejs|bun|deno)$/.test(lit) && !lit.startsWith(".");
      if (/^fork\b/.test(m[0]) || !named) {
        tier.pkg = true;
        tier.tests = true;
        tier.flows = true;
      }
    }
    for (let k = 1; k < list.length; k++) {
      const t = list[k]!.trim();
      if (!t || t.startsWith("{") || strLit(t) !== undefined || FUNCTION_START.test(t)) continue;
      for (const v of vectorOf(t, 0)) {
        if (FUNCTION_START.test(v)) continue; // a callback held by a name
        if (v.startsWith("[") && v.endsWith("]")) {
          for (const el of splitTop(v.slice(1, -1), ",")) {
            const e = el.trim();
            if (e && strLit(e) === undefined && !/^-/.test(e)) for (const base of rootBases) loadEffect(tier, base, e, text, true);
          }
        } else if (!v.startsWith("{") && strLit(v) === undefined) for (const base of rootBases) loadEffect(tier, base, v, text, true);
      }
    }
  }
}

// npm sets npm_package_json to this package's manifest. dirname of it is the package root.
function stripPkgJsonEnv(text: string): string {
  return text.replace(/process\.env(?:\.npm_package_json|\s*\[\s*(['"])npm_package_json\1\s*\])/g, "");
}

function isPkgRootExpr(expr: string): boolean {
  const t = expr.replace(/\s+/g, "");
  if (t === "process.cwd()") return true;
  if (/^process\.env(?:\.INIT_CWD|\[['"]INIT_CWD['"]\])$/.test(t)) return true;
  return /^(?:[A-Za-z_$][\w$]*\.)?dirname\(process\.env(?:\.npm_package_json|\[['"]npm_package_json['"]\])\)$/.test(t);
}

// Classified calls are removed so a leftover Worker, vm.Script, or computed exec/spawn stays visible.
function stripClassifiedCalls(text: string): string {
  const re = /\b(?:require|import|fork|execFileSync|execFile|eval|Function)\s*\(|\bvm\s*\.\s*(?:runInThisContext|runInNewContext|runInContext|compileFunction)\s*\(/g;
  let out = "";
  let i = 0;
  for (const m of text.matchAll(re)) {
    const start = m.index ?? 0;
    if (start < i) continue;
    out += text.slice(i, start);
    const paren = start + m[0].lastIndexOf("(");
    const args = argsOf(text, paren);
    if (args === undefined) {
      i = start + m[0].length;
      continue;
    }
    i = paren + args.length + 2;
  }
  out += text.slice(i);
  return out;
}

function stripBraceGroups(src: string): string {
  let out = "";
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (quote) {
      if (depth === 0) out += c;
      if (c === "\\") {
        i++;
        if (depth === 0) out += src[i] ?? "";
        continue;
      }
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === "`") {
      quote = c;
      if (depth === 0) out += c;
      continue;
    }
    if (c === "{") {
      depth++;
      continue;
    }
    if (c === "}") {
      if (depth > 0) depth--;
      continue;
    }
    if (depth === 0) out += c;
  }
  return out;
}

function dynamicProcessRunner(text: string): boolean {
  const re = /\b(?:execSync|spawnSync|exec|spawn)\s*\(/g;
  for (const m of text.matchAll(re)) {
    const paren = (m.index ?? 0) + m[0].lastIndexOf("(");
    const args = argsOf(text, paren);
    if (args === undefined) return true;
    if (/__dirname|__filename|\$\{|\+/.test(stripBraceGroups(args))) return true;
  }
  return false;
}

function unclassifiedUnsafe(text: string): boolean {
  const rest = stripClassifiedCalls(text);
  if (/\bWorker\b/.test(rest)) return true;
  if (/\bvm\s*\./.test(rest)) return true;
  return dynamicProcessRunner(rest);
}

type NonJsLang = "py" | "rb" | "sh" | "pl";
type NonJsEffect = { kind: "static" } | { kind: "every" } | { kind: "dirs"; dirs: string[]; lits: string[] };

// A literal directory before a computed tail. `sh docs/` yields docs, not the command word.
function pathDir(lead: string): string | null {
  const tok = lead.trim().split(/\s+/).pop() ?? "";
  const cut = tok.lastIndexOf("/");
  if (cut < 0) return null;
  const dir = tok.slice(0, cut).replace(/^\.\//, "");
  if (!dir || badPath(dir)) return null;
  return dir;
}

function shellWords(src: string): { text: string; single: boolean }[] {
  const out: { text: string; single: boolean }[] = [];
  let i = 0;
  while (i < src.length) {
    while (i < src.length && /\s/.test(src[i]!)) i++;
    if (i >= src.length) break;
    const q = src[i]!;
    if (q === "'" || q === '"') {
      const end = src.indexOf(q, i + 1);
      out.push({ text: src.slice(i + 1, end === -1 ? src.length : end), single: q === "'" });
      i = end === -1 ? src.length : end + 1;
      continue;
    }
    let j = i;
    while (j < src.length && !/\s/.test(src[j]!)) j++;
    out.push({ text: src.slice(i, j), single: false });
    i = j;
  }
  return out;
}

// True when this site has no literal directory. The caller then widens to every file.

// A run or a load widens to every file unless each argument is a plain literal
// or one simple tail off a literal directory. Hole spellings are not special:
// anything that is not one of those two shapes widens.

type ArgHit =
  | { t: "none" }
  | { t: "open" }
  | { t: "lit"; path: string }
  | { t: "dir"; dir: string }
  | { t: "shell"; text: string }
  | { t: "code"; text: string };

function stripDot(p: string): string {
  let t = p.trim().replace(/\/{2,}/g, "/").replace(/^~(?:[+-]\d*|\d+)\/+/, "");
  while (t.startsWith("./")) t = t.slice(2);
  return t;
}

function isInterpToken(tok: string): boolean {
  if (tok === "sys.executable") return true;
  const base = tok.split("/").pop() ?? tok;
  return /^(?:sh|bash|dash|zsh|ksh|python\d*(?:\.\d+)?|ruby\d*(?:\.\d+)?|perl\d*|node|nodejs|env|exec|xargs|sudo)$/.test(base);
}

function openReadLit(expr: string): string | undefined {
  const m = /^open\s*\(\s*(['"])([^'"\n]*)\1\s*\)\s*\.\s*read\s*\(\s*\)$/.exec(expr.trim());
  return m?.[2];
}

function splitDot(src: string): string[] {
  const out: string[] = [];
  let cur = "";
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (quote) {
      cur += c;
      if (c === "\\") {
        cur += src[i + 1] ?? "";
        i++;
        continue;
      }
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === "`") {
      quote = c;
      cur += c;
      continue;
    }
    if (c === "(" || c === "[" || c === "{") {
      depth++;
      cur += c;
      continue;
    }
    if (c === ")" || c === "]" || c === "}") {
      depth--;
      cur += c;
      continue;
    }
    if (c === "." && depth === 0 && src[i - 1] !== "." && src[i + 1] !== ".") {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += c;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

function asPath(body: string, mode: "path" | "import"): ArgHit {
  const s = stripDot(body);
  if (!s || s.startsWith("-")) return { t: "none" };
  if (s.includes("://")) return { t: "none" };
  if (mode === "import" && !s.includes("/")) {
    const segs = s.split(".").filter(Boolean);
    if (segs.length >= 2 && segs.every((p) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(p))) return { t: "dir", dir: segs.slice(0, -1).join("/") };
    if (segs.length === 1 && /^[A-Za-z_][A-Za-z0-9_]*$/.test(s)) return { t: "lit", path: s };
    return { t: "none" };
  }
  if (badPath(s) || !/^[A-Za-z0-9_@.+/-]+$/.test(s)) return { t: "none" };
  return { t: "lit", path: s };
}

// One `$name`, `${name}`, or `#{ident}` after a literal directory. Anything else is open.
// When `safe` is passed, that name must be one this file assigned, and every value must
// be a plain word. An env name, a positional, or a builtin -v name is absent, so
// `./tools/$N.sh` widens. Omit `safe` to keep the directory bound (ruby `#{n}`).
function simpleTail(body: string, safe?: ReadonlySet<string>): string | null {
  if (body.includes("`") || body.includes("$(")) return null;
  const holes = [...body.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)|#\{([A-Za-z_][A-Za-z0-9_]*)\}/g)];
  if (holes.length !== 1) return null;
  const hole = holes[0]!;
  const at = hole.index ?? 0;
  const after = body.slice(at + hole[0].length);
  if (/[$`]/.test(after) || after.includes("#{")) return null;
  const dir = pathDir(body.slice(0, at));
  if (!dir) return null;
  if (safe) {
    const name = hole[1] ?? hole[2] ?? hole[3] ?? "";
    if (!safe.has(name)) return null;
  }
  return dir;
}

function classifyPlain(body: string, mode: "path" | "import", expand: boolean, safe?: ReadonlySet<string>): ArgHit {
  if (expand && (/[$`]/.test(body) || body.includes("#{") || body.includes("{}"))) {
    const dir = simpleTail(body, safe);
    if (!dir) return { t: "open" };
    return { t: "dir", dir };
  }
  if (/[*?[]/.test(body)) return { t: "open" };
  return asPath(body, mode);
}

function foldParts(parts: string[], mode: "path" | "import" | "shell"): ArgHit[] | "open" {
  let lead = "";
  let seenSimple = false;
  const lits: string[] = [];
  for (const raw of parts) {
    const s = raw.trim();
    if (!s) continue;
    const lit = strLit(s);
    if (lit !== undefined) {
      if (seenSimple && (lit.includes("..") || lit.startsWith("/"))) return "open";
      if (!seenSimple) lead += lit;
      lits.push(lit);
      continue;
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(s) || /^\$[A-Za-z_][A-Za-z0-9_]*$/.test(s)) {
      seenSimple = true;
      continue;
    }
    return "open";
  }
  if (!seenSimple) {
    const joined = lits.join("");
    if (mode === "shell") return [{ t: "shell", text: joined }];
    return [classifyPlain(joined, mode === "import" ? "import" : "path", false)];
  }
  const dir = pathDir(lead);
  if (!dir) return "open";
  return [{ t: "dir", dir }];
}

function quotedBody(expr: string, lit: string, mode: "path" | "import" | "shell", lang: NonJsLang): ArgHit {
  if (mode === "shell") return { t: "shell", text: lit };
  const expand = lang !== "py" && expr.trim().startsWith('"') && (/[$`]/.test(lit) || lit.includes("#{"));
  return classifyPlain(lit, mode === "import" ? "import" : "path", expand);
}

function classifyExpr(expr: string, mode: "path" | "import" | "shell" | "code", dot: boolean, lang: NonJsLang): ArgHit[] | "open" {
  const t = expr.trim();
  if (!t || isInterpToken(t)) return [];
  if (/^-[A-Za-z0-9_-]+$/.test(t)) return [];
  const read = openReadLit(t);
  if (read !== undefined) return [classifyPlain(read, "path", false)];
  if (t.startsWith("[") && t.endsWith("]")) {
    const acc: ArgHit[] = [];
    for (const el of splitTop(t.slice(1, -1), ",")) {
      const hit = classifyExpr(el, mode === "code" || mode === "shell" ? "path" : mode, dot, lang);
      if (hit === "open") return "open";
      acc.push(...hit);
    }
    return acc;
  }
  const plus = splitTop(t, "+");
  const dots = dot ? splitDot(t) : [t];
  if (plus.length > 1) return foldParts(plus, mode === "code" ? "path" : mode);
  if (dot && dots.length > 1) return foldParts(dots, mode === "code" ? "path" : mode);
  if (mode === "code") {
    const lit = strLit(t);
    if (lit !== undefined) return [{ t: "code", text: lit }];
    return "open";
  }
  const lit = strLit(t);
  if (lit !== undefined) return [quotedBody(t, lit, mode === "import" ? "import" : mode === "shell" ? "shell" : "path", lang)];
  return "open";
}

function positionals(args: string): string[] {
  return splitTop(args, ",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !/^[A-Za-z_][A-Za-z0-9_]*\s*=/.test(s));
}

function place(path: string, cd: string | undefined): string {
  if (!cd || path.includes("/")) return path;
  return `${cd}/${path}`;
}

function maskCode(text: string): string {
  let out = "";
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quote) {
      if (c === "\\") {
        out += " ";
        if (i + 1 < text.length) {
          out += " ";
          i++;
        }
        continue;
      }
      if (c === quote) {
        quote = null;
        out += c;
        continue;
      }
      out += c === "\n" ? "\n" : " ";
      continue;
    }
    if (c === "#" && text[i + 1] !== "{") {
      while (i < text.length && text[i] !== "\n") {
        out += " ";
        i++;
      }
      if (i < text.length) out += "\n";
      continue;
    }
    if (c === "'" || c === '"' || c === "`") {
      quote = c;
      out += c;
      continue;
    }
    out += c;
  }
  return out;
}

function readBareArg(text: string, i: number): string {
  let depth = 0;
  let quote: string | null = null;
  const start = i;
  for (; i < text.length; i++) {
    const c = text[i]!;
    if (quote) {
      if (c === "\\") {
        i++;
        continue;
      }
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === "`") {
      quote = c;
      continue;
    }
    if (c === "(" || c === "[" || c === "{") {
      depth++;
      continue;
    }
    if (c === ")" || c === "]" || c === "}") {
      depth--;
      continue;
    }
    if (depth === 0 && (c === "\n" || c === ";" || c === "#")) break;
  }
  return text.slice(start, i).trim();
}

const PY_CALL =
  /\b(subprocess\s*\.\s*(?:run|call|check_call|check_output|Popen|getoutput|getstatusoutput)|os\s*\.\s*(?:system|popen|chdir|execl\w*|execv\w*|spawnl\w*|spawnv\w*|posix_spawn)|runpy\s*\.\s*run_(?:path|module)|importlib\s*\.\s*import_module|import_module|__import__|execfile|exec|eval|compile|pty\s*\.\s*spawn|create_subprocess_(?:exec|shell)|check_call|check_output|getstatusoutput|getoutput|Popen|posix_spawn|run|call|[A-Za-z_][A-Za-z0-9_]*\s*\.\s*run)\s*\(/g;
const RB_CALL = /\b(require_relative|load|require|eval|system|exec|spawn|popen|capture2e|capture2|capture3|popen3|popen2)\b\s*(\()?/g;
const PL_CALL = /\b(do|require|eval|system|exec)\b\s*(\()?/g;

function calleeMode(name: string, shellFlag: boolean): "path" | "import" | "shell" | "code" | "chdir" {
  const n = name.replace(/\s+/g, "");
  if (n === "os.chdir" || n.endsWith(".chdir")) return "chdir";
  if (n === "import_module" || n.endsWith(".import_module") || n === "__import__") return "import";
  if (n === "exec" || n === "eval" || n === "compile" || n === "execfile") return "code";
  if (shellFlag || n === "system" || n === "popen" || n.endsWith(".system") || n.endsWith(".popen") || n === "create_subprocess_shell") return "shell";
  return "path";
}

function mergeSub(sub: NonJsEffect, dirs: Set<string>, lits: string[]): boolean {
  if (sub.kind === "every") return true;
  if (sub.kind === "dirs") {
    for (const d of sub.dirs) dirs.add(d);
    for (const n of sub.lits) lits.push(n);
  }
  return false;
}

function absorbHits(hits: ArgHit[], dirs: Set<string>, lits: string[], cd: string | undefined, lang: NonJsLang, depth: number): boolean {
  for (const h of hits) {
    if (h.t === "open") return true;
    if (h.t === "dir") dirs.add(h.dir);
    else if (h.t === "lit") lits.push(place(h.path, cd));
    else if (h.t === "shell") {
      if (mergeSub(classifyShell(h.text, depth + 1), dirs, lits)) return true;
    } else if (h.t === "code") {
      const subLang = lang === "sh" ? "py" : lang;
      if (mergeSub(classifyLang(h.text, subLang, depth + 1), dirs, lits)) return true;
    }
  }
  return false;
}

function classifyCalls(text: string, lang: "py" | "rb" | "pl", depth: number): NonJsEffect {
  if (depth > 3 || text.length > 1_000_000) return { kind: "every" };
  const mask = maskCode(text);
  const re = lang === "py" ? PY_CALL : lang === "rb" ? RB_CALL : PL_CALL;
  const dirs = new Set<string>();
  const lits: string[] = [];
  let cd: string | undefined;
  let cdOpen = false;
  let saw = false;
  for (const m of mask.matchAll(re)) {
    const name = (m[1] ?? "").replace(/\s+/g, "");
    const at = (m.index ?? 0) + m[0].length;
    const hasParen = m[0].endsWith("(");
    const args = hasParen ? argsOf(text, at - 1) : readBareArg(text, at);
    if (args === undefined) return { kind: "every" };
    // re.compile and an object eval are not runners. Kernel.system and Kernel.load are.
    if (/^(?:compile|eval)$/.test(name) && (m.index ?? 0) > 0 && text[(m.index ?? 0) - 1] === ".") continue;
    if (name.replace(/\s+/g, "").startsWith("asyncio.")) continue;
    if ((name === "do" || name === "eval") && args.trim().startsWith("{")) continue;
    const shellFlag = /\bshell\s*=\s*True\b/.test(args);
    const mode = calleeMode(name, shellFlag);
    const positional = positionals(args);
    const first = positional[0] ?? "";
    if (mode === "chdir") {
      const hit = classifyExpr(first, "path", false, lang);
      if (hit === "open") {
        cdOpen = true;
        cd = undefined;
        continue;
      }
      const lit = hit.find((h) => h.t === "lit");
      if (lit && lit.t === "lit" && !badPath(lit.path)) {
        cd = lit.path;
        cdOpen = false;
      } else {
        cdOpen = true;
        cd = undefined;
      }
      continue;
    }
    saw = true;
    if (cdOpen) return { kind: "every" };
    const dot = lang === "pl";
    const exprs = mode === "path" || mode === "shell" ? positional : [first];
    for (const ex of exprs.length ? exprs : [first]) {
      const hit = classifyExpr(ex, mode, dot, lang);
      if (hit === "open") return { kind: "every" };
      if (absorbHits(hit, dirs, lits, cd, lang, depth)) return { kind: "every" };
    }
  }
  if (lang === "rb" || lang === "pl") {
    for (const body of backtickBodies(text)) {
      saw = true;
      if (mergeSub(classifyShell(body, depth + 1), dirs, lits)) return { kind: "every" };
    }
  }
  if (lang === "rb") {
    for (const body of delimitedCommands(text, /(?:^|[^A-Za-z0-9_])%x/g)) {
      saw = true;
      if (mergeSub(classifyShell(body, depth + 1), dirs, lits)) return { kind: "every" };
    }
  }
  if (lang === "pl") {
    for (const body of delimitedCommands(text, /\bqx/g)) {
      saw = true;
      if (mergeSub(classifyShell(body, depth + 1), dirs, lits)) return { kind: "every" };
    }
  }
  if (lang === "py") {
    const pathHit = absorbSysPath(mask, text, dirs);
    if (pathHit === "every") return { kind: "every" };
    if (pathHit === "saw") saw = true;
    const got = absorbGetattr(mask, text, dirs, lits, cd, lang, depth);
    if (got === "every") return { kind: "every" };
    if (got === "saw") saw = true;
  }
  if (!saw || (dirs.size === 0 && lits.length === 0)) return { kind: "static" };
  return { kind: "dirs", dirs: [...dirs], lits };
}

// %x(...) and qx(...) run a shell. The delimiter is the character after the introducer.
function delimitedCommands(text: string, head: RegExp): string[] {
  const mask = maskCode(text);
  const out: string[] = [];
  for (const m of mask.matchAll(head)) {
    const at = (m.index ?? 0) + m[0].length;
    const delim = text[at];
    if (!delim || /[A-Za-z0-9_\s]/.test(delim)) continue;
    const close = delim === "(" ? ")" : delim === "{" ? "}" : delim === "[" ? "]" : delim === "<" ? ">" : delim;
    const paired = close !== delim;
    let body = "";
    let depth = 1;
    let i = at + 1;
    for (; i < text.length; i++) {
      const c = text[i]!;
      if (c === "\\") {
        body += text[i + 1] ?? "";
        i++;
        continue;
      }
      if (paired && c === delim) {
        depth++;
        body += c;
        continue;
      }
      if (c === close) {
        depth--;
        if (depth === 0) break;
      }
      body += c;
    }
    if (i < text.length) out.push(body);
  }
  return out;
}

// sys.path.insert/append/extend of a literal directory is that directory. Anything else widens.
function absorbSysPath(mask: string, text: string, dirs: Set<string>): "every" | "saw" | "none" {
  const re = /\bsys\s*\.\s*path\s*\.\s*(insert|append|extend)\s*\(/g;
  let saw: "saw" | "none" = "none";
  for (const m of mask.matchAll(re)) {
    const paren = (m.index ?? 0) + m[0].length - 1;
    const args = argsOf(text, paren);
    if (args === undefined) return "every";
    const pos = positionals(args);
    const expr = (m[1] === "insert" ? pos[1] : pos[0]) ?? "";
    const hit = classifyExpr(expr, "path", false, "py");
    if (hit === "open") return "every";
    let got = false;
    for (const h of hit) {
      if (h.t === "open") return "every";
      if (h.t === "lit" && !badPath(h.path)) {
        dirs.add(h.path.replace(/\/+$/, ""));
        got = true;
      } else if (h.t === "dir") {
        dirs.add(h.dir);
        got = true;
      }
    }
    if (!got) return "every";
    saw = "saw";
  }
  return saw;
}

// getattr(...)(...) runs whatever attribute it loaded. A plain command is followed.
function absorbGetattr(mask: string, text: string, dirs: Set<string>, lits: string[], cd: string | undefined, lang: NonJsLang, depth: number): "every" | "saw" | "none" {
  const re = /\bgetattr\s*\(/g;
  let saw: "saw" | "none" = "none";
  for (const m of mask.matchAll(re)) {
    const paren = (m.index ?? 0) + m[0].length - 1;
    const args = argsOf(text, paren);
    if (args === undefined) return "every";
    const close = paren + 1 + args.length;
    if (text[close] !== ")") return "every";
    let j = close + 1;
    while (j < text.length && /\s/.test(text[j]!)) j++;
    if (text[j] !== "(") continue;
    const invoke = argsOf(text, j);
    if (invoke === undefined) return "every";
    saw = "saw";
    const exprs = positionals(invoke);
    for (const ex of exprs.length ? exprs : [invoke]) {
      const hit = classifyExpr(ex, "shell", false, "py");
      if (hit === "open") return "every";
      if (absorbHits(hit, dirs, lits, cd, lang, depth)) return "every";
    }
  }
  return saw;
}

function backtickBodies(text: string): string[] {
  const out: string[] = [];
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quote) {
      if (c === "\\") {
        i++;
        continue;
      }
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      continue;
    }
    if (c !== "`") continue;
    let body = "";
    let j = i + 1;
    for (; j < text.length; j++) {
      if (text[j] === "\\") {
        body += text[j + 1] ?? "";
        j++;
        continue;
      }
      if (text[j] === "`") break;
      body += text[j] ?? "";
    }
    if (j >= text.length) break;
    out.push(body);
    i = j;
  }
  return out;
}

function classifyLang(text: string, lang: "py" | "rb" | "pl", depth: number): NonJsEffect {
  return classifyCalls(text, lang, depth);
}

function stripShellKw(seg: string): string {
  let s = seg.trim();
  for (;;) {
    const next = s.replace(/^(?:if|then|else|elif|fi|do|done|while|until|for|case|esac|in|\{|\})\b\s*/, "").trim();
    if (next === s) return s;
    s = next;
  }
}

function splitOutside(text: string, kind: "stmt" | "pipe"): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: string | undefined;
  const push = () => {
    if (cur.trim()) out.push(cur.trim());
    cur = "";
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quote) {
      cur += c;
      if (c === quote) quote = undefined;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      cur += c;
      continue;
    }
    if (kind === "stmt" && (c === ";" || c === "\n")) {
      push();
      continue;
    }
    if (kind === "stmt" && c === "&") {
      push();
      if (text[i + 1] === "&") i++;
      continue;
    }
    if (c === "|" && text[i + 1] === "|") {
      if (kind === "stmt") push();
      else cur += c;
      if (kind === "stmt") i++;
      else {
        cur += text[i + 1]!;
        i++;
      }
      continue;
    }
    if (kind === "pipe" && c === "|") {
      push();
      continue;
    }
    cur += c;
  }
  push();
  return out;
}

type ShWord = { text: string; single: boolean };
type ShCmd = { cmd: string; cmdSingle: boolean; args: ShWord[]; redirIn: ShWord[]; assigns: ShWord[] };

function parseCmd(seg: string): ShCmd {
  const words = shellWords(stripShellKw(seg));
  let i = 0;
  const assigns: ShWord[] = [];
  while (i < words.length && !words[i]!.single && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]!.text)) {
    assigns.push(words[i]!);
    i++;
  }
  const redirIn: ShWord[] = [];
  const args: ShWord[] = [];
  let cmd = "";
  let cmdSingle = false;
  for (; i < words.length; i++) {
    const w = words[i]!;
    if ((w.text === "<" || w.text === "<<" || w.text === "<<-") && words[i + 1]) {
      if (w.text === "<") redirIn.push(words[i + 1]!);
      i++;
      continue;
    }
    if ((w.text === ">" || w.text === ">>") && words[i + 1]) {
      i++;
      continue;
    }
    if (!cmd) {
      cmd = w.text;
      cmdSingle = w.single;
      continue;
    }
    args.push(w);
  }
  return { cmd, cmdSingle, args, redirIn, assigns };
}

// A joined flag that carries a path, such as -mdocs.run or -rdocs/run.
function flagEmbedsPath(tok: string): boolean {
  if (!tok.startsWith("-") || tok.startsWith("<<")) return false;
  if (tok.includes("/")) return true;
  const rest = /^-[mrMR](.+)$/.exec(tok)?.[1] ?? "";
  return rest.includes(".") || rest.includes("/");
}

function envHasAssign(cmd: ShCmd): boolean {
  const base = cmd.cmd.split("/").pop() ?? cmd.cmd;
  if (base !== "env") return false;
  return cmd.args.some((w) => !w.single && /^[A-Za-z_][A-Za-z0-9_]*=/.test(w.text));
}

function unwrapEnv(cmd: ShCmd): ShCmd {
  const base = cmd.cmd.split("/").pop() ?? cmd.cmd;
  if (base !== "env") return cmd;
  let i = 0;
  while (i < cmd.args.length && !cmd.args[i]!.single && /^[A-Za-z_][A-Za-z0-9_]*=/.test(cmd.args[i]!.text)) i++;
  while (i < cmd.args.length && cmd.args[i]!.text.startsWith("-")) i++;
  const next = cmd.args[i];
  if (!next) return cmd;
  return { cmd: next.text, cmdSingle: next.single, args: cmd.args.slice(i + 1), redirIn: cmd.redirIn, assigns: cmd.assigns };
}

// An unquoted $ or ${...} in the command word widens, unless a literal directory
// bounds it and the name is a safe assignment (N=run, then ./tools/$N.sh).
// '$X' is the characters dollar-X.
function expandedCommand(cmd: ShCmd, safe?: ReadonlySet<string>): boolean {
  if (!cmd.cmd || cmd.cmdSingle) return false;
  if (!cmd.cmd.includes("$")) return false;
  return simpleTail(cmd.cmd, safe) === null;
}

function isRunnerCmd(cmd: ShCmd): boolean {
  const c = cmd.cmd;
  if (!c) return false;
  if (c === "." || c === "source") return true;
  const base = c.split("/").pop() ?? c;
  const named = /^(?:sh|bash|dash|zsh|ksh|python\d*(?:\.\d+)?|ruby\d*(?:\.\d+)?|perl\d*|node|nodejs|xargs|exec|eval)$/.test(base);
  if (named && (c === base || c.startsWith("/"))) return true;
  if (c.startsWith(".") || (c.includes("/") && !c.startsWith("/"))) return true;
  if (!c.includes("/") && c.includes("$") && !c.includes("`") && !c.includes("$(")) return true;
  return false;
}

function wordHit(w: ShWord, safe?: ReadonlySet<string>): ArgHit {
  return classifyPlain(w.text, "path", !w.single, safe);
}

function absorbWord(w: ShWord, dirs: Set<string>, lits: string[], cd: string | undefined, safe?: ReadonlySet<string>): boolean {
  if (!w.text || isInterpToken(w.text)) return false;
  if (w.text === "{}") return true;
  const hit = wordHit(w, safe);
  if (hit.t === "open") return true;
  if (hit.t === "dir") dirs.add(hit.dir);
  if (hit.t === "lit") lits.push(place(hit.path, cd));
  return false;
}

function codeLang(cmd: string): NonJsLang | undefined {
  const base = cmd.split("/").pop() ?? cmd;
  if (/^python\d*(?:\.\d+)?$/.test(base)) return "py";
  if (/^ruby\d*(?:\.\d+)?$/.test(base)) return "rb";
  if (/^perl\d*$/.test(base)) return "pl";
  if (/^(?:sh|bash|dash|zsh|ksh)$/.test(base)) return "sh";
  return undefined;
}

function absorbRunner(cmd: ShCmd, dirs: Set<string>, lits: string[], cd: string | undefined, depth: number, safe?: ReadonlySet<string>): boolean {
  const c = cmd.cmd;
  if (c.includes("/") && !c.startsWith("/") && c !== ".") {
    if (absorbWord({ text: c, single: false }, dirs, lits, cd, safe)) return true;
  }
  for (const r of cmd.redirIn) if (absorbWord(r, dirs, lits, cd, safe)) return true;
  for (let i = 0; i < cmd.args.length; i++) {
    const w = cmd.args[i]!;
    if (w.text === "-c" || w.text === "-e" || w.text === "--eval" || w.text === "--command") {
      const code = cmd.args[i + 1];
      i++;
      if (!code) return true;
      if (!code.single && (/[$`]/.test(code.text) || code.text.includes("#{"))) return true;
      const sub = codeLang(cmd.cmd);
      if (!sub) continue;
      const inner = sub === "sh" ? classifyShell(code.text, depth + 1) : classifyLang(code.text, sub, depth + 1);
      if (mergeSub(inner, dirs, lits)) return true;
      continue;
    }
    if (w.text.startsWith("-") || w.text.startsWith("<<")) {
      if (flagEmbedsPath(w.text)) return true;
      continue;
    }
    if (absorbWord(w, dirs, lits, cd, safe)) return true;
  }
  return false;
}

function absorbPipe(cmd: ShCmd, dirs: Set<string>, lits: string[], safe?: ReadonlySet<string>): boolean {
  if (cmd.cmd.includes("/") && !cmd.cmd.startsWith("/")) {
    if (absorbWord({ text: cmd.cmd, single: false }, dirs, lits, undefined, safe)) return true;
  }
  for (const w of cmd.args) {
    if (w.text.startsWith("-")) continue;
    if (absorbWord(w, dirs, lits, undefined, safe)) return true;
  }
  for (const r of cmd.redirIn) if (absorbWord(r, dirs, lits, undefined, safe)) return true;
  return false;
}

// A tail value is safe only when the whole word is plain. A dot, quote, or backslash is not.
const PLAIN_TAIL = /^[A-Za-z0-9_-]+$/;
const SH_BUILTIN = new Set(
  ". : [ alias bg bind break builtin caller cd command compgen complete continue declare dirs disown echo enable eval exec exit export false fc fg getopts hash help history jobs kill let local logout mapfile popd printf pushd pwd read readarray readonly return set shift shopt source suspend test times trap true type typeset ulimit umask unalias unset wait".split(/\s+/),
);

// A name is safe when this file assigns it and every value matches PLAIN_TAIL.
// Prefix assigns count (`N=run cmd`). `export N=...` does not, so that name stays unknown.
// `printf '-v' N` poisons N: quotes are not data. `printf -v N[0]` poisons the prefix N.
// Any eval word, or `.` / `source` with an argument, clears safe names. That text can rebind them.
function shellSafeTails(text: string): Set<string> {
  if (sourcesOtherFile(text)) return new Set();
  const bad = new Set<string>();
  const assigned = new Set<string>();
  const poison = (name: string) => {
    assigned.add(name);
    bad.add(name);
  };
  for (const stmt of splitOutside(text, "stmt")) {
    for (const seg of splitOutside(stmt, "pipe")) {
      const cmd = unwrapEnv(parseCmd(seg));
      for (const a of cmd.assigns) {
        const eq = a.text.indexOf("=");
        if (eq <= 0) continue;
        const name = a.text.slice(0, eq);
        assigned.add(name);
        if (!PLAIN_TAIL.test(a.text.slice(eq + 1))) bad.add(name);
      }
      const base = cmd.cmd.split("/").pop() ?? cmd.cmd;
      if (!SH_BUILTIN.has(base)) continue;
      for (let i = 0; i < cmd.args.length; i++) {
        const w = cmd.args[i]!;
        if (w.text === "-v") {
          const next = cmd.args[i + 1];
          const name = next ? /^[A-Za-z_][A-Za-z0-9_]*/.exec(next.text)?.[0] : undefined;
          if (name) poison(name);
          i++;
          continue;
        }
        const attached = /^-v([A-Za-z_][A-Za-z0-9_]*)/.exec(w.text);
        if (attached?.[1]) poison(attached[1]);
      }
    }
  }
  const safe = new Set<string>();
  for (const name of assigned) if (!bad.has(name)) safe.add(name);
  return safe;
}

function classifyShell(text: string, depth = 0): NonJsEffect {
  if (depth > 3 || text.length > 1_000_000) return { kind: "every" };
  const masked = text.replace(/\$\{?npm_package_config_[A-Za-z0-9_]+\}?/g, "");
  if (changesDirectory(masked)) return { kind: "every" };
  const safe = shellSafeTails(masked);
  const dirs = new Set<string>();
  const lits: string[] = [];
  let cd: string | undefined;
  let cdOpen = false;
  let saw = false;
  for (const stmt of splitOutside(masked, "stmt")) {
    const rawParts = splitOutside(stmt, "pipe").map((seg) => parseCmd(seg));
    if (rawParts.some((p) => {
      const ran = unwrapEnv(p);
      return isRunnerCmd(ran) && (p.assigns.length > 0 || envHasAssign(p));
    })) return { kind: "every" };
    const parts = rawParts.map((p) => unwrapEnv(p));
    if (parts.length === 0 || !parts[0]!.cmd) continue;
    if (parts.some((p) => (p.cmd.split("/").pop() ?? p.cmd) === "find" && p.args.some((w) => w.text === "-exec" || w.text === "-execdir"))) {
      return { kind: "every" };
    }
    const last = parts[parts.length - 1]!;
    const piped = parts.length > 1 && isRunnerCmd(last);
    if (piped) {
      saw = true;
      if (cdOpen) return { kind: "every" };
      for (const p of parts.slice(0, -1)) if (absorbPipe(p, dirs, lits, safe)) return { kind: "every" };
      if (absorbRunner(last, dirs, lits, cd, depth, safe)) return { kind: "every" };
      // `echo 'script' | sh` is the same text as `sh -c script` when every word is a literal.
      const sub = codeLang(last.cmd);
      if (sub && shellReadsStdin(last)) {
        const script = pipeScript(parts.slice(0, -1));
        if (script === "open") return { kind: "every" };
        if (script !== undefined) {
          if (sub === "sh") {
            const inner = classifyShell(script, depth + 1);
            if (mergeSub(inner, dirs, lits) || shellUncovered(script, inner, depth + 1)) return { kind: "every" };
          } else {
            const inner = classifyLang(script, sub, depth + 1);
            if (inner.kind === "every" || codeUncovered(script, sub, inner)) return { kind: "every" };
            mergeSub(inner, dirs, lits);
          }
        }
      }
      continue;
    }
    const cmd = parts[0]!;
    if ((cmd.cmd.split("/").pop() ?? cmd.cmd) === "cd") {
      const arg = cmd.args[0];
      if (!arg) {
        cdOpen = true;
        cd = undefined;
        continue;
      }
      const hit = wordHit(arg, safe);
      if (hit.t === "lit" && !badPath(hit.path)) {
        cd = hit.path;
        cdOpen = false;
      } else {
        cdOpen = true;
        cd = undefined;
      }
      continue;
    }
    if (!isRunnerCmd(cmd)) continue;
    saw = true;
    if (cdOpen) return { kind: "every" };
    if (absorbRunner(cmd, dirs, lits, cd, depth, safe)) return { kind: "every" };
  }
  if (!saw || (dirs.size === 0 && lits.length === 0)) return { kind: "static" };
  return { kind: "dirs", dirs: [...dirs], lits };
}

// A plain import of one of these is not a run. A local or third-party name is.
const PY_STDLIB = new Set(
  "abc argparse ast asyncio atexit base64 binascii builtins codecs collections contextlib copy csv ctypes dataclasses datetime decimal distutils enum errno fnmatch functools gc getopt getpass glob gzip hashlib hmac html http importlib inspect io itertools json logging math multiprocessing os pathlib pickle pkgutil platform pprint pty pwd py_compile queue random re runpy shlex shutil signal site socket sqlite3 ssl stat string struct subprocess sys sysconfig tarfile tempfile textwrap threading time traceback types typing unicodedata unittest urllib uuid warnings weakref xml zipfile zlib __future__".split(" "),
);
const SH_ALLOW = new Set(["echo", "printf", "true", "test", "[", "mkdir", "exit"]);

function blankRange(buf: string[], from: number, to: number): void {
  const end = Math.min(buf.length, to);
  for (let i = Math.max(0, from); i < end; i++) {
    if (buf[i] !== "\n") buf[i] = " ";
  }
}

function blankCallMatch(text: string, buf: string[], index: number, matchLen: number): void {
  const at = index + matchLen;
  if (text[at - 1] === "(") {
    const args = argsOf(text, at - 1);
    if (args === undefined) {
      blankRange(buf, index, at);
      return;
    }
    blankRange(buf, index, at + args.length + 1);
    return;
  }
  blankRange(buf, index, at + readBareArg(text, at).length);
}

function blankDelimited(text: string, buf: string[], head: RegExp): void {
  const mask = maskCode(text);
  for (const m of mask.matchAll(head)) {
    const at = (m.index ?? 0) + m[0].length;
    const delim = text[at];
    if (!delim || /[A-Za-z0-9_\s]/.test(delim)) continue;
    const close = delim === "(" ? ")" : delim === "{" ? "}" : delim === "[" ? "]" : delim === "<" ? ">" : delim;
    const paired = close !== delim;
    let depth = 1;
    let i = at + 1;
    for (; i < text.length; i++) {
      const c = text[i]!;
      if (c === "\\") {
        i++;
        continue;
      }
      if (paired && c === delim) {
        depth++;
        continue;
      }
      if (c === close) {
        depth--;
        if (depth === 0) break;
      }
    }
    if (i >= text.length) continue;
    const start = /[%q]/.test(text[m.index ?? 0] ?? "") ? (m.index ?? 0) : (m.index ?? 0) + 1;
    blankRange(buf, start, i + 1);
  }
}

function blankBackticks(text: string, buf: string[]): void {
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quote) {
      if (c === "\\") {
        i++;
        continue;
      }
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      continue;
    }
    if (c !== "`") continue;
    let j = i + 1;
    for (; j < text.length; j++) {
      if (text[j] === "\\") {
        j++;
        continue;
      }
      if (text[j] === "`") break;
    }
    if (j >= text.length) break;
    blankRange(buf, i, j + 1);
    i = j;
  }
}

// Recognized runners are removed only after they followed a path, so a missed spelling stays a call.
function blankRunners(text: string, lang: "py" | "rb" | "pl"): string {
  const buf = [...text];
  const mask = maskCode(text);
  const re = lang === "py" ? PY_CALL : lang === "rb" ? RB_CALL : PL_CALL;
  for (const m of mask.matchAll(re)) blankCallMatch(text, buf, m.index ?? 0, m[0].length);
  if (lang === "py") {
    const pathRe = /\bsys\s*\.\s*path\s*\.\s*(?:insert|append|extend)\s*\(/g;
    for (const m of mask.matchAll(pathRe)) blankCallMatch(text, buf, m.index ?? 0, m[0].length);
    const getattrRe = /\bgetattr\s*\(/g;
    for (const m of mask.matchAll(getattrRe)) {
      const paren = (m.index ?? 0) + m[0].length - 1;
      const args = argsOf(text, paren);
      if (args === undefined) continue;
      const close = paren + 1 + args.length;
      if (text[close] !== ")") continue;
      let j = close + 1;
      while (j < text.length && /\s/.test(text[j]!)) j++;
      if (text[j] !== "(") continue;
      const invoke = argsOf(text, j);
      if (invoke === undefined) continue;
      blankRange(buf, m.index ?? 0, j + invoke.length + 2);
    }
  }
  if (lang === "rb") blankDelimited(text, buf, /(?:^|[^A-Za-z0-9_])%x/g);
  if (lang === "pl") blankDelimited(text, buf, /\bqx/g);
  if (lang === "rb" || lang === "pl") blankBackticks(text, buf);
  return buf.join("");
}

function blankPrints(text: string, lang: "py" | "rb" | "pl"): string {
  const buf = [...text];
  const mask = maskCode(text);
  const re = lang === "rb" ? /\b(?:print|puts|say|p)\s*\(/g : /\b(?:print|puts|say)\s*\(/g;
  for (const m of mask.matchAll(re)) blankCallMatch(text, buf, m.index ?? 0, m[0].length);
  return buf.join("");
}

function pathOrEnvTouch(text: string, lang: "py" | "rb" | "pl"): boolean {
  const mask = maskCode(text);
  if (lang === "py") {
    if (/\bos\s*\.\s*environ\s*\[[^\]]*\]\s*=(?!=)/.test(mask)) return true;
    if (/\bos\s*\.\s*(?:putenv|environ\s*\.\s*(?:update|setdefault))\s*\(/.test(mask)) return true;
    if (/\bsite\s*\.\s*addsitedir\b/.test(mask)) return true;
    if (/\bsys\s*\.\s*path\b(?!\s*\.\s*(?:insert|append|extend)\s*\()/.test(mask)) return true;
  }
  if (lang === "rb" && (/\$LOAD_PATH|\$:/.test(mask) || /\bENV\s*\[[^\]]*\]\s*=(?!=)/.test(mask))) return true;
  if (lang === "pl" && (/@INC|\buse\s+lib\b/.test(mask) || /\$ENV\s*\{[^}]*\}\s*=(?!=)/.test(mask))) return true;
  return false;
}

function nonStdlibImport(text: string, parsed: NonJsEffect): boolean {
  for (const imp of pyImports(text)) {
    if (PY_STDLIB.has(imp.root)) continue;
    const plain = /^[A-Za-z_][A-Za-z0-9_]*$/.test(imp.name);
    if (parsed.kind === "dirs" && parsed.dirs.length > 0 && plain) continue;
    return true;
  }
  return false;
}

// The text between one `{` and its matching `}`. Quotes and nested braces stay inside.
function braceInner(text: string, open: number): { core: string; next: number } | undefined {
  let depth = 1;
  let i = open + 1;
  let quote: string | null = null;
  let triple = false;
  const start = i;
  while (i < text.length) {
    const c = text[i]!;
    if (quote) {
      if (c === "\\") {
        i += 2;
        continue;
      }
      if (triple && text.startsWith(quote + quote + quote, i)) {
        quote = null;
        triple = false;
        i += 3;
        continue;
      }
      if (!triple && c === quote) quote = null;
      i++;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      triple = text[i + 1] === c && text[i + 2] === c;
      i += triple ? 3 : 1;
      continue;
    }
    if (c === "{") {
      depth++;
      i++;
      continue;
    }
    if (c === "}") {
      depth--;
      if (depth === 0) return { core: text.slice(start, i).trim(), next: i + 1 };
      i++;
      continue;
    }
    i++;
  }
  return undefined;
}

function isFPrefix(text: string, quoteAt: number): boolean {
  let j = quoteAt - 1;
  let prefix = "";
  while (j >= 0 && /[A-Za-z]/.test(text[j]!)) {
    prefix = text[j]! + prefix;
    j--;
  }
  if (j >= 0 && /[A-Za-z0-9_]/.test(text[j]!)) return false;
  const p = prefix.toLowerCase();
  return p === "f" || p === "fr" || p === "rf";
}

function skipQuoted(text: string, i: number, endMark: string): number {
  while (i < text.length) {
    if (text.startsWith(endMark, i)) return i + endMark.length;
    if (text[i] === "\\") {
      i += 2;
      continue;
    }
    i++;
  }
  return text.length;
}

// An f-string hole that is not one bare name can run code. `f"{name}"` does not.
function walkFString(text: string, i: number, endMark: string): number | "unsafe" {
  while (i < text.length) {
    if (text.startsWith(endMark, i)) return i + endMark.length;
    const c = text[i]!;
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === "{") {
      if (text[i + 1] === "{") {
        i += 2;
        continue;
      }
      const hole = braceInner(text, i);
      if (!hole || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(hole.core)) return "unsafe";
      i = hole.next;
      continue;
    }
    i++;
  }
  return "unsafe";
}

function fStringHoleUnsafe(text: string): boolean {
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (c === "#") {
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }
    if (c !== "'" && c !== '"') {
      i++;
      continue;
    }
    const triple = text[i + 1] === c && text[i + 2] === c;
    const endMark = triple ? c + c + c : c;
    const bodyAt = i + endMark.length;
    if (isFPrefix(text, i)) {
      const walked = walkFString(text, bodyAt, endMark);
      if (walked === "unsafe") return true;
      i = walked;
      continue;
    }
    i = skipQuoted(text, bodyAt, endMark);
  }
  return false;
}

// "#{expr}" runs unless expr is one bare name. Backticks and %x run anywhere outside a single quote.
function rubyHoleUnsafe(text: string): boolean {
  let i = 0;
  let quote: string | null = null;
  while (i < text.length) {
    const c = text[i]!;
    if (quote === "'") {
      if (c === "\\") {
        i += 2;
        continue;
      }
      if (c === "'") quote = null;
      i++;
      continue;
    }
    if (quote === '"') {
      if (c === "\\") {
        i += 2;
        continue;
      }
      if (c === '"') {
        quote = null;
        i++;
        continue;
      }
      if (c === "#" && text[i + 1] === "{") {
        const hole = braceInner(text, i + 1);
        if (!hole || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(hole.core)) return true;
        i = hole.next;
        continue;
      }
      i++;
      continue;
    }
    if (c === "#") {
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }
    if (c === "'") {
      quote = "'";
      i++;
      continue;
    }
    if (c === '"') {
      quote = '"';
      i++;
      continue;
    }
    if (c === "`") return true;
    if (c === "%" && text[i + 1] === "x" && !/[A-Za-z0-9_]/.test(text[i + 2] ?? " ")) return true;
    i++;
  }
  return false;
}

function argIsPlain(expr: string, lang: "py" | "rb" | "pl"): boolean {
  const t = expr.trim();
  if (!t) return true;
  if (/^(?:None|True|False|nil|true|false)$/.test(t)) return true;
  if (/^[+-]?\d+(?:\.\d+)?$/.test(t)) return true;
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(t)) return true;
  if (lang === "py") {
    const q = t.search(/['"]/);
    if (q > 0 && isFPrefix(t, q)) return !fStringHoleUnsafe(t);
  }
  if (lang === "rb" && rubyHoleUnsafe(t)) return false;
  return strLit(t) !== undefined;
}

// print(os.system(...)) and print(vars(os)['system'](...)) are calls, not literals.
function printArgsUnsafe(text: string, lang: "py" | "rb" | "pl"): boolean {
  const mask = maskCode(text);
  const re = lang === "rb" ? /\b(?:print|puts|say|p)\s*\(/g : /\b(?:print|puts|say)\s*\(/g;
  for (const m of mask.matchAll(re)) {
    const paren = (m.index ?? 0) + m[0].length - 1;
    const args = argsOf(text, paren);
    if (args === undefined) return true;
    for (const part of splitTop(args, ",")) {
      const raw = part.trim().replace(/^[A-Za-z_][A-Za-z0-9_]*\s*=\s*/, "");
      if (!argIsPlain(raw, lang)) return true;
    }
  }
  return false;
}

// Dirty when a statement is not an allowlisted print, literal assignment, or stdlib import.
// A runner that already followed a path is blanked first, so its literals stay narrow.
// Code inside a print, an f-string, or a ruby interpolation is still checked.
function codeUncovered(text: string, lang: "py" | "rb" | "pl", parsed: NonJsEffect): boolean {
  if (pathOrEnvTouch(text, lang)) return true;
  if (lang === "py" && fStringHoleUnsafe(text)) return true;
  if (printArgsUnsafe(text, lang)) return true;
  // A %x or backtick that already followed a literal stays that file. One hidden in a string does not.
  const peeled = parsed.kind === "dirs" ? blankRunners(text, lang) : text;
  if (lang === "rb" && rubyHoleUnsafe(peeled)) return true;
  const masked = maskCode(blankPrints(peeled, lang));
  if (masked.includes("(")) return true;
  if (lang === "py" && nonStdlibImport(text, parsed)) return true;
  if (/\b(?:async\s+def|def|class|lambda)\b/.test(masked)) return true;
  return false;
}

function runnerCovered(cmd: ShCmd, depth: number): boolean {
  for (let i = 0; i < cmd.args.length; i++) {
    const w = cmd.args[i]!;
    if (w.text === "-m" || w.text === "--module") return false;
    if (w.text !== "-c" && w.text !== "-e" && w.text !== "--eval" && w.text !== "--command") continue;
    const code = cmd.args[i + 1];
    if (!code) return false;
    if (!code.single && (/[$`]/.test(code.text) || code.text.includes("#{"))) return false;
    const sub = codeLang(cmd.cmd);
    if (!sub || sub === "sh") {
      const inner = classifyShell(code.text, depth + 1);
      return !shellUncovered(code.text, inner, depth + 1);
    }
    const inner = classifyLang(code.text, sub, depth + 1);
    if (inner.kind === "every") return false;
    return !codeUncovered(code.text, sub, inner);
  }
  return true;
}

function commandCovered(cmd: ShCmd, depth: number): boolean {
  const base = cmd.cmd.split("/").pop() ?? cmd.cmd;
  if (!base) return true;
  if (base === "export") return false;
  if (SH_ALLOW.has(base)) return true;
  if (base === "cd") {
    const arg = cmd.args[0];
    if (!arg || cmd.args.length !== 1) return false;
    if (arg.text.startsWith("-") || arg.text.startsWith("/") || /[$`]/.test(arg.text) || arg.text.includes("#{")) return false;
    return true;
  }
  return isRunnerCmd(cmd) && runnerCovered(cmd, depth);
}

// `sh` with no script file reads the pipe. `sh docs/run.sh` does not.
function shellReadsStdin(cmd: ShCmd): boolean {
  if (cmd.args.some((w) => w.text === "-c" || w.text === "-e" || w.text === "--eval" || w.text === "--command")) return false;
  return !cmd.args.some((w) => w.text !== "-" && !w.text.startsWith("-") && !w.text.startsWith("<<"));
}

// echo/printf of plain literals is the script. Anything expanded is not a literal.
function pipeScript(up: ShCmd[]): string | "open" | undefined {
  if (up.length !== 1) return undefined;
  const cmd = up[0]!;
  const base = cmd.cmd.split("/").pop() ?? "";
  if (base !== "echo" && base !== "printf") return undefined;
  if (cmd.assigns.length > 0) return "open";
  let args = cmd.args;
  if (base === "echo") args = args.filter((w) => w.text !== "-n" && w.text !== "-e" && w.text !== "-E");
  if (base === "printf") {
    if (args.length === 0) return "open";
    args = args.slice(1);
  }
  if (args.length === 0) return undefined;
  const chunks: string[] = [];
  for (const w of args) {
    if (!w.single && (/[$`]/.test(w.text) || w.text.includes("#{"))) return "open";
    chunks.push(w.text);
  }
  return chunks.join(" ");
}

// $(...), backticks, and $((...)) run, including inside ${name:-$(...)}. ${name} and $name do not.
function shellSubst(text: string): boolean {
  let i = 0;
  let quote: string | null = null;
  while (i < text.length) {
    const c = text[i]!;
    if (quote) {
      if (c === "\\" && quote !== "'") {
        i += 2;
        continue;
      }
      if (c === quote) {
        quote = null;
        i++;
        continue;
      }
      if (quote === '"' && substAt(text, i)) return true;
      i++;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      i++;
      continue;
    }
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === "#") {
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }
    if (substAt(text, i)) return true;
    const heredoc = quotedHeredocEnd(text, i);
    if (heredoc !== undefined) {
      i = heredoc;
      continue;
    }
    i++;
  }
  return false;
}

function substAt(text: string, i: number): boolean {
  const c = text[i]!;
  if (c === "`") return true;
  if (c !== "$") return false;
  return text[i + 1] === "(";
}

// <<'EOF' does not expand. The body is skipped. <<"EOF" and <<EOF still expand.
function quotedHeredocEnd(text: string, i: number): number | undefined {
  if (text[i] !== "<" || text[i + 1] !== "<" || text[i + 2] === "<") return undefined;
  let j = i + 2;
  if (text[j] === "-") j++;
  while (j < text.length && (text[j] === " " || text[j] === "\t")) j++;
  if (text[j] !== "'") return undefined;
  j++;
  const start = j;
  while (j < text.length && text[j] !== "'" && text[j] !== "\n") j++;
  if (text[j] !== "'") return undefined;
  const delim = text.slice(start, j);
  j++;
  const nl = text.indexOf("\n", j);
  if (nl < 0) return text.length;
  let k = nl + 1;
  while (k <= text.length) {
    const lineEnd = text.indexOf("\n", k);
    const end = lineEnd < 0 ? text.length : lineEnd;
    if (text.slice(k, end) === delim) return end + (lineEnd < 0 ? 0 : 1);
    if (lineEnd < 0) return text.length;
    k = lineEnd + 1;
  }
  return text.length;
}

// echo, printf, true, test, mkdir, and exit are static when their arguments do not
// expand. $(...), backticks, a PATH assignment, export, a function, process
// substitution, and a command word with an unquoted $ that has no literal directory
// widen. ./tools/$N.sh stays on that directory only when N is a plain-word assignment.
// A value that is not ^[A-Za-z0-9_-]+$, a builtin -v name, or an unassigned name
// reaches every file.
// A parsed runner keeps its literal follow.
function shellUncovered(text: string, parsed: NonJsEffect, depth = 0): boolean {
  if (depth > 3) return true;
  if (/<\(|>\(/.test(text)) return true;
  if (/\bfunction\s+[A-Za-z_]/.test(text)) return true;
  if (/(^|[^A-Za-z0-9_])[A-Za-z_][A-Za-z0-9_]*\s*\(\s*\)\s*\{/.test(text)) return true;
  const masked = text.replace(/\$\{?npm_package_config_[A-Za-z0-9_]+\}?/g, "");
  const safe = shellSafeTails(masked);
  if (shellSubst(masked)) return true;
  for (const stmt of splitOutside(masked, "stmt")) {
    const rawParts = splitOutside(stmt, "pipe").map((seg) => parseCmd(seg));
    for (const raw of rawParts) {
      for (const a of raw.assigns) {
        const eq = a.text.indexOf("=");
        if (eq > 0 && a.text.slice(0, eq) === "PATH") return true;
      }
    }
    if (rawParts.length === 0 || rawParts.every((p) => !p.cmd)) continue;
    const parts = rawParts.map((p) => unwrapEnv(p));
    if (parts.some((p) => expandedCommand(p, safe))) return true;
    const last = parts[parts.length - 1]!;
    const piped = parts.length > 1 && isRunnerCmd(last);
    if (piped && parsed.kind === "dirs" && runnerCovered(last, depth)) continue;
    for (const ran of parts) {
      if (!ran.cmd) continue;
      if (!commandCovered(ran, depth)) return true;
    }
  }
  return false;
}

// Static only when every statement is provably static. A recognized runner still follows
// a plain literal. A path change, an env write, or any other call widens to every file.
function nonJsEffect(text: string, lang: NonJsLang): NonJsEffect {
  if (lang === "sh") {
    const parsed = classifyShell(text, 0);
    if (parsed.kind === "every") return parsed;
    if (shellUncovered(text, parsed)) return { kind: "every" };
    return parsed;
  }
  const parsed = classifyLang(text, lang, 0);
  if (parsed.kind === "every") return parsed;
  if (codeUncovered(text, lang, parsed)) return { kind: "every" };
  return parsed;
}

function addJoinedName(ctx: Ctx, name: string, lang: NonJsLang): void {
  const cands = [name];
  if (lang === "py" && !name.includes(".")) cands.push(`${name}.py`, `${name}/__init__.py`);
  if (lang === "rb" && !name.includes(".")) cands.push(`${name}.rb`);
  if (lang === "pl" && !name.includes(".")) cands.push(`${name}.pl`);
  for (const c of cands) if (ctx.logical.has(c)) addLogical(ctx, c);
}

function applyNonJs(ctx: Ctx, text: string, lang: NonJsLang): boolean {
  const effect = nonJsEffect(text, lang);
  if (effect.kind === "static") return false;
  // No directory bound: the computed name can be any file, docs and tests included.
  if (effect.kind === "every") widenEvery(ctx);
  else {
    for (const d of effect.dirs) addPrefixDir(ctx, d);
    for (const n of effect.lits) addJoinedName(ctx, n, lang);
  }
  addNative(ctx);
  return true;
}

// The effect of one load argument. An argument that names nothing (a parameter, an unresolved name) can still be any file of
// this directory or above, so it keeps that fallback even when another call restricts to a directory.
function loadEffect(tier: JsTier, fromKey: string, arg: string, text: string, floor = false): void {
  const eff = effectOf(fromKey, arg, text);
  mergeEffect(tier, eff);
  if (eff.t === "none" && strLit(arg.trim()) === undefined) tier.same = true;
  // A shape main did not classify at all kept the hook's own folder: a restriction to one directory keeps it too.
  if (floor && (eff.t === "prefix" || eff.t === "lit")) tier.same = true;
}
function mergeEffect(tier: JsTier, eff: JsEffect): void {
  if (eff.t === "none") return;
  if (eff.t === "same") {
    tier.same = true;
    return;
  }
  if (eff.t === "lit") {
    tier.lits.push(eff.path);
    return;
  }
  if (eff.t === "prefix") {
    if (eff.dir && !tier.dirs.includes(eff.dir)) tier.dirs.push(eff.dir);
    else if (!eff.dir) tier.same = true;
    return;
  }
  if (eff.t === "all") {
    tier.all = true;
    return;
  }
  tier.pkg = true;
  if (eff.tests) tier.tests = true;
  if (eff.flows) tier.flows = true;
}

// A plain identifier is a package name (require(name)), not a file path.
// The names a file binds to require, or to the result of createRequire(...): a call through one loads like require.
// An assignment anywhere counts (`let r; r = require`), so do aliases of aliases (up to three deep) and require.bind(...).
// Back from a call to the start of its statement: a ; ends it, a newline does too unless the line before ends with an operator or the
// line after starts with one (the usual wrap of a long statement). Past this many characters the statement is unreadable.
function statementStart(text: string, at: number): { from: number; overflow: boolean } {
  let from = at;
  const floor = Math.max(0, at - 3000);
  while (from > floor && text[from - 1] !== ";") {
    // The { of a block (after ), =>, try, else, do, finally) opens a new statement: the head before it is not part of this one.
    if (text[from - 1] === "{" && /(?:\)|=>|\b(?:try|else|do|finally))\s*$/.test(text.slice(Math.max(0, from - 40), from - 1))) break;
    if (text[from - 1] === "\n") {
      const prev = text.slice(Math.max(0, from - 200), from - 1).trimEnd();
      const next = text.slice(from, from + 40).trimStart()[0] ?? "";
      if (!/[=(,+\-*/?:&|{[]$/.test(prev) && !/[.?:&|+]/.test(next)) break;
    }
    from--;
  }
  return { from, overflow: from === floor && floor > 0 };
}

function loaderNames(text: string): string[] {
  const id = "[A-Za-z_$][\\w$]*";
  const names = new Set<string>();
  for (const m of text.matchAll(new RegExp(`(?<![\\w$.])(${id})\\s*=\\s*(?:module\\s*\\.\\s*)?require\\b(?!\\s*\\()(?!\\s*\\.\\s*(?!bind\\b))`, "g"))) names.add(m[1]!);
  // name = ...createRequire(...): walk back from each call to the start of its statement, whatever the length of what lies between.
  for (const maker of createRequireNames(text)) {
    for (const m of text.matchAll(new RegExp(`(?<![\\w$])${maker.replace(/\$/g, "\\$")}\\s*\\(`, "g"))) {
      const { from, overflow } = statementStart(text, m.index ?? 0);
      const stmt = text.slice(from, m.index ?? 0);
      // Every identifier assigned in the statement may be the loader (`const r = (other = 1, make(f))`).
      for (const b of stmt.matchAll(new RegExp(`(?<![\\w$.])(${id})\\s*=(?!=)`, "g"))) names.add(b[1]!);
      if (overflow) loaderOverflow = true; // a statement too long to read: the file widens, whatever was found in it
    }
  }
  // name = other: one scan builds the edges, then three rounds walk them, so a thousand aliases cost one pass.
  const edges = new Map<string, string[]>();
  for (const m of text.matchAll(new RegExp(`(?<![\\w$.])(${id})\\s*=\\s*(${id})(?![\\w$])(?!\\s*[(.])`, "g"))) {
    const list = edges.get(m[2]!);
    if (list) list.push(m[1]!);
    else edges.set(m[2]!, [m[1]!]);
  }
  let frontier = [...names];
  for (let round = 0; round < 3 && frontier.length; round++) {
    const next: string[] = [];
    for (const n of frontier) for (const to of edges.get(n) ?? []) if (!names.has(to)) { names.add(to); next.push(to); }
    frontier = next;
  }
  return [...names];
}
let loaderOverflow = false;

// createRequire and its renamed destructured binding (const { createRequire: cr } = require("module")).
function createRequireNames(text: string): string[] {
  const out = new Set<string>(["createRequire"]);
  for (const m of text.matchAll(/\bcreateRequire\s*:\s*([A-Za-z_$][\w$]*)/g)) out.add(m[1]!);
  return [...out];
}

// What a name is bound to: its initializers and later assignments, up to the end of the statement. A line that continues the
// expression (a leading + . ? : & |, or a trailing operator) belongs to it; `+=` also reads the unknown left side.
function bindingsOf(name: string): string[] {
  const c = cls;
  if (!c) return [];
  const hit = c.bind.get(name);
  if (hit) return hit;
  const text = c.text;
  const out: string[] = [];
  const re = new RegExp(`(?:\\b(?:const|let|var)\\s+|(?<![\\w$.]))${name.replace(/\$/g, "\\$")}\\s*(\\+|\\|\\||\\?\\?|&&)?=(?![=>])`, "g");
  for (const m of text.matchAll(re)) {
    let start = (m.index ?? 0) + m[0].length;
    while (start < text.length && /\s/.test(text[start]!)) start++;
    let depth = 0;
    let quote: string | null = null;
    let i = start;
    for (; i < text.length; i++) {
      const ch = text[i]!;
      if (quote) {
        if (ch === "\\") i++;
        else if (ch === quote) quote = null;
        continue;
      }
      if (ch === "'" || ch === '"' || ch === "`") quote = ch;
      else if (ch === "(" || ch === "[" || ch === "{") depth++;
      else if (ch === ")" || ch === "]" || ch === "}") {
        if (depth === 0) break;
        depth--;
      } else if (depth === 0 && (ch === ";" || ch === ",")) break;
      else if (depth === 0 && ch === "\n") {
        const before = /[+\-*/?:&|.,=(]\s*$/.test(text.slice(start, i));
        const after = /^\s*[+.?:&|]/.test(text.slice(i + 1, i + 40));
        if (!before && !after) break;
      }
    }
    const init = text.slice(start, i).trim();
    if (init) out.push(m[1] === "+" ? `__prev + ${init}` : init);
  }
  c.bind.set(name, out);
  return out;
}

// One classify call's view of the file: the path-module names, and the bindings it has already read. A name is read once,
// a name met again while it is being read counts for nothing more, and past this many names the answer is the package.
type FnDef = { fname?: string; alias?: string; params: string[]; kind: "named" | "export" | "anon" | "method"; destructured: string };
type ClsCtx = { text: string; mods: Set<string>; fns: Set<string>; bind: Map<string, string[]>; memo: Map<string, JsEffect>; visiting: Set<string>; steps: number; defs?: FnDef[]; refs?: Map<string, { calls: string[]; other: boolean; exported: boolean }>; defSteps: number };
let cls: ClsCtx | undefined;
const BIND_STEPS = 200;
const WIDE: JsEffect = { t: "pkg", tests: true, flows: true };

function combineEffects(effects: JsEffect[]): JsEffect {
  if (effects.length === 0 || effects.every((e) => e.t === "none")) return { t: "none" };
  if (effects.some((e) => e.t === "all")) return { t: "all" };
  const wide = effects.filter((e): e is Extract<JsEffect, { t: "pkg" }> => e.t === "pkg");
  if (wide.length) return { t: "pkg", tests: wide.some((e) => e.tests), flows: wide.some((e) => e.flows) };
  // A restriction to a directory stands only when every one restricts the same way; one that names nothing or a different
  // directory leaves the whole package possible.
  const first = JSON.stringify(effects[0]);
  if (effects.every((e) => JSON.stringify(e) === first)) return effects[0]!;
  return { t: "all" };
}

function nameEffect(fromKey: string, name: string, depth: number): JsEffect {
  const c = cls;
  if (!c) return { t: "none" };
  const key = `${fromKey}\0${name}`; // the same name read from another base is another answer
  const hit = c.memo.get(key);
  if (hit) return hit;
  if (c.visiting.has(key)) return { t: "none" };
  if (++c.steps > BIND_STEPS || depth >= 8) return WIDE;
  c.visiting.add(key);
  let eff: JsEffect;
  try {
    eff = nameEffectScan(fromKey, name, depth);
  } finally {
    c.visiting.delete(key);
  }
  c.memo.set(key, eff);
  return eff;
}

function nameEffectScan(fromKey: string, name: string, depth: number): JsEffect {
  const c = cls!;
  const n = name.replace(/\$/g, "\\$");
  // A name taken out of a structure or a loop (`const { p } = o`, `for (const p of list)`, `catch (p)`) is data the scan cannot follow.
  if (new RegExp(`\\b(?:const|let|var)\\s*[{\\[][^;=]*?(?<![\\w$.])${n}(?![\\w$])[^;=]*?[}\\]]\\s*=|\\bfor\\s*\\(\\s*(?:const|let|var)\\s+${n}\\s+(?:of|in)\\b|\\bcatch\\s*\\(\\s*${n}\\s*\\)`).test(c.text)) return WIDE;
  const effects = bindingsOf(name).map((init) => effectOf(fromKey, init, "", depth + 1));
  // A parameter that is also assigned still gets the arguments of its function's calls.
  const param = paramEffect(fromKey, name, depth);
  if (param.t !== "none" || effects.length === 0) effects.push(param);
  return combineEffects(effects);
}

// Every function-like construct of the file with its parameter names, found once: declarations, function expressions, arrows,
// and method shorthand. `kind` says how the function can be reached: by its own name, as an export, or not by a name at all.
function fnDefs(): FnDef[] {
  const c = cls!;
  if (c.defs) return c.defs;
  const text = c.text;
  const defs: FnDef[] = [];
  const parse = (list: string): { params: string[]; destructured: string } => {
    const params: string[] = [];
    let destructured = "";
    for (const raw of splitTop(list, ",")) {
      const x = raw.trim().replace(/^\.\.\./, "");
      if (/^[{[]/.test(x)) {
        destructured += ` ${x}`;
        params.push("");
      } else params.push(x.replace(/\s*=.*$/s, "").trim());
    }
    return { params, destructured };
  };
  const heads = (at: number) => text.slice(Math.max(0, at - 80), at);
  const stored = (at: number): { fname?: string; kind: FnDef["kind"] } => {
    const before = heads(at);
    const bound = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?$/.exec(before);
    if (bound) return { fname: bound[1]!, kind: "named" };
    if (/(?:\bexports|\bmodule\s*\.\s*exports)(?:\s*\.\s*[\w$]+)?\s*=\s*(?:async\s*)?$/.test(before)) return { kind: "export" };
    return { kind: "anon" };
  };
  // function name?(params): the list is read balanced, so a default such as y = String(1) does not end it.
  for (const m of text.matchAll(/\bfunction\s*\*?\s*([A-Za-z_$][\w$]*)?\s*\(/g)) {
    const list = argsOf(text, (m.index ?? 0) + m[0].length - 1);
    if (list === undefined) continue;
    const { params, destructured } = parse(list);
    const own = stored(m.index ?? 0);
    // `const go = function inner(x) {}` is reached as go; a bare `function go(x) {}` as go.
    // The inner name is a second way in: its recursive calls are calls of this function too.
    if (m[1] && own.kind === "named") defs.push({ fname: own.fname, alias: m[1], params, kind: "named", destructured });
    else if (m[1]) defs.push({ fname: m[1], params, kind: "named", destructured }); // export function go: its own direct calls are read
    else defs.push({ ...own, params, destructured });
  }
  // (params) => and name =>: for the parenthesized form the list is found by matching the ) backwards.
  for (const m of text.matchAll(/=>/g)) {
    const at = m.index ?? 0;
    let j = at;
    while (j > 0 && /\s/.test(text[j - 1]!)) j--;
    let list = "";
    let start = j;
    if (text[j - 1] === ")") {
      let depth = 0;
      let k = j - 1;
      for (; k >= 0 && j - k < 1500; k--) {
        if (text[k] === ")") depth++;
        else if (text[k] === "(" && --depth === 0) break;
      }
      if (k < 0 || depth !== 0) continue;
      list = text.slice(k + 1, j - 1);
      start = k;
    } else {
      const idm = /([A-Za-z_$][\w$]*)$/.exec(text.slice(Math.max(0, j - 80), j));
      if (!idm || /[\w$.]$/.test(text.slice(Math.max(0, j - 80), j - idm[0].length))) continue;
      list = idm[1]!;
      start = j - idm[1]!.length;
    }
    const { params, destructured } = parse(list);
    defs.push({ ...stored(/\basync\s+$/.test(text.slice(Math.max(0, start - 8), start)) ? start - 6 : start), params, destructured });
  }
  for (const m of text.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)\s*\(/g)) {
    if (/^(?:if|for|while|switch|catch|with|function|return|else|do)$/.test(m[1]!)) continue;
    if (/\bfunction\s*\*?\s*$/.test(heads(m.index ?? 0))) continue;
    // A method definition starts a member: after { } , ; a newline, or static/async/get/set. A call nested in other calls does not.
    if (!/(?:^|[{},;\n]|\b(?:static|async|get|set))\s*$/.test(heads(m.index ?? 0).slice(-30))) continue;
    const list = argsOf(text, (m.index ?? 0) + m[0].length - 1);
    if (list === undefined || list.length > 2000) continue;
    const after = text.slice((m.index ?? 0) + m[0].length + list.length + 1, (m.index ?? 0) + m[0].length + list.length + 20);
    if (!/^\s*\{/.test(after)) continue;
    const { params, destructured } = parse(list);
    defs.push({ params, kind: "method", destructured });
  }
  c.defs = defs;
  return defs;
}

// The references to every function name that has a definition: its direct calls (with their argument lists) and whether anything
// else mentions it (an alias, a member call, call/apply). A reference that only exports it (`exports.go = go`) is its own flag.
// One pass over the file reads them all.
function refsOf(fname: string): { calls: string[]; other: boolean; exported: boolean } {
  const c = cls!;
  if (!c.refs) {
    const names = new Set<string>();
    for (const d of fnDefs()) {
      if (d.fname) names.add(d.fname);
      if (d.alias) names.add(d.alias);
    }
    const refs = new Map<string, { calls: string[]; other: boolean; exported: boolean }>();
    for (const n of names) refs.set(n, { calls: [], other: false, exported: false });
    const text = c.text;
    for (const m of text.matchAll(/(?<![\w$])[A-Za-z_$][\w$]*(?![\w$])/g)) {
      const out = refs.get(m[0]);
      if (!out || out.other) continue;
      const at = m.index ?? 0;
      const before = text.slice(Math.max(0, at - 40), at);
      if (/\bfunction\s*\*?\s*$/.test(before)) continue; // its own declaration
      if (/\b(?:const|let|var)\s+$/.test(before)) continue; // its own binding
      if (/\.\s*$/.test(before)) {
        // exports.go = ... names an export, not a use; any other member (o.go(x)) can reach the function.
        if (/(?:\bexports|\bmodule\s*\.\s*exports)\s*\.\s*$/.test(before) && /^\s*=(?!=)/.test(text.slice(at + m[0].length, at + m[0].length + 4))) out.exported = true;
        else out.other = true;
        continue;
      }
      const call = /^\s*\(/.exec(text.slice(at + m[0].length, at + m[0].length + 8));
      if (!call) {
        if (/(?:\bexports|\bmodule\s*\.\s*exports)(?:\s*\.\s*[\w$]+)?\s*=\s*$/.test(before) || /\bexport\s*\{[^}]*$/.test(before)) out.exported = true;
        else out.other = true;
        continue;
      }
      const args = argsOf(text, at + m[0].length + call[0].length - 1);
      if (args === undefined || out.calls.length >= 50) out.other = true;
      else out.calls.push(args);
    }
    c.refs = refs;
  }
  return c.refs.get(fname) ?? { calls: [], other: false, exported: false };
}

// An export the file also calls (exports.go(x), module.exports(x), require(__filename).go(x)) is called from here with whatever it is given.
function callsOwnExport(): boolean {
  return /(?:\bexports|\bmodule\s*\.\s*exports)(?:\s*\.\s*[\w$]+)?\s*\(|\brequire\s*\(\s*__filename\s*\)/.test(cls!.text);
}

// A parameter names nothing until its function is called. A function reached only by direct calls takes the arguments of those
// calls; one reached any other way (an alias, a member, call/apply, an IIFE, a callback, a method, a destructured parameter) can be
// handed anything, so the load widens to the package. An exported function nobody calls here names nothing; one the file calls
// through its export is read as a call from anywhere.
function paramEffect(fromKey: string, name: string, depth: number): JsEffect {
  const c = cls!;
  const effects: JsEffect[] = [];
  const done = new Set<string>();
  for (const def of fnDefs()) {
    const at = def.params.indexOf(name);
    const hidden = def.destructured !== "" && new RegExp(`(?<![\\w$.])${name.replace(/\$/g, "\\$")}(?![\\w$])`).test(def.destructured);
    if (at < 0 && !hidden) continue;
    // One name can match thousands of definitions (a minified bundle): past this many the answer is the package.
    if (++c.defSteps > BIND_STEPS) return WIDE;
    if (hidden || def.kind === "method") {
      effects.push(WIDE);
      continue;
    }
    if (def.kind === "export") {
      if (callsOwnExport()) effects.push(WIDE);
      continue;
    }
    if (def.kind === "anon" || !def.fname) {
      effects.push(WIDE);
      continue;
    }
    const key = `${def.fname}:${at}`;
    if (done.has(key)) continue;
    done.add(key);
    const refs = refsOf(def.fname);
    const inner = def.alias ? refsOf(def.alias) : { calls: [] as string[], other: false, exported: false };
    if (refs.other || inner.other) {
      effects.push(WIDE);
      continue;
    }
    if ((refs.exported || inner.exported) && callsOwnExport()) effects.push(WIDE);
    for (const args of [...refs.calls, ...inner.calls]) {
      const arg = splitTop(args, ",")[at];
      if (arg !== undefined && arg.trim()) effects.push(effectOf(fromKey, arg, "", depth + 1));
    }
  }
  return combineEffects(effects);
}

function effectOf(fromKey: string, expr: string, _text = "", depth = 0): JsEffect {
  const t = expr.trim();
  if (/^[A-Za-z_$][\w$]*$/.test(t)) return nameEffect(fromKey, t, depth);
  // A property of a name (`o.p`) is what the name holds: a parameter's call-site arguments, a bound object.
  if (/^[A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)+$/.test(t)) {
    const root = /^[A-Za-z_$][\w$]*/.exec(t)![0];
    if (root !== "process" && root !== "__dirname" && root !== "__filename" && root !== "module" && root !== "exports") return nameEffect(fromKey, root, depth);
  }
  if (!t || strLit(t) !== undefined) return { t: "none" };
  if (/Buffer\.from\s*\(|\bbase64\b|\batob\s*\(/.test(t)) return { t: "pkg", tests: true, flows: true };
  const call = matchCall(t);
  // A join or resolve is a path call when its receiver is the path module (`path`, `path?.join`, `(path).join`,
  // require("path/win32").join, a destructured join). Any other join is a string built by joining pieces: when every piece is a
  // literal it is that string, otherwise it can name any file, docs included.
  if (call && isJoinCallee(call.callee)) {
    const callee = call.callee.replace(/\s+/g, "").replace(/\?\./g, ".").replace(/\(([A-Za-z_$][\w$]*)\)/g, "$1");
    if (isPathCallee(callee)) return effectOfJoin(fromKey, call.args, isResolveCallee(callee));
    const exact = literalJoin(callee, call.args);
    if (exact !== undefined) {
      const walked = applySegs(parentParts(fromKey), exact);
      const path = walked.escape ? "" : walked.parts.join("/");
      return path ? { t: "lit", path } : { t: "none" };
    }
    return { t: "all" };
  }
  if (t.includes("+") || t.startsWith("`")) return effectOfPlus(fromKey, t);
  if (/[([`]/.test(t)) return { t: "pkg", tests: true, flows: true };
  return { t: "none" };
}

// The callee of a join or resolve call is the path module: a name bound to it, a destructured join or resolve, or a require of it.
function isPathCallee(callee: string): boolean {
  const c = cls;
  const rm = /^require\((["'`])(?:node:)?path(?:\/(?:posix|win32))?\1\)\.(?:(?:posix|win32)\.)?(?:join|resolve)$/.test(callee);
  if (rm) return true;
  if (!c) return false;
  const bare = /^([A-Za-z_$][\w$]*)$/.exec(callee);
  if (bare) return c.fns.has(bare[1]!);
  const member = /^([A-Za-z_$][\w$]*)\.(?:(?:posix|win32)\.)?(?:join|resolve)$/.exec(callee);
  return !!member && (c.mods.has(member[1]!) || c.fns.has(member[1]!));
}

// `["./do", "cs/x.js"].join("")`: the string a join of literals makes, when every piece is a literal.
function literalJoin(callee: string, argsSrc: string): string | undefined {
  if (!callee.endsWith(".join")) return undefined;
  const recv = callee.slice(0, -5);
  if (!recv.startsWith("[") || !recv.endsWith("]")) return undefined;
  const parts: string[] = [];
  for (const el of splitTop(recv.slice(1, -1), ",")) {
    if (!el.trim()) continue;
    const lit = strLit(el.trim());
    if (lit === undefined) return undefined;
    parts.push(lit);
  }
  const sep = argsSrc.trim() ? strLit(firstArg(argsSrc).trim()) : ",";
  return sep === undefined ? undefined : parts.join(sep);
}

function isJoinCallee(callee: string): boolean {
  return /(?:^|\.)(?:posix\.)?(?:join|resolve)$/.test(callee.replace(/\s+/g, ""));
}

function isResolveCallee(callee: string): boolean {
  return /(?:^|\.)(?:posix\.)?resolve$/.test(callee.replace(/\s+/g, ""));
}

// path.resolve with no absolute anchor is cwd-relative. npm runs install at the package root.
function effectOfJoin(fromKey: string, argsSrc: string, fromCwd: boolean): JsEffect {
  const args = splitTop(argsSrc, ",").map((a) => a.trim()).filter((a) => a.length > 0 && !a.startsWith("{"));
  const base = parentParts(fromKey);
  let parts = fromCwd ? [] : [...base];
  let escaped = false;
  let anchored = fromCwd;
  for (let i = 0; i < args.length; i++) {
    const bits = splitTop(args[i]!, "+").map((s) => s.trim()).filter(Boolean);
    let k = 0;
    for (; k < bits.length; k++) {
      const bit = bits[k]!;
      if (bit === "__dirname" || bit === "__filename" || isPkgRootExpr(bit)) {
        parts = bit === "__dirname" || bit === "__filename" ? [...base] : [];
        escaped = false;
        anchored = true;
        continue;
      }
      const lit = strLit(bit);
      if (lit === undefined) break;
      anchored = true;
      const walked = applySegs(parts, lit);
      parts = walked.parts;
      if (walked.escape) escaped = true;
    }
    if (k < bits.length) {
      const tail = [bits.slice(k).join("+"), ...args.slice(i + 1)].filter(Boolean).join("+");
      return finishDynamic(base, parts, escaped, tail, anchored);
    }
    // A join argument that is only an absolute string discards the path so far.
    const only = strLit(args[i]!.trim());
    if (only !== undefined && (only.startsWith("/") || /^[A-Za-z]:/.test(only))) {
      parts = applySegs([], only).parts;
      escaped = true;
    }
  }
  if (escaped) return { t: "none" };
  const path = parts.join("/");
  return path ? { t: "lit", path } : { t: "none" };
}

function effectOfPlus(fromKey: string, expr: string): JsEffect {
  const t = expr.trim();
  if (t.startsWith("`") && t.endsWith("`") && t.length >= 2) {
    const body = t.slice(1, -1);
    const cut = body.indexOf("${");
    if (cut < 0) {
      const walked = applySegs(parentParts(fromKey), body);
      if (walked.escape) return { t: "none" };
      const path = walked.parts.join("/");
      return path ? { t: "lit", path } : { t: "none" };
    }
    const head = body.slice(0, cut);
    const walked = applySegs(parentParts(fromKey), head);
    return finishDynamic(parentParts(fromKey), walked.parts, walked.escape, body.slice(cut), head.length > 0);
  }
  const base = parentParts(fromKey);
  const bits = splitTop(t, "+").map((s) => s.trim()).filter(Boolean);
  let parts = [...base];
  let escaped = false;
  let sawDir = false;
  let anchored = false;
  let i = 0;
  for (; i < bits.length; i++) {
    const bit = bits[i]!;
    if (bit === "__dirname" || bit === "__filename" || isPkgRootExpr(bit)) {
      parts = bit === "__dirname" || bit === "__filename" ? [...base] : [];
      escaped = false;
      sawDir = true;
      anchored = true;
      continue;
    }
    const lit = strLit(bit);
    if (lit === undefined) break;
    anchored = true;
    // `__dirname + '/lib/a.js'` is a separator. A leading slash with no __dirname is absolute.
    if (!sawDir && (lit.startsWith("/") || /^[A-Za-z]:/.test(lit))) {
      parts = applySegs([], lit).parts;
      escaped = true;
      continue;
    }
    const walked = applySegs(parts, lit);
    parts = walked.parts;
    if (walked.escape) escaped = true;
  }
  if (i >= bits.length) {
    if (escaped) return { t: "none" };
    const path = parts.join("/");
    return path ? { t: "lit", path } : { t: "none" };
  }
  return finishDynamic(base, parts, escaped, bits.slice(i).join("+"), anchored);
}

// A prefix that stays inside the file's directory widens to that directory.
// `..` or an escaped prefix widens to the package, docs excluded.
function finishDynamic(base: string[], parts: string[], escaped: boolean, tail: string, anchored: boolean): JsEffect {
  const danger = tailDanger(tail);
  if (escaped || danger.dotdot) return { t: "pkg", tests: !danger.one, flows: !danger.one };
  const dir = parts.join("/");
  const b = base.join("/");
  const left = b.length > 0 && dir !== b && !dir.startsWith(`${b}/`);
  if (!danger.one) {
    // No literal directory was consumed, so this is not the root prefix. Docs stay out.
    // A nested tail under the package root can name docs. One that already left this
    // file's directory stays on the package-minus-docs tier.
    if (left || !anchored) return { t: "pkg", tests: true, flows: true };
    if (!dir) return { t: "all" };
    return { t: "prefix", dir };
  }
  if (left) return { t: "pkg", tests: dirHits(dir, "test"), flows: dirHits(dir, "flow") };
  if (dir === b) return { t: "same" };
  return { t: "prefix", dir };
}

function tailDanger(tail: string): { one: boolean; dotdot: boolean } {
  const strings = tail.match(/['"][^'"]*['"]/g) ?? [];
  const bare = tail.replace(/['"][^'"]*['"]/g, "");
  const dotdot = bare.includes("..") || strings.some((s) => s.includes(".."));
  // `@scope/name` is a package specifier. Its slash is not a path segment.
  const slash = bare.includes("/") || strings.some((s) => pathSlash(s.slice(1, -1)));
  return { one: !dotdot && !slash, dotdot };
}

function pathSlash(body: string): boolean {
  if (!body.includes("/")) return false;
  if (body.startsWith("/") || body.startsWith(".") || body.includes("..")) return true;
  return !/^@[^/]+\/[^/]+$/.test(body);
}

function dirHits(dir: string, kind: "test" | "flow"): boolean {
  const parts = dir.split("/");
  if (kind === "flow") {
    for (let i = 0; i < parts.length; i++) {
      if (parts[i]!.toLowerCase() === ".github" && parts[i + 1]?.toLowerCase() === "workflows") return true;
    }
    return false;
  }
  return parts.some((part) => {
    const p = part.toLowerCase();
    return p === "test" || p === "tests" || p === "__tests__";
  });
}

function parentParts(logical: string): string[] {
  const dir = parentDir(logical);
  return dir ? dir.split("/") : [];
}

function applySegs(parts: string[], rel: string): { parts: string[]; escape: boolean } {
  const next = [...parts];
  let escape = false;
  for (const seg of rel.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (next.length === 0) escape = true;
      else next.pop();
      continue;
    }
    next.push(seg);
  }
  return { parts: next, escape };
}

function strLit(expr: string): string | undefined {
  const t = expr.trim();
  if (t.length < 2) return undefined;
  const q = t[0];
  if ((q !== "'" && q !== '"') || t[t.length - 1] !== q) return undefined;
  if (t.slice(1, -1).includes(q!)) return undefined;
  return t.slice(1, -1);
}

function splitTop(src: string, sep: "," | "+"): string[] {
  const out: string[] = [];
  let cur = "";
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (quote) {
      cur += c;
      if (c === "\\") {
        cur += src[i + 1] ?? "";
        i++;
        continue;
      }
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === "`") {
      quote = c;
      cur += c;
      continue;
    }
    if (c === "(" || c === "[" || c === "{") {
      depth++;
      cur += c;
      continue;
    }
    if (c === ")" || c === "]" || c === "}") {
      depth--;
      cur += c;
      continue;
    }
    if (c === sep && depth === 0) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += c;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

function firstArg(args: string): string {
  return splitTop(args, ",")[0] ?? "";
}

function argsOf(text: string, paren: number): string | undefined {
  if (text[paren] !== "(") return undefined;
  let depth = 0;
  let quote: string | null = null;
  for (let i = paren; i < text.length; i++) {
    const c = text[i]!;
    if (quote) {
      if (c === "\\") {
        i++;
        continue;
      }
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === "`") {
      quote = c;
      continue;
    }
    if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) return text.slice(paren + 1, i);
    }
  }
  return undefined;
}

function matchCall(expr: string): { callee: string; args: string } | undefined {
  const t = expr.trim();
  let quote: string | null = null;
  let depth = 0;
  let open = -1;
  for (let i = 0; i < t.length; i++) {
    const c = t[i]!;
    if (quote) {
      if (c === "\\") {
        i++;
        continue;
      }
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === "`") {
      quote = c;
      continue;
    }
    if (c === "(") {
      if (depth === 0) open = i;
      depth++;
    } else if (c === ")") {
      depth--;
      if (depth === 0 && open >= 0 && i === t.length - 1) {
        return { callee: t.slice(0, open).trim(), args: t.slice(open + 1, i) };
      }
      if (depth === 0) open = -1;
    }
  }
  return undefined;
}

function isDocSurface(logical: string): boolean {
  const base = logical.slice(logical.lastIndexOf("/") + 1);
  if (/^readme/i.test(base) || base.toLowerCase().endsWith(".md")) return true;
  for (const part of logical.split("/")) {
    const p = part.toLowerCase();
    if (p === "doc" || p === "docs") return true;
  }
  return false;
}

function isTestSurface(logical: string): boolean {
  const base = logical.slice(logical.lastIndexOf("/") + 1);
  if (/\.(?:test|spec)\./i.test(base)) return true;
  for (const part of logical.split("/")) {
    const p = part.toLowerCase();
    if (p === "test" || p === "tests" || p === "__tests__") return true;
  }
  return false;
}

function isWorkflowSurface(logical: string): boolean {
  const parts = logical.split("/");
  for (let i = 0; i < parts.length; i++) {
    if (parts[i]!.toLowerCase() === ".github" && parts[i + 1]?.toLowerCase() === "workflows") return true;
  }
  return false;
}

function quotedTokens(text: string): string[] {
  const out: string[] = [];
  const re = /(['"])([^'"\\\n]{1,512})\1/g;
  for (const m of text.matchAll(re)) {
    const raw = m[2] ?? "";
    for (const tok of raw.split(/\s+/)) if (tok) out.push(tok);
  }
  return out;
}

function addLiteralToken(ctx: Ctx, token: string): void {
  let t = token.replace(/\/{2,}/g, "/").replace(/^~(?:[+-]\d*|\d+)\/+/, "");
  while (t.startsWith("./")) t = t.slice(2);
  if (t.startsWith("/")) t = t.slice(1);
  if (t.startsWith("../")) t = t.slice(3);
  while (t.startsWith("./")) t = t.slice(2);
  if (!t || badPath(t) || /[*?[]/.test(t) || !/^[A-Za-z0-9_@.+/-]+$/.test(t)) return;
  if (t.includes("/")) {
    if (ctx.logical.has(t)) addLogical(ctx, t);
    return;
  }
  if (ctx.logical.has(t)) {
    addLogical(ctx, t);
    return;
  }
  if (t.length < 3 || !t.includes(".")) return;
  let hit: string | undefined;
  for (const logical of ctx.logical.keys()) {
    if (logical.slice(logical.lastIndexOf("/") + 1) !== t) continue;
    if (hit) return;
    hit = logical;
  }
  if (hit) addLogical(ctx, hit);
}

function scanAdded(ctx: Ctx, key: string): void {
  if (ctx.hold || ctx.scanned.has(key)) return;
  const base = key.slice(key.lastIndexOf("/") + 1);
  if (/\.(?:js|cjs|mjs)$/i.test(base)) {
    scanJs(ctx, key);
    return;
  }
  if (ctx.scanned.size >= DEPTH) {
    fail(ctx, "unresolved: script depth");
    return;
  }
  const text = dec.decode(ctx.bytes.get(key));
  if (/\.py$/i.test(base)) {
    ctx.scanned.add(key);
    followPyImports(ctx, key, text);
    // No runner keeps the precise walk. A run widens unless every argument is a
    // plain literal or a simple tail off a literal directory.
    if (!applyNonJs(ctx, text, "py")) {
      if (runsOtherFile(text)) narrowWiden(ctx, key);
      else addNative(ctx);
    }
    return;
  }
  if (/\.rb$/i.test(base)) {
    ctx.scanned.add(key);
    if (!applyNonJs(ctx, text, "rb")) {
      addNative(ctx);
      if (runsOtherFile(text)) addScannedLiterals(ctx);
    }
    return;
  }
  if (/\.(?:sh|bash)$/i.test(base)) {
    ctx.scanned.add(key);
    if (!applyNonJs(ctx, text, "sh") && (runsOtherFile(text) || sourcesOtherFile(text))) narrowWiden(ctx, key);
    return;
  }
  // A TS body is JavaScript-shaped. The same-directory floor stays; it is not a shell script.
  if (/\.(?:ts|tsx|mts|cts)$/i.test(base)) {
    ctx.scanned.add(key);
    narrowWiden(ctx, key);
    return;
  }
  // binding.gyp has a dot, so it is not an extensionless entry.
  if (/\.pl$/i.test(base)) {
    ctx.scanned.add(key);
    if (!applyNonJs(ctx, text, "pl")) narrowWiden(ctx, key);
    return;
  }
  if (!base.includes(".")) {
    ctx.scanned.add(key);
    if (!applyNonJs(ctx, text, "sh")) narrowWiden(ctx, key);
  }
}

function markHookFile(ctx: Ctx, token: string): void {
  if (!token || token.startsWith("-")) return;
  const logical = normalize(token);
  if (!logical || badPath(logical) || /[*?[]/.test(logical)) return;
  ctx.hookNamed.add(logical);
}

// A file named by a command, resolved from the directory an earlier cd moved to as well as from the package root.
function noteHookArgCwd(ctx: Ctx, token: string): void {
  // A file named by an expansion the scan could not resolve (`sh tools/$N.sh`) may be any file of the package.
  if (token.includes(UNRESOLVED)) {
    // An unresolved part may name a file anywhere, docs and tests included: a bare word (`node -r $(cat n)`), a path word
    // in the package root (`node ./$(cat n)`) or with an unresolved directory. A path word whose directory is known
    // (`node docs/$(cat b)`) reads every file under that directory, inert ones included, and no others.
    const dir = token.includes("/") ? normalize(token.slice(0, token.lastIndexOf("/"))) : "";
    if (!dir || dir.includes(UNRESOLVED) || badPath(dir)) ctx.widenInert = true;
    else addUnder(ctx, dir);
    widenAll(ctx);
  }
  // After a `cd` a dotted path is resolved from that directory below, not from the package root.
  noteHookArg(ctx, token, Boolean(ctx.cwd));
  if (ctx.cwd && token && !token.startsWith("-") && !token.startsWith("/")) {
    const j = joinDir(ctx.cwd, token);
    if (j === undefined) {
      // A path that leaves the package: every file is read, and later checks are not switched off first.
      ctx.widenInert = true;
      widenAll(ctx);
    } else if (j === "") noteRootMain(ctx);
    else noteHookArg(ctx, j);
  }
}

// `node .` and `node lib/..` run the package root as a directory, as Node does: the manifest `main` as a file (with its added
// extensions), then as a directory's index, and index.js of the root when main names nothing. Only node reads a root this
// way: `tsc -p .` names the root without running it. A root with nothing to run is not a hold.
function nodeFile(ctx: Ctx, base: string): string | undefined {
  for (const ext of ["", ".js", ".json", ".node"]) if (ctx.logical.has(base + ext)) return base + ext;
  return undefined;
}

function noteRootMain(ctx: Ctx): void {
  if (ctx.hold || !ctx.rootRuns) return;
  const manifest = ctx.logical.get("package.json");
  const pj = manifest ? parseJson(ctx.bytes.get(manifest)) : undefined;
  let rel = "";
  if (pj && typeof pj.main === "string") {
    const m = normalize(pj.main);
    const j = /[*?[\u0005$~]/.test(m) || m.startsWith("/") || /^[A-Za-z]:/.test(m) ? undefined : joinDir("", m);
    if (j === undefined) {
      fail(ctx, "unresolved: path");
      return;
    }
    rel = j;
  }
  const name = (rel ? nodeFile(ctx, rel) ?? nodeFile(ctx, `${rel}/index`) : undefined) ?? nodeFile(ctx, "index");
  if (!name) return;
  markHookFile(ctx, name);
  addLogical(ctx, name);
}

function noteHookArg(ctx: Ctx, token: string, afterCd = false): void {
  // `.` is not a named file. Recording it would be an unresolved-path hold.
  // A glob still reaches addRef, so the glob and pattern-length caps stay holds.
  if (!token || token.startsWith("-")) return;
  const logical = normalize(token);
  if (!afterCd && /^(?:\.\/*)+$/.test(token)) {
    noteRootMain(ctx);
    return;
  }
  if (!afterCd && logical && /(^|\/)\.{1,2}(\/|$)/.test(logical) && !logical.startsWith("/") && !/^[A-Za-z]:/.test(logical) && !/[\u0005$~*?[]/.test(logical)) {
    // A path with a `.` or `..` segment names the file it resolves to (`lib/../x/evil.js` is x/evil.js). One that leaves the
    // package reads every file, as a path joined to an earlier `cd` does.
    const j = joinDir("", logical);
    if (j === undefined) {
      ctx.widenInert = true;
      widenAll(ctx);
    } else if (j === "") noteRootMain(ctx);
    else if (!badPath(j)) {
      markHookFile(ctx, j);
      addRef(ctx, j);
    }
    return;
  }
  if (!logical || badPath(logical)) return;
  markHookFile(ctx, token);
  addRef(ctx, token);
}

// No resolved file argument (python3 -c, rollup -c, cross-env, ./bin). Docs, tests, and
// workflows stay out. Files are recorded directly so a large package does not trip the depth cap.
// A widen means the run may have left this package's layout: those scripts live in other packages'
// manifests, so every non-root package.json joins the surface on every widen (tests/ and docs/ included, and
// the files under their folders). The root manifest is read on its own path.
function movedInto(ctx: Ctx, logical: string): boolean {
  for (const dir of ctx.movedDirs) if (logical.startsWith(`${dir}/`)) return true;
  return false;
}

// The directories that hold a nested manifest, per file map (the map does not change during a scan).
const PKG_DIRS = new WeakMap<object, string[]>();

function widenAll(ctx: Ctx): void {
  // A directory that holds a nested manifest is another package: a run can land there, so its files are not
  // inert whatever folder name they sit under (tests/pkg, docs/pkg).
  let pkgDirs = PKG_DIRS.get(ctx.logical);
  if (!pkgDirs) {
    pkgDirs = [];
    for (const logical of ctx.logical.keys()) if (isManifest(logical) && logical.includes("/")) pkgDirs.push(logical.slice(0, logical.lastIndexOf("/") + 1));
    PKG_DIRS.set(ctx.logical, pkgDirs);
  }
  for (const [logical, key] of ctx.logical) {
    if (isManifest(logical)) {
      // The root manifest is read on its own path. A manifest under tests/ or docs/ is a package like any other.
      if (!logical.includes("/")) continue;
    } else if (!ctx.widenInert && omitInert(ctx, logical) && !pkgDirs.some((d) => logical.startsWith(d)) && !movedInto(ctx, logical)) continue;
    ctx.files.add(key);
    if (ctx.fromGyp) ctx.gypFiles.add(key);
  }
}

// A resolved file is the entry, and its own scan closes what it names.
// No resolved file still widens to every non-inert file.
function closeUnknownRunner(ctx: Ctx, argv: string[], i: number): void {
  let resolved = false;
  const head = argv[i - 1] ?? "";
  const plain = !head.includes("/") && plainCommand(head);
  for (let j = i; j < argv.length; j++) {
    const arg = argv[j]!;
    if (arg.startsWith("-")) continue;
    // `printf -v N[0] ..` and `read -a N[0]` assign to a variable: the word after the flag is a name, not a file or a glob
    if ((binName(argv[i - 1] ?? "") === "printf" && argv[j - 1] === "-v") || (binName(argv[i - 1] ?? "") === "read" && /^-[A-Za-z]*a$/.test(argv[j - 1] ?? ""))) continue; // read -a N, read -ra N
    // A plain command (rm, mkdir, cp ...) runs nothing an expansion in its arguments names.
    if (!(plain && arg.includes(UNRESOLVED))) noteHookArgCwd(ctx, arg);
    const logical = normalize(arg);
    if (!logical || badPath(logical)) continue;
    const key = findKey(ctx, logical);
    if (key && !isManifest(key)) resolved = true;
  }
  if (!resolved) widenAll(ctx);
}

function evalCode(ctx: Ctx, code: string): void {
  // Record the require even when the rest of the expression is not a plain load.
  // The required file is still part of the surface. A dynamic require names its directory.
  const specs: string[] = [];
  const rest = code.replace(/require\(\s*(['"])(\.[^'"]*)\1\s*\)/g, (_full, _q, spec: string) => {
    specs.push(spec);
    return " ";
  });
  for (const spec of specs) addRef(ctx, spec);
  for (const dir of dynamicRequireDirs(code)) addUnder(ctx, dir);
  // A spec that holds an unresolved expansion (`require('./lib/$(cat n)')`) is matched above as a plain path: it names nothing.
  if (code.includes(UNRESOLVED) || /[+`$]/.test(code) || code.includes("process.env") || !specs.length || !/^[\s;]*$/.test(rest)) {
    fail(ctx, "unresolved: eval");
    // The inline code runs like a file named "-e" in the package root: the same JS hardening applies to it.
    if (code.includes(UNRESOLVED)) {
      ctx.widenInert = true;
      widenAll(ctx);
    } else if (!provablyStatic(code)) widenJs(ctx, "-e", code);
  }
}

// A redirect aborts the split, but `node-gyp` later in that same hook still compiles.
// The redirect itself is not a hold. `node safe.js > out` does not name node-gyp.
function noteUnparsedCompile(ctx: Ctx, body: string): void {
  if (/(?:^|&&|\|\||[;&\n])\s*node-gyp(?![\w-])/.test(body)) ctx.sawNodeGyp = true;
}

// A redirect, a backslash or a parenthesis keeps a text from being split into commands, and a command in it is then not
// dispatched. `make` is such a command: with no file to name it reads every file, so it is dispatched from the
// tolerant segments (the commands split outside quotes), with its redirects dropped.
// Does the line end inside a quote? (The shell would not run it.)
function opensQuote(l: string): boolean {
  let q: string | undefined;
  for (let i = 0; i < l.length; i++) {
    const c = l[i]!;
    if (q) {
      if (c === "\\" && q === '"') i++;
      else if (c === q) q = undefined;
    } else if (c === "\\") i++;
    else if (c === "'" || c === '"') q = c;
  }
  return q !== undefined;
}
const REDIRECT_TOKEN = /^(?:[0-9]*(?:>>?|<|>\||>&|<&)|&>>?)/;
function noteUnparsedMake(ctx: Ctx, text: string): void {
  if (ctx.hold || !/\b(?:make|gmake)\b/.test(text.replace(/[\\"']/g, ""))) return; // `ma\ke` is make
  for (const seg of logicalLines(text).filter((l) => !opensQuote(l)).flatMap((l) => shellSegments(l))) { // heredoc text, comments and a line that never closes a quote are not commands
    const argv: string[] = [];
    const toks = words(seg).map((t) => t.replace(/\\(.)/g, "$1")); // ma\ke is make
    for (let k = 0; k < toks.length; k++) {
      const t = toks[k]!;
      if (REDIRECT_TOKEN.test(t)) {
        if (/^(?:[0-9]*(?:>>?|<|>\||>&|<&)|&>>?)$/.test(t)) k++; // the target is the next word
        continue;
      }
      argv.push(t);
    }
    // the command word: past assignments, compound-command keywords and wrappers with their options
    let h = 0;
    while (h < argv.length) {
      const t = argv[h]!;
      if (ASSIGN.test(t) || /^(?:if|then|elif|else|do|while|until|!|\{|time)$/.test(t)) h++;
      else if (/^(?:env|command|builtin|exec|nice|nohup|setsid|stdbuf|ionice)$/.test(binName(t))) {
        h++;
        while (h < argv.length && argv[h]!.startsWith("-")) h += /^-[nuCcpt]$/.test(argv[h]!) ? 2 : 1; // nice -n 5, env -u X
      } else break;
    }
    if (h < argv.length && (/^g?make$/.test(binName(argv[h]!)) || /^["']?\$\{?(?:MAKE|GMAKE)\b/.test(argv[h]!)) && ctx.depth < DEPTH) {
      ctx.depth++;
      dispatch(ctx, argv.map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(" "));
      ctx.depth--;
    }
  }
}

// The logical lines of a body: what the shell reads as one command line. A newline inside quotes, a substitution or
// after a backslash does not end one; a comment is dropped; the text of a heredoc is skipped up to its terminator.
// An unclosed quote, substitution or heredoc takes the rest of the body.
function logicalLines(text: string, heredocs?: string[]): string[] {
  const out: string[] = [];
  // The line so far, as parts and its last 12 characters: indexing into a long string being appended to is quadratic.
  const parts: string[] = [];
  let tail = "";
  let blank = true;
  let i = 0;
  let esc = false;
  const pend: { delim: string; strip: boolean; quoted: boolean }[] = [];
  const put = (x: string): void => {
    if (!x) return;
    parts.push(x);
    tail = (tail + x).slice(-12);
    if (blank && x.trim()) blank = false;
  };
  const flush = (): void => {
    if (!blank) out.push(parts.join(""));
    parts.length = 0;
    tail = "";
    blank = true;
  };
  const span = (end: number): void => {
    put(text.slice(i, Math.min(end, text.length)));
    i = Math.min(end, text.length);
  };
  while (i < text.length) {
    const c = text[i]!;
    const wasEsc = esc;
    esc = false;
    if (c === "\\") {
      if (text[i + 1] === "\n") i += 2;
      else {
        put(c + (text[i + 1] ?? ""));
        i += 2;
        esc = true;
      }
      continue;
    }
    if (c === "'") {
      const e = text.indexOf("'", i + 1);
      span(e < 0 ? text.length : e + 1);
      continue;
    }
    if (c === "$" && text[i + 1] === "'") {
      span(endAnsi(text, i + 1) + 1);
      continue;
    }
    if (c === "$" && text[i + 1] === "[") { // legacy arithmetic: a << inside is a shift
      const e = text.indexOf("]", i + 2);
      span(e < 0 ? text.length : e + 1);
      continue;
    }
    if (c === "$" && text[i + 1] === "{") {
      const e = endBrace(text, i + 2);
      span(e < 0 ? text.length : e);
      continue;
    }
    if (c === "(" && text[i + 1] === "(" && (blank || /[;&|!{]\s*$|(?:^|[\s;&|(])(?:if|while|until|elif|then|do|else|time)\s*$/.test(tail))) { // `(( n <<= 1 ))`: arithmetic, not a heredoc
      const e = endParen(text, i + 1);
      span(e < 0 ? text.length : e);
      continue;
    }
    if (c === '"') {
      span(endDq(text, i) + 1);
      continue;
    }
    if (c === "`" || (c === "$" && text[i + 1] === "(")) {
      const e = c === "`" ? endTick(text, i) : endParen(text, i + 2);
      span(e < 0 ? text.length : e);
      continue;
    }
    if (c === "#" && (parts.length === 0 || (/[\s;&|(]/.test(tail.slice(-1)) && !wasEsc))) {
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }
    if (c === "<" && text[i + 1] === "<") {
      if (text[i + 2] === "<") {
        put("<<<");
        i += 3;
        continue;
      }
      const h = heredocWord(text, i + 2);
      span(h.end);
      if (h.delim && !/^\d+$|^=/.test(h.delim)) pend.push(h); // `1 << 2` and `n <<= 1` are shifts
      continue;
    }
    if (c === "\n") {
      flush();
      i = skipHeredocs(text, i + 1, pend, heredocs ? (t) => heredocs.push(t) : undefined);
      pend.length = 0;
      continue;
    }
    put(c);
    i++;
  }
  flush();
  return out;
}

// The runners of a script of this package. A stage that starts with one runs that script wherever the line sits.
const SCRIPT_RUNNERS = new Set(["npm", "yarn", "pnpm", "bun", "run-s", "run-p", "npm-run-all"]);
const STAGE_SCRIPT_WORDS = new Set(["test", "t", "tst", "start", "stop", "restart"]);
// npm words that run lifecycle scripts without naming them: the scripts each one runs.
const NPM_LIFECYCLE: Record<string, string[]> = {
  it: ["test"],
  cit: ["test"],
  "install-test": ["test"],
  "install-ci-test": ["test"],
  pack: ["prepack", "prepare", "postpack"],
  version: ["preversion", "version", "postversion"],
};
// The lifecycle words that also run a named script themselves: --ignore-scripts does not stop that one.
const NPM_RUNS_NAMED: Record<string, string[]> = { it: ["test"], cit: ["test"], "install-test": ["test"], "install-ci-test": ["test"] };
// `npm pack` and `npm version` run this package's lifecycle scripts only for a directory spec (pack) or a version operand
// (version): `npm pack ms@2.1.3` packs a registry package and a bare `npm version` only lists versions.
// A literal registry spec: a name or @scope/name with an optional @tag, range or version that is not a path. A bare word with no
// slash is a registry name to npm; anything with an expansion, a path, a git or http spec or user/repo is not one.
function isRegistrySpec(o: string): boolean {
  return /^(?:@[a-z0-9~._-]+\/)?[a-z0-9~._-]+(?:@(?:[A-Za-z0-9^<>=*]|~[0-9])[A-Za-z0-9^~<>=*.+|_-]*)?$/.test(o) && !/^[.]/.test(o);
}
// A tarball path with a literal name: it is a file, so no hook of this package runs for it.
function isTarballPath(o: string): boolean {
  return /^(?:file:)?[A-Za-z0-9._/@+-]+\.(?:tgz|tar\.gz|tar)$/.test(o);
}
// `npm pack` and `npm version` run this package's lifecycle scripts for a directory spec (pack) or a version operand (version):
// `npm pack ms@2.1.3` packs a registry package and a bare `npm version` only lists versions. Pack is quiet only when every
// operand is a literal registry spec or tarball path; a computed, local, git or alias operand keeps the lifecycle.
function npmLifecycleApplies(sub: string, rest: string[]): boolean {
  if (sub !== "pack" && sub !== "version") return true;
  const ops: string[] = [];
  let unsure = false; // a flag this does not know may take the next word as its value
  for (let k = 0; k < rest.length; k++) {
    const w = rest[k]!;
    if (w === "--") {
      ops.push(...rest.slice(k + 1)); // after -- every word is an operand
      break;
    }
    if (w.startsWith("-")) {
      if (NPM_WORKSPACE_WIDEN.test(w)) return true; // a workspace or prefix flag moves the run to another package: its scripts run
      if (NPM_VALUE_FLAG.test(w) && !w.includes("=")) k++;
      else if (w === "--ignore-scripts" && /^(?:true|false|1|0)$/.test(rest[k + 1] ?? "")) k++;
      else if (w.startsWith("--") && !w.includes("=") && !NPM_BOOL_FLAG.test(w)) unsure = true;
      continue;
    }
    ops.push(w);
  }
  if (sub === "pack") return unsure || ops.length === 0 || !ops.every((o) => isRegistrySpec(o) || isTarballPath(o));
  return ops.length > 0; // npm reads any operand as a version (any run of v and = is stripped), so every operand counts
}
// `env -i`, `env -` and `env -u npm_config_ignore_scripts` clear the variable.
function envClears(words: string[]): boolean {
  for (let k = 0; k < words.length; k++) {
    const w = words[k]!;
    if (!w.startsWith("-") && !ASSIGN.test(w)) return false;
    if (w === "-i" || w === "-" || w === "--ignore-environment") return true;
    if ((w === "-u" || w === "--unset") && words[k + 1] === "npm_config_ignore_scripts") return true;
    if (/^(?:-u|--unset=)npm_config_ignore_scripts$/.test(w)) return true;
  }
  return false;
}
const LAUNCHER_PREFIX = /^(?:env|command|builtin|exec|nohup|time|nice|sudo|stdbuf|timeout|corepack)$/;
// Names the shell only looks up, never runs.
const LOOKUP_ONLY = /^(?:type|which|hash)$/;
// npm subcommands that run no script of this package.
const NPM_READ_ONLY = new Set(["help", "view", "v", "show", "info", "config", "c", "get", "set", "ls", "list", "la", "ll", "outdated", "audit", "prefix", "root", "bin", "whoami", "search", "s", "find", "explain", "why", "doctor", "ping", "fund", "help-search", "docs", "repo", "bugs", "home"]);
// npm flags that take a separate value, and long flags known to take none.
const NPM_VALUE_FLAG = /^(?:--(?:cache|prefix|workspace|userconfig|globalconfig|registry|loglevel|tag|otp|scope|access|script-shell|include|omit|audit-level|install-strategy|before|logs-dir|tmp|cafile|cert|key|proxy|https-proxy|noproxy|node-options|call|package|message|tag-version-prefix|logs-max|init-module|fetch-retries|fetch-timeout|location|lockfile-version|pack-destination|preid)|-w|-C|-c|-m)$/;
const NPM_BOOL_FLAG = /^--(?:silent|quiet|verbose|json|global|force|yes|no|dry-run|production|ignore-scripts|if-present|workspaces|include-workspace-root|no-[a-z-]+|foreground-scripts|offline|prefer-offline|prefer-online|legacy-peer-deps|save|save-dev|no-save|audit|fund|help|version|parseable|long|all|link|unicode|color|progress|ws)$/;
// `--ignore-scripts` (and its env spelling) switch every pre/post and lifecycle script off, not the named one.
const IGNORE_FLAG_ON = /^--ignore-scripts(?:=(?:true|1))?$/;
const IGNORE_FLAG_OFF = /^(?:--no-ignore-scripts|--ignore-scripts=(?:false|0|))$/;
const IGNORE_ENV_ON = /^npm_config_ignore_scripts=(?:true|1)$/;
const IGNORE_ENV_OFF = /^npm_config_ignore_scripts=/i; // any other value, an empty one included, leaves scripts on
// The last setting wins: the value the flags give (undefined when none names it), or the env assignments give.
function flagIgnore(words: string[]): boolean | undefined {
  let r: boolean | undefined;
  for (let k = 0; k < words.length; k++) {
    const w = words[k]!;
    if (w === "--ignore-scripts" && /^(?:true|false|1|0)$/.test(words[k + 1] ?? "")) {
      // npm's parser takes a boolean word after the flag as its value
      r = /^(?:true|1)$/.test(words[++k]!);
    } else if (IGNORE_FLAG_ON.test(w)) r = true;
    else if (IGNORE_FLAG_OFF.test(w)) r = false;
  }
  return r;
}
function envIgnore(words: string[]): boolean | undefined {
  let r: boolean | undefined;
  for (const w of words) {
    if (IGNORE_ENV_ON.test(w)) r = true;
    else if (IGNORE_ENV_OFF.test(w)) r = false;
  }
  return r;
}
const SHELL_NAME = /^(?:sh|bash|dash|zsh|ksh)$/;

// The command a stage runs, past assignments, keywords and launcher prefixes (`env -i A=1`, `nice -n 5`, `nohup`, `corepack`).
function stageCommand(words: string[], assigns?: string[]): string[] {
  let h = 0;
  while (h < words.length) {
    const w = words[h]!;
    if (ASSIGN.test(w) || STAGE_KEYWORD.test(w)) {
      if (assigns && ASSIGN.test(w)) assigns.push(w);
      h++;
    }
    else if (w === "function") h += 2;
    else if (LOOKUP_ONLY.test(w)) return []; // `type`, `which` and `hash` only look names up
    else if (LAUNCHER_PREFIX.test(binName(w))) {
      const bin = binName(w);
      // `command -v npm` and `command -V npm` look the name up: nothing runs.
      if (bin === "command") {
        // Only a flag right after \`command\` (before the command word) is a lookup flag: \`command npm run x -- -v\` runs npm.
        let q = h + 1;
        while (q < words.length && words[q]!.startsWith("-")) if (/^-[A-Za-z]*[vV][A-Za-z]*$/.test(words[q++]!)) return [];
      }
      h++;
      const takes = PREFIX_VALUE_FLAG[bin];
      while (h < words.length && (words[h]!.startsWith("-") || ASSIGN.test(words[h]!))) {
        const x = words[h]!;
        if (bin === "env" && ASSIGN.test(x)) assigns?.push(x); // only env takes assignments: after another launcher one is a command word, read as a runner's env or not, never as the setting
        else if (bin === "env" && envClears([x, words[h + 1] ?? ""])) assigns?.push("npm_config_ignore_scripts="); // the variable is cleared
        h += takes && takes.test(x) ? 2 : 1;
      }
      if (bin === "timeout" && h < words.length && /^[0-9.]+[smhd]?$/.test(words[h]!)) h++;
    } else break;
  }
  return words.slice(h);
}

// A line that is not split into commands (a pipe, a redirect, a subshell, a function definition) still runs the commands in
// it. The stages are cut apart by the shell reader (quotes, comments, heredoc bodies and redirect operands are not stages),
// and a stage that starts with a script runner and holds no expansion the scan could not resolve is dispatched on its own:
// `npm run evil | cat`, `(npm run evil)`, `f() { npm run evil; }; f`, `FOO=1 npm run evil | cat`, `sh -c 'npm run evil' | cat`.
function dispatchScriptStages(ctx: Ctx, text: string, depth = 0): void {
  if (ctx.hold || ctx.depth >= DEPTH || depth > 4) return;
  const { stages } = shellStages(text);
  for (const stage of stages) {
    if (ctx.hold) return;
    if (stage.some((w) => w.sub || w.v)) continue;
    // Only the assignments before the command (an env word's and a launcher's included, in order) set the environment: an
    // argument that looks like one does not.
    const assigns: string[] = [];
    const ws = stageCommand(stage.map((w) => w.t), assigns);
    if (!ws.length) continue;
    const ignoring = envIgnore(assigns);
    const bin = binName(ws[0]!);
    // A shell given a script text runs its commands like a line.
    if (SHELL_NAME.test(bin)) {
      const c = ws.findIndex((w) => /^-[A-Za-z]*c[A-Za-z]*$/.test(w));
      if (c >= 0 && ws[c + 1] !== undefined) dispatchScriptStages(ctx, ws[c + 1]!, depth + 1);
      continue;
    }
    // `xargs npm run` runs the runner on what is piped in.
    if (bin === "xargs") {
      const innerAssigns: string[] = [];
      const inner = stageCommand(ws.slice(1).filter((w, k, all) => !all.slice(0, k + 1).every((x) => x.startsWith("-"))), innerAssigns);
      if (inner.length && SCRIPT_RUNNERS.has(binName(inner[0]!))) {
        // The script name comes from the input: a run with no name after it may run any script.
        const tail = inner[inner.length - 1]!;
        if (inner.length === 1 || RUN_SUB.has(tail) || /^(?:run-s|run-p|npm-run-all)$/.test(binName(inner[0]!))) {
          ctx.widenInert = true;
          widenAll(ctx);
        } else dispatchRunner(ctx, inner, envIgnore([...assigns, ...innerAssigns]));
      }
      continue;
    }
    // `npx run-s evil`, `npm exec -- run-s evil`
    let run = ws;
    if (bin === "npx" || (bin === "npm" && /^(?:exec|x)$/.test(ws[1] ?? ""))) {
      const k = ws.findIndex((w, j) => j > (bin === "npx" ? 0 : 1) && !w.startsWith("-"));
      if (k < 0) continue;
      run = ws.slice(k);
    }
    if (!SCRIPT_RUNNERS.has(binName(run[0]!))) continue;
    dispatchRunner(ctx, run, ignoring);
  }
}

function dispatchRunner(ctx: Ctx, ws: string[], envIg?: boolean): void {
  const bin = binName(ws[0]!);
  const quoted = ws.map((w) => (/[\s'"\\]/.test(w) ? "'" + w.replace(/'/g, "'\\''") + "'" : w));
  let npmSub: string | undefined;
  let npmRest: string[] = [];
  // Only npm has this flag; a flag beats the env, and the last of either wins.
  const setIg = bin === "npm" ? flagIgnore(ws.slice(0, ws.includes("--") ? ws.indexOf("--") : ws.length)) ?? envIg : undefined;
  const ignore = setIg === true;
  if (bin !== "run-s" && bin !== "run-p" && bin !== "npm-run-all") {
    const dd = ws.indexOf("--");
    const args = (dd < 0 ? ws : ws.slice(0, dd)).slice(1).filter((w) => !w.startsWith("-"));
    // The subcommand is the first operand once the flags and the values of the flags that take one are skipped:
    // `npm view pack version` and `npm config get test` run no script, `npm --cache view run evil` runs evil. A version flag
    // before the subcommand prints the version; after it (`npm run evil -- --version`) it belongs to the script.
    if (bin === "npm") {
      let sub: string | undefined;
      let version = false;
      let subAt = -1;
      let unsure = false; // the word before the subcommand is a flag this does not know takes no value
      for (let q = 1; q < (dd < 0 ? ws.length : dd); q++) {
        const w = ws[q]!;
        if (w === "-v" || w === "--version") version = true;
        if (w.startsWith("-")) {
          if (NPM_VALUE_FLAG.test(w) && !w.includes("=")) q++;
          else if (w === "--ignore-scripts" && /^(?:true|false|1|0)$/.test(ws[q + 1] ?? "")) q++;
          else if (w.startsWith("--") && !w.includes("=") && !NPM_BOOL_FLAG.test(w)) unsure = true;
          continue;
        }
        sub = w;
        subAt = q;
        break;
      }
      npmSub = sub;
      npmRest = subAt >= 0 ? ws.slice(subAt + 1) : [];
      if (version) return;
      if (sub !== undefined && NPM_READ_ONLY.has(sub)) {
        // An unknown flag may have taken the read-only word as its value: a script runner after it still runs.
        const k = args.indexOf(sub);
        if (!(unsure && args.slice(k + 1, k + 2).some((w) => RUN_SUB.has(w) || STAGE_SCRIPT_WORDS.has(w)))) return;
      }
    }
    // Only a stage that names a script to run: `npm ls`, `yarn install` and the like run no script of this package.
    // Only the parsed subcommand names lifecycle scripts (`npm run build pack` runs build): and --ignore-scripts switches them off.
    const life = bin === "npm" && npmSub !== undefined ? NPM_LIFECYCLE[npmSub] : undefined;
    if (life) {
      if (!npmLifecycleApplies(npmSub!, npmRest)) return;
      ctx.depth++;
      if (ignore) for (const name of NPM_RUNS_NAMED[npmSub!] ?? []) runNamed(ctx, name, true);
      else for (const name of life) runScript(ctx, name, true);
      ctx.depth--;
      return;
    }
    const sub = args.find((w) => RUN_SUB.has(w) || STAGE_SCRIPT_WORDS.has(w) || (bin !== "npm" && typeof ctx.raw[w] === "string"));
    if (sub === undefined) return;
  }
  ctx.depth++;
  const savedIgnore = ctx.ignoreHooks;
  if (setIg !== undefined) ctx.ignoreHooks = setIg;
  dispatch(ctx, quoted.join(" "));
  ctx.ignoreHooks = savedIgnore;
  ctx.depth--;
}

// A body that does not read whole is read one logical line at a time, as the shell runs it: the commands of a line
// that reads are scanned; a line that does not read is noted like an unreadable body, and the commands of it that
// hold no expansion the scan cannot resolve are still scanned (`make -C sub && echo $(date)`).
function noteUnreadable(ctx: Ctx, text: string): void {
  dispatchScriptStages(ctx, text);
  // The text was not split, so a `cd` or a workspace flag inside a redirect, pipe or subshell may be moving a
  // run to another package. A body that stays in place (`node safe.js > out`) is not widened.
  if (noteBody(ctx, text)) widenAll(ctx);
  // A sourced file runs in this shell and may sit under test/ or docs/: read every file.
  if (/(?:^|[\s;&|({])(?:source|\.)\s+[^\s;&|)]/.test(text)) {
    ctx.widenInert = true;
    widenAll(ctx);
  }
  noteUnparsedCompile(ctx, text);
  noteUnparsedMake(ctx, text);
}

// The command word of a command (after variable assignments) holds an expansion that could not be resolved.
function headUnresolved(cmd: string): boolean {
  for (const w of cmd.split(/\s+/)) {
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) continue;
    return w.includes(UNRESOLVED);
  }
  return false;
}

// Commands with no option that runs a program or loads code: a substitution in their arguments cannot name a file they run.
// Everything else (sed `e`, openssl `-provider`, tar `--use-compress-program`, sort, grep, git, make, curl, awk, find, xargs, env,
// zip, rsync, ssh ...) may run what the substitution names. Only a bare name is the system tool: a path word (`./tools/cat`)
// is a package file.
const PLAIN_SUBST = new Set(["echo", "printf", "true", "false", ":", "pwd", "date", "sleep", "mkdir", "rm", "rmdir", "ls", "dirname", "basename", "realpath", "cat", "head", "tail", "wc", "cut", "tr", "uniq", "test", "[", "[[", "cd", "pushd", "popd", "export", "local", "declare", "typeset", "readonly", "unset", "set", "shift", "read", "exit", "return", "type", "which", "hash", "tee", "cp", "mv", "ln"]);
function plainCommand(name: string): boolean {
  return PLAIN_SUBST.has(name);
}
function plainStage(name: string): boolean {
  return plainCommand(name);
}
// Commands that run a script, a program or the text on their standard input.
const STAGE_RUNNER = /^(?:sh|bash|dash|zsh|ksh|source|\.|eval|node|nodejs|bun|deno|python[0-9.]*|py|perl|ruby|php)$/;
const SHELL_RUNNER = /^(?:sh|bash|dash|zsh|ksh|ash|mksh|yash)$/;
const STAGE_PM = /^(?:npm|npx|yarn|pnpm)$/;
// Package manager words that only look things up.
const PM_LOOKUP = new Set(["ls", "list", "view", "info", "config", "outdated", "audit", "help", "prefix", "root", "bin", "whoami", "version", "show", "search"]);
const STAGE_PREFIX = /^(?:env|command|builtin|exec|nohup|time|nice|sudo|stdbuf|timeout)$/;
// The flags of a prefix command that take a separate value: that word is not the command.
const PREFIX_VALUE_FLAG: Record<string, RegExp> = {
  nice: /^(?:-n|--adjustment)$/,
  sudo: /^(?:-u|-g|-h|-p|-C|-D|-R|-T|-U|-r|-t|--user|--group|--host|--prompt|--chdir|--close-from)$/,
  env: /^(?:-u|-C|--unset|--chdir)$/,
  exec: /^-a$/,
  timeout: /^(?:-s|-k|--signal|--kill-after)$/,
  stdbuf: /^(?:-i|-o|-e|--input|--output|--error)$/,
  time: /^(?:-f|-o|--format|--output)$/,
};
const STAGE_KEYWORD = /^(?:\{|\}|!|if|then|elif|else|do|done|fi|while|until)$/;

type StageWord = { t: string; sub: boolean; v: boolean; n: string[]; ar: boolean; an: string[]; uq: string[]; un: string[] }; // sub: a command substitution; v: a variable or arithmetic expansion; n: the plain variable names in the word

// `text` with each command substitution replaced by a number, so what is left reads as arithmetic or not.
function blankSubs(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === "$" && text[i + 1] === "(") {
      const e = endParen(text, i + 2);
      if (e < 0) return out + "0";
      out += "0";
      i = e - 1;
    } else if (c === "`") {
      const e = endTick(text, i);
      if (e < 0) return out + "0";
      out += "0";
      i = e - 1;
    } else out += c;
  }
  return out;
}

// `$((` at i opens arithmetic only when it closes with an adjacent `))` and what is inside reads as an expression: bash runs
// `$((node x) )` and `$((node x))` as a subshell in a substitution, where two operands are not separated by an operator.
function isArith(t: string, i: number): boolean {
  if (t[i] !== "$" || t[i + 1] !== "(" || t[i + 2] !== "(") return false;
  const e = endParen(t, i + 2);
  if (e < 0 || t[e - 2] !== ")") return false;
  return !/[\w$)\]}]\s+[\w$({]/.test(blankSubs(t.slice(i + 3, e - 2)));
}

// The substitutions inside the text of a `${...}` or an arithmetic expansion: each body is a command to read. `dq`: the text
// sits in double quotes, where a single quote is an ordinary character.
function nestedBodies(text: string, out: string[], depth = 0, dq = false): boolean {
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === "\\") i++;
    else if (c === "'" && !dq) {
      const e = text.indexOf("'", i + 1);
      if (e < 0) return false;
      i = e;
    } else if (c === "`") {
      const e = endTick(text, i);
      if (e < 0) return false;
      out.push(unTick(text.slice(i + 1, e - 1)));
      i = e - 1;
    } else if (c === "$" && text[i + 1] === "(") {
      const arith = isArith(text, i);
      const e = endParen(text, i + 2);
      if (e < 0) return false;
      if (arith) {
        if (depth > 6 || !nestedBodies(text.slice(i + 3, e - 2), out, depth + 1, dq)) return false;
      } else out.push(text.slice(i + 2, e - 1));
      i = e - 1;
    } else if (c === "$" && text[i + 1] === "{") {
      const e = endBrace(text, i + 2, dq);
      if (e < 0) return false;
      if (depth > 6 || !nestedBodies(text.slice(i + 2, e - 1), out, depth + 1, dq)) return false;
      i = e - 1;
    }
  }
  return true;
}

// The command text inside backticks: a backslash before \`, $ or \\ is dropped, as the shell does before it reads the body.
function unTick(body: string): string {
  return body.replace(/\\([`$\\])/g, "$1");
}

// The commands of a line cut apart the way the shell reads them: quotes and backslashes tracked, each `$(...)` and backtick
// body collected (and its place in the word marked), redirections and their operands left out. `unsure` is a quote or a
// substitution that never closes.
type StageFeed = { stages: StageWord[][]; feed: ([number, number] | null)[]; fed: boolean[]; fedUnres: boolean[]; bodies: string[]; unsure: boolean };
function shellStages(line: string): StageFeed {
  const stages: StageWord[][] = [];
  const feed: ([number, number] | null)[] = []; // the stages (a range) whose output the stage reads, when it follows a pipe
  const fed: boolean[] = []; // the stage has a here-string or a heredoc on its standard input
  const fedUnres: boolean[] = []; // and the text fed in holds an expansion
  let nextFeed: [number, number] | null = null;
  let lastRange: [number, number] = [0, 0];
  const groups: { start: number; feed: [number, number] | null }[] = []; // open subshells
  let hereStr = false;
  let nowFedUnres = false;
  let nowFed = false;
  let names: string[] = [];
  let arithBudget = 16; // scans for the end of a `((` that consume nothing (unclosed or nested runs) are bounded
  let uqBodies: string[] = []; // unquoted substitutions in the word: their output splits into words
  let uqNames: string[] = []; // and unquoted variables
  let arSub = false; // the word holds arithmetic with a substitution in it: the substituted value is evaluated
  let arNames: string[] = []; // and the names the arithmetic reads
  const bodies: string[] = [];
  let words: StageWord[] = [];
  let cur = "";
  let inWord = false;
  let sub = false;
  let v = false;
  let skip = false; // the next word is a redirection operand
  let unsure = false;
  const pend: { delim: string; strip: boolean; quoted: boolean; stage: number }[] = []; // heredocs whose text starts after the line break
  const endWord = (): void => {
    if (!inWord) return;
    if (skip) {
      skip = false;
      if (hereStr && (sub || v)) nowFedUnres = true;
      hereStr = false;
    } else words.push({ t: cur, sub, v, n: names, ar: arSub, an: arNames, uq: uqBodies, un: uqNames });
    cur = "";
    inWord = false;
    sub = false;
    v = false;
    names = [];
    arSub = false;
    arNames = [];
    uqBodies = [];
    uqNames = [];
  };
  const endStage = (): void => {
    endWord();
    if (words.length) {
      stages.push(words);
      feed.push(nextFeed ?? (groups.length ? groups[groups.length - 1]!.feed : null));
      fed.push(nowFed);
      fedUnres.push(nowFedUnres);
      lastRange = [stages.length - 1, stages.length];
      nextFeed = null;
      nowFed = false;
      nowFedUnres = false;
    }
    words = [];
  };
  const take = (i: number, tick: boolean, quoted = false): number => {
    const e = tick ? endTick(line, i) : endParen(line, i + 2);
    if (e < 0) {
      unsure = true;
      return line.length;
    }
    const text = tick ? unTick(line.slice(i + 1, e - 1)) : line.slice(i + 2, e - 1);
    bodies.push(text);
    if (!quoted) uqBodies.push(text);
    sub = true;
    inWord = true;
    cur += UNRESOLVED;
    return e;
  };
  const dollar = (i: number, dq = false): number => {
    // `$((..))` is arithmetic, `${..}` and `$name` are variables: not commands.
    v = true;
    inWord = true;
    cur += UNRESOLVED;
    if (isArith(line, i)) {
      const e = endParen(line, i + 2);
      if (e < 0) {
        unsure = true;
        return line.length;
      }
      const arith = line.slice(i + 3, e - 2);
      if (!nestedBodies(arith, bodies, 0, dq)) unsure = true;
      if (/\$\(|`/.test(arith)) arSub = true;
      arNames.push(...(arith.match(/[A-Za-z_]\w*/g) ?? []));
      return e;
    }
    if (line[i + 1] === "{") {
      const e = endBrace(line, i + 2, dq);
      if (e < 0) {
        unsure = true;
        return line.length;
      }
      const inner = line.slice(i + 2, e - 1);
      if (!nestedBodies(inner, bodies, 0, dq)) unsure = true;
      const nm = /^[A-Za-z_][A-Za-z0-9_]*$/.exec(inner);
      if (nm) {
        names.push(nm[0]);
        if (!dq) uqNames.push(nm[0]);
      }
      return e;
    }
    const m = /^(?:[A-Za-z_][A-Za-z0-9_]*|[0-9@*#?$!-])/.exec(line.slice(i + 1));
    if (m && /^[A-Za-z_]/.test(m[0])) {
      names.push(m[0]);
      if (!dq) uqNames.push(m[0]);
    }
    return i + 1 + (m ? m[0].length : 0);
  };
  for (let i = 0; i < line.length; ) {
    const c = line[i]!;
    if (c === "\\") {
      if (i + 1 >= line.length) unsure = true;
      else {
        cur += line[i + 1];
        inWord = true;
      }
      i += 2;
      continue;
    }
    if (c === "'") {
      const e = line.indexOf("'", i + 1);
      inWord = true;
      if (e < 0) {
        unsure = true;
        break;
      }
      cur += line.slice(i + 1, e);
      i = e + 1;
      continue;
    }
    if (c === '"') {
      inWord = true;
      let j = i + 1;
      for (; j < line.length && line[j] !== '"'; ) {
        const d = line[j]!;
        if (d === "\\") {
          cur += line[j + 1] ?? "";
          j += 2;
        } else if (d === "`") j = take(j, true, true);
        else if (d === "$" && line[j + 1] === "(" && !isArith(line, j)) j = take(j, false, true);
        else if (d === "$" && line[j + 1] !== undefined && /[A-Za-z_{(0-9@*#?$!-]/.test(line[j + 1]!)) j = dollar(j, true);
        else {
          cur += d;
          j++;
        }
      }
      if (j >= line.length) {
        unsure = true;
        break;
      }
      i = j + 1;
      continue;
    }
    if (c === "`") {
      i = take(i, true);
      continue;
    }
    if (c === "$" && line[i + 1] === "(" && !isArith(line, i)) {
      i = take(i, false);
      continue;
    }
    if (c === "$" && line[i + 1] !== undefined && /[A-Za-z_{(0-9@*#?$!-]/.test(line[i + 1]!)) {
      i = dollar(i);
      continue;
    }
    if (c === "<" && line[i + 1] === "(" || c === ">" && line[i + 1] === "(") {
      // a process substitution: a word whose body is a command
      const e = endParen(line, i + 2);
      if (e < 0) {
        unsure = true;
        break;
      }
      bodies.push(line.slice(i + 2, e - 1));
      cur += UNRESOLVED;
      sub = true;
      inWord = true;
      i = e;
      continue;
    }
    if (c === "<" && line[i + 1] === "<" && line[i + 2] !== "<") {
      // a heredoc: its text is not commands, and an apostrophe in it is not a quote
      const h = heredocWord(line, i + 2);
      if (h.delim && !/^\d+$|^=/.test(h.delim)) {
        endWord();
        nowFed = true;
        pend.push({ ...h, stage: stages.length });
        i = h.end;
        continue;
      }
    }
    if (c === "<" || c === ">" || (c === "&" && line[i + 1] === ">")) {
      if (inWord && /^\d+$/.test(cur) && !sub && !v) {
        cur = "";
        inWord = false; // the descriptor of `2>`
      } else endWord();
      let j = i;
      while (j < line.length && /[<>&|]/.test(line[j]!)) j++;
      if (line.startsWith("<<<", i)) {
        nowFed = true;
        hereStr = true;
      }
      skip = true; // the operand: a file, a descriptor or a here-string
      i = j;
      continue;
    }
    if (c === "\n" && pend.length) {
      endStage();
      i = skipHeredocs(line, i + 1, pend, (text, h) => {
        if (!nestedBodies(text, bodies, 0, true)) unsure = true;
        if (/[$`]/.test(text) && h.stage < fedUnres.length) fedUnres[h.stage] = true;
      });
      pend.length = 0;
      continue;
    }
    if (c === "|" && line[i + 1] !== "|" && line[i - 1] !== "|") {
      endStage();
      nextFeed = lastRange;
      i += line[i + 1] === "&" ? 2 : 1;
      continue;
    }
    if (c === "(" && line[i + 1] === "(" && !inWord && arithBudget <= 0) unsure = true; // a very long nested run of ((: read every file
    else if (c === "(" && line[i + 1] === "(" && !inWord) {
      // `(( ... ))` as a command evaluates its text as arithmetic: a substituted value in it runs as code
      const e = endParen(line, i + 1);
      const inner0 = e > 0 ? line.slice(i + 2, e - 2) : "";
      if (e > 0 && line[e - 2] === ")" && !/[;|&]/.test(blankSubs(inner0)) && !/[\w$)\]}]\s+[\w$({]/.test(blankSubs(inner0))) {
        endStage();
        const inner = inner0;
        if (!nestedBodies(inner, bodies, 0, false)) unsure = true;
        stages.push([{ t: "((", sub: false, v: false, n: [], ar: /\$\(|`/.test(inner), an: inner.match(/[A-Za-z_]\w*/g) ?? [], uq: [], un: [] }]);
        feed.push(null);
        fed.push(false);
        fedUnres.push(false);
        lastRange = [stages.length - 1, stages.length];
        i = e;
        continue;
      }
      arithBudget--; // a scan that did not consume its text (an unclosed or nested run) counts toward the bound
    }
    if (c === "(") {
      endStage();
      groups.push({ start: stages.length, feed: nextFeed ?? (groups.length ? groups[groups.length - 1]!.feed : null) });
      nextFeed = null;
      i++;
      continue;
    }
    if (c === ")") {
      endStage();
      const g = groups.pop();
      if (g) lastRange = [g.start, stages.length];
      i++;
      continue;
    }
    if (c === "|" || c === ";" || c === "\n" || (c === "&" && line[i + 1] !== ">")) {
      endStage();
      i++;
      continue;
    }
    if (c === "#" && !inWord) {
      // a comment runs to the end of the line
      while (i < line.length && line[i] !== "\n") i++;
      continue;
    }
    if (/\s/.test(c)) {
      endWord();
      i++;
      continue;
    }
    cur += c;
    inWord = true;
    i++;
  }
  endStage();
  return { stages, feed, fed, fedUnres, bodies, unsure };
}

// The flags of an interpreter that carry its program text (`-e`) or take a separate value, and the ones of a shell.
function runnerFlags(name: string): { code: RegExp; value: RegExp } {
  if (SHELL_RUNNER.test(name)) return { code: /^-[A-Za-z]*c[A-Za-z]*$/, value: /^(?:-o|-O|--rcfile|--init-file)$/ };
  const key = /^(?:node|nodejs)$/.test(name) ? "node" : /^(?:python[0-9.]*|py)$/.test(name) ? "python" : name;
  const spec = STDIN_INTERPS[key];
  if (!spec) return { code: /^$/, value: /^$/ };
  return { code: spec.code, value: key === "node" ? new RegExp(spec.value.source.replace(/\)\$$/, "|--title)$")) : spec.value };
}
// Commands whose output is a number, a version or a platform name: unquoted, it cannot split into a second flag. A path or a
// host name can hold spaces (pwd, npm root|prefix, hostname, whoami, uname -n -a -v), and a bare date prints the time zone name,
// so those are quiet only quoted; sysctl and getconf only for numeric keys.
// A date format starts with a conversion and holds only conversions and the separators : . _ -; %z is out (west of UTC it prints -0700) and so is the _ flag
// (it pads with a space). The format may be quoted.
const DATE_FMT = "%[-0^]?[YmdHMSyjuwUVWFTDRsN%](?:[:._-]|%[-0^]?[YmdHMSyjuwUVWFTDRsN%])*";
const DATE_SUB = new RegExp(`^date (?:\\+${DATE_FMT}|'\\+${DATE_FMT}'|"\\+${DATE_FMT}"|\\+'${DATE_FMT}'|\\+"${DATE_FMT}")$`);
const BENIGN_SUB = /^(?:nproc(?: --all)?|uname(?: -[smrpio])?|arch|getconf (?:_?NPROCESSORS_[A-Z]+|PAGE_?SIZE|ARG_MAX|LONG_BIT)|sysctl -n (?:hw\.(?:ncpu|logicalcpu|physicalcpu|activecpu|availcpu|memsize|pagesize|cpufrequency|l[123]dcachesize|cachelinesize))|node (?:-v|--version))$/;
// Flags whose substituted value is a number or a target, not a program.
const SAFE_FLAG_SUB: Record<string, RegExp> = {
  make: /^-j/,
  gmake: /^-j/,
  ninja: /^-j/,
  cmake: /^-D(?:CMAKE_BUILD_TYPE|CMAKE_INSTALL_PREFIX|CMAKE_OSX_ARCHITECTURES|CMAKE_OSX_DEPLOYMENT_TARGET|BUILD_TESTING|BUILD_SHARED_LIBS|[A-Z0-9_]*_VERSION)(?::[A-Z]+)?=/,
  "node-gyp": /^--(?:target|arch|jobs|dist-url|runtime)(?:=|$)/,
  "prebuild-install": /^--(?:target|arch|runtime|platform)(?:=|$)/,
};

// True when a stage of the line (or of a substitution in it) may run a file of the package that the text does not name.
// Only plain commands (SHELL_PLAIN, PLAIN_CMDS) are quiet with a substitution in an argument: any other command may run what
// the substitution names. An interpreter given a literal script (`node lib/ok.js "$(date)"`) runs that script, whose arguments
// are data; with a flag first, the script cannot be told from a flag value, so every substitution counts.
function stageHazard(line: string, depth: number, inherited?: Set<string>): { hit: boolean; inert: boolean } {
  const { stages, feed, fed, fedUnres, bodies, unsure } = shellStages(line);
  if (unsure) return { hit: true, inert: true };
  const tainted = new Set<string>(inherited); // variables set from a substitution earlier on the line
  let hit = false;
  let inert = false;
  const widen = (wide: boolean): void => {
    hit = true;
    if (wide) inert = true;
  };
  const taints = (w: StageWord): boolean => w.sub || (w.v && w.n.some((x) => tainted.has(x)));
  // An unquoted substitution or tainted variable splits into words: a second flag can come out of it.
  const splits = (w: StageWord): boolean => w.uq.some((b) => !(BENIGN_SUB.test(b.trim()) || DATE_SUB.test(b.trim()))) || w.un.some((x) => tainted.has(x));
  const holdsUnresolved = (st: StageWord[]): boolean => st.some((w) => w.sub || w.v);
  stages.forEach((words, at) => {
    let h = 0;
    while (h < words.length) {
      const w = words[h]!;
      if (ASSIGN.test(w.t) || STAGE_KEYWORD.test(w.t)) {
        if (ASSIGN.test(w.t) && taints(w)) tainted.add(w.t.slice(0, w.t.indexOf("=")).replace(/\+$/, ""));
        h++;
      } else if (!w.sub && !w.v && STAGE_PREFIX.test(binName(w.t))) {
        const pre = binName(w.t);
        const timed = pre === "timeout";
        const takes = PREFIX_VALUE_FLAG[pre];
        h++;
        while (h < words.length && (words[h]!.t.startsWith("-") || ASSIGN.test(words[h]!.t))) {
          const flag = words[h]!.t;
          h += takes && takes.test(flag) ? 2 : 1;
        }
        if (timed && h < words.length && /^[0-9.]+[smhd]?$/.test(words[h]!.t)) h++;
      } else break;
    }
    const head = words[h];
    // Arithmetic evaluates a substituted value, and a value like a[$(cmd)] runs the command.
    if (words.some((w) => w.ar || w.an.some((x) => tainted.has(x)))) widen(true);
    if (!head) return; // only assignments: what their substitutions hold is read as bodies
    if (head.sub || head.v) {
      // An unresolved command word may be any runner; a path word keeps the directory-scoped read.
      widen(!head.t.includes("/"));
      return;
    }
    const rest = words.slice(h + 1);
    // `for x in $(...)`: the variable holds what the substitution printed.
    if (head.t === "for" && rest[1]?.t === "in") {
      if (rest.slice(2).some(taints)) tainted.add(rest[0]!.t);
      return;
    }
    // The word a `case` or `select` looks at is data: what a substitution in it prints only picks a branch.
    if (/^(?:case|esac|select)$/.test(head.t)) return;
    const name = binName(head.t);
    const path = head.t.includes("/");
    if (!path && plainStage(name)) {
      // A declaration keeps what a substitution printed in its variable.
      if (/^(?:export|local|declare|typeset|readonly)$/.test(name)) {
        for (const w of rest) if (ASSIGN.test(w.t) && taints(w)) tainted.add(w.t.slice(0, w.t.indexOf("=")).replace(/\+$/, ""));
      }
      // A substituted name or number is evaluated as arithmetic by these: a[$(cmd)] runs cmd.
      // The words of `read` that are names: not the values of -p -n -N -t -u -d -i -a.
      const operands = (): StageWord[] => {
        const out: StageWord[] = [];
        for (let k = 0; k < rest.length; k++) {
          const w = rest[k]!;
          if (w.t === "--") continue;
          if (w.t.startsWith("-")) {
            if (name === "read" && /^-[A-Za-z]*[pnNtudia]$/.test(w.t)) k++;
            continue;
          }
          out.push(w);
        }
        return out;
      };
      const named = operands().some((w) => !ASSIGN.test(w.t) && taints(w));
      if (/^(?:read|unset|declare|typeset|local|readonly|export)$/.test(name) && named) widen(true);
      if (/^(?:declare|typeset|local)$/.test(name) && rest.some((w) => /^-[A-Za-z]*i/.test(w.t)) && rest.some(taints)) widen(true);
      // A variable set from a substitution is evaluated as arithmetic when declared -i or unset by name: a[$(cmd)] runs cmd.
      const namesTainted = operands().some((w) => tainted.has(w.t.replace(/=.*/, "")));
      if (/^(?:declare|typeset|local)$/.test(name) && rest.some((w) => /^-[A-Za-z]*i/.test(w.t)) && namesTainted) widen(true);
      if (name === "unset" && namesTainted) widen(true);
      // read keeps what its input holds in its variables.
      if (name === "read") for (const w of operands()) if (!ASSIGN.test(w.t)) tainted.add(w.t);
      // Only the name after -v is evaluated: the data arguments of printf are data, and after -- a -v is the format. The
      // variable it sets keeps what a substituted argument printed.
      if (name === "printf") {
        const dd = rest.findIndex((w) => w.t === "--");
        const v = rest.findIndex((w, k) => w.t === "-v" && (dd < 0 || k < dd));
        if (v >= 0 && rest[v + 1] !== undefined) {
          if (taints(rest[v + 1]!)) widen(true);
          else if (rest.slice(v + 2).some(taints)) tainted.add(rest[v + 1]!.t);
        }
      }
      if (/^(?:\[|\[\[|test)$/.test(name) && (rest.some(taints) || rest.some((w) => tainted.has(w.t))) && rest.some((w) => w.t === "-v" || /^-(?:eq|ne|lt|le|gt|ge)$/.test(w.t))) widen(true);
      return;
    }
    if (path) {
      // A path word is a file of the package: it may run what its argument names.
      if (rest.some(taints)) widen(true);
      return;
    }
    if (STAGE_RUNNER.test(name)) {
      const spec = runnerFlags(name);
      let q = 0;
      let codeFlag = false;
      let codeWord: StageWord | undefined;
      let sub = false; // deno and bun take a subcommand (`deno run -A file`) before the script
      while (q < rest.length) {
        const w = rest[q]!;
        if (!w.t.startsWith("-")) {
          if (!sub && /^(?:deno|bun)$/.test(name) && /^[a-z]+$/.test(w.t) && !w.sub && !w.v) {
            sub = true;
            q++;
            continue;
          }
          break;
        }
        const joined = w.t.includes("=");
        const flag = joined ? w.t.slice(0, w.t.indexOf("=")) : w.t;
        if (!joined && spec.code.test(w.t)) {
          // The word after a code flag is the program text, which may read its arguments.
          codeFlag = true;
          codeWord = rest[q + 1];
          q += 2;
        } else if (spec.value.test(flag)) {
          // A preload or loader names a file the runner loads.
          if (joined ? taints(w) : rest[q + 1] !== undefined && taints(rest[q + 1]!)) widen(true);
          q += joined ? 1 : 2;
        } else {
          // A flag value that splits can carry a second flag (a preload, a loader).
          if (splits(w)) widen(true);
          q++;
        }
      }
      const first = rest[q];
      if (name === "eval" && rest.length > 0) {
        // The words are joined and run as a line.
        if (rest.some(taints)) widen(true);
        else if (depth < 6) {
          const r = stageHazard(rest.map((w) => w.t).join(" "), depth + 1, tainted);
          if (r.hit) widen(r.inert);
        }
        return;
      }
      if (codeWord && !codeWord.sub && SHELL_RUNNER.test(name) && depth < 6) {
        const r = stageHazard(codeWord.t, depth + 1, tainted);
        if (r.hit) widen(r.inert);
      }
      if (codeFlag && rest.some(taints)) widen(true);
      else if (!first) {
        // no script: it reads its standard input, which a pipe or a here-string feeds
        const f = feed[at];
        const piped = f ? stages.slice(f[0], f[1]).some(holdsUnresolved) : false;
        if (piped || (fed[at] && fedUnres[at])) widen(true);
        else if (rest.some(taints)) widen(true);
      } else if (!codeFlag && (first.sub || first.v)) widen(true);
      return;
    }
    if (STAGE_PM.test(name)) {
      const ops = rest.filter((w) => !w.t.startsWith("-"));
      if (ops[0] !== undefined && PM_LOOKUP.has(ops[0].t)) return;
      if (ops.slice(0, 2).some((w) => w.sub || w.v) || rest.some(taints)) widen(true);
      return;
    }
    // Any other command may run what a substitution in its arguments names; a flag value of a build tool that only sets a
    // number or a target (`make -j$(nproc)`, `node-gyp rebuild --target=$(node -v)`) does not.
    // `let X` evaluates the value of a variable set from a substitution as arithmetic.
    if (name === "let" && rest.some((w) => taints(w) || (w.t.match(/[A-Za-z_]\w*/g) ?? []).some((x) => tainted.has(x)))) widen(true);
    // The value is exempt only as a literal or a quoted substitution: an unquoted one splits into words, and a word can be a flag.
    const safe = SAFE_FLAG_SUB[name];
    const exempt = (w: StageWord, p: StageWord | undefined): boolean => {
      if (!safe || splits(w)) return false;
      if (w.t.startsWith("-")) return safe.test(w.t);
      // the value as the next word of a bare flag: `--target "$(node -v)"`, `-D CMAKE_BUILD_TYPE="$(cmd)"`
      return !!p && p.t.startsWith("-") && !p.t.includes("=") && !p.sub && !p.v && safe.test(p.t === "-D" ? "-D" + w.t : p.t + "=" + w.t);
    };
    if (rest.some((w, k) => taints(w) && !exempt(w, rest[k - 1]))) widen(true);
  });
  if (depth < 6) {
    for (const body of bodies) {
      const r = stageHazard(body, depth + 1, tainted);
      if (r.hit) widen(r.inert);
    }
  } else if (bodies.length) widen(true);
  return { hit, inert };
}

// A line the shell reader could not split (a pipe, a redirect, a subshell) that holds an expansion it could not resolve: each
// stage and each substitution body is read as a command, and a stage that runs a command or file named by the expansion, or
// reads its standard input, may run any file of the package, so every file is read.
function unreadableUnresolved(ctx: Ctx, loose: string, orig: string): void {
  if (!loose.includes(UNRESOLVED)) return;
  const r = stageHazard(orig, 0);
  if (!r.hit) return;
  if (r.inert) ctx.widenInert = true;
  widenAll(ctx);
}

// A line that did split into commands still runs whatever its substitutions hold (`: $(node $(cat n))`, `x=$(sh $(cat n))`): each
// substitution body is read as a command line of its own.
function substBodiesHazard(ctx: Ctx, orig: string): void {
  if ((!orig.includes("$(") && !orig.includes("`"))) return;
  const { bodies, unsure } = shellStages(orig);
  let hit = unsure;
  let inert = unsure;
  for (const b of bodies) {
    const r = stageHazard(b, 1);
    if (r.hit) {
      hit = true;
      inert ||= r.inert;
    }
  }
  if (!hit) return;
  if (inert) ctx.widenInert = true;
  widenAll(ctx);
}

function heredocHazard(ctx: Ctx, text: string): void {
  if (!/[$`]/.test(text)) return;
  const bs: string[] = [];
  let hit = !nestedBodies(text, bs, 0, true);
  let inert = hit;
  for (const b of bs) {
    const r = stageHazard(b, 1);
    if (r.hit) {
      hit = true;
      inert ||= r.inert;
    }
  }
  if (!hit) return;
  if (inert) ctx.widenInert = true;
  widenAll(ctx);
}

function readParts(ctx: Ctx, body: string): void {
  if (body.includes(UNRESOLVED)) {
    // The placeholder is a character the body itself holds: a command could not be told from an unresolved one. Read every file.
    ctx.widenInert = true;
    widenAll(ctx);
    return;
  }
  const hds: string[] = [];
  const lines = logicalLines(body, hds);
  // An unquoted heredoc expands its text: a substitution in it runs.
  for (const text of hds) heredocHazard(ctx, text);
  for (const line of lines) {
    if (ctx.hold) return;
    const whole = subst(ctx, line);
    if (whole !== null && splitCommands(ctx, whole)) {
      runBody(ctx, line);
      continue;
    }
    const loose = subst(ctx, line, true);
    const cmds = loose === null ? null : splitCommands(ctx, loose);
    if (cmds && ctx.depth < DEPTH) {
      ctx.depth++;
      for (const cmd of cmds) {
        // An unresolved command word may be any runner: every file is read. An unresolved argument is dispatched as an argument.
        if (headUnresolved(cmd)) {
          // A bare unresolved command word (`$npm_execpath run x`) may run anything: tests and docs are read too. A path word
          // (`./tools/$N.sh`) keeps the directory-scoped read.
          const head = cmd.split(/\s+/).find((w) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) ?? "";
          if (!head.includes("/")) ctx.widenInert = true;
          widenAll(ctx);
        } else dispatch(ctx, cmd);
      }
      ctx.depth--;
      substBodiesHazard(ctx, line);
    } else if (loose !== null) unreadableUnresolved(ctx, loose, line);
    if (ctx.hold) return;
    if (lines.length > 1) noteUnreadable(ctx, line); // a body of one line is noted whole by the caller
  }
}

// Shell forms that run code the text does not name (see shell-classes.ts): read every file, like an unrecognised runner.
function noteClasses(ctx: Ctx, body: string): void {
  if (flagBody(body).length === 0) return;
  widenAll(ctx);
}

function runBody(ctx: Ctx, body: string): void {
  if (ctx.hold) return;
  noteClasses(ctx, body);
  if (ctx.depth >= DEPTH) {
    ctx.widenInert = true;
    widenAll(ctx);
    fail(ctx, "unresolved: script depth");
    return;
  }
  if (body.includes("*") && ctx.fileCount > STAR_KEY_MAX) {
    fail(ctx, `key count ${ctx.fileCount} > ${STAR_KEY_MAX}`);
    return;
  }
  // ANSI-C quoting hides quotes from the command splitter as well: read every file.
  if (body.includes("$'")) {
    ctx.widenInert = true;
    widenAll(ctx);
  }
  const sub = subst(ctx, body);
  if (sub === null || ctx.hold) {
    if (sub === null && !ctx.hold) readParts(ctx, body);
    if (sub === null && !ctx.hold) noteUnparsedMake(ctx, body); // `echo $(make -C sub)`, `${MAKE:-make} -C sub`
    // An expansion that cannot be resolved may name another directory: widen when the body moves the run.
    if (sub === null && noteBody(ctx, body)) widenAll(ctx);
    return;
  }
  const cmds = splitCommands(ctx, sub);
  if (!cmds) {
    readParts(ctx, body);
    noteUnreadable(ctx, sub);
    return;
  }
  if (ctx.hold) return;
  ctx.depth++;
  for (const cmd of cmds) dispatch(ctx, cmd);
  ctx.depth--;
}

function runScript(ctx: Ctx, name: string, optional: boolean): void {
  if (ctx.hold) return;
  if (ctx.seen.has(name)) return;
  const raw = ctx.raw[name];
  if (typeof raw !== "string") {
    // A script named by an unresolved expansion (`npm run "$(cat name.txt)"`) may be any script of the package.
    if (name.includes(UNRESOLVED)) {
      ctx.widenInert = true;
      widenAll(ctx);
    }
    if (!optional) fail(ctx, "unresolved: script");
    return;
  }
  if (ctx.seen.size >= DEPTH || ctx.depth >= DEPTH) {
    ctx.widenInert = true;
    widenAll(ctx);
    fail(ctx, "unresolved: script depth");
    return;
  }
  ctx.seen.add(name);
  ctx.scripts[name] = raw;
  if (raw.length === 0) return;
  ctx.depth++;
  // Each script starts at the package root, whatever an earlier script changed into.
  const savedCwd = ctx.cwd;
  ctx.cwd = "";
  if (!ctx.ignoreHooks) runScript(ctx, `pre${name}`, true);
  ctx.cwd = "";
  runBody(ctx, raw);
  ctx.cwd = "";
  if (!ctx.ignoreHooks) runScript(ctx, `post${name}`, true);
  ctx.cwd = savedCwd;
  ctx.depth--;
}

function readWord(ctx: Ctx, argv: string[], i: number): { i: number; word?: string } | null {
  while (i < argv.length) {
    const a = argv[i]!;
    if (a === "--") {
      fail(ctx, "unresolved: flag");
      return null;
    }
    if (!a.startsWith("-")) return { i, word: a };
    const eq = a.indexOf("=");
    const name = eq > 0 ? a.slice(0, eq) : a;
    if (BOOL_FLAGS.has(name)) {
      i++;
      continue;
    }
    if (VALUE_FLAGS.has(name)) {
      if (eq > 0) {
        i++;
        continue;
      }
      if (i + 1 >= argv.length) {
        fail(ctx, "unresolved: flag");
        return null;
      }
      i += 2;
      continue;
    }
    fail(ctx, "unresolved: flag");
    return null;
  }
  return { i, word: undefined };
}

function restart(ctx: Ctx): void {
  if (typeof ctx.raw.restart === "string") {
    runScript(ctx, "restart", false);
    return;
  }
  const stop = typeof ctx.raw.stop === "string";
  const start = typeof ctx.raw.start === "string";
  if (!stop && !start) {
    fail(ctx, "unresolved: script");
    return;
  }
  if (stop) runScript(ctx, "stop", false);
  if (start) runScript(ctx, "start", false);
}

// The program a package runner runs: the first word that is not one of the runner's own options. Options that take the next word
// as a value (`--registry URL`, `--cache DIR`, `--cwd .`, `-p pkg`) are skipped with it. A package manager that runs another
// program (`corepack npm exec -- node`, `corepack npx node`) is followed to that program.
const RUNNER_VALUE_FLAGS = /^--(?:registry|cache|userconfig|globalconfig|loglevel|cwd|prefix|workspace|shell|node-arg|node-options|config|tag|scope)$/;
function runnerExecutable(argv: string[], i: number, depth = 0): string {
  for (let j = i; j < argv.length; j++) {
    const a = argv[j]!;
    let exe: string | undefined;
    if (a === "--") exe = runnerName(argv[j + 1] ?? "");
    else if (!a.startsWith("-")) exe = runnerName(a);
    if (exe !== undefined) {
      const at = a === "--" ? j + 1 : j;
      // Past the depth limit the program is not known: it may be node.
      if (/^(?:npx|bunx|pnpx)$/.test(exe)) return depth < 4 ? runnerExecutable(argv, at + 1, depth + 1) : "node";
      if (/^(?:npm|pnpm|yarn|bun)$/.test(exe)) {
        const sub = argv.findIndex((w, q) => q > at && /^(?:exec|x|dlx)$/.test(w));
        if (sub > 0) return depth < 4 ? runnerExecutable(argv, sub + 1, depth + 1) : "node";
      }
      return exe;
    }
    const ef = execFlag(a);
    if (ef?.kind === "call") return "";
    if (ef?.kind === "package" && ef.value === undefined) j++;
    else if (RUNNER_VALUE_FLAGS.test(a)) j++;
  }
  return "";
}

// Node's own options that never take a value (from `node --help`), and the V8 flags that are plain switches. Any other option may
// take the next word (`--title t`, `--localstorage-file f`, `-C dev`), so that word is not counted as the script: a `.` after it
// still names the package root. The options node documents as taking a value are listed too: their value is never the root.
const NODE_BOOL_NAMES = new Set(["--abort-on-uncaught-exception", "--allow-addons", "--allow-child-process", "--allow-ffi", "--allow-fs-vfs", "--allow-inspector", "--allow-net", "--allow-openssl-store", "--allow-wasi", "--allow-worker", "--bench", "--build-snapshot", "--check", "--completion-bash", "--cpu-prof", "--deprecation", "--disable-sigusr1", "--disable-wasm-trap-handler", "--disallow-code-generation-from-strings", "--enable-etw-stack-walking", "--enable-fips", "--enable-fips-indicator-events", "--enable-network-family-autoselection", "--enable-source-maps", "--entry-url", "--experimental-addon-modules", "--experimental-async-context-frame", "--experimental-bench", "--experimental-detect-module", "--experimental-eventsource", "--experimental-fetch", "--experimental-global-customevent", "--experimental-global-navigator", "--experimental-global-webcrypto", "--experimental-import-meta-resolve", "--experimental-import-text", "--experimental-inspector-network-resource", "--experimental-json-modules", "--experimental-network-inspection", "--experimental-permission", "--experimental-print-required-tla", "--experimental-repl-await", "--experimental-require-module", "--experimental-shadow-realm", "--experimental-sqlite", "--experimental-storage-inspection", "--experimental-stream-iter", "--experimental-strip-types", "--experimental-test-coverage", "--experimental-test-module-mocks", "--experimental-transform-types", "--experimental-vfs", "--experimental-vm-modules", "--experimental-wasm-modules", "--experimental-web-worker", "--experimental-websocket", "--experimental-webstorage", "--experimental-worker", "--experimental-worker-inspection", "--expose-gc", "--force-context-aware", "--force-fips", "--force-node-api-uncaught-exceptions-policy", "--frozen-intrinsics", "--heap-prof", "--help", "--insecure-http-parser", "--inspect", "--inspect-brk", "--inspect-wait", "--interactive", "--interpreted-frames-native-stack", "--jitless", "--no-addons", "--no-async-context-frame", "--no-deprecation", "--no-experimental-detect-module", "--no-experimental-ffi", "--no-experimental-global-navigator", "--no-experimental-repl-await", "--no-experimental-require-module", "--no-experimental-sqlite", "--no-experimental-websocket", "--no-experimental-webstorage", "--no-extra-info-on-fatal-exception", "--no-force-async-hooks-checks", "--no-global-search-paths", "--no-network-family-autoselection", "--no-require-module", "--no-strip-types", "--no-warnings", "--no-worker-snapshot", "--node-memory-debug", "--openssl-legacy-provider", "--openssl-shared-config", "--pending-deprecation", "--permission", "--permission-audit", "--preserve-symlinks", "--preserve-symlinks-main", "--prof", "--prof-process", "--report-compact", "--report-exclude-env", "--report-exclude-network", "--report-on-fatalerror", "--report-on-process-timeout", "--report-on-signal", "--report-uncaught-exception", "--test", "--test-coverage-include-all", "--test-force-exit", "--test-only", "--test-randomize", "--test-update-snapshots", "--throw-deprecation", "--tls-max-v1.2", "--tls-max-v1.3", "--tls-min-v1.0", "--tls-min-v1.1", "--tls-min-v1.2", "--tls-min-v1.3", "--trace-deprecation", "--trace-env", "--trace-env-js-stack", "--trace-env-native-stack", "--trace-exit", "--trace-promises", "--trace-sigint", "--trace-sync-io", "--trace-tls", "--trace-uncaught", "--trace-warnings", "--track-heap-objects", "--use-bundled-ca", "--use-env-proxy", "--use-openssl-ca", "--use-system-ca", "--v8-options", "--version", "--warnings", "--watch", "--watch-preserve-output", "--webstorage", "--zero-fill-buffers", "-c", "-h", "-i", "-v"]);
const NODE_VALUE_NAMES = new Set(["--allow-fs-read", "--allow-fs-write", "--bench-isolation", "--bench-name-pattern", "--bench-reporter", "--bench-reporter-destination", "--bench-samples", "--bench-warmup", "--build-sea", "--build-snapshot-config", "--conditions", "--config-file", "--cpu-prof-dir", "--cpu-prof-interval", "--cpu-prof-name", "--debug-port", "--diagnostic-dir", "--disable-proto", "--disable-warning", "--dns-result-order", "--env-file", "--env-file-if-exists", "--eval", "--experimental-config-file", "--experimental-default-config-file", "--experimental-loader", "--experimental-package-map", "--experimental-sea-config", "--experimental-test-isolation", "--experimental-test-tag-filter", "--heap-prof-dir", "--heap-prof-interval", "--heap-prof-name", "--heapsnapshot-near-heap-limit", "--heapsnapshot-signal", "--icu-data-dir", "--import", "--input-type", "--inspect-port", "--inspect-publish-uid", "--loader", "--localstorage-file", "--max-http-header-size", "--max-old-space-size-percentage", "--network-family-autoselection-attempt-timeout", "--openssl-config", "--process-timeout", "--redirect-warnings", "--report-dir", "--report-directory", "--report-filename", "--report-signal", "--require", "--run", "--secure-heap", "--secure-heap-min", "--snapshot-blob", "--test-concurrency", "--test-coverage-branches", "--test-coverage-exclude", "--test-coverage-functions", "--test-coverage-include", "--test-coverage-lines", "--test-global-setup", "--test-isolation", "--test-name-pattern", "--test-random-seed", "--test-reporter", "--test-reporter-destination", "--test-rerun-failures", "--test-shard", "--test-skip-pattern", "--test-timeout", "--title", "--tls-cipher-list", "--tls-keylog", "--trace-event-categories", "--trace-event-file-pattern", "--trace-require-module", "--unhandled-rejections", "--use-largepages", "--v8-pool-size", "--vfs-load", "--watch-kill-signal", "--watch-path", "-C", "-e", "-r"]);
const NODE_BOOL_RE =
  /^--(?:no-[a-z0-9-]+|harmony[a-z-]*|expose-[a-z-]+|abort-on-[a-z-]+|disable-(?!warning|proto)[a-z-]+|trace-(?!event-|require-module)[a-z-]+|allow-natives-syntax|use-strict|max-lazy|veri[f]y-base-objects|track-heap-objects|zero-fill-buffers|perf-[a-z-]+)$/;

function dispatchNode(ctx: Ctx, argv: string[], i: number): void {
  // The first operand that names a file of the package is the script, and the words after it are its own arguments: a `.`
  // before that (after an option and its value, `--title t .`) is the directory node runs.
  const allow = ctx.rootRuns;
  let scriptSeen = false;
  let optValue = false; // the next word is possibly an option's value: not the script
  let knownValue = false; // ... and a documented value: not the root either
  while (i < argv.length) {
    ctx.rootRuns = false;
    if (ctx.hold) return;
    const a = argv[i]!;
    if (a === "--") {
      // What follows is the script and its arguments.
      for (let q = i + 1; q < argv.length; q++) {
        ctx.rootRuns = allow && !scriptSeen && q === i + 1;
        noteHookArgCwd(ctx, argv[q]!);
      }
      return;
    }
    if (a.startsWith("-")) {
      optValue = false;
      knownValue = false;
      const eq = a.indexOf("=");
      const name = eq > 0 ? a.slice(0, eq) : a;
      const inline = eq > 0 ? a.slice(eq + 1) : undefined;
      const take = (): string | undefined => {
        if (inline !== undefined) return inline;
        const next = argv[i + 1];
        if (next === undefined) {
          fail(ctx, "unresolved: flag");
          return undefined;
        }
        i++;
        return next;
      };
      if (name === "--test") {
        // The test runner globs test files under any test directory: every file is read, inert paths included.
        ctx.widenInert = true;
        widenAll(ctx);
        i++;
        continue;
      }
      if (name === "--run") {
        const script = take();
        if (!script) return;
        runScript(ctx, script, false);
        i++;
        continue;
      }
      if (name === "-e" || name === "--eval" || name === "-p" || name === "--print" || name === "-pe" || name === "-ep") {
        const code = take();
        if (code === undefined) return;
        evalCode(ctx, code);
        scriptSeen = true; // the words after the code are its arguments
        i++;
        continue;
      }
      if (name === "-r" || name === "--require" || name === "--import") {
        const spec = take();
        if (!spec) return;
        ctx.rootRuns = allow; // a preload names a module, so a directory runs its main
        noteHookArgCwd(ctx, spec);
        i++;
        continue;
      }
      // A node option this does not know (--no-warnings, --max-old-space-size=4096, --title foo, -C dev) may take
      // the next word as its value or load a file: widen, and keep reading the words that follow as files.
      widenAll(ctx);
      if (inline) noteHookArgCwd(ctx, inline);
      else if (!NODE_BOOL_NAMES.has(name) && !NODE_BOOL_RE.test(name)) {
        optValue = true;
        knownValue = NODE_VALUE_NAMES.has(name);
      }
      i++;
      continue;
    }
    // A file named by an expansion the scan could not resolve (`node $(cat name.txt)`) may be any file of the package.
    // A path word (`node tools/$N.js`) keeps the directory-scoped read.
    if (a.includes(UNRESOLVED) && !a.includes("/")) {
      ctx.widenInert = true;
      widenAll(ctx);
    }
    ctx.rootRuns = allow && !scriptSeen && !knownValue;
    noteHookArgCwd(ctx, a);
    // The value of a value-taking option (`--title lib/ok.js`, `--env-file .env`) is not the script. A file, a dotfile or a
    // directory with an index or manifest that is not the root is the script; `.`, `./` and `lib/..` name the root.
    if (!scriptSeen && !optValue) {
      const n = normalize(a).replace(/\/+$/, "");
      scriptSeen =
        Boolean(n) && !badPath(n) && (nodeFile(ctx, n) !== undefined || nodeFile(ctx, `${n}/index`) !== undefined || ctx.logical.has(`${n}/package.json`));
    }
    optValue = false;
    knownValue = false;
    i++;
  }
}

function dispatchSh(ctx: Ctx, argv: string[], i: number): void {
  // Options come first. Any option this does not know widens (it may take a value or load a
  // file); the first operand is the script, and arguments after it are the script's own.
  let j = i;
  let sFlag = false;
  for (; j < argv.length; j++) {
    const t = argv[j]!;
    if (t === "--") {
      j++;
      break;
    }
    if (!t.startsWith("-") && !t.startsWith("+")) break;
    if (/^-[A-Za-z]*c[A-Za-z]*$/.test(t)) {
      // The command string is a body: the options after -c that take a name come first, then the string.
      let n = j + 1 + (t.match(/[oO]/g) ?? []).length;
      while (n < argv.length) {
        const o = argv[n]!;
        if (o === "--") {
          n++;
          break;
        }
        if (/^[-+][A-Za-z]+$/.test(o)) n += 1 + (o.match(/[oO]/g) ?? []).length;
        else if (o === "--rcfile" || o === "--init-file") n += 2;
        else if (/^--[A-Za-z-]+(?:=.*)?$/.test(o)) n++;
        else break;
      }
      const body = argv[n];
      if (body === undefined || ctx.depth >= DEPTH) {
        ctx.widenInert = true;
        widenAll(ctx);
        fail(ctx, "unresolved: shell");
        return;
      }
      ctx.depth++;
      runBody(ctx, body);
      ctx.depth--;
      // The words after the string are $0, $1, ...: they may name files the string runs (`sh -c 'node "$1"' _ x.js`).
      for (let q = n + 1; q < argv.length; q++) noteHookArgCwd(ctx, argv[q]!);
      return;
    }
    if (/^[-+][A-Za-z]*s[A-Za-z]*$/.test(t) && t.startsWith("-")) sFlag = true;
    if (/^[-+][A-Za-z]+$/.test(t)) {
      // -o / +o / -O take an option name.
      j += (t.match(/[oO]/g) ?? []).length;
    } else if (t === "--rcfile" || t === "--init-file") {
      if (argv[j + 1]) noteHookArgCwd(ctx, argv[j + 1]!);
      j++;
    } else if (/^--(?:rcfile|init-file)=/.test(t)) noteHookArgCwd(ctx, t.slice(t.indexOf("=") + 1));
    else if (!/^--(?:norc|noprofile|posix|login|restricted|verbose|noediting|debugger|version|help)$/.test(t)) widenAll(ctx);
  }
  // With -s the script comes from stdin and every operand is a positional parameter.
  if (sFlag) {
    for (let q = j; q < argv.length; q++) noteHookArgCwd(ctx, argv[q]!);
    fail(ctx, "unresolved: shell");
    return;
  }
  const token = argv[j];
  // The script's own arguments may name files it runs (`node "$1"`): they are read too.
  for (let q = j + 1; q < argv.length; q++) noteHookArgCwd(ctx, argv[q]!);
  if (token === undefined) {
    // No script: the shell reads stdin.
    fail(ctx, "unresolved: shell");
    return;
  }
  noteHookArgCwd(ctx, token);
  if (ctx.hold) return;
  // The script resolves from the directory an earlier cd moved to first.
  const rel = ctx.cwd && !token.startsWith("/") ? joinDir(ctx.cwd, token) : undefined;
  const key = (rel !== undefined ? findKey(ctx, normalize(rel)) : undefined) ?? findKey(ctx, normalize(token));
  if (!key) {
    // A script this package does not hold: what it runs is not known.
    widenAll(ctx);
    fail(ctx, "unresolved: shell");
    return;
  }
  if (ctx.ranSh.has(key)) return;
  if (ctx.ranSh.size >= DEPTH) {
    fail(ctx, "unresolved: script depth");
    return;
  }
  ctx.ranSh.add(key);
  runBody(ctx, dec.decode(ctx.bytes.get(key)));
}

function dispatchRuns(ctx: Ctx, argv: string[], i: number): void {
  for (let j = i; j < argv.length; j++) {
    if (ctx.hold) return;
    const a = argv[j]!;
    if (a === "--") {
      fail(ctx, "unresolved: flag");
      return;
    }
    if (a.startsWith("-")) {
      const eq = a.indexOf("=");
      const name = eq > 0 ? a.slice(0, eq) : a;
      if (BOOL_FLAGS.has(name)) continue;
      if (VALUE_FLAGS.has(name)) {
        if (eq < 0) {
          const next = argv[j + 1];
          if (next === undefined || next.startsWith("-")) {
            fail(ctx, "unresolved: flag");
            return;
          }
          j++;
        }
        continue;
      }
      fail(ctx, "unresolved: flag");
      return;
    }
    if (/\s/.test(a)) {
      fail(ctx, "unresolved: shell");
      return;
    }
    if (a.includes("?") || a.includes("[")) {
      fail(ctx, "glob");
      return;
    }
    if (a.includes("*")) {
      if (a.length > STAR_PATTERN_MAX) {
        fail(ctx, "pattern length");
        return;
      }
      const keys = Object.keys(ctx.raw).filter((k) => typeof ctx.raw[k] === "string");
      if (keys.length > STAR_KEY_MAX) {
        fail(ctx, `key count ${keys.length} > ${STAR_KEY_MAX}`);
        return;
      }
      for (const k of keys) {
        if (k.length > STAR_TEXT_MAX) {
          fail(ctx, "pattern length");
          return;
        }
        if (starMatch(a, k)) runScript(ctx, k, false);
      }
      continue;
    }
    runScript(ctx, a, false);
  }
}

const WORKSPACE_WIDEN: Record<"yarn" | "pnpm" | "bun", RegExp> = {
  pnpm: /^(?:-[A-Za-z]*[FCrw].*|--filter(?:-prod)?(?:=.*)?|--dir(?:=.*)?|--prefix(?:=.*)?|--recursive(?:=.*)?|--workspace-root(?:=.*)?|recursive|m|multi)$/,
  yarn: /^(?:--cwd(?:=.*)?|-C.*|workspace|workspaces)$/, // -C is no yarn flag; hold it, not a skip
  bun: /^(?:-F.*|--filter(?:=.*)?|--cwd(?:=.*)?|--workspaces)$/,
};
// npm reaches another package with --prefix/-C, -w/--workspace and --workspaces/-ws.
const NPM_WORKSPACE_WIDEN = /^(?:--(?:user|global)config(?:=.*)?|--prefix(?:=.*)?|-C.*|-w.*|--workspaces?(?:=.*)?|--include-workspace-root(?:=.*)?|-iwr)$/;
const RUNNER_BUILTINS = new Set(["exec", "x", "dlx", "create", "init", "add", "remove", "rm", "install", "i", "link", "up", "upgrade", "update", "pm", "patch", "set", "config", "node", "workspace", "workspaces", "rebuild", "unplug"]);

// A shorthand word that looks like a file path (`bun payload.js`, `yarn ./x`) runs that file,
// not a script of the same name, so it is never resolved as a script.
function pathLikeWord(w: string): boolean {
  return w.includes("/") || /\.(?:js|cjs|mjs|ts|tsx|jsx)$/.test(w);
}

// `npx yarn run setup` and `corepack pnpm test` resolve to a script of this package.
// Returns that script name, or undefined when the wrapped command is anything else.
function wrappedScript(ctx: Ctx, argv: string[], i: number): string | undefined {
  const inner = argv[i];
  if (inner === undefined || inner.startsWith("-")) return undefined;
  const runner = runnerName(inner);
  if (runner !== "npm" && runner !== "yarn" && runner !== "pnpm" && runner !== "bun") return undefined;
  if (runner === "npm" && npmFlagWidens(argv, i + 1)) return undefined;
  let j = i + 1;
  while (j < argv.length && BOOL_FLAGS.has(argv[j]!)) j++;
  const sub = argv[j];
  if (sub === undefined || sub.startsWith("-")) return undefined;
  const has = (n: string | undefined): n is string => n !== undefined && !n.startsWith("-") && typeof ctx.raw[n] === "string";
  if (RUN_SUB.has(sub) || sub === "run-script") {
    let k = j + 1;
    while (k < argv.length && BOOL_FLAGS.has(argv[k]!)) k++;
    return has(argv[k]) ? argv[k] : undefined;
  }
  if (runner === "npm") {
    if (sub === "test" || sub === "t" || sub === "tst") return has("test") ? "test" : undefined;
    return (sub === "start" || sub === "stop") && has(sub) ? sub : undefined;
  }
  if (RUNNER_BUILTINS.has(sub) || pathLikeWord(sub)) return undefined;
  // pnpm runs its own recursive command for these words, never a script of that name.
  if (runner === "pnpm" && /^(?:recursive|m|multi)$/.test(sub)) return undefined;
  return has(sub) ? sub : undefined;
}

// The command word of a package runner is a local file only when it is written as one:
// `./x.js`, `../x.js` or `/abs/x.js`. A bare name (`evil.js`) is a package to npx, and a leading
// flag (whose value could be path-like), a scoped name, a `host:path` spec or a URL widens too.
function localEntry(w: string): boolean {
  if (w.startsWith("./") || w.startsWith("../") || w.startsWith("/")) return true;
  return false;
}

// `npm exec` runs the command after its flags, so that command is dispatched. A named package (`-p`,
// `--package`) or a command that is not a local path is fetched when it is not installed, so it is never
// resolved: it widens and holds as the unknown runner does. `-c`/`--call` hands a shell string to runBody.
function npmExec(ctx: Ctx, argv: string[], from: number, ex: number): void {
  // Flags before `exec` that are not known to stay in place widen, and the command after them is still read.
  if (npmFlagWidens(argv.slice(0, ex), from)) widenAll(ctx);
  let k = ex + 1;
  let remote = false;
  let call: string | undefined;
  while (k < argv.length && argv[k] !== "--" && argv[k]!.startsWith("-")) {
    const a = argv[k]!;
    const ef = execFlag(a);
    if (ef?.kind === "call") {
      call = ef.value ?? argv[k + 1] ?? "";
      if (ef.value === undefined) k++;
    } else if (ef?.kind === "package") {
      remote = true;
      if (ef.value === undefined) k++;
    } else if (a !== "--yes" && a !== "-y" && a !== "--no" && npmFlagWidens([a], 0)) {
      // An unknown flag may take the next word as its value: widen, and the command is still dispatched below
      // (a bare name is a package to fetch and fails as the unresolved runner).
      widenAll(ctx);
    }
    k++;
  }
  if (call !== undefined) {
    if (ctx.depth >= DEPTH) {
      ctx.widenInert = true;
      widenAll(ctx);
      fail(ctx, "unresolved: script depth");
      return;
    }
    ctx.depth++;
    runBody(ctx, call);
    ctx.depth--;
    // `-p pkg -c '...'` runs with a fetched package on PATH, as `-p pkg -- cmd` does.
    if (remote) {
      widenAll(ctx);
      fail(ctx, "unresolved: runner");
    }
    return;
  }
  if (argv[k] === "--") k++;
  else if (k < argv.length && npmFlagWidens(argv, k + 1)) {
    // Flags after the command word are npm's own: widen, and still dispatch the command word.
    widenAll(ctx);
    fail(ctx, "unresolved: runner");
  }
  // The command word is a file the run executes, so it is read itself, inert path or not.
  if (k < argv.length && localEntry(argv[k]!)) closeUnknownRunner(ctx, argv, k);
  const inner = argv.slice(k).map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(" ");
  if (ctx.depth >= DEPTH) {
    ctx.widenInert = true;
    widenAll(ctx);
    fail(ctx, "unresolved: script depth");
    return;
  }
  ctx.depth++;
  if (k >= argv.length || remote || !localEntry(argv[k]!)) {
    if (k < argv.length) dispatch(ctx, inner);
    widenAll(ctx);
    fail(ctx, "unresolved: runner");
  } else dispatch(ctx, inner);
  ctx.depth--;
}

const NPM_QUIET_FLAGS = new Set(["--loglevel", "--max-parallel", "--jobs", "-j", "--preid", "--tag-version-prefix", "--message", "-m"]);

// Whether every word is a flag, a quiet flag taking its value as the next word (`--loglevel silent`, `-j 4`) included.
function flagsOnly(ws: string[]): boolean {
  for (let j = 0; j < ws.length; j++) {
    const t = ws[j]!;
    if (!t.startsWith("-")) return false;
    if (NPM_QUIET_FLAGS.has(t)) j++;
  }
  return true;
}

// True when an argument before a bare `--` is a flag that is not known to leave the run in place.
function npmFlagWidens(argv: string[], from: number): boolean {
  for (let j = from; j < argv.length && argv[j] !== "--"; j++) {
    const a = argv[j]!;
    if (!a.startsWith("-") || a === "-") continue;
    const eq = a.indexOf("=");
    const name = eq > 0 ? a.slice(0, eq) : a;
    if (NPM_WORKSPACE_WIDEN.test(a) || !(BOOL_FLAGS.has(name) || NPM_QUIET_FLAGS.has(name))) return true;
    // A quiet flag with a separate value: the value is not a flag or a word of the command.
    if (eq < 0 && NPM_QUIET_FLAGS.has(name)) j++;
  }
  return false;
}

// Tools that run a script of every package. A file named among their arguments is a config, not an entry.
const WORKSPACE_TOOLS = new Set(["lerna", "turbo", "nx", "rush", "wsrun"]);

// Commands of a shell body, split outside quotes at `;`, `&`, `|`, newlines, parentheses and backticks.
function shellSegments(body: string): string[] {
  const out: string[] = [];
  let cur = "";
  let last = ""; // the last character of cur: indexing into a long string that is being appended to is quadratic
  const add = (x: string): void => {
    cur += x;
    last = x[x.length - 1]!;
  };
  const reset = (): void => {
    cur = "";
    last = "";
  };
  let quote: string | undefined;
  let escEnd = false;
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!;
    const wasEsc = escEnd;
    escEnd = false;
    if (quote) {
      add(c);
      // A backslash escapes inside double quotes only.
      if (c === "\\" && quote === '"' && i + 1 < body.length) add(body[++i]!);
      else if (c === quote) quote = undefined;
    } else if (c === "\\") {
      // An escaped character is a plain character: it opens no quote and ends no command.
      add(c);
      if (i + 1 < body.length) add(body[++i]!);
      escEnd = true;
    } else if (c === "#" && (last === "" || (/\s/.test(last) && !wasEsc))) {
      // A comment runs to the end of the line.
      while (i + 1 < body.length && body[i + 1] !== "\n") i++;
    } else if (c === "'" || c === '"') {
      quote = c;
      add(c);
    } else if ((c === "&" && (last === "<" || last === ">" || (body[i + 1] === ">" && body[i - 1] !== "&"))) || (c === "|" && last === ">")) {
      // `2>&1`, `>&2`, `&>file` and `>|file` are redirects, not command separators.
      add(c);
    } else if (";&|\n()`".includes(c)) {
      if (cur.trim()) out.push(cur.trim());
      reset();
    } else add(c);
  }
  // An unterminated quote is a shell error, but nothing after it is trusted: read it split without quotes too.
  if (quote) out.push(...cur.split(/[;&|\n()`]+/).map((t) => t.trim()).filter(Boolean));
  else if (cur.trim()) out.push(cur.trim());
  return out;
}

const ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*\+?=/;
const NODE_OPTS = /^NODE_OPTIONS\+?=/;
const SPECIAL_ENV = /^(?:npm_|NPM_|NODE_OPTIONS\+?=|YARN_|PNPM_|BUN_|COREPACK_)/;
const UNSAFE_ENV = /^(?:CDPATH|IFS|GIT_SSH_COMMAND|GIT_SSH|GIT_EXTERNAL_DIFF|GIT_PAGER|GIT_EDITOR|GIT_ASKPASS|GIT_CONFIG_COUNT|GIT_CONFIG_PARAMETERS|SSH_ASKPASS|EDITOR|VISUAL|PAGER|PYTHONPATH|PYTHONSTARTUP|PERL5LIB|PERL5OPT|RUBYOPT|RUBYLIB|ZDOTDIR|PATH|HOME|BASH_ENV|ENV|NODE_PATH|LD_PRELOAD|LD_LIBRARY_PATH|DYLD_INSERT_LIBRARIES|DYLD_LIBRARY_PATH|DYLD_FRAMEWORK_PATH|DYLD_FALLBACK_LIBRARY_PATH|DYLD_FALLBACK_FRAMEWORK_PATH|LD_AUDIT|path|cdpath|fpath)\+?=/;
const RUNNERS = new Set(["npm", "pnpm", "yarn", "yarnpkg", "bun", "bunx", "npx", "pnpx", "corepack"]);
const WRAP_BINS = new Set(["xargs", "env", "nohup", "time", "exec", "cross-env", "sudo", "doas", "nice", "ionice", "timeout", "stdbuf", "setsid", "caffeinate", "busybox", "chrt", "arch"]);
const WRAPPERS = new Set(["command", "builtin", "exec", "nohup", "time", "env", "cross-env"]);
const DIR_FLAG = /^(?:--prefix|--dir|--cwd|--workspace|-C|-w)(?:=(.*))?$/;
// npm reads any unique prefix of a long flag (`--prefi`, `--workspa`) and a short cluster ending in w or C
// (`-sw dir`): all of them name a directory.
function dirFlagName(a: string): { name: string; value?: string } | undefined {
  const eq = a.indexOf("=");
  const name = eq > 0 ? a.slice(0, eq) : a;
  const value = eq > 0 ? a.slice(eq + 1) : undefined;
  if (DIR_FLAG.test(name)) return { name, value };
  if (name.startsWith("--") && name.length >= 3 && ["--prefix", "--workspace", "--workspaces", "--dir", "--cwd"].some((f) => f.startsWith(name))) return { name, value };
  if (/^-[A-Za-z]+[wC]$/.test(name)) return { name, value };
  return undefined;
}

// Directories a flag names: `--prefix sub`, `-C sub`, `--dir=sub`, `-Csub`.
function flagDirs(rest: string[], dirs: string[]): void {
  for (let j = 0; j < rest.length && rest[j] !== "--"; j++) {
    const m = dirFlagName(rest[j]!);
    if (m) {
      // A flag that takes no value (`--workspaces`) leaves a following word as a command word: both are recorded.
      const v = m.value ?? rest[j + 1];
      if (v && !v.startsWith("-")) pushDir(dirs, v);
    } else if (/^-C./.test(rest[j]!)) pushDir(dirs, rest[j]!.slice(2));
    else if (/^-w./.test(rest[j]!)) pushDir(dirs, rest[j]!.slice(2));
  }
}

// Whether one command (its words) moves a run: a directory change, a workspace tool, a runner given a workspace
// flag or an npm flag not known to stay in place, or a wrapper (env, cross-env, exec, command, npx, npm exec,
// pnpm exec, sh -c) around one of those. Only the command word is looked at, so other programs' flags and quoted
// text (`tar -C dir`, `echo 'workspace'`) are not. Directories named on the way go to `dirs`.
function movesCore(argv: string[], dirs: string[]): boolean {
  // CDPATH, PATH, HOME and the startup-file variables change what any later command resolves to, here or in a later
  // command: read every file.
  if (argv.some((a) => UNSAFE_ENV.test(a))) {
    dirs.push(UNSURE);
    return true;
  }
  // The same variables in any word, not only a leading one (`export npm_config_workspace=sub; npm run build`).
  if (argv.some((a) => SPECIAL_ENV.test(a))) {
    if (argv.some((a) => NODE_OPTS.test(a))) dirs.push(UNSURE);
    return true;
  }
  let k = 0;
  let wrapped = false;
  while (k < argv.length) {
    const a = argv[k]!;
    if (ASSIGN.test(a)) {
      if (SPECIAL_ENV.test(a)) {
        // NODE_OPTIONS=--require=./x.js names a file node runs first: read every file.
        if (NODE_OPTS.test(a)) dirs.push(UNSURE);
        return true;
      }
    } else if (/^(?:!|then|do|else|elif|if|while|until|\{)$/.test(a)) {
      // a shell reserved word before the command
    } else if (wrapped && a.startsWith("-")) {
      // An option of env or time. `env -C dir` / `--chdir=dir` runs the command in another directory.
      if (a === "--chdir") {
        if (argv[k + 1]) pushDir(dirs, argv[k + 1]!);
        return true;
      }
      if (a.startsWith("--chdir=")) {
        pushDir(dirs, a.slice(8));
        return true;
      }
      // `-S string` / `--split-string=string` is a whole command line.
      const sv = a.startsWith("--split-string=") ? a.slice(15) : /^-[A-Za-z]*S/.test(a) && !a.startsWith("--") ? a.slice(a.indexOf("S") + 1) || argv[k + 1] : a === "--split-string" ? argv[k + 1] : undefined;
      if (sv !== undefined && movesRun(sv, dirs)) return true;
      // A short cluster holding C (`-C`, `-Cdir`, `-iC dir`, `-iCdir`): the directory follows the C or is the next word.
      const c = /^-[A-Za-z]*C/.exec(a);
      if (c && !a.startsWith("--")) {
        const tail = a.slice(c[0].length);
        const d = tail || argv[k + 1];
        if (d) pushDir(dirs, d);
        return true;
      }
    } else if (WRAPPERS.has(runnerName(a.replace(/^\\+/, "")))) wrapped = true;
    else break;
    k++;
  }
  if (k >= argv.length) return false;
  // `yarnpkg` is yarn and `pnpx` is npx.
  const bin = runnerName(argv[k]!.replace(/^\\+/, "")).replace(/^yarnpkg$/, "yarn").replace(/^pnpx$/, "npx");
  const rest = argv.slice(k + 1);
  // Flags of otherwise plain commands that run a program (`rg --pre sh`, `tar -F sh`, `find -exec`).
  const rp = RUNS_PROGRAM[bin];
  if (rp && rest.some((t) => rp.test(t))) {
    dirs.push(UNSURE);
    return true;
  }
  if (/^(?:cd|pushd|popd)$/.test(bin)) {
    const t = rest.find((x) => x === "-" || !x.startsWith("-"));
    // A bare `cd` goes to HOME and an argless `popd` to a directory not tracked here.
    if (t) pushDir(dirs, t);
    else dirs.push(UNSURE);
    return true;
  }
  if (WORKSPACE_TOOLS.has(bin)) return true;
  if (bin === "npm") {
    flagDirs(rest, dirs);
    const ex = rest.findIndex((a, j) => (a === "exec" || a === "x") && flagsOnly(rest.slice(0, j)));
    // These name a file npm or node then runs; the file is not resolved here, so read every file.
    if (rest.some((t) => /^--(?:node-options|script-shell|userconfig|globalconfig)/.test(t))) dirs.push(UNSURE);
    if (ex >= 0) return execMoves(rest.slice(ex + 1), dirs) || npmFlagWidens(rest.slice(0, ex), 0);
    const dd = rest.indexOf("--");
    return npmFlagWidens(rest, 0) || rest.slice(0, dd < 0 ? rest.length : dd).some((t) => NPM_WORKSPACE_WIDEN.test(t));
  }
  if (bin === "yarn" || bin === "pnpm" || bin === "bun") {
    const before = rest.slice(0, rest.indexOf("--") < 0 ? rest.length : rest.indexOf("--"));
    if (before.some((t) => WORKSPACE_WIDEN[bin].test(t))) {
      flagDirs(rest, dirs);
      return true;
    }
    if (rest.some((t) => WORKSPACE_TOOLS.has(runnerName(t)))) return true;
    const ex = rest.findIndex((t) => t === "exec" || t === "x" || t === "dlx");
    return ex >= 0 && moves(rest.slice(ex + 1), dirs);
  }
  if (bin === "npx" || bin === "bunx" || bin === "corepack") {
    let n = 0;
    while (n < rest.length && rest[n]!.startsWith("-")) {
      const ef = execFlag(rest[n]!);
      if (ef?.kind === "call" && (ef.value !== undefined || rest[n + 1] !== undefined)) return movesRun(ef.value ?? rest[n + 1]!, dirs);
      // npx and bunx take the workspace and prefix flags too.
      if (NPM_WORKSPACE_WIDEN.test(rest[n]!) || (bin === "bunx" && WORKSPACE_WIDEN.bun.test(rest[n]!))) {
        flagDirs(rest, dirs);
        if (/^--(?:userconfig|globalconfig)/.test(rest[n]!)) dirs.push(UNSURE);
        return true;
      }
      n++;
    }
    return n < rest.length && moves(rest.slice(n), dirs);
  }
  if (SHELL_RE.test(bin)) {
    let rc = false;
    // `-c` may sit anywhere among the options, after options that take a value (`-o pipefail`, `--rcfile x`).
    for (let j = 0; j < rest.length && (rest[j]!.startsWith("-") || rest[j]!.startsWith("+")); j++) {
      const o = rest[j]!;
      if (/^-[A-Za-z]*c[A-Za-z]*$/.test(o)) {
        // POSIX allows options between -c and the string (`sh -c -e '...'`, `bash -c -- '...'`, `sh -c -o pipefail '...'`).
        let n = j + 1;
        // Each o/O in the cluster (`-eco pipefail`, `-oc pipefail`) takes an option name before the string.
        n += (o.match(/[oO]/g) ?? []).length;
        while (n < rest.length && (rest[n]!.startsWith("-") || rest[n]!.startsWith("+"))) {
          if (rest[n] === "--") {
            n++;
            break;
          }
          n += 1 + (/^[-+][A-Za-z]+$/.test(rest[n]!) ? (rest[n]!.match(/[oO]/g) ?? []).length : rest[n] === "--rcfile" || rest[n] === "--init-file" ? 1 : 0);
        }
        // A string that is wholly an expansion cannot be read.
        if (rest[n] !== undefined && /^\s*\$/.test(rest[n]!)) {
          dirs.push(UNSURE);
          return true;
        }
        // A file sourced inside the string runs in that shell and may sit under test/ or docs/: its directory is read.
        let sourced = false;
        for (const m of (rest[n] ?? "").matchAll(/(?:^|[\s;&|({])(?:source|\.)\s+['"]?([^\s;&|)'"]+)/g)) {
          fedDir(dirs, m[1]!);
          sourced = true;
        }
        const mv = rest[n] !== undefined && movesRun(rest[n]!, dirs);
        // The words after the string are $0, $1, ...: they may name files the string runs.
        let params = false;
        for (const t of rest.slice(n + 1)) if (!t.startsWith("-")) {
          fedDir(dirs, t);
          params = true;
        }
        return sourced || rest[n] === undefined || mv || params;
      }
      if (/^[-+][A-Za-z]+$/.test(o)) j += (o.match(/[oO]/g) ?? []).length;
      else if (o === "--rcfile" || o === "--init-file") {
        // The startup file runs in the shell: read it even under test/ or docs/.
        fedDir(dirs, rest[j + 1] ?? "");
        rc = true;
        j++;
      } else if (/^--(?:rcfile|init-file)=/.test(o)) {
        fedDir(dirs, o.slice(o.indexOf("=") + 1));
        rc = true;
      }
    }
    if (rc) return true;
  }
  // A command word not modeled here (nice, timeout, eval, xargs, a wrapper with value options) may run what
  // follows it: read the first later cd, runner or workspace-tool word as the command, and any later word that
  // holds a whole command line (`env -S '...'`, `eval '...'`) as a body. `tar -C dir` and `rm -rf` have none.
  if (bin === "eval" && rest.some((t) => t.includes("$") || t.includes("`"))) {
    dirs.push(UNSURE);
    return true;
  }
  if (bin !== "echo" && bin !== "printf") {
    const n = rest.findIndex((t) => {
      const b = runnerName(t.replace(/^\\+/, ""));
      return /^(?:cd|pushd|popd)$/.test(b) || RUNNERS.has(b) || WORKSPACE_TOOLS.has(b);
    });
    if (n >= 0 && moves(rest.slice(n), dirs)) return true;
    if (rest.some((t) => /\s/.test(t) && movesRun(t, dirs))) return true;
  }
  return false;
}

// movesRun for a body that is not dispatched command by command: the directories it moves into and the
// runners it names are recorded on the context.
// A file fed to a shell or interpreter (`sh < scripts/x.sh`, `cat scripts/list | xargs node`) is a surface file, and
// a script that is fed runs as a body, so what it runs is read too; a list names files, which are read.
function readFed(ctx: Ctx, path: string, shell = false): void {
  const tag = path.indexOf("\u0003");
  if (tag >= 0) {
    const saved = ctx.cwd;
    ctx.cwd = path.slice(tag + 1);
    readFedAt(ctx, path.slice(0, tag), shell);
    ctx.cwd = saved;
    return;
  }
  // Resolved from the directory an earlier cd moved to as well as from the package root.
  if (ctx.cwd && path && !path.startsWith("/")) {
    const j = joinDir(ctx.cwd, path);
    if (j === undefined) {
      ctx.widenInert = true;
      widenAll(ctx);
    } else if (j !== path) readFedAt(ctx, j, shell);
  }
  readFedAt(ctx, path, shell);
}

function readFedAt(ctx: Ctx, path: string, shell: boolean): void {
  const logical = normalize(path);
  if (!logical || badPath(logical)) return;
  const key = findKey(ctx, logical);
  if (!key || isManifest(key)) return;
  noteHookArg(ctx, path);
  if (ctx.ranSh.has(key)) return;
  if (ctx.ranSh.size >= DEPTH || ctx.depth >= DEPTH) {
    // A budget ran out with a fed file unread: read every file.
    ctx.widenInert = true;
    widenAll(ctx);
    return;
  }
  ctx.ranSh.add(key);
  const text = dec.decode(ctx.bytes.get(key));
  if (text.length > 1_000_000) {
    ctx.widenInert = true;
    widenAll(ctx);
    return;
  }
  if (shell || /\.(?:sh|bash|zsh|ksh|bats)$/i.test(logical) || /^#!.*\b(?:sh|bash|zsh|dash|ksh)\b/.test(text)) {
    ctx.depth++;
    runBody(ctx, text);
    ctx.depth--;
  } else if (!/[;&|`$(){}<>'"]/.test(text) && text.length < 20_000) {
    for (const t of text.split(/\s+/)) if (/^[A-Za-z0-9._/-]+$/.test(t) && t !== path) readFed(ctx, t);
  }
}

function noteBody(ctx: Ctx, body: string): boolean {
  const dirs: string[] = [];
  const hit = movesRun(body, dirs);
  for (const d of dirs) {
    if (isFedMark(d)) readFed(ctx, d.slice(1), d.startsWith(FEDSH));
    else if (d === UNSURE) ctx.widenInert = true;
    else {
      const n = normalize(d);
      if (n) ctx.movedDirs.add(n);
      const r = joinDir(ctx.cwd, d);
      // A path that leaves the package root, or an absolute one, cannot be resolved: read every file.
      if (r === undefined) ctx.widenInert = true;
      const m = r === undefined ? undefined : normalize(r);
      if (m) ctx.movedDirs.add(m);
    }
  }
  for (const seg of shellSegments(body)) if (words(seg).some((t) => RUNNERS.has(runnerName(t.replace(/^\\+/, ""))))) ctx.sawRunner = true;
  // A runner inside a quoted string (`bash -c 'npm run build'`) is a runner too.
  if (/(?:^|[\s;&|('"`])(?:npm|pnpm|yarn|yarnpkg|bun|bunx|npx|pnpx|corepack)(?![\w-])/.test(body)) ctx.sawRunner = true;
  return hit;
}

// `npm exec` options, then the command: `-c` hands over a shell string.
// An `npm exec` flag that names a call string or a package, in the forms npm reads: the full name, a unique
// prefix (`--cal`, `--pack`), a short flag, or a short cluster (`-yc`, `-yp pkg`). `value` is set when it is joined.
function execFlag(a: string): { kind: "call" | "package"; value?: string } | undefined {
  const eq = a.indexOf("=");
  const name = eq > 0 ? a.slice(0, eq) : a;
  const value = eq > 0 ? a.slice(eq + 1) : undefined;
  if (name.startsWith("--")) {
    if (name.length >= 5 && "--call".startsWith(name)) return { kind: "call", value };
    if (name.length >= 5 && "--package".startsWith(name)) return { kind: "package", value };
    return undefined;
  }
  if (!/^-[A-Za-z]+$/.test(name)) return undefined;
  const at = name.search(/[cp]/);
  if (at < 0) return undefined;
  const inline = name.slice(at + 1);
  return { kind: name[at] === "c" ? "call" : "package", value: inline || value };
}

function execMoves(rest: string[], dirs: string[]): boolean {
  let n = 0;
  while (n < rest.length && rest[n] !== "--" && rest[n]!.startsWith("-")) {
    const a = rest[n]!;
    const ef = execFlag(a);
    if (ef?.kind === "call") return movesRun(ef.value ?? rest[n + 1] ?? "", dirs);
    if (ef?.kind === "package") {
      if (ef.value === undefined) n++;
    } else if (NPM_WORKSPACE_WIDEN.test(a) || (a !== "--yes" && a !== "-y" && a !== "--no" && npmFlagWidens([a], 0))) {
      // exec's own workspace, prefix and unknown flags run the command in another package.
      flagDirs(rest, dirs);
      if (/^--(?:node-options|script-shell|userconfig|globalconfig)/.test(a)) dirs.push(UNSURE);
      return true;
    }
    n++;
  }
  // Without a `--`, npm reads the flags after the command word as its own (`npm exec ./x.js -w sub`).
  if (rest[n] === "--") n++;
  else if (npmFlagWidens(rest, n + 1)) {
    // The flags after the command word are npm's own: a dir flag among them moves the run.
    flagDirs(rest.slice(n + 1), dirs);
    moves(rest.slice(n), dirs);
    return true;
  }
  return n < rest.length && moves(rest.slice(n), dirs);
}

// A body is split into commands outside quotes, at `;`, `&`, `|`, newlines, parentheses and backticks.
// A directory resolved against the directory an earlier `cd` moved to (`cd tools && cd ../docs` is docs).
function joinDir(cwd: string, d: string): string | undefined {
  if (d.startsWith("/") || d.startsWith("~") || d.includes("$")) return undefined;
  const out = cwd ? cwd.split("/") : [];
  if (out.length > 64 || d.length > 4096) return undefined;
  for (const part of d.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (!out.length) return undefined;
      out.pop();
    } else out.push(part);
  }
  return out.join("/");
}

// The shell readers recurse through wrapped commands and substitutions; past this depth they stop and fail closed.
const MOVE_DEPTH = 24;
let moveDepth = 0;
let scanSteps = 0;

function guarded<T>(dirs: string[] | undefined, over: T, f: () => T): T {
  if (moveDepth >= MOVE_DEPTH) {
    dirs?.push(UNSURE);
    return over;
  }
  // One step budget per top-level scan, shared by every nested level.
  if (moveDepth === 0) scanSteps = 0;
  // Every nested scan spends from the same budget; past it the scan is unsure.
  scanSteps += 50;
  if (scanSteps > SUB_STEPS) {
    dirs?.push(UNSURE);
    return over;
  }
  moveDepth++;
  try {
    return f();
  } finally {
    moveDepth--;
  }
}

function moves(argv: string[], dirs: string[]): boolean {
  return guarded(dirs, true, () => movesCore(argv, dirs));
}

function movesRun(body: string, dirs: string[] = []): boolean {
  return guarded(dirs, true, () => movesRunCore(body, dirs));
}

function scriptArgsMove(ctx: Ctx, argv: string[]): boolean {
  // At the depth cap the scan is unsure: the widen reads every file, inert paths included.
  if (moveDepth >= MOVE_DEPTH) {
    ctx.widenInert = true;
    return true;
  }
  return guarded(undefined, true, () => scriptArgsMoveCore(ctx, argv));
}

const CD_WORD = /^(?:cd|pushd)$/;

// A directory a command moves into. A name that holds an expansion, a glob or a brace, or `cd -`, cannot be resolved
// here, so it is recorded as unsure (the widen then reads every file).
function pushDir(dirs: string[], d: string): void {
  // Only plain path characters are taken literally: anything else (`%`, `~`, `>`, quotes, a leading `-`) is unsure.
  dirs.push(/^[A-Za-z0-9._/-]+$/.test(d) && d !== "-" ? d : UNSURE);
}
// The directory of a file that feeds a shell or interpreter: it may sit under test/ or docs/, so its directory is
// read as moved into. A name with characters outside a plain path is unsure.
function fedDir(dirs: string[], f: string, shell = false, cwd = ""): void {
  if (f === "" || f === "-" || f.startsWith("/dev/")) return;
  if (!/^[A-Za-z0-9._/-]+$/.test(f) || f.startsWith("/")) {
    dirs.push(UNSURE);
    return;
  }
  // The file's own directory (so inert paths under it are read), the name itself (it may be a directory), and a
  // marker that the file is read and, when it is a script, run as a body.
  const k = f.lastIndexOf("/");
  if (k > 0) dirs.push(f.slice(0, k));
  // A fed file found through a cd carries that directory: the script runs from there.
  dirs.push(f, (shell ? FEDSH : FED) + f + (cwd ? `\u0003${cwd}` : ""));
}
// A directory-list entry that names a file fed to a shell or interpreter.
const FED = "\u0001";
// The same, for a file fed to a shell: whatever its name, it is a shell body.
const FEDSH = "\u0002";
const isFedMark = (d: string): boolean => d.startsWith(FED) || d.startsWith(FEDSH);

// A directory entry that means the scan was not sure: the widen then reads every file, inert paths included.
const UNSURE = "\u0000";

// The top-level command substitutions of a text, with quotes, escapes and parentheses tracked: `$(...)` up to its
// matching parenthesis, and backtick pairs. Returns null when the scan cannot be sure (an unclosed quote,
// parenthesis or backtick, a `case` inside, nesting deeper than SUB_DEPTH, or more than SUB_STEPS characters read):
// the caller then widens. Each text is read once per level, so the work is bounded.
const SUB_DEPTH = 16;
const SUB_STEPS = 200_000;

function substitutions(body: string): string[] | null {
  // `$'...'` is ANSI-C quoting, where a backslash escapes a quote: not modeled, so unsure.
  if (body.includes("$'")) return null;
  if (!body.includes("$(") && !body.includes("`")) return [];
  const out: string[] = [];
  const tick = (): boolean => ++scanSteps <= SUB_STEPS;
  // Index just past the closing quote of the text opened before `i`, or -1.
  const skipSingle = (t: string, i: number): number => {
    const j = t.indexOf("'", i);
    return j < 0 ? -1 : j + 1;
  };
  const skipBacktick = (t: string, i: number): number => {
    for (let j = i; j < t.length; j++) {
      if (!tick()) return -1;
      // An escaped backtick inside a backtick body opens a nested substitution: not modeled, so unsure.
      if (t[j] === "\\" && t[j + 1] === "`") return -1;
      if (t[j] === "\\") j++;
      else if (t[j] === "`") return j + 1;
    }
    return -1;
  };
  // From just after `$(`: index just past the matching `)`, or -1.
  const parseSub = (t: string, i: number, depth: number): number => {
    if (depth > SUB_DEPTH) return -1;
    let paren = 1;
    for (let j = i; j < t.length; j++) {
      if (!tick()) return -1;
      const c = t[j]!;
      if (c === "\\") j++;
      else if (c === "'") {
        j = skipSingle(t, j + 1) - 1;
        if (j < 0) return -1;
      } else if (c === '"') {
        j = parseDq(t, j + 1, depth) - 1;
        if (j < 0) return -1;
      } else if (c === "`") {
        j = skipBacktick(t, j + 1) - 1;
        if (j < 0) return -1;
      } else if (c === "$" && t[j + 1] === "(") {
        j = parseSub(t, j + 2, depth + 1) - 1;
        if (j < 0) return -1;
      } else if (c === "(") paren++;
      else if (c === ")" && --paren === 0) {
        const inner = t.slice(i, j);
        return /(?:^|[^A-Za-z0-9_])case(?![A-Za-z0-9_])/.test(inner) ? -1 : j + 1;
      }
    }
    return -1;
  };
  // From just after an opening `"`: index just past the closing one, or -1.
  const parseDq = (t: string, i: number, depth: number): number => {
    for (let j = i; j < t.length; j++) {
      if (!tick()) return -1;
      const c = t[j]!;
      if (c === "\\") j++;
      else if (c === '"') return j + 1;
      else if (c === "`") {
        j = skipBacktick(t, j + 1) - 1;
        if (j < 0) return -1;
      } else if (c === "$" && t[j + 1] === "(") {
        j = parseSub(t, j + 2, depth + 1) - 1;
        if (j < 0) return -1;
      }
    }
    return -1;
  };
  let dq = false;
  for (let i = 0; i < body.length; i++) {
    if (!tick()) return null;
    const c = body[i]!;
    if (c === "\\") i++;
    else if (c === "'" && !dq) {
      i = skipSingle(body, i + 1) - 1;
      if (i < 0) return null;
    } else if (c === '"') dq = !dq;
    else if (c === "`") {
      const e = skipBacktick(body, i + 1);
      if (e < 0) return null;
      out.push(body.slice(i + 1, e - 1));
      i = e - 1;
    } else if (c === "$" && body[i + 1] === "(") {
      const e = parseSub(body, i + 2, 1);
      if (e < 0) return null;
      out.push(body.slice(i + 2, e - 1));
      i = e - 1;
    }
  }
  return dq ? null : out;
}

// The words of a command with leading wrappers (env, command, exec, sudo, busybox, xargs and their flags and
// assignments) removed, so the interpreter the line really runs is first.
// A text with `<` and `>` redirects set off as words of their own outside quotes (`sh<x.sh` is `sh < x.sh`),
// a leading file descriptor kept with its operator (`2>&1`).
function spaceRedirects(t: string): string {
  if (!/[<>]/.test(t)) return t;
  let out = "";
  let q = "";
  for (let i = 0; i < t.length; i++) {
    const c = t[i]!;
    if (q) {
      out += c;
      if (c === q) q = "";
      else if (c === "\\" && q === '"' && i + 1 < t.length) out += t[++i]!;
    } else if (c === "\\" && i + 1 < t.length) out += c + t[++i]!;
    else if (c === "'" || c === '"') {
      q = c;
      out += c;
    } else if (c === "<" || c === ">") {
      let op = c;
      while (i + 1 < t.length && /[<>&|]/.test(t[i + 1]!) && !(t[i + 1] === "(" )) op += t[++i]!;
      // A file descriptor number that is a word of its own stays attached to the operator.
      let k = out.length;
      while (k > 0 && out.charCodeAt(k - 1) >= 48 && out.charCodeAt(k - 1) <= 57) k--;
      const fd = k < out.length && (k === 0 || /\s/.test(out[k - 1]!));
      out += (fd ? "" : " ") + op + " ";
    } else out += c;
  }
  return out;
}

function unwrapSink(w0: string[]): { words: string[]; xargs: boolean; lead: string } {
  let w = w0;
  let i = 0;
  let xargs = false;
  for (let guard = 0; i < w.length && guard < 64; guard++) {
    const n = runnerName(w[i]!.replace(/^\\+/, ""));
    if (ASSIGN.test(w[i]!)) i++;
    else if (WRAPPERS.has(n) || n === "busybox") {
      i++;
      while (i < w.length && (w[i]!.startsWith("-") || ASSIGN.test(w[i]!))) {
        // `env -S 'sh -s'` splits its string into the command: the string's words come next.
        const sv = n === "env" ? (w[i] === "-S" || w[i] === "--split-string" ? w[i + 1] : /^-S./.test(w[i]!) ? w[i]!.slice(2) : w[i]!.startsWith("--split-string=") ? w[i]!.slice(15) : undefined) : undefined;
        if (sv !== undefined) {
          const used = w[i] === "-S" || w[i] === "--split-string" ? 2 : 1;
          w = [...words(sv), ...w.slice(i + used)];
          i = 0;
          break;
        }
        i += n === "env" && /^(?:-[uC]|--unset|--chdir)$/.test(w[i]!) ? 2 : 1;
      }
    } else if (n === "sudo" || n === "doas") {
      i++;
      while (i < w.length && w[i]!.startsWith("-")) i += /^-[ughpCDRTU]$/.test(w[i]!) ? 2 : 1;
    } else if (n === "xargs") {
      xargs = true;
      i++;
      while (i < w.length && w[i]!.startsWith("-")) i += /^-[IiLnPsdEaJ]$/.test(w[i]!) ? 2 : 1;
    } else break;
  }
  let ws = w.slice(i);
  const lead = runnerName((ws[0] ?? "").replace(/^\\+/, ""));
  // A wrapper this does not name (nice, timeout, stdbuf, ionice, chrt, setsid, caffeinate, arch, ...) runs the
  // first shell or interpreter word after it: unless the first word is itself one or a known plain command, the
  // sink is read from that word on.
  const first = runnerName((ws[0] ?? "").replace(/^\\+/, ""));
  if (ws.length > 0 && !SINK_WORD.test(first) && !PLAIN_CMDS.has(first)) {
    const at = ws.findIndex((t, q) => q > 0 && SINK_WORD.test(runnerName(t.replace(/^\\+/, ""))));
    if (at > 0) ws = ws.slice(at);
  }
  return { words: ws, xargs, lead };
}
const SHELL_RE = /^(?:sh|bash|zsh|dash|ksh|ash|mksh|yash)$/;
const SINK_WORD = /^(?:sh|bash|zsh|dash|ksh|node|nodejs|python[0-9.]*|perl|ruby|deno|bun|php|ash|mksh|yash)$/;
const PLAIN_CMDS = new Set(["echo", "tee", "tar", "find", "printf", "cat", "grep", "egrep", "fgrep", "rg", "head", "tail", "tr", "ls", "test", "[", "true", "false", ":", "cp", "mv", "rm", "mkdir", "touch", "chmod", "which", "sort", "uniq", "wc", "cut", "diff", "curl", "wget", "less", "more", "jq", "yq", "gzip", "gunzip", "zcat", "bzip2", "xz", "xxd", "od", "hexdump", "openssl", "shasum", "sha256sum", "sha1sum", "md5", "md5sum", "cksum", "fold", "nl", "rev", "paste", "comm", "join", "column", "cmp", "sleep", "date", "pwd", "wait", "read", "tput", "stat", "file", "du", "df", "ps", "unzip", "zip", "strings", "tac", "expand", "unexpand", "split", "mktemp", "basename", "dirname", "realpath", "readlink", "ln"]);

// Interpreters that read their program from stdin when given no script operand: the flags that carry a program
// (`-e`), and the flags that take a separate value.
const STDIN_INTERPS: Record<string, { code: RegExp; value: RegExp }> = {
  node: { code: /^(?:-[A-Za-z]*[ep][A-Za-z]*|--eval|--print)(?:=|$)/, value: /^(?:-r|--require|--import|--loader|--experimental-loader|--input-type|-C|--conditions)$/ },
  python: { code: /^(?:-[A-Za-z]*[cm][A-Za-z]*)$/, value: /^(?:-W|-X|--check-hash-based-pycs)$/ },
  perl: { code: /^-[A-Za-z0-9]*[eE][A-Za-z0-9]*$/, value: /^(?:-I|-M|-m|-C)$/ },
  ruby: { code: /^-[A-Za-z0-9]*e[A-Za-z0-9]*$/, value: /^(?:-I|-r|-C|-E|-x)$/ },
  deno: { code: /^$/, value: /^(?:--config|-c|--import-map|--reload|--lock|--cert|--location|--seed|--v8-flags)$/ },
  php: { code: /^-[A-Za-z]*[rR]$/, value: /^(?:-d|-c|-z|-n|-f)$/ },
  bun: { code: /^(?:-e|--eval|-p|--print)(?:=|$)/, value: /^(?:--cwd|--config|-c|--preload|-r|--define|-d|--tsconfig-override|--env-file)$/ },
};

// Whether an interpreter other than a shell reads its program from stdin: no program flag, and no script
// operand (or `-`). `deno` and `bun` read `run` as a subcommand; `deno eval` and other subcommands are not.
// Wrappers that run the command after their own options and operands: the options that take a value, and how many
// operands precede the command (`timeout 300 npm run setup`).
const WRAPPER_SPEC: Record<string, { value: RegExp; operands: number }> = {
  nice: { value: /^(?:-n|--adjustment)$/, operands: 0 },
  ionice: { value: /^-[cnpP]$/, operands: 0 },
  timeout: { value: /^(?:-[sk]|--signal|--kill-after)$/, operands: 1 },
  stdbuf: { value: /^-[ioe]$/, operands: 0 },
  setsid: { value: /^$/, operands: 0 },
  caffeinate: { value: /^-[tw]$/, operands: 0 },
  chrt: { value: /^$/, operands: 1 },
  arch: { value: /^$/, operands: 0 },
  exec: { value: /^-a$/, operands: 0 },
  unbuffer: { value: /^$/, operands: 0 },
  taskset: { value: /^-c$/, operands: 1 },
  flock: { value: /^-[wE]$|^--(?:timeout|conflict-exit-code)$/, operands: 1 },
  numactl: { value: /^$/, operands: 0 },
};

// The command a wrapper from WRAPPER_SPEC runs, or undefined when the first word is not one.
function stripWrapper(w: string[]): string[] | undefined {
  const spec = WRAPPER_SPEC[runnerName((w[0] ?? "").replace(/^\\+/, ""))];
  if (!spec) return undefined;
  let i = 1;
  let operands = spec.operands;
  while (i < w.length && w[i]!.startsWith("-") && w[i] !== "--") {
    // taskset -c LIST names the CPUs by option, so no mask operand follows.
    if (w[i] === "-c" && runnerName(w[0]!) === "taskset") operands = 0;
    i += spec.value.test(w[i]!) ? 2 : 1;
  }
  if (w[i] === "--") i++;
  return w.slice(Math.min(w.length, i + operands));
}

const STDIN_PATH = /^(?:\/dev\/stdin|\/dev\/fd\/\d+|\/proc\/self\/fd\/0|php:\/\/stdin)$/;

function interpReadsStdin(bin: string, w: string[]): boolean {
  const key = /^(?:node|nodejs)$/.test(bin) ? "node" : /^python[0-9.]*$/.test(bin) ? "python" : bin;
  const spec = STDIN_INTERPS[key];
  if (!spec) return false;
  const args = w.slice(1);
  let start = 0;
  if ((key === "deno" || key === "bun") && args[0] === "run") start = 1;
  else if (key === "deno" && args[0] !== undefined && !args[0].startsWith("-") && args[0] !== "-") return false;
  // An unknown `--long` flag with no `=` may take the next word as its value or not: either reading that ends at
  // stdin counts (`node --stack-size 100` reads stdin, `node --foo x.js` may not).
  // A very long flag list is read as stdin (fail closed) rather than recursed through.
  if (args.length > 2000) return true;
  const memo = new Map<number, boolean>();
  const scan = (j0: number): boolean => {
    const hit = memo.get(j0);
    if (hit !== undefined) return hit;
    const r = scanFrom(j0);
    memo.set(j0, r);
    return r;
  };
  const scanFrom = (j: number): boolean => {
    for (; j < args.length; j++) {
      const t = args[j]!;
      if (t === "-") return true;
      if (t === "--") return args[j + 1] === "-" || args[j + 1] === undefined || STDIN_PATH.test(args[j + 1]!);
      if (spec.code.test(t)) return false;
      if (spec.value.test(t)) {
        if (args[j + 1] !== undefined && STDIN_PATH.test(args[j + 1]!)) return true;
        j++;
        continue;
      }
      if (t.startsWith("--") && !t.includes("=") && j + 1 < args.length && !args[j + 1]!.startsWith("-")) return scan(j + 2) || scan(j + 1);
      if (t.startsWith("-")) continue;
      return STDIN_PATH.test(t);
    }
    return true;
  };
  return scan(start);
}

// Files a program text names in quotes (`require('./test/x.js')`, `open("test/x.py")`): fed text for an interpreter is
// not shell, so its string literals are the paths it can load. An expansion in it is unsure.
function textRefs(text: string, dirs: string[]): void {
  if (/[$`]/.test(text)) dirs.push(UNSURE);
  for (const m of text.matchAll(/['"]([^'"\s]{1,512})['"]/g)) {
    const f = m[1]!;
    if (/^[A-Za-z0-9._/-]+$/.test(f) && /[./]/.test(f) && f !== "." && f !== "..") fedDir(dirs, f.replace(/^(?:\.\/)+/, ""));
  }
  for (const m of text.matchAll(/(?:^|[\s(=])(\.{0,2}\/[A-Za-z0-9._/-]+)/g)) fedDir(dirs, m[1]!.replace(/^(?:\.\/)+/, ""));
}

// Files a shell or interpreter loads through flags (`node -r ./x.js`, `python3 -m test.x`, `php -f x.php`,
// `ruby -x x.rb`, `deno run --reload x.ts`), in an unsplit body too. A flag value that is a plain path is read.
function flagFiles(bin: string, w: string[]): string[] {
  const key = /^(?:node|nodejs)$/.test(bin) ? "node" : /^python[0-9.]*$/.test(bin) ? "python" : bin;
  const spec = STDIN_INTERPS[key];
  if (!spec) return [];
  const args = w.slice(1);
  const out: string[] = [];
  for (let j = 0; j < args.length; j++) {
    const t = args[j]!;
    if (t === "--") break;
    const eq = t.indexOf("=");
    const name = eq > 0 ? t.slice(0, eq) : t;
    if (key === "python" && /^-[A-Za-z]*m$/.test(t) && args[j + 1]) {
      const mod = args[j + 1]!.replace(/\./g, "/");
      out.push(`${mod}.py`, `${mod}/__main__.py`);
      j++;
    } else if (spec.value.test(name)) {
      const v = eq > 0 ? t.slice(eq + 1) : args[j + 1];
      if (v) out.push(v);
      if (eq < 0) j++;
    } else if (/^-[A-Za-z]*[rIM]./.test(t) && key !== "python" && !t.startsWith("--")) {
      // joined short value (`-r./x.js`)
      out.push(t.replace(/^-[A-Za-z]*?[rIM]/, ""));
    }
  }
  return out;
}

// The script file a shell or interpreter is given (`sh test/x.sh`, `node ./a.js`), or undefined when it runs a program
// from a flag (`-c`, `-e`) or reads stdin.
function scriptOperand(bin: string, w: string[]): string | undefined {
  const args = w.slice(1);
  if (SHELL_RE.test(bin)) {
    for (let j = 0; j < args.length; j++) {
      const t = args[j]!;
      if (t === "--") return args[j + 1];
      if (t === "--rcfile" || t === "--init-file") {
        j++;
        continue;
      }
      if (t.startsWith("--")) continue;
      if (t.startsWith("-") || t.startsWith("+")) {
        if (/^-[A-Za-z]*c[A-Za-z]*$/.test(t)) return undefined;
        if (/[oO]/.test(t)) j += (t.match(/[oO]/g) ?? []).length;
        continue;
      }
      return t;
    }
    return undefined;
  }
  const key = /^(?:node|nodejs)$/.test(bin) ? "node" : /^python[0-9.]*$/.test(bin) ? "python" : bin;
  const spec = STDIN_INTERPS[key];
  if (!spec) return undefined;
  let j = (key === "deno" || key === "bun") && args[0] === "run" ? 1 : 0;
  for (; j < args.length; j++) {
    const t = args[j]!;
    if (t === "--") return args[j + 1];
    if (spec.code.test(t)) return undefined;
    if (spec.value.test(t)) {
      j++;
      continue;
    }
    if (t.startsWith("-")) continue;
    return t;
  }
  return undefined;
}

// A program text that reads stdin itself.
const STDIN_CODE = /readFileSync\s*\(\s*(?:0\b|['"]\/dev\/stdin)|\/dev\/stdin|\/dev\/fd\/\d|process\.stdin|sys\.stdin|\bSTDIN\b|\$stdin|<&0|\bfileinput\b|\bgets\b|\bread\s+-r?\s*\w/;

// Flags of otherwise plain commands that run a program.
const RUNS_PROGRAM: Record<string, RegExp> = {
  tar: /^(?:--(?:to-command|use-compress-program|checkpoint-action|rsh-command|info-script)(?:=.*)?|-[A-Za-z]*[IF].*|--new-volume-script(?:=.*)?)$/,
  zip: /^(?:-TT|--unzip-command(?:=.*)?)$/,
  // node --test runs every test file by default glob, under any test directory.
  node: /^--test$/,
  nodejs: /^--test$/,
  split: /^--filter(?:=.*)?$/,
  sort: /^--compress-program(?:=.*)?$/,
  rg: /^--pre(?:=.*)?$/,
  find: /^-(?:exec|execdir|ok|okdir)$/,
  git: /^(?:--upload-pack|--receive-pack|--exec-path)(?:=.*)?$|^(?:-c)?core\.(?:hooksPath|sshCommand|pager|editor|fsmonitor|askPass)|^(?:alias|credential|diff|merge|filter|gpg)\.\S*(?:=|$)|^-c.*(?:hooksPath|sshCommand|pager|editor|fsmonitor)/,
  less: /^--lesskey-src(?:=.*)?$/,
  rsync: /^(?:-[A-Za-z]*e.*|--rsh(?:=.*)?|--rsync-path(?:=.*)?)$/,
};

// Whether a shell command reads its script from stdin: no -c, and either -s, /dev/stdin, `-`, or no script file.
function readsStdin(bin: string, w: string[]): boolean {
  if (!SHELL_RE.test(bin)) return false;
  const args = w.slice(1);
  let sFlag = false;
  // Options end at `--` or the first operand; what follows is the script file and its arguments, not options.
  for (let j = 0; j < args.length; j++) {
    const t = args[j]!;
    if (t === "--") return sFlag || args[j + 1] === undefined || STDIN_PATH.test(args[j + 1]!);
    if (t === "-") return true;
    if (t === "--rcfile" || t === "--init-file") {
      j++;
      continue;
    }
    if (t.startsWith("--")) continue;
    if (t.startsWith("-") || t.startsWith("+")) {
      if (/^-[A-Za-z]*c[A-Za-z]*$/.test(t)) return false;
      if (/^-[A-Za-z]*s[A-Za-z]*$/.test(t)) sFlag = true;
      // -o / +o / -O take an option name, anywhere in the cluster.
      if (/[oO]/.test(t)) j += (t.match(/[oO]/g) ?? []).length;
      continue;
    }
    return sFlag || STDIN_PATH.test(t);
  }
  return true;
}

// A body with its terminated heredoc bodies cut out, and those bodies keyed by the offset of the end of the line that
// opened them. A heredoc with no terminator, or past the cap, is left in place and the result is unsure.
function stripHeredocs(body: string): { text: string; docs: Map<number, string[]>; unsure: boolean } {
  const docs = new Map<number, string[]>();
  if (!/<<(?!<)/.test(body)) return { text: body, docs, unsure: false };
  const lines = body.split("\n");
  const out: string[] = [];
  let pos = 0;
  let count = 0;
  let unsure = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    out.push(line);
    let marks = [...line.matchAll(/(?<!<)<<(?!<)(-?)\s*(['"]?)([A-Za-z0-9_]+)\2/g)];
    // A mark after `((` is an arithmetic shift (`$((1 << A))`), not a heredoc: left in place and unsure.
    const arith = line.indexOf("((");
    if (marks.length > 0 && arith >= 0 && marks.some((m) => m.index > arith)) {
      unsure = true;
      marks = [];
    }
    if (marks.length > 0) {
      let j = i + 1;
      const bodies: string[] = [];
      let ok = true;
      for (const m of marks) {
        if (++count > 32) {
          ok = false;
          break;
        }
        const text: string[] = [];
        let found = false;
        for (; j < lines.length; j++) {
          const t = m[1] ? lines[j]!.replace(/^\t+/, "") : lines[j]!;
          if (t.trimEnd() === m[3]) {
            found = true;
            j++;
            break;
          }
          text.push(lines[j]!);
        }
        if (!found) {
          ok = false;
          break;
        }
        bodies.push(text.join("\n"));
      }
      if (ok) {
        docs.set(pos + line.length, bodies);
        i = j - 1;
      } else unsure = true;
    }
    pos += line.length + 1;
  }
  return { text: out.join("\n"), docs, unsure };
}

function movesRunCore(body: string, dirs: string[] = []): boolean {
  let hit = false;
  let cwd = "";
  // A fed or operand path is read as written and joined with the directory an earlier cd moved to.
  // A fed file is a shell body unless the consumer is a known interpreter that is not a shell.
  let fedShell = true;
  const fedBoth = (f: string): void => {
    fedDir(dirs, f, fedShell);
    if (cwd && f && !f.startsWith("/") && !f.startsWith("-")) {
      const j = joinDir(cwd, f);
      if (j === undefined) dirs.push(UNSURE);
      else fedDir(dirs, j, fedShell, cwd);
    }
  };
  // A body this large is not read command by command: every file is read.
  if (body.length > 200_000) {
    dirs.push(UNSURE);
    return true;
  }
  // Terminated heredoc bodies are cut out before the text is split into commands, and read by their command.
  const hd = stripHeredocs(body);
  body = hd.text;
  if (hd.unsure) dirs.push(UNSURE);
  let pipeText: string | undefined;
  let fedHit = false;
  let prev: string | undefined;
  let prevArgs: string[] = [];
  // A command substitution inside text (`echo "$(cd test && node setup.js)"`, backticks) runs its content.
  const subs = substitutions(body);
  if (subs === null) {
    // The scan cannot be sure: fail closed, and read every file (test and docs too).
    dirs.push(UNSURE);
    return true;
  }
  for (const inner of subs) if (movesRun(inner, dirs)) hit = true;
  let pos = 0;
  let pipeFiles: string[] = [];
  // Files a command wrote (`> build.js`, `tee build.js`) with the files that fed that stage, so a later command that
  // runs the written file reads the sources.
  const written = new Map<string, string[]>();
  // Heredoc text written to a file (`cat <<EOF > r.sh`), run later by name.
  const writtenText = new Map<string, string>();
  // Sources of commands that create files at names this scan does not follow (tar x, unzip, patch, git apply, cp into
  // a directory): a later shell or interpreter, or a path as the command, reads them.
  let produced: string[] = [];
  // An output process substitution (`cat test/x.sh > >(sh)`) is a consumer whose feed this scan does not follow.
  if (/>\(/.test(body)) {
    hit = true;
    dirs.push(UNSURE);
  }
  // A process substitution (`sh <(cat test/x.sh)`) feeds a command from a file: the files it names are read.
  for (const m of body.matchAll(/<\(([^)]*)\)/g)) {
    hit = true;
    // The command word counts when it is itself a path (`<(./test/gen.sh)`).
    words(m[1]!).forEach((t, q) => {
      if (!t.startsWith("-") && (q > 0 || t.includes("/"))) fedBoth(t);
    });
  }
  // A file sourced anywhere in the text, inside a quoted eval or sh -c string included, runs in this shell and may
  // sit under test/ or docs/: its directory is read.
  for (const m of body.matchAll(/(?:^|[\s;&|({'"`])(?:source|\.)\s+['"]?([^\s;&|)'"`]+)/g)) {
    hit = true;
    fedBoth(m[1]!);
  }
  for (const seg of shellSegments(body)) {
    // Whether a single `|` joins this command to the one before it.
    const at = body.indexOf(seg, pos);
    const piped = at < 0 || /(?:^|[^|])\|(?!\|)/.test(body.slice(pos, at));
    if (at >= 0) pos = at + seg.length;
    // Redirects are set off as words (`sh<x.sh`) and their operands are not arguments: `node < x.js` has none.
    const raw = words(spaceRedirects(seg));
    const noRedir: string[] = [];
    for (let q = 0; q < raw.length; q++) {
      if (/^\d*[<>]/.test(raw[q]!)) {
        if (/^\d*(?:<{1,3}-?|>>?|<>|[<>]&|>\|)$/.test(raw[q]!)) q++;
      } else noRedir.push(raw[q]!);
    }
    const w = noRedir;
    // Every file named anywhere in a pipeline: arguments and `<` operands of each stage.
    // A lone closing word (`}`, `fi`, `done`) between a group and its pipe does not end the pipeline.
    if (!piped && !/^(?:\}|fi|done|esac)$/.test(seg)) {
      pipeFiles = [];
      pipeText = undefined;
    }
    for (let q = 0; q < raw.length; q++) {
      const m = /^\d*<(?!<)(.*)$/.exec(raw[q]!);
      if (m) pipeFiles.push(m[1] || raw[q + 1] || "");
    }
    // The arguments of a network tool are addresses, not files.
    if (!/^(?:curl|wget|nc|ssh|scp|rsync|ftp|sftp|http|https)$/.test(runnerName((w[0] ?? "").replace(/^\\+/, "")))) for (const t of w.slice(1)) if (!t.startsWith("-")) pipeFiles.push(t);
    const local: string[] = [];
    if (moves(w, local)) hit = true;
    // Both the raw and the joined directory are recorded: the base may be wrong across a subshell or a popd.
    // Bounded: a body with hundreds of directory changes reads every file.
    if (dirs.length > 512 || cwd.split("/").length >= 64) {
      dirs.push(UNSURE);
      return true;
    }
    for (const d of local) {
      if (d === UNSURE || isFedMark(d)) dirs.push(d);
      else {
        const j = joinDir(cwd, d);
        if (j === undefined) dirs.push(UNSURE);
        else dirs.push(d, j);
      }
    }
    const first = w.find((t) => !/^(?:!|then|do|else|elif|if|while|until|\{|command|builtin)$/.test(t));
    if (first && CD_WORD.test(runnerName(first.replace(/^\\+/, ""))) && local[0] !== undefined) cwd = joinDir(cwd, local[0]) ?? cwd;
    // A shell that reads its script from a pipe (`echo 'cd sub && npm run build' | sh`) runs the producer's text.
    const b = runnerName((w[0] ?? "").replace(/^\\+/, ""));
    const un = unwrapSink(noRedir);
    const sb = runnerName((un.words[0] ?? "").replace(/^\\+/, ""));
    const isShell = SHELL_RE.test(sb);
    // Input of xargs is arguments (a list of files), not commands.
    fedShell = (isShell || !SINK_WORD.test(sb)) && !un.xargs;
    // `... | xargs bash -c` runs the piped text as the command string.
    const bare =
      readsStdin(sb, un.words) ||
      interpReadsStdin(sb, un.words) ||
      (un.xargs && isShell && un.words.slice(1).some((t) => /^-[A-Za-z]*c[A-Za-z]*$/.test(t)));
    // A program text that reads stdin itself (`node -e "eval(require('fs').readFileSync(0,'utf8'))"`) is a sink.
    const codeStdin = SINK_WORD.test(sb) && !bare && un.words.slice(1).some((t) => STDIN_CODE.test(t));
    if (codeStdin && prev !== undefined && !/^(?:echo|printf)$/.test(prev)) {
      hit = true;
      for (const t of pipeFiles) fedBoth(t);
    }
    // A script run by its path (`./scripts/setup.sh > /dev/null`) is run by whatever its first line names: read as a body.
    const head = un.words[0] ?? "";
    if (/^(?:\.\.?\/|[A-Za-z0-9_-][A-Za-z0-9_.-]*\/)/.test(head) && !SINK_WORD.test(sb) && !PLAIN_CMDS.has(sb)) fedBoth(head);
    // A shell or interpreter given a script file runs it, whether or not the body was split into commands.
    if (SINK_WORD.test(sb) && !bare) {
      const operand = scriptOperand(sb, un.words);
      if (operand) fedBoth(operand);
    }
    if (bare && fedHit) hit = true;
    // A shell fed from a file (`sh < x.sh`) or by a producer that is not echo or printf with literal words
    // (`cat x.sh | sh`, `echo "$X" | sh`, `... | base64 -d | sh`) runs text that is not read here: widen.
    // The fed file may itself sit under test/ or docs/, so the scan is unsure and reads inert paths too.
    const redirSink = isShell || interpReadsStdin(sb, un.words) || (sb !== "" && !PLAIN_CMDS.has(sb) && !SINK_WORD.test(sb) && !RUNNERS.has(sb) && !CD_WORD.test(sb));
    if (redirSink && /<(?!<)/.test(seg)) {
      hit = true;
      for (let q = 0; q < raw.length; q++) {
        const m = /^\d*<(?!<)(.*)$/.exec(raw[q]!);
        if (m) fedBoth(m[1] || raw[q + 1] || "");
      }
    }
    // A pipe whose producer is not literal text feeds any consumer that is not a known plain command (`ash`,
    // `tsx`, `lua -`, `tclsh`, `env -S 'sh -s'`): the consumer is treated as a sink instead of being named.
    const consumer = un.lead;
    const classSink = piped && prev !== undefined && !/^(?:echo|printf)$/.test(prev) && !bare && (un.words.length === 0 ? noRedir.length > 0 : !PLAIN_CMDS.has(consumer) && !(SINK_WORD.test(consumer) && un.words[0] !== undefined && runnerName(un.words[0]) === consumer));
    if ((bare || classSink) && pipeText !== undefined) {
      // The literal text a producer stage got from a here-string runs in the consumer.
      hit = true;
      if (isShell || !SINK_WORD.test(sb)) {
        if (movesRun(pipeText, dirs)) hit = true;
      } else textRefs(pipeText, dirs);
    }
    if ((bare || classSink) && prev !== undefined) {
      if (!/^(?:echo|printf)$/.test(prev) || prevArgs.some((t) => /[$`]/.test(t))) {
        hit = true;
        if (/^(?:echo|printf)$/.test(prev)) dirs.push(UNSURE);
        else for (const t of pipeFiles) fedBoth(t);
      }
    }
    // A here-string hands its text to the consumer: a shell or interpreter runs it, so its text is read as a command line.
    for (let q = 0; q < raw.length; q++) {
      const m = /^\d*<<<(.*)$/.exec(raw[q]!);
      if (!m) continue;
      const text = m[1] || raw[q + 1] || "";
      // A here-string with an expansion on a stage that pipes on (`cat <<< "$(cat test/x.sh)" | sh`) is unsure.
      if (!redirSink) {
        if (/[$`]/.test(text) && at >= 0 && /^\s*\|(?!\|)/.test(body.slice(at + seg.length))) dirs.push(UNSURE);
        else pipeText = text;
        continue;
      }
      hit = true;
      if (!text || /[$`]/.test(text)) dirs.push(UNSURE);
      else if (isShell || !SINK_WORD.test(sb)) {
        if (movesRun(text, dirs)) hit = true;
      } else textRefs(text, dirs);
    }
    // Literal text piped into an interpreter that is not a shell is program text, not commands.
    if (bare && !isShell && SINK_WORD.test(sb) && prev !== undefined && /^(?:echo|printf)$/.test(prev)) {
      hit = true;
      textRefs(prevArgs.join(" "), dirs);
    }
    // Heredocs opened on this stage take their bodies in order (their text was cut out above). A body fed to a shell is
    // commands, to an interpreter program text; on a producer stage it flows on to the next stage or into a written file.
    let docText: string | undefined;
    const marks = (seg.match(/(?<!<)<<(?!<)/g) ?? []).length;
    if (marks > 0) {
      const le = at >= 0 ? body.indexOf("\n", at) : -1;
      const own = hd.docs.get(le < 0 ? body.length : le)?.splice(0, marks) ?? [];
      if (own.length < marks) dirs.push(UNSURE);
      else docText = own[own.length - 1];
    }
    if (docText !== undefined) {
      if (SINK_WORD.test(sb)) {
        hit = true;
        if (isShell) {
          if (movesRun(docText, dirs)) hit = true;
        } else textRefs(docText, dirs);
      } else pipeText = docText;
    }
    // Flags that load a file, and the script operand, in an unsplit body.
    if (SINK_WORD.test(sb)) for (const f of flagFiles(sb, un.words)) fedBoth(f.replace(/^(?:\.\/)+/, ""));
    // xargs turns its input lines into the arguments of a shell or interpreter (`echo test/x.sh | xargs sh`).
    if (un.xargs && SINK_WORD.test(sb)) {
      hit = true;
      if (prev === undefined) dirs.push(UNSURE);
      else if (/^(?:echo|printf)$/.test(prev) && !prevArgs.some((t) => /[$`]/.test(t))) for (const t of prevArgs) if (!t.startsWith("-")) fedBoth(t);
      else if (/^(?:echo|printf)$/.test(prev)) dirs.push(UNSURE);
      else for (const t of pipeFiles) fedBoth(t);
    }
    // find -exec, tar --to-command and a shell's --rcfile run a file or a program named by their arguments.
    const rp = RUNS_PROGRAM[un.lead];
    if (rp && w.some((t) => rp.test(t))) {
      hit = true;
      dirs.push(UNSURE);
    }
    if (isShell) {
      for (let q = 1; q < un.words.length; q++) {
        const t = un.words[q]!;
        if (t === "--rcfile" || t === "--init-file") fedBoth(un.words[q + 1] ?? "");
        else if (/^--(?:rcfile|init-file)=/.test(t)) fedBoth(t.slice(t.indexOf("=") + 1));
        else continue;
        hit = true;
      }
    }
    if (produced.length > 0 && (SINK_WORD.test(un.lead) || /^\.{0,2}\//.test(un.lead) || un.lead === "." || un.lead === "source")) {
      // The sources are read as files (not a widen): what they create is not followed.
      for (const f of produced) fedBoth(f.replace(/^(?:\.\/)+/, ""));
    }
    // A command that runs a file an earlier stage wrote reads the files that fed that stage.
    if (written.size > 0 && !PLAIN_CMDS.has(un.lead)) {
      for (const t of w) {
        const key = t.replace(/^(?:\.\/)+/, "");
        const tx = writtenText.get(key);
        if (tx !== undefined) {
          hit = true;
          if (movesRun(tx, dirs)) hit = true;
        }
        const src = written.get(key);
        if (!src) continue;
        hit = true;
        for (const f of src) fedBoth(f);
      }
    }
    for (let q = 0; q < raw.length; q++) {
      const m = /^\d*>>?\|?(?!&)(.*)$/.exec(raw[q]!);
      const name = m ? m[1] || raw[q + 1] || "" : "";
      if (name && !name.startsWith("/dev/")) {
        written.set(name.replace(/^(?:\.\/)+/, ""), pipeFiles.slice());
        if (docText !== undefined) writtenText.set(name.replace(/^(?:\.\/)+/, ""), docText);
        else if (pipeText !== undefined) writtenText.set(name.replace(/^(?:\.\/)+/, ""), pipeText);
      }
    }
    if (un.lead === "tee") {
      for (const t of w.slice(1)) {
        if (t.startsWith("-")) continue;
        written.set(t.replace(/^(?:\.\/)+/, ""), pipeFiles.slice());
        const tx = docText ?? pipeText;
        if (tx !== undefined) writtenText.set(t.replace(/^(?:\.\/)+/, ""), tx);
      }
    }
    {
      const args = w.slice(1);
      const t = un.lead;
      const extracts = (t === "tar" && (args.some((x) => /^-[A-Za-z]*x|^--(?:extract|get)$/.test(x) || x === "x") || /^[A-Za-z]*x[A-Za-z]*$/.test(args[0] ?? ""))) || /^(?:unzip|7z|7za|unrar|gunzip|bunzip2|unxz|cpio)$/.test(t) || t === "patch" || (t === "git" && args.some((x) => /^(?:apply|am|checkout|restore|stash|merge|cherry-pick|rebase|pull)$/.test(x)));
      if (extracts || /^(?:cp|mv|ln|install|rsync|ditto)$/.test(t)) {
        // Every non-flag operand counts (a destination or an option value is read as a file and found missing).
        for (const x of args) if (!x.startsWith("-")) produced.push(x);
        // patch -i FILE, git apply FILE, tar -xf FILE: the operands include the fed file.
        for (const x of raw) {
          const m = /^\d*<(?!<)(.*)$/.exec(x);
          if (m && m[1]) produced.push(m[1]);
        }
        if (produced.length > 64) {
          dirs.push(UNSURE);
          produced = produced.slice(0, 64);
        }
      }
    }
    // cp, mv and ln make the destination a copy of the sources.
    if (/^(?:cp|mv|ln|install|rsync)$/.test(un.lead)) {
      const args = w.slice(1).filter((t) => !t.startsWith("-"));
      if (args.length >= 2) {
        const dst = args[args.length - 1]!.replace(/^(?:\.\/)+/, "");
        written.set(dst, args.slice(0, -1));
      }
    }
    prev = b;
    prevArgs = w.slice(1);
    // The producer's words read as one command line (`echo cd test \; node setup.js | sh`).
    if (/^(?:echo|printf)$/.test(b) && movesRun(prevArgs.join(" "), dirs)) fedHit = true;
    for (const t of w.slice(1)) if (/\s/.test(t) && movesRun(t, dirs)) fedHit = true;
  }
  return hit;
}

// Extra arguments given to a package script reach the commands in its body: `npm run go -- -w sub` with
// `go: "npm run build"` runs `npm run build -w sub`. When the body names a runner or workspace tool, widen.
function scriptArgsMoveCore(ctx: Ctx, argv: string[]): boolean {
  const k = argv.findIndex((a) => RUNNERS.has(runnerName(a.replace(/^\\+/, ""))));
  if (k < 0) return false;
  const bin = runnerName(argv[k]!.replace(/^\\+/, ""));
  if (bin === "npx" || bin === "bunx" || bin === "corepack") {
    let n = k + 1;
    while (n < argv.length && argv[n]!.startsWith("-")) n++;
    return n < argv.length && scriptArgsMove(ctx, argv.slice(n));
  }
  const rest = argv.slice(k + 1).filter((a) => !BOOL_FLAGS.has(a));
  let n = rest.findIndex((a) => !a.startsWith("-"));
  if (n < 0) return false;
  if (RUN_SUB.has(rest[n]!) || (bin !== "npm" && rest[n] === "run")) n = rest.findIndex((a, j) => j > n && !a.startsWith("-"));
  const name = n >= 0 ? rest[n]! : "";
  const body = ctx.raw[["test", "t", "tst"].includes(name) && bin === "npm" ? "test" : name];
  if (typeof body !== "string" || rest.length <= n + 1) return false;
  return /(?:^|[\s;&|(`'"])(?:npm|pnpm|yarn|yarnpkg|pnpx|bun|bunx|npx|corepack|lerna|turbo|nx|rush|wsrun|cd|pushd|popd|sh|bash|zsh|dash|ksh|eval)(?![A-Za-z0-9_-])/.test(body);
}

// A named script runs; with --ignore-scripts its pre and post scripts do not.
function runNamed(ctx: Ctx, name: string, ignoring: boolean): void {
  const saved = ctx.ignoreHooks;
  ctx.ignoreHooks = ignoring;
  runScript(ctx, name, false);
  ctx.ignoreHooks = saved;
}

function dispatch(ctx: Ctx, cmd: string): void {
  if (ctx.hold) return;
  const argv = words(cmd);
  let i = 0;
  if (i < argv.length && ASSIGN.test(argv[i]!)) {
    // An assignment such as npm_config_workspace=sub or npm_config_prefix=sub moves the run to another package.
    // Every leading assignment is checked, not only the first.
    let j = 0;
    let ignoring: boolean | undefined;
    while (j < argv.length && ASSIGN.test(argv[j]!)) {
      if (IGNORE_ENV_ON.test(argv[j]!)) ignoring = true;
      else if (IGNORE_ENV_OFF.test(argv[j]!)) ignoring = false;
      // CDPATH changes where a later cd lands: read every file.
      if (UNSAFE_ENV.test(argv[j]!)) {
        ctx.widenInert = true;
        widenAll(ctx);
      }
      if (NODE_OPTS.test(argv[j]!)) ctx.widenInert = true;
      if (SPECIAL_ENV.test(argv[j]!)) widenAll(ctx);
      j++;
    }
    // The command after the assignments is read exactly as without them (cd, workspace flags, runners).
    if (j < argv.length) {
      const savedIgnore = ctx.ignoreHooks;
      if (ignoring !== undefined && !ctx.noEnvIgnore && binName(argv[j]!) === "npm") ctx.ignoreHooks = ignoring;
      dispatch(ctx, argv.slice(j).map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(" "));
      ctx.ignoreHooks = savedIgnore;
    }
    if (!ctx.hold) fail(ctx, "unresolved: env");
    return;
  }
  // `\cd`, `command cd` and `builtin cd` are the plain command.
  while (i < argv.length && (/^(?:command|builtin)$/.test(argv[i]!) || argv[i]!.startsWith("\\"))) {
    if (argv[i]!.startsWith("\\")) argv[i] = argv[i]!.slice(1);
    else i++;
  }
  // A compound command's keywords (`if`, `then`, `do`, `fi` ...) are not commands: the command after one is read, and a bare
  // closing keyword runs nothing. Without this each of them was an unknown runner that widened and, with `[ -f x ]`
  // after `if`, held on the glob cap whatever changed.
  while (i < argv.length && /^(?:if|then|elif|else|do|while|until|!|\{)$/.test(argv[i]!)) i++;
  if (i >= argv.length || /^(?:fi|done|esac|\})$/.test(argv[i]!)) return;
  if (argv[i] === "[" || argv[i] === "test") return; // the test builtin runs nothing
  if (/^(?:export|declare|typeset|local|readonly)$/.test(argv[i]!)) {
    // An assignment builtin runs nothing: only the variables that change how a later command runs matter.
    for (let j = i + 1; j < argv.length; j++) {
      const a = argv[j]!.includes("=") ? argv[j]! : argv[j]! + "="; // `export LD_PRELOAD` marks an earlier assignment for export: the same name
      if (UNSAFE_ENV.test(a)) {
        ctx.widenInert = true;
        widenAll(ctx);
      }
      if (NODE_OPTS.test(a)) ctx.widenInert = true;
      if (SPECIAL_ENV.test(a)) widenAll(ctx);
    }
    return;
  }
  // One structural check on every command: a move or a script argument that may carry one widens first.
  const moved: string[] = [];
  // Once the scan was unsure the widen already reads everything: later commands need not be rescanned.
  if (!ctx.widenInert && (moves(argv, moved) || scriptArgsMove(ctx, argv))) {
    if (ctx.movedDirs.size >= 256 || ctx.cwd.split("/").length >= 64) ctx.widenInert = true;
    for (const d of moved) {
      if (d === UNSURE) {
        ctx.widenInert = true;
        continue;
      }
      if (isFedMark(d)) {
        readFed(ctx, d.slice(1), d.startsWith(FEDSH));
        continue;
      }
      const jr = joinDir(ctx.cwd, d);
      if (jr === undefined) ctx.widenInert = true;
      const r = jr ?? d;
      const n = normalize(r);
      const raw = normalize(d);
      if (raw) ctx.movedDirs.add(raw);
      if (n) ctx.movedDirs.add(n);
      if (CD_WORD.test(runnerName(argv.find((t) => !/^(?:!|then|do|else|elif|if|while|until|\{|command|builtin)$/.test(t))?.replace(/^\\+/, "") ?? ""))) ctx.cwd = n;
    }
    widenAll(ctx);
  }
  if (argv.some((a) => RUNNERS.has(runnerName(a)))) ctx.sawRunner = true;
  const bin = binName(argv[i]!);
  // An unresolved command word may be any runner: every file is read, docs and tests included.
  if (bin.includes(UNRESOLVED) && !argv[i]!.includes("/")) {
    ctx.widenInert = true;
    widenAll(ctx);
  }
  i++;
  // A wrapper (env, nohup, time, sudo, nice, timeout, ...) runs the command after its own options: that command is
  // dispatched too (`env bash -c 'node test/x.js'`, `/usr/bin/env sh -c ...`), and the wrapper's own reading goes on.
  if ((WRAP_BINS.has(bin) || WRAPPER_SPEC[bin]) && argv.length > 1000) {
    // A wrapper line this long is not unwrapped layer by layer (each layer would reparse it): every file is read.
    ctx.widenInert = true;
    widenAll(ctx);
  } else if ((WRAP_BINS.has(bin) || WRAPPER_SPEC[bin]) && ctx.depth < DEPTH) {
    const un = unwrapSink(argv.slice(i - 1));
    const own = stripWrapper(argv.slice(i - 1));
    let inner = un.words;
    if (own && (inner.length >= argv.length - (i - 1) || own.length < inner.length)) inner = own;
    if (inner.length > 0 && inner.join("\u0000") !== argv.slice(i - 1).join("\u0000")) {
      ctx.depth++;
      const savedNoEnv = ctx.noEnvIgnore;
      if (bin !== "env") ctx.noEnvIgnore = true;
      const savedIg = ctx.ignoreHooks;
      if (bin === "env") {
        // env's own flags and assignments, in order: -i or -u clear the variable, an assignment sets it. The wrapper drops them from
        // the inner words, so the setting is carried here.
        const marks: string[] = [];
        for (let k = i; k < argv.length; k++) {
          const w = argv[k]!;
          if (ASSIGN.test(w)) marks.push(w);
          else if (w.startsWith("-")) {
            if (envClears([w, argv[k + 1] ?? ""])) marks.push("npm_config_ignore_scripts=");
            if (PREFIX_VALUE_FLAG.env!.test(w) && !w.includes("=")) k++;
          } else break;
        }
        const envIg = envIgnore(marks);
        if (envIg !== undefined && binName(inner[0]!) === "npm") ctx.ignoreHooks = envIg;
        else if (envClears(argv.slice(i))) ctx.ignoreHooks = false;
      }
      dispatch(ctx, inner.map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(" "));
      ctx.noEnvIgnore = savedNoEnv;
      ctx.ignoreHooks = savedIg;
      ctx.depth--;
    }
  }
  // A command this does not know in front of a package runner (`dotenv -- npm run setup`, `flock /tmp/l npm run x`,
  // `./bin/wrap yarn run x`): the runner is dispatched from its own word, whatever the wrapper is.
  if (!RUNNERS.has(runnerName(bin)) && !SINK_WORD.test(bin) && !PLAIN_CMDS.has(bin) && !WRAP_BINS.has(bin) && !WRAPPER_SPEC[bin] && !/^(?:cd|pushd|popd|\.|source|echo|printf|true|false|:|test|\[|node-gyp|run-s|run-p|npm-run-all|lerna|turbo|nx|rush)$/.test(bin) && argv.length <= 200 && ctx.depth < DEPTH) {
    const k = argv.findIndex((a, q) => q >= i && RUNNERS.has(runnerName(a.replace(/^\\+/, ""))));
    if (k >= 0) {
      ctx.depth++;
      dispatch(ctx, argv.slice(k).map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(" "));
      ctx.depth--;
    }
  }
  // A directory change leaves this package whatever the target resolves to.
  if (bin === "cd" || bin === "pushd" || bin === "popd") {
    // Once the scan was unsure the widen already reads everything.
    if (!ctx.widenInert) widenAll(ctx);
    return;
  }
  if (WORKSPACE_TOOLS.has(bin) || ((bin === "npx" || bin === "bunx" || bin === "corepack") && WORKSPACE_TOOLS.has(runnerName(argv[i] ?? "")))) widenAll(ctx);
  if (bin === "echo" || bin === "true" || bin === ":") return;
  if (bin === "node" || bin === "nodejs") {
    const before = ctx.rootRuns;
    ctx.rootRuns = true;
    try {
      dispatchNode(ctx, argv, i);
    } finally {
      ctx.rootRuns = before;
    }
    return;
  }
  if (bin === "node-gyp") {
    // Any argument, including `rebuild`, is not a form we model. The gyp bytes
    // are still the file node-gyp reads.
    ctx.sawNodeGyp = true;
    if (i < argv.length) fail(ctx, "unresolved: node-gyp");
    return;
  }
  if (SHELL_RE.test(bin)) {
    dispatchSh(ctx, argv, i);
    return;
  }
  if (bin === "npm") {
    // Every argument before a bare `--` is checked, so a flag value cannot hide a later workspace flag.
    // npm reads a flag wherever it sits before `--`, and accepts unique prefixes (`--prefi`) and joined short
    // options (`-sw`), so any flag that is not a known quiet one widens, in every position.
    // `npm exec` takes its own `-c`, `--call`, `-p` and `--package`, so it is read before the flag rule.
    const ex = argv.findIndex((a, j) => j >= i && (a === "exec" || a === "x") && flagsOnly(argv.slice(i, j)));
    const dd = argv.indexOf("--");
    if (ex >= 0 && (dd < 0 || dd > ex)) {
      npmExec(ctx, argv, i, ex);
      return;
    }
    if (npmFlagWidens(argv, i)) {
      widenAll(ctx);
      // A workspace or prefix flag may run another package's script, which the widen covers, and may name this
      // package (`--prefix .`), so the root's own script is read too: the flags are dropped and the rest dispatched.
      const dd2 = argv.indexOf("--");
      if (ctx.depth >= DEPTH) {
        ctx.widenInert = true;
        widenAll(ctx);
        fail(ctx, "unresolved: script depth");
        return;
      }
      // The unknown flags are dropped and the rest is dispatched, once with the next word kept and once with it
      // taken as the flag's value (a flag with no `=` may take a value).
      const end = dd2 < 0 ? argv.length : dd2;
      // `npm version -w a` and `npm pack --workspaces` run the lifecycle scripts of the workspaces and of this package.
      const lifeSub = argv.slice(i, end).find((t) => t === "version" || t === "pack");
      if (lifeSub && argv.slice(i, end).some((t) => NPM_WORKSPACE_WIDEN.test(t)) && !(flagIgnore(argv.slice(i, end)) ?? !!ctx.ignoreHooks)) {
        for (const name of NPM_LIFECYCLE[lifeSub] ?? []) runScript(ctx, name, true);
      }
      const strip = (takesValue: boolean): string[] => {
        const out: string[] = [];
        for (let q = i; q < argv.length; q++) {
          const t = argv[q]!;
          const nm = t.indexOf("=") > 0 ? t.slice(0, t.indexOf("=")) : t;
          if (q < end && t.startsWith("-") && t !== "-" && !(BOOL_FLAGS.has(nm) || NPM_QUIET_FLAGS.has(nm))) {
            if ((takesValue || VALUE_FLAGS.has(nm)) && !t.includes("=") && q + 1 < end) q++;
            continue;
          }
          out.push(t);
        }
        return out;
      };
      const keepNext = strip(false);
      const dropNext = strip(true);
      ctx.depth++;
      const savedIgnore = ctx.ignoreHooks;
      ctx.ignoreHooks = flagIgnore(argv.slice(i, end)) ?? savedIgnore; // the flag is dropped from the line, not its meaning
      for (const rest of [keepNext, dropNext]) dispatch(ctx, ["npm", ...rest].map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(" "));
      ctx.ignoreHooks = savedIgnore;
      ctx.depth--;
      return;
    }
    const ddIgnore = argv.indexOf("--");
    const ignoreNow = flagIgnore(argv.slice(i, ddIgnore < 0 ? argv.length : ddIgnore)) ?? !!ctx.ignoreHooks;
    const sub = readWord(ctx, argv, i);
    if (!sub) {
      // A flag no form here models may move the run to another package or take the next word as its value.
      ctx.widenInert = true;
      widenAll(ctx);
      return;
    }
    if (!sub.word) {
      widenAll(ctx);
      if (!ctx.hold) fail(ctx, "unresolved: runner");
      return;
    }
    if (RUN_SUB.has(sub.word)) {
      const name = readWord(ctx, argv, sub.i + 1);
      if (!name) {
        ctx.widenInert = true;
        widenAll(ctx);
        return;
      }
      if (!name.word) {
        // A bare `npm run` only lists the scripts; an argument naming an unresolved expansion may be any script.
        if (argv.slice(sub.i + 1).some((a) => a.includes(UNRESOLVED))) {
          ctx.widenInert = true;
          widenAll(ctx);
        }
        if (!ctx.hold) fail(ctx, "unresolved: script");
        return;
      }
      runNamed(ctx, name.word, ignoreNow);
      return;
    }
    if (sub.word === "test" || sub.word === "t" || sub.word === "tst") {
      runNamed(ctx, "test", ignoreNow);
      return;
    }
    if (sub.word === "start") {
      runNamed(ctx, "start", ignoreNow);
      return;
    }
    if (sub.word === "stop") {
      runNamed(ctx, "stop", ignoreNow);
      return;
    }
    if (sub.word === "restart") {
      restart(ctx);
      return;
    }
    // `npm it`, `npm pack` and the like run lifecycle scripts without naming them: those scripts are read as named ones, unless
    // --ignore-scripts switches them off.
    if (!ignoreNow && npmLifecycleApplies(sub.word, argv.slice(sub.i + 1))) for (const name of NPM_LIFECYCLE[sub.word] ?? []) runScript(ctx, name, true);
    else for (const name of NPM_RUNS_NAMED[sub.word] ?? []) runNamed(ctx, name, true);
    if (sub.word.includes(UNRESOLVED)) ctx.widenInert = true;
    widenAll(ctx);
    fail(ctx, "unresolved: runner");
    return;
  }
  if (bin === "yarn" || bin === "pnpm" || bin === "bun") {
    // Forms that run a script of another workspace package or another directory. Those scripts are not
    // modeled here, so the whole package surface is reached. Every argument before a bare `--` is checked,
    // so a flag value cannot hide a later widening flag.
    const widen = WORKSPACE_WIDEN[bin];
    for (let j = i; j < argv.length && argv[j] !== "--"; j++) {
      if (widen.test(argv[j]!)) {
        widenAll(ctx);
        return;
      }
    }
    const sub = readWord(ctx, argv, i);
    if (!sub) {
      // A flag no form here models (`yarn run -T`, `pnpm --dir-like` options) may move the run to another
      // package or take the next word as its value.
      ctx.widenInert = true;
      widenAll(ctx);
      return;
    }
    // `yarn setup` and `pnpm test` run the script of that name when one exists.
    if (sub.word && sub.word !== "run" && sub.word !== "run-script" && !pathLikeWord(sub.word) && !RUNNER_BUILTINS.has(sub.word) && typeof ctx.raw[sub.word] === "string") {
      runScript(ctx, sub.word, false);
      return;
    }
    if (sub.word !== "run" && sub.word !== "run-script") {
      if (!ctx.hold) fail(ctx, "unresolved: runner");
      // A subcommand named by an unresolved expansion may be a script of the package.
      if (sub.word !== undefined && sub.word.includes(UNRESOLVED)) {
        ctx.widenInert = true;
        widenAll(ctx);
      }
      if (sub.word === undefined) {
        widenAll(ctx);
        return;
      }
      // dlx fetches remote code, so no named file makes it resolved.
      if (sub.word === "dlx" || (bin === "bun" && sub.word === "x")) widenAll(ctx);
      // A file (`bun ./x.ts`) is followed like node; exec widens when no file resolves.
      // Other builtins (install, add, ...) keep their old handling.
      else if (pathLikeWord(sub.word)) closeUnknownRunner(ctx, argv, sub.i);
      else if (sub.word === "exec" || sub.word === "x") closeUnknownRunner(ctx, argv, sub.i + 1);
      return;
    }
    const name = readWord(ctx, argv, sub.i + 1);
    if (!name) {
      ctx.widenInert = true;
      widenAll(ctx);
      return;
    }
    if (!name.word) {
      if (argv.slice(sub.i + 1).some((a) => a.includes(UNRESOLVED))) ctx.widenInert = true;
      widenAll(ctx);
      if (!ctx.hold) fail(ctx, "unresolved: script");
      return;
    }
    // `bun run ./x.ts` runs that file unless a script of exactly that name exists, which wins.
    if (bin === "bun" && pathLikeWord(name.word) && typeof ctx.raw[name.word] !== "string") {
      closeUnknownRunner(ctx, argv, name.i);
      return;
    }
    runScript(ctx, name.word, false);
    return;
  }
  if (bin === "run-s" || bin === "run-p" || bin === "npm-run-all") {
    dispatchRuns(ctx, argv, i);
    return;
  }
  if (bin === "npx" || bin === "bunx") {
    // The call string of `npx -c '...'` (or `--cal`, `-yc`) is a shell body.
    for (let j = i; j < argv.length && argv[j] !== "--" && argv[j]!.startsWith("-"); j++) {
      const ef = execFlag(argv[j]!);
      if (ef?.kind === "call") {
        const call = ef.value ?? argv[j + 1];
        if (call !== undefined && ctx.depth < DEPTH) {
          ctx.depth++;
          runBody(ctx, call);
          ctx.depth--;
        } else if (call !== undefined) {
          ctx.widenInert = true;
          widenAll(ctx);
        }
        break;
      }
      if (ef?.kind === "package" && ef.value === undefined) j++;
    }
  }
  if (bin === "npx" || bin === "corepack") {
    // `npx pnpm -C sub build` runs a script of another package through the wrapped runner.
    const inner = argv.slice(i).findIndex((a) => ["npm", "yarn", "pnpm", "bun"].includes(runnerName(a)));
    if (inner >= 0) {
      const wrapped = runnerName(argv[i + inner]!) as "npm" | "yarn" | "pnpm" | "bun";
      const rx = wrapped === "npm" ? NPM_WORKSPACE_WIDEN : WORKSPACE_WIDEN[wrapped];
      for (let j = i + inner + 1; j < argv.length && argv[j] !== "--"; j++) {
        if (rx.test(argv[j]!)) {
          widenAll(ctx);
          return;
        }
      }
    }
    // Only a wrapped runner that names a script of this package re-dispatches to it.
    // Every other form keeps the unknown-runner reach below.
    const named = wrappedScript(ctx, argv, i);
    if (named !== undefined) {
      runScript(ctx, named, false);
      return;
    }
  }
  if (bin === "prebuild-install" || bin === "node-pre-gyp") {
    ctx.reachGyp = true;
    fail(ctx, "unresolved: runner");
    return;
  }
  if (bin === "node-gyp-build" || bin === "node-gyp-build-optional-packages") {
    closePrebuilds(ctx, argv, i);
    return;
  }
  if (bin === "node-gyp-build-optional") {
    closeOptionalPrebuilds(ctx, argv, i);
    return;
  }
  if (bin === "patch-package") {
    closePatches(ctx, argv, i);
    return;
  }
  // prebuild-install and node-pre-gyp already returned. They download; they do not widen.
  // node already returned and keeps named files plus the require walk.
  // A sourced file runs in this shell, from the directory an earlier cd moved to.
  if ((bin === "." || bin === "source") && argv[i]) readFed(ctx, argv[i] === "--" && argv[i + 1] ? argv[i + 1]! : argv[i]!, true);
  // A script run by its path is read as a body (what its first line names runs it).
  if (/^(?:\.\.?\/|[A-Za-z0-9_-][A-Za-z0-9_.-]*\/)/.test(argv[i - 1] ?? "") && bin !== "npx" && bin !== "bunx") readFed(ctx, argv[i - 1]!, true);
  // `npx node .` runs the root as a module through the runner, as `node .` does.
  const rootBefore = ctx.rootRuns;
  if ((bin === "npx" || bin === "bunx" || bin === "corepack") && /^(?:node|nodejs)$/.test(runnerExecutable(argv, i))) ctx.rootRuns = true;
  try {
    closeUnknownRunner(ctx, argv, i);
  } finally {
    ctx.rootRuns = rootBefore;
  }
  // A package runner fetches or resolves a package, so a local file named among its
  // arguments does not make the run resolved, as with dlx.
  // `-p`/`--package` fetches a package onto PATH for the named file, so it always widens.
  if ((bin === "bunx" || bin === "npx" || bin === "corepack") && (argv.slice(i).some((a) => a === "-p" || a === "--package" || a.startsWith("--package=") || (a.startsWith("-p") && !a.startsWith("--") && a.length > 2)) || !localEntry(argv[i] ?? ""))) widenAll(ctx);
  fail(ctx, `unresolved: runner ${bin}`);
}

const RUNNER_CONFIGS = new Set([".npmrc", ".yarnrc.yml", ".yarnrc", "pnpm-workspace.yaml", ".pnpmfile.cjs", "bunfig.toml", ".pnp.cjs", ".pnp.loader.mjs", ".env", ".env.yarn", ".env.local", ".env.development", ".env.production", ".env.test"]);
const PREBUILD_DIRS = ["prebuilds", "build/Release", "build/Debug"];
const PATCH_BOOL = new Set(["--error-on-fail", "--error-on-warn", "--reverse", "--partial", "--use-yarn"]);

function underDir(logical: string, dir: string): boolean {
  return logical === dir || logical.startsWith(`${dir}/`);
}

// node-gyp-build's published bin treats argv[2] as a shell command, not a directory.
// Zero arguments close over a local prebuild. npm still compiles binding.gyp when
// the prebuild is for another platform, or when it synthesizes `node-gyp rebuild`,
// so the gyp bytes stay in the surface either way.
function closePrebuilds(ctx: Ctx, argv: string[], i: number): void {
  if (i < argv.length) {
    fail(ctx, "unresolved: runner");
    return;
  }
  for (const logical of ctx.logical.keys()) {
    if (!PREBUILD_DIRS.some((p) => underDir(logical, p))) continue;
    addLogical(ctx, logical);
  }
  ctx.sawNodeGyp = true;
}

// node-gyp-build-optional's bin exits before a build. One directory argument stays closed.
function closeOptionalPrebuilds(ctx: Ctx, argv: string[], i: number): void {
  const rest = argv.slice(i);
  if (rest.length > 1 || rest.some((a) => a.startsWith("-") || /[*?[]/.test(a))) {
    fail(ctx, "unresolved: runner");
    return;
  }
  let base = "";
  if (rest.length === 1) {
    base = normalize(rest[0] ?? "");
    if (badPath(base)) {
      fail(ctx, "unresolved: path");
      return;
    }
  }
  const prefixes = PREBUILD_DIRS.map((p) => (base ? `${base}/${p}` : p));
  for (const logical of ctx.logical.keys()) {
    if (prefixes.some((p) => underDir(logical, p))) addLogical(ctx, logical);
  }
  ctx.sawNodeGyp = true;
}

// patch-package with no package name applies files under patches/ (or one relative --patch-dir).
// A package name creates a patch. That path is not the apply set.
function closePatches(ctx: Ctx, argv: string[], i: number): void {
  let dir = "patches";
  for (let j = i; j < argv.length; j++) {
    const a = argv[j]!;
    if (PATCH_BOOL.has(a)) continue;
    let rel: string | undefined;
    if (a === "--patch-dir") {
      const next = argv[++j];
      if (next === undefined || next.startsWith("-")) {
        ctx.widenInert = true;
        widenAll(ctx);
        fail(ctx, "unresolved: runner");
        return;
      }
      rel = next;
    } else if (a.startsWith("--patch-dir=")) rel = a.slice("--patch-dir=".length);
    else {
      // A package name creates a patch (nothing that runs); a flag this does not model, or an unresolved word, anywhere among the
      // arguments may run any file.
      const rest = argv.slice(j).filter((w) => !PATCH_BOOL.has(w));
      if (rest.some((w) => w.startsWith("-") || w.includes(UNRESOLVED))) {
        ctx.widenInert = true;
        widenAll(ctx);
      }
      fail(ctx, "unresolved: runner");
      return;
    }
    const logical = normalize(rel);
    if (!logical || badPath(logical) || /[*?[]/.test(logical) || logical.includes(UNRESOLVED)) {
      ctx.widenInert = true;
      widenAll(ctx);
      fail(ctx, "unresolved: runner");
      return;
    }
    dir = logical;
  }
  for (const logical of ctx.logical.keys()) if (underDir(logical, dir)) addLogical(ctx, logical);
}

function gypStringVars(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const block of text.matchAll(/['"]variables['"]\s*:\s*\{([^{}]*)\}/g)) {
    for (const pair of (block[1] ?? "").matchAll(/['"]([A-Za-z0-9_]+)['"]\s*:\s*['"]([^'"]*)['"]/g)) {
      out.set(pair[1] ?? "", pair[2] ?? "");
    }
  }
  return out;
}

function substGypVars(cmd: string, vars: Map<string, string>): string {
  return cmd.replace(/<\(([A-Za-z0-9_]+)\)/g, (full, name: string) => vars.get(name) ?? full);
}

function isGypName(logical: string): boolean {
  const base = logical.slice(logical.lastIndexOf("/") + 1).toLowerCase();
  return base.endsWith(".gyp") || base.endsWith(".gypi");
}

function joinLogical(baseFile: string, rel: string): string {
  const dir = baseFile.includes("/") ? baseFile.slice(0, baseFile.lastIndexOf("/")) : "";
  const parts = (dir ? `${dir}/${rel}` : rel).split("/");
  const out: string[] = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") return "";
    out.push(part);
  }
  return out.join("/");
}

function quotedKey(text: string, key: string): boolean {
  return new RegExp(`['"]${key}['"]\\s*:`).test(text);
}

function takeList(text: string, key: string): string[] | null | undefined {
  if (!quotedKey(text, key)) return undefined;
  const matches = [...text.matchAll(new RegExp(`['"]${key}['"]\\s*:\\s*\\[([^\\]]*)\\]`, "g"))];
  if (matches.length === 0) return null;
  const out: string[] = [];
  for (const m of matches) {
    const inner = m[1] ?? "";
    const parts = [...inner.matchAll(/['"]([^'"]*)['"]/g)].map((x) => x[1] ?? "");
    if (inner.replace(/['"][^'"]*['"]/g, "").replace(/[\s,]/g, "")) return null;
    out.push(...parts);
  }
  return out;
}

function stripBang(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const at = text[i + 2] === "@";
    if (text[i] === "<" && text[i + 1] === "!" && (text[i + 2] === "(" || (at && text[i + 3] === "("))) {
      let j = i + (at ? 4 : 3);
      let depth = 1;
      for (; j < text.length && depth > 0; j++) {
        if (text[j] === "(") depth++;
        else if (text[j] === ")") depth--;
      }
      if (depth !== 0) out += text[i];
      else {
        i = j - 1;
        continue;
      }
    }
    out += text[i] ?? "";
  }
  return out;
}

// `<(`, `>(`, and `^(` are expansions. `<!(` and `<!@(` are not: the `(` there does not follow `<`, `>`, or `^`.
function gypVar(text: string): boolean {
  for (let i = 0; i < text.length - 1; i++) {
    const c = text[i]!;
    if ((c === "<" || c === ">" || c === "^") && text[i + 1] === "(") return true;
  }
  return false;
}

// A single action word may be `<!(node evil.js)` or `<!@(...)`. The space sits inside the
// substitution, which gypCommands already closed. Any other space is not one argv word.
function bangArg(arg: string): boolean {
  return /^<!\([^)]*\)$/.test(arg) || /^<!@\([^)]*\)$/.test(arg);
}

function scanGyp(ctx: Ctx, logical: string, seen: Set<string>): void {
  if (ctx.hold) return;
  const key = ctx.logical.get(logical);
  if (!key || seen.has(key)) return;
  seen.add(key);
  const text = dec.decode(ctx.bytes.get(key));
  // An expansion we do not model is not a reason to skip the rest of the file.
  // The gyp bytes themselves are compared, and a resolved action is still closed.
  if (text.replace(/<!@/g, "").includes("<@") || stripBang(text).includes("<!")) fail(ctx, "unresolved: gyp");
  if (gypVar(text)) fail(ctx, "unresolved: gyp");
  const saved = ctx.fromGyp;
  ctx.fromGyp = true;
  const gypVars = gypStringVars(text);
  for (const cmd of gypCommands(text)) {
    const body = substGypVars(cmd, gypVars);
    runBody(ctx, body);
  }
  const includes = takeList(text, "includes");
  if (includes === null) fail(ctx, "unresolved: gyp");
  else if (includes) {
    for (const inc of includes) {
      if (ctx.hold) break;
      const next = joinLogical(logical, inc);
      if (!next || badPath(next) || /[*?[]/.test(next) || !ctx.logical.has(next)) {
        fail(ctx, "unresolved: gyp");
        break;
      }
      const incKey = ctx.logical.get(next)!;
      ctx.files.add(incKey);
      ctx.gypFiles.add(incKey);
      scanGyp(ctx, next, seen);
    }
  }
  // `action` under rules or postbuilds is the same command list. `action_name` is not.
  const found = [...text.matchAll(/['"]action['"]\s*:\s*\[([^\]]*)\]/g)];
  if (quotedKey(text, "action") && found.length === 0) fail(ctx, "unresolved: gyp");
  for (const m of found) {
    if (ctx.hold) break;
    const inner = m[1] ?? "";
    if (inner.replace(/['"][^'"]*['"]/g, "").replace(/[\s,]/g, "")) {
      fail(ctx, "unresolved: gyp");
      break;
    }
    const argv = [...inner.matchAll(/['"]([^'"]*)['"]/g)].map((x) => x[1] ?? "");
    if (argv.length === 0 || argv.some((a) => /\s/.test(a) && !bangArg(a))) {
      fail(ctx, "unresolved: gyp");
      break;
    }
    const cmd = argv.join(" ");
    if (cmd.includes("<!") || cmd.includes("<@")) continue;
    dispatch(ctx, cmd);
  }
  ctx.fromGyp = saved;
}

function parseJson(bytes: Uint8Array | undefined): Record<string, unknown> | undefined {
  if (!bytes) return undefined;
  try {
    const v = JSON.parse(dec.decode(bytes)) as unknown;
    if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
    return v as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function indexFiles(files: FileMap): { logical: Map<string, string>; manifest?: string; gyp?: string; foldClash: boolean } {
  const logical = new Map<string, string>();
  const put = (logicalPath: string, orig: string) => {
    if (!logical.has(logicalPath)) logical.set(logicalPath, orig);
  };
  if (files.has("package.json")) {
    for (const k of files.keys()) put(k, k);
  } else {
    for (const k of files.keys()) {
      const slash = k.indexOf("/");
      put(slash < 0 ? k : k.slice(slash + 1), k);
    }
  }
  let gyp: string | undefined;
  for (const [logicalPath, orig] of logical) {
    if (!logicalPath.includes("/") && logicalPath.toLowerCase() === "binding.gyp") {
      gyp = orig;
      break;
    }
  }
  const rootFolds = [...logical.keys()].filter((k) => !k.includes("/") && k.toLowerCase() === "package.json");
  let manifest = logical.get("package.json");
  if (!manifest && rootFolds.length === 1) manifest = logical.get(rootFolds[0]!);
  return { logical, manifest, gyp, foldClash: rootFolds.length > 1 };
}

function walkStrings(v: unknown, fn: (s: string) => void): void {
  if (typeof v === "string") fn(v);
  else if (Array.isArray(v)) for (const x of v) walkStrings(x, fn);
  else if (v && typeof v === "object") {
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      fn(k);
      walkStrings(x, fn);
    }
  }
}

function finish(ctx: Ctx, manifest: string, gyp: string | undefined, hook: boolean, binStamp: string): InstallView {
  return {
    hold: ctx.hold,
    manifest,
    files: [...ctx.files].sort(),
    gypFiles: [...ctx.gypFiles].sort(),
    missing: [...ctx.missing].sort(),
    scripts: ctx.scripts,
    gyp,
    hook,
    binStamp,
  };
}

function installHook(root: Record<string, unknown>): boolean {
  const scripts = root.scripts;
  if (!scripts || typeof scripts !== "object" || Array.isArray(scripts)) return false;
  const rec = scripts as Record<string, unknown>;
  return INSTALL.some((name) => typeof rec[name] === "string" && (rec[name] as string).length > 0);
}

function stampBin(root: Record<string, unknown>): string {
  const directories = root.directories;
  let directoriesBin: unknown = null;
  if (directories && typeof directories === "object" && !Array.isArray(directories)) {
    const value = (directories as Record<string, unknown>).bin;
    if (value !== undefined) directoriesBin = value;
  }
  return JSON.stringify({ bin: root.bin === undefined ? null : root.bin, directoriesBin });
}

// A safe relative prebuild.test is part of the closure. Any other prebuild value is a download or a config we do not read.
function notePrebuild(ctx: Ctx, root: Record<string, unknown>): void {
  if (ctx.hold || root.prebuild === undefined) return;
  const pre = root.prebuild;
  if (!pre || typeof pre !== "object" || Array.isArray(pre)) {
    fail(ctx, "unresolved: prebuild");
    return;
  }
  const rec = pre as Record<string, unknown>;
  const keys = Object.keys(rec);
  const test = rec.test;
  if (keys.length === 1 && keys[0] === "test" && typeof test === "string") {
    const logical = normalize(test);
    if (!logical || badPath(logical) || /[*?[]/.test(logical)) {
      fail(ctx, "unresolved: prebuild");
      return;
    }
    addRef(ctx, test);
    return;
  }
  fail(ctx, "unresolved: prebuild");
}

export function installView(files: FileMap): InstallView {
  const indexed = indexFiles(files);
  const manifest = indexed.manifest ?? "package.json";
  if (!indexed.manifest && !indexed.gyp && !indexed.foldClash) {
    return { manifest, files: [], gypFiles: [], missing: [], scripts: {}, hook: false, binStamp: "" };
  }
  const ctx: Ctx = {
    files: new Set(),
    gypFiles: new Set(),
    missing: new Set(),
    scripts: {},
    seen: new Set(),
    scanned: new Set(),
    ranSh: new Set(),
    depth: 0,
    sawNodeGyp: false,
    reachGyp: false,
    fromGyp: false,
    fileCount: files.size,
    hookNamed: new Set(),
    movedDirs: new Set(),
    cwd: "",
    widenInert: false,
    sawRunner: false,
    logical: indexed.logical,
    raw: {},
    config: {},
    bytes: files,
  };
  const pj = indexed.manifest ? parseJson(files.get(indexed.manifest)) : {};
  if (indexed.manifest && !pj) {
    fail(ctx, "unresolved: manifest");
    return finish(ctx, manifest, undefined, false, "");
  }
  const root = pj ?? {};
  const hook = installHook(root);
  const stamp = stampBin(root);
  const done = (gyp?: string) => finish(ctx, manifest, gyp, hook, stamp);
  const scripts = root.scripts;
  ctx.raw = scripts && typeof scripts === "object" && !Array.isArray(scripts) ? (scripts as Record<string, unknown>) : {};
  const config = root.config;
  ctx.config = config && typeof config === "object" && !Array.isArray(config) ? (config as Record<string, unknown>) : {};
  walkStrings(root.exports, (s) => {
    if (ctx.hold || !s.includes("*")) return;
    if (s.length > STAR_PATTERN_MAX) fail(ctx, "pattern length");
    else if (ctx.fileCount > STAR_KEY_MAX) fail(ctx, `key count ${ctx.fileCount} > ${STAR_KEY_MAX}`);
  });
  if (indexed.foldClash) fail(ctx, "case-fold");
  if (ctx.hold) return done();
  // A binary field can still compile the package. The download itself is not a hold.
  if (hook && root.binary !== undefined) ctx.reachGyp = true;
  notePrebuild(ctx, root);
  if (ctx.hold) return done();
  for (const name of INSTALL) {
    const raw = ctx.raw[name];
    if (typeof raw === "string" && raw.includes("*") && ctx.fileCount > STAR_KEY_MAX) {
      fail(ctx, `key count ${ctx.fileCount} > ${STAR_KEY_MAX}`);
      return done();
    }
  }
  const ran = prepareInert(ctx.raw, otherInstallEntry(files, manifest)) ? INSTALL.filter((name) => name !== "prepare") : INSTALL;
  for (const name of ran) {
    const raw = ctx.raw[name];
    if (typeof raw === "string") ctx.scripts[name] = raw;
  }
  for (const name of ran) {
    const raw = ctx.raw[name];
    if (typeof raw === "string" && raw.length > 0) runScript(ctx, name, false);
  }
  // A runner config file at the package root (`.npmrc` with `workspace=sub`, `.yarnrc.yml` with `yarnPath`,
  // `pnpm-workspace.yaml`, `.pnpmfile.cjs`, `bunfig.toml`) can move or replace a run, so when an install hook
  // reaches a package runner it joins the surface and the other manifests are read. Deeper copies (fixtures,
  // templates) keep the inert rule; a nested package's own config is read by the widen.
  const rootConfigs = [...indexed.logical].filter(([logical]) => !logical.includes("/") && RUNNER_CONFIGS.has(logical.toLowerCase()));
  if (rootConfigs.length) {
    if (ctx.sawRunner) {
      for (const [, key] of rootConfigs) ctx.files.add(key);
      // A config can name a file under test/ or docs/ (yarnPath, node-options, script-shell, preload).
      ctx.widenInert = true;
      widenAll(ctx);
    }
  }
  const truthy = (name: string) => typeof ctx.raw[name] === "string" && String(ctx.raw[name]).length > 0;
  let gyp: string | undefined;
  const anyBinding = [...indexed.logical.keys()].some((logical) => logical.slice(logical.lastIndexOf("/") + 1).toLowerCase() === "binding.gyp");
  // Implicit rebuild runs when any binding.gyp exists, gypfile is not false, and
  // neither install nor preinstall is truthy. postinstall does not suppress it.
  // An explicit node-gyp or node-gyp-build reads every gyp byte even when a
  // prebuild was loaded or gypfile is false. `node safe.js` does not.
  const implicit = anyBinding && !truthy("install") && !truthy("preinstall") && root.gypfile !== false;
  const reached = ctx.sawNodeGyp || ctx.reachGyp;
  if (implicit || reached) {
    gyp = indexed.gyp;
    if (!gyp) {
      for (const [logical, orig] of indexed.logical) {
        if (logical.slice(logical.lastIndexOf("/") + 1).toLowerCase() === "binding.gyp") {
          gyp = orig;
          break;
        }
      }
    }
    const seen = new Set<string>();
    for (const logical of indexed.logical.keys()) {
      if (!isGypName(logical)) continue;
      const orig = indexed.logical.get(logical)!;
      // binding.gyp itself is byte-compared through the view's gyp field.
      if (orig !== gyp) {
        ctx.files.add(orig);
        ctx.gypFiles.add(orig);
      }
      scanGyp(ctx, logical, seen);
    }
  }
  return done(gyp);
}
