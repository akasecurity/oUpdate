import { describe, expect, test } from "bun:test";
import * as closure from "../src/install-closure.ts";

const { classifyJs } = closure;
// The index work is counted where the scan has the counter; a scan without it reads as no index work, so those rows are guards there.
const argsIndexedChars: () => number = (closure as { argsIndexedChars?: () => number }).argsIndexedChars ?? (() => 0);

const LIMIT = 9;
const time = (src: string) => {
  const t = performance.now();
  const tier = classifyJs("a.js", src);
  return { tier, took: performance.now() - t };
};
const fill = (unit: string, bytes: number) => unit.repeat(Math.ceil(bytes / unit.length));
/**
 * Growth of the scan cost: the time at four times the size over the time at the base size, after one warm-up call, each the better of two runs. A
 * linear scan gives about 4 and a quadratic one about 16, whatever the speed of the machine; the limit sits between them. A loaded machine can
 * spoil one measurement, so a result over the limit is measured again, up to three times.
 */
const growth = (gen: (bytes: number) => string, base: number): number => {
  classifyJs("a.js", gen(base / 8));
  const best = (bytes: number) => Math.min(time(gen(bytes)).took, time(gen(bytes)).took); // the better of two: a collection pause is not growth
  let ratio = Infinity;
  for (let attempt = 0; attempt < 3 && ratio >= LIMIT; attempt++) ratio = best(base * 4) / Math.max(best(base), 25);
  return ratio;
};

