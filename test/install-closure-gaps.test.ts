import { expect, test } from "bun:test";
import { prepass, type FileMap } from "../src/prepass.ts";

const enc = (s: string) => new TextEncoder().encode(s);
const files = (o: Record<string, string>): FileMap => new Map(Object.entries(o).map(([k, v]) => [k, enc(v)]));
const holds = (old: FileMap, now: FileMap) => prepass("npm", old, now).hard.filter((s) => s.kind === "install-script").map((s) => s.detail);

// One file of the package changes between the two releases; the hook names none of them.
const release = (v: string, hook: string, changed: "lib/evil.js" | "docs/evil.js" | "none") =>
  files({
    "package.json": JSON.stringify({ name: "p", version: v, scripts: { postinstall: hook } }),
    "lib/evil.js": changed === "lib/evil.js" ? `console.log("evil ${v}")\n` : "console.log('evil')\n",
    "docs/evil.js": changed === "docs/evil.js" ? `console.log("evil ${v}")\n` : "console.log('evil')\n",
    "lib/ok.js": "console.log('ok')\n",
    "name.txt": "lib/evil.js\n",
    "d.txt": "lib\n",
  });

const N = "$(cat name.txt)";

// Lines the reader and the shell cut differently, or that evaluate or bind a substituted value: the file a substitution
// names may be in lib/ or docs/, so a change to either holds.
const reads: [string, string][] = [
  ["a plain brace inside a double-quoted default (dash does not count it)", `echo "\${X:-{}"; node ${N} | cat; echo "}"`],
  ["a plain brace inside an unquoted default", `echo \${X:-{}; node ${N} | cat; echo }`],
  ["single quotes that pair across the end of a double-quoted default", `echo "\${X:-'}"' $(node ${N}) '"'}"`],
  ["a single quote inside a double quote inside an unquoted default", `echo \${X:-"'"$(node ${N})"'"} | cat`],
  ["a variable read through an operator form", `F=${N}; cross-env A=1 node "\${F%%}" | cat`],
  ["a variable set on one line and used on the next", `F=${N}\ncross-env A=1 node "$F" | cat`],
  ["hash -p with a substituted path before a pipe", `hash -p "${N}" cat; cat x | cat`],
  ["hash -p with a substituted path", `hash -p "${N}" cat\ncat x`],
  ["a substituted value declared as an integer", `declare -i x=${N}`],
  ["a variable set by a substitution used in arithmetic", `F=${N}; echo $((F))`],
  ["a substituted value in a double bracket comparison", `[[ ${N} -eq 0 ]]`],
  ["a substituted name declared", `declare "${N}"`],
  ["a substituted name unset", `unset "${N}"`],
];

for (const [label, hook] of reads) {
  for (const changed of ["lib/evil.js", "docs/evil.js"] as const) {
    test(`${label} reads every file: a changed ${changed} holds`, () => {
      expect(holds(release("1.0.0", hook, "none"), release("1.0.1", hook, changed)).length).toBeGreaterThan(0);
    });
  }
}

const quiet: [string, string][] = [
  ["a default that holds another expansion", "echo ${X:-${Y:-a}} | cat"],
  ["a double-quoted default", 'echo "${X:-a}" | cat'],
  ["a lone single quote in a double-quoted default", `echo "\${X:-it's}" | cat`],
  ["paired single quotes with plain text in a double-quoted default", `echo "\${X:-'a b'}" | cat`],
  ["a variable set from a date and printed", "F=$(date)\necho $F | cat"],
  ["a local set from a date", "local x=$(date); echo done"],
  ["an export set from a date before a literal node run", "export F=$(date)\nnode lib/ok.js"],
  ["an integer declared from a number", "declare -i n=3"],
  ["a hash reset", "hash -r"],
  ["a string comparison", '[ "$(uname)" = Darwin ] && echo hi'],
];

for (const [label, hook] of quiet) {
  test(`${label} stays quiet: a changed docs/evil.js is not an install change`, () => {
    expect(holds(release("1.0.0", hook, "none"), release("1.0.1", hook, "docs/evil.js"))).toEqual([]);
  });
}

// A file the line names itself, in any directory: the line runs it by a way the splitter does not read as a command.
const dirs = ["lib", "docs", "test"] as const;
const releaseDir = (v: string, hook: string, changed: (typeof dirs)[number] | "none") =>
  files({
    "package.json": JSON.stringify({ name: "p", version: v, scripts: { postinstall: hook } }),
    ...Object.fromEntries(dirs.map((d) => [`${d}/evil.js`, changed === d ? `console.log("evil ${v}")\n` : "console.log('evil')\n"])),
  });

