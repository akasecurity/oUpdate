// After the job (spec §5 caller rules; CRB-b129 §2.3): wait for an inventory whose update_time is later than the job's
// end; the leg then compares it with the review read. That the broker serves this post-job read as `inventory` on the
// same run, repeatable with a new seq each time, is CRB-b129 rev 12 §8.7 (Q-7); a change lands in this file only. No newer inventory within the window, or
// any read or decode failure, is "no fresh inventory": the leg reports it as trouble and patches no other VM this run.

import type { Exec } from "../../apply/exec.ts";
import type { Decoded } from "../nas/answer.ts";
import { decodeInventory, type Inventory } from "./answer.ts";
import { gceRead, type GceBroker, type GceSession } from "./broker.ts";
import type { Clock } from "./job.ts";

/** The broker's own post-check polls for 30 min (CRB-b129 §2.3); the caller waits as long. */
export const POST_WAIT = { everyMs: 60_000, forMs: 30 * 60_000 };

/**
 * until: the last moment (epoch ms on the clock) a read may be sent: the leg's 30 min wait, cut to the run's read window
 * (rev 13 §8.1). The deadline is checked before every read, so a late reply never leads to a read past it.
 */
export async function freshInventory(b: GceBroker, exec: Exec, s: GceSession, endMs: number, clock: Clock, until: number, everyMs = POST_WAIT.everyMs): Promise<Decoded<Inventory>> {
  let latest: string | undefined;
  const stale = () => ({ ok: false as const, why: `no inventory newer than the job's end by the end of the wait (latest ${latest})` });
  for (;;) {
    if (clock.now() > until) return latest ? stale() : { ok: false, why: "post-job inventory: not asked: the run's read window has ended" };
    const r = await gceRead(b, exec, s, "inventory");
    if (!r.ok) return { ok: false, why: `post-job ${r.why}` };
    const d = decodeInventory(r.answer, s.vm);
    if (!d.ok) return { ok: false, why: `post-job ${d.why}` };
    if (d.value.updateTime > endMs) return d;
    latest = d.value.updateText;
    if (clock.now() + everyMs > until) return stale();
    await clock.sleep(everyMs);
  }
}
