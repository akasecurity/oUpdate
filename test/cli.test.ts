import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseReviewArgs, parseGateArgs, parseImageArgs, gateToken, gateForge, loadArtifacts, lockedFilesCheck, type ReviewArgs } from "../src/cli.ts";
import { pypiRegistry } from "../src/adapters/ecosystem/pypi.ts";
import { prepass } from "../src/prepass.ts";

describe("parseReviewArgs", () => {
  test("positional eco name from to, with defaults", () => {
    const a = parseReviewArgs(["pypi", "litellm", "1.106.2", "1.107.0"]);
    expect(a).toMatchObject({ eco: "pypi", name: "litellm", from: "1.106.2", to: "1.107.0", cooldownDays: 2 });
    expect(a.only).toBeUndefined();
  });

  test("replay flags", () => {
    const a = parseReviewArgs([
      "pypi", "litellm", "1.106.2", "1.107.0",
      "--old-artifact", "o.whl", "--new-artifact", "n.whl",
      "--published", "2026-10-21T11:39:00Z", "--now", "2026-10-21T13:20:00Z",
      "--only", "cooldown,prepass", "--reviewer", '{"type":"command","name":"rev","argv":["rev","-p"]}', "--json", "out.json", "--cooldown-days", "3",
    ]);
    expect(a).toMatchObject({
      oldArtifact: "o.whl",
      newArtifact: "n.whl",
      only: ["cooldown", "prepass"],
      reviewer: { type: "command", name: "rev", argv: ["rev", "-p"] },
      json: "out.json",
      cooldownDays: 3,
    });
    expect(a.published?.toISOString()).toBe("2026-10-21T11:39:00.000Z");
    expect(a.now.toISOString()).toBe("2026-10-21T13:20:00.000Z");
  });

  test("rejects an unknown ecosystem, layer or flag", () => {
    expect(() => parseReviewArgs(["gem", "x", "1", "2"])).toThrow(/ecosystem/);
    expect(() => parseReviewArgs(["npm", "x", "1", "2", "--only", "vibes"])).toThrow(/layer/);
    expect(() => parseReviewArgs(["npm", "x", "1", "2", "--bogus"])).toThrow(/unknown flag/);
  });

  test("one artifact without the other is refused", () => {
    expect(() => parseReviewArgs(["npm", "x", "1", "2", "--old-artifact", "a"])).toThrow(/both/);
  });

  test("a reviewer spec must be JSON with a known type", () => {
    expect(() => parseReviewArgs(["npm", "x", "1", "2", "--reviewer", "rev -p"])).toThrow(/JSON/);
    expect(() => parseReviewArgs(["npm", "x", "1", "2", "--reviewer", '{"type":"psychic"}'])).toThrow(/type/);
    expect(() => parseReviewArgs(["npm", "x", "1", "2", "--reviewer", '{"type":"openai","name":"l"}'])).toThrow(/baseUrls|model/);
  });
});

