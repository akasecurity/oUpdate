// Client-key check: the install-time hardening each package manager already ships, read from a repo's own config.
// Build-script denial (npm ignore-scripts + allow-git=none, pnpm strictDepBuilds, bun's default) and the per-client
// release-age cooldown. Config only: oupdate reports what is set; it never edits the files.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type Manager = "npm" | "pnpm" | "bun" | "uv";
export type KeyStatus = "ok" | "missing" | "weak" | "info" | "error";

export interface KeyFinding {
  manager: Manager;
  file: string;
  key: string;
  status: KeyStatus;
  want: string;
  got?: string;
  note?: string;
}

export interface KeyOptions {
  cooldownDays: number;
}

export type KeyFiles = Record<string, string>;

const LOCKFILES: [string, Manager][] = [
  ["package-lock.json", "npm"],
  ["npm-shrinkwrap.json", "npm"],
  ["pnpm-lock.yaml", "pnpm"],
  ["bun.lock", "bun"],
  ["bun.lockb", "bun"],
  ["uv.lock", "uv"],
];

const CONFIG_FILES = [".npmrc", "pnpm-workspace.yaml", "bunfig.toml", "package.json", "pyproject.toml", "uv.toml"];

export function readKeyFiles(dir: string): KeyFiles {
  const out: KeyFiles = {};
  for (const name of [...LOCKFILES.map(([f]) => f), ...CONFIG_FILES]) {
    const p = join(dir, name);
    if (existsSync(p)) out[name] = readFileSync(p, "utf8");
  }
  return out;
}

export function detectManagers(files: KeyFiles): Manager[] {
  const seen = new Set<Manager>();
  for (const [f, m] of LOCKFILES) if (f in files) seen.add(m);
  return (["npm", "pnpm", "bun", "uv"] as Manager[]).filter((m) => seen.has(m));
}

function parseNpmrc(text: string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  for (const raw of (text ?? "").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    out.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim());
  }
  return out;
}

type Parsed = { ok: true; value: Record<string, unknown> } | { ok: false; error: string };

