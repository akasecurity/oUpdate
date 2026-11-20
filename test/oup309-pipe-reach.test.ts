// A hook with a pipe reads the same files as the hook without it: every stage of a hook line that is not split into commands (a pipe, a
// redirect, a group, a subshell, `&`) is read through the reader a bare command goes through, except that a plain tool (cat, tee, grep...)
// that names nothing of the package does not widen the package for the pipe it sits in.
import { describe, expect, test } from "bun:test";
import { prepass, type FileMap } from "../src/prepass.ts";

const enc = new TextEncoder();
const map = (f: Record<string, string>): FileMap => new Map(Object.entries(f).map(([k, v]) => [k, enc.encode(v)]));
const held = (o: Record<string, string>, n: Record<string, string>) => prepass("npm", map(o), map(n)).hard.some((s) => s.kind === "install-script");

const A = "module.exports = 1;\n";
const B = "module.exports = 2;\n";
const rel = (main: string, hook: string, over: Record<string, string> = {}, extra: object = {}) => ({
  "package.json": JSON.stringify({ name: "x", version: "1", main, scripts: { postinstall: hook }, ...extra }),
  "docs/a.js": A,
  "docs/b.js": B,
  ...over,
});

const FORMS = [
  "node . | tee log",
  "node . ; echo a | cat",
  "echo a | cat ; node .",
  "npx . | tee log",
  "node . && echo a | cat",
  "(node .) | cat",
  "node . 2>&1 | cat",
  "node . a\\|b",
  "bash -c 'node .' | cat",
  "node . |& cat",
  "node . & wait",
  "{ node .; } | cat",
  "echo a\nnode . | cat",
  "echo a | cat\nnpx . | cat",
  "if true; then node . | cat; fi",
  "true && (npx .) | cat",
  "node . > out.log | cat",
  "FOO=1 node . | cat",
  "cat f | node .",
  "node . < in.txt | cat",
];

// A script file that runs the package, then the pipe after it.
const VIA_SH = ["bash run.sh | cat", "sh ./run.sh | tee log", "./run.sh | cat"];

describe("a hook with a pipe reads the same files as without: a main retarget is held", () => {
  for (const hook of VIA_SH) {
    test(`${hook} (run.sh runs node .): main onto an unchanged file`, () => {
      const over = { "run.sh": "node .\n" };
      expect(held(rel("docs/a.js", hook, over), rel("docs/b.js", hook, over))).toBe(true);
    });
  }
  test("control: the bare commands hold", () => {
    for (const h of ["node .", "npx ."]) expect(held(rel("docs/a.js", h), rel("docs/b.js", h))).toBe(true);
  });
  for (const hook of FORMS) {
    test(`${hook}: main onto an unchanged file`, () => {
      expect(held(rel("docs/a.js", hook), rel("docs/b.js", hook))).toBe(true);
    });
    test(`${hook}: main onto a file whose bytes changed`, () => {
      expect(held(rel("docs/a.js", hook), rel("docs/b.js", hook, { "docs/b.js": B + "// changed\n" }))).toBe(true);
    });
  }
});

// The main file's own bytes change (no retarget), with a pipe, a redirect or a pipe into a shell in the hook.
describe("a change in the bytes of main itself is held whatever the hook pipes", () => {
  const FORMS2 = [
    "node . | cat",
    "node . && echo hi > f",
    "node . && echo hi | sh",
    "echo hi | sh && node .",
    "node . ; echo hi | cat",
    "npx . && echo hi | cat",
    "fetch-step | sh && node .",
    // controls that held before: a bare redirect, a pipe into a shell, a named file
    "node . > log",
    "node . | sh",
    "node lib/a.js | cat",
  ];
  const withMain = (hook: string, bytes: string) => rel("lib/a.js", hook, { "lib/a.js": bytes });
  for (const hook of FORMS2) {
    test(`${hook}: main lib/a.js changes its bytes`, () => {
      expect(held(withMain(hook, A), withMain(hook, A + "// changed\n"))).toBe(true);
    });
  }
  test("a pipe that runs nothing of the package, and nothing changed: released (a control, no false hold)", () => {
    const hook = "echo hi | cat";
    expect(held(withMain(hook, A), withMain(hook, A))).toBe(false);
  });
  test("a pipe with a quoted `|` is no pipe: `echo 'a | b' && node .` is read, and a main change is held", () => {
    const hook = "echo 'a | b' && node .";
    expect(held(withMain(hook, A), withMain(hook, A + "// changed\n"))).toBe(true);
  });
});

