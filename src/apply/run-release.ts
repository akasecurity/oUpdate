// The release-check step of the host apply run (run.ts drives it): each unfinished check's owner restarts, its
// pre-check gate and its verdict, and the owner jobs a check requires.

import { groupAlive, type Exec } from "./exec.ts";
import { basename, dirname, join } from "node:path";
import { kegHolders, lsofMaps, type Holder, type KegEnv } from "./kegs.ts";
import { matchOwner, ownerDir, ownerFiles, ownerOps, parsePrint, type OwnerWaiterEnv, type QueuedOwner } from "./owner-waiter.ts";
import { adoptInstalled, asUser, brewView, installedAbove, kegDirFor, failOptLink, failUnauthorized, invalidateRecord, resume, findCheck, holdFailed, pendingPath, readHold, runHook, savePending, type PendingCheck } from "./release-checks.ts";
import { restartUpgraded } from "./restarts.ts";
import { recordPath, recordText } from "./tailscale-sweep.ts";
import { type RunCtx, last, liveRestartPid, named, ownerArgvKey, ownerArgvs } from "./run-ctx.ts";

/** How long a release check waits for the owner waiter's lock before its check waits for a later run. */
const LOCK_WAIT_MS = 10 * 60_000;

/** Runs a check waits for its owner (any reason) before it ends with no verdict, notified. */
const UNRESOLVED_WAIT_RUNS = 3;
/** Runs in which after may be withheld for a restart process still running as root, each by a fresh helper hanging (the pid is kept for one run only): at this count it runs anyway. */
const AFTER_WITHHELD_RUNS = 3;

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export async function releaseChecksSection(rt: RunCtx) {
  const { opts, dryRun, now, host, stamp, log, b, x, notify, step, rcEnv, rcPending, mergeOwners, rcStopOff, stoppingNow, afterOwed, expectedKeg, retiredFor, ownerLock, clock, restartOpts, cfg, fs, exec, waiterEnv } = rt;
  if (!rcPending.size) {
    await startDeferredWaiter(rt);
    return;
  }
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
    /** The saved verdict's sweep record could not be written again: the record stays, so the next run tries again. */
    let republishFailed = false;
    /**
     * This host's sweep record for the saved verdict: present and saying the same (host, version, status) is enough; missing or another one is written again. False when the write fails
     * (logged, flagged): the pending record is then kept and the next run tries again, every run until it lands.
     */
    const republish = async (): Promise<boolean> => {
      const path = recordPath(cfg.stateDir, p.to!);
      const status = p.verdict === "pass" ? "verified" : "failed";
      let text: string | undefined;
      try {
        text = await rcEnv.readFile(path);
      } catch (e) {
        // A record that cannot be read (a directory, no access) is no reason to hold the rollback back. It may still be replaceable (no read permission in a writable directory):
        // the verdict is written over it once (an atomic replace); if that fails too it is reported, the pending record kept, asked again next run.
        try {
          await rcEnv.writeFile(path, recordText({ host, version: p.to!, status, at: stamp }));
          log.push(`  release check ${f}: the sweep record ${path} could not be read (${errText(e)}) — replaced with the ${status} verdict`);
          return true;
        } catch {
          b.failed.push(`release-check:${f}`);
          b.flagged = true;
          b.rcNotes.push(`${f} sweep record ${path} unreadable`);
          log.push(`  release check ${f}: WARNING — the sweep record ${path} could not be read (${errText(e)}) nor replaced — the pending record is kept, asked again next run`);
          return false;
        }
      }
      let same = false;
      try {
        const j = text === undefined ? undefined : (JSON.parse(text.trim()) as { host?: unknown; version?: unknown; status?: unknown });
        same = !!j && j.host === host && j.version === p.to && j.status === status;
      } catch {
        same = false;
      }
      if (same) return true;
      try {
        await rcEnv.writeFile(path, recordText({ host, version: p.to!, status, at: stamp }));
        log.push(`  release check ${f}: the sweep record for ${p.to} (${status}) was ${text === undefined ? "missing" : "not the verdict"} — written again`);
        return true;
      } catch (e) {
        b.failed.push(`release-check:${f}`);
        b.flagged = true;
        log.push(`  release check ${f}: WARNING — the sweep record for ${p.to} could not be written (${errText(e)}) — the pending record is kept, asked again next run`);
        return false;
      }
    };
    let locked = false;
    /** The pid of a restart process still running as root: no `after`, no lock release, no waiter beside it. */
    const helperHeld = () => liveRestartPid(restartOpts.helperRunning, p.formula, ownerArgvs(cfg.staleOwners, [...(findCheck(cfg.releaseChecks, f)?.owners ?? []), ...(p.owners ?? []).map((q) => q.label)]));
    const lockPath = ownerFiles(ownerDir(cfg.stateDir)).lock;
    try {
      // A record of an unauthorized version still to be removed (the removal failed, or the run died before it): removed before anything else, every run until it is gone.
      if (p.invalidate && !stoppingNow() && !dryRun && !(await invalidateRecord(rcEnv, p, () => savePending(rcEnv, p)))) {
        republishFailed = true;
        b.failed.push(`release-check:${f}`);
        b.flagged = true;
        b.rcNotes.push(`${f} sweep record ${(p.invalidate ?? []).map((v) => recordPath(cfg.stateDir, v)).join(", ")} still to be removed (followers read it until it is gone)`);
      }
      // A confirmed fail is published before anything else, an ended record included: the rollback never waits on it, but the followers must read it (every run until it lands).
      if (rc.builtin && p.verdict === "fail" && !p.unauthorized && p.to && !stoppingNow() && !dryRun && !(await republish())) republishFailed = true;
      if (p.ended) {
        b.rcNotes.push(`${f}: after owed by an earlier run`);
        continue;
      }
      // The tailscale check never trusts a saved version: the installed keg is read now, on every recovery, undecided or saved PASS (a PASS is republished and its older kegs pruned
      // only for the keg that is installed now). A keg that cannot be read keeps the record pending (an upgrade that was started is never dropped before a version is read and decided).
      if (rc.builtin && (!p.verdict || p.verdict === "pass") && !p.rolledBack && !stoppingNow() && !dryRun) {
        const seen = await brewView(rcEnv.exec, cfg.brew, p.full, kegDirFor(rcEnv));
        // The version in use is the opt link's keg alone (never linked_keg or the one keg installed): a link that is unread keeps the record pending, one that is positively missing or
        // names no keg is a confirmed fail of the version on the record (a record with none stays pending).
        const stand = seen?.optState === "ok" ? seen.opt : undefined;
        // With the link bad, the version is the authorized keg when brew names it or the rack lists it (a version saved from a fallback link, or any other keg, is never preferred).
        const badTo = seen?.optState === "bad" ? await installedAbove(rcEnv, p, seen) : undefined;
        const badLink = !!badTo && badTo !== p.from;
        // A record whose version is the previous one is no upgrade (a legacy shape): the unchanged handling below takes it.
        const noUpgrade = !!p.to && p.to === p.from && !p.verdict;
        if (!stand && !badLink && !noUpgrade) {
          // A link that was read and is positively missing or names no keg, with no keg to blame (none on the record, none named by brew, none authorized in the rack): said as it is.
          const bad = seen?.optState === "bad";
          log.push(bad
            ? `  release check ${f}: the opt link is missing or names no keg and no installed keg can be named — the check stays pending, nothing is rolled back (docs/tailscale-upgrades.md, "A check that stays pending, and the manual rollback")`
            : `  release check ${f}: the installed version could not be read — the check stays pending, asked again next run`);
          b.rcNotes.push(bad ? `${f} opt link missing or on no keg, no keg to blame, check pending (manual rollback recipe in the docs)` : `${f} installed version unreadable, check pending`);
          b.failed.push(`release-check:${f}`);
          b.flagged = true;
          keep = true;
          // A PASS whose keg cannot be read now is not shown to the fleet meanwhile: the verified record is taken away, republished once the read confirms it. Only this host's own record is
          // removed (invalidateRecord reads the owner again); a removal that is refused or fails keeps the marker on the record, the check pending and the run flagged, every run until it lands.
          if (p.verdict === "pass" && p.to) {
            p.invalidate = [...new Set([...(p.invalidate ?? []), p.to])];
            await savePending(rcEnv, p).catch((e) => log.push(`  release check ${f}: WARNING — the pending record could not be saved (${errText(e)}); the removal is tried anyway`));
            if (!(await invalidateRecord(rcEnv, p, () => savePending(rcEnv, p)))) {
              republishFailed = true;
              b.rcNotes.push(`${f} sweep record ${(p.invalidate ?? []).map((v) => recordPath(cfg.stateDir, v)).join(", ")} still to be removed (followers read it until it is gone)`);
            }
          }
          continue;
        }
        if (p.verdict === "pass" && p.to && (badLink || stand !== p.to)) {
          // The host was changed since the PASS (rolled back by hand, another release): that PASS says nothing about this keg.
          log.push(`  release check ${f}: the saved PASS was for ${p.to}, the installed version is ${stand ?? "not named by the opt link"} — the PASS is dropped`);
          // A verified record this host published for it must not stand for a version that is no longer in use: removed first. A removal that fails never holds the decision back
          // (the keg in use is checked and rolled back as any other): a marker on the pending record keeps asking, every run, until the file is gone.
          p.invalidate = [...new Set([...(p.invalidate ?? []), p.to])];
          await savePending(rcEnv, p).catch((e) => log.push(`  release check ${f}: WARNING — the pending record could not be saved (${errText(e)}); the removal is tried anyway`));
          if (!(await invalidateRecord(rcEnv, p, () => savePending(rcEnv, p)))) {
            republishFailed = true;
            b.failed.push(`release-check:${f}`);
            b.flagged = true;
            b.rcNotes.push(`${f} sweep record ${(p.invalidate ?? []).map((v) => recordPath(cfg.stateDir, v)).join(", ")} still to be removed (followers read it until it is gone)`);
          }
          delete p.verdict;
          delete p.tail;
          delete p.why;
        }
        if (badLink) {
          p.to = badTo;
          await failOptLink(rcEnv, p, () => savePending(rcEnv, p));
        } else if (stand) p.to = stand;
      }
      // A record that names no version change (to === from, as written before this was checked) is no upgrade.
      if (p.to && p.to === p.from && !p.verdict) {
        p.unchanged = true;
        delete p.to;
        delete p.upgraded;
      }
      if (!p.to && p.from && !p.unchanged) {
        // A stopped run may have upgraded without recording it.
        const v = await brewView(rcEnv.exec, cfg.brew, p.full, kegDirFor(rcEnv));
        if (rc.builtin) await adoptInstalled(rcEnv, p, v, () => savePending(rcEnv, p));
        else if (v?.current && v.current !== p.from) p.to = v.current;
      }
      // The tailscale check authorizes one version: whatever is installed now (a run that died after the install, an upgrade that exited nonzero but changed the
      // keg) is compared to it every time, and another release is a confirmed fail, never adopted.
      if ((rc.builtin || p.gated) && !stoppingNow() && !dryRun) await failUnauthorized(rcEnv, p, () => savePending(rcEnv, p));
      // A saved PASS whose sweep record is missing or says something else (the run died between the two writes) is published again: followers never wait on a verdict already made.
      if (rc.builtin && !stoppingNow() && !dryRun && p.to && !p.unauthorized && p.verdict === "pass" && !(await republish())) {
        republishFailed = true;
        // Nothing else is decided or pruned before the PASS is published: the next run publishes it, every run until it lands.
        continue;
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
        } else if ((p.upgraded || p.to) && rc.builtin) {
          // The tailscale check never adopts a version it could not read: it stays pending (previous keg protected) and asks again next run.
          log.push(`  release check ${f}: the installed version could not be read (before ${p.from || "?"}) — the check stays pending, asked again next run`);
          b.rcNotes.push(`${f} installed version unreadable, check pending`);
          b.failed.push(`release-check:${f}`);
          b.flagged = true;
          keep = true;
          continue;
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
        if (n < UNRESOLVED_WAIT_RUNS || (p.verdict && n > UNRESOLVED_WAIT_RUNS) || stoppingNow() || rc.builtin) {
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
          if (phase === "restored") await restartUpgraded({ exec: x, restartExec: waiterEnv.exec, exists: fs.exists, spawnDetached: fs.spawnDetached, home: fs.home, uid: fs.uid }, [p.formula], { ...restartOpts, into });
          // The version the owners must run after the restart: every other keg of the formula is stale.
          const expect = join(p.rack, phase === "new" ? to : p.from);
          const jobs = await requiredJobs(rt, f, keg, expect);
          // A risky tailscale with no daemon to restart (no plist found, no stale-keg job) cannot be shown to run the new version: could not run, never a pass.
          if (!jobs.length && phase === "new" && f === "tailscale" && cfg.riskyKeepPrevious.some((q) => q.split("/").at(-1) === "tailscale")) {
            return { kind: "busy" as const, note: "no tailscale daemon found to restart (no sh.brew.tailscale, homebrew.mxcl.tailscale or com.tailscale.tailscaled plist)" };
          }
          // The whole set on the record before any restart: a resumed rollback restarts the same owners.
          const all = mergeOwners(p.owners ?? [], jobs);
          if (all.length !== (p.owners ?? []).length) {
            p.owners = all;
            await savePending(rcEnv, p);
          }
          // The formula's helper (step 2's, or the restored phase's own) is still running as root: an owner restart now would race it.
          const running = helperHeld();
          const o = running !== undefined
            ? { kind: "failed" as const, note: `owner restarts not made: a root restart process (pid ${running}) is still running` }
            : await ownerJobs(rt, jobs);
          if ("running" in o && o.running !== undefined && o.argv) {
            // Kept for the run: no `after`, no other restart of the owners this argv covers, and no owner waiter beside it (the key is no package name).
            restartOpts.helperRunning?.set(ownerArgvKey(o.argv), o.running);
          }
          const kind = into.some((s) => s.includes("FAILED")) ? "failed" : o.kind;
          // Whether a process is left on a keg it must leave is the pre-check gate's to see.
          return { kind, note: [...into, o.note].filter(Boolean).join(", ") || "nothing to restart" };
        },
        scan: (expect) => kegPids(rt, p.rack, expect),
      });
      // A fail whose record could not be written inside the deciding run: the rollback went on, the pending record stays until the failed record lands.
      if (rc.builtin && p.verdict === "fail" && !p.unauthorized && p.to && !stoppingNow() && !dryRun && !(await republish())) republishFailed = true;
      if (d.flag) {
        b.flagged = true;
        b.rcNotes.push(d.flag);
      }
      if (d.wait && d.failed && d.note) b.rcNotes.push(d.note);
      if (d.wait) await ownerWait(d.waitFor === "rollback" ? `its rollback could not be done yet (${d.waitWhy ?? "busy"})` : `its owner could not be ${d.failed ? "restarted" : "restarted yet"} (${d.waitWhy ?? "busy"})`, d.waitWhy ?? "busy");
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
        const wanted = !!rc.after && afterOwed(p);
        // A restart process still running as root: after is not run now, and the record (with its owed after) stays for a later run,
        // counted on the record; at AFTER_WITHHELD_RUNS it runs anyway.
        const holdPid = wanted ? helperHeld() : undefined;
        let withheld = false;
        if (holdPid !== undefined) {
          p.afterWithheld = (p.afterWithheld ?? 0) + 1;
          const n = p.afterWithheld;
          // On the record at once: a stop during the notice below must not lose this run's count.
          await savePending(rcEnv, p);
          if (n < AFTER_WITHHELD_RUNS) {
            withheld = true;
            log.push(`  release check ${f}: after not run — a restart process (pid ${holdPid}) is still running as root, after stays owed to a later run (${n}/${AFTER_WITHHELD_RUNS})`);
            b.failed.push(`release-check-after:${f}`);
            b.flagged = true;
            await notify(`⚠️ <b>${host} release check ${f}: after withheld (${n}/${AFTER_WITHHELD_RUNS})</b>\nA restart process (pid ${holdPid}) is still running as root: the host stays out of rotation for this run only. The hold lasts one run: the pid is kept for this run, not saved, so the next run runs after unless a fresh helper hangs again. The count reaches ${AFTER_WITHHELD_RUNS} only if a fresh helper hangs ${AFTER_WITHHELD_RUNS} runs in a row, and after then runs anyway.\nLog: ${cfg.logFile ?? "-"}`);
          } else {
            log.push(`  release check ${f}: after run anyway — withheld ${n} runs while a restart process (pid ${holdPid}) is still running as root`);
            b.flagged = true;
            await notify(`⚠️ <b>${host} release check ${f}: after runs anyway after ${n} withheld runs</b>\nA restart process (pid ${holdPid}) is still running as root.\nLog: ${cfg.logFile ?? "-"}`);
          }
        }
        const owed = wanted && !withheld;
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
          if (p.ended && !(owed && !p.afterRan) && !withheld && !republishFailed && !p.invalidate) {
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
    await startDeferredWaiter(rt);
  }
}

