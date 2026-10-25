// App-bundle upgrades (apply.appBundles): a macOS .app that is installed outside brew and published
// as a signed, notarized disk image on the project's GitHub release (e.g. a model server app: its bundle ships
// precompiled Metal kernels that brew's bottle lacks). Dry-run by default like everything else.
//
// A release is installed only when every gate passes, in this order:
//   1. a stable release (not a prerelease, tag vX.Y.Z) newer than the installed bundle;
//   2. one asset matches the configured pattern, with a sha256 digest and a download url on the
//      project's own GitHub release path;
//   3. the release's supply-chain surface (git diff of the project's tags, the same reading as an
//      upstream tap) has no deterministic finding and the reviewer APPROVEs it;
//   4. the downloaded image has the published sha256, and the new bundle has the installed
//      bundle's id and Team ID, is accepted by Gatekeeper as notarized Developer ID code of that
//      team, passes a strict codesign check and carries the release's version.
// Then the old bundle is renamed `<app>.bak-oupdate-<oldver>` (kept for revert) and the new one
// takes its place. The restart is handed detached to the configured waiter, with the backup path
// last: the running server still maps the renamed bundle, which is what the waiter watches for.

import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Reviewer } from "../review.ts";
import { chunkedReview, type Caps } from "./chunked.ts";
import type { Exec } from "./exec.ts";
import { realGates } from "./gatekeeper.ts";
import { VERDICT_CONTRACT } from "./formula.ts";
import { gatherSurface, type Git } from "./surface.ts";

export interface AppBundle {
  name: string;
  /** The installed bundle, an absolute path ending in .app. */
  app: string;
  /** The project's GitHub repository, "owner/name". */
  repo: string;
  /** A regular expression matched against release asset names; exactly one asset must match. */
  asset: string;
  /** Run detached with the backup path appended after an upgrade (argv[0] absolute); absent: no restart is started. */
  restart?: string[];
}

export interface GhAsset {
  name: string;
  browser_download_url: string;
  digest?: string;
}

export interface GhRelease {
  tag_name: string;
  prerelease: boolean;
  draft: boolean;
  assets: GhAsset[];
}

export interface AppEnv {
  exec: Exec;
  git: Git;
  /** The repository's releases, newest first. */
  releases(repo: string): Promise<GhRelease[]>;
  download(url: string, dest: string): Promise<void>;
  sha256(file: string): Promise<string>;
  exists(path: string): Promise<boolean>;
  mkdir(path: string): Promise<void>;
  /** Removes a path this run created. */
  remove(path: string): Promise<void>;
  spawnDetached(argv: string[], stderrFile: string): Promise<number>;
}

export interface AppOptions {
  dryRun: boolean;
  host: string;
  logFile?: string;
  stateDir: string;
  notify: (text: string) => void | Promise<void>;
  caps?: Caps;
  /** The detached restart's stderr file. */
  detachedLog: string;
}

export interface AppResult {
  /** current: nothing newer; dry-run: would upgrade; upgraded; held: a gate said no (FLAG); failed: it broke. */
  status: "current" | "dry-run" | "upgraded" | "held" | "failed";
  note: string;
  log: string[];
}

const STABLE_TAG = /^v(\d+)\.(\d+)\.(\d+)$/;
const SLUG = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

const triple = (v: string) => v.replace(/^v/, "").split(".").map((n) => Number.parseInt(n, 10));
export function newer(a: string, b: string): boolean {
  const x = triple(a);
  const y = triple(b);
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  return false;
}

/** The newest stable release: not a draft or prerelease, tag exactly vX.Y.Z. */
export function latestStable(rels: GhRelease[]): GhRelease | undefined {
  let best: GhRelease | undefined;
  for (const r of rels) {
    if (r.draft || r.prerelease || !STABLE_TAG.test(r.tag_name)) continue;
    if (!best || newer(r.tag_name, best.tag_name)) best = r;
  }
  return best;
}