// (Not in the list: cat, grep, `npm ls` and the like. Bare, each widens the package, so a change to a file nothing reaches holds; as a stage of
// a pipe they keep reading as before, quietly: that is the one difference from the bare command, and it is deliberate.)
// The property: a command in a pipeline, with a redirect, or after a producer is read like the bare command. For every bare form X, the
// lines `X | cat`, `X > log`, `echo a | X` and `X | tee log; true` hold whenever X holds (the wrapped line may hold more: a redirect or a
// producer is itself read), for a moved main, a changed main and a changed file nothing reaches.
describe("a command reads the same with a pipe or a redirect around it as bare", () => {
  const BARE = [
    "node .", "npx .", "node docs/a.js", "node -r . -e 1", "node --require . -e 1", "node --import . -e 1", "node -e 'require(\".\")'", "bun .", "npm exec -- node .",
    "pnpm exec node .", "corepack pnpm exec node .", "node . -c x", "node . -p x", "npx -p x .", "npx -c 'node .'", "node --require=. -e 1",
    "cross-env FOO=1 node .", "dotenv -- node .", "c8 node .", "nodemon .", "electron .", "concurrently 'node .'", "eval 'node .'",
    "gulp", "webpack", "python3 -c 'import helper'", "env gulp", "nice gulp", "nohup gulp", "nice -n 5 gulp", "sh -c 'gulp'", "FOO=1 gulp", "command gulp", "exec gulp", "nodemon", "mytool", "env mytool", "pnpm exec mytool", "yarn exec mytool", "pnpx mytool", "yarnpkg mytool", "xargs npx mytool",
    "cross-env npm run x", "dotenv -- npm run x", "flock l npm run x",
    "flock x node .", "ionice -c3 node .", "setsid node .", "caffeinate node .", "busybox sh -c 'node .'", "bash run.sh", "./run.sh", "FOO=1 node .", "(node .)", "{ node .; }",
    "node build.js", "npm run build", "echo a", "true",
  ];
  const WRAPS: [string, (x: string) => string][] = [["| cat", (x) => `${x} | cat`], ["> log", (x) => `${x} > log`], ["echo a |", (x) => `echo a | ${x}`], ["| tee; true", (x) => `${x} | tee log; true`]];
  const files = (main: string, hook: string, over: Record<string, string> = {}) => rel(main, hook, { "run.sh": "node .\n", "build.js": "console.log(1);\n", "src/z.js": A, ...over });
  const scenarios: [string, (h: string) => [Record<string, string>, Record<string, string>]][] = [
    ["main moved", (h) => [files("docs/a.js", h), files("docs/b.js", h)]],
    ["main bytes changed", (h) => [files("docs/a.js", h), files("docs/a.js", h, { "docs/a.js": A + "// changed\n" })]],
    ["unreached file changed", (h) => [files("docs/a.js", h), files("docs/a.js", h, { "src/z.js": A + "// changed\n" })]],
  ];
  for (const x of BARE) {
    test(`${x}: the wrapped lines hold whenever the bare command does`, () => {
      for (const [scn, mk] of scenarios) {
        const [bo, bn] = mk(x);
        const bare = held(bo, bn);
        for (const [label, wrap] of WRAPS) {
          const [wo, wn] = mk(wrap(x));
          // Never fewer holds than the bare command.
          expect({ x, label, scn, held: bare ? held(wo, wn) : true }).toEqual({ x, label, scn, held: true });
        }
      }
    });
  }
});

describe("a hook line with a line continuation, and a script file, read with a pipe as without", () => {
  test("a backslash-newline inside a stage", () => {
    for (const hook of ["echo a | \\\nnode .", "\\\nnode . | cat", "node \\\n. | cat", "echo a && \\\nnode ."]) {
      expect({ hook, held: held(rel("docs/a.js", hook), rel("docs/b.js", hook)) }).toEqual({ hook, held: true });
      expect({ hook, held: held(rel("docs/a.js", hook), rel("docs/a.js", hook, { "docs/a.js": A + "// changed\n" })) }).toEqual({ hook, held: true });
    }
  });
  test("a script file whose line has a pipe reads as without it", () => {
    const run = (body: string) => ({ "run.sh": body });
    for (const [hook, body] of [["sh run.sh", "node . | cat\n"], ["./run.sh", "echo a | cat\nnode .\n"], ["bash run.sh", "node . > log\n"]] as const) {
      expect({ hook, held: held(rel("docs/a.js", hook, run(body)), rel("docs/b.js", hook, run(body))) }).toEqual({ hook, held: true });
    }
  });
});

describe("more forms, and the cost", () => {
  test("a script run by its path, with an assignment before it, and a bin by its path", () => {
    for (const hook of ["FOO=1 ./run.sh | cat", "./bin/x | cat"]) {
      const over = { "run.sh": "node .\n", "bin/x": "node .\n" };
      const a = rel("docs/a.js", hook, over);
      expect({ hook, held: held(a, rel("docs/a.js", hook, { ...over, "docs/a.js": A + "// changed\n" })) }).toEqual({ hook, held: true });
    }
  });
  test("`node -v | cat` runs nothing of the package: a change to main is not held (as bare)", () => {
    const hook = "node -v | cat";
    expect(held(rel("docs/a.js", hook), rel("docs/a.js", hook, { "docs/a.js": A + "// changed\n" }))).toBe(held(rel("docs/a.js", "node -v"), rel("docs/a.js", "node -v", { "docs/a.js": A + "// changed\n" })));
  });
  test("a hook of 10,000 stages reads in seconds, and the large manifest is parsed once", () => {
    const hook = Array.from({ length: 10_000 }, () => "node . | cat").join("\n");
    const big = (v: string) => ({ ...rel("docs/a.js", hook), "package.json": JSON.stringify({ name: "x", version: v, main: "docs/a.js", pad: "x".repeat(1_000_000), scripts: { postinstall: hook } }) });
    const t = performance.now();
    held(big("1"), big("2"));
    expect(performance.now() - t).toBeLessThan(20_000);
  });
});

describe("a hook of thousands of DISTINCT stages is read in linear time", () => {
  // Distinct lines: identical ones are skipped by the once-per-stage key. Each distinct `npx . aN` names a directory; a walk over all the
  // named directories at every widen was quadratic (16,000 lines: 46.6 s on build, about 1.5 s now).
  for (const prefix of ["", "nice env "]) {
    test(`16,000 distinct \`${prefix}npx . aN | cat\` lines`, () => {
      const hook = Array.from({ length: 16_000 }, (_, i) => `${prefix}npx . a${i} | cat`).join("\n");
      const t = performance.now();
      held(rel("docs/a.js", hook), rel("docs/a.js", hook, { "docs/a.js": A + "// changed\n" }));
      expect(performance.now() - t).toBeLessThan(15_000);
    }, 60_000);
  }
});

