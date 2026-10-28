// A target's reach supplies the Exec its legs run through. local: oupdate runs on the target.
// git: a clone on the runner; opening it fetches only the base branch and pins its commit, so every leg
// reads the same commit and nothing touches the clone's checkout. gce-patch: the broker's OS Config patch job; opening it
// makes no call (each VM is read by its leg). A target plugin's reach (registry.ts) is opened by its plugin. vm-agent and
// docker are declared and parse, but are not built: the target reports "not checked" with trouble.

import type { Exec } from "../apply/exec.ts";
import type { Compat } from "./compat.ts";
import type { GceBroker } from "./gce/broker.ts";
import { isPluginReach, type Reach } from "./model.ts";
import { EMPTY_REGISTRY, type Registry } from "./registry.ts";

/** Git never prompts for credentials in an unattended run. */
export const GIT_ENV: Record<string, string> = { GIT_TERMINAL_PROMPT: "0" };

export type OpenReach =
  | { kind: "local"; exec: Exec }
  | { kind: "git"; exec: Exec; repo: string; remote: string; base: string; baseSha: string }
  | { kind: "gce-patch"; exec: Exec; broker: GceBroker; project: string; vms: string[] }
  /** A target plugin's open reach; the plugin's own type adds its fields. */
  | { kind: string; plugin: true; exec: Exec };
export type OpenGce = Extract<OpenReach, { kind: "gce-patch" }>;

export type ReachHandle = { ok: true; open: OpenReach } | { ok: false; why: string };

const OID = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const firstLine = (s: string) => {
  const l = s.trim().split("\n")[0];
  return l ? `: ${l.slice(0, 200)}` : "";
};

/** The reach's broker door; `compat` gives an older deployment's client environment and verdict keys (compat.ts). */
export function gceBroker(r: Extract<Reach, { kind: "gce-patch" }>, compat: Compat = {}): GceBroker {
  const patchAction = r.actions.find((a) => a.endsWith(".patch"));
  const env = compat.brokerClient?.baseUrlEnv;
  const keys = compat.verdictReviewerKeys;
  return { client: r.client, baseUrl: r.baseUrl, ...(env ? { baseUrlEnv: env } : {}), readAction: r.actions.find((a) => a.endsWith(".read"))!, ...(patchAction ? { patchAction } : {}), ...(keys ? { reviewerKeys: keys } : {}) };
}

export async function openReach(reach: Reach, exec: Exec, timeoutMs: number, reg: Registry = EMPTY_REGISTRY): Promise<ReachHandle> {
  if (isPluginReach(reach)) {
    const k = reg.reaches.get(reach.kind);
    return k ? k.open(reach, exec, timeoutMs) : { ok: false, why: `reach ${reach.kind} has no plugin loaded` };
  }
  if (reach.kind === "local") return { ok: true, open: { kind: "local", exec } };
  if (reach.kind === "gce-patch") return { ok: true, open: { kind: "gce-patch", exec, broker: gceBroker(reach, reg.compat), project: reach.project, vms: [...reach.vms] } };
  if (reach.kind !== "git") return { ok: false, why: `reach ${reach.kind} not built yet` };
  const git = (args: string[]) => exec(["git", "-C", reach.repo, ...args], { env: GIT_ENV, timeoutMs });
  const f = await git(["fetch", "--quiet", "--no-tags", reach.remote, `+refs/heads/${reach.base}:refs/remotes/${reach.remote}/${reach.base}`]);
  if (f.rc !== 0) return { ok: false, why: `reach git: fetch of ${reach.base} from ${reach.remote} failed (rc ${f.rc}${firstLine(f.err)})` };
  const r = await git(["rev-parse", "--verify", "--quiet", `refs/remotes/${reach.remote}/${reach.base}^{commit}`]);
  const sha = r.out.trim();
  if (r.rc !== 0 || !OID.test(sha)) return { ok: false, why: `reach git: ${reach.remote}/${reach.base} does not resolve to a commit` };
  return { ok: true, open: { kind: "git", exec, repo: reach.repo, remote: reach.remote, base: reach.base, baseSha: sha } };
}
