// The pins.env model: byte-for-byte round trip, only values ever change, and a value can never add a line or a shell expansion.
import { describe, expect, test } from "bun:test";
import { parsePins, pinValues, pinsDiff, renderPins, setPins, SAFE_VALUE } from "../../src/targets/pins/file.ts";

const TEXT = `# Pinned contents of a sample image.
BASE_TAG=24.04
# Source: a registry, read 2026-10-01.
BASE_DIGEST=sha256:${"a".repeat(64)}

TOOL_VERSION=1.2.3
TOOL_SHA256_X64=${"b".repeat(64)}
EMPTY_LATER=
`;

describe("pins file", () => {
  test("round-trips byte for byte and indexes the pins", () => {
    const f = parsePins(TEXT);
    expect(renderPins(f)).toBe(TEXT);
    expect(pinValues(f).get("TOOL_VERSION")).toBe("1.2.3");
    expect(pinValues(f).get("EMPTY_LATER")).toBe("");
    expect(pinValues(f).size).toBe(5);
  });

  test("keeps a missing final newline", () => {
    expect(renderPins(parsePins("A=1\nB=2"))).toBe("A=1\nB=2");
  });

  test("refuses a line that is not KEY=value and a key set twice", () => {
    expect(() => parsePins("A=1\nexport B=2\n")).toThrow("pins line 2 is not KEY=value");
    expect(() => parsePins("A=1\nA=2\n")).toThrow("pins line 2: A is set twice");
  });

  test("setPins replaces only the named values and leaves the input alone", () => {
    const f = parsePins(TEXT);
    const g = setPins(f, { TOOL_VERSION: "1.2.4", TOOL_SHA256_X64: "c".repeat(64) });
    expect(renderPins(g)).toBe(TEXT.replace("TOOL_VERSION=1.2.3", "TOOL_VERSION=1.2.4").replace(`TOOL_SHA256_X64=${"b".repeat(64)}`, `TOOL_SHA256_X64=${"c".repeat(64)}`));
    expect(renderPins(f)).toBe(TEXT);
  });

  test("setPins refuses an unknown key", () => {
    expect(() => setPins(parsePins(TEXT), { NEW_KEY: "1" })).toThrow("pins has no NEW_KEY");
  });

  // Review Focus 1: a value read from a source can never add a line, an expansion or a quote.
  test.each(["1.2.4\nEVIL=1", "$(id)", "`id`", "1.2 4", "'x'", "", "a;b", "a|b", "a\\b", "a\"b"])("setPins refuses the value %p", (v) => {
    expect(() => setPins(parsePins(TEXT), { TOOL_VERSION: v })).toThrow("refusing value for TOOL_VERSION");
  });

  test("SAFE_VALUE takes the real value shapes", () => {
    for (const v of ["2.1.296", `sha256:${"0".repeat(64)}`, "sha512-AbC+/x==", "20260919T000000Z", "5:28.5.2-1~ubuntu.24.04~noble"]) expect(SAFE_VALUE.test(v)).toBe(true);
  });

  test("pinsDiff lists each changed value under its line number", () => {
    const f = parsePins(TEXT);
    expect(pinsDiff(f, setPins(f, { TOOL_VERSION: "1.2.4" }))).toBe("@@ line 6 @@\n-TOOL_VERSION=1.2.3\n+TOOL_VERSION=1.2.4");
    expect(pinsDiff(f, f)).toBe("");
  });
});