/**
 * Other owners queued while a release check was unfinished, or while a restart helper still ran as root: their
 * waiter starts now, unless a restart process is still running as root (they stay queued for a later run).
 */
async function startDeferredWaiter(rt: RunCtx) {
  const { opts, dryRun, log, restartOpts, cfg, fs } = rt;
  const heldPid = [...(restartOpts.helperRunning?.values() ?? [])].find((pid) => groupAlive(pid));
  if (rt.st.waiterDeferred && !dryRun && heldPid !== undefined) log.push(`  owner restart waiter not started: a restart helper (pid ${heldPid}) is still running as root, ${rt.st.waiterDeferred} stay queued for a later run`);
  else if (rt.st.waiterDeferred && !dryRun) {
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

/** A release check's owner jobs, inline, as the waiter does them: failed, busy, or ok. */
async function ownerJobs(rt: RunCtx, jobs: QueuedOwner[]): Promise<{ kind: "ok" | "busy" | "failed"; note: string; running?: number; argv?: string[] }> {
  const { now, r, log, clock, waiterEnv, cfg, fs, exec } = rt;
  if (!jobs.length) return { kind: "ok", note: "" };
  const env: OwnerWaiterEnv = {
    exec: waiterEnv.exec, readFile: fs.readFile, writeFile: fs.writeFile, remove: fs.remove, listDir: fs.listDir, isDir: fs.isDir,
    ...(fs.appendFile ? { appendFile: fs.appendFile } : {}),
    now: clock.now, sleep: clock.sleep, httpStatus: clock.httpStatus, takeLock: async () => true, releaseLock: async () => {},
    log: (l) => log.push(`    owner: ${l}`),
  };
  const ops = ownerOps(env, { dir: ownerDir(cfg.stateDir), lsof: cfg.lsof, staleOwners: cfg.staleOwners ?? [], keepUnmatched: true });
  let kind: "ok" | "busy" | "failed" = "ok";
  let running: number | undefined;
  let runningArgv: string[] | undefined;
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
    // A restart process still running as root: no other owner restarts beside it (a glob entry runs the same argv for each label).
    if (r.running !== undefined) {
      running = r.running;
      runningArgv = r.argv;
      const rest = jobs.slice(jobs.indexOf(q) + 1);
      for (const n of rest) {
        log.push(`  release check owner: not tried: ${n.label} (the restart process of ${q.label}, pid ${r.running}, is still running)`);
        lines.push(`not tried: ${n.label}`);
      }
      break;
    }
  }
  return { kind, note: lines.join(", "), ...(running !== undefined ? { running, ...(runningArgv ? { argv: runningArgv } : {}) } : {}) };
}

/**
 * The release check's named owners (launchd labels) that are not running now: `launchctl print` of the
 * job (the probe the owner restart uses) names no pid. Asked before the upgrade, so a formula whose
 * check could never run is not upgraded at all. Without `deep`, one print per owner (as always) and no
 * owner is unloaded. With `deep` (ownerUnloaded: upgrade), see ownersUnloadedProbe.
 */
export async function ownersNotRunning(rt: RunCtx, labels: readonly string[], deep = false): Promise<{ label: string; unloaded: boolean }[]> {
  if (deep) return ownersUnloadedProbe(rt, labels);
  const { x, fs } = rt;
  const down: { label: string; unloaded: boolean }[] = [];
  for (const label of labels) {
    const r = await x(["launchctl", "print", `${await plistDomain(rt, label)}/${label}`]);
    if (r.rc === 0 && parsePrint(r.out).pid) continue;
    down.push({ label, unloaded: false });
  }
  return down;
}

/** The domain launchd would hold the label in by its plist: system for /Library/LaunchDaemons, gui/<uid> for ~/Library/LaunchAgents, else system. */
async function plistDomain(rt: RunCtx, label: string): Promise<string> {
  const { fs } = rt;
  return (await fs.exists(`/Library/LaunchDaemons/${label}.plist`)) ? "system" : (await fs.exists(`${fs.home}/Library/LaunchAgents/${label}.plist`)) ? `gui/${fs.uid}` : "system";
}

type PrintAnswer = { rc: number; out: string; err?: string; timedOut?: boolean };
/**
 * launchctl print's answer for a job that does not exist: exit 113 with "Could not find service"; for a gui or
 * user domain (`userDomain`), also a domain that does not exist (no login session on a headless host): exit 112
 * with "Could not find domain". Anything else (denied, a timeout, another answer) is not.
 */
function noJobAnswer(r: PrintAnswer, userDomain: boolean): boolean {
  const text = `${r.out}\n${r.err ?? ""}`;
  if (r.timedOut) return false;
  return (r.rc === 113 && /Could not find service/.test(text)) || (userDomain && r.rc === 112 && /Could not find domain/.test(text));
}

/**
 * ownerUnloaded: upgrade. Every owner positively no job: its plist is in /Library/LaunchDaemons or
 * ~/Library/LaunchAgents and names that Label (a mistyped label has none), and every print of it in the
 * system, gui/<uid> and user/<uid> domains says no job. The domain its plist puts it in is printed last, for
 * every owner after every other probe, so those prints are the last calls before the upgrade. Every
 * command goes straight to exec: a timeout or an error is not unloaded (a hold), never a phase stop.
 */
async function ownersUnloadedProbe(rt: RunCtx, labels: readonly string[]): Promise<{ label: string; unloaded: boolean }[]> {
  const { fs } = rt;
  const raw = (argv: string[]) => rawExec(rt, argv);
  const print = async (domain: string, label: string): Promise<PrintAnswer> => {
    try {
      return await raw(["launchctl", "print", `${domain}/${label}`]);
    } catch {
      return { rc: 1, out: "" };
    }
  };
  const state = new Map<string, { own: string[]; unloaded: boolean }>();
  for (const label of labels) {
    const home = await plistDomain(rt, label);
    let ok = false;
    try {
      const daemon = `/Library/LaunchDaemons/${label}.plist`;
      const agent = `${fs.home}/Library/LaunchAgents/${label}.plist`;
      const plist = (await fs.exists(daemon)) ? daemon : (await fs.exists(agent)) ? agent : "";
      const named = plist ? await raw(["plutil", "-extract", "Label", "raw", "-o", "-", plist]) : undefined;
      ok = !!named && !named.timedOut && named.rc === 0 && named.out.trim() === label;
    } catch {
      ok = false;
    }
    // The domains its plist cannot put it in first; the ones it can (system for a daemon; gui and user for an
    // agent, user when there is no gui session) last, for every owner after every other probe.
    const own = home === "system" ? ["system"] : [`gui/${fs.uid}`, `user/${fs.uid}`];
    const others = ["system", `gui/${fs.uid}`, `user/${fs.uid}`].filter((d) => !own.includes(d));
    for (const d of others) if (ok) ok = noJobAnswer(await print(d, label), d !== "system");
    state.set(label, { own, unloaded: ok });
  }
  const down: { label: string; unloaded: boolean }[] = [];
  for (const label of labels) {
    const s = state.get(label)!;
    let running = false;
    let unloaded = s.unloaded;
    for (const d of s.own) {
      const r = await print(d, label);
      if (!r.timedOut && r.rc === 0 && parsePrint(r.out).pid) running = true;
      unloaded = unloaded && noJobAnswer(r, d !== "system");
    }
    if (!running) down.push({ label, unloaded });
  }
  return down;
}

/** Straight to exec, not through the run's wrapper: a timeout reads as a failed command (a hold), never a phase stop or a time-box hit. */
async function rawExec(rt: RunCtx, argv: string[], o: Parameters<Exec>[1] = {}) {
  const res = await rt.exec(argv, { timeoutMs: rt.cfg.timeoutMs, ...(argv[0] === rt.cfg.brew ? { env: { HOMEBREW_NO_AUTO_UPDATE: "1" } } : {}), ...o });
  // As the run's wrapper does: a command stopped for output over its bound fails with rc 125, and the log says why.
  if (res.truncated) rt.log.push(`  ${argv.join(" ")}: ${res.err}`);
  return res;
}

/**
 * What runs from formula `f` now: the pids, or why that cannot be told. From a fresh, complete lsof (exit 0,
 * nothing on stderr, every row whole: lsofMaps' clean scan) of its kegs, which sees this user's processes
 * only, and `ps -ax` of every user's process (ps shows every user's command line) whose executable or any
 * argument names a path under a keg of it or its opt link (<prefix>/opt/<f>/), also after `=`, `:`, `,`, a
 * quote, an attached short option or `file://`; a process that only mentions such a path holds too (the safe
 * side). Only this run's own process and its ps are left out (not the lsof scan: a formula this run maps holds). A command ps cannot show (`(name)`: mid-exec, or a zombie) is read once more:
 * holders of both reads count, and a pid unreadable in the second read is "a process command is unreadable".
 */
export async function formulaPids(rt: RunCtx, f: string): Promise<{ pids: string[] } | { why: string }> {
  const { log, cfg } = rt;
  const raw: Exec = (argv, o) => rawExec(rt, argv, o);
  const unread = { why: "the processes running from it could not be read completely" };
  try {
    const cel = await raw([cfg.brew, "--cellar", f]);
    const rack = !cel.timedOut && cel.rc === 0 ? cel.out.trim() : "";
    if (!rack.startsWith("/")) return unread;
    const scan: { clean?: boolean } = {};
    // cwd too: a process whose working directory is in a keg (running a relative script) maps nothing from it.
    const maps = await lsofMaps({ exec: raw } as KegEnv, cfg.lsof, log, true, scan, "cwd,txt,mem");
    if (maps === undefined || !scan.clean) return unread;
    const esc = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // At the start, after whitespace, `=`, `:`, `,` or a quote, after an attached short option (`-r<path>`, `-I<path>`)
    // or after `file://`.
    // A keg or the opt link, the folder itself or anything under it, at the start, after whitespace, `=`, `:`, `,`, `;`,
    // `@` (an argument file), a quote, shell punctuation (`& | ( < > { [` and a backtick), an attached short option
    // (`-r<path>`, `-I<path>`) or `file://`; ended by `/`, the end, whitespace or such punctuation.
    const names = new RegExp(`(^|[\\s=:,;@'"&|(<>{\\[\`]|\\s-[A-Za-z]+|file://)(${[rack, `${dirname(dirname(rack))}/opt/${basename(rack)}`].map(esc).join("|")})(/|$|[\\s'",:;&|)<>}\\]\`])`);
    type Row = { pid: string; ppid: string; cmd: string };
    const read = async (): Promise<Row[] | undefined> => {
      const ps = await raw(["ps", "-axww", "-o", "pid=,ppid=,command="]);
      if (ps.timedOut || ps.rc !== 0 || !ps.out.trim()) return undefined;
      return ps.out.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => {
        const [pid = "", ppid = "", ...rest] = l.split(/\s+/);
        return { pid, ppid, cmd: rest.join(" ") };
      });
    };
    const unreadable = (cmd: string) => cmd === "" || /^\(.*\)$/.test(cmd);
    // This run's own process and the ps reading the list, nothing else: a child of this run that runs a keg script holds.
    const self = String(rt.kegEnv.selfPid ?? process.pid);
    const mine = (rows: Row[]) => new Set([self, ...rows.filter((r) => r.ppid === self && /^(\/bin\/)?ps -axww /.test(r.cmd)).map((r) => r.pid)]);
    const holders = (rows: Row[]) => {
      const own = mine(rows);
      return rows.filter((r) => !own.has(r.pid) && names.test(r.cmd)).map((r) => r.pid);
    };
    const first = await read();
    if (!first) return unread;
    const found = new Set(holders(first));
    // lsof rows: a mapped file or a working directory under a keg or the opt link (NAME is lsof's ninth field on).
    for (const l of maps.split("\n").slice(1)) {
      const c = l.trim().split(/\s+/);
      if (c.length >= 9 && names.test(c.slice(8).join(" "))) found.add(c[1]!);
    }
    if (first.some((r) => unreadable(r.cmd))) {
      const second = await read();
      if (!second) return unread;
      for (const p of holders(second)) found.add(p);
      const own = mine(second);
      const hidden = second.filter((r) => !own.has(r.pid) && unreadable(r.cmd)).map((r) => r.pid);
      if (hidden.length && !found.size) return { why: `a process command is unreadable (pid ${hidden.join(" ")})` };
    }
    return { pids: [...found] };
  } catch {
    return unread;
  }
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
  // Named by the config now (never by a saved record): the check's owners. Only these are kickstarted when no staleOwners
  // entry matches (see ownerOps' derive); the formula's own service label is added below only when an entry matches it.
  const named = new Set(findCheck(cfg.releaseChecks, f)?.owners ?? []);
  for (const label of [`sh.brew.${f}`, `homebrew.mxcl.${f}`]) {
    const where = (await fs.exists(`/Library/LaunchDaemons/${label}.plist`)) ? "system" : (await fs.exists(`${fs.home}/Library/LaunchAgents/${label}.plist`)) ? `gui/${fs.uid}` : "";
    if (!where) continue;
    const owner = matchOwner(cfg.staleOwners, label);
    const target = `${where}/${label}`;
    if (owner && !jobs.some((q) => q.target === target)) {
      jobs.push({ label, target, pid: "?", keg, required: true, named: true, ...(expect ? { expect } : {}), ...(owner.probe ? { probe: owner.probe } : {}), ...(owner.health ? { health: owner.health } : {}),
        ...(owner.restart ? { restart: owner.restart } : {}), ...(owner.healthWithinSec ? { healthWithinSec: owner.healthWithinSec } : {}) });
    }
    break;
  }
  // Tailscale: the daemon on this host is named by the plist it runs from (the Homebrew service, or the vendor's system daemon), and its restart is required:
  // a verify that passes against a daemon nothing restarted onto the new keg would record the host verified on a version it never ran.
  const daemons = cfg.riskyKeepPrevious.some((q) => q.split("/").at(-1) === "tailscale") && f === "tailscale" ? ["sh.brew.tailscale", "homebrew.mxcl.tailscale", "com.tailscale.tailscaled"] : [];
  for (const label of daemons) {
    const where = (await fs.exists(`/Library/LaunchDaemons/${label}.plist`)) ? "system" : (await fs.exists(`${fs.home}/Library/LaunchAgents/${label}.plist`)) ? `gui/${fs.uid}` : "";
    if (!where || jobs.some((q) => q.label === label)) continue;
    const owner = matchOwner(cfg.staleOwners, label);
    jobs.push({ label, target: `${where}/${label}`, pid: "?", keg, required: true, named: true, ...(expect ? { expect } : {}), ...(owner?.probe ? { probe: owner.probe } : {}), ...(owner?.health ? { health: owner.health } : {}),
      ...(owner?.restart ? { restart: owner.restart } : {}), ...(owner?.healthWithinSec ? { healthWithinSec: owner.healthWithinSec } : {}) });
    named.add(label);
  }
  // The check's named owners: always required, matched literally, with the staleOwners entry's probe/health/restart when one matches.
  for (const label of findCheck(cfg.releaseChecks, f)?.owners ?? []) {
    const where = (await fs.exists(`/Library/LaunchDaemons/${label}.plist`)) ? "system" : (await fs.exists(`${fs.home}/Library/LaunchAgents/${label}.plist`)) ? `gui/${fs.uid}` : "system";
    const target = `${where}/${label}`;
    const had = jobs.findIndex((q) => q.label === label);
    if (had >= 0) {
      jobs[had] = { ...jobs[had]!, required: true, named: true };
      continue;
    }
    const owner = matchOwner(cfg.staleOwners, label);
    jobs.push({ label, target, pid: "?", keg, required: true, named: true, ...(expect ? { expect } : {}), ...(owner?.probe ? { probe: owner.probe } : {}), ...(owner?.health ? { health: owner.health } : {}),
      ...(owner?.restart ? { restart: owner.restart } : {}), ...(owner?.healthWithinSec ? { healthWithinSec: owner.healthWithinSec } : {}) });
  }
  return jobs.map(({ named: _, ...q }) => (named.has(q.label) ? { ...q, named: true } : q));
}
