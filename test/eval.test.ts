import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkCutover, expandEnv, checkLanding, checkSwitched, parseOutcomes, parseReplay, render, scoreAcceptance, type HostCfg } from "../scripts/eval.ts";
import { loadSets, setCounts } from "../acceptance/sets.ts";

const host = (root: string): HostCfg => ({ name: "h", root, oupdatePlist: "on.plist", secureUpdatePlist: "su.plist", stateDir: "state" });

test("parses acceptance and replay summaries", () => {
  const o = parseOutcomes("MAL  a-1: STOPPED hold (stopped by scan)\nCTRL c-1: PASSED land\n    scan  stop  x");
  expect(o.mal.get("a-1")).toBe("STOPPED");
  expect(o.ctrl.get("c-1")).toBe("PASSED");
  expect(parseReplay("wheel-local: STOPPED hold\n  prepass stop x").get("wheel-local")).toBe("STOPPED");
});

test("switched: oupdate on and secure-update off; unreadable root is not run", () => {
  const d = mkdtempSync(join(tmpdir(), "ev-"));
  expect(checkSwitched([host(join(d, "nope"))]).status).toBe("not run");
  expect(checkSwitched([host(d)]).status).toBe("fail");
  writeFileSync(join(d, "on.plist"), "");
  expect(checkSwitched([host(d)]).status).toBe("pass");
  writeFileSync(join(d, "su.plist"), "");
  expect(checkSwitched([host(d)]).status).toBe("fail");
  writeFileSync(join(d, "su.plist.disabled"), "");
  expect(checkSwitched([host(d)]).status).toBe("pass");
});

test("cutover: report held differences fail unless waived", () => {
  const d = mkdtempSync(join(tmpdir(), "ev-"));
  expect(checkCutover([host(d)]).status).toBe("not run");
  mkdirSync(join(d, "state/reports"), { recursive: true });
  writeFileSync(join(d, "state/reports/2026-10-23.json"), JSON.stringify({ compare: { held: { onlyInventory: ["duckdb"], onlySecureUpdate: [] } } }));
  expect(checkCutover([host(d)]).status).toBe("fail");
  expect(checkCutover([{ ...host(d), waive: [{ name: "duckdb", why: "manual pin" }] }]).status).toBe("pass");
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
  expect(r.c2).toMatchObject({ status: "pass", detail: "8 of 8 passed" });
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