describe("a runner stage keeps the bare reading even when it is the quiet half of a two-line hook", () => {
  // The stage runs the script `x` (a build tool): the later bare `npm run x` is read once per scan, so the stage's reading must be the bare one.
  const scripts = (hook: string, z: string) => ({
    "package.json": JSON.stringify({ name: "x", version: "1", main: "docs/a.js", scripts: { postinstall: hook, x: "nodemon" } }),
    "docs/a.js": A,
    "src/z.js": z,
  });
  for (const hook of ["cross-env npm run x | cat\nnpm run x", "dotenv -- npm run x | cat\nnpm run x", "flock l npm run x | cat\nnpm run x", "cross-env npm run x > log; npm run x"]) {
    test(`${JSON.stringify(hook)}: a file nothing names changes, held as without the first line`, () => {
      const bare = "npm run x";
      expect(held(scripts(bare, A), scripts(bare, A + "// changed\n"))).toBe(true);
      expect(held(scripts(hook, A), scripts(hook, A + "// changed\n"))).toBe(true);
    });
  }
  test("a build tool or an interpreter as the whole stage widens as bare does (gulp, python3 -c, env gulp, sh -c 'gulp')", () => {
    for (const hook of ["gulp | tee build.log", "python3 -c 'import helper' | cat", "env gulp | cat", "sh -c 'gulp' | cat", "webpack | cat"]) {
      const f = (z: string) => ({ ...rel("docs/a.js", hook), "src/z.js": z });
      expect({ hook, held: held(f(A), f(A + "// changed\n")) }).toEqual({ hook, held: true });
    }
  });
});

describe("a script or body read from a stage is read as itself (the stage's quiet reading does not leak into it)", () => {
  // `x` runs a plain command: read from the stage it must not stay quiet, or the later bare `npm run x` (read once per scan) is skipped.
  const withX = (hook: string, x: string, z: string) => ({
    "package.json": JSON.stringify({ name: "x", version: "1", main: "docs/a.js", scripts: { postinstall: hook, x } }),
    "docs/a.js": A,
    "src/z.js": z,
  });
  for (const x of ["rm -rf dist", "mkdir out", "cat f", "nodemon"]) {
    for (const hook of ["cross-env npm run x | cat\nnpm run x", "npm run x | cat\nnpm run x", "sh -c 'npm run x' | cat\nnpm run x"]) {
      test(`${JSON.stringify(hook)} with x = ${JSON.stringify(x)}: held as the bare second line is`, () => {
        expect(held(withX("npm run x", x, A), withX("npm run x", x, A + "// changed\n"))).toBe(true);
        expect({ hook, held: held(withX(hook, x, A), withX(hook, x, A + "// changed\n")) }).toEqual({ hook, held: true });
      });
    }
  }
  test("a body read from a stage (`sh -c`) is read as itself", () => {
    const hook = "sh -c 'rm -rf dist' | cat\nsh -c 'rm -rf dist'";
    const f = (z: string) => ({ ...rel("docs/a.js", hook), "src/z.js": z });
    expect(held(f(A), f(A + "// changed\n"))).toBe(true);
  });
});


describe("a script file read from a stage is read as itself; a backslash-newline before an operator keeps the runner reading", () => {
  const rows = (hook: string, scripts: Record<string, string>, over: Record<string, string>) => (z: string) => ({
    "package.json": JSON.stringify({ name: "x", version: "1", main: "docs/a.js", scripts: { postinstall: hook, ...scripts } }),
    "docs/a.js": A,
    "src/z.js": z,
    ...over,
  });
  for (const body of ["mkdir out\n", "mkdir -p out\n", "mkdir out\nnode build.js\n"]) {
    for (const hook of ["bash run.sh | cat", "bash run.sh > log", "echo a | bash run.sh", "(bash run.sh)", "bash run.sh &", "sh run.sh > log; sh run.sh", "cross-env bash run.sh | cat\nbash run.sh", "bash run.sh | cat\nnpm run x"]) {
      test(`${JSON.stringify(hook)} with run.sh = ${JSON.stringify(body)}: held as the bare \`bash run.sh\` is`, () => {
        const f = rows(hook, { x: "bash run.sh" }, { "run.sh": body, "build.js": "1\n" });
        expect({ hook, held: held(f(A), f(A + "// changed\n")) }).toEqual({ hook, held: true });
      });
    }
  }
  const lines = ["npm run x \\\n| cat", "npm run x \\\n> log", "npm run x \\\n&& echo a | cat", "npm run x \\\n|| node build.js | cat", "env FOO=1 npm run x \\\n| cat", "nice npm run x \\\n| cat", "xargs npm run x \\\n| cat", "command npm run x \\\n| cat", "timeout 5 npm run x \\\n| cat", "sudo npm run x \\\n| cat", "npm run-script x \\\n| cat", "pnpm run x \\\n| cat", "bun run x \\\n| cat"];
  for (const x of ["sh -c 'node .'", "bash -c 'node build.js'"]) {
    for (const hook of lines) {
      test(`${JSON.stringify(hook)} with x = ${JSON.stringify(x)}: held (the parent held)`, () => {
        const f = rows(hook, { x }, { "build.js": "1\n" });
        expect({ hook, held: held(f(A), f(A + "// changed\n")) }).toEqual({ hook, held: true });
      });
    }
  }
});

