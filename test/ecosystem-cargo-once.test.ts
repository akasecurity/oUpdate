import { describe, expect, test } from "bun:test";
import { ecosystemSignals } from "../src/ecosystem-signals.ts";
import type { FileMap } from "../src/prepass.ts";

const enc = new TextEncoder();
const files = (o: Record<string, string>): FileMap => new Map(Object.entries(o).map(([k, v]) => [k, enc.encode(v)]));
const sigs = (o: Record<string, string>, n: Record<string, string>) => ecosystemSignals(files(o), files(n)).map((s) => `${s.kind} ${s.path}`);

// A tail the TOML parser refuses, so the line reader is the one that reads the manifest.
const REFUSED = "broken = [\n";
const OLD = { "Cargo.toml": '[package]\nname = "x"\n' };
const refused = (toml: string) => {
  expect(() => Bun.TOML.parse(toml)).toThrow();
  return toml;
};

/** A list-form manifest the parser refuses: the listed script a.rs must be raised as new. */
const heldList = (toml: string) => {
  const out = sigs(OLD, { "Cargo.toml": refused(toml + REFUSED), "a.rs": "1" });
  expect(out).toContain("rust-build-script-added a.rs");
  expect(out).toContain("rust-build-script-added Cargo.toml");
};
/** The same manifest without the refused tail: the parser reads it, and must give the same answer. */
const parserAgrees = (toml: string) => {
  const out = sigs(OLD, { "Cargo.toml": toml, "a.rs": "1" });
  expect(out).toContain("rust-build-script-added a.rs");
};
/** A string-form manifest the parser refuses: gen.rs must be raised as a new custom build script. */
const heldKey = (toml: string) => {
  expect(sigs(OLD, { "Cargo.toml": refused(toml + REFUSED), "gen.rs": "1" })).toEqual(["rust-build-script-added gen.rs"]);
  expect(sigs(OLD, { "Cargo.toml": toml, "gen.rs": "1" })).toEqual(["rust-build-script-added gen.rs"]);
};

describe("a list-form build key the line reader reads", () => {
  test("a quoted key", () => {
    heldList('[package]\n"build" = ["a.rs"]\n');
    parserAgrees('[package]\n"build" = ["a.rs"]\n');
    heldList("[package]\n'build' = [\"a.rs\"]\n");
  });
  test("a dotted key at the top, and an inline package table", () => {
    heldList('package.name = "x"\npackage.build = ["a.rs"]\n');
    parserAgrees('package.name = "x"\npackage.build = ["a.rs"]\n');
    heldList('package = { name = "x", build = ["a.rs"] }\n');
    parserAgrees('package = { name = "x", build = ["a.rs"] }\n');
  });
  test("a section line with a comment, no space before it, or spaces or quotes inside the brackets", () => {
    heldList('[package]#note\nbuild = ["a.rs"]\n');
    heldList('[ package ] # note\nbuild = ["a.rs"]\n');
    heldList('["package"]\nbuild = ["a.rs"]\n');
    heldList('[ "package" ]\nbuild = ["a.rs"]\n');
  });
  test("escapes are decoded, and a multi-line string entry is read whole", () => {
    heldList('[package]\nbuild = ["\\u0061.rs"]\n');
    parserAgrees('[package]\nbuild = ["\\u0061.rs"]\n');
    heldList('[package]\nbuild = ["""a.rs"""]\n');
    heldList("[package]\nbuild = ['''a.rs''']\n");
    heldList('[package]\nbuild = [\n"""\na.rs"""]\n');
  });
  test("comments, entries beside the closing bracket, no spaces, CRLF, and a bracket or hash inside a string", () => {
    heldList('[package]\nbuild = [\n  "x.rs", # first\n  # "no.rs",\n  "a.rs"]\n');
    heldList('[package]\nbuild=["a.rs"]\n');
    heldList('[package]\r\nbuild = [\r\n  "a.rs",\r\n]\r\n');
    expect(sigs(OLD, { "Cargo.toml": refused('[package]\nbuild = ["x].rs", "a.rs"]\n' + REFUSED), "a.rs": "1" })).toContain("rust-build-script-added a.rs");
    expect(sigs(OLD, { "Cargo.toml": refused('[package]\nbuild = ["x#.rs", "a.rs"]\n' + REFUSED), "a.rs": "1" })).toContain("rust-build-script-added a.rs");
  });
  test("quiet: a list under another table, in a string, or in a commented line raises nothing", () => {
    for (const toml of [
      '[package]\nname = "x"\n[package.metadata]\nbuild = ["a.rs"]\n',
      '[dependencies]\nbuild = ["a.rs"]\n',
      '[package]\nname = "x"\n[[bin]]\nname = "t"\nbuild = ["a.rs"]\n',
      '[package]\ndescription = """\n[package]\nbuild = ["a.rs"]\n"""\n',
      '[package]\n# build = ["a.rs"]\n',
      '[package]\nbuild = []\n',
    ]) {
      expect(sigs(OLD, { "Cargo.toml": refused(toml + REFUSED), "a.rs": "1" }), toml).toEqual([]);
      expect(sigs(OLD, { "Cargo.toml": toml, "a.rs": "1" }), toml).toEqual([]);
    }
  });
  test("an array the file never closes ends at the next key or table, so later strings are no entries", () => {
    for (const toml of [
      '[package]\nbuild = ["a.rs"\nreadme = "README.md"\n[dependencies]\n',
      '[package]\nbuild = ["a.rs"\n"readme" = "README.md"\ninclude = ["README.md"]\n',
      '[package]\nbuild = ["a.rs",\n[dependencies]\nx = ["README.md"]\n',
    ]) {
      const out = sigs(OLD, { "Cargo.toml": refused(toml + REFUSED), "a.rs": "1", "README.md": "1" });
      expect(out, toml).toContain("rust-build-script-added a.rs");
      expect(out, toml).not.toContain("rust-build-script-added README.md");
    }
  });
});

