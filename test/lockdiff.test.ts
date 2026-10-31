import { expect, test } from "bun:test";
import { diffLocks } from "../src/lockdiff.ts";

test("a credential-only change in a source URL is surfaced and never printed", () => {
  const a = [{ name: "foo", version: "1.0.0", source: "https://alice:one@example.test/foo.tgz", integrity: "sha1-AAAA" }];
  const b = [{ name: "foo", version: "1.0.0", source: "https://bob:two@example.test/foo.tgz", integrity: "sha1-AAAA" }];
  const d = diffLocks(a, b);
  expect(d).toHaveLength(1);
  expect(d[0]!.swapped).toBeDefined();
  const shown = JSON.stringify(d);
  for (const s of ["alice", "bob", "one", "two"]) expect(shown.includes(`${s}@`) || shown.includes(`:${s}@`)).toBe(false);
  expect(shown).not.toContain("alice");
  expect(shown).not.toContain("bob");
});

test("moving text between source and digest is a change", () => {
  const a = [{ name: "foo", version: "1.0.0", source: "https://example.test/foo.tgz", digest: "S" }];
  const b = [{ name: "foo", version: "1.0.0", source: "https://example.test/foo.tgz S" }];
  expect(diffLocks(a, b)).toHaveLength(1);
});

test("a descriptor reassigned to another version is surfaced", () => {
  const a = [
    { name: "foo", version: "1.0.0", descriptors: ["foo@^1"] },
    { name: "foo", version: "1.1.0", descriptors: ["foo@~1"] },
  ];
  const b = [
    { name: "foo", version: "1.0.0", descriptors: ["foo@~1"] },
    { name: "foo", version: "1.1.0", descriptors: ["foo@^1"] },
  ];
  const d = diffLocks(a, b);
  expect(d.length).toBe(2);
  expect(d.every((c) => c.swapped)).toBe(true);
});

test("a new descriptor or unchanged descriptors are not a change", () => {
  const a = [{ name: "foo", version: "1.0.0", descriptors: ["foo@^1"] }];
  expect(diffLocks(a, [{ name: "foo", version: "1.0.0", descriptors: ["foo@^1", "foo@~1"] }])).toEqual([]);
  expect(diffLocks(a, a)).toEqual([]);
});

test("a descriptor moved between same name@version entries from different origins is surfaced", () => {
  const good = { name: "foo", version: "1.0.0", source: "https://good.test/foo" };
  const evil = { name: "foo", version: "1.0.0", source: "https://evil.test/foo" };
  const before = [{ ...good, descriptors: ["foo@^1"] }, { ...evil, descriptors: ["foo@~1"] }];
  const swapped = [{ ...good, descriptors: ["foo@~1"] }, { ...evil, descriptors: ["foo@^1"] }];
  const d = diffLocks(before, swapped);
  expect(d.length).toBe(2);
  expect(d.every((c) => c.swapped)).toBe(true);
  expect(JSON.stringify(d)).toContain("evil.test");
  const allEvil = [{ ...evil, descriptors: ["foo@^1", "foo@~1"] }, { ...good, descriptors: [] }];
  expect(diffLocks(before, allEvil).some((c) => c.swapped)).toBe(true);
});
