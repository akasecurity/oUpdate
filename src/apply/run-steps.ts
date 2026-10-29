// The tail of the host apply run (run.ts drives it): the stale-keg check, the npm phase, the Claude Code native
// update, the post-upgrade checks and the closing summary and notice.

import { basename, dirname, join } from "node:path";
import { isStopping as execStopping } from "./exec.ts";
import { staleKegCheck } from "./kegs.ts";
import { npmSection, type NpmRun } from "./npm.ts";
import { ownerDir, queueOwners } from "./owner-waiter.ts";
import { savePending } from "./release-checks.ts";
import { handoff } from "./waiter.ts";
import { assembleBrew } from "./run-brew.ts";
import { PhaseTimeout, uniq, type ApplyResult, type RunCtx } from "./run-ctx.ts";

export async function staleKegStep(rt: RunCtx): Promise<void> {
  const { opts, dryRun, host, log, b, notify, cfg, fs, rcEnv, rcPending, rcJobs, mergeOwners, kegEnv, recoverTo, releaseRacks, ownerHanded, waiterEnv, track, st } = rt;
  if (b.noBrew) return;
  // This run's upgrades whose installed version was not read right after them.
  if (!dryRun) for (const p of rcPending.values()) await recoverTo(p, "the upgrade installed");
  const racks = releaseRacks();
  const retired = (keg: string) => racks.has(dirname(keg)) && racks.get(dirname(keg)) !== keg;
  const s = await staleKegCheck(kegEnv, {
    brew: cfg.brew, lsof: cfg.lsof, dryRun, host, logFile: cfg.logFile, notify,
    deferred: cfg.deferred.map((d) => d.name),
    // Handed to the service that matched, never to another one.
    // Recorded as made: kept if the re-scan after it stops the step.
    handoff: async (keg, name) => {
      const d = cfg.deferred.find((s) => s.name === name);
      const n = d ? await handoff(waiterEnv, d, keg, dryRun) : `${name} stale — no deferred service of that name, not handed off`;
      if (n) b.handoffNotes.push(n);
      return n;
    },
    restartHelper: cfg.restartHelper,
    labelRestart: cfg.labelRestart,
    staleKegUnlisted: cfg.staleKegUnlisted,
    jobRunners: cfg.jobRunners ?? opts.jobRunners ?? [],
    ownerHanded,
    detachedLog: join(cfg.stateDir, "restart.log"),
    staleOwners: cfg.staleOwners,
    ownerFailed: st.owners.failed,
    ownerBusy: st.owners.busy,
    // A release check's owner restarts inline (its check runs after it), never through the waiter.
    queueOwners: async (items) => {
      const mine = items.filter((q) => retired(q.keg));
      for (const q of mine) {
        const f = basename(dirname(q.keg));
        rcJobs.set(f, [...(rcJobs.get(f) ?? []), q]);
        // On the record as found: a run that resumes it restarts the job though its scan no longer finds it.
        const p = rcPending.get(f);
        if (p && !dryRun) {
          p.owners = mergeOwners(p.owners ?? [], [q]);
          await savePending(rcEnv, p);
        }
      }
      // A target a release check restarts inline is never also the waiter's, whatever other kegs it maps.
      const inline = new Set(mine.map((q) => q.target));
      const rest = items.filter((q) => !retired(q.keg) && !inline.has(q.target));
      // A waiter started now would hold its lock through the release checks' inline restarts.
      const later = rest.length && [...rcPending.values()].some((p) => !p.ended);
      let n = await queueOwners(fs, ownerDir(cfg.stateDir), rest, later ? undefined : opts.ownerWaiterArgv, join(cfg.stateDir, "restart.log"));
      if (later && !n.includes("could not queue")) {
        st.waiterDeferred = rest.map((q) => q.label).join(" ");
        n = `owner restart waiter starts after the release checks for ${st.waiterDeferred}`;
      }
      return [n, mine.length ? `owner restart for the release check: ${mine.map((q) => q.label).join(" ")}` : ""].filter(Boolean).join(", ");
    },
    releaseRacks: racks,
    trackStuck: (still) => track("stale-keg", still) ?? [],
    log,
  });
  b.staleNote = s.note;
  st.rcScanned = s.scanned !== false;
  if (st.rcScanned) st.rcScannedRacks = racks;
  st.rcUnresolved = s.unresolved;
}

/** The npm phase; its status text, "" when the step stopped before it could say. */
export async function npmStep(rt: RunCtx, npmRun: NpmRun): Promise<string> {
  const { cfg, host, dryRun, notify, step, x, r, track } = rt;
  let npmStatus = "";
  if (cfg.npm === null) return "not managed here (apply.npm is null)";
  else {
    const npm = cfg.npm;
    await step("npm", "npm", async () => {
      const n = await npmSection(x, r, {
        npm, host, registry: cfg.npmRegistry, dryRun, logFile: cfg.logFile, notify,
        trackStuck: (pending) => track("npm", pending),
        into: npmRun,
      });
      npmStatus = n.status;
    });
  }
  return npmStatus;
}

/**
 * The native build updates itself in place; with its background updater off, this
 * explicit call is the only update path. Not executable: skipped with no word, as the bash did.
 * Returns the claude-code part of the npm line.
 */
