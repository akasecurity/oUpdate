// The targets file: strict keys, one id and one status file per target, reach kinds declared even when
// not built, and pin-bump only over a git reach.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";
import { parseTargetsConfig } from "../../src/targets/config.ts";
import { groupKeys } from "../../src/targets/pins/config.ts";
import { isDue, isPluginLeg } from "../../src/targets/model.ts";
import { testRegistry } from "./fake-broker.ts";
import { makeRegistry } from "../../src/targets/registry.ts";

const PIN_LEG = {
  kind: "pin-bump",
  pinsPath: "img/pins.env",
  branchPrefix: "oupdate/",
  proposalDir: "/asks",
  groups: [{ source: "npm", name: "cli", package: "@scope/cli", versionKey: "CLI_VERSION", integrity: {} }],
};
const GP = { kind: "gce-patch" as const, project: "proj-one", vms: ["vm-one", "vm-two"], actions: ["cloud.osc.read", "cloud.osc.patch"], baseUrl: "https://broker.example.invalid" };
const ROOT = () => ({
  logDir: "/srv/oupdate/log",
  reviewer: { type: "command", name: "local", argv: ["/bin/cat"] },
  targets: [
    { id: "images", os: "linux", reach: { kind: "git", repo: "/repo" }, legs: [PIN_LEG], schedule: "weekly:sun", summaryTo: "/srv/oupdate/status/images.tsv" },
    { id: "host-a", os: "test-os", reach: { kind: "test-broker" }, legs: [{ kind: "docker-compose" }, { kind: "test-leg" }], schedule: "nightly", summaryTo: "/srv/oupdate/status/host-a.tsv" },
    { id: "vm-one", os: "linux", reach: { kind: "vm-agent", vm: "vm-one", agent: "agent-one" }, legs: [{ kind: "docker-compose" }], schedule: "nightly", summaryTo: "/srv/oupdate/status/vm-one.tsv" },
    { id: "stack", os: "macos", reach: { kind: "docker", on: "images" }, legs: [{ kind: "docker-compose" }], schedule: "nightly", summaryTo: "/srv/oupdate/status/stack.tsv" },
    { id: "laptop", os: "macos", reach: { kind: "local" }, legs: [{ kind: "brew" }], schedule: "nightly", summaryTo: "/srv/oupdate/status/laptop.tsv" },
    { id: "vm-set", os: "linux", reach: GP, legs: [{ kind: "os-packages", seenTo: "/srv/oupdate/state/vm-set-seen.json" }], schedule: "nightly", summaryTo: "/srv/oupdate/status/vm-set.tsv" },
  ],
});
const REG = testRegistry();
const parse = (v: unknown) => parseTargetsConfig(JSON.stringify(v), process.env, REG);
const withTarget = (i: number, over: Record<string, unknown>) => {
  const r = ROOT();
  (r.targets as Record<string, unknown>[])[i] = { ...r.targets[i], ...over };
  return r;
};

