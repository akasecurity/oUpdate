// Pending port of secure-update's tests: Gatekeeper approve/revert (migration step 3, design note §9).
// Generated from the test inventory; each todo is one source case and its comment is the spec to port.
// Host names are renamed (hosta, hostn, ...). Cases marked [live-only] or [src-grep] are not meant to run as unit tests.
import { describe, test } from "bun:test";

describe("port: Gatekeeper approve/revert", () => {
  // Ported to test/apply/gatekeeper.test.ts (macOS only, on real xattr / file / find; the Team ID and
  // notarization gates are faked except in the real-gates case): the five check cases, the nine
  // release / approve / revert / dry-run cases, the real-spctl rejection, and spctl by absolute path.
  // The bare-spctl src-grep is not ported: oupdate calls spctl only through realGates, by path.
  // Slice 7: the cask phase order (snapshot before the upgrade, release then check after it) is in
  // test/apply/run.test.ts; the CLI's --gatekeeper-approve and --gatekeeper-revert in
  // test/apply/apply-cli.test.ts.
});
