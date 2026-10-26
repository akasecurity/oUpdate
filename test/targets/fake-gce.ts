// gce-patch test fakes (placeholders only). Builders for the broker's inventory answer as CRB-b129 rev 13 §8.3 gives it:
// one JSON object with the VM, its instance id, the inventory's update time, os_info, the installed set by name and
// every upgradable candidate with the broker's archive-index verdict ({security: {suite}} or {hold: {reason}}).
import { createHash } from "node:crypto";
import { decodeInventory, type Inventory } from "../../src/targets/gce/answer.ts";
import type { Exec } from "../../src/apply/exec.ts";
import type { GceBroker } from "../../src/targets/gce/broker.ts";
import type { Clock } from "../../src/targets/gce/job.ts";
import type { Reach } from "../../src/targets/model.ts";
import { credreqArgs, fakeExec, type Call, type Rule } from "./fakes.ts";

export const VM_A = "vm-a";
export const VM_B = "vm-b";
export const T0 = "2026-10-26T03:00:00Z";

export interface CandOpts {
  name: string;
  installed: string;
  available: string;
  /** Default: the security pocket. */
  hold?: string;
  suite?: string;
}

export const INSTALLED: [string, string][] = [
  ["openssl", "3.0.13-0ubuntu3.4"],
  ["libssl3t64", "3.0.13-0ubuntu3.4"],
  ["curl", "8.5.0-2ubuntu10.4"],
  ["bash", "5.2.21-2ubuntu4"],
];
export const CANDS: CandOpts[] = [
  { name: "openssl", installed: "3.0.13-0ubuntu3.4", available: "3.0.13-0ubuntu3.5" },
  { name: "libssl3t64", installed: "3.0.13-0ubuntu3.4", available: "3.0.13-0ubuntu3.5" },
  { name: "curl", installed: "8.5.0-2ubuntu10.4", available: "8.5.0-2ubuntu10.6", hold: "the candidate is newer than the security index lists" },
];

export function cand(c: CandOpts): Record<string, unknown> {
  return {
    name: c.name, installed: c.installed, available: c.available,
    broker: c.hold === undefined ? { security: { suite: c.suite ?? "noble-security" } } : { hold: { reason: c.hold } },
  };
}

export interface InvOpts {
  vm?: string;
  instanceId?: string;
  updateTime?: string;
  os?: Record<string, unknown>;
  installed?: [string, string][];
  candidates?: CandOpts[];
  /** Candidate objects sent as given, for hostile-value tests. */
  raw?: Record<string, unknown>[];
  extra?: Record<string, unknown>;
}

export const OS_INFO = { short_name: "ubuntu", version: "24.04", architecture: "x86_64", kernel_version: "6.8.0-1015-gcp" };

/** An inventory answer's own fields; the broker sends them beside run_id and seq (§8.3). */
export function inventory(o: InvOpts = {}): Record<string, unknown> {
  return {
    vm: o.vm ?? VM_A,
    instance_id: o.instanceId ?? "1000000000000000001",
    update_time: o.updateTime ?? T0,
    os_info: o.os ?? OS_INFO,
    installed: (o.installed ?? INSTALLED).map(([name, version]) => ({ name, version })),
    candidates: o.raw ?? (o.candidates ?? CANDS).map(cand),
    ...o.extra,
  };
}

/** The installed set after a job: each name moved to its version, null removes it, a new name adds it. */
export function after(moves: Record<string, string | null>, base: [string, string][] = INSTALLED): [string, string][] {
  const out = base.filter(([n]) => moves[n] !== null).map(([n, v]) => [n, moves[n] ?? v] as [string, string]);
  for (const [n, v] of Object.entries(moves)) if (v !== null && !base.some(([b]) => b === n)) out.push([n, v]);
  return out;
}

/** A decoded inventory, for unit tests that start from one. */
export function inv(o: InvOpts = {}): Inventory {
  const d = decodeInventory(inventory(o), o.vm ?? VM_A);
  if (!d.ok) throw new Error(d.why);
  return d.value;
}

export const GCE: GceBroker = { credreq: "/opt/credreq", baseUrl: "https://broker.example.invalid", readAction: "cloud.osc.read", patchAction: "cloud.osc.patch" };
/** A VM's run id: 32 lowercase hex characters (rev 15c), the same for every read of the VM. */
export const runOf = (vm: string) => createHash("md5").update(`run:${vm}`).digest("hex");
/** Another run's id, for run-change tests. */
export const OTHER_RUN = "0000000000000000000000000000beef";
/** The broker process ids (rev 15a §8): BOOT for every answer the fake makes, BOOT2 for a restarted broker. */
export const BOOT = "0123456789abcdef0123456789abcdef";
export const BOOT2 = "fedcba9876543210fedcba9876543210";

/** An answer with `boot` right after `seq`, as the broker sends it; a scripted result with a seq and no boot gets BOOT, and `boot: null` drops it. */
export function withBoot(result: unknown): unknown {
  if (typeof result !== "object" || result === null || !("seq" in result)) return result;
  const r = result as Record<string, unknown>;
  if (r.boot === null) {
    const { boot: _b, ...rest } = r;
    return rest;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(r)) {
    if (k === "boot") continue;
    out[k] = v;
    if (k === "seq") out.boot = r.boot ?? BOOT;
  }
  return out;
}
export const jobOf = (vm: string) => `job-${vm}-1`;

