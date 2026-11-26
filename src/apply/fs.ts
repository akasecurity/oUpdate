// The small file-system surface of the host apply, so a run can be scripted in tests.

import { execFile } from "node:child_process";
import { accessSync, appendFileSync, closeSync, constants, lstatSync, mkdirSync, openSync, readSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
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
  /** A state file: undefined only when it is missing; any other read failure throws (an unread state is never no state). */
  readState?(path: string): Promise<string | undefined>;
  /** A state directory: [] only when it is missing; any other read failure throws. */
  listState?(path: string): Promise<string[]>;
  /** Replaces the file whole (write to a temporary name, then rename). */
  writeFile(path: string, text: string): Promise<void>;
  remove(path: string): Promise<void>;
  /** Appends in one write (O_APPEND): two processes adding a line each never lose one. */
  appendFile?(path: string, text: string): Promise<void>;
  /** Modification date, YYYY-MM-DD local. */
  mtimeDay(path: string): Promise<string>;
  /** Modification time in ms of a regular file (a link or directory is not one); undefined when missing or not a regular file. */
  mtimeMs?(path: string): Promise<number | undefined>;
  /** The first `bytes` bytes as text of a regular file (a link to one counts); undefined when it is missing, unreadable or not a regular file (a FIFO or device is never opened). */
  readHead?(path: string, bytes: number): Promise<string | undefined>;
  /**
   * A property list read by the OS's own parser (/usr/bin/plutil, the reader launchd's files are written for), as the
   * parsed top-level object. undefined for anything else: not a regular file, over 256 KiB, no plutil, a non-zero exit,
   * a timeout, output that is not a JSON object. Read-only: plutil writes to stdout and never to the file.
   */
  plistJson?(path: string): Promise<Record<string, unknown> | undefined>;
  /** Starts argv in its own process group, stderr appended to a file; returns the pid. */
  spawnDetached(argv: string[], stderrFile: string): Promise<number>;
  pinFiles(roots: string[]): PinFile[];
}

/** The largest property list handed to plutil. */
export const PLIST_MAX_BYTES = 256 * 1024;

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
  readState: async (p) => {
    try {
      return readFileSync(p, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw e;
    }
  },
  listState: async (p) => {
    try {
      return readdirSync(p);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw e;
    }
  },
  writeFile: async (p, text) => {
    mkdirSync(dirname(p), { recursive: true });
    const tmp = `${p}.new.${process.pid}`;
    writeFileSync(tmp, text);
    renameSync(tmp, p);
  },
  remove: async (p) => rmSync(p, { force: true }),
  appendFile: async (p, text) => {
    mkdirSync(dirname(p), { recursive: true });
    appendFileSync(p, text);
  },
  mtimeDay: mtimeDayOf,
  mtimeMs: async (p) => {
    try {
      const s = lstatSync(p);
      return s.isFile() ? s.mtimeMs : undefined;
    } catch {
      return undefined;
    }
  },
  readHead: async (p, bytes) => {
    try {
      if (!statSync(p).isFile()) return undefined;
      const fd = openSync(p, "r");
      try {
        const buf = Buffer.alloc(bytes);
        return buf.subarray(0, readSync(fd, buf, 0, bytes, 0)).toString("utf8");
      } finally {
        closeSync(fd);
      }
    } catch {
      return undefined;
    }
  },
  plistJson: async (p) => {
    try {
      const st = statSync(p);
      if (!st.isFile() || st.size > PLIST_MAX_BYTES) return undefined; // a FIFO or device never reaches plutil
      // No shell: an argument array, `--` before the path (a name that starts with "-" is a path), stdout only.
      const out = await new Promise<string>((ok, no) =>
        execFile("/usr/bin/plutil", ["-convert", "json", "-o", "-", "--", p], { timeout: 5000, maxBuffer: 1024 * 1024, encoding: "utf8" }, (e, stdout) => (e ? no(e) : ok(stdout))),
      );
      const v: unknown = JSON.parse(out);
      return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
    } catch {
      return undefined;
    }
  },
  spawnDetached: realSpawnDetached,
  pinFiles: readPinFiles,
};
