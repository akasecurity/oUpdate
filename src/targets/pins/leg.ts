// The image pin-bump proposal: reads the pins file at the reach's base commit,
// finds newer pinned values per group, holds each for cooldown, reviews npm bumps' release artifacts and
// then the pins diff, and on APPROVE writes a branch with the bump and a proposal for the image owner.
// It never edits a checkout, never merges, and never pushes to the base branch (a branch at most).
// Every pins key is accounted for each run: in a group, fixed, not checked (logged) or unknown (trouble).

import { join } from "node:path";
import type { OciSource } from "../../adapters/oci/registry.ts";
import { cooldownVerdict } from "../../cooldown.ts";
import type { Reviewer, ReviewResult } from "../../review.ts";
import type { LegResult } from "../model.ts";
import { GIT_ENV } from "../reach.ts";
import type { LegRunner, TargetFs } from "../run.ts";
import { groupKeys, type NpmGroup, type PinBumpLeg, type PinGroup } from "./config.ts";
import type { Discovery } from "./discovery.ts";
import { parsePins, pinValues, pinsDiff, renderPins, setPins, type PinsFile } from "./file.ts";
import { discoverDocker, type DockerIndexSource } from "./docker.ts";
import { discoverGithub, type GithubSource } from "./github.ts";
import { discoverNpm, npmSpec, type NpmSource } from "./npm.ts";
import { discoverOci, type SnapshotSource } from "./oci.ts";
import { askCommit, branchExists, branchHolds, branchName, proposeBranch, proposalText, type ProposeResult } from "./propose.ts";
import { reviewPins, type PinChange } from "./review.ts";

export interface PinSources {
  npm: NpmSource;
  github: GithubSource;
  oci: OciSource;
  snapshot: SnapshotSource;
  docker: DockerIndexSource;
}

/**
 * One npm tarball an npm bump changes, with the integrity the old pins and the proposal carry for it: the
 * review must check the downloaded bytes against these before reading them. No integrity is a package
 * the pins do not hash (the main package when only platform packages are pinned).
 */
export interface NpmPayload {
  name: string;
  from: string;
  to: string;
  fromIntegrity?: string;
  toIntegrity?: string;
}

/** Every tarball of an npm group's bump: each pinned integrity, plus the main package if it is not one of them. */
export function npmPayloads(g: NpmGroup, cur: Map<string, string>, from: string, to: string, values: Record<string, string>): NpmPayload[] {
  const out: NpmPayload[] = [];
  for (const [key, template] of Object.entries(g.integrity)) {
    const a = npmSpec(template, from);
    const b = npmSpec(template, to);
    const old = cur.get(key);
    out.push({ name: b.name, from: a.version, to: b.version, ...(old ? { fromIntegrity: old } : {}), ...(values[key] ? { toIntegrity: values[key] } : {}) });
  }
  if (!out.some((p) => p.name === g.package && p.to === to)) out.unshift({ name: g.package, from, to });
  return out;
}

