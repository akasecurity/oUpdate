// The brew phase's steps of the host apply run (run.ts drives them): the section itself, cleanup, the cask and
// app-bundle steps, and the brew status line.

import { join } from "node:path";
import { appBundleUpgrade, realAppNet } from "./appbundle.ts";
import type { ApplyConfig } from "./config.ts";
import type { Exec } from "./exec.ts";
import { gkCheck, gkRelease, gkSnapshot, realGates, type GkEnv, type GkOptions } from "./gatekeeper.ts";
import { caskRunning, lsofMaps, type KegEnv } from "./kegs.ts";
import { asUser, brewView, findCheck, holdPath, holdState, pendingPath, runHook, savePending, trustState, type PendingCheck } from "./release-checks.ts";
import { pinFilter } from "./pins.ts";
import { loadApprovedTaps, outdatedVersions, tapIn } from "./taps.ts";
import { reviewedVersion, typeAReview, versionMismatch } from "./typea.ts";
import type { TypeBRun } from "./typeb.ts";
import { handoff } from "./waiter.ts";
import { type GkOps, type RunCtx, words, uniq, last, named, holdRunningBun, PKG_NAME, DECLARED_DEPS } from "./run-ctx.ts";

/** The real Gatekeeper env, or undefined when brew cannot say where the Caskroom and prefix are. */
export async function gkEnv(cfg: ApplyConfig, exec: Exec): Promise<GkEnv | undefined> {
  const q = async (arg: string) => {
    const r = await exec([cfg.brew, arg]);
    return r.rc === 0 ? r.out.trim() : "";
  };
  const caskroom = await q("--caskroom");
  const prefix = await q("--prefix");
  if (!caskroom.startsWith("/") || !prefix.startsWith("/")) return undefined;
  return { exec, caskroom, prefix, stateDir: cfg.stateDir, ...realGates(exec) };
}

/** Gatekeeper steps that say they could not run: the cask still upgrades, its note says unchecked. */
export const gkUnchecked: GkOps = {
  snapshot: async () => ({ prior: "unknown", team: "" }),
  release: async (cask) => [`  ${cask}: Gatekeeper not checked — brew --caskroom / --prefix unreadable; quarantine kept`],
  check: async (cask) => ({ note: `${cask}: not checked`, log: [] }),
};

export function assembleBrew(rt: RunCtx): string {
  const { dryRun, b, notify, step, quarantined, cfg } = rt;
  // Casks deferred but never tried (a step stopped first) are still listed as deferred.
  const pendingCasks = b.deferredCasks.filter((k) => !b.caskTried.has(k));
  let core: string;
  if (b.noBrew) core = "not run";
  else if (b.nothing) core = "nothing to update";
  else if (!b.sectionDone) core = "not run";
  else if (b.upgraded.length && !dryRun) {
    core = `upgraded: ${b.upgraded.join(" ")}`;
    if (pendingCasks.length) core += `; casks deferred: ${pendingCasks.join(" ")}`;
    if (b.restarted.length) core += `; restarted: ${b.restarted.join(" ")}`;
    if (b.relinkNote) core += `; ${b.relinkNote}`;
  } else if (b.flaggedAtSection) core = "FLAGGED (see notifications)";
  else if (dryRun) core = "dry-run OK";
  else if (pendingCasks.length) core = `casks deferred: ${pendingCasks.join(" ")}`;
  // A failed query or step says FAILED in front; it is never "nothing approved".
  else core = b.deferredCasks.length || b.failed.length ? "" : "nothing approved for upgrade";
  if (b.unknownNote) core = `${b.unknownNote}; ${core}`;
  if (b.headNote) core = `${b.headNote}; ${core}`;
  if (quarantined) core = `${quarantined.name} QUARANTINED — unreviewed install, not restarting (${quarantined.quarantineFile}); ${core}`;
  const parts: string[] = [];
  if (b.casksUp.length) parts.push(`casks upgraded: ${b.casksUp.join(" ")}`);
  if (b.casksSudo.length) parts.push(`casks need sudo: ${b.casksSudo.join(" ")}`);
  if (b.casksRunning.length) parts.push(`casks held (running): ${b.casksRunning.join(" ")}`);
  if (b.casksFailed.length) parts.push(`casks FAILED: ${b.casksFailed.join(" ")}`);
  if (b.gkNotes.length) parts.push(`GATEKEEPER pending: ${b.gkNotes.join("; ")}`);
  if (parts.length) core = core ? `${core}; ${parts.join("; ")}` : parts.join("; ");
  const failed = uniq(b.failed);
  // The check's note, plus any handoff it does not already carry (a stop or a failed re-scan).
  const stale = [b.staleNote, ...b.handoffNotes.filter((n) => !b.staleNote.includes(n))].filter(Boolean).join("; ");
  const notifyNote = !dryRun && cfg.notify === undefined ? "notify: not configured — notices were logged only" : "";
  // Empty parts are skipped, so no "; ;" when the core is empty.
  return [
    failed.length ? `FAILED: ${failed.join(" ")}` : "",
    core.replace(/; $/, ""),
    b.appNotes.join("; "),
    b.stuck.length ? `STUCK: ${b.stuck.join(" ")}` : "",
    b.pinned.length ? `PINNED: ${b.pinned.join(" ")}` : "",
    b.selfBun.length ? `HELD: ${b.selfBun.map((n) => `${n} (runs under it)`).join(", ")}` : "",
    b.rcHeld.length ? `HELD by release check: ${b.rcHeld.join(" ")}` : "",
    b.rcNotes.length ? `release check: ${b.rcNotes.join(", ")}` : "",
    b.pinWarn, stale, b.linkageNote, b.waiterNote, notifyNote,
  ].filter(Boolean).join("; ");
}

