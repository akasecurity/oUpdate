// Lockfile registry: the parser and ecosystem for a lockfile, picked by its file name.

import type { Ecosystem } from "../prepass.ts";
import { parseBunLock } from "./bunlock.ts";
import { parseNpmLock } from "./npmlock.ts";
import { parsePnpmLock } from "./pnpmlock.ts";
import { parsePoetryLock, parseUvLock } from "./pylock.ts";
import { parseRequirements } from "./requirements.ts";
import type { LockedPackage } from "./types.ts";

export type { LockedPackage } from "./types.ts";

interface LockKind {
  eco: Ecosystem;
  parse: (text: string) => LockedPackage[];
}

const KINDS: Record<string, LockKind> = {
  "bun.lock": { eco: "npm", parse: parseBunLock },
  "package-lock.json": { eco: "npm", parse: parseNpmLock },
  "npm-shrinkwrap.json": { eco: "npm", parse: parseNpmLock },
  "pnpm-lock.yaml": { eco: "npm", parse: parsePnpmLock },
  "uv.lock": { eco: "pypi", parse: parseUvLock },
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

export function parseLock(path: string, text: string): { eco: Ecosystem; pkgs: LockedPackage[] } {
  const kind = lockKind(path);
  return { eco: kind.eco, pkgs: kind.parse(text) };
}
