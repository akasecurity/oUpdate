// One patch request per VM: only the run id and the verdict, a verdict for every candidate name, never an empty list,
// a card's outcome and every lost reply mapped as the NAS legs map them, and the latch after anything unclean.
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { Exec } from "../../src/apply/exec.ts";
import { gceRead, newGceSession } from "../../src/targets/gce/broker.ts";
import { gcePatch, newLatch, patchSummary, type PatchLatch } from "../../src/targets/gce/patch.ts";
import { approvedNames, patchVerdict, type PatchVerdict } from "../../src/targets/gce/verdict.ts";
import { DIGEST_TROUBLE } from "../../src/targets/summary.ts";
import { fakeExec } from "./fakes.ts";
import { fakeGce, GCE, inv, inventory, jobOf, runOf, VM_A, type FakeReply } from "./fake-gce.ts";
import { OTHER_RUN } from "./fake-gce.ts";
import { BOOT, BOOT2 } from "./fake-gce.ts";

const R = { primary: "first-model", secondary: "secondary-model" };
const APPROVE = new Set(["openssl", "libssl3t64"]);

async function minted(patch?: FakeReply, wrap?: (e: Exec) => Exec) {
  const f = fakeGce({ vms: { [VM_A]: { inventory: [inventory()], ...(patch ? { replies: { patch } } : {}) } } });
  const t = fakeExec([f.rule]);
  const exec = wrap ? wrap(t.exec) : t.exec;
  const s = newGceSession(VM_A);
  await gceRead(GCE, exec, s, "inventory");
  return { exec, calls: t.calls, requests: f.requests, s, v: patchVerdict(inv(), APPROVE, R, s) };
}

describe("patchVerdict", () => {
  test("names every candidate name, approves only the approved, and hashes the VM's inventory answers", async () => {
    const { v, requests } = await minted();
    expect(v).toEqual({ items: { curl: "HOLD", libssl3t64: "APPROVE", openssl: "APPROVE" }, reviewers: R, evidence_sha256: createHash("sha256").update(JSON.stringify(JSON.parse(requests[0]!.out!).result)).digest("hex") });
    expect(approvedNames(v)).toEqual(["libssl3t64", "openssl"]);
  });

  test("a name that is not a candidate is never approved", async () => {
    const { s } = await minted();
    expect(patchVerdict(inv(), new Set(["bash"]), R, s).items).toEqual({ curl: "HOLD", libssl3t64: "HOLD", openssl: "HOLD" });
  });
});

