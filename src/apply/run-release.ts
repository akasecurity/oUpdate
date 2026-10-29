// The release-check step of the host apply run (run.ts drives it): each unfinished check's owner restarts, its
// pre-check gate and its verdict, and the owner jobs a check requires.

import { dirname, join } from "node:path";
import { kegHolders, lsofMaps, type Holder, type KegEnv } from "./kegs.ts";
import { matchOwner, ownerDir, ownerFiles, ownerOps, type OwnerWaiterEnv, type QueuedOwner } from "./owner-waiter.ts";
import { asUser, brewView, resume, findCheck, holdFailed, pendingPath, readHold, runHook, savePending, type PendingCheck } from "./release-checks.ts";
import { restartUpgraded } from "./restarts.ts";
import { type RunCtx, last, named } from "./run-ctx.ts";

/** How long a release check waits for the owner waiter's lock before its check waits for a later run. */
const LOCK_WAIT_MS = 10 * 60_000;

/** Runs a check waits for its owner (any reason) before it ends with no verdict, notified. */
const UNRESOLVED_WAIT_RUNS = 3;

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export async function releaseChecksSection(rt: RunCtx) {
  const { opts, dryRun, now, host, log, b, x, notify, step, rcEnv, rcPending, mergeOwners, rcStopOff, stoppingNow, afterOwed, expectedKeg, retiredFor, ownerLock, clock, restartOpts, cfg, fs, exec } = rt;
  if (!rcPending.size) return;
  log.push("", "--- release checks ---");
  try {
  for (const p of [...rcPending.values()]) {
    const f = p.formula;
    // Each record on its own: one that throws is logged and notified, and the rest (their owed after too) go on.
    try {
    const rc = findCheck(cfg.releaseChecks, f);
    if (dryRun) {
      log.push(`  dry-run: release check ${f} ${p.to ?? "?"} pending — would restart its owner and run the check${rc?.after && afterOwed(p) ? `, then after [${asUser(rc, rc.after).join(" ")}]` : ""}`);
      continue;
    }
    if (!rc) {
      log.push(`  release check ${f}: no longer configured — its record is removed`);
      await fs.remove(pendingPath(cfg.stateDir, f));
      continue;
    }
    let keep = false;
    let locked = false;
    const lockPath = ownerFiles(ownerDir(cfg.stateDir)).lock;
    try {
      if (p.ended) {
        b.rcNotes.push(`${f}: after owed by an earlier run`);
        continue;
      }
      // A record that names no version change (to === from, as written before this was checked) is no upgrade.
      if (p.to && p.to === p.from && !p.verdict) {
        p.unchanged = true;
        delete p.to;
        delete p.upgraded;
      }
      if (!p.to && p.from && !p.unchanged) {
        // A stopped run may have upgraded without recording it.
        const v = await brewView(rcEnv.exec, cfg.brew, p.full);
        if (v?.current && v.current !== p.from) p.to = v.current;
      }
      // Answers read while stopping are not answers: nothing is decided from them.
      if (stoppingNow()) continue;
      if (!p.to || !p.from) {
        if (p.unchanged) {
          // No version change: nothing to check and nothing to roll back to. Notified: the version
          // in use may have come from another updater, unchecked.
          const why = `release check ${f}: not run — brew upgrade exited 0 but the version in use is still ${p.from}`;
          log.push(`  ${why}`);
          b.rcNotes.push(`${f} upgrade changed nothing (still ${p.from}), no check`);
          await notify(`⚠️ <b>${host} ${why}</b>\nNo upgrade to check: nothing is rolled back, ${p.from} is kept.\nLog: ${cfg.logFile ?? "-"}`);
        } else if (p.upgraded || p.to) {
          // Never a silent skip: no verdict, said so.
          const why = `release check ${f}: not run — the installed version could not be read (before ${p.from || "?"}, after ${p.to || "?"})`;
          log.push(`  ${why}`);
          b.failed.push(`release-check:${f}`);
          b.flagged = true;
          b.rcNotes.push(`${f} not checked, versions unreadable`);
          p.after = "run";
          await notify(`⚠️ <b>${host} ${why}</b>\nNo verdict: the new version is kept.\nLog: ${cfg.logFile ?? "-"}`);
        } else {
          log.push(`  release check ${f}: the upgrade did not complete — no check`);
          b.rcNotes.push(`${f} not upgraded, no check`);
        }
        p.ended = true;
        continue;
      }
      const to = p.to;
      // A confirmed fail is held from the moment it is decided, its rollback waiting or not.
      if (p.verdict === "fail" && !p.rolledBack && (await readHold(rcEnv, f))?.version !== to) await holdFailed(rcEnv, p as PendingCheck & { to: string });
      /**
       * This run's wait for the owner, counted on the record (every reason alike: the scan did not
       * run or did not look, a stale process unresolved, the waiter's lock, a busy owner). At the
       * limit an undecided check ends with no verdict (notified, the new version kept, after owed);
       * a decided one is never ended by it: it is notified and goes on waiting.
       */
      const ownerWait = async (why: string, note: string) => {
        p.unresolvedWaits = (p.unresolvedWaits ?? 0) + 1;
        await savePending(rcEnv, p);
        const n = p.unresolvedWaits;
        if (n < UNRESOLVED_WAIT_RUNS || (p.verdict && n > UNRESOLVED_WAIT_RUNS) || stoppingNow()) {
          keep = true;
          log.push(`  release check ${f}: ${why} — the check waits for a later run (${n}/${UNRESOLVED_WAIT_RUNS})`);
          b.rcNotes.push(`${f} ${to} check waits for its owner (${note})`);
          return;
        }
        if (p.verdict) {
          keep = true;
          const said = `release check ${f} ${to}: ${p.verdict === "fail" ? "FAIL decided, its rollback" : "its verdict"} has waited ${n} runs — ${why}`;
          log.push(`  ${said}`);
          b.failed.push(`release-check:${f}`);
          b.flagged = true;
          b.rcNotes.push(`${f} ${to} still waits for its owner (${note})`);
          await notify(`⚠️ <b>${host} ${said}</b>\nStill waiting: each run tries again.\nLog: ${cfg.logFile ?? "-"}`);
          return;
        }
        const said = `release check ${f} ${to}: not run — ${why} for ${n} runs`;
        log.push(`  ${said}`);
        b.failed.push(`release-check:${f}`);
        b.flagged = true;
        b.rcNotes.push(`${f} ${to} not checked, ${note} for ${n} runs`);
        await notify(`⚠️ <b>${host} ${said}</b>\nNo verdict: ${to} is kept.\nLog: ${cfg.logFile ?? "-"}`);
        // No verdict, the new version kept: after is owed as for a check that could not run, before or not.
        p.after = "run";
        // A notice made while stopping was not sent: the next run ends it.
        if (stoppingNow()) keep = true;
        else p.ended = true;
      };
      // An owner restart still ahead of an undecided check needs the stale-keg scan's view of who
      // runs the kegs it must leave. A decided verdict is never held back by it: a persisted FAIL goes
      // on to its rollback and hold. Whether a process is on such a keg right before any check is
      // the pre-check gate's to see (resume), whatever an earlier run's restart did.
      const restartAhead = !p.verdict && !p.ownerRestarted;
      if (cfg.staleOwners?.length && restartAhead && (!rt.st.rcScanned || rt.st.rcScannedRacks.get(p.rack) !== expectedKeg(p))) {
        // Not scanned for: the scan failed, or the installed version was read only after it.
        const unseen = rt.st.rcScanned ? "the stale-keg scan did not look at its previous keg" : "the stale-keg scan did not run";
        await ownerWait(unseen, unseen);
        continue;
      }
      // A process on a keg the owner must leave whose owner the scan could not find: as unscanned,
      // unless the check names its owners: they are restarted and the gate scans before the check.
      if (cfg.staleOwners?.length && restartAhead && !rc.owners?.length && [...rt.st.rcUnresolved].some((k) => retiredFor(p, k))) {
        await ownerWait("a process on its previous keg has no owner the stale-keg scan could find", "a stale process on its previous keg is unresolved");
        continue;
      }
      // No waiter restarts anything while this formula's owner is restarted and checked: its lock,
      // waited for (bounded), and the label's own queued job removed.
      if (cfg.staleOwners?.length || rc.owners?.length) {
        const t0 = clock.now();
        for (;;) {
          if (await ownerLock.take(lockPath)) {
            locked = true;
            break;
          }
          if (clock.now() - t0 >= LOCK_WAIT_MS) break;
          await clock.sleep(5_000);
        }
        if (!locked) {
          await ownerWait("the owner restart waiter held its lock past the bound", "the owner restart waiter holds its lock");
          continue;
        }
        for (const q of await requiredJobs(rt, f, join(p.rack, p.rolledBack ? to : p.from))) await fs.remove(join(ownerFiles(ownerDir(cfg.stateDir)).queue, `${encodeURIComponent(q.target)}.json`));
      }
      // The record itself: each step resume writes is this record's.
      const d = await resume(rcEnv, rc, p as PendingCheck & { to: string }, {
        save: async () => savePending(rcEnv, p),
        stopping: stoppingNow,
        restartOwner: async (phase) => {
          const keg = join(p.rack, phase === "new" ? p.from : to);
          const into: string[] = [];
          if (phase === "restored") await restartUpgraded({ exec: x, exists: fs.exists, spawnDetached: fs.spawnDetached, home: fs.home, uid: fs.uid }, [p.formula], { ...restartOpts, into });
          // The version the owners must run after the restart: every other keg of the formula is stale.
          const expect = join(p.rack, phase === "new" ? to : p.from);
          const jobs = await requiredJobs(rt, f, keg, expect);
          // The whole set on the record before any restart: a resumed rollback restarts the same owners.
          const all = mergeOwners(p.owners ?? [], jobs);
          if (all.length !== (p.owners ?? []).length) {
            p.owners = all;
            await savePending(rcEnv, p);
          }
          const o = await ownerJobs(rt, jobs);
          const kind = into.some((s) => s.includes("FAILED")) ? "failed" : o.kind;
          // Whether a process is left on a keg it must leave is the pre-check gate's to see.
          return { kind, note: [...into, o.note].filter(Boolean).join(", ") || "nothing to restart" };
        },
        scan: (expect) => kegPids(rt, p.rack, expect),
      });
      if (d.wait) await ownerWait(`its owner could not be restarted yet (${d.waitWhy ?? "busy"})`, d.waitWhy ?? "busy");
      else if (d.note) b.rcNotes.push(d.note);
      if (d.failed) {
        b.failed.push(d.failed);
        b.flagged = true;
      }
    } finally {
      if (locked) {
        try {
          await ownerLock.release(lockPath);
        } catch (e) {
          log.push(`  WARNING: release check ${f}: the owner lock could not be released (${errText(e)})`);
        }
      }
      // A stop under way: the stop task owns after; the record resumes from its last step.
      if (stoppingNow()) log.push(`  release check ${f}: oupdate is stopping — after is left to the stop path, the record to the next run`);
      else {
        const owed = !!rc.after && afterOwed(p);
        if (owed) {
          let ran = false;
          try {
            ran = await runHook(rcEnv, rc, "after");
          } catch (e) {
            log.push(`  release check ${f}: after FAILED (${errText(e)})`);
          }
          if (ran) {
            p.afterRan = true;
            // On the record before anything else can fail (the record's removal too): after never runs twice.
            await savePending(rcEnv, p);
          } else b.failed.push(`release-check-after:${f}`);
        } else if (rc.after && p.after === "skip") log.push(`  release check ${f}: after not run — the host stays as before left it`);
        // A stop that arrived during after (it was killed) leaves the record to the stop path too.
        if (!stoppingNow()) {
          rcStopOff.get(f)?.();
          rcStopOff.delete(f);
          if (keep && p.afterRan) {
            // Waiting: after ran for this run's before. afterRan stays, so a later verdict owes none.
            p.beforeRan = false;
          }
          // The record goes only once the check is over and no after is owed.
          if (p.ended && !(owed && !p.afterRan)) {
            await fs.remove(pendingPath(cfg.stateDir, f));
            rcPending.delete(f);
          } else await savePending(rcEnv, p);
        }
      }
    }
    } catch (e) {
      const why = `release check ${f}: FAILED (${errText(e)})`;
      log.push(`  ${why}`);
      b.failed.push(`release-check:${f}`);
      b.flagged = true;
      b.rcNotes.push(`${f} release check error`);
      try {
        await notify(`⚠️ <b>${host} ${why}</b>\nOther release checks go on.\nLog: ${cfg.logFile ?? "-"}`);
      } catch {
        // Logged above.
      }
    }
  }
  } finally {
    // Other owners queued while a release check was unfinished: their waiter starts now.
    if (rt.st.waiterDeferred && !dryRun) {
      const labels = rt.st.waiterDeferred;
      rt.st.waiterDeferred = "";
      if (!opts.ownerWaiterArgv?.length) log.push(`  owner restart waiter FAILED: no waiter command here, ${labels} queued but not started`);
      else {
        try {
          const pid = await fs.spawnDetached(opts.ownerWaiterArgv, join(cfg.stateDir, "restart.log"));
          log.push(`  owner restart waiter started (pid ${pid}) for ${labels}, after the release checks`);
        } catch (e) {
          log.push(`  owner restart waiter FAILED to start (${e instanceof Error ? e.message : String(e)}), ${labels} queued`);
        }
      }
    }
  }
}

