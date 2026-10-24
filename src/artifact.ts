// Reads a release artifact (tgz, tar, wheel/zip) into a path -> bytes map.
// Static only: it lists members, refuses unsafe names, unpacks into a private
// temp dir with bsdtar, reads regular files and removes the dir. Nothing in the
// artifact is installed, imported or run.

import { mkdtempSync, readdirSync, readFileSync, lstatSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { FileMap } from "./prepass.ts";

const MAX_TOTAL_BYTES = 300_000_000;

function run(args: string[]): string {
  const p = Bun.spawnSync(["bsdtar", ...args], { stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(`bsdtar ${args[0]} failed: ${new TextDecoder().decode(p.stderr).trim()}`);
  return new TextDecoder().decode(p.stdout);
}

function normalize(name: string): string {
  return name.replace(/^(\.\/)+/, "");
}

export function isUnsafeMember(name: string): boolean {
  const n = normalize(name);
  return n.startsWith("/") || n.split("/").includes("..") || /^[A-Za-z]:/.test(n);
}

// Makes two versions of one package comparable path by path: drops a top dir
// shared by every member (sdist `name-version/`, npm `package/`) and replaces
// the version in wheel `name-version.dist-info` / `.data` dirs.
export function normalizePaths(files: FileMap): FileMap {
  const keys = [...files.keys()];
  const tops = new Set(keys.map((k) => k.split("/")[0]));
  const strip = tops.size === 1 && keys.every((k) => k.includes("/"));
  const out: FileMap = new Map();
  for (const [k, v] of files) {
    let p = strip ? k.slice(k.indexOf("/") + 1) : k;
    p = p.replace(/^([A-Za-z0-9_.]+?)-[0-9][^/]*?\.(dist-info|data)\//, "$1-VERSION.$2/");
    out.set(p, v);
  }
  return out;
}

export async function readArtifact(path: string, opts: { passphrase?: string } = {}): Promise<FileMap> {
  const members = run(["-tf", path]).split("\n").filter(Boolean);
  for (const m of members) {
    if (isUnsafeMember(m)) throw new Error(`unsafe member in ${path}: ${m}`);
  }
  const dir = mkdtempSync(join(tmpdir(), "oupdate-unpack-"));
  try {
    run(["-xf", path, "-C", dir, "--no-same-owner", "--no-same-permissions", ...(opts.passphrase ? ["--passphrase", opts.passphrase] : [])]);
    const out: FileMap = new Map();
    let total = 0;
    const walk = (rel: string) => {
      for (const name of readdirSync(join(dir, rel))) {
        const r = rel ? `${rel}/${name}` : name;
        const st = lstatSync(join(dir, r));
        if (st.isDirectory()) walk(r);
        else if (st.isFile()) {
          total += st.size;
          if (total > MAX_TOTAL_BYTES) throw new Error(`artifact over ${MAX_TOTAL_BYTES} bytes unpacked: ${path}`);
          out.set(r, new Uint8Array(readFileSync(join(dir, r))));
        }
        // Symlinks and special files are not followed or read.
      }
    };
    walk("");
    return out;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
