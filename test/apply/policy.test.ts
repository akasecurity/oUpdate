// oupdate-policy.json: an owner and a reason per pin entry; a plain config value without one is a warning.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseApplyConfig } from "../../src/apply/config.ts";
import { applyPolicy, parsePolicy } from "../../src/apply/policy.ts";
import { applyMain, readinessMain } from "../../src/host/cli.ts";
import { pendingFromOutdated } from "../../src/apply/stuck.ts";
import { renderDigest } from "../../src/host/digest.ts";
import { fakeHost } from "./host-fixture.ts";

const E = (o: object) => JSON.stringify(o);
const entry = (value: string, extra: object = {}) => ({ value, owner: "team-a", reason: "held for a known fault", ...extra });

describe("parsePolicy", () => {
  test("an entry with owner and reason is read; the groups default to empty", () => {
    const p = parsePolicy(E({ caskExclude: [entry("example-app")], sandboxPins: [entry("sandbox-tool@1.2")] }));
    expect(p.caskExclude).toEqual([{ value: "example-app", owner: "team-a", reason: "held for a known fault" }]);
    expect(p.sandboxPins.map((e) => e.value)).toEqual(["sandbox-tool@1.2"]);
    expect(p.pinRoots).toEqual([]);
  });
  test("an entry missing owner, reason or both fails, naming the group, index and value", () => {
    expect(() => parsePolicy(E({ caskExclude: [entry("ok"), { value: "bare-app", reason: "r" }] }), "p.json")).toThrow('p.json: caskExclude[1] ("bare-app") needs owner');
    expect(() => parsePolicy(E({ pinRoots: [{ value: "/srv/x", owner: "o" }] }), "p.json")).toThrow('p.json: pinRoots[0] ("/srv/x") needs reason');
    expect(() => parsePolicy(E({ holdFile: [{ value: "/srv/hold" }] }), "p.json")).toThrow('p.json: holdFile[0] ("/srv/hold") needs owner and reason');
  });
  test("a blank owner or reason counts as missing", () => {
    expect(() => parsePolicy(E({ caskExclude: [{ value: "a", owner: " ", reason: "r" }] }))).toThrow(/needs owner/);
  });
  test("mistakes are errors: unknown key, bad shape, relative path, duplicate", () => {
    expect(() => parsePolicy("{")).toThrow(/not valid JSON/);
    expect(() => parsePolicy(E({ pins: [] }))).toThrow(/unknown key "pins"/);
    expect(() => parsePolicy(E({ caskExclude: "x" }))).toThrow(/caskExclude must be an array/);
    expect(() => parsePolicy(E({ pinRoots: [entry("rel/path")] }))).toThrow(/must be an absolute path/);
    expect(() => parsePolicy(E({ caskExclude: [entry("a"), entry("a")] }))).toThrow(/listed twice/);
  });
});

describe("applyPolicy", () => {
  const base = () => parseApplyConfig(E({ apply: { stateDir: "/state.test", pinRoots: ["/srv/a", "/srv/b"], caskExclude: ["one", "two"], deferred: [{ name: "svc", waiter: "/w", holdFile: "/srv/hold", quarantineFile: "/q", outcomeFile: "/o", restartLog: "/r" }] } }), "hosta");
  test("a plain value with no policy entry is reported ownerless; one with an entry is not", () => {
    const { notes } = applyPolicy(base(), parsePolicy(E({ pinRoots: [entry("/srv/a")], caskExclude: [entry("two")], holdFile: [entry("/srv/hold")] })));
    expect(notes).toEqual([
      'policy: WARNING ownerless: pinRoots "/srv/b" has no owner and reason in oupdate-policy.json',
      'policy: WARNING ownerless: caskExclude "one" has no owner and reason in oupdate-policy.json',
    ]);
  });
  test("no policy file: every plain value is ownerless, including a deferred holdFile", () => {
    expect(applyPolicy(base(), undefined).notes).toHaveLength(5);
  });
  test("the policy's own pinRoots and caskExclude values apply too, once", () => {
    const { cfg } = applyPolicy(base(), parsePolicy(E({ pinRoots: [entry("/srv/c"), entry("/srv/a")], caskExclude: [entry("three")] })));
    expect(cfg.pinRoots).toEqual(["/srv/a", "/srv/b", "/srv/c"]);
    expect(cfg.caskExclude).toEqual(["one", "two", "three"]);
  });
});

