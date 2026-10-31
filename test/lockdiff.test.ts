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
