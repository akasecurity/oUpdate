#!/usr/bin/env bun
// oupdate CLI. Subcommands: review (one package update), image (one container image repin), gate (forge PRs), host (report-only shadow of secure-update, --apply, or --launchd-plist), targets (OS targets: --apply [--dry-run] --config FILE; parity --record … --script-log … --date … --ledger …).

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readArtifact, normalizePaths, mergeArtifactPair } from "./artifact.ts";
import { reviewUpdate, LAYERS, type LayerName, type LayerVerdict, type ReviewResult } from "./review.ts";
import type { Ecosystem, FileMap } from "./prepass.ts";
import type { ArtifactFile, Registry } from "./adapters/ecosystem/types.ts";
import { npmRegistry } from "./adapters/ecosystem/npm.ts";
import { pypiRegistry } from "./adapters/ecosystem/pypi.ts";
import { osvFeed } from "./adapters/advisory/osv.ts";
import { parseReviewerSpec, makeReviewer, type ReviewerSpec } from "./adapters/reviewer/spec.ts";
import { parseScannerSpec, makeScanner, type ScannerSpec } from "./adapters/scanner/spec.ts";
import { giteaForge } from "./adapters/forge/gitea.ts";
import { githubForge } from "./adapters/forge/github.ts";
import type { Forge } from "./adapters/forge/types.ts";
import { BOT_LOGINS, PRIVATE_REGISTRY_DEFAULT, PRIVATE_REGISTRY_POLICIES, runGate, type PrivateRegistryPolicy } from "./gate.ts";
import { lockKind } from "./lockfile/index.ts";
import type { LockedFile } from "./lockfile/types.ts";
import { parseHostCommand, hostMain, applyMain, ownerWaiterMain } from "./host/cli.ts";
import { launchdPlist } from "./host/launchd.ts";
import { killLive, realExec } from "./apply/exec.ts";
import { realFs } from "./apply/fs.ts";
import { spawnRunner } from "./host/probe.ts";
import { checkClientKeys, readKeyFiles, renderKeys, failing } from "./clientkeys.ts";
import { appRev, parseTargetsCommand, targetsMain } from "./targets/cli.ts";
import { realTargetFs } from "./targets/run.ts";
import { realUnraidReleases } from "./targets/nas/os.ts";
import { parityMain, parseParityCommand } from "./targets/parity-cli.ts";
import { fetchVerified, realNpmSource } from "./targets/pins/npm.ts";
import { realDockerSource } from "./targets/pins/docker.ts";
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
  /** SRI the downloaded old / new tarball must match, every hash in it, before it is reviewed (the pins, the proposal, the lockfile). */
  oldIntegrity?: string;
  newIntegrity?: string;
  /** The files the lockfile pins for the new version (uv.lock): each must be one the registry lists for it (PyPI). */
  lockedFiles?: LockedFile[];
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
  if (!name || !from || !to || pos.length !== 4) throw new Error("usage: oupdate gate [--forge gitea|github] [--endpoint URL] --repo owner/name (--token-file F | --token-env NAME) [--reviewer JSON] [--scanner JSON] [--branch-prefix renovate/]... [--bot-login LOGIN]... [--gate-login LOGIN] [--lock PATH]... [--cooldown-days N] [--private-registry hold|list|review]\n       oupdate review <npm|pypi> <name> <from> <to> [flags]");
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

async function download(url: string, dir: string, sri?: string, f: typeof fetch = fetch): Promise<string> {
  const bytes = await fetchVerified(f, url, sri);
  // The decoded name can carry %2F or %5C: flatten separators so the file stays in dir.
  const name = decodeURIComponent(new URL(url).pathname.split("/").pop() || "").replace(/[/\\]/g, "_");
  const file = join(dir, /^\.*$/.test(name) ? "artifact" : name);
  writeFileSync(file, bytes);
  return file;
}