export interface PinLegDeps {
  sources: PinSources;
  /** Reviews the pins diff; undefined is "no reviewer configured" (nothing is proposed). */
  reviewer: Reviewer | undefined;
  /**
   * Artifact review of one npm tarball (cli.ts runReview in production: advisory, prepass and reviewer
   * layers, over bytes verified against the payload's integrity).
   */
  reviewNpm: (p: NpmPayload) => Promise<ReviewResult>;
  fs: TargetFs;
  timeoutMs: number;
  /** Where the temporary git index goes. */
  tmpDir: string;
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

function discover(g: PinGroup, cur: Map<string, string>, s: PinSources): Promise<Discovery> {
  if (g.source === "npm") return discoverNpm(g, cur, s.npm);
  if (g.source === "github-release") return discoverGithub(g, cur, s.github);
  if (g.source === "docker-static") return discoverDocker(g, cur, s.docker);
  return discoverOci(g, cur, s.oci, s.snapshot);
}

export function pinBumpRunner(deps: PinLegDeps): LegRunner<PinBumpLeg> {
  return async (leg, ctx): Promise<LegResult> => {
    const lines: string[] = [];
    const r = ctx.reach;
    if ("plugin" in r || r.kind !== "git") return { lines, summary: "error: pin-bump needs a git reach", trouble: true };
    const shown = await r.exec(["git", "-C", r.repo, "show", `${r.baseSha}:${leg.pinsPath}`], { env: GIT_ENV, timeoutMs: deps.timeoutMs });
    if (shown.rc !== 0) return { lines, summary: `not checked — cannot read ${leg.pinsPath} at ${r.remote}/${r.base}`, trouble: true };
    let file: PinsFile;
    try {
      file = parsePins(shown.out);
    } catch (e) {
      return { lines, summary: `not checked — ${leg.pinsPath}: ${msg(e)}`, trouble: true };
    }
    const cur = pinValues(file);
    lines.push(`${leg.pinsPath} at ${r.remote}/${r.base} ${r.baseSha.slice(0, 12)}: ${cur.size} pins`);

    const named = new Set([...leg.groups.flatMap(groupKeys), ...leg.fixed, ...Object.keys(leg.notChecked)]);
    const unknown = [...cur.keys()].filter((k) => !named.has(k));
    for (const k of unknown) lines.push(`not checked: ${k} is not named in the leg config (unknown pin)`);
    for (const [k, why] of Object.entries(leg.notChecked)) lines.push(`not checked: ${k} (${why})`);

    /** npm: the tarballs whose release artifacts are reviewed before the bump is proposed. */
    let accepted: { change: PinChange; values: Record<string, string>; npm?: NpmPayload[] }[] = [];
    const held: string[] = [];
    const notProposed: string[] = [];
    const flagged: string[] = [];
    const errors: string[] = [];

    for (const g of leg.groups) {
      const missing = groupKeys(g).filter((k) => !cur.has(k));
      if (missing.length) {
        errors.push(`${g.name} (missing ${missing.join(" ")})`);
        lines.push(`${g.name}: error: ${missing.join(" ")} not in ${leg.pinsPath}`);
        continue;
      }
      let d: Discovery;
      try {
        d = await discover(g, cur, deps.sources);
      } catch (e) {
        d = { state: "error", group: g.name, why: msg(e) };
      }
      if (d.state === "current") {
        lines.push(`${g.name}: current ${d.version}${d.note ? ` (${d.note})` : ""}`);
        continue;
      }
      if (d.state === "held") {
        held.push(`${g.name} (${d.why})`);
        lines.push(`${g.name}: held: ${d.why}`);
        continue;
      }
      if (d.state === "error") {
        errors.push(`${g.name} (${d.why})`);
        lines.push(`${g.name}: error: ${d.why}`);
        continue;
      }
      lines.push(`${g.name}: ${d.from} -> ${d.to}`, ...d.evidence.map((e) => `  ${e}`));
      if (!d.propose) {
        notProposed.push(`${g.name} ${d.to}${d.note ? ` (${d.note})` : ""}`);
        lines.push(`${g.name}: newer, not proposed${d.note ? `: ${d.note}` : ""}`);
        continue;
      }
      const cool = cooldownVerdict({ publishedAt: d.publishedAt, now: ctx.now, days: leg.cooldownDays, advisoryFix: false });
      if (!cool.eligible) {
        held.push(`${g.name} ${d.to} (${cool.reason.replace(/^held: /, "")})`);
        lines.push(`${g.name}: ${cool.reason}`);
        continue;
      }
      accepted.push({ change: { group: g.name, from: d.from, to: d.to, evidence: d.evidence }, values: d.values, ...(g.source === "npm" ? { npm: npmPayloads(g, cur, d.from, d.to, d.values) } : {}) });
    }

    const nc = Object.keys(leg.notChecked).length;
    const done = (head: string, trouble = false): LegResult => {
      const parts = [head];
      if (held.length) parts.push(`held: ${held.join(", ")}`);
      if (notProposed.length) parts.push(`newer, not proposed: ${notProposed.join(", ")}`);
      if (flagged.length) parts.push(`FLAGGED: ${flagged.join(", ")}`);
      if (errors.length) parts.push(`error: ${errors.join(", ")}`);
      if (unknown.length) parts.push(`not checked: unknown pins ${unknown.join(" ")}`);
      if (nc) parts.push(`not checked: ${nc} pin${nc === 1 ? "" : "s"} (see log)`);
      return { lines, summary: parts.join("; "), trouble: trouble || flagged.length > 0 || errors.length > 0 || unknown.length > 0 };
    };

    const proposal = () => {
      const next = setPins(file, Object.assign({}, ...accepted.map((a) => a.values)) as Record<string, string>);
      const text = renderPins(next);
      const changes = accepted.map((a) => a.change);
      return { next, text, changes, list: changes.map((c) => `${c.group} ${c.from}→${c.to}`).join(", "), branch: branchName(leg.branchPrefix, leg.pinsPath, text) };
    };
    const askFor = (branch: string) => join(leg.proposalDir, `${ctx.target.id}-${branch.replaceAll("/", "-")}.txt`);
    /**
     * A bump already on its branch: no review again, but the branch must hold exactly this proposal and its
     * proposal (the APPROVE record) must name the branch tip before anything is pushed; else trouble.
     */
    const already = async (branch: string, list: string, text: string): Promise<LegResult> => {
      const h = await branchHolds({ exec: r.exec, repo: r.repo, branch, baseSha: r.baseSha, pinsPath: leg.pinsPath, text, timeoutMs: deps.timeoutMs });
      if (!h.ok) {
        lines.push(`branch ${branch} exists but ${h.why}; not pushed`);
        return done(`pins error: branch ${branch} exists but ${h.why}; not pushed (${list})`, true);
      }
      lines.push(`branch ${branch} at ${h.commit} already holds this bump`);
      const askPath = askFor(branch);
      const ask = await deps.fs.readFile(askPath);
      if (ask === undefined) return done(`pins already proposed ${branch} (${list}); error: proposal ${askPath} is missing, not pushed`, true);
      const recorded = askCommit(ask);
      if (recorded !== h.commit)
        return done(`pins already proposed ${branch} (${list}); error: proposal ${askPath} records ${recorded?.slice(0, 12) ?? "no commit"}, not the branch tip ${h.commit.slice(0, 12)}; not pushed`, true);
      if (leg.push && !ctx.dryRun) {
        const p = await r.exec(["git", "-C", r.repo, "push", "--porcelain", r.remote, `refs/heads/${branch}:refs/heads/${branch}`], { env: GIT_ENV, timeoutMs: deps.timeoutMs });
        if (p.rc !== 0) return done(`pins already proposed ${branch} (${list}); error: push failed (rc ${p.rc}: ${p.err.trim().split("\n")[0] ?? ""})`, true);
        lines.push(`branch ${branch} is on ${r.remote}`);
      }
      return done(`pins already proposed ${branch} (${list})`);
    };

    if (!accepted.length) return done(held.length || notProposed.length || flagged.length || errors.length ? "pins nothing to propose" : "pins current");
    let prop: ReturnType<typeof proposal>;
    try {
      prop = proposal();
    } catch (e) {
      errors.push(`proposal (${msg(e)})`);
      return done("pins nothing to propose", true);
    }
    if (await branchExists(r.exec, r.repo, prop.branch, deps.timeoutMs)) return already(prop.branch, prop.list, prop.text);

    // npm bumps: the release artifact review, only for a bump not proposed yet.
    const reviewed: typeof accepted = [];
    for (const a of accepted) {
      if (a.npm === undefined) {
        reviewed.push(a);
        continue;
      }
      const name = a.change.group;
      let ok = true;
      for (const pl of a.npm) {
        const what = `${pl.name}@${pl.to}`;
        let rv: ReviewResult | undefined;
        let crash = "";
        try {
          rv = await deps.reviewNpm(pl);
        } catch (e) {
          crash = msg(e);
        }
        if (!rv) {
          errors.push(`${name} (artifact review of ${what}: ${crash})`);
          lines.push(`${name}: artifact review of ${what} failed: ${crash}`);
          ok = false;
          break;
        }
        if (rv.decision !== "land") {
          const bad = rv.layers.filter((l) => l.verdict === "stop" || l.verdict === "error");
          (bad.some((l) => l.verdict === "stop") ? flagged : errors).push(`${name} ${a.change.to}`);
          lines.push(`${name}: artifact review of ${what} held it: ${bad.map((l) => `${l.layer} ${l.verdict}: ${l.detail}`).join("; ") || "held"}`);
          ok = false;
          break;
        }
        lines.push(`${name}: artifact review of ${what} passed`);
      }
      if (!ok) continue;
      reviewed.push(a);
    }
    if (reviewed.length !== accepted.length) {
      accepted = reviewed;
      if (!accepted.length) return done("pins nothing to propose");
      prop = proposal();
      if (await branchExists(r.exec, r.repo, prop.branch, deps.timeoutMs)) return already(prop.branch, prop.list, prop.text);
    }
    const { next, text, changes, list, branch } = prop;
    const v = await reviewPins(deps.reviewer, { pinsPath: leg.pinsPath, changes, diff: pinsDiff(file, next) });
    lines.push(`pins review: ${v.verdict} (${v.detail})`, ...(v.text ? v.text.split("\n").map((l) => `│ ${l}`) : []));
    if (v.verdict === "FLAG") return done(`pins FLAGGED by ${v.detail} (${list})`, true);
    if (v.verdict === "error") return done(`pins review error: ${v.detail} (${list})`, true);
    if (ctx.dryRun) return done(`pins would propose ${branch} (${list})`);

    const indexFile = join(deps.tmpDir, `oupdate-pins-index-${process.pid}-${Date.now()}`);
    let p: ProposeResult;
    try {
      p = await proposeBranch({
        exec: r.exec, repo: r.repo, remote: r.remote, base: r.base, baseSha: r.baseSha, pinsPath: leg.pinsPath, text, branch,
        message: `chore: bump ${changes.map((c) => `${c.group} ${c.to}`).join(", ")} (oupdate proposal)\n\nReviewed by ${v.detail} (APPROVE). Rebuild, scan and re-bake from this branch before merging.\n`,
        author: leg.author, push: leg.push, timeoutMs: deps.timeoutMs, indexFile,
      });
    } finally {
      await deps.fs.remove(indexFile).catch(() => {});
    }
    if (!p.ok) return done(`pins proposal failed: ${p.why} (${list})`, true);
    lines.push(`branch ${branch} at ${p.commit}${p.pushed ? `, pushed to ${r.remote}` : ""}`);
    const askPath = askFor(branch);
    try {
      await deps.fs.writeFile(askPath, proposalText({ target: ctx.target.id, repo: r.repo, remote: r.remote, base: r.base, baseSha: r.baseSha, branch, commit: p.commit, pushed: p.pushed, pinsPath: leg.pinsPath, changes, reviewer: v.detail, held }));
      lines.push(`proposal: ${askPath}`);
    } catch (e) {
      return done(`pins proposed ${branch} (${list}); proposal not written: error ${msg(e)}`, true);
    }
    if (p.pushError) return done(`pins proposed ${branch} locally, push failed: ${p.pushError} (${list})`, true);
    return done(`pins proposed ${branch} (${list})`);
  };
}
