// Pending port of secure-update's tests: Tap approval (migration step 3, design note §9).
// Generated from the test inventory; each todo is one source case and its comment is the spec to port.
// Host names are renamed (hosta, hostn, ...). Cases marked [live-only] or [src-grep] are not meant to run as unit tests.
import { describe, test } from "bun:test";

describe("port: Tap approval", () => {
  // Shared fixture (tap-approval.test.ts:12-24): `run(body, tsv)` writes `approved-taps.tsv` to a temp dir and sets `SU_APPROVED_TAPS_FILE`; `load(host)` = `HOST=<host>; TYPE_B_TAPS="example/svc"; su_load_approved_taps; echo "TAPS=[$TYPE_B_TAPS]"`. TSV format: 4 TAB columns `tap host approved-date note`; host `*` or a short hostname matched case-insensitively with a leading site prefix ignored; `#` and blank lines skipped; malformed rows warn `approved-taps: ignoring malformed row` and are skipped; CRLF tolerated; tap lower-cased. Brew-phase mocks `brewMocks` (tap-approval.test.ts:112-159, 47 lines, described not copied): HOST=hosta, `outdated --verbose` prints `good-a (1.0) < 1.1`, `example/workmux/wm (0.1.0) < 0.2.0 [pinned at 0.1.0]`, `example/tf/tfapp (1.5) < 1.6`; real tap checkout at `$HOME/tap` with `Formula/wm.rb`; mocked `type_b_brew_review` records `SU_REVIEWED_*` pin and echoes `TBREVIEW <pkg> <tap> suppress=<SU_NOTIFY_SUPPRESS>`; `TB_RC`, `TB_KIND`, `TB_AFTER`, `TB_STALE`, `TB_DEPS`, `TB_OUTDATED_ERR` knobs.
  // Constant TSV used: `example/workmux<TAB>*<TAB>2026-09-28<TAB>ok` etc.
  // Loader, su_tap_in and su_outdated_versions (26): ported to test/apply/taps.test.ts. The host
  // prefix secure-update stripped by name is now a config list (hostPrefixes). Not ported: the
  // checks on the shipped approved-taps.tsv (fleet data, it stays in the operator's config) and
  // the src-grep that the lib calls the loader at load time (oupdate loads it explicitly).

  // Advisory review, approved path, install-time pin (I2, Mc), off-tap dependency gate (C, R3, Rm),
  // versions unreadable, and the advisory-then-real-FLAG case: ported to test/apply/typeb.test.ts.
  // The no-grep tap-matching src-grep (D) is not ported: oupdate never matches taps with a pattern
  // (tapIn is literal; see test/apply/taps.test.ts).
  // Slice 7, the whole brew phase, ported to test/apply/run.test.ts ("tap approval in the brew
  // phase"): unapproved tap → awaiting-approval note, Type A still upgraded (three verdicts; the
  // two host-class copies are one run in oupdate); approved tap → Type B path, no note for it; the
  // dry run logs Type B FLAGs and holds and never notifies; D: example/work.ux is not
  // example/workmux.
});