const named: [string, string][] = [
  ["a substitution text kept in a variable and evaluated by arithmetic", "x='a[$(node T/evil.js)]'; : $((x))"],
  ["a substitution in an unquoted heredoc body", "cat <<EOF >/dev/null\n$(node T/evil.js)\nEOF"],
  ["a backtick substitution in an unquoted heredoc body", "cat <<EOF >/dev/null\n`node T/evil.js`\nEOF"],
  ["a substitution text kept in a variable and evaluated by let", `v='a[$(node T/evil.js)]'; let "r=v"`],
  ["an eval of a quoted string that names a file", 'eval "node T/evil.js"'],
  ["a hash -p binding of a shell", "hash -p /bin/sh S; S -c 'node T/evil.js'"],
];

for (const [label, hook] of named) {
  for (const d of dirs) {
    test(`${label}: a changed ${d}/evil.js holds`, () => {
      const h = hook.replaceAll("T/", `${d}/`);
      expect(holds(releaseDir("1.0.0", h, "none"), releaseDir("1.0.1", h, d)).length).toBeGreaterThan(0);
    });
  }
}

const namedQuiet: [string, string][] = [
  ["a plain variable used in arithmetic", "x='a b'; : $((x))"],
  ["a let on numbers", "let n=1+2"],
  ["an eval of words that name no file", "eval echo hi"],
  ["a heredoc that holds a date", "cat <<EOF\n$(date)\nEOF"],
];

for (const [label, hook] of namedQuiet) {
  test(`${label} stays quiet: a changed docs/evil.js is not an install change`, () => {
    expect(holds(releaseDir("1.0.0", hook, "none"), releaseDir("1.0.1", hook, "docs"))).toEqual([]);
  });
}

// A bare brace in an unquoted default: what follows it on the line, or on the next, is still read.
const afterBrace: [string, string][] = [
  ["a bare brace in a default, then a node run", "echo ${X:-{}}; node T/evil.js"],
  ["a bare brace in a default, then a node run on the next line", "echo ${X:-{}}\nnode T/evil.js"],
  ["a bare brace in a pattern removal, then a node run", "echo ${X%%{*}; node T/evil.js"],
  ["a brace list in a default, then a node run", "echo ${OPTS:-{a,b}}; node T/evil.js"],
  ["a substitution text kept in a variable on one line and evaluated on the next", "x='a[$(node T/evil.js)]'\n: $((x))"],
];

for (const [label, hook] of afterBrace) {
  for (const d of dirs) {
    test(`${label}: a changed ${d}/evil.js holds`, () => {
      const h = hook.replaceAll("T/", `${d}/`);
      expect(holds(releaseDir("1.0.0", h, "none"), releaseDir("1.0.1", h, d)).length).toBeGreaterThan(0);
    });
  }
}

// Ordinary hooks that evaluate nothing the package controls stay quiet.
const benignEval: [string, string][] = [
  ["a root check with id -u", 'if [ "$(id -u)" -eq 0 ]; then echo root; fi'],
  ["a node version gate in a single-bracket test", `if [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 18 ]; then exit 1; fi`],
  ["a job count from nproc in arithmetic", "make -j$(( $(nproc) + 1 ))"],
  ["a timing line with date +%s in arithmetic", "S=$(date +%s); node lib/ok.js; echo $(( $(date +%s) - S ))"],
  ["a variable set from printf of a number, used in arithmetic on the next line", "x=$(printf 1)\n: $((x+1))"],
  ["a variable set from nproc, used in a test on the next line", 'N=$(nproc)\n[ "$N" -gt 4 ] && echo many'],
  ["an eval of a printf with a dotted number", 'eval "printf %s 1.0"'],
  ["an eval of a node run of an unrelated script", "eval node lib/ok.js"],
  ["an eval of an echo with a dotted word", "eval echo v1.2"],
  ["a hash -p of a system path", "hash -p /bin/echo echo; echo hi"],
  ["a hash -p of a system interpreter", "hash -p /usr/bin/python3 python"],
  ["an apostrophe in a double-quoted default with a node eval after it", `echo "\${MSG:-can't}" && node -e 'require("./lib/ok.js")'`],
];

for (const [label, hook] of benignEval) {
  test(`${label} stays quiet: a changed docs/evil.js is not an install change`, () => {
    expect(holds(releaseDir("1.0.0", hook, "none"), releaseDir("1.0.1", hook, "docs"))).toEqual([]);
  });
}

// A script that sets tens of thousands of distinct variables from substitutions reads in linear time: the time at four times
// the size stays within a small multiple of the time at one (a quadratic read would take 16 times as long).
test("many variables set from substitutions read in linear time", () => {
  const run = (mib: number): number => {
    const n = Math.floor((mib * 1048576) / 120);
    const hook = Array.from({ length: n }, (_, i) => `x${String(i).padStart(6, "0")}=$(cat n)${" ".repeat(100)}`).join("\n");
    const t0 = performance.now();
    holds(releaseDir("1.0.0", hook, "none"), releaseDir("1.0.1", hook, "docs"));
    return performance.now() - t0;
  };
  run(0.25);
  const small = run(1);
  const large = run(4);
  expect(large / small).toBeLessThan(8);
}, 120000);

