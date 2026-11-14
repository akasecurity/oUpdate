import { expect, test } from "bun:test";
import { classifyJs, provablyStatic, scannerFaultCount, setJsScanSteps } from "../src/install-closure.ts";
import { prepass, type FileMap } from "../src/prepass.ts";

const enc = (s: string) => new TextEncoder().encode(s);
const files = (o: Record<string, string>): FileMap => new Map(Object.entries(o).map(([k, v]) => [k, enc(v)]));
const holds = (old: FileMap, now: FileMap) => prepass("npm", old, now).hard.filter((s) => s.kind === "install-script").map((s) => s.detail);
const release = (v: string, hook: string) =>
  files({
    "package.json": JSON.stringify({ name: "p", version: v, scripts: { postinstall: "node lib/hook.js" } }),
    "lib/hook.js": hook,
    "docs/payload.txt": `payload ${v}\n`,
  });
const widensDocs = (hook: string) => holds(release("1.0.0", hook), release("1.0.1", hook)).some((d) => d.includes("docs/payload.txt"));

// `k` is "constructor" built at run time. Each shape calls a computed member, so it reaches Function from any value.
const K = 'const k = ["con", "structor"].join("");\n';
const reaches: [string, string][] = [
  ["an optional chain", `${K}exports.main = () => []?.[k]?.[k]?.("return 1")();\n`],
  ["an optional chain then a plain call", `${K}exports.main = () => [].map?.[k]("return 1")();\n`],
  ["a function expression indexed directly", `${K}exports.main = () => function () {}[k]("return 1")();\n`],
  ["an async function expression indexed directly", `${K}exports.main = () => async function () {}[k]("return 1")();\n`],
  ["a class expression indexed directly", `${K}exports.main = () => class {}[k]("return 1")();\n`],
  ["a tagged template call", "exports.main = () => [].map[[\"con\", \"structor\"].join(\"\")]`return 1`();\n"],
  ["a parenthesized callee", `${K}exports.main = () => ([].map[k])("return 1")();\n`],
  ["a comma-wrapped callee", `${K}exports.main = () => (0, [].map[k])("return 1")();\n`],
  ["a doubly parenthesized callee", `${K}exports.main = () => (([].map[k]))("return 1")();\n`],
  ["new with a parenthesized callee", `${K}exports.main = () => new ([].map[k])("return 1")();\n`],
  ["a returned parenthesized callee", `${K}function f() { return ([].map[k])("return 1"); }\nexports.main = () => f()();\n`],
  ["a call through .call", `${K}exports.main = () => [].map[k].call(0, "return 1")();\n`],
  ["a call through .apply", `${K}exports.main = () => [].map[k].apply(0, ["return 1"])();\n`],
  ["a call through .bind", `${K}exports.main = () => [].map[k].bind(0, "return 1")()();\n`],
  ["a call through ?.call", `${K}exports.main = () => [].map[k]?.call(0, "return 1")();\n`],
  ["a call through .call after many spaces", `${K}exports.main = () => [].map[k].${" ".repeat(40)}call(0, "return 1")();\n`],
  ["a call through .apply after many spaces", `${K}exports.main = () => [].map[k]${" ".repeat(30)}.${" ".repeat(30)}apply(0, ["return 1"])();\n`],
  ["a call through .bind after many spaces", `${K}exports.main = () => [].map[k].${" ".repeat(40)}bind(0, "return 1")()();\n`],
  ["a callee in 17 nested groups", `${K}exports.main = () => ${"(".repeat(17)}[].map[k]${")".repeat(17)}("return 1")();\n`],
  ["a function expression indexed before a block on the next line", `${K}const f = function () {}[k]("return 1")\n{}\nexports.main = f;\n`],
  ["a callee grouped with ||", `${K}exports.main = () => ([].map[k] || 0)("return 1")();\n`],
  ["a callee in a conditional", `${K}exports.main = () => (1 ? [].map[k] : 0)("return 1")();\n`],
  ["a class that extends a computed member", `${K}class A extends [].map[k] {}\nexports.main = () => new A("return 1")();\n`],
  ["a grouped callee after an if header", `${K}exports.main = (c) => { if (c) ([].map[k])("return 1")(); };\n`],
  ["a grouped callee inside a group with ||", `${K}exports.main = () => (([].map[k]) || 0)("return 1")();\n`],
  ["a class that extends a computed member of a call", `${K}const f = () => [].map;\nclass A extends f()[k] {}\nexports.main = () => new A("return 1")();\n`],
  ["a function expression indexed after a body longer than 4096 characters", `${K}exports.main = () => function () { ${"x += 1; ".repeat(600)} }[k]("return 1")();\n`],
  ["an object literal property holding a function expression indexed directly", `${K}const o = { a: function () {}[k]("return 1") };\nexports.o = o;\n`],
  ["a function expression indexed after 70 spaces before its parameters", `${K}exports.main = () => function${" ".repeat(70)}(){}[k]("return 1")();\n`],
  ["a class expression indexed after a base 270 spaces away", `${K}exports.main = () => class extends${" ".repeat(270)}Object {}[k]("return 1")();\n`],
  ["a class that extends a computed member of a call with an object argument", `${K}const f = () => [].map;\nclass A extends f({})[k] {}\nexports.main = () => new A("return 1")();\n`],
  ["a class that extends a computed member of a call with 300 spaces", `${K}const f = () => [].map;\nclass A extends f(${" ".repeat(300)})[k] {}\nexports.main = () => new A("return 1")();\n`],
  ["a function expression indexed as the value of a key named default", `${K}const o = { default: function () {}[k]("return 1") };\nexports.o = o;\n`],
  ["a class that extends a grouped computed member", `${K}class B extends ([].map[k]) {}\nexports.main = () => new B("return 1")();\n`],
  ["an empty array default that is then called", `${K}exports.main = () => ([].map[k] || [])("return 1")();\n`],
  ["an empty object default that is then called", `${K}exports.main = () => ([].map[k] ?? {})("return 1")();\n`],
  ["an empty array default then .call", `${K}exports.main = () => ([].map[k] || []).call(null, "return 1")();\n`],
  ["an empty array default then an optional call", `${K}exports.main = () => ([].map[k] || [])?.("return 1")();\n`],
  ["an empty array default then a quoted call key", `${K}exports.main = () => ([].map[k] || [])["call"](null, "return 1")();\n`],
  ["an empty array default then a quoted apply key", `${K}exports.main = () => ([].map[k] || [])["apply"](null, ["return 1"])();\n`],
  ["an empty array default then a quoted bind key", `${K}exports.main = () => ([].map[k] || [])["bind"](null, "return 1")()();\n`],
  ["an optional call after blanks", `${K}exports.main = () => [].map[k]?. ("return 1")();\n`],
  ["an empty array default then an optional index by a computed key", `${K}exports.main = () => ([].map[k] || [])?.[k]("return 1")();\n`],
  ["an empty array default indexed by a computed key then .call", `${K}exports.main = () => ([].map[k] || [])[k].call(null, "return 1")();\n`],
];
for (const [label, src] of reaches) {
  test(`${label}: not static, the hazard widens and a changed payload holds`, () => {
    expect(provablyStatic(src)).toBe(false);
    expect(classifyJs("pkg/lib/x.js", src).all).toBe(true);
    expect(widensDocs(src)).toBe(true);
  });
}

