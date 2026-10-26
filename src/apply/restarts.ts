// Restart the launchd service of every package this run upgraded, ported from step 7 of
// secure-update's brew_section. Without it brew swaps the binary on disk while the running daemon
// stays on the old one until a reboot. A deferred service (config) is never restarted here: the
// stale-keg check hands it to its idle waiter. Only a service that actually restarted is listed as
// restarted; one that could not be is "FAILED to restart", never dropped.
//
// The label: Homebrew's canonical sh.brew.<formula> when its plist exists, else the legacy
// homebrew.mxcl.<formula>. A system daemon restarts through the restart helper when it allows the
// package, else `sudo -n launchctl kickstart` (fails at once rather than wait on a password). The
// config's labelRestart comes first: "skip" leaves the label to its owner, an owner command is
// started detached with the label appended, and "kickstart" takes the normal path, as for a label
// not listed. staleKegUnlisted "report" applies here too: a label with a plist not in labelRestart is reported only.
// A staleOwners label comes before all of these: it is left to the stale-keg check, which queues it for the idle waiter.

import { isStopping, type Exec } from "./exec.ts";
import { basename } from "node:path";
import type { RestartHelper } from "./config.ts";
import type { LabelRestart } from "./kegs.ts";
import type { DeferredService } from "./waiter.ts";
import { matchOwner, type StaleOwner } from "./owner-waiter.ts";

export interface RestartEnv {
  exec: Exec;
  exists(path: string): Promise<boolean>;
  spawnDetached(argv: string[], stderrFile: string): Promise<number>;
  home: string;
  uid: number;
}

export async function restartUpgraded(
  env: RestartEnv,
  upgraded: string[],
  o: {
    deferred: DeferredService[]; helper?: RestartHelper; labelRestart?: LabelRestart; staleKegUnlisted?: "kickstart" | "report"; detachedLog: string; into?: string[];
    staleOwners?: StaleOwner[];
    /** Filled with each label handed to its owner command (label → command name), for the stale-keg check. */
    ownerHanded?: Map<string, string>;
  },
): Promise<string[]> {
  // `into`: the caller's list, filled as each restart is made, so a stop part-way keeps them.
  const out: string[] = o.into ?? [];
  const daemons = "/Library/LaunchDaemons";
  const agents = `${env.home}/Library/LaunchAgents`;
  for (const pkg of upgraded) {
    // A stop starts nothing new, a delayed detached restart included.
    if (isStopping()) {
      out.push(`${pkg}(not restarted: oupdate is stopping)`);
      continue;
    }
    const d = o.deferred.find((s) => s.name === pkg.split("/").at(-1));
    if (d) {
      out.push(`${pkg}(${(await env.exists(d.holdFile)) ? "on hold, not restarted" : "deferred to idle waiter"})`);
      continue;
    }
    const canon = `sh.brew.${pkg}`;
    const label = (await env.exists(`${daemons}/${canon}.plist`)) || (await env.exists(`${agents}/${canon}.plist`)) ? canon : `homebrew.mxcl.${pkg}`;
    // A label whose restart belongs to its owner (config labelRestart): before the helper and kickstart.
    // Only for a label whose plist exists: without one there is no service, as before.
    const hasPlist = (await env.exists(`${daemons}/${label}.plist`)) || (await env.exists(`${agents}/${label}.plist`));
    // A staleOwners label is restarted only at an idle moment: the stale-keg check queues it for the waiter.
    if (hasPlist && matchOwner(o.staleOwners, label)) {
      out.push(`${pkg}(waiting for idle restart)`);
      continue;
    }
    const policy = hasPlist && Object.hasOwn(o.labelRestart ?? {}, label) ? o.labelRestart![label] : undefined;
    if (policy === "skip") {
      out.push(`${pkg}(restart left to its owner)`);
      continue;
    }
    // staleKegUnlisted "report": labelRestart is an allow list, so an unlisted label is reported only.
    if (hasPlist && policy === undefined && o.staleKegUnlisted === "report") {
      out.push(`${pkg}(reported only, not on the restart list)`);
      continue;
    }
    if (policy !== undefined && policy !== "kickstart") {
      const by = basename(policy[0] ?? "");
      try {
        // Not waited for, with the label as its last argument.
        await env.spawnDetached([...policy, label], o.detachedLog);
        out.push(`${pkg}(handed to ${by})`);
        o.ownerHanded?.set(label, by);
      } catch {
        out.push(`${pkg}(FAILED: handoff to ${by})`);
      }
      continue;
    }
    const h = o.helper;
    if (h?.detached?.includes(pkg)) {
      // A restart that would cut this run's own connection: later, detached, through the helper.
      if (!(await env.exists(`${daemons}/${label}.plist`))) {
        out.push(`${pkg}(FAILED: no launchd plist for ${label})`);
      } else if (!(await env.exists(h.path))) {
        out.push(`${pkg}(FAILED: ${h.path} missing)`);
      } else {
        try {
          // Fixed script; the helper and package are positional arguments, never spliced in.
          await env.spawnDetached(["/bin/sh", "-c", `sleep ${h.delaySec ?? 60}; exec sudo -n "$0" "$1"`, h.path, pkg], o.detachedLog);
          out.push(`${pkg}(sys,deferred)`);
        } catch {
          out.push(`${pkg}(FAILED to restart)`);
        }
      }
      continue;
    }
    if (await env.exists(`${daemons}/${label}.plist`)) {
      let ok = false;
      if (h?.packages.includes(pkg)) {
        if (await env.exists(h.path)) ok = (await env.exec(["sudo", "-n", h.path, pkg])).rc === 0;
      } else ok = (await env.exec(["sudo", "-n", "launchctl", "kickstart", "-k", `system/${label}`])).rc === 0;
      out.push(`${pkg}(${ok ? "sys" : "FAILED to restart"})`);
    } else if (await env.exists(`${agents}/${label}.plist`)) {
      const ok = (await env.exec(["launchctl", "kickstart", "-k", `gui/${env.uid}/${label}`])).rc === 0;
      out.push(`${pkg}(${ok ? "user" : "FAILED to restart"})`);
    }
  }
  return out;
}
