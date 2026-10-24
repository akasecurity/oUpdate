// A real git tap per test case, with brew faked through FormulaEnv. The package is
// example/tool/tool (the source fixtures' own tap, renamed).
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrewFormulaInfo } from "../../src/apply/formula.ts";
import type { TypeBEnv } from "../../src/apply/typeb.ts";

export const TAP = "example/tool";
export const PREBUILT = (v: string) => `https://github.com/example/tool/releases/download/v${v}/tool-darwin-arm64.tar.gz`;
export const SOURCE = (v: string) => `https://github.com/example/tool/archive/refs/tags/v${v}.tar.gz`;
export const APPROVE = "APPROVE\nno attack indicators found";
export const OFFICIAL = ["homebrew/core", "homebrew/cask"];
const root = mkdtempSync(join(tmpdir(), "oupdate-tap-"));
/** Call from afterAll in each test file that builds fixtures. */
export const cleanupFixtures = () => rmSync(root, { recursive: true, force: true });

export const rb = (url: string, version: string, extra = "") => `class Tool < Formula
  desc "tool"
  url "${url}"
  version "${version}"
  sha256 "${version === "1.0" ? "a".repeat(64) : "b".repeat(64)}"
${extra}
  def install
    bin.install "tool"
  end

  def post_install
    (var/"tool").mkpath
  end
end
`;

export function git(dir: string, ...args: string[]) {
  const p = Bun.spawnSync(["git", "-C", dir, ...args], { env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.test", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.test" } });
  return { rc: p.exitCode ?? 1, out: p.stdout.toString() };
}

export const OTHER: Record<string, BrewFormulaInfo> = {
  "openssl@3": { tap: "homebrew/core", full_name: "openssl@3" },
  xz: { tap: "homebrew/core", full_name: "xz" },
  "homebrew/core/xz": { tap: "homebrew/core", full_name: "xz" },
  "evil/tap/x": { tap: "evil/tap", full_name: "evil/tap/x" },
  helper: { tap: TAP, full_name: "example/tool/helper" },
  "example/tool/helper": { tap: TAP, full_name: "example/tool/helper" },
  toolx: { tap: TAP, full_name: "example/tool/toolx" },
  helper2: { tap: "other/tap", full_name: "other/tap/helper2" },
  "example/tool/openssl@3": { tap: TAP, full_name: "example/tool/openssl@3" },
};

export interface Fx {
  oldUrl?: string;
  newUrl?: string;
  oldExtra?: string;
  newExtra?: string;
  /** Extra changes committed with the new formula. */
  after?: (tap: string) => void;
  receipt?: "rev" | "none" | "unknown" | "head";
  runtimeDeps?: string[];
  infoDeps?: string[];
  rbPath?: string;
  artifact?: "prebuilt" | "source";
  /** `brew list --versions` output for the package (default "tool 1.0"). */
  installed?: string;
  /** `brew deps --installed --full-name` output, or an Error for a failed call. */
  deps?: string | Error;
  /** `brew outdated --quiet --formula <name>`: printed text, or an Error for a failed call. */
  outdated?: Record<string, string | Error>;
}

let n = 0;
export function fixture(f: Fx = {}) {
  const dir = join(root, `case-${++n}`);
  const tap = join(dir, "tap");
  mkdirSync(join(tap, "Formula"), { recursive: true });
  git(tap, "init", "-q");
  writeFileSync(join(tap, "Formula/tool.rb"), rb(f.oldUrl ?? PREBUILT("1.0"), "1.0", f.oldExtra));
  writeFileSync(join(tap, "Formula/helper.rb"), "class Helper < Formula\nend\n");
  git(tap, "add", "-A");
  git(tap, "commit", "-qm", "old");
  const oldRev = git(tap, "rev-parse", "HEAD").out.trim();
  writeFileSync(join(tap, "Formula/tool.rb"), rb(f.newUrl ?? PREBUILT("1.1"), "1.1", f.newExtra));
  f.after?.(tap);
  git(tap, "add", "-A");
  git(tap, "commit", "-qm", "new");
  const head = git(tap, "rev-parse", "HEAD").out.trim();
  const cellar = join(dir, "Cellar/tool");
  mkdirSync(join(cellar, "1.0"), { recursive: true });
  const rev = f.receipt === "none" ? undefined : f.receipt === "unknown" ? "deadbeef".repeat(5) : f.receipt === "head" ? head : oldRev;
  if (rev !== undefined) {
    const receipt: Record<string, unknown> = { source: { tap_git_head: rev } };
    if (f.runtimeDeps) receipt.runtime_dependencies = f.runtimeDeps.map((full_name) => ({ full_name }));
    writeFileSync(join(cellar, "1.0/INSTALL_RECEIPT.json"), JSON.stringify(receipt));
  }
  const env: TypeBEnv = {
    brewInfo: async (name) =>
      name === `${TAP}/tool`
        ? { ruby_source_path: f.rbPath ?? "Formula/tool.rb", dependencies: f.infoDeps ?? [], versions: { stable: "1.1" }, urls: { stable: { url: f.newUrl ?? PREBUILT("1.1") } } }
        : OTHER[name],
    brew: async (args) => {
      const a = args.join(" ");
      if (a === `--repository ${TAP}`) return { rc: 0, out: `${tap}\n` };
      if (a === `list --versions ${TAP}/tool`) return f.installed === "" ? { rc: 1, out: "" } : { rc: 0, out: `${f.installed ?? "tool 1.0"}\n` };
      if (a === `deps --installed --full-name ${TAP}/tool`) return f.deps instanceof Error ? { rc: 1, out: "" } : { rc: 0, out: f.deps ?? "" };
      const m = a.match(/^outdated --quiet --formula (\S+)$/);
      if (m) {
        const v = f.outdated?.[m[1]!];
        return v instanceof Error ? { rc: 1, out: "" } : v ? { rc: 1, out: v } : { rc: 0, out: "" };
      }
      return { rc: 1, out: "" };
    },
    cellar: async () => cellar,
    readFile: async (p) => {
      const file = Bun.file(p);
      return (await file.exists()) ? file.text() : undefined;
    },
    git: async (d, args) => git(d, ...args),
  };
  return { env, tap, head, oldRev };
}
