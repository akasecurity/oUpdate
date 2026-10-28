// The forge gate: for each open update PR (Renovate's `renovate/` branches by
// default), diff the lockfile between base and head, review every package
// version the PR brings in, and report on the head commit as a status plus one
// comment. Only PRs the update bot opened from a branch of the repo itself are
// gated. Final states (success, failure) this gate posted, and bound to that head
// in its own comment, are not re-reviewed; pending is, on the next run: a hold
// from cooldown alone or from layer errors can clear.

import { posix } from "node:path";
import type { Forge, Pull, StatusState } from "./adapters/forge/types.ts";
import { diffLocks, type LockChange } from "./lockdiff.ts";
import { LOCK_NAMES, parseLock } from "./lockfile/index.ts";
import { stripTrailingCommas } from "./lockfile/bunlock.ts";
import { pep503 } from "./lockfile/pylock.ts";
import type { Ecosystem } from "./prepass.ts";
import { badName, badVersion, inert, shown } from "./ident.ts";
import type { ReviewResult } from "./review.ts";

/** A package version a PR brings in, with the ecosystem of the lockfile that pins it. */
export type Change = LockChange & { eco: Ecosystem };

export interface GateArgs {
  forge: Forge;
  repo: string;
  review: (c: Change) => Promise<ReviewResult>;
  /** A PR is gated when its head branch starts with any of these. Default: Renovate's `renovate/`. */
  branchPrefixes?: string[];
  /** ...and its author is one of these logins (any case), and its head branch is in the repo, not a fork. Default: BOT_LOGINS. */
  botLogins?: string[];
  /** Lockfiles to diff, all into one status. None: each known lockfile name at the repo root that the head has. */
  lockPaths?: string[];
  /** What a version from a private registry gets; default PRIVATE_REGISTRY_DEFAULT. */
  privateRegistry?: PrivateRegistryPolicy;
  context?: string;
  /** Where to say why a PR is not gated (its branch, author or fork), one line each; default nowhere. */
  log?: (line: string) => void;
}

/**
 * A lockfile version from a non-default registry, which the public registry and OSV know nothing
 * about. "hold" (the default): the PR fails until a person merges it past the gate. "list" (an explicit opt-in):
 * named in the comment as not reviewed, the gate state is left to the other changes. "review": reviewed against
 * the public registry, as before (a dependency-confusion blind spot).
 */
export type PrivateRegistryPolicy = "list" | "hold" | "review";
export const PRIVATE_REGISTRY_POLICIES: PrivateRegistryPolicy[] = ["hold", "list", "review"];
export const PRIVATE_REGISTRY_DEFAULT: PrivateRegistryPolicy = "hold";

const privateNote = (c: Change) => `not reviewed (private registry ${shown(c.registry ?? "")})`;

function heldPrivate(c: Change): ReviewResult {
  return { eco: c.eco, name: c.name, from: c.from ?? "", to: c.to, decision: "hold", layers: [{ layer: "gate", verdict: "stop", detail: `${privateNote(c)}; a person decides` }] };
}

/** Why a change's name or version cannot be a registry release's (a direct source has no version of its own), or undefined. */
function malformedIdent(c: Change): string | undefined {
  return badName(c.eco, c.name) ?? (c.direct ? undefined : badVersion(c.to) ?? (c.from ? badVersion(c.from) : undefined));
}

/** A change the gate cannot review against a registry: it fails the PR for a person to decide. */
function heldUnreviewable(c: Change, why: string): ReviewResult {
  return { eco: c.eco, name: c.name, from: c.from ?? "", to: c.to, decision: "hold", layers: [{ layer: "gate", verdict: "stop", detail: `${why}; a person checks it` }] };
}

export interface GatePull {
  number: number;
  state: StatusState | "skipped";
  results: ReviewResult[];
}

export const MARKER = "<!-- oupdate-gate -->";

/** The line in the gate's comment that binds a verdict to the head it was given for. */
export const verdictLine = (sha: string, state: StatusState) => `<!-- oupdate-verdict: ${sha} ${state} -->`;

/** The logins the Renovate and Dependabot apps open PRs as on GitHub; a `[bot]` login cannot be taken by a user. */
export const BOT_LOGINS = ["renovate[bot]", "dependabot[bot]"];

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * Why a PR is not gated, or undefined when it is: only a PR the update bot opened from a branch of the repo itself,
 * on a gated branch, is. A fork or anyone else's PR never is.
 */
function notGated(pr: Pull, repo: string, bots: string[], prefixes: string[]): string | undefined {
  if (!prefixes.some((p) => pr.headRef.startsWith(p))) return `branch ${pr.headRef} does not start with ${prefixes.join(" or ")}`;
  if (!pr.headRepo || !same(pr.headRepo, pr.baseRepo) || !same(pr.baseRepo, repo)) return `head branch is in ${pr.headRepo || "a deleted fork"}, not ${repo}`;
  if (!bots.some((b) => same(b, pr.author))) return `author ${pr.author || "(none)"} is not a bot login (${bots.join(", ")}); set --bot-login`;
  return undefined;
}