export async function claudeCodeStep(rt: RunCtx): Promise<string | undefined> {
  const { opts, dryRun, log, x, step, cfg, fs } = rt;
  let ccPart: string | undefined = "claude-code: not configured";
  if (cfg.claudeCode) {
    const ccBin = cfg.claudeCode;
    ccPart = (await fs.isExecutable(ccBin)) ? "claude-code: not completed" : undefined;
    if (ccPart) {
      const stopping = () => !!opts.isStopping?.() || execStopping();
      log.push("", "--- claude code (native) ---");
      if (dryRun) {
        log.push("  DRY RUN - would run: claude update");
        ccPart = "claude-code: dry-run";
      } else if (stopping()) {
        log.push("  not run: oupdate is stopping");
        ccPart = "claude-code: not run (oupdate is stopping)";
      } else {
        await step("npm", "claude code", async () => {
          let rc: number | "timeout";
          try {
            const u = await x([ccBin, "update"]);
            rc = u.rc;
            for (const l of `${u.out}${u.err}`.split("\n")) if (l !== "") log.push(`  ${l}`);
          } catch (e) {
            if (!(e instanceof PhaseTimeout)) throw e;
            rc = "timeout";
          }
          // Read after the attempt: on success what now runs, on failure what it is stuck on.
          let ver = "unknown";
          if (!stopping()) {
            try {
              const v = await x([ccBin, "--version"]);
              // A failed --version is "unknown" even when it printed something (the bash took its first field).
              if (v.rc === 0) ver = v.out.trim().split(/\s+/)[0] || "unknown";
            } catch (e) {
              if (!(e instanceof PhaseTimeout)) throw e;
            }
          }
          ccPart = rc === 0 ? `claude-code: ${ver}` : `claude-code: FAILED (${rc === "timeout" ? "timeout" : `rc=${rc}`}, on ${ver})`;
        });
      }
    }
  }
  return ccPart;
}

/**
 * Each package upgraded this run that has a configured argv is run once; a failure is logged,
 * notified and counted (check:<name> in the brew line's FAILED list, so rc 1), never an abort.
 */
export async function postUpgradeChecks(rt: RunCtx, npmRun: NpmRun): Promise<void> {
  const { opts, dryRun, host, log, b, x, notify, step, cfg } = rt;
  if (cfg.postUpgradeCheck && !dryRun) {
    const checks = Object.entries(cfg.postUpgradeCheck);
    const ups = [...b.upgraded, ...npmRun.upgraded];
    const todo = checks.filter(([name]) => ups.some((u) => u === name || u.split("/").at(-1) === name));
    if (todo.length) {
      log.push("", "--- post-upgrade checks ---");
      await step("brew", "post-upgrade checks", async () => {
        for (const [name, argv] of todo) {
          if (opts.isStopping?.() || execStopping()) {
            log.push("  not run: oupdate is stopping");
            return;
          }
          let why = "";
          try {
            const c = await x(argv);
            if (c.rc !== 0) why = `rc=${c.rc}`;
          } catch (e) {
            if (!(e instanceof PhaseTimeout)) throw e;
            why = "timeout";
          }
          if (!why) log.push(`post-upgrade check: ${name} ok`);
          else {
            b.failed.push(`check:${name}`);
            log.push(`post-upgrade check: ${name} FAILED (${why}): ${argv.join(" ")}`);
            await notify(`⚠️ <b>${host} post-upgrade check FAILED: ${name}</b>\n${argv.join(" ")} (${why})\nLog: ${cfg.logFile ?? "-"}`);
          }
        }
      });
    }
  }
}

/** The summary block, the done notice and the result. */
export async function finishRun(rt: RunCtx, a: { npmRun: NpmRun; npmStatus: string; ccPart: string | undefined; prevName: string }): Promise<ApplyResult> {
  const { opts, dryRun, host, log, b, notify, npmFailed } = rt;
  const { npmRun, npmStatus, ccPart, prevName } = a;
  const sink = opts.onLine;
  const brewStatus = assembleBrew(rt);
  // A failure is "FAILED — <name>", the form the shadow parser reads; a step that never finished
  // says so instead of "nothing to update".
  // Stopped part-way: what was already updated, then "not completed" (never "nothing to update").
  const left = npmRun.pending.filter((p) => !npmRun.upgraded.includes(p));
  const npmPartial = [
    ...(npmRun.upgraded.length ? [`upgraded: ${npmRun.upgraded.join(" ")}`] : []),
    left.length ? `not completed — still pending: ${left.join(" ")}` : "not completed",
  ];
  const npmParts = [...uniq(npmFailed).map((t) => `FAILED — ${t}`), ...(npmStatus ? [npmStatus] : npmFailed.length ? npmPartial : ["nothing to update"])];
  const npmLine = [...npmParts, ...(ccPart ? [ccPart] : [])].join("; ");
  const mas = "not checked — the App Store phase is not in oupdate";
  const rc: 0 | 1 = b.failed.length || /FAILED|ERROR/.test(npmLine) ? 1 : 0;
  const summary = [
    "",
    dryRun ? `=== ${host} dry-run summary (nothing applied) ===` : `=== ${host} summary ===`,
    `  brew: ${brewStatus}`,
    `  npm:  ${npmLine}`,
    `  mas:  ${mas}`,
  ];
  for (const l of summary) sink?.(l);
  // A run being stopped by a signal sends no done notice: its ABORTED line is the last word.
  if (!dryRun && !opts.isStopping?.()) await notify(`📋 <b>${host} ${prevName} done (oupdate)</b>\nbrew: ${brewStatus}\nnpm:  ${npmLine}\nmas:  ${mas}`);
  return { log, summary, rc };
}
