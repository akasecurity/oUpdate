import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAcceptance, checkAgreement, expandEnv, checkLanding, checkReplaced, parseOutcomes, parseReplay, render, scoreAcceptance, type HostCfg } from "../scripts/eval.ts";
import { loadSets, setCounts } from "../acceptance/sets.ts";

const host = (root: string): HostCfg => ({ name: "h", root, oupdatePlist: "on.plist", previousUpdaterPlist: "old.plist", stateDir: "state" });

test("parses acceptance and replay summaries", () => {
  const o = parseOutcomes("MAL  a-1: STOPPED hold (stopped by scan)\nCTRL c-1: PASSED land\n    scan  stop  x");
  expect(o.mal.get("a-1")).toBe("STOPPED");
  expect(o.ctrl.get("c-1")).toBe("PASSED");
  expect(parseReplay("wheel-local: STOPPED hold\n  prepass stop x").get("wheel-local")).toBe("STOPPED");
});

test("replaced: oupdate on and the previous updater off; unreadable root is not run", () => {
  const d = mkdtempSync(join(tmpdir(), "ev-"));
  expect(checkReplaced([host(join(d, "nope"))]).status).toBe("not run");
  expect(checkReplaced([host(d)]).status).toBe("fail");
  writeFileSync(join(d, "on.plist"), "");
  expect(checkReplaced([host(d)]).status).toBe("pass");
  writeFileSync(join(d, "old.plist"), "");
  expect(checkReplaced([host(d)]).status).toBe("fail");
  writeFileSync(join(d, "old.plist.disabled"), "");
  expect(checkReplaced([host(d)]).status).toBe("pass");
});

test("agreement: report held differences fail unless waived", () => {
  const d = mkdtempSync(join(tmpdir(), "ev-"));
  expect(checkAgreement([host(d)]).status).toBe("not run");
  mkdirSync(join(d, "state/reports"), { recursive: true });
  writeFileSync(join(d, "state/reports/2026-10-23.json"), JSON.stringify({ compare: { held: { onlyInventory: ["duckdb"], onlyPrevious: [] } } }));
  expect(checkAgreement([host(d)]).status).toBe("fail");
  expect(checkAgreement([{ ...host(d), waive: [{ name: "duckdb", why: "manual pin" }] }]).status).toBe("pass");
});

test("landing and score", () => {
  const d = mkdtempSync(join(tmpdir(), "ev-"));
  expect(checkLanding(join(d, "x.json")).status).toBe("not run");
  writeFileSync(join(d, "l.json"), JSON.stringify({ pr: 7, landed: true, context: "oupdate/review", state: "success", rollbackTested: false }));
  expect(checkLanding(join(d, "l.json")).status).toBe("fail");
  expect(render([{ n: 1, name: "a", status: "pass", detail: "" }, { n: 2, name: "b", status: "not run", detail: "" }]).score).toBe(1);
});

test("expandEnv fills ${NAME} and rejects an unset name", () => {
  expect(expandEnv('{"u":"${A_B}/v1"}', { A_B: "http://h:1" })).toBe('{"u":"http://h:1/v1"}');
  expect(() => expandEnv("${NOPE}", {})).toThrow("NOPE");
  expect(() => expandEnv("${E}", { E: "" })).toThrow("E");
  expect(expandEnv("${lower_1} $A ${1A} ${A-B} $", { lower_1: "x" })).toBe("x $A ${1A} ${A-B} $");
});

test("checks 1 and 2 count the core set from the JSON and ignore extended results", () => {
  const core = setCounts(loadSets(), "core");
  const ext = setCounts(loadSets(), "extended");
  const mal = new Map([...core.attackIds].filter((id) => id !== "litellm-1.107.0").map((id) => [id, "STOPPED"]));
  const ctrl = new Map([...core.controlIds].map((id) => [id, "PASSED"]));
  for (const id of ext.attackIds) mal.set(id, "PASSED");
  for (const id of ext.controlIds) ctrl.set(id, "STOPPED");
  const replay = new Map([["wheel-local", "STOPPED"]]);
  const r = scoreAcceptance({ mal, ctrl }, replay, "0/0");
  expect(r.c1).toMatchObject({ status: "pass", detail: "9 of 9 stopped" });
  expect(r.c2).toMatchObject({ status: "pass", detail: `${core.controls} approved, 0 held by a limit, 0 false alarms (of ${core.controls})` });
  expect(r.extended).toBe(`extended set (informational, not scored): 0 of ${ext.attacks} attacks stopped, 0 of ${ext.controls} controls passed`);
  expect(scoreAcceptance({ mal: new Map(), ctrl: new Map() }, new Map(), "1/1").extended).toBeUndefined();
});