export function gateState(results: ReviewResult[]): StatusState {
  // Nothing reviewed (every change listed as not reviewed) is no evidence of a pass.
  if (results.length && results.every((r) => r.decision === "land")) return "success";
  const hard = results.some((r) => r.decision === "hold" && r.layers.some((l) => l.verdict === "stop" && l.layer !== "cooldown"));
  return hard ? "failure" : "pending";
}

function errored(c: Change, e: unknown): ReviewResult {
  return { eco: c.eco, name: c.name, from: c.from ?? "", to: c.to, decision: "hold", layers: [{ layer: "reviewer", verdict: "error", detail: `review failed: ${e instanceof Error ? e.message : String(e)}` }] };
}

function comment(sha: string, locks: string, state: StatusState, results: ReviewResult[], unreviewed: Change[]): string {
  const lines = [MARKER, verdictLine(sha, state), `**oupdate: ${state}** (${locks})`, ""];
  for (const r of results) if (r.malicious?.length) lines.push(`**MALICIOUS: ${shown(r.name)} ${shown(r.to)} (${r.malicious.join(", ")}).** Do not merge, and check where this version is already installed.`, "");
  for (const r of results) {
    lines.push(`- \`${shown(r.name)} ${r.from ? shown(r.from) : "(new)"} -> ${shown(r.to)}\`: **${r.decision}**`);
    for (const l of r.layers) lines.push(`  - ${l.layer} ${l.verdict}: ${inert(l.detail.replace(/\s+/g, " ").slice(0, 300))}`);
  }
  for (const c of unreviewed) lines.push(`- \`${shown(c.name)} ${c.from ? shown(c.from) : "(new)"} -> ${shown(c.to)}\`: ${privateNote(c)}`);
  return lines.join("\n");
}

/**
 * Manifests a read lockfile can cover, with the fields that only say which dependency versions to want (the
 * lockfile shows what they resolve to). `*` matches any key. A change to any other field (lifecycle scripts, entry
 * points, the build system, the package manager, sources) is behavior the gate does not review.
 */
const MANIFESTS: Record<string, { eco: Ecosystem; parse: (text: string) => unknown; deps: string[][] }> = {
  "package.json": { eco: "npm", parse: JSON.parse, deps: [["dependencies"], ["devDependencies"], ["optionalDependencies"], ["peerDependencies"], ["overrides"], ["resolutions"], ["engines"]] },
  "pnpm-workspace.yaml": { eco: "npm", parse: (t) => Bun.YAML.parse(t), deps: [["catalog"], ["catalogs"], ["overrides"]] },
  "pyproject.toml": {
    eco: "pypi",
    parse: (t) => Bun.TOML.parse(t),
    deps: [["project", "dependencies"], ["project", "optional-dependencies"], ["dependency-groups"], ["tool", "poetry", "dependencies"], ["tool", "poetry", "dev-dependencies"], ["tool", "poetry", "group", "*", "dependencies"], ["tool", "uv", "dev-dependencies"]],
  },
};

/** `o` without the field at `path`, in place. */
function drop(o: unknown, path: string[]): void {
  if (!o || typeof o !== "object") return;
  const [k, ...rest] = path;
  const rec = o as Record<string, unknown>;
  for (const key of k === "*" ? Object.keys(rec) : [k!]) {
    if (!rest.length) delete rec[key];
    else drop(rec[key], rest);
  }
}

const dirOf = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");

/**
 * A read lockfile covering a manifest folder: its path, that folder's key inside it ("" its own), its head text,
 * whether the PR changes it, the package versions its diff brings in and the ones its head locks.
 */
interface Cover {
  path: string;
  member: string;
  text: string;
  changed: boolean;
  diff: LockChange[];
  locked: { name: string; version: string }[];
}

const rec = (o: unknown) => (o && typeof o === "object" && !Array.isArray(o) ? (o as Record<string, unknown>) : {});
const arr = (o: unknown) => (Array.isArray(o) ? o : []);

/** One dependency a manifest asks for: the field it is in, its name and its spec as written. */
interface DepSpec {
  field: string;
  name: string;
  spec: unknown;
  /** How the spec is written: an npm range, a PEP 508 requirement or a Poetry constraint (string or table). */
  kind: "npm" | "pep508" | "poetry";
}

const PEP508 = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)\s*(\[[\w\s,.-]*\])?\s*\(?([\w\s.*,<>=!~+-]*?)\)?\s*$/;