const TAIL = `Check for these explicit attack indicators only:
1. A new network-touching install, build or release step (curl/wget/git clone, a download or socket call in a script, a Makefile, a build hook) — FLAG with quoted line
2. A new or changed dependency from an unexpected source or version: a url, a VCS or direct reference, another index, a typosquat-like name, or a pin loosened to anything — FLAG with quoted line
3. A new install/postinstall hook, an added executable or binary, or a workflow change that reads secrets, publishes, or fetches and runs code — FLAG with quoted line
4. A release or packaging change that sends the built app somewhere other than the project's own GitHub release, or signs it with a different identity — FLAG with quoted line
5. Obfuscation (base64/hex blobs, eval, string-built commands) — FLAG with quoted line
Ordinary version bumps, new registry-pinned dependencies of well-known packages and build-flag changes are APPROVE.

${VERDICT_CONTRACT}
If FLAG, quote the specific offending line(s) verbatim and name the indicator from the list above. 12 lines max.`;

/** Reads one value of an Info.plist, or "". */
async function plistValue(env: AppEnv, app: string, key: string): Promise<string> {
  const r = await env.exec(["/usr/bin/plutil", "-extract", key, "raw", "-o", "-", join(app, "Contents", "Info.plist")]);
  return r.rc === 0 ? r.out.trim() : "";
}

async function teamOf(env: AppEnv, app: string): Promise<string> {
  return (await realGates(env.exec).team(app)) || "";
}

