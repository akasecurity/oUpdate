// GuardDog as a diff layer: static rules (yara and regex; 3.2.0 runs all 54 without semgrep) over the old and the new
// release, run by a configured command (argv, no shell) such as a sandboxed
// container. oupdate writes the files it already unpacked into a directory, so
// GuardDog's own archive extraction never runs. Only findings new in the new
// release count.

import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { isUnsafeMember } from "../../artifact.ts";
import type { FileMap } from "../../prepass.ts";
import type { Scanner } from "../../review.ts";
import type { Finding } from "./types.ts";

// Writes a FileMap under dir (created here), dirs 0755 and files 0644 so a
// sandbox user can read them. Every path is checked before anything is written.
export function materialize(files: FileMap, dir: string): void {
  for (const p of files.keys()) if (isUnsafeMember(p) || p === "") throw new Error(`unsafe path for scan: ${p}`);
  mkdirSync(dir, { recursive: true, mode: 0o755 });
  chmodSync(dir, 0o755);
  for (const [p, bytes] of files) {
    const f = join(dir, p);
    mkdirSync(dirname(f), { recursive: true, mode: 0o755 });
    writeFileSync(f, bytes, { mode: 0o644 });
  }
}

// GuardDog's JSON: results maps each rule to a list of {location "path:line",
// match, message} for source rules, or to a string / non-empty object for a
// package-level (metadata) hit; an empty object is no hit. A non-empty errors
// map means a rule did not run, so the scan is not clean. scanDir is the path
// the scanner saw (e.g. the container mount) and is stripped from locations.
export function parseGuardDog(stdout: string, scanDir?: string): Finding[] {
  let j: { results?: unknown; errors?: unknown };
  try {
    j = JSON.parse(stdout.trim());
  } catch {
    // Some versions log before the report; the report is the last line that is an object.
    const last = stdout.trim().split("\n").reverse().find((l) => l.startsWith("{"));
    try {
      j = JSON.parse(last ?? "");
    } catch {
      throw new Error("guarddog output is not JSON");
    }
  }
  if (!j.results || typeof j.results !== "object") throw new Error("guarddog output has no results");
  if (j.errors && typeof j.errors === "object" && Object.keys(j.errors).length) {
    throw new Error(`guarddog rule error: ${Object.keys(j.errors).join(", ").slice(0, 300)}`);
  }
  const out: Finding[] = [];
  const prefix = scanDir ? scanDir.replace(/\/+$/, "") + "/" : undefined;
  for (const [rule, v] of Object.entries(j.results as Record<string, unknown>)) {
    if (Array.isArray(v)) {
      for (const hit of v as { location?: string; match?: string; message?: string }[]) {
        let path = String(hit.location ?? "").replace(/:\d+$/, "");
        if (prefix && path.startsWith(prefix)) path = path.slice(prefix.length);
        path = path.replace(/^\.\//, "");
        out.push({ rule, path, detail: [hit.message, hit.match].filter(Boolean).join(": ").slice(0, 200) });
      }
    } else if (typeof v === "string" && v) out.push({ rule, path: "", detail: v.slice(0, 200) });
    else if (v && typeof v === "object" && Object.keys(v).length) {
      const m = (v as { message?: unknown }).message;
      out.push({ rule, path: "", detail: (typeof m === "string" ? m : JSON.stringify(v)).slice(0, 200) });
    }
  }
  return out;
}

export interface GuardDogScannerConfig {
  name: string;
  // Command with {eco} and {dir} placeholders, run with no shell, e.g. a
  // `docker run --network none ... -v {dir}:/scan:ro image {eco} scan /scan --output-format json`.
  argv: string[];
  // Where the per-scan directory goes. A colima/docker VM only mounts $HOME, so put it there.
  workRoot?: string;
  // The scanned dir as the scanner sees it (the container mount), stripped from paths.
  stripPrefix?: string;
  timeoutMs?: number;
}

export function guarddogScanner(cfg: GuardDogScannerConfig): Scanner {
  return {
    name: cfg.name,
    async scan(eco, files) {
      const root = mkdtempSync(join(cfg.workRoot ?? tmpdir(), "oupdate-scan-"));
      try {
        chmodSync(root, 0o755);
        const dir = join(root, "pkg");
        materialize(files, dir);
        const argv = cfg.argv.map((a) => a.replaceAll("{eco}", eco).replaceAll("{dir}", dir));
        const proc = Bun.spawn(argv, { cwd: root, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
        let timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          proc.kill();
        }, cfg.timeoutMs ?? 600_000);
        const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
        clearTimeout(timer);
        if (timedOut) throw new Error(`scanner ${cfg.name} timed out`);
        if (code !== 0) throw new Error(`scanner ${cfg.name} exit ${code}: ${err.trim().split("\n").pop()?.slice(0, 300) ?? ""}`);
        return parseGuardDog(out, cfg.stripPrefix ?? dir);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  };
}
