import { expect, test } from "bun:test";
import { measure } from "./npm-transitive";
import local from "./npm-ls-esbuild.json";
import global from "./npm-ls-g-esbuild.json";

const noGyp = () => false;

test("global tree (real npm ls -g output): scripts mark the direct hook", () => {
  expect(measure(global, noGyp)).toEqual({ direct: 1, transitive: 1, unique: 2, withHook: { direct: ["esbuild@0.28.2"], transitive: [] } });
});

test("lockfile-backed tree (real npm ls output): hasInstallScript marks the direct hook", () => {
  expect(measure(local, noGyp)).toEqual({ direct: 1, transitive: 1, unique: 2, withHook: { direct: ["esbuild@0.28.2"], transitive: [] } });
});

test("a transitive entry with a hook is reported in either form", () => {
  const g = structuredClone(global) as any;
  g.dependencies.esbuild.dependencies["@esbuild/darwin-arm64"].scripts = { preinstall: "node x.js" };
  const l = structuredClone(local) as any;
  l.dependencies.esbuild.dependencies["@esbuild/darwin-arm64"].hasInstallScript = true;
  for (const t of [g, l]) expect(measure(t, noGyp).withHook.transitive).toEqual(["@esbuild/darwin-arm64@0.28.2"]);
});

test("binding.gyp with no install script counts as an implicit hook", () => {
  const m = measure(global, (dir) => dir.endsWith("@esbuild/darwin-arm64"));
  expect(m.withHook.transitive).toEqual(["@esbuild/darwin-arm64@0.28.2"]);
});

test("non-install scripts are not hooks", () => {
  expect(measure({ dependencies: { a: { version: "1.0.0", scripts: { prepare: "z", test: "t" } } } }, noGyp).withHook.direct).toEqual([]);
});

test("a duplicated transitive entry counts once", () => {
  const c = { version: "2.0.0", hasInstallScript: true };
  const m = measure({ dependencies: { a: { version: "1.0.0", dependencies: { c } }, b: { version: "1.0.0", dependencies: { c } } } }, noGyp);
  expect(m).toEqual({ direct: 2, transitive: 1, unique: 3, withHook: { direct: [], transitive: ["c@2.0.0"] } });
});

test("empty tree", () => {
  expect(measure({}).unique).toBe(0);
});
