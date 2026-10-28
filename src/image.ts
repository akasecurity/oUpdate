// `oupdate image <old-ref> <new-ref>`: the compose leg's container review for one repin, with the evidence read from a
// registry instead of a NAS. The same diff (Entrypoint/Cmd and the history lines the new image adds), the same pre-gate,
// prompt and reviewers. A side that cannot be read is BASELINE MISSING, which the pre-gate always holds. One reviewer
// is enough unless a second is given; then both must approve, as on the NAS.
//
// With `layers` the review also reads the layer contents (image-layers.ts): the config's ENV, USER, VOLUME, HEALTHCHECK and
// ONBUILD changes and the package and file changes follow the history diff in part 1, and the changed files go to the
// reviewers in further parts. A layer that cannot be read is a LAYERS UNREADABLE line, which holds whatever the reviewers say.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ImageRef, OciImageSource } from "./adapters/oci/registry.ts";
import { reviewLayers, type LayerBudget, type LayerReview } from "./image-layers.ts";
import { LayerError, LayerStore, LIMITS, type Limits } from "./oci-fs.ts";
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
  /** True reads the layer contents; false says they were not read; absent leaves the layer line out. */
  layers?: boolean;
  layerLimits?: Limits;
  layerBudget?: LayerBudget;
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
  primary: Opinion;
  secondary: Opinion;
  lines: string[];
  /** The layer line: what was read, or that nothing was. Absent when the check did not ask. */
  layers?: string;
}

const NO_SECONDARY = "secondary: no reviewer configured";
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

const unreadable = (digest: string, why: string) => `LAYERS UNREADABLE: ${digest}: ${why}`;

/** The layer-content review of one repin; an unreadable layer comes back as the line that holds. */
async function readLayers(a: ImageCheckArgs, deps: { source: OciImageSource }, oldE: ImageEvidence, newE: ImageEvidence): Promise<{ review: LayerReview } | { unreadable: string }> {
  const dir = mkdtempSync(join(tmpdir(), "oupdate-layers-"));
  try {
    if (!deps.source.imageLayers) throw new LayerError(newE.digest ?? "(image)", "this source cannot read layers");
    const old = await deps.source.imageLayers(a.old, a.platform, oldE.digest);
    const now = await deps.source.imageLayers(a.new, a.platform, newE.digest);
    return { review: await reviewLayers({ old, new: now, newEvidence: newE, store: new LayerStore(dir, a.layerLimits ?? LIMITS), budget: a.layerBudget }) };
  } catch (e) {
    return { unreadable: unreadable(e instanceof LayerError ? e.digest : (newE.digest ?? "(image)"), e instanceof Error ? e.message : String(e)) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

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
    return { ...base, decision: "land", why: "unchanged", diff: "", hits: [], primary: "not asked", secondary: "not asked", lines };
  }

  let diff = reviewDiff(oldE, newE);
  let layers = a.layers === false ? "layer contents not read" : undefined;
  let parts: string[] = [];
  let layerHits: string[] = [];
  let narrowed: string | undefined;
  if (a.layers && oldE && newE) {
    const got = await readLayers(a, deps, oldE, newE);
    if ("unreadable" in got) {
      const hit = got.unreadable;
      return { ...base, decision: "hold", why: "layers unreadable", diff, hits: [hit], primary: "not asked", secondary: "not asked", lines, layers: "layers: not read" };
    }
    const lr = got.review;
    diff = [diff, ...lr.extra].filter(Boolean).join("\n");
    parts = lr.parts;
    layerHits = lr.hits;
    narrowed = lr.narrowed;
    layers = `${lr.summary}${parts.length ? `; ${plural(parts.length, "file part")} reviewed` : ""}`;
  }
  const all = layerDiffs([{ ref: a.new.text, diff }]);
  const hits = [...structuralHits(all), ...layerHits];
  const second = deps.reviewers.secondary !== undefined;
  const prompts = [composePrompt(stamp(a.now).slice(0, 10), [a.new.text], all), ...parts.map((p, i) => composePrompt(stamp(a.now).slice(0, 10), [a.new.text], layerDiffs([{ ref: `${a.new.text} (layer files, part ${i + 1} of ${parts.length})`, diff: p }])))];
  let primary: Opinion = "APPROVE";
  let secondary: Opinion = second ? "APPROVE" : "not asked";
  let approved = true;
  for (const prompt of prompts) {
    const v = await reviewTwice(deps.reviewers, prompt, nasApproved);
    lines.push(...(second ? v.lines : v.lines.filter((l) => l !== NO_SECONDARY)));
    const ok = second ? v.approved : v.primary === "APPROVE";
    if (ok) continue;
    // A part that is not approved holds the update; the parts after it are not asked.
    primary = v.primary;
    secondary = second ? v.secondary : "not asked";
    approved = false;
    break;
  }
  const why = hits.length ? `pre-gate: ${plural(hits.length, "hit")}` : primary !== "APPROVE" ? `review: primary ${primary}` : !approved ? `review: secondary ${secondary}` : narrowed ? narrowed : "approved";
  return { ...base, decision: !hits.length && approved && !narrowed ? "land" : "hold", why, diff, hits, primary, secondary, lines, ...(layers ? { layers } : {}) };
}

export function renderImage(r: ImageCheckResult): string {
  const n = r.diff ? r.diff.split("\n").length : 0;
  return [
    `image ${r.repository} ${r.from} -> ${r.to}: ${r.decision.toUpperCase()} (${r.why})`,
    `  diff      ${plural(n, "new line")}`,
    `  pre-gate  ${plural(r.hits.length, "hit")}`,
    ...r.hits.map((h) => `    ${h}`),
    `  reviewer  primary ${r.primary} · secondary ${r.secondary}`,
    ...(r.layers ? [`  layers    ${r.layers}`] : []),
    ...r.lines,
  ].join("\n");
}