function render(r: ReviewResult): string {
  const lines = [`${r.eco} ${r.name} ${r.from} -> ${r.to}: ${r.decision.toUpperCase()}`];
  if (r.malicious?.length) lines.push(`  MALICIOUS (${r.malicious.join(", ")}): check where ${r.name} ${r.to} is already installed`);
  for (const l of r.layers) lines.push(`  ${l.layer.padEnd(9)} ${l.verdict.padEnd(7)} ${l.detail}`);
  return lines.join("\n");
}

/** The old and new release files a review reads: the given artifacts, or the registry's, downloaded into `work`. */
export async function loadArtifacts(a: ReviewArgs, registry: Registry, work: string, f: typeof fetch = fetch): Promise<{ old: FileMap; new: FileMap }> {
  if (a.oldArtifact && a.newArtifact) return { old: normalizePaths(await readArtifact(a.oldArtifact)), new: normalizePaths(await readArtifact(a.newArtifact)) };
  if (a.eco === "pypi") return loadPypiRelease(a, registry, work, f);
  // An empty from is a package the old lockfile did not have: diff against nothing.
  const [oldUrl] = a.from ? await registry.artifactUrls(a.name, a.from) : [undefined];
  const [newUrl] = await registry.artifactUrls(a.name, a.to);
  if ((a.from && !oldUrl) || !newUrl) throw new Error(`no published artifact for ${!newUrl ? a.to : a.from}`);
  return {
    old: oldUrl ? normalizePaths(await readArtifact(await download(oldUrl, work, a.oldIntegrity, f))) : new Map(),
    new: normalizePaths(await readArtifact(await download(newUrl, work, a.newIntegrity, f))),
  };
}

const MAX_RELEASE_BYTES = 1_000_000_000;

// Pairs a file with its counterpart in the other release: a wheel by its tags, the sdist by type.
function pairLabel(x: ArtifactFile): string {
  return x.packagetype === "sdist" ? "sdist" : `${x.filename.replace(/\.whl$/, "").split("-").slice(2).join("-")}.whl`;
}

/**
 * Every wheel and the sdist of both releases, each checked against PyPI's sha256, merged into one old/new pair:
 * an installer picks the file for its platform, so no file goes unread. Anything unlisted, unfetched or
 * unverified throws, which holds the update.
 */
async function loadPypiRelease(a: ReviewArgs, registry: Registry, work: string, f: typeof fetch): Promise<{ old: FileMap; new: FileMap }> {
  if (!registry.artifactFiles) throw new Error("registry cannot list a release's files");
  const now = await registry.artifactFiles(a.name, a.to);
  const before = a.from ? await registry.artifactFiles(a.name, a.from) : [];
  if (!now.length || (a.from && !before.length)) throw new Error(`no published artifact for ${!now.length ? a.to : a.from}`);
  const read = async (x: ArtifactFile): Promise<FileMap> => {
    if (!x.sha256 || !/^[0-9a-f]{64}$/i.test(x.sha256)) throw new Error(`PyPI lists no sha256 for ${x.filename}`);
    const bytes = await fetchVerified(f, x.url, undefined);
    const got = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
    if (got !== x.sha256.toLowerCase()) throw new Error(`sha256 mismatch for ${x.url}: the bytes are ${got}, PyPI lists ${x.sha256}`);
    const file = join(work, got);
    writeFileSync(file, bytes);
    return normalizePaths(await readArtifact(file));
  };
  const oldBy = new Map(before.map((x) => [pairLabel(x), x]));
  // Paired files first; a file in an unpaired one is read again unless the same bytes were already shown whole.
  const ordered = [...now.filter((x) => oldBy.has(pairLabel(x))), ...now.filter((x) => !oldBy.has(pairLabel(x)))];
  const merged = { old: new Map() as FileMap, new: new Map() as FileMap };
  const seen = new Set<string>();
  for (const x of ordered) {
    if (x.sha256 && seen.has(x.sha256.toLowerCase())) continue;
    const label = pairLabel(x);
    const o = oldBy.get(label);
    mergeArtifactPair(merged, label, o ? await read(o) : new Map(), await read(x));
    seen.add(x.sha256!.toLowerCase());
    let total = 0;
    for (const m of [merged.old, merged.new]) for (const b of m.values()) total += b.length;
    if (total > MAX_RELEASE_BYTES) throw new Error(`release files over ${MAX_RELEASE_BYTES} bytes: ${a.name} ${a.to}`);
  }
  return merged;
}