test("extended line counts missing results; render prints info lines without scoring them", () => {
  const ext = setCounts(loadSets(), "extended");
  const id = [...ext.attackIds][0]!;
  const r = scoreAcceptance({ mal: new Map([[id, "STOPPED"]]), ctrl: new Map() }, new Map(), "0/0");
  expect(r.extended).toBe(`extended set (informational, not scored): 1 of ${ext.attacks} attacks stopped, 0 of ${ext.controls} controls passed; ${ext.attacks - 1 + ext.controls} gave no result`);
  const out = render([{ n: 1, name: "a", status: "pass", detail: "" }], ["info line"]);
  expect(out.text).toBe("PASS 1 a: \ninfo line\nscore: 1/6");
  expect(out.score).toBe(1);
});

test("scores by case id when run.ts suffixes the reviewer name, and keeps the worst outcome", () => {
  const out = "MAL  a-1-m1: STOPPED hold\nMAL  a-1-m2: MISSED land\nCTRL c-1-m1: PASSED land\nCTRL c-1-m2: PASSED land";
  const o = parseOutcomes(out, ["m1", "m2"]);
  expect(o.mal.get("a-1")).toBe("MISSED");
  expect(o.ctrl.get("c-1")).toBe("PASSED");
  // the order of the lines does not matter, and a hold for a human is not hidden by a pass
  for (const lines of ["CTRL c-m1: PASSED land\nCTRL c-m2: HELD-HUMAN hold", "CTRL c-m2: HELD-HUMAN hold\nCTRL c-m1: PASSED land"]) expect(parseOutcomes(lines, ["m1", "m2"]).ctrl.get("c")).toBe("HELD-HUMAN");
  for (const lines of ["CTRL c-m1: HELD-HUMAN hold\nCTRL c-m2: ERROR hold", "CTRL c-m2: ERROR hold\nCTRL c-m1: HELD-HUMAN hold"]) expect(parseOutcomes(lines, ["m1", "m2"]).ctrl.get("c")).toBe("ERROR");
});

test("the longest reviewer name is stripped from the case id; a name with a space works", () => {
  expect(parseOutcomes("CTRL x-big-m1: PASSED land\nCTRL x-m1: PASSED land", ["m1", "big-m1"]).ctrl.get("x")).toBe("PASSED");
  expect(parseOutcomes("CTRL c-gpt 5: PASSED land\nCTRL c-m1: PASSED land", ["m1", "gpt 5"]).ctrl.get("c")).toBe("PASSED");
});

test("a case one reviewer did not report is MISSING, whatever the other said", () => {
  const o = parseOutcomes("MAL  a-m1: STOPPED hold\nMAL  a-gpt 5: STOPPED hold\nMAL  b-m1: STOPPED hold\nCTRL c-m1: PASSED land", ["m1", "gpt 5"]);
  expect(o.mal.get("a")).toBe("STOPPED");
  expect(o.mal.get("b")).toBe("MISSING");
  expect(o.ctrl.get("c")).toBe("MISSING");
  // one reviewer: nothing to compare, a line is a result
  expect(parseOutcomes("CTRL c-m1: PASSED land", ["m1"]).ctrl.get("c")).toBe("PASSED");
});

test("a hold for a limit is correct only on the control marked expect held, a stop or an error on a control is a false alarm, and a nonzero exit of the acceptance run fails both checks", () => {
  const sets = setCounts(loadSets(), "core");
  const core = [...sets.controlIds];
  const attacks = [...sets.attackIds];
  const ctrl = new Map(core.map((id) => [id, "PASSED"]));
  const mal = new Map(attacks.map((id) => [id, "STOPPED"]));
  const replay = new Map([["wheel-local", "STOPPED"]]);
  expect(scoreAcceptance({ mal, ctrl }, replay, "0/0").c2.status).toBe("pass");
  const markedId = [...sets.heldIds][0]!; // the control marked expect held; it may also be approved (PASSED above), which is intended
  const held = scoreAcceptance({ mal, ctrl: new Map(ctrl).set(markedId, "HELD-HUMAN") }, replay, "0/0").c2;
  expect(held.status).toBe("pass");
  expect(held.detail).toContain(`${core.length - 1} approved, 1 held by a limit, 0 false alarms (of ${core.length})`);
  const stopped = scoreAcceptance({ mal, ctrl: new Map(ctrl).set(core[0]!, "STOPPED") }, replay, "0/0").c2;
  expect(stopped.status).toBe("fail");
  expect(stopped.detail).toContain(`${core[0]}=STOPPED`);
  const errored = scoreAcceptance({ mal, ctrl: new Map(ctrl).set(core[1]!, "ERROR") }, replay, "0/0").c2; // a crashed layer beside a size hold is classified ERROR, never a hold for a limit
  expect(errored.status).toBe("fail");
  expect(errored.detail).toContain(`${core[1]}=ERROR`);
  const bad = scoreAcceptance({ mal, ctrl }, replay, "1/0");
  expect(bad.c1.status).toBe("fail");
  expect(bad.c2.status).toBe("fail");
  // the replay run's own exit code is not the acceptance run's
  expect(scoreAcceptance({ mal, ctrl }, replay, "0/1").c2.status).toBe("pass");
});

