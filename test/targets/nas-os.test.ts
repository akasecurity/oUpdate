// unraid-os reports only: the NAS's version through os.version against the releases API, the script's words kept.
import { describe, expect, test } from "bun:test";
import { osLeg, realUnraidReleases, UNRAID_RELEASES_URL } from "../../src/targets/nas/os.ts";
import { DIGEST_TROUBLE } from "../../src/targets/summary.ts";
import { ans, openNas } from "./fake-nas.ts";

const rel = (v: string | undefined) => ({ latest: async () => v });
const VERSION = { answers: { "os.version": ans([["UNRAID", "7.1.4"]]) } };

describe("unraid-os leg", () => {
  test("up to date", async () => {
    const { nas } = await openNas(VERSION);
    expect(await osLeg(nas, rel("7.1.4"))).toMatchObject({ summary: "up to date", trouble: false, parity: { os: "up to date" } });
  });

  test("an update is reported, never installed, and is not trouble", async () => {
    const { nas, requests } = await openNas(VERSION);
    const res = await osLeg(nas, rel("7.2.0"));
    expect(res).toMatchObject({ summary: "UPDATE AVAILABLE: 7.1.4 -> 7.2.0", trouble: false, parity: { os: "UPDATE AVAILABLE: 7.1.4 -> 7.2.0" } });
    expect(requests.every((q) => q.action === "store.oup.read")).toBe(true);
  });

  test("an unreachable releases API is a failed check, with a digest trouble word", async () => {
    const { nas } = await openNas(VERSION);
    const res = await osLeg(nas, rel(undefined));
    expect(res).toMatchObject({ summary: "check failed (API unreachable)", trouble: true, parity: { os: "check failed (API unreachable)" } });
    expect(DIGEST_TROUBLE.test(res.summary)).toBe(true);
  });

  test("an os.version failure is not checked", async () => {
    const { nas } = await openNas({ answers: { "os.version": ans([], 3) } });
    expect(await osLeg(nas, rel("7.1.4"))).toMatchObject({ summary: "not checked — os.version: NAS read failed: nas-oup: read failed (rc 3: a tool failed)", trouble: true });
  });

  test("realUnraidReleases reads .version and refuses anything else", async () => {
    const urls: string[] = [];
    const f = (body: unknown, ok = true) => (async (u: string | URL | Request) => (urls.push(String(u)), new Response(JSON.stringify(body), { status: ok ? 200 : 503 }))) as typeof fetch;
    expect(await realUnraidReleases(f({ version: "7.2.0" })).latest()).toBe("7.2.0");
    expect(urls).toEqual([UNRAID_RELEASES_URL]);
    expect(await realUnraidReleases(f({ version: "7.2.0; reboot" })).latest()).toBeUndefined();
    expect(await realUnraidReleases(f({ version: "7.2.0" }, false)).latest()).toBeUndefined();
    expect(await realUnraidReleases((async () => { throw new Error("offline"); }) as unknown as typeof fetch).latest()).toBeUndefined();
  });
});
