// The one door every broker reach shares (spec §2): `credreq <action> <target> --why … --wait … --param verb=<verb>
// [--param <key>=<value>]… [--param-json <key>=<json>]…`, run as argv through Exec (never a shell) with
// CREDBROKER_BASE_URL set. It returns the broker's reply, or why there is none; what a result means belongs to each
// reach's own decoder. Moved here unchanged from nas/broker.ts so that the gce-patch reach uses the same door.

import type { Exec } from "../apply/exec.ts";

export interface CredreqDoor {
  /** The credreq binary (absolute path, or a name on PATH). */
  credreq: string;
  baseUrl: string;
}

export const STATUSES = ["approved", "denied", "expired", "failed", "withheld", "pending", "unknown"] as const;
export type Status = (typeof STATUSES)[number];
export interface Reply {
  status: Status;
  reason?: string;
  result?: unknown;
  /** The broker's request id: each target's log names it for every write (spec §7). */
  requestId?: string;
}
export type Param = { key: string; value: string; json?: boolean };
/** raw: credreq's stdout as received, trimmed (a reach that hashes what the broker sent reads it here). */
export type CallResult = { ok: true; reply: Reply; raw: string } | { ok: false; why: string };

const REQUEST_ID = /^[A-Za-z0-9._:-]{1,80}$/;
/** Exec gives credreq this long past its own wait before killing it. */
export const MARGIN_S = 30;

export const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
export const short = (s: string) => s.replace(/\s+/g, " ").trim().slice(0, 200);
export const tail = (s: string | undefined) => (s ? `: ${short(s)}` : "");

/** A log line naming the broker's request id when there is one. */
export const requestLine = (w: { why: string; requestId?: string }): string => (w.requestId ? `${w.why} [broker request ${w.requestId}]` : w.why);

export async function credreqCall(d: CredreqDoor, exec: Exec, action: string, target: string, verb: string, params: Param[], waitS: number): Promise<CallResult> {
  const argv = [d.credreq, action, target, "--why", `oupdate ${verb}`, "--wait", String(waitS), "--param", `verb=${verb}`];
  for (const p of params) argv.push(p.json ? "--param-json" : "--param", `${p.key}=${p.value}`);
  const r = await exec(argv, { env: { CREDBROKER_BASE_URL: d.baseUrl }, timeoutMs: (waitS + MARGIN_S) * 1000 });
  if (r.timedOut) return { ok: false, why: `credreq timed out after ${waitS + MARGIN_S} s` };
  if (r.rc === 127) return { ok: false, why: `credreq did not start${tail(r.err)}` };
  if (r.rc === 2) return { ok: false, why: `credreq usage error${tail(r.err)}` };
  let o: unknown;
  try {
    o = JSON.parse(r.out.trim());
  } catch {
    o = undefined;
  }
  if (!isObj(o) || !(STATUSES as readonly unknown[]).includes(o.status)) return { ok: false, why: `credreq gave no outcome (rc ${r.rc}${tail(r.err)})` };
  const requestId = typeof o.request_id === "string" && REQUEST_ID.test(o.request_id) ? o.request_id : undefined;
  return { ok: true, reply: { status: o.status as Status, ...(typeof o.reason === "string" ? { reason: o.reason } : {}), result: o.result, ...(requestId ? { requestId } : {}) }, raw: r.out.trim() };
}
