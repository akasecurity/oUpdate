// An image's filesystem as its layers say it, read with bsdtar and never unpacked. A layer is listed once
// (`bsdtar -tv --numeric-owner`) into its entries and whiteouts; a path resolves by walking the layers newest first,
// honoring `.wh.<name>` and `.wh..wh..opq`; one file's bytes come out of its layer on demand (`bsdtar -xOf`). Every
// limit is checked before the work it bounds and throws a LayerError, which the review turns into a hold.

import { isUnsafeMember } from "./artifact.ts";
import type { LayerInfo } from "./adapters/oci/registry.ts";

export interface Limits {
  /** Compressed bytes of one side's layers. */
  maxCompressed: number;
  /** Listed entries across every layer read. */
  maxEntries: number;
  /** Bytes of file content read out of layers. */
  maxContent: number;
  /** Largest file shown to a reviewer; a bigger one is only named. */
  maxShown: number;
  /** Milliseconds one bsdtar call (a listing or one file's read) may run before it is stopped. */
  timeoutMs?: number;
}

export const LIMITS: Limits = { maxCompressed: 2_000_000_000, maxEntries: 500_000, maxContent: 300_000_000, maxShown: 1_000_000, timeoutMs: 300_000 };

/** Stops `p` after `ms`; `timedOut()` says whether it was this that stopped it. */
function deadline(p: { kill(): void }, ms: number): { timedOut: () => boolean; clear: () => void } {
  let hit = false;
  const t = setTimeout(() => {
    hit = true;
    p.kill();
  }, ms);
  return { timedOut: () => hit, clear: () => clearTimeout(t) };
}

/** Why a layer could not be read; the review holds on it whatever the reviewers say. */
export class LayerError extends Error {
  constructor(
    readonly digest: string,
    why: string,
  ) {
    super(why);
  }
}

export type NodeType = "file" | "dir" | "symlink" | "device" | "fifo";

export interface FsNode {
  path: string;
  type: NodeType;
  mode: number;
  uid: number;
  gid: number;
  size: number;
  /** A symlink's target. */
  link?: string;
  /** The digest of the layer holding it. */
  layer: string;
  /** The member name to pull its bytes by (a hard link's is its target's). */
  member: string;
  /** A hard link's target, as a canonical path. */
  hard?: string;
}

export interface LayerListing {
  digest: string;
  file: string;
  entries: Map<string, FsNode>;
  /** Full paths deleted by a `.wh.<name>` entry. */
  whiteouts: Set<string>;
  /** Directories whose lower contents an opaque marker hides. */
  opaque: Set<string>;
  /** Non-directory paths the layer names more than once: replaying them in order is not modeled, so the merge holds on each. */
  repeated?: Set<string>;
}

const SUPPORTED = /^application\/vnd\.(oci\.image\.layer\.v1\.tar(\+gzip|\+zstd)?|docker\.image\.rootfs\.diff\.tar(\.gzip|\.zstd)?)$/;

/** One spelling per path: `etc//x`, `./etc/x` and `etc/./x` are all `etc/x`, for matching, merging and whiteouts alike. */
const norm = (name: string): string => name.split("/").filter((seg) => seg !== "" && seg !== ".").join("/");
const dirOf = (p: string): string => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
const baseOf = (p: string): string => p.slice(p.lastIndexOf("/") + 1);

function modeBits(s: string): number {
  let m = 0;
  const bit = (i: number, on: string, v: number) => {
    if (on.includes(s[i]!)) m |= v;
  };
  bit(1, "r", 0o400);
  bit(2, "w", 0o200);
  bit(3, "xs", 0o100);
  bit(4, "r", 0o040);
  bit(5, "w", 0o020);
  bit(6, "xs", 0o010);
  bit(7, "r", 0o004);
  bit(8, "w", 0o002);
  bit(9, "xt", 0o001);
  bit(3, "sS", 0o4000);
  bit(6, "sS", 0o2000);
  bit(9, "tT", 0o1000);
  return m;
}

const LINE = /^(\S{10})\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+[A-Z][a-z]{2}\s+\d{1,2}\s+(?:\d{1,2}:\d{2}|\d{4})\s(.*)$/;
const TYPES: Record<string, NodeType> = { "-": "file", d: "dir", l: "symlink", c: "device", b: "device", p: "fifo", h: "file" };