describe("what a stage's nested reader reads is read as itself: a later bare run of the same script is not skipped", () => {
  // Every row: a script x that runs a plain command, read from inside a stage through a nested body (`npm exec -c`, `sh -c`, xargs sh -c),
  // then run bare on a later line. The parent holds the later bare `npm run x`; the head must too.
  const f = (hook: string, x: string) => (z: string) => ({
    "package.json": JSON.stringify({ name: "x", version: "1", main: "docs/a.js", scripts: { postinstall: hook, x } }),
    "docs/a.js": A,
    "src/z.js": z,
  });
  const outer = [
    "npm exec -c 'npm run x'", "npm x -c 'npm run x'", "FOO=1 npm exec -c 'npm run x'", "command npm exec -c 'npm run x'", "time npm exec -c 'npm run x'",
    "time npm exec -- sh -c 'npm run x'", "time pnpm exec sh -c 'npm run x'", "sh -c 'npm run x'",
    "nice xargs sh -c 'npm run x'", "timeout 5 xargs -n1 sh -c 'npm run x'", "stdbuf -oL xargs -I{} bash -c 'npm run x'", "xargs env sh -c 'npm run x'",
  ];
  const tails = [" | cat", " > log", " &"];
  for (const x of ["mkdir out", "mkdir -p out", "rm -rf dist"]) {
    for (const o of outer) {
      for (const t of tails) {
        test(`${JSON.stringify(o + t + "\nnpm run x")} with x = ${JSON.stringify(x)} holds as the bare second line does`, () => {
          const hook = `${o}${t}\nnpm run x`;
          const g = f(hook, x);
          expect({ hook, x, held: held(g(A), g(A + "// changed\n")) }).toEqual({ hook, x, held: true });
        });
      }
    }
  }
});

// The stage reading is a pass that only ADDS: it runs after the parent's reading, on records of its own, and cannot change what that reading
// marks (ranSh, seen, evalRead) or widens (widenInert). Each row below was released by a head whose stage read ran first or set state outside
// its scope; the parent holds it.
import { setJsScanSteps } from "../src/install-closure.ts";
import { allowFaults } from "./fault-guard.ts";
describe("the stage pass never takes from the parent's reading", () => {
  const pk = (scripts: Record<string, string>, extra: Record<string, string>, a: string) => ({
    "package.json": JSON.stringify({ name: "p", version: "1", main: "docs/a.js", scripts }),
    "docs/a.js": a,
    "src/z.js": "1\n",
    ...extra,
  });
  const mainChanged = (scripts: Record<string, string>, extra: Record<string, string> = {}) => held(pk(scripts, extra, A), pk(scripts, extra, B));
  const SQ = "npm exec -c 'sh -c '\\''bash run.sh'\\'''";
  // A: the stage read marked run.sh read (ranSh) before the parent's `. file`-style widening of inert files could read it.
  for (const body of ["mkdir out\n", "mkdir -p out\n", "mkdir out\nnode build.js\n"]) {
    for (const tail of [" | cat", " > log", " &", " 2>&1 | tee log", ""]) {
      for (const lead of ["", "echo a | ", "("]) {
        const hook = lead === "(" ? `(${SQ})${tail}; bash run.sh` : `${lead}${SQ}${tail}; bash run.sh`;
        test(`A ${JSON.stringify(hook)} with run.sh = ${JSON.stringify(body)}: a changed main holds`, () => {
          expect({ hook, held: mainChanged({ postinstall: hook }, { "run.sh": body, "build.js": "1\n" }) }).toEqual({ hook, held: true });
        });
      }
    }
  }
  // B: the stage read reached the backslash reading first, with widenInert false, and its once-records stopped the parent's later read.
  for (const tail of ["; true"]) {
    test(`B nested sh -c body with a later bare run${JSON.stringify(tail)}: a changed main holds`, () => {
      const hook = `npm run x\nnpm exec -c 'sh -c '\\''mkdir out\nnode build.js'\\'''${tail}`;
      expect({ hook, held: mainChanged({ postinstall: hook, x: "mkdir out\nnode build.js" }, { "build.js": "1\n" }) }).toEqual({ hook, held: true });
    });
  }
  // C: a `. file` widening (widenInert) set inside the scope was restored, so the parent's later `cd docs` + `node .` fault was lost.
  for (const hook of [". ./run.sh | cat\ncd docs\nnode .", "source run.sh > log\ncd docs\nnode ."]) {
    test(`C ${JSON.stringify(hook)} at the scan-step limits where the parent faults (10, 5, 1): a moved main holds`, () => {
      allowFaults();
      const f = (main: string) => ({ ...pk({ postinstall: hook }, { "run.sh": "mkdir out\n", "docs/b.js": B }, A), "package.json": JSON.stringify({ name: "p", version: "1", main, scripts: { postinstall: hook } }) });
      try {
        for (const lim of [10, 5, 1]) {
          setJsScanSteps(lim);
          expect({ hook, lim, held: held(f("docs/a.js"), f("docs/b.js")) }).toEqual({ hook, lim, held: true });
        }
      } finally {
        setJsScanSteps(undefined);
      }
    });
  }
});

describe("the stage pass keeps its own once-records", () => {
  // The pass marked the nested sh -c body as read (evalRead) before the parent's backslash reading could read it, which is where the parent's
  // widening of inert files (docs/b.js) comes from: main moved onto a changed docs/b.js was released.
  test("nested sh -c body, main moved onto a changed docs/b.js: held as the parent holds it", () => {
    const hook = "npm run build\nnpm exec -c 'sh -c '\\''mkdir out\nnode build.js'\\'''; true";
    const f = (main: string, b: string) => ({
      "package.json": JSON.stringify({ name: "x", version: "1", main, scripts: { postinstall: hook, build: "node build.js" } }),
      "build.js": "console.log(1);\n",
      "docs/a.js": A,
      "docs/b.js": b,
    });
    expect(held(f("docs/a.js", B), f("docs/b.js", B + "// c\n"))).toBe(true);
  });
});

