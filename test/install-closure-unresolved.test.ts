import { expect, test } from "bun:test";
import { prepass, type FileMap } from "../src/prepass.ts";
import { scannerFaultCount } from "../src/install-closure.ts";
import { allowFaults } from "./fault-guard.ts";

const enc = (s: string) => new TextEncoder().encode(s);
const files = (o: Record<string, string>): FileMap => new Map(Object.entries(o).map(([k, v]) => [k, enc(v)]));
const holds = (old: FileMap, now: FileMap) => prepass("npm", old, now).hard.filter((s) => s.kind === "install-script").map((s) => s.detail);

// A package-controlled file reached only through a word the scan cannot resolve (a command substitution, a variable) runs at
// install. Only one payload file changes between the two releases; name.txt names it or a script that runs it. The payload is
// under docs/, which a plain widen leaves out: the read-every-file mode of an out-of-package cd is what reaches it.
const release = (v: string, hook: string) =>
  files({
    "package.json": JSON.stringify({ name: "p", version: v, scripts: { postinstall: hook, evil: "node docs/payload.txt" } }),
    "docs/payload.txt": `payload ${v}\n`,
    "name.txt": "evil\n",
    "d.txt": "docs\n",
  });

const unresolved: [string, string][] = [
  ["npm run with a substituted script name", 'npm run "$(cat name.txt)"'],
  ["npm run-script with a backtick script name", "npm run-script `cat name.txt`"],
  ["npm run with a variable script name", 'npm run "$FOO"'],
  ["node with a substituted file name", "node $(cat name.txt)"],
  ["node -e with substituted code", 'node -e "$(cat name.txt)"'],
  ["yarn with a substituted subcommand", "yarn $(cat name.txt)"],
  ["pnpm with a variable subcommand", "pnpm $FOO"],
  ["a variable command word", "$npm_execpath run evil"],
  ["patch-package with a substituted patch dir", "patch-package --patch-dir $(cat d.txt)"],
  ["patch-package with a substituted patch dir flag value", 'patch-package --patch-dir="$(cat d.txt)"'],
  ["patch-package with a flag it does not model", "patch-package --exclude x"],
];

for (const [label, hook] of unresolved) {
  test(`${label} reads every file, docs included: the changed docs/payload.txt holds`, () => {
    expect(holds(release("1.0.0", hook), release("1.0.1", hook)).length).toBeGreaterThan(0);
  });
}

test("node with a partly substituted path reads the package: the changed lib/evil.js holds", () => {
  const hook = "node ./lib/$(cat name.txt).js";
  const rel = (v: string) =>
    files({
      "package.json": JSON.stringify({ name: "p", version: v, scripts: { postinstall: hook } }),
      "lib/evil.js": `console.log("evil ${v}")\n`,
      "name.txt": "evil\n",
    });
  expect(holds(rel("1.0.0"), rel("1.0.1")).length).toBeGreaterThan(0);
});

test("node -e with code that loads a computed path reads the package: the changed lib/evil.js holds", () => {
  const hook = 'node -e "require(process.argv[1])"';
  const rel = (v: string) =>
    files({
      "package.json": JSON.stringify({ name: "p", version: v, scripts: { postinstall: hook } }),
      "lib/evil.js": `console.log("evil ${v}")\n`,
    });
  expect(holds(rel("1.0.0"), rel("1.0.1")).length).toBeGreaterThan(0);
});

// Clean controls: nothing here runs a changed file, so an unrelated changed file must not hold.
const quiet: [string, string][] = [
  ["a bare npm run (it lists the scripts)", "npm run"],
  ["patch-package with a package name (it creates a patch)", "patch-package some-pkg"],
  ["node -e with code that loads nothing", 'node -e "process.exit(0)"'],
  ["a literal script name", "npm run other"],
];
for (const [label, hook] of quiet) {
  test(`control: ${label} does not read the package`, () => {
    const rel = (v: string) =>
      files({
        "package.json": JSON.stringify({ name: "p", version: v, scripts: { postinstall: hook, other: "echo hi" } }),
        "lib/changed.js": `console.log("c ${v}")\n`,
      });
    expect(holds(rel("1.0.0"), rel("1.0.1"))).toEqual([]);
  });
}

// A static file over 1 MB names its loads like a small one; a fault in that walk is a hold, counted, like any other.
const pad = "// " + "x".repeat(80) + "\n";
const bigHook = (v: string) =>
  files({
    "package.json": JSON.stringify({ name: "p", version: v, scripts: { postinstall: "node lib/big.js" } }),
    "lib/big.js": `require("./other.js")\n` + pad.repeat(13000),
    "lib/other.js": `console.log("other ${v}")\n`,
  });

test("a static file over 1 MB still names the files it loads: the changed other.js holds", () => {
  expect(holds(bigHook("1.0.0"), bigHook("1.0.1")).length).toBeGreaterThan(0);
});

test("a fault in the walk of a static file over 1 MB is counted and holds, even with no changed payload", () => {
  allowFaults();
  const before = scannerFaultCount();
  const real = String.prototype.matchAll;
  String.prototype.matchAll = function (this: string, re: RegExp): ReturnType<typeof real> {
    if (new Error().stack?.includes("followLoadsScan")) throw new RangeError("injected fault");
    return real.call(this, re);
  };
  let found: string[] = [];
  try {
    found = holds(bigHook("1.0.0"), bigHook("1.0.0"));
  } finally {
    String.prototype.matchAll = real;
  }
  expect(scannerFaultCount()).toBeGreaterThan(before);
  expect(found.length).toBeGreaterThan(0);
});
