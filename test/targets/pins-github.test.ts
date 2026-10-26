import { describe, expect, test } from "bun:test";
import type { GithubGroup } from "../../src/targets/pins/config.ts";
import { discoverGithub, tagPattern, type DatedRelease, type GithubSource } from "../../src/targets/pins/github.ts";

const G: GithubGroup = { source: "github-release", name: "tool", repo: "example/tool", tag: "tool-v{v}", versionKey: "TOOL_VERSION", assets: { TOOL_SHA256_ARM: "tool-linux-aarch64.zip", TOOL_SHA256_X64: "tool_{v}_linux_amd64.tar.gz" }, propose: true };
const CUR = new Map([["TOOL_VERSION", "1.4.2"]]);
const H = (c: string) => c.repeat(64);
const asset = (name: string, digest?: string, url = `https://github.com/example/tool/releases/download/tool-v1.4.3/${name}`) => ({ name, browser_download_url: url, ...(digest !== undefined ? { digest } : {}) });
const rel = (tag: string, over: Partial<DatedRelease> = {}): DatedRelease => ({
  tag_name: tag,
  prerelease: false,
  draft: false,
  published_at: "2026-10-01T10:00:00Z",
  assets: [asset("tool-linux-aarch64.zip", `sha256:${H("a")}`), asset(`tool_${tag.replace("tool-v", "")}_linux_amd64.tar.gz`, `sha256:${H("b")}`)],
  ...over,
});
const src = (rels: DatedRelease[] | Error): GithubSource => ({
  releases: async () => {
    if (rels instanceof Error) throw rels;
    return rels;
  },
});

describe("github pins", () => {
  test("tagPattern captures x.y.z between the template's ends", () => {
    expect("tool-v1.4.3".match(tagPattern("tool-v{v}"))?.[1]).toBe("1.4.3");
    expect(tagPattern("tool-v{v}").test("tool-v1.4.3-rc1")).toBe(false);
    expect(tagPattern("v{v}").test("xv1.0.0")).toBe(false);
  });

  test("the newest stable matching release brings its version and published hashes", async () => {
    const d = await discoverGithub(G, CUR, src([rel("canary", { prerelease: true }), rel("tool-v1.5.0", { draft: true }), rel("tool-v1.4.3"), rel("tool-v1.4.2"), rel("tool-v2.0.0-rc1")]));
    expect(d).toMatchObject({ state: "newer", group: "tool", from: "1.4.2", to: "1.4.3", publishedAt: new Date("2026-10-01T10:00:00Z") });
    if (d.state !== "newer") throw new Error("not newer");
    expect(d.values).toEqual({ TOOL_VERSION: "1.4.3", TOOL_SHA256_ARM: H("a"), TOOL_SHA256_X64: H("b") });
    expect(d.evidence[0]).toBe("github example/tool tool-v1.4.3 (1.4.2 -> 1.4.3), published 2026-10-01T10:00:00.000Z");
  });

  // Review Focus 4: an older or equal latest never proposes; nothing matching is an error.
  test("the pinned or an older release is current", async () => {
    expect(await discoverGithub(G, CUR, src([rel("tool-v1.4.2")]))).toEqual({ state: "current", group: "tool", version: "1.4.2" });
    expect(await discoverGithub(G, CUR, src([rel("tool-v1.4.1")]))).toEqual({ state: "current", group: "tool", version: "1.4.2", note: "newest release 1.4.1 is not newer than the pin" });
    expect(await discoverGithub(G, CUR, src([rel("v9.9.9"), rel("tool-v2.0.0", { prerelease: true })]))).toEqual({ state: "error", group: "tool", why: "no stable release of example/tool has a tag like tool-v{v}" });
  });

  test("a missing digest, a second match or an off-repo url is an error", async () => {
    const noDigest = rel("tool-v1.4.3", { assets: [asset("tool-linux-aarch64.zip"), asset("tool_1.4.3_linux_amd64.tar.gz", `sha256:${H("b")}`)] });
    expect(await discoverGithub(G, CUR, src([noDigest]))).toEqual({ state: "error", group: "tool", why: "tool-linux-aarch64.zip has no published sha256 digest" });
    const twice = rel("tool-v1.4.3", { assets: [...rel("tool-v1.4.3").assets, asset("tool-linux-aarch64.zip", `sha256:${H("c")}`)] });
    expect(await discoverGithub(G, CUR, src([twice]))).toEqual({ state: "error", group: "tool", why: "tool-v1.4.3 has 2 assets named tool-linux-aarch64.zip" });
    const elsewhere = rel("tool-v1.4.3", { assets: [asset("tool-linux-aarch64.zip", `sha256:${H("a")}`, "https://downloads.example.com/tool-linux-aarch64.zip"), asset("tool_1.4.3_linux_amd64.tar.gz", `sha256:${H("b")}`)] });
    expect(await discoverGithub(G, CUR, src([elsewhere]))).toEqual({ state: "error", group: "tool", why: "tool-linux-aarch64.zip is not on example/tool's release path" });
  });

  // Review Focus 1: a hostile digest value is refused.
  test.each([`sha256:${H("a")}\nEVIL=1`, "sha256:$(id)", `sha512:${H("a")}`, `sha256:${H("A")}`])("digest %p is refused", async (dg) => {
    const bad = rel("tool-v1.4.3", { assets: [asset("tool-linux-aarch64.zip", dg), asset("tool_1.4.3_linux_amd64.tar.gz", `sha256:${H("b")}`)] });
    expect(await discoverGithub(G, CUR, src([bad]))).toEqual({ state: "error", group: "tool", why: "tool-linux-aarch64.zip has no published sha256 digest" });
  });

  test("propose false and the note carry through; a source failure is an error", async () => {
    const d = await discoverGithub({ ...G, propose: false, note: "coupled" }, CUR, src([rel("tool-v1.4.3")]));
    expect(d).toMatchObject({ state: "newer", propose: false, note: "coupled" });
    expect(await discoverGithub(G, CUR, src(new Error("GitHub releases HTTP 403")))).toEqual({ state: "error", group: "tool", why: "github example/tool: GitHub releases HTTP 403" });
  });
});
