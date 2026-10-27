import { describe, expect, test } from "bun:test";
import { npmRegistry } from "../src/adapters/ecosystem/npm.ts";
import { pypiRegistry } from "../src/adapters/ecosystem/pypi.ts";
import { osvFeed } from "../src/adapters/advisory/osv.ts";

type Call = { url: string; init?: RequestInit };
function fakeFetch(routes: Record<string, unknown>, calls: Call[] = []): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (!(url in routes)) return new Response("not found", { status: 404 });
    return Response.json(routes[url]);
  }) as typeof fetch;
}

describe("npmRegistry", () => {
  const reg = npmRegistry({
    fetch: fakeFetch({
      "https://registry.npmjs.org/yaml": {
        "dist-tags": { latest: "2.8.3" },
        time: { "2.8.1": "2025-08-01T00:00:00.000Z", "2.8.3": "2026-10-01T00:00:00.000Z" },
        versions: {
          "2.8.1": { dist: { tarball: "https://registry.npmjs.org/yaml/-/yaml-2.8.1.tgz" } },
          "2.8.3": { dist: { tarball: "https://registry.npmjs.org/yaml/-/yaml-2.8.3.tgz" } },
        },
      },
      "https://registry.npmjs.org/@scope%2fpkg": { "dist-tags": { latest: "1.0.0" }, time: {}, versions: {} },
    }),
  });

  test("latest and publish time", async () => {
    expect(await reg.latest("yaml")).toBe("2.8.3");
    expect((await reg.publishedAt("yaml", "2.8.3"))?.toISOString()).toBe("2026-10-01T00:00:00.000Z");
    expect(await reg.publishedAt("yaml", "9.9.9")).toBeUndefined();
  });

  test("artifact URLs come from dist.tarball", async () => {
    expect(await reg.artifactUrls("yaml", "2.8.1")).toEqual(["https://registry.npmjs.org/yaml/-/yaml-2.8.1.tgz"]);
  });

  test("scoped names are escaped", async () => {
    expect(await reg.latest("@scope/pkg")).toBe("1.0.0");
  });
});

describe("pypiRegistry", () => {
  const reg = pypiRegistry({
    fetch: fakeFetch({
      "https://pypi.org/pypi/litellm/json": { info: { version: "1.106.2" } },
      "https://pypi.org/pypi/litellm/1.106.2/json": {
        urls: [
          { packagetype: "bdist_wheel", url: "https://files.example/litellm-1.106.2-py3-none-any.whl", upload_time_iso_8601: "2026-10-18T10:00:00.000000Z" },
          { packagetype: "sdist", url: "https://files.example/litellm-1.106.2.tar.gz", upload_time_iso_8601: "2026-10-18T09:59:00.000000Z" },
        ],
      },
    }),
  });

  test("latest", async () => {
    expect(await reg.latest("litellm")).toBe("1.106.2");
  });

  test("publish time is the earliest upload of that version", async () => {
    expect((await reg.publishedAt("litellm", "1.106.2"))?.toISOString()).toBe("2026-10-18T09:59:00.000Z");
  });

  test("artifacts list the wheel before the sdist", async () => {
    expect(await reg.artifactUrls("litellm", "1.106.2")).toEqual([
      "https://files.example/litellm-1.106.2-py3-none-any.whl",
      "https://files.example/litellm-1.106.2.tar.gz",
    ]);
  });

  test("artifact files are every wheel and sdist with PyPI's sha256; eggs are left out", async () => {
    const reg2 = pypiRegistry({
      fetch: fakeFetch({
        "https://pypi.org/pypi/demo/1.0/json": {
          urls: [
            { packagetype: "bdist_wheel", filename: "demo-1.0-py3-none-any.whl", url: "https://files.example/a.whl", digests: { sha256: "a".repeat(64) } },
            { packagetype: "bdist_egg", filename: "demo-1.0.egg", url: "https://files.example/b.egg", digests: { sha256: "b".repeat(64) } },
            { packagetype: "sdist", filename: "demo-1.0.tar.gz", url: "https://files.example/c.tar.gz" },
          ],
        },
      }),
    });
    expect(await reg2.artifactFiles!("demo", "1.0")).toEqual([
      { url: "https://files.example/a.whl", filename: "demo-1.0-py3-none-any.whl", packagetype: "bdist_wheel", sha256: "a".repeat(64) },
      { url: "https://files.example/c.tar.gz", filename: "demo-1.0.tar.gz", packagetype: "sdist", sha256: undefined },
    ]);
  });

  test("a quarantined or missing version gives no artifacts and no time", async () => {
    expect(await reg.artifactUrls("litellm", "1.107.0")).toEqual([]);
    expect(await reg.publishedAt("litellm", "1.107.0")).toBeUndefined();
  });
});

