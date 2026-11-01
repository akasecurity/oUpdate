import { expect, test } from "bun:test";
import { npmPrivateRegistry } from "../src/lockfile/types.ts";

test("npmPrivateRegistry never returns an unparsable url, which may carry credentials", () => {
  const raw = "//user:s3cret@registry.internal:bad port/pkg.tgz";
  const out = npmPrivateRegistry(raw);
  expect(out).toBeDefined();
  expect(out).not.toContain("s3cret");
  expect(out).not.toContain("user");
});

test("npmPrivateRegistry returns the host for a private registry and undefined for the default", () => {
  expect(npmPrivateRegistry("https://npm.example.com/a/-/a-1.0.0.tgz")).toBe("npm.example.com");
  expect(npmPrivateRegistry("https://registry.npmjs.org/a/-/a-1.0.0.tgz")).toBeUndefined();
  expect(npmPrivateRegistry(undefined)).toBeUndefined();
});
