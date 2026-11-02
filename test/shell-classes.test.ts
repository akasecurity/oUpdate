import { describe, expect, test } from "bun:test";
import { flagBody, LIMITS, MAX_LEN, type ClassName } from "../src/shell-classes.ts";
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

  test("an unclosed quote, backtick or paren reports nothing, an unterminated heredoc reports", () => {
    for (const c of ["node -r ./p.js 'a", "node -r ./p.js $(", "node -r ./p.js `a", "node -r ./p.js \"a", "echo a(b)", "node -p \\\"require('x').targets\\\""]) expect(classes(c), c).toEqual([]);
    expect(classes("sh <<")).toEqual(["heredoc"]);
  });

  test("structure the parser reads: case, functions, $'..', process substitution, stray parens", () => {
    const P = "node -r ./p.js a.js";
    for (const c of [`case x in *) ${P};; esac`, `case x in (a|b) ${P};; esac`, `f() { ${P}; }; f`, `function f { ${P}; }; f`, `function f() { ${P}; }`, `${P}; echo $'x\\'y'`, `${P}; : <(true)`, `: >(cat); ${P}`, `if true; then ${P}; fi`, `for i in a b; do ${P}; done`]) {
      expect(classes(c), c).toEqual(["interp-flag"]);
    }
    expect(classes("case x in *) node a.js;; esac")).toEqual([]);
  });

  test("a parse that gives up for structure fails closed with a named reason", () => {
    for (const c of [`echo $(echo $(echo $(echo $(echo $(node -r ./p.js a.js)))))`, "echo hi \\", "echo >"]) {
      expect(classes(c), c).toEqual(["unparsed"]);
    }
    expect(classes("echo $(echo $(echo $(echo $(node a.js))))")).toEqual([]); // depth 4 still reads
    const saved = LIMITS.fuel;
    try {
      LIMITS.fuel = 50;
      const hits = flagBody("echo " + "a ".repeat(100));
      expect(hits.map((h) => h.cls)).toEqual(["unparsed"]);
      expect(hits[0]!.why).toContain("budget");
    } finally { LIMITS.fuel = saved; }
  });

  test("many heredoc openers do not rescan: each search starts after the last terminator", () => {
    const t = performance.now();
    expect(classes("cat " + "<<E ".repeat(100) + "\n" + "\n".repeat(5000) + "E\n")).toEqual(["heredoc"]); // 100 openers, one terminator
    expect(classes("cat <<E\n".repeat(100) + "\n".repeat(5000) + "E\n")).toEqual([]); // one heredoc whose body holds the rest
    expect(classes("cat <<E <<E\na\nE\nb\nE\n")).toEqual([]);
    expect(performance.now() - t).toBeLessThan(100);
  });

  test("a heredoc, here-string or redirect into an interpreter with a flag", () => {
    for (const c of ["node --no-warnings <<E\nx\nE\n", "python3 -u <<E\nprint(1)\nE\n", "node --input-type=module <<< 'x'"]) expect(classes(c), c).toEqual(["heredoc"]);
    expect(classes("node --no-warnings < x.js")).toEqual(["interp-stdin"]);
    for (const c of ["node --version", "python3 --version", "node -e 1 < /dev/null", "node -v"]) expect(classes(c), c).toEqual([]);
  });

  test("clustered shell flags: -ec, -xc, -lc, -c --", () => {
    const P = "node -r ./p.js a.js";
    for (const c of [`bash -ec '${P}'`, `sh -xc '${P}'`, `bash -lc '${P}'`, `sh -c -- '${P}'`, `sh -c -e '${P}'`, `bash -o pipefail -c '${P}'`, `bash -c -o pipefail '${P}'`]) {
      expect(classes(c), c).toEqual(["interp-flag"]);
    }
    expect(classes("bash -ec 'echo hi'")).toEqual([]);
  });

  test("a cd and a written file carry into nested bodies", () => {
    expect(classes("cd sub && sh -c 'node a.js'")).toEqual(["cd-relative"]);
    expect(classes("cd sub && echo $(node a.js)")).toEqual(["cd-relative"]);
    expect(classes("cat t > b.js && sh -c 'node b.js'")).toEqual(["writer-exec"]);
    expect(classes("cat t > b.js && bash -lc 'node b.js'")).toEqual(["writer-exec"]);
    expect(classes("(cat t > b.js) && node b.js")).toEqual(["writer-exec"]);
    expect(classes("(cd sub) && sh -c 'node a.js'")).toEqual([]); // a cd inside a subshell does not leave it
    expect(classes("sh -c 'cd sub' && node a.js")).toEqual([]);
  });

  test("wrappers with option arguments", () => {
    const P = "node -r ./p.js a.js";
    for (const c of [`nice -n 5 ${P}`, `nice -5 ${P}`, `timeout -s KILL 10 ${P}`, `timeout 10 ${P}`, `timeout -k 5 -s TERM 10 ${P}`, `sudo -u root ${P}`, `sudo -E -u root -g wheel ${P}`, `env -u X ${P}`, `env -i A=1 ${P}`, `env -S '${P}'`, `xargs ${P}`, `xargs -n 1 -I{} ${P}`, `stdbuf -o0 ${P}`, `stdbuf -o L ${P}`, `setsid ${P}`, `arch -arm64 ${P}`, `builtin command nohup ${P}`, `ionice -c 3 ${P}`, `time -o t.log ${P}`, `exec -a x ${P}`, `nohup nice -n 5 timeout 9 ${P}`]) {
      expect(classes(c), c).toEqual(["interp-flag"]);
    }
    expect(classes("env -u X NODE_OPTIONS=--require=./p.js node a.js")).toEqual(["env-assign"]);
    expect(classes("env -C sub node a.js")).toEqual(["cd-relative"]);
    expect(classes("env --chdir=sub node a.js")).toEqual(["cd-relative"]);
    for (const c of ["nice -n 5 node a.js", "timeout -s KILL 10 node a.js", "sudo -u root node a.js", "xargs -n 1 echo"]) expect(classes(c), c).toEqual([]);
  });

  test("clustered interpreter flags", () => {
    for (const c of ["python3 -Bm pkg", "python3 -m pkg", "perl -wMFoo a.pl", "perl -wI lib a.pl", "ruby -wrfoo a.rb", "ruby -I lib a.rb"]) expect(classes(c), c).toEqual(["interp-flag"]);
    for (const c of ["python3 -Bu a.py", "perl -w a.pl", "ruby -w a.rb", "python3 -Bc 'print(1)'"]) expect(classes(c), c).toEqual([]);
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

  test("a backslash or a variable in a flag, and a double-quoted -c string with $ or a backslash", () => {
    const P = "node -r ./p.js a.js";
    for (const c of ["node \\-r ./p.js a.js", "node $F a.js", "node ${F} a.js", "node $@ a.js", 'sh -c "node -r ./p.js a.js; echo \\$HOME"', 'sh -c "node -r ./p.js a.js; echo $HOME"', `sh -c "${P}; echo $(date)"`]) {
      expect(classes(c), c).toContain("interp-flag");
    }
    // a lone variable is the script, and a variable inside a longer word is not a flag
    for (const c of ["node $npm_package_config_bin", 'node "$X"', "node $DIR/a.js", "node a.js $F"]) expect(classes(c), c).toEqual([]);
  });

  test("heredoc bodies: $(..) spans, apostrophes, multi-line spans, arithmetic", () => {
    const P = "node -r ./p.js a.js";
    for (const c of [`cat <<E\nit's $(${P})\nE\n`, `cat <<E\n$(echo a\n${P})\nE\n`, `cat <<E\nx \`${P}\`\nE\n`, `cat <<-E\n\tit's $(${P}) and "q"\n\tE\n`, `echo $((1+$(${P})))`, `echo $[1+$(${P})]`, `cat <<E\n$((1+$(${P})))\nE\n`]) {
      expect(classes(c), c).toEqual(["interp-flag"]);
    }
    expect(classes("cat <<'E'\nit's $(node -r ./p.js a.js)\nE\n")).toEqual([]);
    expect(classes("cat <<E\nit's fine\nE\n")).toEqual([]);
    expect(classes("cat <<E\n$(node a.js\nE\n")).toEqual([]); // unclosed span: nothing to read
  });

  test("a backslash-escaped double quote inside a delimiter or a redirect target", () => {
    const P = "node -r ./p.js a.js";
    expect(classes(`cat > "a\\"b" && ${P}`)).toEqual(["interp-flag"]);
    expect(classes(`cat <<"E\\"OF"\nx\nE"OF\n; ${P}`)).toEqual(["interp-flag"]);
    expect(classes(`cat t > "a\\"b.js" && node 'a"b.js'`)).toEqual(["writer-exec"]);
  });

  test("interpreter flags with a separate value", () => {
    const P = "./p.js a.js";
    for (const c of [`python3 -W ignore -m pkg`, `python3 -X dev -m pkg`, `node --title foo -r ${P}`, `node -C dev -r ${P}`, `ruby -E utf-8 -r ./x a.rb`, `node --input-type module --require ${P}`, "php -d x=1 -f a.php", "deno run --config c.json a.ts", "node --test", "node --run setup"]) {
      expect(classes(c), c).toEqual(["interp-flag"]);
    }
    for (const c of ["node --title foo a.js", "python3 -W ignore a.py", "ruby -E utf-8 a.rb", "deno run a.ts", "deno eval 1", "deno task x", "node --input-type module a.js"]) expect(classes(c), c).toEqual([]);
    // the value of -r is not the script: a cd moves the script
    expect(classes("cd sub && node -r ./p.js a.js")).toEqual(["cd-relative", "interp-flag"]);
  });

  test("a file fetched or sourced, then run", () => {
    for (const c of ["curl -o b.js u && node b.js", "curl -ob.js u && node b.js", "curl --output b.js u && node b.js", "curl --output=b.js u; node b.js", "wget -O b.js u && node b.js", "wget -Ob.js u && node b.js", "wget --output-document=b.js u && node b.js", "cat t > r.sh && . ./r.sh", "cat t > r.sh && source r.sh"]) {
      expect(classes(c), c).toEqual(["writer-exec"]);
    }
    expect(classes("curl -s u | tar x && node a.js")).toEqual([]);
    expect(classes("node b.js > b.js")).toEqual([]); // the redirect empties b.js before node runs
    expect(classes("cat t > b.js; node b.js > b.js")).toEqual(["writer-exec"]);
  });

  test("more assignments that load code", () => {
    for (const c of ["BASH_ENV=./x.sh sh a.sh", "PERL5OPT=-Mx perl a.pl", "RUBYOPT=-rx ruby a.rb", "PYTHONPATH=. python3 a.py", "PYTHONSTARTUP=x python3 a.py", "NODE_PATH=. node a.js", "LD_PRELOAD=./x.so node a.js", "DYLD_INSERT_LIBRARIES=./x.dylib node a.js", "env PERL5LIB=. perl a.pl", "export LD_PRELOAD=./x.so"]) {
      expect(classes(c), c).toEqual(["env-assign"]);
    }
    expect(classes("PATH=$PATH:bin node a.js")).toEqual([]);
  });

  test("program files with attached values, and sed commands that run", () => {
    for (const c of ["make -fMk", "make -kf Mk", "sed -fp.sed x", "sed -nfp.sed x", "awk -fp.awk x", "sed '1e id' x", "sed 'e' x", "sed -e '$e id' x", "sed 's/a/b/e' x", "sed -n '/x/e echo'", "sed 's#a#b#ge' x"]) {
      expect(classes(c), c).toEqual(["program-file"]);
    }
    for (const c of ["sed 's/a/b/g' x", "sed -n '1p' x", "sed 's/e/f/' x", "sed '/e/d' x", "awk -F: '{print $1}' x", "make -j4"]) expect(classes(c), c).toEqual([]);
  });

  test("no false hold: a pipe then a newline, CRLF heredocs, $[..], ((..))", () => {
    for (const c of ["echo x |\nsh", "echo x | \n  sh", "cat <<E\r\nhi\r\nE\r\n", "echo $[1<<2]", "echo $((1<<2))", "((x=1<<2)); node a.js", "(( i = 1 << 2 ))"]) expect(classes(c), c).toEqual([]);
    expect(classes("cat <<E\r\nhi\r\n")).toEqual(["heredoc"]); // still unterminated
    expect(classes("sh <<E\r\nx\r\nE\r\n")).toEqual(["heredoc"]);
    expect(classes("((x=1<<2)); sh")).toEqual(["interp-stdin"]);
    expect(classes("((x=$(sh -c 'cd a && node b.js')))")).toEqual(["cd-relative"]);
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
