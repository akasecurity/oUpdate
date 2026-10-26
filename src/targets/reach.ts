// A target's reach supplies the Exec its legs run through (spec §2). local: oupdate runs on the target.
// git: a clone on the runner; opening it fetches only the base branch and pins its commit, so every leg
// reads the same commit and nothing touches the clone's checkout. broker-script: the broker runs fixed
// scripts on the target; opening it is one `self` read through the broker, and the open reach carries
// the night's broker session (its run id and evidence). gce-patch: the broker's OS Config patch job; opening it
// makes no call (each VM is read by its leg). vm-agent and docker are declared and parse, but are not built: the target
// reports "not checked" with trouble.

import type { Exec } from "../apply/exec.ts";
import type { GceBroker } from "./gce/broker.ts";
import type { Reach } from "./model.ts";
import { decodeSelf, type SelfInfo } from "./nas/answer.ts";
import { brokerRead, newSession, type NasBroker, type NasSession } from "./nas/broker.ts";

/** Git never prompts for credentials in an unattended run. */
export const GIT_ENV: Record<string, string> = { GIT_TERMINAL_PROMPT: "0" };

export type OpenReach =
  | { kind: "local"; exec: Exec }
  | { kind: "git"; exec: Exec; repo: string; remote: string; base: string; baseSha: string }
  | { kind: "broker-script"; exec: Exec; broker: NasBroker; session: NasSession; self: SelfInfo }
  | { kind: "gce-patch"; exec: Exec; broker: GceBroker; project: string; vms: string[] };
export type OpenNas = Extract<OpenReach, { kind: "broker-script" }>;
export type OpenGce = Extract<OpenReach, { kind: "gce-patch" }>;

export type ReachHandle = { ok: true; open: OpenReach } | { ok: false; why: string };

const OID = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const firstLine = (s: string) => {
  const l = s.trim().split("\n")[0];
  return l ? `: ${l.slice(0, 200)}` : "";
};

export function nasBroker(r: Extract<Reach, { kind: "broker-script" }>): NasBroker {
  const writeAction = r.actions.find((a) => a.endsWith(".write"));
  return { credreq: r.credreq, baseUrl: r.baseUrl, host: r.host, readAction: r.actions.find((a) => a.endsWith(".read"))!, ...(writeAction ? { writeAction } : {}) };
}

export function gceBroker(r: Extract<Reach, { kind: "gce-patch" }>): GceBroker {
  const patchAction = r.actions.find((a) => a.endsWith(".patch"));
  return { credreq: r.credreq, baseUrl: r.baseUrl, readAction: r.actions.find((a) => a.endsWith(".read"))!, ...(patchAction ? { patchAction } : {}) };
}

export async function openReach(reach: Reach, exec: Exec, timeoutMs: number): Promise<ReachHandle> {
  if (reach.kind === "local") return { ok: true, open: { kind: "local", exec } };
  if (reach.kind === "broker-script") {
    const broker = nasBroker(reach);
    const session = newSession();
    const r = await brokerRead(broker, exec, session, "self");
    if (!r.ok) return { ok: false, why: `reach broker-script: ${r.why}` };
    const self = decodeSelf(r.rows);
    if (!self.ok) return { ok: false, why: `reach broker-script: ${self.why}` };
    return { ok: true, open: { kind: "broker-script", exec, broker, session, self: self.value } };
  }
  if (reach.kind === "gce-patch") return { ok: true, open: { kind: "gce-patch", exec, broker: gceBroker(reach), project: reach.project, vms: [...reach.vms] } };
  if (reach.kind !== "git") return { ok: false, why: `reach ${reach.kind} not built yet` };
  const git = (args: string[]) => exec(["git", "-C", reach.repo, ...args], { env: GIT_ENV, timeoutMs });
  const f = await git(["fetch", "--quiet", "--no-tags", reach.remote, `+refs/heads/${reach.base}:refs/remotes/${reach.remote}/${reach.base}`]);
  if (f.rc !== 0) return { ok: false, why: `reach git: fetch of ${reach.base} from ${reach.remote} failed (rc ${f.rc}${firstLine(f.err)})` };
  const r = await git(["rev-parse", "--verify", "--quiet", `refs/remotes/${reach.remote}/${reach.base}^{commit}`]);
  const sha = r.out.trim();
  if (r.rc !== 0 || !OID.test(sha)) return { ok: false, why: `reach git: ${reach.remote}/${reach.base} does not resolve to a commit` };
  return { ok: true, open: { kind: "git", exec, repo: reach.repo, remote: reach.remote, base: reach.base, baseSha: sha } };
}
