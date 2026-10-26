// Reach: local hands over Exec, git fetches the base branch and pins its commit, broker-script opens with a self read, everything else is "not built yet".
import { describe, expect, test } from "bun:test";
import { gceBroker, nasBroker, openReach } from "../../src/targets/reach.ts";
import { ans, BROKER, nasExec, REACH, SELF } from "./fake-nas.ts";
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
      open: { kind: "gce-patch", exec, broker: { credreq: "/opt/credreq", baseUrl: "https://broker.example.invalid", readAction: "cloud.osc.read", patchAction: "cloud.osc.patch" }, project: "example-proj", vms: ["vm-a", "vm-b"] },
    });
    expect(calls).toHaveLength(0);
    expect(gceBroker({ ...GCE_REACH, actions: ["cloud.osc.read"] })).toEqual({ credreq: "/opt/credreq", baseUrl: "https://broker.example.invalid", readAction: "cloud.osc.read" });
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

  test("broker-script opens with one self read through the broker", async () => {
    const { exec, requests } = nasExec({ answers: { self: SELF } });
    const h = await openReach(REACH, exec, 1000);
    if (!h.ok || h.open.kind !== "broker-script") throw new Error("not open");
    expect(h.open.self.nasos).toBe("7.1.4");
    expect(h.open.broker).toEqual(BROKER);
    expect(h.open.session).toEqual({ evidence: [] });
    expect(requests.map((q) => [q.action, q.host, q.params.verb])).toEqual([["store.oup.read", "box-1", "self"]]);
  });

  test("a broker that refuses self is not checked, with the reason", async () => {
    const { exec } = nasExec({ replies: { self: { status: "denied", reason: "caller not listed" } } });
    expect(await openReach(REACH, exec, 1000)).toEqual({ ok: false, why: "reach broker-script: self: broker denied: caller not listed" });
  });

  test("a self answer that does not decode is not checked", async () => {
    const { exec } = nasExec({ answers: { self: ans([["NASOS", "7.1.4"]]) } });
    expect(await openReach(REACH, exec, 1000)).toEqual({ ok: false, why: "reach broker-script: self: needs two SCRIPT rows and one NASOS, SH and PLUGINS row" });
  });

  test("nasBroker takes the .read and .write actions by suffix", () => {
    expect(nasBroker({ ...REACH, actions: ["store.oup.read"] })).toEqual({ credreq: "/opt/credreq", baseUrl: "https://broker.example.invalid", host: "box-1", readAction: "store.oup.read" });
  });
});
