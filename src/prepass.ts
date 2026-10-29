// Deterministic pre-pass over two unpacked release artifacts (old, new).
// Hard signals hold an update no matter what a model reviewer says; soft
// signals are handed to the reviewer as pointers. It reads bytes only.

import { installView } from "./install-closure.ts";

export type FileMap = Map<string, Uint8Array>;
export type Ecosystem = "npm" | "pypi";

// These mean the install surface could not be computed. Any other install hold
// is a form we compared and found unchanged, which is not a hold.
export function surfaceCap(reason: string): boolean {
  return /^(glob|pattern length|key count|unresolved: manifest|unresolved: path|unresolved: script depth|case-fold)/.test(reason);
}

// Symlink entries from readArtifact. Their bytes are the link target (what pip writes for a wheel's
// symlink entry), and the mark is kept on the bytes so it survives path renames and copies.
const LINKS = new WeakSet<Uint8Array>();

export function markLink(bytes: Uint8Array): Uint8Array {
  LINKS.add(bytes);
  return bytes;
}

export function isLink(bytes: Uint8Array): boolean {
  return LINKS.has(bytes);
}

// Tar member problems read from the archive listing, not the extracted tree.
// npm skips link entries; bsdtar does not. The note survives path normalization.
const TAR_NOTES = new WeakMap<FileMap, string[]>();

export function markTarNotes(files: FileMap, notes: readonly string[]): void {
  if (notes.length === 0) return;
  const prev = TAR_NOTES.get(files) ?? [];
  const seen = new Set(prev);
  const next = [...prev];
  for (const note of notes) if (!seen.has(note)) {
    seen.add(note);
    next.push(note);
  }
  TAR_NOTES.set(files, next);
}

export function tarNotes(files: FileMap): readonly string[] {
  return TAR_NOTES.get(files) ?? [];
}

// Paths mergeArtifactPair placed, per merged map: the path inside the artifact (a `label/` prefix stripped), which
// is what a symlink target is relative to, and the paths that artifact holds, so a link resolves only inside it.
const LABELED = new WeakMap<FileMap, Map<string, { inner: string; members?: ReadonlySet<string> }>>();
// (member set, inner path) -> placed key. Rebuilt when labels change. First label wins, matching a linear scan.
const PLACED_INDEX = new WeakMap<FileMap, Map<ReadonlySet<string>, Map<string, string>>>();

export function markLabeled(files: FileMap, key: string, inner: string, members?: ReadonlySet<string>): void {
  let m = LABELED.get(files);
  if (!m) LABELED.set(files, (m = new Map()));
  m.set(key, { inner, members });
  PLACED_INDEX.delete(files);
}

export function artifactPath(files: FileMap, key: string): string {
  return LABELED.get(files)?.get(key)?.inner ?? key;
}

function placementIndex(files: FileMap): Map<ReadonlySet<string>, Map<string, string>> {
  let idx = PLACED_INDEX.get(files);
  if (idx) return idx;
  idx = new Map();
  for (const [k, v] of LABELED.get(files) ?? []) {
    if (!v.members) continue;
    let inner = idx.get(v.members);
    if (!inner) idx.set(v.members, (inner = new Map()));
    if (!inner.has(v.inner)) inner.set(v.inner, k);
  }
  PLACED_INDEX.set(files, idx);
  return idx;
}

/** The key a merge placed `inner` of the same artifact (same member set) under, if it placed it at all. */
export function artifactKey(files: FileMap, members: ReadonlySet<string>, inner: string): string | undefined {
  return placementIndex(files).get(members)?.get(inner);
}

/** The paths of the artifact a merged key came from, or undefined for a map no merge built. */
export function artifactMembers(files: FileMap, key: string): ReadonlySet<string> | undefined {
  return LABELED.get(files)?.get(key)?.members;
}

export interface Signal {
  kind: string;
  path: string;
  detail: string;
}

export interface PrepassResult {
  hard: Signal[];
  soft: Signal[];
  added: string[];
  removed: string[];
  changed: string[];
}

const NPM_INSTALL_SCRIPTS = ["preinstall", "install", "postinstall", "prepare"];