// Shapes that do not call the computed member stay static.
const stays: [string, string][] = [
  ["a computed member passed to a call that returns a function", "const o = { a: 1 };\nconst f = (x) => () => x;\nexports.main = (k) => f(o[k])(1);\n"],
  ["a computed member in an if condition", "const o = { a: 1 };\nexports.main = (k) => { if (o[k]) { return 1; } return 0; };\n"],
  ["an array literal indexed after a block", "exports.main = (a, b) => { if (a) {}\n[a, b][0].toString(); };\n"],
  ["an array literal indexed after a case block", "exports.main = (x) => { switch (x) { case 1: { x++; } [1, 2][0].toString(); } };\n"],
  ["an array literal indexed after a labeled block", "exports.main = (x) => { label: { x++; } [1, 2][0].toString(); };\n"],
  ["an array literal indexed after a block longer than 4096 characters", `exports.main = (flag, x) => { if (flag) { ${"x += 1; ".repeat(600)} }\n[1, 2][0].toString(); };\n`],
  ["a class method named by a computed key after another method", "const tag = [\"t\"].join(\"\");\nclass A { a() { return 1; }\n[tag]() { return 2; } }\nexports.A = A;\n"],
  ["an array literal indexed after an if block on the same line", "exports.main = (flag) => { if (flag) {} [1, 2][0].toString(); };\n"],
  ["an array literal indexed after a function declaration", "function f() {}\n[1, 2][0].toString();\nexports.f = f;\n"],
  ["a computed member as the test of a conditional callee", "exports.main = (o, k, f, g) => (o[k] ? f : g)(1);\n"],
  ["a computed member on the left of && in a callee", "exports.main = (o, k, f) => (o[k] && f)(1);\n"],
  ["a computed member as the test of an indexed conditional", "exports.main = (o, k, a, b, j) => (o[k] ? a : b)[j];\n"],
  ["a computed member behind typeof in a callee", "exports.main = (o, k) => (typeof o[k])(1);\n"],
  ["a computed member behind void in a callee", "exports.main = (o, k) => (void o[k])(1);\n"],
  ["a computed member in 17 groups that are not called", `exports.main = (o, k) => ${"(".repeat(17)}o[k]${")".repeat(17)} + 1;\n`],
  ["a computed member with an empty array default, indexed", "exports.main = (cache, key) => (cache[key] || [])[0];\n"],
  ["a computed member with an empty object default, indexed", "exports.main = (map, a, b) => (map[a] || {})[b];\n"],
  ["a computed read in parentheses used as a value", "const o = { a: 1 };\nexports.main = (k) => (o[k]) + 1;\n"],
  ["a || default followed by a comma in the group", "exports.f = (o, k, f, g) => (o[k] || f, g)(1);\n"],
  ["a || default that is the test of a conditional", "exports.f = (o, k, f, a, b) => (o[k] || f ? a : b)(1);\n"],
  ["a conditional branch followed by a comma in the group", "exports.f = (c, o, k, f, g) => (c ? o[k] : f, g)(1);\n"],
  ["a ?? default followed by a comma, then indexed", "exports.f = (o, k, f, g, j) => (o[k] ?? f, g)[j];\n"],
  ["a computed member with an empty array default, optionally indexed", "exports.main = (cache, key) => (cache[key] || [])?.[0];\n"],
  ["a computed member with an empty object default, optionally read", "exports.main = (o, k) => (o[k] ?? {})?.x;\n"],
  ["a computed member with an empty array default, indexed by a counter", "const a = [[() => 1]];\nfor (let i = 0; i < 1; i++) (a[i] || [])[i];\n"],
  ["a computed member with an empty object default, indexed, then a property read", "exports.f = (c, a, b) => (c[a] || {})[b].size;\n"],
];
for (const [label, src] of stays) {
  test(`${label}: stays static`, () => {
    expect(provablyStatic(src)).toBe(true);
    expect(classifyJs("pkg/lib/x.js", src).all).toBe(false);
  });
}

