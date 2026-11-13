import { describe, expect, test } from "bun:test";
import { corpusPair } from "../acceptance/synthetic/corpus.ts";
import { dependencySignals, isNpmManifest, lookalikeOf, oneEditApart, stripHashComments } from "../src/dependency-signals.ts";
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

  test("real neighbors of popular names raise no lookalike, so they raise only dependency-added", () => {
    expect(lookalikeOf("pypi", "scapy")).toBeUndefined();
    expect(lookalikeOf("pypi", "markdown2")).toBeUndefined();
    expect(lookalikeOf("npm", "preact")).toBeUndefined();
    expect(lookalikeOf("npm", "reacts")).toBe("react");
    expect(lookalikeOf("npm", "color")).toBeUndefined();
    const s = dependencySignals("pypi", files({ "setup.py": "setup(install_requires=[])" }), files({ "setup.py": 'setup(install_requires=["scapy"])' }));
    expect(s.map((x) => x.kind)).toEqual(["dependency-added"]);
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

  test("npm: an unreadable manifest gives nothing, and a manifest with no old copy counts every name as new", () => {
    expect(dependencySignals("npm", files({ "package.json": pj({}) }), files({ "package.json": "{" }))).toEqual([]);
    expect(dependencySignals("npm", files({}), files({ "package.json": pj({ a: "1", b: "2" }) }))).toEqual([
      { kind: "dependency-added", path: "package.json", detail: "new dependency name(s): a, b" },
    ]);
  });

  test("npm: only the root package.json is read", () => {
    const nu = files({ "package.json": pj({}), "pkg/package.json": pj({ a: "1" }), "node_modules/x/package.json": pj({ b: "1" }) });
    expect(dependencySignals("npm", files({ "package.json": pj({}) }), nu)).toEqual([]);
  });

  test("pypi: a manifest new to the release counts every name as new", () => {
    const s = dependencySignals("pypi", files({}), files({ "requirements.txt": "a\nb\n" }));
    expect(s).toEqual([{ kind: "dependency-added", path: "requirements.txt", detail: "new dependency name(s): a, b" }]);
  });

  test("pypi: a stray apostrophe in a # comment does not drop the names after it", () => {
    const old = files({ "setup.py": 'setup(install_requires=["a"])' });
    const nu = files({ "setup.py": 'setup(install_requires=[\n    "a",\n    # don\'t drop "x" quietly\n    "b",\n    "c",\n])' });
    expect(dependencySignals("pypi", old, nu)[0]!.detail).toBe("new dependency name(s): b, c");
    const toml = files({ "pyproject.toml": 'dependencies = [\n  "a", # it\'s here\n  "d",\n]\n' });
    expect(dependencySignals("pypi", files({ "pyproject.toml": 'dependencies = ["a"]\n' }), toml)[0]!.detail).toBe("new dependency name(s): d");
  });

  test("pypi: only root files and a top-level dist-info METADATA are read, never a file deeper in the tree", () => {
    const old = files({});
    const nu = files({
      "pkg/setup.py": 'setup(install_requires=["a"])',
      "docs/requirements.txt": "b\n",
      "tests/pyproject.toml": 'dependencies = ["c"]\n',
      "a/b/x.egg-info/requires.txt": "d\n",
      "a/b.dist-info/METADATA": "Requires-Dist: e\n",
      "x.dist-info/METADATA": "Requires-Dist: f\n",
      "requirements-dev.txt": "g\n",
    });
    expect(dependencySignals("pypi", old, nu).map((x) => `${x.path}: ${x.detail}`)).toEqual([
      "x.dist-info/METADATA: new dependency name(s): f",
      "requirements-dev.txt: new dependency name(s): g",
    ]);
  });

  test("pypi: a setuptools sdist's egg-info is read, at the root or under src/, for requires.txt (and PKG-INFO at the root)", () => {
    const nu = files({
      "x.egg-info/requires.txt": "a\n[test]\nt\n",
      "src/y.egg-info/requires.txt": "b\n",
      "z.egg-info/PKG-INFO": "Requires-Dist: c\n",
      "src/w.egg-info/PKG-INFO": "Requires-Dist: ignored\n",
      "requires.txt": "never\n",
    });
    expect(dependencySignals("pypi", files({}), nu).map((x) => `${x.path}: ${x.detail}`).sort()).toEqual([
      "src/y.egg-info/requires.txt: new dependency name(s): b",
      "x.egg-info/requires.txt: new dependency name(s): a",
      "z.egg-info/PKG-INFO: new dependency name(s): c",
    ]);
  });

  test("pyproject: a single-quoted TOML string has no escapes, so a trailing backslash does not swallow the comment after it", () => {
    const toml = files({ "pyproject.toml": "dependencies = [\n  'a\\', 'b', # it's\n  'c',\n]\n" });
    expect(dependencySignals("pypi", files({}), toml)[0]!.detail).toBe("new dependency name(s): a, b, c");
  });

  test("stripHashComments: single-quoted strings take escapes in Python and none in TOML", () => {
    const line = "l = ['a\\', 'b'] # it's";
    expect(stripHashComments(line, { tomlLiteral: true })).toBe("l = ['a\\', 'b'] ");
    expect(stripHashComments(line, { tomlLiteral: false })).toBe(line);
  });

  test("stripHashComments keeps a # inside a quoted string", () => {
    expect(stripHashComments('x = "a#b" # note\ny = 1')).toBe('x = "a#b" \ny = 1');
  });

  test("pypi: setup.cfg install_requires with the first requirement on the same line", () => {
    const old = files({ "setup.cfg": "[options]\ninstall_requires = a\n" });
    const nu = files({ "setup.cfg": "[options]\ninstall_requires = a>=1\n    b\n" });
    expect(dependencySignals("pypi", old, nu)[0]!.detail).toBe("new dependency name(s): b");
    expect(dependencySignals("pypi", files({ "setup.cfg": "[options]\n" }), files({ "setup.cfg": "[options]\ninstall_requires = reqeusts>=2\n" })).map((x) => x.kind)).toEqual(["dependency-added", "dependency-lookalike"]);
  });

  test("pypi: a url or path line in a requirements file is no dependency named for its scheme", () => {
    const nu = files({ "requirements.txt": "git+https://example.invalid/r.git#egg=x\nhttps://example.invalid/p.whl\n./local\n-e .\nreal @ https://example.invalid/real.whl\nplain>=1\n" });
    expect(dependencySignals("pypi", files({ "requirements.txt": "" }), nu)[0]!.detail).toBe("new dependency name(s): real, plain");
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

describe("isNpmManifest", () => {
  test("the root package.json, and one directory down when asked, never under node_modules", () => {
    expect(isNpmManifest("package.json", 1)).toBe(true);
    expect(isNpmManifest("pkg/package.json", 1)).toBe(false);
    expect(isNpmManifest("pkg/package.json")).toBe(true);
    expect(isNpmManifest("a/b/package.json")).toBe(false);
    expect(isNpmManifest("node_modules/package.json")).toBe(false);
    expect(isNpmManifest("pkg/package.json.bak")).toBe(false);
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

describe("a new npm dependency with a major of 90 to 999 raises the high-floor signal (soft)", () => {
  const manifest = (deps: Record<string, string>) => new Map([["package.json", new TextEncoder().encode(JSON.stringify({ name: "p", version: "1.0.0", dependencies: deps }))]]);
  const high = (oldDeps: Record<string, string>, newDeps: Record<string, string>) => dependencySignals("npm", manifest(oldDeps), manifest(newDeps)).filter((s) => s.kind === "dependency-high-floor");
  test("the corpus case carries it, as a soft signal and no hard one", () => {
    const p = corpusPair("npm-dependency-confusion-internal-name");
    const r = prepass("npm", p.old, p.new);
    expect(r.hard).toEqual([]);
    expect(r.soft.find((s) => s.kind === "dependency-high-floor")?.detail).toContain("@acme-internal/auth-core asks for version ^99.0.0");
  });
  test("the edges: 89 and 1000 and a calendar version are quiet, 90 and 999 raise it", () => {
    expect(high({}, { a: "^89.0.0" })).toEqual([]);
    expect(high({}, { a: "^1000.0.0" })).toEqual([]);
    expect(high({}, { a: "^2026.1.0" })).toEqual([]);
    expect(high({}, { a: "90.0.0" })).toHaveLength(1);
    expect(high({}, { a: "~999.1.0" })).toHaveLength(1);
    expect(high({}, { a: ">=99.0.0" })).toHaveLength(1);
  });
  test("only a name the release adds: a dependency the old release had, or one with no version string, stays quiet", () => {
    expect(high({ a: "^99.0.0" }, { a: "^99.0.0" })).toEqual([]);
    expect(high({ a: "^1.0.0" }, { a: "^99.0.0" })).toEqual([]);
    expect(high({}, { a: "latest", b: "^1.2.3" })).toEqual([]);
  });
  test("PyPI is not read", () => {
    const f = (t: string) => new Map([["requirements.txt", new TextEncoder().encode(t)]]);
    expect(dependencySignals("pypi", f(""), f("a==99.0.0\n")).filter((s) => s.kind === "dependency-high-floor")).toEqual([]);
  });
});
