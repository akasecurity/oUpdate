// Upstream taps (apply.upstreamTaps): the tap IS the project's source repo, so a release diff is
// hundreds of source files. The review reads only the supply-chain surface of that diff: what brew
// or a build would run or fetch (install and build scripts, formula, manifests, lockfiles, CI and
// release workflows, packaging, new executables) and any binary. Plain source files are counted,
// not read. Deterministic findings on the surface FLAG before any reviewer call.

export type Git = (dir: string, args: string[]) => Promise<{ rc: number; out: string }>;

const MANIFEST = /^(setup\.py|setup\.cfg|pyproject\.toml|MANIFEST\.in|Pipfile(\.lock)?|requirements[^/]*\.txt|package(-lock)?\.json|bun\.lockb?|yarn\.lock|pnpm-lock\.yaml|uv\.lock|poetry\.lock|Cargo\.(toml|lock)|build\.rs|Package\.(swift|resolved)|Gemfile(\.lock)?|go\.(mod|sum)|CMakeLists\.txt|GNUmakefile|[Mm]akefile|Dockerfile[^/]*|install[^/]*)$/;
const DIRS = /^(Formula|HomebrewFormula|Casks|\.github|\.circleci|packaging|scripts?|bin|ci)\//;
const EXT = /\.(sh|bash|zsh|lock|cmake|plist|rb|podspec|gemspec|pbxproj|xcconfig|entitlements|mk)$/;
const BENIGN_BINARY = /\.(png|jpe?g|gif|ico|icns|webp|pdf|ttf|otf|woff2?)$/i;

/** Files brew or a build may run, fetch or resolve dependencies from. */
export function isSurfaceFile(path: string): boolean {
  return DIRS.test(path) || EXT.test(path) || MANIFEST.test(path.slice(path.lastIndexOf("/") + 1));
}

const FETCH_EXEC: [RegExp, string][] = [
  [/\b(curl|wget|fetch)\b[^\n]*\|\s*(sudo\s+)?(ba|z|da)?sh\b/, "fetch piped into a shell"],
  [/\b(ba|z|da)?sh\s+-c\s+["']?\$\(\s*(curl|wget)/, "shell run on fetched code"],
  [/base64\s+(-d|-D|--decode)|\bb64decode\b|marshal\.loads|zlib\.decompress/, "encoded payload decoded at run time"],
];
const NET_FETCH: [RegExp, string][] = [
  [/(^|[\s;&|(`"'])(curl|wget)\s/, "network fetch (curl/wget)"],
  [/\b(urllib|urlopen|requests\.(get|post|put)|httpx\.|http\.client|create_connection)\b|\/dev\/tcp\/|\bgit\s+clone\b/, "network access from a build step"],
];
const DEP_SOURCE: [RegExp, string][] = [
  [/git\+|@\s*(https?|git|file):|--(extra-)?index-url|--trusted-host|--find-links|\bdependency_links\b/, "dependency from a url, vcs or another index"],
  [/^\+\s*"(?!homepage"|url"|repository"|bugs"|funding"|author)[^"]+"\s*:\s*"(https?:|git\+|git:|github:|file:)/, "dependency from a url or vcs"],
  [/^\+\s*"(preinstall|postinstall|install|prepare)"\s*:/, "package install hook"],
  [/^\+\s*\w[\w-]*\s*=\s*\{[^}]*\b(git|path)\s*=/, "dependency from a git or path source"],
];
const isManifest = (p: string) => /(^|\/)(requirements[^/]*\.txt|pyproject\.toml|setup\.(py|cfg)|package\.json|Cargo\.toml|Pipfile|Gemfile|go\.mod|Package\.swift)$/.test(p);

/** One finding per file: the first suspicious thing added to it. Removed lines never count. */
export function scanSurface(files: { path: string; diff: string }[]): string[] {
  const out: string[] = [];
  for (const f of files) {
    const added = f.diff.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++"));
    const rules = [...FETCH_EXEC, ...(f.path.startsWith(".github/") ? [] : NET_FETCH), ...(isManifest(f.path) ? DEP_SOURCE : [])];
    for (const [re, why] of rules) {
      const hit = added.find((l) => re.test(l));
      if (hit) {
        out.push(`${f.path}: ${why} (${hit.slice(0, 120).trim()})`);
        break;
      }
    }
  }
  return out;
}

export interface Surface {
  files: { path: string; diff: string }[];
  /** Deterministic findings: each one FLAGs. */
  findings: string[];
  /** Changed files outside the surface, counted and not read. */
  otherCount: number;
}

export type SurfaceResult = { ok: true; surface: Surface } | { ok: false; why: string };

/** The surface of the diff oldRev..head in the tap checkout. */
export async function gatherSurface(git: Git, dir: string, oldRev: string, head: string): Promise<SurfaceResult> {
  const range = `${oldRev}..${head}`;
  const base = ["-c", "core.quotepath=false", "diff", "--no-renames"];
  const raw = await git(dir, [...base, "--raw", range]);
  const num = await git(dir, [...base, "--numstat", range]);
  if (raw.rc !== 0 || num.rc !== 0) return { ok: false, why: "git could not list the release diff" };
  const modes = new Map<string, { from: string; to: string }>();
  for (const l of raw.out.split("\n")) {
    const m = l.match(/^:(\d+) (\d+) \S+ \S+ \S+\t(.+)$/);
    if (m) modes.set(m[3]!, { from: m[1]!, to: m[2]! });
  }
  const binary = new Set<string>();
  for (const l of num.out.split("\n")) {
    const m = l.match(/^-\t-\t(.+)$/);
    if (m) binary.add(m[1]!);
  }
  const findings: string[] = [];
  const read: string[] = [];
  let otherCount = 0;
  for (const [path, m] of modes) {
    const execNew = m.to === "100755" && m.from !== "100755";
    const link = m.to === "120000" && m.from !== "120000";
    if (binary.has(path) && !BENIGN_BINARY.test(path)) findings.push(`${path}: binary file added or changed`);
    if (isSurfaceFile(path) || execNew || link) read.push(path);
    else otherCount++;
  }
  const files: { path: string; diff: string }[] = [];
  for (const path of read.sort()) {
    const d = await git(dir, [...base, "-U0", range, "--", path]);
    if (d.rc !== 0) return { ok: false, why: `git could not read the diff of ${path}` };
    const body = d.out.slice(d.out.search(/^@@|^Binary files|^new file|^deleted file/m) >= 0 ? d.out.search(/^@@|^Binary files|^new file|^deleted file/m) : 0);
    files.push({ path, diff: body });
  }
  findings.push(...scanSurface(files));
  return { ok: true, surface: { files, findings, otherCount } };
}
