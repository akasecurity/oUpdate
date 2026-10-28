// Tools pinned to a GitHub release and the sha256 of release assets the build downloads. The version is
// the newest non-draft, non-prerelease release whose tag fits the group's template; each hash is the
// asset's published `digest` (the same field the app-bundle phase trusts), and an asset must sit on the
// project's own release download path. `assetKeys` are rewritten to that asset's file name at the new
// version, so a pin like TOOL_ASSET stays in step with the version and the hash.

import { newer, realAppNet, type GhRelease } from "../../apply/appbundle.ts";
import type { GithubGroup } from "./config.ts";
import type { Discovery } from "./discovery.ts";

export type DatedRelease = GhRelease & { published_at?: string };

export interface GithubSource {
  /** The repository's releases, newest first (the API returns published_at with each). */
  releases(repo: string): Promise<DatedRelease[]>;
}

export const realGithubSource: GithubSource = {
  releases: async (repo) => (await realAppNet.releases(repo)) as DatedRelease[],
};

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** "tool-v{v}" as a regex capturing x.y.z, anchored at both ends. */
export function tagPattern(template: string): RegExp {
  const [pre = "", post = ""] = template.split("{v}");
  return new RegExp(`^${esc(pre)}(\\d+\\.\\d+\\.\\d+)${esc(post)}$`);
}

const SHA256 = /^sha256:([0-9a-f]{64})$/;
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const when = (s: string | undefined) => {
  if (!s) return undefined;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? undefined : d;
};

export async function discoverGithub(g: GithubGroup, cur: Map<string, string>, src: GithubSource): Promise<Discovery> {
  const err = (why: string): Discovery => ({ state: "error", group: g.name, why });
  const from = cur.get(g.versionKey);
  if (!from) return err(`${g.versionKey} is empty`);
  try {
    const re = tagPattern(g.tag);
    let best: { rel: DatedRelease; v: string } | undefined;
    for (const rel of await src.releases(g.repo)) {
      if (rel.draft || rel.prerelease) continue;
      const m = rel.tag_name.match(re);
      if (m && (!best || newer(m[1]!, best.v))) best = { rel, v: m[1]! };
    }
    if (!best) return err(`no stable release of ${g.repo} has a tag like ${g.tag}`);
    const { rel, v } = best;
    if (!newer(v, from)) return { state: "current", group: g.name, version: from, ...(v !== from ? { note: `newest release ${v} is not newer than the pin` } : {}) };
    const publishedAt = when(rel.published_at);
    const prefix = `https://github.com/${g.repo}/releases/download/`;
    const values: Record<string, string> = { [g.versionKey]: v };
    const evidence = [`github ${g.repo} ${rel.tag_name} (${from} -> ${v}), published ${publishedAt?.toISOString() ?? "unknown"}`];
    for (const [key, template] of Object.entries(g.assets)) {
      const name = template.replaceAll("{v}", v);
      const hits = rel.assets.filter((a) => a.name === name);
      if (hits.length !== 1) return err(`${rel.tag_name} has ${hits.length} assets named ${name}`);
      const a = hits[0]!;
      if (!a.browser_download_url.startsWith(prefix)) return err(`${name} is not on ${g.repo}'s release path`);
      const m = (a.digest ?? "").match(SHA256);
      if (!m) return err(`${name} has no published sha256 digest`);
      values[key] = m[1]!;
      evidence.push(`${key}: ${name} sha256 ${m[1]} (${a.browser_download_url})`);
    }
    for (const [key, template] of Object.entries(g.assetKeys ?? {})) {
      const name = template.replaceAll("{v}", v);
      const hits = rel.assets.filter((a) => a.name === name);
      if (hits.length !== 1) return err(`${rel.tag_name} has ${hits.length} assets named ${name}`);
      const a = hits[0]!;
      if (!a.browser_download_url.startsWith(prefix)) return err(`${name} is not on ${g.repo}'s release path`);
      values[key] = name;
      evidence.push(`${key}: ${name} (${a.browser_download_url})`);
    }
    return { state: "newer", group: g.name, from, to: v, publishedAt, values, evidence, propose: g.propose, ...(g.note ? { note: g.note } : {}) };
  } catch (e) {
    return err(`github ${g.repo}: ${msg(e)}`);
  }
}
