#!/usr/bin/env bun
// oupdate CLI. Subcommands: review (one package update), gate (forge PRs), host (report-only shadow of secure-update, --apply, or --launchd-plist).

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
import { runGate } from "./gate.ts";
import { parseHostCommand, hostMain, applyMain, ownerWaiterMain } from "./host/cli.ts";
import { launchdPlist } from "./host/launchd.ts";
import { realExec } from "./apply/exec.ts";
import { realFs } from "./apply/fs.ts";
import { spawnRunner } from "./host/probe.ts";
import { checkClientKeys, readKeyFiles, renderKeys, failing } from "./clientkeys.ts";

export interface ReviewArgs {
  eco: Ecosystem;
  name: string;
  from: string;
  to: string;
  oldArtifact?: string;
  newArtifact?: string;
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
  if (!name || !from || !to || pos.length !== 4) throw new Error("usage: oupdate gate --endpoint URL --repo owner/name --token-file F [--reviewer JSON] [--scanner JSON] [--branch-prefix renovate/] [--lock bun.lock] [--cooldown-days N]\n       oupdate review <npm|pypi> <name> <from> <to> [flags]");
  const out: ReviewArgs = { eco, name, from, to, now: new Date(), cooldownDays: 7, advisoryFix };
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

async function download(url: string, dir: string): Promise<string> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`download ${r.status} for ${url}`);
  const file = join(dir, decodeURIComponent(new URL(url).pathname.split("/").pop() || "artifact"));
  writeFileSync(file, new Uint8Array(await r.arrayBuffer()));
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
        return { old: oldUrl ? normalizePaths(await readArtifact(await download(oldUrl, work))) : new Map(), new: normalizePaths(await readArtifact(await download(newUrl, work))) };
      },
    });
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

export interface GateCliArgs {
  endpoint: string;
  repo: string;
  tokenFile: string;
  branchPrefix: string;
  lockPath: string;
  cooldownDays: number;
  reviewer?: ReviewerSpec;
  scanner?: ScannerSpec;
}

const GATE_FLAGS = new Set(["--endpoint", "--repo", "--token-file", "--branch-prefix", "--lock", "--cooldown-days", "--reviewer", "--scanner"]);

export function parseGateArgs(argv: string[]): GateCliArgs {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!GATE_FLAGS.has(a)) throw new Error(`unknown flag ${a}`);
    const v = argv[++i];
    if (v === undefined) throw new Error(`${a} needs a value`);
    flags.set(a, v);
  }
  for (const req of ["--endpoint", "--repo", "--token-file"]) if (!flags.has(req)) throw new Error(`gate needs ${req}`);
  const repo = flags.get("--repo")!;
  if (!/^[^/\s]+\/[^/\s]+$/.test(repo)) throw new Error(`--repo must be owner/name, got ${repo}`);
  const cooldownDays = Number(flags.get("--cooldown-days") ?? 7);
  if (!Number.isFinite(cooldownDays) || cooldownDays < 0) throw new Error("--cooldown-days must be a number >= 0");
  const out: GateCliArgs = { endpoint: flags.get("--endpoint")!, repo, tokenFile: flags.get("--token-file")!, branchPrefix: flags.get("--branch-prefix") ?? "renovate/", lockPath: flags.get("--lock") ?? "bun.lock", cooldownDays };
  if (flags.has("--reviewer")) out.reviewer = parseReviewerSpec(flags.get("--reviewer")!);
  if (flags.has("--scanner")) out.scanner = parseScannerSpec(flags.get("--scanner")!);
  return out;
}

async function gateMain(argv: string[]): Promise<number> {
  const g = parseGateArgs(argv);
  const token = (await Bun.file(g.tokenFile).text()).trim();
  if (!token) throw new Error(`empty token file ${g.tokenFile}`);
  const pulls = await runGate({
    forge: giteaForge({ endpoint: g.endpoint, token }),
    repo: g.repo,
    branchPrefix: g.branchPrefix,
    lockPath: g.lockPath,
    review: (c) => runReview({ eco: "npm", name: c.name, from: c.from ?? "", to: c.to, now: new Date(), cooldownDays: g.cooldownDays, advisoryFix: false, reviewer: g.reviewer, scanner: g.scanner }),
  });
  for (const p of pulls) {
    console.log(`PR #${p.number}: ${p.state}`);
    for (const r of p.results) console.log(render(r).replace(/^/gm, "  "));
  }
  return pulls.some((p) => p.state === "failure") ? 1 : 0;
}

export interface KeysArgs {
  dir: string;
  cooldownDays: number;
  json: boolean;
}

export function parseKeysArgs(argv: string[]): KeysArgs {
  const out: KeysArgs = { dir: ".", cooldownDays: 7, json: false };
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

if (import.meta.main) {
  const [cmd, ...rest] = process.argv.slice(2);
  try {
    if (cmd === "gate") process.exit(await gateMain(rest));
    if (cmd === "keys") process.exit(keysMain(rest));
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
    if (cmd !== "review") throw new Error("usage: oupdate review <npm|pypi> <name> <from> <to> [--old-artifact F --new-artifact F] [--published ISO] [--now ISO] [--only layers] [--reviewer JSON] [--scanner JSON] [--advisory-fix] [--cooldown-days N] [--json FILE]");
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