describe("a string-form build key the line reader reads", () => {
  test("a quoted key, a dotted key, an inline package table, a section comment", () => {
    heldKey('[package]\n"build" = "gen.rs"\n');
    heldKey("[package]\n'build' = 'gen.rs'\n");
    heldKey('package.name = "x"\npackage.build = "gen.rs"\n');
    heldKey('package = { name = "x", build = "gen.rs" }\n');
    heldKey('[package]#note\nbuild = "gen.rs"\n');
    heldKey('[ package ] # note\nbuild = "gen.rs"\n');
  });
  test("a hash after a space inside the string is part of the name", () => {
    expect(sigs(OLD, { "Cargo.toml": refused('[package]\nbuild = "g #.rs"\n' + REFUSED), "g #.rs": "1" })).toEqual(["rust-build-script-added g #.rs"]);
  });
  test("an array-of-tables header ends [package]", () => {
    const toml = '[package]\nname = "x"\n[[bin]]\nname = "t"\nbuild = "gen.rs"\n' + REFUSED;
    expect(sigs(OLD, { "Cargo.toml": refused(toml), "gen.rs": "1" })).toEqual([]);
  });
});

const counting = <T>(f: () => T) => {
  const real = Bun.TOML.parse;
  let n = 0;
  (Bun.TOML as { parse: typeof real }).parse = (s: Parameters<typeof real>[0]) => {
    n++;
    return real(s);
  };
  try {
    return { value: f(), parses: n };
  } finally {
    (Bun.TOML as { parse: typeof real }).parse = real;
  }
};

// More than 4096 `[` and `=` marks send a manifest to the line reader without the parser being tried. Comment lines carry
// the marks and cost the reader nothing, so a manifest followed by them is read by the line reader.
const PAD = "# [ = ]\n".repeat(5000);
const P = '[package]\nname = "x"\n';

/** What a valid manifest raises on each way it can be read: by the parser as written, by the line reader after the parser
 * refuses a tail, and by the line reader because of the pad. All three must raise the same, which is returned. */
const threeWays = (toml: string, extra: Record<string, string>, old: Record<string, string> = OLD) => {
  expect(() => Bun.TOML.parse(toml)).not.toThrow();
  expect(() => Bun.TOML.parse(toml + REFUSED)).toThrow();
  const run = (t: string) => sigs(old, { "Cargo.toml": t, ...extra }).sort();
  const parsed = run(toml);
  expect(run(toml + REFUSED), "line reader, refused").toEqual(parsed);
  expect(run(toml + PAD), "line reader, padded").toEqual(parsed);
  expect(run(PAD + toml), "line reader, padded first").toEqual(parsed);
  return parsed;
};
const GEN = ["rust-build-script-added gen.rs"];
const LIST = ["rust-build-script-added Cargo.toml", "rust-build-script-added a.rs"];