describe("the stage pass runs after the reading, on a context of its own", () => {
  // A `((` line the shell splitter cannot cut, then a next line whose first word is a backslash-n: the stage pass used to run inside the
  // backslash re-read of the body and share the `((` reading's records, so the parent's reading of `npx .` was skipped and a main retarget released.
  const ARITH = "(( '$(cat n)' ))";
  const HOOKS = [
    `${ARITH}\n\\npx .`,
    `${ARITH}\nnpx \\.`,
    `${ARITH} | cat\n\\npx .`,
    `x=$(cat n)\n(( x ))\n\\npx .`,
    `sh -c '\\npx .'`,
    `${ARITH} && true\n\\npx .`,
    `if ${ARITH}; then :; fi\n\\npx .`,
    `${ARITH}\n\n\\npx .`,
  ];
  const f = (hook: string, main: string, b: string) => ({
    "package.json": JSON.stringify({ name: "p", version: "1", main, scripts: { postinstall: hook } }),
    "docs/a.js": A,
    "docs/b.js": b,
    n: "x\n",
  });
  for (const hook of HOOKS) {
    test(`${JSON.stringify(hook)}: main onto a file with the same bytes is held`, () => {
      expect({ hook, held: held(f(hook, "docs/a.js", A), f(hook, "docs/b.js", A)) }).toEqual({ hook, held: true });
    });
    test(`${JSON.stringify(hook)}: main onto a file with other bytes is held`, () => {
      expect({ hook, held: held(f(hook, "docs/a.js", B), f(hook, "docs/b.js", B)) }).toEqual({ hook, held: true });
    });
    test(`${JSON.stringify(hook)}: main moved to a missing file is held`, () => {
      expect({ hook, held: held(f(hook, "docs/a.js", A), f(hook, "docs/gone.js", A)) }).toEqual({ hook, held: true });
    });
  }
});

describe("the stage pass's files are compared from both sides (stageAll)", () => {
  const detailsOf = (o: Record<string, string>, n: Record<string, string>) => prepass("npm", map(o), map(n)).hard.filter((s) => s.kind === "install-script").map((s) => s.detail).sort();
  const f = (main: string, hook: string) => ({
    "package.json": JSON.stringify({ name: "p", version: "1", main, scripts: { postinstall: hook } }),
    "docs/a.js": A,
    "docs/b.js": A,
  });
  // The reading widens to docs/a.js and docs/b.js on both sides (same bytes in both), so only the stage pass's own files tell the retarget:
  // the old side's stage reaches docs/a.js, the new side's docs/b.js. The old-only loop of the comparison (prepass) names a, the new-only loop b:
  // the hold is the same with either loop alone, the detail set shows each.
  for (const hook of ["node . > out", "\\npx .\nnode . | cat"]) {
    test(`${JSON.stringify(hook)}: main moved onto a file with the same bytes names the old side's file and the new side's file`, () => {
      expect(detailsOf(f("docs/a.js", hook), f("docs/b.js", hook))).toEqual(["file docs/a.js", "file docs/b.js"]);
    });
  }
});

describe("a hook-text change between an unsplit hook and a `((` line keeps the file detail of the base", () => {
  // The stage pass's files are compared apart (arAll) and do not widen arOnly, so the retarget asymmetry of the `((` reading still shows: the
  // base names docs/a.js (main, unchanged) beside the hook text; a head that put the stage files in arOnly dropped that detail.
  const f = (hook: string) => ({
    "package.json": JSON.stringify({ name: "p", version: "1", main: "docs/a.js", scripts: { postinstall: hook } }),
    "docs/a.js": A,
    n: "1\n",
  });
  const det = (o: string, n: string) => prepass("npm", map(f(o)), map(f(n))).hard.filter((s) => s.kind === "install-script").map((s) => s.detail);
  for (const [o, n] of [["(( '$(cat n)' ))", "node . | cat"], ["node . | cat", "(( '$(cat n)' ))"]] as const) {
    test(`${JSON.stringify(o)} -> ${JSON.stringify(n)}: file docs/a.js is named`, () => {
      expect(det(o, n)).toContain("file docs/a.js");
    });
  }
});

describe("a stage that widens to every file does not hide a main retarget (stageOnly)", () => {
  // The stage reads every file (python3 -c 'import helper') on both sides, so the sets the stage reached are equal; the retarget shows in what the
  // main reading reached and the stage pass did not (compared as the self-run and backslash readings are).
  const hook = "echo a | cross-env A=1 timeout 5 bash -c 'command python3 -c '\\''import helper'\\''' > log\nnpx \\.";
  const f = (main: string, b: string) => ({
    "package.json": JSON.stringify({ name: "x", version: "1", main, scripts: { postinstall: hook, x: "mkdir out\nnode build.js", y: "bash run.sh", build: "node build.js" } }),
    "build.js": "console.log(1);\n",
    "run.sh": "mkdir out\n",
    "docs/a.js": A,
    "docs/b.js": b,
    "src/z.js": A,
    f: "x",
    n: "x\n",
  });
  test("main a -> b with other bytes is held", () => {
    expect(held(f("docs/a.js", B), f("docs/b.js", B))).toBe(true);
  });
  test("main a -> b with the same bytes is held", () => {
    expect(held(f("docs/a.js", A), f("docs/b.js", A))).toBe(true);
  });
});

