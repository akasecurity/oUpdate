// Reads a sample from a malicious-package dataset (encrypted zip) into a file
// map comparable with a registry artifact. Static only. Four layouts are known:
// an unpacked npm tree (`.../package/...` plus a metadata json), an unpacked
// sdist tree (the dir with PKG-INFO), an unpacked wheel tree (the dir with
// *.dist-info/METADATA) and a wrapper around one inner archive.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readArtifact } from "./artifact.ts";
import type { FileMap } from "./prepass.ts";

const ARCHIVE = /\.(zip|whl|tar\.gz|tgz|tar)$/;

export async function readSample(zipPath: string, passphrase: string): Promise<FileMap> {
  const outer = await readArtifact(zipPath, { passphrase });
  const pkgKeys = [...outer.keys()].filter((k) => /(^|\/)package\//.test(k));
  if (pkgKeys.length) {
    const out: FileMap = new Map();
    for (const k of pkgKeys) out.set(k.slice(k.search(/(^|\/)package\//) + (k.startsWith("package/") ? 0 : 1)), outer.get(k)!);
    return out;
  }
  const archives = [...outer.keys()].filter((k) => ARCHIVE.test(k));
  if (archives.length === 1 && outer.size === 1) {
    const dir = mkdtempSync(join(tmpdir(), "oupdate-sample-"));
    try {
      const name = archives[0]!.split("/").pop()!;
      const p = join(dir, name);
      writeFileSync(p, outer.get(archives[0]!)!);
      return await readArtifact(p);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  // An unpacked sdist: the shallowest dir holding PKG-INFO becomes the root.
  const roots = [...outer.keys()].filter((k) => k === "PKG-INFO" || k.endsWith("/PKG-INFO")).sort((a, b) => a.split("/").length - b.split("/").length);
  if (roots.length) {
    const prefix = roots[0]!.slice(0, -"PKG-INFO".length);
    const out: FileMap = new Map();
    for (const [k, v] of outer) if (k.startsWith(prefix)) out.set(k.slice(prefix.length), v);
    return out;
  }
  // An unpacked wheel: the dir holding *.dist-info/METADATA is the root, and the
  // dataset stores each file X as X/X under it (ultralytics 8.3.41).
  const meta = [...outer.keys()].map((k) => /^(.*?)([^/]+\.dist-info\/METADATA)\/\2$/.exec(k)).find((m) => m);
  if (meta) {
    const prefix = meta[1]!;
    const out: FileMap = new Map();
    for (const [k, v] of outer) {
      const doubled = k.startsWith(prefix) && /^(.+)\/\1$/.exec(k.slice(prefix.length));
      if (doubled) out.set(doubled[1]!, v);
    }
    return out;
  }
  throw new Error(`unknown sample layout in ${zipPath}: ${[...outer.keys()].slice(0, 5).join(", ")}`);
}
