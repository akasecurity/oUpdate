// After the job: only an inventory strictly newer than the job's end counts; anything else, within a bounded wait, is
// "no fresh inventory" with its reason.
import { describe, expect, test } from "bun:test";
import { gceRead, newGceSession } from "../../src/targets/gce/broker.ts";
import { freshInventory } from "../../src/targets/gce/post.ts";
import { parseTime } from "../../src/targets/gce/verbs.ts";
import { fakeClock, GCE, gceExec, inventory, JOB_END, runOf, VM_A, type GceVm } from "./fake-gce.ts";
import { OTHER_RUN } from "./fake-gce.ts";

const END = parseTime(JOB_END)!;
const MIN = 60_000;

async function minted(vm: GceVm) {
  const t = gceExec({ vms: { [VM_A]: vm } });
  const s = newGceSession(VM_A);
  await gceRead(GCE, t.exec, s, "inventory");
  return { ...t, s };
}

describe("freshInventory", () => {
  test("waits until an inventory is newer than the job's end", async () => {
    const { exec, s } = await minted({ inventory: [inventory(), inventory({ updateTime: "2026-10-26T03:10:00Z" }), inventory({ updateTime: JOB_END }), inventory({ updateTime: "2026-10-26T03:20:01Z" })] });
    const clock = fakeClock(END);
    const r = await freshInventory(GCE, exec, s, END, clock, END + 30 * MIN);
    expect(r.ok && r.value.updateText).toBe("2026-10-26T03:20:01Z");
    expect(clock.slept).toEqual([60_000, 60_000]);
  });

  test("an inventory dated exactly at the job's end is never newer (Review Focus 4)", async () => {
    const { exec, s } = await minted({ inventory: [inventory(), inventory({ updateTime: JOB_END })] });
    const clock = fakeClock(END);
    expect(await freshInventory(GCE, exec, s, END, clock, END + 3 * MIN)).toEqual({ ok: false, why: `no inventory newer than the job's end by the end of the wait (latest ${JOB_END})` });
  });

  test.each([
    ["a lost read", { replies: { inventory: (p: Record<string, unknown>) => (p.run_id ? { status: "withheld", reason: "locked" } : { status: "approved", result: { run_id: runOf(VM_A), seq: 1, ...inventory() } }) } }, "post-job inventory: broker withheld: locked"],
    ["a run that changed during the wait", { replies: { inventory: (p: Record<string, unknown>) => ({ status: "approved", result: { run_id: p.run_id ? OTHER_RUN : runOf(VM_A), seq: p.run_id ? 2 : 1, ...inventory() } }) } }, `post-job inventory: the broker's run changed (${OTHER_RUN}, expected ${runOf(VM_A)})`],
    ["an answer for another VM", { inventory: [inventory(), inventory({ vm: "vm-b", updateTime: "2026-10-26T03:30:00Z" })] }, 'post-job inventory names another VM ("vm-b", expected vm-a)'],
  ] as [string, GceVm, string][])("%s is no fresh inventory (Review Focus 4)", async (_what, vm, why) => {
    const { exec, s } = await minted(vm);
    expect(await freshInventory(GCE, exec, s, END, fakeClock(END), END + 30 * MIN)).toEqual({ ok: false, why });
  });

  test("the deadline is checked before every read: an already-ended window sends nothing (binding)", async () => {
    const { exec, s, requests } = await minted({ inventory: [inventory(), inventory({ updateTime: "2026-10-26T03:30:00Z" })] });
    const clock = fakeClock(END + 56 * MIN);
    expect(await freshInventory(GCE, exec, s, END, clock, END + 55 * MIN)).toEqual({ ok: false, why: "post-job inventory: not asked: the run's read window has ended" });
    expect(requests).toHaveLength(1);
  });

  test("a read that comes back late is not followed by another past the deadline (binding)", async () => {
    const clock = fakeClock(END);
    const t = gceExec({ vms: { [VM_A]: { inventory: [inventory(), inventory({ updateTime: JOB_END })] } } });
    const s = newGceSession(VM_A);
    await gceRead(GCE, t.exec, s, "inventory");
    const slow: typeof t.exec = async (argv, o) => {
      const r = await t.exec(argv, o);
      await clock.sleep(40 * MIN);
      return r;
    };
    expect(await freshInventory(GCE, slow, s, END, clock, END + 30 * MIN)).toEqual({ ok: false, why: `no inventory newer than the job's end by the end of the wait (latest ${JOB_END})` });
    expect(t.requests).toHaveLength(2);
  });
});
