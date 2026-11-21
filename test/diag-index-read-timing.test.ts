import { test } from "bun:test";
import os from "node:os";
import * as HEAD from "../src/install-closure.ts";
import * as MAIN from "./vendor-main-install-closure.ts";

// Diagnostic only, not for merge: prints best-of-3 milliseconds per size and shape for the entry points of the scanner, for the
// current source (head) and for the previous main copied beside this file, plus the key read on its own and the literal-key reader.
const fastest = (f: () => unknown) => {
  let best = Infinity;
  for (let i = 0; i < 3; i++) {
    const t = performance.now();
    f();
    best = Math.min(best, performance.now() - t);
  }
  return best;
};
const SHAPES: [string, (n: number) => string][] = [
  ["a run of $word", (n) => "x[`" + "$a".repeat(n / 2) + "`]"],
  ["a run of $ in a piece", (n) => "x[`" + "$".repeat(n) + "`]"],
  ["a run of ${word} holes", (n) => "x[`" + '${"a"}'.repeat(n / 6) + "`]"],
  ["a run of escaped holes", (n) => "x[`" + '${"\\\\"}'.repeat(n / 7) + "`]"],
];
const f1 = (x: number) => x.toFixed(1).padStart(8);
test("diag: timing of the index read", () => {
  console.log(`DIAG ${process.platform} ${process.arch} bun ${Bun.version} ${os.cpus().length} cpus ${os.cpus()[0]?.model ?? ""}`);
  console.log("DIAG shape | size | head: dangerousStringUse processHazard provablyStatic indexKeyUse pureLiteralKey(narrow) pureLiteralKey(wide) | main: processHazard provablyStatic");
  for (const [name, build] of SHAPES) {
    for (const n of [65_536, 131_072, 262_144, 524_288]) {
      const src = build(n);
      const key = src.slice(2, -1); // the text between the brackets
      const row = [
        fastest(() => HEAD.dangerousStringUse(src)),
        fastest(() => HEAD.processHazard(src)),
        fastest(() => HEAD.provablyStatic(src)),
        fastest(() => HEAD.indexKeyUse(src)),
        fastest(() => HEAD.pureLiteralKey(key, false)),
        fastest(() => HEAD.pureLiteralKey(key, true)),
        fastest(() => MAIN.processHazard(src)),
        fastest(() => MAIN.provablyStatic(src)),
      ];
      console.log(`DIAG ${name} | ${n} |${row.map(f1).join("")}`);
    }
  }
}, 600_000);