/**
 * Whether every file a lockfile pins for name@version is one PyPI lists for that version, by sha256: undefined when
 * each is, a stop when one is not (the install would fetch bytes the review never reads), an error when one cannot
 * be checked (no URL, no sha256, no listing), which holds.
 */
export async function lockedFilesCheck(registry: Registry, name: string, version: string, locked: LockedFile[]): Promise<LayerVerdict | undefined> {
  try {
    if (!registry.artifactFiles) throw new Error("registry cannot list a release's files");
    const files = await registry.artifactFiles(name, version);
    if (!files.length) throw new Error(`no published files for ${name} ${version}`);
    const listed = new Set(files.map((x) => x.sha256?.toLowerCase()).filter(Boolean));
    for (const f of locked) {
      const m = /^sha256:([0-9a-f]{64})$/i.exec(f.hash ?? "");
      if (!f.url || !m) throw new Error(`the lockfile's file ${f.url ?? "(no url)"} has no url or sha256 to check (${f.hash ?? "no hash"})`);
      if (!listed.has(m[1]!.toLowerCase())) return { layer: "gate", verdict: "stop", detail: `the lockfile's file ${f.url} (${f.hash}) is not one PyPI lists for ${name} ${version}; a person checks it` };
    }
  } catch (e) {
    return { layer: "gate", verdict: "error", detail: `cannot check the lockfile's files against PyPI: ${e instanceof Error ? e.message : String(e)}` };
  }
  return undefined;
}

export async function runReview(a: ReviewArgs): Promise<ReviewResult> {
  const base: Registry = a.eco === "npm" ? npmRegistry() : pypiRegistry();
  const registry: Registry = a.published ? { ...base, publishedAt: async () => a.published } : { ...base };
  if (a.lockedFiles?.length) {
    // The review reads PyPI's file list for the new version too: fetch it once.
    const list = base.artifactFiles?.bind(base);
    const memo = new Map<string, Promise<ArtifactFile[]>>();
    if (list) registry.artifactFiles = (n, v) => memo.get(`${n}@${v}`) ?? (memo.set(`${n}@${v}`, list(n, v)), memo.get(`${n}@${v}`)!);
    const bad = await lockedFilesCheck(registry, a.name, a.to, a.lockedFiles);
    if (bad) return { eco: a.eco, name: a.name, from: a.from, to: a.to, decision: "hold", layers: [bad] };
  }
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
      loadArtifacts: () => loadArtifacts(a, registry, work),
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
  /** ...and one of these logins opened it from a branch of the repo. */
  botLogins: string[];
  /** The login the token acts as; unset, the forge is asked (GET /user). */
  gateLogin?: string;
  /** Empty: the gate looks for each known lockfile name at the repo root. */
  lockPaths: string[];
  cooldownDays: number;
  /** What a private-registry version gets: hold (default) fails the PR; list accepts it unreviewed. */
  privateRegistry: PrivateRegistryPolicy;
  reviewer?: ReviewerSpec;
  scanner?: ScannerSpec;
}

const GATE_FLAGS = new Set(["--forge", "--endpoint", "--repo", "--token-file", "--token-env", "--branch-prefix", "--bot-login", "--gate-login", "--lock", "--cooldown-days", "--private-registry", "--reviewer", "--scanner"]);

