// Gatekeeper for cask upgrades, ported from secure-update's su_gk_* functions and
// su_cask_gatekeeper_check. A cask upgrade leaves its new binaries quarantined, so the first run
// from a login session waits on a GUI prompt. The release removes that quarantine only when three
// gates pass for every file: the previous version's linked binaries were approved (an
// unquarantined file counts as approved, as Homebrew treats it), the new file is signed by the
// same single Team ID (and the team matches the one pinned on the first release), and Gatekeeper
// accepts it as notarized Developer ID code of that team. Every removal is logged so revert can
// put it back. The check then reports whatever is still waiting on a prompt.

import { lstatSync, readdirSync, readFileSync, readlinkSync, statSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import type { Exec } from "./exec.ts";

export interface GkEnv {
  exec: Exec;
  /** `brew --caskroom` and `brew --prefix`, already resolved. */
  caskroom: string;
  prefix: string;
  /** Where gatekeeper-teams.tsv and gatekeeper-release.tsv live. */
  stateDir: string;
  /** Team ID of a signed file ("" when none); real: codesign. */
  team(file: string): Promise<string>;
  /** Does Gatekeeper accept the file as notarized Developer ID code of this team? Real: spctl. */
  notarized(file: string, team: string): Promise<boolean>;
}

export interface GkOptions {
  dryRun: boolean;
  host: string;
  logFile?: string;
  notify: (text: string) => void | Promise<void>;
}

const Q = "com.apple.quarantine";

/** The real Team ID and notarization gates. spctl is called by absolute path: /usr/sbin is not on a LaunchDaemon's PATH. */
export function realGates(exec: Exec, spctl = "/usr/sbin/spctl") {
  return {
    team: async (file: string) => {
      const r = await exec(["codesign", "-dv", file]);
      return `${r.out}${r.err}`.match(/^TeamIdentifier=(.*)$/m)?.[1]?.trim() ?? "";
    },
    notarized: async (file: string, team: string) => {
      const r = await exec([spctl, "-a", "-vv", "-t", "open", "--context", "context:primary-signature", file]);
      const a = `${r.out}${r.err}`;
      return a.includes(": accepted") && a.includes("source=Notarized Developer ID") && a.includes(`(${team})`);
    },
  };
}

/** The newest version directory of an installed cask (dot-dirs such as .metadata skipped, as the shell glob skips them; an mtime tie goes to the first name, as ls -t), or undefined. */
export function verDir(env: GkEnv, cask: string): string | undefined {
  const root = join(env.caskroom, cask);
  let best: { p: string; t: number } | undefined;
  let names: string[];
  try {
    names = readdirSync(root).sort();
  } catch {
    return undefined;
  }
  for (const n of names) {
    if (n.startsWith(".")) continue;
    const p = join(root, n);
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(p);
    } catch {
      continue; // a dangling link, as the shell glob skips it
    }
    if (st.isDirectory() && (!best || st.mtimeMs > best.t)) best = { p, t: st.mtimeMs };
  }
  return best?.p;
}

/** approved | none | pending, for one file's quarantine flags (0x40 is the user-approved bit). */
export async function gkState(env: GkEnv, file: string): Promise<"approved" | "none" | "pending"> {
  const r = await env.exec(["xattr", "-p", Q, file]);
  if (r.rc !== 0) return "none";
  const flags = r.out.trim().split(";")[0] ?? "";
  return /^[0-9a-fA-F]{1,4}$/.test(flags) && (Number.parseInt(flags, 16) & 0x40) !== 0 ? "approved" : "pending";
}

/** The targets of <prefix>/bin symlinks that point into the version dir. */
export function gkLinked(env: GkEnv, ver: string): string[] {
  const bin = join(env.prefix, "bin");
  const out: string[] = [];
  let names: string[];
  try {
    names = readdirSync(bin);
  } catch {
    return out;
  }
  for (const n of names) {
    const l = join(bin, n);
    try {
      if (!lstatSync(l).isSymbolicLink()) continue;
      const t = readlinkSync(l);
      if (t.startsWith(`${ver}/`)) out.push(t);
    } catch {
      // unreadable link
    }
  }
  return out.sort();
}

