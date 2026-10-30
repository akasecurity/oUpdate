import { expect, test } from "bun:test";
import { measure } from "./npm-transitive";

test("counts direct and transitive entries and install hooks", () => {
  const m = measure({
    dependencies: {
      a: { version: "1.0.0", scripts: { postinstall: "node x.js" }, dependencies: { c: { version: "2.0.0", scripts: { install: "y" } } } },
      b: { version: "1.0.0", scripts: { prepare: "z" }, dependencies: { c: { version: "2.0.0", scripts: { install: "y" } } } },
    },
  });
  expect(m).toEqual({ direct: 2, transitive: 1, unique: 3, withHook: { direct: ["a@1.0.0"], transitive: ["c@2.0.0"] } });
});

test("empty tree", () => {
  expect(measure({}).unique).toBe(0);
});
