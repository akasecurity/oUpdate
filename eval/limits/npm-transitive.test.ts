import { expect, test } from "bun:test";
import { measure } from "./npm-transitive";
import real from "./npm-ls-esbuild.json";

test("real npm ls output: direct entry with an install hook, installed transitive entry without", () => {
  expect(measure(real)).toEqual({ direct: 1, transitive: 1, unique: 2, withHook: { direct: ["esbuild@0.28.2"], transitive: [] } });
});

test("a transitive entry with hasInstallScript is reported", () => {
  const tree = structuredClone(real) as any;
  tree.dependencies.esbuild.dependencies["@esbuild/darwin-arm64"].hasInstallScript = true;
  expect(measure(tree).withHook.transitive).toEqual(["@esbuild/darwin-arm64@0.28.2"]);
});

test("a duplicated transitive entry counts once", () => {
  const c = { version: "2.0.0", hasInstallScript: true };
  const m = measure({ dependencies: { a: { version: "1.0.0", dependencies: { c } }, b: { version: "1.0.0", dependencies: { c } } } });
  expect(m).toEqual({ direct: 2, transitive: 1, unique: 3, withHook: { direct: [], transitive: ["c@2.0.0"] } });
});

test("empty tree", () => {
  expect(measure({}).unique).toBe(0);
});