export const SOFT_PATTERNS: { kind: string; re: RegExp }[] = [
  { kind: "encoded-blob", re: /[A-Za-z0-9+/=_-]{400,}/ },
  { kind: "dynamic-exec", re: /\b(exec|eval)\s*\(\s*(base64|codecs|zlib|marshal|atob|Buffer\.from|bytes\.fromhex|__import__)/ },
  { kind: "dynamic-exec", re: /\bnew\s+Function\s*\(/ },
  { kind: "credential-path", re: /\.aws\/credentials|\.ssh\/id_|\.config\/gcloud|\.kube\/config|\.docker\/config\.json|\.npmrc|\.pypirc|\.netrc|\.git-credentials|Login Data|Cookies\.binarycookies/ },
  { kind: "credential-env", re: /(ANTHROPIC|OPENAI|AWS_SECRET|GITHUB|GH|NPM|PYPI)_[A-Z_]*(KEY|TOKEN|SECRET)/ },
  { kind: "metadata-endpoint", re: /169\.254\.169\.254|metadata\.google\.internal/ },
  { kind: "process-spawn", re: /\b(subprocess\.(Popen|run|call)|os\.system|child_process|execSync|spawnSync)\b/ },
];

const dec = new TextDecoder("utf-8", { fatal: false });

function basename(p: string): string {
  const i = p.lastIndexOf("/");
  return i < 0 ? p : p.slice(i + 1);
}

function isPythonStartupHook(path: string): boolean {
  const b = basename(path);
  return b.endsWith(".pth") || b === "sitecustomize.py" || b === "usercustomize.py";
}

// True when a symlink at `path` with this target resolves above the package root (or is absolute).
function linkEscapes(path: string, target: string): boolean {
  if (target.startsWith("/") || /^[A-Za-z]:/.test(target)) return true;
  const stack = path.split("/").slice(0, -1);
  for (const seg of target.split("/")) {
    if (seg === "..") {
      if (!stack.length) return true;
      stack.pop();
    } else if (seg && seg !== ".") stack.push(seg);
  }
  return false;
}

/** Same bytes and same type: a file and a symlink with equal bytes (the link target) are different entries. */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length || isLink(a) !== isLink(b)) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function addedLines(oldText: string | undefined, newText: string): string[] {
  const before = new Set((oldText ?? "").split("\n"));
  return newText.split("\n").filter((l) => !before.has(l));
}

const HOOK_BINS = new Set(["node", "nodejs", "npm", "npx", "echo", "sh", "bash", "run", "run-s", "run-p", "run-script", "npm-run-all", "yarn", "pnpm", "bun"]);
const HOOK_FILE_BINS = new Set(["node", "nodejs", "bun", "sh", "bash"]);

function npmPackageEnv(pj: Record<string, unknown>): Map<string, string> {
  const env = new Map<string, string>();
  const walk = (prefix: string, v: unknown) => {
    if (v === null || v === undefined) return;
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
      env.set(prefix, String(v));
      return;
    }
    if (Array.isArray(v)) {
      if (v.every((x) => x === null || x === undefined || ["string", "number", "boolean"].includes(typeof x))) {
        env.set(prefix, v.map((x) => (x == null ? "" : String(x))).join(","));
      }
      return;
    }
    if (typeof v === "object") {
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        if (/^[A-Za-z0-9_]+$/.test(k)) walk(`${prefix}_${k}`, x);
      }
    }
  };
  walk("npm_package", pj);
  return env;
}

function substituteNpmPackage(body: string, env: Map<string, string>): string {
  let out = body;
  for (const k of [...env.keys()].sort((a, b) => b.length - a.length)) {
    const v = env.get(k)!;
    out = out.replace(new RegExp(`\\$\\{${k}\\}|\\$${k}(?![A-Za-z0-9_])`, "g"), () => v);
  }
  return out;
}

