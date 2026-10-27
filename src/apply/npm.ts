// The npm globals phase, ported minimally from the previous updater's npm_section: list the outdated
// globals, read each new version's scripts and tarball and the installed version's scripts, force a
// FLAG on literal attack indicators, on a new or changed install hook and on any hook npm runs on
// install even when unchanged (a model is not trusted with what a pattern does reliably, and this lane
// never sees the file a hook runs, which can change under the same hook string), ask the reviewer about
// the batch, then upgrade each package by name. A FLAG or an unavailable reviewer holds the whole
// batch. Differences from the bash, all fail-closed: a failed or unreadable outdated query is an
// ERROR, not "nothing to update"; the tarball must come from the registry's own origin, not merely
// mention it; the stuck lane counts "<name>=<latest>" like the brew lane.

import type { Reviewer } from "../review.ts";
import type { Exec } from "./exec.ts";
import { reviewChunk } from "./verdict.ts";
import { VERDICT_CONTRACT } from "./formula.ts";

/** The phase's record, owned by the caller and filled as the phase goes, so a stop part-way keeps it. */
export interface NpmRun {
  log: string[];
  /** Outdated globals found this run. */
  pending: string[];
  /** Updated so far. */
  upgraded: string[];
}

export interface NpmOptions {
  npm: string;
  host: string;
  registry: string;
  dryRun: boolean;
  logFile?: string;
  notify: (text: string) => void | Promise<void>;
  /** Counts what is still outdated after the run (npm lane); returns the stuck entries, or undefined when the state is unusable. */
  trackStuck: (pending: string[]) => string[] | undefined;
  into?: NpmRun;
}

interface Outdated {
  current: string;
  next: string;
}

/** Name → versions from `npm outdated -g --json`, or undefined when the answer is not that shape. */
export function parseNpmOutdated(text: string): Map<string, Outdated> | undefined {
  let j: unknown;
  try {
    j = JSON.parse(text.trim() || "{}");
  } catch {
    return undefined;
  }
  if (!j || typeof j !== "object" || Array.isArray(j)) return undefined;
  const out = new Map<string, Outdated>();
  for (const [name, v] of Object.entries(j as Record<string, unknown>)) {
    if (!v || typeof v !== "object" || /\s/.test(name) || !name) return undefined;
    const o = v as Record<string, unknown>;
    const s = (x: unknown) => (typeof x === "string" && x ? x : undefined);
    out.set(name, { current: s(o.current) ?? "unknown", next: s(o.latest) ?? s(o.wanted) ?? "unknown" });
  }
  return out;
}

/** The literal indicators that force a FLAG whatever the reviewer says; "" when none. */
export function npmHardHit(details: string): string {
  if (/(curl|wget)[^|]*\|\s*(sudo\s+)?(ba|z|da)?sh([^A-Za-z0-9_.-]|$)/im.test(details)) return "pipes a network fetch straight into a shell";
  if (/base64\s+(-d|--decode)[^|]*\|\s*(sudo\s+)?(ba|z|da)?sh([^A-Za-z0-9_.-]|$)/im.test(details)) return "decodes and executes an encoded payload";
  if (/tarball registry: (no|false)/i.test(details)) return "tarball is not from the registry";
  if (/(\.ssh\/|\/etc\/(passwd|sudoers|shadow))/m.test(details)) return "install script touches ~/.ssh or /etc";
  return "";
}

const INSTALL_HOOKS = ["preinstall", "install", "postinstall", "prepare"];
/** The hooks npm runs on a registry install (prepare runs only for git/directory sources). */
const RUN_HOOKS = ["preinstall", "install", "postinstall"];

/** `npm view … scripts --json` as name → body; "" is no scripts; undefined when it is not that shape. */
function parseScripts(text: string): Record<string, string> | undefined {
  try {
    const j: unknown = JSON.parse(text.trim() || "{}");
    if (!j || typeof j !== "object" || Array.isArray(j)) return undefined;
    return Object.fromEntries(Object.entries(j as Record<string, unknown>).map(([k, v]) => [k, String(v)]));
  } catch {
    return undefined;
  }
}

function fromRegistry(tarball: string, registry: string): boolean {
  try {
    return new URL(tarball).origin === new URL(registry).origin;
  } catch {
    return false;
  }
}

/** The installed global version of a package from `npm ls -g --json`, or undefined when it cannot be read. */
export async function npmInstalled(exec: Exec, npm: string, pkg: string): Promise<string | undefined> {
  const r = await exec([npm, "ls", "-g", "--depth=0", "--json", pkg]);
  // npm ls exits 1 on an unrelated problem in the tree: the answer decides, as for outdated.
  if (r.rc !== 0 && r.rc !== 1) return undefined;
  try {
    const v = (JSON.parse(r.out) as { dependencies?: Record<string, { version?: unknown }> }).dependencies?.[pkg]?.version;
    return typeof v === "string" && v ? v : undefined;
  } catch {
    return undefined;
  }
}

