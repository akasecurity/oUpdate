import { describe, expect, test } from "bun:test";
import { parseReviewArgs, parseGateArgs } from "../src/cli.ts";

describe("parseReviewArgs", () => {
  test("positional eco name from to, with defaults", () => {
    const a = parseReviewArgs(["pypi", "litellm", "1.106.2", "1.107.0"]);
    expect(a).toMatchObject({ eco: "pypi", name: "litellm", from: "1.106.2", to: "1.107.0", cooldownDays: 7 });
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
    expect(a).toMatchObject({ endpoint: "https://forge.test/api/v1", repo: "o/r", tokenFile: "tok", branchPrefix: "renovate/", lockPath: "bun.lock", cooldownDays: 7 });
    expect(a.reviewer).toBeUndefined();
  });

  test("takes a reviewer, prefix, lock path and cooldown", () => {
    const a = parseGateArgs(["--endpoint", "e", "--repo", "o/r", "--token-file", "t", "--reviewer", '{"type":"command","name":"x","argv":["x"]}', "--branch-prefix", "deps/", "--lock", "sub/bun.lock", "--cooldown-days", "3"]);
    expect(a).toMatchObject({ branchPrefix: "deps/", lockPath: "sub/bun.lock", cooldownDays: 3 });
    expect(a.reviewer).toBeDefined();
  });

  test("a missing required flag, a bad repo or an unknown flag is refused", () => {
    expect(() => parseGateArgs(["--repo", "o/r", "--token-file", "t"])).toThrow(/--endpoint/);
    expect(() => parseGateArgs(["--endpoint", "e", "--repo", "or", "--token-file", "t"])).toThrow(/owner\/name/);
    expect(() => parseGateArgs(["--endpoint", "e", "--repo", "o/r", "--token-file", "t", "--x"])).toThrow(/unknown flag/);
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
