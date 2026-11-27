import { expect, test } from "bun:test";
import { prepass, type FileMap } from "../src/prepass.ts";

const enc = (s: string) => new TextEncoder().encode(s);
const files = (o: Record<string, string>): FileMap => new Map(Object.entries(o).map(([k, v]) => [k, enc(v)]));
const CPX = `const cp = require("child_process");\n`;

// lib/x.js is the postinstall hook; only docs/evil.js changes between the releases. docs/ is outside the package tier, so the release holds it only
// when the scan reaches it by name or widens to every file.
const release = (v: string, body: string, extra: Record<string, string> = {}): FileMap =>
  files({
    "package.json": JSON.stringify({ name: "p", version: v, scripts: { postinstall: "node lib/x.js" } }),
    "lib/x.js": body,
    "lib/a.js": "module.exports = { args: [] }\n",
    "docs/evil.js": `console.log("evil ${v}")\n`,
    ...extra,
  });
const held = (body: string, extra: Record<string, string> = {}): boolean =>
  prepass("npm", release("1.0.0", body, extra), release("1.0.1", body, extra)).hard.some((s) => s.kind === "install-script");
const DE = `decodeURIComponent("docs%2Fevil.js")`;
const run = `cp.spawnSync(process.execPath, args);\n`;

const rows: [string, string, Record<string, string>?][] = [
  ["a container object holding the array, written through the container", `${CPX}const args = ["lib/a.js"];\nconst o = { l: args };\no.l[0] = ${DE};\n${run}`],
  ["a one-element container array, written through [0][0]", `${CPX}const args = ["lib/a.js"];\n[args][0][0] = ${DE};\n${run}`],
  ["a container object literal, written through its key", `${CPX}const args = ["lib/a.js"];\n({ l: args }).l[0] = ${DE};\n${run}`],
  ["an index write through a parenthesized name", `${CPX}const args = ["lib/a.js"];\n(args[0]) = ${DE};\n${run}`],
  ["a double-parenthesized index write", `${CPX}const args = ["lib/a.js"];\n((args))[0] = ${DE};\n${run}`],
  ["a double-parenthesized push", `${CPX}const args = [];\n((args)).push(${DE});\n${run}`],
  ["Object.assign with a parenthesized target", `${CPX}const args = ["lib/a.js"];\nObject.assign((args), [${DE}]);\n${run}`],
  ["Object[\"assign\"] with the array as target", `${CPX}const args = ["lib/a.js"];\nObject["assign"](args, [${DE}]);\n${run}`],
  ["Reflect.apply with a parenthesized Array.prototype.push", `${CPX}const args = [];\nReflect.apply((Array.prototype.push), args, [${DE}]);\n${run}`],
  ["Reflect[\"apply\"] on the array", `${CPX}const args = [];\nReflect["apply"](Array.prototype.push, args, [${DE}]);\n${run}`],
  ["Reflect.apply with a doubly parenthesized receiver", `${CPX}const args = [];\nReflect.apply(Array.prototype.push, ((args)), [${DE}]);\n${run}`],
  ["[].push.call on the array", `${CPX}const args = [];\n[].push.call(args, ${DE});\n${run}`],
  ["a push held by a name and called with .call", `${CPX}const args = [];\nconst p = [].push;\np.call(args, ${DE});\n${run}`],
  ["Reflect.apply of [].push", `${CPX}const args = [];\nReflect.apply([].push, args, [${DE}]);\n${run}`],
  ["a write through args || a literal", `${CPX}const args = [];\n(args || ["x"]).push(${DE});\n${run}`],
  ["a write through a comma expression", `${CPX}const args = [];\n(0, args).push(${DE});\n${run}`],
  ["a write through a conditional", `${CPX}const args = [];\n(1 ? args : null).push(${DE});\n${run}`],
  ["a push through arguments[0]", `${CPX}const args = [];\n(function () { arguments[0].push(${DE}); })(args);\n${run}`],
  ["a cross-file write through require", `${CPX}const args = require("./a.js").args;\nrequire("./b.js").args[0] = ${DE};\n${run}`, { "lib/b.js": `module.exports = { args: [] }\n` }],
  ["a write through a destructured container", `${CPX}const args = [];\nconst { l } = { l: args };\nl.push(${DE});\n${run}`],
  ["a write through an array destructured container", `${CPX}const args = [];\nconst [l] = [args];\nl.push(${DE});\n${run}`],
];
for (const [label, body, extra] of rows)
  test(`${label} holds the changed docs/evil.js`, () => {
    expect(held(body, extra)).toBe(true);
  });

const more: [string, string][] = [
  ["a container literal that holds an array literal, written through its key", `${CPX}const o = { l: ["lib/a.js"] };\no.l[0] = ${DE};\ncp.spawnSync(process.execPath, o.l);\n`],
  ["an index write through a call result", `${CPX}const args = ["lib/a.js"];\nconst get = () => args;\nget()[0] = ${DE};\n${run}`],
  ["a push through a member chain", `${CPX}const args = [];\nconst o = { l: args };\no.l.push(${DE});\n${run}`],
  ["Object[\"assign\"] with a member target", `${CPX}const args = ["lib/a.js"];\nconst o = { l: args };\nObject["assign"](o.l, [${DE}]);\n${run}`],
  ["an array bound with bind and written", `${CPX}const args = [];\nconst add = [].push.bind(args);\nadd(${DE});\n${run}`],
  ["a push held by a name and applied", `${CPX}const args = [];\nconst p = Array.prototype.push;\np.apply(args, [${DE}]);\n${run}`],
  ["an index write whose bracket does not close in 400 characters, through a member", `${CPX}const args = ["lib/a.js"];\nconst o = { l: args };\no.l[0${" ".repeat(450)}] = ${DE};\n${run}`],
];
for (const [label, body] of more)
  test(`${label} holds the changed docs/evil.js`, () => {
    expect(held(body)).toBe(true);
  });

