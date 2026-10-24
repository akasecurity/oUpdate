// Pending port of secure-update's tests: Stuck tracking (pending-state) (migration step 3, design note §9).
// Generated from the test inventory; each todo is one source case and its comment is the spec to port.
// Host names are renamed (hosta, hostn, ...). Cases marked [live-only] or [src-grep] are not meant to run as unit tests.
import { describe, test } from "bun:test";

describe("port: Stuck tracking (pending-state)", () => {
  // Ported to test/apply/stuck.test.ts: literal target identities and a fresh count on a new target,
  // the pending JSON (targets recorded, completed items cleared, other lanes kept), and a malformed
  // answer as a failed query (pendingFromOutdated returns undefined; the caller keeps the state).
  // Slice 7, the apply run, which owns the state file, the brew call and the summary: ported to
  // test/apply/run.test.ts ("stuck tracking in the run"): a failed pending query keeps the state file
  // and marks the phase failed; successfully upgraded casks are not stuck.
  // The HEAD-install case ("the stuck tracker also sees HEAD installs") is counted in section 12.
});
