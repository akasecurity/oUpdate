import { expect, test } from "bun:test";
import { prepass, type FileMap } from "../src/prepass.ts";

const enc = (s: string) => new TextEncoder().encode(s);
const files = (o: Record<string, string>): FileMap => new Map(Object.entries(o).map(([k, v]) => [k, enc(v)]));
const holds = (old: FileMap, now: FileMap) => prepass("npm", old, now).hard.filter((s) => s.kind === "install-script").map((s) => s.detail);

// A hook path with a `.` or `..` segment names the file it resolves to, so a changed file there must hold,
// docs/ and test/ included.
const release = (v: string, hook: string, target: string) =>
  files({
    "package.json": JSON.stringify({ name: "p", version: v, scripts: { postinstall: hook } }),
    "lib/ok.js": "console.log('ok')\n",
    "lib2/a.js": "console.log('a')\n",
    [target]: `console.log("evil ${v}")\n`,
  });
const held = (hook: string, target: string) => holds(release("1.0.0", hook, target), release("1.0.1", hook, target)).length > 0;

const forms = (d: string): [string, string][] => [
  ["a path that goes up and back down", `node lib2/../${d}/evil.js`],
  ["a path with a ./ segment", `node ./${d}/./evil.js`],
  ["a path with a ./ segment and no leading dot", `node ${d}/./evil.js`],
  ["a path that goes up from its own directory", `node ${d}/../${d}/evil.js`],
  ["a quoted path with a .. segment", `node "lib2/../${d}/evil.js"`],
  ["a path with a .. segment inside sh -c", `sh -c 'node lib2/../${d}/evil.js'`],
  ["a path with a ./ segment inside sh -c", `sh -c "node ./${d}/./evil.js"`],
  ["a path that leaves the package", `node ../${d}/evil.js`],
];
for (const d of ["lib", "docs", "test"]) {
  for (const [label, hook] of forms(d)) {
    test(`${label}: a changed ${d}/evil.js holds`, () => expect(held(hook, `${d}/evil.js`)).toBe(true));
  }
}

// The plain spellings held before and still hold.
for (const d of ["lib", "docs", "test"]) {
  for (const hook of [`node ${d}/evil.js`, `node ./${d}/evil.js`, `node ${d}//evil.js`]) {
    test(`${hook}: a changed ${d}/evil.js holds`, () => expect(held(hook, `${d}/evil.js`)).toBe(true));
  }
}

// Paths that resolve to a file that did not change stay quiet.
const controls: [string, string][] = [
  ["a plain path", "node lib/ok.js"],
  ["a ./ path", "node ./lib/ok.js"],
  ["a path that resolves to an unchanged file", "node lib/../lib/ok.js"],
  ["a ./ segment on an unchanged file", "node ./lib/./ok.js"],
  ["a command with no file", "echo hi"],
];
for (const [label, hook] of controls) {
  test(`${label}: a changed unrelated docs/evil.js stays quiet`, () => expect(held(hook, "docs/evil.js")).toBe(false));
}
test("a path that resolves to the changed file holds even from an unchanged-looking spelling", () =>
  expect(held("node lib/../lib/ok.js", "lib/ok.js")).toBe(true));

// After a `cd` a dotted path is resolved from that directory, not from the package root.
test("cd lib && node ../lib/ok.js: a changed unrelated docs/evil.js stays quiet", () =>
  expect(held("cd lib && node ../lib/ok.js", "docs/evil.js")).toBe(false));
test("cd lib && node ./../lib/ok.js: a changed unrelated docs/evil.js stays quiet", () =>
  expect(held("cd lib && node ./../lib/ok.js", "docs/evil.js")).toBe(false));
for (const d of ["x", "docs", "test"]) {
  test(`cd lib && node ../${d}/evil.js: a changed ${d}/evil.js holds`, () =>
    expect(held(`cd lib && node ../${d}/evil.js`, `${d}/evil.js`)).toBe(true));
}
test("cd lib && node ../../evil.js leaves the package: a changed docs/evil.js holds", () =>
  expect(held("cd lib && node ../../evil.js", "docs/evil.js")).toBe(true));

