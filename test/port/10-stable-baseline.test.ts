// Pending port of secure-update's tests: Stable baseline (migration step 3, design note §9).
// Generated from the test inventory; each todo is one source case and its comment is the spec to port.
// Host names are renamed (hosta, hostn, ...). Cases marked [live-only] or [src-grep] are not meant to run as unit tests.
import { describe, test } from "bun:test";

describe("port: Stable baseline", () => {
  // Harness (stable-baseline.test.ts:17-50): real git repo with two commits `v1` (`a.py` "print(1)") and `v2` (`print(2)`), `git archive --format=tar.gz` for OLD/NEW commits plus an OTHER tarball with `plain.txt` (no commit id); `brew ruby` stub prints the installed formula's `url` and `sha256` (the "pins"); `curl` stub serves OLD_TGZ for `*v0.7.0*`, else NEW_TGZ, and logs to `curl.log`; command: `su_pin_stable_commits <formula.rb> example/svc <oldver> <newurl> <newsha> 0.7.1` prints `RC=<rc> OLD=<SU_OLD_COMMIT> NEW=<SU_NEW_COMMIT>`. URLs: `https://github.com/example/svc/archive/refs/tags/v0.7.0.tar.gz`, `.../v0.7.1.tar.gz`.
  // RC=0, OLD/NEW = the two commits.
  test.todo("both archives match their pins → commits come from the archive bytes []");
  // oldVer `0.7.0_1` -> ok.
  test.todo("a revision suffix on the installed version still matches the tag archive []");
  // serve NEW for old -> "does not match its pinned sha256".
  test.todo("old tag moved: its archive no longer hashes to the installed pin → fail []");
  // serve OLD for new -> `target \(0\.7\.1\).*does not match`.
  test.todo("new tag moved after the formula pinned it → fail (brew would refuse it anyway, the review must too) []");
  // serve OTHER -> "carries no git-archive commit id".
  test.todo("an archive with no git-archive commit id → fail []");
  // rb file missing -> "no installed formula copy", no `curl`.
  test.todo("no installed formula copy → fail before any download []");
  // pins empty -> `baseline \(installed 0\.7\.0\)`.
  test.todo("installed formula Homebrew cannot evaluate (no pins) → fail []");
  // urls `https://github.com/example/svc/releases/download/v0.7.0/svc.tar.gz`, `https://github.com/evil/svc/archive/refs/tags/v0.7.0.tar.gz`, `https://github.com/example/svc/archive/refs/tags/v0.6.9.tar.gz` -> "is not a example/svc tag archive"; new url `.../v9.9.tar.gz` -> "target".
  test.todo("pins that are not a tag archive of the compared repo → fail []");
  // curl rc 22 -> "could not download".
  test.todo("download failure → fail []");
  // newSha `nothex` -> "no sha256 pin".
  test.todo("malformed new sha256 → fail []");
  // source tap with OLD_SHA `9`x64 -> RC=2, "does not match its pinned sha256", CALLS=1. [pure]
  test.todo("stable baseline: old tag archive no longer matches the installed sha256 → hold, source never reviewed [formula-review]");
  // MERGE_BASE `e`x40 -> RC=2, "is not the installed".
  test.todo("stable baseline: installed commit not an ancestor of the target (merge base differs) → hold []");
  // curl mock logs urls -> output matches `compare/[0-9a-f]{40}\.\.\.[0-9a-f]{40}`, not `compare/v?1\.0`.
  test.todo("stable baseline: the compare is requested by the pinned commits, never by tag name []");
});
