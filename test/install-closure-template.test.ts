import { describe, expect, test } from "bun:test";
import { installView, templatesQuoted } from "../src/install-closure.ts";

const enc = new TextEncoder();
const head = 'const cp = require("child_process");\nconst path = require("path");\nconst d = __dirname + "/docs";\n';
// The hook's text is `body`; docs/ is left out of the plain widen, so only a literal read of the hook reaches docs/evil.js.
const reaches = (body: string) => {
  const o = { "package.json": JSON.stringify({ name: "x", version: "1.0.0", scripts: { postinstall: "node hook.js" } }), "hook.js": `${head}${body}\n`, "docs/evil.js": "1;\n", "README.md": "x\n" };
  return installView(new Map(Object.entries(o).map(([k, v]) => [k, enc.encode(v)]))).files.includes("docs/evil.js");
};
const T = "`";

describe("a template literal with no ${} names a file as a quoted string does", () => {
  test.each([
    `cp.spawnSync("node", [${T}./docs/evil.js${T}]);`,
    `cp.spawnSync(${T}node${T}, [${T}./docs/evil.js${T}]);`,
    `cp.execSync(${T}node ./docs/evil.js${T});`,
    `cp.execFileSync("node", [${T}docs/evil.js${T}]);`,
    `cp.fork(${T}./docs/evil.js${T});`,
    `cp.spawnSync("sh", ["-c", ${T}node ./docs/evil.js${T}]);`,
    `cp.spawnSync("node", [path.join(d, ${T}evil${T})]);`,
    `cp.spawnSync("node", [${T}./docs/evil.js${T}], { stdio: ${T}inherit${T} });`,
    `const r = /"/; cp.spawnSync("node", [${T}./docs/evil.js${T}]);`,
    `const t = ${T}a\${1}b${T}; cp.spawnSync("node", [${T}./docs/evil.js${T}]);`,
    `cp.execSync(${T}node ./docs/evil.js "x"${T});`,
    `cp.spawnSync("sh", ["-c", ${T}node docs/evil.js 'a'${T}]);`,
    `cp.execSync(${T}node ./docs/evil.js #'${T});`,
    // Past the nesting cap the deep template is skipped, and a later template is still read.
    `const deep = ${(T + "${").repeat(33)}x${("}" + T).repeat(33)}; cp.spawnSync("node", [${T}./docs/evil.js${T}]);`,
  ])("%s: held", (body) => {
    expect(reaches(body)).toBe(true);
  });
  test("control: a template in a comment names nothing", () => {
    expect(reaches(`// cp.spawnSync("node", [${T}./docs/evil.js${T}]);`)).toBe(false);
    expect(reaches(`/* cp.execSync(${T}node ./docs/evil.js${T}); */`)).toBe(false);
  });
  test("the quoted text: only templates with no ${}, backslash or line break, in the quote the body lacks, same length", () => {
    expect(templatesQuoted(`f(${T}a b${T}, "x", ${T}c\${d}e${T});`)).toBe(`f("a b", "x", ${T}c\${d}e${T});`);
    expect(templatesQuoted(`x = ${T}a\${${T}in${T}}b${T};`)).toBe(`x = ${T}a\${"in"}b${T};`);
    expect(templatesQuoted(`x = ${T}a\\nb${T} + ${T}l\nm${T} + ${T}q"'${T};`)).toBeUndefined();
    expect(templatesQuoted(`x = ${T}q"${T} + ${T}r'${T};`)).toBe(`x = 'q"' + "r'";`);
    expect(templatesQuoted(`// ${T}a${T}\nx = "${T}b${T}";`)).toBeUndefined();
    expect(templatesQuoted("x = 1;")).toBeUndefined();
    // Past the nesting cap a template is skipped to its next backtick, and a later template is still found.
    const deep = `${(T + "${").repeat(40)}x${("}" + T).repeat(40)}`;
    expect(templatesQuoted(`${deep}; f(${T}a${T});`)?.endsWith(`; f("a");`)).toBe(true);
  });
});