/** A release check's owner jobs, inline, as the waiter does them: failed, busy, or ok. */
async function ownerJobs(rt: RunCtx, jobs: QueuedOwner[]): Promise<{ kind: "ok" | "busy" | "failed"; note: string }> {
  const { now, r, log, clock, waiterEnv, cfg, fs, exec } = rt;
  if (!jobs.length) return { kind: "ok", note: "" };
  const env: OwnerWaiterEnv = {
    exec: waiterEnv.exec, readFile: fs.readFile, writeFile: fs.writeFile, remove: fs.remove, listDir: fs.listDir, isDir: fs.isDir,
    ...(fs.appendFile ? { appendFile: fs.appendFile } : {}),
    now: clock.now, sleep: clock.sleep, httpStatus: clock.httpStatus, takeLock: async () => true, releaseLock: async () => {},
    log: (l) => log.push(`    owner: ${l}`),
  };
  const ops = ownerOps(env, { dir: ownerDir(cfg.stateDir), lsof: cfg.lsof });
  let kind: "ok" | "busy" | "failed" = "ok";
  const lines: string[] = [];
  for (const q of jobs) {
    // Restarted even when an earlier run's restart of it failed: the check needs it restarted.
    const r = await ops.job(q, { ignoreFailed: true });
    const line = r.line ?? `${q.label} not restarted`;
    log.push(`  release check owner: ${line}`);
    lines.push(line);
    // An owner gone before its restart was never restarted: a failure, never ok.
    if (r.kind === "failed" || r.kind === "skipped" || r.kind === "not-running") kind = "failed";
    else if (r.kind === "busy" && kind === "ok") kind = "busy";
  }
  return { kind, note: lines.join(", ") };
}

