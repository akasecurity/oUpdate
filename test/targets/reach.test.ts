// Reach: local hands over Exec, git fetches the base branch and pins its commit, a plugin's reach opens through its plugin, everything else is "not built yet".
import { describe, expect, test } from "bun:test";
import { gceBroker, openReach } from "../../src/targets/reach.ts";
import { makeRegistry } from "../../src/targets/registry.ts";
import { fakeExec, gitArgs, gitRule } from "./fakes.ts";
import { GCE_REACH } from "./fake-gce.ts";

const SHA = "a".repeat(40);
const GIT = { kind: "git" as const, repo: "/repo", remote: "origin", base: "main" };

describe("openReach", () => {
  test("local is open with the given exec", async () => {
    const { exec } = fakeExec([]);
    const h = await openReach({ kind: "local" }, exec, 1000);
    expect(h).toEqual({ ok: true, open: { kind: "local", exec } });
  });

  test.each([
    [{ kind: "vm-agent" as const, vm: "vm-one", agent: "agent-one" }, "reach vm-agent not built yet"],
    [{ kind: "docker" as const, on: "laptop" }, "reach docker not built yet"],
  ])("%p is not built yet and runs nothing", async (reach, why) => {
    const { exec, calls } = fakeExec([]);
    expect(await openReach(reach, exec, 1000)).toEqual({ ok: false, why });
    expect(calls).toHaveLength(0);
  });

  test("gce-patch opens with no call: its broker, project and VMs", async () => {
    const { exec, calls } = fakeExec([]);
    expect(await openReach(GCE_REACH, exec, 1000)).toEqual({
      ok: true,
      open: { kind: "gce-patch", exec, broker: { client: "/opt/broker-client", baseUrl: "https://broker.example.invalid", readAction: "cloud.osc.read", patchAction: "cloud.osc.patch" }, project: "example-proj", vms: ["vm-a", "vm-b"] },
    });
    expect(calls).toHaveLength(0);
    expect(gceBroker({ ...GCE_REACH, actions: ["cloud.osc.read"] })).toEqual({ client: "/opt/broker-client", baseUrl: "https://broker.example.invalid", readAction: "cloud.osc.read" });
  });

  test("git fetches only the base branch, then resolves its commit", async () => {
    const { exec, calls } = fakeExec([gitRule(["fetch"], {}), gitRule(["rev-parse"], { out: `${SHA}\n` })]);
    const h = await openReach(GIT, exec, 1000);
    expect(h).toEqual({ ok: true, open: { kind: "git", exec, repo: "/repo", remote: "origin", base: "main", baseSha: SHA } });
    expect(calls.map((c) => c.argv.slice(0, 3))).toEqual([["git", "-C", "/repo"], ["git", "-C", "/repo"]]);
    expect(gitArgs(calls[0]!)).toEqual(["fetch", "--quiet", "--no-tags", "origin", "+refs/heads/main:refs/remotes/origin/main"]);
    expect(gitArgs(calls[1]!)).toEqual(["rev-parse", "--verify", "--quiet", "refs/remotes/origin/main^{commit}"]);
    expect(calls[0]!.env).toEqual({ GIT_TERMINAL_PROMPT: "0" });
    expect(calls[0]!.timeoutMs).toBe(1000);
  });

  test("a failed fetch is not checked, with the reason", async () => {
    const { exec } = fakeExec([gitRule(["fetch"], { rc: 128, err: "fatal: could not read from remote\nmore" })]);
    expect(await openReach(GIT, exec, 1000)).toEqual({ ok: false, why: "reach git: fetch of main from origin failed (rc 128: fatal: could not read from remote)" });
  });

  test("a base that does not resolve to a commit is not checked", async () => {
    const { exec } = fakeExec([gitRule(["fetch"], {}), gitRule(["rev-parse"], { out: "not-a-sha\n" })]);
    expect(await openReach(GIT, exec, 1000)).toEqual({ ok: false, why: "reach git: origin/main does not resolve to a commit" });
  });

  test("a plugin's reach is opened by its plugin; with no plugin loaded it is not checked and runs nothing", async () => {
    const { exec, calls } = fakeExec([]);
    const reach = { kind: "box", plugin: true as const };
    const reg = makeRegistry([{ reaches: { box: { parse: () => reach, open: async (_r, e) => ({ ok: true, open: { kind: "box", plugin: true, exec: e } }) } } }]);
    expect(await openReach(reach, exec, 1000, reg)).toEqual({ ok: true, open: { kind: "box", plugin: true, exec } });
    expect(await openReach(reach, exec, 1000)).toEqual({ ok: false, why: "reach box has no plugin loaded" });
    expect(calls).toHaveLength(0);
  });
});
