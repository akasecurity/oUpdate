// Pending port of secure-update's tests: Chunked / grounded review (migration step 3, design note §9).
// Generated from the test inventory; each todo is one source case and its comment is the spec to port.
// Host names are renamed (hosta, hostn, ...). Cases marked [live-only] or [src-grep] are not meant to run as unit tests.
import { describe, test } from "bun:test";

describe("port: Chunked / grounded review", () => {

  // 2a. chunked-review.test.ts (31): ported to test/apply/chunked.test.ts (chunkedReview, splitDiff),
  // with grounding in test/apply/ground.test.ts and the notify case from 1a.
  // Not ported, because the TS port has no such moving part: the grounding tool as a separate
  // process (a throwing ground() is covered in verdict.test.ts), the src-grep that both reviews
  // call the shared helper (slice 2 wires formula and HEAD review through chunkedReview), the
  // temp-dir cleanup and unreadable-chunk cases (chunks are kept in memory), and the splitter
  // run as a bare awk program (splitDiff refuses the same caps itself).

  // 2b. formula-review.test.ts (54): the formula half (su_formula_review) is ported to
  // test/apply/formula.test.ts and test/apply/formula-gates.test.ts, with the package renamed to
  // example/tool/tool. Left for slice 2c, with type_b_brew_review (the source review through the
  // GitHub compare, the review kind, and prebuilt→source):
  test.todo("source-built tap: formula + source both reviewed, both APPROVE → rc 0 [formula-review]");
  test.todo("source-built tap: a formula FLAG blocks before the source review [formula-review]");
  test.todo("source-built tap: a source FLAG blocks even when the formula APPROVEs [formula-review]");
  test.todo("C1 prebuilt→source holds: no installed source to tie the diff baseline to [formula-review]");

  // 2c. head-review.test.ts (23): diff completeness and rebuild
  // Shared fixture (head-review.test.ts:23-71, 40 lines of mocks, describe): REVIEWED=`abc1234def567890000000000000000000000000`, MOVED=`fff9999000000000000000000000000000000000`; `git()` shadow answering `ls-remote` (LSR / LSR_EXTRA / LSR_NONE); `brew()` mock for svc (`outdated`, `info --json=v2 example/svc/svc` with `urls.head.url https://github.com/example/svc.git`, `branch main`, linked_keg `HEAD-<POST:0:7>`, `link`/`unlink`, `upgrade*` -> `ATTEMPT $* cleanup=${HOMEBREW_NO_INSTALL_CLEANUP:-unset}`); `pin` = `SU_REVIEWED_HEAD_PKG=svc SU_REVIEWED_HEAD_SHA=$REVIEWED SU_REVIEWED_HEAD_URL=https://github.com/example/svc.git SU_REVIEWED_HEAD_BRANCH=main`. Compare helper: `cmp(files, extra)` = `{"total_commits":1,"merge_base_commit":{"sha":OLDSHA},"files":[...]}` with OLDSHA=`0dd0000`+33x`1`; `f(name)` a file with patch `@@ -1 +1 @@\n-a\n+b` and `raw_url https://github.com/example/svc/raw/<REVIEWED>/<name>`; `nop(name)` same without patch; `rawCurl` mock serves `raw.githubusercontent.com/example/svc/<sha>/<path>` from `$HOME/raw/<sha>/<path>`; `check(json, setup, args)` runs `su_compare_complete $HOME/c.json example/svc <args>` and prints OK/GAP and `$SU_COMPARE_REBUILT`.
  // cmp([f("a.py")]) -> OK, no raw.githubusercontent.
  test.todo("C complete diff → ok, nothing fetched [head-review]");
  // 300 files -> message "300 files — the compare API caps the list", GAP.
  test.todo("C 300 files is a gap no rebuild can close [head-review]");
  // nop pkg/big.py +2/-1; raw old "keep\nold line\n", raw new "keep\nnew line\nevil()\n" -> OK; output has `=== pkg/big.py (status: modified, patch rebuilt from the raw files`, `-old line`, `+evil()`, both raw URLs.
  test.todo("C oversized modified file: rebuilt at the compare's SHAs, counts match → reviewed [head-review]");
  // added tests/t.py with zero stats, raw "import os\nos.system(x)\n" -> OK, `+os.system(x)`.
  test.todo("C GitHub-zeroed stats (changes 0) on a real text file are rebuilt too — they are not binaries [head-review]");
  // sec.py removed, old raw "check()\nverify()\n" -> OK, `-verify()`.
  test.todo("C a removed oversized file is shown as deletions [head-review]");
  // new.py renamed from old.py, both raw "same\n" -> OK, "content unchanged".
  test.todo("C rename with identical content → ok, noted [head-review]");
  // logo.png raw `PNG\000\001\002`, run.sh raw `#!/bin/sh\n\000\necho EXECUTED\n` -> `logo.png: binary (6 bytes, sha256 <64hex>) — not reviewable` + GAP; run.sh likewise.
  test.todo("C a binary holds (a NUL-bearing script would otherwise pass as 'binary' unreviewed) [head-review]");
  // `mktemp() { return 1; }` -> "could not create a temp dir", GAP.
  test.todo("C mktemp failure is a gap, never /new and /old [head-review]");
  // GitHub +5/-0, raw old "a", new "a\nb" -> `big.py: rebuilt +1/-0 but GitHub reports +5/-0`, GAP.
  test.todo("C rebuilt counts that disagree with GitHub's → gap [head-review]");
  // big.py additions 9000, no raw file -> GAP.
  test.todo("C a raw file that cannot be fetched stays a gap [head-review]");
  // response without merge_base_commit, raw_url `.../raw/main/a.py` -> "no commit SHAs", GAP.
  test.todo("C no pinned SHAs in the response → gap (never fetch by a mutable ref) [head-review]");
  // merge_base 9x40 vs expected `0dd0000` -> "merge base 9999999 is not the installed 0dd0000", GAP.
  test.todo("C HEAD review: compare base or head not the expected commits (force-push) → gap [head-review]");
  // cmp([f("a.py"), nop("big.py",9000 changes)]), `su_git_source_diff` stubbed to fail -> "RC=1 PIN=[]", NO-MODEL, names big.py.
  test.todo("C type_b_head_review holds an unrebuildable diff without asking the model [head-review]");
  // added big.py raw "HIDDEN_PAYLOAD\n" -> RC=0, prompt contains HIDDEN_PAYLOAD (grep -c >= 1).
  test.todo("C type_b_head_review sends the rebuilt patch to the model [head-review]");
  // real local upstream repo built by `upstream(change)` (head-review:478-485, 8 lines: init, config uploadpack.allowFilter/allowAnySHA1InWant, `pkg/a.py` "keep\nold", `pkg/b.py` "gone", commit one; apply change; commit two; write `$HOME/old`, `$HOME/new`). Change: a.py -> "keep\nnew\nevil()\n", `git rm pkg/b.py`, png header bytes. `su_git_source_diff file://$HOME/up <old7> <new>` -> OK, `COMMITS=1 FILES=3`, `=== pkg/a.py (status: git diff) ===`, `+evil()`, `=== pkg/b.py (status: git diff) ===`, `=== pkg/logo.png (status: binary png image, magic bytes verified — 16 bytes, sha256 <64hex>) ===`. [pure; real git, local file://].
  test.todo("G git diff: every file in a chunker block, a real png named by hash → ok [head-review]");
  // `run.sh` with NUL, `logo.png` = `MZ\000\001payload` -> `binary (<n> bytes, sha256 ...)` + GAP.
  test.todo("G git diff: a non-image binary, or a .png whose bytes are not a png, holds [head-review]");
  // installed = a new side commit -> "is not in .* history", GAP.
  test.todo("G git diff: installed commit off the reviewed history (force-push) → gap [head-review]");
  // installed `1234567` -> "not in ... history"; `file://$HOME/nowhere` -> "could not fetch".
  test.todo("G git diff: unknown installed commit or unfetchable reviewed commit → gap [head-review]");
  // compare JSON with patchless file, brew URL rewritten to file://$HOME/up; expect "diffing", `RC=0 PIN=[<40hex>]`, HIDDEN_PAYLOAD reached the model.
  test.todo("G type_b_head_review falls back to the git diff and sends it to the model [head-review]");
  // `$LOG_DIR/svc-approved-head` = mid sha -> "reviewing from the operator-approved", prompt has LATE_CHANGE not EARLY_CHANGE, PIN == NEW tip.
  test.todo("A approved commit between installed and tip: only the later commits are reviewed [head-review]");
  // log "is the operator-approved commit", NO-MODEL, RC=0, PIN = tip.
  test.todo("A approved commit IS the tip: approved without asking the model [head-review]");
  // three variants (`e`x40, the installed sha, `main`) -> no "operator-approved", both EARLY_CHANGE and LATE_CHANGE reviewed.
  test.todo("A approved commit off the history, the installed one, or not a sha → ignored, full review [head-review]");
  // bodies of type_b_head_review and type_b_brew_review in lib both contain `su_compare_complete`. [src-grep].
  test.todo("C both reviews run the gap check [head-review]");
  // Fleet values: `example/svc`, `svc-approved-head` (file name), `svc/a.py`, comment "Measured on example/svc f0d8428...18d05ee".
  // Count check: 12 + 2 + 5 + 3 + 1 = 23.
});