test("for an attack a PASSED is the worst outcome, in either order", () => {
  for (const lines of ["MAL  a-m1: ERROR hold\nMAL  a-m2: PASSED land", "MAL  a-m2: PASSED land\nMAL  a-m1: ERROR hold"]) expect(parseOutcomes(lines, ["m1", "m2"]).mal.get("a")).toBe("PASSED");
});

test("a landed attack is not hidden by MISSING, and a false alarm on a control is the worst control outcome", () => {
  expect(parseOutcomes("MAL  a-m1: PASSED land", ["m1", "m2"]).mal.get("a")).toBe("PASSED"); // m2 never reported it
  for (const lines of ["CTRL c-m1: STOPPED hold\nCTRL c-m2: ERROR hold", "CTRL c-m2: ERROR hold\nCTRL c-m1: STOPPED hold"]) expect(parseOutcomes(lines, ["m1", "m2"]).ctrl.get("c")).toBe("STOPPED");
});

test("a reviewer that reports a case twice does not stand in for one that reported it not at all", () => {
  expect(parseOutcomes("MAL  a-m1: STOPPED hold\nMAL  a-m1: STOPPED hold", ["m1", "m2"]).mal.get("a")).toBe("MISSING");
});

test("reviewer names where one ends in another's are rejected before the run", () => {
  const spec = (name: string) => ({ type: "command", name, argv: ["true"] });
  const r = runAcceptance({ reviewers: [spec("m1"), spec("x-m1")] } as never);
  expect(r.c1.status).toBe("not run");
  expect(r.c1.detail).toContain("x-m1 repeats or ends in another reviewer's name");
  // the same name twice writes the same result files and is heard from one name only
  const dup = runAcceptance({ reviewers: [spec("m1"), spec("m1")] } as never);
  expect(dup.c1.status).toBe("not run");
  expect(dup.c1.detail).toContain("m1 repeats or ends in another reviewer's name");
});

test("check 2 needs the unmarked controls approved: all ten held for a limit fails, a hold is correct only on a control marked expect held", () => {
  const sets = loadSets();
  const ids = setCounts(sets, "core").controlIds;
  const core = sets.controls.filter((c) => ids.has(c.id));
  const marked = [...setCounts(sets, "core").heldIds];
  expect(marked.sort()).toEqual(["control-bitwarden-cli-2026.3.0", "control-litellm-1.106.2"]); // the releases that ship a binary no model can read
  const attacks = new Map<string, string>();
  const allHeld = new Map(core.map((c) => [c.id, "HELD-HUMAN"]));
  const r = scoreAcceptance({ mal: attacks, ctrl: allHeld }, new Map(), "0/0").c2;
  expect(r.status).toBe("fail");
  expect(r.detail).toContain(`0 approved, 2 held by a limit, ${core.length - 2} false alarms (of ${core.length})`);
  const oneUnmarked = new Map(core.map((c) => [c.id, "PASSED"]));
  oneUnmarked.set(core[core.length - 1]!.id, "HELD-HUMAN");
  const u = scoreAcceptance({ mal: attacks, ctrl: oneUnmarked }, new Map(), "0/0").c2;
  expect(u.status).toBe("fail");
  expect(u.detail).toContain(`${core[core.length - 1]!.id}=HELD-HUMAN`);
  const markedPassed = new Map(core.map((c) => [c.id, "PASSED"]));
  expect(scoreAcceptance({ mal: attacks, ctrl: markedPassed }, new Map(), "0/0").c2.status).toBe("pass"); // the marked control may also be approved
});

test("the bitwarden control is marked expect held: its hold for the .wasm counts in check 2, and an unmarked control's does not", () => {
  const sets = setCounts(loadSets(), "core");
  const attacks = new Map([...sets.attackIds].map((id) => [id, "STOPPED"]));
  const replay = new Map([["wheel-local", "STOPPED"]]);
  const ctrl = new Map([...sets.controlIds].map((id) => [id, "PASSED"]));
  const held = scoreAcceptance({ mal: attacks, ctrl: new Map(ctrl).set("control-bitwarden-cli-2026.3.0", "HELD-HUMAN") }, replay, "0/0").c2;
  expect(held.status).toBe("pass");
  expect(held.detail).toContain(`${sets.controls - 1} approved, 1 held by a limit, 0 false alarms`);
  expect(scoreAcceptance({ mal: attacks, ctrl: new Map(ctrl).set("control-ms-2.1.3", "HELD-HUMAN") }, replay, "0/0").c2.status).toBe("fail");
});