export async function brewSection(rt: RunCtx) {
  const { opts, dryRun, host, r, tb, log, b, brewHeld, x, notify, step, tbEnv, tbOpts, brewFailed, rcEnv, rcPending, rcBroken, gatedOutdated, cfg, fs } = rt;
  log.push("", "--- brew ---");
  const v = await x([cfg.brew, "--version"]);
  if (v.rc === 127) {
    log.push(`${cfg.brew} not found — skipping the brew phase`);
    b.failed.push("brew-not-found");
    b.noBrew = true;
    return;
  }
  b.started = true;

  // 1. Sync the formula repo only. A failed tap fetch is surfaced and the run goes on, so one
  // unreachable tap does not cost the host its official upgrades.
  if (dryRun) log.push("dry-run: brew update skipped — the outdated list is against the taps as they are");
  else {
    const u = await x([cfg.brew, "update"]);
    const out = `${u.out}${u.err}`;
    if (u.rc !== 0) {
      log.push(`  WARNING: brew update exited ${u.rc} — a tap fetch likely failed, so the outdated list below may be computed against a STALE tap:`);
      log.push(...out.split("\n").filter((l) => /error|fatal|failed/i.test(l)).slice(0, 5).map((l) => `    ${l}`));
    }
    log.push(...out.trimEnd().split("\n").slice(-3));
  }

  // 2. Outdated formulae (with --fetch-HEAD, so a HEAD install shows) and casks (greedy, so an
  // auto_updates cask shows). A query that fails is a FAILED entry, never "nothing to update".
  let f = await x([cfg.brew, "outdated", ...(b.fetchHead ? ["--fetch-HEAD"] : []), "--formula"]);
  if (f.rc !== 0 && b.fetchHead) {
    b.headNote = `outdated --fetch-HEAD FAILED (rc ${f.rc}) — HEAD installs not checked this run`;
    b.fetchHead = false;
    log.push(`  WARNING: brew ${b.headNote}; falling back to the plain query`);
    f = await x([cfg.brew, "outdated", "--formula"]);
  }
  if (dryRun) log.push("dry-run: HEAD installs are not fetched");
  let formulas: string[] = [];
  if (f.rc !== 0) await brewFailed("outdated-query");
  else formulas = words(f.out);
  const c = await x([cfg.brew, "outdated", "--cask", "--greedy-auto-updates"]);
  let casks: string[] = [];
  if (c.rc !== 0) await brewFailed("cask-outdated-query");
  else casks = words(c.out);

  // Casks never auto-managed here.
  casks = casks.filter((k) => {
    if (!named(cfg.caskExclude, k)) return true;
    log.push(`  excluding ${k} (CASK_EXCLUDE — self-updates / too heavy to reinstall)`);
    return false;
  });

  // Gated formulae outdated, read before pins hold any: a pinned one is still pulled in by a
  // dependent's upgrade. A failed outdated query: every gated formula counts (fail closed).
  if (cfg.releaseChecks?.length) {
    const gated = f.rc !== 0 ? cfg.releaseChecks.map((c) => c.formula) : formulas.filter((n) => findCheck(cfg.releaseChecks, n));
    for (const n of gated) if (!gatedOutdated.includes(last(n))) gatedOutdated.push(last(n));
    // A gated formula not installed counts too: a dependent's upgrade would install it fresh (a held
    // release included) with no before, check or rollback. A failed list: every gated formula counts.
    const inst = await x([cfg.brew, "list", "--formula", "--full-name"]);
    const have = inst.rc === 0 ? words(inst.out).map(last) : [];
    for (const c of cfg.releaseChecks) {
      const n = last(c.formula);
      if (!have.includes(n) && !gatedOutdated.includes(n)) gatedOutdated.push(n);
    }
  }

  // The bun this run is executing. Upgrading Homebrew's bun replaces that binary mid-run
  // (brew cleanup then deletes the keg). It is held; a deliberate step updates it later.
  const self = holdRunningBun(formulas, opts.bunExec ?? process.execPath);
  for (const n of self.held) log.push(`  holding ${n} (runs under it)`);
  b.selfBun.push(...self.held);
  formulas = self.kept;

  // Pinned tools (brew pin, or a repo's pins.json) are held, never upgraded.
  const pinnedQ = await x([cfg.brew, "list", "--pinned"]);
  if (pinnedQ.rc !== 0) {
    b.pinWarn = `WARNING: brew list --pinned failed (rc ${pinnedQ.rc}) — brew pins not read, repo pins still held`;
    log.push(`  ${b.pinWarn}`);
  }
  const files = fs.pinFiles(cfg.pinRoots);
  for (const [kind, names] of [["brew", formulas], ["cask", casks]] as const) {
    const p = pinFilter(kind, names, { brewPinned: pinnedQ.rc === 0 ? words(pinnedQ.out) : [], files });
    if (kind === "brew") log.push(...p.warnings.map((w) => `  ${w}`));
    for (const n of p.pinned) log.push(`  holding ${n.replace(/\(.*$/, "")} (pinned: ${n.replace(/^[^(]*\(|\)$/g, "")})`);
    b.pinned.push(...p.pinned);
    if (kind === "brew") formulas = p.kept;
    else casks = p.kept;
  }

  // Release checks: a held release is not upgraded to (a newer one is); a dry run says what it would do.
  if (cfg.releaseChecks?.length) {
    const keep: string[] = [];
    for (const n of formulas) {
      const rc = findCheck(cfg.releaseChecks, n);
      if (!rc) {
        keep.push(n);
        continue;
      }
      const f = last(n);
      const open = rcPending.get(f);
      if (open) {
        // Never a second upgrade over an unfinished one: its from stays the rollback baseline.
        log.push(`  holding ${f} (its release check of ${open.from || "?"} → ${open.to ?? "?"} is not finished — finished first)`);
        b.rcHeldNames.push(n);
        continue;
      }
      if (rcBroken.includes(f)) {
        log.push(`  holding ${f} (its release check record ${pendingPath(cfg.stateDir, f)} is unreadable — fix or remove it)`);
        b.rcHeld.push(`${f} (record unreadable)`);
        b.rcHeldNames.push(n);
        continue;
      }
      const view = await brewView(rcEnv.exec, cfg.brew, n);
      const hs = await holdState(rcEnv, f);
      if (hs.unreadable) {
        log.push(`  holding ${f} (its release check hold ${holdPath(cfg.stateDir, f)} is unreadable — fix or remove it)`);
        b.rcHeld.push(`${f} (hold unreadable)`);
        b.rcHeldNames.push(n);
        continue;
      }
      // A hold is only ever compared with a version read: no candidate, no upgrade this run.
      if (!view?.candidate) {
        log.push(`  holding ${f} (release check: its candidate version could not be read — not upgraded this run)`);
        b.rcNotes.push(`${f} not upgraded, candidate unreadable`);
        b.rcHeldNames.push(n);
        continue;
      }
      const hold = hs.hold;
      if (hold && view.candidate === hold.version) {
        log.push(`  holding ${f} ${hold.version} (HELD by release check — failed ${hold.at}, rolled back to ${hold.from}; a newer release is tried)`);
        b.rcHeld.push(`${f} ${hold.version}`);
        b.rcHeldNames.push(n);
        continue;
      }
      keep.push(n);
      if (dryRun) {
        const to = view?.candidate ?? "?";
        log.push(`  dry-run: release check ${f}: would run ${rc.before ? `before [${asUser(rc, rc.before).join(" ")}], ` : ""}the upgrade to ${to} keeping the previous keg ${view?.current ?? "?"}, the owner restart, the check [${asUser(rc, rc.command).join(" ")}] with GATE_VERSION=${to}${rc.after ? `, then after [${asUser(rc, rc.after).join(" ")}]` : ""}`);
      }
    }
    formulas = keep;
  }

  if (!formulas.length && !casks.length) {
    log.push("brew: nothing to update");
    if (!b.failed.length) b.nothing = true;
    return;
  }

  // Never review a list brew failed to produce.
  const vq = await x([cfg.brew, "outdated", "--verbose", "--greedy-auto-updates", ...(b.fetchHead ? ["--fetch-HEAD"] : [])]);
  if (vq.rc !== 0) {
    await brewFailed("outdated-query");
    return;
  }
  // Excluded and held names stay out of the review table too (literal, by last segment).
  const hide = brewHeld();
  const verbose = `${vq.out}${vq.err}`.split("\n").filter((l) => !named(hide, l.trim().split(/\s+/)[0] ?? "")).join("\n");
  log.push(verbose.trimEnd(), "");
  b.verbose = verbose;

  // 3. Tap tiers. Type B is the config's list plus this host's approved taps.
  let typeBTaps = cfg.typeBTaps;
  if (cfg.approvedTapsFile) {
    const t = await fs.readFile(cfg.approvedTapsFile);
    if (t !== undefined) {
      const l = loadApprovedTaps(t, host, typeBTaps, { hostPrefixes: cfg.hostPrefixes });
      typeBTaps = l.taps;
      log.push(...l.warnings.map((w) => `  ${w}`));
    } else if (await fs.exists(cfg.approvedTapsFile)) log.push(`  WARNING: ${cfg.approvedTapsFile} unreadable — no tap approvals this run`);
  }
  let typeA: string[] = [];
  const typeBPairs: { pkg: string; tap: string }[] = [];
  const unknownF: { pkg: string; tap: string }[] = [];
  const unresolvedF: string[] = [];
  if (formulas.length) {
    const info = await x([cfg.brew, "info", "--json=v2", ...formulas]);
    const tapOf = new Map<string, string>();
    try {
      for (const e of (JSON.parse(info.out) as { formulae?: { name?: unknown; full_name?: unknown; tap?: unknown }[] }).formulae ?? []) {
        const tap = typeof e?.tap === "string" && e.tap ? e.tap : "unknown";
        for (const n of [e?.name, e?.full_name]) if (typeof n === "string" && n) tapOf.set(n, tap);
      }
    } catch {
      log.push("  WARNING: could not read formula tap data from brew — treating all pending formulae as unverified");
    }
    for (const pkg of formulas) {
      const tap = tapOf.get(pkg);
      if (tap === undefined) unresolvedF.push(pkg);
      else if (tapIn(tap, cfg.officialTaps)) typeA.push(pkg);
      else if (tapIn(tap, typeBTaps)) typeBPairs.push({ pkg: last(pkg), tap });
      else unknownF.push({ pkg: last(pkg), tap });
    }
  }
  // Casks by tap too, keyed on the name brew outdated gave (never the token echoed back), and
  // queried with --cask so a name that is also a formula is not answered about the formula.
  let keptCasks: string[] = [];
  const typeBCasks: string[] = [];
  const unknownC: { pkg: string; tap: string }[] = [];
  if (casks.length) {
    const info = await x([cfg.brew, "info", "--json=v2", "--cask", ...casks]);
    const tapOf = new Map<string, string>();
    try {
      for (const e of (JSON.parse(info.out) as { casks?: { token?: unknown; tap?: unknown }[] }).casks ?? []) {
        if (typeof e?.token === "string" && e.token) tapOf.set(e.token, typeof e.tap === "string" && e.tap ? e.tap : "unknown");
      }
    } catch {
      // an empty map: every cask below is unresolved
    }
    if (!tapOf.size) log.push("  WARNING: could not read cask tap data from brew — treating all pending casks as unverified");
    for (const k of casks) {
      const tap = tapOf.get(k);
      if (tap === undefined) unknownC.push({ pkg: k, tap: "tap-unresolved" });
      else if (tapIn(tap, cfg.officialTaps)) keptCasks.push(k);
      else if (tapIn(tap, typeBTaps)) typeBCasks.push(`${k}(${tap})`);
      else unknownC.push({ pkg: k, tap });
    }
  }
  const show = (xs: string[]) => (xs.length ? xs.join(" ") : "(none)");
  const unknownShown = [...unknownF.map((u) => `${u.pkg}(${u.tap})`), ...unresolvedF.map((u) => `${u}(tap-unresolved)`), ...unknownC.map((u) => `${u.pkg}(${u.tap})`)];
  log.push("Tier split:", `  Type A (first-party): ${show([...typeA, ...keptCasks])}`, `  Type B (third-party trusted): ${show(typeBPairs.map((p) => p.pkg))}`);
  log.push(`  Unknown tap: ${show(unknownShown)}`);
  if (typeBCasks.length) log.push(`  Trusted tap, no cask review path (skipped): ${typeBCasks.join(" ")}`);
  log.push("");

  // 4. Unknown taps: isolated, never block the host. Each pending formula gets an advisory
  // review (never installed, its notices logged only); one notice asks for the tap's approval.
  if (unknownShown.length || typeBCasks.length) {
    b.flagged = true;
    const tbNote = typeBCasks.length ? `; trusted-tap cask(s) skipped (no cask review path): ${typeBCasks.join(" ")}` : "";
    const items: string[] = [];
    if (unknownF.length || unknownC.length) {
      const a = await tb.awaiting(tbEnv, r, unknownF, unknownC, verbose, tbOpts);
      log.push(...a.log);
      if (a.items) items.push(a.items);
    }
    for (const pkg of unresolvedF) items.push(`(unresolved tap) (${pkg} ${outdatedVersions(pkg, verbose)}, review: n/a)`);
    const where = cfg.approvedTapsFile ?? "the approved-taps file (apply.approvedTapsFile)";
    if (items.length) {
      const list = items.join("; ");
      b.unknownNote = `FLAGGED — awaiting tap approval: ${list} — approve a tap by adding it to ${where}${tbNote}`;
      await notify(`⚠️ <b>${host} brew FLAGGED — awaiting tap approval</b>\n${list}${tbNote}\nHeld until the tap is approved; official Homebrew upgrades still proceed.\nApprove a tap once by adding a row to ${where} (tap, host or *, date, note); its updates then take the normal Type B review.\nLog: ${cfg.logFile ?? "-"}`);
    } else {
      b.unknownNote = `FLAGGED — ${tbNote.slice(2)}`;
      await notify(`⚠️ <b>${host} brew FLAGGED — trusted-tap cask skipped</b>\n${tbNote.slice(2)}\nLog: ${cfg.logFile ?? "-"}`);
    }
    log.push(`brew: awaiting tap approval — skipping [${unknownShown.join(" ")}${tbNote}], continuing with the rest`);
  }

  // 5. Type A: the deterministic version policy holds only what it names; the rest upgrades.
  if (typeA.length || keptCasks.length) {
    const all = [...typeA, ...keptCasks];
    log.push(`--- Type A review (${all.length} packages) ---`);
    const a = typeAReview(all, verbose, cfg.sensitive);
    log.push("┌─ Type A review", ...a.text.split("\n").map((l) => `│ ${l}`), "└─");
    if (a.held.length) {
      b.flagged = true;
      const held = new Set(a.held);
      typeA = typeA.filter((p) => !held.has(p));
      keptCasks = keptCasks.filter((p) => !held.has(p));
      await notify(`⚠️ <b>${host} Type A — holding ${a.held.length} pkg(s), upgrading rest</b>\nheld: ${a.held.join(" ")}\nSensitive major increase or unverifiable version baseline.\nLog: ${cfg.logFile ?? "-"}`);
      log.push(`Type A: holding [${a.held.join(" ")}] — upgrading [${[...typeA, ...keptCasks].join(" ")}]`);
    }
    typeA = await notWaiting(rt, typeA);
    keptCasks = await notWaiting(rt, keptCasks, true);
    if (!typeA.length && !keptCasks.length) log.push("Type A: nothing left to upgrade after holds");
    else if (dryRun) log.push(`dry-run: would upgrade Type A formulas=[${typeA.join(" ")}] casks=[${keptCasks.join(" ")}]`);
    else {
      // Recorded before the formula upgrades, so a stop part-way still leaves the casks to their phase.
      if (keptCasks.length) {
        b.deferredCasks = keptCasks;
        log.push(`Type A casks deferred until end of run: ${keptCasks.join(" ")}`);
      }
      for (const pkg of typeA) {
        if ((await upgradeFormula(rt, pkg)) !== 0) await brewFailed(pkg);
        else if (await versionHeld(rt, pkg, reviewedVersion(pkg, verbose), (await brewView(rt.rcEnv.exec, cfg.brew, pkg))?.current)) b.upgraded.push(pkg);
      }
    }
  }

  // 6. Type B: per-package review, then a guarded install. Its record is ours, filled as it goes.
  if (typeBPairs.length) {
    const go = new Set(await notWaiting(rt, typeBPairs.map((p) => `${p.tap}/${p.pkg}`)));
    typeBPairs.splice(0, typeBPairs.length, ...typeBPairs.filter((p) => go.has(`${p.tap}/${p.pkg}`)));
  }
  if (typeBPairs.length) {
    const into: TypeBRun = { upgraded: b.upgraded, upgradedFull: [], failed: b.failed, flagged: false, log };
    try {
      await tb.upgrades(tbEnv, r, typeBPairs, {
        ...tbOpts,
        dryRun,
        into,
        upgrade: (full) => upgradeFormula(rt, full),
      });
    } finally {
      if (into.flagged) b.flagged = true;
    }
  }
}

