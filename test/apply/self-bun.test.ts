import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { holdRunningBun, runsUnderBrewBun } from "../../src/apply/run.ts";

test("a Cellar bun and the stable link into it are held; another bun is not", () => {
  const d = mkdtempSync(join(tmpdir(), "oupdate-bun-"));
  try {
    const keg = join(d, "Cellar", "bun", "1.4.4", "bin");
    mkdirSync(keg, { recursive: true });
    writeFileSync(join(keg, "bun"), "");
    mkdirSync(join(d, "bin"));
    symlinkSync(join(keg, "bun"), join(d, "bin", "bun"));
    expect(runsUnderBrewBun(join(keg, "bun"))).toBe(true);
    expect(runsUnderBrewBun(join(d, "bin", "bun"))).toBe(true);
    expect(runsUnderBrewBun("/nonexistent/oupdate-bun/bin/bun")).toBe(false);
    expect(holdRunningBun(["bun", "good-a", "oven-sh/bun/bun"], join(keg, "bun"))).toEqual({ kept: ["good-a"], held: ["bun", "oven-sh/bun/bun"] });
    expect(holdRunningBun(["bun"], "/nonexistent/oupdate-bun/bin/bun")).toEqual({ kept: ["bun"], held: [] });
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});
