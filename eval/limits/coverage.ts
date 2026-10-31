#!/usr/bin/env bun
// Ecosystem coverage matrix: for each lockfile kind, does a one-package update PR get parsed, reach the pre-pass
// and reach the reviewer? One minimal fixture per row runs through the gate, with a stub reviewer that always
// approves, so no model is needed. Rows for kinds oupdate does not read are measured the same way where a file
// name exists (yarn.lock) and are marked "no adapter" where none does. Writes results/<version>-coverage.{json,md}.
//   usage: bun eval/limits/coverage.ts [--out <dir>]
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { runGate } from "../../src/gate.ts";
import { parseLock } from "../../src/lockfile/index.ts";
import { reviewUpdate, type Reviewer } from "../../src/review.ts";
import type { Registry } from "../../src/adapters/ecosystem/types.ts";
import type { Forge } from "../../src/adapters/forge/types.ts";

export interface Row {
  ecosystem: string;
  file: string;
  status: "covered" | "not covered (measured)";
  parsed: boolean;
  prepass: boolean;
  reviewer: boolean;
  note: string;
}

const enc = new TextEncoder();
const sri = (s: string) =>
  `sha512-${createHash("sha512").update(s).digest("base64")}`;
const hex = (s: string) => createHash("sha256").update(s).digest("hex");
const NAME = "tiny-lib";
const [V1, V2] = ["1.0.0", "1.0.1"];
const tarball = (v: string) =>
  `https://registry.npmjs.org/${NAME}/-/${NAME}-${v}.tgz`;
const wheel = (v: string) => `${NAME.replace("-", "_")}-${v}-py3-none-any.whl`;
const whl = (v: string) =>
  `https://files.pythonhosted.org/packages/ab/cd/${wheel(v)}`;

/** The lockfile text at version `v` of the one package. */
const FIXTURES: {
  ecosystem: string;
  file: string;
  eco: "npm" | "pypi";
  text: (v: string) => string;
}[] = [
  {
    ecosystem: "bun",
    file: "bun.lock",
    eco: "npm",
    text: (v) =>
      JSON.stringify({
        lockfileVersion: 1,
        packages: { [NAME]: [`${NAME}@${v}`, "", {}] },
      }),
  },
  {
    ecosystem: "npm",
    file: "package-lock.json",
    eco: "npm",
    text: (v) =>
      JSON.stringify({
        lockfileVersion: 3,
        packages: {
          "": { name: "app" },
          [`node_modules/${NAME}`]: {
            version: v,
            resolved: tarball(v),
            integrity: sri(v),
          },
        },
      }),
  },
  {
    ecosystem: "pnpm",
    file: "pnpm-lock.yaml",
    eco: "npm",
    text: (v) =>
      [
        `lockfileVersion: '9.0'`,
        "packages:",
        `  ${NAME}@${v}:`,
        `    resolution: {integrity: ${sri(v)}}`,
        "snapshots:",
        `  ${NAME}@${v}: {}`,
        "",
      ].join("\n"),
  },
  {
    ecosystem: "uv",
    file: "uv.lock",
    eco: "pypi",
    text: (v) =>
      [
        `version = 1`,
        "[[package]]",
        `name = "${NAME}"`,
        `version = "${v}"`,
        `source = { registry = "https://pypi.org/simple" }`,
        `wheels = [{ url = "${whl(v)}", hash = "sha256:${hex(v)}" }]`,
        "",
      ].join("\n"),
  },
  {
    ecosystem: "poetry",
    file: "poetry.lock",
    eco: "pypi",
    text: (v) =>
      [
        "[[package]]",
        `name = "${NAME}"`,
        `version = "${v}"`,
        `files = [{file = "${wheel(v)}", hash = "sha256:${hex(v)}"}]`,
        "",
      ].join("\n"),
  },
  {
    ecosystem: "requirements",
    file: "requirements.txt",
    eco: "pypi",
    text: (v) => `${NAME}==${v} --hash=sha256:${hex(v)}\n`,
  },
];

const registry: Registry = {
  latest: async () => undefined,
  publishedAt: async () => new Date("2026-01-01T00:00:00Z"),
  artifactUrls: async () => [],
};
const pkgFiles = (v: string) =>
  new Map([
    ["package.json", enc.encode(JSON.stringify({ name: NAME, version: v }))],
    ["index.js", enc.encode(`module.exports = () => ${JSON.stringify(v)};\n`)],
  ]);

