import { describe, expect, test } from "bun:test";
import { flagBody, MAX_LEN, type ClassName } from "../src/shell-classes.ts";
import { prepass, type FileMap } from "../src/prepass.ts";

const classes = (body: string): ClassName[] => [...new Set(flagBody(body).map((h) => h.cls))].sort();
const enc = new TextEncoder();
const map = (f: Record<string, string>): FileMap => new Map(Object.entries(f).map(([k, v]) => [k, enc.encode(v)]));
// A hook body, a changed file the hook does not name, and whether the scan holds on it.
function held(cmd: string): boolean {
  const pj = JSON.stringify({ name: "x", version: "1", scripts: { postinstall: cmd } });
  const base = { "package.json": pj, "lib/setup.js": "1", "x.sh": "echo hi\n" };
  const h = prepass("npm", map(base), map({ ...base, "lib/setup.js": "evil()" })).hard.filter((s) => s.kind === "install-script");
  return h.length > 0;
}

describe("shell classes", () => {
  test("interpreter flags that load other code", () => {
    for (const c of ["node --loader ./l.mjs a.js", "node -r ./p.js a.js", "node --require=./p.js a.js", "node --import ./p.mjs a.js", "node --env-file .env a.js", "node --run setup", "python3 -m pkg.mod", "python3 -mpkg", "ruby -r ./x a.rb", "perl -MX a.pl", "php -f x.php", "bash --rcfile x.sh x.sh", "bash --init-file x.sh x.sh", "env FOO=1 node -r ./p.js a.js"]) {
      expect(classes(c), c).toEqual(["interp-flag"]);
    }
    for (const c of ["node a.js", "node --no-warnings a.js", "node -e 1", "node -p 1", "node --eval 1", "python3 -c 'print(1)'", "perl -e 'print 1'", "ruby -e 'p 1'", "python3 -u a.py", "sh -e a.sh", "bash a.sh -s -c"]) {
      expect(classes(c), c).toEqual([]);
    }
  });

  test("a program read from stdin", () => {
    for (const c of ["sh", "node -", "bash -s", "bash -s a.sh", "python3", "perl < x.pl", "sh < x.sh", "node 0<x.js", "sh -s -- x"]) expect(classes(c), c).toEqual(["interp-stdin"]);
    // a pipeline sink is read by the existing scan, not here
    for (const c of ["echo hi | sh", "cat x.sh | sh", "echo hi | python3 -c 'print(1)'"]) expect(classes(c), c).toEqual([]);
  });

  test("heredoc and here-string forms", () => {
    expect(classes("sh <<EOF\nnode a.js\nEOF\n")).toEqual(["heredoc"]);
    expect(classes("sh <<-'EOF'\n\tnode a.js\n\tEOF\n")).toEqual(["heredoc"]);
    expect(classes('sh <<"E"\nx\nE\n')).toEqual(["heredoc"]);
    expect(classes("sh <<< 'node a.js'")).toEqual(["heredoc"]);
    expect(classes("python3 <<EOF\nprint(1)\nEOF\n")).toEqual(["heredoc"]);
    expect(classes("node <<EOF\nx\n")).toEqual(["heredoc"]); // no terminator
    expect(classes("cat <<EOF\nhi\nEOF\n")).toEqual([]);
    expect(classes("cat <<EOF\n$(sh)\nEOF\n")).toEqual(["interp-stdin"]);
    expect(classes("cat <<'EOF'\n$(sh)\nEOF\n")).toEqual([]); // quoted delimiter: no expansion
    expect(classes("cat <<EOF\nhi\nEOF  \n")).toEqual(["heredoc"]); // a delimiter line with trailing blanks is not the end
  });

  test("a relative script after cd", () => {
    for (const c of ["cd sub && node a.js", "cd sub; sh run.sh", "pushd sub && ./run.sh", "cd .. && python3 a.py", "cd sub\nbash a.sh", "(cd sub && node a.js)"]) expect(classes(c), c).toEqual(["cd-relative"]);
    for (const c of ["cd sub && echo hi", "node a.js && cd sub", "cd sub && node /abs/a.js", "(cd sub) && node a.js"]) expect(classes(c), c).toEqual([]);
  });

  test("a file written or copied, then run", () => {
    for (const c of ["cat t > b.js && node b.js", "cp t.js b.js && node ./b.js", "mv t.js b.js; sh b.js", "echo x | tee run.sh; sh run.sh", "cat t >> ./r && ./r", "ln -s t b.js && node b.js"]) expect(classes(c), c).toEqual(["writer-exec"]);
    for (const c of ["cp t.js b.js && node a.js", "tar -xf v.tgz && node install.js", "node build.js 2>&1 | tee log.txt", "echo x > /dev/null && node a.js"]) expect(classes(c), c).toEqual([]);
  });

  test("a program held in a file", () => {
    for (const c of ["sed -f p.sed x", "sed -nf p.sed x", "awk -f p.awk x", "awk 'BEGIN{system(\"id\")}'", "make -f Mk", "make --file=Mk"]) expect(classes(c), c).toEqual(["program-file"]);
    for (const c of ["sed s/a/b/ x", "sed -i s/a/b/ x", "awk '{print $1}' x", "make", "make build"]) expect(classes(c), c).toEqual([]);
  });

  test("NODE_OPTIONS and npm_config_* assignments", () => {
    for (const c of ["NODE_OPTIONS=--require=./p.js node a.js", "npm_config_registry=http://x npm i", "env NODE_OPTIONS=-r./p node a.js", "export NODE_OPTIONS=-r./p", "NPM_CONFIG_X=1 npm run b", "FOO=1 npm_config_y=2 true", "sudo -E NODE_OPTIONS=x node a.js"]) {
      expect(classes(c), c).toEqual(["env-assign"]);
    }
    for (const c of ["FOO=1 node a.js", "export FOO=1", "env FOO=1 node a.js", "echo NODE_OPTIONS=x"]) expect(classes(c), c).toEqual([]);
  });

  test("nested bodies are read", () => {
    expect(classes("sh -c 'cd sub && node a.js'")).toEqual(["cd-relative"]);
    expect(classes("echo $(node -r ./p.js a.js)")).toEqual(["interp-flag"]);
    expect(classes("echo `make -f Mk`")).toEqual(["program-file"]);
    expect(classes('echo "$(sed -f p x)"')).toEqual(["program-file"]);
    expect(classes("(node -r ./p.js a.js)")).toEqual(["interp-flag"]);
  });

  test("a body it cannot parse reports nothing, an unterminated heredoc reports", () => {
    for (const c of ["node -r ./p.js 'a", "node -r ./p.js $(", "node -r ./p.js )", "node <(x) -r ./p.js", "node -r ./p.js \\"]) expect(classes(c), c).toEqual([]);
    expect(classes("sh <<")).toEqual(["heredoc"]);
  });

  test("a body over the character cap fails closed", () => {
    const long = "node a.js; " + "echo hi; ".repeat(MAX_LEN / 9);
    expect(long.length).toBeGreaterThan(MAX_LEN);
    expect(flagBody(long).map((h) => h.cls)).toEqual(["over-cap"]);
    expect(flagBody(long)[0]!.why).toContain(String(MAX_LEN));
    expect(flagBody("a".repeat(MAX_LEN))).toEqual([]);
    expect(classes("echo $(" + "a".repeat(MAX_LEN) + ")")).toEqual(["over-cap"]);
    expect(held(long)).toBe(true);
    expect(held("node a.js")).toBe(false);
  });

  test("integration: a flagged body reads files the hook does not name", () => {
    for (const c of ["node --loader ./l.mjs lib/other.js", "node -r ./nope.js a.js", "python3 -m pkg", "sh <<EOF\nnode a.js\nEOF", "cd sub && node a.js", "cat t > b.js && node b.js", "sed -f p.sed x", "NODE_OPTIONS=--require=./p.js node a.js"]) {
      expect(held(c), c).toBe(true);
    }
    for (const c of ["node a.js", "node -e 1", "node a.js && echo hi"]) expect(held(c), c).toBe(false);
  });
});