describe("the stageOnly comparison is not redundant with the other loops", () => {
  const f = (main: string, hook: string) => ({
    "package.json": JSON.stringify({ name: "x", version: "1", main, scripts: { postinstall: hook, a: "echo a", build: "node build.js" } }),
    "build.js": "console.log(1);\n",
    "run.sh": "node .\n",
    "docs/a.js": A,
    "docs/b.js": B,
    "src/z.js": A,
    n: "x\n",
    f: "x",
  });
  const details = (o: Record<string, string>, n: Record<string, string>) => prepass("npm", map(o), map(n)).hard.filter((s) => s.kind === "install-script").map((s) => s.detail);
  test("a stage line replaced by another under an unchanged main keeps `file docs/a.js` (the base names it)", () => {
    const o = "sh -c 'node . | cat'\nnode . | cat";
    const n = "sh -c 'node . | cat'\nbash run.sh | cat";
    expect(details(f("docs/a.js", o), f("docs/a.js", n))).toContain("file docs/a.js");
  });
  test("`sudo xargs { cat f; } | cat` then `node .`: a main retarget is held", () => {
    const hook = "sudo xargs { cat f; } | cat\nnode .";
    expect(held(f("docs/a.js", hook), f("docs/b.js", hook))).toBe(true);
  });
});

describe("a stage word with a single quote is read as written (no false hold)", () => {
  // The stage is re-quoted for the bare reader. A single-quote form `'a'\''b'` holds a backslash that the backslash-taking reading takes as a word
  // character and then misreads (`require(\./lib/ok.js\)` does not parse): the whole package was read and an unrelated docs/notes.md held.
  const f = (hook: string, notes: string) => ({
    "package.json": JSON.stringify({ name: "x", version: "1", main: "lib/ok.js", scripts: { postinstall: hook } }),
    "lib/ok.js": A,
    "docs/notes.md": notes,
  });
  for (const hook of [`node -e "require('./lib/ok.js')" | cat`, `node -e "'ok'" | cat`, `node -e "require('./lib/ok.js')" > /dev/null`, `node -e "console.log('a b')" | tee log`, `node -e "console.log('hi!')" | cat`, `node -e "if (!1) require('./lib/ok.js')" | cat`, String.raw`node -e "require('./lib/ok.js')+\"\"" | cat`, String.raw`node -e "console.log('a\nb')" | cat`]) {
    test(`${hook}: a change of docs/notes.md alone is not held`, () => {
      expect({ hook, held: held(f(hook, "v1"), f(hook, "v2")) }).toEqual({ hook, held: false });
    });
  }
});

describe("a side that stopped at a cap keeps the cap as its detail", () => {
  // Old main docs/a.js, new main ../outside.js (`unresolved: path`): the stopped side runs no stage pass, so the stage files differ between the
  // sides and made the comparison non-empty, which dropped the cap detail the base gives (the hold stayed).
  const f = (main: string, hook: string) => ({
    "package.json": JSON.stringify({ name: "x", version: "1", main, scripts: { postinstall: hook } }),
    "docs/a.js": A,
    "run.sh": "mkdir out\n",
  });
  for (const hook of [". ./run.sh | cat\nnode .", "source run.sh > log\nnode ."]) {
    test(`${JSON.stringify(hook)}: main moved outside the package names the cap`, () => {
      const d = prepass("npm", map(f("docs/a.js", hook)), map(f("../outside.js", hook))).hard.filter((s) => s.kind === "install-script").map((s) => s.detail);
      expect(d).toContain("unresolved: path");
    });
  }
});

describe("a wrapper or env prefix before a stage with a quote is read as written (no false hold)", () => {
  // dispatch() hands the unwrapped tail back as text at every wrapper, env and function site: on the stage pass the single-quote form of a word
  // with a quote (`'a'\''b'`) was misread by the backslash reading and widened the package; the helper (reQuote) double-quotes it there.
  const f = (hook: string, notes: string) => ({
    "package.json": JSON.stringify({ name: "x", version: "1", main: "lib/ok.js", scripts: { postinstall: hook } }),
    "lib/ok.js": A,
    "docs/notes.md": notes,
  });
  const tail = `node -e "require('./lib/ok.js')" | cat`;
  for (const pre of ["FOO=1 ", "env ", "nice ", "timeout 5 ", "cross-env A=1 ", "env FOO=1 ", "sudo ", "nohup ", "time ", "command ", "npx "]) {
    test(`${JSON.stringify(pre)} before the stage: a change of docs/notes.md alone is not held`, () => {
      const hook = pre + tail;
      expect({ hook, held: held(f(hook, "v1"), f(hook, "v2")) }).toEqual({ hook, held: false });
    });
  }
  // The code that runs is still read: the same prefixed stage with a changed file it requires holds.
  test("control: the prefixed stage that requires a changed lib/ok.js holds", () => {
    const hook = `FOO=1 ${tail}`;
    const g = (v: string) => ({ ...f(hook, "v"), "lib/ok.js": v });
    expect(held(g(A), g(B))).toBe(true);
  });
});