describe("a line inside an array, inline table or multi-line string is no table header", () => {
  const nested = ['[["a"]]', '["linux", "x86_64"]', '[ ["a", "b"], ["c"] ]', '["a"]'];
  test("an array of arrays before the build key", () => {
    for (const n of nested) {
      expect(threeWays(P + `kw = [\n  ${n}\n]\nbuild = "gen.rs"\n`, { "gen.rs": "1" }), n).toEqual(GEN);
      expect(threeWays(P + `kw = [\n  ${n}\n]\nbuild = ["a.rs"]\n`, { "a.rs": "1" }), n).toEqual(LIST);
    }
  });
  test("a table-header-looking array line under another table does not make [package] of it", () => {
    for (const n of ['["package"]', '[["package"]]', '[ "package" ]']) {
      expect(threeWays(`[x]\nkw = [\n  ${n}\n]\nbuild = "gen.rs"\n`, { "gen.rs": "1" }), n).toEqual([]);
      expect(threeWays(`[x]\nkw = [\n  ${n}\n]\nbuild = ["a.rs"]\n`, { "a.rs": "1" }), n).toEqual([]);
    }
  });
  test("a key, a header and a build line inside a multi-line string or a multi-line inline table", () => {
    expect(threeWays(P + 'd = """\n[other]\nbuild = "no.rs"\n"""\nbuild = "gen.rs"\n', { "gen.rs": "1", "no.rs": "1" })).toEqual(GEN);
    expect(threeWays(P + "d = '''\n[[bin]]\n'''\nbuild = [\"a.rs\"]\n", { "a.rs": "1" })).toEqual(LIST);
    expect(threeWays(P + 'm = {\n  a = [\n    ["x"],\n    ["y"]\n  ],\n  b = { c = [[1]] }\n}\nbuild = "gen.rs"\n', { "gen.rs": "1" })).toEqual(GEN);
    expect(threeWays(P + 'k = [\n  {\n    a = 1,\n    b = [\n      2\n    ]\n  },\n]\nbuild = ["a.rs"]\n', { "a.rs": "1" })).toEqual(LIST);
  });
  test("an array the file never closes still ends at the next key or table", () => {
    const toml = P + 'build = ["a.rs",\n["x"]\n[dependencies]\nx = ["README.md"]\n';
    const out = sigs(OLD, { "Cargo.toml": toml, "a.rs": "1", "README.md": "1" });
    expect(out).toContain("rust-build-script-added a.rs");
    expect(out).not.toContain("rust-build-script-added README.md");
  });
});