export async function cleanup(rt: RunCtx) {
  const { log, x, quarantined, rcPending, rcBroken, cfg } = rt;
  log.push("--- brew cleanup ---");
  // A quarantined service's reviewed keg, and a formula whose release check has not decided (its
  // previous keg is the rollback): clean everything else by name.
  const skip = [...(quarantined ? [quarantined.name] : []), ...rcPending.keys(), ...rcBroken];
  if (skip.length) {
    const fl = await x([cfg.brew, "list", "--formula", "--full-name"]);
    const cl = await x([cfg.brew, "list", "--cask"]);
    const keep = [...words(fl.out), ...words(cl.out)].filter((n) => !skip.includes(last(n)));
    if (quarantined) log.push(`  ${quarantined.name} quarantined — cleanup skips ${quarantined.name}`);
    for (const f of rcPending.keys()) log.push(`  ${f}: release check pending — cleanup skips ${f} (its previous keg is the rollback)`);
    for (const f of rcBroken) log.push(`  ${f}: release check record unreadable — cleanup skips ${f}`);
    if (keep.length) log.push(...(await x([cfg.brew, "cleanup", ...keep])).out.trimEnd().split("\n").slice(-5));
    return;
  }
  log.push(...(await x([cfg.brew, "cleanup"])).out.trimEnd().split("\n").slice(-5));
}

