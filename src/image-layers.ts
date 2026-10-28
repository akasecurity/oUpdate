// What `oupdate image` shows a reviewer beyond the config: the difference between two images' layer contents.
// Only the layers the two images do not share are read in full; a path that either tail touches is resolved on both sides
// (oci-fs.ts) and compared by metadata, then bytes. The package database diff stands for the files a package upgrade
// replaced; the rest is ranked (what runs first, startup and persistence paths, setuid files, unpackaged executables,
// new CA certificates, other changes) and cut into the same prompt-sized parts and scope tiers as a package review.

import type { ImageDetail, ImageLayers } from "./adapters/oci/registry.ts";
import { scanSurface } from "./apply/surface.ts";
import { benignBinary } from "./benign-binary.ts";
import { diffSeq, renderLineDiff } from "./linediff.ts";
import { ImageTree, LayerError, LIMITS, MergedIndex, type FsNode, type LayerStore } from "./oci-fs.ts";
import { SOFT_PATTERNS, type FileMap } from "./prepass.ts";
import { chunkDiff, hashedBinary, SCOPE_NOTE, type Scope } from "./review.ts";
import type { ImageEvidence } from "./targets/broker/answer.ts";

export interface LayerReview {
  /** Lines that follow today's history diff in part 1. */
  extra: string[];
  /** File-content parts, one reviewer call each. */
  parts: string[];
  /** Deterministic findings; each holds. */
  hits: string[];
  /** Set when the parts are narrower than the whole change: the review can stop but never land. */
  narrowed?: string;
  /** `layers: N read, M not read`. */
  summary: string;
}

export interface LayerBudget {
  chunkChars: number;
  maxParts: number;
}

export const LAYER_BUDGET: LayerBudget = { chunkChars: 60_000, maxParts: 12 };

const enc = new TextEncoder();
const dec = new TextDecoder("utf-8", { fatal: false });
const sha = (b: Uint8Array) => new Bun.CryptoHasher("sha256").update(b).digest("hex");
const isBinary = (b: Uint8Array) => b.subarray(0, 8000).includes(0);
const isElf = (b: Uint8Array) => b[0] === 0x7f && b[1] === 0x45 && b[2] === 0x4c && b[3] === 0x46;
const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && Buffer.compare(a, b) === 0;

/** The `+`/`-` lines between two string sets, sorted. */
function setDiff(label: string, o: string[], n: string[]): string[] {
  const os = new Set(o);
  const ns = new Set(n);
  return [...n.filter((x) => !os.has(x)).map((x) => `${label} +${x}`), ...o.filter((x) => !ns.has(x)).map((x) => `${label} -${x}`)];
}

/** ENV, USER, WORKDIR, VOLUME, HEALTHCHECK and ONBUILD changes, one line each. */
export function detailLines(o: ImageDetail, n: ImageDetail): string[] {
  const one = (label: string, a: string, b: string) => (a === b ? [] : [`${label} changed: ${a || "(none)"} -> ${b || "(none)"}`]);
  return [...setDiff("ENV", o.env, n.env), ...one("USER", o.user, n.user), ...one("WORKDIR", o.workdir, n.workdir), ...setDiff("VOLUME", o.volumes, n.volumes), ...one("HEALTHCHECK", o.healthcheck, n.healthcheck), ...setDiff("ONBUILD", o.onbuild, n.onbuild)];
}

type PkgKind = "apk" | "dpkg";
interface Packages {
  kind?: PkgKind;
  rpm: boolean;
  versions: Map<string, string>;
  /** Path -> package, where the database lists files (apk). */
  owner: Map<string, string>;
}

function parseApk(text: string): { versions: Map<string, string>; owner: Map<string, string> } {
  const versions = new Map<string, string>();
  const owner = new Map<string, string>();
  for (const block of text.split(/\n\n+/)) {
    let name = "";
    let dir = "";
    const files: string[] = [];
    for (const l of block.split("\n")) {
      if (l.startsWith("P:")) name = l.slice(2);
      else if (l.startsWith("V:") && name) versions.set(name, l.slice(2));
      else if (l.startsWith("F:")) dir = l.slice(2).replace(/\/+$/, "");
      else if (l.startsWith("R:")) files.push(dir ? `${dir}/${l.slice(2)}` : l.slice(2));
    }
    if (name) for (const f of files) owner.set(f, name);
  }
  return { versions, owner };
}

function parseDpkg(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const stanza of text.split(/\n\n+/)) {
    const field = (k: string) => new RegExp(`^${k}: (.*)$`, "m").exec(stanza)?.[1]?.trim();
    const name = field("Package");
    const status = field("Status");
    if (name && (!status || status.endsWith(" installed"))) out.set(name, `${field("Version") ?? ""}`);
  }
  return out;
}

async function readPath(tree: ImageTree, idx: MergedIndex, p: string): Promise<Uint8Array | undefined> {
  const n = idx.get(p);
  return n && n.type === "file" ? tree.read(n) : undefined;
}

const RPM_DB = ["var/lib/rpm/rpmdb.sqlite", "usr/lib/sysimage/rpm/rpmdb.sqlite"];

async function readPackages(tree: ImageTree, idx: MergedIndex): Promise<Packages> {
  const apk = await readPath(tree, idx, "lib/apk/db/installed");
  if (apk) return { kind: "apk", rpm: false, ...parseApk(dec.decode(apk)) };
  const dpkg = await readPath(tree, idx, "var/lib/dpkg/status");
  if (dpkg) return { kind: "dpkg", rpm: false, versions: parseDpkg(dec.decode(dpkg)), owner: new Map() };
  const rpm = RPM_DB.some((p) => idx.get(p) !== undefined);
  return { rpm, versions: new Map(), owner: new Map() };
}