describe("osvFeed", () => {
  test("querybatch maps results back to packages and hydrates details", async () => {
    const calls: Call[] = [];
    const feed = osvFeed({
      fetch: fakeFetch(
        {
          "https://api.osv.dev/v1/querybatch": { results: [{ vulns: [{ id: "GHSA-48c2-rrv3-qjmp" }] }, {}] },
          "https://api.osv.dev/v1/vulns/GHSA-48c2-rrv3-qjmp": {
            id: "GHSA-48c2-rrv3-qjmp",
            summary: "yaml stack overflow",
            database_specific: { severity: "MODERATE" },
            affected: [{ package: { ecosystem: "npm", name: "yaml" }, ranges: [{ type: "SEMVER", events: [{ introduced: "2.0.0" }, { fixed: "2.8.3" }] }] }],
          },
        },
        calls,
      ),
    });
    const out = await feed.query([
      { ecosystem: "npm", name: "yaml", version: "2.8.1" },
      { ecosystem: "npm", name: "typescript", version: "5.9.2" },
    ]);
    expect(out).toEqual([
      {
        pkg: { ecosystem: "npm", name: "yaml", version: "2.8.1" },
        id: "GHSA-48c2-rrv3-qjmp",
        summary: "yaml stack overflow",
        severity: "moderate",
        fixed: ["2.8.3"],
        malicious: false,
      },
    ]);
    const body = JSON.parse(String(calls[0]!.init!.body));
    expect(body.queries[0]).toEqual({ package: { ecosystem: "npm", name: "yaml" }, version: "2.8.1" });
  });

  test("a MAL- id, or a MAL- alias, marks the advisory malicious", async () => {
    const feed = osvFeed({
      fetch: fakeFetch(
        {
          "https://api.osv.dev/v1/querybatch": { results: [{ vulns: [{ id: "MAL-2025-1" }, { id: "GHSA-aaaa" }, { id: "GHSA-bbbb" }] }] },
          "https://api.osv.dev/v1/vulns/MAL-2025-1": { id: "MAL-2025-1", summary: "Malicious code in x" },
          "https://api.osv.dev/v1/vulns/GHSA-aaaa": { id: "GHSA-aaaa", summary: "x contains malware", aliases: ["MAL-2025-1"] },
          "https://api.osv.dev/v1/vulns/GHSA-bbbb": { id: "GHSA-bbbb", summary: "x SSRF", aliases: ["CVE-2025-1"] },
        },
        [],
      ),
    });
    const out = await feed.query([{ ecosystem: "npm", name: "x", version: "1.0.1" }]);
    expect(out.map((a) => [a.id, a.malicious])).toEqual([["MAL-2025-1", true], ["GHSA-aaaa", true], ["GHSA-bbbb", false]]);
  });

  test("malware wording in the summary marks it malicious; plain 'malicious input' does not", async () => {
    const summaries = {
      "PYSEC-1": "A number of releases of ultralytics contained malicious crypto miner software.",
      "GHSA-c1": "eslint-config-prettier has embedded malicious code",
      "GHSA-c2": "x contains malware after account takeover",
      "GHSA-c3": "Malicious input causes a stack overflow",
      "GHSA-c4": "SSRF via a maliciously crafted URL",
    } as Record<string, string>;
    const routes: Record<string, unknown> = { "https://api.osv.dev/v1/querybatch": { results: [{ vulns: Object.keys(summaries).map((id) => ({ id })) }] } };
    for (const [id, summary] of Object.entries(summaries)) routes[`https://api.osv.dev/v1/vulns/${id}`] = { id, summary };
    const out = await osvFeed({ fetch: fakeFetch(routes as never, []) }).query([{ ecosystem: "PyPI", name: "x", version: "1" }]);
    expect(out.map((a) => [a.id, a.malicious])).toEqual([["PYSEC-1", true], ["GHSA-c1", true], ["GHSA-c2", true], ["GHSA-c3", false], ["GHSA-c4", false]]);
  });

  test("an OSV error is thrown, not read as clean", async () => {
    const feed = osvFeed({ fetch: (async () => new Response("boom", { status: 500 })) as unknown as typeof fetch });
    await expect(feed.query([{ ecosystem: "npm", name: "yaml", version: "2.8.1" }])).rejects.toThrow(/osv/);
  });
});