/**
 * The planned upgrades that do not depend on an outdated or uninstalled gated formula. brew upgrade
 * installs the dependencies a new version needs, so such an upgrade would pull the gated (or held)
 * release in with no before, check or rollback: it waits for a run where the gated formula is
 * installed and current.
 * The query is the candidate's declared dependencies, recursive, build and optional ones too: a
 * plain `brew deps` of an installed formula reads its installed keg's runtime dependencies (not
 * the new release's) and leaves out build dependencies, which a source build installs.
 * Unreadable dependencies wait too (fail closed). Every gated formula installed and current: nothing is queried.
 */
async function notWaiting(rt: RunCtx, names: string[], cask = false): Promise<string[]> {
  const { log, b, x, gatedOutdated, cfg } = rt;
  if (!gatedOutdated.length) return names;
  const keep: string[] = [];
  for (const n of names) {
    // Every planned upgrade, a gated formula (on another gated one) and a cask (its formula dependencies) too.
    // Only a formula is exempt from its own name: a cask named like a gated formula is another package.
    const d = await x([cfg.brew, "deps", ...DECLARED_DEPS, ...(cask ? ["--cask"] : []), n]);
    // Every line a package name, or the list is unreadable.
    const deps = d.rc === 0 ? words(d.out) : [];
    const read = d.rc === 0 && deps.every((dep) => PKG_NAME.test(dep));
    const hit = read ? deps.find((dep) => gatedOutdated.includes(last(dep)) && (cask || last(dep) !== last(n))) : undefined;
    if (!read) log.push(`  ${last(n)}: not upgraded this run — its dependencies could not be read while ${gatedOutdated.join(" ")} is gated by a release check`);
    else if (hit) log.push(`  ${last(n)}: not upgraded this run — it depends on ${last(hit)}, which a release check gates; retried next run`);
    else {
      keep.push(n);
      continue;
    }
    b.rcNotes.push(`${last(n)} waits for ${hit ? last(hit) : "its dependencies"}`);
  }
  return keep;
}

