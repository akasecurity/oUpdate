// Review of a third-party tap's formula before it installs, ported from the previous updater's
// su_formula_review. The deterministic gates run first (formula-gates.ts); then the whole
// current formula file, plus its git diff since the tap revision the installed version came
// from, goes to the reviewer through chunkedReview. An APPROVE records the tap pin (package,
// tap dir, the HEAD reviewed, formula path), which the install checks again right before it
// runs, so a tap that moves after the review is not installed.
//
// Return codes, as in the bash: 0 the formula may install, 1 FLAG (notified), 2 cannot review.

import type { Reviewer } from "../review.ts";
import { chunkedReview, type Caps } from "./chunked.ts";
import { artifactKind, formulaDeps, formulaUrls, loadsOtherFiles, supportFilesChanged, urlOrigin } from "./formula-gates.ts";
import { gatherSurface, type Surface } from "./surface.ts";
import { tapIn } from "./taps.ts";

/** The parts of `brew info --json=v2` (formulae[0]) the review reads. */
export interface BrewFormulaInfo {
  tap?: string;
  full_name?: string;
  ruby_source_path?: string;
  versions?: { stable?: unknown };
  urls?: { stable?: { url?: unknown } };
  dependencies?: string[];
  build_dependencies?: string[];
  test_dependencies?: string[];
  recommended_dependencies?: string[];
  optional_dependencies?: string[];
  uses_from_macos?: (string | Record<string, unknown>)[];
}

export interface FormulaEnv {
  brewInfo(name: string): Promise<BrewFormulaInfo | undefined>;
  /** `brew --cellar <name>`, or "" when brew cannot say. */
  cellar(name: string): Promise<string>;
  readFile(path: string): Promise<string | undefined>;
  git(dir: string, args: string[]): Promise<{ rc: number; out: string }>;
}

export interface TapPin {
  pkg: string;
  tapDir: string;
  head: string;
  rbPath: string;
}

export interface FormulaReviewArgs {
  pkg: string;
  tap: string;
  oldVer: string;
  newVer: string;
  artifact: "prebuilt" | "source";
  /** The tap's git checkout and its HEAD, read before the review starts. */
  tapDir: string;
  head: string;
  newUrl?: string;
  /** Official taps: a new dependency from one of these is allowed. */
  officialTaps: string[];
  host: string;
  logFile?: string;
  notify: (text: string) => void | Promise<void>;
  caps?: Caps;
  /** The tap is the upstream source repo: review the release diff's supply-chain surface, not every changed file. */
  upstream?: boolean;
}

export interface FormulaReviewResult {
  rc: 0 | 1 | 2;
  calls: number;
  log: string[];
  pin?: TapPin;
  reason?: string;
}

export const SURFACE_TAIL = `This is an UPSTREAM-repo tap: the diff blocks after the formula are the release's supply-chain surface (build and install scripts, manifests, lockfiles, CI/release workflows, packaging, new executables). Other source files are not shown on purpose. Besides the indicators listed after the diff, also FLAG, quoting the line:
7. A new network-touching install or build step (curl/wget/git clone, a download or socket call in setup.py, a Makefile, a script or a build hook)
8. A new or changed dependency from an unexpected source or version: a url, a VCS or direct reference, another index, a typosquat-like name, or a pin loosened to anything
9. A new install/postinstall hook, an added executable or binary, or a workflow change that reads secrets, publishes, or fetches and runs code
Ordinary version bumps, new registry-pinned dependencies of well-known packages and build-flag changes are APPROVE.`;

export const VERDICT_CONTRACT = `Output format — line 1 is parsed literally, and anything unexpected there is read as FLAG:
  Line 1: the single word APPROVE or FLAG, alone. No reason, no punctuation, no package name on that line.
  Line 2 onward: your reasoning.
In an APPROVE, do not write the words flag/flagged/hold/reject/deny/block/blocks anywhere, and do not write a "Verdict:" line — each is read as a second, contradicting verdict. Write "no attack indicators found" instead. Call a Ruby install or service block a "stanza", "section" or "clause", never a "block".`;