// A path that resolves to the package root runs its `main`, or index.js.
const rootPkg = (v: string, hook: string, main: string | undefined, extra: Record<string, string>) =>
  files({
    "package.json": JSON.stringify({ name: "p", version: v, ...(main ? { main } : {}), scripts: { postinstall: hook } }),
    "lib/ok.js": "console.log('ok')\n",
    ...Object.fromEntries(Object.entries(extra).map(([k, s]) => [k, s.replace("V", v)])),
  });
const rootHeld = (hook: string, main: string | undefined, extra: Record<string, string>) =>
  holds(rootPkg("1.0.0", hook, main, extra), rootPkg("1.0.1", hook, main, extra)).length > 0;
for (const d of ["lib", "docs", "test"]) {
  for (const hook of ["node .", "node lib/..", "node ./lib/../.", "node ./", "cd lib && node .."]) {
    test(`${hook}: the package main ${d}/evil.js changed holds`, () =>
      expect(rootHeld(hook, `${d}/evil.js`, { [`${d}/evil.js`]: "console.log('evil V')\n" })).toBe(true));
  }
}
test("node . without a main runs index.js: a changed index.js holds", () =>
  expect(rootHeld("node .", undefined, { "index.js": "console.log('evil V')\n" })).toBe(true));
test("node . with neither a main nor an index.js stays quiet: node runs nothing", () =>
  expect(rootHeld("node .", undefined, { "docs/evil.js": "console.log('evil V')\n" })).toBe(false));
test("node . with an unchanged main stays quiet when another file changes", () =>
  expect(rootHeld("node .", "lib/ok.js", { "docs/evil.js": "console.log('evil V')\n" })).toBe(false));
test("node lib/../lib with a manifest main in lib holds when that main changes", () =>
  expect(rootHeld("node lib/../lib", undefined, { "lib/package.json": '{"main":"m.js"}', "lib/m.js": "console.log('evil V')\n" })).toBe(true));

// Returning to the root after a cd leaves no stale directory.
test("cd lib && cd .. && node ./docs/./evil.js: a changed docs/evil.js holds", () =>
  expect(held("cd lib && cd .. && node ./docs/./evil.js", "docs/evil.js")).toBe(true));
test("cd lib && cd .. && node . : the main docs/evil.js changed holds", () =>
  expect(rootHeld("cd lib && cd .. && node .", "docs/evil.js", { "docs/evil.js": "console.log('evil V')\n" })).toBe(true));

// Only a program that runs the directory as a module reads the root main.
test("tsc -p . does not run the manifest main", () =>
  expect(rootHeld("tsc -p .", "docs/runtime.js", { "docs/runtime.js": "console.log('r V')\n" })).toBe(false));
test("node-gyp rebuild stays quiet when main changes", () =>
  expect(rootHeld("node-gyp rebuild", "docs/runtime.js", { "docs/runtime.js": "console.log('r V')\n" })).toBe(false));
test("node scripts/build.js stays quiet when main changes", () =>
  expect(rootHeld("node scripts/build.js", "docs/runtime.js", { "scripts/build.js": "1\n", "docs/runtime.js": "console.log('r V')\n" })).toBe(false));

// A main that is a directory is run through its index, not a nested manifest; an operand directory honors its manifest.
test("a main that is a directory ignores that directory's manifest", () =>
  expect(
    rootHeld("node .", "docs", { "docs/package.json": '{"main":"evil.js"}', "docs/index.js": "1\n", "docs/evil.js": "console.log('evil V')\n" }),
  ).toBe(false));
test("a main that is a directory runs its index.js", () =>
  expect(rootHeld("node .", "docs", { "docs/index.js": "console.log('evil V')\n" })).toBe(true));
test("node lib honors lib/package.json main", () =>
  expect(rootHeld("node lib", undefined, { "lib/package.json": '{"main":"m.js"}', "lib/m.js": "console.log('evil V')\n" })).toBe(true));