// Budget rows run under a fixed step limit of 40 per character, about twice what the reading spends (a step count is the same
// on every machine), so a reading that spends more faults. Where the previous head's cost was uncharged, it spent no steps on it
// and only the wall-time bound sees it.
const underLimit = (src: string) => {
  setJsScanSteps(40 * src.length);
  try {
    const before = scannerFaultCount();
    const t = performance.now();
    const v = provablyStatic(src);
    return { v, faults: scannerFaultCount() - before, ms: performance.now() - t };
  } finally {
    setJsScanSteps(undefined);
  }
};

// The empty-default check and the climb read each group once: a long run of || defaults with a padded tail stays linear.
test("200,000 members joined by || before 200,000 blanks read in linear time with no fault", () => {
  const r = underLimit("exports.x = (o, k, f) => (" + "o[k] || ".repeat(200_000) + "f" + " ".repeat(200_000) + ");\n");
  expect(r.v).toBe(true);
  expect(r.faults).toBe(0);
  // A re-read of the group's tail per member was uncharged and took about 19 s; linear takes under 1 s.
  expect(r.ms).toBeLessThan(10_000);
});

// What follows a group is read once per group: a long || chain before ?. and a megabyte of blanks does not re-walk the blanks.
test("200,000 members joined by || before ?. and 1 MB of blanks read the group's next token once", () => {
  const r = underLimit("(" + "o[k] || ".repeat(200_000) + "f)?." + " ".repeat(1024 * 1024) + "y;\n");
  expect(r.v).toBe(true);
  expect(r.faults).toBe(0);
  expect(r.ms).toBeLessThan(10_000); // the old re-walk was uncharged
});

