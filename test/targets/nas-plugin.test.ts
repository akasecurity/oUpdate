// The unraid-plugin leg: the OS plugin is never touched, each newer plugin's .plg (old and new) is read through the
// broker, checked against its PLG sha, filtered by the .plg rules and reviewed by both models; updates go one per plugin.
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PluginLeg, Target } from "../../src/targets/model.ts";
import { orderedDiff, plgRules, pluginLeg } from "../../src/targets/nas/plugin.ts";
import type { OpenNas } from "../../src/targets/reach.ts";
import type { LegContext } from "../../src/targets/run.ts";
import { ans, fakeReviewer, j, openNas, REACH, RUN, X, type FakeNas } from "./fake-nas.ts";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const b64 = (s: string) => Buffer.from(s).toString("base64");
const plg = (v: string, hash = `<SHA256>${X("a")}</SHA256>`) => `<?xml version='1.0' standalone='yes'?>
<PLUGIN name="example.plugin" version="${v}">
<FILE Name="/boot/config/plugins/example.plugin/example-${v}.txz" Run="upgradepkg --install-new">
<URL>https://downloads.example.org/example-${v}.txz</URL>
${hash}
</FILE>
</PLUGIN>
`;
const OLD = plg("2026.09.01");
const NEW = plg("2026.10.01", `<SHA256>${X("b")}</SHA256>`);
const MAL = readFileSync(join(import.meta.dir, "../fixtures/nas/malicious.plg"), "utf8");
const TARGET: Target = { id: "storage-box", os: "unraid", reach: REACH, legs: [], schedule: { every: "night" }, summaryTo: "/status/storage-box.tsv" };
const ctx = (nas: OpenNas, dryRun = false): LegContext => ({ target: TARGET, reach: nas, dryRun, now: new Date(2026, 9, 25, 3, 0) });
const leg = (apply = false): PluginLeg => ({ kind: "unraid-plugin", apply });
const row = (name: string, from: string, to: string, oldText: string, newText: string) => ["PLG", j(name), j(from), j(to), sha(oldText), sha(newText), "Ab12Cd34"];

function scene(newText = NEW, extra: FakeNas = {}, rows?: string[][]): FakeNas {
  return {
    ...extra,
    answers: {
      "plugin.check": ans(rows ?? [row("example.plugin", "2026.09.01", "2026.10.01", OLD, newText), row("other.plugin", "2026.08.01", "2026.08.01", OLD, OLD), row("unRAIDServer", "7.1.4", "7.2.0", OLD, OLD)]),
      "plugin.file": (p) => ans([["B64", b64(p.which === "old" ? OLD : newText)]]),
      ...extra.answers,
    },
  };
}
const both = () => ({ router: fakeReviewer("router-model", "APPROVE").reviewer, onprem: fakeReviewer("onprem-model", "APPROVE").reviewer });

describe("plgRules", () => {
  test("a payload with a sha256 is listed; with no hash it is held; MD5 only is a flag", () => {
    expect(plgRules(NEW)).toEqual({ hold: [], flags: [], payloads: [`/boot/config/plugins/example.plugin/example-2026.10.01.txz: https://downloads.example.org/example-2026.10.01.txz sha256 ${X("b")}`] });
    expect(plgRules(plg("1", "")).hold).toEqual(["payload without a hash: https://downloads.example.org/example-1.txz"]);
    expect(plgRules(plg("1", "<MD5>abc</MD5>")).flags).toEqual(["MD5 only: https://downloads.example.org/example-1.txz"]);
  });

  test("an inline fetch or a second install is held", () => {
    expect(plgRules(MAL).hold).toEqual(["payload without a hash: https://downloads.example.org/example-2026.10.01.txz", '? INLINE contains "://"']);
    expect(plgRules(`<FILE Name="/tmp/x" Run="plugin install /tmp/y.plg"><INLINE>x</INLINE></FILE>`).hold).toEqual(['/tmp/x Run contains "plugin install"']);
  });
});