function parseWith(fn: (s: string) => unknown, text: string | undefined): Parsed {
  if (text === undefined) return { ok: true, value: {} };
  try {
    const v = fn(text);
    return { ok: true, value: v && typeof v === "object" ? (v as Record<string, unknown>) : {} };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

function age(manager: Manager, file: string, key: string, got: unknown, unitMs: number, unit: string, o: KeyOptions): KeyFinding {
  const wantN = (o.cooldownDays * 86_400_000) / unitMs;
  const want = `>= ${wantN} ${unit} (${o.cooldownDays} days)`;
  if (got === undefined || got === null || got === "") return { manager, file, key, status: "missing", want };
  const n = Number(got);
  if (!Number.isFinite(n)) return { manager, file, key, status: "weak", want, got: String(got), note: "not a number" };
  return { manager, file, key, status: n >= wantN ? "ok" : "weak", want, got: String(got) };
}

function flag(manager: Manager, file: string, key: string, got: string | undefined, want: string): KeyFinding {
  if (got === undefined) return { manager, file, key, status: "missing", want };
  return { manager, file, key, status: got === want ? "ok" : "weak", want, got };
}

function npmKeys(files: KeyFiles, o: KeyOptions): KeyFinding[] {
  const rc = parseNpmrc(files[".npmrc"]);
  return [
    flag("npm", ".npmrc", "ignore-scripts", rc.get("ignore-scripts"), "true"),
    flag("npm", ".npmrc", "allow-git", rc.get("allow-git"), "none"),
    age("npm", ".npmrc", "min-release-age", rc.get("min-release-age"), 86_400_000, "days", o),
  ];
}

function pnpmKeys(files: KeyFiles, o: KeyOptions): KeyFinding[] {
  const ws = parseWith(Bun.YAML.parse, files["pnpm-workspace.yaml"]);
  if (!ws.ok) return [{ manager: "pnpm", file: "pnpm-workspace.yaml", key: "*", status: "error", want: "valid YAML", note: ws.error }];
  const rc = parseNpmrc(files[".npmrc"]);
  const y = ws.value;
  const strictY = y.strictDepBuilds;
  const strict = strictY !== undefined ? flag("pnpm", "pnpm-workspace.yaml", "strictDepBuilds", String(strictY), "true")
    : flag("pnpm", ".npmrc", "strictDepBuilds", rc.get("strict-dep-builds"), "true");
  const ageY = y.minimumReleaseAge;
  const ageF = ageY !== undefined ? age("pnpm", "pnpm-workspace.yaml", "minimumReleaseAge", ageY, 60_000, "minutes", o)
    : age("pnpm", ".npmrc", "minimumReleaseAge", rc.get("minimum-release-age"), 60_000, "minutes", o);
  const allowed: string[] = [];
  if (y.allowBuilds && typeof y.allowBuilds === "object") {
    for (const [k, v] of Object.entries(y.allowBuilds as Record<string, unknown>)) if (v === true) allowed.push(k);
  }
  if (Array.isArray(y.onlyBuiltDependencies)) allowed.push(...y.onlyBuiltDependencies.map(String));
  const allow: KeyFinding = { manager: "pnpm", file: "pnpm-workspace.yaml", key: "allowBuilds", status: "info", want: "only packages whose build scripts were reviewed", got: allowed.join(", ") || "none" };
  return [strict, ageF, allow];
}

function bunKeys(files: KeyFiles, o: KeyOptions): KeyFinding[] {
  const out: KeyFinding[] = [];
  const pkg = parseWith(JSON.parse, files["package.json"]);
  const trusted = pkg.ok && Array.isArray(pkg.value.trustedDependencies) ? pkg.value.trustedDependencies.map(String) : [];
  out.push(pkg.ok
    ? { manager: "bun", file: "package.json", key: "trustedDependencies", status: "info", want: "only packages whose lifecycle scripts were reviewed (bun runs no others)", got: trusted.join(", ") || "none" }
    : { manager: "bun", file: "package.json", key: "*", status: "error", want: "valid JSON", note: pkg.error });
  const cfg = parseWith(Bun.TOML.parse, files["bunfig.toml"]);
  if (!cfg.ok) out.push({ manager: "bun", file: "bunfig.toml", key: "*", status: "error", want: "valid TOML", note: cfg.error });
  else {
    const install = cfg.value.install as Record<string, unknown> | undefined;
    out.push(age("bun", "bunfig.toml", "minimumReleaseAge", install?.minimumReleaseAge, 1000, "seconds", o));
  }
  return out;
}

const UNIT_MS: Record<string, number> = { second: 1000, minute: 60_000, hour: 3_600_000, day: 86_400_000, week: 604_800_000 };

/** uv's exclude-newer duration in ms: "7 days", "1 week", ISO 8601 "P7D"/"P2W"/"PT48H". Undefined if not a duration. */
export function uvDurationMs(v: string): number | undefined {
  const friendly = /^(\d+(?:\.\d+)?)\s*(second|minute|hour|day|week)s?$/i.exec(v.trim());
  if (friendly) return Number(friendly[1]) * UNIT_MS[friendly[2]!.toLowerCase()]!;
  const iso = /^P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/i.exec(v.trim());
  if (iso && v.trim().length > 1 && !/T$/i.test(v.trim())) {
    const [, w, d, h, m, s] = iso.map((x) => Number(x ?? 0));
    return w! * UNIT_MS.week! + d! * UNIT_MS.day! + h! * UNIT_MS.hour! + m! * UNIT_MS.minute! + s! * 1000;
  }
  return undefined;
}

function uvKeys(files: KeyFiles, o: KeyOptions): KeyFinding[] {
  const want = `a rolling duration >= ${o.cooldownDays} days ("${o.cooldownDays} days")`;
  const sources: [string, (v: Record<string, unknown>) => unknown][] = [
    ["uv.toml", (v) => v["exclude-newer"]],
    ["pyproject.toml", (v) => (v.tool as Record<string, Record<string, unknown>> | undefined)?.uv?.["exclude-newer"]],
  ];
  for (const [file, pick] of sources) {
    const p = parseWith(Bun.TOML.parse, files[file]);
    if (!p.ok) return [{ manager: "uv", file, key: "*", status: "error", want: "valid TOML", note: p.error }];
    const got = pick(p.value);
    if (got === undefined) continue;
    const s = String(got);
    const ms = uvDurationMs(s);
    if (ms !== undefined) return [{ manager: "uv", file, key: "exclude-newer", status: ms >= o.cooldownDays * 86_400_000 ? "ok" : "weak", want, got: s }];
    return [{ manager: "uv", file, key: "exclude-newer", status: "weak", want, got: s, note: "a fixed date pins the index instead of a rolling cooldown" }];
  }
  return [{ manager: "uv", file: "pyproject.toml", key: "exclude-newer", status: "missing", want }];
}

const CHECKS: Record<Manager, (f: KeyFiles, o: KeyOptions) => KeyFinding[]> = { npm: npmKeys, pnpm: pnpmKeys, bun: bunKeys, uv: uvKeys };

export function checkClientKeys(files: KeyFiles, o: KeyOptions): KeyFinding[] {
  return detectManagers(files).flatMap((m) => CHECKS[m](files, o));
}

/** True when a finding should fail the check. */
export function failing(f: KeyFinding): boolean {
  return f.status === "missing" || f.status === "weak" || f.status === "error";
}

export function renderKeys(dir: string, fs: KeyFinding[]): string {
  if (fs.length === 0) return `${dir}: no npm, pnpm, bun or uv lockfile; nothing to check`;
  const bad = fs.filter(failing).length;
  const lines = [`${dir}: ${bad === 0 ? "OK" : `${bad} key(s) to set`}`];
  for (const f of fs) {
    const got = f.got !== undefined ? ` got ${f.got}` : "";
    const note = f.note ? ` (${f.note})` : "";
    lines.push(`  ${f.manager.padEnd(4)} ${f.status.padEnd(7)} ${f.file} ${f.key}:${got}; want ${f.want}${note}`);
  }
  return lines.join("\n");
}