describe("a build value that spans lines is read as the parser reads it", () => {
  test("a multi-line basic or literal string, one-line triple quotes and a line-ending backslash", () => {
    for (const v of ['"""\ngen.rs"""', "'''\ngen.rs'''", '"""gen.rs"""', "'''gen.rs'''", '"""gen\\\n   .rs"""', '"""\r\ngen.rs"""']) {
      expect(threeWays(P + `build = ${v}\n`, { "gen.rs": "1" }), v).toEqual(GEN);
    }
  });
  test("a multi-line inline package table, with a string or a multi-line list", () => {
    expect(threeWays('package = {\n  name = "x",\n  build = "gen.rs"\n}\n', { "gen.rs": "1" })).toEqual(GEN);
    expect(threeWays('package = {\n  name = "x",\n  build = """\ngen.rs"""\n}\n', { "gen.rs": "1" })).toEqual(GEN);
    expect(threeWays('package = {\n  name = "x",\n  build = [\n    "a.rs", # first\n    "b.rs",\n  ]\n}\n', { "a.rs": "1" })).toEqual(LIST);
    expect(threeWays('package = { name = "x", build = [\n  "a.rs"\n] }\n', { "a.rs": "1" })).toEqual(LIST);
  });
  test("the same manifest raises the same at 4096 marks (the parser reads it) and at 4097 (the line reader does)", () => {
    const toml = P + 'build = """\ngen.rs"""\n';
    const marks = (t: string) => (t.match(/[=[]/g) ?? []).length;
    // Marks inside comments and strings count too: the pad is one comment line of equals signs.
    const to = (n: number) => toml + "#" + "=".repeat(n - marks(toml)) + "\n";
    for (const n of [4095, 4096, 4097, 4098]) {
      const padded = to(n);
      expect(marks(padded)).toBe(n);
      const r = counting(() => sigs(OLD, { "Cargo.toml": padded, "gen.rs": "1" }));
      expect(r.value, String(n)).toEqual(GEN);
      expect(r.parses, String(n)).toBe(n <= 4096 ? 2 : 1); // the old manifest, and this one when it has few enough marks
    }
  });
});

describe("an entry of a nested inline table does not move the start of the outer build value", () => {
  const G = ["rust-build-script-added Cargo.toml", "rust-build-script-added g.rs"];
  test("a nested inline table after the list keeps the list whole", () => {
    expect(threeWays('package = { name="x", build=["g.rs", {x=1}] }\n', { "g.rs": "1" })).toEqual(G);
  });
  test("a table or list inside a build table is no build key", () => {
    expect(threeWays('package = { name="x", build = { k = ["gen.rs"] } }\n', { "gen.rs": "1" })).toEqual([]);
    expect(threeWays('package = { name="x", build = [{ k = ["gen.rs"] }] }\n', { "gen.rs": "1" })).toEqual([]);
  });
});

describe("a bare key of any length is read whole, and the value after it is skipped whole", () => {
  const x = (n: number) => "x".repeat(n);
  const NL = (t: string) => [t, t.replace(/\n/g, "\r\n")];
  for (const len of [255, 256, 257, 300, 5000, 200_000]) {
    test(`a ${len}-character key before a multi-line string that holds a header: the build key after it is kept`, () => {
      for (const t of NL(P + `version = "0.1.0"\nmetadata.${x(len)} = """\n[other]\n"""\nbuild = "gen.rs"\n`)) {
        expect(threeWays(t, { "gen.rs": "1" }), String(len)).toEqual(GEN);
      }
    });
    test(`a ${len}-character key before a multi-line string that holds a [package] build line raises nothing`, () => {
      for (const t of NL(P + `version = "0.1.0"\n[package.metadata]\n${x(len)} = """\n[package]\nbuild = "gen.rs"\n"""\n`)) {
        expect(threeWays(t, { "gen.rs": "1" }), String(len)).toEqual([]);
      }
    });
    test(`a ${len}-character key in an inline package table, before a string holding a brace: the build key after it is kept`, () => {
      for (const t of NL(`package = { name = "x", ${x(len)} = "}", build = "gen.rs" }\n`)) {
        expect(threeWays(t, { "gen.rs": "1" }), String(len)).toEqual(GEN);
      }
    });
  }
  test("the same at exactly 4096 and 4097 marks", () => {
    const toml = P + `metadata.${x(300)} = """\n[other]\n"""\nbuild = "gen.rs"\n`;
    const marks = (t: string) => (t.match(/[=[]/g) ?? []).length;
    for (const n of [4096, 4097]) {
      const padded = toml + "#" + "=".repeat(n - marks(toml)) + "\n";
      expect(sigs(OLD, { "Cargo.toml": padded, "gen.rs": "1" }), String(n)).toEqual(GEN);
    }
  });
});

describe("a manifest the parser refuses and the file never closes (narrowings; Cargo refuses both, so no script runs)", () => {
  test("an inline table never closed hides a later build key, as does a multi-line string never closed", () => {
    for (const toml of ['[package]\nmeta = {a=1,\nbuild = "gen.rs"\n', '[package]\ndescription = """oops\nbuild = "gen.rs"\n']) {
      expect(() => Bun.TOML.parse(toml)).toThrow();
      expect(sigs(OLD, { "Cargo.toml": toml, "gen.rs": "1" }), toml).toEqual([]);
    }
  });
});

describe("a list entry with escapes is read as its decoded text on every route", () => {
  const files = { "gen.rs": "1", "g\\u0065n.rs": "1" };
  test("the file literally named with the escape raises nothing of its own", () => {
    const toml = P + 'build = ["g\\u0065n.rs"]\n';
    const way = (t: string) => sigs(OLD, { "Cargo.toml": t, ...files }).sort();
    const want = ["rust-build-script-added Cargo.toml", "rust-build-script-added gen.rs"];
    expect(way(toml)).toEqual(want);
    expect(way(toml + REFUSED)).toEqual(want);
    expect(way(toml + PAD)).toEqual(want);
  });
  test("a manifest that moves between the parser and the line reader between versions raises nothing", () => {
    const toml = P + 'build = ["g\\u0065n.rs", "src\\\\a.rs"]\n';
    const f = { "gen.rs": "1", "src\\a.rs": "1" };
    const same = (a: string, b: string) => expect(sigs({ "Cargo.toml": a, ...f }, { "Cargo.toml": b, ...f })).toEqual([]);
    same(toml, toml + PAD);
    same(toml + PAD, toml);
    same(toml + REFUSED, toml);
  });
});

describe("a refused list reads the whitespace and tokens main read", () => {
  test("a no-break space, form feed, vertical tab or line separator between entries", () => {
    for (const w of ["\u00a0", "\f", "\v", "\u2028", "\u3000"]) {
      const out = sigs(OLD, { "Cargo.toml": refused(P + `build = ["a.rs",${w}"b.rs"]\n` + REFUSED), "a.rs": "1", "b.rs": "1" });
      expect(out, JSON.stringify(w)).toContain("rust-build-script-added a.rs");
      expect(out, JSON.stringify(w)).toContain("rust-build-script-added b.rs");
    }
  });
  test("an inline table entry before an entry", () => {
    const out = sigs(OLD, { "Cargo.toml": refused(P + 'build = [{ p = 1 }, "b.rs"]\n' + REFUSED), "b.rs": "1" });
    expect(out).toContain("rust-build-script-added b.rs");
  });
  test("a no-break space before the equals sign of the build key", () => {
    expect(sigs(OLD, { "Cargo.toml": refused(P + 'build\u00a0= "gen.rs"\n' + REFUSED), "gen.rs": "1" })).toEqual(GEN);
  });
});

describe("each manifest text is read once", () => {
  const manifests = (n: number, same: boolean) => {
    const o: Record<string, string> = {};
    const w: Record<string, string> = {};
    for (let i = 0; i < n; i++) {
      const tag = same ? "" : String(i);
      o[`c${i}/Cargo.toml`] = `[package]\nname = "c${tag}"\nbuild = "g.rs"\n`;
      w[`c${i}/Cargo.toml`] = `[package]\nname = "c${tag}"\nbuild = ["g.rs", "h.rs"]\n`;
      o[`c${i}/g.rs`] = "1";
      w[`c${i}/g.rs`] = "2";
      w[`c${i}/h.rs`] = "3";
    }
    return [files(o), files(w)] as const;
  };

  test("a manifest read for the key and again for the list is decoded once per side: the per-path cache is used", () => {
    const o = files({ "Cargo.toml": '[package]\nname = "x"\nbuild = "g.rs"\n', "g.rs": "1" });
    const w = files({ "Cargo.toml": '[package]\nname = "x"\nbuild = ["g.rs", "h.rs"]\n', "g.rs": "2", "h.rs": "3" });
    const real = TextDecoder.prototype.decode;
    let decodes = 0;
    TextDecoder.prototype.decode = function (this: TextDecoder, ...a: Parameters<typeof real>) {
      const r = real.apply(this, a);
      if (r.startsWith("[package]")) decodes++;
      return r;
    };
    try {
      expect(ecosystemSignals(o, w).length).toBe(3);
    } finally {
      TextDecoder.prototype.decode = real;
    }
    expect(decodes).toBe(2);
  });
  test("one parse per manifest per side, however many questions are asked of it", () => {
    const [o, w] = manifests(50, false);
    const r = counting(() => ecosystemSignals(o, w));
    expect(r.parses).toBe(100);
    expect(r.value.length).toBe(150);
  });
  test("the same manifest text under many paths is parsed once per side", () => {
    const [o, w] = manifests(50, true);
    const r = counting(() => ecosystemSignals(o, w));
    expect(r.parses).toBe(2);
    expect(r.value.length).toBe(150);
    expect(new Set(r.value.map((s) => s.kind))).toEqual(new Set(["rust-build-script-added", "rust-build-script-changed"]));
  });
  test("a manifest the parser refuses is parsed once, and the line reader still answers", () => {
    const o = files({ "Cargo.toml": '[package]\nbuild = "g.rs"\n' + REFUSED, "g.rs": "1" });
    const w = files({ "Cargo.toml": '[package]\nbuild = ["g.rs", "h.rs"]\n' + REFUSED, "g.rs": "2", "h.rs": "3" });
    const r = counting(() => ecosystemSignals(o, w));
    expect(r.parses).toBe(2);
    expect(r.value.map((s) => s.path).sort()).toEqual(["Cargo.toml", "g.rs", "h.rs"]);
  });
  test("a manifest with very many keys and tables goes to the line reader without a parse, and gives the same answer", () => {
    const head = '[package]\nname = "x"\nbuild = ["a.rs"]\n';
    const many = head + Array.from({ length: 3000 }, (_, i) => `[dependencies.d${i}]\nversion = "1"\n`).join("");
    const r = counting(() => sigs(OLD, { "Cargo.toml": many, "a.rs": "1" }));
    expect(r.parses).toBe(1); // the old manifest only
    expect(r.value.sort()).toEqual(sigs(OLD, { "Cargo.toml": head, "a.rs": "1" }).sort());
    expect(r.value.length).toBe(2);
  });
  test("a big manifest that is cheap for the parser (comments, one long string or list) is still parsed, over 64 KB too", () => {
    const head = '[package]\nname = "x"\nbuild = ["a.rs"]\n';
    const shapes = [head + "# padding that makes this manifest big\n".repeat(4000), head + 'long = "' + "x".repeat(300_000) + '"\n', head + "l = [" + '"x", '.repeat(100_000) + "]\n"];
    for (const toml of shapes) {
      expect(toml.length).toBeGreaterThan(64 * 1024);
      const r = counting(() => sigs(OLD, { "Cargo.toml": toml, "a.rs": "1" }));
      expect(r.parses).toBe(2); // the old manifest and this one
      expect(r.value.sort()).toEqual(sigs(OLD, { "Cargo.toml": head, "a.rs": "1" }).sort());
    }
  });
});

describe("cost stays linear in the size of the manifests", () => {
  const best = (f: () => unknown, runs = 3) => {
    let m = Infinity;
    for (let i = 0; i < runs; i++) {
      const t = performance.now();
      f();
      m = Math.min(m, performance.now() - t);
    }
    return m;
  };
  /** One manifest of many small tables (the shape whose TOML parse time grows with the square of the table count). */
  const bigManifest = (bytes: number) => {
    const body = '[package]\nname = "x"\nbuild = ["a.rs", "b.rs"]\n' + Array.from({ length: Math.floor(bytes / 36) }, (_, i) => `[dependencies.d${i}]\nversion = "1"\n`).join("");
    return [files({ "Cargo.toml": '[package]\nname = "x"\nbuild = "g.rs"\n', "g.rs": "1" }), files({ "Cargo.toml": body, "a.rs": "1", "b.rs": "2" })] as const;
  };
  const many = (bytes: number) => {
    const o: Record<string, string> = {};
    const w: Record<string, string> = {};
    for (let i = 0; i < Math.floor(bytes / 90); i++) {
      // Each manifest's text differs, so none is answered from the cache of another.
      o[`c${i}/Cargo.toml`] = `[package]\nname = "c${i}"\nbuild = "g.rs"\n`;
      w[`c${i}/Cargo.toml`] = `[package]\nname = "c${i}"\nbuild = ["g.rs", "h.rs"]\n`;
      o[`c${i}/g.rs`] = "1";
      w[`c${i}/g.rs`] = "2";
      w[`c${i}/h.rs`] = "3";
    }
    return [files(o), files(w)] as const;
  };
  const MB = 1024 * 1024;

  test("one manifest of many tables: four times the size takes about four times as long, not sixteen", () => {
    // The parser alone takes 0.9 s at 512 KB and 15 s at 2 MB of this shape; the line reader takes a few milliseconds.
    // No floor under the first time: a quadratic reader at 1 ms then 16 ms fails the ratio.
    const [o1, w1] = bigManifest(MB / 2);
    const [o2, w2] = bigManifest(2 * MB);
    const t1 = best(() => ecosystemSignals(o1, w1));
    const t2 = best(() => ecosystemSignals(o2, w2));
    const label = `${t1.toFixed(1)} -> ${t2.toFixed(1)} ms`;
    expect(t2 / Math.max(t1, 0.1), label).toBeLessThan(8);
    expect(t2, label).toBeLessThan(500);
  });
  test("a manifest near the size cap is read in a fraction of a second", () => {
    const [o, w] = bigManifest(4.7 * MB);
    const ms = best(() => ecosystemSignals(o, w), 1);
    expect(ms, `${ms.toFixed(0)} ms`).toBeLessThan(1500);
  });
  test("a big manifest the parser reads quickly is parsed in linear time", () => {
    const head = '[package]\nname = "x"\nbuild = ["a.rs"]\n';
    const of = (n: number) => files({ "Cargo.toml": head + "# padding that makes this manifest big\n".repeat(n), "a.rs": "1" });
    const t = best(() => ecosystemSignals(files(OLD), of(120_000)), 2); // 4.6 MB
    expect(t, `${t.toFixed(0)} ms`).toBeLessThan(500);
  });
  test("the line reader reads a long line, many headers, and unterminated strings in one pass", () => {
    const rep = (s: string, bytes: number) => s.repeat(Math.ceil(bytes / s.length));
    const K = 256 * 1024;
    const shapes: Record<string, string> = {
      "one long list line": '[package]\nbuild = ["a.rs",' + ' "x",'.repeat(200_000) + "]\n",
      "many headers": '[package]\nbuild = ["a.rs"]\n' + "[a]\n".repeat(250_000),
      "unterminated strings": "[package]\nbuild = [\n" + '"abc\n'.repeat(200_000),
      "multi-line string openers": "[package]\nbuild = [\n" + "'''\n\"\"\"\n".repeat(100_000),
      // Each opener after the first has no closer: a reader that searches to the end of the text for each is quadratic.
      "unclosed basic triple quotes behind a backslash, in a list": "[package]\nbuild = [\n" + rep('\\"""\n', K),
      "unclosed basic triple quotes, in a list": "[package]\nbuild = [\n" + rep('"""x\n', K),
      "unclosed literal triple quotes behind a backslash, in a list": "[package]\nbuild = [\n" + rep("\\'''\n", K),
      "unclosed basic triple quotes behind a backslash, after a string build": '[package]\nbuild = "a.rs"\n' + rep('\\"""\n', K),
      "unclosed triple quotes as keys": '[package]\nbuild = "a.rs"\n' + rep('"""k\n', K),
      "unclosed literal triple quotes as keys": "[package]\n" + rep("'''k\n", K),
      "a list that opens at every line": "[package]\nbuild = [\n" + rep("[\n", K),
      "inline tables that open at every line": "[package]\nbuild = [\n" + rep("{a=\n", K),
      "keys inside an array never closed": "[package]\nbuild = [\n" + rep('a = "b"\n', K),
      "very deep nesting": "[package]\nx = " + "[".repeat(K),
    };
    for (const [label, toml] of Object.entries(shapes)) {
      const [o, w] = [files(OLD), files({ "Cargo.toml": toml + REFUSED, "a.rs": "1" })];
      const ms = best(() => ecosystemSignals(o, w), 1);
      expect(ms, `${label}: ${ms.toFixed(0)} ms`).toBeLessThan(1500);
    }
  });
  test("one deeply dotted table header followed by many keys: four times the size takes about four times as long, not sixteen", () => {
    const of = (parts: number, keys: number) =>
      [files(OLD), files({ "Cargo.toml": '[package]\nname = "x"\nbuild = "gen.rs"\n[' + "a.".repeat(parts) + "a]\n" + "b=1\n".repeat(keys) + PAD, "gen.rs": "1" })] as const;
    const [o1, w1] = of(25_000, 1500);
    const [o2, w2] = of(100_000, 6000);
    expect(sigs(OLD, { "Cargo.toml": '[package]\nbuild = "gen.rs"\n[' + "a.".repeat(1000) + "a]\n" + "b=1\n".repeat(5000), "gen.rs": "1" })).toEqual(GEN);
    const t1 = best(() => ecosystemSignals(o1, w1));
    const t2 = best(() => ecosystemSignals(o2, w2));
    const label = `${t1.toFixed(1)} -> ${t2.toFixed(1)} ms`;
    expect(t2 / Math.max(t1, 0.1), label).toBeLessThan(8);
    expect(t2, label).toBeLessThan(500);
  });
  test("many small manifests: four times the count takes about four times as long, not sixteen", () => {
    const [o1, w1] = many(MB);
    const [o2, w2] = many(4 * MB);
    const t1 = best(() => ecosystemSignals(o1, w1));
    const t2 = best(() => ecosystemSignals(o2, w2));
    const label = `${t1.toFixed(0)} -> ${t2.toFixed(0)} ms`;
    expect(t2 / Math.max(t1, 0.1), label).toBeLessThan(8);
    expect(t2, label).toBeLessThan(6000);
  });
});
