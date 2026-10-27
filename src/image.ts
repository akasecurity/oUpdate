// `oupdate image <old-ref> <new-ref>`: the compose leg's container review for one repin, with the evidence read from a
// registry instead of a NAS. The same diff (Entrypoint/Cmd and the history lines the new image adds), the same pre-gate,
// prompt and reviewers. A side that cannot be read is BASELINE MISSING, which the pre-gate always holds. One reviewer
// is enough unless a second is given; then both must approve, as on the NAS.

import type { ImageRef, OciImageSource } from "./adapters/oci/registry.ts";
import type { ImageEvidence } from "./targets/nas/answer.ts";
import { layerDiffs, nasApproved, reviewDiff, structuralHits } from "./targets/nas/evidence.ts";
import { composePrompt } from "./targets/nas/prompt.ts";
import { reviewTwice, type NasReviewers, type Opinion } from "./targets/nas/review.ts";
import { stamp } from "./targets/summary.ts";

export interface ImageCheckArgs {
  old: ImageRef;
  new: ImageRef;
  /** `os/arch[/variant]`. */
  platform: string;
  now: Date;
}

export interface ImageCheckResult {
  /** `registry/repository`. */
  repository: string;
  /** The refs as written. */
  old: string;
  new: string;
  /** The tag or digest each ref names. */
  from: string;
  to: string;
  platform: string;
  /** The platform manifest digests read, when read. */
  oldDigest?: string;
  newDigest?: string;
  decision: "land" | "hold";
  why: string;
  diff: string;
  hits: string[];
  router: Opinion;
  onprem: Opinion;
  lines: string[];
}

const NO_ONPREM = "on-prem: no reviewer configured";
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

export async function checkImage(a: ImageCheckArgs, deps: { source: OciImageSource; reviewers: NasReviewers }): Promise<ImageCheckResult> {
  const lines: string[] = [];
  const read = async (side: "old" | "new", ref: ImageRef): Promise<ImageEvidence | undefined> => {
    try {
      return await deps.source.imageEvidence(ref, a.platform);
    } catch (e) {
      lines.push(`${side} ${ref.text}: ${e instanceof Error ? e.message : String(e)}`);
      return undefined;
    }
  };
  const oldE = await read("old", a.old);
  const newE = await read("new", a.new);
  const base = { repository: `${a.new.registry}/${a.new.repository}`, old: a.old.text, new: a.new.text, from: a.old.reference, to: a.new.reference, platform: a.platform, oldDigest: oldE?.digest, newDigest: newE?.digest };
  if (oldE?.config && oldE.config === newE?.config) {
    return { ...base, decision: "land", why: "unchanged", diff: "", hits: [], router: "not asked", onprem: "not asked", lines };
  }

  const diff = reviewDiff(oldE, newE);
  const all = layerDiffs([{ ref: a.new.text, diff }]);
  const hits = structuralHits(all);
  const v = await reviewTwice(deps.reviewers, composePrompt(stamp(a.now).slice(0, 10), [a.new.text], all), nasApproved);
  const second = deps.reviewers.onprem !== undefined;
  lines.push(...(second ? v.lines : v.lines.filter((l) => l !== NO_ONPREM)));
  const onprem: Opinion = second ? v.onprem : "not asked";
  const approved = second ? v.approved : v.router === "APPROVE";
  const why = hits.length ? `pre-gate: ${plural(hits.length, "hit")}` : v.router !== "APPROVE" ? `review: router ${v.router}` : !approved ? `review: on-prem ${v.onprem}` : "approved";
  return { ...base, decision: !hits.length && approved ? "land" : "hold", why, diff, hits, router: v.router, onprem, lines };
}

export function renderImage(r: ImageCheckResult): string {
  const n = r.diff ? r.diff.split("\n").length : 0;
  return [
    `image ${r.repository} ${r.from} -> ${r.to}: ${r.decision.toUpperCase()} (${r.why})`,
    `  diff      ${plural(n, "new line")}`,
    `  pre-gate  ${plural(r.hits.length, "hit")}`,
    ...r.hits.map((h) => `    ${h}`),
    `  reviewer  router ${r.router} · on-prem ${r.onprem}`,
    ...r.lines,
  ].join("\n");
}
