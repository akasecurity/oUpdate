// NAS test fakes. fakeBroker answers `credreq <action> <host> --why W --wait N --param k=v… --param-json k=J…` the way
// the CRB-b128 broker's caller contract says (rev 3g §4.8, open question O-1): a read's result is {run_id, seq, answer}, the
// answer with its final marker removed, or {run_id, held}; run_id is absent until the first compose.state or plugin.check
// mints it (rev 3f). A NAS answer with no marker or a nonzero rc comes back as {run_id, failed, rc?}; a repeat of
// compose.state or plugin.check as {run_id, refused}. A write's result is {run_id, outcome, rc?}. Every request is recorded.
// Placeholder names only.
import type { Exec } from "../../src/apply/exec.ts";
import type { Reach } from "../../src/targets/model.ts";
import type { NasBroker } from "../../src/targets/nas/broker.ts";
import { writeOutcome } from "../../src/targets/nas/outcome.ts";
import type { WriteVerb } from "../../src/targets/nas/verbs.ts";
import { openReach, type OpenNas } from "../../src/targets/reach.ts";
import type { Reviewer } from "../../src/review.ts";
import { fakeExec, type Call, type Rule } from "./fakes.ts";

export const BROKER: NasBroker = { credreq: "/opt/credreq", baseUrl: "https://broker.example.invalid", host: "box-1", readAction: "store.oup.read", writeAction: "store.oup.write" };
export const RUN = "run-0001abcd";

type Params = Record<string, unknown>;
export interface Reply {
  status: string;
  reason?: string;
  result?: unknown;
}
export interface FakeNas {
  /** verb -> answer text, or a function of the request's params. */
  answers?: Record<string, string | ((p: Params) => string)>;
  /** verb -> a whole broker reply, overriding the answer (another status, a held item, a broken result). */
  replies?: Record<string, Reply | ((p: Params) => Reply | undefined)>;
  /** write verb -> the rc the NAS script ended with; null: no rc came back. Default 0. */
  writeRc?: Record<string, number | null>;
  /** write verb -> the broker's own outcome field; default: the caller's table for the rc. */
  writeOutcome?: Record<string, string>;
}
export interface FakeRequest {
  action: string;
  host: string;
  why: string;
  wait: number;
  params: Params;
  env?: Record<string, string>;
}

export function fakeBroker(nas: FakeNas = {}, b: NasBroker = BROKER): { rule: Rule; requests: FakeRequest[] } {
  const requests: FakeRequest[] = [];
  let runId: string | undefined;
  const read = new Set<string>();
  let seq = 0;
  let n = 0;
  const rule: Rule = (argv, call) => {
    if (argv[0] !== b.credreq) return undefined;
    const [, action = "", host = "", ...rest] = argv;
    const params: Params = {};
    let why = "";
    let wait = -1;
    for (let i = 0; i < rest.length; i += 2) {
      const flag = rest[i]!;
      const v = rest[i + 1] ?? "";
      const eq = v.indexOf("=");
      if (flag === "--why") why = v;
      else if (flag === "--wait") wait = Number(v);
      else if (flag === "--param" && eq > 0) params[v.slice(0, eq)] = v.slice(eq + 1);
      else if (flag === "--param-json" && eq > 0) params[v.slice(0, eq)] = JSON.parse(v.slice(eq + 1));
      else return { rc: 2, err: `usage: unknown argument ${flag}` };
    }
    requests.push({ action, host, why, wait, params, env: call.env });
    const verb = String(params.verb);
    const scripted = nas.replies?.[verb];
    let reply = typeof scripted === "function" ? scripted(params) : scripted;
    if (!reply && action === b.writeAction) {
      const rc = nas.writeRc && Object.hasOwn(nas.writeRc, verb) ? nas.writeRc[verb]! : 0;
      const outcome = nas.writeOutcome?.[verb] ?? writeOutcome(verb as WriteVerb, rc ?? undefined);
      reply = { status: "approved", result: { run_id: runId, outcome, ...(rc !== null ? { rc } : {}) } };
    }
    if (!reply) {
      const a = nas.answers?.[verb];
      const answer = typeof a === "function" ? a(params) : a;
      if (answer === undefined) reply = { status: "failed", reason: `fake: no answer scripted for ${verb}` };
      else {
        const m = /(?:^|\n)__OUP_RC=(\d+)\n?$/.exec(answer);
        const rc = m ? Number(m[1]) : undefined;
        const mints = verb === "compose.state" || verb === "plugin.check";
        if (mints && read.has(verb)) reply = { status: "approved", result: { run_id: runId, refused: "nas-oup: run already read" } };
        else if (rc !== 0) reply = { status: "approved", result: { ...(runId ? { run_id: runId } : {}), failed: "nas-oup: read failed", ...(rc !== undefined ? { rc } : {}) } };
        else {
          if (mints) read.add(verb);
          if (!runId && mints) runId = RUN;
          reply = { status: "approved", result: { ...(runId ? { run_id: runId, seq: ++seq } : {}), answer: brokerAnswer(answer) } };
        }
      }
    }
    return { rc: reply.status === "approved" ? 0 : 1, out: `${JSON.stringify({ request_id: `req-${++n}`, ...reply })}\n` };
  };
  return { rule, requests };
}

