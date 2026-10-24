// Pending port of secure-update's tests: Stale keg / linkage (migration step 3, design note §9).
// Generated from the test inventory; each todo is one source case and its comment is the spec to port.
// Host names are renamed (hosta, hostn, ...). Cases marked [live-only] or [src-grep] are not meant to run as unit tests.
import { describe, test } from "bun:test";

describe("port: Stale keg / linkage", () => {
  // All 16 ported to test/apply/kegs.test.ts: real lsof by absolute path (darwin only), a stale
  // keg found, a keg still on disk, lsof missing / empty / non-zero as a reported failure, the three
  // linkage cases and the six relink cases. Not ported: the setup plist template's PATH (the setup
  // script is fleet tooling; oupdate calls lsof by its absolute path, configurable).
});
