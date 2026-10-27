// Lockfile registry: the parser and ecosystem for a lockfile, picked by its file name.

import type { Ecosystem } from "../prepass.ts";
import { parseBunLock, stripTrailingCommas } from "./bunlock.ts";
import { parseNpmLock } from "./npmlock.ts";
import { parsePnpmLock } from "./pnpmlock.ts";
import { parsePoetryLock, parseUvLock } from "./pylock.ts";
import { parseRequirements } from "./requirements.ts";
import type { LockedPackage } from "./types.ts";

export type { LockedPackage } from "./types.ts";

interface LockKind {
  eco: Ecosystem;
  parse: (text: string) => LockedPackage[];
  /** The folders, relative to the lockfile's, of the project's own packages it locks (workspaces); its own folder is implied. */
  members?: (text: string) => string[];
}

const keysOf = (o: unknown) => (o && typeof o === "object" ? Object.keys(o) : []);
const npmMembers = (text: string) => keysOf((JSON.parse(text) as { packages?: unknown }).packages).filter((k) => k && !k.includes("node_modules/"));

const KINDS: Record<string, LockKind> = {
  "bun.lock": { eco: "npm", parse: parseBunLock, members: (text) => keysOf((JSON.parse(stripTrailingCommas(text)) as { workspaces?: unknown }).workspaces) },
  "package-lock.json": { eco: "npm", parse: parseNpmLock, members: npmMembers },
  "npm-shrinkwrap.json": { eco: "npm", parse: parseNpmLock, members: npmMembers },
  "pnpm-lock.yaml": { eco: "npm", parse: parsePnpmLock, members: (text) => keysOf((Bun.YAML.parse(text) as { importers?: unknown }).importers) },
  "uv.lock": {
    eco: "pypi",
    parse: parseUvLock,
    members: (text) =>
      ((Bun.TOML.parse(text) as { package?: { source?: { editable?: unknown; virtual?: unknown } }[] }).package ?? [])
        .map((p) => p.source?.editable ?? p.source?.virtual)
        .filter((d): d is string => typeof d === "string"),
  },
  "poetry.lock": { eco: "pypi", parse: parsePoetryLock },
};

/** The lockfile names oupdate reads, in the order the gate looks for them at the repo root. */
export const LOCK_NAMES = Object.keys(KINDS);

/** Pinned requirements files, read only when named by --lock: the name alone does not say a file is pinned. */
const REQUIREMENTS = /^requirements.*\.txt$|\.lock\.txt$/;
const REQUIREMENTS_KIND: LockKind = { eco: "pypi", parse: parseRequirements };

/** The kind of the lockfile at `path`, by its base name. An unknown name throws, never reads as empty. */
export function lockKind(path: string): LockKind {
  const base = path.split("/").pop() ?? "";
  const kind = KINDS[base] ?? (REQUIREMENTS.test(base) ? REQUIREMENTS_KIND : undefined);
  if (!kind) throw new Error(`unsupported lockfile ${path}: oupdate reads ${LOCK_NAMES.join(", ")}, and requirements*.txt or *.lock.txt named by --lock`);
  return kind;
}

export function parseLock(path: string, text: string): { eco: Ecosystem; pkgs: LockedPackage[]; members: string[] } {
  const kind = lockKind(path);
  return { eco: kind.eco, pkgs: kind.parse(text), members: kind.members?.(text) ?? [] };
}
