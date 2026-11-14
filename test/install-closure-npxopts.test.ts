import { describe, expect, test } from "bun:test";
import { installView } from "../src/install-closure.ts";
import { prepass } from "../src/prepass.ts";

const enc = new TextEncoder();
// docs/ is left out of the plain widen, so only reading the option's file (or every file) reaches docs/evil.js.
const reaches = (hook: string, files: Record<string, string> = {}) => {
  const o = { "package.json": JSON.stringify({ name: "x", version: "1.0.0", main: "docs/evil.js", scripts: { postinstall: hook } }), "x.js": "1;\n", "docs/evil.js": "1;\n", "README.md": "x\n", ...files };
  return installView(new Map(Object.entries(o).map(([k, v]) => [k, enc.encode(v)]))).files.includes("docs/evil.js");
};

describe("npx options that carry node options or a shell", () => {
  test.each([
    'npx --node-options "--require ./docs/evil.js" node x.js',
    "npx --node-options='--require ./docs/evil.js' node x.js",
    'npx --node-options="-r ./docs/evil.js" node x.js',
    'npx --node-options "--import ./docs/evil.js" node x.js',
    'bunx --node-arg "--require ./docs/evil.js" node x.js',
    'npx --shell sh -c "node ./docs/evil.js"',
    'npx --script-shell sh -c "node ./docs/evil.js"',
    'npx --shell sh -c "node ."',
    'npx --yes --shell bash --call "node ./docs/evil.js"',
  ])("%s: the file it runs is read", (hook) => {
    expect(reaches(hook)).toBe(true);
  });
  test.each(["npx --registry https://r.invalid/ x", "npx --yes cowsay hi", "npx --cache /tmp/c x"])("control, as on main: %s reads no docs file", (hook) => {
    expect(reaches(hook)).toBe(false);
  });
});

describe("node options before a call string", () => {
  test("npx --node-options with -c: every file is read", () => {
    expect(reaches('npx --node-options "-r ./docs/evil.js" -c "node x.js"')).toBe(true);
  });
});

// main's own widen and move branches run before the value skip: --userconfig and --globalconfig read every file, and --prefix,
// --workspace and bunx --cwd move the run into that folder, spaced or with =.
describe("runner options main already widens or moves on", () => {
  test.each([
    "npx --userconfig ./cfg/npmrc x",
    "npx --userconfig=./cfg/npmrc x",
    "npx --userconfig=sh node x.js",
    "npx --globalconfig ./cfg/npmrc x",
    "npx --globalconfig=./cfg/npmrc x",
  ])("%s: every file is read", (hook) => {
    expect(reaches(hook, { "cfg/npmrc": "x\n" })).toBe(true);
  });
  // docs/ is outside the plain widen, so a changed docs/gen.js is held only when the run moves into docs.
  const movedHeld = (hook: string) => {
    const base = { "package.json": JSON.stringify({ name: "x", version: "1.0.0", scripts: { postinstall: hook } }), "x.js": "1;\n" };
    const m = (gen: string) => new Map(Object.entries({ ...base, "docs/gen.js": gen }).map(([k, v]) => [k, enc.encode(v)]));
    return prepass("npm", m("1;\n"), m("evil()\n")).hard.some((s) => s.kind === "install-script");
  };
  test.each([
    "npx --prefix docs node gen.js",
    "npx --prefix=docs node gen.js",
    "npx --workspace docs node gen.js",
    "npx --workspace=docs node gen.js",
    "bunx --cwd docs node gen.js",
    "bunx --cwd=docs node gen.js",
    "npx --shell --prefix docs node gen.js",
  ])("%s: the run moves into docs, as on main", (hook) => {
    expect(movedHeld(hook)).toBe(true);
  });
  test.each(["npx --shell sh --prefix docs node gen.js", "npx --registry https://r.invalid/ --prefix docs node gen.js"])(
    "%s: a value option before the move is skipped with its value, so the move is seen",
    (hook) => {
      expect(movedHeld(hook)).toBe(true);
    },
  );
  test.each(["npx node gen.js", "npx --cache /tmp/c node gen.js"])("control, as on main: %s does not move", (hook) => {
    expect(movedHeld(hook)).toBe(false);
  });
  test("a value option followed by an option takes no value: npx --shell -c reads the call", () => {
    expect(reaches('npx --shell -c "node ./docs/evil.js"')).toBe(true);
  });
  // Both readings are kept: each option alone (its next word may read as the command, as on main) and a value option skipped with
  // its value. An option npm does not parse as taking a value (--cwd, --config on npx) never hides the word after it.
  test.each([
    "npx --cwd npm run build -w docs",
    "npx --config npm run build -w docs",
    "npx --loglevel=silent --cwd npm run build --workspace docs",
    'npx --cache cd -c "node x.js"',
    'npx --registry cd -c "node x.js"',
  ])("%s: held, as on main", (hook) => {
    expect(movedHeld(hook)).toBe(true);
  });
  test.each([
    'npx --node-options "-r ./docs/evil.js" npm run build -w pkg',
    'npx --node-options "-r ./docs/evil.js" lerna run build',
    'bunx --node-arg "-r ./docs/evil.js" npm run build -w pkg',
    'npx --cache /tmp/c --node-options "-r ./docs/evil.js" node x.js',
    'npx --tag --node-options "-r ./docs/evil.js" node x.js',
    'npx --scope --node-options "-r ./docs/evil.js" node x.js',
    'npx --shell --node-options="-r ./docs/evil.js" node x.js',
  ])("%s: the node options read every file even when the run also moves (main misses it too)", (hook) => {
    expect(reaches(hook, { "pkg/package.json": JSON.stringify({ name: "p", scripts: { build: "echo hi" } }) })).toBe(true);
  });
  test.each(['npx --cache -c -c "node ./docs/evil.js"', 'npx --registry -c --call "node ./docs/evil.js"'])(
    "%s: the call is read whether the option took the dash word as its value or not (main misses it too)",
    (hook) => {
      expect(reaches(hook)).toBe(true);
    },
  );
  test.each(['npx --shell=./docs/evil.sh -c "echo hi"', 'npx --script-shell=./docs/evil.sh -c "echo hi"', 'npx --shell=docs/evil.sh x', 'npx --cache -p --shell=./docs/evil.sh -c "echo hi"'])(
    "%s: a shell given by path is a file of the package that runs (main misses it too)",
    (hook) => {
      expect(reaches(hook, { "docs/evil.sh": "#!/bin/sh\nnode ./docs/evil.js\n" })).toBe(true);
    },
  );
  test("control, as on main: a shell named by program (--shell bash) reads no docs file", () => {
    expect(reaches('npx --shell bash -c "echo hi"')).toBe(false);
  });
  test("control, as on main: npx --cwd is not npm's, so the word after it is the command and -c is its argument", () => {
    expect(reaches('npx --cwd x -c "node ./docs/evil.js"')).toBe(false);
  });
  test("a crafted chain of nested runners with value options is read in about the time main takes", () => {
    for (const hook of ["npx --cache npx ".repeat(10000) + "x", "npx --cache npx npx ".repeat(7000) + "x", "npx --shell sh ".repeat(10000) + "-c x"]) {
      const t0 = performance.now();
      reaches(hook);
      expect(performance.now() - t0).toBeLessThan(1000);
    }
  });
  test.each(["npx --script-shell node .", "npx --script-shell=bash node ."])("%s: the package's main is read, as on main", (hook) => {
    expect(reaches(hook)).toBe(true);
  });
});
