// npm groups: the latest plain release, newer than the pin, with a sha512 integrity for every tarball the build fetches.
import { describe, expect, test } from "bun:test";
import { npmIntegrity } from "../../src/adapters/ecosystem/npm.ts";
import type { NpmGroup } from "../../src/targets/pins/config.ts";
import { createHash } from "node:crypto";
import { discoverNpm, fetchVerified, npmSpec, sriOf, type NpmSource } from "../../src/targets/pins/npm.ts";

const SRI = (c: string) => `sha512-${c.repeat(86)}==`;
const G: NpmGroup = { source: "npm", name: "cli", package: "@scope/cli", versionKey: "CLI_VERSION", integrity: { CLI_INTEGRITY: "@scope/cli@{v}", CLI_PLAT_X64: "@scope/cli-linux-x64@{v}", CLI_PLAT_ARM: "@scope/cli@{v}-linux-arm64" }, propose: true };
const CUR = new Map([["CLI_VERSION", "1.2.3"]]);
const PUB = new Date("2026-10-01T00:00:00Z");

function fake(latest: string | undefined | Error, ints: Record<string, string> = {}) {
  const asked: string[] = [];
  const s: NpmSource = {
    latest: async () => {
      if (latest instanceof Error) throw latest;
      return latest;
    },
    publishedAt: async () => PUB,
    integrity: async (n, v) => (asked.push(`${n}@${v}`), ints[`${n}@${v}`]),
  };
  return { s, asked };
}
const ALL = { "@scope/cli@1.2.4": SRI("A"), "@scope/cli-linux-x64@1.2.4": SRI("B"), "@scope/cli@1.2.4-linux-arm64": SRI("C") };