test("node lib with a manifest main that leaves lib holds", () =>
  expect(rootHeld("node lib", undefined, { "lib/package.json": '{"main":"../docs/evil.js"}', "docs/evil.js": "console.log('evil V')\n" })).toBe(true));

// Valid main spellings resolve before they are validated.
test("a main with a .. segment stays quiet when an unrelated file changes", () =>
  expect(rootHeld("node .", "lib/../lib/ok.js", { "docs/other.md": "doc V\n" })).toBe(false));
test("a main with a .. segment holds when the file it names changes", () =>
  expect(rootHeld("node .", "lib/../lib/ok.js", { "lib/ok.js": "console.log('evil V')\n" })).toBe(true));
test("a main with a trailing slash stays quiet when an unrelated file changes", () =>
  expect(rootHeld("node .", "lib/", { "lib/index.js": "1\n", "docs/other.md": "doc V\n" })).toBe(false));
test("a main with a trailing slash holds when its index.js changes", () =>
  expect(rootHeld("node .", "lib/", { "lib/index.js": "console.log('evil V')\n" })).toBe(true));

// A main that names a missing file falls back to the root index.js.
test("a main naming a missing file falls back to index.js: a changed index.js holds", () =>
  expect(rootHeld("node .", "missing.js", { "index.js": "console.log('evil V')\n" })).toBe(true));

// A runner that wraps node runs the root as a module too.
for (const hook of ["npx node .", "npx --yes node .", "npx nodejs .", "bunx node .", "env node .", "nice node .", "sudo node .", "exec node .", "command node ."]) {
  test(`${hook}: the package main changed holds`, () =>
    expect(rootHeld(hook, "docs/evil.js", { "docs/evil.js": "console.log('evil V')\n" })).toBe(true));
}
test("npx tsc -p . does not run the manifest main", () =>
  expect(rootHeld("npx tsc -p .", "docs/runtime.js", { "docs/runtime.js": "console.log('r V')\n" })).toBe(false));

// A dependency main that leaves its directory but stays in the package resolves to the file it names.
const build = { "scripts/build.js": 'require("../lib");\n', "lib/package.json": '{"main":"../safe.js"}' };
test("a dependency main one level up stays quiet when an unrelated file changes", () =>
  expect(rootHeld("node scripts/build.js", undefined, { ...build, "safe.js": "1\n", "docs/unrelated.md": "d V\n" })).toBe(false));
test("a dependency main one level up holds when the file it names changes", () =>
  expect(rootHeld("node scripts/build.js", undefined, { ...build, "safe.js": "console.log('evil V')\n" })).toBe(true));
test("a dependency main that leaves the package holds", () =>
  expect(
    rootHeld("node scripts/build.js", undefined, { ...build, "lib/package.json": '{"main":"../../x.js"}', "safe.js": "1\n", "docs/unrelated.md": "d V\n" }),
  ).toBe(true));

// Only the program a runner runs, and the first operand after node's own flags, name the root directory.
const rtMain = { "docs/runtime.js": "console.log('r V')\n" };
for (const hook of ["npx tsc --types node -p .", "bunx tsc --types node -p .", "npx --yes tsc --types node -p .", "npx -p typescript tsc --types node -p ."]) {
  test(`${hook}: the manifest main is not run`, () => expect(rootHeld(hook, "docs/runtime.js", rtMain)).toBe(false));
}
test("node scripts/build.js . : the dot is the script's argument, not the directory it runs", () =>
  expect(rootHeld("node scripts/build.js .", "docs/runtime.js", { ...rtMain, "scripts/build.js": 'console.log("ok")\n' })).toBe(false));
test("node --no-warnings . : a flag before the directory operand still runs the root main", () =>
  expect(rootHeld("node --no-warnings .", "docs/runtime.js", rtMain)).toBe(true));
test("npx -y node . : a runner flag before node still runs the root main", () =>
  expect(rootHeld("npx -y node .", "docs/runtime.js", rtMain)).toBe(true));