function splitShell(body: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: string | undefined;
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!;
    if (quote) {
      cur += c;
      if (c === quote) quote = undefined;
      continue;
    }
    if (c === "\"" || c === "'" || c === "`") {
      quote = c;
      cur += c;
      continue;
    }
    if ((c === "&" || c === "|") && body[i + 1] === c) {
      if (cur.trim()) out.push(cur.trim());
      cur = "";
      i++;
      continue;
    }
    if (c === ";" || c === "|" || c === "&" || c === "\n") {
      if (cur.trim()) out.push(cur.trim());
      cur = "";
      continue;
    }
    cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function shellWords(cmd: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: string | undefined;
  for (const c of cmd) {
    if (quote) {
      if (c === quote) quote = undefined;
      else cur += c;
      continue;
    }
    if (c === "\"" || c === "'" || c === "`") {
      quote = c;
      continue;
    }
    if (/\s/.test(c)) {
      if (cur) out.push(cur);
      cur = "";
      continue;
    }
    cur += c;
  }
  if (cur) out.push(cur);
  return out;
}

function binName(token: string): string {
  return token.replace(/^.*\//, "").replace(/\.cmd$/i, "");
}

// A pattern or a key past these bounds is not matched. The matcher is linear, and a long
// pattern against every key of a huge package is still the cost this cap exists to stop.
export const STAR_PATTERN_MAX = 256;
export const STAR_KEY_MAX = 4096;
export const STAR_TEXT_MAX = 1024;

// `*` is any run of characters, including empty and `/`. Every other character is literal.
// Two pointers, no RegExp: a run of stars cannot backtrack exponentially over the text.
export function starMatch(pattern: string, text: string): boolean {
  if (pattern.length > STAR_PATTERN_MAX || text.length > STAR_TEXT_MAX) return false;
  let pi = 0;
  let ti = 0;
  let starP = -1;
  let starT = -1;
  while (ti < text.length) {
    if (pi < pattern.length && pattern[pi] === "*") {
      starP = pi;
      starT = ti;
      pi++;
      continue;
    }
    if (pi < pattern.length && pattern[pi] === text[ti]) {
      pi++;
      ti++;
      continue;
    }
    if (starP === -1) return false;
    starT++;
    pi = starP + 1;
    ti = starT;
  }
  while (pi < pattern.length && pattern[pi] === "*") pi++;
  return pi === pattern.length;
}

const VALUE_FLAGS = new Set([
  "--prefix", "-C", "--registry", "--userconfig", "--globalconfig", "--cache", "--tmp",
  "--script-shell", "--workspace", "-w", "--omit", "--include", "--scope", "--user",
  "--filter", "--dir", "--cwd", "--max-parallel", "--jobs", "-j", "--npm-path", "--config",
]);
const BOOL_FLAGS = new Set([
  "--silent", "--quiet", "-s", "-q", "--if-present", "--ignore-scripts", "--no-color", "--color",
  "--continue-on-error", "-c", "--print-label", "--print-name", "-l", "--parallel", "-p",
  "--sequential", "--race", "--aggregate-output", "--serial", "--bun", "--frozen-lockfile",
  "--prefer-offline", "--offline", "--recursive", "-r",
]);
const NPM_RUN = new Set(["run", "run-script", "rum", "urn"]);
const NPM_LIFE = new Set(["test", "start", "stop", "restart"]);

function flagName(token: string): string {
  const eq = token.indexOf("=");
  return eq > 0 ? token.slice(0, eq) : token;
}

// Flags before a subcommand. A value flag consumes the next word. A boolean flag does not,
// so `npm --silent run setup` still sees `run`. An unknown flag consumes the next word only
// when that word is not the subcommand (`npm --prefix . run setup`).
function skipFlags(argv: string[], i: number, protect: ReadonlySet<string> | null): number {
  while (i < argv.length) {
    const a = argv[i]!;
    if (a === "--") return -1;
    if (!a.startsWith("-")) return i;
    const name = flagName(a);
    const inline = a.includes("=");
    i++;
    if (inline || BOOL_FLAGS.has(name)) continue;
    const next = argv[i];
    if (!next || next.startsWith("-")) continue;
    // Before the subcommand, an unlisted flag still takes a value that is not itself the
    // subcommand. After it, only a known value flag does, so the script name is left intact.
    if (VALUE_FLAGS.has(name) || (protect !== null && !protect.has(next))) i++;
  }
  return i;
}

function referencedScripts(argv: string[], scripts: Record<string, unknown>): string[] {
  let i = 0;
  while (i < argv.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[i]!)) i++;
  if (i >= argv.length) return [];
  const bin = binName(argv[i]!);
  const names: string[] = [];
  if (bin === "npm") {
    i++;
    const subs = new Set<string>([...NPM_RUN, ...NPM_LIFE]);
    i = skipFlags(argv, i, subs);
    if (i < 0) return [];
    const sub = argv[i];
    if (sub && NPM_LIFE.has(sub)) return [sub];
    if (!sub || !NPM_RUN.has(sub)) return [];
    i++;
    i = skipFlags(argv, i, null);
    if (i < 0) return [];
    const name = argv[i];
    if (name && !name.startsWith("-")) names.push(name);
    return names;
  }
  if (bin === "yarn" || bin === "pnpm" || bin === "bun") {
    i++;
    i = skipFlags(argv, i, new Set(["run"]));
    if (i < 0 || argv[i] !== "run") return [];
    i++;
    i = skipFlags(argv, i, null);
    if (i < 0) return [];
    const name = argv[i];
    if (name && !name.startsWith("-")) names.push(name);
    return names;
  }
  if (bin === "run-s" || bin === "run-p" || bin === "npm-run-all") {
    i++;
    const keys = Object.keys(scripts);
    const pool = keys.length > STAR_KEY_MAX ? keys.slice(0, STAR_KEY_MAX) : keys;
    for (; i < argv.length; i++) {
      const a = argv[i]!;
      if (a === "--") break;
      if (a.startsWith("-")) {
        const name = flagName(a);
        if (!a.includes("=") && VALUE_FLAGS.has(name)) {
          const next = argv[i + 1];
          if (next && !next.startsWith("-")) i++;
        }
        continue;
      }
      if (a.includes("*")) {
        if (a.length > STAR_PATTERN_MAX) continue;
        for (const k of pool) if (starMatch(a, k)) names.push(k);
      } else names.push(a);
    }
  }
  return names;
}

function expandHookBody(raw: string, scripts: Record<string, unknown>, env: Map<string, string>): string {
  const seen = new Set<string>();
  const parts: string[] = [];
  const queue: { body: string; depth: number }[] = [{ body: raw, depth: 0 }];
  while (queue.length) {
    const { body, depth } = queue.shift()!;
    const sub = substituteNpmPackage(body, env);
    parts.push(sub);
    if (depth >= 8) continue;
    for (const cmd of splitShell(sub)) {
      for (const name of referencedScripts(shellWords(cmd), scripts)) {
        if (seen.has(name)) continue;
        const next = scripts[name];
        if (typeof next !== "string") continue;
        seen.add(name);
        queue.push({ body: next, depth: depth + 1 });
      }
    }
  }
  return parts.join("\n");
}

// Install-hook text after `$npm_package_*` substitution, plus every script body a runner names:
// `npm run` / `run-script` / `rum` / `urn`, `npm test|start|stop|restart`, `yarn|pnpm|bun run`, and `run-s` / `run-p` / `npm-run-all`.
export function expandNpmScripts(pj: Record<string, unknown>, names: readonly string[]): Record<string, string> {
  if (!pj || typeof pj !== "object" || Array.isArray(pj)) return {};
  const scripts = (pj.scripts ?? {}) as Record<string, unknown>;
  const env = npmPackageEnv(pj);
  const out: Record<string, string> = {};
  for (const name of names) {
    const raw = scripts[name];
    if (typeof raw !== "string") continue;
    out[name] = expandHookBody(raw, scripts, env);
  }
  return out;
}

function pathLikeToken(token: string): boolean {
  return token.startsWith(".") || token.includes("/");
}

function tokenExt(token: string): boolean {
  return /\.[A-Za-z0-9]+$/.test(token);
}

// A quote, paren, or equals inside `node -e` / `--eval` / `-p` text. The shell word is the whole
// expression; the old split is what names `./evil.js` inside `require('./evil.js')`.
function pushSplitFiles(text: string, out: string[]) {
  for (const t of text.split(/[\s;&|()<>"'`=]+/)) {
    if (!t || t.startsWith("-")) continue;
    if (HOOK_BINS.has(binName(t)) && !pathLikeToken(t)) continue;
    if (pathLikeToken(t) || tokenExt(t)) out.push(t);
  }
}

// File arguments of an expanded install hook. Command words and script names are not files.
// `node evil` (no extension) is a file argument; `npm run setup` is not.
// `-e` / `--eval` / `-p` text and a `sh -c` / `bash -c` body are read again. `--require=`, `-r`, and `--import=` name a file.
export function npmHookFileArgs(body: string): string[] {
  const walk = (text: string, depth: number): string[] => {
    if (depth > 8) return [];
    const out: string[] = [];
    for (const cmd of splitShell(text)) {
      const argv = shellWords(cmd);
      let i = 0;
      while (i < argv.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[i]!)) i++;
      if (i >= argv.length) continue;
      const exe = argv[i]!;
      i++;
      const bin = binName(exe);
      if ((pathLikeToken(exe) || tokenExt(exe)) && !HOOK_BINS.has(bin)) out.push(exe);
      const fileBin = HOOK_FILE_BINS.has(bin);
      const nodeBin = bin === "node" || bin === "nodejs" || bin === "bun";
      const shellBin = bin === "sh" || bin === "bash";
      for (; i < argv.length; i++) {
        const a = argv[i]!;
        if (a === "--") break;
        if (a.startsWith("-")) {
          const eq = a.indexOf("=");
          const name = eq > 0 ? a.slice(0, eq) : a;
          const inline = eq > 0 ? a.slice(eq + 1) : undefined;
          const take = (): string | undefined => {
            if (inline !== undefined) return inline;
            const next = argv[i + 1];
            if (next === undefined || next.startsWith("-")) return undefined;
            i++;
            return next;
          };
          if (shellBin && name === "-c") {
            const nested = take();
            if (nested) out.push(...walk(nested, depth + 1));
            continue;
          }
          if (nodeBin && (name === "-e" || name === "--eval" || name === "-p" || name === "--print")) {
            const code = take();
            if (code) pushSplitFiles(code, out);
            continue;
          }
          if (nodeBin && (name === "-r" || name === "--require" || name === "--import")) {
            const spec = take();
            if (spec) out.push(spec);
            continue;
          }
          continue;
        }
        if (HOOK_BINS.has(binName(a)) && !pathLikeToken(a)) continue;
        if (pathLikeToken(a) || (fileBin && (tokenExt(a) || !a.includes("=")))) out.push(a);
      }
    }
    return out;
  };
  return walk(body, 0);
}

// npm runs `node-gyp rebuild` when binding.gyp is on disk, gypfile is not false, and neither
// install nor preinstall is set. A hook that itself runs node-gyp still reads the gyp file.
export function bindingRunsGyp(pj: Record<string, unknown>): boolean {
  if (pj.gypfile === false) return false;
  const scripts = pj.scripts;
  const s = scripts && typeof scripts === "object" && !Array.isArray(scripts) ? (scripts as Record<string, unknown>) : {};
  const install = typeof s.install === "string" ? s.install : "";
  const pre = typeof s.preinstall === "string" ? s.preinstall : "";
  if (typeof s.install !== "string" && typeof s.preinstall !== "string") return true;
  return /\bnode-gyp\b/.test(`${install}\n${pre}`);
}

// `<!(cmd)` and `<!@(cmd)` are the commands node-gyp runs while it reads binding.gyp.
export function gypCommands(text: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "<" || text[i + 1] !== "!") continue;
    let j = i + 2;
    if (text[j] === "@") j++;
    if (text[j] !== "(") continue;
    j++;
    let depth = 1;
    const start = j;
    for (; j < text.length && depth > 0; j++) {
      if (text[j] === "(") depth++;
      else if (text[j] === ")") depth--;
    }
    if (depth === 0) out.push(text.slice(start, j - 1));
    i = j - 1;
  }
  return out;
}

