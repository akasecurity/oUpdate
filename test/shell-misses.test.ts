import { describe, expect, test } from "bun:test";
import { flagBody } from "../src/shell-classes.ts";
import { prepass, type FileMap } from "../src/prepass.ts";

// Install lines where lib/hidden.js runs in at least one of sh, bash and dash while the scanner's own variable tracking
// read them as running only the unchanged file. Each meets a construct the tracking does not model; the scanner must
// stop trusting the names it touches and hold, naming the changed file.

const enc = new TextEncoder();
const map = (f: Record<string, string>): FileMap => new Map(Object.entries(f).map(([k, v]) => [k, enc.encode(v)]));
const pj = (hook: string) => JSON.stringify({ name: "x", version: "1", scripts: { postinstall: hook } });

// The detail of each install-script hold when only lib/hidden.js changes between the releases.
function details(hook: string): string[] {
  const base: Record<string, string> = { "package.json": pj(hook), "a.js": "1", "lib/hidden.js": "1" };
  const n = { ...base, "lib/hidden.js": "changed()" };
  return prepass("npm", map(base), map(n)).hard.filter((s) => s.kind === "install-script").map((s) => s.detail);
}

const families: [string, string[]][] = [
  ["a subscript or array index with an assignment in it is arithmetic: it sets the name", [
    "N=1; a=([N=2]=x); cat lib/hidden.js > $N.js; node 2.js",
    "N=1; true && a=([N=2]=x); cat lib/hidden.js > ${N}.js; node 2.js",
    "N=1; for i in 1 2; do cat lib/hidden.js > \"$N\".js; eval 'a=([N=2]=x)'; done; node 2.js",
    "x=(q); a=(q r s); N=1; : ${#x[N=2]}; cat lib/hidden.js > $N.js; node 2.js",
    "f() { : ${#x[N=2]}; }; x=(q); a=(q r s); N=1; f; cat lib/hidden.js > ${N}.js; node 2.js",
    "x=(q); a=(q r s); N=1; unset 'a[N=2]'; cat lib/hidden.js > $N.js; node 2.js",
    "function f { unset a[N=2]; }; x=(q); a=(q r s); N=1; for i in 1 2; do cat lib/hidden.js > $N.js; f; done; node 2.js",
    "x=(q); a=(q r s); N=1; for i in 1 2; do cat lib/hidden.js > $N.js; eval 'unset '\\''a[N=2]'\\'''; done; node 2.js",
  ]],
  ["time, builtin, a quoted keyword or a stray reserved word before a builtin: the shells disagree on what runs", [
    "N=a.js; time eval \\N=b.js; cat lib/hidden.js > $N; node a.js",
    "N=a.js; \\builtin eval N=b.js; cat lib/hidden.js > ${N:-b.js}; node a.js",
    "N=a.js; { 'time' eval N=b.js; }; cat lib/hidden.js > $N; node a.js",
    "N=a.js; eval 'builtin eval N'\\'''\\''=b.js'; cat lib/hidden.js > ${N}; node a.js",
    "N=a.js; time \"{\" N=b.js; cat lib/hidden.js > $N; node a.js",
    "N=a.js; { time \\{ N=b.js; }; cat lib/hidden.js > ${N:-b.js}; node a.js",
    "N=a.js; 'for' N in b.js; cat lib/hidden.js > $N; node a.js",
    "N=a.js; time \"for\" N in b.js; cat lib/hidden.js > ${N:-b.js}; node a.js",
    "N=a.js; for \\N in b.js; do :; done; cat lib/hidden.js > $N; node a.js",
    "N=a.js; eval '! ! N=b.js'; cat lib/hidden.js > ${N:-b.js}; node a.js",
    "N=a.js; eval 'done N=b.js'; cat lib/hidden.js > ${N:-b.js}; node a.js",
    "N=a.js; eval 'while N=b.js'; cat lib/hidden.js > \"$N\"; node a.js",
    "N=a.js; N\\=b.js; cat lib/hidden.js > $N; node a.js",
  ]],
  ["unset on one pass of a loop: ${N:-x} on the next pass is the default", [
    "N=a.js; for i in 1 2; do cat lib/hidden.js > ${N:-b.js}; unset N; done; node b.js",
    "N=a.js; i=0; until [ $i -ge 2 ]; do cat lib/hidden.js > ${N:-b.js}; unset \\N; i=$((i+1)); done; node b.js",
    "N=a.js; i=0; while [ $i -lt 2 ]; do cat lib/hidden.js > ${N:-b.js}; unset N''; i=$((i+1)); done; node b.js",
    "N=a.js; for i in 1 2; do cat lib/hidden.js > ${N:-b.js}; eval 'unset -v N'; done; node b.js",
  ]],
  ["a quoted esac in a case pattern is a pattern, not the end of the case", [
    "N=a.js; case x in y) :;; \"esac\" ) N=b.js;; esac; cat lib/hidden.js > \"$N\"; node a.js",
    "N=a.js; true && case x in y) :;; 'esac' ) N=b.js;; esac; cat lib/hidden.js > ${N}; node a.js",
    "N=a.js; false || case x in y) :;; esa\\c ) N=b.js;; esac; cat lib/hidden.js > $N; node a.js",
    "N=a.js; true && case x in y) :;; e''sac ) N=b.js;; esac; cat lib/hidden.js > ${N:-b.js}; node a.js",
    "N=a.js; eval 'case x in y) :;; esa\\c ) N=b.js;; esac'; cat lib/hidden.js > \"$N\"; node a.js",
  ]],
  ["declare, read or an array literal into a[0] changes $a", [
    "a=a.js; false || declare a[0]=b.js; cat lib/hidden.js > $a; node b.js",
    "a=a.js; eval 'declare a[0]=b.js'; cat lib/hidden.js > ${a}; node b.js",
    "a=a.js; for i in 1 2; do cat lib/hidden.js > $a; read a[0] < f; done; node b.js",
    "a=a.js; for i in 1 2; do cat lib/hidden.js > ${a}; read 'a[0]' < f; done; node b.js",
    "a=a.js; { a=(b.js); }; cat lib/hidden.js > \"$a\"; node b.js",
    "a=a.js; eval 'a=([0]=b.js)'; cat lib/hidden.js > $a; node b.js",
  ]],
  ["${N:=x} in an unquoted heredoc body sets N", [
    "N=; cat >/dev/null <<E\n${N:=b.js}\nE\ncat lib/hidden.js > $N; node b.js",
    "N=\nfalse || cat >/dev/null <<E\n${N:=b.js}\nE\ncat lib/hidden.js > $N\nnode b.js",
    "N=; for i in 1 2; do cat lib/hidden.js > $N; cat >/dev/null <<E\n${N:=b.js}\nE\ndone; node b.js",
    "N=; i=0; while [ $i -lt 2 ]; do cat lib/hidden.js > $N; cat >/dev/null <<E\n${N:=b.js}\nE\ni=$((i+1)); done; node b.js",
  ]],
  ["an unclosed [[ is a command named [[ in dash: the assignment after it is an argument", [
    "N=a.js; { [[ N=b.js; }; cat lib/hidden.js > ${N}; node a.js",
    "f() { [[ N=b.js; }; N=a.js; for i in 1 2; do cat lib/hidden.js > ${N:-b.js}; f; done; node a.js",
    "f() { time [[ N=b.js; }; N=a.js; for i in 1 2; do cat lib/hidden.js > ${N}; f; done; node a.js",
    "N=a.js; i=0; until [ $i -ge 2 ]; do cat lib/hidden.js > $N; [[ N=b.js; i=$((i+1)); done; node a.js",
  ]],
];

describe("constructs the variable tracking cannot model hold, naming lib/hidden.js", () => {
  for (const [family, lines] of families) {
    describe(family, () => {
      for (const hook of lines) {
        test(JSON.stringify(hook), () => {
          expect(details(hook)).toContain("file lib/hidden.js");
        });
      }
    });
  }
});

describe("the same constructs with nothing to hide stay quiet", () => {
  for (const c of ["a=(x y); node a.js", "x=(q); : ${#x[0]}; node a.js", "unset N; node a.js", "for i in 1 2; do unset N; done; node a.js",
    "case x in \"esac\") :;; esac; node a.js", "cat >/dev/null <<E\n${N:-x}\nE\nnode a.js", "time eval 'echo hi'; node a.js", "! N=b.js; node a.js"]) {
    test(JSON.stringify(c), () => {
      expect(flagBody(c)).toEqual([]);
    });
  }
});
