// npm-published tools pinned by version, plus the sha512 integrity of each tarball the build fetches
// (main package and platform packages). The latest is npm's dist-tags.latest; only a plain x.y.z newer
// than the pin is a bump, so a registry answer can never propose a downgrade or a prerelease.

import { createHash } from "node:crypto";
import { newer } from "../../apply/appbundle.ts";
import { npmIntegrity, npmRegistry } from "../../adapters/ecosystem/npm.ts";
import type { NpmGroup } from "./config.ts";
import { PLAIN_VERSION, type Discovery } from "./discovery.ts";

export interface NpmSource {
  latest(name: string): Promise<string | undefined>;
  publishedAt(name: string, version: string): Promise<Date | undefined>;
  integrity(name: string, version: string): Promise<string | undefined>;
}

export function realNpmSource(base?: string): NpmSource {
  const deps = base ? { base } : {};
  const reg = npmRegistry(deps);
  return { latest: (n) => reg.latest(n), publishedAt: (n, v) => reg.publishedAt(n, v), integrity: (n, v) => npmIntegrity(n, v, deps) };
}

/** sha512 SRI: 64 bytes in base64 is 86 characters and "==". */
export const SRI = /^sha512-[A-Za-z0-9+/]{86}==$/;

/** The sha512 SRI of some bytes, the form dist.integrity and the pins carry. */
export function sriOf(bytes: Uint8Array): string {
  return `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
}

/**
 * Downloads a tarball and returns its bytes only when their sha512 is `sri` (the integrity the pins or the
 * proposal carry), so the artifact review reads the very bytes the build will fetch. No sri: no check.
 */
export async function fetchVerified(f: typeof fetch, url: string, sri: string | undefined): Promise<Uint8Array> {
  const r = await f(url);
  if (!r.ok) throw new Error(`download ${r.status} for ${url}`);
  const bytes = new Uint8Array(await r.arrayBuffer());
  if (sri !== undefined) {
    const got = sriOf(bytes);
    if (got !== sri) throw new Error(`integrity mismatch for ${url}: the bytes are ${got}, the proposal pins ${sri}`);
  }
  return bytes;
}

/** "name@{v}suffix" at version v: the package name and the version string to read. */
export function npmSpec(template: string, v: string): { name: string; version: string } {
  const at = template.lastIndexOf("@");
  return { name: template.slice(0, at), version: template.slice(at + 1).replace("{v}", v) };
}

/** The characters a semver (with prerelease and build parts, or a leading "v") can hold. */
const VERSION_TOKEN = /^[A-Za-z0-9.+-]+$/;

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export async function discoverNpm(g: NpmGroup, cur: Map<string, string>, src: NpmSource): Promise<Discovery> {
  const err = (why: string): Discovery => ({ state: "error", group: g.name, why });
  const from = cur.get(g.versionKey);
  if (!from) return err(`${g.versionKey} is empty`);
  try {
    const latest = await src.latest(g.package);
    if (!latest) return err(`npm has no latest for ${g.package}`);
    // Only semver characters can be held as a prerelease or odd release; anything else is a hostile answer.
    if (!VERSION_TOKEN.test(latest.trim())) return err(`npm latest for ${g.package} is not a version string`);
    if (!PLAIN_VERSION.test(latest)) return { state: "held", group: g.name, why: `npm latest ${latest.trim()} is not a plain x.y.z release` };
    if (!newer(latest, from)) return { state: "current", group: g.name, version: from, ...(latest !== from ? { note: `npm latest ${latest} is not newer than the pin` } : {}) };
    const publishedAt = await src.publishedAt(g.package, latest);
    const values: Record<string, string> = { [g.versionKey]: latest };
    const evidence = [`npm ${g.package} ${from} -> ${latest}, published ${publishedAt?.toISOString() ?? "unknown"}`];
    for (const [key, template] of Object.entries(g.integrity)) {
      const { name, version } = npmSpec(template, latest);
      const sri = await src.integrity(name, version);
      if (!sri || !SRI.test(sri)) return err(`no sha512 integrity for ${name}@${version}`);
      values[key] = sri;
      evidence.push(`${key}: ${name}@${version} dist.integrity ${sri}`);
    }
    return { state: "newer", group: g.name, from, to: latest, publishedAt, values, evidence, propose: g.propose, ...(g.note ? { note: g.note } : {}) };
  } catch (e) {
    return err(`npm ${g.package}: ${msg(e)}`);
  }
}
