// Type B upgrades (packages from a reviewed third-party tap), ported from secure-update's
// type_b_brew_review, su_type_b_upgrades, su_tap_unchanged_since_review,
// su_offtap_deps_current and su_awaiting_tap_approval.
//
// Not ported yet, so held (fail closed) with a notice that says so:
//   - a source-built package: its source diff review (the GitHub compare) is a later slice, so
//     until then an unapproved source-built tap reads "review: n/a" in the advisory note;
//   - a HEAD install: its review and the quarantine of a keg that does not match it are too.

import type { Reviewer } from "../review.ts";
import type { Caps } from "./chunked.ts";
import { artifactKind } from "./formula-gates.ts";
import { formulaReview, type FormulaEnv, type TapPin } from "./formula.ts";
import { outdatedVersions, tapIn } from "./taps.ts";

export interface TypeBEnv extends FormulaEnv {
  /** Runs `brew <args>`; out is stdout. */
  brew(args: string[]): Promise<{ rc: number; out: string }>;
}

export interface TypeBOptions {
  officialTaps: string[];
  host: string;
  logFile?: string;
  /** In a dry run the caller passes a notify that only logs: the bash sent no notices then. */
  notify: (text: string) => void | Promise<void>;
  caps?: Caps;
  /** Taps that are the upstream source repo: their release diff is reviewed by its supply-chain surface. */
  upstreamTaps?: string[];
}

export interface TypeBReview {
  /** 0 may install, 1 FLAG, 2 no review could be made (held). */
  rc: 0 | 1 | 2;
  /** The review kind, once a verdict exists: "formula-only, prebuilt" or "formula + source". */
  kind?: string;
  pin?: TapPin;
  calls: number;
  log: string[];
}

const firstVersion = (out: string) => out.trim().split("\n")[0]?.trim().split(/\s+/)[1] ?? "";

export async function typeBReview(env: TypeBEnv, r: Reviewer, pkg: string, tap: string, o: TypeBOptions): Promise<TypeBReview> {
  const log: string[] = [];
  // Pin the tap HEAD first, before anything is read from the tap: everything below describes
  // this commit, and the install refuses to run if the tap is not still exactly here.
  const repo = await env.brew(["--repository", tap]);
  const tapDir = repo.rc === 0 ? repo.out.trim() : "";
  const head = tapDir ? (await env.git(tapDir, ["rev-parse", "HEAD"])).out.trim() : "";
  const list = await env.brew(["list", "--versions", `${tap}/${pkg}`]);
  const oldVer = list.rc === 0 ? firstVersion(list.out) : "";
  const info = await env.brewInfo(`${tap}/${pkg}`);
  const newVer = typeof info?.versions?.stable === "string" ? info.versions.stable : "";
  if (!oldVer || !newVer) {
    log.push(`${pkg}: could not read versions (old=${oldVer} new=${newVer}) — FLAG`);
    return { rc: 2, calls: 0, log };
  }
  log.push(`--- Type B review: ${pkg} (${oldVer} → ${newVer}, tap: ${tap}) ---`);
  const stableUrl = typeof info?.urls?.stable?.url === "string" ? info.urls.stable.url : "";
  const artifact = artifactKind(stableUrl);
  const upstream = artifact === "source" && tapIn(tap, o.upstreamTaps ?? []);
  const kind = artifact === "prebuilt" ? "formula-only, prebuilt" : upstream ? "formula + release surface" : "formula + source";
  log.push(`  review: ${artifact === "prebuilt" ? "formula-only (prebuilt)" : kind}`);
  const f = await formulaReview(env, r, {
    pkg, tap, oldVer, newVer, artifact, tapDir, head, newUrl: stableUrl,
    officialTaps: o.officialTaps, host: o.host, logFile: o.logFile, notify: o.notify, caps: o.caps, upstream,
  });
  log.push(...f.log);
  // The kind is reported only with a verdict: an rc 2 "no review" must not read as reviewed.
  const withKind = f.rc === 0 || f.rc === 1 ? { kind } : {};
  if (f.rc !== 0) return { rc: f.rc, calls: f.calls, log, ...withKind };
  if (artifact === "prebuilt") {
    log.push(`  ${pkg}: formula APPROVEd — prebuilt artifact (${stableUrl}); brew verifies it against the formula's pinned sha256`);
    return { rc: 0, calls: f.calls, log, pin: f.pin, ...withKind };
  }
  if (upstream) {
    log.push(`  ${pkg}: formula and release surface APPROVEd — upstream tap ${tap}, source build of ${stableUrl}`);
    return { rc: 0, calls: f.calls, log, pin: f.pin, ...withKind };
  }
  const reason = "source-built: the source diff review is not in this oupdate version — held for manual review";
  log.push(`  ${pkg}: ${reason}`);
  try {
    await o.notify(`⚠️ <b>${o.host} Type B FLAG — ${pkg}</b>\n${reason}\nUpgrade: ${oldVer} → ${newVer}\nLog: ${o.logFile ?? "-"}`);
  } catch {
    log.push(`${pkg}: the notice could not be sent`);
  }
  return { rc: 2, calls: f.calls, log };
}