/** The listing `bsdtar -tv --numeric-owner` printed for one layer. */
export function parseListing(digest: string, file: string, text: string, maxEntries = LIMITS.maxEntries): LayerListing {
  const lines = text.split("\n").filter(Boolean);
  if (lines.length > maxEntries) throw new LayerError(digest, `layer lists ${lines.length} entries, over the ${maxEntries} cap`);
  const out: LayerListing = { digest, file, entries: new Map(), whiteouts: new Set(), opaque: new Set() };
  const hard: [FsNode, string][] = [];
  const names = new Map<string, string>();
  const dirs = new Map<string, boolean>();
  const repeated = new Set<string>();
  for (const l of lines) {
    const m = LINE.exec(l);
    const kind = m ? TYPES[m[1]![0]!] : undefined;
    if (!m || !kind) throw new LayerError(digest, `unreadable listing line: ${l.slice(0, 120)}`);
    let name = m[6]!;
    let link: string | undefined;
    if (m[1]![0] === "l" && name.includes(" -> ")) [name, link] = [name.slice(0, name.indexOf(" -> ")), name.slice(name.indexOf(" -> ") + 4)];
    if (m[1]![0] === "h" && name.includes(" link to ")) [name, link] = [name.slice(0, name.indexOf(" link to ")), name.slice(name.indexOf(" link to ") + 9)];
    // bsdtar prints a link as `name -> target` (`name link to target`), and both sides are the layer's to choose: a name or
    // target that holds a separator makes the split a guess (a link named `a -> b` reads as a link `a` to `b -> ...`), so
    // the layer is refused rather than split.
    if ([name, link ?? ""].some((x) => x.includes(" -> ") || x.includes(" link to "))) throw new LayerError(digest, `ambiguous member name: ${m[6]!.slice(0, 120)}`);
    if (isUnsafeMember(name) || (link !== undefined && m[1]![0] === "h" && isUnsafeMember(link))) throw new LayerError(digest, `unsafe member name: ${name}`);
    const path = norm(name);
    if (!path) continue;
    // Two spellings of one path in a layer cannot be told apart reliably (which one extraction keeps), so the layer is refused.
    const spelled = names.get(path);
    if (spelled !== undefined && spelled !== name && !(spelled.endsWith("/") && name.endsWith("/"))) throw new LayerError(digest, `two names for one path: ${spelled} and ${name}`);
    names.set(path, name);
    const wasDir = dirs.get(path);
    if (wasDir !== undefined && !(wasDir && kind === "dir")) repeated.add(path);
    dirs.set(path, kind === "dir");
    const base = baseOf(path);
    if (base === ".wh..wh..opq") {
      // Hiding the whole lower filesystem is not something the path walk models; the layer is refused, not guessed at.
      if (!dirOf(path)) throw new LayerError(digest, "root opaque whiteout");
      out.opaque.add(dirOf(path));
      continue;
    }
    if (base.startsWith(".wh.")) {
      out.whiteouts.add(dirOf(path) ? `${dirOf(path)}/${base.slice(4)}` : base.slice(4));
      continue;
    }
    const node: FsNode = { path, type: kind, mode: modeBits(m[1]!), uid: Number(m[3]), gid: Number(m[4]), size: Number(m[5]), layer: digest, member: name };
    if (m[1]![0] === "l") node.link = link;
    if (m[1]![0] === "h" && link !== undefined) node.hard = norm(link);
    out.entries.set(path, node);
    if (m[1]![0] === "h" && link !== undefined) hard.push([node, link]);
  }
  if (repeated.size) out.repeated = repeated;
  for (const w of out.whiteouts) if (out.entries.has(w)) throw new LayerError(digest, `a whiteout and an entry for one path: ${w}`);
  // A hard link is the file it names: same size, same bytes, read from that member.
  for (const [node, target] of hard) {
    const t = out.entries.get(norm(target));
    if (t && t.type === "file") Object.assign(node, { size: t.size, member: t.member });
  }
  return out;
}

const globSafe = (member: string): string => member.replace(/[\\*?[\]]/g, "\\$&");

/**
 * `bsdtar -tv` output read as it arrives: the entry cap (counted in lines) and a per-entry byte bound are enforced while
 * reading, and bsdtar is stopped the moment either passes, so a hostile layer cannot make the listing grow without limit.
 */
