// A base image pinned by its multi-arch index digest under a fixed tag, and optionally the apt snapshot
// id that goes with it: the first midnight UTC after the newest image build, so the snapshot is never
// older than the image's own packages. A snapshot that is not published yet holds the group (not
// trouble); the image build time is the publish time cooldown counts from.

import { DIGEST, type OciIndex, type OciSource } from "../../adapters/oci/registry.ts";
import type { OciGroup } from "./config.ts";
import type { Discovery } from "./discovery.ts";

export interface SnapshotSource {
  /** Whether <base>/<id>/dists/<suite>/InRelease is published. */
  exists(base: string, id: string, suite: string): Promise<boolean>;
}

export const realSnapshotSource: SnapshotSource = {
  async exists(base, id, suite) {
    const r = await fetch(`${base.replace(/\/+$/, "")}/${id}/dists/${suite}/InRelease`, { method: "HEAD", headers: { "user-agent": "oupdate" }, signal: AbortSignal.timeout(60_000) });
    return r.ok;
  },
};

export const SNAPSHOT_ID = /^\d{8}T000000Z$/;
const two = (n: number) => String(n).padStart(2, "0");

/** The first midnight UTC strictly after t, as a snapshot id (YYYYMMDDT000000Z). */
export function snapshotAfter(t: Date): string {
  const d = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate() + 1));
  return `${d.getUTCFullYear()}${two(d.getUTCMonth() + 1)}${two(d.getUTCDate())}T000000Z`;
}

const short = (d: string) => d.slice(0, 19);
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export async function discoverOci(g: OciGroup, cur: Map<string, string>, oci: OciSource, snap: SnapshotSource): Promise<Discovery> {
  const err = (why: string): Discovery => ({ state: "error", group: g.name, why });
  const tag = cur.get(g.tagKey);
  const from = cur.get(g.digestKey);
  if (!tag) return err(`${g.tagKey} is empty`);
  if (!from) return err(`${g.digestKey} is empty`);
  let idx: OciIndex;
  try {
    idx = await oci.index(g.repository, tag);
  } catch (e) {
    return err(`${g.repository}:${tag}: ${msg(e)}`);
  }
  if (!DIGEST.test(idx.digest)) return err(`${g.repository}:${tag}: index digest is not sha256`);
  if (idx.digest === from) return { state: "current", group: g.name, version: short(from) };
  const values: Record<string, string> = { [g.digestKey]: idx.digest };
  const evidence = [`${g.repository}:${tag} index ${idx.digest} (was ${from})`, ...idx.images.map((i) => `linux/${i.arch} ${i.digest} created ${i.created?.toISOString() ?? "unknown"}`)];
  if (g.snapshot) {
    if (!idx.created) return err("image build time unknown: no apt snapshot id can be derived");
    const id = snapshotAfter(idx.created);
    const was = cur.get(g.snapshot.key) ?? "";
    if (SNAPSHOT_ID.test(was) && id < was) return err(`derived snapshot ${id} is older than the pinned ${was}`);
    let ok: boolean;
    try {
      ok = await snap.exists(g.snapshot.base, id, g.snapshot.suite);
    } catch (e) {
      return err(`apt snapshot ${id}: ${msg(e)}`);
    }
    if (!ok) return { state: "held", group: g.name, why: `apt snapshot ${id} has no ${g.snapshot.suite} InRelease yet` };
    values[g.snapshot.key] = id;
    evidence.push(`apt snapshot ${id}: ${g.snapshot.base}/${id}/dists/${g.snapshot.suite}/InRelease present (first midnight UTC after the newest image build)`);
  }
  return { state: "newer", group: g.name, from: short(from), to: short(idx.digest), publishedAt: idx.created, values, evidence, propose: g.propose, ...(g.note ? { note: g.note } : {}) };
}
