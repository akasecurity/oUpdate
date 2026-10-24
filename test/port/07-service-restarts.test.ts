// Pending port of secure-update's tests: Service restarts (migration step 3, design note §9).
// Generated from the test inventory; each todo is one source case and its comment is the spec to port.
// Host names are renamed (hosta, hostn, ...). Cases marked [live-only] or [src-grep] are not meant to run as unit tests.
import { describe, test } from "bun:test";

describe("port: Service restarts", () => {
  // Ported in slice 4 (test/apply/kegs.test.ts, "deferred services"): a non-deferred stale package
  // never reaches the handoff; a deferred service stale on a dependency keg is handed off and another
  // holder of that keg is still handled; one service stale on two kegs is handed off exactly once.
  // Ported in slice 6 (test/apply/waiter.test.ts): handed to the waiter and never kickstarted, sudo'd
  // or alarmed; a live waiter not duplicated; dry-run never starts one; the waiter report (recover,
  // outcome shown and cleared); hold: not handed off, and reported every run in words the digest
  // does not count as trouble. The service, its waiter and its files come from config (the bash
  // named svc and lib/svc-safe-restart.sh). Slice 7, the brew phase order and the restart list:
  // ported to test/apply/run.test.ts ("service restarts and the phase order"): a deferred service is
  // never restarted by the brew phase, it is deferred to the idle waiter (on hold: reported); M8:
  // leftover drains are recovered before the brew build, the stale-keg check after it.
});