// Shapes that write nothing an argument array holds: the literal argv stays constant and nothing widens.
const calm: [string, string][] = [
  ["Object.assign into an empty object", `${CPX}const args = ["lib/a.js"];\nconst o = Object.assign({}, { a: 1 });\n${run}`],
  ["a method call chain that is not a write", `${CPX}const args = ["lib/a.js"];\nconst n = "a,b".split(",").map((x) => x.trim()).length;\n${run}`],
  ["a comparison through a member index", `${CPX}const args = ["lib/a.js"];\nconst o = { l: args };\nif (o.l[0] == "lib/a.js") ${run}`],
  ["a call result read by index", `${CPX}const args = ["lib/a.js"];\nconst first = [args][0][0];\n${run}`],
];
for (const [label, body] of calm)
  test(`pin: ${label} does not hold docs/evil.js`, () => {
    expect(held(body)).toBe(false);
  });

// A main retarget between two byte-identical writer files that a preinstall hook also names: `node .` reaches the same files on both sides, so only
// the file `node .` runs differs. Both files write an argv and spawn; the one that runs decides what the install starts.
const WRITER = `const cp = require("child_process");\nconst args = ["./local.js"];\nargs[0] = decodeURIComponent("docs%2Fchanged.js");\ncp.spawnSync(process.execPath, args);\n`;
const retarget = (v: string, main: string, post: string, pre = "node docs/a.js && node docs/b.js", extra: Record<string, string> = {}): FileMap =>
  files({
    "package.json": JSON.stringify({ name: "p", version: v, main, scripts: { preinstall: pre, postinstall: post } }),
    "docs/a.js": WRITER,
    "docs/b.js": WRITER,
    "docs/changed.js": "console.log(1)\n",
    "local.js": "1\n",
    ...extra,
  });
const heldRetarget = (post: string, pre?: string, mainB = "docs/b.js"): boolean =>
  prepass("npm", retarget("1.0.0", "docs/a.js", post, pre), retarget("1.0.1", mainB, post, pre)).hard.some((s) => s.kind === "install-script");
for (const [label, post, pre] of [
  ["`node .` after a preinstall that names both writers", "node .", undefined],
  ["`node .` after a piped preinstall", "node .", "node docs/a.js | cat && node docs/b.js"],
  ["`npx .` after a preinstall that names both writers", "npx .", undefined],
] as [string, string, string | undefined][])
  test(`a main moved between two identical writer files holds: ${label}`, () => {
    expect(heldRetarget(post, pre)).toBe(true);
  });
test("pin: the same main with a new version and no change to the files releases", () => {
  expect(heldRetarget("node .", undefined, "docs/a.js")).toBe(false);
});
test("pin: a main moved between two identical files that are not writers releases", () => {
  const plain = (v: string, main: string) => retarget(v, main, "node .", undefined, { "docs/a.js": "1\n", "docs/b.js": "1\n" });
  expect(prepass("npm", plain("1.0.0", "docs/a.js"), plain("1.0.1", "docs/b.js")).hard.some((s) => s.kind === "install-script")).toBe(false);
});

// A hook line with an unresolved expansion and a pipe: its other commands are still read (the whole line went unread, so a changed file `node .` reaches
// was in no comparison).
const stopRel = (v: string, post: string): FileMap =>
  files({
    "package.json": JSON.stringify({ name: "p", version: v, main: "docs/a.js", scripts: { postinstall: post } }),
    "docs/a.js": WRITER,
    "local.js": "1\n",
    "docs/changed.js": `console.log(${v === "1.0.0" ? 1 : 2})\n`,
  });
const stopHeld = (post: string): boolean => prepass("npm", stopRel("1.0.0", post), stopRel("1.0.1", post)).hard.some((s) => s.kind === "install-script");
for (const post of [
  "echo $npm_package_x | cat && node . | cat",
  "echo $npm_package_x && node . | cat",
  "echo $FOO | cat; node . | cat",
  "echo ${npm_package_x} | cat; npx . | cat",
  "node . | cat && echo $npm_package_x | cat",
])
  test(`an unresolved expansion beside a pipe does not hide a changed file of the commands that read: ${post}`, () => {
    expect(stopHeld(post)).toBe(true);
  });
test("pin: the same line with a pipe and an unresolved expansion and no file change releases", () => {
  const same = (v: string): FileMap => files({ ...Object.fromEntries([...stopRel(v, "echo $FOO | cat; node . | cat")].map(([k, b]) => [k, new TextDecoder().decode(b)])), "docs/changed.js": "x\n" });
  const strip = (v: string): FileMap => {
    const m = same(v);
    const pj = JSON.parse(new TextDecoder().decode(m.get("package.json")!));
    return files({ ...Object.fromEntries([...m].map(([k, b]) => [k, new TextDecoder().decode(b)])), "package.json": JSON.stringify({ ...pj, version: v }) });
  };
  expect(prepass("npm", strip("1.0.0"), strip("1.0.1")).hard.some((s) => s.kind === "install-script")).toBe(false);
});
