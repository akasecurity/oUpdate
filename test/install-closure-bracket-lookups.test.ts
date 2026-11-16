import { expect, test } from "bun:test";
import { bracketLookupCount } from "../src/install-closure.ts";
import { prepass, type FileMap } from "../src/prepass.ts";

const enc = (s: string) => new TextEncoder().encode(s);
const release = (v: string, hook: string): FileMap =>
  new Map(
    Object.entries({
      "package.json": JSON.stringify({ name: "p", version: v, scripts: { postinstall: "node lib/hook.js" } }),
      "lib/hook.js": hook,
      "docs/payload.txt": `payload ${v}\n`,
    }).map(([k, t]) => [k, enc(t)]),
  );

// A scan asks for its text's bracket index; the lookup compares the text, so a lookup per match makes the scan quadratic. The count of
// lookups must not grow with the number of matches, and the answer is the one main gives (what the release holds).
const HOLD = [{ kind: "install-script", path: "package.json", detail: "file docs/payload.txt" }];
const run = (unit: string, n: number): { lookups: number; hard: unknown } => {
  const hook = unit.repeat(n);
  const before = bracketLookupCount();
  const hard = prepass("npm", release("1.0.0", hook), release("1.0.1", hook)).hard;
  return { lookups: bracketLookupCount() - before, hard };
};
const shapes: [string, string, unknown][] = [
  ["a process alias with a template write", "const q = process.env; q.A = `x${1}`;\n", HOLD],
  ["a process rebinding with a template", "const p = process; p = `x`;\n", HOLD],
  ["an indexed process.env copy written by index", "q = process.env[a]; q[0] = `x${1}`;\n", []],
  ["an indexed process.env chain", "process.env[a][b] = `x`;\n", HOLD],
  ["a computed key in an object literal", "const o = { [k]: 1 };\n", []],
  ["a constructor key in an object literal", "const o = { constructor: 1 };\n", []],
  ["pin: a constructor key in a destructuring pattern", "const { constructor: c } = o;\n", HOLD],
];
for (const [name, unit, hard] of shapes) {
  test(`${name} costs the same bracket lookups at ten times the matches`, () => {
    const small = run(unit, 100);
    const large = run(unit, 1000);
    expect(small.hard).toEqual(hard);
    expect(large.hard).toEqual(hard);
    expect(small.lookups).toBeGreaterThan(0);
    expect(large.lookups - small.lookups).toBeLessThanOrEqual(small.lookups);
  });
}
