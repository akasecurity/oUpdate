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

test("a direct git or url dependency's source, from and to never carry credentials", () => {
  const src = "git+https://dave:tok2@example.test/foo.git#b";
  const old = { name: "foo", version: "1.0.0", integrity: "sha1-AAAA" };
  for (const direct of ["git", "url"] as const) {
    const added = diffLocks([old], [{ name: "foo", version: src, source: src, direct }]);
    expect(added).toHaveLength(1);
    expect(added[0]!.source).toBe("git+https://example.test/foo.git#b");
    expect(JSON.stringify(added)).not.toContain("tok2");
    expect(JSON.stringify(added)).not.toContain("dave");
    const swap = diffLocks([{ name: "foo", version: "1.0.0", source: "https://x.test/f" }], [{ name: "foo", version: "1.0.0", source: src, direct }]);
    expect(swap).toHaveLength(1);
    expect(swap[0]!.source).toBe("git+https://example.test/foo.git#b");
    expect(JSON.stringify(swap)).not.toContain("tok2");
    const moved = diffLocks([{ name: "foo", version: src, source: src, direct }], [{ name: "foo", version: "git+https://dave:tok3@example.test/foo.git#c", source: "git+https://dave:tok3@example.test/foo.git#c", direct }]);
    expect(JSON.stringify(moved)).not.toMatch(/tok[23]|dave/);
  }
});

test("credentials with an @ inside or a second URL in the source are fully masked", () => {
  const a = [{ name: "foo", version: "1.0.0", source: "git+https://carol:p@ss1@example.test/foo.git#x", integrity: "sha1-AAAA" }];
  const b = [{ name: "foo", version: "1.0.0", source: "git+https://dave:p@ss2@example.test/foo.git#x https://erin:three@mirror.test/foo", integrity: "sha1-AAAA" }];
  const shown = JSON.stringify(diffLocks(a, b));
  for (const s of ["carol", "dave", "erin", "ss1", "ss2", "three"]) expect(shown).not.toContain(s);
});

test("one range resolved to two versions by different workspaces is not a change against itself", () => {
  const a = [
    { name: "dep", version: "1.0.0", descriptors: ["dep@^1.0.0"] },
    { name: "dep", version: "1.5.0", descriptors: ["dep@^1.0.0"] },
  ];
  expect(diffLocks(a, a)).toEqual([]);
});

test("a range that loses one same-version origin to another is still a swap", () => {
  const X = { name: "foo", version: "1.0.0", source: "https://registry.npmjs.org/foo/-/foo-1.0.0.tgz", digest: "sha512-AAA", descriptors: ["foo@^1.0.0"] };
  const Y = { name: "foo", version: "1.0.0", source: "https://mirror.example/foo-1.0.0.tgz", digest: "sha512-BBB", descriptors: ["foo@^1.0.0"] };
  expect(diffLocks([Y, X], [{ ...Y }]).length).toBe(1);
  expect(diffLocks([Y, X], [{ ...Y }, { ...X }])).toEqual([]);
});
