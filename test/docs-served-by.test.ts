import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// AGENTS.md repeats the README paragraph on the reviewer's optional keys; the served-by text must read the same in both.
test("AGENTS.md carries the README's served-by sentences", () => {
  const readme = readFileSync(join(import.meta.dir, "..", "README.md"), "utf8"), agents = readFileSync(join(import.meta.dir, "..", "AGENTS.md"), "utf8");
  const m = /`servedByHeader` \(optional\)[^\n]*?an `--out` folder outside the repo\./.exec(readme);
  expect(m).not.toBeNull();
  expect(m![0]).toContain("it never refuses an answer");
  expect(agents).toContain(m![0]);
});