/** dpkg's info/<package>.list files: every path a package owns. `only` limits which packages are read. */
async function readDpkgOwners(tree: ImageTree, idx: MergedIndex, into: Map<string, string>, only?: Set<string>): Promise<void> {
  for (const p of idx.under("var/lib/dpkg/info").sort()) {
    const m = /^var\/lib\/dpkg\/info\/([^/]+)\.list$/.exec(p);
    if (!m) continue;
    const name = m[1]!.replace(/:[^:]+$/, "");
    if (only && !only.has(name)) continue;
    const bytes = await readPath(tree, idx, p);
    if (!bytes) continue;
    for (const l of dec.decode(bytes).split("\n")) if (l.startsWith("/") && l.length > 1) into.set(l.slice(1), name);
  }
}

const pkgLines = (m: Map<string, string>) => [...m].map(([k, v]) => `${k} ${v}`).sort();

/** `name version` lines that differ, as +/- lines in order. */
function packageDiff(o: Packages, n: Packages): { lines: string[]; changed: Set<string> } {
  const ops = diffSeq(pkgLines(o.versions), pkgLines(n.versions));
  const changed = new Set<string>();
  const lines: string[] = [];
  for (const op of ops ?? [...pkgLines(o.versions).map((v) => ({ op: "-" as const, v })), ...pkgLines(n.versions).map((v) => ({ op: "+" as const, v }))]) {
    if (op.op === "=") continue;
    lines.push(`${op.op}${op.v}`);
    changed.add(op.v.slice(0, op.v.indexOf(" ")));
  }
  return { lines, changed };
}

// The bookkeeping files a package change rewrites, which the package diff stands for: exact names only, anchored at both ends.
const DB_PATH = /^(?:lib\/apk\/db\/installed|var\/lib\/dpkg\/(?:status|status-old|available|available-old|lock|lock-frontend|diversions|diversions-old|statoverride|statoverride-old)|var\/lib\/dpkg\/info\/[^/]+\.(?:list|md5sums|shlibs|symbols|triggers|conffiles))$|^(?:var\/cache\/apk\/|var\/lib\/apt\/lists\/|var\/cache\/apt\/)/;
// Maintainer scripts run as root at install: code, never bookkeeping.
const MAINT = /^var\/lib\/dpkg\/info\/[^/]+\.(?:preinst|postinst|prerm|postrm|config)$|^lib\/apk\/db\/(?:scripts\.tar|triggers)$/;
// Startup and persistence paths whose change is a finding of its own.
const HARD = /^etc\/(ld\.so\.preload$|init\.d\/|profile\.d\/|profile$|cron[^/]*(\/|$)|sudoers(\.d\/|$)|passwd$|shadow$|gshadow$)|^var\/spool\/cron\/|(^|\/)authorized_keys2?$|\.pth$|(^|\/)(sitecustomize|usercustomize)\.py$/;
// The persistence names judged by the file alone, whatever directory holds it.
const UNANCHORED_HARD = /(^|\/)authorized_keys2?$|\.pth$|(^|\/)(sitecustomize|usercustomize)\.py$/;
// Paths an image's init system starts: read first, and the line diff is what the reviewer judges.
const STARTUP = /^etc\/(s6-overlay\/|services\.d\/|cont-init\.d\/|cont-finish\.d\/|fix-attrs\.d\/)|^etc\/(systemd\/|pam\.d\/|pam\.conf$|security\/)|^init$|^docker-entrypoint/;
// The directory names a trust store lives in; the pattern and the ancestor test both come from this list.
const CA_DIRS = ["ca-certificates", "ssl/certs", "pki/ca-trust", "pki/tls/certs"];
const CA_CERT = new RegExp(`(^|\\/)(${CA_DIRS.map((d) => d.replace(/\//g, "\\/")).join("|")})\\/`);
/** A directory that is, or ends in, a leading part of a trust directory's name (ssl, pki, pki/tls): a link there reaches one. */
const caAncestor = (d: string) =>
  CA_DIRS.some((n) => {
    const segs = n.split("/");
    for (let k = 1; k < segs.length; k++) {
      const pre = segs.slice(0, k).join("/");
      if (d === pre || d.endsWith(`/${pre}`)) return true;
    }
    return false;
  });

/** The exact paths the HARD, STARTUP and MAINT patterns name (not a prefix or a directory): the directories above each are mandatory too. */
export const EXACT_MANDATORY = ["etc/ld.so.preload", "etc/profile", "etc/passwd", "etc/shadow", "etc/gshadow", "etc/sudoers", "etc/pam.conf", "init", "lib/apk/db/scripts.tar", "lib/apk/db/triggers"];
const EXACT_ANCESTORS = new Set(EXACT_MANDATORY.flatMap((p) => p.split("/").slice(0, -1).map((_, i, a) => a.slice(0, i + 1).join("/"))));

// Mandatory directory roots, so that a directory above one is important too.
const MANDATORY_ROOTS = ["etc/cron.d", "etc/init.d", "etc/profile.d", "etc/sudoers.d", "var/spool/cron", "etc/services.d", "etc/cont-init.d", "etc/cont-finish.d", "etc/s6-overlay", "etc/systemd", "etc/pam.d", "etc/security", "var/lib/dpkg/info", "usr/share/ca-certificates", "usr/local/share/ca-certificates"];