export async function appBundleUpgrade(env: AppEnv, r: Reviewer, b: AppBundle, o: AppOptions): Promise<AppResult> {
  const log: string[] = [];
  const say = (s: string) => void log.push(`  ${b.name}: ${s}`);
  const tell = async (text: string) => {
    try {
      await o.notify(text);
    } catch {
      say("the notice could not be sent");
    }
  };
  const held = async (why: string): Promise<AppResult> => {
    say(`${why} — FLAG, not upgrading`);
    await tell(`⚠️ <b>${o.host} app bundle FLAG — ${b.name}</b>\n${why}\nLog: ${o.logFile ?? "-"}`);
    return { status: "held", note: `${b.name} held: ${why}`, log };
  };
  const failed = async (why: string): Promise<AppResult> => {
    say(`FAILED: ${why}`);
    await tell(`${o.host} app bundle FAILED: ${b.name}; ${why}; log: ${o.logFile ?? "-"}`);
    return { status: "failed", note: `${b.name} FAILED: ${why}`, log };
  };

  if (!SLUG.test(b.repo)) return failed(`bad repo ${JSON.stringify(b.repo)}`);
  let assetRe: RegExp;
  try {
    assetRe = new RegExp(b.asset);
  } catch {
    return failed("asset is not a valid regular expression");
  }
  const oldVer = await plistValue(env, b.app, "CFBundleShortVersionString");
  const bundleId = await plistValue(env, b.app, "CFBundleIdentifier");
  const team = await teamOf(env, b.app);
  if (!oldVer || !bundleId || !team) return failed(`cannot read the installed bundle (version '${oldVer}', id '${bundleId}', team '${team}')`);

  let rels: GhRelease[];
  try {
    rels = await env.releases(b.repo);
  } catch (e) {
    return failed(`cannot list releases (${e instanceof Error ? e.message : "error"})`);
  }
  const rel = latestStable(rels);
  if (!rel) return failed("no stable release found");
  const newVer = rel.tag_name.replace(/^v/, "");
  if (!newer(rel.tag_name, oldVer)) {
    say(`current (${oldVer}; latest stable ${newVer})`);
    return { status: "current", note: "", log };
  }
  say(`${oldVer} → ${newVer}`);

  const hits = rel.assets.filter((a) => assetRe.test(a.name));
  if (hits.length !== 1) return held(`${hits.length} release assets match ${b.asset} (need exactly 1)`);
  const asset = hits[0]!;
  const digest = asset.digest?.match(/^sha256:([0-9a-f]{64})$/)?.[1];
  if (!digest) return held(`asset ${asset.name} has no sha256 digest`);
  if (!asset.browser_download_url.startsWith(`https://github.com/${b.repo}/releases/download/`)) return held(`asset url is not on ${b.repo}'s release path: ${asset.browser_download_url}`);

  // ── the release surface ──
  const work = join(o.stateDir, "appbundle", b.name);
  const gitDir = join(work, "src.git");
  await env.mkdir(work);
  const url = `https://github.com/${b.repo}.git`;
  const fetched = (await env.exists(gitDir))
    ? await env.git(gitDir, ["fetch", "--force", "origin", "+refs/tags/*:refs/tags/*"])
    : await env.exec(["git", "clone", "--bare", "--filter=blob:none", url, gitDir]).then((c) => ({ rc: c.rc, out: c.out }));
  if (fetched.rc !== 0) return failed("cannot fetch the project's source tags");
  const oldTag = `v${oldVer}`;
  for (const t of [oldTag, rel.tag_name]) {
    if ((await env.git(gitDir, ["rev-parse", "--verify", "--quiet", `refs/tags/${t}^{commit}`])).rc !== 0) return held(`tag ${t} is not in the project's source`);
  }
  const g = await gatherSurface(env.git, gitDir, `refs/tags/${oldTag}`, `refs/tags/${rel.tag_name}`);
  if (!g.ok) return held(`the release diff cannot be established (${g.why})`);
  if (g.surface.findings.length) return held(`release surface — manual review: ${g.surface.findings.join("; ")}`);
  let body = "";
  for (const f of g.surface.files) body += `${body ? "\n" : ""}=== ${f.path} (status: release diff ${oldTag}..${rel.tag_name}) ===\n${f.diff}`;
  body += `\n=== release surface summary (status: note) ===\n${g.surface.files.length} surface files shown above; ${g.surface.otherCount} other changed files (source code) not shown.`;
  const res = await chunkedReview(r, {
    title: "App bundle release review",
    label: `${b.name} (app bundle)`,
    upgrade: `${oldVer} → ${newVer}`,
    head: `You are reviewing a new release of a macOS application for supply chain attack indicators.

Package: ${b.name} (${b.repo})
Upgrade: ${oldVer} → ${newVer}
Artifact: the project's own signed, notarized app bundle from its GitHub release (${asset.name}). Its sha256 against the published digest, signer Team ID against the installed bundle, and Gatekeeper notarization are checked separately, deterministically. Below is the supply-chain surface of the release's source diff (build and install scripts, manifests, lockfiles, CI/release workflows, packaging, new executables); other source files are not shown on purpose.`,
    tail: TAIL,
    diff: body,
    diffLabel: "Release supply-chain surface:",
    caps: o.caps,
    host: o.host,
    logFile: o.logFile,
    notify: o.notify,
  });
  log.push(...res.log.map((l) => `  ${l}`));
  if (!res.approved) {
    say(`review FLAG: ${res.reason ?? "no verdict"}`);
    return { status: "held", note: `${b.name} held: review FLAG`, log };
  }
  say(`release surface APPROVEd (${g.surface.files.length} surface files)`);

  if (o.dryRun) {
    say(`dry-run: would install ${asset.name}`);
    return { status: "dry-run", note: "", log };
  }

  // ── download, verify, stage ──
  const rdir = join(work, rel.tag_name);
  const dmg = join(rdir, asset.name);
  const mnt = join(rdir, "mnt");
  const staged = `${b.app}.new-oupdate`;
  let attached = false;
  const cleanup = async () => {
    if (attached) await env.exec(["/usr/bin/hdiutil", "detach", "-force", mnt]);
    attached = false;
    await env.remove(rdir);
    await env.remove(staged);
  };
  try {
    await env.remove(rdir);
    await env.remove(staged);
    await env.mkdir(mnt);
    try {
      await env.download(asset.browser_download_url, dmg);
    } catch (e) {
      return await failed(`download failed (${e instanceof Error ? e.message : "error"})`);
    }
    const got = await env.sha256(dmg);
    if (got !== digest) return await held(`sha256 of ${asset.name} is ${got}, the release publishes ${digest}`);
    const at = await env.exec(["/usr/bin/hdiutil", "attach", "-nobrowse", "-readonly", "-noautoopen", "-mountpoint", mnt, dmg]);
    if (at.rc !== 0) return await failed("cannot mount the disk image");
    attached = true;
    const found = (await env.exec(["/usr/bin/find", mnt, "-maxdepth", "1", "-name", "*.app"])).out.split("\n").filter(Boolean);
    if (found.length !== 1) return await held(`the image holds ${found.length} .app bundles (need exactly 1)`);
    const cp = await env.exec(["/usr/bin/ditto", found[0]!, staged]);
    if (cp.rc !== 0) return await failed("cannot copy the bundle out of the image");
    await env.exec(["/usr/bin/hdiutil", "detach", "-force", mnt]);
    attached = false;

    const newId = await plistValue(env, staged, "CFBundleIdentifier");
    const newVerPlist = await plistValue(env, staged, "CFBundleShortVersionString");
    const newTeam = await teamOf(env, staged);
    if (newId !== bundleId) return await held(`bundle id changed ${bundleId} → ${newId}`);
    if (newTeam !== team) return await held(`signer Team ID changed ${team} → ${newTeam || "unsigned"}`);
    if (newVerPlist !== newVer) return await held(`bundle says version ${newVerPlist}, the release is ${newVer}`);
    const cs = await env.exec(["/usr/bin/codesign", "--verify", "--deep", "--strict", staged]);
    if (cs.rc !== 0) return await held("codesign --verify --deep --strict fails on the new bundle");
    if (!(await realGates(env.exec).notarized(staged, team))) return await held(`Gatekeeper does not accept the new bundle as notarized Developer ID code of ${team}`);
    say(`verified: sha256, bundle id, Team ID ${team}, version, codesign, notarization`);

    // ── swap ──
    const backup = `${b.app}.bak-oupdate-${oldVer}`;
    if (await env.exists(backup)) return await failed(`${backup} already exists — not overwriting it`);
    if ((await env.exec(["/bin/mv", b.app, backup])).rc !== 0) return await failed(`cannot move ${b.app} aside`);
    if ((await env.exec(["/bin/mv", staged, b.app])).rc !== 0) {
      const back = await env.exec(["/bin/mv", backup, b.app]);
      return await failed(`cannot move the new bundle into place${back.rc === 0 ? " (old bundle restored)" : ` — OLD BUNDLE IS AT ${backup}`}`);
    }
    say(`installed ${newVer}; old bundle kept at ${backup} (revert: mv it back over ${basename(b.app)} in ${dirname(b.app)})`);
    let restart = "no restart configured";
    if (b.restart) {
      try {
        const pid = await env.spawnDetached([...b.restart, backup], o.detachedLog);
        restart = `restart handed to ${basename(b.restart[0] ?? "")} (pid ${pid})`;
      } catch {
        restart = `FAILED to start ${basename(b.restart[0] ?? "")} — the old version keeps running`;
      }
    }
    say(restart);
    return { status: "upgraded", note: `${b.name} ${oldVer} → ${newVer} (${restart})`, log };
  } finally {
    await cleanup();
  }
}