describe("parseGateArgs", () => {
  test("needs endpoint, repo and token file; defaults the rest", () => {
    const a = parseGateArgs(["--endpoint", "https://forge.test/api/v1", "--repo", "o/r", "--token-file", "tok"]);
    expect(a).toMatchObject({ forge: "gitea", endpoint: "https://forge.test/api/v1", repo: "o/r", tokenFile: "tok", branchPrefixes: ["renovate/"], lockPaths: [], cooldownDays: 2 });
    expect(a.reviewer).toBeUndefined();
  });

  test("takes a reviewer, prefix, lock path and cooldown", () => {
    const a = parseGateArgs(["--endpoint", "e", "--repo", "o/r", "--token-file", "t", "--reviewer", '{"type":"command","name":"x","argv":["x"]}', "--branch-prefix", "deps/", "--lock", "sub/bun.lock", "--cooldown-days", "3"]);
    expect(a).toMatchObject({ branchPrefixes: ["deps/"], lockPaths: ["sub/bun.lock"], cooldownDays: 3 });
    expect(a.reviewer).toBeDefined();
  });

  test("--lock repeats; a lockfile name oupdate cannot read is refused up front", () => {
    const base = ["--endpoint", "e", "--repo", "o/r", "--token-file", "t"];
    expect(parseGateArgs([...base, "--lock", "bun.lock", "--lock", "web/bun.lock"]).lockPaths).toEqual(["bun.lock", "web/bun.lock"]);
    expect(() => parseGateArgs([...base, "--lock", "yarn.lock"])).toThrow(/unsupported lockfile yarn.lock/);
    expect(parseGateArgs([...base, "--lock", "uv.lock", "--lock", "api/requirements.txt"]).lockPaths).toEqual(["uv.lock", "api/requirements.txt"]);
  });

  test("--branch-prefix repeats, replacing the renovate/ default", () => {
    const base = ["--endpoint", "e", "--repo", "o/r", "--token-file", "t"];
    expect(parseGateArgs([...base, "--branch-prefix", "dependabot/", "--branch-prefix", "renovate/"]).branchPrefixes).toEqual(["dependabot/", "renovate/"]);
  });

  test("--bot-login repeats and replaces the Renovate and Dependabot app logins; --gate-login names the token's own login", () => {
    const base = ["--endpoint", "e", "--repo", "o/r", "--token-file", "t"];
    expect(parseGateArgs(base).botLogins).toEqual(["renovate[bot]", "dependabot[bot]"]);
    expect(parseGateArgs(base).gateLogin).toBeUndefined();
    const a = parseGateArgs([...base, "--bot-login", "renovate", "--bot-login", "deps-bot", "--gate-login", "github-actions[bot]"]);
    expect(a.botLogins).toEqual(["renovate", "deps-bot"]);
    expect(a.gateLogin).toBe("github-actions[bot]");
  });

  test("--private-registry defaults to hold; list is the opt-in to accept private-registry versions unreviewed", () => {
    const base = ["--endpoint", "e", "--repo", "o/r", "--token-file", "t"];
    expect(parseGateArgs(base).privateRegistry).toBe("hold");
    expect(parseGateArgs([...base, "--private-registry", "list"]).privateRegistry).toBe("list");
    expect(() => parseGateArgs([...base, "--private-registry", "yes"])).toThrow(/--private-registry must be hold, list or review/);
  });

  test("a missing required flag, a bad repo or an unknown flag is refused", () => {
    expect(() => parseGateArgs(["--repo", "o/r", "--token-file", "t"])).toThrow(/--endpoint/);
    expect(() => parseGateArgs(["--endpoint", "e", "--repo", "or", "--token-file", "t"])).toThrow(/owner\/name/);
    expect(() => parseGateArgs(["--endpoint", "e", "--repo", "o/r", "--token-file", "t", "--x"])).toThrow(/unknown flag/);
  });
});

describe("gate --forge github", () => {
  test("needs no endpoint; GITHUB_API_URL (GitHub Enterprise Server) fills it when --endpoint is absent", () => {
    expect(parseGateArgs(["--forge", "github", "--repo", "o/r", "--token-env", "GITHUB_TOKEN"], {})).toMatchObject({ forge: "github", endpoint: undefined, tokenEnv: "GITHUB_TOKEN" });
    expect(parseGateArgs(["--forge", "github", "--repo", "o/r", "--token-env", "T"], { GITHUB_API_URL: "https://ghe.example/api/v3" }).endpoint).toBe("https://ghe.example/api/v3");
    expect(parseGateArgs(["--forge", "github", "--endpoint", "https://x.example/api", "--repo", "o/r", "--token-env", "T"], { GITHUB_API_URL: "https://ghe.example/api/v3" }).endpoint).toBe("https://x.example/api");
  });

  test("gitea still needs --endpoint; an unknown forge is refused", () => {
    expect(() => parseGateArgs(["--forge", "gitea", "--repo", "o/r", "--token-env", "T"], {})).toThrow(/--endpoint/);
    expect(() => parseGateArgs(["--forge", "gitlab", "--repo", "o/r", "--token-env", "T"], {})).toThrow(/--forge must be gitea or github/);
  });

  test("the token comes from exactly one of --token-file and --token-env", () => {
    const base = ["--forge", "github", "--repo", "o/r"];
    expect(() => parseGateArgs(base, {})).toThrow(/--token-file or --token-env/);
    expect(() => parseGateArgs([...base, "--token-file", "f", "--token-env", "T"], {})).toThrow(/not both/);
  });

  test("--token-env reads the named variable; an unset or empty one names the variable, never a value", async () => {
    const g = parseGateArgs(["--forge", "github", "--repo", "o/r", "--token-env", "GH_TOK"], {});
    expect(await gateToken(g, { GH_TOK: " ghs_abc\n" })).toBe("ghs_abc");
    await expect(gateToken(g, {})).rejects.toThrow("environment variable GH_TOK is empty or unset");
    await expect(gateToken(g, { GH_TOK: "  " })).rejects.toThrow(/GH_TOK/);
  });

  test("the github forge talks to api.github.com with a bearer token; gitea to its endpoint", async () => {
    const urls: string[] = [];
    const auth: string[] = [];
    const fake = (async (u: string, i?: RequestInit) => (urls.push(String(u)), auth.push(new Headers(i?.headers).get("authorization") ?? ""), Response.json([]))) as unknown as typeof fetch;
    await gateForge(parseGateArgs(["--forge", "github", "--repo", "o/r", "--token-env", "T"], {}), "tk", fake).openPulls("o/r");
    await gateForge(parseGateArgs(["--endpoint", "https://forge.test/api/v1", "--repo", "o/r", "--token-file", "f"], {}), "tk", fake).openPulls("o/r");
    expect(urls).toEqual(["https://api.github.com/repos/o/r/pulls?state=open&per_page=100&page=1", "https://forge.test/api/v1/repos/o/r/pulls?state=open&limit=50&page=1"]);
    expect(auth).toEqual(["Bearer tk", "token tk"]);
  });
});

