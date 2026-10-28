// Type A deterministic policy, ported from the previous updater's tests.
import { describe, expect, test } from "bun:test";
import { DEFAULTS } from "../../src/apply/config.ts";
import { typeAReview } from "../../src/apply/typea.ts";

describe("typeAReview", () => {
  for (const [name, versions, held] of [
    ["openssl@3", "3.6.3) < 4.0.0", true],
    ["python@3.13", "3.13.5) < 4.0.0", true],
    ["ollama", "0.24.0) < 0.30.6", false],
    ["curl", "9.0) < 10.0", true],
    ["git", "2.4) < 2.5", false],
    ["claude-code", "1.0) < 2.0", false],
    ["node", "unknown) < 25.0", true],
  ] as const) {
    test(`Type A deterministic ${name} ${versions}`, () => {
      const r = typeAReview([name], `${name} (${versions}`, DEFAULTS.sensitive);
      expect(r.text.startsWith(held ? `FLAG\nHOLD: ${name}` : "APPROVE")).toBe(true);
      expect(r.held).toEqual(held ? [name] : []);
    });
  }
  test("Type A missing sensitive baseline holds only that package", () => {
    const r = typeAReview(["git", "mosh"], "mosh (1.0) < 1.1", DEFAULTS.sensitive);
    expect(r.text).toContain("HOLD: git");
    expect(r.held).toEqual(["git"]);
  });
  test("a tap-qualified sensitive name matches on its last segment; the list comes from config", () => {
    expect(typeAReview(["example/tap/curl"], "example/tap/curl (1.0) < 2.0", ["curl"]).held).toEqual(["example/tap/curl"]);
    expect(typeAReview(["curl"], "curl (1.0) < 2.0", []).held).toEqual([]);
  });
  test("names with pattern characters compare literally", () => {
    expect(typeAReview(["no.e"], "node (1.0) < 2.0", ["no.e"]).held).toEqual(["no.e"]);
  });
});