const root = mkdtempSync(join(tmpdir(), "oupdate-policy-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
function host(apply: object, policy?: string) {
  const dir = join(root, `c${++n}`);
  mkdirSync(dir, { recursive: true });
  const config = join(dir, "config.json");
  writeFileSync(config, E({ apply: { stateDir: join(dir, "state"), npm: null, ...apply } }));
  if (policy !== undefined) writeFileSync(join(dir, "oupdate-policy.json"), policy);
  return { dir, config };
}
const run = (config: string) => {
  const h = fakeHost();
  return applyMain({ mode: "apply", config, dryRun: true, host: "hosta" }, { exec: h.exec, fs: h.fs, out: () => {} });
};

describe("host --apply and the policy file", () => {
  test("an ownerless plain value is a warning in the log and the run's rc is unchanged", async () => {
    const c = host({ caskExclude: ["one"] });
    const r = await run(c.config);
    expect(r.rc).toBe(0);
    expect(r.text).toContain('policy: WARNING ownerless: caskExclude "one" has no owner and reason in oupdate-policy.json');
  });
  test("a listed value is not reported", async () => {
    const c = host({ caskExclude: ["one"] }, E({ caskExclude: [entry("one")] }));
    expect((await run(c.config)).text).not.toContain("ownerless");
  });
  test("an entry missing its owner fails the run's config check, naming the entry", async () => {
    const c = host({}, E({ caskExclude: [{ value: "bare-app", reason: "r" }] }));
    await expect(run(c.config)).rejects.toThrow(/caskExclude\[0\] \("bare-app"\) needs owner/);
  });
  test("a named policyFile that is missing is an error; the default one missing is not", async () => {
    const c = host({ policyFile: "/nonexistent.test/policy.json" });
    await expect(run(c.config)).rejects.toThrow("cannot read policy file /nonexistent.test/policy.json");
    expect((await run(host({}).config)).rc).toBe(0);
  });
});

describe("round 1 fixes", () => {
  const cfgOf = (apply: object) => parseApplyConfig(E({ apply: { stateDir: "/state.test", ...apply } }), "hosta");
  test("the digest is identical with and without a policy line in the log", async () => {
    const plain = await run(host({ caskExclude: ["one"] }).config);
    const owned = await run(host({ caskExclude: ["one"] }, E({ caskExclude: [entry("one")] })).config);
    expect(plain.text).toContain("ownerless");
    expect(owned.text).not.toContain("ownerless");
    const d = (log: string) => renderDigest({ host: "hosta", date: "2026-11-03", log });
    expect(d(plain.text)).toBe(d(owned.text));
    expect(d(plain.text)).not.toContain("policy");
  });
  test("a trailing slash is the same path: no ownerless warning and the root is listed once", () => {
    const { cfg, notes } = applyPolicy(cfgOf({ pinRoots: ["/srv/a/"] }), parsePolicy(E({ pinRoots: [entry("/srv/a")] })));
    expect(notes).toEqual([]);
    expect(cfg.pinRoots).toEqual(["/srv/a/"]);
    expect(() => parsePolicy(E({ pinRoots: [entry("/srv/a/"), entry("/srv/a")] }))).toThrow(/listed twice/);
  });
  test("a cask compares by its last path segment, like the matcher", () => {
    const { cfg, notes } = applyPolicy(cfgOf({ caskExclude: ["homebrew/cask/foo"] }), parsePolicy(E({ caskExclude: [entry("foo")] })));
    expect(notes).toEqual([]);
    expect(cfg.caskExclude).toEqual(["homebrew/cask/foo", "foo"]);
    expect(applyPolicy(cfgOf({ caskExclude: ["foo"] }), undefined).notes).toHaveLength(1);
  });
  test("the warning names the policy file in use", () => {
    const { notes } = applyPolicy(cfgOf({ caskExclude: ["one"] }), undefined, "named-policy.json");
    expect(notes).toEqual(['policy: WARNING ownerless: caskExclude "one" has no owner and reason in named-policy.json']);
  });
  test("a broken policy file does not stop readiness", async () => {
    const c = host({}, "{ not json");
    const h = fakeHost();
    await expect(readinessMain({ mode: "readiness", config: c.config, host: "hosta" }, { exec: h.exec, fs: h.fs, out: () => {} })).resolves.toBeNumber();
    await expect(run(c.config)).rejects.toThrow(/not valid JSON/);
  });
  test("the union keeps both cask spellings, so the pending list has no item for the cask", () => {
    const { cfg } = applyPolicy(cfgOf({ caskExclude: ["homebrew/cask/foo"] }), parsePolicy(E({ caskExclude: [entry("foo")] })));
    const outdated = E({ formulae: [], casks: [{ token: "foo", current_version: "2.0" }, { token: "bar", current_version: "1.0" }] });
    expect(pendingFromOutdated(outdated, cfg.caskExclude)).toEqual(["bar=1.0"]);
  });
  test("a holdFile compares exactly: a trailing slash is another path", () => {
    const cfg = cfgOf({ deferred: [{ name: "svc", waiter: "/w", holdFile: "/etc/hosts", quarantineFile: "/q", outcomeFile: "/o", restartLog: "/r" }] });
    expect(applyPolicy(cfg, parsePolicy(E({ holdFile: [entry("/etc/hosts/")] }))).notes).toHaveLength(1);
    expect(applyPolicy(cfg, parsePolicy(E({ holdFile: [entry("/etc/hosts")] }))).notes).toEqual([]);
    expect(() => parsePolicy(E({ holdFile: [entry("/etc/hosts/"), entry("/etc/hosts")] }))).not.toThrow();
  });
  test("a policy-sourced cask exclusion logs its owner and reason; a config-sourced one logs as today", async () => {
    const c = host({ caskExclude: ["cfgcask"] }, E({ caskExclude: [entry("polcask", { owner: "team-b", reason: "self-updates" })] }));
    const h = fakeHost({ casks: "cfgcask\npolcask\n" });
    const r = await applyMain({ mode: "apply", config: c.config, dryRun: true, host: "hosta" }, { exec: h.exec, fs: h.fs, out: () => {} });
    const lines = r.text.split("\n").filter((l) => l.includes("excluding"));
    expect(lines).toEqual([
      "  excluding cfgcask (CASK_EXCLUDE — self-updates / too heavy to reinstall)",
      '  excluding polcask (CASK_EXCLUDE — self-updates / too heavy to reinstall; policy owner "team-b", reason "self-updates")',
    ]);
  });
  test("a policy-sourced pin root logs its owner and reason", async () => {
    const c = host({}, E({ pinRoots: [entry("/srv/c", { owner: "team-c", reason: "pins live here" })] }));
    const r = await run(c.config);
    expect(r.text).toContain('  pin root "/srv/c" from the policy: owner "team-c", reason "pins live here"');
  });
  test("a duplicate key in the policy JSON fails, naming the key", () => {
    const dupGroup = `{"caskExclude":[{"value":"a"}],"caskExclude":[]}`;
    expect(() => parsePolicy(dupGroup, "p.json")).toThrow('p.json: duplicate key "caskExclude"');
    const dupEntry = `{"caskExclude":[{"value":"a","owner":"o","owner":"p","reason":"r"}]}`;
    expect(() => parsePolicy(dupEntry, "p.json")).toThrow('p.json: duplicate key "owner"');
    expect(parsePolicy(`{"caskExclude":[{"value":"a","owner":"o","reason":"r"}],"pinRoots":[]}`).caskExclude).toHaveLength(1);
  });
  test("a cask exclusion hides no outdated formula of the same name from the pending tracker", async () => {
    const c = host({}, E({ caskExclude: [entry("foo")] }));
    const h = fakeHost({ formulas: "foo", verbose: "foo (1.0) < 1.1", formulaTaps: { foo: "homebrew/core" }, upgradeRc: { foo: 1 } });
    await applyMain({ mode: "apply", config: c.config, dryRun: false, host: "hosta" }, { exec: h.exec, fs: h.fs, out: () => {} });
    expect(h.files.get(join(c.dir, "state", "pending-state.tsv"))).toContain("foo=9.9");
  });
  test("an unknown policy key prints escaped", () => {
    expect(() => parsePolicy(E({ "a\nb\u001b": [] }), "p.json")).toThrow('p.json: unknown key "a\\nb\\u001b"');
  });
});
