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