// The empty-default check is read once per place: 2,000 members of an inner group climbing to an outer || [] default after 1 MB
// of blanks do not walk the blanks again each.
test("2,000 members of an inner group before an empty default after 1 MB of blanks read the default once", () => {
  const r = underLimit("exports.f = (o, k) => ((" + "o[k] || ".repeat(2000) + "o[k]) ||" + " ".repeat(1 << 20) + "[])[0];\n");
  expect(r.v).toBe(true);
  expect(r.faults).toBe(0); // the previous head charged a walk of the blanks per member and tripped the budget
});

// A group's own checks (what stands before its opener, what follows it) are read once per group, not once per member.
test("2,000 members of a group after 1 MB of blanks read what stands before the group once", () => {
  const r = underLimit("f" + "\n".repeat(1 << 20) + "(o[k] || " + Array.from({ length: 2000 }, (_, i) => "g" + i + "[k]").join(" || ") + ")");
  expect(r.v).toBe(true);
  expect(r.faults).toBe(0); // the previous head re-walked the blanks per member: about 2e9 steps
});
// A label's colon stops the walk back at the previous colon of the same bracket: 1,000 labelled blocks are read in linear steps.
test("1,000 labelled blocks before an index, with no semicolons, read each colon once", () => {
  const r = underLimit("exports.f = () => {\n" + "label: {} [1, 2][0].toString()\n".repeat(1000) + "};");
  expect(r.v).toBe(true);
  expect(r.faults).toBe(0);
});
// A quoted key padded past 64 characters is still a literal: static on main, so static here.
for (const [label, src] of [
  ["leading blanks", "const o = { safe: () => 1 };\no[" + " ".repeat(64) + '"safe"]();\n'],
  ["trailing blanks", "const o = { safe: () => 1 };\no['safe'" + " ".repeat(64) + "]();\n"],
  ["blanks on both sides", "const o = { safe: () => 1 };\no[" + " ".repeat(500) + '"safe"' + " ".repeat(500) + "]();\n"],
] as [string, string][]) {
  test(`a quoted key with ${label} past 64 characters stays static`, () => {
    expect(provablyStatic(src)).toBe(true);
    expect(classifyJs("pkg/lib/x.js", src).all).toBe(false);
  });
}

// A member climbs the groups around it once: each level is read for the first member that reaches it.
test("5,000 members of 5,000 nested groups are climbed once and stay static with no fault", () => {
  const r = underLimit("x = " + "(".repeat(5000) + "o[k] || ".repeat(5000) + "g" + ")".repeat(5000) + ";\n");
  expect(r.v).toBe(true);
  expect(r.faults).toBe(0);
});
test("2,000 members of an inner group inside an outer group after 1 MB of blanks do not walk the blanks each", () => {
  const r = underLimit("exports.f = (o, k, g) => (" + " ".repeat(1 << 20) + "(" + Array.from({ length: 2000 }, (_, i) => "g" + i + "[k]").join(" || ") + "));\n");
  expect(r.v).toBe(true);
  expect(r.faults).toBe(0);
});
// A colon is walked back once, not again for each colon inside the object it sits in.
test("10,000 labelled blocks inside a labelled block read the outer colon once", () => {
  const r = underLimit("x = 1\n".repeat(10_000) + "l: {\n" + "m: {} [0]\n".repeat(10_000) + "}\n");
  expect(r.v).toBe(true);
  expect(r.faults).toBe(0);
});

// A block's brace is read once, whatever colon inside it asks: 1 MB of blanks before it, or a long name chain, is not walked per colon.
test("2,000 labelled blocks inside a block after 1 MB of blanks read the brace once", () => {
  const r = underLimit("foo" + "\n".repeat(1 << 20) + "{\n" + "m: {} [0]\n".repeat(2000) + "}\n");
  expect(r.v).toBe(true);
  expect(r.faults).toBe(0);
});
test("10,000 labelled blocks inside a block after a 10,000-link name chain read the brace once", () => {
  const r = underLimit("x" + ".y".repeat(10_000) + "\n{\n" + "m: {} [0]\n".repeat(10_000) + "}\n");
  expect(r.v).toBe(true);
  expect(r.faults).toBe(0);
});