describe("a wrapper before a shell given a quote body is read as written (no false hold)", () => {
  // The parent's reading hands the unwrapped tail back as text in the legacy single-quote form; the sh -c body read out of it was queued as a
  // stage job with a stray backslash and the stage pass widened the package. A text re-built that way queues no job of its own.
  const f = (hook: string, notes: string) => ({
    "package.json": JSON.stringify({ name: "x", version: "1", main: "lib/ok.js", scripts: { postinstall: hook } }),
    "lib/ok.js": A,
    "docs/notes.md": notes,
  });
  const body = `sh -c "node -e \\"require('./lib/ok.js');//'\\""`;
  for (const pre of ["env ", "FOO=1 ", "nice ", "sudo ", "time ", "nohup ", "env A=1 "]) {
    test(`${JSON.stringify(pre)} before sh -c with a quote body: a change of docs/notes.md alone is not held`, () => {
      const hook = pre + body;
      expect({ hook, held: held(f(hook, "v1"), f(hook, "v2")) }).toEqual({ hook, held: false });
    });
  }
  for (const [name, wrap] of [["function", (b: string) => `f() { env ${b}; }; f`], ["group", (b: string) => `{ env ${b}; }`], ["and", (b: string) => `true && env ${b}`]] as const) {
    test(`env sh -c in a ${name} form: a change of docs/notes.md alone is not held`, () => {
      const hook = wrap(body);
      expect({ hook, held: held(f(hook, "v1"), f(hook, "v2")) }).toEqual({ hook, held: false });
    });
  }
  test("control: the same wrapper with a body that requires a changed lib/ok.js holds", () => {
    const hook = `env sh -c "node -e \\"require('./lib/ok.js')\\" | cat"`;
    const g = (v: string) => ({ ...f(hook, "v"), "lib/ok.js": v });
    expect(held(g(A), g(B))).toBe(true);
  });
});

describe("a pipe inside a shell body or a script reached by a quoted word is still read as a stage", () => {
  // The legacy-form re-quote of a word with a quote must not hide the stage reach of what runs under it: the pipe sits INSIDE the sh -c body, or inside a script a runner reaches.
  const mk = (main: string, hook: string, b = "node . | cat") => ({
    "package.json": JSON.stringify({ name: "x", version: "1", main, scripts: { postinstall: hook, b } }),
    "docs/a.js": "1;\n",
    "docs/b.js": "1;\n",
    "lib/ok.js": "1;\n",
    "lib/two.js": "1;\n",
  });
  const retarget = (hook: string, b?: string, from = "docs/a.js", to = "docs/b.js") => held(mk(from, hook, b), mk(to, hook, b));
  const hooks: Record<string, string> = {
    "env sh -c with a quoted grep arg": `env sh -c "node . | grep 'x'"`,
    "env sh -c with an unquoted grep arg": `env sh -c "node . | grep x"`,
    "env npm run b -- with a quote": `env npm run b -- "it's"`,
    "env npm run b -- without a quote": `env npm run b -- its`,
    "FOO=1 npm run b a'b": `FOO=1 npm run b "a'b"`,
    "nice npm run b a'b": `nice npm run b "a'b"`,
    "sudo npm run b a'b": `sudo npm run b "a'b"`,
    "true && npm run b a'b": `true && npm run b "a'b"`,
    "npm exec -- npm run b a'b": `npm exec -- npm run b "a'b"`,
    "npm run-script b a'b": `FOO=1 npm run-script b "a'b"`,
    "yarn run b a'b": `FOO=1 yarn run b "a'b"`,
    "pnpm run b a'b": `FOO=1 pnpm run b "a'b"`,
    "npx run-s b a'b": `FOO=1 npx run-s b "a'b"`,
  };
  for (const [name, hook] of Object.entries(hooks)) {
    test(`${name}: a retarget of main (same bytes) is held`, () => {
      expect({ hook, held: retarget(hook, undefined, "lib/ok.js", "lib/two.js") }).toEqual({ hook, held: true });
    });
  }
  for (const b of ["(node .)", "node . > log"]) {
    test(`FOO=1 npm run b a'b with b = ${b}: a retarget of main is held`, () => {
      const hook = `FOO=1 npm run b "a'b"`;
      expect({ b, held: retarget(hook, b, "lib/ok.js", "lib/two.js") }).toEqual({ b, held: true });
    });
  }
  const caps = (hook: string) => prepass("npm", map(mk("docs/a.js", hook)), map(mk("../outside.js", hook))).hard.filter((x) => x.kind === "install-script").map((x) => x.detail);
  test("a runner chain with a quoted word and main -> ../outside.js: the files and the cap are named", () => {
    expect(caps(`env npm run b -- "it's"`)).toEqual(expect.arrayContaining(["file docs/a.js", "unresolved: path"]));
  });
  test("env sh -c with a quoted grep arg and main -> ../outside.js: the files and the cap are named", () => {
    expect(caps(`env sh -c "node . | grep 'x'"`)).toEqual(expect.arrayContaining(["file docs/a.js", "unresolved: path"]));
  });
});

describe("a runner's -c body with a quote inside is read as written (no false hold)", () => {
  // dispatchRunner built its argument text in the legacy single-quote form directly, so the -c body was misread in the parent's reading and in the stage pass.
  const f = (hook: string, notes: string, v: string) => ({
    "package.json": JSON.stringify({ name: "x", version: v, main: "lib/ok.js", scripts: { postinstall: hook } }),
    "lib/ok.js": A,
    "docs/notes.md": notes,
  });
  const body = `"node -e \\"require('./lib/ok.js');//'\\""`;
  for (const run of ["npm -s exec -c", "npm exec -c", "npx -c", "yarn exec -c", "pnpm exec -c"]) {
    test(`${run} with a quote inside the body | cat: a change of docs/notes.md alone is not held`, () => {
      const hook = `${run} ${body} test | cat`;
      expect({ hook, held: held(f(hook, "a", "1.0.0"), f(hook, "b", "1.0.1")) }).toEqual({ hook, held: false });
    });
  }
  test("control: an early return (npm view with a quote) leaves no mark behind: the next line is read as on base", () => {
    const hook = `npm view "a'b" | cat\nnode -e "require('./lib/ok.js')" | cat`;
    expect({ hook, held: held(f(hook, "a", "1.0.0"), f(hook, "b", "1.0.1")) }).toEqual({ hook, held: false });
  });
});

