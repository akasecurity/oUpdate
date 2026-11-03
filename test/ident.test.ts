import { expect, test } from "bun:test";
import { badName, badVersion, inert, shown } from "../src/ident.ts";

test("npm names: scoped and plain registry names pass; markup, spaces, newlines and uppercase-scope tricks do not", () => {
  for (const ok of ["lodash", "@scope/pkg", "a.b_c-d", "@a/b.c", "~tilde"]) expect(badName("npm", ok)).toBeUndefined();
  for (const bad of ["", "a b", "a`b", "a\nb", "a](http://x)", "<!-- x -->", "@scope", "@/x", "a/b", "../x", "-a", ".a", "x".repeat(215)]) expect(badName("npm", bad)).toMatch(/not a valid npm name/);
});

test("pypi names follow PEP 503: alphanumerics joined by . _ -", () => {
  for (const ok of ["requests", "Django", "zope.interface", "a_b-c", "a"]) expect(badName("pypi", ok)).toBeUndefined();
  for (const bad of ["", "-a", "a-", "a b", "a`b", "@scope/x", "a\nb", "a[extra]"]) expect(badName("pypi", bad)).toMatch(/not a valid pypi name/);
});

test("versions: semver and PEP 440 shapes pass; anything with markup or whitespace does not", () => {
  for (const ok of ["1.0.0", "1.0.0-beta.1+build.5", "2024.1.1", "1!2.0.post1+local", "1.0rc1"]) expect(badVersion(ok)).toBeUndefined();
  for (const bad of ["", "1.0 0", "1.0.0`", "1.0.0\nIgnore", "1.0.0](x)", "git+https://x/y.git", "<1.0", "1.0.0 ".repeat(30)]) expect(badVersion(bad)).toMatch(/has characters no registry version has/);
});

test("shown escapes what could break out of markdown or a prompt line, and cuts long text", () => {
  expect(shown("@scope/pkg-1.0.0+b")).toBe("@scope/pkg-1.0.0+b");
  const out = shown("evil`](http://x)\n<!-- y -->\u0000");
  expect(out).not.toMatch(/[`\[\]()<>\n\0]/);
  expect(out).toContain("\\u{60}");
  expect(shown("x".repeat(500)).length).toBeLessThan(110);
  expect(shown(undefined)).toBe("");
});

test("length limits: PyPI names have none, npm names stop at 214, versions at a generous 256", () => {
  expect(badName("pypi", `a${"b".repeat(149)}`)).toBeUndefined();
  expect(badName("npm", "n".repeat(214))).toBeUndefined();
  expect(badName("npm", "n".repeat(215))).toMatch(/not a valid npm name/);
  expect(badVersion(`1.0.0+${"build.".repeat(30)}x`)).toBeUndefined();
  expect(badVersion(`1.0.0+${"a".repeat(260)}`)).toMatch(/has characters no registry version has/);
});

test("inert writes the characters that open links, code, tags and comments as escapes and keeps prose", () => {
  const out = inert("see [x](http://evil.example) `a` <b> <!-- c --> \u0001 (ok; fine)");
  expect(out).not.toMatch(/[`[\]<>\u0001]/);
  expect(out).toContain("(ok; fine)");
  expect(out).toContain("\\u{5b}x\\u{5d}(http://evil.example)");
});

test("inert writes every invisible or reordering character as an escape, and keeps ASCII prose and spaces", () => {
  const one = (cp: number) => { const out = inert(`a${String.fromCodePoint(cp)}b`); expect(out, cp.toString(16)).toBe(`a\\u{${cp.toString(16)}}b`); };
  // C1, bidi, zero-width, soft hyphen, Arabic letter mark, Mongolian vowel separator, deprecated format, specials, line/paragraph separators, a tag character
  for (const cp of [0x85, 0x202e, 0x200b, 0x2066, 0xfeff, 0x2060, 0xad, 0x61c, 0x180e, 0x206a, 0xfff9, 0x2028, 0x2029, 0xe0041]) one(cp);
  // variation selectors, grapheme joiner, Hangul fillers, braille blank, non-ASCII spaces, backslash
  for (const cp of [0xfe0f, 0xe0100, 0x34f, 0x115f, 0x1160, 0x3164, 0xffa0, 0x2800, 0xa0, 0x200a, 0x3000, 0x5c]) one(cp);
  expect(inert("a b (ok; fine) \u00e9 \u4e2d")).toBe("a b (ok; fine) \u00e9 \u4e2d");
});

test("inert escapes every default-ignorable code point, found at runtime so the file holds no raw characters", () => {
  const ignorable = /^\p{Default_Ignorable_Code_Point}$/u;
  let n = 0;
  for (let cp = 0; cp <= 0x10ffff; cp++) {
    if (cp >= 0xd800 && cp <= 0xdfff) continue;
    if (!ignorable.test(String.fromCodePoint(cp))) continue;
    n++;
    expect(inert(`a${String.fromCodePoint(cp)}b`)).toBe(`a\\u{${cp.toString(16)}}b`);
  }
  expect(n).toBeGreaterThan(300); // the property covers the Mongolian selectors, Khmer vowels and the hidden unassigned ranges too
});

test("inert escapes a lone surrogate, a private-use and an unassigned code point", () => {
  for (const [cp, ch] of [[0xd800, String.fromCharCode(0xd800)], [0xdfff, String.fromCharCode(0xdfff)], [0xe000, String.fromCodePoint(0xe000)], [0xf8ff, String.fromCodePoint(0xf8ff)], [0x10ffff, String.fromCodePoint(0x10ffff)], [0x378, String.fromCodePoint(0x378)], [0xffff, String.fromCodePoint(0xffff)]] as [number, string][])
    expect(inert(`a${ch}b`), cp.toString(16)).toBe(`a\\u{${cp.toString(16)}}b`);
  expect(inert("a\u{1f600}b")).toBe("a\u{1f600}b"); // an assigned emoji stays
});
