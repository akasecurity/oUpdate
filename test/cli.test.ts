import { describe, expect, test } from "bun:test";
import { parseReviewArgs, parseGateArgs, parseImageArgs, gateToken, gateForge } from "../src/cli.ts";

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
    expect(a.reviewer).toBeUndefined();
    expect(a.secondReviewer).toBeUndefined();
  });

  test("a digest ref and every flag", () => {
    const a = parseImageArgs([
      "lscr.io/linuxserver/radarr:5.14.0", `lscr.io/linuxserver/radarr@${D}`,
      "--platform", "linux/arm64/v8", "--reviewer", REV, "--second-reviewer", REV, "--now", "2026-10-26T12:00:00Z", "--json", "out.json",
    ]);
    expect(a.new.reference).toBe(D);
    expect(a).toMatchObject({ platform: "linux/arm64/v8", json: "out.json", reviewer: { name: "r" }, secondReviewer: { name: "r" } });
    expect(a.now.toISOString()).toBe("2026-10-26T12:00:00.000Z");
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