/**
 * The processes mapping a keg of the formula (its rack) other than `expect` now (a fresh lsof), or
 * undefined when the processes cannot be read.
 */
async function kegPids(rt: RunCtx, rack: string, expect: string): Promise<Holder[] | undefined> {
  const { now, log, x, cfg, exec } = rt;
  const maps = await lsofMaps({ exec: x } as KegEnv, cfg.lsof, log, true);
  return maps === undefined ? undefined : kegHolders(maps, dirname(rack)).filter((h) => dirname(h.keg) === rack && h.keg !== expect);
}

/**
 * The owner jobs a release check needs restarted off `keg`: those the stale-keg check found on it,
 * and the formula's own launchd service when its label matches staleOwners (found or not: a
 * service that is not running then is a restart failure, never a pass). Only no staleOwners match
 * means no owner restart is needed. `expect`: the keg they must run after it (see QueuedOwner).
 */
async function requiredJobs(rt: RunCtx, f: string, keg: string, expect?: string): Promise<QueuedOwner[]> {
  const { rcPending, rcJobs, mergeOwners, cfg, fs } = rt;
  // This run's scan and every owner the record names (an earlier run's scan): all required, as a
  // shell or supervisor maps no keg while its child runs the old one.
  const found = mergeOwners(rcJobs.get(f) ?? [], rcPending.get(f)?.owners ?? []);
  const jobs: QueuedOwner[] = found.map((q) => {
    const { expect: _, ...base } = q.keg === keg ? q : { ...q, pid: "?", keg };
    return { ...base, required: true, ...(expect ? { expect } : {}) };
  });
  for (const label of [`sh.brew.${f}`, `homebrew.mxcl.${f}`]) {
    const where = (await fs.exists(`/Library/LaunchDaemons/${label}.plist`)) ? "system" : (await fs.exists(`${fs.home}/Library/LaunchAgents/${label}.plist`)) ? `gui/${fs.uid}` : "";
    if (!where) continue;
    const owner = matchOwner(cfg.staleOwners, label);
    const target = `${where}/${label}`;
    if (owner && !jobs.some((q) => q.target === target)) {
      jobs.push({ label, target, pid: "?", keg, required: true, ...(expect ? { expect } : {}), ...(owner.probe ? { probe: owner.probe } : {}), ...(owner.health ? { health: owner.health } : {}),
        ...(owner.restart ? { restart: owner.restart } : {}), ...(owner.healthWithinSec ? { healthWithinSec: owner.healthWithinSec } : {}) });
    }
    break;
  }
  // The check's named owners: always required, matched literally, with the staleOwners entry's probe/health/restart when one matches.
  for (const label of findCheck(cfg.releaseChecks, f)?.owners ?? []) {
    const where = (await fs.exists(`/Library/LaunchDaemons/${label}.plist`)) ? "system" : (await fs.exists(`${fs.home}/Library/LaunchAgents/${label}.plist`)) ? `gui/${fs.uid}` : "system";
    const target = `${where}/${label}`;
    const had = jobs.findIndex((q) => q.label === label);
    if (had >= 0) {
      jobs[had] = { ...jobs[had]!, required: true };
      continue;
    }
    const owner = matchOwner(cfg.staleOwners, label);
    jobs.push({ label, target, pid: "?", keg, required: true, ...(expect ? { expect } : {}), ...(owner?.probe ? { probe: owner.probe } : {}), ...(owner?.health ? { health: owner.health } : {}),
      ...(owner?.restart ? { restart: owner.restart } : {}), ...(owner?.healthWithinSec ? { healthWithinSec: owner.healthWithinSec } : {}) });
  }
  return jobs;
}
