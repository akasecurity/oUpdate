// Deterministic checks on a third-party tap's formula, ported from secure-update. They run
// before any reviewer call: each one that fails is a FLAG that names the reason.

/**
 * Top-level download urls of a formula: every `url "…"` / `url('…')` line outside resource,
 * patch, head and livecheck blocks (on_macos / on_arm blocks count: per-architecture formulae
 * declare their urls there).
 */
export function formulaUrls(text: string): string[] {
  const opens = (l: string) => /(^|\s)do(\s*\|[^|]*\|)?\s*$/.test(l);
  const out: string[] = [];
  let skip = 0;
  for (const l of text.split("\n")) {
    if (skip > 0) {
      if (opens(l)) skip++;
      else if (/^\s*end(\s|$)/.test(l)) skip--;
      continue;
    }
    if (/^\s*(resource|patch|head|livecheck)([\s(]|$)/.test(l) && opens(l)) {
      skip = 1;
      continue;
    }
    const m = l.match(/^\s*url[\s(]+["']([^"']*)["']/);
    if (m?.[1]) out.push(m[1]);
  }
  return out;
}

/** Where a url's bytes come from: github.com/<owner>/<repo> for GitHub, else <host>/<first path segment>. */
export function urlOrigin(url: string): string {
  let u = url.includes("://") ? url.slice(url.indexOf("://") + 3) : url;
  u = u.split("?")[0]!;
  const slash = u.indexOf("/");
  const host = (slash < 0 ? u : u.slice(0, slash)).toLowerCase();
  const path = slash < 0 ? "" : u.slice(slash + 1);
  if (host === "github.com" || host === "www.github.com" || host === "codeload.github.com") {
    // As the bash's parameter expansion: with no second segment, the owner doubles as the repo.
    const owner = path.split("/")[0]!;
    const rest = path.includes("/") ? path.slice(path.indexOf("/") + 1) : path;
    const repo = rest.split("/")[0]!;
    return `github.com/${owner}/${repo.replace(/\.git$/, "")}`.toLowerCase();
  }
  return `${host}/${path.split("/")[0]}`;
}

/** Dependency names written in a formula: depends_on and uses_from_macos, either quote style, optional parentheses. */
export function formulaDeps(text: string): string[] {
  const out = new Set<string>();
  for (const l of text.split("\n")) {
    const m = l.match(/^\s*(depends_on|uses_from_macos)[\s(]+["']([^"']+)["']/);
    if (m) out.add(m[2]!);
  }
  return [...out].sort();
}

/** prebuilt or source for a formula url; anything unknown is source (and so also needs the source review). */
export function artifactKind(url: string): "prebuilt" | "source" {
  if (url.includes("/releases/download/")) return "prebuilt";
  if (/(\.tar\.gz|\.tar\.xz|\.tgz|\.git)$/.test(url) || url.includes("/archive/")) return "source";
  if (/(\.zip|\.dmg|\.pkg)$/.test(url) || url.includes(".bottle")) return "prebuilt";
  return "source";
}

/** Changed tap files brew may load or run: anything but formulae, casks and docs. */
export function supportFilesChanged(changed: string[]): string[] {
  return changed.filter(
    (f) =>
      f !== "" &&
      !/^(Formula|HomebrewFormula|Casks)\//.test(f) &&
      !f.startsWith(".github/") &&
      !f.endsWith(".md") &&
      !(/(^|\/)LICENSE[^/]*$/.test(f) && !f.endsWith(".rb")),
  );
}

/** A formula that reads other files makes every changed tap file part of it. */
export function loadsOtherFiles(text: string): boolean {
  return /(^|[^A-Za-z0-9_])(require_relative|require|load)[\s(]|(^|[^A-Za-z0-9])eval[\s(]|(instance|class|module)_eval|send\s*\(?\s*:(require_relative|require|load)|__dir__|__FILE__|(IO|File)\.(read|binread|open|readlines|foreach)|Pathname/m.test(
    text,
  );
}
