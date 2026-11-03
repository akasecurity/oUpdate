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
    for (const c of ["node --loader ./l.mjs a.js", "node -r ./p.js a.js", "node --require=./p.js a.js", "node --import ./p.mjs a.js", "node --env-file .env a.js", "node --run setup", "python3 -m pkg.mod", "python3 -mpkg", "ruby -r ./x a.rb", "perl -MX a.pl", "bash --rcfile x.sh x.sh", "bash --init-file x.sh x.sh", "env FOO=1 node -r ./p.js a.js"]) {
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
    expect(performance.now() - t).toBeLessThan(1000);
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
    for (const c of [`python3 -W ignore -m pkg`, `python3 -X dev -m pkg`, `node --title foo -r ${P}`, `node -C dev -r ${P}`, `ruby -E utf-8 -r ./x a.rb`, `node --input-type module --require ${P}`, "deno run --config c.json a.ts", "node --test", "node --run setup"]) {
      expect(classes(c), c).toEqual(["interp-flag"]);
    }
    for (const c of ["node --title foo a.js", "python3 -W ignore a.py", "ruby -E utf-8 a.rb", "deno run a.ts", "deno eval 1", "deno task x", "node --input-type module a.js", "php -d x=1 -f a.php"]) expect(classes(c), c).toEqual([]);
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
    for (const c of [`arr=(x y); ${P}`, `arr=($(echo x)); ${P}`, `[[ a =~ (a) ]] && ${P}`, `[[ -n $(true) ]] && ${P}`, `if [[ a == b* ]]; then ${P}; fi`, `echo $(true # it's\n); ${P}`, `echo $(cat <<E\nit's\nE\n); ${P}`, `echo $(cat <<-'E'\n\tit's\n\tE\n); ${P}`, `echo "x\\"y"; ${P}`, `echo "a \\" b" && ${P}`]) {
      expect(classes(c), c).toEqual(["interp-flag"]);
    }
    // a redirect target built by a substitution is a write to a name the body cannot tell
    for (const c of [`${P} > $(echo log)`, `${P} > \`echo log\``, `${P} 2> "$(echo log)"`]) expect(classes(c), c).toEqual(["interp-flag", "writer-exec"]);
    expect(classes("arr=($(sh -c 'cd a && node b.js'))")).toEqual(["cd-relative"]);
    expect(classes("[[ $(sh -c 'cd a && node b.js') ]]")).toEqual(["cd-relative"]);
    expect(classes("echo > $(sh -c 'cd a && node b.js')")).toEqual(["cd-relative", "writer-exec"]);
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
    expect(classes('echo > "$(node -r ./p.js a.js)"')).toEqual(["interp-flag", "writer-exec"]);
    expect(classes('echo >& "$(node -r ./p.js a.js)"')).toEqual(["interp-flag", "writer-exec"]);
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
    expect(performance.now() - t).toBeLessThan(1000);
  });
});

