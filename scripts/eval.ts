#!/usr/bin/env bun
// oupdate goal eval (OUP-b2): runs checks 1-6, prints one pass/fail line each and a score
// out of 6. Exit 0 only at 6/6. A check that cannot run reports "not run" and counts as a fail.
//
//   1 attacks   all 9 attacks stopped: the 8 dataset cases (acceptance/run.ts) and the litellm
//               replay (every pair), local reviewer only, advisory and cooldown layers off
//   2 controls  all 8 controls pass (acceptance/run.ts, same run), 0 false alarms
//               Checks 1 and 2 score the core set; their counts come from acceptance/cases.json and
//               controls.json (acceptance/sets.ts). With `extended: true` in the config the run also
//               covers the extended set, printed as one informational line that is not a check.
//   3 switched  every host runs oupdate and has secure-update disabled
//   4 cutover   per host, one dry-run shadow report shows oupdate holds what secure-update holds
//   5 landing   the yaml advisory update landed through the train, oupdate/review=success,
//               rollback tested
//   6 open      scripts/oss-scan.ts finds nothing in the git-tracked files
//
// usage: bun scripts/eval.ts [--config FILE] [--only 1,2,...]
// Config: --config, else $OUPDATE_EVAL_CONFIG, else ~/.config/oupdate/eval.json. See
// scripts/eval.config.example.json. The config holds fleet values, so it stays outside the repo.
// Checks 3-5 read files only; they never SSH to a host. For a remote host, point its `root` at a
// directory that holds that host's files (a mount or a collected copy); an unreadable root is "not run".
// Check 6 also requires, per the goal, that checks 1 and 2 pass on a clean sample config; pass
// `sampleConfig` (a second config with only placeholder values) to run 1 and 2 against it too.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { validateReviewerSpec } from "../src/adapters/reviewer/spec.ts";
import type { HostReport } from "../src/host/report.ts";
import { scanTracked } from "./oss-scan.ts";
import { loadSets, setCounts } from "../acceptance/sets.ts";

export type Status = "pass" | "fail" | "not run";
export interface CheckResult {
  n: number;
  name: string;
  status: Status;
  detail: string;
}

export interface HostCfg {
  name: string;
  /** Directory the host's files are read from: "/" for this host, a mount or collected copy for another. */
  root: string;
  /** Paths below root. */
  oupdatePlist: string;
  secureUpdatePlist: string;
  /** The oupdate state dir (holds reports/<date>.json from `oupdate host --report-only`). */
  stateDir: string;
  /** Held-name differences accepted for this host, each with a reason (a manual pin, say). */
  waive?: { name: string; why: string }[];
}

export interface EvalConfig {
  /** openai-type reviewer specs for checks 1 and 2; local endpoints only (your choice, not enforced). */
  reviewers: unknown[];
  scanner?: unknown;
  /** Where acceptance downloads are cached between runs. */
  workDir?: string;
  hosts?: HostCfg[];
  /** JSON evidence file for check 5: {pr, context, state, landed, rollbackTested}. */
  landing?: string;
  /** A second, placeholder-only config for the clean-sample run of checks 1 and 2. */
  sampleConfig?: string;
  /** Also run the extended set (acceptance/run.ts --set all); reported on its own line, not scored. */
  extended?: boolean;
}

const repo = resolve(import.meta.dir, "..");

// ---- checks 1 and 2 -------------------------------------------------------

/** Pure: reads run.ts summary lines ("MAL  id: STOPPED hold", "CTRL id: PASSED land") and replay lines ("tag: STOPPED hold"). */
export function parseOutcomes(out: string): { mal: Map<string, string>; ctrl: Map<string, string> } {
  const mal = new Map<string, string>();
  const ctrl = new Map<string, string>();
  for (const l of out.split("\n")) {
    const m = /^(MAL|CTRL)\s+(\S+): (\S+)/.exec(l);
    if (m) (m[1] === "MAL" ? mal : ctrl).set(m[2]!, m[3]!);
  }
  return { mal, ctrl };
}

export function parseReplay(out: string): Map<string, string> {
  const r = new Map<string, string>();
  for (const l of out.split("\n")) {
    const m = /^([\w-]+): ([A-Z-]+) (hold|land)\b/.exec(l);
    if (m) r.set(m[1]!, m[2]!);
  }
  return r;
}

