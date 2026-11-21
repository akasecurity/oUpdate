// Run by install-closure-scanner-gaps.test.ts in a fresh bun process (one per shape), so the timings are not those of a process that already
// holds the heap of a whole test run. Prints the best-of-3 milliseconds of the key read and of provablyStatic as JSON.
import * as IC from "../src/install-closure.ts";

export const SHAPES: [string, (n: number) => string][] = [
  ["a run of $word", (n) => "x[`" + "$a".repeat(n / 2) + "`]"],
  ["a run of $ in a piece", (n) => "x[`" + "$".repeat(n) + "`]"],
  ["a run of ${word} holes", (n) => "x[`" + '${"a"}'.repeat(n / 6) + "`]"],
  ["a run of escaped holes", (n) => "x[`" + '${"\\\\"}'.repeat(n / 7) + "`]"],
  ["nested index brackets", (n) => "a[".repeat(n / 2) + "]".repeat(n / 2)],
  ["nested brackets that start with a string", (n) => 'a["x"+'.repeat(n / 6) + "b" + "]".repeat(n / 6)],
  ["many short indexes", (n) => 'a["b"+c];'.repeat(n / 9)],
  ["60,000 short indexes", () => 'a["b"+c];'.repeat(60_000)],
  ["60,000 nested closes", () => "a[".repeat(60_000) + "]".repeat(60_000)],
  ["60,000 nested closes with a piece in each", () => 'a["constr"+'.repeat(60_000) + "b" + "]".repeat(60_000)],
  ["60,000 sibling closes", () => "a[0]".repeat(60_000)],
  ["60,000 sibling closes with calls", () => 'a[f("x")]'.repeat(60_000)],
  ["an opener run", (n) => "x[" + '"['.repeat(n / 2)],
];
const key = (src: string) => IC.dangerousStringUse(src) || IC.processHazard(src);
const stat = (src: string) => IC.provablyStatic(src);
const fastest = (f: () => unknown) => {
  let best = Infinity;
  for (let i = 0; i < 3; i++) {
    const t = performance.now();
    f();
    best = Math.min(best, performance.now() - t);
  }
  return best;
};
const once = (src: string) => {
  const time = (f: () => unknown) => {
    const t0 = performance.now();
    f();
    return performance.now() - t0;
  };
  return { key: time(() => key(src)), stat: time(() => stat(src)) };
};
const both = (src: string) => ({ key: fastest(() => key(src)), stat: fastest(() => stat(src)) });

if (import.meta.main) {
  const build = SHAPES.find(([name]) => name === process.argv[2])?.[1];
  if (!build) throw new Error(`no shape ${process.argv[2]}`);
  if (process.argv[2]!.startsWith("60,000")) {
    const src = build(0);
    console.log(JSON.stringify({ src: both(src), plain: both("a[0];".repeat(Math.ceil(src.length / 5))) }));
  } else {
    // Two sizes, both past the step that some shapes have between 131,072 and 262,144 characters; the two template runs that are the slowest
    // shapes also get 5 MB (one run each).
    const big = process.argv[2]!.startsWith("a run of $") && !process.argv[2]!.includes("holes");
    const large = build(524_288);
    console.log(JSON.stringify({ small: both(build(262_144)), large: both(large), ...(big ? { mb5: once(build(5_242_880)) } : {}) }));
  }
}
