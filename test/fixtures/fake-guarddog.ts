// Stands in for the sandboxed GuardDog: argv <eco> <dir> [mode]. Reports one
// finding per file under dir whose text contains "eval(", in GuardDog's JSON shape.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const [eco, dir, mode] = process.argv.slice(2);
if (mode === "fail") {
  console.error("boom");
  process.exit(3);
}
if (mode === "hang") await new Promise((r) => setTimeout(r, 60_000));
const hits: { location: string; code: string; match: string; message: string }[] = [];
const walk = (d: string) => {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (readFileSync(p, "utf8").includes("eval(")) hits.push({ location: `${relative(dir!, p)}:1`, code: "eval(x)", match: "eval(", message: `eval in ${eco}` });
  }
};
walk(dir!);
console.error("Network error: cache refresh skipped");
console.log(JSON.stringify({ package: "/scan", results: { "threat-runtime-eval": hits, "capability-filesystem-read": {} }, errors: {} }));