const oct = (m: number) => (m & 0o7777).toString(8).padStart(4, "0");

/**
 * What a directory's change looks like: a METADATA line for any change of mode or owner, and a hit when it weakens the
 * directory (a new write bit for the group or for others, a sticky bit dropped from a writable directory, or another owner) where that matters: `important` is a PATH directory,
 * one holding a start input, or a startup or persistence directory. A new directory is judged by its mode alone.
 */
export function dirChange(path: string, o: FsNode | undefined, n: FsNode, important: boolean): { line?: string; hit?: string } {
  const diffs = o ? [...(o.mode !== n.mode ? [`mode ${oct(o.mode)} -> ${oct(n.mode)}`] : []), ...(o.uid !== n.uid ? [`uid ${o.uid} -> ${n.uid}`] : []), ...(o.gid !== n.gid ? [`gid ${o.gid} -> ${n.gid}`] : [])] : [];
  const out: { line?: string; hit?: string } = {};
  if (diffs.length) out.line = `METADATA dir ${path}: ${diffs.join(", ")}`;
  if (!important) return out;
  const unsticky = !!o && (o.mode & 0o1000) !== 0 && (n.mode & 0o1000) === 0 && (n.mode & 0o022) !== 0;
  if ((n.mode & 0o022 & ~(o?.mode ?? 0)) !== 0 || unsticky) out.hit = `directory permissions weakened: ${path} (mode ${o ? `${oct(o.mode)} -> ` : ""}${oct(n.mode)})`;
  else if (o && (o.uid !== n.uid || o.gid !== n.gid)) out.hit = `directory owner changed: ${path} (uid ${o.uid} -> ${n.uid}, gid ${o.gid} -> ${n.gid})`;
  return out;
}

interface Change {
  path: string;
  o?: FsNode;
  n?: FsNode;
}

const sameMetadata = (a: FsNode, b: FsNode) => a.type === b.type && a.mode === b.mode && a.uid === b.uid && a.gid === b.gid && a.link === b.link;

/** Whether two entries are the same: the same metadata and, for a file, the same bytes (equal by layer and member, else read when the size matches). */
async function sameEntry(a: FsNode, b: FsNode, oldT: ImageTree, newT: ImageTree): Promise<boolean> {
  if (!sameMetadata(a, b)) return false;
  if (a.layer === b.layer && a.member === b.member) return true;
  if (a.type !== "file") return true;
  return a.size === b.size && sameBytes(await oldT.read(a), await newT.read(b));
}

/** The two images' physical entries compared one by one: what was added, removed or changed. No per-path layer probing. */
export async function diffIndexes(o: MergedIndex, n: MergedIndex, oldT: ImageTree, newT: ImageTree): Promise<Change[]> {
  const out: Change[] = [];
  for (const path of [...new Set([...o.nodes.keys(), ...n.nodes.keys()])].sort()) {
    if (!path) continue;
    const a = o.get(path);
    const b = n.get(path);
    if (a && b && (await sameEntry(a, b, oldT, newT))) continue;
    out.push({ path, o: a, n: b });
  }
  return out;
}

const linkText = (n: FsNode) => enc.encode(`symlink -> ${n.link ?? ""}`);

/** Entrypoint and Cmd words inspected; a longer command line holds. */
const MAX_START_WORDS = 256;
const DEFAULT_PATH = ["/usr/local/sbin", "/usr/local/bin", "/usr/sbin", "/usr/bin", "/sbin", "/bin"];

/**
 * The files the image starts. argv[0] is what the runtime executes: a name with a slash is a path (relative to WorkingDir),
 * a bare name is searched on PATH in order (an empty component is WorkingDir; no PATH at all is the runtime default), and
 * the match must be an executable regular file. It must resolve; when it does not, `unresolved` names it and the review
 * holds. Every other word that names a file (absolute, or relative to WorkingDir) is a start input too, an interpreted
 * script for one: it needs to be readable, not executable. `pathDirs` are the directories PATH searches. A link loop on
 * the way is reported in `loops`.
 */
function startTargets(idx: MergedIndex, ev: ImageEvidence, detail: ImageDetail): { found: Set<string>; unresolved?: string; pathDirs: Set<string>; words: number; loops: string[]; inputs: string[] } {
  const parse = (j: string): string[] | undefined => {
    try {
      const v: unknown = JSON.parse(j);
      return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : undefined;
    } catch {
      return undefined;
    }
  };
  const ep = parse(ev.entrypoint);
  const argv = ep?.length ? [...ep, ...(parse(ev.cmd) ?? [])] : (parse(ev.cmd) ?? []);
  const envPath = detail.env.find((e) => e.startsWith("PATH="));
  const work = detail.workdir.startsWith("/") ? detail.workdir : `/${detail.workdir}`;
  const canon = (p: string) => p.split("/").filter((x) => x && x !== ".").join("/");
  const dirs = (envPath === undefined ? DEFAULT_PATH : envPath.slice(5).split(":")).map((d) => (d === "" ? work : d.startsWith("/") ? d : `${work}/${d}`));
  const found = new Set<string>();
  const loops: string[] = [];
  const inputs: string[] = [];
  let unresolved: string | undefined;
  // Every word is inspected; only a command line past the budget is not, and that holds (the caller adds the hit).
  for (const [i, w] of argv.slice(0, MAX_START_WORDS).entries()) {
    if (i === 0) {
      const cands = w.startsWith("/") ? [w] : w.includes("/") ? [`${work}/${w}`] : dirs.map((d) => `${d}/${w}`);
      let hit = false;
      for (const c of cands) {
        const r = idx.resolve(c);
        if (r.loop) loops.push(c);
        const n = r.final === undefined ? undefined : idx.get(r.final);
        if (!n || n.type !== "file" || (n.mode & 0o111) === 0) continue;
        for (const l of r.links) found.add(l);
        found.add(r.final!);
        inputs.push(canon(c));
        hit = true;
        break;
      }
      if (!hit) unresolved = w;
      continue;
    }
    if (!w || w.startsWith("-")) continue;
    const r = idx.resolve(w.startsWith("/") ? w : `${work}/${w}`);
    if (r.loop) loops.push(w);
    const n = r.final === undefined ? undefined : idx.get(r.final);
    if (r.final !== undefined && n?.type === "file") {
      for (const l of r.links) found.add(l);
      found.add(r.final);
      inputs.push(canon(w.startsWith("/") ? w : `${work}/${w}`));
    }
  }
  return { found, unresolved, pathDirs: new Set(dirs.map(canon)), words: argv.length, loops, inputs };
}