// The core set as the JSON defines it: today 9 attacks (8 dataset cases plus the replay) and 8 controls.
const SETS = loadSets();
const CORE = setCounts(SETS, "core");
const EXTENDED = setCounts(SETS, "extended");
const ATTACKS = CORE.attacks;
const CONTROLS = CORE.controls;

const pick = (m: Map<string, string>, ids: Set<string>) => new Map([...m].filter(([k]) => ids.has(k)));

/**
 * Pure: checks 1 and 2 from parsed run.ts and replay outcomes, core ids only; plus the extended
 * set's informational line when the run produced any extended result. rc is "<run>/<replay>".
 */
export function scoreAcceptance(out: { mal: Map<string, string>; ctrl: Map<string, string> }, replay: Map<string, string>, rc: string): { c1: CheckResult; c2: CheckResult; extended?: string } {
  const mal = pick(out.mal, CORE.attackIds);
  const ctrl = pick(out.ctrl, CORE.controlIds);
  const stoppedMal = [...mal].filter(([, o]) => o === "STOPPED").length;
  const replayOk = replay.size > 0 && [...replay.values()].every((o) => o === "STOPPED");
  const attacks = stoppedMal + (replayOk ? 1 : 0);
  const attackSeen = mal.size + (replay.size ? 1 : 0);
  const c1: CheckResult =
    attackSeen < ATTACKS
      ? { n: 1, name: "attacks", status: "not run", detail: `only ${attackSeen} of ${ATTACKS} attacks produced a result (${mal.size} dataset, ${replay.size} replay pairs); rc=${rc}` }
      : { n: 1, name: "attacks", status: attacks === ATTACKS ? "pass" : "fail", detail: `${attacks} of ${ATTACKS} stopped${attacks < ATTACKS ? `; missed: ${[...mal].filter(([, o]) => o !== "STOPPED").map(([k, o]) => `${k}=${o}`).concat(replayOk ? [] : ["litellm-replay"]).join(", ")}` : ""}` };
  const passed = [...ctrl].filter(([, o]) => o === "PASSED").length;
  const c2: CheckResult =
    ctrl.size < CONTROLS
      ? { n: 2, name: "controls", status: "not run", detail: `only ${ctrl.size} of ${CONTROLS} controls produced a result; rc=${rc.split("/")[0]}` }
      : { n: 2, name: "controls", status: passed === CONTROLS ? "pass" : "fail", detail: `${passed} of ${CONTROLS} passed${passed < CONTROLS ? `; not passed: ${[...ctrl].filter(([, o]) => o !== "PASSED").map(([k, o]) => `${k}=${o}`).join(", ")}` : ""}` };
  const xm = pick(out.mal, EXTENDED.attackIds);
  const xc = pick(out.ctrl, EXTENDED.controlIds);
  if (!xm.size && !xc.size) return { c1, c2 };
  const missing = EXTENDED.attacks - xm.size + EXTENDED.controls - xc.size;
  const extended = `extended set (informational, not scored): ${[...xm.values()].filter((o) => o === "STOPPED").length} of ${EXTENDED.attacks} attacks stopped, ${[...xc.values()].filter((o) => o === "PASSED").length} of ${EXTENDED.controls} controls passed${missing ? `; ${missing} gave no result` : ""}`;
  return { c1, c2, extended };
}