describe("--scanner", () => {
  const spec = '{"type":"guarddog","name":"guarddog","argv":["docker","run","{dir}"]}';
  test("review and gate both take a scanner spec", () => {
    expect(parseReviewArgs(["npm", "x", "1", "2", "--scanner", spec]).scanner?.name).toBe("guarddog");
    expect(parseGateArgs(["--endpoint", "e", "--repo", "o/r", "--token-file", "t", "--scanner", spec]).scanner?.argv).toEqual(["docker", "run", "{dir}"]);
    expect(() => parseReviewArgs(["npm", "x", "1", "2", "--scanner", "guarddog"])).toThrow(/--scanner must be JSON/);
  });
});

describe("parseImageArgs", () => {
  const D = `sha256:${"c".repeat(64)}`;
  const REV = '{"type":"command","name":"r","argv":["r"]}';
  test("two refs, linux/amd64 and Docker Hub defaults", () => {
    const a = parseImageArgs(["alpine:3.20", "alpine:3.21"]);
    expect(a.old).toMatchObject({ registry: "docker.io", repository: "library/alpine", reference: "3.20" });
    expect(a.new).toMatchObject({ registry: "docker.io", repository: "library/alpine", reference: "3.21" });
    expect(a.platform).toBe("linux/amd64");
    expect(a.layers).toBe(true);
    expect(a.reviewer).toBeUndefined();
    expect(a.secondReviewer).toBeUndefined();
  });

  test("a digest ref and every flag", () => {
    const a = parseImageArgs([
      "registry.example/team/app-a:5.14.0", `registry.example/team/app-a@${D}`,
      "--platform", "linux/arm64/v8", "--reviewer", REV, "--second-reviewer", REV, "--now", "2026-10-26T12:00:00Z", "--json", "out.json",
    ]);
    expect(a.new.reference).toBe(D);
    expect(a).toMatchObject({ platform: "linux/arm64/v8", json: "out.json", reviewer: { name: "r" }, secondReviewer: { name: "r" } });
    expect(a.now.toISOString()).toBe("2026-10-26T12:00:00.000Z");
  });

  test("--no-layers turns the layer read off, in any position", () => {
    expect(parseImageArgs(["alpine:3.20", "--no-layers", "alpine:3.21"]).layers).toBe(false);
    expect(parseImageArgs(["alpine:3.20", "alpine:3.21", "--no-layers"]).layers).toBe(false);
  });

  test("different repositories, a bad ref, platform or date, an unknown flag or a missing value is refused", () => {
    expect(() => parseImageArgs(["alpine:3.20", "debian:12"])).toThrow(/same repository/);
    expect(() => parseImageArgs(["ghcr.io/o/a:1", "docker.io/o/a:2"])).toThrow(/same repository/);
    expect(() => parseImageArgs(["alpine:3.20"])).toThrow(/usage: oupdate image/);
    expect(() => parseImageArgs(["alpine:3.20", "alpine:bad;tag"])).toThrow(/not an image tag/);
    expect(() => parseImageArgs(["alpine:3.20", "alpine@sha256:abc"])).toThrow(/not a sha256 digest/);
    expect(() => parseImageArgs(["alpine:1", "alpine:2", "--platform", "amd64"])).toThrow(/--platform must be os\/arch/);
    expect(() => parseImageArgs(["alpine:1", "alpine:2", "--now", "soon"])).toThrow(/--now: not a date/);
    expect(() => parseImageArgs(["alpine:1", "alpine:2", "--x"])).toThrow(/unknown flag --x/);
    expect(() => parseImageArgs(["alpine:1", "alpine:2", "--reviewer"])).toThrow(/--reviewer needs a value/);
  });
});

