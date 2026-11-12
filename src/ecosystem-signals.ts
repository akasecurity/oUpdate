import { posix } from "node:path";
import { bytesEqual, LARGE_FILE_BYTES, type FileMap, type Signal } from "./prepass.ts";

// Soft signals for build-time and CI surfaces that a release can ship inside an npm or PyPI artifact:
// a Rust build script, Go code generation or cgo, and GitHub Actions workflow files. Each only points the
// reviewer at the file; none is a hold. Read as text, by path and by the lines the release adds.

const dec = new TextDecoder("utf-8", { fatal: false });

const base = (p: string) => p.slice(p.lastIndexOf("/") + 1);
const text = (f: FileMap, p: string) => {
  const b = f.get(p);
  // Over the cap the pre-pass already raises large-file; read nothing past it, the same line.
  return b && b.length <= LARGE_FILE_BYTES ? dec.decode(b) : undefined;
};

/** A Rust build script (build.rs) runs at build time, before any of the crate's own code. */
export const isRustBuildScript = (p: string) => base(p) === "build.rs";
/** A Go source file. `go generate` reads test files too; cgo does not build in them. */
export const isGoSource = (p: string) => p.endsWith(".go");
const isGoTest = (p: string) => p.endsWith("_test.go");
/** A workflow file under .github/workflows, or an action.yml / action.yaml (a composite or JavaScript action). */
export const isWorkflowFile = (p: string) => /(^|\/)\.github\/workflows\/[^/]+\.ya?ml$/.test(p) || /(^|\/)action\.ya?ml$/.test(p);

const GO_GENERATE = /^\s*\/\/go:generate\b/;
// Read on goCode's output, where every string is "" except the path "C". A one-path import: `import`, an optional name
// (`.`, which needs no space, or `_` or an identifier after one), then "C". An import group: its contents to the closing
// paren, split into tokens; a path with its name may be one token (`_"C"`). Both start only at the keyword, and the group
// stops at any paren, so a scan costs linear time. A Go identifier is Unicode letters, digits and _, so the keyword's
// boundary and a name are read with Unicode classes (a field named αimport is no import).
const GO_IMPORT_C = /(?<![\p{L}\p{Nd}_.])import(?:\s*\.|\s+[\p{L}_][\p{L}\p{Nd}_]*)?\s*"C"/u;
const GO_IMPORT_GROUP = /(?<![\p{L}\p{Nd}_.])import\s*\(([^()]*)\)/gu;
const GO_C_TOKEN = /^(?:\.|[\p{L}_][\p{L}\p{Nd}_]*)?"C"$/u;
// An interpreted string that is one escape for C (\x43, \103, \u0043, \U00000043) unquotes to the same import path.
const GO_ESCAPED_C = /^\\(?:x43|103|u0043|U00000043)$/;
/**
 * Go source with its comments taken out (a block comment's newlines kept) and every string and rune turned into "" or ''
 * ("C" for a string that is exactly C, raw or not, or one escape for it: the same import path), read in one pass the way
 * the Go scanner reads it: a backquote or a quote inside a comment or another string opens nothing. A carriage return is
 * no line end in Go, so it reads as a space.
 */
