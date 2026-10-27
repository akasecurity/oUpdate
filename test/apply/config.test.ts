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
  test("releaseChecks: off by default; formula + command, retries 1 and timeoutSec 900 by default, optional before/after/runAs", () => {
    expect(parseApplyConfig(cfg({ stateDir: "/state.test" }), "hosta").releaseChecks).toBeUndefined();
    const c = parseApplyConfig(cfg({ stateDir: "/state.test", releaseChecks: [
      { formula: "splash", command: ["/opt/gate.test/check", "--quick"] },
      { formula: "other", command: ["/opt/gate.test/other"], retries: 0, timeoutSec: 60, before: ["svcctl", "off", "--now"], after: ["svcctl", "on"], runAs: "svc-user", owners: ["com.example.other-server"] },
    ] }), "hosta");
    expect(c.releaseChecks).toEqual([
      { formula: "splash", command: ["/opt/gate.test/check", "--quick"], retries: 1, timeoutSec: 900 },
      { formula: "other", command: ["/opt/gate.test/other"], retries: 0, timeoutSec: 60, before: ["svcctl", "off", "--now"], after: ["svcctl", "on"], runAs: "svc-user", owners: ["com.example.other-server"] },
    ]);
  });
  test("notify [] is kept: log-only by choice, not unconfigured", () => {
    expect(parseApplyConfig(cfg({ stateDir: "/state.test", notify: [] }), "hosta").notify).toEqual([]);
  });
  test("everything host-specific is read from the file", () => {
    const c = parseApplyConfig(cfg({
      host: "hostn", stateDir: "/state.test", npm: null, typeBTaps: ["Example/Svc"], approvedTapsFile: "/conf.test/taps.tsv",
      pinRoots: ["/repos.test"], caskExclude: ["big"], stuckAfter: 5, deferred: [SVC],
      restartHelper: { path: "/usr/local/sbin/helper.test", packages: ["svc"], detached: ["net"] },
      notify: ["send-notice", "--to", "ops"], reviewer: { type: "command", name: "r", argv: ["review-cmd"] }, timeoutMs: 1000,
    }), "hosta");
    expect(c).toMatchObject({ host: "hostn", npm: null, typeBTaps: ["example/svc"], stuckAfter: 5, deferred: [SVC], notify: ["send-notice", "--to", "ops"] });
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
  test("staleOwners: off by default; a list of label globs with an optional probe argv and health URL", () => {
    expect(parseApplyConfig(cfg({ stateDir: "/state.test" }), "hosta").staleOwners).toBeUndefined();
    const c = parseApplyConfig(cfg({ stateDir: "/state.test", staleOwners: [{ match: "org.example.*" }, { match: "org.example.svc", probe: ["/opt/svc.test/idle", "--quiet"], health: "http://127.0.0.1:8080/health" }] }), "hosta");
    expect(c.staleOwners).toEqual([{ match: "org.example.*" }, { match: "org.example.svc", probe: ["/opt/svc.test/idle", "--quiet"], health: "http://127.0.0.1:8080/health" }]);
  });
  test("staleOwners restart: kickstart (default) or bootout+bootstrap of an absolute plist; healthWithinSec", () => {
    const c = parseApplyConfig(cfg({ stateDir: "/state.test", staleOwners: [
      { match: "org.example.k", restart: "kickstart" },
      { match: "org.example.gate", probe: ["/usr/local/libexec/example-idle"], health: "http://127.0.0.1:8091/status", restart: { bootstrap: "/Library/LaunchDaemons/org.example.gate.plist" }, healthWithinSec: 120 },
    ] }), "hosta");
    expect(c.staleOwners).toEqual([
      { match: "org.example.k", restart: "kickstart" },
      { match: "org.example.gate", probe: ["/usr/local/libexec/example-idle"], health: "http://127.0.0.1:8091/status", restart: { bootstrap: "/Library/LaunchDaemons/org.example.gate.plist" }, healthWithinSec: 120 },
    ]);
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
    ["a staleOwners that is not an array", cfg({ stateDir: "/s", staleOwners: { match: "x" } }), /apply\.staleOwners must be an array/],
    ["a staleOwners entry that is not an object", cfg({ stateDir: "/s", staleOwners: ["org.x"] }), /apply\.staleOwners\[0\] must be an object/],
    ["a staleOwners entry with no match", cfg({ stateDir: "/s", staleOwners: [{ probe: ["/a"] }] }), /apply\.staleOwners\[0\]\.match is required/],
    ["a staleOwners entry with an unknown key", cfg({ stateDir: "/s", staleOwners: [{ match: "org.x", probes: ["/a"] }] }), /apply\.staleOwners\[0\]: unknown key probes/],
    ["a staleOwners probe with a relative argv0", cfg({ stateDir: "/s", staleOwners: [{ match: "org.x", probe: ["idle.sh"] }] }), /apply\.staleOwners\[0\]\.probe\[0\] must be an absolute path/],
    ["a staleOwners probe that is empty", cfg({ stateDir: "/s", staleOwners: [{ match: "org.x", probe: [] }] }), /apply\.staleOwners\[0\]\.probe must be a non-empty array/],
    ["a staleOwners restart word other than kickstart", cfg({ stateDir: "/s", staleOwners: [{ match: "org.x", restart: "bootstrap" }] }), /apply\.staleOwners\[0\]\.restart must be "kickstart" or \{"bootstrap": "<absolute plist path>"\}/],
    ["a staleOwners bootstrap with a relative plist", cfg({ stateDir: "/s", staleOwners: [{ match: "org.x", restart: { bootstrap: "org.x.plist" } }] }), /apply\.staleOwners\[0\]\.restart must be/],
    ["a staleOwners restart object with another key", cfg({ stateDir: "/s", staleOwners: [{ match: "org.x", restart: { bootstrap: "/L/org.x.plist", how: 1 } }] }), /apply\.staleOwners\[0\]\.restart must be/],
    ["a staleOwners healthWithinSec of zero", cfg({ stateDir: "/s", staleOwners: [{ match: "org.x", healthWithinSec: 0 }] }), /apply\.staleOwners\[0\]\.healthWithinSec must be a positive integer/],
    ["a staleOwners health that is not a URL", cfg({ stateDir: "/s", staleOwners: [{ match: "org.x", health: "localhost:8080" }] }), /apply\.staleOwners\[0\]\.health must be an http\(s\) URL/],
    ["a releaseChecks that is not an array", cfg({ stateDir: "/s", releaseChecks: { formula: "x" } }), /apply\.releaseChecks must be an array/],
    ["a releaseChecks entry that is not an object", cfg({ stateDir: "/s", releaseChecks: ["splash"] }), /apply\.releaseChecks\[0\] must be an object/],
    ["a releaseChecks entry with an unknown key", cfg({ stateDir: "/s", releaseChecks: [{ formula: "splash", command: ["/c"], retry: 2 }] }), /apply\.releaseChecks\[0\]: unknown key retry/],
    ["a releaseChecks entry with no formula", cfg({ stateDir: "/s", releaseChecks: [{ command: ["/c"] }] }), /apply\.releaseChecks\[0\]\.formula is required/],
    ["a releaseChecks entry with no command", cfg({ stateDir: "/s", releaseChecks: [{ formula: "splash" }] }), /apply\.releaseChecks\[0\]\.command is required/],
    ["a releaseChecks command that is empty", cfg({ stateDir: "/s", releaseChecks: [{ formula: "splash", command: [] }] }), /apply\.releaseChecks\[0\]\.command must be a non-empty array/],
    ["a releaseChecks retries that is negative", cfg({ stateDir: "/s", releaseChecks: [{ formula: "splash", command: ["/c"], retries: -1 }] }), /apply\.releaseChecks\[0\]\.retries must be a non-negative integer/],
    ["a releaseChecks timeoutSec of zero", cfg({ stateDir: "/s", releaseChecks: [{ formula: "splash", command: ["/c"], timeoutSec: 0 }] }), /apply\.releaseChecks\[0\]\.timeoutSec must be a positive integer/],
    ["a releaseChecks before that is empty", cfg({ stateDir: "/s", releaseChecks: [{ formula: "splash", command: ["/c"], before: [] }] }), /apply\.releaseChecks\[0\]\.before must be a non-empty array/],
    ["a releaseChecks runAs that is not a user name", cfg({ stateDir: "/s", releaseChecks: [{ formula: "splash", command: ["/c"], runAs: "-u root" }] }), /apply\.releaseChecks\[0\]\.runAs must be a user name/],
    ["a releaseChecks owners that is empty", cfg({ stateDir: "/s", releaseChecks: [{ formula: "splash", command: ["/c"], owners: [] }] }), /apply\.releaseChecks\[0\]\.owners must be a non-empty array/],
    ["a releaseChecks owners entry that is not a string", cfg({ stateDir: "/s", releaseChecks: [{ formula: "splash", command: ["/c"], owners: [1] }] }), /apply\.releaseChecks\[0\]\.owners must be a non-empty array/],
    ["a releaseChecks formula listed twice", cfg({ stateDir: "/s", releaseChecks: [{ formula: "splash", command: ["/c"] }, { formula: "example/tap/splash", command: ["/d"] }] }), /apply\.releaseChecks\[1\]\.formula splash is listed twice/],
  ] as const) {
    test(`${label} is an error`, () => expect(() => parseApplyConfig(text, "hosta")).toThrow(err));
  }
  test("${NAME} in a config value is read from the environment; unset or empty is an error naming it (#9)", () => {
    const text = cfg({ stateDir: "${OUP_STATE}/s", reviewer: { type: "openai", name: "h", baseUrls: ["${base_url}"], model: "m", headers: { "X-Key": "${OUP_KEY}" } }, notify: ["/bin/echo", "$HOME $1 ${1X} $"] });
    const c = parseApplyConfig(text, "hosta", { OUP_STATE: "/state.test", base_url: "https://h.test/v1", OUP_KEY: 'k"\\' });
    expect(c.stateDir).toBe("/state.test/s");
    expect(c.reviewer).toMatchObject({ baseUrls: ["https://h.test/v1"], headers: { "X-Key": 'k"\\' } });
    expect(c.notify).toEqual(["/bin/echo", "$HOME $1 ${1X} $"]);
    expect(() => parseApplyConfig(text, "hosta", { OUP_STATE: "/state.test", base_url: "https://h.test/v1" })).toThrow("OUP_KEY");
    expect(() => parseApplyConfig(text, "hosta", { OUP_STATE: "/state.test", base_url: "https://h.test/v1", OUP_KEY: "" })).toThrow("OUP_KEY");
  });
});