describe("shell classes: review of fcdb6a0", () => {
  const F: ClassName[] = ["interp-flag"];
  test("one budget for the whole call: a body of many unclosed quote lines fails closed and fast", () => {
    const t = performance.now();
    expect(classes("'" + "\n''".repeat(6600))).toEqual(["unparsed"]);
    expect(performance.now() - t).toBeLessThan(1000);
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
    for (const c of ["declare -a a=(1)", "local -a a=(1)", "export a=(1)", "time [[ a =~ (b) ]]", "[[ a == \" ]] \" ]]", "echo `echo \\`date\\``", "echo > $'a\\'b'", "echo $(# it's\ncat <<EOF\nx\nEOF\n)", "echo $( echo $(( 1 << 2 )) )", "case x in @(a)) echo;; esac", "cmd &>> log", "while read x; do :; done < <(cmd)", "echo > >(cmd)"]) {
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
    for (const c of ["sed -e's/x/id/e' f", "sed --expression='e id' f", "sed '1~2e id' f", "sed '/x/I e id' f", "sed '1,+2e id' f", "sed '" + "p;".repeat(2100) + "' f"]) expect(classes(c), c).toEqual(["program-file"]);
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

describe("shell classes: review of 1a768af", () => {
  const is = (want: ClassName[], cmds: string[]) => { for (const c of cmds) expect(classes(c), c).toEqual(want); };
  test("awk -F and -v values are not the program; sed custom-delimiter addresses", () => {
    is(["program-file"], ["awk -F : '{system($0)}' lib/cmds.txt > out", "sed '\\%.%e' lib/cmds.txt > out", "sed '\\,a,e' f", "sed '/a/,/b/ e id' f"]);
    is([], ["awk -F: '{print $1}' f", "awk -v x=1 '{print}' f", "sed 's/a/b/' f"]);
  });
  test("a tool variable that is $PWD or a substitution is inside the package or unknown", () => {
    is(["env-assign"], ["CC=$PWD/lib/x.sh node-gyp rebuild", "CC=${PWD}/x node-gyp", "CC=$(pwd)/lib/x.sh node-gyp rebuild"]);
    is([], ["CC=$HOME/x make", "CC=clang make"]);
  });
  test("npm's own variables as the command word are not computed commands", () => {
    is([], ["$npm_execpath run build", "${npm_execpath} run build", "${npm_package_config_cmd} x", '"$npm_node_execpath" a.js']);
    is(["computed-command"], ["$N run build", "${CMD} x"]);
  });
  test("python -Wmodule is not -m; php -f is the script; sed -ifoo is a suffix; the second sed operand is a file", () => {
    is([], ["python3 -Wmodule a.py", "php -f a.php", "sed -ifoo s/a/b/ f", "sed -n p e", "sed -e p e"]);
    is(F2, ["python3 -Bm pkg", "python3 -mpkg"]);
    is(["program-file"], ["sed -nf p.sed x", "sed -n 'e id' f"]);
  });
  test("a body that holds the reader's own placeholder fails closed", () => {
    is(["unparsed"], ["./\u0001 \"$HOME\""]);
  });
  test("the nested-substitution cost block returns a result, not an exception", () => {
    let inner = "echo a";
    for (let d = 0; d < 5; d++) inner = "echo $(" + inner + " ; " + "echo b ".repeat(300) + ")";
    const got = flagBody(inner);
    expect(got.some((h) => h.why.startsWith("the reader failed"))).toBe(false);
    expect([...new Set(got.map((h) => h.cls))]).toEqual(["unparsed"]);
  });
});
const F2: ClassName[] = ["interp-flag"];

describe("shell classes: review of d6a40bd", () => {
  const is = (want: ClassName[], cmds: string[]) => { for (const c of cmds) expect(classes(c), c).toEqual(want); };
  test("P1: quotes inside a substitution inside a substitution, and $'..' with an escaped quote, are read as the shell reads them", () => {
    const L = "node --loader ./l.mjs a.js";
    is(["interp-flag"], [`x=$(echo "$(printf '"')"); ${L}`, `x=$(echo "$(printf '"')")\n${L}`, `x=$(printf $'\\''); ${L}`, `x=$(printf $'\\'')\n${L}`, `echo "\${x:-"}"}"; ${L}`, `X=$(cat <<< hi); ${L}`, `X=$(echo \${x:- #}); ${L}`, `echo "$(echo "a" "$(echo 'b')")"; ${L}`]);
  });
  test("M1: sed -s takes no value", () => {
    is(["program-file"], ["sed -sf p.sed x"]);
    is(["writer-exec"], ["sed -si 's/^/x/' a.js && node a.js"]);
  });
  test("M2: wget -O in a cluster and -P directory", () => {
    is(["writer-exec"], ["wget -qOb.js http://x.invalid/p && node b.js", "wget -P lib http://x.invalid/b.js && node lib/b.js", "wget --directory-prefix=lib http://x.invalid/b.js && node lib/b.js"]);
  });
  test("M3: cp to . records the name; an empty target does not match absolute paths", () => {
    is(["writer-exec"], ["cp lib/evil.js . && node evil.js"]);
    is([], ["cp x . && node /usr/lib/x.js"]);
  });
  test("M4: deno global flags before the subcommand", () => {
    is(["writer-exec"], ["cat t > a.ts && deno -q run a.ts"]);
    is(["cd-relative"], ["cd sub && deno -q run a.ts"]);
  });
  test("M5: gawk --source", () => {
    is(["program-file"], ["gawk --source='BEGIN{system(\"id\")}'", "gawk --source 'BEGIN{system(\"id\")}'"]);
    is([], ["gawk --source='{print}' f"]);
  });
  test("L6: dotted versions of every interpreter, and php -c with an attached path", () => {
    is(["interp-flag"], ["lua5.4 -l evil a.lua", "php8.2 -c ./evil.ini a.php", "php -c./evil.ini a.php", "ruby3.2 -r ./e a.rb", "perl5.36 -MEvil a.pl"]);
  });
  test("L7: a wrapper run from a relative path is a file of the package", () => {
    is(["cd-relative"], ["cd sub && ./timeout 5 true"]);
    is(["writer-exec"], ["cp evil timeout && ./timeout 5 true"]);
  });
  test("L9: an alias defined earlier is expanded (dash does)", () => {
    is(["interp-flag"], ["alias node='node -r ./evil.js'\nnode a.js"]);
    is([], ["alias ll='ls -l'\nll", "node a.js"]);
  });
  test("F10: a case pattern is not a command", () => {
    is([], ['case "$1" in a) ;; sh) echo;; esac', 'case "$1" in a|sh) echo;; node) echo;; esac']);
    is(["interp-flag"], ['case "$1" in a) node -r ./p.js a.js;; esac']);
  });
  test("F11: sh < /dev/null reads no program", () => {
    is([], ["sh < /dev/null"]);
    is(["interp-stdin"], ["sh < x.sh"]);
  });
  test("F12: ruby -Ilib is a load path, not an in-place edit", () => {
    is(["interp-flag"], ["ruby -Ilib -e 1 a.rb && node a.rb"]);
    is(["writer-exec"], ["ruby -i -e 1 a.rb && ruby a.rb"]);
  });
  test("L13: a long arithmetic text is linear", () => {
    const t = performance.now();
    flagBody("((" + "a".repeat(19996) + "))");
    expect(performance.now() - t).toBeLessThan(1000);
  });
});

describe("shell classes: review of 04ced3f", () => {
  const is = (want: ClassName[], cmds: string[]) => { for (const c of cmds) expect(classes(c), c).toEqual(want); };
  const F: ClassName[] = ["interp-flag"];
  test("Q1/Q2: a case subject and pattern that run code, and a (pattern) item with a pipeline", () => {
    is(F, ["case $(node -r ./p.js a.js) in *) :;; esac", "case x in $(node -r ./p.js a.js)) :;; esac", "case x in (a) echo hi | node -r ./p.js a.js;; esac", "case x in (a) false || node --loader ./l.mjs a.js;; esac"]);
    is([], ['case "$1" in a) ;; sh) echo;; esac']);
  });
  test("Q3: time ( ) and coproc ( ) are subshells", () => {
    is(F, ["time (node -r ./p.js a.js)", "coproc (node -r ./p.js a.js)"]);
  });
  test("Q4: $npm_node_execpath is node", () => {
    is(F, ["$npm_node_execpath -r ./p.js a.js", "${npm_node_execpath} --loader ./l.mjs a.js"]);
    is(["cd-relative"], ["cd sub && $npm_node_execpath a.js"]);
    is([], ["$npm_node_execpath a.js"]);
  });
  test("Q5: /dev/stdin and its aliases are a program read from stdin", () => {
    is(["heredoc"], ["node /dev/stdin <<'EOF'\nrequire('./lib/hidden.js')\nEOF", "bash /dev/stdin <<'EOF'\nnode -r ./p.js a.js\nEOF", ". /dev/stdin <<'EOF'\nnode -r ./p.js a.js\nEOF"]);
    is(["interp-stdin"], ["node /dev/stdin < lib/x.js", "node /dev/fd/0 < lib/x.js", "node /proc/self/fd/0 < lib/x.js"]);
  });
  test("Q6: curl -J fails closed; --output-dir is the directory of the output", () => {
    is(["writer-exec"], ["curl -OJ https://h/dl && node b.js", "curl --output-dir lib -O https://h/b.js && node lib/b.js", "curl --output-dir=lib -o b.js https://h/x && node lib/b.js"]);
  });
  test("Q7: awk print piped to a command held in a variable", () => {
    is(["program-file"], ['awk \'BEGIN{c="sh"; print "id" | c}\'']);
    is([], ["awk 'BEGIN{ if (a || b) print 1 }'"]);
  });
  test("Q8: trap -- 'code' EXIT", () => {
    is(F, ["trap -- 'node -r ./p.js a.js' EXIT"]);
  });
  test("Q9: an alias whose value holds an expansion", () => {
    is(F, ['X=-r\nalias n="node $X ./p.js"\nn a.js']);
  });
  test("Q12: ruby -C and env -C move one command, not the rest of the body", () => {
    is(["cd-relative"], ["ruby -C sub a.rb"]);
    is([], ["env -C sub true && node a.js"]);
    expect(flagBody("ruby -C sub a.rb && node a.js").map((h) => h.why)).toEqual(["ruby script after cd"]); // not also "node script after cd"
  });
});

describe("shell classes: O14", () => {
  test("ruby -E, -C, -K, -T, -x, -W, -F and -0 values are not flags", () => {
    for (const c of ["ruby -Ebinary a.rb", "ruby -Csrc a.rb", "ruby -Kutf8 a.rb", "ruby -Tn a.rb", "ruby -Wrr a.rb", "ruby -Fr a.rb"]) expect(classes(c), c).not.toContain("interp-flag");
    for (const c of ["ruby -rfoo a.rb", "ruby -r./e a.rb", "ruby -wrfoo a.rb", "ruby -Ilib a.rb", "ruby -wI lib a.rb", "ruby -Ebinary -r ./e a.rb"]) expect(classes(c), c).toContain("interp-flag");
  });
});

describe("shell classes: review of 47a705c", () => {
  const is = (want: ClassName[], cmds: string[]) => { for (const c of cmds) expect(classes(c), c).toEqual(want); };
  test("1: ruby -C, -X and -x take a directory, attached or not", () => {
    is(["cd-relative"], ["ruby -Csrc a.rb", "ruby -C src a.rb", "ruby -Xsrc a.rb", "ruby -X src a.rb", "ruby -xsrc a.rb"]);
    is([], ["ruby -x a.rb", "ruby -Ebinary a.rb"]);
  });
  test("3: parentheses in quotes do not make a group arithmetic", () => {
    const L = ["interp-flag"] as ClassName[];
    is(L, ['((echo "(") && (node -r ./p.js a.js ")"))', 'x=$(((echo "(") && (node -r ./p.js a.js ")")))', "((echo '(') && (node -r ./p.js a.js '('))", "((echo \\() && (node -r ./p.js a.js))"]);
  });
  test("5: more compiler flags that load a file", () => {
    is(["env-assign"], ["CXXFLAGS='-B ./bin' node-gyp rebuild", "LDFLAGS=-Wl,-plugin=./p.so node-gyp rebuild", "OBJCXXFLAGS=-B./bin node-gyp rebuild"]);
    is([], ["CXXFLAGS='-B /usr/bin' make", "LDFLAGS=-Wl,-rpath,/x make"]);
  });
});

describe("shell classes: follow-up round first", () => {
  const is = (want: ClassName[], cmds: string[]) => { for (const c of cmds) expect(classes(c), c).toEqual(want); };
  test("F1: only ;; ends a case item; a lone ; does not turn | and || into case separators", () => {
    is(["interp-flag"], ["echo build; node-gyp rebuild || node --loader ./l.mjs fallback.js"]);
    is(["cd-relative"], ["cd sub; test -f x || node a.js"]);
    is(["interp-flag"], ['case x in a) :;; b) true || node -r ./p.js a.js;; esac']);
  });
  test("F2: a heredoc or here-string on descriptor 0", () => {
    is(["heredoc"], ["node 0<<EOF\nrequire('./lib/hidden.js')\nEOF", "sh 0<<< 'node -r ./p.js a.js'"]);
  });
  test("F3: env -C and sudo -D carry their directory into a nested shell", () => {
    is(["cd-relative"], ["env -C sub sh -c 'node a.js'", "sudo -D sub bash -c 'node a.js'"]);
    is([], ["env sh -c 'node a.js'"]);
  });
  test("F4: bun run FILE", () => {
    is(["writer-exec"], ["cat lib/hidden.js > b.js && bun run b.js"]);
    is(["cd-relative"], ["cd sub && bun run a.js"]);
    is([], ["bun run build", "bun run a.js"]);
  });
  test("F5: xargs -I{} / -i hands the script from stdin", () => {
    is(["interp-stdin"], ["printf lib/setup.js | xargs -I{} node {}", "printf lib/setup.js | xargs -i node {}"]);
  });
  test("F6: a program from a descriptor other than 0", () => {
    is(["interp-stdin"], ["node /dev/fd/3 3<lib/hidden.js", "bash /proc/self/fd/4 4<lib/x.sh"]);
    is(["computed-command"], ["bash <(cat lib/x.sh)", "node <(cat lib/hidden.js)"]);
  });
  test("node flag clusters and an export whose name holds an expansion", () => {
    is(["interp-flag"], ["node -ep 1 -r ./p.js a.js", "node -ie 1 -r ./p.js a.js", "node -pe 1 -r ./p.js"]);
    is(["env-assign"], ['export ""$(cat lib/x.env)', 'export "a b"$(cat lib/x.env)', 'export "$(cat lib/x.env)=1"']);
    is([], ["export FOO=$(pwd)", 'export "FOO=$(pwd)"']);
  });
  test("F7: export of names or values built by a substitution", () => {
    is(["env-assign"], ["export $(cat lib/x.env) && node a.js", "declare -x $(cat lib/x.env)"]);
    is([], ["export FOO=$(pwd)", "export $npm_config_x"]);
  });
  test("F8: perl -E and --eval=, and no over-hold after a cd", () => {
    is(["interp-flag"], ["perl -E 1 -MEvil"]);
    is(["cd-relative"], ["cd sub && perl a.pl"]);
    is([], ["cd sub && perl -E 'say 1'", "node --eval=1 x"]);
  });
  test("F9: a read-write redirect <> writes", () => {
    is(["writer-exec"], ["cat lib/hidden.js 1<>b.js && node b.js"]);
  });
  test("F10: time -p ( )", () => {
    is(["interp-flag"], ["time -p (node -r ./p.js a.js)"]);
  });
  test("F11: cp -t DIR, -tDIR and --target-directory", () => {
    is(["writer-exec"], ["cp --target-directory=lib evil.js && node lib/evil.js", "cp --target-directory lib evil.js && node lib/evil.js", "cp -tlib evil.js && node lib/evil.js", "cp -t lib evil.js && node lib/evil.js"]);
    is([], ["cp -t lib evil.js && node a.js"]);
  });
  test("F12: ~+ and ~- are the working directory, not a home", () => {
    is(["env-assign"], ["PATH=~+/bin:$PATH node a.js", "CC=~+/x.sh node-gyp rebuild"]);
    is([], ["PATH=~/bin:$PATH node a.js", "CC=~/x.sh make"]);
  });
  test("W1: a regex with | in an awk program is not a pipe", () => {
    is([], ["awk '/foo|bar/ {print}' f", "awk '{gsub(/a|b/,\"\")}' f"]);
    is(["program-file"], ["awk 'BEGIN{c=\"sh\"; print \"id\" | c}'", "awk '/a|b/ {print \"id\" | \"sh\"}'"]);
  });
});

describe("shell classes: follow-up round second", () => {
  const is = (want: ClassName[], cmds: string[]) => { for (const c of cmds) expect(classes(c), c).toEqual(want); };
  const F: ClassName[] = ["interp-flag"];
  test("C1: a (pattern) item after the first, and (sh) as a pattern", () => {
    is(F, ['case "$1" in\n (a) true | node -r ./p.js a.js;;\nesac', "case x in (a) :;; (b) true || node --loader ./l.mjs a.js;; esac"]);
    is([], ['case "$1" in\n(sh) echo;;\nesac', "case x in (a) :;; (sh) echo;; esac"]);
  });
  test("C2: a word that expands to several words, flags among them", () => {
    is(F, ['set -- -r ./p.js a.js; node "$@"', "sh -c 'node \"$@\"' sh -r ./p.js a.js", 'A=(-r ./p.js a.js); node "${A[@]}"', "node ${X:--r ./p.js a.js}", "X='-r ./p.js a.js'; sh -c \"node $X\"", "X='-r ./p.js a.js'; node $X"]);
    is([], ["node ${npm_package_config_e:-a.js}", "node $npm_package_config_bin"]);
  });
  test("C3: brace expansion in a command or its flags", () => {
    is(F, ["node {-r,./p.js} a.js"]);
    is(["computed-command"], ["{node,-r,./p.js} a.js"]);
    is([], ["echo {a,b}"]);
    // a brace in the script operand names files the existing scan cannot (node a{1,2}.js runs a1.js)
    is(["computed-command"], ["node a{1,2}.js", "node --max-old-space-size=4096 a{1,2}.js", "node {a,b}.js", "node {,}lib/hidden.js", "sh {,}lib/x.sh"]);
    is(F, ["node --{require=./p.js,inspect} a.js", "node {--require,--inspect} ./p.js a.js"]);
  });
  test("C4: a subshell and a -c string see the variables, aliases and unknown writes of the body", () => {
    is(["writer-exec"], ['N=b.js; (cat lib/hidden.js > "$N"); node b.js', 'M=$(echo b.js); sh -c \'cat lib/hidden.js > "$M"\'; node b.js']);
    is(F, ["alias node='node -r ./p.js'\n(node a.js)"]);
    is([], ["alias node='node -r ./p.js'\nsh -c 'node a.js'"]); // a new shell has no aliases
  });
  test("C5: a script on a descriptor opened earlier", () => {
    is(["interp-stdin"], ["exec 3<lib/x.sh; sh /dev/fd/3"]);
  });
  test("C7: for and read of a loader variable", () => {
    is(["env-assign"], ["for PATH in ./bin; do node a.js; done", "read PATH <<< ./bin; node a.js", "read -r NODE_OPTIONS", "for NODE_OPTIONS in --require=./x.js; do node a.js; done"]);
    is([], ["for f in a b; do echo $f; done", "read line", "for PATH in /usr/bin; do node a.js; done"]);
  });
  test("C9: printf | xargs sh", () => {
    is(["interp-stdin"], ["printf lib/x.sh | xargs sh", "printf lib/x.sh | xargs bash"]);
    is([], ["printf x | xargs echo", "printf x | xargs sh -c 'echo ok'"]);
  });
  test("C11: -r is deno --reload and -p is a perl loop flag, not inline code", () => {
    is(["writer-exec"], ["cat t > a.ts && deno run -r a.ts", "cat t > x.pl && perl -p x.pl f", "cat t > x.pl && perl -c x.pl"]);
    is(F, ["perl -E 1 -MEvil", "node -p 1 -r ./p.js"]);
    is([], ["python3 -c 'print(1)'", "cd sub && python3 -c 'print(1)'", "python3 -Bc 'x'"]);
    is(F, ["python3 -m pkg"]);
    is([], ["python3 -c 'x' -m y"]); // after -c CODE the rest is sys.argv
  });
  test("C12: PERL5DB", () => {
    is(["env-assign"], ["PERL5DB='require \"./lib/x.pl\"' perl -d a.pl", "export PERL5DB"]);
  });
});

describe("shell classes: follow-up V1-V3 (variables the body sets in ways that are not literal)", () => {
  const is = (want: ClassName[], cmds: string[]) => { for (const c of cmds) expect(classes(c), c).toEqual(want); };
  // N was a.js; each form may set it to something else, so the write through "$N" is to a name the body cannot tell
  const stale = (f: string) => `N=a.js\n${f}\ncat h > $N; node b.js`;
  test("V1: an assignment that may not run, runs elsewhere, or a builtin that sets N makes N unknown", () => {
    for (const f of ["if true; then N=b.js; fi", "true && N=b.js || N=c.js", "f() { N=b.js; }; f", "N=b.js | true", "printf -v N b.js", "let N=1", "((N++))", "unset N", ": ${N:=b.js}", "(N=b.js)", "x=$(N=b.js)", "for N in a b; do :; done", "read N <<< b.js", "N=$(echo b.js)", "case x in x) N=b.js;; esac", "while false; do N=b.js; done"]) {
      expect(classes(stale(f)), f).toEqual(["writer-exec"]);
    }
  });
  test("V1: a prefix assignment is that command's environment: N keeps its value", () => {
    is([], ["N=a.js\nN=b.js true\ncat h > $N; node b.js"]); // N is still a.js: the write is to a.js, and node b.js is not that file
    is(["writer-exec"], ["N=a.js\nN=b.js true\ncat h > $N; node a.js"]);
  });
  test("V1: a known value is still known", () => {
    is(["writer-exec"], ["N=b.js\ncat h > $N; node b.js", "N=b.js; eval N=c.js; cat h > $N; node c.js"]);
    is([], ["N=b.js\ncat h > $N; node a.js", "N=a.js; eval N=b.js; cat h > $N; node a.js"]);
  });
  test("V2: more writes to a name the body cannot tell", () => {
    for (const f of ["(cat h > $N)", "x=$(cat h > $N)", "cat h | tee $N", "dd of=$N", "cat h <> $N", "cat h 1<>b.js", "cp h $N", "mv h \"$N\"", "install h $N"]) expect(classes(`${f}; node b.js`), f).toEqual(["writer-exec"]);
  });
  test("V2: a write outside the package, or a program's own output, is not an unknown write", () => {
    is([], ['echo x > "$TMPDIR/o"; node a.js', 'echo x > "$HOME/o"; node a.js', "echo x > /tmp/o.js; node a.js", "echo x > ${LOG:-/dev/null}; node a.js", "dd of=/tmp/o; node b.js"]);
    // no program's own output is trusted: npx, npm exec, npm run, make, node SCRIPT, php -r can print any file of the package
    is(["writer-exec"], ["node a.js > $OUT; node b.js", "make > $OUT; node b.js", "npm run build > $OUT; node b.js", "npx cat lib/hidden.js > $npm_package_config_out; node b.js", "npm exec -- cat lib/hidden.js > $npm_package_config_out; node b.js", "pnpm dlx cat lib/hidden.js > $npm_package_config_out; node b.js", "php -r 'readfile(\"lib/hidden.js\");' > $npm_package_config_out; node b.js", "set -- b.js; npx cat lib/hidden.js > $1; node b.js", "f() { npx cat lib/hidden.js > $1; }; f b.js; node b.js", "getopts o N; cat lib/hidden.js > $N; node b.js", "cat lib/hidden.js > ${npm_package_config_out:-/tmp/x}; node b.js", "npx cat lib/hidden.js > $npm_package_name.js; node x.js"]);
  });
  test("V3: a script path built from a variable the body assigned something it cannot read", () => {
    is(["computed-command"], ["D=$(echo sub); node $D/a.js", "D=sub; node $D/a.js", "if true; then D=sub; fi; node $D/a.js"]);
    is([], ["node $D/a.js"]);
  });
});

describe("shell classes: follow-up round third", () => {
  const is = (want: ClassName[], cmds: string[]) => { for (const c of cmds) expect(classes(c), c).toEqual(want); };
  const F: ClassName[] = ["interp-flag"];
  test("1: division in an awk program does not hide system(), getline or a pipe", () => {
    is(["program-file"], [`awk '{x=$1 / 2; system("sh lib/x.sh"); y=$2 / 3}'`, `awk '{x=$1 / 2; print "id" | "sh"; y=$2 / 3}'`, `awk '{x=$1 / 2; "date" | getline d; y=$2 / 3}'`]);
    is([], ["awk '/foo|bar/ {print}' f", "awk '{x=$1 / 2; y=$2 / 3; print x}' f"]);
  });
  test("2: a flag held in a variable is an interp-flag", () => {
    is(F, ["X=-e; node $X \"require('./lib/hidden.js')\"", "X=-r; node $X ./p.js a.js"]);
  });
  test("3: a subshell or pipe after esac is not a case pattern", () => {
    is(F, ["case x in a) :;; esac; (node -r ./p.js a.js)", "case x in a) :;; esac | node -r ./p.js a.js"]);
  });
  test("4: every item of a for list is checked", () => {
    is(["env-assign"], ["for PATH in /usr/bin ./bin; do node a.js; done", "for CC in gcc ./cc; do make; done"]);
    is([], ["for PATH in /usr/bin /opt/bin; do node a.js; done"]);
  });
  test("5: interpreters it does not list are not examined", () => {
    is([], ["tsx -e 'console.log(1)'", "cd sub && tsx -e 'x'", "cd sub && Rscript -e 'x'"]);
  });
  test("6: cp and ln -t in clusters; rsync is not cp", () => {
    is(["writer-exec"], ["cp -vt lib a.js && node lib/a.js", "ln -sft lib x.js && node lib/x.js"]);
    is([], ["rsync -rtv a.js lib/ && node lib/a.js"]);
  });
  test("8: xargs -I STR and -J STR", () => {
    is(["interp-stdin"], ["printf lib/x.js | xargs -I % node %", "printf lib/x.sh | xargs -I@ sh @", "printf lib/x.js | xargs -J % node %"]);
    is([], ["printf lib/x.js | xargs -I % node a.js %"]);
  });
  test("9/10: a default value without spaces or a leading dash is one word", () => {
    is([], ['export "$npm_config_x"', "node ${npm_package_config_e:-a.js}"]);
    // the default is the script when nothing sets the variable: a file the existing scan cannot name (node ${X:-./lib/hidden.js} runs lib/hidden.js)
    is(["computed-command"], ["node ${SCRIPT:-index.js}", 'node "${SCRIPT:-index.js}"', "node ${X:-./lib/hidden.js}", "node ${X-./lib/hidden.js}", "node ${X:=./lib/hidden.js}"]);
    is(F, ["node ${X:--r} ./p.js a.js", "node ${X:-a b}"]);
  });
  test("11: <> opens the file for reading too", () => {
    is(["interp-stdin"], ["printf x | node 0<>lib/x.js"]);
  });
  test("12: aliases stay in this shell; a subshell's assignment is not kept", () => {
    is(["writer-exec"], ['N=b.js; (N=safe.js); cat x > "$N"; node b.js']);
  });
  test("13: ;& and ;;& end a case item", () => {
    is([], ["case x in a) :;& sh) echo;; esac", "case x in a) :;;& sh) echo;; esac"]);
  });
  test("14: a heredoc on another descriptor is not stdin", () => {
    is([], ["node a.js 3<<EOF\nx\nEOF"]);
    is(["heredoc"], ["node 0<<EOF\nx\nEOF", "node <<EOF\nx\nEOF"]);
  });
  test("15: bun run --cwd DIR script; a package script with a dot is not a file", () => {
    is([], ["cd sub && bun run build.prod", "bun run build.prod"]);
    is(F, ["bun run --cwd sub build"]); // --cwd is read as a load flag; sub is not taken for the script
    is(["cd-relative"], ["cd sub && bun run a.js"]);
  });
});

describe("shell classes: review of 7960377 (H1-H10, N1-N7)", () => {
  const is = (want: ClassName[], cmds: string[]) => { for (const c of cmds) expect(classes(c), c).toEqual(want); };
  const F: ClassName[] = ["interp-flag"];
  test("H1: a program that can print any file does not make its redirect target an outside write", () => {
    is(["writer-exec"], ['read OUT <<< b.js; sh -c "cat lib/hidden.js" > "$OUT"; node b.js', "node -p \"fs.readFileSync('lib/hidden.js','utf8')\" > $OUT; node b.js", "git show :lib/hidden.js > $N; node b.js", "N=$(echo b.js); sh -c 'cat lib/hidden.js' > $N; node b.js"]);
  });
  test("H2: a block that ended does not leave later assignments unknown", () => {
    is([], ["if [ -f x ]; then :; fi; OUT=dist/x.js; cat a > $OUT; node other.js", "for d in a; do :; done; OUT=dist/x.js; cat a > $OUT; node other.js", "{ :; }; OUT=dist/x.js; cat a > $OUT; node other.js", "case x in a) :;; esac; OUT=dist/x.js; cat a > $OUT; node other.js", "while false; do :; done; OUT=dist/x.js; cat a > $OUT; node other.js", "f() { :; }; OUT=dist/x.js; cat a > $OUT; node other.js"]);
    is(["writer-exec"], ["if [ -f x ]; then OUT=dist/x.js; fi; cat a > $OUT; node other.js", "for d in a; do OUT=dist/x.js; done; cat a > $OUT; node other.js", "N=b.js; for N in x y; do :; done; cat a > $N; node b.js"]);
  });
  test("H3/H4: a background command and a newline after && or ||", () => {
    is(["writer-exec"], ["N=b.js; N=a.js & cat lib/hidden.js > $N; node b.js", "N=b.js; false &&\nN=a.js\ncat lib/hidden.js > $N; node b.js", "N=b.js; false ||\nN=a.js\ncat lib/hidden.js > $N; node b.js"]);
  });
  test("H5: a name the body reassigned is not an outside place", () => {
    is(["writer-exec"], ["N=$(echo b.js); cat lib/hidden.js > ${N:-/tmp/x}; node b.js"]);
    expect(classes("HOME=$(pwd); cat lib/hidden.js > $HOME/b.js; node b.js")).toContain("writer-exec");
    is([], ['echo x > "$TMPDIR/o"; node a.js', "echo x > ${LOG:-/dev/null}; node a.js"]);
  });
  test("a prefix assignment whose value is not read taints the code the command runs", () => {
    is(["writer-exec"], ["N=$(echo b.js) sh -c 'cat lib/hidden.js > $N'; node b.js", "N=$(echo b.js) bash -c 'cat lib/hidden.js > $N'; node b.js", "N=$(echo b.js) eval 'cat lib/hidden.js > $N'; node b.js"]);
    is(["computed-command"], ["D=$(echo sub) sh -c 'node $D/a.js'"]);
    expect(classes("HOME=$(pwd) sh -c 'cat lib/hidden.js > $HOME/b.js'; node b.js")).toContain("writer-exec");
    is([], ["N=a.js; N=$(echo b.js) true; cat h > $N; node c.js"]); // the prefix assignment does not leak to the next command
  });
  test("with -t every operand is a source", () => {
    is(["writer-exec"], ["cp -t lib $SRC a.js; node b.js", "cp -t . $SRC; node b.js", "cp --target-directory=lib $SRC a.js; node b.js", "mv -t lib $SRC a.js; node b.js"]);
    is([], ["cp -t lib a.js; node b.js", "cp -t /tmp $SRC; node b.js"]);
  });
  test("a variable holding flags, before the script; after the script it is an argument", () => {
    is(["computed-command"], ["X=$(cat flags); node $X"]);
    is(["interp-flag"], ['X="-r ./p.js"; node $X a.js']);
    is([], ["X=$(cat flags); node a.js $X"]);
  });
  test("a function body keyword form closes: a later plain group is not a function body", () => {
    is([], ["function f { :; }; { N=b.js; }; cat h > $N; node c.js", "f() { :; }; { N=b.js; }; cat h > $N; node c.js"]);
    is(["writer-exec"], ["function f { N=b.js; }; f; cat h > $N; node b.js"]);
  });
  test("H6: ;;& ends a case item", () => {
    is([], ["case x in a) :;;& sh) echo;; esac"]);
  });
  test("H7: cp --target-directory and -t with a directory held in a variable", () => {
    is(["writer-exec"], ['cp --target-directory="$DIR" lib/hidden.js; node b.js', 'cp -t"$DIR" lib/hidden.js; node b.js', 'cp -t $DIR lib/hidden.js; node b.js']);
    is([], ['cp -t "$TMPDIR" lib/hidden.js; node b.js']);
  });
  test("H8/N3: xargs replacement strings, inside a path, and a replacement token that looks like an option", () => {
    is(["interp-stdin"], ["printf x | xargs -I{} node lib/{}.js", "printf x | xargs -I{} node ./{}", "printf x | xargs -iR sh R", "printf x | xargs --replace=R node R", "printf lib/setup.js | xargs -I -i node -i"]);
  });
  test("H9: rsync -t is not cp -t", () => {
    is([], ["rsync -avtz hidden.js b.js && node b.js"]);
  });
  test("H10: a spaced division does not hide a pipe", () => {
    is(["program-file"], ["awk '{print $1 /2; print \"id\" | cmd; x = 4 /2}'"]);
  });
  test("N1: a prefix assignment is seen by the code the command runs", () => {
    is(["writer-exec"], ["N=b.js eval 'cat lib/hidden.js > $N'; node b.js", "N=b.js sh -c 'cat lib/hidden.js > $N'; node b.js"]);
  });
  test("N2: cp into a directory held in a variable", () => {
    is(["writer-exec"], ["D=lib; cp evil.js $D; node lib/evil.js", "D=lib; cp evil.js $D/; node lib/evil.js"]);
  });
  test("N4: nested braces and a path before the brace", () => {
    is(["computed-command"], ["./{bin,sub}/sh"]);
    is(F, ["node {a,{b,c}}", "node {-r,{./p.js,a.js}}"]);
    is(["computed-command"], ["node {a,b}.js"]);
    is([], ["echo {a,{b,c}}"]);
  });
  test("N5: bun run with a script held in a variable, and load flags after run", () => {
    is(["computed-command", "writer-exec"], ["N=b.js; cp lib/hidden.js b.js; bun run $N"]);
    is(F, ["bun run --preload ./p.js a.js", "bun run --import=./p.js a.js", "bun run -r ./p.js a.js"]);
  });
  test("N6: --eval=CODE does not consume the next word", () => {
    is(F, ["node --eval=1 -r ./p.js a.js"]);
    is([], ["node --eval=1 a.js"]);
  });
  test("N7 and the low items: here-string on fd 3, ${X:-k=v}, <<=, printf -vN, mapfile, for N;", () => {
    is([], ["node a.js 3<<<x"]);
    // ${X:-k=v} and ${X//a=b/} do not assign: N stays known, so the write is b.js and node c.js is not that file
    is([], ["echo ${X:-k=v}; N=b.js; cat h > $N; node c.js", "echo ${X//a=b/}; N=b.js; cat h > $N; node c.js"]);
    is(["writer-exec"], ["N=a.js; ((N<<=1)); cat h > $N; node b.js", "N=a.js; printf -vN b.js; cat h > $N; node b.js", "N=a.js; mapfile N < f; cat h > $N; node b.js", "N=a.js; for N; do :; done; cat h > $N; node b.js", "N=a.js; readarray -t N < f; cat h > $N; node b.js"]);
  });
  test("a default that is a path is the script", () => {
    is(["computed-command"], ["node ${X:-./lib/hidden.js}", "node ${X-./lib/hidden.js}"]);
  });
});

describe("shell classes: long words stay linear", () => {
  test("arithmetic, let, braces and ${ } over 20 000 characters", () => {
    const t = performance.now();
    for (const b of ["((" + "a".repeat(19996) + "))", "let " + "a".repeat(19990), "node " + "{{a".repeat(6000), "node " + "${x:-" + "a".repeat(19990) + "}", "x=$((" + "a+".repeat(9990) + "1))", "echo " + "a=".repeat(9990)]) {
      expect(flagBody(b).some((h) => h.why.startsWith("the reader failed"))).toBe(false);
    }
    expect(performance.now() - t).toBeLessThan(1000);
  });
});

describe("shell classes: review of 32f9b2f (C1-C3 and the low items)", () => {
  const is = (want: ClassName[], cmds: string[]) => { for (const c of cmds) expect(classes(c), c).toEqual(want); };
  test("C1: a { after time or function opens a group that its } closes", () => {
    is(["writer-exec"], ["N=b.js; if false; then time { :; }; N=a.js; fi; cat lib/hidden.js > $N; node b.js", "N=b.js; if false; then function f { :; }; N=a.js; fi; cat lib/hidden.js > $N; node b.js", "N=b.js; if false; then f() { :; }; N=a.js; fi; cat lib/hidden.js > $N; node b.js"]);
    is([], ["N=b.js; time { :; }; cat lib/hidden.js > $N; node c.js"]);
  });
  test("C2: calling a function forgets the names its body assigns", () => {
    is(["writer-exec"], ["f(){ N=b.js; }; N=a.js; f; cat lib/hidden.js > $N; node b.js", "function f { N=b.js; }; N=a.js; f; cat lib/hidden.js > $N; node b.js", "f() { read N; }; N=a.js; f; cat lib/hidden.js > $N; node b.js"]);
    is([], ["f(){ N=b.js; }; N=a.js; cat lib/hidden.js > $N; node c.js"]); // f is never called: N is still a.js
  });
  test("C3: a script word with an empty alternative", () => {
    is(["computed-command"], ["node {,}lib/hidden.js"]);
  });
  test("a prefix assignment built from a known variable is that value in nested code; ~+ is the working directory", () => {
    is(["computed-command"], ["X=lib/hidden.js; N=$X sh -c 'node $N'"]);
    is(["writer-exec"], ["cat lib/hidden.js > ~+/b.js; node b.js"]);
  });
});

describe("shell classes: O5, O10, O12", () => {
  const is = (want: ClassName[], cmds: string[]) => { for (const c of cmds) expect(classes(c), c).toEqual(want); };
  test("O5: a redirect target held in a variable the body assigned a literal", () => {
    is(["writer-exec"], ['N=b.js; cat lib/hidden.js > "$N"; node b.js', "N=b.js\ncat lib/hidden.js > $N\nnode b.js", 'cat t > "$PWD/b.js" && node b.js', 'N=b.js\ncat t >> "${N}"\nnode b.js']);
    is([], ['N=b.js; echo x > "$N"; node a.js', 'echo x > "$LOG"; echo done']);
    // a name the body cannot tell: any relative file it runs afterwards may be that one
    is(["writer-exec"], ['echo x > "$LOG"; node a.js', 'N=b.js; echo x > "$M"; node b.js', 'N=$(echo b.js); cat h > "$N"; node b.js', 'N=a; N=$(echo b.js); cat h > "$N"; node b.js', "read N <<< b.js\ncat h > \"$N\"\nnode b.js", 'cat h &> "$N"; node b.js', 'cat h >&"$N"; node b.js', 'for N in x y; do cat h > "$N"; done; node b.js', 'M=${N%.x}; cat h > "$M"; node b.js']);
    // a variable built from known literals is known
    is(["writer-exec"], ["N=b.js; export M=$N; cat h > $M; node b.js", "export N=b.js; cat h > $N; node b.js", "for N in b.js; do cat h > \"$N\"; done; node b.js", "N=b; M=$N.js; cat h > $M; node b.js", 'N=sub; cat h > "$N/b.js"; node sub/b.js']);
    is([], ["N=b.js; cat h > $N; node a.js", "node $D/a.js"]);
    // a script path built from a variable the body assigned is a file the existing scan cannot name
    is(["computed-command"], ["D=sub; node $D/a.js"]);
    expect(classes("cd sub; D=a.js; node $D")).toEqual(["cd-relative", "computed-command"]);
  });
  test("O10: node-gyp tool variables, compiler flags that load a file, PYTHONUSERBASE", () => {
    is(["env-assign"], ["NODE_GYP_FORCE_PYTHON=./tools/py.sh node-gyp rebuild", "LINK=./x.sh node-gyp rebuild", "CC_host=./c node-gyp rebuild", "CXX_target=./c node-gyp rebuild", "CXXFLAGS=-B./bin node-gyp rebuild", "CFLAGS=-fplugin=./p.so node-gyp rebuild", "LDFLAGS=-fuse-ld=./ld node-gyp rebuild", "PYTHONUSERBASE=. python3 a.py"]);
    is([], ["CFLAGS=-O2 node-gyp rebuild", "CFLAGS=-B/usr/bin make", "CC=clang make", "PYTHONUSERBASE=/opt/x python3 a.py", "CFLAGS=-fplugin=/usr/lib/p.so make"]);
  });
  test("O12: sudo -D and --chdir move that command", () => {
    is(["cd-relative"], ["sudo -D sub node a.js", "sudo --chdir=sub node a.js"]);
    is([], ["sudo node a.js", "sudo -D sub true && node a.js"]);
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
    ["flat sh -c (single quotes do not nest)", rep("sh -c '", 400) + "x" + rep("'", 400), ["interp-stdin"]],
    ["nested substitutions past the depth cap", rep("echo $(", 400) + "x" + rep(")", 400), ["unparsed"]],
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
      expect(performance.now() - t).toBeLessThan(1000);
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
      expect(flagBody(s).some((h) => h.why.startsWith("the reader failed")), JSON.stringify(s)).toBe(false); // flagBody catches everything, so a failure shows as this hit
      expect(performance.now() - t, JSON.stringify(s)).toBeLessThan(1000);
    }
  });
});

describe("shell classes: an outside write is the whole word, a prefix plus a literal tail", () => {
  const held = (cmds: string[]) => { for (const c of cmds) expect(classes(c), c).toContain("writer-exec"); };
  test("a tail after ${V:-/dev/null}, an expansion that names the package, or a .. segment is not outside", () => {
    held(["cat lib/hidden.js > ${PWD:-/dev/null}/b.js; node b.js", "cat lib/hidden.js > ${PWD:=/dev/null}/b.js; node b.js", "cat lib/hidden.js > ${INIT_CWD:-/dev/null}/b.js; node b.js",
      "node -p 'x' > ${PWD:-/dev/null}/b.js; node b.js", "cat lib/hidden.js > $TMPDIR/../../../../../../../../$PWD/b.js; node b.js", "cat lib/hidden.js > $HOME/../../$PWD/b.js; node b.js",
      "cat lib/hidden.js > /$PWD/b.js; node b.js", "cat lib/hidden.js > //$PWD/b.js; node b.js", "npm run x > /$PWD/b.js; node b.js", "cat lib/hidden.js > ~/../../../$PWD/b.js; node b.js", "echo x > /tmp/$N; node a.js"]);
  });
  test("a literal place outside stays quiet", () => {
    for (const c of ["echo x > /tmp/o.js; node a.js", "echo x > $TMPDIR/o.js; node a.js", "echo x > ~/o.js; node a.js", "echo x > ${LOG:-/dev/null}; node a.js"]) expect(classes(c), c).toEqual([]);
  });
});

describe("shell classes: eval and special builtins change the names of the body only where they run", () => {
  const held = (cmds: string[]) => { for (const c of cmds) expect(classes(c), c).toContain("writer-exec"); };
  test("an eval that may not run, or runs in a pipeline or function, leaves the name unknown", () => {
    held(["N=a.js; false && eval N=b.js; cat lib/hidden.js > $N; node a.js", "N=a.js; f() { eval N=b.js; }; cat lib/hidden.js > $N; node a.js",
      "N=a.js; eval N=b.js | true; cat lib/hidden.js > $N; node a.js", "N=a.js; if false; then eval N=b.js; fi; cat lib/hidden.js > $N; node a.js"]);
  });
  test("a prefix assignment of a special builtin persists, so the name is unknown", () => {
    held(["N=a.js; N=b.js :; cat lib/hidden.js > $N; node b.js", "N=a.js; N=b.js export X; cat lib/hidden.js > $N; node b.js", "N=a.js; N=b.js set --; cat lib/hidden.js > $N; node b.js"]);
    expect(classes("N=a.js; N=b.js true; cat lib/hidden.js > $N; node b.js")).toEqual([]);
  });
});

describe("shell classes: a group in a pipe or the background, and exec with only redirections", () => {
  const held = (cmds: string[]) => { for (const c of cmds) expect(classes(c), c).toContain("writer-exec"); };
  test("a { } group followed by | or & runs in a subshell", () => {
    held(["N=a.js; { eval N=b.js; } | cat; cat lib/hidden.js > $N; node a.js", "N=a.js; { N=b.js; } | cat; cat lib/hidden.js > $N; node a.js", "N=a.js; { N=b.js; } & wait; cat lib/hidden.js > $N; node a.js"]);
    expect(classes("N=a.js; { :; }; cat lib/hidden.js > $N; node b.js")).toEqual([]);
  });
  test("exec with only redirections keeps its prefix assignment", () => {
    held(["N=a.js; N=b.js exec 3>/dev/null; cat lib/hidden.js > $N; node b.js"]);
  });
});

describe("shell classes: a group after &&, || or a pipe, and ~N", () => {
  const held = (cmds: string[]) => { for (const c of cmds) expect(classes(c), c).toContain("writer-exec"); };
  test("a { } group that may not run does not make its assignments unconditional", () => {
    held(["N=b.js; false && { :; N=a.js; }; cat lib/hidden.js > $N; node b.js", "N=b.js; true || { :; N=a.js; }; cat lib/hidden.js > $N; node b.js", "N=b.js; echo | { :; N=a.js; }; cat lib/hidden.js > $N; node b.js"]);
  });
  test("~0 and ~+0 are the working directory", () => {
    held(["cat lib/hidden.js > ~0/b.js; node b.js", "cat lib/hidden.js > ~+0/b.js; node b.js"]);
    for (const c of ["CC=~0/x.sh node-gyp rebuild", "PATH=~0/bin:$PATH node a.js"]) expect(classes(c), c).toEqual(["env-assign"]);
  });
});

describe("shell classes: a called function forgets the names its body sets, however it is called", () => {
  const H = "cat lib/hidden.js > $N; node b.js";
  test("a call inside a function, through eval, and a body that evals an assignment", () => {
    for (const c of ["g() { N=b.js; }; f() { g; }; N=a.js; f; " + H, "f() { N=b.js; }; N=a.js; eval f; " + H, "f() { N=b.js; }; N=a.js; eval 'f'; " + H,
      "f() { eval N=b.js; }; N=a.js; f; " + H, 'f() { eval "N=b.js"; }; N=a.js; f; ' + H]) expect(classes(c), c).toContain("writer-exec");
  });
});

describe("shell classes: prefix assignments of a function call, time { }, and callees defined later", () => {
  const H = "cat lib/hidden.js > $N; node b.js";
  test("a prefix assignment on a call of a function persists; command exec does not", () => {
    expect(classes("f() { :; }; N=a.js; N=b.js f; " + H)).toContain("writer-exec");
    expect(classes("N=a.js; N=b.js command exec 3>/dev/null; cat lib/hidden.js > $N; node b.js")).toEqual([]);
  });
  test("an assignment after time { is an assignment", () => {
    expect(classes("N=a.js; time { N=b.js; } 2>/dev/null; " + H)).toContain("writer-exec");
  });
  test("a function that calls one defined after it forgets what that one sets", () => {
    for (const c of ["g() { f; }; f() { N=b.js; }; N=a.js; g; " + H, "g() { eval f; }; f() { N=b.js; }; N=a.js; g; " + H]) expect(classes(c), c).toContain("writer-exec");
  });
});

describe("shell classes: a function with a subshell body, deep call chains, time groups, eval prefixes, substitutions in a target", () => {
  const H = "cat lib/hidden.js > $N; node b.js";
  const held = (cmds: string[]) => { for (const c of cmds) expect(classes(c), c).toContain("writer-exec"); };
  test("S3b: f() ( : ) is a function and its call keeps the prefix assignment", () => {
    held(["f() ( : ); N=a.js; N=b.js f; " + H]);
  });
  test("a chain of calls reaches the names the last function sets", () => {
    held(["h() { g; }; g() { f; }; f() { N=b.js; }; N=a.js; h; " + H]);
  });
  test("a substitution in an outside target is not outside", () => {
    held(["cat lib/hidden.js > $TMPDIR/$(echo ../../../..)$(pwd)/b.js; node b.js", "cat lib/hidden.js > ~/$(echo ..)$(pwd)/b.js; node b.js", "cat lib/hidden.js > /tmp/`echo ..``pwd`/b.js; node b.js", "echo x > $(echo b.js); node b.js"]);
  });
  test("a time group after && and time -p { } track their blocks", () => {
    held(["N=b.js; false && time { :; N=a.js; } 2>/dev/null; " + H, "N=a.js; if false; then time -p { :; } 2>/dev/null; N=b.js; fi; cat lib/hidden.js > $N; node a.js",
      "N=a.js; while false; do time -p { :; }; N=b.js; done; cat lib/hidden.js > $N; node a.js", "N=a.js; time -p { N=b.js; } 2>/dev/null; " + H]);
  });
  test("an eval with a prefix assignment changes the names of this shell", () => {
    held(["N=a.js; X=1 eval 'N=b.js'; " + H, "N=a.js; X=1 eval N=b.js; " + H]);
  });
  test("export of a name built from an npm variable and a substitution is an env-assign", () => {
    expect(classes("export $npm_config_a$(cat lib/x.env); node a.js")).toContain("env-assign");
  });
  test("a write to ~/ is outside the package and does not name a file in it", () => {
    expect(classes("echo x > ~/a.js; node a.js")).toEqual([]);
  });
  test("a function is recorded whatever its body: case, if, for, while, function f case", () => {
    held(["f() case x in *) :;; esac; N=a.js; N=b.js f; " + H, "function f case x in *) :;; esac; N=a.js; N=b.js f; " + H,
      "f() case x in *) N=b.js;; esac; N=a.js; f; " + H, "f() if :; then N=b.js; fi; N=a.js; f; " + H,
      "f() for i in a; do N=b.js; done; N=a.js; f; " + H, "f() while :; do N=b.js; break; done; N=a.js; f; " + H]);
  });
  test("a call chain deeper than the fixpoint rounds is held, not quiet", () => {
    const deep = (n: number): string => { const nm = "abcdefghij".split(""); let t = ""; for (let i = 0; i < n; i++) t += `${nm[i]}(){ ${i < n - 1 ? nm[i + 1] + ";" : "N=b.js;"} }; `; return t + "N=a.js; a; " + H; };
    held([deep(5), deep(6), deep(8)]);
    expect(classes(deep(10)).length, "past the cap: widened").toBeGreaterThan(0);
  });
  test("export and declare -x of an npm_package_* name are env-assigns (the author sets them)", () => {
    expect(classes("export $npm_package_config_x; node a.js")).toContain("env-assign");
    expect(classes("declare -x $npm_package_config_x; node a.js")).toContain("env-assign");
    expect(classes("export $npm_config_foo; node a.js")).toEqual([]);
  });
  test("OP-4: ${N:=v} inside double quotes sets N", () => {
    held(['N=; : "${N:=b.js}"; ' + H, 'N=; : "${N:=b.js}"\n' + H, 'N=; echo "x${N:=b.js}y"; ' + H]);
  });
  test("OP-5: a write target default is not taken for a name the package manager or environment sets", () => {
    held(["cat lib/hidden.js > ${PNPM_SCRIPT_SRC_DIR:-/tmp}/b.js; node b.js", "cat lib/hidden.js > ${npm_config_x:-/tmp}/b.js; node b.js",
      "cat lib/hidden.js > ${INIT_CWD:-/tmp}/b.js; node b.js", "cat lib/hidden.js > ${TMPDIR:-/tmp}/b.js; node b.js"]);
    expect(classes("cat lib/hidden.js > ${LOGDIR:-/tmp}/b.js; node b.js")).toEqual([]);
  });
  test("OP-6: let ++N and $[N=2] set N; a brace sequence makes a file name", () => {
    held(["N=1; let ++N; cat lib/hidden.js > $N.js; node 2.js", "N=1; : $[N=2]; cat lib/hidden.js > $N.js; node 2.js", 'N=1; : "$[N=2]"; cat lib/hidden.js > $N.js; node 2.js']);
    expect(classes("node lib/hidde{n..n}.js")).toContain("computed-command");
  });
  test("OP-7: a single-quoted sh -c body does not see names this shell did not export", () => {
    held(["N=a.js; sh -c 'cat lib/hidden.js > ${N:-b.js}'; node b.js"]);
  });
  test("B1: a quoted tilde is a file name, not an expansion; an unquoted ~N/ still names the file", () => {
    held(['mkdir -p sub; cat lib/hidden.js > "~+/sub/x.js"; node "~+/sub/x.js"', "cat lib/hidden.js > '~+/sub/x.js'; node '~+/sub/x.js'",
      "cat lib/hidden.js > sub/x.js; node ~+/sub/x.js", "cat lib/hidden.js > sub/x.js; node ~1/sub/x.js", "cat lib/hidden.js > sub/x.js; node ~-1/sub/x.js"]);
    expect(classes('cat lib/hidden.js > sub/x.js; node "~+/sub/x.js"')).toEqual([]);
    expect(classes("cat lib/hidden.js > sub/x.js; node '~0/sub/x.js'")).toEqual([]);
    held(["cat lib/hidden.js > '~+/sub/x.js'; node ~\\+/sub/x.js", 'cat lib/hidden.js > "~+"/sub/x.js; node ~"+"/sub/x.js']);
  });
  test("B2: a default is not taken for a shell, CI or package-manager name", () => {
    held(["echo b.js; cat lib/hidden.js > ${_:-/dev/null}; node b.js", "read REPLY <<< b.js; cat lib/hidden.js > ${REPLY:-/dev/null}; node b.js",
      "getopts a: o -a b.js; cat lib/hidden.js > ${OPTARG:-/dev/null}; node b.js", "cat lib/hidden.js > ${GITHUB_WORKSPACE:-/tmp}/b.js; node b.js"]);
    expect(classes("cat lib/hidden.js > ${logdir:-/tmp}/b.js; node b.js")).toEqual([]);
    expect(classes("cat lib/hidden.js > ${LOG:-/dev/null}; node b.js")).toEqual([]);
  });
  test("F1: $[ ] is closed by its own bracket, not the first ]", () => {
    held(["N=1; : $[x[0]=1,N=2]; cat lib/hidden.js > $N.js; node 2.js", 'N=1; : "$[x[0]=1,N=2]"; cat lib/hidden.js > $N.js; node 2.js']);
  });
  test("B3: quote removal applies to a default word", () => {
    held(['cat lib/hidden.js > ${out:-"b.js"}; node b.js', "cat lib/hidden.js > ${out:-'b.js'}; node b.js", 'cat lib/hidden.js > ${out:-b\\.js}; node b.js', 'cp lib/hidden.js ${d:-"b.js"}; node b.js']);
  });
  test("B4: := in any redirect target sets the name; words expand before the targets", () => {
    held(['N=; true 2>sub/${N:=b.js}; cat lib/hidden.js > $N; node b.js', 'N=; true 2> "${N:=b.js}"; cat lib/hidden.js > $N; node b.js',
      'N=; cat lib/hidden.js > $N ${N:=b.js}; node b.js']);
  });
  test("B5: an empty quote in front of a ~ makes it literal; the other quoted-prefix spellings stay held", () => {
    const W = "cat lib/hidden.js > sub/x.js; ";
    for (const c of [W + "node ''~+/sub/x.js", W + 'node ""~+/sub/x.js', W + "sh -c \"node ''~+/sub/x.js\""]) expect(classes(c), c).toEqual([]);
    held([W + "node ~+/sub/x.js", "cat lib/hidden.js > ~\\+/b.js; node ~\\+/b.js", "cat lib/hidden.js > ''~+/b.js; node ''~+/b.js"]);
  });
  test("B6: a default word with quotes beside a backslash or $ is not read (held), a plain one still is", () => {
    for (const c of ["cat lib/hidden.js > ${out:-'b\\.js'}; node 'b\\.js'", "N=b.js; cat lib/hidden.js > ${out:-'$N'}; node '$N'", 'cat lib/hidden.js > ${out:-"b\\.js"}; node b.js'])
      expect(classes(c).length, c).toBeGreaterThan(0);
    held(['cat lib/hidden.js > ${out:-"b.js"}; node b.js']);
  });
  test("B7: a quoted ~ in an assignment value is the same literal name on the write and on the run", () => {
    held(["N='~+/b.js'; cat lib/hidden.js > \"$N\"; node \"~+/b.js\"", "N=~+/b.js; cat lib/hidden.js > \"$N\"; node b.js", "N=~'+'/b.js; cat lib/hidden.js > \"$N\"; node \"~+/b.js\""]);
  });
  test("~+//b.js: every slash after the tilde prefix is dropped", () => {
    held(["cat lib/hidden.js > b.js; node ~+//b.js", "cat lib/hidden.js > sub/x.js; node ~0//sub/x.js", "cat lib/hidden.js > sub/x.js; node ~+///sub/x.js"]);
  });
  test("B8: an empty quote between = and ~ in an assignment value makes the ~ literal", () => {
    held(["N=''~+/b.js; cat lib/hidden.js > \"$N\"; node \"~+/b.js\"", 'N=""~+/b.js; cat lib/hidden.js > "$N"; node "~+/b.js"',
      "export N=''~+/b.js; cat lib/hidden.js > \"$N\"; node \"~+/b.js\"", "declare N=''~+/b.js; cat lib/hidden.js > \"$N\"; node \"~+/b.js\"",
      "N=~+/b.js; cat lib/hidden.js > \"$N\"; node b.js"]);
  });
});

describe("shell classes: wrapper, loop and shell fail-opens", () => {
  const H = "cat lib/hidden.js > $N; node b.js";
  const held = (cmds: string[]) => { for (const c of cmds) expect(classes(c), c).toContain("writer-exec"); };
  test("a loop or compound before | or & runs in a subshell: a name it sets is not known after it", () => {
    held(["N=b.js; for N in a.js; do :; done | cat; " + H, "N=b.js; for N in a.js; do :; done & wait; " + H, "N=b.js; if N=a.js; then :; fi | cat; " + H]);
  });
  test("time before an assignment: the assignment is the command and sticks", () => {
    held(["N=a.js; time N=b.js; " + H, "N=a.js; time -p N=b.js; " + H, "N=a.js; ! N=b.js; " + H]);
  });
  test("assignments in arithmetic places: subscripts, offsets, [[ -eq ]], N[0]=, quoted $(( )), nested :=, case subject", () => {
    held(["N=a.js; : ${x[N=b.js]}; " + H, "N=1; : ${x:N=2}; cat lib/hidden.js > $N.js; node 2.js", "N=1; [[ 1 -eq N=2 ]]; cat lib/hidden.js > $N.js; node 2.js",
      "N=a.js; N[0]=b.js; " + H, 'N=1; : "$((N=2))"x; cat lib/hidden.js > $N.js; node 2.js', "N=; : ${x:-${N:=b.js}}; " + H, "N=; case ${N:=b.js} in *) ;; esac; " + H]);
  });
  test("builtins that set names: getopts OPTARG, read REPLY, declare -i/-n", () => {
    held(["OPTARG=a.js; getopts x: o -x b.js; cat lib/hidden.js > $OPTARG; node b.js", "REPLY=a.js; read <<< b.js; cat lib/hidden.js > $REPLY; node b.js",
      "N=a.js; declare -n N=M; M=b.js; " + H, "N=a.js; declare -i N=3; " + H.replace("b.js", "3")]);
  });
  test("a function body reads names when it is called, not where it is defined", () => {
    held(["N=a.js; f() { cat lib/hidden.js > $N; }; N=b.js; f; node b.js"]);
    held(["f() { N=b.js; cat lib/hidden.js > $N; node b.js; }; f"]);
  });
  test("a loop body runs again: a name it sets is not known at its start", () => {
    held(["N=a.js; for i in 1 2; do cat lib/hidden.js > $N; N=b.js; done; node b.js", "N=a.js; i=0; while [ $i -lt 2 ]; do cat lib/hidden.js > $N; N=b.js; i=1; done; node b.js"]);
    expect(classes("for f in a b; do cp x y/$f; done")).toEqual([]);
  });
  test("CFLAGS=-B~+/bin and -fplugin=~+/p.so name a place in the package", () => {
    expect(classes("CFLAGS=-B~+/bin make")).not.toEqual([]);
    expect(classes("CFLAGS=-fplugin=~+/p.so make")).not.toEqual([]);
  });
});

describe("shell classes: prefix words, quoted names and loop name sets", () => {
  const H = "cat lib/hidden.js > $N; node b.js";
  const held = (cmds: string[]) => { for (const c of cmds) expect(classes(c), c).not.toEqual([]); };
  test("R1: a function body that runs a name set outside it holds", () => {
    held(["N=a.js; f() { node $N; }; cat lib/hidden.js > b.js; N=b.js; f", 'N=a.js; f() { node "$N"; }; cat lib/hidden.js > b.js; N=b.js; f',
      "N=a.js; function f { node $N; }; cat lib/hidden.js > b.js; N=b.js; f", "N=a.js; f() { node $N/x.js; }; N=sub; cat lib/hidden.js > sub/x.js; f",
      "N=a.js; f() { node $N; }; cat lib/hidden.js > a.js; f", "N=a.js; f() { node $N; }; N=lib/hidden.js; f", "f() { node $N; }; cat lib/hidden.js > b.js; N=b.js; f"]);
  });
  test("R2: a quoted or escaped time, ! or keyword is a command, not the reserved word", () => {
    const w = (k: string) => `N=a.js; ${k} N=b.js; cat lib/hidden.js > $N; node a.js`;
    held([w("\\time"), w("\\!"), w("'time'")]);
  });
  test("loop second pass sees printf -vN and let ++N / --N", () => {
    held(["N=a.js; for i in 1 2; do cat lib/hidden.js > $N; printf -vN b.js; done; node b.js", "N=1; for i in 1 2; do cat lib/hidden.js > $N.js; let ++N; done; node 2.js",
      "N=1; for i in 1 2; do cat lib/hidden.js > $N.js; let --N; done; node 0.js"]);
  });
  test("subscripts are arithmetic in a[N=2]=x, read, declare, ${!x[ ]} and a quoted [[ -eq ]] operand; declare -i names evaluate later assignments", () => {
    held(["N=1; a[N=2]=x; cat lib/hidden.js > $N.js; node 2.js", "N=1; read a[N=2] <<< x; cat lib/hidden.js > $N.js; node 2.js", "N=1; declare a[N=2]=x; cat lib/hidden.js > $N.js; node 2.js",
      "N=1; : ${!x[N=2]}; cat lib/hidden.js > $N.js; node 2.js", 'N=1; [[ 1 -eq "N = 2" ]]; cat lib/hidden.js > $N.js; node 2.js', "declare -i N; N=1+1; cat lib/hidden.js > $N.js; node 2.js"]);
  });
  test("a for header on the right of a pipe runs in a subshell", () => {
    held(["N=a.js; echo | for N in b.js; do :; done; " + H.replace("b.js", "a.js"), "N=b.js; echo | for N in a.js; do :; done; " + H]);
  });
  test("CFLAGS=-fplugin=~/p.so and -specs=~/x: a ~ after a flag is literal", () => {
    held(["CFLAGS=-fplugin=~/p.so make", "CFLAGS=-specs=~/x make"]);
  });
});

describe("shell classes: time prefix words", () => {
  const body = (p: string, run = "a.js") => `N=a.js; ${p} N=b.js; cat lib/hidden.js > $N; node ${run}`;
  const held = (cmds: string[]) => { for (const c of cmds) expect(classes(c), c).not.toEqual([]); };
  test("R3: time is first, -p directly after it, ! first or after time / time -p; anything else is a command", () => {
    held([body("time time"), body("-p"), body("! -p"), body("! time"), body("time -p -p")]);
    expect(classes(body("!"))).toEqual([]); // a ! prefix is the assignment in every shell: N is b.js
    held([body("!", "b.js")]);
  });
  test("dash has no time keyword: N is not known after time / time -p", () => {
    held([body("time"), body("time -p"), body("time ! !"), body("time", "b.js")]);
  });
  test("a quoted or escaped assignment name is a command, with or without time", () => {
    held(['N=a.js; time "N"=b.js; cat lib/hidden.js > $N; node a.js', 'N=a.js; time \\N=b.js; cat lib/hidden.js > $N; node a.js', 'N=a.js; "N"=b.js; cat lib/hidden.js > $N; node a.js',
      'N=a.js; time N="b.js"; cat lib/hidden.js > $N; node b.js']);
  });
});

describe("shell classes: eval in a loop and namerefs", () => {
  const held = (cmds: string[]) => { for (const c of cmds) expect(classes(c), c).not.toEqual([]); };
  test("a loop second pass sees the names eval sets", () => {
    held(["N=a.js; for i in 1 2; do cat lib/hidden.js > $N; eval N=b.js; done; node b.js", "N=a.js; for i in 1 2; do cat lib/hidden.js > $N; eval 'N=b.js'; done; node b.js",
      'N=a.js; for i in 1 2; do cat lib/hidden.js > $N; eval "N=b.js"; done; node b.js', "N=a.js; while :; do cat lib/hidden.js > $N; eval N=b.js; break; done; node b.js",
      "N=a.js; for i in 1 2; do cat lib/hidden.js > $N; eval 'eval N=b.js'; done; node b.js", "N=a.js; for i in 1 2; do cat lib/hidden.js > $N; eval 'read N <<< b.js'; done; node b.js"]);
    expect(classes("for i in 1 2; do eval echo hi; done")).toEqual([]);
  });
  test("a write through a nameref writes its target (declare, typeset, local -n; read, for, +=, no target yet)", () => {
    held(["M=a.js; declare -n N=M; N=b.js; cat lib/hidden.js > $M; node b.js", "M=a.js; typeset -n N=M; N=b.js; cat lib/hidden.js > $M; node b.js",
      "M=a.js; f() { local -n N=M; N=b.js; }; f; cat lib/hidden.js > $M; node b.js", "M=a.js; declare -n N=M; read N <<< b.js; cat lib/hidden.js > $M; node b.js",
      "M=a.js; declare -n N=M; for N in b.js; do :; done; cat lib/hidden.js > $M; node b.js", "M=a.js; declare -n N=M; N+=b.js; cat lib/hidden.js > $M; node a.jsb.js",
      "M=a.js; declare -n N; N=M; N=b.js; cat lib/hidden.js > $M; node b.js", "M=b.js; declare -n N=M; cat lib/hidden.js > $N; node b.js"]);
  });
});

describe("shell classes: over-holds", () => {
  test("for and select set only their variable; the words after in are not names it sets", () => {
    for (const c of ["a=x.js; for f in a b; do :; done; cat lib/hidden.js > $a; node z.js", "b=z.js; for i in a b; do :; done; cat x > $b; node y.js",
      "a=1; select s in a b; do break; done; cat lib/hidden.js > $a.js; node z.js"]) expect(classes(c), c).toEqual([]);
  });
  test("export -n removes the export attribute; it is not a nameref and the name stays known", () => {
    for (const c of ["N=a.js; export -n N; N=b.js; cat lib/x.js > $N; node a.js", "N=a.js; export -n N; cat lib/x.js > $N; node b.js"]) expect(classes(c), c).toEqual([]);
  });
  test("the loop variable itself is still unknown on the second pass", () => {
    expect(classes("N=a.js; for N in b.js c.js; do cat lib/hidden.js > $N; done; node b.js")).not.toEqual([]);
  });
});

describe("shell classes: namerefs in a loop, eval behind wrappers and --, alias bodies", () => {
  const held = (cmds: string[]) => { for (const c of cmds) expect(classes(c), c).not.toEqual([]); };
  test("a nameref declared in a loop body links its name to its target on the second pass", () => {
    held(["M=a.js; for i in 1 2; do cat lib/hidden.js > $M; declare -n N=M; N=b.js; done; node b.js", "M=a.js; for i in 1 2; do cat lib/hidden.js > $M; typeset -n N=M; N=b.js; done; node b.js"]);
  });
  test("command, builtin and time in front of a builtin that sets a name, in a loop", () => {
    held(["N=a.js; for i in 1 2; do cat lib/hidden.js > $N; command eval N=b.js; done; node b.js", "N=a.js; for i in 1 2; do cat lib/hidden.js > $N; builtin eval N=b.js; done; node b.js",
      "N=a.js; for i in 1 2; do cat lib/hidden.js > $N; time eval N=b.js; done; node b.js", "N=a.js; for i in 1 2; do cat lib/hidden.js > $N; command read N <<< b.js; done; node b.js",
      "N=a.js; for i in 1 2; do cat lib/hidden.js > $N; command export N=b.js; done; node b.js", "N=a.js; for i in 1 2; do cat lib/hidden.js > $N; command -p eval N=b.js; done; node b.js"]);
  });
  test("eval -- takes the text after the --", () => {
    held(["N=a.js; eval -- N=b.js; cat lib/hidden.js > $N; node b.js", "N=a.js; eval -- 'N=b.js'; cat lib/hidden.js > $N; node b.js",
      "N=a.js; for i in 1 2; do cat lib/hidden.js > $N; eval -- 'N=b.js'; done; node b.js"]);
  });
  test("an alias body sees declare -i and -n names", () => {
    held(["N=a.js; alias f='declare -i N'; f; N=1+1; cat lib/hidden.js > $N.js; node 2.js", "M=a.js; alias f='declare -n N=M'; f; N=b.js; cat lib/hidden.js > $M; node b.js"]);
  });
});

describe("shell classes: nameref loop variables, wrapped and aliased declarations, export -n in a loop", () => {
  const held = (cmds: string[]) => { for (const c of cmds) expect(classes(c), c).not.toEqual([]); };
  test("a for whose variable is a nameref repoints it at each listed name", () => {
    held(["X=a.js; declare -n N=M; for N in X; do N=b.js; done; cat lib/hidden.js > $X; node b.js", "X=a.js; declare -n N=M; for i in 1 2; do for N in X; do N=b.js; done; done; cat lib/hidden.js > $X; node b.js"]);
  });
  test("a nameref declared behind builtin, command, eval or an alias inside a loop is linked", () => {
    held(["M=a.js; for i in 1 2; do cat lib/hidden.js > $M; builtin declare -n N=M; N=b.js; done; node b.js", "M=a.js; for i in 1 2; do cat lib/hidden.js > $M; command declare -n N=M; N=b.js; done; node b.js",
      "M=a.js; for i in 1 2; do cat lib/hidden.js > $M; eval 'declare -n N=M'; N=b.js; done; node b.js", "M=a.js; alias d='declare -n'; for i in 1 2; do cat lib/hidden.js > $M; d N=M; N=b.js; done; node b.js"]);
  });
  test("a nameref with no target set in a function forgets the names it may reach, also when the function is called later", () => {
    held(["M=a.js; f() { declare -n N; N=M; N=b.js; }; f; cat lib/hidden.js > $M; node b.js", "f() { declare -n N; N=M; N=b.js; }; M=a.js; f; cat lib/hidden.js > $M; node b.js"]);
  });
  test("export -n in a loop is not a nameref: the names stay known", () => {
    expect(classes("N=a.js; X=z.js; for i in 1 2; do export -n N; done; cat lib/x.js > $X; node b.js")).toEqual([]);
  });
});

describe("shell classes: a function called in a loop sets its names on every pass", () => {
  const held = (cmds: string[]) => { for (const c of cmds) expect(classes(c), c).not.toEqual([]); };
  test("export -n NAME=value, export and plain assignments in a function body called in a loop", () => {
    held(["function f { export -n N=b.js; }; N=a.js; for i in 1 2; do cat lib/hidden.js > ${N:-b.js}; f; done; node b.js", "function f { export -n N''=b.js; }; N=a.js; for i in 1 2; do cat lib/hidden.js > ${N:-b.js}; f; done; node b.js",
      "f() { export -n N''=b.js; }; N=a.js; for i in 1 2; do cat lib/hidden.js > \"$N\"; f; done; node b.js", "f() { export N=b.js; }; N=a.js; for i in 1 2; do cat lib/hidden.js > \"$N\"; f; done; node b.js",
      "f() { N=b.js; }; N=a.js; for i in 1 2; do cat lib/hidden.js > $N; f; done; node b.js"]);
  });
});

describe("shell classes: eval -- is read as bash and as dash read it", () => {
  const words = ["N=b.js", "'N=b.js'", '"N=b.js"', "N\\=b.js", "N''=b.js", 'N""=b.js', "'N'=b.js", '"N"=b.js', "N=b.js;", "N=b.js ; true", "N=\\b.js", "N=b'.js'", "N=b.js && :", "N=a.js N=b.js", 'N="b.js"', "export N=b.js", "read N <<< b.js", "N+=b.js", "X=1 N=b.js"];
  const wrap = (e: string, x: string) => [`N=a.js; ${e} ${x}; cat lib/hidden.js > $N; node b.js`, `N=a.js; for i in 1 2; do cat lib/hidden.js > $N; ${e} ${x}; done; node b.js`,
    `N=a.js; f() { ${e} ${x}; }; for i in 1 2; do cat lib/hidden.js > $N; f; done; node b.js`, `N=a.js; ${e} ${x} ; true | cat lib/hidden.js > $N; node b.js`];
  test("whatever eval X holds, eval -- X holds too (bash skips the --, dash does not: either may be the shell)", () => {
    for (const x of words) {
      const a = wrap("eval", x), b = wrap("eval --", x);
      for (let i = 0; i < a.length; i++) if (classes(a[i]!).length > 0) expect(classes(b[i]!).length > 0, b[i]).toBe(true);
    }
  });
  test("dash runs eval -- N=b.js as a command named --: N stays a.js, so the file node runs is the one written", () => {
    const tails = ["cat lib/hidden.js > ${N:-b.js}; node a.js", 'cat lib/hidden.js > "$N"; node a.js'];
    const heads = ["N=a.js; eval -- \\N=b.js", "N=a.js; eval -- 'N'=b.js", 'N=a.js; e""val -- N=b.js', 'N=a.js; { eval -- N""=b.js; }', 'N=a.js; { e""val -- N=b.js; }',
      "N=a.js; eval 'eval -- \\N=b.js'", "N=a.js; eval 'e'\\'''\\''val -- N=b.js'", "N=a.js; eval 'eva\\l -- N=b.js'", "N=a.js; eval -- N=b.js"];
    for (const h of heads) for (const t of tails) expect(classes(`${h}; ${t}`), `${h}; ${t}`).not.toEqual([]);
    // without the -- both shells set N: the file written is b.js and node runs a.js
    expect(classes('N=a.js; eval N=b.js; cat lib/hidden.js > "$N"; node a.js')).toEqual([]);
  });
});

describe("shell classes: a nameref to an unnamed target, and an eval with a syntax error in a loop", () => {
  const held = (cmds: string[]) => { for (const c of cmds) expect(classes(c), c).not.toEqual([]); };
  test("a write through a nameref whose target the body cannot name leaves no name's default standing", () => {
    held(["declare -n R; R=$1; R=b.js; cat lib/hidden.js > ${N:-a.js}; node b.js", "f() { declare -n R; R=$1; R=b.js; }; f N; cat lib/hidden.js > ${N:-a.js}; node b.js",
      "N=a.js; declare -n R; R=$1; R=b.js; cat lib/hidden.js > ${N:-a.js}; node b.js", "f() { declare -n R; R=$1; R=b.js; }; f; cat lib/hidden.js > ${N:-a.js}; node b.js"]);
  });
  test("an eval whose text fails to parse in a loop: the lines before the error still run on every pass", () => {
    held(["N=a.js; for i in 1 2; do cat lib/hidden.js > $N; eval 'N=b.js\n('; done; node b.js"]);
  });
});

describe("shell classes: a for over a nameref declared later in the loop body", () => {
  test("the nameref is linked before the for is read, wherever in the body it is declared", () => {
    for (const c of ["X=a.js; for i in 1 2 3; do cat lib/hidden.js > $X; for N in X; do N=b.js; done; declare -n N=M; done; node b.js", "X=a.js; for i in 1 2; do cat lib/hidden.js > $X; declare -n N=M; for N in X; do N=b.js; done; done; node b.js"]) expect(classes(c), c).not.toEqual([]);
  });
  test("a nameref whose target is built by a command substitution leaves no name's default standing", () => {
    for (const c of ["declare -n R; R=$(printf N); R=b.js; cat lib/hidden.js > ${N:-a.js}; node b.js", "f() { declare -n R; R=$(printf $1); R=b.js; }; f N; cat lib/hidden.js > ${N:-a.js}; node b.js"]) expect(classes(c), c).not.toEqual([]);
  });
});

describe("shell classes: a nameref to an unnamed target and the places a name is read", () => {
  const held = (cmds: string[]) => { for (const c of cmds) expect(classes(c), c).not.toEqual([]); };
  test("after a write through it, $HOME, $TMPDIR, a /dev/null default and an unset name in a run path may all name a package file", () => {
    held(["declare -n R; R=$1; R=.; cat lib/hidden.js > $HOME/b.js; node b.js", "declare -n R; R=$1; R=.; cat lib/hidden.js > $TMPDIR/b.js; node b.js",
      "declare -n R; R=$1; R=b.js; cat lib/hidden.js > ${LOG:-/dev/null}; node b.js", "declare -n R; R=$1; R=.; cat lib/hidden.js > ./b.js; node $P/b.js"]);
  });
  test("without such a write the same places stay outside the package", () => {
    for (const c of ["declare -n R=M; M=a.js; cat lib/hidden.js > $HOME/b.js; node a.js", "cat lib/hidden.js > ${LOG:-/dev/null}; node b.js"]) expect(classes(c), c).toEqual([]);
  });
  test("for N with no in runs over the arguments: a nameref loop variable may then point anywhere", () => {
    held(["declare -n N=M; for N; do N=b.js; done; cat lib/hidden.js > ${X:-a.js}; node b.js", "declare -n N=M; for i in 1 2; do for N; do N=b.js; done; done; cat lib/hidden.js > ${X:-a.js}; node b.js"]);
  });
});