export function nasExec(nas: FakeNas): { exec: Exec; calls: Call[]; requests: FakeRequest[] } {
  const fb = fakeBroker(nas);
  const { exec, calls } = fakeExec([fb.rule]);
  return { exec, calls, requests: fb.requests };
}

/** What the broker returns as `answer` for a NAS answer that ended in rc 0: the rows joined with \n, no trailing line break, marker removed. */
export const brokerAnswer = (text: string): string => text.replace(/\n?__OUP_RC=0\n?$/, "");

export const A = (c: string) => `sha256:${c.repeat(64)}`;
export const X = (c: string) => c.repeat(64);
export const j = (v: unknown) => JSON.stringify(v);

/** An answer: tab-joined rows, then the marker (null: no marker). */
export const ans = (rows: string[][], rc: number | null = 0): string =>
  rows.map((r) => r.join("\t")).join("\n") + (rows.length ? "\n" : "") + (rc === null ? "" : `__OUP_RC=${rc}\n`);

/** image.evidence / image.candidate rows; entrypoint defaults to ["/init"], cmd to null. */
export function evidenceRows(o: { id?: string; digest?: string; config?: string; entrypoint?: unknown; cmd?: unknown; history: string[] }): string[][] {
  return [
    ...(o.digest ? [["DIGEST", o.digest]] : []),
    ...(o.config ? [["CONFIG", o.config]] : []),
    ...(o.id ? [["ID", o.id]] : []),
    ["ENTRYPOINT", j("entrypoint" in o ? o.entrypoint : ["/init"])],
    ["CMD", j("cmd" in o ? o.cmd : null)],
    ...o.history.map((h) => ["HIST", j(h)]),
  ];
}

export const SELF = ans([["SCRIPT", "oup-read.sh", X("1"), X("1")], ["SCRIPT", "oup-write.sh", X("2"), X("2")], ["UNRAID", "7.1.4"], ["SH", "/bin/bash"], ["PLUGINS", X("3")]]);

export function fakeReviewer(name: string, answer: string | Error | ((prompt: string) => string)): { reviewer: Reviewer; prompts: string[] } {
  const prompts: string[] = [];
  const reviewer: Reviewer = {
    name,
    review: async (p) => {
      prompts.push(p);
      if (answer instanceof Error) throw answer;
      return typeof answer === "function" ? answer(p) : answer;
    },
  };
  return { reviewer, prompts };
}

export const REACH: Extract<Reach, { kind: "broker-script" }> = { kind: "broker-script", host: "box-1", actions: ["store.oup.read", "store.oup.write"], baseUrl: "https://broker.example.invalid", credreq: "/opt/credreq" };

/** An open broker-script reach over the fake broker; `self` answers SELF unless the test scripts it. */
export async function openNas(nas: FakeNas): Promise<{ nas: OpenNas; calls: Call[]; requests: FakeRequest[] }> {
  const t = nasExec({ ...nas, answers: { self: SELF, ...nas.answers } });
  const h = await openReach(REACH, t.exec, 1000);
  if (!h.ok || h.open.kind !== "broker-script") throw new Error(`fake reach did not open: ${h.ok ? h.open.kind : h.why}`);
  return { nas: h.open, calls: t.calls, requests: t.requests };
}
