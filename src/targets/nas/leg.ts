// Runs one NAS leg over the broker-script reach. The same leg kinds over another reach (docker-compose on a docker or
// vm-agent reach, spec §9 steps 3 and 4) are not built yet.

import type { LegResult, NasLeg } from "../model.ts";
import type { LegContext } from "../run.ts";
import { composeLeg } from "./compose.ts";
import { osLeg, type UnraidReleases } from "./os.ts";
import { pluginLeg } from "./plugin.ts";
import type { NasReviewers } from "./review.ts";

export interface NasLegDeps {
  reviewers: NasReviewers;
  releases: UnraidReleases;
}

export async function runNasLeg(leg: NasLeg, ctx: LegContext, deps: NasLegDeps): Promise<LegResult> {
  const nas = ctx.reach;
  if (nas.kind !== "broker-script") return { lines: [], summary: `not checked — leg ${leg.kind} over reach ${nas.kind} not built yet`, trouble: true };
  if (leg.kind === "docker-compose") return composeLeg(leg, ctx, nas, deps.reviewers);
  if (leg.kind === "unraid-plugin") return pluginLeg(leg, ctx, nas, deps.reviewers);
  return osLeg(nas, deps.releases);
}