export async function npmSection(exec: Exec, r: Reviewer, o: NpmOptions): Promise<{ status: string; log: string[] }> {
  const run: NpmRun = o.into ?? { log: [], pending: [], upgraded: [] };
  const log = run.log;
  log.push("", "--- npm globals ---");
  const send = async (text: string) => {
    try {
      await o.notify(text);
    } catch {
      log.push("  the notice could not be sent");
    }
  };
  // `npm outdated` exits 1 when something is outdated: the answer decides, not the exit code.
  const q = await exec([o.npm, "outdated", "-g", "--json"]);
  if (q.rc === 127) {
    // An ERROR, so the run exits non-zero and the digest sees it: npm globals went unchecked.
    log.push(`npm: ${o.npm} not found — not checked`);
    return { status: `ERROR — ${o.npm} not found, npm globals not checked`, log };
  }
  const outdated = q.rc === 0 || q.rc === 1 ? parseNpmOutdated(q.out) : undefined;
  if (!outdated) {
    log.push(`npm: outdated query failed (rc ${q.rc}) — nothing upgraded`);
    return { status: `ERROR — npm outdated query failed (rc ${q.rc})`, log };
  }
  if (!outdated.size) {
    log.push("npm: nothing to update");
    return { status: "nothing to update", log };
  }

  const names = [...outdated.keys()];
  run.pending.push(...names);
  let details = "";
  const unread: string[] = [];
  const hooks: string[] = [];
  const runs: string[] = [];
  for (const [pkg, v] of outdated) {
    // A failed view is not "no scripts": what could not be read cannot be reviewed.
    const sv = await exec([o.npm, "view", `${pkg}@${v.next}`, "scripts", "--json"]);
    const ov = await exec([o.npm, "view", `${pkg}@${v.current}`, "scripts", "--json"]);
    const tv = await exec([o.npm, "view", `${pkg}@${v.next}`, "dist.tarball"]);
    if (sv.rc !== 0) unread.push(`${pkg}@${v.next} scripts (npm view rc ${sv.rc})`);
    if (ov.rc !== 0) unread.push(`${pkg}@${v.current} scripts (npm view rc ${ov.rc})`);
    if (tv.rc !== 0) unread.push(`${pkg}@${v.next} tarball (npm view rc ${tv.rc})`);
    const after = sv.rc === 0 ? parseScripts(sv.out) : {};
    const before = ov.rc === 0 ? parseScripts(ov.out) : {};
    if (!after) unread.push(`${pkg}@${v.next} scripts (unparseable)`);
    if (!before) unread.push(`${pkg}@${v.current} scripts (unparseable)`);
    // A new or changed install hook runs code this lane never sees (the file it calls), so it is a person's call.
    for (const k of INSTALL_HOOKS) if (after?.[k] !== undefined && after[k] !== before?.[k]) hooks.push(`${pkg}@${v.next} ${k}: ${after[k]!.slice(0, 200)}`);
    // An unchanged hook string can run a changed file (audit 0.2.3: same "node setup.js", new setup.js), and this
    // lane never reads the tarball, so any hook npm runs on install holds too.
    for (const k of RUN_HOOKS) if (after?.[k] !== undefined && after[k] === before?.[k]) runs.push(`${pkg}@${v.next} ${k}: ${after[k]!.slice(0, 200)}`);
    const scripts = sv.out.trim() || "(no scripts)";
    const tarball = tv.out.trim().split("\n")[0] || "unknown";
    const ok = fromRegistry(tarball, o.registry) ? "yes" : `NO — unexpected: ${tarball}`;
    details += `  ${pkg}: ${v.current} -> ${v.next}\n    tarball registry: ${ok}\n    scripts:\n${scripts.split("\n").map((l) => `      ${l}`).join("\n")}\n`;
  }
  log.push("Pending npm upgrades:", details, "--- model npm review ---");

  const prompt = `You are a security reviewer checking pending npm global package upgrades on a host.

Host: ${o.host}

Pending upgrades:
${details}
Only these lifecycle scripts run automatically on \`npm install\` / \`npm update\`:
  - preinstall, install, postinstall
  - prepare (only when installing from a git/directory source — NOT for registry tarballs, which is what we use here)
IGNORE all other scripts (build, test, lint, release, version, prepack, prepublish, prepublishOnly, dev, start, etc.) — they only run when a developer explicitly invokes them. They are NOT an install-time attack surface.

An install-time script that calls a local file (e.g. "node bundle.js") runs code that is not shown here; the Shai-Hulud worm ran exactly that way. Treat it as a risk signal, never as a convention that makes it safe. Any preinstall/install/postinstall script, and a new or changed prepare, holds the update for a person whatever you answer. FLAG any install-time script whose body shows a direct attack pattern: curl|sh, wget|sh, base64 -d | sh, eval of network input, writes to ~/.ssh or /etc, encoded payloads, exfiltration to non-package domains.

Review and decide APPROVE or FLAG:
1. Install-time script (preinstall/install/postinstall/prepare) with an explicit attack indicator? — FLAG and quote the offending line.
2. Tarball not from ${o.registry}? — FLAG it.
3. Unknown package name that isn't a recognized public npm package? — FLAG it.
4. Otherwise (including packages with only build/test scripts) — APPROVE.

${VERDICT_CONTRACT}
One-line reason if FLAG. 6 lines max.`;

  if (unread.length) {
    const reason = `could not read ${unread.join(", ")} — not reviewed`;
    log.push(`npm: ${reason}; skipping upgrade`);
    await send(`⚠️ <b>${o.host} npm FLAGGED</b>\n${reason}\nPackages: ${names.join(" ")}\nLog: ${o.logFile ?? "-"}`);
    return { status: `FLAGGED — ${reason}`, log };
  }
  const hookHit = [hooks.length ? `new or changed install script: ${hooks.join(", ")}` : "", runs.length ? `install script runs unreviewed package files: ${runs.join(", ")}` : ""].filter(Boolean).join("; ");
  const hard = npmHardHit(details) || hookHit;
  const v = await reviewChunk(r, prompt, { ground: () => "GROUNDED", box: "review npm" });
  log.push(...v.log);
  let reason = "";
  if (hard) {
    log.push(`npm: STRUCTURAL FLAG (pre-gate) — ${hard}`);
    reason = `FLAG: ${hard} (structural pre-gate)`;
  } else if (v.verdict === "UNAVAILABLE") reason = "reviewer unavailable";
  else if (v.verdict === "FLAG") reason = v.reason ?? "FLAG";
  if (reason) {
    await send(`⚠️ <b>${o.host} npm FLAGGED</b>\n${reason}\nPackages: ${names.join(" ")}\nLog: ${o.logFile ?? "-"}`);
    log.push("npm: flagged — skipping upgrade");
    return { status: `FLAGGED — ${reason}`, log };
  }
  if (o.dryRun) {
    log.push(`dry-run: would upgrade: ${names.join(" ")}`);
    return { status: "dry-run OK", log };
  }

  let status = "";
  const off: string[] = [];
  for (const [pkg, v] of outdated) {
    // Exactly the reviewed version: `npm update` would take whatever is newest by now.
    log.push(`  upgrading ${pkg} to ${v.next}...`);
    const u = await exec([o.npm, "install", "-g", `${pkg}@${v.next}`]);
    if (u.rc !== 0) {
      status = `FAILED — ${pkg}`;
      log.push(`npm: upgrade failed for ${pkg} — continuing`);
      await send(`⚠️ <b>${o.host} npm FAILED — ${pkg}</b>\nLog: ${o.logFile ?? "-"}`);
      continue;
    }
    // Verified, not assumed: a version that cannot be read is no match.
    const got = await npmInstalled(exec, o.npm, pkg);
    if (got !== v.next) {
      const what = `${pkg} installed ${got ?? "unknown"}, reviewed ${v.next}`;
      off.push(what);
      log.push(`npm: ${what} — FLAGGED`);
      await send(`⚠️ <b>${o.host} npm FLAGGED</b>\n${what}\nLog: ${o.logFile ?? "-"}`);
    } else run.upgraded.push(pkg);
  }
  if (off.length) status = [status, `FLAGGED — ${off.join(", ")}`].filter(Boolean).join("; ");
  if (!status) status = `upgraded: ${names.join(" ")}`;

  // What is still outdated: re-queried, not inferred.
  const left = await exec([o.npm, "outdated", "-g", "--json"]);
  const leftMap = left.rc === 0 || left.rc === 1 ? parseNpmOutdated(left.out) : undefined;
  if (!leftMap) {
    log.push("npm: the pending query failed — stuck state kept");
    return { status: `${status}; ERROR — pending query failed`, log };
  }
  const stuck = o.trackStuck([...leftMap].map(([n, x]) => `${n}=${x.next}`));
  if (stuck === undefined) status += "; ERROR — stuck state unusable";
  else if (stuck.length) status += `; STUCK: ${stuck.join(" ")}`;
  return { status, log };
}