describe("loadArtifacts: pypi", () => {
  const root = mkdtempSync(join(tmpdir(), "oupdate-cli-pypi-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const pack = (file: string, files: Record<string, string>): Uint8Array => {
    const src = join(root, `${file}-src`);
    for (const [p, body] of Object.entries(files)) {
      mkdirSync(join(src, p, ".."), { recursive: true });
      writeFileSync(join(src, p), body);
    }
    const out = join(root, file);
    const args = file.endsWith(".whl") ? ["--format", "zip", "-cf", out, "-C", src, "."] : ["-czf", out, "-C", src, "."];
    const p = Bun.spawnSync(["bsdtar", ...args]);
    if (p.exitCode !== 0) throw new Error(new TextDecoder().decode(p.stderr));
    return new Uint8Array(readFileSync(out));
  };
  const sha = (b: Uint8Array) => new Bun.CryptoHasher("sha256").update(b).digest("hex");
  // A clean universal wheel listed first, and a macOS wheel that alone carries a startup hook.
  const files: Record<string, { type: string; bytes: Uint8Array }> = {
    "demo-1.0-py3-none-any.whl": { type: "bdist_wheel", bytes: pack("demo-1.0-py3-none-any.whl", { "demo/__init__.py": "v = 1\n" }) },
    "demo-1.0-cp312-cp312-macosx_11_0_arm64.whl": { type: "bdist_wheel", bytes: pack("demo-1.0-cp312-cp312-macosx_11_0_arm64.whl", { "demo/__init__.py": "v = 1\n", "demo/_c.so": "bin1" }) },
    "demo-1.0.tar.gz": { type: "sdist", bytes: pack("demo-1.0.tar.gz", { "demo-1.0/demo/__init__.py": "v = 1\n", "demo-1.0/pyproject.toml": "[project]\n" }) },
    "demo-1.1-py3-none-any.whl": { type: "bdist_wheel", bytes: pack("demo-1.1-py3-none-any.whl", { "demo/__init__.py": "v = 2\n" }) },
    "demo-1.1-cp312-cp312-macosx_11_0_arm64.whl": { type: "bdist_wheel", bytes: pack("demo-1.1-cp312-cp312-macosx_11_0_arm64.whl", { "demo/__init__.py": "v = 2\n", "demo/_c.so": "bin1", "evil.pth": "import evil\n" }) },
    "demo-1.1.tar.gz": { type: "sdist", bytes: pack("demo-1.1.tar.gz", { "demo-1.1/demo/__init__.py": "v = 2\n", "demo-1.1/pyproject.toml": "[project]\n" }) },
  };
  const release = (v: string, digest: (name: string, b: Uint8Array) => string | undefined) => ({
    urls: Object.entries(files)
      .filter(([n]) => n.startsWith(`demo-${v}`))
      .map(([n, f]) => ({ filename: n, packagetype: f.type, url: `https://files.example/${n}`, digests: { sha256: digest(n, f.bytes) }, upload_time_iso_8601: "2026-10-01T00:00:00Z" })),
  });
  const fakeFetch = (digest: (name: string, b: Uint8Array) => string | undefined, missing = new Set<string>()): typeof fetch =>
    (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "https://pypi.org/pypi/demo/1.0/json") return Response.json(release("1.0", digest));
      if (url === "https://pypi.org/pypi/demo/1.1/json") return Response.json(release("1.1", digest));
      const name = url.replace("https://files.example/", "");
      if (files[name] && !missing.has(name)) return new Response(new Blob([files[name]!.bytes as BlobPart]));
      return new Response("not found", { status: 404 });
    }) as typeof fetch;
  const args: ReviewArgs = { eco: "pypi", name: "demo", from: "1.0", to: "1.1", now: new Date(), cooldownDays: 0, advisoryFix: false };
  const load = (f: typeof fetch) => {
    const work = mkdtempSync(join(root, "work-"));
    return loadArtifacts(args, pypiRegistry({ fetch: f }), work, f);
  };

  test("every wheel and the sdist are read: a .pth only in the macOS wheel hard-stops the pre-pass", async () => {
    const r = await load(fakeFetch((_n, b) => sha(b)));
    const pth = [...r.new.keys()].filter((k) => k.endsWith("evil.pth"));
    expect(pth.length).toBe(1);
    expect(prepass("pypi", r.old, r.new).hard.map((s) => `${s.kind} ${s.path}`)).toContain(`startup-hook ${pth[0]}`);
    // Files the same in every artifact are read once.
    expect([...r.new.keys()].filter((k) => k.endsWith("demo/__init__.py")).length).toBe(1);
    expect([...r.new.keys()].filter((k) => k.endsWith("pyproject.toml")).length).toBe(1);
  });

  test("a download whose sha256 differs from PyPI's digest holds", async () => {
    await expect(load(fakeFetch((n, b) => (n.includes("macosx") ? "0".repeat(64) : sha(b))))).rejects.toThrow(/sha256/);
  });

  test("a file PyPI lists with no sha256 digest holds", async () => {
    await expect(load(fakeFetch((n, b) => (n.endsWith(".tar.gz") ? undefined : sha(b))))).rejects.toThrow(/sha256/);
  });

  test("a listed file that cannot be fetched holds", async () => {
    await expect(load(fakeFetch((_n, b) => sha(b), new Set(["demo-1.1-cp312-cp312-macosx_11_0_arm64.whl"])))).rejects.toThrow(/404/);
  });
});

