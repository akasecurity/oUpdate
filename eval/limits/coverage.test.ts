import { expect, test } from "bun:test";
import { measure } from "./coverage.ts";

test("coverage matrix: read lockfiles reach every layer, yarn does not", async () => {
  const rows = await measure();
  const by = Object.fromEntries(rows.map((r) => [r.ecosystem, r]));
  for (const e of ["bun", "npm", "pnpm", "uv", "poetry", "requirements"]) {
    expect(by[e], e).toMatchObject({
      status: "covered",
      parsed: true,
      prepass: true,
      reviewer: true,
    });
  }
  expect(by.yarn).toMatchObject({
    status: "not covered (measured)",
    parsed: false,
    prepass: false,
    reviewer: false,
  });
  for (const e of ["apt", "Mac App Store"])
    expect(by[e]).toMatchObject({
      status: "not covered (measured)",
      note: "no adapter",
    });
  expect(rows).toHaveLength(9);
});