test("npx -p typescript node . : a package flag with a value before node still runs the root main", () =>
  expect(rootHeld("npx -p typescript node .", "docs/runtime.js", rtMain)).toBe(true));
test("node -r . lib/ok.js : a preloaded directory runs the root main", () =>
  expect(rootHeld("node -r . lib/ok.js", "docs/runtime.js", rtMain)).toBe(true));
test("node --import . lib/ok.js : an imported directory runs the root main", () =>
  expect(rootHeld("node --import . lib/ok.js", "docs/runtime.js", rtMain)).toBe(true));

// A value-taking option before the directory does not make the value the script.
for (const hook of ["node --title t .", "node -C dev .", "node --conditions dev .", "node --env-file .env .", "node --inspect-port 0 .", "node --no-warnings --title t lib/..", "node -r ./lib/ok.js ."]) {
  test(`${hook}: the root main changed holds`, () => expect(rootHeld(hook, "docs/runtime.js", { ...rtMain, ".env": "A=1\n" })).toBe(true));
}
test("node scripts/build.js . stays quiet with an option before the script", () =>
  expect(rootHeld("node --title t scripts/build.js .", "docs/runtime.js", { ...rtMain, "scripts/build.js": 'console.log("ok")\n' })).toBe(false));

// A runner's own options that take a value are skipped, and a package manager that runs node is followed.
for (const hook of [
  "npx --registry https://registry.npmjs.org node .",
  "npx --cache /tmp/cache node .",
  "bunx --cwd . node .",
  "npx --loglevel silent node .",
  "npx --registry=https://r.example node .",
  "corepack npm exec -- node .",
  "corepack npx node .",
  "node --title=worker .",
]) {
  test(`${hook}: the root main changed holds`, () => expect(rootHeld(hook, "docs/runtime.js", rtMain)).toBe(true));
}
test("npx --registry URL tsc -p . does not run the manifest main", () =>
  expect(rootHeld("npx --registry https://registry.npmjs.org tsc -p .", "docs/runtime.js", rtMain)).toBe(false));
test("corepack pnpm install does not run the manifest main", () =>
  expect(rootHeld("corepack pnpm install .", "docs/runtime.js", rtMain)).toBe(false));

// After -e or -p the next word is code and the rest are its arguments.
for (const hook of ['node -e "console.log(1)" .', "node -p process.version .", "node --eval 'x' ."]) {
  test(`${hook}: the dot is an argument of the code, not the root`, () => expect(rootHeld(hook, "docs/runtime.js", rtMain)).toBe(false));
}

// An option's value that names a real file is not the script; a directory or dotfile script is.
const withOk = { ...rtMain, "lib/index.js": "1\n", ".build.js": "1\n" };
for (const hook of ["node --title lib/ok.js .", "node --conditions lib/ok.js .", "node -C lib/ok.js .", "node --title=lib/ok.js ."]) {
  test(`${hook}: the root main changed holds`, () => expect(rootHeld(hook, "docs/runtime.js", withOk)).toBe(true));
}
for (const hook of ["node lib/ .", "node lib .", "node .build.js ."]) {
  test(`${hook}: the dot is an argument of the script, not the root`, () => expect(rootHeld(hook, "docs/runtime.js", withOk)).toBe(false));
}
test("node -r ./lib/ok.js . still runs the root main", () => expect(rootHeld("node -r ./lib/ok.js .", "docs/runtime.js", withOk)).toBe(true));
test("node --import ./lib/ok.js . still runs the root main", () => expect(rootHeld("node --import ./lib/ok.js .", "docs/runtime.js", withOk)).toBe(true));

// Past the nesting limit of package runners the program is not known: it may be node.
test("npx npx npx npx npx npx node . : the root main changed holds", () =>
  expect(rootHeld("npx npx npx npx npx npx node .", "docs/runtime.js", rtMain)).toBe(true));