export interface FakeReply {
  status: string;
  reason?: string;
  result?: unknown;
}
export interface GceVm {
  /** inventory answers in order: the review read, then each post-job read (the last repeats). */
  inventory?: Record<string, unknown>[];
  /** job.status answers in order (the last repeats). */
  jobs?: Record<string, unknown>[];
  /** verb -> a whole reply, overriding the scripted answers. */
  replies?: Record<string, FakeReply | ((p: Record<string, unknown>) => FakeReply)>;
}
export interface FakeGce {
  vms?: Record<string, GceVm>;
  /** Stamps each request with its time, for the binding-window tests. */
  clock?: Clock;
}
export interface GceRequest {
  action: string;
  vm: string;
  wait: number;
  params: Record<string, unknown>;
  at?: number;
  /** The stdout credreq gave back, as the caller received it. */
  out?: string;
}

/**
 * The CRB-b129 broker as rev 15a §8 gives it: the credreq target is the VM; every answer carries the run id, a per-VM
 * seq (refusals included) and, right after it, the broker's boot id (BOOT; scripted replies get it too, see withBoot). inventory answers {run_id, seq, <the §8.3 fields>} and mints the VM's run on its first read;
 * job.status answers {run_id, seq, <the §8.6 fields>}; patch answers {run_id, seq, job_id, sent} with sent = every APPROVE name. A VM not in
 * the scene is refused {seq, refused: "gce-osc: unknown vm"} with no run, as the catalog would.
 */
export function fakeGce(g: FakeGce, b: GceBroker = GCE): { rule: Rule; requests: GceRequest[] } {
  const requests: GceRequest[] = [];
  const state = new Map<string, { inv: number; job: number; seq: number }>();
  let n = 0;
  const next = <T>(xs: T[] | undefined, i: number) => (xs?.length ? xs[Math.min(i, xs.length - 1)] : undefined);
  const rule: Rule = (argv) => {
    if (argv[0] !== b.credreq) return undefined;
    const a = credreqArgs(argv);
    if (!a) return { rc: 2, err: "usage: bad arguments" };
    requests.push({ action: a.action, vm: a.target, wait: a.wait, params: a.params, ...(g.clock ? { at: g.clock.now() } : {}) });
    const vm = g.vms?.[a.target];
    const st = state.get(a.target) ?? { inv: 0, job: 0, seq: 0 };
    state.set(a.target, st);
    const verb = String(a.params.verb);
    const scripted = vm?.replies?.[verb];
    let reply: FakeReply | undefined = typeof scripted === "function" ? scripted(a.params) : scripted;
    if (!reply && !vm) reply = { status: "approved", result: { seq: ++st.seq, refused: "gce-osc: unknown vm" } };
    if (!reply && a.action === b.patchAction && verb === "patch") {
      const items = (a.params.verdict as { items?: Record<string, string> } | undefined)?.items ?? {};
      reply = { status: "approved", result: { run_id: runOf(a.target), seq: ++st.seq, job_id: jobOf(a.target), sent: Object.keys(items).filter((k) => items[k] === "APPROVE") } };
    }
    if (!reply && verb === "inventory") {
      const answer = next(vm!.inventory, st.inv++);
      reply = answer === undefined ? { status: "failed", reason: "fake: no inventory scripted" } : { status: "approved", result: { run_id: runOf(a.target), seq: ++st.seq, ...answer } };
    }
    if (!reply && verb === "job.status") {
      const answer = next(vm!.jobs, st.job++);
      reply = answer === undefined ? { status: "failed", reason: "fake: no job status scripted" } : { status: "approved", result: { run_id: runOf(a.target), seq: ++st.seq, ...answer } };
    }
    reply ??= { status: "failed", reason: `fake: nothing scripted for ${verb}` };
    reply = { ...reply, ...(reply.result !== undefined ? { result: withBoot(reply.result) } : {}) };
    // A scripted reply's seq counts too, so the fake's own next answer comes after it.
    const rs = (reply.result as { seq?: unknown } | undefined)?.seq;
    if (typeof rs === "number") st.seq = Math.max(st.seq, rs);
    const out = `${JSON.stringify({ request_id: `req-${++n}`, ...reply })}\n`;
    requests[requests.length - 1]!.out = out;
    return { rc: reply.status === "approved" ? 0 : 1, out };
  };
  return { rule, requests };
}

export function gceExec(g: FakeGce): { exec: Exec; calls: Call[]; requests: GceRequest[] } {
  const f = fakeGce(g);
  const { exec, calls } = fakeExec([f.rule]);
  return { exec, calls, requests: f.requests };
}

export const JOB_END = "2026-10-26T03:20:00Z";

/** A job.status answer: Google's patch job state, the VM's instance state, the end time once the job has ended, and the broker's post-check result once it has finished. */
export const job = (vm: string, state: string, instance: string, end?: string, post?: "clean" | "drift" | "not-checked"): Record<string, unknown> =>
  ({ job_id: jobOf(vm), state, instance_state: instance, ...(end ? { end_time: end } : {}), ...(post ? { post } : {}) });

/** A clock whose sleep advances it at once, recording each wait. */
export function fakeClock(start: number): Clock & { slept: number[] } {
  let t = start;
  const slept: number[] = [];
  return { slept, now: () => t, sleep: async (ms) => void (slept.push(ms), (t += ms)) };
}

export const GCE_REACH: Extract<Reach, { kind: "gce-patch" }> = { kind: "gce-patch", project: "example-proj", vms: [VM_A, VM_B], actions: ["cloud.osc.read", "cloud.osc.patch"], baseUrl: "https://broker.example.invalid", credreq: "/opt/credreq" };