// An unquoted heredoc runs its substitutions: the ones that only print a literal are not read, the others are.
const heredocHeld: [string, string][] = [
  ["a node run after literal printf substitutions", "cat <<EOF\n$(printf 1) $(echo hi) $(node T/evil.js)\nEOF"],
  ["the same node run twice", "cat <<EOF\n$(node T/evil.js) $(node T/evil.js)\nEOF"],
  ["a node run at the end of a pipe in a substitution", "cat <<EOF\n$(cat x | node T/evil.js)\nEOF"],
  ["a node run next to a plain substitution", "cat <<EOF\n$(cat x) $(node T/evil.js)\nEOF"],
];

for (const [label, hook] of heredocHeld) {
  for (const d of dirs) {
    test(`${label} in an unquoted heredoc: a changed ${d}/evil.js holds`, () => {
      const h = hook.replaceAll("T/", `${d}/`);
      expect(holds(releaseDir("1.0.0", h, "none"), releaseDir("1.0.1", h, d)).length).toBeGreaterThan(0);
    });
  }
}

const heredocQuiet: [string, string][] = [
  ["a printf of a number", "cat <<EOF\n$(printf 1)\nEOF"],
  ["an echo of a word", "cat <<EOF\nv$(echo 2) $(echo hi there)\nEOF"],
  ["a date", "cat <<EOF\n$(date +%s)\nEOF"],
  ["a plain cat", "cat <<EOF\n$(cat name.txt)\nEOF"],
];

for (const [label, hook] of heredocQuiet) {
  test(`${label} in an unquoted heredoc stays quiet: a changed docs/evil.js is not an install change`, () => {
    expect(holds(releaseDir("1.0.0", hook, "none"), releaseDir("1.0.1", hook, "docs"))).toEqual([]);
  });
}

// Round two: arithmetic on a name, a variable one level down, and shapes that only looked alike.
const deeper: [string, string][] = [
  ["a name printed by uname into arithmetic", "Darwin='a[$(node T/evil.js)]'\necho $(( $(uname -s) )) | cat"],
  ["a variable read in arithmetic inside a nested echo", 'X=$(cat name.txt); echo "$(echo $((X)))" | cat'],
  ["a variable read in arithmetic inside an eval string", "X=$(cat name.txt); eval ': $((X))' | cat"],
  ["a variable read in arithmetic inside a shell string", "export X=$(cat name.txt); bash -c ': $((X))' | cat"],
  ["a hash -p bound to a substituted path", 'hash -p "$(cat name.txt)" E; E'],
  ["a hash -p bound to a path of the package", "hash -p ./T/x E; E v"],
  ["an appended variable that holds a substitution", "x='a[$(node T/evil.js)]'; x+=1; : $((x))"],
];

for (const [label, hook] of deeper) {
  for (const d of dirs) {
    test(`${label}: a changed ${d}/evil.js holds`, () => {
      const h = hook.replaceAll("T/", `${d}/`);
      expect(holds(releaseDir("1.0.0", h, "none"), releaseDir("1.0.1", h, d)).length).toBeGreaterThan(0);
    });
  }
}

const roundTwoQuiet: [string, string][] = [
  ["a cd in a heredoc substitution before a node run", "cat <<EOF\n$(cd docs) $(node lib/ok.js)\nEOF"],
  ["a cd to the root in a heredoc substitution", "cat <<EOF\n$(cd /) $(node lib/ok.js)\nEOF"],
  ["a path printed by cd and pwd into a heredoc", "cat > paths.env <<EOF\nROOT=$(cd .. && pwd)\nEOF\nnode lib/ok.js"],
  ["a quoted default with a brace inside single quotes", `echo "\${X:-'a}b'}" | cat`],
  ["a default that holds a bare brace", "echo ${X:-{}} | cat"],
  ["a default that holds a brace list", "echo ${OPTS:-{a,b}} | cat"],
  ["a pattern removal that holds a bare brace", "echo ${X%%{*} | cat"],
  ["a double-quoted default of braces redirected", `echo "\${OPTS:-{}}" > opts.json`],
  ["a default of braces inside a substitution", `CFG=$(echo "\${npm_config_cfg:-{}}")`],
  ["a hash -p of echo with a dotted argument", "hash -p /bin/echo E; E v1.2"],
  ["a variable overwritten by a literal before arithmetic", "x='a[$(node docs/evil.js)]'; x=1; : $((x))"],
  ["a variable set from cat then overwritten", "x=$(cat name.txt); x=1; : $((x))"],
  ["a variable overwritten on a later line", "v=$(git describe)\nv=1\n[[ $v -gt 0 ]]"],
  ["a node version gate in a double-bracket test", `if [[ "$(node -p 'process.versions.node.split(".")[0]')" -lt 18 ]]; then exit 1; fi`],
  ["a job count from grep -c in arithmetic", "make -j$(( $(grep -c ^processor /proc/cpuinfo) + 1 ))"],
  ["a job count from nproc or a number", "make -j$(( $(nproc 2>/dev/null || echo 2) ))"],
  ["a count from wc -l in a double-bracket test", "[[ $(ls dist | wc -l) -eq 0 ]] && node lib/ok.js"],
  ["the major kernel version from uname -r and cut in a double-bracket test", "[[ $(uname -r | cut -d. -f1) -ge 20 ]] && echo new"],
];

