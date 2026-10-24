// Pending port of secure-update's tests: TLS (migration step 3, design note §9).
// Generated from the test inventory; each todo is one source case and its comment is the spec to port.
// Host names are renamed (hosta, hostn, ...). Cases marked [live-only] or [src-grep] are not meant to run as unit tests.
import { describe, test } from "bun:test";

describe("port: TLS", () => {

  // 9a. secure-update-tls.test.ts (12) [needs-brew]
  // Harness: `setup()` makes `$dir/{bin,home,config/homebrew,cache,logs,temp}`, writes a probe `bin/brew-su-tls-probe` (a `#!/opt/homebrew/opt/python@3.14/bin/python3` script printing `{"args":[...],"env":{PIP_CERT,PIP_USE_DEPRECATED,CLOUDSDK_CONFIG,UNRELATED_SECRET,AWS_SECRET_ACCESS_KEY,PIP_TRUSTED_HOST,HOMEBREW_NO_INSTALLED_DEPENDENTS_CHECK,HOMEBREW_NO_INSTALL_CLEANUP}}` and exiting with argv[1]), env PATH `$dir/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin`, HOMEBREW_* dirs in the temp dir, synthetic `UNRELATED_SECRET`/`AWS_SECRET_ACCESS_KEY` = `synthetic-do-not-forward`, `PIP_TRUSTED_HOST=must-not-survive`. Runs `source lib/secure-update-tls.sh; su_brew_install su-tls-probe "$@"` via the INSTALLED `/opt/homebrew/bin/brew` (explicitly not mocked). CA bundle path `/opt/homebrew/etc/ca-certificates/cert.pem`.
  // CA copied to `CA ' $literal.pem`, CLOUDSDK_CONFIG `cloud ' $(not-executed) config`, args `['upgrade','two words','',"a'quote",'$(not-executed)','--flag']`, `SU_PIP_CA_BUNDLE` set -> rc 0, args echoed exactly, env `{PIP_CERT: customCA, PIP_USE_DEPRECATED:'legacy-certs', CLOUDSDK_CONFIG: config, UNRELATED_SECRET:null, AWS_SECRET_ACCESS_KEY:null, PIP_TRUSTED_HOST:null, HOMEBREW_NO_INSTALLED_DEPENDENTS_CHECK:'1', HOMEBREW_NO_INSTALL_CLEANUP:'1'}`, no `secure-update-tls.*` leftovers in temp.
  test.todo("actual launcher passes scoped TLS/config and exact arguments, filters unrelated secrets [secure-update-tls]");
  // probe exits 37 with parent `PIP_CERT=parent-cert PIP_USE_DEPRECATED=parent-mode` -> rc 37, child CLOUDSDK_CONFIG null, parent still `parent=parent-cert,parent-mode,unset`, no leftovers.
  test.todo("unset config remains unset and child failure preserves status and parent environment [secure-update-tls]");
  // (`missing`, `malformed` = `not a certificate\n`, `empty`): `SU_PIP_CA_BUNDLE` = invalid file -> rc != 0, stdout empty, stderr contains `CA bundle`.
  test.todo("<kind> CA fails before brew runs [secure-update-tls] x3");
  // probe prints `child=$HOMEBREW_NO_AUTO_UPDATE`; parent `HOMEBREW_NO_AUTO_UPDATE=''` -> stdout `child=1\nparent=\n`.
  test.todo("suppresses auto-update launcher re-exec only in the child [secure-update-tls]");
  // `set -euo pipefail` -> rc 0, CLOUDSDK_CONFIG == ''.
  test.todo("explicit empty CLOUDSDK_CONFIG survives under strict shell options [secure-update-tls]");
  // git observer via `HOMEBREW_GIT_PATH` + `HOMEBREW_DEVELOPER=1`, `su_brew_install --version`; records `PATH` = `/usr/bin:/bin:/usr/sbin:/sbin` and `HOMEBREW_PATH` = original; a colliding `bin/uname` is never executed.
  test.todo("internal backend restores sanitized PATH and retains original HOMEBREW_PATH [secure-update-tls]");
  // `bin/brew-secure-update-tls-run.rb` printing `ruby-bridge-hijacked` -> not run; args `['0']` echoed.
  test.todo("fixed-name external Ruby collision cannot hijack the private bridge [secure-update-tls]");
  // env var `'1'`.
  test.todo("actual launcher: installs never trigger the installed-dependents upgrade (HOMEBREW_NO_INSTALLED_DEPENDENTS_CHECK=1 reaches brew) [secure-update-tls]");
  // empty var dropped by bin/brew; `HOMEBREW_NO_INSTALL_CLEANUP=1 su_brew_install ...` reaches child as `'1'`.
  test.todo("actual launcher: a caller prefix HOMEBREW_NO_INSTALL_CLEANUP=1 reaches brew (svc HEAD upgrade keeps the old keg) [secure-update-tls]");
  // with `LOG_DIR=$dir/logs-su`, no file -> not '1'; write `svc-quarantine` = `installed=HEAD-fff reviewed=abc\n` -> `'1'`.
  test.todo("actual launcher: while svc is quarantined, EVERY install runs with HOMEBREW_NO_INSTALL_CLEANUP=1 [secure-update-tls]");

  // 9b. secure-update-tls-live.ts (7 scenarios) [live-only]
  // Opt-in script (`bun tests/secure-update-tls-live.ts`), uses `node:assert`, evidence under `/tmp/tls-helper-live-*`. Generates the installed Homebrew sandbox profile (via a `brew-su-tls-profile.rb` external command), removes `(global-name "com.apple.trustd.agent")` from it to reproduce unreachable trustd over SSH, runs a probe through `sandbox-exec` + `python -m pip download --no-deps --only-binary=:all: ... packaging==25.0`. Scenarios (each = one `pip download` against a URL): `default` (https://pypi.org/simple, via plain brew; must fail, `OSStatus -26276`), `ca-only` (PIP_CERT set but no legacy mode; must fail), `fixed` (via su_brew_install; must succeed, wheel downloaded, child PIP_CERT == CA, PIP_USE_DEPRECATED `legacy-certs`, CLOUDSDK_CONFIG passed), `self-signed` (https://self-signed.badssl.com/; `CERTIFICATE_VERIFY_FAILED.*self.signed`), `wrong-host` (https://wrong.host.badssl.com/; `CERTIFICATE_VERIFY_FAILED.*(hostname|not valid for)`), `nested` (pip build-dependency installer building a local pyproject `secure-update-tls-probe` with `requires=["setuptools","wheel"]`; stdout "Installing build dependencies.*done"; wheel produced), `brew-env` (brew.env cannot supply PIP_CERT/PIP_USE_DEPRECATED/CLOUDSDK_CONFIG to the child).

  // 9c. tap-approval.test.ts (1)
  // lib/secure-update-tls.sh matches `HOMEBREW_NO_INSTALLED_DEPENDENTS_CHECK=1 [^\n]*"$brew_path" "$dispatch"`. [src-grep].
  test.todo("C su_brew_install exports HOMEBREW_NO_INSTALLED_DEPENDENTS_CHECK=1 [tap-approval]");
});