describe("npm pins", () => {
  test("npmSpec splits a scoped template at the version", () => {
    expect(npmSpec("@scope/cli@{v}-linux-x64", "1.2.4")).toEqual({ name: "@scope/cli", version: "1.2.4-linux-x64" });
    expect(npmSpec("plain@{v}", "2.0.0")).toEqual({ name: "plain", version: "2.0.0" });
  });

  test("a newer release brings its version and every integrity", async () => {
    const { s, asked } = fake("1.2.4", ALL);
    const d = await discoverNpm(G, CUR, s);
    expect(d).toMatchObject({ state: "newer", group: "cli", from: "1.2.3", to: "1.2.4", publishedAt: PUB, propose: true });
    if (d.state !== "newer") throw new Error("not newer");
    expect(d.values).toEqual({ CLI_VERSION: "1.2.4", CLI_INTEGRITY: SRI("A"), CLI_PLAT_X64: SRI("B"), CLI_PLAT_ARM: SRI("C") });
    expect(asked).toEqual(["@scope/cli@1.2.4", "@scope/cli-linux-x64@1.2.4", "@scope/cli@1.2.4-linux-arm64"]);
    expect(d.evidence[0]).toBe("npm @scope/cli 1.2.3 -> 1.2.4, published 2026-10-01T00:00:00.000Z");
    expect(d.evidence).toContain(`CLI_PLAT_X64: @scope/cli-linux-x64@1.2.4 dist.integrity ${SRI("B")}`);
  });

  test("the same version is current", async () => {
    expect(await discoverNpm(G, CUR, fake("1.2.3").s)).toEqual({ state: "current", group: "cli", version: "1.2.3" });
  });

  // Review Focus 4: never a downgrade, never a prerelease.
  test("an older latest is current with a note", async () => {
    expect(await discoverNpm(G, CUR, fake("1.2.2").s)).toEqual({ state: "current", group: "cli", version: "1.2.3", note: "npm latest 1.2.2 is not newer than the pin" });
  });

  test.each(["1.3.0-beta.1", "1.3", "v1.3.0", "1.3.0 "])("latest %p is held, not proposed", async (v) => {
    const d = await discoverNpm(G, CUR, fake(v).s);
    expect(d.state).toBe("held");
  });

  // Review: a hostile latest is an error (trouble), never a quiet hold, and is not echoed.
  test.each(["1.0.1;id", "1.0.1$(id)", "1.0.1\nEVIL=1", "1.0.1 x"])("latest %p is an error", async (v) => {
    expect(await discoverNpm(G, CUR, fake(v).s)).toEqual({ state: "error", group: "cli", why: "npm latest for @scope/cli is not a version string" });
  });

  test("a missing integrity is an error", async () => {
    const { ["@scope/cli-linux-x64@1.2.4"]: _gone, ...rest } = ALL;
    expect(await discoverNpm(G, CUR, fake("1.2.4", rest).s)).toEqual({ state: "error", group: "cli", why: "no sha512 integrity for @scope/cli-linux-x64@1.2.4" });
  });

  // Review Focus 1: a hostile integrity value is refused and not echoed.
  test.each(["sha512-$(id)", `${SRI("A")}\nEVIL=1`, `sha1-${"A".repeat(27)}=`, `sha512-${"A".repeat(86)}== x`])("integrity %p is refused", async (bad) => {
    const d = await discoverNpm(G, CUR, fake("1.2.4", { ...ALL, "@scope/cli@1.2.4": bad }).s);
    expect(d).toEqual({ state: "error", group: "cli", why: "no sha512 integrity for @scope/cli@1.2.4" });
  });

  test("a registry failure or an empty pin is an error", async () => {
    expect(await discoverNpm(G, CUR, fake(new Error("registry 503")).s)).toEqual({ state: "error", group: "cli", why: "npm @scope/cli: registry 503" });
    expect(await discoverNpm(G, new Map([["CLI_VERSION", ""]]), fake("1.2.4").s)).toEqual({ state: "error", group: "cli", why: "CLI_VERSION is empty" });
    expect(await discoverNpm(G, CUR, fake(undefined).s)).toEqual({ state: "error", group: "cli", why: "npm has no latest for @scope/cli" });
  });

  // Review: the artifact review reads only bytes whose sha512 matches the integrity in the proposal.
  test("fetchVerified returns bytes matching the integrity and refuses others", async () => {
    const body = new TextEncoder().encode("tarball bytes");
    const good = `sha512-${createHash("sha512").update(body).digest("base64")}`;
    expect(sriOf(body)).toBe(good);
    const f = (async () => new Response(body.slice().buffer as ArrayBuffer)) as unknown as typeof fetch;
    const url = "https://registry.example.com/@scope/cli/-/cli-1.2.4.tgz";
    expect(new TextDecoder().decode(await fetchVerified(f, url, good))).toBe("tarball bytes");
    await expect(fetchVerified(f, url, SRI("A"))).rejects.toThrow(`integrity mismatch for ${url}: the bytes are ${good}, the proposal pins ${SRI("A")}`);
    expect(new TextDecoder().decode(await fetchVerified(f, url, undefined))).toBe("tarball bytes");
    const nf = (async () => new Response("no", { status: 404 })) as unknown as typeof fetch;
    await expect(fetchVerified(nf, url, good)).rejects.toThrow(`download 404 for ${url}`);
  });

  test("npmIntegrity reads dist.integrity of one version, undefined on 404", async () => {
    const urls: string[] = [];
    const f = (async (u: string | URL | Request) => {
      urls.push(String(u));
      return String(u).endsWith("/9.9.9") ? new Response("no", { status: 404 }) : Response.json({ dist: { integrity: SRI("Z") } });
    }) as unknown as typeof fetch;
    expect(await npmIntegrity("@scope/cli", "1.2.4", { fetch: f, base: "https://registry.example.com" })).toBe(SRI("Z"));
    expect(await npmIntegrity("@scope/cli", "9.9.9", { fetch: f, base: "https://registry.example.com" })).toBeUndefined();
    expect(urls[0]).toBe("https://registry.example.com/@scope/cli/1.2.4");
  });
});