function goCode(src: string): string {
  let out = "";
  let i = 0;
  let from = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i]!;
    if (c === "/" && src[i + 1] === "/") {
      out += src.slice(from, i);
      const e = src.indexOf("\n", i);
      i = from = e < 0 ? n : e;
    } else if (c === "/" && src[i + 1] === "*") {
      out += src.slice(from, i) + " ";
      const e = src.indexOf("*/", i + 2);
      const end = e < 0 ? n : e + 2;
      out += src.slice(i, end).replace(/[^\n]+/g, "");
      i = from = end;
    } else if (c === "`") {
      out += src.slice(from, i);
      const e = src.indexOf("`", i + 1);
      const end = e < 0 ? n : e + 1;
      out += src.slice(i + 1, end - 1).replace(/\r/g, "") === "C" ? '"C"' : '""';
      i = from = end;
    } else if (c === '"' || c === "'") {
      // An interpreted string or a rune: to its closing quote, past escapes, never past a newline.
      out += src.slice(from, i);
      let j = i + 1;
      while (j < n && src[j] !== c && src[j] !== "\n") j += src[j] === "\\" ? 2 : 1;
      const body = src.slice(i + 1, j);
      out += c === '"' && (body === "C" || GO_ESCAPED_C.test(body)) ? '"C"' : c + c;
      i = from = Math.min(j + 1, n);
    } else i++;
  }
  return (out + src.slice(from)).replace(/\r/g, " ");
}
// Known limit: a .c, .s or .h file added beside an existing import "C" is compiled by cgo but raises nothing here.
const hasImportC = (src: string) => {
  const t = goCode(src);
  if (GO_IMPORT_C.test(t)) return true;
  for (const g of t.matchAll(GO_IMPORT_GROUP)) if (g[1]!.split(/[\s;]+/).some((tok) => GO_C_TOKEN.test(tok))) return true;
  return false;
};
const GO_CGO_LINE = /^(?:\/\/\s*)?#cgo\b/;

const lines = (t: string | undefined) => (t ?? "").split(/\r?\n/);
const lineSet = (t: string | undefined) => new Set(lines(t).map((l) => l.trim()));
const fresh = (before: Set<string>, now: string, re: RegExp) => lines(now).map((l) => l.trim()).filter((l) => re.test(l) && !before.has(l));

const sameBytes = (a: Uint8Array | undefined, b: Uint8Array | undefined) => !!a && !!b && bytesEqual(a, b);

function rustSignals(oldFiles: FileMap, newFiles: FileMap, p: string): Signal[] {
  const prev = oldFiles.get(p);
  const now = newFiles.get(p)!;
  if (sameBytes(prev, now)) return [];
  return [{ kind: prev ? "rust-build-script-changed" : "rust-build-script-added", path: p, detail: prev ? "build.rs changed; it runs at build time" : "new build.rs; it runs at build time" }];
}

/** The custom build script a Cargo.toml names under [package] (`build = "<path>"`), relative to the crate; undefined for none or the default. */
export function cargoBuildScript(toml: string | undefined): string | undefined {
  const key = cargoBuildKey(toml);
  return typeof key === "string" ? key : undefined;
}

/**
 * The [package] build key: the script path it names, false when it turns the build script off, undefined when absent
 * (or true: the crate root's build.rs).
 * A list of scripts (build = ["a.rs", "b.rs"], an unstable Cargo form) reads as undefined here, so the crate root's
 * build.rs is followed as usual; cargoBuildList reads the list and cargoListSignals raises a soft signal for it and for
 * each listed script that is added or changed.
 * Known limit: whether Cargo accepts a list, and which listed script runs, is not checked; every listed file is treated
 * as a script that runs.
 */
function cargoBuildKey(toml: string | undefined): string | false | undefined {
  if (toml === undefined) return undefined;
  try {
    const build = (Bun.TOML.parse(toml) as { package?: { build?: unknown } }).package?.build;
    return typeof build === "string" ? build.replace(/^\.\//, "") : build === false ? false : undefined;
  } catch {
    return cargoBuildKeyLines(toml);
  }
}

/** The line reader behind cargoBuildKey, for a Cargo.toml the TOML parser refuses. */
function cargoBuildKeyLines(toml: string): string | false | undefined {
  let inPackage = false;
  for (const raw of lines(toml)) {
    const l = raw.replace(/\s#[\s\S]*$/, "").trim();
    const sec = /^\[([^\]]+)\]$/.exec(l);
    if (sec) { inPackage = sec[1]!.trim() === "package"; continue; }
    if (!inPackage) continue;
    if (/^build\s*=\s*false$/.test(l)) return false;
    const m = /^build\s*=\s*(?:"([^"]+)"|'([^']+)')$/.exec(l);
    if (m) return (m[1] ?? m[2])!.replace(/^\.\//, "");
  }
  return undefined;
}

/** The strings of a TOML array, from just after its opening bracket to the closing one: basic and literal strings, comments
 * skipped, one pass. An unterminated string is dropped. */
function tomlStringArray(src: string): string[] {
  const out: string[] = [];
  const n = src.length;
  let i = 0;
  while (i < n) {
    const c = src[i]!;
    if (c === "]") break;
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && src[j] !== c && src[j] !== "\n") j += c === '"' && src[j] === "\\" ? 2 : 1;
      if (src[j] === c) out.push(src.slice(i + 1, j));
      i = j + 1;
    } else if (c === "#") {
      while (i < n && src[i] !== "\n") i++;
    } else i++;
  }
  return out;
}

