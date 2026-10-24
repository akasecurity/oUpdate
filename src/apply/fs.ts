// The small file-system surface of the host apply, so a run can be scripted in tests.

import { accessSync, constants, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { homedir } from "node:os";
import { readPinFiles, type PinFile } from "./pins.ts";
import { mtimeDayOf, realSpawnDetached } from "./waiter.ts";

export interface ApplyFs {
  home: string;
  uid: number;
  exists(path: string): Promise<boolean>;
  isDir(path: string): Promise<boolean>;
  /** A file this process may execute (bash's `-x`, a directory excluded). */
  isExecutable(path: string): Promise<boolean>;
  /** File names in a directory; [] when it cannot be read. */
  listDir(path: string): Promise<string[]>;
  /** The text, or undefined when the file is missing or cannot be read. */
  readFile(path: string): Promise<string | undefined>;
  /** Replaces the file whole (write to a temporary name, then rename). */
  writeFile(path: string, text: string): Promise<void>;
  remove(path: string): Promise<void>;
  /** Modification date, YYYY-MM-DD local. */
  mtimeDay(path: string): Promise<string>;
  /** Starts argv in its own process group, stderr appended to a file; returns the pid. */
  spawnDetached(argv: string[], stderrFile: string): Promise<number>;
  pinFiles(roots: string[]): PinFile[];
}

export const realFs: ApplyFs = {
  home: homedir(),
  uid: process.getuid?.() ?? 0,
  exists: async (p) => {
    try {
      statSync(p);
      return true;
    } catch {
      return false;
    }
  },
  isDir: async (p) => {
    try {
      return statSync(p).isDirectory();
    } catch {
      return false;
    }
  },
  isExecutable: async (p) => {
    try {
      accessSync(p, constants.X_OK);
      return !statSync(p).isDirectory();
    } catch {
      return false;
    }
  },
  listDir: async (p) => {
    try {
      return readdirSync(p);
    } catch {
      return [];
    }
  },
  readFile: async (p) => {
    try {
      return readFileSync(p, "utf8");
    } catch {
      return undefined;
    }
  },
  writeFile: async (p, text) => {
    mkdirSync(dirname(p), { recursive: true });
    const tmp = `${p}.new.${process.pid}`;
    writeFileSync(tmp, text);
    renameSync(tmp, p);
  },
  remove: async (p) => rmSync(p, { force: true }),
  mtimeDay: mtimeDayOf,
  spawnDetached: realSpawnDetached,
  pinFiles: readPinFiles,
};
