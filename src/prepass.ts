// Deterministic pre-pass over two unpacked release artifacts (old, new).
// Hard signals hold an update no matter what a model reviewer says; soft
// signals are handed to the reviewer as pointers. It reads bytes only.

export type FileMap = Map<string, Uint8Array>;
export type Ecosystem = "npm" | "pypi";

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

const HOOK_BINS = new Set(["node", "nodejs", "npm", "npx", "echo", "sh", "bash", "run", "run-s", "run-p", "run-script", "yarn", "pnpm", "bun"]);
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

// `*` is any run of characters, including empty and `/`. Every other character is literal.
// Two pointers, no RegExp: a run of stars cannot backtrack exponentially over the text.
export function starMatch(pattern: string, text: string): boolean {
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

function referencedScripts(argv: string[], scripts: Record<string, unknown>): string[] {
  let i = 0;
  while (i < argv.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[i]!)) i++;
  if (i >= argv.length) return [];
  const bin = binName(argv[i]!);
  const names: string[] = [];
  if (bin === "npm") {
    i++;
    while (i < argv.length && argv[i]!.startsWith("-")) i++;
    const sub = argv[i];
    if (sub !== "run" && sub !== "run-script") return [];
    i++;
    while (i < argv.length && argv[i]!.startsWith("-")) i++;
    const name = argv[i];
    if (name && !name.startsWith("-")) names.push(name);
    return names;
  }
  if (bin === "run-s" || bin === "run-p") {
    i++;
    const keys = Object.keys(scripts);
    for (; i < argv.length; i++) {
      const a = argv[i]!;
      if (a === "--") break;
      if (a.startsWith("-")) continue;
      if (a.includes("*")) {
        for (const k of keys) if (starMatch(a, k)) names.push(k);
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

// Install-hook text after `$npm_package_*` substitution, plus every `npm run` / `run-script` / `run-s` / `run-p` body it names.
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

const BUILD_INCLUDE_RE = /^\s*(data|data-files|data_files|include|force-include|shared-data|package-data|package_data)\s*=/;

export function prepass(eco: Ecosystem, oldFiles: FileMap, newFiles: FileMap): PrepassResult {
  const hard: Signal[] = [];
  const soft: Signal[] = [];
  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];

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