describe("parseTargetsConfig", () => {
  test("parses every reach kind and fills git defaults", () => {
    const c = parse(ROOT());
    expect(c.logDir).toBe("/srv/oupdate/log");
    expect(c.reviewer).toMatchObject({ type: "command", name: "local" });
    expect(c.targets.map((t) => t.reach.kind)).toEqual(["git", "test-broker", "vm-agent", "docker", "local", "gce-patch"]);
    expect(c.targets[0]!.reach).toEqual({ kind: "git", repo: "/repo", remote: "origin", base: "main" });
    expect(c.targets[0]!.schedule).toEqual({ every: "week", day: 0 });
    expect(c.targets[1]!.schedule).toEqual({ every: "night" });
    expect(c.targets[0]!.legs[0]).toMatchObject({ kind: "pin-bump", cooldownDays: 2 });
    expect(c.targets[1]!.legs).toEqual([{ kind: "docker-compose", apply: false, prune: true }, { kind: "test-leg", plugin: true }]);
  });

  test("gce-patch needs a project id, distinct VM names, one read action, at most one patch action and a base URL", () => {
    const at = (reach: unknown) => () => parse(withTarget(5, { reach }));
    expect(parse(ROOT()).targets[5]!.reach).toEqual({ ...GP, client: "broker-client" });
    expect(at({ ...GP, project: "Proj_One" })).toThrow("targets[5].reach.project");
    expect(at({ ...GP, vms: [] })).toThrow("targets[5].reach.vms must be a non-empty array");
    expect(at({ ...GP, vms: ["vm-one", "*"] })).toThrow("targets[5].reach.vms");
    expect(at({ ...GP, vms: ["vm-one", "vm-one"] })).toThrow("targets[5].reach.vms");
    expect(at({ ...GP, filter: "all" })).toThrow("targets[5].reach: unknown key filter");
    expect(at({ ...GP, actions: ["cloud.osc.patch"] })).toThrow("targets[5].reach.actions must be one <name>.read action and at most one <name>.patch action");
    expect(at({ ...GP, actions: ["cloud.osc.read", "cloud.osc.write"] })).toThrow("targets[5].reach.actions must be one <name>.read action and at most one <name>.patch action");
    expect(at({ ...GP, baseUrl: undefined })).toThrow("targets[5].reach.baseUrl is required");
    expect(at({ ...GP, client: "bin/broker-client" })).toThrow("targets[5].reach.client must be an absolute path");
  });

  test("a plugin's older key names are read as the current ones, and its client command is the default", () => {
    const reg = { ...REG, compat: makeRegistry([{ compat: { configKeys: { brokerCmd: "client", askDir: "proposalDir" }, brokerClient: { command: "legacy-client" } } }]).compat };
    const text = (reach: unknown) => JSON.stringify(withTarget(5, { reach }));
    expect(parseTargetsConfig(text(GP), {}, reg).targets[5]!.reach).toEqual({ ...GP, client: "legacy-client" });
    expect(parseTargetsConfig(text({ ...GP, brokerCmd: "/opt/old" }), {}, reg).targets[5]!.reach).toEqual({ ...GP, client: "/opt/old" });
    // Both names at once: the current one wins and the strict parser names the old one.
    expect(() => parseTargetsConfig(text({ ...GP, brokerCmd: "/opt/old", client: "/opt/new" }), {}, reg)).toThrow("targets[5].reach: unknown key brokerCmd");
    const { proposalDir, ...rest } = PIN_LEG;
    const asks = withTarget(0, { legs: [{ ...rest, askDir: proposalDir }] });
    expect(parseTargetsConfig(JSON.stringify(asks), {}, reg).targets[0]!.legs[0]).toMatchObject({ kind: "pin-bump", proposalDir: "/asks" });
  });

  test("a VM appears in at most one gce-patch target, across projects too", () => {
    const two = ROOT();
    (two.targets as Record<string, unknown>[])[2] = { id: "vm-two", os: "linux", reach: { ...GP, vms: ["vm-three", "vm-one"] }, legs: [{ kind: "os-packages", seenTo: "/srv/oupdate/state/vm-two-seen.json" }], schedule: "nightly", summaryTo: "/srv/oupdate/status/vm-two.tsv" };
    expect(() => parse(two)).toThrow("targets[5].reach.vms: vm-one is already in gce-patch target vm-two");
    (two.targets as Record<string, unknown>[])[2] = { id: "vm-two", os: "linux", reach: { ...GP, project: "proj-two", vms: ["vm-one"] }, legs: [{ kind: "os-packages", seenTo: "/srv/oupdate/state/vm-two-seen.json" }], schedule: "nightly", summaryTo: "/srv/oupdate/status/vm-two.tsv" };
    expect(() => parse(two)).toThrow("targets[5].reach.vms: vm-one is already in gce-patch target vm-two");
  });

  test("os-packages: defaults, a linux gce-patch target only, apply only with a patch action, and its own first-seen file", () => {
    expect(parse(ROOT()).targets[5]!.legs).toEqual([{ kind: "os-packages", apply: false, cooldownDays: 2, approvalWaitS: 3600, seenTo: "/srv/oupdate/state/vm-set-seen.json" }]);
    const legAt = (l: Record<string, unknown>, over: Record<string, unknown> = {}) => () => parse(withTarget(5, { legs: [{ kind: "os-packages", seenTo: "/s/seen.json", ...l }], ...over }));
    expect(legAt({ apply: true, cooldownDays: 0, approvalWaitS: 600 })().targets[5]!.legs[0]).toEqual({ kind: "os-packages", apply: true, cooldownDays: 0, approvalWaitS: 600, seenTo: "/s/seen.json" });
    expect(legAt({}, { os: "macos" })).toThrow("targets[5].legs[0]: os-packages needs a linux target with a gce-patch reach");
    expect(legAt({}, { reach: { kind: "vm-agent", vm: "vm-one", agent: "agent-one" } })).toThrow("targets[5].legs[0]: os-packages needs a linux target with a gce-patch reach");
    expect(legAt({ apply: true }, { reach: { ...GP, actions: ["cloud.osc.read"] } })).toThrow("targets[5].legs[0]: apply needs a gce-patch reach with a .patch action");
    expect(legAt({ seenTo: "seen.json" })).toThrow("targets[5].legs[0].seenTo must be an absolute path");
    expect(legAt({ seenTo: "/s/seen.txt" })).toThrow("targets[5].legs[0].seenTo must end in .json");
    expect(legAt({ approvalWaitS: 30 })).toThrow("targets[5].legs[0].approvalWaitS must be a whole number of seconds from 60 to 5400");
    expect(legAt({ approvalWaitS: 6000 })).toThrow("targets[5].legs[0].approvalWaitS must be a whole number of seconds from 60 to 5400");
    expect(legAt({ extra: 1 })).toThrow("targets[5].legs[0]: unknown key extra");
    const two = ROOT();
    (two.targets as Record<string, unknown>[])[2] = { id: "vm-two", os: "linux", reach: { ...GP, vms: ["vm-three"] }, legs: [{ kind: "os-packages", seenTo: "/srv/oupdate/state/vm-set-seen.json" }], schedule: "nightly", summaryTo: "/srv/oupdate/status/vm-two.tsv" };
    expect(() => parse(two)).toThrow("targets[5]: seenTo /srv/oupdate/state/vm-set-seen.json is used twice");
  });


  test("not JSON, unknown keys and an empty list are errors", () => {
    expect(() => parseTargetsConfig("{")).toThrow("targets config is not valid JSON");
    expect(() => parse({ ...ROOT(), extra: 1 })).toThrow("config: unknown key extra");
    expect(() => parse(withTarget(0, { extra: 1 }))).toThrow("targets[0]: unknown key extra");
    expect(() => parse({ ...ROOT(), targets: [] })).toThrow("config.targets must be a non-empty array");
    expect(() => parse({ ...ROOT(), logDir: "log" })).toThrow("config.logDir must be an absolute path");
  });

  test("ids and status files are unique and well formed", () => {
    expect(() => parse(withTarget(1, { id: "images" }))).toThrow("targets[1]: id images is used twice");
    expect(() => parse(withTarget(1, { summaryTo: "/srv/oupdate/status/images.tsv" }))).toThrow("targets[1]: summaryTo /srv/oupdate/status/images.tsv is used twice");
    expect(() => parse(withTarget(0, { id: "Lane Images" }))).toThrow("targets[0].id is not valid");
    expect(() => parse(withTarget(0, { summaryTo: "/srv/x.txt" }))).toThrow("targets[0].summaryTo must end in .tsv");
  });

  // Review: "." and ".." aliases of one status file are the same file at write time.
  test.each(["/srv/oupdate/status/./images.tsv", "/srv/oupdate/other/../status/images.tsv", "/srv//oupdate/status/images.tsv"])("summaryTo alias %p is used twice", (alias) => {
    expect(() => parse(withTarget(1, { summaryTo: alias }))).toThrow("targets[1]: summaryTo /srv/oupdate/status/images.tsv is used twice");
  });

  test("summaryTo is stored normalized", () => {
    expect(parse(withTarget(1, { summaryTo: "/srv/oupdate/x/../status/./box.tsv" })).targets[1]!.summaryTo).toBe("/srv/oupdate/status/box.tsv");
  });

  test("os, reach, legs and schedule are checked", () => {
    expect(() => parse(withTarget(0, { os: "windows" }))).toThrow("targets[0].os must be macos, linux or test-os");
    expect(() => parse(withTarget(0, { reach: { kind: "ssh" } }))).toThrow("targets[0].reach.kind must be local, git, vm-agent, gce-patch, docker or test-broker");
    expect(() => parse(withTarget(0, { reach: { kind: "git", repo: "/repo", base: "a/../b" } }))).toThrow("targets[0].reach.base must be a branch name");
    expect(() => parse(withTarget(1, { reach: { kind: "test-broker", extra: 1 } }))).toThrow("targets[1].reach: unknown key extra");
    expect(() => parse(withTarget(3, { reach: { kind: "docker", on: "nowhere" } }))).toThrow("targets[3].reach.on names no other target: nowhere");
    expect(() => parse(withTarget(3, { reach: { kind: "docker", on: "stack" } }))).toThrow("targets[3].reach.on names no other target: stack");
    expect(() => parse(withTarget(0, { legs: [] }))).toThrow("targets[0].legs must be a non-empty array");
    expect(() => parse(withTarget(0, { legs: [{ kind: "flatpak" }] }))).toThrow("targets[0].legs[0].kind must be pin-bump, os-packages or one of");
    expect(() => parse(withTarget(1, { legs: [{ kind: "test-leg", extra: 1 }] }))).toThrow("targets[1].legs[0]: unknown key extra");
    expect(() => parse(withTarget(0, { schedule: "hourly" }))).toThrow('targets[0].schedule must be "nightly" or "weekly:<sun|mon|tue|wed|thu|fri|sat>"');
  });

  test("pin-bump needs a git reach", () => {
    expect(() => parse(withTarget(4, { legs: [PIN_LEG] }))).toThrow("targets[4].legs[0]: pin-bump needs a git reach");
  });

  test("one git target can carry two pin-bump legs, pins.env and host-pins.env", () => {
    const text = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "fixtures/two-pin-legs.json"), "utf8");
    const c = parseTargetsConfig(text);
    expect(c.targets).toHaveLength(1);
    const t = c.targets[0]!;
    expect(t.reach).toEqual({ kind: "git", repo: "/repo/example", remote: "origin", base: "main" });
    expect(t.legs.map((l) => (!isPluginLeg(l) && l.kind === "pin-bump" ? l.pinsPath : l.kind))).toEqual(["sandbox/base/pins.env", "sandbox/base/host-pins.env"]);
    const host = t.legs[1];
    if (!host || isPluginLeg(host) || host.kind !== "pin-bump") throw new Error("second leg is not pin-bump");
    expect(host).toMatchObject({ branchPrefix: "oupdate/", proposalDir: "/srv/oupdate/proposals", push: false, cooldownDays: 2 });
    expect(host.groups.map((g) => g.name)).toEqual(["vmtool", "ctrtool", "docker-cli"]);
    const vmtool = host.groups[0];
    if (vmtool?.source !== "github-release") throw new Error("vmtool is not github-release");
    expect(vmtool.assetKeys).toEqual({ VMTOOL_ASSET: "vmtool-{v}-Darwin-arm64.tar.gz" });
    const ctrtool = host.groups[1];
    if (ctrtool?.source !== "github-release") throw new Error("ctrtool is not github-release");
    expect(ctrtool.assetKeys).toEqual({ CTRTOOL_ASSET: "ctrtool-Darwin-arm64" });
    expect(host.groups[2]).toMatchObject({ source: "docker-static", propose: false });
    expect(host.groups.flatMap(groupKeys).sort()).toEqual(["CTRTOOL_ASSET", "CTRTOOL_SHA256", "CTRTOOL_VERSION", "DOCKER_CLI_ASSET", "DOCKER_CLI_SHA256", "DOCKER_CLI_VERSION", "VMTOOL_ASSET", "VMTOOL_SHA256", "VMTOOL_VERSION"]);
  });

  test("isDue: nightly every day, weekly on its day only", () => {
    const sun = new Date(2026, 9, 25, 3, 0);
    const mon = new Date(2026, 9, 26, 3, 0);
    expect(isDue({ every: "night" }, sun)).toBe(true);
    expect(isDue({ every: "week", day: 0 }, sun)).toBe(true);
    expect(isDue({ every: "week", day: 0 }, mon)).toBe(false);
  });

  test("docker-compose: apply defaults to false and prune to true; apply needs a reach with a write action", () => {
    const legs = (l: unknown[], reach?: unknown) => parse(withTarget(1, { legs: l, ...(reach ? { reach } : {}) })).targets[1]!.legs;
    expect(legs([{ kind: "docker-compose", prune: false }])).toEqual([{ kind: "docker-compose", apply: false, prune: false }]);
    expect(() => legs([{ kind: "docker-compose", apply: true }])).toThrow("targets[1].legs[0]: apply needs a reach with a write action");
    expect(() => parse(withTarget(2, { legs: [{ kind: "docker-compose", apply: true }] }))).toThrow("targets[2].legs[0]: apply needs a reach with a write action");
    expect(legs([{ kind: "docker-compose", apply: true }], { kind: "test-broker", write: true })).toEqual([{ kind: "docker-compose", apply: true, prune: true }]);
    expect(() => legs([{ kind: "docker-compose", apply: "yes" }])).toThrow("targets[1].legs[0].apply must be true or false");
  });

  test("a plugin's kinds parse only with the plugin loaded, and its leg check applies", () => {
    expect(() => parse(withTarget(2, { legs: [{ kind: "test-leg" }] }))).toThrow("targets[2].legs[0]: test-leg needs a test-broker reach");
    expect(() => parseTargetsConfig(JSON.stringify(ROOT()))).toThrow("targets[1].os must be macos or linux");
    expect(() => parseTargetsConfig(JSON.stringify(withTarget(1, { os: "linux" })))).toThrow("targets[1].reach.kind must be local, git, vm-agent, gce-patch or docker");
    expect(() => parseTargetsConfig(JSON.stringify(withTarget(1, { os: "linux", reach: { kind: "local" } })))).toThrow("targets[1].legs[1].kind must be pin-bump, os-packages or one of docker-compose, brew");
  });

  test("parityTo and secondReviewer", () => {
    expect(parse({ ...ROOT(), secondReviewer: { type: "command", name: "second", argv: ["/bin/cat"] } }).secondReviewer?.name).toBe("second");
    expect(parse(withTarget(1, { parityTo: "/srv/oupdate/parity/box.jsonl" })).targets[1]!.parityTo).toBe("/srv/oupdate/parity/box.jsonl");
    expect(() => parse(withTarget(1, { parityTo: "/srv/oupdate/parity/box.tsv" }))).toThrow("targets[1].parityTo must end in .jsonl");
    expect(() => parse(withTarget(1, { parityTo: "parity.jsonl" }))).toThrow("targets[1].parityTo must be an absolute path");
  });
  test("${NAME} in a config value is read from the environment; unset or empty is an error naming it (#9)", () => {
    const text = JSON.stringify({ ...ROOT(), logDir: "${OUP_LOG}/log" });
    expect(parseTargetsConfig(text, { OUP_LOG: "/srv/oupdate" }, REG).logDir).toBe("/srv/oupdate/log");
    expect(() => parseTargetsConfig(text, {}, REG)).toThrow("OUP_LOG");
    expect(() => parseTargetsConfig(text, { OUP_LOG: "" }, REG)).toThrow("OUP_LOG");
  });
});