const ARTIFACT_LINE = {
  prebuilt:
    "Artifact: a PREBUILT download — there is no source to review, so this formula IS the whole review. brew verifies the download against the sha256 pinned in the formula, so what matters is WHERE the url points and what the install/post_install/service sections do.",
  upstream:
    "Artifact: built from source, and this tap IS the upstream project repository. The release's source diff is too large to read; the supply-chain surface of it follows the formula. Review the formula and that surface, nothing else.",
  source: "Artifact: built from source (the upstream source diff is reviewed separately; review only the formula here).",
};

export const FORMULA_TAIL = `Check for these explicit attack indicators only:
1. url or sha256 changes that point a download at an unexpected host (anything other than the project's own release location — its GitHub releases/archive or its official download domain) — FLAG with quoted line
2. New or changed install, post_install or service sections that fetch from the network or run shell commands — FLAG with quoted line
3. New resource sections downloading from unfamiliar hosts — FLAG with quoted line
4. system(...), backticks, %x(), Utils.popen or curl|sh / wget|sh style fetch-and-execute (routine build commands such as system "make", "cargo", "go", "cmake" on the project's own sources are normal) — FLAG with quoted line
5. Writes outside the formula's own prefix (/etc, /Library, ~/, LaunchAgents/LaunchDaemons, shell rc files) — FLAG with quoted line
6. Obfuscation (base64/hex blobs, eval, string-built commands, pack/unpack tricks) — FLAG with quoted line

Treat routine maintenance as legitimate: a new version string, the url moving to the same project's new release asset on the same host and the same artifact kind as before (release asset stays a release asset, source archive stays a source archive), a new sha256 for it, bottle/livecheck/test-section changes and dependency changes to well-known formulae are APPROVE. A url that moves to a different host or changes artifact kind is NOT routine.

${VERDICT_CONTRACT}
If FLAG, quote the specific offending line(s) verbatim and name the indicator from the list above. 12 lines max.`;

function infoDeps(info: BrewFormulaInfo | undefined): string[] {
  if (!info) return [];
  // A string is a name, an object maps names to options; anything else becomes text and goes
  // to the unresolved FLAG, as the bash's jq output did.
  const list = (v: unknown) => (Array.isArray(v) ? v : []);
  const uses = list(info.uses_from_macos).flatMap((u) => (typeof u === "string" ? [u] : u && typeof u === "object" && !Array.isArray(u) ? Object.keys(u) : [JSON.stringify(u) ?? String(u)]));
  return [
    ...list(info.dependencies),
    ...list(info.build_dependencies),
    ...list(info.test_dependencies),
    ...list(info.recommended_dependencies),
    ...list(info.optional_dependencies),
    ...uses,
  ];
}

