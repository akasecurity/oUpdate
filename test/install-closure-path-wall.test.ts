import { expect, test } from "bun:test";
import { classifyJs } from "../src/install-closure.ts";

// OUP-298. The names bound to the path module are read off a file once, not once per alias: 24,000 `const pN=require("path")` aliases (about 700 KB)
// took 56 s through classifyJs when each alias read the whole text again (27 s on dev), and about 0.3 s in two passes. The 3 s bound is the line that fails
// when pathNames goes back to a pass per alias (run once on that code: it did not finish in 30 s).
const aliases = Array.from({ length: 24_000 }, (_, i) => `const p${i}=require("path")\n`).join("");
test("24,000 aliases of the path module classify in under 3 s, and the join through one is a literal", () => {
  const src = `${aliases}require(p7.join(__dirname, "a.js"));\n`;
  const t0 = performance.now();
  const tier = classifyJs("lib/x.js", src);
  const ms = performance.now() - t0;
  expect(tier.lits).toEqual(["lib/a.js"]);
  expect(tier.all).toBe(false);
  expect(ms).toBeLessThan(3000);
}, 60_000);