async function streamListing(digest: string, file: string, maxEntries: number, timeoutMs: number): Promise<string> {
  const p = Bun.spawn(["bsdtar", "-tv", "--numeric-owner", "-f", file], { stdout: "pipe", stderr: "pipe" });
  const timer = deadline(p, timeoutMs);
  const errText = new Response(p.stderr).text();
  const dec = new TextDecoder();
  const maxBytes = Math.max(maxEntries, 0) * 4096;
  let text = "";
  let lines = 0;
  let bytes = 0;
  let rc: number;
  try {
    const reader = p.stdout.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.length;
      for (const b of value) if (b === 10) lines++;
      if (lines > maxEntries || bytes > maxBytes) {
        p.kill();
        throw new LayerError(digest, `layer lists more than ${maxEntries} entries, over the cap`);
      }
      text += dec.decode(value, { stream: true });
    }
    rc = await p.exited;
  } finally {
    timer.clear();
  }
  if (timer.timedOut()) throw new LayerError(digest, `bsdtar did not list the layer within ${timeoutMs} ms`);
  if (rc !== 0) throw new LayerError(digest, `bsdtar could not list the layer: ${(await errText).trim().split("\n")[0]}`);
  return text + dec.decode();
}

/** Layer blobs kept in one private directory, each listed once and fetched only when something asks for it. */
export class LayerStore {
  private listings = new Map<string, Promise<LayerListing>>();
  private contents = new Map<string, Promise<Uint8Array>>();
  entries = 0;
  contentRead = 0;
  /** Digests fetched, in order. */
  readonly fetched: string[] = [];

  constructor(
    readonly dir: string,
    readonly limits: Limits = LIMITS,
  ) {}

  listing(layer: LayerInfo, fetchLayer: (l: LayerInfo, dest: string) => Promise<void>): Promise<LayerListing> {
    let p = this.listings.get(layer.digest);
    if (!p) {
      p = this.load(layer, fetchLayer);
      this.listings.set(layer.digest, p);
    }
    return p;
  }

  private async load(layer: LayerInfo, fetchLayer: (l: LayerInfo, dest: string) => Promise<void>): Promise<LayerListing> {
    if (!SUPPORTED.test(layer.mediaType)) throw new LayerError(layer.digest, `unsupported layer media type: ${layer.mediaType || "none"}`);
    const file = `${this.dir}/${layer.digest.slice(7)}`;
    try {
      await fetchLayer(layer, file);
    } catch (e) {
      throw new LayerError(layer.digest, e instanceof Error ? e.message : String(e));
    }
    this.fetched.push(layer.digest);
    const room = this.limits.maxEntries - this.entries;
    const listed = await streamListing(layer.digest, file, room, this.limits.timeoutMs ?? LIMITS.timeoutMs!);
    const listing = parseListing(layer.digest, file, listed, room);
    this.entries += listing.entries.size + listing.whiteouts.size + listing.opaque.size;
    if (this.entries > this.limits.maxEntries) throw new LayerError(layer.digest, `layers list over the ${this.limits.maxEntries} entry cap`);
    return listing;
  }

  /** The bytes of a regular file, counted against the content budget and cached. */
  read(node: FsNode, listing: LayerListing): Promise<Uint8Array> {
    const key = `${node.layer}\0${node.member}`;
    let p = this.contents.get(key);
    if (!p) {
      p = this.pull(node, listing);
      this.contents.set(key, p);
    }
    return p;
  }

  /** The first `n` bytes of a regular file (all of it when it is no longer), counted against the content budget. */
  head(node: FsNode, listing: LayerListing, n: number): Promise<Uint8Array> {
    if (node.size <= n) return this.read(node, listing);
    const key = `${node.layer}\0${node.member}\0${n}`;
    let p = this.contents.get(key);
    if (!p) {
      p = this.pull(node, listing, n);
      this.contents.set(key, p);
    }
    return p;
  }

  private async pull(node: FsNode, listing: LayerListing, upTo?: number): Promise<Uint8Array> {
    if (node.type !== "file") throw new LayerError(node.layer, `not a regular file: ${node.path}`);
    const want = upTo === undefined ? node.size : Math.min(upTo, node.size);
    this.contentRead += want;
    if (this.contentRead > this.limits.maxContent) throw new LayerError(node.layer, `content read passes the ${this.limits.maxContent} byte cap at ${node.path}`);
    // Streamed: the bytes are counted as they arrive, and the pull stops at the size the header declares.
    const p = Bun.spawn(["bsdtar", "-xOf", listing.file, "--", globSafe(node.member)], { stdout: "pipe", stderr: "pipe" });
    const ms = this.limits.timeoutMs ?? LIMITS.timeoutMs!;
    const timer = deadline(p, ms);
    const errText = new Response(p.stderr).text();
    const chunks: Uint8Array[] = [];
    let total = 0;
    let rc: number;
    try {
      const reader = p.stdout.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (want < node.size && total + value.length >= want) {
          chunks.push(value.subarray(0, want - total));
          total = want;
          p.kill();
          break;
        }
        total += value.length;
        if (total > node.size) {
          p.kill();
          throw new LayerError(node.layer, `${node.path} is longer than the ${node.size} bytes its header declares`);
        }
        chunks.push(value);
      }
      rc = await p.exited;
    } finally {
      timer.clear();
    }
    if (timer.timedOut()) throw new LayerError(node.layer, `bsdtar did not read ${node.path} within ${ms} ms`);
    if (want < node.size && total === want) return concat(chunks, total);
    if (rc !== 0) throw new LayerError(node.layer, `bsdtar could not read ${node.path}: ${(await errText).trim().split("\n")[0]}`);
    if (total !== node.size) throw new LayerError(node.layer, `${node.path} is ${total} bytes, its header declares ${node.size}`);
    return concat(chunks, total);
  }
}

