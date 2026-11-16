import { expect, test } from "bun:test";
import { prepass, type FileMap } from "../src/prepass.ts";

const enc = (s: string) => new TextEncoder().encode(s);
const files = (o: Record<string, string>): FileMap => new Map(Object.entries(o).map(([k, v]) => [k, enc(v)]));
const BS = "\\";
const NL = "\n";

// The backslash reading of a line must not copy or rescan the records main has read (the missing paths, the bins read, the marks, the
// script names): a body of n lines, each with a distinct missing path or escaped word, costs a number of set iterations that grows with n,
// not with n times the size of those records.
const body = (n: number): string => {
  const lines = ["node lib/a.js > out"];
  for (let i = 1; i <= n; i++) lines.push(i % 2 ? `node lib/missing${i}.js` : `node${BS} lib/f${i % 100}.js x${i}`);
  return lines.join(NL);
};
const fix = (n: number) => (v: string): Record<string, string> => {
  const o: Record<string, string> = {
    "package.json": JSON.stringify({ name: "p", version: v, scripts: { postinstall: body(n) } }),
    "lib/a.js": "console.log(1)\n",
  };
  for (let k = 0; k < 100; k++) o[`lib/f${k}.js`] = v === "1.0.0" ? "1;\n" : "2;\n";
  return o;
};
// Elements yielded by every Set iteration (spread, for-of, new Set(set)) while fn runs.
const iterations = (fn: () => void): number => {
  const proto = Set.prototype as unknown as Record<symbol | string, unknown>;
  const orig = proto[Symbol.iterator] as () => IterableIterator<unknown>;
  const origValues = proto.values;
  const origKeys = proto.keys;
  let n = 0;
  const wrapped = function (this: Set<unknown>) {
    const it = orig.call(this);
    return {
      next: () => {
        const r = it.next();
        if (!r.done) n++;
        return r;
      },
      [Symbol.iterator]() {
        return this;
      },
    };
  };
  proto[Symbol.iterator] = wrapped;
  proto.values = wrapped;
  proto.keys = wrapped;
  try {
    fn();
  } finally {
    proto[Symbol.iterator] = orig;
    proto.values = origValues;
    proto.keys = origKeys;
  }
  return n;
};
const held = (n: number) => {
  const f = fix(n);
  return prepass("npm", files(f("1.0.0")), files(f("1.0.1"))).hard.some((s) => s.kind === "install-script");
};
test("escaped lines among distinct missing paths read in a count of set iterations that grows linearly", () => {
  held(100);
  let h1 = false;
  let h2 = false;
  const a = iterations(() => { h1 = held(1000); });
  const b = iterations(() => { h2 = held(2000); });
  expect(h1).toBe(true);
  expect(h2).toBe(true);
  // linear: about 2x; the per-line copy of the missing paths: about 4x
  expect(b).toBeLessThan(a * 2.8);
});
