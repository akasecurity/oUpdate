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
// stops at any paren, so a scan costs linear time.
const GO_IMPORT_C = /(?<![\w.])import(?:\s*\.|\s+(?:_|[A-Za-z_]\w*))?\s*"C"/;
const GO_IMPORT_GROUP = /(?<![\w.])import\s*\(([^()]*)\)/g;
const GO_C_TOKEN = /^(?:[_.]|[A-Za-z_]\w*)?"C"$/;
/**
 * Go source with its comments taken out (a block comment's newlines kept) and every string and rune turned into "" or ''
 * ("C" for a string that is exactly C, raw or not: the same import path), read in one pass the way the Go scanner reads
 * it: a backquote or a quote inside a comment or another string opens nothing. A carriage return is no line end in Go, so
 * it reads as a space.
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
      out += c === '"' && src.slice(i + 1, j) === "C" ? '"C"' : c + c;
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
  if (toml === undefined) return undefined;
  try {
    const build = (Bun.TOML.parse(toml) as { package?: { build?: unknown } }).package?.build;
    return typeof build === "string" ? build.replace(/^\.\//, "") : undefined;
  } catch {
    return cargoBuildScriptLines(toml);
  }
}

/** The line reader behind cargoBuildScript, for a Cargo.toml the TOML parser refuses. */
function cargoBuildScriptLines(toml: string): string | undefined {
  let inPackage = false;
  for (const raw of lines(toml)) {
    const l = raw.replace(/\s#[\s\S]*$/, "").trim();
    const sec = /^\[([^\]]+)\]$/.exec(l);
    if (sec) { inPackage = sec[1]!.trim() === "package"; continue; }
    if (!inPackage) continue;
    const m = /^build\s*=\s*(?:"([^"]+)"|'([^']+)')$/.exec(l);
    if (m) return (m[1] ?? m[2])!.replace(/^\.\//, "");
  }
  return undefined;
}

/** `seen`: the script paths already looked at in this release, so a script many manifests share is compared, and reported, once. */
function cargoSignals(oldFiles: FileMap, newFiles: FileMap, p: string, seen: Set<string>): Signal[] {
  const script = cargoBuildScript(text(newFiles, p));
  if (!script) return [];
  const dir = p.includes("/") ? p.slice(0, p.lastIndexOf("/") + 1) : "";
  const sp = posix.normalize(dir + script);
  if (!newFiles.has(sp)) return [];
  const named = cargoBuildScript(text(oldFiles, p)) === script;
  const prev = oldFiles.get(sp);
  // A build.rs is read on its own path (a new or changed one is raised there), and the crate root's build.rs runs with or
  // without the key. Followed from here: a script under another name, and a build.rs elsewhere that the manifest newly
  // names while it was already shipped (it did not run before, and its own path raises nothing when it is unchanged).
  if (isRustBuildScript(sp) && (sp === posix.normalize(dir + "build.rs") || named || !prev || !sameBytes(prev, newFiles.get(sp)))) return [];
  // A manifest that newly names the script is still reported; otherwise the script's bytes are compared once per path.
  if ((named || isRustBuildScript(sp)) && seen.has(sp)) return [];
  seen.add(sp);
  if (named && sameBytes(prev, newFiles.get(sp))) return [];
  const added = !named || !prev;
  return [{ kind: added ? "rust-build-script-added" : "rust-build-script-changed", path: sp, detail: `${added ? "new" : "changed"} custom build script named in ${p}; it runs at build time` }];
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
 * Where the new file drops a permissions block the old one had, so the repository or organization default (which can
 * be read-write) applies: the workflow level when a job is left with no block of its own (unless the old workflow
 * block was write-all, which no default exceeds), a job still present when the workflow level has none, and a new or
 * renamed job with no block when every old job had one.
 */
export function permissionsRemoved(oldSrc: string, newSrc: string): string[] {
  return removedBlocks(readWorkflow(oldSrc).perms, readWorkflow(newSrc).perms);
}
function removedBlocks(o: Permissions, n: Permissions): string[] {
  if (n.workflow) return [];
  const out: string[] = [];
  if (o.workflow && !o.workflow.has("write-all") && [...n.jobs.values()].some((s) => !s)) out.push("workflow");
  for (const [j, s] of o.jobs) if (s && n.jobs.has(j) && !n.jobs.get(j)) out.push(`job ${j}`);
  // A new or renamed job with no block of its own, where every old job had one (and no workflow block): the default
  // applies to a job where none did before.
  if (!o.workflow && o.jobs.size && [...o.jobs.values()].every((s) => s)) for (const [j, s] of n.jobs) if (!s && !o.jobs.has(j)) out.push(`job ${j}`);
  return out;
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
  const dropped = prev === undefined ? [] : removedBlocks(o.perms, n.perms);
  const parts = [
    ...(widened.length ? [`write access added: ${widened.slice(0, 6).join("; ")}`] : []),
    ...(dropped.length ? [`permissions removed, the repository default applies: ${dropped.slice(0, 6).join(", ")}`] : []),
  ];
  if (parts.length) out.push({ kind: "workflow-permissions-widened", path: p, detail: parts.join("; ").slice(0, 160) });
  const added = [...n.triggers].filter((t) => !o.triggers.has(t));
  if (added.length) out.push({ kind: "workflow-trigger-added", path: p, detail: `new trigger: ${added.join(", ")}` });
  return out;
}

/** Soft signals for a new or changed build.rs (or Cargo.toml custom build script), Go generate / cgo, and workflow permission or trigger changes. Never hard. */
export function ecosystemSignals(oldFiles: FileMap, newFiles: FileMap): Signal[] {
  const out: Signal[] = [];
  const cargoSeen = new Set<string>();
  for (const p of newFiles.keys()) {
    if (isRustBuildScript(p)) out.push(...rustSignals(oldFiles, newFiles, p));
    else if (base(p) === "Cargo.toml") out.push(...cargoSignals(oldFiles, newFiles, p, cargoSeen));
    else if (isGoSource(p)) out.push(...goSignals(oldFiles, newFiles, p));
    else if (isWorkflowFile(p)) out.push(...workflowSignals(oldFiles, newFiles, p));
  }
  return out;
}
