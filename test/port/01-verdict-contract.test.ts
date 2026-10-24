// Pending port of secure-update's tests: Verdict contract (migration step 3, design note §9).
// Generated from the test inventory; each todo is one source case and its comment is the spec to port.
// Host names are renamed (hosta, hostn, ...). Cases marked [live-only] or [src-grep] are not meant to run as unit tests.
import { describe, test } from "bun:test";

describe("port: Verdict contract", () => {
  // Shared fixture (formula-review.test.ts:14, head-review.test.ts:15): the real contract text is extracted from lib: `_VERDICT_CONTRACT='Output format — line 1 is parsed literally...'` (lib:1207-1210, 4 lines; verbatim: "Line 1: the single word APPROVE or FLAG, alone ... In an APPROVE, do not write the words flag/flagged/hold/reject/deny/block anywhere, and do not write a "Verdict:" line"). Exit-code contract of model_review/llm-review.ts: 0 APPROVE, 1 FLAG, 2 unavailable; `verdictOf()` FLAGs on any verdict word anywhere (lib/llm-review.ts).

  // 1a. chunked-review.test.ts (16): ported to test/apply/verdict.test.ts (firstVerdict, reviewChunk);
  // the notify on a FLAG or an unavailable reviewer is in test/apply/chunked.test.ts ((b), (g),
  // "notified exactly once").

  // 1b. formula-review.test.ts (1)
  // regex-extracts every `p_head|p_tail|prompt|artifact_line="..."` string from lib + host-secure-update.sh, asserts >3 prompts and none matches `\bblocks?\b` (reason: verdictOf BLOCK\w* scored clean approvals as contradictions). [src-grep].
  test.todo("formula and source review prompts never contain the word block [formula-review]");

  // 1c. secure-update-containers.test.ts (22) - hostn parser
  // Harness `fixture(host, failure, changed, response, evidence, extraEnv)`: slices the real `hosta-secure-update.sh` / `hostn-secure-update.sh` tail, mocks docker/curl/model_review/notify, replaces `/tmp/mini_pre_hist_` and `/mnt/user/backup/status/secure-update` with the temp dir, runs under `/opt/homebrew/bin/bash` for hostn (macOS bash 3.2 lacks `declare -A`). review.ts stub imports `verdictOf` from lib/llm-review.ts and exits 0 only on APPROVE.
  // host=hosta, no failure; stub returns `APPROVE\nNo suspicious layers.` only when the prompt contains "APPROVE or FLAG alone on the first line". Expect rc 0, stdout DEPLOY, summary "updated (1 pulled)". containers lane + verdict. [pure].
  test.todo("hosta actual prompt produces a safe response accepted by production first-line parser [containers]");
  // , each `fixture("hostn","",true,response)` expects rc 0, summary contains "blocked", no DEPLOY. Responses: `"Do not APPROVE: unexpected remote download"`, `"Verdict: APPROVE\nDo not APPROVE: unexpected remote download"`, `"Verdict: APPROVE\nVerdict: REJECT"`, `"Verdict: APPROVE\nDo not deploy"`, `"Verdict: APPROVE if safe"`, `"UNAVAILABLE"`, `"Looks safe"`, then qualifiers (2026-09-28): `"Verdict: APPROVE only if the layer checksum matches"`, `"APPROVE, but verify the new entrypoint first"`, `"2. Verdict: APPROVE unless the base image changed"`, `"Verdict: APPROVE pending manual review"`, `"Verdict: APPROVE provided the vendor URL is correct"`, `"Verdict: APPROVE conditionally"`. [pure][hostn].
  test.todo("hostn fails closed: <response> [containers] x13");
  // `"1. none\n2. Verdict: APPROVE"`, `"Verdict: APPROVE"`, `"APPROVE\nRoutine update."`, and real logged approvals `"Verdict: APPROVE - Only benign build-time labels updated; no suspicious commands"`, `"Verdict: APPROVE all updates. Supply chain risk: LOW."`, `"Verdict: APPROVE (all three) - No supply chain anomalies detected"`, `"Verdict: APPROVE."`, `"VERDICT: APPROVE. All updates fetch from verified official sources"`. Expect rc 0, summary "updated (1 pulled)", DEPLOY. [pure][hostn].
  test.todo("hostn explicit approval: <response> [containers] x8");

  // 1d. secure-update.test.ts (7) - hostn parser
  // via `nas_review_approved`: `numbered bare APPROVE` "1. none\n2. APPROVE" -> OK; `numbered Verdict: APPROVE` "1. none\n2. Verdict: APPROVE" -> OK; `plain APPROVE` -> OK; `numbered FLAG` "1. curl | sh added\n2. FLAG" -> HOLD; `APPROVE then FLAG` "1. none\n2. APPROVE\n3. FLAG" -> HOLD; `APPROVED is not APPROVE` "2. APPROVED" -> HOLD; `looks suspicious` "1. layer looks suspicious\n2. APPROVE" -> HOLD. Uses functions() of hostn-secure-update.sh. [pure][hostn].
  test.todo("hostn verdict parser: <label> [secure-update] x7");
});
