import { describe, expect, test } from "bun:test";
import { scanText } from "../scripts/scan.ts";

describe("scanText", () => {
  test("flags a home path", () => {
    expect(scanText("a.ts", "const p = '/" + "Users/someone/x'").map((f) => f.rule)).toContain("home-path");
    expect(scanText("a.ts", "cd /" + "home/someone").map((f) => f.rule)).toContain("home-path");
  });

  test("flags a tailnet name and a CGNAT address", () => {
    expect(scanText("a.ts", "host.tail1234.ts" + ".net").map((f) => f.rule)).toContain("tailnet");
    expect(scanText("a.ts", "100.101" + ".102.103").map((f) => f.rule)).toContain("cgnat-ip");
  });

  test("flags an email that is not a reserved or noreply domain", () => {
    expect(scanText("a.ts", "me@" + "company.io").map((f) => f.rule)).toContain("email");
    expect(scanText("a.ts", "x@example.com y@users.noreply.invalid z@host.test").map((f) => f.rule)).not.toContain("email");
  });

  test("flags operator-supplied deny words, case-insensitive, whole word", () => {
    expect(scanText("a.ts", "ssh Gizmo now", ["gizmo"]).map((f) => f.rule)).toContain("deny-list");
    expect(scanText("a.ts", "gizmos", ["gizmo"]).map((f) => f.rule)).not.toContain("deny-list");
  });

  test("a private address is flagged, a three-part version is not", () => {
    expect(scanText("a.ts", "10.0" + ".0.12").map((f) => f.rule)).toContain("private-ip");
    expect(scanText("a.ts", '"good": "10.1.5"').map((f) => f.rule)).not.toContain("private-ip");
  });

  test("clean text has no findings", () => {
    expect(scanText("a.ts", "export const x = 1; // example.test")).toEqual([]);
  });
});