/** Right before the upgrade: is the tap exactly as reviewed (same HEAD, nothing changed or untracked)? */
export async function tapUnchangedSinceReview(env: TypeBEnv, pkg: string, pin: TapPin | undefined, o: TypeBOptions, log: string[]): Promise<boolean> {
  let reason: string;
  if (!pin || pin.pkg !== pkg || !pin.tapDir || !pin.head || !pin.rbPath) {
    reason = `no reviewed tap state recorded for ${pkg}`;
  } else {
    const now = (await env.git(pin.tapDir, ["rev-parse", "HEAD"])).out.trim();
    // The whole tap, untracked files included: an edit anywhere changes what brew would run.
    const st = await env.git(pin.tapDir, ["status", "--porcelain", "--untracked-files=all"]);
    const dirty = st.rc !== 0 ? "git status failed" : st.out.trim();
    if (now !== pin.head) reason = `tap HEAD moved ${pin.head.slice(0, 12)} → ${now.slice(0, 12)}`;
    else if (dirty) reason = "uncommitted or untracked changes in the tap";
    else return true;
  }
  log.push(`  ${pkg}: tap changed after review (${reason}) — FLAG, not upgrading`);
  await send(o, log, `⚠️ <b>${o.host} Type B FLAG — ${pkg}</b>\ntap changed after review (${reason}) — not upgraded\nLog: ${o.logFile ?? "-"}`);
  return false;
}

/**
 * Right before `brew upgrade <tap>/<pkg>`: brew also upgrades the package's outdated installed
 * dependencies, which would install an off-tap one no review saw. Refused while any installed
 * dependency outside the official taps is outdated, unless it was itself upgraded earlier in this
 * run (full names only: a core `xz` upgrade does not excuse x/tap/xz).
 */
export async function offTapDepsCurrent(env: TypeBEnv, pkg: string, tap: string, doneFull: string[], o: TypeBOptions, log: string[]): Promise<boolean> {
  let reason = "";
  const deps = await env.brew(["deps", "--installed", "--full-name", `${tap}/${pkg}`]);
  if (deps.rc !== 0) {
    reason = "could not list its installed dependencies ";
  } else {
    const stale: string[] = [];
    for (const d of deps.out.split(/\s+/).filter(Boolean)) {
      const parts = d.split("/");
      if (parts.length < 3) continue; // a bare name is homebrew/core
      if (tapIn(parts.slice(0, -1).join("/").toLowerCase(), o.officialTaps)) continue;
      if (doneFull.includes(d)) continue;
      // `brew outdated <f>` exits 1 both when <f> is outdated (and prints it) and on an error
      // (prints nothing): output decides, and no output with a non-zero exit fails closed.
      const out = await env.brew(["outdated", "--quiet", "--formula", d]);
      if (out.out.trim()) stale.push(d);
      else if (out.rc !== 0) {
        reason = `could not check whether ${d} is outdated (brew outdated rc ${out.rc}) `;
        break;
      }
    }
    if (!reason) {
      if (!stale.length) return true;
      reason = `off-tap dependency outdated and not reviewed this run: ${stale.join(" ")} `;
    }
  }
  log.push(`  ${pkg}: ${reason}— FLAG, not upgrading (brew upgrade would install it too)`);
  await send(o, log, `⚠️ <b>${o.host} Type B FLAG — ${pkg}</b>\n${reason}— not upgraded (brew would upgrade it as a dependency, unreviewed)\nLog: ${o.logFile ?? "-"}`);
  return false;
}

async function send(o: TypeBOptions, log: string[], text: string) {
  try {
    await o.notify(text);
  } catch {
    log.push("the notice could not be sent");
  }
}

