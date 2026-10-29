import { expect, test } from "bun:test";
import { prepass, type FileMap } from "../src/prepass.ts";

const enc = new TextEncoder();
const map = (f: Record<string, string>): FileMap => new Map(Object.entries(f).map(([k, v]) => [k, enc.encode(v)]));
const index = `const flag = require("function-flag");\nmodule.exports = (s) => flag.asciiArt(String(s), "Bloody");\n`;
const pj = (fields: Record<string, unknown>, version: string) =>
  JSON.stringify({ name: "function-color", version, main: "index.js", ...fields }, null, 2) + "\n";
const hard = (o: Record<string, string>, n: Record<string, string>) =>
  prepass("npm", map(o), map(n)).hard.map((s) => `${s.kind}:${s.detail}`);
const deps = (d: Record<string, string>) => ({ dependencies: d });
const pair = (oldF: Record<string, unknown>, newF: Record<string, unknown>, extraNew: Record<string, string> = {}) =>
  [{ "package/package.json": pj(oldF, "1.0.0"), "package/index.js": index }, { "package/package.json": pj(newF, "1.7.3"), "package/index.js": index, ...extraNew }] as const;

const cases: [string, "HOLD" | "QUIET", Record<string, unknown>, Record<string, unknown>, Record<string, string>?][] = [
  ["Z0 ^4.0.0 -> ^1.7.3", "HOLD", deps({ "function-flag": "^4.0.0" }), deps({ "function-flag": "^1.7.3" })],
  ["Z1 ^1.7", "HOLD", deps({ "function-flag": "^4.0.0" }), deps({ "function-flag": "^1.7" })],
  ["Z2 1.x", "HOLD", deps({ "function-flag": "^4.0.0" }), deps({ "function-flag": "1.x" })],
  ["Z3 *", "HOLD", deps({ "function-flag": "^4.0.0" }), deps({ "function-flag": "*" })],
  ["Z4 <5.0.0", "HOLD", deps({ "function-flag": "^4.0.0" }), deps({ "function-flag": "<5.0.0" })],
  ["Z5 || lower alternative", "HOLD", deps({ "function-flag": "^4.0.0" }), deps({ "function-flag": "^4.0.0 || ^1.7.3" })],
  ["Z6 >= with a space", "HOLD", deps({ "function-flag": "^4.0.0" }), deps({ "function-flag": ">= 1.7.3" })],
  ["Z7 >1.7.2", "HOLD", deps({ "function-flag": "^4.0.0" }), deps({ "function-flag": ">1.7.2" })],
  ["Z8 prerelease", "HOLD", deps({ "function-flag": "^4.0.0" }), deps({ "function-flag": "1.7.3-0" })],
  ["Z9 tag", "HOLD", deps({ "function-flag": "^4.0.0" }), deps({ "function-flag": "latest" })],
  ["Z10 npm alias", "HOLD", deps({ "function-flag": "^4.0.0" }), deps({ "function-flag": "npm:function-flag@1.7.3" })],
  ["Z11 renamed alias key", "HOLD", deps({ "function-flag": "^4.0.0" }), deps({ ff: "npm:function-flag@1.7.3" })],
  ["Z12 git url", "HOLD", deps({ "function-flag": "^4.0.0" }), deps({ "function-flag": "github:someone/function-flag#v1.7.3" })],
  ["Z13 tarball url", "HOLD", deps({ "function-flag": "^4.0.0" }), deps({ "function-flag": "https://example.com/function-flag-1.7.3.tgz" })],
  ["Z14 move to optionalDependencies", "HOLD", deps({ "function-flag": "^4.0.0" }), { optionalDependencies: { "function-flag": "^1.7.3" } }],
  ["Z15 move to peerDependencies", "HOLD", deps({ "function-flag": "^4.0.0" }), { peerDependencies: { "function-flag": "^1.7.3" } }],
  ["Z16 optionalDependencies falls", "HOLD", { optionalDependencies: { "function-flag": "^4.0.0" } }, { optionalDependencies: { "function-flag": "^1.7.3" } }],
  ["Z17 peerDependencies falls", "HOLD", { peerDependencies: { "function-flag": "^4.0.0" } }, { peerDependencies: { "function-flag": "^1.7.3" } }],
  ["Z18 optional floor under the dependency", "HOLD", deps({ "function-flag": "^4.0.0" }), { dependencies: { "function-flag": "^4.0.0" }, optionalDependencies: { "function-flag": "^1.7.3" } }],
  ["Z19 shrinkwrap added", "HOLD", deps({ "function-flag": "^4.0.0" }), deps({ "function-flag": "^4.0.0" }), {
    "package/npm-shrinkwrap.json": "{\"name\":\"function-color\",\"lockfileVersion\":3}\n",
  }],
  ["Z20 overrides stay quiet", "QUIET", deps({ "function-flag": "^4.0.0" }), { dependencies: { "function-flag": "^4.0.0" }, overrides: { "function-flag": "1.7.3" } }],
  ["Z21 partial ^4", "HOLD", deps({ "function-flag": "^4" }), deps({ "function-flag": "^1.7.3" })],
  ["Z22 bundled dependency appears", "HOLD", deps({ "function-flag": "^4.0.0" }), { dependencies: { "function-flag": "^4.0.0" }, bundleDependencies: ["function-flag"] }, {
    "package/node_modules/function-flag/package.json": JSON.stringify({ name: "function-flag", version: "1.7.3", scripts: { postinstall: "node x.js" } }),
    "package/node_modules/function-flag/x.js": "require('child_process').exec('id')\n",
  }],
  ["F1 equal floor", "QUIET", deps({ "function-flag": "^4.0.0" }), deps({ "function-flag": "~4.0.0" })],
  ["F2 rising floor", "QUIET", deps({ "function-flag": "^4.0.0" }), deps({ "function-flag": "^4.1.0" })],
  ["F3 reordered alternatives", "QUIET", deps({ "function-flag": "^4.0.0 || ^1.0.0" }), deps({ "function-flag": "^1.0.0 || ^4.0.0" })],
  ["F4 removed dependency", "QUIET", deps({ "function-flag": "^4.0.0" }), deps({})],
  ["F5 exact equals the lower bound", "QUIET", deps({ "function-flag": ">=4.0.0" }), deps({ "function-flag": "4.0.0" })],
  ["Y1 optional overrode the dependency, then the optional edge was removed", "HOLD", { dependencies: { "function-flag": "^1.0.0" }, optionalDependencies: { "function-flag": "^4.0.0" } }, { dependencies: { "function-flag": "^1.0.0" } }],
  ["Y2 the winning optional edge and the dependency swapped ranges", "HOLD", { dependencies: { "function-flag": "^1.0.0" }, optionalDependencies: { "function-flag": "^4.0.0" } }, { dependencies: { "function-flag": "^4.0.0" }, optionalDependencies: { "function-flag": "^1.0.0" } }],
  ["Y3 the dependency overrode the peer, then the dependency fell", "HOLD", { dependencies: { "function-flag": "^4.0.0" }, peerDependencies: { "function-flag": "^1.0.0" } }, { dependencies: { "function-flag": "^1.0.0" }, peerDependencies: { "function-flag": "^1.0.0" } }],
  ["Y4 the dependency overrode the peer, then the dependency was removed", "HOLD", { dependencies: { "function-flag": "^4.0.0" }, peerDependencies: { "function-flag": "^1.0.0" } }, { peerDependencies: { "function-flag": "^1.0.0" } }],
  ["Y5 an alias of the same package was removed", "HOLD", { dependencies: { a: "npm:function-flag@^4.0.0", "function-flag": "^1.0.0" } }, { dependencies: { "function-flag": "^1.0.0" } }],
  ["Y6 a leading zero lowers the floor", "HOLD", deps({ "function-flag": "^4.0.0" }), deps({ "function-flag": "^01.7.3" })],
  ["Y7 a version Bun cannot order holds", "HOLD", deps({ "function-flag": "^4.0.0" }), deps({ "function-flag": "^4.0.0 || 99999999999999999999.0.0" })],
  ["Y8 a hyphen range uses its left side", "HOLD", deps({ "function-flag": "^4.0.0" }), deps({ "function-flag": "1.7.3 - 4" })],
  ["Y9 a loose prefix is unreadable", "HOLD", deps({ "function-flag": "^4.0.0" }), deps({ "function-flag": "v=1.7.3" })],
  // >=4.0.0 and >3 name the same versions. The floor still drops, and that false hold stays.
  ["G1 greater-than three holds", "HOLD", deps({ "function-flag": ">=4.0.0" }), deps({ "function-flag": ">3" })],
  ["G2 the same range moved from dependencies to optionalDependencies", "QUIET", deps({ "function-flag": "^4.0.0" }), { optionalDependencies: { "function-flag": "^4.0.0" } }],
  ["X1 a dependency fell while another key kept the old alias", "HOLD", deps({ "function-flag": "^4.0.0" }), { dependencies: { "function-flag": "^1.0.0" }, optionalDependencies: { ff: "npm:function-flag@^4.0.0" } }],
  ["X2 the dependency moved to peer while another key kept the old alias", "HOLD", deps({ "function-flag": "^4.0.0" }), { peerDependencies: { "function-flag": "^1.0.0" }, dependencies: { ff: "npm:function-flag@^4.0.0" } }],
  ["X3 the optional edge fell while another key kept the old alias", "HOLD", { optionalDependencies: { "function-flag": "^4.0.0" } }, { optionalDependencies: { "function-flag": "^1.0.0" }, dependencies: { ff: "npm:function-flag@^4.0.0" } }],
  ["X4 the same key fell while an optional alias kept the old range", "HOLD", deps({ "function-flag": "^4.0.0" }), { dependencies: { "function-flag": "npm:function-flag@^1.0.0" }, optionalDependencies: { x: "npm:function-flag@^4.0.0" } }],
  ["H1 the same key gained an optional copy of the same range", "QUIET", deps({ "function-flag": "^4.0.0" }), { dependencies: { "function-flag": "^4.0.0" }, optionalDependencies: { "function-flag": "^4.0.0" } }],
];

for (const [name, want, oldF, newF, extra] of cases) {
  test(`${name} ${want === "HOLD" ? "holds" : "stays quiet"}`, () => {
    const [a, b] = pair(oldF, newF, extra ?? {});
    const got = hard(a, b);
    if (want === "HOLD") expect(got.length).toBeGreaterThan(0);
    else expect(got).toEqual([]);
    expect(hard(b, b)).toEqual([]);
  });
}

test("a devDependency downgrade is not install-time surface", () => {
  const body = (range: string) => JSON.stringify({ name: "text-pad", version: "1.0.0", devDependencies: { "function-flag": range } }) + "\n";
  expect(hard({ "package.json": body("^4.0.0") }, { "package.json": body("^1.7.3") })).toEqual([]);
});

test("a new package with a dependency stays quiet", () => {
  const neu = {
    "package.json": JSON.stringify({ name: "tint-strings", version: "3.0.0", dependencies: { "ansi-wrap": "^2.0.0" } }) + "\n",
    "index.js": `const wrap = require("ansi-wrap");\n`,
  };
  expect(hard({}, neu)).toEqual([]);
});
