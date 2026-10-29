import { describe, expect, test } from "bun:test";
import { giteaForge } from "../src/adapters/forge/gitea.ts";

describe("giteaForge plain http", () => {
  test("the token is never sent to a plain http endpoint on a non-loopback host; loopback is allowed", async () => {
    const urls: string[] = [];
    const f = (async (u: string) => (urls.push(String(u)), Response.json([]))) as unknown as typeof fetch;
    const bad = giteaForge({ token: "t", login: "bot", endpoint: "http://forge.example/api/v1", fetch: f });
    await expect(bad.openPulls("o/r")).rejects.toThrow(/token is not sent over plain http/);
    expect(urls).toEqual([]);
    const ok = giteaForge({ token: "t", login: "bot", endpoint: "http://localhost:3000/api/v1", fetch: f });
    await ok.openPulls("o/r").catch(() => {});
    expect(urls.length).toBeGreaterThan(0);
  });
});