/** After a Type A upgrade: true when the installed version is the reviewed one; otherwise flagged, notified and counted failed. */
async function versionHeld(rt: RunCtx, pkg: string, reviewed: string | undefined, installed: string | undefined): Promise<boolean> {
  const why = versionMismatch(pkg, reviewed, installed);
  if (!why) return true;
  const { log, b, notify, host, cfg } = rt;
  b.failed.push(`version:${pkg}`);
  b.flagged = true;
  log.push(`  Type A: ${why} — FLAGGED`);
  await notify(`⚠️ <b>${host} Type A FLAGGED</b>\n${why}\nLog: ${cfg.logFile ?? "-"}`);
  return false;
}

/** A formula upgrade; one with a release check records its previous keg first and runs its before. */
async function upgradeFormula(rt: RunCtx, full: string): Promise<number> {
  const { now, log, stamp, b, x, installEnv, rcEnv, rcPending, rcThisRun, oweAfter, cfg } = rt;
  const rc = findCheck(cfg.releaseChecks, full);
  if (!rc) return (await x([cfg.brew, "upgrade", full], { env: installEnv })).rc;
  const f = last(full);
  const view = await brewView(rcEnv.exec, cfg.brew, full);
  const cel = await x([cfg.brew, "--cellar", f]);
  const rack = cel.rc === 0 ? cel.out.trim() : "";
  // The rollback needs all three: the version in use, its rack, and whether brew trusts the formula
  // (uninstall drops the trust). Any unread: not upgraded, never upgraded without a rollback.
  const trusted = view ? await trustState(rcEnv.exec, cfg.brew, view.full) : undefined;
  const why = !view?.current ? "the version in use could not be read" : !rack.startsWith("/") ? "its cellar could not be read" : trusted === undefined ? "its trust state could not be read" : "";
  if (!view?.current || why || trusted === undefined) {
    log.push(`  ${f}: not upgraded — release check: ${why}`);
    b.rcNotes.push(`${f} not upgraded, ${why}`);
    return 1;
  }
  const p: PendingCheck = { formula: f, full, rack, from: view.current, trusted, beforeRan: false, at: stamp };
  rcPending.set(f, p);
  rcThisRun.add(f);
  // Written before before runs: a run that dies from here on leaves it, and the next run owes after.
  await savePending(rcEnv, p);
  // The stop task decides at the stop whether after is owed (before ran, the upgrade started, or a verdict says run).
  oweAfter(p);
  if (rc.before) {
    p.beforeRan = true;
    await savePending(rcEnv, p);
    if (!(await runHook(rcEnv, rc, "before"))) {
      log.push(`  ${f}: not upgraded — its release check's before failed`);
      return 1;
    }
  }
  // On the record before the upgrade: from here a stop or an error before the verdict owes after, before or not.
  // Owed only once written: a write that fails stops the upgrade, and a run that upgraded nothing owes none.
  await savePending(rcEnv, { ...p, upgradeStarted: true });
  p.upgradeStarted = true;
  const code = (await x([cfg.brew, "upgrade", full], { env: installEnv })).rc;
  if (code === 0) {
    const now = await brewView(rcEnv.exec, cfg.brew, full);
    if (now?.current && now.current === p.from) {
      // brew exited 0 without changing the version in use (another updater installed the candidate
      // first, or brew had nothing to do): no upgrade, so no check and no rollback (the version in
      // use may be the only keg). after is owed as for an upgrade that did not complete.
      p.unchanged = true;
      await savePending(rcEnv, p);
      log.push(`  release check ${f}: brew upgrade exited 0 but ${f} is still ${p.from} — no upgrade, no check`);
    } else {
      p.upgraded = true;
      if (now?.current) p.to = now.current;
      await savePending(rcEnv, p);
      log.push(`  release check ${f}: ${p.from || "?"} → ${p.to ?? "?"}, the previous keg kept until the check decides`);
    }
  }
  return code;
}

