#!/usr/bin/env bun
// oupdate CLI. Subcommands: review (one package update), image (one container image repin), gate (forge PRs), host (report-only shadow of the previous updater, --apply, or --launchd-plist), targets (OS targets: --apply [--dry-run] --config FILE; parity --record … --script-log … --date … --ledger …).

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readArtifact, normalizePaths } from "./artifact.ts";
import { reviewUpdate, LAYERS, type LayerName, type ReviewResult } from "./review.ts";
import type { Ecosystem } from "./prepass.ts";
import type { Registry } from "./adapters/ecosystem/types.ts";
import { npmRegistry } from "./adapters/ecosystem/npm.ts";
import { pypiRegistry } from "./adapters/ecosystem/pypi.ts";
import { osvFeed } from "./adapters/advisory/osv.ts";
import { parseReviewerSpec, makeReviewer, type ReviewerSpec } from "./adapters/reviewer/spec.ts";
import { parseScannerSpec, makeScanner, type ScannerSpec } from "./adapters/scanner/spec.ts";
import { giteaForge } from "./adapters/forge/gitea.ts";
import { githubForge } from "./adapters/forge/github.ts";
import type { Forge } from "./adapters/forge/types.ts";
import { runGate } from "./gate.ts";
import { lockKind } from "./lockfile/index.ts";
import { parseHostCommand, hostMain, applyMain, ownerWaiterMain } from "./host/cli.ts";
import { launchdPlist } from "./host/launchd.ts";
import { killLive, realExec } from "./apply/exec.ts";
import { realFs } from "./apply/fs.ts";
import { spawnRunner } from "./host/probe.ts";
import { checkClientKeys, readKeyFiles, renderKeys, failing } from "./clientkeys.ts";
import { appRev, parseTargetsCommand, targetsMain } from "./targets/cli.ts";
import { realTargetFs } from "./targets/run.ts";
import { realNasOsReleases } from "./targets/nas/os.ts";
import { parityMain, parseParityCommand } from "./targets/parity-cli.ts";
import { fetchVerified, realNpmSource } from "./targets/pins/npm.ts";
import { realGithubSource } from "./targets/pins/github.ts";
import { realSnapshotSource } from "./targets/pins/oci.ts";
import { dockerHubSource, parseImageRef, registrySource, type ImageRef } from "./adapters/oci/registry.ts";
import { checkImage, renderImage } from "./image.ts";

export interface ReviewArgs {
  eco: Ecosystem;
  name: string;
  from: string;
  to: string;
  oldArtifact?: string;
  newArtifact?: string;
  /** sha512 SRI the downloaded old / new tarball must match before it is reviewed (the pins and the proposal). */
  oldIntegrity?: string;
  newIntegrity?: string;
  published?: Date;
  now: Date;
  only?: LayerName[];
  reviewer?: ReviewerSpec;
  scanner?: ScannerSpec;
  json?: string;
  cooldownDays: number;
  advisoryFix: boolean;
}

const VALUE_FLAGS = new Set(["--old-artifact", "--new-artifact", "--published", "--now", "--only", "--reviewer", "--scanner", "--json", "--cooldown-days"]);

function date(flag: string, v: string): Date {
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) throw new Error(`${flag}: not a date: ${v}`);
  return d;
}

