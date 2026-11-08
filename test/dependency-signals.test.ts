import { describe, expect, test } from "bun:test";
import { corpusPair } from "../acceptance/synthetic/corpus.ts";
import { dependencySignals, lookalikeOf, oneEditApart } from "../src/dependency-signals.ts";
import { prepass, type FileMap } from "../src/prepass.ts";

const enc = new TextEncoder();
const files = (o: Record<string, string>): FileMap => new Map(Object.entries(o).map(([k, v]) => [k, enc.encode(v)]));
const pj = (deps: Record<string, string>) => JSON.stringify({ name: "x", version: "1.0.0", dependencies: deps });
const kinds = (s: { kind: string }[]) => s.map((x) => x.kind);

describe("oneEditApart", () => {
  test("a change, an insert, a drop and a swap count; equal, two edits and a far length do not", () => {
    expect(oneEditApart("reqeusts", "requests")).toBe(true);
    expect(oneEditApart("lodsh", "lodash")).toBe(true);
    expect(oneEditApart("expresss", "express")).toBe(true);
    expect(oneEditApart("axois", "axios")).toBe(true);
    expect(oneEditApart("colorz", "colors")).toBe(true);
    expect(oneEditApart("axios", "axios")).toBe(false);
    expect(oneEditApart("axxxs", "axios")).toBe(false);
    expect(oneEditApart("axiosss", "axios")).toBe(false);
  });
});

describe("lookalikeOf", () => {
  test("a name one edit from a popular one points at it; the popular name and short names do not", () => {
    expect(lookalikeOf("npm", "expresss")).toBe("express");
    expect(lookalikeOf("pypi", "reqeusts")).toBe("requests");
    expect(lookalikeOf("pypi", "Python_Dateutill")).toBe("python-dateutil");
    expect(lookalikeOf("npm", "express")).toBeUndefined();
    expect(lookalikeOf("pypi", "Requests")).toBeUndefined();
    expect(lookalikeOf("npm", "vuex")).toBeUndefined();
    expect(lookalikeOf("npm", "left-pad-2")).toBeUndefined();
  });
});

describe("dependencySignals", () => {
  test("npm: a new name in dependencies is one soft signal; an unchanged list is none", () => {
    const old = files({ "package.json": pj({ a: "^1.0.0" }) });
    expect(dependencySignals("npm", old, files({ "package.json": pj({ a: "^1.1.0" }) }))).toEqual([]);
    const s = dependencySignals("npm", old, files({ "package.json": pj({ a: "^1.0.0", b: "^2.0.0" }) }));
    expect(s).toEqual([{ kind: "dependency-added", path: "package.json", detail: "new dependency name(s): b" }]);
  });

  test("npm: a lookalike of a popular name adds a second signal naming it", () => {
    const s = dependencySignals("npm", files({ "package.json": pj({}) }), files({ "package.json": pj({ expresss: "1.0.0" }) }));
    expect(kinds(s)).toEqual(["dependency-added", "dependency-lookalike"]);
    expect(s[1]!.detail).toContain("express");
  });

  test("npm: optional and peer names count, a removal and a nested node_modules manifest do not", () => {
    const old = files({ "package.json": pj({ a: "1.0.0" }) });
    const nu = files({ "package.json": JSON.stringify({ name: "x", optionalDependencies: { o: "1.0.0" }, peerDependencies: { p: "1.0.0" } }), "node_modules/z/package.json": pj({ q: "1" }) });
    expect(dependencySignals("npm", old, nu)[0]!.detail).toBe("new dependency name(s): o, p");
  });

  test("npm: an unreadable manifest and a first install give nothing", () => {
    expect(dependencySignals("npm", files({ "package.json": pj({}) }), files({ "package.json": "{" }))).toEqual([]);
    expect(dependencySignals("npm", files({}), files({ "package.json": pj({ a: "1" }) }))).toEqual([]);
  });

  test("pypi: setup.py, pyproject.toml, setup.cfg, METADATA, requires.txt and requirements files are read", () => {
    const old = files({
      "setup.py": 'setup(install_requires=["a>=1"])',
      "pyproject.toml": '[project]\ndependencies = [\n  "a",\n]\n',
      "setup.cfg": "[options]\ninstall_requires =\n    a\n",
      "x.dist-info/METADATA": "Name: x\nRequires-Dist: a\n",
      "x.egg-info/requires.txt": "a\n",
      "requirements.txt": "a==1\n",
    });
    const nu = files({
      "setup.py": 'setup(install_requires=["a>=1", "b==2"])',
      "pyproject.toml": '[project]\ndependencies = [\n  "a",\n  "c[extra]>=1",\n]\n',
      "setup.cfg": "[options]\ninstall_requires =\n    a\n    d>=1\n",
      "x.dist-info/METADATA": "Name: x\nRequires-Dist: a\nRequires-Dist: e (>=1)\n",
      "x.egg-info/requires.txt": "a\nf\n[test]\ng\n",
      "requirements.txt": "# c\na==1\nh\n-r other.txt\n",
    });
    const got = Object.fromEntries(dependencySignals("pypi", old, nu).map((s) => [s.path, s.detail]));
    expect(got).toEqual({
      "setup.py": "new dependency name(s): b",
      "pyproject.toml": "new dependency name(s): c",
      "setup.cfg": "new dependency name(s): d",
      "x.dist-info/METADATA": "new dependency name(s): e",
      "x.egg-info/requires.txt": "new dependency name(s): f",
      "requirements.txt": "new dependency name(s): h",
    });
  });

  test("pypi: names compare the way pip does (case, dash, underscore, dot)", () => {
    const old = files({ "setup.py": 'setup(install_requires=["Typing_Extensions"])' });
    expect(dependencySignals("pypi", old, files({ "setup.py": 'setup(install_requires=["typing-extensions>=4"])' }))).toEqual([]);
  });
});

describe("prepass carries the dependency signals as soft, never hard", () => {
  test.each(["npm-dependency-confusion-internal-name", "pypi-typosquat-dependency-added"] as const)("the corpus case %s", (k) => {
    const p = corpusPair(k);
    const r = prepass(k.startsWith("npm") ? "npm" : "pypi", p.old, p.new);
    expect(r.hard).toEqual([]);
    expect(kinds(r.soft)).toContain("dependency-added");
  });

  test("the typosquat case also raises the lookalike signal", () => {
    const p = corpusPair("pypi-typosquat-dependency-added");
    const r = prepass("pypi", p.old, p.new);
    expect(r.soft.find((s) => s.kind === "dependency-lookalike")?.detail).toContain("requests");
  });
});