function runBun(args: string[], cwd: string): { rc: number; out: string } {
  const p = Bun.spawnSync([process.execPath, ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  return { rc: p.exitCode ?? 1, out: new TextDecoder().decode(p.stdout) + new TextDecoder().decode(p.stderr) };
}

/** One acceptance run plus the replay, in a scratch dir so the repo's results stay untouched. */
export function runAcceptance(cfg: EvalConfig): { c1: CheckResult; c2: CheckResult; extended?: string } {
  const nr = (detail: string) => ({ c1: { n: 1, name: "attacks", status: "not run" as const, detail }, c2: { n: 2, name: "controls", status: "not run" as const, detail } });
  if (!cfg.reviewers?.length) return nr("config has no reviewers");
  try {
    cfg.reviewers.forEach(validateReviewerSpec);
  } catch (e) {
    return nr(`bad reviewer spec: ${e instanceof Error ? e.message : String(e)}`);
  }
  const scratch = mkdtempSync(join(tmpdir(), "oupdate-eval-"));
  try {
    const rfile = join(scratch, "reviewers.json");
    writeFileSync(rfile, JSON.stringify(cfg.reviewers));
    const layers = "prepass,scan,reviewer"; // no advisory, no cooldown, no gate (gate runs package tests)
    const work = resolve(cfg.workDir ?? join(repo, "acceptance-work"));
    mkdirSync(work, { recursive: true });
    const scanner = cfg.scanner ? ["--scanner", JSON.stringify(cfg.scanner)] : [];
    const set = cfg.extended ? ["--set", "all"] : [];
    const acc = runBun([join(repo, "acceptance/run.ts"), "--reviewers", rfile, "--layers", layers, "--work", work, ...scanner, ...set], scratch);
    const rep = runBun([join(repo, "replay/litellm-2026-10-21/run.ts"), rfile, cfg.scanner ? JSON.stringify(cfg.scanner) : "", layers], scratch);
    return scoreAcceptance(parseOutcomes(acc.out), parseReplay(rep.out), `${acc.rc}/${rep.rc}`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

// ---- checks 3-5 (file evidence, no SSH) -----------------------------------

const at = (root: string, p: string) => join(root, p);

export function checkSwitched(hosts: HostCfg[] | undefined): CheckResult {
  const base = { n: 3, name: "switched" };
  if (!hosts?.length) return { ...base, status: "not run", detail: "no hosts list in config" };
  const bad: string[] = [];
  const unread: string[] = [];
  for (const h of hosts) {
    if (!existsSync(h.root)) {
      unread.push(h.name);
      continue;
    }
    const on = existsSync(at(h.root, h.oupdatePlist));
    const su = existsSync(at(h.root, h.secureUpdatePlist)) && !existsSync(at(h.root, `${h.secureUpdatePlist}.disabled`));
    if (!on || su) bad.push(`${h.name}${!on ? " no oupdate" : ""}${su ? " secure-update still on" : ""}`);
  }
  const ok = hosts.length - bad.length - unread.length;
  const detail = `${ok} of ${hosts.length} hosts switched${bad.length ? `; not switched: ${bad.join(", ")}` : ""}${unread.length ? `; not readable: ${unread.join(", ")}` : ""}`;
  return { ...base, status: unread.length ? "not run" : bad.length ? "fail" : "pass", detail };
}

export function latestReport(stateDir: string): HostReport | undefined {
  const dir = join(stateDir, "reports");
  if (!existsSync(dir)) return undefined;
  const f = readdirSync(dir).filter((x) => /^\d{4}-\d\d-\d\d\.json$/.test(x)).sort().at(-1);
  return f ? (JSON.parse(readFileSync(join(dir, f), "utf8")) as HostReport) : undefined;
}

/** Cutover: the host's dry-run report shows nothing secure-update held that oupdate does not (waivers named per host). */
export function checkCutover(hosts: HostCfg[] | undefined): CheckResult {
  const base = { n: 4, name: "cutover" };
  if (!hosts?.length) return { ...base, status: "not run", detail: "no hosts list in config" };
  const bad: string[] = [];
  const none: string[] = [];
  for (const h of hosts) {
    const r = existsSync(h.root) ? latestReport(at(h.root, h.stateDir)) : undefined;
    if (!r?.compare) {
      none.push(h.name);
      continue;
    }
    const waived = new Set((h.waive ?? []).map((w) => w.name));
    const diff = [...r.compare.held.onlyInventory, ...r.compare.held.onlySecureUpdate].filter((n) => !waived.has(n));
    if (diff.length) bad.push(`${h.name} (${diff.join(" ")})`);
  }
  const ok = hosts.length - bad.length - none.length;
  const detail = `${ok} of ${hosts.length} hosts agree${bad.length ? `; differ: ${bad.join(", ")}` : ""}${none.length ? `; no report: ${none.join(", ")}` : ""}`;
  return { ...base, status: none.length ? "not run" : bad.length ? "fail" : "pass", detail };
}

export function checkLanding(file: string | undefined): CheckResult {
  const base = { n: 5, name: "landing" };
  if (!file || !existsSync(file)) return { ...base, status: "not run", detail: "no landing evidence file" };
  let e: Record<string, unknown>;
  try {
    e = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return { ...base, status: "not run", detail: "landing evidence is not JSON" };
  }
  const miss = [e.landed === true || "landed", e.context === "oupdate/review" || "context", e.state === "success" || "state=success", e.rollbackTested === true || "rollbackTested"].filter((x) => x !== true);
  return { ...base, status: miss.length ? "fail" : "pass", detail: miss.length ? `evidence lacks: ${miss.join(", ")}` : `PR ${String(e.pr ?? "?")} landed, oupdate/review=success, rollback tested` };
}

// ---- check 6 --------------------------------------------------------------

export function checkOpenSource(sample: CheckResult[] | undefined, denyFile = process.env.OUPDATE_SCAN_DENY): CheckResult {
  const deny = denyFile && existsSync(denyFile) ? readFileSync(denyFile, "utf8").split("\n").map((s) => s.trim()).filter(Boolean) : [];
  const { files, findings } = scanTracked(deny);
  const scanOk = findings.length === 0;
  const sampleBad = sample?.filter((c) => c.status !== "pass").map((c) => c.n);
  const detail = `${files} files, ${findings.length} findings${deny.length ? "" : " (no deny list)"}${sample ? (sampleBad?.length ? `; clean sample config: checks ${sampleBad.join(",")} not passing` : "; clean sample config passes 1 and 2") : "; no sampleConfig, so 1 and 2 not run on a clean config"}`;
  return { n: 6, name: "open source", status: !scanOk || sampleBad?.length ? "fail" : sample ? "pass" : "not run", detail };
}

// ---- main -----------------------------------------------------------------

/** Replaces ${NAME} in every string with the environment value; an unset name is an error. */
export function expandEnv(text: string, env: Record<string, string | undefined> = process.env): string {
  return text.replace(/\$\{([A-Z0-9_]+)\}/g, (_, n: string) => {
    const v = env[n];
    if (v === undefined || v === "") throw new Error(`env ${n} is not set`);
    return JSON.stringify(v).slice(1, -1);
  });
}

export function loadConfig(path: string): EvalConfig {
  return JSON.parse(expandEnv(readFileSync(path, "utf8"))) as EvalConfig;
}

/** info: lines printed after the checks (the extended set), never counted in the score. */
export function render(results: CheckResult[], info: string[] = []): { text: string; score: number } {
  const score = results.filter((r) => r.status === "pass").length;
  const lines = results.map((r) => `${r.status === "pass" ? "PASS" : r.status === "fail" ? "FAIL" : "FAIL (not run)"} ${r.n} ${r.name}: ${r.detail}`);
  return { text: [...lines, ...info, `score: ${score}/6`].join("\n"), score };
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const flag = (n: string) => argv[argv.indexOf(n) + 1];
  const path = argv.includes("--config") ? flag("--config")! : (process.env.OUPDATE_EVAL_CONFIG ?? join(homedir(), ".config/oupdate/eval.json"));
  const only = argv.includes("--only") ? new Set(flag("--only")!.split(",").map(Number)) : undefined;
  const want = (n: number) => !only || only.has(n);
  const missing = (n: number, name: string, detail: string): CheckResult => ({ n, name, status: "not run", detail });
  let cfg: EvalConfig | undefined;
  try {
    cfg = loadConfig(path);
  } catch (e) {
    console.error(`eval: cannot read config ${path}: ${e instanceof Error ? e.message : String(e)}`);
  }
  const results: CheckResult[] = [];
  const acc = want(1) || want(2) || want(6);
  const ab = cfg && acc ? runAcceptance(cfg) : undefined;
  const nocfg = "no readable config";
  if (want(1)) results.push(ab?.c1 ?? missing(1, "attacks", nocfg));
  if (want(2)) results.push(ab?.c2 ?? missing(2, "controls", nocfg));
  if (want(3)) results.push(cfg ? checkSwitched(cfg.hosts) : missing(3, "switched", nocfg));
  if (want(4)) results.push(cfg ? checkCutover(cfg.hosts) : missing(4, "cutover", nocfg));
  if (want(5)) results.push(cfg ? checkLanding(cfg.landing) : missing(5, "landing", nocfg));
  if (want(6)) {
    const sample = cfg?.sampleConfig && existsSync(cfg.sampleConfig) ? runAcceptance(loadConfig(cfg.sampleConfig)) : undefined;
    results.push(checkOpenSource(sample ? [sample.c1, sample.c2] : undefined));
  }
  const { text, score } = render(results, ab?.extended ? [ab.extended] : []);
  console.log(text);
  process.exit(score === 6 && results.length === 6 ? 0 : 1);
}
