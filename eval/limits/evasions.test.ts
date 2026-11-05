import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EVASIONS, SPAWN, evasionReport, newText, scoreEvasions, summarize, writeEvasions, type EvasionCase } from "./evasions.ts";

const byId = (id: string) => EVASIONS.find((x) => x.id === id)!;
const mism = (rows: { ok: boolean; id: string; size: string }[]) => rows.filter((r) => !r.ok).map((r) => `${r.id}/${r.size}`);

test("every evasion case is labeled and the labels match what the reviewer is shown", async () => {
  const rows = await scoreEvasions();
  expect(rows.filter((r) => !r.ok).map((r) => `${r.id}/${r.size}`)).toEqual([]);
  expect(summarize(rows)).toEqual({ n: 65, shown: 40, known_base_weaknesses: 25, mismatches: [] });
}, 120000);

test("the set is well formed: unique ids, a known weakness is a hidden case", () => {
  expect(new Set(EVASIONS.map((c) => c.id)).size).toBe(EVASIONS.length);
  for (const c of EVASIONS) if (c.baseWeakness) expect(c.expect).toBe("hidden");
});

test("a wrong label is a mismatch, not a pass", async () => {
  const c = EVASIONS.find((x) => x.id === "extra-content-no-loader")!;
  const rows = await scoreEvasions([{ ...c, expect: "hidden" }]);
  expect(summarize(rows).mismatches).toEqual(["extra-content-no-loader/big", "extra-content-no-loader/small"]);
}, 60000);

test("a release record is written per version with the summary", async () => {
  const out = mkdtempSync(join(tmpdir(), "evas-"));
  const c = EVASIONS.find((x) => x.id === "extra-content-no-loader")!;
  const s = await writeEvasions("9.9.9", out, [c]);
  expect(s).toMatchObject({ tool_version: "9.9.9", n: 2, shown: 2, known_base_weaknesses: 0, mismatches: [] });
  expect(JSON.parse(readFileSync(join(out, "9.9.9-evasions.json"), "utf8")).summary.tool_version).toBe("9.9.9");
  expect(readFileSync(join(out, "9.9.9-evasions.md"), "utf8")).toContain("2 of 2 shown");
  rmSync(out, { recursive: true, force: true });
}, 60000);

test("text that only the old release carries is not shown as new text", async () => {
  const loader = "const m = JSON.parse(require('fs').readFileSync(__filename + '.map', 'utf8'));\nrequire('vm').runInThisContext(m['sources'+'Content'][1]);\nexports.v = 2;\n";
  const c: EvasionCase = { id: "old-only", note: "payload only in the old map, shown as a removed line; the new side hides it", expect: "hidden", key: [SPAWN], code: loader, old: { sources: ["a", "a"], sc: [SPAWN, "ok"] }, next: { sources: ["a", "a"], sc: ["ok", "other"] } };
  expect(mism(await scoreEvasions([c]))).toEqual([]);
  expect(newText("x\n<<<BEGIN UNTRUSTED DATA: d>>>\n| -old " + SPAWN + "\n| ~a [-" + SPAWN + "-] {+b+}\n| +new\n<<<END UNTRUSTED DATA: d>>>\n" + SPAWN)).toBe("| ~a  {+b+}\n| +new\n");
}, 60000);

test("a mutant that keeps the removed line but drops the new payload fails the swap cases", async () => {
  // keeps removed lines and [-removed-] spans, drops the payload everywhere else
  const view = (p: string) => p.split("\n").map((l) => (l.startsWith("| -") ? l : l.replace(/(\[-[\s\S]*?-\])|require\('child_process'\)\.exec\(process\.env\.Q\)/g, (_m, kept) => kept ?? ""))).join("\n");
  expect(mism(await scoreEvasions([byId("swap-clean-and-payload"), byId("rename-source-then-swap")], { view }))).toEqual(["swap-clean-and-payload/big", "swap-clean-and-payload/small", "rename-source-then-swap/big", "rename-source-then-swap/small"]);
}, 120000);

test("a reviewer that throws makes every case a mismatch, known weaknesses included", async () => {
  const hidden = EVASIONS.filter((c) => c.baseWeakness);
  expect(hidden.length).toBe(13);
  const rows = await scoreEvasions(hidden, { review: async () => { throw new Error("boom"); } });
  expect(rows.every((r) => !r.ran && !r.ok)).toBe(true);
  expect(summarize(rows).mismatches.length).toBe(rows.length);
}, 120000);

test("a split payload is shown only when every piece reaches the reviewer", async () => {
  const c = byId("names-split-forward-join");
  const half = c.key[1]!;
  expect(mism(await scoreEvasions([c], { view: (p) => p.split(half).join("") }))).toEqual(["names-split-forward-join/big", "names-split-forward-join/small"]);
}, 60000);

test("the report fails on a label mismatch and names it", () => {
  const ok = evasionReport({ n: 2, shown: 2, known_base_weaknesses: 0, mismatches: [] });
  expect(ok).toEqual({ line: "2 of 2 shown, 0 known base weaknesses", failed: false });
  const bad = evasionReport({ n: 2, shown: 1, known_base_weaknesses: 0, mismatches: ["a/big"] });
  expect(bad.failed).toBe(true);
  expect(bad.line).toContain("label mismatches: a/big");
});