export function parseReviewArgs(argv: string[]): ReviewArgs {
  const pos: string[] = [];
  const flags = new Map<string, string>();
  let advisoryFix = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--advisory-fix") advisoryFix = true;
    else if (VALUE_FLAGS.has(a)) {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      flags.set(a, v);
    } else if (a.startsWith("--")) throw new Error(`unknown flag ${a}`);
    else pos.push(a);
  }
  const [eco, name, from, to] = pos;
  if (eco !== "npm" && eco !== "pypi") throw new Error(`ecosystem must be npm or pypi, got ${eco ?? "nothing"}`);
  if (!name || !from || !to || pos.length !== 4) throw new Error("usage: oupdate gate [--forge gitea|github] [--endpoint URL] --repo owner/name (--token-file F | --token-env NAME) [--reviewer JSON] [--scanner JSON] [--branch-prefix renovate/]... [--lock PATH]... [--cooldown-days N]\n       oupdate review <npm|pypi> <name> <from> <to> [flags]");
  const out: ReviewArgs = { eco, name, from, to, now: new Date(), cooldownDays: 2, advisoryFix };
  const oldA = flags.get("--old-artifact");
  const newA = flags.get("--new-artifact");
  if (!!oldA !== !!newA) throw new Error("--old-artifact and --new-artifact go together: give both or neither");
  if (oldA && newA) {
    out.oldArtifact = oldA;
    out.newArtifact = newA;
  }
  if (flags.has("--published")) out.published = date("--published", flags.get("--published")!);
  if (flags.has("--now")) out.now = date("--now", flags.get("--now")!);
  if (flags.has("--only")) {
    const only = flags.get("--only")!.split(",").map((s) => s.trim());
    for (const l of only) if (!LAYERS.includes(l as LayerName)) throw new Error(`unknown layer ${l}; layers: ${LAYERS.join(",")}`);
    out.only = only as LayerName[];
  }
  if (flags.has("--reviewer")) out.reviewer = parseReviewerSpec(flags.get("--reviewer")!);
  if (flags.has("--scanner")) out.scanner = parseScannerSpec(flags.get("--scanner")!);
  if (flags.has("--json")) out.json = flags.get("--json")!;
  if (flags.has("--cooldown-days")) {
    const n = Number(flags.get("--cooldown-days"));
    if (!Number.isFinite(n) || n < 0) throw new Error("--cooldown-days must be a number >= 0");
    out.cooldownDays = n;
  }
  return out;
}

async function download(url: string, dir: string, sri?: string): Promise<string> {
  const bytes = await fetchVerified(fetch, url, sri);
  const file = join(dir, decodeURIComponent(new URL(url).pathname.split("/").pop() || "artifact"));
  writeFileSync(file, bytes);
  return file;
}

function render(r: ReviewResult): string {
  const lines = [`${r.eco} ${r.name} ${r.from} -> ${r.to}: ${r.decision.toUpperCase()}`];
  if (r.malicious?.length) lines.push(`  MALICIOUS (${r.malicious.join(", ")}): check where ${r.name} ${r.to} is already installed`);
  for (const l of r.layers) lines.push(`  ${l.layer.padEnd(9)} ${l.verdict.padEnd(7)} ${l.detail}`);
  return lines.join("\n");
}