describe("a replayed command keeps the context it was read in", () => {
  // The legacy-form replay queued the outer command with the context of the nested reading that met the legacy form (script switches, directory).
  const mk = (scripts: Record<string, string>, files: Record<string, string>) => ({ "package.json": JSON.stringify({ name: "x", version: "1", scripts }), ...files });
  test("--ignore-scripts run of a script whose body runs a -c with a quote under --no-ignore-scripts: presetup stays skipped", () => {
    const scripts = { postinstall: "npm --ignore-scripts run setup", presetup: "node docs/gen.js", setup: `npm --no-ignore-scripts exec -c "echo 'a' | cat" test | cat` };
    expect(held(mk(scripts, { "docs/gen.js": "1" }), mk(scripts, { "docs/gen.js": "2" }))).toBe(false);
  });
  test("a cd then a runner with a quoted -c body in a sh file: the replayed line is read where it ran (held, as on the base)", () => {
    const files = (n: string) => ({ "run.sh": `cd sub\nnpm -s exec -c "echo 'a' | cat" test | cat\n`, "sub/run.sh": "node ../docs/notes.md\n", "docs/notes.md": n });
    const scripts = { postinstall: "sh run.sh" };
    expect(held(mk(scripts, files("a")), mk(scripts, files("b")))).toBe(true);
  });
});

describe("a replayed origin is keyed once, not for every line under it (linear in the size)", () => {
  // `nice sh -c "<lines>" "it's"` meets the legacy form once; every nested line that does not split used to rebuild the key from the whole command.
  const pk = (n: number, v: string) => ({
    "package.json": JSON.stringify({ name: "x", version: v, main: "lib/ok.js", scripts: { postinstall: `nice sh -c "${"echo q | cat\n".repeat(n)}" "it's"` } }),
    "lib/ok.js": A,
  });
  const time = (n: number): number => {
    const o = pk(n, "1");
    const m = pk(n, "2");
    let best = Infinity;
    for (let i = 0; i < 1; i++) {
      const t = performance.now();
      held(o, m);
      best = Math.min(best, performance.now() - t);
    }
    return best;
  };
  test("the time grows about linearly with the number of lines", () => {
    const sizes = [8000, 64000];
    const slopes: number[] = [];
    for (let attempt = 0; attempt < 3; attempt++) {
      const ts = sizes.map(time);
      slopes.push(Math.log(Math.max(ts[1]!, 5) / Math.max(ts[0]!, 5)) / Math.log(sizes[1]! / sizes[0]!));
      if (slopes[slopes.length - 1]! < 1.25) break;
    }
    expect(Math.min(...slopes)).toBeLessThan(1.25);
  }, 300000);
});

describe("every cap a side stopped on is named, a main-less manifest included", () => {
  // Line one stops the reading on `unresolved: path` (the `/..` word beside a word with a quote); the stage line stops the stage pass on another cap.
  const pk = (v: string, l2: string, files: Record<string, string>) => ({
    "package.json": JSON.stringify({ name: "x", version: v, scripts: { postinstall: `FOO=1 node-gyp-build-optional "a'b" "/.."\n${l2}` } }),
    ...files,
  });
  const dets = (o: Record<string, string>, n: Record<string, string>) => prepass("npm", map(o), map(n)).hard.filter((x) => x.kind === "install-script").map((x) => x.detail);
  test("a stage line with a glob: `unresolved: path` is named beside `glob`", () => {
    const l = `node "?" | cat`;
    expect(dets(pk("1.0.0", l, { "README.md": "old " }), pk("1.0.1", l, { "README.md": "new " }))).toEqual(expect.arrayContaining(["unresolved: path", "glob"]));
  });
  test("a file reached by the stage pass alone on both sides and changed: `unresolved: path` is named beside the file", () => {
    const l = "node . | cat";
    expect(dets(pk("1.0.0", l, { "index.js": "1 " }), pk("1.0.1", l, { "index.js": "2 " }))).toEqual(expect.arrayContaining(["unresolved: path", "file index.js"]));
  });
});

describe("both sides' caps are named when a stage pass stops a side on a cap of its own", () => {
  // The new side's stage pass stops on `unresolved: manifest` (npx . reaches the bin), which shadowed the cap the main reading stopped on.
  const f = (main: string) => ({
    "package.json": JSON.stringify({ name: "x", version: "1", main, bin: "run.js", scripts: { postinstall: "npx . | cat\nnode ." } }),
    "run.js": "console.log(process.env.npm_package_version);\n",
  });
  const g = (main: string) => ({
    "package.json": JSON.stringify({ name: "x", version: "1", main, scripts: { postinstall: "printf '%s' '[a]' | cat\nnode ." } }),
  });
  const details = (o: Record<string, string>, n: Record<string, string>) => prepass("npm", map(o), map(n)).hard.filter((s) => s.kind === "install-script").map((s) => s.detail);
  test("main ../outside.js -> none.js with `npx . | cat` and a bin: `unresolved: path` is named", () => {
    expect(details(f("../outside.js"), f("none.js"))).toContain("unresolved: path");
  });
  test("main ../outside.js -> none.js with a glob stage: `unresolved: path` is named", () => {
    expect(details(g("../outside.js"), g("none.js"))).toContain("unresolved: path");
  });
});
