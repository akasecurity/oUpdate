#!/usr/bin/env bun
// Runs every case as a pull request through runGate (src/gate.ts): the lockfile before and after is diffed,
// and every package the change brings in, direct or transitive, goes to reviewUpdate (src/review.ts) with the
// deterministic layers only (pre-pass; no model, no network, same result every run).
// Scoring: an attack is blocked when the gate fails the PR because a package in it is held; a look-alike or
// control passes when the gate lets the PR through. Writes results/results.json and results/results.md next to
// this file; exit 0 only when every case meets its goal.
//   usage: bun eval/2026-10-28-function-color-postinstall-hidden-download/run.ts
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { runGate } from "../../src/gate.ts";
import { reviewUpdate } from "../../src/review.ts";
import type { Registry } from "../../src/adapters/ecosystem/types.ts";
import type { Forge } from "../../src/adapters/forge/types.ts";
import { CASES, type Pkg } from "./cases.ts";

const here = dirname(new URL(import.meta.url).pathname);
const version = (await Bun.file(join(here, "../../package.json")).json()).version as string;
const registry: Registry = { latest: async () => undefined, publishedAt: async () => new Date("2026-01-01T00:00:00Z"), artifactUrls: async () => [] };
const lock = (pkgs: Pkg[]) => JSON.stringify({ lockfileVersion: 1, packages: Object.fromEntries(pkgs.map((p) => [p.name, [`${p.name}@${p.version}`, "", {}]])) });

const rows = [];
for (const c of CASES) {
  const byKey = new Map([...c.base, ...c.head].map((p) => [`${p.name}@${p.version}`, p.files]));
  const files: Record<string, string> = { "b:bun.lock": lock(c.base), "h:bun.lock": lock(c.head) };
  const forge: Forge = {
    self: async () => "gate",
    openPulls: async () => [{ number: 1, headRef: "renovate/update", headSha: "h", baseSha: "b", author: "renovate[bot]", headRepo: "o/r", baseRepo: "o/r" }],
    readFile: async (_r, sha, path) => files[`${sha}:${path}`],
    changedFiles: async () => ["bun.lock"],
    statusOf: async () => undefined,
    setStatus: async () => {},
    ownComment: async () => undefined,
    upsertComment: async () => {},
  };
  const [pr] = await runGate({
    forge, repo: "o/r",
    review: (ch) => reviewUpdate({
      eco: ch.eco, name: ch.name, from: ch.from ?? "", to: ch.to, registry,
      advisories: { query: async () => [] }, reviewer: undefined,
      cooldownDays: 0, now: new Date("2026-10-28T12:00:00Z"),
      loadArtifacts: async () => ({ old: ch.from ? byKey.get(`${ch.name}@${ch.from}`)! : new Map(), new: byKey.get(`${ch.name}@${ch.to}`)! }),
      only: ["prepass"],
    }),
  });
  const held = pr!.results.filter((r) => r.decision === "hold").map((r) => {
    const stop = r.layers.find((l) => l.verdict === "stop");
    return { package: `${r.name} ${r.from || "(new)"} -> ${r.to}`, layer: stop?.layer ?? "?", reason: stop?.detail.split("; ")[0] ?? "" };
  });
  const decision = pr!.state === "success" ? "land" : "hold";
  rows.push({ id: c.id, kind: c.kind, goal: c.expect, pr_state: pr!.state, decision, ok: decision === c.expect, packages_reviewed: pr!.results.length, held });
}

const attacks = rows.filter((r) => r.kind === "attack");
const others = rows.filter((r) => r.kind !== "attack");
const summary = {
  tool_version: version,
  layers: "prepass",
  attacks_blocked: attacks.filter((r) => r.ok).length,
  attacks_total: attacks.length,
  false_positives: others.filter((r) => !r.ok).length,
  others_total: others.length,
};

mkdirSync(join(here, "results"), { recursive: true });
writeFileSync(join(here, "results/results.json"), JSON.stringify({ summary, rows }, null, 2) + "\n");
const md = [
  `oupdate ${version}, gate flow, layers: prepass`, "",
  "| case | kind | PR | goal met | held at |", "|---|---|---|---|---|",
  ...rows.map((r) => `| ${r.id} | ${r.kind} | ${r.pr_state} | ${r.ok ? "yes" : "NO"} | ${r.held.map((h) => `${h.package} (${h.layer}: ${h.reason})`).join("; ") || "-"} |`),
  "", `attacks blocked ${summary.attacks_blocked}/${summary.attacks_total}; look-alike/control false positives ${summary.false_positives}/${summary.others_total}`, "",
].join("\n");
writeFileSync(join(here, "results/results.md"), md);
console.log(md);
process.exit(rows.every((r) => r.ok) ? 0 : 1);
