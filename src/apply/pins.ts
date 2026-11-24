// Pinned tools are held, never upgraded (ported from the previous updater's pin filter). A tool is
// held when brew pins it (formulae only: `brew outdated` still lists pinned formulae, and naming
// one to `brew upgrade` is an error) or when a repo lists it in a pins.json at its root:
//   {"brew": {"duckdb": "1.5.5"}, "cask": {"brave-browser": "1.97"}}
// Any upgrade of a listed tool is held, whatever the version; the version is for the reader.
// Names match on their last path segment. Lifting a hold is the repo's change, or `brew unpin`.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export interface PinFile {
  /** The repo directory's name, reported as the reason. */
  repo: string;
  /** Where it was read, for the warning. */
  path: string;
  /** undefined when the file exists but could not be read. */
  text: string | undefined;
}

/**
 * Every <root>/<repo>/pins.json one level under the roots (dot-directories skipped, as the shell
 * glob did). A pins.json that exists but cannot be read is kept with no text, so pinFilter warns.
 */
export function readPinFiles(roots: string[]): PinFile[] {
  const out: PinFile[] = [];
  for (const root of roots) {
    let names: string[];
    try {
      names = readdirSync(root).sort();
    } catch (e) {
      // A root that does not exist holds no pins; one that cannot be read (permissions, a protected folder) is a warning.
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") out.push({ repo: root, path: root, text: undefined });
      continue;
    }
    for (const repo of names) {
      if (repo.startsWith(".")) continue;
      const p = join(root, repo, "pins.json");
      try {
        if (!statSync(p).isFile()) {
          // Something named pins.json that is not a file (a directory): the repo meant to pin and the pins cannot be read.
          out.push({ repo, path: p, text: undefined });
          continue;
        }
      } catch (e) {
        // No pins.json in this repo is silent; one that cannot be looked at (permissions) is a warning.
        const code = (e as NodeJS.ErrnoException).code;
        if (code !== "ENOENT" && code !== "ENOTDIR") out.push({ repo, path: p, text: undefined });
        continue;
      }
      let text: string | undefined;
      try {
        text = readFileSync(p, "utf8");
      } catch {
        text = undefined;
      }
      out.push({ repo, path: p, text });
    }
  }
  return out;
}

export interface PinResult {
  kept: string[];
  /** "<name>(<why>)", why being the repo or "brew pin". */
  pinned: string[];
  warnings: string[];
}

/** The pin key of a name: its last path segment, lower case (acme/tools/Foo@2 pins foo@2). */
export const key = (n: string) => n.split("/").at(-1)!.toLowerCase();

export function pinFilter(kind: "brew" | "cask", names: string[], o: { brewPinned?: string[]; files: PinFile[] }): PinResult {
  const held = new Map<string, string>();
  const warnings: string[] = [];
  if (kind === "brew") for (const n of o.brewPinned ?? []) if (!held.has(key(n))) held.set(key(n), "brew pin");
  for (const f of o.files) {
    let j: unknown;
    try {
      j = f.text === undefined ? undefined : JSON.parse(f.text);
    } catch {
      j = undefined;
    }
    if (!j || typeof j !== "object" || Array.isArray(j)) {
      warnings.push(`WARNING: ${f.path}: pins.json unreadable, holds nothing`);
      continue;
    }
    const section = (j as Record<string, unknown>)[kind];
    if (section === undefined) continue;
    if (section && typeof section === "object" && !Array.isArray(section)) {
      for (const n of Object.keys(section)) if (!held.has(key(n))) held.set(key(n), f.repo);
    } else warnings.push(`WARNING: ${f.path}: "${kind}" is not an object, holds nothing`);
  }
  const kept: string[] = [];
  const pinned: string[] = [];
  for (const n of names) {
    const why = held.get(key(n));
    if (why) pinned.push(`${n}(${why})`);
    else kept.push(n);
  }
  return { kept, pinned, warnings };
}

/** The names a pending query must skip for the pinned entries: each in full and by its last segment. */
export function heldFromPinned(pinned: string[]): string[] {
  return pinned.flatMap((p) => {
    const n = p.replace(/\(.*$/, "");
    return [n, n.split("/").at(-1)!];
  });
}