/** Quarantined, unapproved Mach-O files in the version dir, outside any .app bundle. */
export async function gkPending(env: GkEnv, ver: string): Promise<string[]> {
  const f = await env.exec(["find", ver, "-name", "*.app", "-prune", "-o", "-type", "f", "-xattrname", Q, "-print0"]);
  const out: string[] = [];
  for (const file of f.out.split("\0").filter(Boolean)) {
    if ((await gkState(env, file)) !== "pending") continue;
    const kind = await env.exec(["file", "-b", file]);
    if (kind.rc === 0 && kind.out.includes("Mach-O")) out.push(file);
  }
  return out;
}

export interface GkPrior {
  prior: "ok" | "pending" | "unknown";
  team: string;
}

/** Before an upgrade: were the installed version's linked binaries approved, and by which single team? */
export async function gkSnapshot(env: GkEnv, cask: string): Promise<GkPrior> {
  const ver = verDir(env, cask);
  if (!ver) return { prior: "unknown", team: "" };
  let prior: GkPrior["prior"] = "ok";
  const teams = new Set<string>();
  for (const f of gkLinked(env, ver)) {
    if ((await gkState(env, f)) === "pending") prior = "pending";
    teams.add((await env.team(f)) || "none");
  }
  const [only] = [...teams];
  if (teams.size !== 1 || only === "none" || only === "not set") return { prior: "unknown", team: "" };
  return { prior, team: only! };
}

async function send(o: GkOptions, log: string[], text: string) {
  try {
    await o.notify(text);
  } catch {
    log.push("  the notice could not be sent");
  }
}

// Rows of a state file; [] when it does not exist, undefined when it exists but cannot be read
// (an unreadable pins file must not read as "no pin").
const readTsv = async (p: string): Promise<string[][] | undefined> => {
  try {
    statSync(p);
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ENOENT" ? [] : undefined;
  }
  try {
    return readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => l.split("\t"));
  } catch {
    return undefined; // a directory, or no read permission
  }
};

