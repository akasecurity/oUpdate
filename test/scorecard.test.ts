import { expect, test } from "bun:test";
import { scorecard, type ScoreRow } from "../acceptance/scorecard.ts";
import type { LayerVerdict, ReviewResult } from "../src/review.ts";

// Fixture results shaped like the 26 Oct run: 9 attacks, 8 controls.
const layer = (layer: LayerVerdict["layer"], verdict: LayerVerdict["verdict"], detail = ""): LayerVerdict => ({ layer, verdict, detail });
function result(decision: "land" | "hold", prepass: "pass" | "stop", reviewer: LayerVerdict, judged: boolean): ReviewResult {
  return { eco: "npm", name: "p", from: "1", to: "2", decision, layers: [layer("prepass", prepass), reviewer], ...(judged ? { reviewerText: ["x"] } : {}) };
}
const flag = layer("reviewer", "stop", "local FLAG on part(s) 1 of 2");
const approve = layer("reviewer", "pass", "local APPROVE on 3 part(s)");
const tooLarge = layer("reviewer", "stop", "too large for model review: 64 parts > 12 (signal files alone); needs a human");

const published: [string, ReviewResult][] = [
  ["litellm-1.82.7", result("hold", "pass", flag, true)],
  ["ultralytics-8.3.41", result("hold", "pass", flag, true)],
  ["debug-4.4.2", result("hold", "pass", flag, true)],
  ["litellm-1.82.8", result("hold", "stop", flag, true)],
  ["nx-devkit-21.5.0", result("hold", "stop", flag, true)],
  ["eslint-config-prettier-10.1.7", result("hold", "stop", flag, true)],
  ["litellm-1.107.0", result("hold", "stop", flag, true)],
  ["tinycolor-4.1.1", result("hold", "stop", tooLarge, false)],
  ["bitwarden-cli-2026.4.0", result("hold", "stop", tooLarge, false)],
];
const controls = Array.from({ length: 8 }, (_, i): [string, ReviewResult] => [`control-${i}`, result("land", "pass", approve, true)]);
const rows = (reviewer?: string): ScoreRow[] => [
  ...published.map(([id, r]) => ({ id, kind: "attack" as const, reviewer, result: r })),
  ...controls.map(([id, r]) => ({ id, kind: "control" as const, reviewer, result: r })),
];

test("the 26 Oct results score 9/9 stopped, 3 by the model alone, FLAG 7/9, 8/8 controls, 2 not judged", () => {
  const out = scorecard(rows("local")).join("\n");
  expect(out).toContain("scorecard: local");
  expect(out).toMatch(/attacks stopped\s+9\/9\s+bar 9\/9\s+26 Oct: 9\/9/);
  expect(out).toMatch(/stopped by the model alone\s+3\/9\s+26 Oct: 3\/9/);
  expect(out).toMatch(/model FLAG on attacks\s+7\/9\s+26 Oct: 7\/9/);
  expect(out).toMatch(/controls landed\s+8\/8\s+bar 8\/8\s+26 Oct: 8\/8/);
  expect(out).toContain("not judged by the model      2: tinycolor-4.1.1, bitwarden-cli-2026.4.0");
});

test("one block per reviewer; a missed attack and a held control count against it", () => {
  const worse = rows("other").map((r) =>
    r.id === "debug-4.4.2" ? { ...r, result: result("land", "pass", approve, true) } : r.id === "control-0" ? { ...r, result: result("hold", "pass", flag, true) } : r,
  );
  const out = scorecard([...rows("local"), ...worse]);
  expect(out.filter((l) => l.startsWith("scorecard: "))).toEqual(["scorecard: local", "scorecard: other"]);
  const other = out.slice(out.indexOf("scorecard: other")).join("\n");
  expect(other).toMatch(/attacks stopped\s+8\/9/);
  expect(other).toMatch(/stopped by the model alone\s+2\/9/);
  expect(other).toMatch(/controls landed\s+7\/8/);
});

test("no reviewer: every case is not judged, and no line looks like a case line", () => {
  const none = layer("reviewer", "error", "no reviewer configured");
  const out = scorecard(rows(undefined).map((r) => ({ ...r, result: result("hold", r.result.layers[0]!.verdict as "pass" | "stop", none, false) })));
  expect(out[0]).toBe("scorecard: no reviewer");
  const text = out.join("\n");
  expect(text).toMatch(/attacks stopped\s+6\/9/);
  expect(text).toMatch(/model FLAG on attacks\s+0\/9/);
  expect(text).toContain("not judged by the model      17:");
  expect(out.some((l) => /^(MAL|CTRL)\s/.test(l))).toBe(false);
});

test("synthetic evasion cases get their own line and stay out of the published attack count", () => {
  const syn: ScoreRow[] = [
    { id: "synthetic-a", kind: "synthetic", reviewer: "local", result: result("hold", "pass", flag, true) },
    { id: "synthetic-b", kind: "synthetic", reviewer: "local", result: result("land", "pass", approve, true) },
  ];
  const out = scorecard([...rows("local"), ...syn]).join("\n");
  expect(out).toMatch(/attacks stopped\s+9\/9/);
  expect(out).toMatch(/evasion cases stopped\s+1\/2\s+model FLAG 1\/2/);
  expect(scorecard(rows("local")).join("\n")).not.toContain("evasion");
});

test("extended set: labeled, scored against the set's JSON counts, no bar or published column", () => {
  const ext: ScoreRow[] = [
    { id: "x-1", kind: "attack", reviewer: "local", result: result("hold", "pass", flag, true) },
    { id: "x-2", kind: "attack", reviewer: "local", result: result("land", "pass", approve, true) },
    { id: "control-x-1", kind: "control", reviewer: "local", result: result("land", "pass", approve, true) },
  ];
  const out = scorecard(ext, { set: "extended", expected: { attacks: 17, controls: 17 } });
  expect(out[0]).toBe("scorecard: local (extended set)");
  const text = out.join("\n");
  expect(text).toMatch(/attacks stopped\s+1\/17\s*$/m);
  expect(text).toMatch(/controls landed\s+1\/17\s*$/m);
  expect(text).not.toContain("bar ");
  expect(text).not.toContain("26 Oct");
});

test("core set keeps the bar and the published column whatever expected says", () => {
  const out = scorecard(rows("local"), { set: "core" }).join("\n");
  expect(out).toContain("scorecard: local\n");
  expect(out).toMatch(/attacks stopped\s+9\/9\s+bar 9\/9\s+26 Oct: 9\/9/);
});