/** The network and file operations of the real run; the rest of AppEnv comes from the run's exec, git and spawn. */
export type AppNet = Pick<AppEnv, "releases" | "download" | "sha256" | "exists" | "mkdir" | "remove">;

const GH_TIMEOUT_MS = 60_000;
const DL_TIMEOUT_MS = 30 * 60_000;

export const realAppNet: AppNet = {
  async releases(repo) {
    const res = await fetch(`https://api.github.com/repos/${repo}/releases?per_page=30`, {
      headers: { accept: "application/vnd.github+json", "user-agent": "oupdate" },
      signal: AbortSignal.timeout(GH_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`GitHub releases HTTP ${res.status}`);
    return (await res.json()) as GhRelease[];
  },
  async download(url, dest) {
    const res = await fetch(url, { headers: { "user-agent": "oupdate" }, signal: AbortSignal.timeout(DL_TIMEOUT_MS) });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
    await Bun.write(dest, res);
  },
  sha256: (file) =>
    new Promise((resolve, reject) => {
      const h = createHash("sha256");
      createReadStream(file).on("data", (c) => h.update(c)).on("error", reject).on("end", () => resolve(h.digest("hex")));
    }),
  exists: async (p) => existsSync(p),
  mkdir: async (p) => void mkdirSync(p, { recursive: true }),
  remove: async (p) => void rmSync(p, { recursive: true, force: true }),
};