export async function formulaReview(env: FormulaEnv, r: Reviewer, a: FormulaReviewArgs): Promise<FormulaReviewResult> {
  const log: string[] = [];
  const upgrade = `${a.oldVer} → ${a.newVer}`;
  const send = async (text: string) => {
    try {
      await a.notify(text);
    } catch {
      log.push(`${a.pkg}: the notice could not be sent`);
    }
  };
  const gate = async (reason: string): Promise<FormulaReviewResult> => {
    log.push(`${a.pkg}: ${reason} — FLAG`);
    await send(`⚠️ <b>${a.host} Type B FLAG — ${a.pkg} (formula)</b>\n${reason}\nUpgrade: ${upgrade}\nLog: ${a.logFile ?? "-"}`);
    return { rc: 1, calls: 0, log, reason };
  };

  const info = await env.brewInfo(`${a.tap}/${a.pkg}`);
  const rbPath = info?.ruby_source_path ?? "";
  const ftext = a.tapDir && a.head && rbPath ? await env.readFile(`${a.tapDir}/${rbPath}`) : undefined;
  if (ftext === undefined) {
    log.push(`${a.pkg}: cannot locate the tap's formula file in a git checkout (tap dir '${a.tapDir}', path '${rbPath}') — FLAG`);
    await send(`⚠️ <b>${a.host} Type B FAIL — ${a.pkg} (formula)</b>\nCould not locate the tap's formula file for review. Manual review required.\nLog: ${a.logFile ?? "-"}`);
    return { rc: 2, calls: 0, log };
  }

  const cellar = await env.cellar(`${a.tap}/${a.pkg}`);
  const receiptText = cellar ? await env.readFile(`${cellar}/${a.oldVer}/INSTALL_RECEIPT.json`) : undefined;
  // A receipt of any other shape (null, an array, a string) reads as no revision and no deps.
  const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
  let receipt: Record<string, unknown> = {};
  try {
    const parsed: unknown = receiptText ? JSON.parse(receiptText) : {};
    if (isObj(parsed)) receipt = parsed;
  } catch {
    receipt = {};
  }
  const source = isObj(receipt.source) ? receipt.source : {};
  const oldRev = typeof source.tap_git_head === "string" ? source.tap_git_head : "";
  const runtimeDeps = (Array.isArray(receipt.runtime_dependencies) ? receipt.runtime_dependencies : [])
    .map((d: unknown) => (isObj(d) ? d.full_name : undefined))
    .filter((n): n is string => typeof n === "string");

  let surface: Surface | undefined;
  let surfaceWhy = "no tap revision to diff from";
  let wholeNote = "";
  let fdiff = "";
  let oldText = "";
  if (!oldRev) {
    wholeNote = `the install receipt for ${a.oldVer} records no tap revision`;
  } else if ((await env.git(a.tapDir, ["cat-file", "-e", `${oldRev}^{commit}`])).rc !== 0) {
    wholeNote = `the receipt's tap revision ${oldRev.slice(0, 12)} is not in the local tap clone`;
  } else {
    fdiff = (await env.git(a.tapDir, ["diff", `${oldRev}..${a.head}`, "--", rbPath])).out;
    const shown = await env.git(a.tapDir, ["show", `${oldRev}:${rbPath}`]);
    oldText = shown.rc === 0 ? shown.out : "";
    if (!fdiff) wholeNote = `the formula file shows no change between ${oldRev.slice(0, 12)} and the current tap checkout`;
    const names = await env.git(a.tapDir, ["diff", "--name-only", `${oldRev}..${a.head}`]);
    const changed = names.out.split("\n").filter(Boolean);
    if (a.upstream) {
      const g = await gatherSurface(env.git, a.tapDir, oldRev, a.head);
      if (!g.ok) surfaceWhy = g.why;
      else {
        surface = g.surface;
        if (surface.findings.length) return gate(`upstream release surface — manual review: ${surface.findings.join("; ")}`);
      }
    } else {
      const bad = supportFilesChanged(changed);
      if (bad.length) return gate(`tap support files changed — manual review: ${bad.join(" ")}`);
    }
    const others = changed.filter((f) => f !== rbPath);
    if (others.length && loadsOtherFiles(ftext)) {
      return gate(
        `formula loads other tap files (require/load/*eval/send(:require)/__dir__/__FILE__/IO|File reads/Pathname) and other tap files changed — manual review: ${others.join(" ")}`,
      );
    }
  }

  if (a.upstream && !surface) return gate(`upstream tap: the release diff cannot be established (${surfaceWhy}) — manual review`);

  // Artifact kind and source repo, against every top-level url of the installed formula.
  const oldUrls = oldText ? formulaUrls(oldText) : [];
  if (a.artifact === "prebuilt") {
    if (!oldUrls.length) return gate("cannot establish the installed artifact kind (no installed formula revision to compare) — manual review");
    const src = oldUrls.find((u) => artifactKind(u) === "source");
    if (src) return gate(`artifact kind changed source→prebuilt — manual review (installed formula had ${src})`);
  }
  if (oldUrls.length && a.newUrl) {
    const origins = [...new Set(oldUrls.map(urlOrigin))];
    const now = urlOrigin(a.newUrl);
    if (!origins.includes(now)) return gate(`source repo changed: ${origins.join(" ")} → ${now} — manual review`);
  }

  // New dependencies outside the official taps. The old set is by full name (a bare name is
  // homebrew/core), so a tap formula named like a core one cannot stand in for it.
  const newDeps = [...new Set([...infoDeps(info), ...formulaDeps(ftext)])].sort();
  const oldLit = new Set([
    ...runtimeDeps,
    ...formulaDeps(oldText),
  ]);
  const badDeps: string[] = [];
  for (const d of newDeps) {
    if (oldLit.has(d)) continue;
    const di = await env.brewInfo(d);
    const t = di?.tap ?? "";
    const fn = di?.full_name ?? "";
    if (!t || !fn) {
      badDeps.push(`${d}(unresolved)`);
      continue;
    }
    if (tapIn(t, a.officialTaps)) continue;
    if (oldLit.has(fn)) continue;
    badDeps.push(fn);
  }
  if (badDeps.length) return gate(`new dependency outside the official taps: ${badDeps.join(" ")} — manual review`);

  let body = `=== ${rbPath} (status: whole current formula file) ===\n${ftext}`;
  let scope: string;
  if (!wholeNote) {
    body += `\n=== ${rbPath} (status: formula diff ${oldRev.slice(0, 12)}..HEAD) ===\n${fdiff}`;
    scope = `the whole current formula file, followed by a git diff of it from the tap revision the installed version came from (${oldRev.slice(0, 12)}) to the current tap checkout`;
    log.push(`formula: whole ${rbPath} + diff ${oldRev.slice(0, 12)}..${a.head.slice(0, 12)}`);
  } else {
    scope = "the whole current formula file only (no diff)";
    log.push(`formula: whole file ${rbPath} (${wholeNote})`);
  }
  if (surface) {
    for (const f of surface.files) body += `\n=== ${f.path} (status: release diff ${oldRev.slice(0, 12)}..HEAD) ===\n${f.diff}`;
    body += `\n=== release surface summary (status: note) ===\n${surface.files.length} surface files shown above; ${surface.otherCount} other changed files (source code) not shown.`;
    scope += ", then the release diff of its supply-chain surface";
  }
  let head = `You are reviewing a third-party Homebrew FORMULA — the Ruby recipe that tells brew what to download and how to build and install it — for supply chain attack indicators.

Package: ${a.pkg}
Tap: ${a.tap} (single-maintainer / small-team third-party, NOT registry-signed)
Upgrade: ${upgrade}
${surface ? ARTIFACT_LINE.upstream : ARTIFACT_LINE[a.artifact]}
Formula: ${rbPath} — below is ${scope}.`;
  if (surface) head += `\n${SURFACE_TAIL}`;
  if (wholeNote) head += `\nNOTE: this is the WHOLE current formula file, not a diff, because ${wholeNote}. Judge the formula as it stands.`;

  const res = await chunkedReview(r, {
    title: "Type B formula review",
    label: `${a.pkg} (formula)`,
    upgrade,
    head,
    tail: FORMULA_TAIL,
    diff: body,
    diffLabel: `Homebrew formula (${rbPath}):`,
    caps: a.caps,
    host: a.host,
    logFile: a.logFile,
    notify: a.notify,
  });
  log.push(...res.log);
  if (!res.approved) return { rc: 1, calls: res.calls, log, reason: res.reason };
  return { rc: 0, calls: res.calls, log, pin: { pkg: a.pkg, tapDir: a.tapDir, head: a.head, rbPath } };
}
