// Install-time closure of one npm artifact. A command we cannot reduce to a known
// form holds the release. Caps hold too: a long pattern, a glob we do not expand,
// or more keys than the star walk is allowed to touch.
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

const INSTALL = ["preinstall", "install", "postinstall", "prepare"] as const;
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
  files: Set<string>;
  gypFiles: Set<string>;
  missing: Set<string>;
  scripts: Record<string, string>;
  seen: Set<string>;
  scanned: Set<string>;
  ranSh: Set<string>;
  depth: number;
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

function words(cmd: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: string | undefined;
  for (const c of cmd) {
    if (quote) {
      if (c === quote) quote = undefined;
      else cur += c;
      continue;
    }
    if (c === "'" || c === '"') {
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

function normalize(token: string): string {
  let t = token;
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

function subst(ctx: Ctx, body: string): string | null {
  let out = "";
  for (let i = 0; i < body.length; ) {
    const c = body[i]!;
    if (c === "`") {
      fail(ctx, "unresolved: shell");
      return null;
    }
    if (c === "$" && body[i + 1] === "(") {
      fail(ctx, "unresolved: shell");
      return null;
    }
    if (c === "$") {
      let key: string | undefined;
      let next = i + 1;
      if (body[next] === "{") {
        const end = body.indexOf("}", next + 1);
        if (end < 0) {
          fail(ctx, "unresolved: env");
          return null;
        }
        const m = /^npm_package_config_([A-Za-z0-9_]+)$/.exec(body.slice(next + 1, end));
        if (!m) {
          fail(ctx, "unresolved: env");
          return null;
        }
        key = m[1];
        next = end + 1;
      } else {
        const m = /^npm_package_config_([A-Za-z0-9_]+)/.exec(body.slice(next));
        if (!m) {
          fail(ctx, "unresolved: env");
          return null;
        }
        key = m[1];
        next += m[0]!.length;
      }
      const val = configVal(ctx, key!);
      if (val === undefined || !TOKEN.test(val) || val.split("/").includes("..")) {
        fail(ctx, "unresolved: env");
        return null;
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
      if (c === quote) quote = undefined;
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
    if (!rel || badPath(rel) || /[*?[]/.test(rel)) return undefined;
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
function followLoads(ctx: Ctx, key: string, text: string): void {
  const re = /(?:\brequire|\bimport)\(\s*(['"])([^'"]+)\1\s*\)|\bfrom\s+(['"])([^'"]+)\3|\bimport\s+(['"])([^'"]+)\5/g;
  for (const m of text.matchAll(re)) {
    if (ctx.hold) return;
    const spec = m[2] || m[4] || m[6] || "";
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
const LITERAL_LOAD = /(?:\brequire|\bimport)\(\s*(['"])([^'"]+)\1\s*\)|\bfrom\s+(['"])([^'"]+)\3|\bimport\s+(['"])([^'"]+)\5/g;
// Anything still able to name a file. module.exports is removed first; it is the static CJS assignment.
const UNSAFE_JS = /\brequire\b|import\s*\(|\bmodule\b|\bFunction\b|\beval\b|\bWorker\b|\bvm\b|\bchild_process\b|\bprocess\.binding\b|\bdlopen\b|\b(?:globalThis|global)\s*\[|\bconstructor\b|\bReflect\b|\bProxy\b/;
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
function stripLiteralLoad(spec: string): boolean {
  if (spec.startsWith(".") || spec.startsWith("/")) return true;
  const root = builtinRoot(spec);
  if (!root) return true;
  if (STATIC_BUILTINS.has(root)) return true;
  return !NODE_BUILTINS.has(root);
}

// One predicate for JS. A file that fails it widens by the shape of its computed loads.
function provablyStatic(text: string): boolean {
  let rest = text.replace(new RegExp(PLAIN_REQUIRE.source, "g"), "");
  rest = rest.replace(new RegExp(LITERAL_LOAD.source, "g"), (full, _a, spec1, _b, spec2, _c, spec3) => {
    const spec = String(spec1 || spec2 || spec3 || "");
    return stripLiteralLoad(spec) ? "" : full;
  });
  rest = rest.replace(/\bmodule\s*\.\s*exports\b/g, "");
  return !UNSAFE_JS.test(rest);
}

// exec/eval/compile, a dynamic import, or a loader that runs another file.
// A static `import helper` does not match. Docs stay out unless a literal names them.
function runsOtherFile(text: string): boolean {
  if (/\b(?:exec|eval|compile)\s*\(/.test(text)) return true;
  if (/\b(?:__import__|importlib|import_module|execfile|runpy|run_path|load_source|SourceFileLoader)\b/.test(text)) return true;
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
  if (!key) {
    ctx.missing.add(logical);
    return;
  }
  // The manifest is not a surface file. Hook text and bin are compared on their own,
  // and a version bump always changes these bytes.
  if (isManifest(key)) return;
  // A file the walk reached by name stays, including docs, markdown, and workflows.
  // Inert exclusion applies only inside widenAll, addBundled, and the same-directory widen.
  ctx.files.add(key);
  if (ctx.fromGyp) ctx.gypFiles.add(key);
  scanAdded(ctx, key);
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
  const tier = classifyJs(key, text);
  if (tier.all) widenEvery(ctx);
  else if (tier.pkg) widenPackage(ctx, tier.tests, tier.flows);
  else {
    if (tier.dirs.length === 0 || tier.same) addSameDir(ctx, key);
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

type JsTier = { all: boolean; pkg: boolean; tests: boolean; flows: boolean; same: boolean; dirs: string[]; lits: string[] };

// eval/Function/vm of a value we cannot see can load any file, docs included.
// A string literal or a read of a literal path is not that shape.
function hasUnbounded(text: string): boolean {
  const re = /\b(?:eval|Function)\s*\(|\bvm\s*\.\s*(?:runInThisContext|runInNewContext|runInContext|compileFunction)\s*\(/g;
  const ok = new Set(["require", "fs", "path", "readFileSync", "readFile", "open", "__dirname", "__filename", "join", "resolve", "toString", "String", "utf8", "posix"]);
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

function classifyJs(fromKey: string, text: string): JsTier {
  const tier: JsTier = { all: false, pkg: false, tests: false, flows: false, same: false, dirs: [], lits: [] };
  if (hasUnbounded(text)) tier.all = true;
  const re = /(?:^|[^\w$])(?:require|import|fork|execFile|execFileSync)\s*\(/g;
  for (const m of text.matchAll(re)) {
    const paren = (m.index ?? 0) + m[0].lastIndexOf("(");
    const args = argsOf(text, paren);
    if (args === undefined) continue;
    mergeEffect(tier, effectOf(fromKey, firstArg(args)));
  }
  // A hit we do not classify can name any non-doc file, including tests and workflows.
  if (!tier.all && unclassifiedUnsafe(text)) {
    tier.pkg = true;
    tier.tests = true;
    tier.flows = true;
  }
  return tier;
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
  let t = p.trim();
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
function effectOf(fromKey: string, expr: string): JsEffect {
  const t = expr.trim();
  if (!t || /^[A-Za-z_$][\w$]*$/.test(t) || strLit(t) !== undefined) return { t: "none" };
  if (/Buffer\.from\s*\(|\bbase64\b|\batob\s*\(/.test(t)) return { t: "pkg", tests: true, flows: true };
  const call = matchCall(t);
  if (call && isJoinCallee(call.callee)) return effectOfJoin(fromKey, call.args, isResolveCallee(call.callee));
  if (t.includes("+") || t.startsWith("`")) return effectOfPlus(fromKey, t);
  if (/[([`]/.test(t)) return { t: "pkg", tests: true, flows: true };
  return { t: "none" };
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
  let t = token;
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

function noteHookArg(ctx: Ctx, token: string): void {
  // `.` is not a named file. Recording it would be an unresolved-path hold.
  // A glob still reaches addRef, so the glob and pattern-length caps stay holds.
  if (!token || token.startsWith("-")) return;
  const logical = normalize(token);
  if (!logical || badPath(logical)) return;
  markHookFile(ctx, token);
  addRef(ctx, token);
}

// No resolved file argument (python3 -c, rollup -c, cross-env, ./bin). Docs, tests, and
// workflows stay out. Files are recorded directly so a large package does not trip the depth cap.
function widenAll(ctx: Ctx): void {
  for (const [logical, key] of ctx.logical) {
    if (isManifest(logical) || omitInert(ctx, logical)) continue;
    ctx.files.add(key);
    if (ctx.fromGyp) ctx.gypFiles.add(key);
  }
}

// A resolved file is the entry, and its own scan closes what it names.
// No resolved file still widens to every non-inert file.
function closeUnknownRunner(ctx: Ctx, argv: string[], i: number): void {
  let resolved = false;
  for (let j = i; j < argv.length; j++) {
    const arg = argv[j]!;
    if (arg.startsWith("-")) continue;
    noteHookArg(ctx, arg);
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
  if (/[+`$]/.test(code) || code.includes("process.env") || !specs.length || !/^[\s;]*$/.test(rest)) {
    fail(ctx, "unresolved: eval");
  }
}

// A redirect aborts the split, but `node-gyp` later in that same hook still compiles.
// The redirect itself is not a hold. `node safe.js > out` does not name node-gyp.
function noteUnparsedCompile(ctx: Ctx, body: string): void {
  if (/(?:^|&&|\|\||[;&\n])\s*node-gyp(?![\w-])/.test(body)) ctx.sawNodeGyp = true;
}

function runBody(ctx: Ctx, body: string): void {
  if (ctx.hold) return;
  if (ctx.depth >= DEPTH) {
    fail(ctx, "unresolved: script depth");
    return;
  }
  if (body.includes("*") && ctx.fileCount > STAR_KEY_MAX) {
    fail(ctx, `key count ${ctx.fileCount} > ${STAR_KEY_MAX}`);
    return;
  }
  const sub = subst(ctx, body);
  if (sub === null || ctx.hold) return;
  const cmds = splitCommands(ctx, sub);
  if (!cmds) {
    noteUnparsedCompile(ctx, sub);
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
    if (!optional) fail(ctx, "unresolved: script");
    return;
  }
  if (ctx.seen.size >= DEPTH || ctx.depth >= DEPTH) {
    fail(ctx, "unresolved: script depth");
    return;
  }
  ctx.seen.add(name);
  ctx.scripts[name] = raw;
  if (raw.length === 0) return;
  ctx.depth++;
  runScript(ctx, `pre${name}`, true);
  runBody(ctx, raw);
  runScript(ctx, `post${name}`, true);
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

function dispatchNode(ctx: Ctx, argv: string[], i: number): void {
  while (i < argv.length) {
    if (ctx.hold) return;
    const a = argv[i]!;
    if (a === "--") {
      fail(ctx, "unresolved: flag");
      return;
    }
    if (a.startsWith("-")) {
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
      if (name === "--run") {
        const script = take();
        if (!script) return;
        runScript(ctx, script, false);
        i++;
        continue;
      }
      if (name === "-e" || name === "--eval" || name === "-p" || name === "--print") {
        const code = take();
        if (code === undefined) return;
        evalCode(ctx, code);
        i++;
        continue;
      }
      if (name === "-r" || name === "--require" || name === "--import") {
        const spec = take();
        if (!spec) return;
        noteHookArg(ctx, spec);
        i++;
        continue;
      }
      fail(ctx, "unresolved: flag");
      return;
    }
    noteHookArg(ctx, a);
    i++;
  }
}

function dispatchSh(ctx: Ctx, argv: string[], i: number): void {
  if (i >= argv.length || argv[i]!.startsWith("-") || i + 1 !== argv.length) {
    fail(ctx, "unresolved: shell");
    return;
  }
  const token = argv[i]!;
  noteHookArg(ctx, token);
  if (ctx.hold) return;
  const key = findKey(ctx, normalize(token));
  if (!key) {
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

function dispatch(ctx: Ctx, cmd: string): void {
  if (ctx.hold) return;
  const argv = words(cmd);
  let i = 0;
  if (i < argv.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[i]!)) {
    fail(ctx, "unresolved: env");
    return;
  }
  if (i >= argv.length) return;
  const bin = binName(argv[i]!);
  i++;
  if (bin === "echo" || bin === "true" || bin === ":") return;
  if (bin === "node" || bin === "nodejs") {
    dispatchNode(ctx, argv, i);
    return;
  }
  if (bin === "node-gyp") {
    // Any argument, including `rebuild`, is not a form we model. The gyp bytes
    // are still the file node-gyp reads.
    ctx.sawNodeGyp = true;
    if (i < argv.length) fail(ctx, "unresolved: node-gyp");
    return;
  }
  if (bin === "sh" || bin === "bash") {
    dispatchSh(ctx, argv, i);
    return;
  }
  if (bin === "npm") {
    const sub = readWord(ctx, argv, i);
    if (!sub || !sub.word) {
      if (!ctx.hold) fail(ctx, "unresolved: runner");
      return;
    }
    if (RUN_SUB.has(sub.word)) {
      const name = readWord(ctx, argv, sub.i + 1);
      if (!name || !name.word) {
        if (!ctx.hold) fail(ctx, "unresolved: script");
        return;
      }
      runScript(ctx, name.word, false);
      return;
    }
    if (sub.word === "test" || sub.word === "t" || sub.word === "tst") {
      runScript(ctx, "test", false);
      return;
    }
    if (sub.word === "start") {
      runScript(ctx, "start", false);
      return;
    }
    if (sub.word === "stop") {
      runScript(ctx, "stop", false);
      return;
    }
    if (sub.word === "restart") {
      restart(ctx);
      return;
    }
    fail(ctx, "unresolved: runner");
    return;
  }
  if (bin === "yarn" || bin === "pnpm" || bin === "bun") {
    const sub = readWord(ctx, argv, i);
    if (!sub || sub.word !== "run") {
      if (!ctx.hold) fail(ctx, "unresolved: runner");
      return;
    }
    const name = readWord(ctx, argv, sub.i + 1);
    if (!name || !name.word) {
      if (!ctx.hold) fail(ctx, "unresolved: script");
      return;
    }
    runScript(ctx, name.word, false);
    return;
  }
  if (bin === "run-s" || bin === "run-p" || bin === "npm-run-all") {
    dispatchRuns(ctx, argv, i);
    return;
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
  closeUnknownRunner(ctx, argv, i);
  fail(ctx, `unresolved: runner ${bin}`);
}

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
        fail(ctx, "unresolved: runner");
        return;
      }
      rel = next;
    } else if (a.startsWith("--patch-dir=")) rel = a.slice("--patch-dir=".length);
    else {
      fail(ctx, "unresolved: runner");
      return;
    }
    const logical = normalize(rel);
    if (!logical || badPath(logical) || /[*?[]/.test(logical)) {
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
  for (const cmd of gypCommands(text)) runBody(ctx, substGypVars(cmd, gypVars));
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
  for (const name of INSTALL) {
    const raw = ctx.raw[name];
    if (typeof raw === "string") ctx.scripts[name] = raw;
  }
  for (const name of INSTALL) {
    const raw = ctx.raw[name];
    if (typeof raw === "string" && raw.length > 0) runScript(ctx, name, false);
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
