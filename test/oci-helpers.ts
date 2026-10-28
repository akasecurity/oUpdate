// Layer fixtures for the image-layer tests: the tarballs in test/fixtures/oci/ as an ImageLayers whose fetch copies a file.
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { sha256Digest, type ImageDetail, type ImageLayers, type LayerInfo } from "../src/adapters/oci/registry.ts";

const dir = join(import.meta.dir, "fixtures/oci");
const path = (name: string) => (name.startsWith("/") ? name : join(dir, name));

export const noDetail: ImageDetail = { env: [], user: "", workdir: "", ports: [], volumes: [], labels: [], healthcheck: "", onbuild: [], shell: [] };

export function layerInfo(name: string, mediaType?: string): LayerInfo {
  const b = readFileSync(path(name));
  return {
    digest: sha256Digest(b),
    size: b.length,
    mediaType: mediaType ?? (name.endsWith(".gz") ? "application/vnd.oci.image.layer.v1.tar+gzip" : "application/vnd.oci.image.layer.v1.tar"),
  };
}

/** An image of the named fixture layers, oldest first; `fail` makes a layer's fetch throw. `fetched` records the names fetched. */
export function fakeLayers(names: string[], opts: { detail?: Partial<ImageDetail>; mediaTypes?: Record<string, string>; fail?: Record<string, string> } = {}): ImageLayers & { fetched: string[] } {
  const byDigest = new Map<string, string>();
  const layers = names.map((n) => {
    const info = layerInfo(n, opts.mediaTypes?.[n]);
    byDigest.set(info.digest, n);
    return info;
  });
  const fetched: string[] = [];
  return {
    detail: { ...noDetail, ...opts.detail },
    layers,
    fetched,
    async fetchLayer(l, dest) {
      const n = byDigest.get(l.digest)!;
      fetched.push(n);
      if (opts.fail?.[n]) throw new Error(opts.fail[n]);
      copyFileSync(path(n), dest);
    },
  };
}

export async function withTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const d = mkdtempSync(join(tmpdir(), "oup28-"));
  try {
    return await fn(d);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
}

/** A layer built at test time: path -> file text, `{ text, mode }` for a file with a mode, `{ link }` for a symlink, `{ dir }` for an (empty) directory. */
export type LayerSpec = Record<string, string | { text: string; mode: number } | { link: string } | { dir: true }>;

function writeSpec(root: string, spec: LayerSpec): void {
  for (const [p, v] of Object.entries(spec)) {
    const abs = join(root, p);
    mkdirSync(dirname(abs), { recursive: true });
    if (typeof v === "string") writeFileSync(abs, v);
    else if ("text" in v) {
      writeFileSync(abs, v.text);
      chmodSync(abs, v.mode);
    } else if ("link" in v) symlinkSync(v.link, abs);
    else mkdirSync(abs, { recursive: true });
  }
}

/** A tar of exactly the named members, with no entries for the directories above them; returns its path. */
export function bareTar(dir: string, tag: string, spec: LayerSpec): string {
  const root = join(dir, `${tag}.bare`);
  mkdirSync(root, { recursive: true });
  writeSpec(root, spec);
  const tar = join(dir, `${tag}.tar`);
  const r = Bun.spawnSync(["bsdtar", "--uid", "0", "--gid", "0", "--numeric-owner", "-cf", tar, "-C", root, ...Object.keys(spec)]);
  if (r.exitCode !== 0) throw new Error(`bsdtar ${tar}: ${r.stderr.toString()}`);
  return tar;
}

/** An image of layers built from specs with bsdtar into `dir` (oldest first); nothing is fetched from anywhere. */
export function specLayers(dir: string, tag: string, specs: (LayerSpec | { tar: string })[]): ImageLayers {
  const files = new Map<string, string>();
  const layers = specs.map((spec, i) => {
    if ("tar" in spec && typeof spec.tar === "string") {
      const info = layerInfo(spec.tar);
      files.set(info.digest, spec.tar);
      return info;
    }
    spec = spec as LayerSpec;
    const root = join(dir, `${tag}-${i}.root`);
    mkdirSync(root, { recursive: true });
    writeSpec(root, spec);
    const tar = join(dir, `${tag}-${i}.tar`);
    const r = Bun.spawnSync(["bsdtar", "--uid", "0", "--gid", "0", "--numeric-owner", "-cf", tar, "-C", root, "."]);
    if (r.exitCode !== 0) throw new Error(`bsdtar ${tar}: ${r.stderr.toString()}`);
    const info = layerInfo(tar);
    files.set(info.digest, tar);
    return info;
  });
  return { detail: noDetail, layers, async fetchLayer(l, dest) { copyFileSync(files.get(l.digest)!, dest); } };
}

/** A tar of hard-link entries only (name -> target, in order, repeats kept), written to `file`. */
export function hardlinkTar(file: string, links: [string, string][]): string {
  const blocks = links.map(([name, target]) => {
    const header = Buffer.alloc(512);
    header.write(name, 0);
    header.write("0000644\0", 100);
    header.write("0000000\0", 108);
    header.write("0000000\0", 116);
    header.write("00000000000\0", 124);
    header.write("00000000000\0", 136);
    header.write("        ", 148);
    header.write("1", 156);
    header.write(target, 157);
    header.write("ustar\0", 257);
    header.write("00", 263);
    let sum = 0;
    for (const b of header) sum += b;
    header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
    return header;
  });
  writeFileSync(file, Buffer.concat([...blocks, Buffer.alloc(1024)]));
  return file;
}