function envPathValue(v: string): boolean {
  if (!v || v.length > 240 || /\s/.test(v) || v.includes("://") || v.startsWith("/") || /^[A-Za-z]:[\\/]/.test(v)) return false;
  if (v.startsWith("./") || v.startsWith("../") || v.includes("/")) return true;
  return /\.(?:js|cjs|mjs|node|sh)$/i.test(v);
}

// A hook file that loads `process.env.npm_package_*` reads that value at install time.
// Only a path-shaped value is a file. A version string is not.
export function hookEnvPaths(text: string, pj: Record<string, unknown>): string[] {
  const env = npmPackageEnv(pj);
  const out: string[] = [];
  const re = /process\.env(?:\.|\s*\[\s*["'])npm_package_([A-Za-z0-9_]+)/g;
  for (const m of text.matchAll(re)) {
    const v = env.get(`npm_package_${m[1]}`);
    if (v && envPathValue(v)) out.push(v);
  }
  return out;
}

function npmInstallScripts(bytes: Uint8Array | undefined): Record<string, string> {
  if (!bytes) return {};
  try {
    const pj = JSON.parse(dec.decode(bytes)) as unknown;
    if (!pj || typeof pj !== "object") return { "<unparseable>": "package.json did not parse" };
    return expandNpmScripts(pj as Record<string, unknown>, NPM_INSTALL_SCRIPTS);
  } catch {
    return { "<unparseable>": "package.json did not parse" };
  }
}

function resolveMention(files: FileMap, token: string): string | undefined {
  const rel = token.replace(/^\.\//, "");
  if (!rel || rel.startsWith("/") || rel.split("/").includes("..")) return undefined;
  const bases = rel.startsWith("package/") ? [rel] : [rel, `package/${rel}`];
  for (const base of bases) {
    if (files.has(base)) return base;
    for (const ext of [".js", ".json", ".node", ".cjs", ".mjs"]) {
      if (files.has(base + ext)) return base + ext;
      if (files.has(`${base}/index${ext}`)) return `${base}/index${ext}`;
    }
  }
  return undefined;
}

// require('./rel') and `node ./file.js` inside a hook, even when eval does not close them.
function mentionFiles(files: FileMap, scripts: Record<string, string>): string[] {
  const text = Object.values(scripts).join("\n");
  const out: string[] = [];
  for (const m of text.matchAll(/['"](\.[^'"]+)['"]/g)) {
    const hit = resolveMention(files, m[1] ?? "");
    if (hit) out.push(hit);
  }
  for (const m of text.matchAll(/(?:^|[\s;&|])node\s+(\.\/\S+|\S+\.(?:js|cjs|mjs))/g)) {
    const hit = resolveMention(files, m[1] ?? "");
    if (hit) out.push(hit);
  }
  return out;
}

function reachedFiles(files: FileMap, view: ReturnType<typeof installView>): Set<string> {
  const found = new Set<string>(view.files);
  for (const k of view.gypFiles) found.add(k);
  if (view.gyp) found.add(view.gyp);
  for (const k of mentionFiles(files, view.scripts)) found.add(k);
  return found;
}

function bundledStamp(files: FileMap): string {
  const lines: string[] = [];
  for (const key of [...files.keys()].sort()) {
    if (!key.split("/").includes("node_modules") || !key.endsWith("package.json")) continue;
    try {
      const v = JSON.parse(dec.decode(files.get(key))) as { scripts?: Record<string, unknown> };
      const scripts = v.scripts ?? {};
      lines.push(`${key} ${NPM_INSTALL_SCRIPTS.map((k) => `${k}=${typeof scripts[k] === "string" ? scripts[k] : ""}`).join(" ")}`);
    } catch {
      lines.push(`${key} <unparseable>`);
    }
  }
  return lines.join("\n");
}

function outsideKeys(files: FileMap): string[] {
  const keys = [...files.keys()];
  if (!keys.some((k) => k.startsWith("package/"))) return [];
  return keys.filter((k) => !k.startsWith("package/"));
}

function installClosureSignals(oldFiles: FileMap, newFiles: FileMap): Signal[] {
  const oldV = installView(oldFiles);
  const newV = installView(newFiles);
  const path = newV.manifest || oldV.manifest || "package.json";
  const out: Signal[] = [];
  const seen = new Set<string>();
  const push = (detail: string) => {
    if (seen.has(detail)) return;
    seen.add(detail);
    out.push({ kind: "install-script", path, detail: detail.slice(0, 200) });
  };
  for (const k of new Set([...Object.keys(oldV.scripts), ...Object.keys(newV.scripts)])) {
    if (oldV.scripts[k] !== newV.scripts[k]) push(`script ${k}`);
  }
  const missN = new Set(newV.missing);
  for (const p of oldV.missing) if (!missN.has(p)) push(`file ${p}`);
  const missO = new Set(oldV.missing);
  for (const p of newV.missing) if (!missO.has(p)) push(`file ${p}`);
  // A retarget reaches a different key even when both files sit in both trees.
  const oldReached = reachedFiles(oldFiles, oldV);
  const newReached = reachedFiles(newFiles, newV);
  for (const k of oldReached) if (!newReached.has(k)) push(`file ${k}`);
  for (const k of newReached) if (!oldReached.has(k)) push(`file ${k}`);
  for (const k of oldReached) {
    if (!newReached.has(k)) continue;
    const a = oldFiles.get(k);
    const b = newFiles.get(k);
    if (!a || !b || !bytesEqual(a, b)) push(`file ${k}`);
  }
  if (bundledStamp(oldFiles) !== bundledStamp(newFiles)) push("bundled");
  for (const k of new Set([...outsideKeys(oldFiles), ...outsideKeys(newFiles)])) {
    const a = oldFiles.get(k);
    const b = newFiles.get(k);
    if (!a || !b || !bytesEqual(a, b)) push(`file ${k}`);
  }
  if ((oldV.hook || newV.hook) && oldV.binStamp !== newV.binStamp) push("bin");
  // The surface matched. A cap still holds, because the closure above is incomplete.
  // A download, an eval, or an unresolved runner does not.
  if (out.length === 0) {
    const cap = newV.hold ?? oldV.hold;
    if (cap && surfaceCap(cap)) push(cap);
  }
  return out;
}

const BUILD_INCLUDE_RE = /^\s*(data|data-files|data_files|include|force-include|shared-data|package-data|package_data)\s*=/;

export function prepass(eco: Ecosystem, oldFiles: FileMap, newFiles: FileMap): PrepassResult {
  const hard: Signal[] = [];
  const soft: Signal[] = [];
  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];

  for (const detail of new Set([...tarNotes(oldFiles), ...tarNotes(newFiles)])) {
    hard.push({ kind: "tar-entry", path: detail.split(" ").slice(1).join(" ") || "archive", detail: detail.slice(0, 200) });
  }

  for (const p of oldFiles.keys()) if (!newFiles.has(p)) removed.push(p);
  for (const [p, bytes] of newFiles) {
    const prev = oldFiles.get(p);
    if (!prev) added.push(p);
    else if (!bytesEqual(prev, bytes)) changed.push(p);
  }

  // A link named as a startup hook, or pointing outside the package, is hard whether or not it changed.
  for (const [p, bytes] of newFiles) {
    if (!isLink(bytes)) continue;
    const target = dec.decode(bytes);
    if (isPythonStartupHook(p)) hard.push({ kind: "link-startup-hook", path: p, detail: `symlink with a startup hook name; pip installs its target as the file: ${target.slice(0, 200)}` });
    else if (linkEscapes(artifactPath(newFiles, p), target)) hard.push({ kind: "link-outside", path: p, detail: `symlink outside the package: ${target.slice(0, 200)}` });
    else if (!oldFiles.has(p) || !bytesEqual(oldFiles.get(p)!, bytes)) soft.push({ kind: "symlink", path: p, detail: `symlink to ${target.slice(0, 160)}` });
  }

  if (eco === "pypi") {
    for (const p of added) {
      if (isPythonStartupHook(p)) hard.push({ kind: "startup-hook", path: p, detail: "new interpreter startup hook (.pth / sitecustomize / usercustomize)" });
    }
    for (const p of changed) {
      if (isPythonStartupHook(p)) soft.push({ kind: "startup-hook-changed", path: p, detail: "existing startup hook changed" });
    }
    for (const p of [...added, ...changed]) {
      const b = basename(p);
      if (b !== "pyproject.toml" && b !== "setup.cfg" && b !== "setup.py" && b !== "MANIFEST.in") continue;
      const lines = addedLines(oldFiles.has(p) ? dec.decode(oldFiles.get(p)!) : undefined, dec.decode(newFiles.get(p)!));
      for (const l of lines) {
        if (BUILD_INCLUDE_RE.test(l)) hard.push({ kind: "build-include", path: p, detail: `new build include: ${l.trim().slice(0, 200)}` });
      }
    }
  }

  if (eco === "npm") {
    const pj = [...newFiles.keys()].filter((p) => p.split("/").length <= 2 && basename(p) === "package.json");
    for (const p of pj) {
      const before = npmInstallScripts(oldFiles.get(p));
      const after = npmInstallScripts(newFiles.get(p));
      for (const [k, v] of Object.entries(after)) {
        if (before[k] !== v) hard.push({ kind: "install-script", path: p, detail: `${k}: ${v.slice(0, 200)}` });
      }
    }
    for (const signal of installClosureSignals(oldFiles, newFiles)) hard.push(signal);
  }

  for (const p of [...added, ...changed]) {
    const bytes = newFiles.get(p)!;
    if (bytes.length > 5_000_000) {
      soft.push({ kind: "large-file", path: p, detail: `${bytes.length} bytes, not scanned` });
      continue;
    }
    const lines = addedLines(oldFiles.has(p) ? dec.decode(oldFiles.get(p)!) : undefined, dec.decode(bytes));
    const seen = new Set<string>();
    for (const l of lines) {
      for (const { kind, re } of SOFT_PATTERNS) {
        if (seen.has(kind) || !re.test(l)) continue;
        seen.add(kind);
        soft.push({ kind, path: p, detail: l.trim().slice(0, 160) });
      }
    }
  }

  return { hard, soft, added, removed, changed };
}