// Audit 0.2.3: the npm download named its file from the decoded last URL segment, so %2F or %2E%2E%2F in a registry
// URL could write outside the work directory.
describe("loadArtifacts: npm file names", () => {
  test("an encoded path separator in the tarball URL never writes outside the work directory", async () => {
    const root = mkdtempSync(join(tmpdir(), "oupdate-cli-npm-"));
    const work = join(root, "work");
    mkdirSync(work);
    try {
      const registry = { artifactUrls: async (_n: string, v: string) => [`https://registry.npmjs.org/demo/-/%2E%2E%2Fescape-${v}.tgz`] } as never;
      const f = (async () => new Response(new Uint8Array([1, 2, 3]))) as unknown as typeof fetch;
      const a = { eco: "npm", name: "demo", from: "1.0.0", to: "1.0.1" } as ReviewArgs;
      await loadArtifacts(a, registry, work, f).catch(() => undefined);
      expect([...new Bun.Glob("escape-*").scanSync({ cwd: root })]).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// Adversarial read 0.2.3 r7 (Codex 2): a uv.lock file the review never read (another sha256 than any PyPI lists for
// that version) passed with the review of PyPI's files.
describe("lockedFilesCheck", () => {
  const sha = (c: string) => c.repeat(64);
  const listed = [{ url: "https://files.pythonhosted.org/p/demo-1.0.1.tar.gz", filename: "demo-1.0.1.tar.gz", packagetype: "sdist" as const, sha256: sha("a") }, { url: "https://files.pythonhosted.org/p/demo-1.0.1-py3-none-any.whl", filename: "demo-1.0.1-py3-none-any.whl", packagetype: "bdist_wheel" as const, sha256: sha("B") }];
  const registry = (files = listed) => ({ latest: async () => undefined, publishedAt: async () => undefined, artifactUrls: async () => [], artifactFiles: async () => files });
  const f = (h: string) => ({ url: "https://files.pythonhosted.org/p/x", hash: h });

  test("every locked file's sha256 is one PyPI lists for that version: nothing to say", async () => {
    expect(await lockedFilesCheck(registry(), "demo", "1.0.1", [f(`sha256:${sha("a")}`), f(`sha256:${sha("b")}`)])).toBeUndefined();
  });

  test("a sha256 PyPI does not list for that version stops", async () => {
    expect(await lockedFilesCheck(registry(), "demo", "1.0.1", [f(`sha256:${sha("a")}`), f(`sha256:${sha("c")}`)])).toMatchObject({ layer: "gate", verdict: "stop", detail: expect.stringContaining(`sha256:${sha("c")}`) });
  });

  test("a file it cannot check (no hash, another algorithm, no url, no listing) is an error, which holds", async () => {
    for (const x of [{ url: "https://files.pythonhosted.org/p/x" }, f(`md5:${"a".repeat(32)}`), { hash: `sha256:${sha("a")}` }]) {
      expect(await lockedFilesCheck(registry(), "demo", "1.0.1", [x])).toMatchObject({ layer: "gate", verdict: "error" });
    }
    const down = { ...registry(), artifactFiles: async () => { throw new Error("pypi 503"); } };
    expect(await lockedFilesCheck(down, "demo", "1.0.1", [f(`sha256:${sha("a")}`)])).toMatchObject({ verdict: "error", detail: expect.stringContaining("pypi 503") });
    expect(await lockedFilesCheck(registry([]), "demo", "1.0.1", [f(`sha256:${sha("a")}`)])).toMatchObject({ verdict: "error" });
  });
});