// Local time, as `date '+%F %T'`.
const localStamp = () => {
  const d = new Date();
  const p = (x: number) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

/** After an upgrade (or as the operator's approve): apply the three gates and release what passes. */
export async function gkRelease(env: GkEnv, cask: string, o: GkOptions, mode: { prior: GkPrior } | "approve"): Promise<string[]> {
  const log: string[] = [];
  const ver = verDir(env, cask);
  if (!ver) return log;
  const pending = await gkPending(env, ver);
  if (!pending.length) return log;
  const pins = join(env.stateDir, "gatekeeper-teams.tsv");
  const revlog = join(env.stateDir, "gatekeeper-release.tsv");
  let team: string;
  if (mode === "approve") {
    const teams = new Set<string>();
    // An unsigned linked file has no team and does not count, as the bash's empty codesign line.
    for (const f of gkLinked(env, ver)) {
      const t = await env.team(f);
      if (t) teams.add(t);
    }
    team = teams.size === 1 ? [...teams][0]! : "";
  } else if (mode.prior.prior === "ok") {
    team = mode.prior.team;
  } else {
    log.push(`  ${cask}: quarantine kept — previous version was never approved (${mode.prior.prior}); run: oupdate host --gatekeeper-approve ${cask}`);
    return log;
  }
  if (!team || team === "not set") {
    log.push(`  ${cask}: quarantine kept — no single Team ID on the linked binaries`);
    return log;
  }
  const pinRows = await readTsv(pins);
  if (pinRows === undefined) {
    log.push(`  ${cask}: quarantine kept — cannot read ${pins}`);
    return log;
  }
  const pin = pinRows.filter((r) => r[0] === cask).at(-1)?.[1] ?? "";
  if (pin && pin !== team) {
    log.push(`  ${cask}: quarantine kept — Team ID ${team} != pinned ${pin}`);
    await send(o, log, `⚠️ <b>${o.host} ${cask}: signer changed</b>\nTeam ID ${team}, pinned ${pin}. Quarantine kept.\nLog: ${o.logFile ?? "-"}`);
    return log;
  }
  let ok = 0;
  const bad: string[] = [];
  for (const f of pending) {
    const rel = f.slice(ver.length + 1);
    const t = await env.team(f);
    if (t !== team || !(await env.notarized(f, team))) {
      bad.push(`${rel}(${t})`);
      continue;
    }
    if (o.dryRun) {
      log.push(`  ${cask}: would release ${rel}`);
      ok++;
      continue;
    }
    const value = (await env.exec(["xattr", "-p", Q, f])).out.trim();
    // A removal that cannot be logged could not be reverted: keep that file quarantined.
    if (!value) {
      bad.push(`${rel}(quarantine value unreadable)`);
      continue;
    }
    try {
      await appendFile(revlog, `${localStamp()}\t${cask}\t${value}\t${f}\n`);
    } catch {
      bad.push(`${rel}(release log not writable)`);
      continue;
    }
    if ((await env.exec(["xattr", "-d", Q, f])).rc === 0) ok++;
  }
  if (!o.dryRun && ok > 0 && !pin) {
    try {
      await appendFile(pins, `${cask}\t${team}\n`);
    } catch {
      log.push(`  ${cask}: could not pin team ${team} in ${pins}`);
    }
  }
  log.push(`  ${cask}: Gatekeeper — ${o.dryRun ? "would release" : "released"} ${ok} file(s), notarized ${team}`);
  if (bad.length) {
    log.push(`  ${cask}: quarantine kept on: ${bad.join(" ")} `);
    await send(o, log, `⚠️ <b>${o.host} ${cask}: files failed the Gatekeeper release gate</b>\nExpected notarized ${team}: ${bad.join(" ")} \nLog: ${o.logFile ?? "-"}`);
  }
  return log;
}

/** Put back every quarantine value a release removed for the cask. */
export async function gkRevert(env: GkEnv, cask: string): Promise<string[]> {
  let n = 0;
  const file = join(env.stateDir, "gatekeeper-release.tsv");
  const rows = await readTsv(file);
  if (rows === undefined) return [`  ${cask}: cannot read ${file}; nothing restored`];
  for (const [, c, v, ...rest] of rows) {
    const f = rest.join("\t"); // a path may hold a tab: the rest of the line is the path
    if (c !== cask || !f || v === undefined) continue;
    if (!(await Bun.file(f).exists())) continue;
    if ((await env.exec(["xattr", "-w", Q, v, f])).rc === 0) n++;
  }
  return [`  ${cask}: restored quarantine on ${n} file(s)`];
}

/** What still waits on a Gatekeeper prompt after the upgrade: a note and one notice, never a failure. */
export async function gkCheck(env: GkEnv, cask: string, o: GkOptions): Promise<{ note: string; log: string[] }> {
  const log: string[] = [];
  const ver = verDir(env, cask);
  if (!ver) return { note: "", log };
  const exes: string[] = [];
  let libs = 0;
  for (const f of await gkPending(env, ver)) {
    const kind = await env.exec(["file", "-b", f]);
    if (kind.rc !== 0) continue;
    if (/Mach-O.*(shared library|bundle)/.test(kind.out)) libs++;
    else exes.push(f.slice(ver.length + 1));
  }
  if (!exes.length && !libs) return { note: "", log };
  const note = `${cask}: ${exes.length} unapproved${libs ? ` + ${libs} dylib` : ""}`;
  log.push(`  ${cask}: GATEKEEPER — ${exes.length} executable(s) + ${libs} dylib(s) still quarantined, unapproved:`, ...exes.map((e) => `    ${e}`));
  await send(o, log, `⚠️ <b>${o.host} ${cask}: Gatekeeper approval pending</b>\nFirst run from a login session will wait on a GUI prompt at the console.\n${exes.join(" ")}${libs ? ` (+${libs} dylib)` : ""}\nLog: ${o.logFile ?? "-"}`);
  return { note, log };
}