function concat(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/** One side's layers, oldest first, resolved newest first. */
export class ImageTree {
  constructor(
    readonly store: LayerStore,
    readonly layers: LayerInfo[],
    private fetchLayer: (l: LayerInfo, dest: string) => Promise<void>,
  ) {}

  private list(i: number): Promise<LayerListing> {
    return this.store.listing(this.layers[i]!, this.fetchLayer);
  }

  /** The node at `path` after every layer, undefined when it is absent or deleted. `from` skips the layers above it. */
  async resolve(path: string, from = this.layers.length): Promise<FsNode | undefined> {
    const ancestors: string[] = [];
    for (let a = dirOf(path); a; a = dirOf(a)) ancestors.push(a);
    for (let i = from - 1; i >= 0; i--) {
      const l = await this.list(i);
      const n = l.entries.get(path);
      if (n) return n;
      if (l.whiteouts.has(path)) return undefined;
      for (const a of ancestors) {
        if (l.whiteouts.has(a) || l.opaque.has(a)) return undefined;
        const e = l.entries.get(a);
        if (e && e.type !== "dir") return undefined;
      }
    }
    return undefined;
  }

  /** Every path any layer lists under `dir`: the candidates a deletion of `dir` may have removed. Lists every layer. */
  async under(dir: string): Promise<string[]> {
    const out = new Set<string>();
    for (let i = 0; i < this.layers.length; i++) for (const p of (await this.list(i)).entries.keys()) if (p.startsWith(`${dir}/`)) out.add(p);
    return [...out];
  }

  /** Every layer's listing, oldest first. Lists every layer. */
  async all(): Promise<LayerListing[]> {
    const out: LayerListing[] = [];
    for (let i = 0; i < this.layers.length; i++) out.push(await this.list(i));
    return out;
  }

  /** The layers from `from` up, listed: the tail whose own entries and deletions mark the paths that may differ. */
  tail(from: number): Promise<LayerListing[]> {
    return Promise.all(this.layers.slice(from).map((_, i) => this.list(from + i)));
  }

  async read(node: FsNode): Promise<Uint8Array> {
    const i = this.layers.findIndex((l) => l.digest === node.layer);
    return this.store.read(node, await this.list(i));
  }

  /** The first `n` bytes of a file. */
  async head(node: FsNode, n: number): Promise<Uint8Array> {
    const i = this.layers.findIndex((l) => l.digest === node.layer);
    return this.store.head(node, await this.list(i), n);
  }
}

/** How many leading layers two images share by digest. */
export function sharedPrefix(a: LayerInfo[], b: LayerInfo[]): number {
  let n = 0;
  while (n < a.length && n < b.length && a[n]!.digest === b[n]!.digest) n++;
  return n;
}

const dirNode = (path: string): FsNode => ({ path, type: "dir", mode: 0o755, uid: 0, gid: 0, size: 0, layer: "", member: "" });

/**
 * One image's final filesystem as a path index, built in a single pass over its layers: every visible entry, every
 * directory a member implies (with the image root as ""), and link entries as they are. Whiteouts and opaque markers delete
 * a subtree through a child index, so a layer costs its own entries. `resolve` is the one place links are followed.
 */
export class MergedIndex {
  readonly nodes = new Map<string, FsNode>([["", dirNode("")]]);
  private kids = new Map<string, Set<string>>();
  /** Things the merge could not settle (a hard link with no file to point at); the review holds on each. */
  readonly problems: string[] = [];
  private unresolved = new Set<string>();

  static async build(tree: ImageTree): Promise<MergedIndex> {
    return MergedIndex.fromListings(await tree.all());
  }

  static fromListings(listings: LayerListing[]): MergedIndex {
    const idx = new MergedIndex();
    for (const l of listings) {
      for (const r of l.repeated ?? []) idx.problems.push(`layer repeats path: ${r}`);
      for (const d of l.opaque) idx.dropKids(d);
      for (const w of l.whiteouts) idx.dropSubtree(w);
      for (const [p, n0] of l.entries) {
        let n = n0;
        idx.unresolved.delete(p);
        // A hard link is the file it names as that file stands when its layer applies (the same layer's, else the merged
        // image's so far): same bytes, so it is judged by the target's content source, not its own layer and member.
        if (n.hard !== undefined) {
          // The target as the merge stands (an earlier entry of this layer is already in it, resolved to its own terminal
          // source, so a chain of links ends at the file); only a target this layer lists later is read raw, and a raw
          // link there is not followed, so a cycle or a missing end stays unresolved.
          const merged = idx.nodes.get(n.hard);
          const src = (merged && !idx.unresolved.has(n.hard) ? merged : undefined) ?? (l.entries.get(n.hard)?.hard === undefined ? l.entries.get(n.hard) : undefined);
          if (src && src.type === "file") n = { ...n, size: src.size, layer: src.layer, member: src.member };
          else {
            idx.problems.push(`hard link target unresolved: ${p} -> ${n.hard}`);
            idx.unresolved.add(p);
          }
        }
        idx.put(p, n);
      }
    }
    return idx;
  }

  get(path: string): FsNode | undefined {
    return this.nodes.get(path);
  }

  private put(path: string, n: FsNode): void {
    const old = this.nodes.get(path);
    if (old && old.type === "dir" && n.type !== "dir") this.dropKids(path);
    this.nodes.set(path, n);
    for (let c = path; ; ) {
      const par = dirOf(c);
      let set = this.kids.get(par);
      if (!set) this.kids.set(par, (set = new Set()));
      set.add(c);
      const up = this.nodes.get(par);
      if (par === "" || up?.type === "dir") break;
      // A layer unpacked on its own (overlay) makes a directory for a member's parent, and that directory hides a lower
      // layer's link or file at the same path; it does not write through the link. A runtime that applies layers in place
      // may follow it instead, so the merge models the overlay result and the review holds on it.
      if (up) this.problems.push(`layer writes under a lower ${up.type}: ${path} (${par} becomes a directory)`);
      this.nodes.set(par, dirNode(par));
      if (up) break;
      c = par;
    }
  }

  private dropKids(dir: string): void {
    for (const k of [...(this.kids.get(dir) ?? [])]) this.dropSubtree(k);
  }

  private dropSubtree(path: string): void {
    if (!this.nodes.has(path)) return;
    this.kids.get(dirOf(path))?.delete(path);
    const stack = [path];
    while (stack.length) {
      const p = stack.pop()!;
      this.nodes.delete(p);
      for (const k of this.kids.get(p) ?? []) stack.push(k);
      this.kids.delete(p);
    }
  }

  /** Every path below `dir`, or the first `max` of them. */
  under(dir: string, max = Infinity): string[] {
    const out: string[] = [];
    const stack = [...(this.kids.get(dir) ?? [])];
    while (stack.length && out.length < max) {
      const p = stack.pop()!;
      out.push(p);
      for (const k of this.kids.get(p) ?? []) stack.push(k);
    }
    return out;
  }

  /** The names directly inside `dir`. */
  childNames(dir: string): string[] {
    return [...(this.kids.get(dir) ?? [])].map((k) => k.slice(k.lastIndexOf("/") + 1));
  }

  /** Every link entry, sorted. */
  links(): string[] {
    return [...this.nodes].filter(([, n]) => n.type === "symlink").map(([p]) => p).sort();
  }

  /**
   * `path` with every component's links followed (absolute targets from the root, `..` clamped at the root). `final` is the
   * path reached, "" for the root; it is absent when something on the way is missing, and `loop` is set past 40 links.
   * `links` are the links passed, in order.
   */
  resolve(path: string): { final?: string; links: string[]; loop?: boolean } {
    let parts = path.split("/").filter(Boolean);
    let cur: string[] = [];
    const links: string[] = [];
    while (parts.length) {
      const seg = parts.shift()!;
      if (seg === ".") continue;
      if (seg === "..") {
        cur.pop();
        continue;
      }
      cur.push(seg);
      const p = cur.join("/");
      const n = this.nodes.get(p);
      if (!n) return { links };
      if (n.type === "symlink" && n.link !== undefined) {
        if (links.length >= 40) return { links, loop: true };
        links.push(p);
        cur.pop();
        if (n.link.startsWith("/")) cur = [];
        parts = [...n.link.split("/").filter(Boolean), ...parts];
      } else if (parts.length && n.type !== "dir") return { links };
    }
    return { final: cur.join("/"), links };
  }
}