describe("gcePatch", () => {
  test("one request with only the run id and the verdict; the job starts", async () => {
    const { exec, calls, requests, s, v } = await minted();
    const r = await gcePatch(GCE, exec, s, v, newLatch(), 3600);
    expect(r).toEqual({ outcome: "started", jobId: jobOf(VM_A), sent: ["libssl3t64", "openssl"], dropped: [], why: `patch: job ${jobOf(VM_A)} started for 2 package(s)`, requestId: "req-2" });
    expect(calls[1]!.argv).toEqual(["/opt/credreq", "cloud.osc.patch", VM_A, "--why", "oupdate patch", "--wait", "3900", "--param", "verb=patch", "--param", `run_id=${runOf(VM_A)}`, "--param-json", `verdict=${JSON.stringify(v)}`]);
    expect(Object.keys(requests[1]!.params).sort()).toEqual(["run_id", "verb", "verdict"]);
  });

  test("names the broker dropped before execute are listed", async () => {
    const { exec, s, v } = await minted({ status: "approved", result: { run_id: runOf(VM_A), seq: 2, job_id: jobOf(VM_A), sent: ["openssl"] } });
    expect(await gcePatch(GCE, exec, s, v, newLatch(), 3600)).toMatchObject({ outcome: "started", sent: ["openssl"], dropped: ["libssl3t64"], why: `patch: job ${jobOf(VM_A)} started for 1 package(s); the broker dropped 1 before execute: libssl3t64` });
  });

  test("an empty list, too many names or no run is never sent", async () => {
    const { exec, calls, s } = await minted();
    const none = patchVerdict(inv(), new Set(), R, s);
    expect(await gcePatch(GCE, exec, s, none, newLatch(), 3600)).toEqual({ outcome: "refused", sent: false, why: "patch: not asked: no package is approved (an empty list is never sent)" });
    const many: PatchVerdict = { items: Object.fromEntries(Array.from({ length: 201 }, (_, i) => [`pkg-${i}`, "APPROVE" as const])), reviewers: R, evidence_sha256: "0".repeat(64) };
    expect(await gcePatch(GCE, exec, s, many, newLatch(), 3600)).toEqual({ outcome: "refused", sent: false, why: "patch: not asked: 201 approved names, over the 200-name cap" });
    expect(await gcePatch(GCE, exec, newGceSession(VM_A), none, newLatch(), 3600)).toEqual({ outcome: "refused", sent: false, why: "patch: no broker run for this VM" });
    expect(await gcePatch({ ...GCE, patchAction: undefined }, exec, s, none, newLatch(), 3600)).toEqual({ outcome: "refused", sent: false, why: "patch: the reach names no patch action" });
    expect(calls).toHaveLength(1);
  });

  test.each([
    ["a card still pending", { status: "pending" }, "patch: waits on a card on the page and may still run"],
    ["a broker withheld", { status: "withheld", reason: "locked" }, "patch: broker withheld: locked"],
    ["an approval with no job id", { status: "approved", result: { run_id: runOf(VM_A), seq: 2, sent: ["openssl"] } }, "patch: approved with no valid job id: outcome unknown"],
    ["a sent list naming an unapproved package", { status: "approved", result: { run_id: runOf(VM_A), seq: 2, job_id: jobOf(VM_A), sent: ["openssl", "bash"] } }, `patch: job ${jobOf(VM_A)}: the broker's sent list is not a non-empty subset of the approved names`],
    ["a refusal for another run", { status: "approved", result: { run_id: OTHER_RUN, seq: 2, refused: "x" } }, `patch: a refusal for another run (${OTHER_RUN}, expected ${runOf(VM_A)}): x`],
    ["a started reply with no seq", { status: "approved", result: { run_id: runOf(VM_A), job_id: jobOf(VM_A), sent: ["openssl"] } }, "patch: the broker gave no valid seq"],
    ["a refusal with no seq", { status: "approved", result: { run_id: runOf(VM_A), refused: "gce-osc: role busy" } }, "patch: the broker gave no valid seq"],
    ["a reply that repeats the inventory's seq", { status: "approved", result: { run_id: runOf(VM_A), seq: 1, job_id: jobOf(VM_A), sent: ["openssl"] } }, "patch: the broker's seq 1 repeats"],
    ["a reply under a new boot (the broker restarted)", { status: "approved", result: { run_id: runOf(VM_A), seq: 1, boot: BOOT2, job_id: jobOf(VM_A), sent: ["openssl"] } }, `patch: the broker restarted (boot ${BOOT2.slice(0, 8)}…, was ${BOOT.slice(0, 8)}…): the run is dead`],
    ["a reply with no boot", { status: "approved", result: { run_id: runOf(VM_A), seq: 2, boot: null, job_id: jobOf(VM_A), sent: ["openssl"] } }, "patch: the broker gave no valid boot"],
    ["a reply for another run", { status: "approved", result: { run_id: OTHER_RUN, seq: 2, job_id: jobOf(VM_A), sent: ["openssl"] } }, `patch: the broker's run changed (${OTHER_RUN}, expected ${runOf(VM_A)})`],
  ] as [string, FakeReply, string][])("%s is unknown, never started, and latches (Review Focus 3)", async (_what, reply, why) => {
    const { exec, calls, s, v } = await minted(reply);
    const latch: PatchLatch = newLatch();
    const r = await gcePatch(GCE, exec, s, v, latch, 3600);
    expect(r).toEqual({ outcome: "unknown", why, requestId: "req-2" });
    expect(latch.stopped).toBe(VM_A);
    const again = await gcePatch(GCE, exec, s, v, latch, 3600);
    expect(again).toEqual({ outcome: "refused", sent: false, why: `patch: not asked: an earlier VM this run ended with trouble (${VM_A})` });
    expect(calls).toHaveLength(2);
    const summary = patchSummary(r as Exclude<typeof r, { outcome: "started" }>);
    expect(summary).toBe("FAILED — patch outcome unknown, the patch may have run (the broker's own post-check covers it)");
    expect(summary).not.toContain(OTHER_RUN);
    expect(DIGEST_TROUBLE.test(summary)).toBe(true);
  });

  test("a credreq timeout and an Exec that throws are unknown (Review Focus 3)", async () => {
    const timeout = await minted(undefined, (e) => async (argv, o) => (argv[1] === "cloud.osc.patch" ? { rc: 143, out: "", err: "", timedOut: true } : e(argv, o)));
    expect(await gcePatch(GCE, timeout.exec, timeout.s, timeout.v, newLatch(), 3600)).toEqual({ outcome: "unknown", why: "patch: credreq timed out after 3930 s" });
    const thrown = await minted(undefined, (e) => async (argv, o) => {
      if (argv[1] === "cloud.osc.patch") throw new Error("spawn failed");
      return e(argv, o);
    });
    expect(await gcePatch(GCE, thrown.exec, thrown.s, thrown.v, newLatch(), 3600)).toEqual({ outcome: "unknown", why: "patch: spawn failed" });
  });

  test.each([
    ["a denied card", { status: "denied", reason: "operator said no" }, "patch: card denied, nothing ran: operator said no"],
    ["an expired card", { status: "expired" }, "patch: card expired, nothing ran"],
    ["a broker refusal", { status: "approved", result: { run_id: runOf(VM_A), seq: 2, refused: "gce-osc: approves held" } }, "patch: refused by the broker, nothing ran: gce-osc: approves held"],
    ["a card approved while the role is still busy (Q-5)", { status: "approved", result: { run_id: runOf(VM_A), seq: 2, refused: "gce-osc: role busy" } }, "patch: refused by the broker, nothing ran: gce-osc: role busy"],
    ["a VM the broker suspended (Q-7)", { status: "approved", result: { run_id: runOf(VM_A), seq: 2, refused: "gce-osc: vm suspended" } }, "patch: refused by the broker, nothing ran: gce-osc: vm suspended"],
    ["a Lock epoch change before the send, which voids the intent (rev 15 §8.5)", { status: "approved", result: { run_id: runOf(VM_A), seq: 2, refused: "gce-osc: locked" } }, "patch: refused by the broker, nothing ran: gce-osc: locked"],
  ] as [string, FakeReply, string][])("%s is blocked with nothing ran, and latches", async (_what, reply, why) => {
    const { exec, s, v } = await minted(reply);
    const latch: PatchLatch = newLatch();
    const r = await gcePatch(GCE, exec, s, v, latch, 3600);
    expect(r).toEqual({ outcome: "refused", sent: true, why, requestId: "req-2" });
    expect(latch.stopped).toBe(VM_A);
    expect(patchSummary(r as Exclude<typeof r, { outcome: "started" }>)).toBe("blocked — nothing ran (see the targets log)");
  });

  test("the patch reply's seq is recorded, so a later answer cannot reuse it (rev 13 §8)", async () => {
    const { exec, s, v } = await minted();
    await gcePatch(GCE, exec, s, v, newLatch(), 3600);
    expect(s.seqs).toEqual([1, 2]);
  });

  describe("review-time refusals in the deny reason", () => {
    /** The patch is denied with \`reason\`; job.status by run then answers with seq \`next\`. */
    async function deniedThenStatus(reason: string, next: number) {
      const status: FakeReply = { status: "approved", result: { run_id: runOf(VM_A), seq: next, job_id: jobOf(VM_A), state: "PATCHING", instance_state: "STARTED" } };
      const f = fakeGce({ vms: { [VM_A]: { inventory: [inventory()], replies: { patch: { status: "denied", reason }, "job.status": status } } } });
      const { exec } = fakeExec([f.rule]);
      const s = newGceSession(VM_A);
      await gceRead(GCE, exec, s, "inventory");
      return { exec, s, v: patchVerdict(inv(), APPROVE, R, s) };
    }
    const refusal = (over: Record<string, unknown> = {}) => JSON.stringify({ run_id: runOf(VM_A), seq: 2, boot: BOOT, refused: "gce-osc: verdict refused", ...over });

    test("a patch refused at review takes its seq, so job.status at seq + 1 succeeds", async () => {
      const { exec, s, v } = await deniedThenStatus(refusal(), 3);
      const latch = newLatch();
      expect(await gcePatch(GCE, exec, s, v, latch, 3600)).toEqual({ outcome: "refused", sent: true, why: "patch: refused by the broker, nothing ran: gce-osc: verdict refused", requestId: "req-2" });
      expect(latch.stopped).toBe(VM_A);
      expect(s.seqs).toEqual([1, 2]);
      expect((await gceRead(GCE, exec, s, "job.status", { vm: VM_A })).ok).toBe(true);
      expect(s.seqs).toEqual([1, 2, 3]);
    });

    test("a review-time refusal with a seq gap or for another run is unknown", async () => {
      const gap = await deniedThenStatus(refusal({ seq: 3 }), 4);
      expect(await gcePatch(GCE, gap.exec, gap.s, gap.v, newLatch(), 3600)).toEqual({ outcome: "unknown", why: "patch: the broker's seq 3 is not the next one (expected 2)", requestId: "req-2" });
      const other = await deniedThenStatus(refusal({ run_id: OTHER_RUN }), 3);
      expect(await gcePatch(GCE, other.exec, other.s, other.v, newLatch(), 3600)).toEqual({ outcome: "unknown", why: `patch: a refusal for another run (${OTHER_RUN}, expected ${runOf(VM_A)}): gce-osc: verdict refused`, requestId: "req-2" });
    });

    test("a plain card denial takes no seq; the next answer continues from the last", async () => {
      const { exec, s, v } = await deniedThenStatus("operator said no", 2);
      expect(await gcePatch(GCE, exec, s, v, newLatch(), 3600)).toEqual({ outcome: "refused", sent: true, why: "patch: card denied, nothing ran: operator said no", requestId: "req-2" });
      expect(s.seqs).toEqual([1]);
      expect((await gceRead(GCE, exec, s, "job.status", { vm: VM_A })).ok).toBe(true);
      expect(s.seqs).toEqual([1, 2]);
    });
  });

  test("a VM gets at most one patch request a run, whatever its latch says (attempted before sending)", async () => {
    const { exec, calls, s, v } = await minted();
    const latch = newLatch();
    expect((await gcePatch(GCE, exec, s, v, latch, 3600)).outcome).toBe("started");
    expect(latch.attempted.has(VM_A)).toBe(true);
    expect(await gcePatch(GCE, exec, s, v, latch, 3600)).toEqual({ outcome: "refused", sent: false, why: "patch: not asked: vm-a already had a patch request this run" });
    expect(calls).toHaveLength(2);
  });

  test("no patch is sent on a run whose broker restarted", async () => {
    const { exec, calls, s, v } = await minted();
    s.dead = true;
    expect(await gcePatch(GCE, exec, s, v, newLatch(), 3600)).toEqual({ outcome: "refused", sent: false, why: "patch: not asked: the broker restarted, so the run is dead" });
    expect(calls).toHaveLength(1);
  });
});
