// Pending port of secure-update's tests: Other (migration step 3, design note §9).
// Generated from the test inventory; each todo is one source case and its comment is the spec to port.
// Host names are renamed (hosta, hostn, ...). Cases marked [live-only] or [src-grep] are not meant to run as unit tests.
import { describe, test } from "bun:test";

describe("port: Other", () => {

  // 12a. Type A deterministic policy (8): ported to test/apply/typea.test.ts (slice 7).

  // 12b. Brew-phase isolation and orchestration (5): secure-update.test.ts
  // brewMocks (`bad-a`,`good-a`,`bad-b`,`good-b`, cask `app`; `bad*` upgrade returns 9) -> `ATTEMPT upgrade good-a`, `ATTEMPT upgrade example/svc/good-b`, "casks upgraded: app", "FAILED", "upgraded: good-a good-b", "CLEANUP", rc 1. [pure]
  // Ported to test/apply/run.test.ts ("individual failures keep the successes...", slice 7).
  // host only; HEAD svc upgrade fails (9) while a versioned `good-b` in the same tap still upgrades -> `ATTEMPT upgrade --fetch-HEAD example/svc/svc`, `ATTEMPT upgrade example/svc/good-b`, "upgraded: good-a good-b", "casks upgraded: app", rc 1; `su_head_unchanged_since_review`/`su_head_install_matches_review` stubbed. [pure]
  test.todo("host HEAD upgrade failure retains bookkeeping and continues [secure-update]");
  // orchestration (from `if [ "$PHASE" = "all" ]; then` after `# ── Run`), a child script that fails only for phase `brew`; stdout "=== fixture summary ===", "finished npm", "finished mas", "FAILED", rc 1. [pure]
  // Ported to test/apply/run.test.ts (slice 7): oupdate runs the phases in one process, so the
  // equivalent is a brew phase that fails part-way (a timeout): npm still runs, the summary prints, rc 1.

  // 12c. claude_step (3): secure-update.test.ts (host script; fake `$HOME/.local/bin/claude` handling `--version` and `update`)
  // update writes 2.0.0 -> `claude-code: 2.0.0`, no FAILED.
  // `exit 1` -> `claude-code: FAILED (rc=1, on 1.0.0)`.
  // update and `--version` both fail -> `claude-code: FAILED (rc=1, on unknown)`, REACHED-END, rc 0.
  // Ported to test/apply/run.test.ts ("Claude Code native update in the npm phase"): the run's own
  // rc is 1 there, as for any FAILED on the npm line; the phase and the run still finish.

  // 12d. svc kernel preflight (4): secure-update.test.ts (the service's kernel-toolchain check, receipt `{"used_options":["--with-custom-kernel"]}` under a fake `--cellar svc`; `xcrun` stubbed)
  // output "svc kernel build will fail", "xcodebuild -downloadComponent MetalToolchain", rc 0.
  test.todo("kernel-toolchain check: custom-kernel host with no metal tool warns [secure-update]");
  // `NOTE=[]`.
  test.todo("...: custom-kernel host with metal is silent [secure-update]");
  // `NOTE=[]`.
  test.todo("...: host not building kernels is silent even without metal [secure-update]");
  // note matches `flag|block|cve|error|fail|abort|no status|stuck|stale|divergent`.
  test.todo("...: the warning matches the digest trouble regex [secure-update]");
  // All [pure].

  // 12e. su_sync_shared (1): secure-update.test.ts
  // real git repos in temp, origin points to a nonexistent path -> rc 0, stdout `sync: shared pull FAILED — still at <hex>: <reason>`, not "SKIPPED". [pure; real git].
  test.todo("su_sync_shared names a failed pull FAILED and carries git's reason [secure-update]");

  // 12f. svc HEAD install path: pin, quarantine, rollback (33): head-review.test.ts
  // Shared fixture: see section 2c. Hosts: host script + hosta script.
  // Pre/post-install pin
  // `su_head_unchanged_since_review svc` with `ls-remote` returning REVIEWED -> OK; MOVED -> "upstream HEAD moved since review (abc1234 → fff9999" + REFUSED; no pin -> REFUSED.
  test.todo("E pre-install: branch still at the reviewed commit → ok; moved → FLAG [head-review]");
  // `su_head_install_matches_review svc example/svc` OK; with POST=MOVED -> MISMATCH, "HEAD-fff9999 is not the reviewed commit abc1234".
  test.todo("E post-install: linked keg HEAD-<sha> must be a prefix of the reviewed commit [head-review]");
  // curl returns one patched file; `RC=0 PIN=[svc|<REVIEWED>|main]`.
  test.todo("E type_b_head_review records the reviewed commit on APPROVE [head-review]");
  // `RC=1 PIN=[]`.
  test.todo("E type_b_head_review records nothing on FLAG [head-review]");
  // dispatch with LSR=MOVED -> "upstream HEAD moved since review", no `ATTEMPT upgrade --fetch-HEAD`.
  test.todo("E host: branch moved after review → no --fetch-HEAD upgrade [head-review]");
  // POST=MOVED -> `ATTEMPT upgrade --fetch-HEAD example/svc/svc`, "is not the reviewed commit", FAILED, QUARANTINED.
  test.todo("E host: installed keg is not the reviewed commit → FAILED notify [head-review]");
  // "svc(deferred to idle waiter)", no "brew FAILED".
  test.todo("E host: reviewed commit installed → upgraded [head-review]");
  // log line `LSREMOTE ls-remote https://github.com/example/svc.git refs/heads/main`.
  test.todo("R1a ls-remote queries refs/heads/<branch> exactly [head-review]");
  // LSR_EXTRA -> REFUSED.
  test.todo("R1a an extra ref ending in /main makes the pre-install check FLAG [head-review]");
  // LSR_NONE -> REFUSED.
  test.todo("R1a no matching ref makes the pre-install check FLAG [head-review]");
  // `RC=1 PIN=[]`, "could not resolve upstream HEAD".
  test.todo("R1a type_b_head_review FLAGs an ambiguous branch (extra ref) instead of picking one [head-review]");
  // Quarantine
  // fake lsof for svc keg, `su_stale_keg_check` and `brew_cleanup_prune` REAL; with POST=MOVED -> `ATTEMPT upgrade --fetch-HEAD example/svc/svc cleanup=1`, `NOTIFY ⚠️ <b>fixture brew FAILED — svc QUARANTINED</b>`, "unreviewed HEAD fff9999 installed; running server left on the reviewed keg", quarantine file `installed=HEAD-fff9999 reviewed=abc1234def...`, `CLEANUP [cleanup xz]` (svc excluded), "svc quarantined — not restarting", NO-WAITER, `brew: ...QUARANTINED`.
  test.todo("R1b mismatch → quarantine file, HEAD upgrade kept the old keg, cleanup skips svc, no restart handoff [head-review]");
  // file `installed=HEAD-fff9999 reviewed=abc1234 date=2026-09-28`.
  test.todo("R1b while quarantined, later runs keep refusing the restart and keep cleanup off svc [head-review]");
  // `CLEANUP [cleanup]`, "restart handed to waiter".
  test.todo("R1b no quarantine → normal cleanup and normal handoff [head-review]");
  // "svc QUARANTINED — HEAD upgrades held until the operator clears it", RC not 0 or 3, NO-MODEL, NO-CURL.
  test.todo("Q type_b_head_review holds while quarantined: rc ≠ 0, no model call, no upgrade [head-review]");
  // "HEAD upgrades held".
  test.todo("Q host phase: quarantined svc → no --fetch-HEAD upgrade [head-review]");
  // hosta parity (7 + 3)
  // OUTDATED_NEEDS_FETCH_HEAD -> `ATTEMPT upgrade --fetch-HEAD example/svc/svc cleanup=1`.
  test.todo("M hosta: a HEAD install is only seen via --fetch-HEAD — hosta asks for it [head-review]");
  // .
  test.todo("M hosta: reviewed commit installed → upgraded and handed to the idle waiter [head-review]");
  // .
  test.todo("M hosta: branch moved after review → no --fetch-HEAD upgrade [head-review]");
  // .
  test.todo("M hosta: installed keg is not the reviewed commit → QUARANTINED [head-review]");
  // .
  test.todo("M hosta: quarantined svc → no review, no upgrade [head-review]");
  // LSR=`0ld0000a`x... -> "HEAD unchanged", RC=3.
  test.todo("M hosta: HEAD unchanged upstream → rc 3 (skip), not a FLAG [head-review]");
  // `type_b_head_review() { return 3; }` -> `PENDING outdated --json=v2 --greedy-auto-updates --fetch-HEAD` (stuck tracking cross-ref).
  test.todo("M hosta: the stuck-package tracker also sees HEAD installs [head-review]");
  // brew fails every `*--fetch-HEAD*` -> `ATTEMPT upgrade xz`, "outdated --fetch-HEAD FAILED", no "brew: nothing to update".
  test.todo("F <host|hosta>: --fetch-HEAD query fails → plain query still upgrades formulae, failure reported [head-review] x2");
  // `su_type_b_upgrades "otherpkg|example/svc"` with `HEAD-0ld0000` -> "HEAD install with no quarantine path", `FLAGGED=true UP=[]`.
  test.todo("F a non-svc HEAD install from a trusted tap is held, not reviewed or upgraded [head-review]");
  // "--- Type B HEAD review: svc (0ld0000 →", `ATTEMPT upgrade --fetch-HEAD ... cleanup=1`, "svc(deferred to idle waiter)".
  test.todo("M hosta: real HEAD review APPROVE → pinned --fetch-HEAD upgrade [head-review]");
  // regex on hosta script `su_relink_upgraded "$upgraded"` ... `# Restart launchd services for upgraded packages`. [src-grep]
  test.todo("M hosta: relinks an upgraded-but-unlinked keg before restarts [head-review]");
  // Rollback
  // kegs `HEAD-0ld0000`, `HEAD-fff9999`; brewlog `UNLINK` then `LINK`; only reviewed keg left and linked; "rolled back to HEAD-0ld0000".
  test.todo("RB mismatch → unreviewed keg deleted, reviewed keg relinked, notify says rolled back [head-review]");
  // LINK_FAILS=1.
  test.todo("RB relink fails → quarantine stands and says rollback FAILED [head-review]");
  // hosta dispatch -> "rolled back to HEAD-0ld0000".
  test.todo("RB hosta gets the same rollback [head-review]");
  // extra `HEAD-3rd0000` -> "rollback FAILED", no UNLINK.
  test.todo("RB a third keg on disk → rollback refuses, nothing deleted or unlinked [head-review]");
  // "rollback FAILED", `HEAD-fff9999` still present.
  test.todo("RB unlink fails → stop before deleting anything [head-review]");
  // Count: pin 7 + R1a 4 + R1b 3 + Q 2 + hosta 7 + F 2 + F 1 + real 1 + relink 1 + RB 5 = 33. (the `E` quarantine host cases are included in "pin 7".)
});