export async function runReview(a: ReviewArgs): Promise<ReviewResult> {
  const base: Registry = a.eco === "npm" ? npmRegistry() : pypiRegistry();
  const registry: Registry = a.published ? { ...base, publishedAt: async () => a.published } : base;
  const work = mkdtempSync(join(tmpdir(), "oupdate-dl-"));
  try {
    return await reviewUpdate({
      eco: a.eco,
      name: a.name,
      from: a.from,
      to: a.to,
      registry,
      advisories: osvFeed(),
      reviewer: a.reviewer ? makeReviewer(a.reviewer) : undefined,
      scanner: a.scanner ? makeScanner(a.scanner) : undefined,
      cooldownDays: a.cooldownDays,
      now: a.now,
      advisoryFix: a.advisoryFix,
      only: a.only,
      loadArtifacts: async () => {
        if (a.oldArtifact && a.newArtifact) return { old: normalizePaths(await readArtifact(a.oldArtifact)), new: normalizePaths(await readArtifact(a.newArtifact)) };
        // An empty from is a package the old lockfile did not have: diff against nothing.
        const [oldUrl] = a.from ? await registry.artifactUrls(a.name, a.from) : [undefined];
        const [newUrl] = await registry.artifactUrls(a.name, a.to);
        if ((a.from && !oldUrl) || !newUrl) throw new Error(`no published artifact for ${!newUrl ? a.to : a.from}`);
        return {
          old: oldUrl ? normalizePaths(await readArtifact(await download(oldUrl, work, a.oldIntegrity))) : new Map(),
          new: normalizePaths(await readArtifact(await download(newUrl, work, a.newIntegrity))),
        };
      },
    });
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

export type ForgeKind = "gitea" | "github";

export interface GateCliArgs {
  forge: ForgeKind;
  /** The forge's API base. Required for gitea; for github, unset means api.github.com. */
  endpoint?: string;
  repo: string;
  /** Exactly one of these: a file holding the token, or the name of an environment variable holding it. */
  tokenFile?: string;
  tokenEnv?: string;
  /** A PR is gated when its head branch starts with any of these. */
  branchPrefixes: string[];
  /** Empty: the gate looks for each known lockfile name at the repo root. */
  lockPaths: string[];
  cooldownDays: number;
  reviewer?: ReviewerSpec;
  scanner?: ScannerSpec;
}

const GATE_FLAGS = new Set(["--forge", "--endpoint", "--repo", "--token-file", "--token-env", "--branch-prefix", "--lock", "--cooldown-days", "--reviewer", "--scanner"]);

/** `env` supplies GITHUB_API_URL, which Actions sets on GitHub Enterprise Server, as the github endpoint when --endpoint is absent. */
export function parseGateArgs(argv: string[], env: Record<string, string | undefined> = process.env): GateCliArgs {
  const flags = new Map<string, string>();
  const lockPaths: string[] = [];
  const branchPrefixes: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!GATE_FLAGS.has(a)) throw new Error(`unknown flag ${a}`);
    const v = argv[++i];
    if (v === undefined) throw new Error(`${a} needs a value`);
    if (a === "--lock") {
      lockKind(v);
      lockPaths.push(v);
    } else if (a === "--branch-prefix") branchPrefixes.push(v);
    else flags.set(a, v);
  }
  const forge = flags.get("--forge") ?? "gitea";
  if (forge !== "gitea" && forge !== "github") throw new Error(`--forge must be gitea or github, got ${forge}`);
  for (const req of forge === "gitea" ? ["--endpoint", "--repo"] : ["--repo"]) if (!flags.has(req)) throw new Error(`gate needs ${req}`);
  if (flags.has("--token-file") === flags.has("--token-env")) {
    throw new Error(flags.has("--token-file") ? "gate takes --token-file or --token-env, not both" : "gate needs --token-file or --token-env");
  }
  const repo = flags.get("--repo")!;
  if (!/^[^/\s]+\/[^/\s]+$/.test(repo)) throw new Error(`--repo must be owner/name, got ${repo}`);
  const cooldownDays = Number(flags.get("--cooldown-days") ?? 2);
  if (!Number.isFinite(cooldownDays) || cooldownDays < 0) throw new Error("--cooldown-days must be a number >= 0");
  const endpoint = flags.get("--endpoint") ?? (forge === "github" ? env.GITHUB_API_URL || undefined : undefined);
  const out: GateCliArgs = { forge, endpoint, repo, branchPrefixes: branchPrefixes.length ? branchPrefixes : ["renovate/"], lockPaths, cooldownDays };
  if (flags.has("--token-file")) out.tokenFile = flags.get("--token-file")!;
  else out.tokenEnv = flags.get("--token-env")!;
  if (flags.has("--reviewer")) out.reviewer = parseReviewerSpec(flags.get("--reviewer")!);
  if (flags.has("--scanner")) out.scanner = parseScannerSpec(flags.get("--scanner")!);
  return out;
}

/** The forge token from --token-file or the --token-env variable, trimmed. Errors name the source, never the value. */
export async function gateToken(g: GateCliArgs, env: Record<string, string | undefined> = process.env): Promise<string> {
  if (g.tokenEnv !== undefined) {
    const token = (env[g.tokenEnv] ?? "").trim();
    if (!token) throw new Error(`environment variable ${g.tokenEnv} is empty or unset`);
    return token;
  }
  const token = (await Bun.file(g.tokenFile!).text()).trim();
  if (!token) throw new Error(`empty token file ${g.tokenFile}`);
  return token;
}

