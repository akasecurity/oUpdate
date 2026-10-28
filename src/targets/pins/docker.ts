// The Docker CLI static tarball (macOS arm64). Docker publishes no checksums for it, so a newer stable
// docker-<semver>.tgz on the download index is reported and never proposed: the sha256 pin stays a
// first-fetch value someone refreshes by hand, along with the asset name.

import { newer } from "../../apply/appbundle.ts";
import type { DockerStaticGroup } from "./config.ts";
import type { Discovery } from "./discovery.ts";

export interface DockerIndexSource {
  /** Body of the stable aarch64 directory listing. */
  listing(): Promise<string>;
}

export const DOCKER_STATIC_INDEX = "https://download.docker.com/mac/static/stable/aarch64/";

export const realDockerSource: DockerIndexSource = {
  async listing() {
    const r = await fetch(DOCKER_STATIC_INDEX, { headers: { "user-agent": "oupdate" }, signal: AbortSignal.timeout(60_000) });
    if (!r.ok) throw new Error(`docker static index HTTP ${r.status}`);
    return r.text();
  },
};

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** docker-X.Y.Z.tgz, three numeric components, no leading zero, no prerelease or build suffix. */
const STABLE_TGZ = /^docker-(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)\.tgz$/;

/** A same-directory file name: no directory, query, fragment or scheme. */
function sameDirFile(href: string): string | undefined {
  if (href === "" || /[/\\?#:]/.test(href)) return undefined;
  return href;
}

/** The newest stable docker-X.Y.Z.tgz linked as a same-directory href. Other listing text is ignored. */
export function newestDockerTgz(listing: string): string | undefined {
  let best: string | undefined;
  for (const m of listing.matchAll(/href\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) {
    const name = sameDirFile(m[1] ?? m[2] ?? "");
    const v = name?.match(STABLE_TGZ);
    if (!v) continue;
    const ver = `${v[1]}.${v[2]}.${v[3]}`;
    if (!best || newer(ver, best)) best = ver;
  }
  return best;
}

export async function discoverDocker(g: DockerStaticGroup, cur: Map<string, string>, src: DockerIndexSource): Promise<Discovery> {
  const err = (why: string): Discovery => ({ state: "error", group: g.name, why });
  const from = cur.get(g.versionKey);
  if (!from) return err(`${g.versionKey} is empty`);
  try {
    const v = newestDockerTgz(await src.listing());
    if (!v) return err("no stable docker-<semver>.tgz on the index");
    if (!newer(v, from)) return { state: "current", group: g.name, version: from, ...(v !== from ? { note: `newest docker ${v} is not newer than the pin` } : {}) };
    return {
      state: "newer",
      group: g.name,
      from,
      to: v,
      publishedAt: undefined,
      values: { [g.versionKey]: v },
      evidence: [`docker static index docker-${v}.tgz (${from} -> ${v}); no upstream sums, not proposed`],
      propose: false,
      ...(g.note ? { note: g.note } : {}),
    };
  } catch (e) {
    return err(`docker static index: ${msg(e)}`);
  }
}