/**
 * Directories whose contents (through links too) hold a file named by an unanchored persistence pattern. They start as the
 * directories above such a file, and spread through links to a fixed point: a link to a holder directory makes the link's
 * own location a holder, and so every directory above it, so a link to a directory with a nested link to the file's
 * directory (root -> /opt/A, /opt/A/.ssh -> /data/A) is found at the outer link. Both images, one work budget.
 */
export function holderDirs(ixs: MergedIndex[], budget: { work: number }, hits: string[]): Set<string> {
  const holders = new Set<string>();
  const up = (d: string): boolean => {
    let added = false;
    for (;;) {
      if (++budget.work > MAX_LINK_WORK) break;
      if (holders.has(d)) break;
      holders.add(d);
      added = true;
      if (!d) break;
      d = d.includes("/") ? d.slice(0, d.lastIndexOf("/")) : "";
    }
    return added;
  };
  const links: { l: string; f: string }[] = [];
  for (const ix of ixs) {
    for (const p of ix.nodes.keys()) {
      if (budget.work > MAX_LINK_WORK) break;
      if (UNANCHORED_HARD.test(p)) up(p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
    }
    for (const l of ix.links()) {
      if (budget.work > MAX_LINK_WORK) break;
      const r = ix.resolve(l);
      budget.work += r.links.length + 1;
      if (r.final !== undefined) links.push({ l, f: r.final });
    }
  }
  if (budget.work > MAX_LINK_WORK) {
    hits.push("link resolution over budget");
    return holders;
  }
  for (let changed = true; changed; ) {
    changed = false;
    for (const { l, f } of links) {
      if (++budget.work > MAX_LINK_WORK) {
        hits.push("link resolution over budget");
        return holders;
      }
      if (holders.has(f) && up(l)) changed = true;
    }
  }
  return holders;
}

/**
 * The classes a link hands on. Every link entry is walked once, then every directory it reaches: a pair (v, p) says the
 * virtual path v is the physical path p, so a physical path under p is also known as v plus the rest. Only pairs whose
 * virtual path can be mandatory are kept, which bounds the walk. A physical path is judged by the union of all its
 * aliases, and the directories above and below a mandatory directory link's target are important. A loop (a chain of over
 * 40 links) or an exhausted work budget is a hit, and the review holds on it.
 */
const MAX_LINK_WORK = 2_000_000;
const MAX_LINK_DEPTH = 40;

interface LinkAliases {
  pairs: { v: string; p: string }[];
  important: Set<string>;
  hits: string[];
}

export function linkAliases(idx: MergedIndex, relevant: (v: string, p?: string) => boolean, mandatoryDir: (v: string) => boolean, budget: { work: number }): LinkAliases {
  const hits = new Set<string>();
  const pairs: { v: string; p: string }[] = [];
  const important = new Set<string>();
  const addUp = (p: string) => {
    for (let d = p; ; d = d.includes("/") ? d.slice(0, d.lastIndexOf("/")) : "") {
      if (++budget.work > MAX_LINK_WORK) break;
      important.add(d);
      if (!d) break;
    }
  };
  const links = idx.links();
  const seen = new Set<string>();
  const queue: { v: string; p: string; depth: number }[] = [];
  const push = (v: string, p: string, depth: number) => {
    const k = `${v}\0${p}`;
    if (!seen.has(k)) {
      seen.add(k);
      queue.push({ v, p, depth });
    }
  };
  const walk = (m: string, v: string, depth: number) => {
    if (budget.work > MAX_LINK_WORK) return;
    const r = idx.resolve(m);
    budget.work += r.links.length + 1;
    if (r.loop) {
      if (relevant(v)) hits.add(`link loop: ${v}`);
    } else if (r.final !== undefined && relevant(v, r.final)) push(v, r.final, depth);
  };
  for (const l of links) walk(l, l, 1);
  while (budget.work > MAX_LINK_WORK || queue.length) {
    if (budget.work > MAX_LINK_WORK) {
      hits.add("link resolution over budget");
      return { pairs, important, hits: [...hits] };
    }
    const { v, p, depth } = queue.pop()!;
    pairs.push({ v, p });
    addUp(p);
    const isDir = idx.get(p)?.type === "dir";
    if (isDir && mandatoryDir(v)) {
      const below = idx.under(p, MAX_LINK_WORK - budget.work + 1);
      budget.work += below.length;
      for (const d of below) if (budget.work <= MAX_LINK_WORK && idx.get(d)?.type === "dir") addUp(d);
    }
    if (!isDir) continue;
    if (depth >= MAX_LINK_DEPTH) {
      hits.add(`link loop: ${v}`);
      continue;
    }
    for (const m of links) {
      if (++budget.work > MAX_LINK_WORK) {
        hits.add("link resolution over budget");
        return { pairs, important, hits: [...hits] };
      }
      if (p !== "" && !m.startsWith(`${p}/`)) continue;
      const vm = `${v}/${p === "" ? m : m.slice(p.length + 1)}`;
      walk(m, vm, depth + 1);
    }
  }
  return { pairs, important, hits: [...hits] };
}

export async function reviewLayers(a: { old: ImageLayers; new: ImageLayers; newEvidence: ImageEvidence; store: LayerStore; budget?: LayerBudget }): Promise<LayerReview> {
  const { store } = a;
  const budget = a.budget ?? LAYER_BUDGET;
  const maxShown = store.limits.maxShown ?? LIMITS.maxShown;
  for (const side of [a.old, a.new]) {
    const total = side.layers.reduce((s, l) => s + l.size, 0);
    if (total > store.limits.maxCompressed) throw new LayerError(side.layers[0]?.digest ?? "(image)", `layers are ${total} bytes compressed, over the ${store.limits.maxCompressed} cap`);
  }
  const oldT = new ImageTree(store, a.old.layers, a.old.fetchLayer);
  const newT = new ImageTree(store, a.new.layers, a.new.fetchLayer);
  const oldIdx = await MergedIndex.build(oldT);
  const idx = await MergedIndex.build(newT);
  const changes = await diffIndexes(oldIdx, idx, oldT, newT);
  const problems = [...idx.problems, ...oldIdx.problems];

  // The package databases are read when a layer changed one; otherwise the packages are the same on both sides, and
  // ownership is looked up (newer image's database) only for an executable, whose owner decides how it is judged.
  const dbChanged = changes.some((c) => c.path === "lib/apk/db/installed" || c.path === "var/lib/dpkg/status");
  let oldPk: Packages | undefined;
  let newPk: Packages | undefined;
  let pk: { lines: string[]; changed: Set<string> } = { lines: [], changed: new Set() };
  if (dbChanged) {
    oldPk = await readPackages(oldT, oldIdx);
    newPk = await readPackages(newT, idx);
    pk = packageDiff(oldPk, newPk);
  }
  let owner: Map<string, string> | undefined;
  const ownerOf = async (path: string): Promise<string | undefined> => {
    if (!owner) {
      newPk ??= await readPackages(newT, idx);
      owner = new Map([...(oldPk?.owner ?? []), ...newPk.owner]);
      if (newPk.kind === "dpkg") {
        await readDpkgOwners(newT, idx, owner);
        if (oldPk) await readDpkgOwners(oldT, oldIdx, owner, pk.changed);
      }
    }
    return owner.get(path);
  };

  const extra: string[] = detailLines(a.old.detail, a.new.detail);
  const hits: string[] = [];
  const counts = { added: 0, changed: 0, removed: 0, owned: 0 };
  const shown: { path: string; o?: FsNode; n: FsNode; rank: number; own?: string; entry: boolean }[] = [];
  const { found: entries, unresolved, pathDirs, words, loops, inputs } = startTargets(idx, a.newEvidence, a.new.detail);
  hits.push(...problems);
  for (const l of loops) hits.push(`link loop: ${l}`);
  if (unresolved !== undefined) hits.push(`start target unresolved: ${unresolved}`);
  if (words > MAX_START_WORDS) hits.push(`start inputs over budget: ${words} words`);
  // Links hand classes on (see linkAliases); this runs whatever else the changed file is, a start input included.
  const mandatoryPath = (p: string) => HARD.test(p) || STARTUP.test(p) || MAINT.test(p) || CA_CERT.test(p);
  const mandatoryDir = (d: string) => [`${d}/x`, `${d}/x.postinst`].some(mandatoryPath) || EXACT_ANCESTORS.has(d) || caAncestor(d) || MANDATORY_ROOTS.some((r) => r.startsWith(`${d}/`));
  const linkBudget = { work: 0 };
  // A link is worth walking when its own name stands for a mandatory directory or path, or when it leads to a directory that
  // holds a file named by an unanchored pattern (authorized_keys, a .pth, sitecustomize.py): those names are judged by the
  // file, so the virtual name a link gives it (root/.ssh/authorized_keys) must be enumerated too.
  const holders = holderDirs([oldIdx, idx], linkBudget, hits);
  const relevant = (v: string, p?: string) => mandatoryPath(v) || mandatoryDir(v) || (p !== undefined && holders.has(p));
  const la = linkAliases(idx, relevant, mandatoryDir, linkBudget);
  hits.push(...la.hits);
  // The old image's links walk under the same budget; its loops were reviewed with it, only running out of budget holds.
  const laOld = linkAliases(oldIdx, relevant, mandatoryDir, linkBudget);
  if (laOld.hits.includes("link resolution over budget")) hits.push("link resolution over budget");
  // A path as a startup or persistence path: the name itself, or (for a directory or a link) a name it would put one under.
  const HARD_PROBES = ["x", "ld.so.preload", "passwd", "shadow", "gshadow", "sudoers", "init.d/x", "profile.d/x", "cron.d/x", "sudoers.d/x", "spool/cron/x"];
  // Only the anchored names are probed: a name like authorized_keys or x.pth is judged by the file itself, not by a directory that could hold one (a .ssh directory is the exception).
  const hardName = (p: string, dirish: boolean) => HARD.test(p) || (dirish && (/(^|\/)\.ssh$/.test(p) || HARD_PROBES.some((q) => HARD.test(`${p}/${q}`))));
  // A directory is important when it is, or is above, a PATH directory (resolved too), a start input, a mandatory path the
  // image really has, a directory a mandatory link reaches, or one of the fixed mandatory roots.
  // What removing a path means, one rule for a physical entry and for a name a link gives it: a startup or persistence name,
  // a startup directory or a trust path (a file in a trust directory, or the directory itself) holds, and is named as evidence.
  const removal = (p: string, dirish: boolean, link = false): { hit?: string; evidence: boolean } => {
    const below = dirish ? [`${p}/x`, `${p}/x.postinst`] : [];
    const hit = hardName(p, dirish || link) || STARTUP.test(p) || MAINT.test(p) || below.some((q) => STARTUP.test(q) || MAINT.test(q)) ? "startup path removed" : [p, ...below].some((q) => CA_CERT.test(q)) ? "trust path removed" : undefined;
    return { hit, evidence: hit !== undefined || HARD.test(p) || STARTUP.test(p) || (link && mandatoryDir(p)) };
  };
  const note = (line: string) => {
    if (!extra.includes(line)) extra.push(line);
  };
  const importantDirs = la.important;
  const addUp = (p: string) => {
    for (let d = p; ; d = d.includes("/") ? d.slice(0, d.lastIndexOf("/")) : "") {
      importantDirs.add(d);
      if (!d) break;
    }
  };
  for (const d of pathDirs) {
    addUp(d);
    const r = idx.resolve(d);
    if (r.final !== undefined) addUp(r.final);
  }
  for (const p of [...entries, ...MANDATORY_ROOTS]) addUp(p);
  for (const p of idx.nodes.keys()) if (mandatoryPath(p)) addUp(p);
  const important = (d: string) => importantDirs.has(d) || mandatoryDir(d);
  for (const c of changes) {
    const kind = !c.o ? "added" : !c.n ? "removed" : "changed";
    if (c.n?.type === "dir" ? !c.o || c.o.type === "dir" : !c.n && c.o?.type === "dir") {
      if (c.n) {
        const d = dirChange(c.path, c.o, c.n, important(c.path));
        if (d.line) extra.push(d.line);
        if (d.hit) hits.push(d.hit);
        // A startup or persistence directory changed in any way (mode, owner) holds, not only when it weakens.
        if (d.line && hardName(c.path, true)) hits.push(`startup path changed: ${c.path} (${d.line.slice(d.line.indexOf(": ") + 2)})`);
      } else if (c.o) {
        // A startup, persistence or trust directory that is removed holds, empty or not, and its removal is evidence and a count.
        const rm = removal(c.path, true);
        if (rm.hit) hits.push(`${rm.hit}: ${c.path}`);
        if (rm.evidence) {
          note(`removed: ${c.path}`);
          counts.removed++;
        }
      }
      continue;
    }
    const rpmDb = RPM_DB.includes(c.path);
    counts[kind]++;
    if (!c.n) {
      // A startup or persistence path (or a link standing for one) that is removed holds: the image no longer has it.
      const rm = removal(c.path, false, c.o?.type === "symlink");
      if (rm.hit) hits.push(`${rm.hit}: ${c.path}`);
      if (rm.evidence) note(`removed: ${c.path}`);
      continue;
    }
    if (c.o && c.o.type !== c.n.type && hardName(c.path, [c.o.type, c.n.type].some((t) => t === "symlink" || t === "dir"))) hits.push(`startup path type changed: ${c.path} (${c.o.type} -> ${c.n.type})`);
    // A file replaced by a directory or a special file is gone as a file: the same loss as a removal.
    if (c.o?.type === "file" && c.n.type !== "file" && c.n.type !== "symlink") {
      const rm = removal(c.path, false);
      if (rm.hit) hits.push(`${rm.hit}: ${c.path} (file -> ${c.n.type})`);
      if (rm.evidence) note(`removed: ${c.path}`);
    }
    if (c.n.type === "device" || c.n.type === "fifo") {
      if (hardName(c.path, false)) hits.push(`startup path ${kind}: ${c.path} (${c.n.type})`);
      extra.push(`special file ${kind}: ${c.path} (${c.n.type})`);
      continue;
    }
    if (c.n.type === "dir") continue;
    // Per path, in this order: the metadata change is always rendered; the mandatory checks come next; only a path
    // that passes them can be set aside as package bookkeeping; only then can ownership, which the image under review
    // itself claims, hide a plain file.
    const entry = entries.has(c.path);
    const exec = c.n.type === "file" && (c.n.mode & 0o111) !== 0;
    const sameMeta = !!c.o && c.o.type === c.n.type && c.o.mode === c.n.mode && c.o.uid === c.n.uid && c.o.gid === c.n.gid;
    if (c.o && c.o.type !== "dir") {
      const was = c.o;
      const now = c.n;
      const diffs = [...(was.type !== now.type ? [`type ${was.type} -> ${now.type}`] : []), ...(was.mode !== now.mode ? [`mode ${oct(was.mode)} -> ${oct(now.mode)}`] : []), ...(was.uid !== now.uid ? [`uid ${was.uid} -> ${now.uid}`] : []), ...(was.gid !== now.gid ? [`gid ${was.gid} -> ${now.gid}`] : [])];
      if (diffs.length) extra.push(`METADATA ${c.path}: ${diffs.join(", ")}`);
    }
    const aliases = la.pairs.flatMap(({ v, p }) => (c.path === p ? [v] : p === "" ? [`${v}/${c.path}`] : c.path.startsWith(`${p}/`) ? [`${v}${c.path.slice(p.length)}`] : []));
    // A link entry is a path of its own: a mandatory directory link is judged as the directory it stands for.
    const asDir = c.n.type === "symlink" || c.o?.type === "symlink" ? [`${c.path}/x`, `${c.path}/x.postinst`] : [];
    const classes = [c.path, ...aliases, ...asDir];
    const hard = classes.some((p) => HARD.test(p)) || hardName(c.path, c.n.type === "symlink" || c.o?.type === "symlink");
    const startup = classes.some((p) => STARTUP.test(p));
    const maint = classes.some((p) => MAINT.test(p));
    const id = c.n.type === "file" ? c.n.mode & 0o6000 : 0;
    const ca = classes.some((p) => CA_CERT.test(p));
    // Named by its shortest hard alias; a root link makes a chain of longer ones.
    const hardFrom = aliases.filter((p) => HARD.test(p)).sort((x, y) => x.length - y.length)[0];
    if (hard) hits.push(`startup path ${kind}: ${c.path}${!HARD.test(c.path) && hardFrom ? ` (target of ${hardFrom})` : ""}`);
    if (rpmDb) hits.push(`rpm database ${kind}: ${c.path} (package changes not read)`);
    if (id) hits.push(`setuid/setgid file ${kind}: ${c.path} (mode ${(c.n.mode & 0o7777).toString(8)})`);
    const mandatory = entry || hard || startup || maint || ca || !!id || rpmDb;
    if (!mandatory && !exec && c.n.type === "file" && DB_PATH.test(c.path)) {
      counts[kind]--;
      continue;
    }
    const own = dbChanged || exec ? await ownerOf(c.path) : undefined;
    // Ownership is the image's own claim (its dpkg lists and database), so it can set aside a text file but never vouch
    // for a binary one: a changed binary is judged by its bytes (the first 8000 say whether it is one) and goes on to hold.
    const ownedText = async () => {
      const nh = await newT.head(c.n!, 8000);
      const oh = c.o?.type === "file" ? await oldT.head(c.o, 8000) : undefined;
      return !hashedBinary(c.path, oh, nh) || benignBinary(c.path, nh);
    };
    if (!mandatory && own && pk.changed.has(own) && c.n.type === "file" && !exec && (!c.o || sameMeta) && (await ownedText())) {
      counts.owned++;
      continue;
    }
    const rank = entry ? 0 : hard || startup || maint ? 1 : id ? 2 : exec && !own ? 3 : ca ? 4 : 5;
    shown.push({ path: c.path, o: c.o, n: c.n, rank, own, entry });
  }

  // The virtual view. What an attacker changes is what the image shows at a startup or persistence path, so those paths
  // (every name a link makes of a physical path, in either image) are resolved in both images and compared by what they
  // resolve to. A link on the resolution chain makes a difference here: a redirected intermediate link, a link at an
  // ancestor, a removed or replaced link, a path newly reachable. It is classified by the virtual path.
  const names = new Set<string>();
  const addNames = (ix: MergedIndex, pairs: { v: string; p: string }[]) => {
    for (const p of ix.nodes.keys()) if (p && mandatoryPath(p)) names.add(p);
    for (const { v, p } of pairs) {
      if (relevant(v, p)) names.add(v);
      const below = ix.under(p, MAX_LINK_WORK - linkBudget.work + 1);
      linkBudget.work += below.length;
      if (linkBudget.work > MAX_LINK_WORK) {
        hits.push("link resolution over budget");
        return;
      }
      for (const q of below) {
        const vp = p === "" ? `${v}/${q}` : `${v}${q.slice(p.length)}`;
        if (mandatoryPath(vp) || (ix.get(q)?.type === "dir" && [`${vp}/x`, `${vp}/x.postinst`].some(mandatoryPath))) names.add(vp);
      }
    }
  };
  addNames(idx, la.pairs);
  addNames(oldIdx, laOld.pairs);
  for (const w of [...inputs, ...pathDirs]) if (w) names.add(w);
  const viewOf = (ix: MergedIndex, v: string) => {
    const r = ix.resolve(v);
    const node = r.final === undefined ? undefined : ix.get(r.final);
    return { node, path: r.final, links: r.links.length, loop: !!r.loop, kids: node?.type === "dir" ? ix.childNames(r.final!).sort().join("\0") : undefined };
  };
  const physicalShown = new Set(shown.map((s) => s.path));
  for (const v of [...names].sort()) {
    const ov = viewOf(oldIdx, v);
    const nv = viewOf(idx, v);
    if (nv.loop) hits.push(`link loop: ${v}`);
    if (!ov.links && !nv.links) continue;
    const same = !ov.node && !nv.node ? true : !ov.node || !nv.node || ov.kids !== nv.kids ? false : await sameEntry(ov.node, nv.node, oldT, newT);
    if (same) continue;
    if (pathDirs.has(v) && ov.path !== nv.path) hits.push(`PATH directory redirected: ${v}`);
    const kind = !ov.node ? "added" : !nv.node ? "removed" : ov.node.type !== nv.node.type ? "type changed" : "changed";
    const dirish = [ov.node, nv.node].some((n) => n?.type === "dir");
    const hard = hardName(v, dirish);
    const probes = dirish ? [v, `${v}/x`, `${v}/x.postinst`] : [v];
    const other = probes.some((q) => STARTUP.test(q) || MAINT.test(q) || CA_CERT.test(q));
    const input = inputs.includes(v);
    if (hard) hits.push(`startup path ${kind}: ${v}`);
    else if (kind === "removed" || (ov.node?.type === "file" && nv.node?.type !== "file")) {
      const rm = removal(v, ov.node?.type === "dir");
      if (rm.hit) hits.push(`${rm.hit}: ${v}`);
      if (rm.evidence || other) note(`removed: ${v}`);
    }
    if (nv.node?.type === "file" && (hard || other || input)) {
      if (!physicalShown.has(v) && !physicalShown.has(nv.path!)) shown.push({ path: v, o: ov.node?.type === "file" ? ov.node : undefined, n: nv.node, rank: input ? 0 : 1, entry: input });
      // The bytes are already shown under their physical path; the virtual name stays as evidence of what presents them.
      else if (nv.path !== v) extra.push(`ALIAS ${v} -> ${nv.path} (${kind})`);
    }
  }

  const oldF: FileMap = new Map();
  const newF: FileMap = new Map();
  const ranks = new Map<string, number>();
  const texts: { path: string; before?: string; after: string }[] = [];
  const binaries: string[] = [];
  for (const s of shown) {
    const bytes = async (t: ImageTree, n: FsNode | undefined) => (!n ? undefined : n.type === "symlink" ? linkText(n) : n.type === "file" ? await t.read(n) : undefined);
    const nb = await bytes(newT, s.n);
    if (!nb) continue;
    const exec = s.n.type === "file" && (s.n.mode & 0o111) !== 0;
    const kind = s.o ? "changed" : "added";
    if (nb.length > maxShown) {
      extra.push(`not shown: ${s.path} (${nb.length} bytes, over the ${maxShown} byte limit, sha256 ${sha(nb)})`);
      // Content no reviewer saw is not an approval: any file left out holds.
      hits.push(`content not shown: ${s.path} ${kind} (${nb.length} bytes, over the ${maxShown} byte limit)`);
      continue;
    }
    const ob = await bytes(oldT, s.o);
    if (exec && !s.own && !s.entry && (isElf(nb) || isBinary(nb))) hits.push(`unpackaged binary ${kind}: ${s.path} (sha256 ${sha(nb)})`);
    // As in a package review: a binary reaches the reviewers only as a hash, so their APPROVE does not cover it. Any
    // added or changed binary holds, executable or not, packaged or not (the image vouches for its own packages), a start
    // target included; only a benign format whose bytes match its name (an image, a font) may pass on its hash.
    if (s.n.type === "file" && hashedBinary(s.path, ob, nb) && (s.entry || !benignBinary(s.path, nb))) binaries.push(s.path);
    newF.set(s.path, nb);
    if (ob) oldF.set(s.path, ob);
    ranks.set(s.path, s.rank);
    if (!isBinary(nb) && !(ob && isBinary(ob))) texts.push({ path: s.path, before: ob && dec.decode(ob), after: dec.decode(nb) });
  }
  if (binaries.length) hits.push(`not model-reviewable: binary file(s) ${binaries.join(", ")}; needs a human`);
  for (const t of texts) {
    const diff = renderLineDiff(t.before, t.after);
    hits.push(...scanSurface([{ path: t.path, diff }]));
    const added = diff.split("\n").filter((l) => l.startsWith("+"));
    const soft = SOFT_PATTERNS.find((p) => added.some((l) => p.re.test(l)));
    if (soft) hits.push(`${t.path}: ${soft.kind}`);
  }

  if (pk.lines.length) extra.push(`PACKAGE CHANGES (${newPk?.kind ?? oldPk?.kind}):`, ...pk.lines);
  extra.push(`FILES: ${counts.added} added, ${counts.changed} changed, ${counts.removed} removed; ${counts.owned} owned by upgraded packages, not shown`);

  const order = [...ranks.keys()].sort((x, y) => ranks.get(x)! - ranks.get(y)! || (x < y ? -1 : 1));
  const cut = (only: string[]) => (only.length ? chunkDiff(oldF, newF, budget.chunkChars, only) : []);
  let scope: Scope = "all";
  let parts = cut(order);
  let narrowed: string | undefined;
  if (parts.length > budget.maxParts) {
    const total = parts.length;
    const priority = order.filter((p) => ranks.get(p)! <= 4);
    scope = "priority";
    parts = cut(priority);
    narrowed = `too large for model review: ${total} parts > ${budget.maxParts} (full diff); priority files only, ${order.length - priority.length} file(s) not reviewed; needs a human`;
    if (parts.length > budget.maxParts) {
      const signal = order.filter((p) => ranks.get(p)! <= 1);
      scope = "signal";
      parts = cut(signal);
      narrowed = `too large for model review: ${total} parts > ${budget.maxParts} (priority files alone); signal files only, ${order.length - signal.length} file(s) not reviewed; needs a human`;
      if (parts.length > budget.maxParts) {
        scope = "ranked";
        narrowed = `too large for model review: ${parts.length} parts > ${budget.maxParts} (signal files alone); top ${budget.maxParts} ranked parts only, never lands; needs a human`;
        parts = parts.slice(0, budget.maxParts);
      }
    }
  }
  if (scope !== "all") parts = parts.map((p) => `[${SCOPE_NOTE[scope].trim()}]\n${p}`);

  const digests = new Set([...a.old.layers, ...a.new.layers].map((l) => l.digest));
  const read = store.fetched.length;
  return { extra, parts, hits: [...new Set(hits)], narrowed, summary: `layers: ${read} read, ${digests.size - read} not read (shared by both images)` };
}