const listEntry = (e: string) => e.trim().replace(/^\.\//, "");

/** The [package] build key when it is a list of scripts, the entries as written (a leading ./ removed); undefined when it
 * is not a list. Read with the TOML parser first, then a line reader for a Cargo.toml the parser refuses. */
function cargoBuildList(toml: string | undefined): string[] | undefined {
  if (toml === undefined) return undefined;
  try {
    const build = (Bun.TOML.parse(toml) as { package?: { build?: unknown } }).package?.build;
    return Array.isArray(build) ? build.filter((e): e is string => typeof e === "string").map(listEntry) : undefined;
  } catch {
    return cargoBuildListLines(toml);
  }
}

function cargoBuildListLines(toml: string): string[] | undefined {
  let inPackage = false;
  const all = lines(toml);
  for (let i = 0; i < all.length; i++) {
    const l = all[i]!.replace(/\s#[\s\S]*$/, "").trim();
    const sec = /^\[([^\]]+)\]$/.exec(l);
    if (sec) { inPackage = sec[1]!.trim() === "package"; continue; }
    if (!inPackage) continue;
    const m = /^build\s*=\s*\[/.exec(l);
    if (!m) continue;
    // The array may run over several lines: read from the bracket to its close.
    const first = all[i]!;
    const rest = first.slice(first.indexOf("[", first.indexOf("build")) + 1);
    return tomlStringArray([rest, ...all.slice(i + 1)].join("\n")).map(listEntry);
  }
  return undefined;
}

/**
 * Soft signals for a list-form build key. One on the manifest when the list is new or its entries changed (provided a
 * listed file ships), and one per listed script that is added (not named by the old manifest, or not in the old files) or
 * changed. A listed build.rs is read on its own path, as the string form is.
 */
function cargoListSignals(oldFiles: FileMap, newFiles: FileMap, p: string, unchanged: (path: string) => boolean): Signal[] {
  const list = cargoBuildList(text(newFiles, p));
  if (!list?.length) return [];
  const oldToml = text(oldFiles, p);
  const dir = p.includes("/") ? p.slice(0, p.lastIndexOf("/") + 1) : "";
  const norm = (e: string) => posix.normalize(dir + e);
  const paths = [...new Set(list.map(norm))].filter((sp) => newFiles.has(sp));
  if (!paths.length) return [];
  const oldList = cargoBuildList(oldToml);
  const oldScript = cargoBuildScript(oldToml);
  const oldNamed = new Set([...(oldList ?? []), ...(oldScript !== undefined ? [oldScript] : [])].map(norm));
  const out: Signal[] = [];
  const key = (l: string[]) => [...new Set(l.map(norm))].sort().join("\n");
  if (!oldList || key(oldList) !== key(list)) {
    const kind = oldList ? "rust-build-script-changed" : "rust-build-script-added";
    out.push({ kind, path: p, detail: `${oldList ? "changed" : "new"} list of custom build scripts in ${p}; they run at build time`.slice(0, 160) });
  }
  for (const sp of paths) {
    const named = oldNamed.has(sp);
    const prev = oldFiles.get(sp);
    // A script shipped before and unchanged raises nothing of its own: the list signal covers a newly listed one.
    if (prev && unchanged(sp)) continue;
    if (isRustBuildScript(sp) && (named || !prev || !unchanged(sp))) continue;
    const added = !named || !prev;
    out.push({ kind: added ? "rust-build-script-added" : "rust-build-script-changed", path: sp, detail: `${added ? "new" : "changed"} custom build script named in ${p}; it runs at build time` });
  }
  return out;
}

/** Per release: `seen`, the signal already reported for each build script path (one per path, however many manifests
 * name it, and a build.rs read on its own path counts); `same`, each path's old-versus-new byte comparison, made once
 * however many manifests share the script. */
type CargoState = { seen: Map<string, Signal>; same: Map<string, boolean> };
/** One signal per script path. A script that is new to one manifest and changed under another is reported as added
 * (it now runs where it did not): the added signal takes the place of the changed one, where that was reported. */
function oncePerPath(st: CargoState, sig: Signal | undefined): Signal[] {
  if (!sig) return [];
  const prev = st.seen.get(sig.path);
  if (!prev) {
    st.seen.set(sig.path, sig);
    return [sig];
  }
  if (prev.kind === "rust-build-script-changed" && sig.kind === "rust-build-script-added") Object.assign(prev, sig);
  return [];
}
function cargoSignals(oldFiles: FileMap, newFiles: FileMap, p: string, st: CargoState): Signal[] {
  const unchanged = (path: string) => {
    let v = st.same.get(path);
    if (v === undefined) st.same.set(path, (v = sameBytes(oldFiles.get(path), newFiles.get(path))));
    return v;
  };
  return [oncePerPath(st, cargoSignal(oldFiles, newFiles, p, unchanged)), ...cargoListSignals(oldFiles, newFiles, p, unchanged).map((s) => oncePerPath(st, s))].flat();
}
function cargoSignal(oldFiles: FileMap, newFiles: FileMap, p: string, unchanged: (path: string) => boolean): Signal | undefined {
  const key = cargoBuildKey(text(newFiles, p));
  if (key === false) return undefined;
  const oldToml = text(oldFiles, p);
  const oldKey = cargoBuildKey(oldToml);
  const dir = p.includes("/") ? p.slice(0, p.lastIndexOf("/") + 1) : "";
  const root = posix.normalize(dir + "build.rs");
  const runsRoot = (k: string | false | undefined) => k === undefined || (typeof k === "string" && posix.normalize(dir + k) === root);
  if (runsRoot(key)) {
    // The crate root's build.rs runs. A new one is raised on its own path; one the old manifest turned off, or passed over
    // for another script, starts running now: added, and said to be changed too when it is (in place of the changed signal
    // its own path raises).
    if (oldToml === undefined || runsRoot(oldKey) || !newFiles.has(root)) return undefined;
    const changed = !unchanged(root);
    if (changed && !oldFiles.has(root)) return undefined;
    const why = oldKey === false ? "no longer turns the build script off" : "no longer names another build script";
    return { kind: "rust-build-script-added", path: root, detail: `build.rs now runs${changed ? ", changed" : ""}: ${p} ${why}`.slice(0, 160) };
  }
  const sp = posix.normalize(dir + key!);
  if (!newFiles.has(sp)) return undefined;
  // Compared as normalized paths: "./gen.rs" and "gen.rs" are the same script.
  const oldScript = cargoBuildScript(oldToml);
  const named = oldScript !== undefined && posix.normalize(dir + oldScript) === sp;
  const prev = oldFiles.get(sp);
  // A build.rs is read on its own path (a new or changed one is raised there). Followed from here: a script under another
  // name, and a build.rs elsewhere that the manifest newly names while it was already shipped (it did not run before, and
  // its own path raises nothing when it is unchanged).
  if (isRustBuildScript(sp) && (named || !prev || !unchanged(sp))) return undefined;
  if (named && unchanged(sp)) return undefined;
  const added = !named || !prev;
  return { kind: added ? "rust-build-script-added" : "rust-build-script-changed", path: sp, detail: `${added ? "new" : "changed"} custom build script named in ${p}; it runs at build time` };
}

function goSignals(oldFiles: FileMap, newFiles: FileMap, p: string): Signal[] {
  const now = text(newFiles, p);
  if (now === undefined) return [];
  const prev = text(oldFiles, p);
  const before = lineSet(prev);
  const out: Signal[] = [];
  const gen = fresh(before, now, GO_GENERATE);
  if (gen.length) out.push({ kind: "go-generate-added", path: p, detail: gen[0]!.slice(0, 160) });
  if (!isGoTest(p) && hasImportC(now)) {
    const cgo = fresh(before, now, GO_CGO_LINE);
    const newImport = prev === undefined || !hasImportC(prev);
    if (newImport || cgo.length) out.push({ kind: "go-cgo-added", path: p, detail: (cgo[0] ?? 'import "C"').slice(0, 160) });
  }
  return out;
}

// Workflows are read with the YAML parser; the line reader below is the fallback for a file it refuses, so broken YAML is still checked.
// Known limit: a workflow file inside a package never runs for the people who install it; the signal is for a reviewer reading the release, or a repo built from it.
// [\s\S]* (not .*) to the end: . stops at a lone \r, and $ would then fail and retry from every later "#".
const stripComment = (l: string) => l.replace(/(^|\s)#[\s\S]*$/, "$1");
const indentOf = (l: string) => l.length - l.trimStart().length;
/** A YAML scalar without its surrounding single or double quotes. */
const unq = (v: string) => v.trim().replace(/^(["'])(.*)\1$/, "$2");
// A key, quoted or not, at the start of a line or after a list dash: group 1 the dash, 2 the key, 3 the rest.
const KEY = /^\s*(-\s+)?["']?([A-Za-z0-9_-]+)["']?\s*:(?:\s+([\s\S]*)|\s*)$/;
// A "<scope>: write" pair inside a flow map; the key and the value may be quoted. A match starts only where a name starts
// (the lookbehind), so a long run of letters is not retried from every position inside it.
const FLOW_WRITE = /(?<![A-Za-z-])["']?([A-Za-z-]+)["']?\s*:\s*["']?write["']?\s*(?=[,}]|$)/g;
// A value that opens a block scalar (`|`, `>`, with chomping or indent marks).
const BLOCK_SCALAR = /(?::|^\s*-)\s+[|>][-+0-9]*\s*$/;
// Keys whose contents are data (action inputs, environment, outputs), never a grant.
const DATA_KEYS = new Set(["with", "env", "inputs", "outputs"]);

/** The column of a line's key: past a list dash, if there is one. */
const keyCol = (l: string) => {
  const m = /^(\s*-\s+)["']?[A-Za-z0-9_-]+["']?\s*:/.exec(l);
  return m ? m[1]!.length : indentOf(l);
};
/** Scan one line for flow brackets outside quoted strings: the change in depth, and the quote still open at its end. */
const scanBrackets = (l: string, quote: string): { delta: number; quote: string } => {
  let d = 0;
  let q = quote;
  for (const c of l) {
    if (q) { if (c === q) q = ""; }
    else if (c === '"' || c === "'") q = c;
    else if (c === "[" || c === "{") d++;
    else if (c === "]" || c === "}") d--;
  }
  return { delta: d, quote: q };
};
/** A flow value is joined over at most this many following non-blank lines. */
const MAX_FLOW_JOIN = 200;

/**
 * The YAML lines that carry structure: comments cut, blank lines and block scalar bodies dropped, a flow value spread over
 * lines joined into one. The bracket depth is kept as lines are added (never a rescan of the joined text), and a join stops
 * at a line back at indent 0 (a closing ] or } there still belongs to it) or after MAX_FLOW_JOIN non-blank lines, so an
 * unclosed bracket costs linear time and does not swallow the rest of the file.
 */
function yamlLogical(src: string): string[] {
  // YAML ends a line at a lone \r too (a Go or TOML reader does not).
  const raw = src.split(/\r\n|\r|\n/).map(stripComment);
  const out: string[] = [];
  let scalarCol = -1;
  for (let i = 0; i < raw.length; i++) {
    let l = raw[i]!;
    if (!l.trim()) continue;
    if (scalarCol >= 0 && indentOf(l) > scalarCol) continue;
    scalarCol = -1;
    let { delta: depth, quote } = scanBrackets(l, "");
    const parts = [l];
    for (let n = 0; depth > 0 && n < MAX_FLOW_JOIN && i + 1 < raw.length; ) {
      const next = raw[i + 1]!;
      const t = next.trim();
      if (t && indentOf(next) === 0 && !/^[\]}]/.test(t)) break;
      i++;
      if (!t) continue;
      n++;
      parts.push(t);
      const r = scanBrackets(t, quote);
      depth += r.delta;
      quote = r.quote;
    }
    l = parts.join(" ");
    out.push(l);
    if (BLOCK_SCALAR.test(l)) scalarCol = keyCol(l);
  }
  return out;
}

/** The write grants of each permissions block: the workflow level (undefined: no block) and each job's own block. */
interface Permissions {
  workflow?: Set<string>;
  jobs: Map<string, Set<string> | undefined>;
}
interface Workflow {
  perms: Permissions;
  triggers: Set<string>;
}

// Triggers that run with the base repository's token and secrets on an event an outside user can cause (opening an issue
// or a discussion, or commenting on one, needs no write access).
const RISKY = new Set(["pull_request_target", "workflow_run", "issue_comment", "pull_request_review_comment", "issues", "discussion", "discussion_comment"]);
const isMap = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** "write-all" and "<scope> write" from a parsed permissions value. */
function grantsOf(v: unknown): Set<string> {
  const out = new Set<string>();
  if (v === "write-all") out.add("write-all");
  else if (isMap(v)) for (const [k, x] of Object.entries(v)) if (x === "write") out.add(`${k} write`);
  return out;
}

/** A workflow or action file read with the YAML parser (anchors resolved); the line reader when the parser refuses it. */
function readWorkflow(src: string): Workflow {
  let doc: unknown;
  try {
    doc = Bun.YAML.parse(src);
  } catch {
    return { perms: linesPermissions(src), triggers: linesTriggers(src) };
  }
  // Several documents (an array) are no workflow the parser can place: read them as lines. An empty file or a scalar holds nothing.
  if (Array.isArray(doc)) return { perms: linesPermissions(src), triggers: linesTriggers(src) };
  if (!isMap(doc)) return { perms: { jobs: new Map() }, triggers: new Set() };
  const jobs = new Map<string, Set<string> | undefined>();
  if (isMap(doc.jobs)) for (const [name, job] of Object.entries(doc.jobs)) jobs.set(name, isMap(job) && Object.hasOwn(job, "permissions") ? grantsOf(job.permissions) : undefined);
  const on = doc.on;
  const names = typeof on === "string" ? [on] : Array.isArray(on) ? on.filter((x): x is string => typeof x === "string") : isMap(on) ? Object.keys(on) : [];
  return {
    perms: { workflow: Object.hasOwn(doc, "permissions") ? grantsOf(doc.permissions) : undefined, jobs },
    triggers: new Set(names.filter((n) => RISKY.has(n))),
  };
}

/** The line reader's permissions: for a file the YAML parser refuses. */
function linesPermissions(src: string): Permissions {
  const r: Permissions = { jobs: new Map() };
  const ls = yamlLogical(src);
  let dataCol = -1;
  let inJobs = false;
  let jobCol = -1;
  let job = "";
  // The block permissions key whose lines are being read: one pass, closed when a line comes back to its column.
  let open: { col: number; set: Set<string> } | undefined;
  for (let i = 0; i < ls.length; i++) {
    const l = ls[i]!;
    const ind = indentOf(l);
    if (open && ind <= open.col) open = undefined;
    if (dataCol >= 0 && ind > dataCol) continue;
    dataCol = -1;
    const k = KEY.exec(l);
    if (open && k && k[3] !== undefined && unq(k[3]) === "write") open.set.add(`${k[2]} write`);
    if (ind === 0) {
      inJobs = !!k && k[2] === "jobs" && !k[3];
      jobCol = -1;
      job = "";
    } else if (inJobs) {
      if (jobCol < 0) jobCol = ind;
      if (ind === jobCol && k && !k[1]) { job = k[2]!; r.jobs.set(job, undefined); continue; }
    }
    if (!k) continue;
    const col = keyCol(l);
    if (DATA_KEYS.has(k[2]!) && !k[3]) { dataCol = col; continue; }
    // A permissions key inside an open block is one of its lines: the outer block stays open and keeps its grants.
    if (k[2] !== "permissions" || open) continue;
    const set = new Set<string>();
    if (ind === 0) r.workflow = set;
    else if (job) r.jobs.set(job, set);
    const rest = (k[3] ?? "").trim();
    if (unq(rest) === "write-all") set.add("write-all");
    else if (rest.startsWith("{")) for (const g of rest.matchAll(FLOW_WRITE)) set.add(`${g[1]} write`);
    else if (!rest) open = { col, set };
  }
  return r;
}

/** Every write grant a workflow or action file holds, at the workflow level or in any job: "write-all" and "<scope> write". */
export function workflowWriteGrants(src: string): Set<string> {
  const { workflow, jobs } = readWorkflow(src).perms;
  return new Set([...(workflow ?? []), ...[...jobs.values()].flatMap((s) => [...(s ?? [])])]);
}

/**
 * The grants the new file adds, per effective scope. The workflow block against the old workflow block (an old
 * workflow-level write-all covers it). A job the old file also had, against its own old block, or the old workflow block
 * when it had none. A new or renamed job, against the old grants pooled over the workflow block and every job (a job-level
 * write-all left out: it covers only its own job), so a renamed job or a grant moved between levels is no change.
 * Known limit: a job renamed while it widens to a grant some other old job had is not flagged.
 */
function widenedGrants(o: Permissions, n: Permissions): string[] {
  const ow = o.workflow ?? new Set<string>();
  const out = new Set<string>();
  const add = (s: Iterable<string>, base: Set<string>) => {
    if (!base.has("write-all")) for (const g of s) if (!base.has(g)) out.add(g);
  };
  add(n.workflow ?? [], ow);
  const pool = new Set([...ow, ...[...o.jobs.values()].flatMap((s) => [...(s ?? [])].filter((g) => g !== "write-all"))]);
  for (const [j, s] of n.jobs) {
    if (!s) continue;
    if (o.jobs.has(j)) add(s, o.jobs.get(j) ?? ow);
    else add(s, pool);
  }
  return [...out];
}

/**
 * Where the repository or organization default (which can be read-write) now applies and did not before: a permissions
 * block the old file had and the new one drops (the workflow level when a job is left with no block of its own, unless
 * the old workflow block was write-all, which no default exceeds; a job still present when the workflow level has none),
 * then a new or renamed job with no block of its own when every old job had one (nothing was removed there).
 */
export function permissionsRemoved(oldSrc: string, newSrc: string): string[] {
  const { removed, unset } = defaultApplies(readWorkflow(oldSrc).perms, readWorkflow(newSrc).perms);
  return [...removed, ...unset];
}
function defaultApplies(o: Permissions, n: Permissions): { removed: string[]; unset: string[] } {
  const removed: string[] = [];
  const unset: string[] = [];
  if (n.workflow) return { removed, unset };
  if (o.workflow && !o.workflow.has("write-all") && [...n.jobs.values()].some((s) => !s)) removed.push("workflow");
  for (const [j, s] of o.jobs) if (s && n.jobs.has(j) && !n.jobs.get(j)) removed.push(`job ${j}`);
  // A new or renamed job with no block of its own, where every old job had one (and no workflow block): the default
  // applies to a job where none did before.
  if (!o.workflow && o.jobs.size && [...o.jobs.values()].every((s) => s)) for (const [j, s] of n.jobs) if (!s && !o.jobs.has(j)) unset.push(`job ${j}`);
  return { removed, unset };
}

/** The risky triggers (pull_request_target, workflow_run, issue_comment, pull_request_review_comment, issues, discussion, discussion_comment) the file names under its top-level `on:` key. */
export const workflowTriggers = (src: string | undefined): Set<string> => readWorkflow(src ?? "").triggers;

/** The line reader's triggers, in the scalar, flow list, flow map, block list or block map form of `on:`. */
function linesTriggers(src: string): Set<string> {
  const out = new Set<string>();
  const add = (name: string) => RISKY.has(name) && out.add(name);
  const ls = yamlLogical(src);
  for (let i = 0; i < ls.length; i++) {
    const k = KEY.exec(ls[i]!);
    if (!k || k[1] || indentOf(ls[i]!) !== 0 || k[2] !== "on") continue;
    const rest = (k[3] ?? "").trim();
    if (rest.startsWith("[") || rest.startsWith("{")) {
      // Flow form: only the names at the first level, not a value nested inside one ({ workflow_run: { workflows: [x] } }).
      let depth = 0;
      let tok = "";
      for (const c of rest) {
        if (c === "[" || c === "{") { if (depth === 1) add(unq(tok)); depth++; tok = ""; }
        else if (c === "]" || c === "}") { if (depth === 1) add(unq(tok)); depth--; tok = ""; }
        else if (depth === 1 && (c === "," || c === ":")) { add(unq(tok)); tok = ""; }
        else if (depth === 1) tok += c;
      }
    } else if (rest) add(unq(rest));
    else {
      let childCol = -1;
      for (let j = i + 1; j < ls.length; j++) {
        const n = ls[j]!;
        const ind = indentOf(n);
        if (ind === 0) break;
        if (childCol < 0) childCol = ind;
        if (ind !== childCol) continue;
        const item = /^\s*-\s+([\s\S]*)$/.exec(n);
        if (item) add(unq(item[1]!));
        else {
          const c = KEY.exec(n);
          if (c) add(c[2]!);
        }
      }
    }
  }
  return out;
}

function workflowSignals(oldFiles: FileMap, newFiles: FileMap, p: string): Signal[] {
  const now = text(newFiles, p);
  if (now === undefined) return [];
  const prev = text(oldFiles, p);
  const n = readWorkflow(now);
  const o = readWorkflow(prev ?? "");
  const out: Signal[] = [];
  const widened = widenedGrants(o.perms, n.perms);
  const { removed, unset } = prev === undefined ? { removed: [], unset: [] } : defaultApplies(o.perms, n.perms);
  const parts = [
    ...(widened.length ? [`write access added: ${widened.slice(0, 6).join("; ")}`] : []),
    // Short labels, so all three parts and their names fit under the 160-character cut.
    ...(removed.length ? [`permissions removed, default applies: ${removed.slice(0, 6).join(", ")}`] : []),
    ...(unset.length ? [`no permissions block, default applies: ${unset.slice(0, 6).join(", ")}`] : []),
  ];
  if (parts.length) out.push({ kind: "workflow-permissions-widened", path: p, detail: parts.join("; ").slice(0, 160) });
  const added = [...n.triggers].filter((t) => !o.triggers.has(t));
  if (added.length) out.push({ kind: "workflow-trigger-added", path: p, detail: `new trigger: ${added.join(", ")}` });
  return out;
}

/** Soft signals for a new or changed build.rs (or Cargo.toml custom build script), Go generate / cgo, and workflow permission or trigger changes. Never hard. */
export function ecosystemSignals(oldFiles: FileMap, newFiles: FileMap): Signal[] {
  const out: Signal[] = [];
  const cargoState: CargoState = { seen: new Map(), same: new Map() };
  for (const p of newFiles.keys()) {
    if (isRustBuildScript(p)) out.push(...rustSignals(oldFiles, newFiles, p).flatMap((s) => oncePerPath(cargoState, s)));
    else if (base(p) === "Cargo.toml") out.push(...cargoSignals(oldFiles, newFiles, p, cargoState));
    else if (isGoSource(p)) out.push(...goSignals(oldFiles, newFiles, p));
    else if (isWorkflowFile(p)) out.push(...workflowSignals(oldFiles, newFiles, p));
  }
  return out;
}