/** `env` supplies GITHUB_API_URL, which Actions sets on GitHub Enterprise Server, as the github endpoint when --endpoint is absent. */
export function parseGateArgs(argv: string[], env: Record<string, string | undefined> = process.env): GateCliArgs {
  const flags = new Map<string, string>();
  const lockPaths: string[] = [];
  const branchPrefixes: string[] = [];
  const botLogins: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!GATE_FLAGS.has(a)) throw new Error(`unknown flag ${a}`);
    const v = argv[++i];
    if (v === undefined) throw new Error(`${a} needs a value`);
    if (a === "--lock") {
      lockKind(v);
      lockPaths.push(v);
    } else if (a === "--branch-prefix") branchPrefixes.push(v);
    else if (a === "--bot-login") botLogins.push(v);
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
  const privateRegistry = (flags.get("--private-registry") ?? PRIVATE_REGISTRY_DEFAULT) as PrivateRegistryPolicy;
  if (!PRIVATE_REGISTRY_POLICIES.includes(privateRegistry)) throw new Error(`--private-registry must be hold, list or review, got ${privateRegistry}`);
  const out: GateCliArgs = { forge, endpoint, repo, branchPrefixes: branchPrefixes.length ? branchPrefixes : ["renovate/"], botLogins: botLogins.length ? botLogins : BOT_LOGINS, lockPaths, cooldownDays, privateRegistry };
  if (flags.has("--gate-login")) out.gateLogin = flags.get("--gate-login")!;
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
  return g.forge === "github" ? githubForge({ endpoint: g.endpoint, token, login: g.gateLogin, fetch: f }) : giteaForge({ endpoint: g.endpoint!, token, login: g.gateLogin, fetch: f });
}

async function gateMain(argv: string[]): Promise<number> {
  const g = parseGateArgs(argv);
  const token = await gateToken(g);
  const pulls = await runGate({
    forge: gateForge(g, token),
    repo: g.repo,
    branchPrefixes: g.branchPrefixes,
    botLogins: g.botLogins,
    lockPaths: g.lockPaths,
    privateRegistry: g.privateRegistry,
    log: (line) => console.log(line),
    review: (c) => runReview({ eco: c.eco, name: c.name, from: c.from ?? "", to: c.to, oldIntegrity: c.fromIntegrity, newIntegrity: c.toIntegrity, lockedFiles: c.toArtifacts, now: new Date(), cooldownDays: g.cooldownDays, advisoryFix: false, reviewer: g.reviewer, scanner: g.scanner }),
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
  /** Read the layer contents; `--no-layers` turns it off. */
  layers: boolean;
  reviewer?: ReviewerSpec;
  secondReviewer?: ReviewerSpec;
  json?: string;
}

const IMAGE_USAGE = "usage: oupdate image <old-ref> <new-ref> [--platform linux/amd64] [--no-layers] [--reviewer JSON] [--second-reviewer JSON] [--now ISO] [--json FILE]";
const IMAGE_FLAGS = new Set(["--platform", "--reviewer", "--second-reviewer", "--now", "--json"]);

export function parseImageArgs(argv: string[]): ImageArgs {
  const pos: string[] = [];
  const flags = new Map<string, string>();
  let layers = true;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--no-layers") layers = false;
    else if (IMAGE_FLAGS.has(a)) {
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
  const out: ImageArgs = { old, new: now, platform, layers, now: flags.has("--now") ? date("--now", flags.get("--now")!) : new Date() };
  if (flags.has("--reviewer")) out.reviewer = parseReviewerSpec(flags.get("--reviewer")!);
  if (flags.has("--second-reviewer")) out.secondReviewer = parseReviewerSpec(flags.get("--second-reviewer")!);
  if (flags.has("--json")) out.json = flags.get("--json")!;
  return out;
}

async function imageMain(argv: string[]): Promise<number> {
  const a = parseImageArgs(argv);
  const r = await checkImage(a, {
    source: registrySource(),
    reviewers: { router: a.reviewer ? makeReviewer(a.reviewer) : undefined, onprem: a.secondReviewer ? makeReviewer(a.secondReviewer) : undefined },
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
    sources: { npm: realNpmSource(), github: realGithubSource, oci: dockerHubSource(), snapshot: realSnapshotSource, docker: realDockerSource },
    makeReviewer,
    releases: realUnraidReleases(),
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