export interface TypeBRun {
  upgraded: string[];
  /** Full names (tap/pkg) of the upgrades done, for the off-tap dependency check. */
  upgradedFull: string[];
  failed: string[];
  /** Something was held or failed: the brew phase reports FLAGGED and the run exits non-zero on a failure. */
  flagged: boolean;
  log: string[];
}

/** Reviews and upgrades each Type B package in turn; a hold never stops the rest. */
export async function typeBUpgrades(
  env: TypeBEnv,
  r: Reviewer,
  pairs: { pkg: string; tap: string }[],
  o: TypeBOptions & { dryRun: boolean; upgrade: (fullName: string) => Promise<number>; into?: TypeBRun },
): Promise<TypeBRun> {
  // `into`: the caller's record, filled as each package finishes, so a run stopped part-way
  // (a timeout) still knows what was already upgraded.
  const run: TypeBRun = o.into ?? { upgraded: [], upgradedFull: [], failed: [], flagged: false, log: [] };
  for (const { pkg, tap } of pairs) {
    const list = await env.brew(["list", "--versions", `${tap}/${pkg}`]);
    if (firstVersion(list.out).startsWith("HEAD-")) {
      run.log.push(`  ${pkg}: HEAD install: its review is not in this oupdate version — FLAG, not upgrading`);
      await send(o, run.log, `⚠️ <b>${o.host} Type B FLAG — ${pkg} (HEAD)</b>\nHEAD install: its review is not in this oupdate version — not upgraded\nLog: ${o.logFile ?? "-"}`);
      run.flagged = true;
      continue;
    }
    const v = await typeBReview(env, r, pkg, tap, o);
    run.log.push(...v.log);
    if (v.rc !== 0) {
      run.flagged = true;
      continue;
    }
    if (o.dryRun) {
      run.log.push(`  dry-run: would upgrade ${pkg}`);
      continue;
    }
    if (!(await tapUnchangedSinceReview(env, pkg, v.pin, o, run.log))) {
      run.flagged = true;
      continue;
    }
    if (!(await offTapDepsCurrent(env, pkg, tap, run.upgradedFull, o, run.log))) {
      run.flagged = true;
      continue;
    }
    run.log.push(`  upgrading ${pkg}...`);
    if ((await o.upgrade(`${tap}/${pkg}`)) !== 0) {
      run.failed.push(pkg);
      run.flagged = true;
      run.log.push(`  ${pkg}: upgrade FAILED — continuing`);
      await send(o, run.log, `${o.host} brew FAILED: ${pkg}; log: ${o.logFile ?? "-"}`);
      continue;
    }
    run.upgraded.push(pkg);
    run.upgradedFull.push(`${tap}/${pkg}`);
  }
  return run;
}

/**
 * Packages from taps that are not approved: each formula gets an advisory review (never
 * installed, notices logged but not sent: the one awaiting-approval notice is the alert).
 * Returns "<tap> (<pkg> <old>→<new>, review: <verdict>)" items joined by "; ".
 */
export async function awaitingTapApproval(
  env: TypeBEnv,
  r: Reviewer,
  formulas: { pkg: string; tap: string }[],
  casks: { pkg: string; tap: string }[],
  verbose: string,
  o: TypeBOptions,
): Promise<{ items: string; log: string[] }> {
  const log: string[] = [];
  const items: string[] = [];
  const quiet: TypeBOptions = {
    ...o,
    notify: (text) => void log.push(`[advisory — not notified] ${text.split("\n")[0]!.replace(/<\/?b>/g, "")}`),
  };
  for (const { pkg, tap } of formulas) {
    log.push(`--- advisory review (tap ${tap} not approved — will NOT install): ${pkg} ---`);
    const v = await typeBReview(env, r, pkg, tap, quiet);
    log.push(...v.log);
    let verdict = v.rc === 0 ? "APPROVE" : v.rc === 1 ? "FLAG" : "n/a";
    if (v.kind) verdict += ` (${v.kind})`;
    items.push(`${tap} (${pkg} ${outdatedVersions(pkg, verbose)}, review: ${verdict})`);
  }
  for (const { pkg, tap } of casks) {
    items.push(`${tap === "tap-unresolved" ? "(unresolved tap)" : tap} (${pkg} ${outdatedVersions(pkg, verbose)}, review: n/a (cask))`);
  }
  return { items: items.join("; "), log };
}