for (const [label, hook] of roundTwoQuiet) {
  test(`${label} stays quiet: a changed docs/evil.js is not an install change`, () => {
    expect(holds(releaseDir("1.0.0", hook, "none"), releaseDir("1.0.1", hook, "docs"))).toEqual([]);
  });
}

// A heredoc with many substitutions reads in linear time: the time at four times the size stays within a small multiple of the
// time at one (a quadratic read would take 16 times as long). The median of three runs, with the literal ones and with distinct
// commands (which the dedupe does not collapse).
const median = (f: () => number): number => [f(), f(), f()].sort((a, b) => a - b)[1]!;
for (const [label, unit] of [["literal", (_i: number) => "$(printf 1) "], ["distinct", (i: number) => `$(node n${i}.js) `]] as const) {
  test(`a heredoc with many ${label} substitutions reads in linear time`, () => {
    const run = (mib: number): number => {
      const n = Math.floor((mib * 1048576) / 14);
      const hook = "cat <<EOF\n" + Array.from({ length: n }, (_, i) => unit(i)).join("") + "\nEOF";
      const t0 = performance.now();
      holds(releaseDir("1.0.0", hook, "none"), releaseDir("1.0.1", hook, "docs"));
      return performance.now() - t0;
    };
    run(0.25);
    const small = median(() => run(0.5));
    const large = median(() => run(2));
    expect(large / small).toBeLessThan(8);
  }, 120000);
}

// Unclosed spans: each `${` that never closes scans to the end of the text, so a text of many of them must stop reading them after
// a few. A quadratic read takes 16 times as long at four times the size; a linear one about 4. Median of three runs.
const scriptHook = (body: string) => files({
  "package.json": JSON.stringify({ name: "p", version: "1.0.0", scripts: { postinstall: "sh install.sh" } }),
  "install.sh": body,
});
const scriptTime = (body: string): number => {
  const t0 = performance.now();
  holds(scriptHook(body + "true\n"), scriptHook(body + "true \n"));
  return performance.now() - t0;
};
const lines = (bytes: number, line: (i: number) => string): string => {
  const out: string[] = [];
  for (let n = 0, i = 0; n < bytes; i++) {
    const l = line(i);
    out.push(l);
    n += l.length;
  }
  return out.join("");
};
const shapes: [string, (bytes: number) => string][] = [
  ["a line per unclosed default with a dollar and a quote", (b) => lines(b, (i) => `echo "\${X${i}:-'a$'"\n`)],
  ["a line per unclosed brace", (b) => lines(b, (i) => `: \${X${i}\n`)],
  ["one long line of unclosed braces", (b) => ": ${X ".repeat(Math.floor(b / 6)) + "\n"],
];
for (const [label, make] of shapes) {
  test(`${label} reads in linear time`, () => {
    scriptTime(make(20000));
    const small = median(() => scriptTime(make(30000)));
    const large = median(() => scriptTime(make(120000)));
    expect(large / small).toBeLessThan(9);
  }, 60000);
}

// The files a hook line names are found through an index of the names, not by walking every name once per command. The reads of
// eval and heredoc lines cost a small multiple of the same commands on lines of their own.
const costShapes: [string, (bytes: number) => string][] = [
  ["eval lines that name distinct files", (b) => lines(b, (i) => `eval node lib/x${i}.js\n`)],
  ["a heredoc of substitutions that name distinct files", (b) => "cat <<EOF >/dev/null\n" + lines(b, (i) => `$(node n${i}.js)\n`) + "EOF\n"],
];
for (const [label, make] of costShapes) {
  test(`${label} cost a small multiple of plain lines`, () => {
    const plain = (b: number) => lines(b, (i) => `node lib/x${i}.js\n`);
    scriptTime(plain(100000));
    const control = median(() => scriptTime(plain(400000)));
    const shape = median(() => scriptTime(make(400000)));
    expect(shape / control).toBeLessThan(6);
  }, 60000);
}
