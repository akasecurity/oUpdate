// Deterministic pre-pass over two unpacked release artifacts (old, new).
// Hard signals hold an update no matter what a model reviewer says; soft
// signals are handed to the reviewer as pointers. It reads bytes only.

export type FileMap = Map<string, Uint8Array>;
export type Ecosystem = "npm" | "pypi";

export interface Signal {
  kind: string;
  path: string;
  detail: string;
}

export interface PrepassResult {
  hard: Signal[];
  soft: Signal[];
  added: string[];
  removed: string[];
  changed: string[];
}

const NPM_INSTALL_SCRIPTS = ["preinstall", "install", "postinstall", "prepare"];

const SOFT_PATTERNS: { kind: string; re: RegExp }[] = [
  { kind: "encoded-blob", re: /[A-Za-z0-9+/=_-]{400,}/ },
  { kind: "dynamic-exec", re: /\b(exec|eval)\s*\(\s*(base64|codecs|zlib|marshal|atob|Buffer\.from|bytes\.fromhex|__import__)/ },
  { kind: "dynamic-exec", re: /\bnew\s+Function\s*\(/ },
  { kind: "credential-path", re: /\.aws\/credentials|\.ssh\/id_|\.config\/gcloud|\.kube\/config|\.docker\/config\.json|\.npmrc|\.pypirc|\.netrc|\.git-credentials|Login Data|Cookies\.binarycookies/ },
  { kind: "credential-env", re: /(ANTHROPIC|OPENAI|AWS_SECRET|GITHUB|GH|NPM|PYPI)_[A-Z_]*(KEY|TOKEN|SECRET)/ },
  { kind: "metadata-endpoint", re: /169\.254\.169\.254|metadata\.google\.internal/ },
  { kind: "process-spawn", re: /\b(subprocess\.(Popen|run|call)|os\.system|child_process|execSync|spawnSync)\b/ },
];

const dec = new TextDecoder("utf-8", { fatal: false });

function basename(p: string): string {
  const i = p.lastIndexOf("/");
  return i < 0 ? p : p.slice(i + 1);
}

function isPythonStartupHook(path: string): boolean {
  const b = basename(path);
  return b.endsWith(".pth") || b === "sitecustomize.py" || b === "usercustomize.py";
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function addedLines(oldText: string | undefined, newText: string): string[] {
  const before = new Set((oldText ?? "").split("\n"));
  return newText.split("\n").filter((l) => !before.has(l));
}

function npmInstallScripts(bytes: Uint8Array | undefined): Record<string, string> {
  if (!bytes) return {};
  try {
    const scripts = (JSON.parse(dec.decode(bytes)) as { scripts?: Record<string, unknown> }).scripts ?? {};
    const out: Record<string, string> = {};
    for (const k of NPM_INSTALL_SCRIPTS) if (typeof scripts[k] === "string") out[k] = scripts[k] as string;
    return out;
  } catch {
    return { "<unparseable>": "package.json did not parse" };
  }
}

const BUILD_INCLUDE_RE = /^\s*(data|data-files|data_files|include|force-include|shared-data|package-data|package_data)\s*=/;

export function prepass(eco: Ecosystem, oldFiles: FileMap, newFiles: FileMap): PrepassResult {
  const hard: Signal[] = [];
  const soft: Signal[] = [];
  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];

  for (const p of oldFiles.keys()) if (!newFiles.has(p)) removed.push(p);
  for (const [p, bytes] of newFiles) {
    const prev = oldFiles.get(p);
    if (!prev) added.push(p);
    else if (!bytesEqual(prev, bytes)) changed.push(p);
  }

  if (eco === "pypi") {
    for (const p of added) {
      if (isPythonStartupHook(p)) hard.push({ kind: "startup-hook", path: p, detail: "new interpreter startup hook (.pth / sitecustomize / usercustomize)" });
    }
    for (const p of changed) {
      if (isPythonStartupHook(p)) soft.push({ kind: "startup-hook-changed", path: p, detail: "existing startup hook changed" });
    }
    for (const p of [...added, ...changed]) {
      const b = basename(p);
      if (b !== "pyproject.toml" && b !== "setup.cfg" && b !== "setup.py" && b !== "MANIFEST.in") continue;
      const lines = addedLines(oldFiles.has(p) ? dec.decode(oldFiles.get(p)!) : undefined, dec.decode(newFiles.get(p)!));
      for (const l of lines) {
        if (BUILD_INCLUDE_RE.test(l)) hard.push({ kind: "build-include", path: p, detail: `new build include: ${l.trim().slice(0, 200)}` });
      }
    }
  }

  if (eco === "npm") {
    const pj = [...newFiles.keys()].filter((p) => p.split("/").length <= 2 && basename(p) === "package.json");
    for (const p of pj) {
      const before = npmInstallScripts(oldFiles.get(p));
      const after = npmInstallScripts(newFiles.get(p));
      for (const [k, v] of Object.entries(after)) {
        if (before[k] !== v) hard.push({ kind: "install-script", path: p, detail: `${k}: ${v.slice(0, 200)}` });
      }
    }
  }

  for (const p of [...added, ...changed]) {
    const bytes = newFiles.get(p)!;
    if (bytes.length > 5_000_000) {
      soft.push({ kind: "large-file", path: p, detail: `${bytes.length} bytes, not scanned` });
      continue;
    }
    const lines = addedLines(oldFiles.has(p) ? dec.decode(oldFiles.get(p)!) : undefined, dec.decode(bytes));
    const seen = new Set<string>();
    for (const l of lines) {
      for (const { kind, re } of SOFT_PATTERNS) {
        if (seen.has(kind) || !re.test(l)) continue;
        seen.add(kind);
        soft.push({ kind, path: p, detail: l.trim().slice(0, 160) });
      }
    }
  }

  return { hard, soft, added, removed, changed };
}
