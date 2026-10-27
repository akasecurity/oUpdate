#!/usr/bin/env bun
// Writes the good and bad sides of each acceptance item as plain directory
// trees (acceptance-work/<id>/tree-good, tree-bad), so other static scanners
// can read them. Bytes are written, never run. Run after acceptance/run.ts.
//
// usage: bun acceptance/extract.ts [--work <dir>]

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { readArtifact, isUnsafeMember } from "../src/artifact.ts";
import { readSample } from "../src/dataset.ts";
import type { Ecosystem, FileMap } from "../src/prepass.ts";

const i = process.argv.indexOf("--work");
const work = resolve(i >= 0 ? process.argv[i + 1]! : "acceptance-work");
// readSample needs each case's ecosystem (the npm package/ layout applies to npm samples only).
const ecoOf = new Map((JSON.parse(readFileSync(join(import.meta.dir, "cases.json"), "utf8")) as { id: string; eco: Ecosystem }[]).map((c) => [c.id, c.eco]));
function ecoFor(id: string): Ecosystem {
  const eco = ecoOf.get(id);
  if (!eco) throw new Error(`${id} is not in cases.json`);
  return eco;
}

function writeTree(dir: string, files: FileMap) {
  for (const [p, b] of files) {
    if (isUnsafeMember(p)) throw new Error(`unsafe path ${p}`);
    const t = join(dir, p);
    mkdirSync(dirname(t), { recursive: true });
    writeFileSync(t, b, { mode: 0o644 });
  }
}

for (const id of readdirSync(work)) {
  try {
  for (const side of ["good", "bad"] as const) {
    const d = join(work, id, side);
    if (!existsSync(d)) continue;
    const f = readdirSync(d).map((x) => join(d, x))[0];
    if (!f) continue;
    const files = id.startsWith("control-") || side === "good" ? await readArtifact(f) : await readSample(f, "infected", ecoFor(id));
    writeTree(join(work, id, `tree-${side}`), files);
  }
  console.log(`extracted ${id}`);
  } catch (e) {
    console.log(`extract failed ${id}: ${e instanceof Error ? e.message : String(e)}`);
  }
}