describe("shell classes: bounded work", () => {
  const rep = (s: string, n: number) => s.repeat(n);
  const inputs: [string, string][] = [
    ["quotes", rep("'", MAX_LEN - 1)],
    ["dollar parens", rep("$(", MAX_LEN / 2 - 1)],
    ["heredocs", rep("cat <<E\n", MAX_LEN / 8 - 1)],
    ["parens", rep("(", MAX_LEN - 1)],
    ["backticks", rep("`", MAX_LEN - 1)],
    ["nested subshell", rep("sh -c '", 400) + "x" + rep("'", 400)],
    ["many stages", rep("node a.js | ", MAX_LEN / 12 - 1) + "sh"],
    ["many redirects", rep("cat >a ", MAX_LEN / 7 - 1)],
    ["long word", "node " + rep("a", MAX_LEN - 10)],
    ["unterminated heredoc lines", "sh <<E\n" + rep("x\n", MAX_LEN / 2 - 10)],
    ["escapes", rep("\\ ", MAX_LEN / 2 - 1)],
    ["braces", rep("${", MAX_LEN / 2 - 1)],
    ["over the cap", rep("node a.js;", MAX_LEN)],
    ["double quotes with dollars", '"' + rep("$(", MAX_LEN / 2 - 3) + '"'],
  ];
  for (const [name, input] of inputs) {
    test(`${name}: under 100 ms`, () => {
      const t = performance.now();
      flagBody(input);
      expect(performance.now() - t).toBeLessThan(100);
    });
  }

  test("random inputs finish under 100 ms each and do not throw", () => {
    const alphabet = ["'", '"', "`", "$(", ")", "(", "<<", "<<-", "<<<", ">", "|", "&", ";", "\n", "\\", " ", "sh", "node", "-r", "cd", "EOF", "x", "${", "}", "-c"];
    let seed = 12345;
    const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
    for (let i = 0; i < 400; i++) {
      let s = "";
      for (let k = rnd(60); k > 0; k--) s += alphabet[rnd(alphabet.length)];
      const t = performance.now();
      expect(() => flagBody(s)).not.toThrow();
      expect(performance.now() - t, JSON.stringify(s)).toBeLessThan(100);
    }
  });
});