export function gateForge(g: GateCliArgs, token: string, f?: typeof fetch): Forge {
  return g.forge === "github" ? githubForge({ endpoint: g.endpoint, token, fetch: f }) : giteaForge({ endpoint: g.endpoint!, token, fetch: f });
}

async function gateMain(argv: string[]): Promise<number> {
  const g = parseGateArgs(argv);
  const token = await gateToken(g);
  const pulls = await runGate({
    forge: gateForge(g, token),
    repo: g.repo,
    branchPrefixes: g.branchPrefixes,
    lockPaths: g.lockPaths,
    review: (c) => runReview({ eco: c.eco, name: c.name, from: c.from ?? "", to: c.to, oldIntegrity: c.fromIntegrity, newIntegrity: c.toIntegrity, now: new Date(), cooldownDays: g.cooldownDays, advisoryFix: false, reviewer: g.reviewer, scanner: g.scanner }),
  });
  for (const p of pulls) {
    console.log(`PR #${p.number}: ${p.state}`);
    for (const r of p.results) console.log(render(r).replace(/^/gm, "  "));
  }
  return pulls.some((p) => p.state === "failure") ? 1 : 0;
}

export interface ImageArgs {
  old: ImageRef;
  new: ImageRef;
  platform: string;
  now: Date;
  reviewer?: ReviewerSpec;
  secondReviewer?: ReviewerSpec;
  json?: string;
}

const IMAGE_USAGE = "usage: oupdate image <old-ref> <new-ref> [--platform linux/amd64] [--reviewer JSON] [--second-reviewer JSON] [--now ISO] [--json FILE]";
const IMAGE_FLAGS = new Set(["--platform", "--reviewer", "--second-reviewer", "--now", "--json"]);

export function parseImageArgs(argv: string[]): ImageArgs {
  const pos: string[] = [];
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (IMAGE_FLAGS.has(a)) {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      flags.set(a, v);
    } else if (a.startsWith("--")) throw new Error(`unknown flag ${a}`);
    else pos.push(a);
  }
  if (pos.length !== 2) throw new Error(IMAGE_USAGE);
  const old = parseImageRef(pos[0]!);
  const now = parseImageRef(pos[1]!);
  if (old.registry !== now.registry || old.repository !== now.repository) throw new Error(`the two refs must name the same repository: ${old.registry}/${old.repository} and ${now.registry}/${now.repository}`);
  const platform = flags.get("--platform") ?? "linux/amd64";
  if (!/^[a-z0-9]+\/[a-z0-9_]+(\/[a-z0-9]+)?$/.test(platform)) throw new Error(`--platform must be os/arch[/variant], got ${platform}`);
  const out: ImageArgs = { old, new: now, platform, now: flags.has("--now") ? date("--now", flags.get("--now")!) : new Date() };
  if (flags.has("--reviewer")) out.reviewer = parseReviewerSpec(flags.get("--reviewer")!);
  if (flags.has("--second-reviewer")) out.secondReviewer = parseReviewerSpec(flags.get("--second-reviewer")!);
  if (flags.has("--json")) out.json = flags.get("--json")!;
  return out;
}

async function imageMain(argv: string[]): Promise<number> {
  const a = parseImageArgs(argv);
  const r = await checkImage(a, {
    source: registrySource(),
    reviewers: { primary: a.reviewer ? makeReviewer(a.reviewer) : undefined, secondary: a.secondReviewer ? makeReviewer(a.secondReviewer) : undefined },
  });
  if (a.json) writeFileSync(a.json, JSON.stringify(r, null, 2) + "\n");
  console.log(renderImage(r));
  return r.decision === "land" ? 0 : 1;
}

export interface KeysArgs {
  dir: string;
  cooldownDays: number;
  json: boolean;
}

export function parseKeysArgs(argv: string[]): KeysArgs {
  const out: KeysArgs = { dir: ".", cooldownDays: 2, json: false };
  const pos: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--json") out.json = true;
    else if (a === "--cooldown-days") {
      const n = Number(argv[++i]);
      if (!Number.isFinite(n) || n < 0) throw new Error("--cooldown-days must be a number >= 0");
      out.cooldownDays = n;
    } else if (a.startsWith("--")) throw new Error(`unknown flag ${a}`);
    else pos.push(a);
  }
  if (pos.length > 1) throw new Error("usage: oupdate keys [DIR] [--cooldown-days N] [--json]");
  if (pos[0]) out.dir = pos[0];
  return out;
}

