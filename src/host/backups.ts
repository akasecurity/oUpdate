// oUpdate's own old config backups: after a clean apply run, files in the config directory that
// match a FIXED list of backup name patterns and are older than the current config.json are deleted.
// Nothing else in the directory is ever touched (renovate, renovate-token, release-signing,
// scan-deny.txt, other tools' files). A dry run lists what it would delete and deletes nothing.

import type { ApplyFs } from "../apply/fs.ts";

/** The fixed name prefixes (each pattern is `<prefix>*` with a non-empty rest). */
export const BACKUP_PREFIXES = ["config.json.bak-", "config.json.pre-", "config.json.bak-pre-", "targets.json.pre-"] as const;

// The directory as given, never normalized: path.join would fold a `..` after a symlink lexically, where the kernel resolves it physically (as it did when it read config.json).
const at = (dir: string, name: string) => (dir.endsWith("/") ? dir + name : `${dir}/${name}`);

export const isBackupName = (name: string) => BACKUP_PREFIXES.some((p) => name.length > p.length && name.startsWith(p));

/**
 * Deletes the old backups in `dir`; returns the log lines. A backup is old when its mtime is before
 * config.json's. A failed delete is a warning line, never a failure. No config.json (or no way to
 * read mtimes): nothing is deleted.
 */
export async function cleanOldBackups(dir: string, fs: Pick<ApplyFs, "listDir" | "mtimeMs" | "remove">, dryRun: boolean): Promise<string[]> {
  if (!fs.mtimeMs) return [];
  const cur = await fs.mtimeMs(at(dir, "config.json"));
  if (cur === undefined) return [];
  const lines: string[] = [];
  for (const name of (await fs.listDir(dir)).filter(isBackupName).sort()) {
    const path = at(dir, name);
    const m = await fs.mtimeMs(path);
    if (m === undefined || m >= cur) continue;
    if (dryRun) {
      lines.push(`config backup: would delete ${path}`);
      continue;
    }
    try {
      await fs.remove(path);
      lines.push(`config backup: deleted ${path}`);
    } catch (e) {
      lines.push(`WARNING: config backup: could not delete ${path} (${e instanceof Error ? e.message : String(e)})`);
    }
  }
  return lines;
}