export async function appBundlesSection(rt: RunCtx) {
  const { opts, dryRun, host, r, log, b, x, notify, tbEnv, cfg, fs, exec } = rt;
  if (!cfg.appBundles.length) return;
  log.push("", "--- app bundles ---");
  const net = opts.appNet ?? realAppNet;
  const env = { ...net, exec: x, git: tbEnv.git, spawnDetached: fs.spawnDetached };
  for (const app of cfg.appBundles) {
    const res = await appBundleUpgrade(env, r, app, {
      dryRun, host, logFile: cfg.logFile, stateDir: cfg.stateDir, notify, caps: cfg.caps, detachedLog: join(cfg.stateDir, "restart.log"),
    });
    log.push(...res.log);
    if (res.status === "held") b.flagged = true;
    else if (res.status === "failed") {
      b.flagged = true;
      b.failed.push(`app:${app.name}`);
    }
    if (res.note) b.appNotes.push(res.note);
  }
}

export async function casksSection(rt: RunCtx) {
  const { opts, dryRun, host, log, b, x, notify, brewFailed, installEnv, cfg, exec } = rt;
  if (!b.deferredCasks.length) return;
  log.push("", "--- deferred Type A casks ---");
  const gk = opts.gk ?? (await (async (): Promise<GkOps> => {
    const env = await gkEnv(cfg, x);
    if (!env) return gkUnchecked;
    const o: GkOptions = { dryRun, host, logFile: cfg.logFile, notify };
    return { snapshot: (k) => gkSnapshot(env, k), release: (k, p) => gkRelease(env, k, o, { prior: p }), check: (k) => gkCheck(env, k, o) };
  })());
  try {
    // One at a time: a batch upgrade fails whole when any one cask fails.
    for (const cask of b.deferredCasks) {
      b.caskTried.add(cask);
      // A pkg or kext artifact needs sudo, which an unattended run does not have.
      const info = await x([cfg.brew, "info", "--json=v2", "--cask", cask]);
      let needsSudo = false;
      let apps: string[] = [];
      try {
        const arts = (JSON.parse(info.out) as { casks?: { artifacts?: unknown[] }[] }).casks?.[0]?.artifacts ?? [];
        apps = arts.flatMap((a) => (a && typeof a === "object" && Array.isArray((a as { app?: unknown }).app) ? (a as { app: unknown[] }).app : [])).filter((n): n is string => typeof n === "string").map((n) => `/Applications/${n}`);
        needsSudo = arts.some((a) => !!a && typeof a === "object" && ("pkg" in a || "kext" in a));
      } catch {
        needsSudo = false;
      }
      if (needsSudo) {
        log.push(`  skip ${cask} — needs sudo (pkg/kext); flagged for manual upgrade`);
        b.casksSudo.push(cask);
        continue;
      }
      // An upgrade removes the cask's binaries and app: one with a process running from it waits for the next run.
      const room = (await x([cfg.brew, "--caskroom"])).out.trim();
      const maps = room.startsWith("/") ? await lsofMaps({ exec: x } as KegEnv, cfg.lsof, log) : undefined;
      const pids = maps === undefined ? [] : caskRunning(maps, room, cask, apps);
      if (pids.length) {
        log.push(`  ${cask}: deferred — a process is running from it (pid ${pids.join(" ")}); retried next run`);
        b.casksRunning.push(cask);
        continue;
      }
      log.push(`  upgrading ${cask}...`);
      // The snapshot is taken before the upgrade replaces what it reads.
      const prior = await gk.snapshot(cask);
      if ((await x([cfg.brew, "upgrade", "--cask", "--greedy", cask], { env: installEnv })).rc === 0) {
        let got: unknown;
        try {
          got = (JSON.parse((await x([cfg.brew, "info", "--json=v2", "--cask", cask])).out) as { casks?: { installed?: unknown }[] }).casks?.[0]?.installed;
        } catch {
          got = undefined;
        }
        const ok = await versionHeld(rt, cask, reviewedVersion(cask, b.verbose), typeof got === "string" ? got : undefined);
        if (ok) b.casksUp.push(cask);
        log.push(...(await gk.release(cask, prior)));
        const c = await gk.check(cask);
        log.push(...c.log);
        if (c.note) b.gkNotes.push(c.note);
      } else {
        log.push(`  ${cask}: upgrade FAILED`);
        b.casksFailed.push(cask);
        await brewFailed(cask);
      }
    }
  } finally {
    if (b.casksFailed.length) {
      b.flagged = true;
      await notify(`⚠️ <b>${host} casks FAILED</b>\ncasks: ${b.casksFailed.join(" ")}\nLog: ${cfg.logFile ?? "-"}`);
      log.push(`deferred casks failed: ${b.casksFailed.join(" ")}`);
    }
    if (b.casksSudo.length) {
      await notify(`ℹ️ <b>${host} casks need manual upgrade (sudo)</b>\n${b.casksSudo.join(" ")}\nUpgrade interactively: brew upgrade --cask --greedy ${b.casksSudo.join(" ")}\nLog: ${cfg.logFile ?? "-"}`);
    }
  }
}
