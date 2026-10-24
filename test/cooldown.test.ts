import { describe, expect, test } from "bun:test";
import { cooldownVerdict } from "../src/cooldown.ts";

const DAY = 86_400_000;
const now = new Date("2026-10-21T18:00:00Z");

describe("cooldownVerdict", () => {
  test("a release younger than the cooldown is held", () => {
    const v = cooldownVerdict({ publishedAt: new Date(now.getTime() - 2 * 3_600_000), now, days: 7, advisoryFix: false });
    expect(v.eligible).toBe(false);
    expect(v.reason).toContain("held");
  });

  test("a release older than the cooldown is eligible", () => {
    const v = cooldownVerdict({ publishedAt: new Date(now.getTime() - 8 * DAY), now, days: 7, advisoryFix: false });
    expect(v.eligible).toBe(true);
  });

  test("exactly the cooldown age is eligible", () => {
    const v = cooldownVerdict({ publishedAt: new Date(now.getTime() - 7 * DAY), now, days: 7, advisoryFix: false });
    expect(v.eligible).toBe(true);
  });

  test("an advisory fix skips the cooldown but says so", () => {
    const v = cooldownVerdict({ publishedAt: new Date(now.getTime() - 3_600_000), now, days: 7, advisoryFix: true });
    expect(v.eligible).toBe(true);
    expect(v.reason).toContain("advisory");
  });

  test("an unknown publish time is held (fail closed)", () => {
    const v = cooldownVerdict({ publishedAt: undefined, now, days: 7, advisoryFix: false });
    expect(v.eligible).toBe(false);
  });

  test("a publish time in the future is held", () => {
    const v = cooldownVerdict({ publishedAt: new Date(now.getTime() + DAY), now, days: 7, advisoryFix: false });
    expect(v.eligible).toBe(false);
  });
});