/** The dependencies a parsed manifest asks for, by an id that is the same in base and head for the same entry. */
function depSpecs(file: string, o: unknown): Map<string, DepSpec> {
  const out = new Map<string, DepSpec>();
  const map = (field: string, m: unknown, kind: DepSpec["kind"]) => {
    // YAML reads `a: 2` as a number; the lockfile writes the same spec as text.
    for (const [name, spec] of Object.entries(rec(m))) out.set(`${field}\0${name}`, { field, name, spec: typeof spec === "number" ? String(spec) : spec, kind });
  };
  // A PEP 508 list has no keys: an entry is the same only when its text is.
  const list = (field: string, l: unknown) => {
    for (const spec of arr(l)) out.set(`${field}\0${JSON.stringify(spec)}`, { field, name: typeof spec === "string" ? (PEP508.exec(spec.split(";")[0]!)?.[1] ?? spec) : "", spec, kind: "pep508" });
  };
  const r = rec(o);
  if (file === "package.json") {
    for (const f of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies", "resolutions"]) map(f, r[f], "npm");
    // overrides nest: { a: { ".": "1", b: "2" } }.
    const walk = (m: unknown, at: string) => {
      for (const [k, v] of Object.entries(rec(m))) {
        if (v && typeof v === "object") walk(v, `${at}${k}>`);
        else out.set(`overrides\0${at}${k}`, { field: "overrides", name: `${at}${k}`, spec: v, kind: "npm" });
      }
    };
    walk(r.overrides, "");
  } else if (file === "pnpm-workspace.yaml") {
    map("catalog", r.catalog, "npm");
    for (const [c, m] of Object.entries(rec(r.catalogs))) map(`catalogs.${c}`, m, "npm");
    map("overrides", r.overrides, "npm");
  } else {
    const project = rec(r.project);
    list("project.dependencies", project.dependencies);
    for (const [g, l] of Object.entries(rec(project["optional-dependencies"]))) list(`project.optional-dependencies.${g}`, l);
    for (const [g, l] of Object.entries(rec(r["dependency-groups"]))) list(`dependency-groups.${g}`, l);
    list("tool.uv.dev-dependencies", rec(rec(r.tool).uv)["dev-dependencies"]);
    const poetry = rec(rec(r.tool).poetry);
    map("tool.poetry.dependencies", poetry.dependencies, "poetry");
    map("tool.poetry.dev-dependencies", poetry["dev-dependencies"], "poetry");
    for (const [g, t] of Object.entries(rec(poetry.group))) map(`tool.poetry.group.${g}.dependencies`, rec(t).dependencies, "poetry");
  }
  return out;
}

/**
 * An npm semver range or plain dist-tag (empty is any version, as `*`): never what npm reads as a path (a leading
 * `.`, `/` or `~/`) or a tarball file.
 */
const npmRange = (s: unknown) => typeof s === "string" && /^[\w\s.*^~<>=|+-]*$/.test(s) && !/^\s*(\.|\/|~\/)/.test(s) && !/\.(tgz|tar|tar\.gz)\s*$/i.test(s);

/** An `npm:<name>@<range>` alias: the package it installs and its range (none is any version). */
function npmAlias(s: unknown): { name: string; range: string } | undefined {
  const m = typeof s === "string" ? /^npm:((?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*)(?:@(.*))?$/i.exec(s) : null;
  return m ? { name: m[1]!, range: m[2] ?? "" } : undefined;
}

const POETRY_KEYS = new Set(["version", "extras", "markers", "python", "optional", "allow-prereleases", "platform"]);
const poetryRange = (v: unknown) => typeof v === "string" && /^[\w\s.*,<>=!~^|+-]+$/.test(v);

/**
 * A spec that resolves from the package registry by version: a range, version or tag. A git, URL, file, link,
 * workspace, catalog or user/repo spec (anything with `:`, `/`, `@` or `#`), a PEP 508 direct reference (`name @ url`)
 * or a Poetry git, path or url table is not. An `npm:` alias is when its range is; a Poetry `source` only when it
 * is PyPI or one of `sources`, the ones the manifest declared before the change (lowercase).
 */
function registrySpec(d: DepSpec, sources: Set<string>): boolean {
  const s = d.spec;
  const alias = npmAlias(s);
  if (d.kind === "npm") return npmRange(s) || (!!alias && npmRange(alias.range)) || (typeof s === "string" && d.field === "overrides" && /^\$[\w.@/-]+$/.test(s));
  if (d.kind === "pep508") {
    // A dependency-groups entry may include another group.
    if (s && typeof s === "object") return Object.keys(s).length === 1 && typeof rec(s)["include-group"] === "string";
    return typeof s === "string" && !s.split(";")[0]!.includes("@") && PEP508.test(s.split(";")[0]!);
  }
  const table = (t: unknown) => !!t && typeof t === "object" && Object.entries(t).every(([k, v]) => POETRY_KEYS.has(k) || (k === "source" && typeof v === "string" && (v.toLowerCase() === "pypi" || sources.has(v.toLowerCase())))) && (rec(t).version === undefined || poetryRange(rec(t).version));
  return poetryRange(s) || (Array.isArray(s) ? s.length > 0 && s.every(table) : table(s));
}

const specSet = (s: string) => s.replace(/[\s()]/g, "").split(",").filter(Boolean).sort().join(",");

/**
 * Whether the lockfile's root record (the project's own entry, which the package manager copies from the manifest)
 * names this spec: true or false, or undefined when this lockfile keeps no such record for it (poetry.lock and
 * requirements files keep none; npm lockfiles none for overrides). Then the lockfile's own diff has to show it.
 */
function rootMatches(c: Cover, file: string, d: DepSpec): boolean | undefined {
  const lock = c.path.split("/").pop();
  if (file === "package.json" && ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"].includes(d.field)) {
    if (lock === "package-lock.json" || lock === "npm-shrinkwrap.json") return rec(rec(rec(rec(JSON.parse(c.text)).packages)[c.member])[d.field])[d.name] === d.spec;
    if (lock === "bun.lock") return rec(rec(rec(rec(JSON.parse(stripTrailingCommas(c.text))).workspaces)[c.member])[d.field])[d.name] === d.spec;
    // pnpm records no peer dependencies of the project itself. A registry spec it resolved to a local link or
    // file is not what the manifest asks for. A v5 or v6 single-project lockfile (no importers) keeps the root's
    // record at the top level; v5 writes the version alone, with the spec in a `specifiers` map.
    if (lock === "pnpm-lock.yaml") {
      if (d.field === "peerDependencies") return undefined;
      const l = rec(Bun.YAML.parse(c.text));
      const imp = l.importers === undefined ? (c.member ? {} : l) : rec(rec(l.importers)[c.member || "."]);
      const raw = rec(imp[d.field])[d.name];
      const dep = typeof raw === "string" ? { specifier: rec(imp.specifiers)[d.name], version: raw } : rec(raw);
      return String(dep.specifier) === d.spec && !/^(link|file):/.test(String(dep.version));
    }
    return false;
  }
  if (file === "pnpm-workspace.yaml") {
    if (lock !== "pnpm-lock.yaml") return undefined;
    const l = rec(Bun.YAML.parse(c.text));
    if (d.field === "overrides") return String(rec(l.overrides)[d.name]) === d.spec;
    const catalog = d.field === "catalog" ? "default" : d.field.slice("catalogs.".length);
    return String(rec(rec(rec(l.catalogs)[catalog])[d.name]).specifier) === d.spec;
  }
  if (d.kind === "pep508" && typeof d.spec === "string" && lock === "uv.lock") {
    const root = arr(rec(Bun.TOML.parse(c.text)).package).map(rec).find((p) => [rec(p.source).editable, rec(p.source).virtual].includes(c.member || "."));
    if (!root) return false;
    const meta = rec(root.metadata);
    const reqs = [...arr(meta["requires-dist"]), ...Object.values(rec(meta["requires-dev"])).flatMap(arr)].map(rec);
    const m = PEP508.exec(d.spec.split(";")[0]!)!;
    return reqs.some((q) => typeof q.name === "string" && pep503(q.name) === pep503(m[1]!) && specSet(typeof q.specifier === "string" ? q.specifier : "") === specSet(m[3]!));
  }
  return undefined;
}

/** The package a dependency entry is for: an override or resolution key's last package, without a version selector. */
function depName(d: DepSpec): string {
  if (d.kind !== "npm") return pep503(d.name);
  const alias = npmAlias(d.spec);
  if (alias) return alias.name;
  if (d.field !== "overrides" && d.field !== "resolutions") return d.name;
  // overrides: `a>b`, `a>.` (a itself), `b@1`; resolutions: `**/b`, `a/b`, `@s/a/@s/b`.
  const last = d.name.split(">").filter((p) => p !== ".").pop() ?? "";
  const parts = last.split("/").reduce<string[]>((o, p) => (o.length && o[o.length - 1]!.startsWith("@") && !o[o.length - 1]!.includes("/") ? [...o.slice(0, -1), `${o[o.length - 1]}/${p}`] : [...o, p]), []);
  return (parts.pop() ?? "").replace(/(?<=.)@.*$/, "");
}

/** A PEP 440 version: epoch, release, and the pre, post and dev parts and local label it may have. */
interface Pep440 {
  epoch: number;
  release: number[];
  pre?: [number, number];
  post?: number;
  dev?: number;
  local?: string;
}

const PEP440 = /^v?(?:(\d+)!)?(\d+(?:\.\d+)*)(?:[-_.]?(a|b|c|rc|alpha|beta|pre|preview)[-_.]?(\d*))?(?:-(\d+)|[-_.]?(?:post|rev|r)[-_.]?(\d*))?(?:[-_.]?dev[-_.]?(\d*))?(?:\+([a-z0-9]+(?:[-_.][a-z0-9]+)*))?$/i;
const PRE_RANK: Record<string, number> = { a: 0, alpha: 0, b: 1, beta: 1, c: 2, rc: 2, pre: 2, preview: 2 };

function pep440(text: string): Pep440 | undefined {
  const m = PEP440.exec(text.trim());
  if (!m) return undefined;
  const v: Pep440 = { epoch: Number(m[1] ?? 0), release: m[2]!.split(".").map(Number) };
  if (m[3]) v.pre = [PRE_RANK[m[3].toLowerCase()]!, Number(m[4] || 0)];
  // A part written with no number is 0 (`1.0.post`, `1.0.dev`); a part not written is absent.
  if (m[5] !== undefined) v.post = Number(m[5]);
  else if (m[6] !== undefined) v.post = Number(m[6] || 0);
  if (m[7] !== undefined) v.dev = Number(m[7] || 0);
  if (m[8]) v.local = m[8].toLowerCase();
  return v;
}

/** PEP 440 order (the local label aside): epoch, release padded with zeros, then pre, post and dev. */
function pepCmp(a: Pep440, b: Pep440): number {
  if (a.epoch !== b.epoch) return a.epoch - b.epoch;
  for (let i = 0; i < Math.max(a.release.length, b.release.length); i++) {
    const d = (a.release[i] ?? 0) - (b.release[i] ?? 0);
    if (d) return d;
  }
  // A dev release of a plain release sorts before its prereleases; no pre sorts after them.
  const pre = (v: Pep440) => (v.pre ? v.pre : v.post === undefined && v.dev !== undefined ? [-1, 0] : [3, 0]);
  const keys = (v: Pep440) => [...pre(v), v.post ?? -1, v.dev ?? Infinity];
  const [x, y] = [keys(a), keys(b)];
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i]! < y[i]! ? -1 : 1;
  return 0;
}

/** Whether `v`'s release starts with `prefix` (in the same epoch), zeros padded: `==1.2.*`. */
const prefixOf = (v: Pep440, prefix: Pep440) => v.epoch === prefix.epoch && prefix.release.every((n, i) => (v.release[i] ?? 0) === n);

const plainRelease = (v: Pep440) => !v.pre && v.post === undefined && v.dev === undefined && !v.local;

/** One PEP 440 clause against a plain or post release: true, false or undefined (a clause the gate cannot read). */
function pepClause(clause: string, raw: string, v: Pep440): boolean | undefined {
  const m = /^(===|~=|==|!=|<=|>=|<|>)\s*(\S+)$/.exec(clause.trim());
  if (!m) return undefined;
  const [, op, text] = m as unknown as [string, string, string];
  if (op === "===") return raw.trim().toLowerCase() === text.toLowerCase();
  if (text.endsWith(".*")) {
    const prefix = pep440(text.slice(0, -2));
    if ((op !== "==" && op !== "!=") || !prefix || !plainRelease(prefix)) return undefined;
    return prefixOf(v, prefix) === (op === "==");
  }
  const s = pep440(text);
  if (!s || s.local) return undefined;
  const c = pepCmp(v, s);
  switch (op) {
    case "==": return c === 0;
    case "!=": return c !== 0;
    case "<=": return c <= 0;
    case ">=": return c >= 0;
    case "<": return c < 0;
    // `>1.0` does not take 1.0's post releases.
    case ">": return c > 0 && !(v.post !== undefined && s.post === undefined && pepCmp({ ...v, post: undefined }, s) === 0);
    default: {
      // ~=X.Y: >=X.Y and ==X.*.
      if (s.release.length < 2) return undefined;
      return c >= 0 && prefixOf(v, { epoch: s.epoch, release: s.release.slice(0, -1) });
    }
  }
}

/** Every clause true is true; any false is false; otherwise (one the gate cannot read) undefined. */
function every(results: (boolean | undefined)[]): boolean | undefined {
  return results.includes(false) ? false : results.includes(undefined) ? undefined : true;
}

/** The version a pin locks, when the gate can compare it: a plain or post release, never a prerelease or local one. */
function lockedVersion(v: string): Pep440 | undefined {
  const p = pep440(v);
  return p && !p.pre && p.dev === undefined && !p.local ? p : undefined;
}

/**
 * Whether a PEP 440 specifier set (`>=1,<3`, `~=2.2`, `==2.*`; empty is any version) allows a locked version:
 * true, false, or undefined when it cannot tell (a prerelease, dev or local version, a clause it cannot read).
 */
export function pep440Allows(spec: string, version: string): boolean | undefined {
  const v = lockedVersion(version);
  if (!v) return undefined;
  const clauses = spec.split(",").map((c) => c.trim());
  if (clauses.length === 1 && clauses[0] === "") return true;
  if (clauses.includes("")) return undefined;
  return every(clauses.map((c) => pepClause(c, version, v)));
}

/** One Poetry constraint (`^1.2`, `~1.2`, `1.2.*`, `1.2.3`, `*` or a PEP 440 clause) as PEP 440 clauses, or undefined. */
function poetryClauses(token: string): string[] | undefined {
  if (token === "*") return [];
  const m = /^(\^|~(?!=))\s*(.+)$/.exec(token);
  if (m) {
    const base = pep440(m[2]!);
    if (!base || !plainRelease(base)) return undefined;
    const r = base.release;
    let upper: number[];
    if (m[1] === "^") {
      const i = r.findIndex((n) => n !== 0);
      const at = i < 0 ? r.length - 1 : i;
      upper = [...r.slice(0, at), r[at]! + 1];
    } else upper = r.length === 1 ? [r[0]! + 1] : [r[0]!, r[1]! + 1];
    const epoch = base.epoch ? `${base.epoch}!` : "";
    return [`>=${m[2]}`, `<${epoch}${upper.join(".")}`];
  }
  if (/^[<>=!~]/.test(token)) return [token];
  if (/^\d[\w.]*\.\*$/.test(token)) return [`==${token}`];
  return pep440(token) ? [`==${token}`] : undefined;
}

/**
 * Whether a Poetry version constraint allows a locked version: `||` (or `|`) branches, any of which may allow it,
 * each a comma or space separated list that all must. True, false, or undefined when it cannot tell.
 */
export function poetryAllows(spec: string, version: string): boolean | undefined {
  const v = lockedVersion(version);
  if (!v) return undefined;
  const branchResults = spec.split(/\|\|?/).map((branch) => {
    const tokens = branch.trim().replace(/(===|~=|==|!=|<=|>=|<|>|\^|~)\s+/g, "$1").split(/\s*,\s*|\s+/).filter(Boolean);
    if (!tokens.length) return undefined;
    const clauses = tokens.map(poetryClauses);
    if (clauses.some((c) => c === undefined)) return undefined;
    return every(clauses.flat().map((c) => pepClause(c!, version, v)));
  });
  return branchResults.includes(true) ? true : branchResults.includes(undefined) ? undefined : false;
}

/**
 * Whether a locked version meets a registry spec: true or false, or undefined when the gate cannot check it (a
 * dist-tag, an override reference, a prerelease or local locked version, a Python clause it cannot read).
 */
function allows(d: DepSpec, v: string): boolean | undefined {
  const s = d.spec;
  if (d.kind === "npm") {
    const r = (npmAlias(s)?.range ?? (typeof s === "string" ? s : "")).trim();
    if (r.startsWith("$") || (/^[A-Za-z]/.test(r) && !/^[vVxX](\d|\.|$)/.test(r))) return undefined;
    return Bun.semver.satisfies(v, r);
  }
  if (d.kind === "pep508") {
    const m = typeof s === "string" ? PEP508.exec(s.split(";")[0]!) : null;
    return m ? pep440Allows(m[3] ?? "", v) : undefined;
  }
  const c = typeof s === "string" ? s : rec(s).version;
  return typeof c === "string" ? poetryAllows(c, v) : undefined;
}

/** A Poetry multiple-constraint array as one spec per branch, each checked on its own; any other spec as itself. */
const branches = (d: DepSpec): DepSpec[] => (d.kind === "poetry" && Array.isArray(d.spec) ? d.spec.map((spec) => ({ ...d, spec })) : [d]);

/**
 * Whether one covering lockfile's diff brings in this dependency at a version its spec allows (or one it cannot
 * check), for every branch of a Poetry array. When the diff leaves the package alone (a constraint-only change), a
 * version the lockfile already locks has to meet the spec as checked: one the gate cannot check fails.
 */
function lockShows(c: Cover, d: DepSpec): boolean {
  const name = depName(d);
  const is = (n: string) => (d.kind === "npm" ? n === name : pep503(n) === name);
  const diff = c.diff.filter((x) => is(x.name));
  if (!diff.length) return branches(d).every((b) => c.locked.some((p) => is(p.name) && allows(b, p.version) === true));
  return branches(d).every((b) => diff.some((x) => allows(b, x.to) !== false));
}

/** Why a changed manifest is not seen, or undefined when only its dependency versions changed and a read lockfile covers its folder. */
async function manifestUnseen(a: GateArgs, pr: Pull, path: string, covers: Map<string, Cover[]>): Promise<string | undefined> {
  const file = path.split("/").pop() ?? "";
  const m = MANIFESTS[file]!;
  const locks = covers.get(`${m.eco}:${dirOf(path)}`);
  if (!locks?.length) return "changed, and no lockfile oupdate read covers its folder";
  const [baseText, headText] = await Promise.all([a.forge.readFile(a.repo, pr.baseSha, path), a.forge.readFile(a.repo, pr.headSha, path)]);
  if (baseText === undefined || headText === undefined) return baseText === undefined ? "added" : "deleted";
  let base: unknown, head: unknown;
  try {
    [base, head] = [m.parse(baseText), m.parse(headText)];
  } catch (e) {
    return `cannot parse it: ${e instanceof Error ? e.message : String(e)}`;
  }
  // Each changed dependency must come from the registry and be what every covering lockfile now records: the
  // install resolves the manifest, so a spec the lockfile does not reflect is a change no lockfile diff shows.
  const before = depSpecs(file, base);
  const sources = new Set(arr(rec(rec(rec(base).tool).poetry).source).map((s) => rec(s).name).filter((n): n is string => typeof n === "string").map((n) => n.toLowerCase()));
  const changed = [...depSpecs(file, head)].filter(([id, d]) => !Bun.deepEquals(before.get(id)?.spec, d.spec)).map(([, d]) => d);
  for (const d of changed) {
    const what = `${d.field} ${d.name} ${JSON.stringify(d.spec)}`.slice(0, 200);
    if (!registrySpec(d, sources)) return `changes ${what}, not a registry version`;
    // An alias's root record names only the alias: the diff must show the package it installs.
    const alias = d.kind === "npm" && !!npmAlias(d.spec);
    for (const c of locks) {
      if (!c.changed) return `changes ${what}, and ${c.path} does not change`;
      const root = rootMatches(c, file, d);
      if (root === false) return `changes ${what}, and ${c.path} does not record it`;
      // With no root record to compare, any text change would do: each such lockfile's own diff must bring in this
      // dependency at a version the spec allows, never another lockfile's. Poetry's `python` is the interpreter, no package.
      if ((alias || root === undefined) && !(d.kind === "poetry" && d.name === "python") && !lockShows(c, d)) return `changes ${what}, and ${c.path} does not show that change`;
    }
  }
  for (const d of m.deps) [base, head].forEach((o) => drop(o, d));
  if (Bun.deepEquals(base, head)) return undefined;
  const fields = [...new Set([...Object.keys(rec(base)), ...Object.keys(rec(head))])].filter((k) => !Bun.deepEquals(rec(base)[k], rec(head)[k]));
  return `changes ${fields.join(", ") || "its contents"}, not only dependency versions`;
}

/**
 * The files a PR changes that the gate did not read, with why: a person has to look at them. Only a lockfile the
 * gate read, or a manifest whose dependency versions alone changed in a folder a read lockfile covers, counts as
 * seen; anything else (a file of another ecosystem, a config or CI file, a version pin in a file no one listed) is
 * not, whatever its name.
 */
async function unseen(a: GateArgs, pr: Pull, changed: string[], found: string[], covers: Map<string, Cover[]>): Promise<{ path: string; why: string }[]> {
  const out: { path: string; why: string }[] = [];
  for (const path of new Set(changed)) {
    if (found.includes(path)) continue;
    const why = MANIFESTS[path.split("/").pop() ?? ""] ? await manifestUnseen(a, pr, path, covers) : "changed, oupdate cannot read it";
    if (why) out.push({ path, why });
  }
  return out;
}

/**
 * The changes a PR's head brings in across the lockfiles, each version once; `found` names the lockfiles the head
 * has, `deleted` the ones the base has and the head does not.
 */
async function lockChanges(a: GateArgs, pr: Pull, paths: string[]): Promise<{ found: string[]; deleted: string[]; changes: Change[]; covers: Map<string, Cover[]> }> {
  const found: string[] = [];
  const covers = new Map<string, Cover[]>();
  const deleted: string[] = [];
  const changes: Change[] = [];
  const seen = new Set<string>();
  for (const path of paths) {
    const [baseText, headText] = await Promise.all([a.forge.readFile(a.repo, pr.baseSha, path), a.forge.readFile(a.repo, pr.headSha, path)]);
    if (headText === undefined) {
      if (baseText !== undefined) deleted.push(path);
      continue;
    }
    found.push(path);
    const parse = (text: string) => {
      try {
        return parseLock(path, text);
      } catch (e) {
        throw new Error(`cannot read ${path}: ${e instanceof Error ? e.message : String(e)}`);
      }
    };
    const head = parse(headText);
    const base = baseText === undefined ? [] : parse(baseText).pkgs;
    const diff = diffLocks(base, head.pkgs);
    // The lockfile's folder and its workspace members, as `eco:dir`: a manifest there is the lockfile's to show.
    for (const m of ["", ...head.members]) {
      const key = `${head.eco}:${posix.normalize(posix.join(dirOf(path), m)).replace(/^\.$|\/$/g, "")}`;
      const list = covers.get(key) ?? [];
      if (!list.some((c) => c.path === path)) list.push({ path, member: m, text: headText, changed: baseText !== headText, diff, locked: head.pkgs });
      covers.set(key, list);
    }
    for (const c of diff) {
      // A version is one review only when every lockfile has it from the same place: a copy from git, another
      // registry, other bytes or a swapped source is kept, so its restriction is never lost to a public twin.
      const key = JSON.stringify([head.eco, c.name, c.from, c.to, c.toIntegrity, c.toArtifacts, c.registry, c.unhashed, c.direct, c.direct && c.source, c.swapped]);
      if (seen.has(key)) continue;
      seen.add(key);
      changes.push({ ...c, eco: head.eco });
    }
  }
  return { found, deleted, changes, covers };
}

export async function runGate(a: GateArgs): Promise<GatePull[]> {
  const prefixes = a.branchPrefixes?.length ? a.branchPrefixes : ["renovate/"];
  const bots = a.botLogins?.length ? a.botLogins : BOT_LOGINS;
  const self = await a.forge.self();
  const paths = a.lockPaths?.length ? a.lockPaths : LOCK_NAMES;
  const context = a.context ?? "oupdate/review";
  const out: GatePull[] = [];
  for (const pr of await a.forge.openPulls(a.repo)) {
    const why = notGated(pr, a.repo, bots, prefixes);
    if (why) {
      a.log?.(`PR #${pr.number} skipped: ${why}`);
      continue;
    }
    try {
      out.push(await gatePull(a, pr, self, paths, context));
    } catch (e) {
      // One PR's forge error holds that PR, never the run: the others are still gated. The status is best effort.
      const why = `gate error: ${e instanceof Error ? e.message : String(e)}`;
      await a.forge.setStatus(a.repo, pr.headSha, { state: "pending", context, description: why.slice(0, 200) }).catch(() => {});
      out.push({ number: pr.number, state: "pending", results: [] });
    }
  }
  return out;
}

async function gatePull(a: GateArgs, pr: Pull, self: string, paths: string[], context: string): Promise<GatePull> {
  // A final verdict is kept only when this gate's own token posted it and its own comment binds that verdict to
  // this head: anyone can post a status with our context, and a token shared with other workflows (the Actions
  // GITHUB_TOKEN) can post one as us.
  const prior = await a.forge.statusOf(a.repo, pr.headSha, context);
  if (prior && (prior.state === "success" || prior.state === "failure") && same(prior.creator, self)) {
    const own = await a.forge.ownComment(a.repo, pr.number, MARKER);
    if (own?.split("\n").includes(verdictLine(pr.headSha, prior.state))) return { number: pr.number, state: "skipped", results: [] };
  }
  let found: string[], deleted: string[], changes: Change[], covers: Map<string, Cover[]>;
  try {
    ({ found, deleted, changes, covers } = await lockChanges(a, pr, paths));
  } catch (e) {
    // A lockfile that does not parse is never read as "no changes": hold the PR and say why.
    const why = e instanceof Error ? e.message : String(e);
    await a.forge.setStatus(a.repo, pr.headSha, { state: "pending", context, description: why.slice(0, 200) });
    await a.forge.upsertComment(a.repo, pr.number, MARKER, [MARKER, `**oupdate: pending** (${paths.join(", ")})`, "", inert(why.replace(/\s+/g, " "))].join("\n"));
    return { number: pr.number, state: "pending", results: [] };
  }
  const locks = found.join(", ");
  // What the gate cannot see is never a pass: a deleted lockfile, or any changed file it does not read.
  const hidden = await unseen(a, pr, await a.forge.changedFiles(a.repo, pr.number), found, covers);
  if (deleted.length || hidden.length) {
    const blind = [...deleted.map((p) => `${p}: deleted`), ...hidden.map((h) => `${h.path}: ${h.why}`)];
    const description = `cannot see dependency changes: ${[...deleted.map((p) => `${p} deleted`), ...hidden.map((h) => h.path)].join(", ")}`;
    await a.forge.setStatus(a.repo, pr.headSha, { state: "failure", context, description: description.slice(0, 200) });
    await a.forge.upsertComment(a.repo, pr.number, MARKER, [MARKER, verdictLine(pr.headSha, "failure"), `**oupdate: failure** (${locks || "no lockfile read"})`, "", "A person reviews these dependency changes; oupdate cannot:", ...blind.map((b) => `- ${b}`)].join("\n"));
    return { number: pr.number, state: "failure", results: [] };
  }
  if (!changes.length) {
    const description = found.length ? `no package changes in ${locks}` : "no dependency files changed";
    await a.forge.setStatus(a.repo, pr.headSha, { state: "success", context, description });
    await a.forge.upsertComment(a.repo, pr.number, MARKER, [MARKER, verdictLine(pr.headSha, "success"), `**oupdate: success** (${locks || "no lockfile read"})`, "", description].join("\n"));
    return { number: pr.number, state: "success", results: [] };
  }
  // A git, url or file source has no registry release to review; the same version with another source or hash
  // would pass a registry review of name@version without the swap being seen. Both fail for a person.
  const malformed = new Map(changes.flatMap((c) => { const w = malformedIdent(c); return w ? [[c, w] as const] : []; }));
  const unreviewable = changes.filter((c) => malformed.has(c) || c.direct || c.unhashed || c.swapped);
  const results: ReviewResult[] = unreviewable.map((c) =>
    malformed.has(c)
      ? heldUnreviewable(c, malformed.get(c)!)
      : c.direct
      ? heldUnreviewable(c, `not from a registry (${c.direct} ${shown(c.source ?? "?")})`)
      : c.unhashed
        ? heldUnreviewable(c, "the lockfile records neither where it is fetched from nor a hash, so what the install checks is unknown")
        : heldUnreviewable(c, `same version, but the lockfile changed where it comes from or its hash (${shown(c.swapped!.from) || "none"} -> ${shown(c.swapped!.to) || "none"})`),
  );
  const policy = a.privateRegistry ?? PRIVATE_REGISTRY_DEFAULT;
  const priv = policy === "review" ? [] : changes.filter((c) => c.registry && !unreviewable.includes(c));
  const unreviewed = policy === "list" ? priv : [];
  if (policy === "hold") results.push(...priv.map(heldPrivate));
  const toReview = changes.filter((c) => !priv.includes(c) && !unreviewable.includes(c));
  if (toReview.length) await a.forge.setStatus(a.repo, pr.headSha, { state: "pending", context, description: `reviewing ${toReview.length} package change${toReview.length === 1 ? "" : "s"}` });
  for (const c of toReview) results.push(await a.review(c).catch((e) => errored(c, e)));
  const state = gateState(results);
  const land = results.filter((r) => r.decision === "land").length;
  const skipped = unreviewed.length ? `, ${unreviewed.length} not reviewed (private registry)` : "";
  await a.forge.setStatus(a.repo, pr.headSha, { state, context, description: `${results.length} package${results.length === 1 ? "" : "s"}: ${land} land, ${results.length - land} hold${skipped}` });
  if (state !== "pending" || priv.length || results.some((r) => r.layers.some((l) => l.verdict === "stop"))) await a.forge.upsertComment(a.repo, pr.number, MARKER, comment(pr.headSha, locks, state, results, unreviewed));
  return { number: pr.number, state, results };
}