/** One PR that changes only `file` (base text -> head text) through the gate; what the review callback and the stub reviewer saw. */
async function runPr(
  file: string,
  base: string,
  head: string,
  lockPaths?: string[],
) {
  const seen = { prepass: false, reviewer: false, reviews: 0 };
  const reviewer: Reviewer = {
    name: "stub",
    review: async () => {
      seen.reviewer = true;
      return "APPROVE\nno concerns";
    },
  };
  const files: Record<string, string> = {
    [`b:${file}`]: base,
    [`h:${file}`]: head,
  };
  const forge: Forge = {
    self: async () => "gate",
    openPulls: async () => [
      {
        number: 1,
        headRef: "renovate/update",
        headSha: "h",
        baseSha: "b",
        author: "renovate[bot]",
        headRepo: "o/r",
        baseRepo: "o/r",
      },
    ],
    readFile: async (_r, sha, path) => files[`${sha}:${path}`],
    changedFiles: async () => [file],
    statusOf: async () => undefined,
    setStatus: async () => {},
    ownComment: async () => undefined,
    upsertComment: async () => {},
  };
  const [pr] = await runGate({
    forge,
    repo: "o/r",
    ...(lockPaths ? { lockPaths } : {}),
    review: async (ch) => {
      seen.reviews++;
      const r = await reviewUpdate({
        eco: ch.eco,
        name: ch.name,
        from: ch.from ?? "",
        to: ch.to,
        registry,
        advisories: { query: async () => [] },
        reviewer,
        cooldownDays: 0,
        now: new Date("2026-10-28T12:00:00Z"),
        loadArtifacts: async () => ({
          old: pkgFiles(ch.from ?? V1),
          new: pkgFiles(ch.to),
        }),
        only: ["prepass", "reviewer"],
      });
      if (r.layers.some((l) => l.layer === "prepass")) seen.prepass = true;
      return r;
    },
  });
  return { ...seen, state: pr!.state, results: pr!.results };
}

export async function measure(): Promise<Row[]> {
  const rows: Row[] = [];
  for (const f of FIXTURES) {
    const [base, head] = [f.text(V1), f.text(V2)];
    const named = f.file === "requirements.txt" ? [f.file] : undefined;
    const pkgs = parseLock(f.file, head).pkgs;
    const parsed = pkgs.some((p) => p.name === NAME && p.version === V2);
    const r = await runPr(f.file, base, head, named);
    rows.push({
      ecosystem: f.ecosystem,
      file: f.file,
      status: "covered",
      parsed,
      prepass: r.prepass,
      reviewer: r.reviewer,
      note: `gate state ${r.state}, ${r.reviews} package reviewed`,
    });
  }
  // yarn.lock has no parser: a PR that changes only it must produce no review.
  const yarn = (v: string) =>
    `# yarn lockfile v1\n\n${NAME}@^1.0.0:\n  version "${v}"\n  resolved "${tarball(v)}"\n  integrity ${sri(v)}\n`;
  let parsed = true;
  try {
    parseLock("yarn.lock", yarn(V2));
  } catch {
    parsed = false;
  }
  const y = await runPr("yarn.lock", yarn(V1), yarn(V2));
  rows.push({
    ecosystem: "yarn",
    file: "yarn.lock",
    status: "not covered (measured)",
    parsed,
    prepass: y.prepass,
    reviewer: y.reviewer,
    note: `gate state ${y.state}, ${y.reviews} package reviewed`,
  });
  for (const [ecosystem, file] of [
    ["apt", "-"],
    ["Mac App Store", "-"],
  ] as const) {
    rows.push({
      ecosystem,
      file,
      status: "not covered (measured)",
      parsed: false,
      prepass: false,
      reviewer: false,
      note: "no adapter",
    });
  }
  return rows;
}

export function table(version: string, rows: Row[]): string {
  const yn = (b: boolean) => (b ? "yes" : "no");
  return [
    `oupdate ${version}, ecosystem coverage`,
    "",
    "| ecosystem | file | status | parsed | pre-pass | reviewer | note |",
    "|---|---|---|---|---|---|---|",
    ...rows.map(
      (r) =>
        `| ${r.ecosystem} | ${r.file} | ${r.status} | ${yn(r.parsed)} | ${yn(r.prepass)} | ${yn(r.reviewer)} | ${r.note} |`,
    ),
    "",
  ].join("\n");
}

if (import.meta.main) {
  const here = dirname(new URL(import.meta.url).pathname);
  const version = (await Bun.file(join(here, "../../package.json")).json())
    .version as string;
  const i = process.argv.indexOf("--out");
  const out = i > 0 ? process.argv[i + 1]! : join(here, "results");
  const rows = await measure();
  mkdirSync(out, { recursive: true });
  writeFileSync(
    join(out, `${version}-coverage.json`),
    JSON.stringify({ tool_version: version, rows }, null, 2) + "\n",
  );
  const md = table(version, rows);
  writeFileSync(join(out, `${version}-coverage.md`), md);
  console.log(md);
}