test("npx npx npx npx npx npx tsc -p . : still holds past the limit (the program is not known)", () =>
  expect(rootHeld("npx npx npx npx npx npx tsc -p .", "docs/runtime.js", rtMain)).toBe(true));

// An option node knows no value rule for may take the next word: the dot after it is still the root.
for (const hook of [
  "node --localstorage-file lib/ok.js .",
  "node --test-reporter-destination lib/ok.js .",
  "node --snapshot-blob lib/ok.js .",
  "node --experimental-config-file lib/ok.js .",
  "node --some-future-flag lib/ok.js .",
  "node --title t --localstorage-file lib/ok.js .",
]) {
  test(`${hook}: the root main changed holds`, () => expect(rootHeld(hook, "docs/runtime.js", withOk)).toBe(true));
}
// Options that never take a value leave the script as the first operand.
for (const hook of ["node --no-warnings scripts/build.js .", "node --enable-source-maps scripts/build.js .", "node --experimental-vm-modules scripts/build.js .", "node --title t scripts/build.js ."]) {
  test(`${hook}: the dot is an argument of the script`, () =>
    expect(rootHeld(hook, "docs/runtime.js", { ...rtMain, "scripts/build.js": 'console.log("ok")\n' })).toBe(false));
}

test("node --test-name-pattern lib/ok.js . : the root main changed holds", () =>
  expect(rootHeld("node --test-name-pattern lib/ok.js .", "docs/runtime.js", withOk)).toBe(true));
for (const flag of ["--report-on-fatalerror", "--report-compact", "--report-on-signal", "--report-uncaught-exception", "--report-exclude-network", "--report-exclude-env"]) {
  test(`node ${flag} scripts/build.js . : a report flag takes no value, so the dot is an argument`, () =>
    expect(rootHeld(`node ${flag} scripts/build.js .`, "docs/runtime.js", { ...rtMain, "scripts/build.js": 'console.log("ok")\n' })).toBe(false));
}
for (const flag of ["--report-dir", "--report-directory", "--report-filename", "--report-signal"]) {
  test(`node ${flag} lib/ok.js . : a report flag with a value leaves the dot as the root`, () =>
    expect(rootHeld(`node ${flag} lib/ok.js .`, "docs/runtime.js", withOk)).toBe(true));
}

// Options that take no value leave the script as the first operand, including V8 switches.
for (const flag of ["--allow-natives-syntax", "--interpreted-frames-native-stack", "--force-context-aware", "--expose-gc", "--max-lazy", "--use-strict", "--abort-on-uncaught-exception", "--stack-trace-limit=50", "--jitless", "--harmony-shadow-realm", "--frozen-intrinsics"]) {
  test(`node ${flag} lib/ok.js . : the dot is an argument of the script`, () =>
    expect(rootHeld(`node ${flag} lib/ok.js .`, "docs/runtime.js", withOk)).toBe(false));
}
test("node --expose-gc . : the dot is the root", () => expect(rootHeld("node --expose-gc .", "docs/runtime.js", withOk)).toBe(true));

// After a script everything is its argument, `--` included; with no script yet the word after `--` is the script or root.
test("node scripts/build.js -- . : both later words are arguments of the script", () =>
  expect(rootHeld("node scripts/build.js -- .", "docs/runtime.js", { ...rtMain, "scripts/build.js": 'console.log("ok")\n' })).toBe(false));
test("node -- . : no script yet, the dot is the root", () => expect(rootHeld("node -- .", "docs/runtime.js", rtMain)).toBe(true));

// The value of a documented value option is not the root.
test("node --title . lib/ok.js : the dot is the title, not the root", () =>
  expect(rootHeld("node --title . lib/ok.js", "docs/runtime.js", withOk)).toBe(false));
test("node --title . . : the first dot is the title and the second is the root", () =>
  expect(rootHeld("node --title . .", "docs/runtime.js", withOk)).toBe(true));
test("node --env-file . lib/ok.js : the value is not the root", () =>
  expect(rootHeld("node --env-file . lib/ok.js", "docs/runtime.js", withOk)).toBe(false));
