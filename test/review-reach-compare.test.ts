import { describe, expect, test } from "bun:test";
import { reviewUpdate } from "../src/review.ts";
import type { Registry } from "../src/adapters/ecosystem/types.ts";
import type { FileMap } from "../src/prepass.ts";

const enc = (s: string) => new TextEncoder().encode(s);
const files = (o: Record<string, string>): FileMap => new Map(Object.entries(o).map(([k, v]) => [k, enc(v)]));
const now = new Date("2026-10-21T18:00:00Z");
const registry: Registry = {
  latest: async () => undefined,
  publishedAt: async () => new Date(now.getTime() - 10 * 86_400_000),
  artifactUrls: async (_n, v) => [`https://files.example/${v}`],
};

// Each manifest key and condition is compared by the file it resolves to, old against new. A file the new
// release names where the old one named another is shown, whatever else both releases list.
describe("per-key entry compare", () => {
  const pj = (o: object, version = "1.0.0") => JSON.stringify({ name: "lib", version, ...o });
  const run = async (old: FileMap, next: FileMap) => {
    const prompts: string[] = [];
    const r = await reviewUpdate({
      eco: "npm",
      name: "lib",
      from: "1.0.0",
      to: "1.0.1",
      registry,
      advisories: { query: async () => [] },
      reviewer: { name: "fake", review: async (p) => (prompts.push(p), "APPROVE\nno attack indicators found") },
      cooldownDays: 7,
      now,
      loadArtifacts: async () => ({ old, new: next }),
    });
    return { r, text: prompts.join("") };
  };
  const base = { "index.js": "a()\n", "a.js": "a2()\n", "evil.js": "steal_cmp()\n" };
  const marker = "steal_cmp()";
  const pair = (oldMeta: object, newMeta: object, extra: Record<string, string> = {}) =>
    run(files({ "package.json": pj({ main: "index.js", ...oldMeta }), ...base, ...extra }), files({ "package.json": pj({ main: "index.js", ...newMeta }, "1.0.1"), ...base, ...extra }));

  // Gap 4: a browser key names the file the map replaces. It is not a load, and a false value loads nothing.
  test("gap 4: a false-valued browser entry does not hide a later retarget to the same file", async () => {
    const { text } = await pair({ browser: { "./evil.js": false } }, { browser: { "./a.js": "./evil.js" } });
    expect(text).toContain(marker);
  });

  test("gap 4: a browser key alone is not a load", async () => {
    const { text } = await pair({}, { browser: { "./evil.js": false } });
    expect(text).not.toContain(marker);
  });

  // Gap 5: a star export lists every file on both sides, so a set difference sees no retarget.
  test("gap 5: a star export does not hide a module or browser retarget", async () => {
    const star = { exports: { "./*": "./*" } };
    for (const field of ["module", "browser"]) {
      const { text } = await pair({ ...star, [field]: "./a.js" }, { ...star, [field]: "./evil.js" });
      expect(`${field} ${text.includes(marker)}`).toBe(`${field} true`);
    }
    const { text } = await pair({ ...star, browser: { "./a.js": "./a.js" } }, { ...star, browser: { "./a.js": "./evil.js" } });
    expect(text).toContain(marker);
  });

  test("gap 5: a star export hides nothing a retarget of its own key shows", async () => {
    const { text } = await pair({ exports: { "./*": "./lib/*.js" } }, { exports: { "./*": "./*.js" } }, { "lib/x.js": "x()\n", "x.js": "steal_cmp()\n" });
    expect(text).toContain(marker);
  });

  // Gap 6: loader-specific entry fields name files too.
  test("gap 6: react-native, svelte, jsnext:main, es2015, esnext and source retargets are shown", async () => {
    for (const field of ["react-native", "svelte", "jsnext:main", "es2015", "esnext", "source"]) {
      const { text } = await pair({ [field]: "./a.js" }, { [field]: "./evil.js" });
      expect(`${field} ${text.includes(marker)}`).toBe(`${field} true`);
    }
  });

  test("gap 6: a new loader field, or one under a star export, is shown", async () => {
    const star = { exports: { "./*": "./*" } };
    for (const field of ["react-native", "svelte", "jsnext:main", "es2015", "esnext", "source"]) {
      const added = await pair({}, { [field]: "./evil.js" });
      const starred = await pair({ ...star, [field]: "./a.js" }, { ...star, [field]: "./evil.js" });
      expect(`${field} ${added.text.includes(marker)} ${starred.text.includes(marker)}`).toBe(`${field} true true`);
    }
  });

  // Fail closed: an entry the compare cannot read shows the files beside the manifest.
  test("an entry that cannot be read shows the package files", async () => {
    const { text } = await pair({}, { browser: { "./a.js": 1 } });
    expect(text).toContain(marker);
  });

  // No regression: the same entries, bumped version only, show nothing new.
  test("unchanged entries in every field show no unchanged file", async () => {
    const meta = {
      module: "./evil.js",
      browser: { "./a.js": "./evil.js", "./b.js": false },
      "react-native": "./evil.js",
      svelte: "./evil.js",
      "jsnext:main": "./evil.js",
      es2015: "./evil.js",
      esnext: "./evil.js",
      source: "./evil.js",
      exports: { ".": { import: "./evil.js", default: "./index.js" }, "./*": "./*" },
    };
    const { text } = await pair(meta, meta);
    expect(text).not.toContain(marker);
  });

  test("a changed entry still shows only the file it now names", async () => {
    const { text } = await pair({ module: "./a.js", svelte: "./a.js" }, { module: "./a.js", svelte: "./evil.js" }, { "other.js": "steal_other()\n" });
    expect(text).toContain(marker);
    expect(text).not.toContain("steal_other()");
  });
});