describe("unraid-plugin leg", () => {
  test("review only: the newer plugin is reviewed and would update; the OS plugin is never read", async () => {
    const { nas, requests } = await openNas(scene());
    const r = fakeReviewer("router-model", "APPROVE");
    const res = await pluginLeg(leg(), ctx(nas), nas, { router: r.reviewer, onprem: fakeReviewer("onprem-model", "APPROVE").reviewer });
    expect(res).toMatchObject({ summary: "would update: example.plugin", trouble: false, parity: { plugins: ["example.plugin 2026.09.01 -> 2026.10.01"] } });
    expect(requests.filter((q) => q.params.verb === "plugin.file").map((q) => [q.params.plugin, q.params.which, q.params.copy, q.params.run_id])).toEqual([["example.plugin", "old", "Ab12Cd34", RUN], ["example.plugin", "new", "Ab12Cd34", RUN]]);
    expect(r.prompts[0]).toContain("+<URL>https://downloads.example.org/example-2026.10.01.txz</URL>");
    expect(res.lines).toContain("  other.plugin: up to date (2026.08.01)");
  });

  test("the malicious .plg is held without a review", async () => {
    const r = fakeReviewer("router-model", "APPROVE");
    const { nas } = await openNas(scene(MAL));
    const res = await pluginLeg(leg(true), ctx(nas), nas, { router: r.reviewer, onprem: fakeReviewer("o", "APPROVE").reviewer });
    expect(res.summary).toBe('blocked (example.plugin: payload without a hash: https://downloads.example.org/example-2026.10.01.txz; ? INLINE contains "://")');
    expect(res.trouble).toBe(true);
    expect(r.prompts).toHaveLength(0);
  });

  test("a .plg whose bytes do not match its PLG row is held", async () => {
    const { nas } = await openNas(scene(NEW, {}, [row("example.plugin", "2026.09.01", "2026.10.01", OLD, "something else")]));
    expect((await pluginLeg(leg(), ctx(nas), nas, both())).summary).toBe("blocked (example.plugin: sha256 of the new .plg does not match its PLG row)");
  });

  test("apply: one plugin.update per approved plugin, naming only that plugin", async () => {
    const { nas, requests } = await openNas(scene());
    const res = await pluginLeg(leg(true), ctx(nas), nas, both());
    expect(res).toMatchObject({ summary: "updated: example.plugin", trouble: false });
    const w = requests.filter((q) => q.action === "store.oup.write");
    expect(w).toHaveLength(1);
    expect(w[0]!.params).toMatchObject({ verb: "plugin.update", run_id: RUN, verdict: { items: { "example.plugin": "APPROVE" }, reviewers: { router: "router-model", onprem: "onprem-model" } }, hold: [] });
    // O-5, confirmed by rev 3e §4.8: only verb, run_id, verdict and hold; items holds exactly this plugin.
    expect(Object.keys(w[0]!.params).sort()).toEqual(["hold", "run_id", "verb", "verdict"]);
    expect((w[0]!.params.verdict as { items: unknown }).items).toEqual({ "example.plugin": "APPROVE" });
  });

  test("a failed update stops the rest and names the suspension", async () => {
    const rows = [row("example.plugin", "2026.09.01", "2026.10.01", OLD, NEW), row("second.plugin", "2026.09.01", "2026.10.01", OLD, NEW)];
    const { nas } = await openNas(scene(NEW, { writeRc: { "plugin.update": 3 } }, rows));
    const res = await pluginLeg(leg(true), ctx(nas), nas, both());
    expect(res.summary).toBe("example.plugin FAILED — plugin.update: rc 3 (a tool failed); the broker suspends the standing entry until a Re-arm card is approved · blocked (second.plugin: not tried after a failed update)");
    expect(res.trouble).toBe(true);
  });

  test("plugin.check busy is not checked", async () => {
    const { nas } = await openNas({ answers: { "plugin.check": ans([], 5) } });
    expect(await pluginLeg(leg(), ctx(nas), nas, both())).toMatchObject({ summary: "not checked — plugin.check: NAS read failed: nas-oup: read failed (rc 5: busy)", trouble: true });
  });

  test("nothing newer is nothing to update; an unreadable version is skipped as the script skips it", async () => {
    const { nas } = await openNas(scene(NEW, {}, [row("other.plugin", "2026.08.01", "2026.08.01", OLD, OLD), row("odd.plugin", "", "2026.08.01", OLD, OLD)]));
    const res = await pluginLeg(leg(), ctx(nas), nas, both());
    expect(res).toMatchObject({ summary: "nothing to update", trouble: false, parity: { plugins: [] } });
    expect(res.lines).toContain("  odd.plugin: could not read version — skipping");
  });

  const inline = (body: string) => `<?xml version='1.0' standalone='yes'?>
<PLUGIN name="example.plugin" version="2026.10.01">
<FILE Name="/tmp/example-install.sh" Run="/bin/bash">
<INLINE>
${body}
</INLINE>
</FILE>
</PLUGIN>
`;
  async function reviewed(oldText: string, newText: string) {
    const nas = scene(newText, { answers: { "plugin.check": ans([row("example.plugin", "2026.09.01", "2026.10.01", oldText, newText)]), "plugin.file": (p) => ans([["B64", b64(p.which === "old" ? oldText : newText)]]) } });
    const { nas: open } = await openNas(nas);
    const r = fakeReviewer("router-model", "APPROVE");
    await pluginLeg(leg(), ctx(open), open, { router: r.reviewer, onprem: fakeReviewer("onprem-model", "APPROVE").reviewer });
    return r.prompts[0]!;
  }

  test("a reordered line shows in the diff: moving a command before exit 0 is a change (Codex 2)", async () => {
    const p = await reviewed(inline("echo installing\nexit 0\nrm -rf /srv/data"), inline("echo installing\nrm -rf /srv/data\nexit 0"));
    expect(p).toMatch(/\n\| [-+](rm -rf \/srv\/data|exit 0)\n/);
    expect(p).toContain("| echo installing\n| rm -rf /srv/data\n| exit 0");
  });

  test("a duplicated or removed duplicate line shows in the diff (Codex 2)", async () => {
    expect(await reviewed(inline("echo a\necho b"), inline("echo a\necho b\necho b"))).toContain("+echo b");
    expect(await reviewed(inline("echo a\necho b\necho b"), inline("echo a\necho b"))).toContain("-echo b");
  });

  test("orderedDiff: hunks with context, removals before additions, separate hunks when far apart", () => {
    const L = (n: number, f = (i: number) => `l${i}`) => Array.from({ length: n }, (_, i) => f(i + 1)).join("\n");
    expect(orderedDiff("a\nb", "a\nb")).toEqual([]);
    expect(orderedDiff(L(10), L(10, (i) => (i === 5 ? "X" : `l${i}`)), 2)).toEqual(["@@ old line 3, new line 3 @@", " l3", " l4", "-l5", "+X", " l6", " l7"]);
    expect(orderedDiff(L(20), L(20, (i) => (i === 3 || i === 17 ? "X" : `l${i}`)), 2)).toEqual([
      "@@ old line 1, new line 1 @@", " l1", " l2", "-l3", "+X", " l4", " l5",
      "@@ old line 15, new line 15 @@", " l15", " l16", "-l17", "+X", " l18", " l19",
    ]);
    expect(orderedDiff("a\nb", "z\na\nb", 1)).toEqual(["@@ old line 1, new line 1 @@", "+z", " a"]);
  });
});
