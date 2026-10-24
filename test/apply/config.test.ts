// The host apply's config (slice 7): defaults, and every mistake an error.
import { describe, expect, test } from "bun:test";
import { DEFAULTS, parseApplyConfig } from "../../src/apply/config.ts";

const cfg = (apply: Record<string, unknown>) => JSON.stringify({ apply });
const SVC = { name: "svc", waiter: "/srv.test/w.sh", holdFile: "/srv.test/h", quarantineFile: "/srv.test/q", outcomeFile: "/srv.test/o", restartLog: "/srv.test/r.log" };

describe("parseApplyConfig", () => {
  test("defaults: only stateDir is required; the host falls back", () => {
    const c = parseApplyConfig(cfg({ stateDir: "/state.test" }), "hosta");
    expect(c).toMatchObject({
      host: "hosta", stateDir: "/state.test", brew: "brew", npm: "npm", lsof: DEFAULTS.lsof, officialTaps: DEFAULTS.officialTaps,
      typeBTaps: [], pinRoots: [], caskExclude: [], stuckAfter: 3, deferred: [], timeoutMs: DEFAULTS.timeoutMs,
    });
    expect(c.reviewer).toBeUndefined();
    expect(c.notify).toBeUndefined();
    expect(c.claudeCode).toBeUndefined();
  });
  test("claudeCode: the native binary's absolute path", () => {
    expect(parseApplyConfig(cfg({ stateDir: "/state.test", claudeCode: "/opt.test/bin/claude" }), "hosta").claudeCode).toBe("/opt.test/bin/claude");
  });
  test("postUpgradeCheck: off by default, a package-to-argv map when given", () => {
    expect(parseApplyConfig(cfg({ stateDir: "/state.test" }), "hosta").postUpgradeCheck).toBeUndefined();
    expect(parseApplyConfig(cfg({ stateDir: "/state.test", postUpgradeCheck: { git: ["git", "--version"] } }), "hosta").postUpgradeCheck).toEqual({ git: ["git", "--version"] });
  });
  test("notify [] is kept: log-only by choice, not unconfigured", () => {
    expect(parseApplyConfig(cfg({ stateDir: "/state.test", notify: [] }), "hosta").notify).toEqual([]);
  });
  test("everything host-specific is read from the file", () => {
    const c = parseApplyConfig(cfg({
      host: "hostn", stateDir: "/state.test", npm: null, typeBTaps: ["Example/Svc"], approvedTapsFile: "/conf.test/taps.tsv",
      pinRoots: ["/repos.test"], caskExclude: ["big"], stuckAfter: 5, deferred: [SVC],
      restartHelper: { path: "/usr/local/sbin/helper.test", packages: ["svc"], detached: ["net"] },
      notify: ["notify-cmd", "--to", "ops"], reviewer: { type: "command", name: "r", argv: ["review-cmd"] }, timeoutMs: 1000,
    }), "hosta");
    expect(c).toMatchObject({ host: "hostn", npm: null, typeBTaps: ["example/svc"], stuckAfter: 5, deferred: [SVC], notify: ["notify-cmd", "--to", "ops"] });
    expect(c.restartHelper).toEqual({ path: "/usr/local/sbin/helper.test", packages: ["svc"], detached: ["net"], delaySec: undefined });
    expect(c.reviewer).toMatchObject({ type: "command", name: "r" });
  });
  test("labelRestart: skip or an absolute argv, per literal label", () => {
    const c = parseApplyConfig(cfg({ stateDir: "/state.test", labelRestart: { "org.example.a+b": "skip", "org.example.d": ["/opt/owner.test/restart", "--wait"] } }), "hosta");
    expect(c.labelRestart).toEqual({ "org.example.a+b": "skip", "org.example.d": ["/opt/owner.test/restart", "--wait"] });
    expect(parseApplyConfig(cfg({ stateDir: "/state.test" }), "hosta").labelRestart).toBeUndefined();
  });
  test('labelRestart: "kickstart" is an explicit allow entry', () => {
    const c = parseApplyConfig(cfg({ stateDir: "/state.test", labelRestart: { "org.example.k": "kickstart", "org.example.s": "skip" } }), "hosta");
    expect(c.labelRestart).toEqual({ "org.example.k": "kickstart", "org.example.s": "skip" });
  });
  test("staleKegUnlisted: kickstart or report; absent is kickstart (the behavior before it)", () => {
    expect(parseApplyConfig(cfg({ stateDir: "/state.test", staleKegUnlisted: "report" }), "hosta").staleKegUnlisted).toBe("report");
    expect(parseApplyConfig(cfg({ stateDir: "/state.test", staleKegUnlisted: "kickstart" }), "hosta").staleKegUnlisted).toBe("kickstart");
    expect(parseApplyConfig(cfg({ stateDir: "/state.test" }), "hosta").staleKegUnlisted).toBe("kickstart");
  });
  test("labelRestart: a label named like a prototype key is an own label, never the prototype", () => {
    // Mutant caught: labelRestart built by assignment ("__proto__" set the object's prototype; the label was lost).
    const c = parseApplyConfig('{"apply":{"stateDir":"/state.test","labelRestart":{"__proto__":"skip","constructor":["/opt/owner.test/r"]}}}', "hosta");
    const l = c.labelRestart!;
    expect(Object.hasOwn(l, "__proto__")).toBe(true);
    expect(Object.hasOwn(l, "constructor")).toBe(true);
    expect(Object.getPrototypeOf(l)).toBe(Object.prototype);
    expect(l["constructor"]).toEqual(["/opt/owner.test/r"]);
  });
  for (const [label, text, err] of [
    ["not JSON", "{", /not valid JSON/],
    ["no apply object", "{}", /"apply" object/],
    ["no stateDir", cfg({}), /stateDir is required/],
    ["a relative path", cfg({ stateDir: "state" }), /absolute path/],
    ["an unknown key", cfg({ stateDir: "/s", caskExclud: [] }), /unknown key caskExclud/],
    ["a wrong type", cfg({ stateDir: "/s", caskExclude: "big" }), /array of non-empty strings/],
    ["a zero threshold", cfg({ stateDir: "/s", stuckAfter: 0 }), /positive integer/],
    ["an incomplete deferred service", cfg({ stateDir: "/s", deferred: [{ name: "svc" }] }), /deferred\[0\]\.waiter is required/],
    ["a bad reviewer", cfg({ stateDir: "/s", reviewer: { type: "x", name: "r" } }), /reviewer type/],
    ["a relative claudeCode", cfg({ stateDir: "/s", claudeCode: "bin/claude" }), /claudeCode must be an absolute path/],
    ["a postUpgradeCheck that is not an object", cfg({ stateDir: "/s", postUpgradeCheck: ["git"] }), /postUpgradeCheck must be an object/],
    ["a postUpgradeCheck with an empty argv", cfg({ stateDir: "/s", postUpgradeCheck: { git: [] } }), /postUpgradeCheck\["git"\] must be a non-empty array of non-empty strings/],
    ["a postUpgradeCheck with a non-string argv entry", cfg({ stateDir: "/s", postUpgradeCheck: { git: ["git", 1] } }), /postUpgradeCheck\["git"\] must be/],
    ["a notify with an empty string", cfg({ stateDir: "/s", notify: [""] }), /array of non-empty strings/],
    ["a labelRestart command with a relative argv0", cfg({ stateDir: "/s", labelRestart: { "org.example.x": ["restart.sh"] } }), /labelRestart\["org\.example\.x"\] must be "skip", "kickstart" or a non-empty argv array whose first entry is an absolute path/],
    ["an empty labelRestart command", cfg({ stateDir: "/s", labelRestart: { "org.example.x": [] } }), /labelRestart\["org\.example\.x"\] must be/],
    ["a labelRestart number", cfg({ stateDir: "/s", labelRestart: { "org.example.x": 1 } }), /labelRestart\["org\.example\.x"\] must be/],
    ["a labelRestart word other than skip", cfg({ stateDir: "/s", labelRestart: { "org.example.x": "restart" } }), /labelRestart\["org\.example\.x"\] must be/],
    ["a labelRestart object value", cfg({ stateDir: "/s", labelRestart: { "org.example.x": { argv: ["/a"] } } }), /labelRestart\["org\.example\.x"\] must be/],
    ["a labelRestart that is not an object", cfg({ stateDir: "/s", labelRestart: ["org.example.x"] }), /labelRestart must be an object/],
    ["a staleKegUnlisted other than kickstart or report", cfg({ stateDir: "/s", staleKegUnlisted: "skip" }), /apply\.staleKegUnlisted must be "kickstart" or "report"/],
    ["a staleKegUnlisted null", cfg({ stateDir: "/s", staleKegUnlisted: null }), /apply\.staleKegUnlisted must be "kickstart" or "report"/],
    ["a staleKegUnlisted that is not a string", cfg({ stateDir: "/s", staleKegUnlisted: true }), /apply\.staleKegUnlisted must be "kickstart" or "report"/],
    ["a labelRestart argv with an empty argument", cfg({ stateDir: "/s", labelRestart: { "org.example.x": ["/a", ""] } }), /labelRestart\["org\.example\.x"\] must be/],
  ] as const) {
    test(`${label} is an error`, () => expect(() => parseApplyConfig(text, "hosta")).toThrow(err));
  }
});
