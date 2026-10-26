// gce-patch reads: one credreq call per read with the VM as the target, the VM's run minted by its first inventory and
// carried after, each inventory answer kept with its seq, and every refusal, run change, cap or seq fault a failure.
import { describe, expect, test } from "bun:test";
import type { Exec } from "../../src/apply/exec.ts";
import { decodeInventory } from "../../src/targets/gce/answer.ts";
import { gceRead, newGceSession } from "../../src/targets/gce/broker.ts";
import { decodeJob, decodeJobByRun } from "../../src/targets/gce/job.ts";
import { patchReply } from "../../src/targets/gce/patch.ts";
import { evidenceSha } from "../../src/targets/nas/broker.ts";
import { BOOT, BOOT2, OTHER_RUN, GCE, gceExec, inventory, job, jobOf, runOf, VM_A, type FakeGce } from "./fake-gce.ts";

const SCENE: FakeGce = { vms: { [VM_A]: { inventory: [inventory(), inventory({ updateTime: "2026-10-26T03:30:00Z" })], jobs: [job(VM_A, "PATCHING", "STARTED")] } } };

describe("gceRead", () => {
  test("the first inventory is one credreq call with the VM as target and no run id; it mints the VM's run", async () => {
    const { exec, calls, requests } = gceExec(SCENE);
    const s = newGceSession(VM_A);
    expect(await gceRead(GCE, exec, s, "inventory")).toEqual({ ok: true, answer: inventory() });
    expect(calls[0]!.argv).toEqual(["/opt/credreq", "cloud.osc.read", VM_A, "--why", "oupdate inventory", "--wait", "315", "--param", "verb=inventory"]);
    expect(calls[0]!.env).toEqual({ CREDBROKER_BASE_URL: "https://broker.example.invalid" });
    expect(calls[0]!.timeoutMs).toBe(345_000);
    expect(s.runId).toBe(runOf(VM_A));
    expect(s.evidence).toEqual([{ seq: 1, answer: JSON.stringify({ run_id: runOf(VM_A), seq: 1, boot: BOOT, ...inventory() }) }]);
  });

  test("later reads carry the run id; job.status carries the job id", async () => {
    const { exec, calls } = gceExec(SCENE);
    const s = newGceSession(VM_A);
    await gceRead(GCE, exec, s, "inventory");
    await gceRead(GCE, exec, s, "inventory");
    expect((await gceRead(GCE, exec, s, "job.status", { job_id: jobOf(VM_A) })).ok).toBe(true);
    expect(calls[1]!.argv.slice(7)).toEqual(["--param", "verb=inventory", "--param", `run_id=${runOf(VM_A)}`]);
    expect(calls[2]!.argv.slice(5)).toEqual(["--wait", "45", "--param", "verb=job.status", "--param", `job_id=${jobOf(VM_A)}`, "--param", `run_id=${runOf(VM_A)}`]);
    expect(s.evidence.map((e) => e.seq)).toEqual([1, 2]);
  });

  test("job.status before the run, with a bad job id or with a missing slot is never sent", async () => {
    const { exec, calls } = gceExec(SCENE);
    const s = newGceSession(VM_A);
    expect(await gceRead(GCE, exec, s, "job.status", { job_id: jobOf(VM_A) })).toEqual({ ok: false, why: "not asked: job.status needs the VM's broker run" });
    s.runId = runOf(VM_A);
    expect(await gceRead(GCE, exec, s, "job.status", { job_id: "job;reboot" })).toEqual({ ok: false, why: "not asked: job.status: job id is not valid" });
    expect(await gceRead(GCE, exec, s, "job.status")).toEqual({ ok: false, why: "not asked: job.status takes job_id, or vm" });
    expect(await gceRead(GCE, exec, s, "job.status", { vm: "vm-b" })).toEqual({ ok: false, why: "not asked: job.status: vm vm-b is not this run's VM (vm-a)" });
    expect(await gceRead(GCE, exec, s, "inventory", { job_id: "x" })).toEqual({ ok: false, why: "not asked: inventory takes no parameters" });
    expect(calls).toHaveLength(0);
  });

  test("a run that changes on a later read is refused", async () => {
    const other = { status: "approved", result: { run_id: OTHER_RUN, seq: 2, ...inventory() } };
    const first = { status: "approved", result: { run_id: runOf(VM_A), seq: 1, ...inventory() } };
    const { exec } = gceExec({ vms: { [VM_A]: { replies: { inventory: (p) => (p.run_id ? other : first) } } } });
    const s = newGceSession(VM_A);
    await gceRead(GCE, exec, s, "inventory");
    expect(await gceRead(GCE, exec, s, "inventory")).toEqual({ ok: false, why: `inventory: the broker's run changed (${OTHER_RUN}, expected ${runOf(VM_A)})` });
  });

  test.each([
    ["a VM the catalog does not hold", {}, "inventory: refused by the broker: gce-osc: unknown vm"],
    ["a VM not set up", { replies: { inventory: { status: "approved", result: { seq: 1, refused: "gce-osc: vm not set up" } } } }, "inventory: refused by the broker: gce-osc: vm not set up"],
    ["a denied read", { replies: { inventory: { status: "denied", reason: "caller not listed" } } }, "inventory: broker denied: caller not listed"],
    ["a result that is not an object", { replies: { inventory: { status: "approved", result: "x" } } }, "inventory: broker result is not an object"],
    ["no run id", { replies: { inventory: { status: "approved", result: { seq: 1, ...inventory() } } } }, "inventory: the broker gave no valid run id"],
    ["no seq", { replies: { inventory: { status: "approved", result: { run_id: runOf(VM_A), ...inventory() } } } }, "inventory: the broker gave no valid seq"],
    ["an answer over its cap", { replies: { inventory: { status: "approved", result: { run_id: runOf(VM_A), seq: 1, ...inventory({ extra: { pad: "x".repeat(2 * 1024 * 1024) } }) } } } }, "inventory: answer is over the 2097152-byte cap"],
  ] as [string, Record<string, unknown>, string][])("%s is a failure with its reason", async (_what, vm, why) => {
    const { exec } = gceExec(Object.keys(vm).length ? { vms: { [VM_A]: vm } } : {});
    expect(await gceRead(GCE, exec, newGceSession(VM_A), "inventory")).toEqual({ ok: false, why });
  });

  test("a repeated seq is refused", async () => {
    const r = { status: "approved", result: { run_id: runOf(VM_A), seq: 1, ...inventory() } };
    const { exec } = gceExec({ vms: { [VM_A]: { replies: { inventory: r } } } });
    const s = newGceSession(VM_A);
    await gceRead(GCE, exec, s, "inventory");
    expect(await gceRead(GCE, exec, s, "inventory")).toEqual({ ok: false, why: "inventory: the broker's seq 1 repeats" });
  });

  test("every answer carries a seq, refusals included, and no seq repeats across verbs (rev 12 §8)", async () => {
    const noSeq = gceExec({ vms: { [VM_A]: { inventory: [inventory()], replies: { "job.status": { status: "approved", result: { run_id: runOf(VM_A), ...job(VM_A, "PATCHING", "STARTED") } } } } } });
    const s1 = newGceSession(VM_A);
    await gceRead(GCE, noSeq.exec, s1, "inventory");
    expect(await gceRead(GCE, noSeq.exec, s1, "job.status", { job_id: jobOf(VM_A) })).toEqual({ ok: false, why: "job.status: the broker gave no valid seq" });
    const again = gceExec({ vms: { [VM_A]: { inventory: [inventory()], replies: { "job.status": { status: "approved", result: { run_id: runOf(VM_A), seq: 1, ...job(VM_A, "PATCHING", "STARTED") } } } } } });
    const s2 = newGceSession(VM_A);
    await gceRead(GCE, again.exec, s2, "inventory");
    expect(await gceRead(GCE, again.exec, s2, "job.status", { job_id: jobOf(VM_A) })).toEqual({ ok: false, why: "job.status: the broker's seq 1 repeats" });
    expect(s2.evidence.map((e) => e.seq)).toEqual([1]);
  });

  test("job.status answers are seq-counted but never evidence; by run it asks with {run_id, vm} (rev 14 §8.6)", async () => {
    const { exec, calls } = gceExec(SCENE);
    const s = newGceSession(VM_A);
    await gceRead(GCE, exec, s, "inventory");
    expect((await gceRead(GCE, exec, s, "job.status", { vm: VM_A })).ok).toBe(true);
    expect(calls[1]!.argv.slice(7)).toEqual(["--param", "verb=job.status", "--param", `vm=${VM_A}`, "--param", `run_id=${runOf(VM_A)}`]);
    expect(s.evidence.map((e) => e.seq)).toEqual([1]);
    expect(s.seqs).toEqual([1, 2]);
  });

  test("a refusal for another run once the run is minted is a run change", async () => {
    const { exec } = gceExec({ vms: { [VM_A]: { replies: { inventory: (p) => (p.run_id ? { status: "approved", result: { run_id: OTHER_RUN, seq: 2, refused: "gce-osc: run expired" } } : { status: "approved", result: { run_id: runOf(VM_A), seq: 1, ...inventory() } }) } } } });
    const s = newGceSession(VM_A);
    await gceRead(GCE, exec, s, "inventory");
    expect(await gceRead(GCE, exec, s, "inventory")).toEqual({ ok: false, why: `inventory: the broker's run changed (${OTHER_RUN}, expected ${runOf(VM_A)}): gce-osc: run expired` });
  });

  test("a refusal's seq is checked and recorded before its reason is read; a seq that goes back is refused", async () => {
    const noSeq = gceExec({ vms: { [VM_A]: { replies: { inventory: { status: "approved", result: { refused: "gce-osc: unknown vm" } } } } } });
    expect(await gceRead(GCE, noSeq.exec, newGceSession(VM_A), "inventory")).toEqual({ ok: false, why: "inventory: the broker gave no valid seq" });
    const refusedFirst = gceExec({ vms: { [VM_A]: { replies: { inventory: { status: "approved", result: { seq: 1, refused: "gce-osc: vm not set up" } } } } } });
    const s1 = newGceSession(VM_A);
    await gceRead(GCE, refusedFirst.exec, s1, "inventory");
    expect(s1.seqs).toEqual([1]);
    const back = gceExec({ vms: { [VM_A]: { inventory: [inventory()] } } });
    const s2 = newGceSession(VM_A);
    s2.seqs.push(4);
    const first = await gceRead(GCE, back.exec, s2, "inventory");
    expect(first).toEqual({ ok: false, why: "inventory: the broker's seq 1 is not the next one (expected 5)" });
  });

  test("seqs run 1, 2, 3 … with no gap: an initial gap and a middle gap are refused (rev 13 §8)", async () => {
    const initial = gceExec({ vms: { [VM_A]: { replies: { inventory: { status: "approved", result: { run_id: runOf(VM_A), seq: 2, ...inventory() } } } } } });
    expect(await gceRead(GCE, initial.exec, newGceSession(VM_A), "inventory")).toEqual({ ok: false, why: "inventory: the broker's seq 2 is not the next one (expected 1)" });
    const middle = gceExec({ vms: { [VM_A]: { inventory: [inventory()], replies: { "job.status": { status: "approved", result: { run_id: runOf(VM_A), seq: 3, ...job(VM_A, "PATCHING", "STARTED") } } } } } });
    const s = newGceSession(VM_A);
    await gceRead(GCE, middle.exec, s, "inventory");
    expect(await gceRead(GCE, middle.exec, s, "job.status", { job_id: jobOf(VM_A) })).toEqual({ ok: false, why: "job.status: the broker's seq 3 is not the next one (expected 2)" });
  });

  test("the evidence sha is rev 14a §8.4: the whole answer object re-serialized as received, in seq order (vector, placeholder values)", async () => {
    // The b129-vectors/evidence-sha.ts vector (rev 15c: hex run id and boot after seq), with only the VM name swapped for
    // a placeholder: seq 1 compact with a \u00e9 escape, seq 3 with spaces and a trailing newline. Its own expected sha is
    // computed the vector's way.
    const a1 = '{"run_id":"7c1d0e9f2a3b4c5d6e7f8091a2b3c4d5","seq":1,"boot":"0f1e2d3c4b5a69788796a5b4c3d2e1f0","vm":"vm-a","instance_id":"123","update_time":"2026-10-26T07:00:00Z","os_info":{"short_name":"ubuntu","version":"24.04","architecture":"x86_64","kernel_version":"6.8.0"},"installed":[{"name":"caf\\u00e9","version":"1"}],"candidates":[{"name":"openssl","installed":"3.0.13-0ubuntu3.4","available":"3.0.13-0ubuntu3.5","broker":{"security":{"suite":"noble-security"}}}]}';
    const a2 = '{ "run_id": "7c1d0e9f2a3b4c5d6e7f8091a2b3c4d5", "seq": 3, "boot": "0f1e2d3c4b5a69788796a5b4c3d2e1f0", "vm": "vm-a", "instance_id": "123", "update_time": "2026-10-26T07:05:00Z", "os_info": {"short_name":"ubuntu","version":"24.04","architecture":"x86_64","kernel_version":"6.8.0"}, "installed": [], "candidates": [{"name":"a<b","installed":"1","available":"2","broker":{"hold":{"reason":"no index row"}}}] }\n';
    const status = JSON.stringify({ run_id: "7c1d0e9f2a3b4c5d6e7f8091a2b3c4d5", seq: 2, boot: "0f1e2d3c4b5a69788796a5b4c3d2e1f0", ...job(VM_A, "PATCHING", "STARTED") });
    const bodies = [a1, status, a2];
    let i = 0;
    const exec: Exec = async () => ({ rc: 0, err: "", out: `{"status":"approved","request_id":"req-${i + 1}","result": ${bodies[i++]}}\n` });
    const s = newGceSession(VM_A);
    expect((await gceRead(GCE, exec, s, "inventory")).ok).toBe(true);
    expect((await gceRead(GCE, exec, s, "job.status", { job_id: jobOf(VM_A) })).ok).toBe(true);
    expect((await gceRead(GCE, exec, s, "inventory")).ok).toBe(true);
    const sha = evidenceSha({ evidence: s.evidence });
    expect(sha).toBe("4bd3921dbd81bdb7eb20ddd082f87acfc6769e0cd83ae1834c732fbb7c6da2b7");
    // Hashing the trimmed raw bodies gives this; it must not match.
    expect(sha).not.toBe("c34ca7982a857797b548e3acfa05656110f610663469d59f5f8716b295c5f826");
  });

  test("refused and failed inventory reads add nothing to the evidence", async () => {
    const { exec } = gceExec({ vms: { [VM_A]: { replies: { inventory: { status: "approved", result: { seq: 1, refused: "gce-osc: vm not set up" } } } } } });
    const s = newGceSession(VM_A);
    await gceRead(GCE, exec, s, "inventory");
    expect(s.evidence).toEqual([]);
  });

  describe("boot (rev 15a §8)", () => {
    test.each([
      ["no boot", { boot: null }],
      ["a boot that is not 32 hex characters", { boot: "ABC" }],
    ] as [string, Record<string, unknown>][])("%s fails closed like a bad seq", async (_what, over) => {
      const { exec } = gceExec({ vms: { [VM_A]: { replies: { inventory: { status: "approved", result: { run_id: runOf(VM_A), seq: 1, ...over, ...inventory() } } } } } });
      const s = newGceSession(VM_A);
      expect(await gceRead(GCE, exec, s, "inventory")).toEqual({ ok: false, why: "inventory: the broker gave no valid boot" });
      expect(s.evidence).toEqual([]);
    });

    test("a boot change on an inventory read is a dead run: refused, no evidence, and no later read is sent", async () => {
      const { exec, requests } = gceExec({ vms: { [VM_A]: { replies: { inventory: (p) => ({ status: "approved", result: { run_id: runOf(VM_A), ...(p.run_id ? { seq: 1, boot: BOOT2 } : { seq: 1 }), ...inventory() } }) } } } });
      const s = newGceSession(VM_A);
      await gceRead(GCE, exec, s, "inventory");
      expect(await gceRead(GCE, exec, s, "inventory")).toEqual({ ok: false, why: `inventory: the broker restarted (boot ${BOOT2.slice(0, 8)}…, was ${BOOT.slice(0, 8)}…): the run is dead` });
      expect(s.dead).toBe(true);
      expect(s.evidence.map((e) => e.seq)).toEqual([1]);
      expect(await gceRead(GCE, exec, s, "inventory")).toEqual({ ok: false, why: "not asked: inventory: the broker restarted, so the run is dead" });
      expect(requests).toHaveLength(2);
    });

    test("the recovery job.status {run_id, vm} may come under a new boot, starting again at seq 1; it marks the run dead", async () => {
      const ok = gceExec({ vms: { [VM_A]: { inventory: [inventory()], replies: { "job.status": { status: "approved", result: { run_id: runOf(VM_A), seq: 1, boot: BOOT2, ...job(VM_A, "PATCHING", "STARTED") } } } } } });
      const s = newGceSession(VM_A);
      await gceRead(GCE, ok.exec, s, "inventory");
      expect((await gceRead(GCE, ok.exec, s, "job.status", { vm: VM_A })).ok).toBe(true);
      expect(s.dead).toBe(true);
      const bad = gceExec({ vms: { [VM_A]: { inventory: [inventory()], replies: { "job.status": { status: "approved", result: { run_id: runOf(VM_A), seq: 2, boot: BOOT2, ...job(VM_A, "PATCHING", "STARTED") } } } } } });
      const s2 = newGceSession(VM_A);
      await gceRead(GCE, bad.exec, s2, "inventory");
      expect(await gceRead(GCE, bad.exec, s2, "job.status", { vm: VM_A })).toEqual({ ok: false, why: "job.status: the broker's seq 2 under a new boot is not 1" });
    });

    test("a job.status by job id under a new boot is a dead run too", async () => {
      const { exec } = gceExec({ vms: { [VM_A]: { inventory: [inventory()], replies: { "job.status": { status: "approved", result: { run_id: runOf(VM_A), seq: 1, boot: BOOT2, ...job(VM_A, "PATCHING", "STARTED") } } } } } });
      const s = newGceSession(VM_A);
      await gceRead(GCE, exec, s, "inventory");
      expect(await gceRead(GCE, exec, s, "job.status", { job_id: jobOf(VM_A) })).toEqual({ ok: false, why: `job.status: the broker restarted (boot ${BOOT2.slice(0, 8)}…, was ${BOOT.slice(0, 8)}…): the run is dead` });
    });
  });

  describe("review-time refusals in the deny reason (CRB-b129 slice C d0e53a5)", () => {
    const run = runOf(VM_A);
    /** job.status by job id is denied with `reason`; by vm it answers with seq `next`. inventory answers seq 1. */
    const scene = (reason: string, next: number) =>
      gceExec({ vms: { [VM_A]: { inventory: [inventory()], replies: { "job.status": (p) => (p.job_id ? { status: "denied", reason } : { status: "approved", result: { run_id: run, seq: next, ...job(VM_A, "PATCHING", "STARTED") } }) } } } });
    const refusal = (over: Record<string, unknown>) => JSON.stringify({ run_id: run, seq: 2, boot: BOOT, refused: "gce-osc: unknown job", ...over });

    test("a §8 refusal in the deny reason takes its seq, so the next read at seq + 1 succeeds", async () => {
      const { exec } = scene(`  ${refusal({})}\n`, 3);
      const s = newGceSession(VM_A);
      await gceRead(GCE, exec, s, "inventory");
      expect(await gceRead(GCE, exec, s, "job.status", { job_id: jobOf(VM_A) })).toEqual({ ok: false, why: "job.status: refused by the broker: gce-osc: unknown job" });
      expect(s.seqs).toEqual([1, 2]);
      expect((await gceRead(GCE, exec, s, "job.status", { vm: VM_A })).ok).toBe(true);
      expect(s.seqs).toEqual([1, 2, 3]);
      expect(s.evidence.map((e) => e.seq)).toEqual([1]);
      // Before the fix the denial took no seq, so the run's seqs stayed [1] and the same next answer was a gap.
      const before = { ...newGceSession(VM_A), runId: run, boot: BOOT, seqs: [1] };
      expect(await gceRead(GCE, scene(refusal({}), 3).exec, before, "job.status", { vm: VM_A })).toEqual({ ok: false, why: "job.status: the broker's seq 3 is not the next one (expected 2)" });
    });

    test("a deny-reason refusal with a seq gap fails closed", async () => {
      const { exec } = scene(refusal({ seq: 3 }), 4);
      const s = newGceSession(VM_A);
      await gceRead(GCE, exec, s, "inventory");
      expect(await gceRead(GCE, exec, s, "job.status", { job_id: jobOf(VM_A) })).toEqual({ ok: false, why: "job.status: the broker's seq 3 is not the next one (expected 2)" });
      expect(s.seqs).toEqual([1]);
    });

    test.each([
      ["plain text", "caller not listed"],
      ["JSON with no §8 shape", JSON.stringify({ refuse: "unknown key: x" })],
      ["a refusal without the gce-osc prefix", JSON.stringify({ run_id: run, seq: 2, boot: BOOT, refused: "unknown job" })],
      ["a refusal with no boot", JSON.stringify({ run_id: run, seq: 2, refused: "gce-osc: unknown job" })],
    ])("a deny reason that is %s takes no seq; the next answer continues from the last", async (_what, reason) => {
      const { exec } = scene(reason, 2);
      const s = newGceSession(VM_A);
      await gceRead(GCE, exec, s, "inventory");
      expect(await gceRead(GCE, exec, s, "job.status", { job_id: jobOf(VM_A) })).toEqual({ ok: false, why: `job.status: broker denied: ${reason}` });
      expect(s.seqs).toEqual([1]);
      expect((await gceRead(GCE, exec, s, "job.status", { vm: VM_A })).ok).toBe(true);
      expect(s.seqs).toEqual([1, 2]);
    });

    test("only a denied status is read for a refusal: an expired card with the same text takes no seq", async () => {
      const { exec } = gceExec({ vms: { [VM_A]: { inventory: [inventory()], replies: { "job.status": { status: "expired", reason: refusal({}) } } } } });
      const s = newGceSession(VM_A);
      await gceRead(GCE, exec, s, "inventory");
      expect((await gceRead(GCE, exec, s, "job.status", { job_id: jobOf(VM_A) })).ok).toBe(false);
      expect(s.seqs).toEqual([1]);
    });

    test("a deny-reason refusal naming another run is a run change", async () => {
      const { exec } = scene(refusal({ run_id: OTHER_RUN }), 3);
      const s = newGceSession(VM_A);
      await gceRead(GCE, exec, s, "inventory");
      expect(await gceRead(GCE, exec, s, "job.status", { job_id: jobOf(VM_A) })).toEqual({ ok: false, why: `job.status: the broker's run changed (${OTHER_RUN}, expected ${run}): gce-osc: unknown job` });
    });

    test("an unknown vm refused at review, before any run, takes seq 1", async () => {
      const { exec } = gceExec({ vms: { [VM_A]: { replies: { inventory: { status: "denied", reason: JSON.stringify({ seq: 1, boot: BOOT, refused: "gce-osc: unknown vm" }) } } } } });
      const s = newGceSession(VM_A);
      expect(await gceRead(GCE, exec, s, "inventory")).toEqual({ ok: false, why: "inventory: refused by the broker: gce-osc: unknown vm" });
      expect(s.seqs).toEqual([1]);
      expect(s.runId).toBeUndefined();
    });
  });

  describe("run id and the exact §8 shapes (rev 15c)", () => {
    test("a run id that is not 32 lowercase hex is refused", async () => {
      for (const id of ["run-vm-a-0001", "7C1D0E9F2A3B4C5D6E7F8091A2B3C4D5", "7c1d0e9f2a3b4c5d6e7f8091a2b3c4d"]) {
        const { exec } = gceExec({ vms: { [VM_A]: { replies: { inventory: { status: "approved", result: { run_id: id, seq: 1, ...inventory() } } } } } });
        expect(await gceRead(GCE, exec, newGceSession(VM_A), "inventory")).toEqual({ ok: false, why: "inventory: the broker gave no valid run id" });
      }
    });

    test("every §8 answer, with boot right after seq, passes the strict decoders: inventory, job.status, orphan, void, refusal, patch", async () => {
      const run = runOf(VM_A);
      const head = (seq: number) => ({ run_id: run, seq, boot: BOOT });
      const bodies = [
        { ...head(1), ...inventory() },
        { ...head(2), ...job(VM_A, "SUCCEEDED", "SUCCEEDED", "2026-10-26T03:20:00Z", "clean") },
        { ...head(3), intent: { intent_id: "int-0001", state: "orphan" }, post: "not-checked" },
        { ...head(4), intent: { intent_id: "int-0002", state: "void" } },
        { ...head(5), refused: "gce-osc: no job" },
      ];
      let i = 0;
      const exec: Exec = async () => ({ rc: 0, err: "", out: JSON.stringify({ status: "approved", request_id: `req-${i + 1}`, result: bodies[i++] }) });
      const s = newGceSession(VM_A);
      const inv = await gceRead(GCE, exec, s, "inventory");
      expect(inv.ok && decodeInventory(inv.answer, VM_A).ok).toBe(true);
      const st = await gceRead(GCE, exec, s, "job.status", { job_id: jobOf(VM_A) });
      expect(st.ok && decodeJob(st.answer, jobOf(VM_A))).toMatchObject({ ok: true, value: { post: "clean" } });
      const orphan = await gceRead(GCE, exec, s, "job.status", { vm: VM_A });
      expect(orphan.ok && decodeJobByRun(orphan.answer)).toEqual({ ok: true, value: { kind: "orphan", intentId: "int-0001", post: "not-checked" } });
      const voided = await gceRead(GCE, exec, s, "job.status", { vm: VM_A });
      expect(voided.ok && decodeJobByRun(voided.answer)).toEqual({ ok: true, value: { kind: "void", intentId: "int-0002" } });
      expect(await gceRead(GCE, exec, s, "job.status", { vm: VM_A })).toEqual({ ok: false, why: "job.status: refused by the broker: gce-osc: no job" });
      const reply = patchReply(s, ["openssl"], { status: "approved", result: { ...head(6), job_id: jobOf(VM_A), sent: ["openssl"] } });
      expect(reply).toMatchObject({ outcome: "started", jobId: jobOf(VM_A), sent: ["openssl"] });
      expect(s.seqs).toEqual([1, 2, 3, 4, 5, 6]);
    });
  });
});