describe("JS scan cost stays linear", () => {
  test("many Reflect aliases", () => {
    expect(growth((bytes) => Array.from({ length: Math.ceil(bytes / 20) }, (_, i) => `const R${i} = Reflect;\n`).join(""), 40 * 1024)).toBeLessThan(LIMIT);
  }, 120000);
  test("an unclosed destructuring repeated (var{var{...)", () => {
    expect(growth((bytes) => fill("var{", bytes) + "} = Reflect;", 50 * 1024)).toBeLessThan(LIMIT);
  }, 120000);
  test("many destructuring ends with no pattern (} = Reflect, } = require.cache)", () => {
    expect(growth((bytes) => fill("} = Reflect;\n", bytes), 64 * 1024)).toBeLessThan(LIMIT);
    expect(growth((bytes) => fill("} = require.cache;\n", bytes), 64 * 1024)).toBeLessThan(LIMIT);
  }, 120000);
  test("spaces inside require( before an unrelated _load", () => {
    expect(growth((bytes) => "const M=require(" + " ".repeat(bytes) + "x); const a=obj._load;", 16 * 1024)).toBeLessThan(LIMIT);
  }, 120000);
  test("one long expression naming a stored cache value many times", () => {
    expect(growth((bytes) => "const c = require.cache;\nf(" + fill("c, ", bytes) + ");", 64 * 1024)).toBeLessThan(LIMIT);
  }, 120000);
  test("repeated blocks of stored cache names with no ; or line break are read in linear time and without a fault", () => {
    const faults = closure.scannerFaultCount();
    const gen = (bytes: number) => "const c = require.cache;\n" + fill("{" + "c, ".repeat(700) + "} ", bytes);
    expect(growth(gen, 64 * 1024)).toBeLessThan(LIMIT);
    classifyJs("a.js", gen(256 * 1024));
    expect(closure.scannerFaultCount()).toBe(faults);
  }, 120000);
  test("many one-name blocks with no ; or line break (a boundary at every match) are read in linear time and without a fault", () => {
    const faults = closure.scannerFaultCount();
    for (const gen of [
      (bytes: number) => "const c = require.cache;\n" + fill("{c}", bytes),
      (bytes: number) => "const c = require.cache;\nf([" + fill("{a:c},", bytes) + "]);",
    ]) {
      expect(growth(gen, 64 * 1024)).toBeLessThan(LIMIT);
      classifyJs("a.js", gen(128 * 1024));
      expect(closure.scannerFaultCount()).toBe(faults);
    }
  }, 120000);
  test("many require( calls and strings read for the module literal", () => {
    expect(growth((bytes) => fill('require( "x"); var s = "a\\"b"; ', bytes) + "obj._load(x);", 64 * 1024)).toBeLessThan(LIMIT);
    expect(growth((bytes) => "require(" + " ".repeat(bytes) + '"module")._load(f);', 16 * 1024)).toBeLessThan(LIMIT);
  }, 120000);
  test("chains of members with spaces (a. a., module. module., exports. exports.) are read in linear time", () => {
    for (const unit of ["a. ", "module. ", "exports. "]) {
      expect(growth((bytes) => fill(unit, bytes) + "z; obj._load(x);", 24 * 1024)).toBeLessThan(LIMIT);
      expect(growth((bytes) => fill(unit, bytes) + "x = require; obj._load(x);", 24 * 1024)).toBeLessThan(LIMIT);
    }
    expect(growth((bytes) => fill("a ?. ", bytes) + 'require("module")._load(f);', 24 * 1024)).toBeLessThan(LIMIT);
  }, 240000);
  test("holders of the loader, index chains before .require( and cache reads in braces are read in linear time", () => {
    // A long chain of members after "= module" that is no holder, repeated assignments of holders, and spaced chains before require(.
    expect(growth((bytes) => "a = module" + fill(". parent", bytes) + ".exports; x = 1;", 24 * 1024)).toBeLessThan(LIMIT);
    expect(growth((bytes) => fill("a = module; b = a; c = b; ", bytes), 24 * 1024)).toBeLessThan(LIMIT);
    expect(growth((bytes) => "x" + fill("[0]", bytes) + ".require(p + '.js');", 24 * 1024)).toBeLessThan(LIMIT);
    expect(growth((bytes) => fill("module.children[0].parent.require(p + '.js'); ", bytes), 24 * 1024)).toBeLessThan(LIMIT);
    expect(growth((bytes) => fill("o = { e: Object.values(require.cache)[0] }; ", bytes) + "o.e.x(1);", 24 * 1024)).toBeLessThan(LIMIT);
    expect(growth((bytes) => fill("f({ a: { b: Object.values(require.cache)[0] } }); ", bytes), 24 * 1024)).toBeLessThan(LIMIT);
    expect(growth((bytes) => fill("{ ", bytes) + "x = { e: require.cache }; o.e.require(p);", 24 * 1024)).toBeLessThan(LIMIT);
  }, 240000);
  test("a cache read's owner is walked out by brace depth in linear time", () => {
    expect(growth((bytes) => "x = { " + fill("Object.values(require.cache)[0], ", bytes) + "}; y(1);", 24 * 1024)).toBeLessThan(LIMIT);
    expect(growth((bytes) => fill("z = {\n a: {},\n e: Object.values(require.cache)[0],\n};\n", bytes) + "y(1);", 24 * 1024)).toBeLessThan(LIMIT);
    expect(growth((bytes) => fill("case 1: { delete require.cache[k]; break; } ", bytes), 24 * 1024)).toBeLessThan(LIMIT);
    expect(growth((bytes) => "const o = { x: Object.values(require.cache)[0] }; const m = Object.values(require.cache)[0];\n" + fill("const k = o.length || m.length || o.size;\n", bytes) + "y(1);", 24 * 1024)).toBeLessThan(LIMIT);
    expect(growth((bytes) => fill("const o = Object.keys(require.cache).length || p;\n", bytes) + "const q = { x: Object.values(require.cache)[0] }; y(1);", 24 * 1024)).toBeLessThan(LIMIT);
    expect(growth((bytes) => "const o = Object.values(require.cache)[0];\n" + fill(" ".repeat(40) + "o;\n", bytes) + "y(1);", 24 * 1024)).toBeLessThan(LIMIT);
    expect(growth((bytes) => "const o = { x: Object.values(require.cache)[0] }; const m = Object.values(require.cache)[0];\n" + fill("if (c) { f(o) } const k = m; ", bytes) + "y(1);", 24 * 1024)).toBeLessThan(LIMIT);
    expect(growth((bytes) => "const o = { x: Object.values(require.cache)[0] };\n" + "if (c) { " + fill("f(o); {} ", bytes) + "} y(1);", 24 * 1024)).toBeLessThan(LIMIT);
    expect(growth((bytes) => "const o = Object.values(require.cache)[0];\n" + fill("const { a }" + " ".repeat(200) + "=\n" + " ".repeat(200) + "o;\n", bytes) + "y(1);", 24 * 1024)).toBeLessThan(LIMIT);
    expect(growth((bytes) => "const o = Object.values(require.cache)[0];\n" + fill("x" + "\u00A0".repeat(100) + ". o;\n", bytes) + "y(1);", 24 * 1024)).toBeLessThan(LIMIT);
    expect(growth((bytes) => "const o = { x: Object.values(require.cache)[0] }; const m = o;\n" + fill("m" + " ".repeat(30) + ". o" + " ".repeat(30) + ".\n", bytes) + "y(1);", 24 * 1024)).toBeLessThan(LIMIT);
    expect(growth((bytes) => fill("module.children?.[0] . parent ?.[1].require('./a'); ", bytes), 24 * 1024)).toBeLessThan(LIMIT);
    expect(growth((bytes) => "x" + fill("?.[0]", bytes) + ".require(p + '.js');", 24 * 1024)).toBeLessThan(LIMIT);
  }, 240000);
  test("a Function body that is not one plain string is read in linear time (a run of escaped quotes, 1 MB)", () => {
    // The scan of a 1 MB body of escaped quotes ends in well under a second (2.3 s when each quote started its own regex run).
    expect(time("new Function('p', `${a}'" + fill("\\'", 1 << 20) + "`);").took).toBeLessThan(1000);
    expect(growth((bytes) => "new Function('p', a + '" + fill("\\'", bytes) + "');", 256 * 1024)).toBeLessThan(LIMIT);
    expect(growth((bytes) => "new Function('p', a + `" + fill("\\\\\\`", bytes) + "`);", 256 * 1024)).toBeLessThan(LIMIT);
    expect(growth((bytes) => "x = { " + fill("'a', \"b\", ", bytes) + "e: Object.values(require.cache)[0] }; y(1);", 24 * 1024)).toBeLessThan(LIMIT);
    expect(growth((bytes) => fill("x = { ' ", bytes) + "e: Object.values(require.cache)[0] }; y(1);", 24 * 1024)).toBeLessThan(LIMIT);
  }, 480000);
  test("constructor names and literal bodies are read in linear time", () => {
    expect(growth((bytes) => "const AF = Object.getPrototypeOf(f).constructor; " + fill("new AF('a', 'return a\\n'); ", bytes), 24 * 1024)).toBeLessThan(LIMIT);
    expect(growth((bytes) => fill("const AF = Object.getPrototypeOf(f).constructor; ", bytes), 24 * 1024)).toBeLessThan(LIMIT);
    expect(growth((bytes) => fill("eval('1' + '\\x41'); ", bytes), 24 * 1024)).toBeLessThan(LIMIT);
  }, 240000);
  test("Function bodies given as text are read in linear time", () => {
    expect(growth((bytes) => fill("new Function('p', 'return require(\\'x\\')'); ", bytes), 24 * 1024)).toBeLessThan(LIMIT);
    expect(growth((bytes) => "Function(".repeat(Math.ceil(bytes / 40)) + "'a'" + ")".repeat(Math.ceil(bytes / 40)), 24 * 1024)).toBeLessThan(LIMIT);
  }, 240000);
  test("many names stored from require.cache", () => {
    expect(growth((bytes) => fill("const c = require.cache; const d = c; const e = d;\n", bytes), 40 * 1024)).toBeLessThan(LIMIT);
  }, 120000);
  test("repeated Object.assign({}, c.settings)", () => {
    expect(growth((n) => "const c = { settings: {} };\n" + fill("x = Object.assign({}, c.settings);\n", n), 128 * 1024)).toBeLessThan(LIMIT);
  }, 120000);
  test("nested console.log(Reflect.get(...)) is bounded, and held past the read budget", () => {
    const nest = (n: number) => "console.log(Reflect.get(".repeat(n) + "a" + "))".repeat(n);
    expect(growth((bytes) => nest(Math.ceil(bytes / 24)), 24 * 1024)).toBeLessThan(LIMIT);
    expect(classifyJs("a.js", nest(4000)).pkg).toBe(true); // far past the budget: held
    expect(classifyJs("a.js", nest(100)).pkg).toBe(false); // an ordinary nesting reads as before
  }, 120000);
  test("an unclosed require( or import( line repeated is held in full, and read in linear time", () => {
    // Tens of milliseconds when linear; a quadratic scan takes minutes at this size, so a loose bound separates them on any machine.
    const wide = { all: true, pkg: false, tests: false, flows: false, same: false, dirs: [], lits: [] };
    for (const unit of ['require("a\n', 'import("data:\n']) {
      const run = time(fill(unit, 2 * 1024 * 1024));
      expect(run.tier).toEqual(wide);
      expect(run.took).toBeLessThan(10000);
    }
  }, 120000);
  test("an unclosed load is held in the kind it was, at any size", () => {
    const wide = { all: true, pkg: false, tests: false, flows: false, same: false, dirs: [], lits: [] };
    expect(classifyJs("a.js", 'require("a\n')).toEqual(wide);
    expect(classifyJs("a.js", fill('require("a\n', 300 * 1024))).toEqual(wide); // past the size the argument index starts at
    expect(classifyJs("a.js", fill('import("data:\n', 300 * 1024))).toEqual(wide);
  });
  test("a call on another long text does not drop the file's own argument index", () => {
    const arg = Array(1200).fill("x").join("+");
    const lines = (bytes: number, layers: number) =>
      Array.from({ length: Math.ceil(bytes / (arg.length + 40 * layers)) }, (_, i) => `require(${"atob(".repeat(layers)}${arg}+v${i}${")".repeat(layers)});\n`).join("");
    expect(growth((bytes) => lines(bytes, 1), 1024 * 1024)).toBeLessThan(LIMIT);
    // Five layers of decode build five long temporary texts per line. The work of the index is counted, not timed: it stays a few times the file.
    const src = lines(2 * 1024 * 1024, 5);
    const before = argsIndexedChars();
    classifyJs("a.js", src);
    expect(argsIndexedChars() - before).toBeLessThan(10 * src.length);
  }, 120000);
  test("a long argument read once or twice is scanned, not indexed: only the file's own copies are", () => {
    const src = `require("./${"a".repeat(3000)}.js");\nrequire("./b.js");\n`;
    const before = argsIndexedChars();
    classifyJs("a.js", src);
    expect(argsIndexedChars() - before).toBeLessThanOrEqual(3 * src.length);
  });
  test("unclosed lines among long decoded arguments: the file's own reads are kept, so it is indexed once and the work stays linear", () => {
    const arg = Array(1200).fill("x").join("+");
    const mix = (bytes: number) => {
      const layer = (i: number) => `require(atob(atob(atob(atob(atob(${arg}+v${i}))))));\n`;
      let src = "";
      let i = 0;
      while (src.length < bytes) src += 'require("a\n' + layer(i++) + layer(i++);
      return src;
    };
    const src = mix(2 * 1024 * 1024);
    const before = argsIndexedChars();
    classifyJs("a.js", src);
    expect(argsIndexedChars() - before).toBeLessThan(10 * src.length);
    expect(growth(mix, 512 * 1024)).toBeLessThan(LIMIT);
  }, 120000);
  test("copies of one file that differ only at a late backtick are not compared character by character", () => {
    // Unclosed loads read the file to its end, so it is indexed; the Object.assign and setTimeout loops read other, same-length copies of it.
    const shape = (bytes: number) => 'require("a\nrequire("b\nrequire("c\n' + fill("x = Object.assign({}, c.settings);\nsetTimeout(f, 1);\n", bytes) + "var t = `tpl`;\n";
    expect(growth(shape, 256 * 1024)).toBeLessThan(LIMIT);
  }, 120000);
  test("a module-keyed Object.assign still holds after the alias read is shared", () => {
    expect(classifyJs("a.js", "const m = module;\nObject.assign({}, m);\n").pkg).toBe(true);
    expect(classifyJs("a.js", "Object.assign({}, c.settings);\n").pkg).toBe(false);
  });
});

describe("the read budget holds only what nests deeply", () => {
  const lit = "a".repeat(1_100_000);
  const free = (src: string) => {
    const t = classifyJs("a.js", src);
    expect(t.all || t.pkg || t.tests || t.flows).toBe(false);
  };
  test("one call around a large literal is not held", () => {
    free(`Object.assign({}, {x:"${lit}"});\n`);
    free(`Reflect.get(a, "${lit}");\n`);
  }, 60000);
  test("three nested Object.assign around a large literal are not held", () => {
    free(`module.exports = Object.assign({}, Object.assign({}, Object.assign({}, { x: "${lit.slice(0, 600_000)}" })));\n`);
  }, 60000);
  test("a compiled Object.freeze(Object.fromEntries(Object.entries(...))) around a large literal is not held", () => {
    free(`Object.freeze(Object.fromEntries(Object.entries({x:"${lit}"})));\n`);
  }, 60000);
  test("an 8 MB hook of plain calls is not held", () => {
    free("const c = { settings: {} };\n" + fill("x = Object.assign({}, c.settings);\n", 8 * 1024 * 1024));
  }, 120000);
});
