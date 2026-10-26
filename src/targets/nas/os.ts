// unraid-os (spec §4): report only, never install. The NAS's version comes through os.version; the latest comes from
// the releases API, which the runner reads itself (the script read it from the NAS). The script's words are kept, so
// the summary and the parity fact read the same as its OS line.

import type { LegResult } from "../model.ts";
import type { OpenNas } from "../reach.ts";
import { decodeOsVersion } from "./answer.ts";
import { brokerRead } from "./broker.ts";

export interface UnraidReleases {
  /** The latest Unraid OS version, or undefined when the API cannot be read or answers anything else. */
  latest(): Promise<string | undefined>;
}

export const UNRAID_RELEASES_URL = "https://releases.unraid.net/os";
const VERSION = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,39}$/;

export function realUnraidReleases(f: typeof fetch = fetch): UnraidReleases {
  return {
    async latest() {
      try {
        const r = await f(UNRAID_RELEASES_URL, { signal: AbortSignal.timeout(15_000) });
        if (!r.ok) return undefined;
        const j: unknown = await r.json();
        const v = typeof j === "object" && j !== null ? (j as Record<string, unknown>).version : undefined;
        return typeof v === "string" && VERSION.test(v) ? v : undefined;
      } catch {
        return undefined;
      }
    },
  };
}

export async function osLeg(nas: OpenNas, releases: UnraidReleases): Promise<LegResult> {
  const r = await brokerRead(nas.broker, nas.exec, nas.session, "os.version");
  if (!r.ok) return { lines: [], summary: `not checked — ${r.why}`, trouble: true };
  const d = decodeOsVersion(r.rows);
  if (!d.ok) return { lines: [], summary: `not checked — ${d.why}`, trouble: true };
  const lines = [`Current: ${d.value}`];
  const latest = await releases.latest();
  if (!latest) {
    lines.push("OS check: could not reach releases API — skipping");
    return { lines, summary: "check failed (API unreachable)", trouble: true, parity: { os: "check failed (API unreachable)" } };
  }
  lines.push(`Latest:  ${latest}`);
  if (latest !== d.value) {
    const t = `UPDATE AVAILABLE: ${d.value} -> ${latest}`;
    lines.push(`OS ${t}`);
    return { lines, summary: t, trouble: false, parity: { os: t } };
  }
  lines.push("OS: up to date");
  return { lines, summary: "up to date", trouble: false, parity: { os: "up to date" } };
}