function keysMain(argv: string[]): number {
  const k = parseKeysArgs(argv);
  const fs = checkClientKeys(readKeyFiles(k.dir), { cooldownDays: k.cooldownDays });
  console.log(k.json ? JSON.stringify(fs, null, 2) : renderKeys(k.dir, fs));
  return fs.some(failing) ? 1 : 0;
}

const SIGNAL_RC = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 } as const;

/** `oupdate targets` with the real Exec, files, sources and reviewer; a stop signal kills every running command first. */
async function targetsCli(argv: string[]): Promise<number> {
  if (argv[0] === "parity") return parityMain(parseParityCommand(argv.slice(1)), { fs: realTargetFs, out: (l) => console.log(l) });
  const c = parseTargetsCommand(argv);
  for (const [sig, code] of Object.entries(SIGNAL_RC)) process.on(sig, () => void killLive().finally(() => process.exit(code)));
  return targetsMain(c, {
    exec: realExec,
    fs: realTargetFs,
    now: new Date(),
    rev: await appRev(realExec, join(import.meta.dir, "..")),
    tmpDir: tmpdir(),
    sources: { npm: realNpmSource(), github: realGithubSource, oci: dockerHubSource(), snapshot: realSnapshotSource },
    makeReviewer,
    releases: realNasOsReleases(),
    reviewNpm: (spec) => (p) =>
      runReview({
        eco: "npm", name: p.name, from: p.from, to: p.to, oldIntegrity: p.fromIntegrity, newIntegrity: p.toIntegrity,
        now: new Date(), cooldownDays: 0, advisoryFix: false, reviewer: spec, only: ["advisory", "prepass", "reviewer"],
      }),
    out: (l) => console.log(l),
  });
}

if (import.meta.main) {
  const [cmd, ...rest] = process.argv.slice(2);
  try {
    if (cmd === "gate") process.exit(await gateMain(rest));
    if (cmd === "keys") process.exit(keysMain(rest));
    if (cmd === "image") process.exit(await imageMain(rest));
    if (cmd === "targets") process.exit(await targetsCli(rest));
    if (cmd === "host") {
      const hc = parseHostCommand(rest);
      if (hc.mode === "launchd") {
        process.stdout.write(launchdPlist(hc.args));
        process.exit(0);
      }
      if (hc.mode === "owner-waiter") process.exit(await ownerWaiterMain(hc, { exec: realExec }));
      if (hc.mode !== "report") {
        const { rc } = await applyMain(hc, { exec: realExec, fs: realFs });
        process.exit(rc);
      }
      const { text } = await hostMain(hc.args, { run: spawnRunner, feed: osvFeed(), now: new Date() });
      console.log(text);
      process.exit(0);
    }
    if (cmd !== "review") throw new Error("usage: oupdate review <npm|pypi> <name> <from> <to> [--old-artifact F --new-artifact F] [--published ISO] [--now ISO] [--only layers] [--reviewer JSON] [--scanner JSON] [--advisory-fix] [--cooldown-days N] [--json FILE]\n       oupdate image <old-ref> <new-ref> [--platform linux/amd64] [--reviewer JSON] [--second-reviewer JSON] [--now ISO] [--json FILE]\n       oupdate targets --apply [--dry-run] --config FILE [--target ID]...\n       oupdate targets parity --record FILE --script-log FILE --date YYYY-MM-DD --ledger FILE [--target ID]");
    const args = parseReviewArgs(rest);
    const r = await runReview(args);
    if (args.json) writeFileSync(args.json, JSON.stringify(r, null, 2) + "\n");
    console.log(render(r));
    process.exit(r.decision === "land" ? 0 : 1);
  } catch (e) {
    console.error(`oupdate: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(2);
  }
}
