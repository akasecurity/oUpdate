// Broker test fakes. fakeBroker answers `<client> <action> <host> --why W --wait N --param k=v… --param-json k=J…` the way
// the broker's caller contract says: a read's result is {run_id, seq, answer}, the
// answer with its final marker removed, or {run_id, held}; run_id is absent until the first compose.state or plugin.check
// mints it. A target answer with no marker or a nonzero rc comes back as {run_id, failed, rc?}; a repeat of
// compose.state or plugin.check as {run_id, refused}. A write's result is {run_id, outcome, rc?}. Every request is recorded.
// Placeholder names only.
import type { Exec } from "../../src/apply/exec.ts";
import { brokerRead, newSession, type ComposeBroker, type OpenBroker } from "../../src/targets/broker/broker.ts";
import { writeOutcome } from "../../src/targets/broker/outcome.ts";
import type { WriteVerb } from "../../src/targets/broker/verbs.ts";
import type { Reviewer } from "../../src/review.ts";
import { makeRegistry, type Registry } from "../../src/targets/registry.ts";
import { obj } from "../../src/targets/strict.ts";
import { fakeExec, type Call, type Rule } from "./fakes.ts";

export const BROKER: ComposeBroker = { client: "/opt/broker-client", baseUrl: "https://broker.example.invalid", host: "box-1", readAction: "store.oup.read", writeAction: "store.oup.write" };
export const RUN = "run-0001abcd";

type Params = Record<string, unknown>;
export interface Reply {
  status: string;
  reason?: string;
  result?: unknown;
}
export interface FakeTarget {
  /** verb -> answer text, or a function of the request's params. */
  answers?: Record<string, string | ((p: Params) => string)>;
  /** verb -> a whole broker reply, overriding the answer (another status, a held item, a broken result). */
  replies?: Record<string, Reply | ((p: Params) => Reply | undefined)>;
  /** write verb -> the rc the target script ended with; null: no rc came back. Default 0. */
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

export function fakeBroker(target: FakeTarget = {}, b: ComposeBroker = BROKER): { rule: Rule; requests: FakeRequest[] } {
  const requests: FakeRequest[] = [];
  let runId: string | undefined;
  const read = new Set<string>();
  let seq = 0;
  let n = 0;
  const rule: Rule = (argv, call) => {
    if (argv[0] !== b.client) return undefined;
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
    const scripted = target.replies?.[verb];
    let reply = typeof scripted === "function" ? scripted(params) : scripted;
    if (!reply && action === b.writeAction) {
      const rc = target.writeRc && Object.hasOwn(target.writeRc, verb) ? target.writeRc[verb]! : 0;
      const outcome = target.writeOutcome?.[verb] ?? writeOutcome(verb as WriteVerb, rc ?? undefined);
      reply = { status: "approved", result: { run_id: runId, outcome, ...(rc !== null ? { rc } : {}) } };
    }
    if (!reply) {
      const a = target.answers?.[verb];
      const answer = typeof a === "function" ? a(params) : a;
      if (answer === undefined) reply = { status: "failed", reason: `fake: no answer scripted for ${verb}` };
      else {
        const m = /(?:^|\n)__OUP_RC=(\d+)\n?$/.exec(answer);
        const rc = m ? Number(m[1]) : undefined;
        const mints = verb === "compose.state" || verb === "plugin.check";
        if (mints && read.has(verb)) reply = { status: "approved", result: { run_id: runId, refused: "box-oup: run already read" } };
        else if (rc !== 0) reply = { status: "approved", result: { ...(runId ? { run_id: runId } : {}), failed: "box-oup: read failed", ...(rc !== undefined ? { rc } : {}) } };
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

export function targetExec(target: FakeTarget): { exec: Exec; calls: Call[]; requests: FakeRequest[] } {
  const fb = fakeBroker(target);
  const { exec, calls } = fakeExec([fb.rule]);
  return { exec, calls, requests: fb.requests };
}

/** What the broker returns as `answer` for a target answer that ended in rc 0: the rows joined with \n, no trailing line break, marker removed. */
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

/** An open reach that carries a broker session over the fake broker (what a target plugin's reach opens to). */
export function openBroker(target: FakeTarget): { target: OpenBroker; calls: Call[]; requests: FakeRequest[] } {
  const t = targetExec(target);
  return { target: { kind: "test-broker", plugin: true, exec: t.exec, broker: BROKER, session: newSession() }, calls: t.calls, requests: t.requests };
}

/**
 * A target plugin: OS `test-os`; reach `test-broker` opens with one `self` read through the fake broker (BROKER), as a
 * real one would, and can write when it has `write: true`; leg `test-leg` needs that reach.
 */
export const TEST_REACH = { kind: "test-broker", plugin: true as const };
export const testRegistry = (): Registry =>
  makeRegistry([
    {
      os: ["test-os"],
      reaches: {
        "test-broker": {
          parse: (v, where) => ({ ...TEST_REACH, ...(obj(v, where, ["kind", "write"]).write === true ? { write: true } : {}) }),
          open: async (_r, exec) => {
            const session = newSession();
            const r = await brokerRead(BROKER, exec, session, "self");
            if (!r.ok) return { ok: false, why: `reach test-broker: ${r.why}` };
            const open: OpenBroker = { kind: "test-broker", plugin: true, exec, broker: BROKER, session };
            return { ok: true, open };
          },
          canWrite: (r) => "write" in r,
        },
      },
      legs: {
        "test-leg": {
          parse: (v, where) => (obj(v, where, ["kind"]), { kind: "test-leg", plugin: true }),
          check: (l, r) => (r.kind === "test-broker" ? undefined : `${l.kind} needs a test-broker reach`),
          run: async () => ({ lines: [], summary: "test leg ran", trouble: false }),
        },
      },
    },
  ]);
