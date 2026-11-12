import { describe, expect, test } from "bun:test";
import { corpusPair } from "../acceptance/synthetic/corpus.ts";
import { cargoBuildScript, ecosystemSignals, permissionsRemoved, workflowTriggers, workflowWriteGrants } from "../src/ecosystem-signals.ts";
import { LARGE_FILE_BYTES, markLink, prepass, type FileMap } from "../src/prepass.ts";

const enc = new TextEncoder();
const dec = new TextDecoder();
const files = (o: Record<string, string>): FileMap => new Map(Object.entries(o).map(([k, v]) => [k, enc.encode(v)]));
const kinds = (s: { kind: string }[]) => s.map((x) => x.kind);
const WF = ".github/workflows/ci.yml";

describe("rust build.rs", () => {
  test("a new build.rs and a changed one are soft signals; an unchanged one and a build.rs-like name are none", () => {
    const s = ecosystemSignals(files({}), files({ "crate/build.rs": "fn main() {}" }));
    expect(s).toEqual([{ kind: "rust-build-script-added", path: "crate/build.rs", detail: "new build.rs; it runs at build time" }]);
    expect(kinds(ecosystemSignals(files({ "build.rs": "a" }), files({ "build.rs": "b" })))).toEqual(["rust-build-script-changed"]);
    expect(ecosystemSignals(files({ "build.rs": "a" }), files({ "build.rs": "a" }))).toEqual([]);
    expect(ecosystemSignals(files({}), files({ "src/rebuild.rs": "x", "build.rs.bak": "x", "build.rst": "x" }))).toEqual([]);
  });
});

describe("go generate and cgo", () => {
  const go = (body: string) => files({ "main.go": `package main\n${body}\nfunc main() {}\n` });
  test("a new //go:generate line is one signal naming it; an existing one is none", () => {
    const s = ecosystemSignals(go(""), go('//go:generate sh gen.sh'));
    expect(s).toEqual([{ kind: "go-generate-added", path: "main.go", detail: "//go:generate sh gen.sh" }]);
    expect(ecosystemSignals(go("//go:generate sh gen.sh"), go("//go:generate sh gen.sh"))).toEqual([]);
    expect(kinds(ecosystemSignals(go("//go:generate a"), go("//go:generate a\n//go:generate b")))).toEqual(["go-generate-added"]);
  });

  test('import "C" newly added, alone or in an import block, is a cgo signal; a #cgo line added to existing cgo is too', () => {
    expect(kinds(ecosystemSignals(go(""), go('import "C"')))).toEqual(["go-cgo-added"]);
    expect(kinds(ecosystemSignals(go(""), go('import (\n\t"fmt"\n\t"C"\n)')))).toEqual(["go-cgo-added"]);
    const s = ecosystemSignals(go('import "C"'), go('// #cgo LDFLAGS: -lz\nimport "C"'));
    expect(s).toEqual([{ kind: "go-cgo-added", path: "main.go", detail: "// #cgo LDFLAGS: -lz" }]);
    expect(ecosystemSignals(go('import "C"'), go('import "C"\n// comment'))).toEqual([]);
  });

  test("go generate reads test files, so a directive there counts; cgo in a test file, non-Go files and prose do not", () => {
    expect(ecosystemSignals(files({}), files({ "a_test.go": '//go:generate x\nimport "C"', "notes.md": "//go:generate x" }))).toEqual([{ kind: "go-generate-added", path: "a_test.go", detail: "//go:generate x" }]);
    expect(ecosystemSignals(go(""), go("// run go:generate by hand"))).toEqual([]);
  });
});

describe("github actions workflows", () => {
  const wf = (src: string, p = WF) => files({ [p]: src });
  test("write-all, a scoped write and an inline write are new grants; a read is not", () => {
    expect([...workflowWriteGrants("permissions: write-all\n")]).toEqual(["write-all"]);
    expect([...workflowWriteGrants("permissions:\n  contents: write\n  id-token: write\n  issues: read\n")]).toEqual(["contents write", "id-token write"]);
    expect([...workflowWriteGrants("permissions: { packages: write, contents: read }\n")]).toEqual(["packages write"]);
    expect([...workflowWriteGrants("permissions: read-all\n")]).toEqual([]);
  });

  test("permissions widening: read to write is one signal, an unchanged write is none, a new job with a new write scope counts", () => {
    const read = "on: push\npermissions:\n  contents: read\njobs:\n  a:\n    runs-on: x\n";
    const write = "on: push\npermissions:\n  contents: write\njobs:\n  a:\n    runs-on: x\n";
    const s = ecosystemSignals(wf(read), wf(write));
    expect(s).toEqual([{ kind: "workflow-permissions-widened", path: WF, detail: "write access added: contents write" }]);
    expect(ecosystemSignals(wf(write), wf(write + "# note\n"))).toEqual([]);
    expect(ecosystemSignals(wf(write), wf(read))).toEqual([]);
    const job = write + "  b:\n    permissions:\n      packages: write\n    runs-on: x\n";
    expect(ecosystemSignals(wf(write), wf(job)).map((x) => x.detail)).toEqual(["write access added: packages write"]);
    expect(kinds(ecosystemSignals(wf(read), wf("on: push\npermissions: write-all\n")))).toEqual(["workflow-permissions-widened"]);
  });

  test("pull_request_target and workflow_run are signals when they newly appear, in every YAML trigger form", () => {
    const base = "on: push\njobs: {}\n";
    for (const [src, name] of [
      ["on:\n  pull_request_target:\n    types: [opened]\n", "pull_request_target"],
      ["on: [push, workflow_run]\n", "workflow_run"],
      ["on:\n  workflow_run:\n    workflows: [ci]\n", "workflow_run"],
      ["on: pull_request_target\n", "pull_request_target"],
      ["on:\n  - pull_request_target\n", "pull_request_target"],
    ] as const) {
      const s = ecosystemSignals(wf(base), wf(src));
      expect(s, src).toEqual([{ kind: "workflow-trigger-added", path: WF, detail: `new trigger: ${name}` }]);
    }
    expect(ecosystemSignals(wf("on: pull_request_target\n"), wf("on: pull_request_target\n# x\n"))).toEqual([]);
    expect(ecosystemSignals(wf(base), wf("on: push\n# was pull_request_target\n"))).toEqual([]);
    expect(ecosystemSignals(wf(base), wf("on: pull_request\n"))).toEqual([]);
  });

  test("action.yml and nested action files are read; other yaml files are not", () => {
    const src = "on: pull_request_target\n";
    expect(kinds(ecosystemSignals(files({}), files({ "action.yml": src, ".github/actions/x/action.yaml": src })))).toEqual(["workflow-trigger-added", "workflow-trigger-added"]);
    expect(ecosystemSignals(files({}), files({ "config.yml": src, ".github/dependabot.yml": src, "docs/.github/workflows/x.txt": src }))).toEqual([]);
  });
});

describe("review fixes: size, line endings, quotes, trigger placement, grant comparison", () => {
  const wf = (src: string) => files({ [WF]: src });
  const read = "on: push\npermissions:\n  contents: read\n";

  test("a file between 1 MB and the pre-pass large-file cap is still read", () => {
    const pad = "# " + "x".repeat(2_000_000) + "\n";
    expect(pad.length).toBeLessThan(LARGE_FILE_BYTES);
    expect(kinds(ecosystemSignals(wf(read), wf(pad + "on: push\npermissions: write-all\n")))).toEqual(["workflow-permissions-widened"]);
    expect(kinds(ecosystemSignals(files({ "main.go": "package main\n" }), files({ "main.go": pad.replace("# ", "// ") + "package main\n//go:generate sh x.sh\n" })))).toEqual(["go-generate-added"]);
  });

  test("CRLF line endings: grants, triggers and Go directives are read", () => {
    const crlf = (t: string) => t.replace(/\n/g, "\r\n");
    expect([...workflowWriteGrants(crlf("permissions: write-all\n"))]).toEqual(["write-all"]);
    expect([...workflowWriteGrants(crlf("permissions:\n  contents: write\n"))]).toEqual(["contents write"]);
    expect([...workflowTriggers(crlf("on:\n  pull_request_target:\n"))]).toEqual(["pull_request_target"]);
    expect([...workflowTriggers(crlf("on: pull_request_target\n"))]).toEqual(["pull_request_target"]);
    const go = files({ "main.go": crlf("package main\n//go:generate sh x.sh\n") });
    expect(ecosystemSignals(files({ "main.go": crlf("package main\n//go:generate sh x.sh\n") }), go)).toEqual([]);
    expect(kinds(ecosystemSignals(files({ "main.go": crlf("package main\n") }), files({ "main.go": crlf('package main\n// #cgo LDFLAGS: -lz\nimport "C"\n') })))).toEqual(["go-cgo-added"]);
  });

  test("quoted YAML keys and values are read", () => {
    expect([...workflowWriteGrants('permissions: "write-all"\n')]).toEqual(["write-all"]);
    expect([...workflowWriteGrants("permissions:\n  contents: 'write'\n  \"id-token\": \"write\"\n")]).toEqual(["contents write", "id-token write"]);
    expect([...workflowWriteGrants('permissions: { "packages": "write" }\n')]).toEqual(["packages write"]);
    expect([...workflowWriteGrants('"permissions":\n  contents: write\n')]).toEqual(["contents write"]);
    expect([...workflowTriggers('on: ["pull_request_target"]\n')]).toEqual(["pull_request_target"]);
    expect([...workflowTriggers("on: 'workflow_run'\n")]).toEqual(["workflow_run"]);
    expect([...workflowTriggers('on:\n  "pull_request_target":\n    types: [opened]\n')]).toEqual(["pull_request_target"]);
    expect([...workflowTriggers('"on":\n  - "workflow_run"\n')]).toEqual(["workflow_run"]);
  });

  test("a trigger name counts only under the top-level on: key", () => {
    const run = "on: push\njobs:\n  a:\n    runs-on: x\n    steps:\n      - run: echo workflow_run pull_request_target\n";
    expect(ecosystemSignals(wf("on: push\n"), wf(run))).toEqual([]);
    expect([...workflowTriggers("on: push\nenv:\n  pull_request_target: 1\n")]).toEqual([]);
    expect([...workflowTriggers("on:\n  push:\n    branches: [workflow_run]\n")]).toEqual([]);
    expect([...workflowTriggers("on: { push: { branches: [workflow_run] } }\n")]).toEqual([]);
    expect([...workflowTriggers("on: { workflow_run: { workflows: [ci] } }\n")]).toEqual(["workflow_run"]);
    expect([...workflowTriggers("jobs:\n  on:\n    pull_request_target: 1\n")]).toEqual([]);
  });

  test("grants compare over the whole file: a renamed job or a grant moved between levels is not widened", () => {
    const top = "on: push\npermissions:\n  contents: write\njobs:\n  a:\n    runs-on: x\n";
    const moved = "on: push\njobs:\n  a:\n    runs-on: x\n    permissions:\n      contents: write\n";
    const renamed = "on: push\njobs:\n  b:\n    runs-on: x\n    permissions:\n      contents: write\n";
    expect(ecosystemSignals(wf(top), wf(moved))).toEqual([]);
    expect(ecosystemSignals(wf(moved), wf(renamed))).toEqual([]);
    expect(ecosystemSignals(wf("on: push\npermissions: write-all\n"), wf(moved))).toEqual([]);
  });

  test("a permissions input under a step's with: is no grant", () => {
    const step = "on: push\njobs:\n  a:\n    runs-on: x\n    steps:\n      - uses: some/action@v1\n        with:\n          permissions: write-all\n          contents: write\n      - with:\n          permissions:\n            contents: write\n";
    expect([...workflowWriteGrants(step)]).toEqual([]);
    expect(ecosystemSignals(wf("on: push\n"), wf(step))).toEqual([]);
    expect([...workflowWriteGrants(step + "    permissions:\n      issues: write\n")]).toEqual(["issues write"]);
  });
});

describe("review fixes, round 2", () => {
  const wf = (src: string) => files({ [WF]: src });

  test("removing a permissions block falls back to the repository default and is widened", () => {
    const top = "on: push\npermissions:\n  contents: read\njobs:\n  a:\n    runs-on: x\n";
    const none = "on: push\njobs:\n  a:\n    runs-on: x\n";
    expect(ecosystemSignals(wf(top), wf(none))).toEqual([{ kind: "workflow-permissions-widened", path: WF, detail: "permissions removed, default applies: workflow" }]);
    const job = "on: push\njobs:\n  a:\n    runs-on: x\n    permissions: {}\n";
    expect(permissionsRemoved(job, none)).toEqual(["job a"]);
    // Moved from the workflow level into every job, or a workflow block kept: no fallback. A renamed job that lost its block falls back.
    expect(permissionsRemoved(top, "on: push\njobs:\n  a:\n    runs-on: x\n    permissions:\n      contents: read\n")).toEqual([]);
    expect(permissionsRemoved(job, "on: push\njobs:\n  b:\n    runs-on: x\n")).toEqual(["job b"]);
    expect(permissionsRemoved(job, "on: push\npermissions: read-all\njobs:\n  a:\n    runs-on: x\n")).toEqual([]);
    expect(permissionsRemoved("on: push\npermissions: write-all\njobs:\n  a:\n    runs-on: x\n", none)).toEqual([]);
  });

  test("a flow value spread over lines is read", () => {
    expect([...workflowTriggers("on: [push,\n  pull_request_target]\n")]).toEqual(["pull_request_target"]);
    expect([...workflowTriggers("on: {\n  push: {},\n  workflow_run: { workflows: [ci] }\n}\n")]).toEqual(["workflow_run"]);
    expect([...workflowWriteGrants("permissions: {\n contents: write,\n issues: read }\n")]).toEqual(["contents write"]);
  });

  test("permissions text inside a block scalar or under env:, inputs: or outputs: is no grant", () => {
    const scalar = "on: push\njobs:\n  a:\n    steps:\n      - run: |\n          permissions: write-all\n          contents: write\n        name: x\n      - run: >-\n          permissions:\n            contents: write\n";
    expect([...workflowWriteGrants(scalar)]).toEqual([]);
    expect([...workflowWriteGrants("env:\n  permissions: write-all\n")]).toEqual([]);
    expect([...workflowWriteGrants("on:\n  workflow_dispatch:\n    inputs:\n      permissions:\n        default: write\n")]).toEqual([]);
    expect([...workflowWriteGrants("jobs:\n  a:\n    outputs:\n      permissions: write-all\n")]).toEqual([]);
    // After the block scalar or data key ends, a real grant is still read.
    expect([...workflowWriteGrants(scalar + "    permissions:\n      issues: write\n")]).toEqual(["issues write"]);
    expect([...workflowWriteGrants("description: |\n  on: pull_request_target\non: push\n")]).toEqual([]);
  });

  test("a Cargo.toml custom build script (build = \"<path>\") is a build script too", () => {
    expect(cargoBuildScript('[package]\nname = "x"\nbuild = "tools/gen.rs"\n\n[dependencies]\n')).toBe("tools/gen.rs");
    expect(cargoBuildScript('[package]\nname = "x"\n\n[features]\nbuild = "y"\n')).toBeUndefined();
    expect(cargoBuildScript('[package]\nbuild = false\n')).toBeUndefined();
    const toml = (b: string) => `[package]\nname = "x"\nversion = "1.0.0"\n${b}`;
    expect(ecosystemSignals(files({ "crate/Cargo.toml": toml("") }), files({ "crate/Cargo.toml": toml('build = "gen/make.rs"\n'), "crate/gen/make.rs": "fn main() {}" }))).toEqual([
      { kind: "rust-build-script-added", path: "crate/gen/make.rs", detail: "new custom build script named in crate/Cargo.toml; it runs at build time" },
    ]);
    const named = toml('build = "gen/make.rs"\n');
    expect(kinds(ecosystemSignals(files({ "Cargo.toml": named, "gen/make.rs": "a" }), files({ "Cargo.toml": named.replace("1.0.0", "1.0.1"), "gen/make.rs": "b" })))).toEqual(["rust-build-script-changed"]);
    expect(ecosystemSignals(files({ "Cargo.toml": named, "gen/make.rs": "a" }), files({ "Cargo.toml": named.replace("1.0.0", "1.0.1"), "gen/make.rs": "a" }))).toEqual([]);
    // build = "build.rs" is the default script, read once on its own path.
    expect(kinds(ecosystemSignals(files({}), files({ "Cargo.toml": toml('build = "build.rs"\n'), "build.rs": "x" })))).toEqual(["rust-build-script-added"]);
  });
});

describe("review fixes, round 3: parsed YAML, per-scope write-all", () => {
  const wf = (src: string) => files({ [WF]: src });

  test("a stray bracket in an ordinary value does not hide the keys after it", () => {
    const src = "name: deploy [\non: pull_request_target\npermissions: write-all\n";
    expect([...workflowTriggers(src)]).toEqual(["pull_request_target"]);
    expect([...workflowWriteGrants(src)]).toEqual(["write-all"]);
    expect(kinds(ecosystemSignals(wf("name: deploy\non: push\n"), wf(src)))).toEqual(["workflow-permissions-widened", "workflow-trigger-added"]);
    const job = "on: push\njobs:\n  a:\n    name: fix {\n    runs-on: x\n    permissions:\n      contents: write\n";
    expect([...workflowWriteGrants(job)]).toEqual(["contents write"]);
  });

  test("Cargo.toml is read with the TOML parser: a dotted key or an inline table names the build script too", () => {
    expect(cargoBuildScript('package.name = "x"\npackage.build = "tools/gen.rs"\n')).toBe("tools/gen.rs");
    expect(cargoBuildScript('package = { name = "x", build = "tools/gen.rs" }\n')).toBe("tools/gen.rs");
    expect(cargoBuildScript('[package\nbuild = "tools/gen.rs"\n')).toBeUndefined();
  });

  test("anchors and aliases are followed", () => {
    expect([...workflowWriteGrants("x: &p\n  contents: write\npermissions: *p\n")]).toEqual(["contents write"]);
  });

  test("YAML the parser refuses is still read by lines", () => {
    const broken = "on: pull_request_target\npermissions: write-all\nfoo: [\n";
    expect(() => Bun.YAML.parse(broken)).toThrow();
    expect([...workflowTriggers(broken)]).toEqual(["pull_request_target"]);
    expect([...workflowWriteGrants(broken)]).toEqual(["write-all"]);
  });

  test("a job-level write-all does not hide removing the workflow block from another job", () => {
    const old = "on: push\npermissions:\n  contents: read\njobs:\n  deploy:\n    permissions: write-all\n  build:\n    runs-on: x\n";
    const nu = "on: push\njobs:\n  deploy:\n    permissions: write-all\n  build:\n    runs-on: x\n";
    expect(permissionsRemoved(old, nu)).toEqual(["workflow"]);
    expect(kinds(ecosystemSignals(wf(old), wf(nu)))).toEqual(["workflow-permissions-widened"]);
  });

  test("a job-level write-all does not hide a new grant on another job; it still covers its own job", () => {
    const old = "on: push\njobs:\n  deploy:\n    permissions: write-all\n  build:\n    permissions:\n      contents: read\n";
    const nu = "on: push\njobs:\n  deploy:\n    permissions: write-all\n  build:\n    permissions:\n      contents: read\n      id-token: write\n";
    expect(ecosystemSignals(wf(old), wf(nu))).toEqual([{ kind: "workflow-permissions-widened", path: WF, detail: "write access added: id-token write" }]);
    const narrowed = "on: push\njobs:\n  deploy:\n    permissions:\n      contents: write\n  build:\n    permissions:\n      contents: read\n";
    expect(ecosystemSignals(wf(old), wf(narrowed))).toEqual([]);
  });
});

describe("review fixes, round 4", () => {
  const wf = (src: string) => files({ [WF]: src });

  test("an old write-all on one job does not cover another job widening to write-all", () => {
    const old = "on: push\njobs:\n  deploy:\n    permissions: write-all\n  build:\n    permissions:\n      contents: read\n";
    const nu = "on: push\njobs:\n  deploy:\n    permissions: write-all\n  build:\n    permissions: write-all\n";
    expect(ecosystemSignals(wf(old), wf(nu))).toEqual([{ kind: "workflow-permissions-widened", path: WF, detail: "write access added: write-all" }]);
  });

  test('import "C" with a trailing comment, in a one-line import group, or beside other paths is cgo; inside a raw string it is not', () => {
    const go = (body: string) => files({ "main.go": `package main\n${body}\nfunc main() {}\n` });
    for (const body of ['import "C" // cgo', 'import "C" /* cgo */', 'import ( "C" )', 'import ( "fmt"; "C" )', 'import (\n\t"fmt"; "C"\n)']) {
      expect(kinds(ecosystemSignals(go(""), go(body))), body).toEqual(["go-cgo-added"]);
    }
    expect(ecosystemSignals(go(""), go('var s = `\nimport "C"\n`'))).toEqual([]);
    expect(ecosystemSignals(go(""), go('import ( "fmt"; "Cx" )'))).toEqual([]);
  });

  test("an identifier ending in import, Unicode letters included, is not the import keyword", () => {
    const go = (body: string) => files({ "main.go": `package main\n${body}\nfunc main() {}\n` });
    for (const body of ['type T struct {\n\tαimport "C"\n}', 'type T struct {\n\tέimport "C"\n}', 'type T struct {\n\t٣import "C"\n}', 'var _ = x.import\n"C"', 'type T struct {\n\tαimport ( "C" )\n}'])
      expect(ecosystemSignals(go(""), go(body)), body).toEqual([]);
    // A Unicode name before the path is still a named import of C.
    for (const body of ['import α "C"', 'import ( α"C" )', 'import (\n\tβ "C"\n)']) expect(kinds(ecosystemSignals(go(""), go(body))), body).toEqual(["go-cgo-added"]);
  });

  test("an import path written as one escape for C is cgo; other escapes are not", () => {
    const go = (body: string) => files({ "main.go": `package main\n${body}\nfunc main() {}\n` });
    for (const body of ['import "\\x43"', 'import "\\103"', 'import "\\u0043"', 'import "\\U00000043"', 'import ( "fmt"; "\\x43" )'])
      expect(kinds(ecosystemSignals(go(""), go(body))), body).toEqual(["go-cgo-added"]);
    for (const body of ['import "\\x44"', 'import "\\x43x"', 'import "\\\\x43"', "import '\\x43'", 'var s = "\\x43"'])
      expect(ecosystemSignals(go(""), go(body)), body).toEqual([]);
  });

  test("a Cargo.toml build path is normalized and followed only when the release ships that file", () => {
    const toml = (b: string) => `[package]\nname = "x"\nversion = "1.0.0"\nbuild = "${b}"\n`;
    expect(ecosystemSignals(files({ "c/Cargo.toml": toml("../shared/gen.rs") }), files({ "c/Cargo.toml": toml("../shared/gen.rs").replace("1.0.0", "1.0.1") }))).toEqual([]);
    expect(ecosystemSignals(files({}), files({ "Cargo.toml": toml("tools/missing.rs") }))).toEqual([]);
    expect(ecosystemSignals(files({}), files({ "c/Cargo.toml": toml("./tools/../gen/make.rs"), "c/gen/make.rs": "fn main() {}" })).map((x) => x.path)).toEqual(["c/gen/make.rs"]);
  });

  test("issue_comment and pull_request_review_comment are risky triggers", () => {
    expect([...workflowTriggers("on: [issue_comment, pull_request_review_comment]\n")]).toEqual(["issue_comment", "pull_request_review_comment"]);
    expect(kinds(ecosystemSignals(wf("on: push\n"), wf("on:\n  issue_comment:\n    types: [created]\n")))).toEqual(["workflow-trigger-added"]);
  });

  test("the Rust corpus case is a pure maturin project on both sides", () => {
    const p = corpusPair("pypi-rust-build-script-added");
    for (const side of [p.old, p.new]) for (const f of ["setup.py", "synthetic_py_rs/__init__.py"]) expect(side.has(f), f).toBe(false);
  });
});

describe("cost on hostile input stays linear", () => {
  const timed = (label: string, f: () => unknown) => {
    const t = performance.now();
    f();
    const ms = performance.now() - t;
    expect(ms, `${label}: ${ms.toFixed(0)} ms`).toBeLessThan(1000);
  };
  const wf = (src: string) => files({ ".github/workflows/x.yml": src });
  const empty = files({});

  test("an unclosed flow bracket the parser refuses is not rejoined line by line", () => {
    const a = "on: [push" + "\n  a: b".repeat(40_000) + "\n";
    expect(() => Bun.YAML.parse(a)).toThrow();
    timed("on: [push + 40,000 lines", () => ecosystemSignals(empty, wf(a)));
    timed("x: [ x 20,000", () => ecosystemSignals(empty, wf("x: [\n".repeat(20_000))));
  });

  test("a join stops at an indent-0 line and after 200 lines", () => {
    expect([...workflowTriggers("x: [\non: pull_request_target\n")]).toEqual(["pull_request_target"]);
    const job = "jobs:\n  a:\n    x: [\n" + "      - a\n".repeat(250) + "    permissions: write-all\n";
    expect(() => Bun.YAML.parse(job)).toThrow();
    expect([...workflowWriteGrants(job)]).toEqual(["write-all"]);
  });

  test("a long run of letters in a flow permissions value, and a Go file of blank lines, are read once", () => {
    timed("permissions: { + 200,000 letters", () => ecosystemSignals(empty, wf("permissions: {" + "a".repeat(200_000) + "\n")));
    timed("2,000,000 blank lines of Go", () => ecosystemSignals(files({ "main.go": "package main\n" }), files({ "main.go": "package main\n" + "\n".repeat(2_000_000) + "func main() {}\n" })));
  });
});

describe("review fixes, round 6", () => {
  const wf = (src: string) => files({ [WF]: src });
  const timed = (label: string, f: () => unknown) => {
    const t = performance.now();
    f();
    const ms = performance.now() - t;
    expect(ms, `${label}: ${ms.toFixed(0)} ms`).toBeLessThan(1000);
  };

  test("nested permissions keys at ever deeper indents are read in one pass", () => {
    const src = Array.from({ length: 3000 }, (_, i) => " ".repeat(i + 1) + "permissions:").join("\n") + "\nbroken: [\n";
    expect(src.length).toBeGreaterThan(4_000_000);
    timed("3000 nested permissions keys", () => ecosystemSignals(files({}), files({ "action.yml": src })));
    expect([...workflowWriteGrants("jobs:\n  a:\n    permissions:\n      contents: write\n      issues: read\n    runs-on: x\n  b:\n    x: [\n")]).toEqual(["contents write"]);
  });

  test("a build script many manifests share is compared and reported once", () => {
    const script = "fn main() {}\n" + "// pad\n".repeat(150_000);
    const toml = (i: number, v: string) => `[package]\nname = "c${i}"\nversion = "${v}"\nbuild = "../shared/gen.rs"\n`;
    const old: Record<string, string> = { "shared/gen.rs": script };
    const nu: Record<string, string> = { "shared/gen.rs": script };
    for (let i = 0; i < 1000; i++) {
      old[`c${i}/Cargo.toml`] = toml(i, "1.0.0");
      nu[`c${i}/Cargo.toml`] = toml(i, "1.0.1");
    }
    const o = files(old);
    timed("1000 manifests sharing a 1 MB script", () => expect(ecosystemSignals(o, files(nu))).toEqual([]));
    nu["shared/gen.rs"] = script + "// changed\n";
    expect(ecosystemSignals(o, files(nu)).map((x) => [x.kind, x.path])).toEqual([["rust-build-script-changed", "shared/gen.rs"]]);
  });

  test("an old workflow write-all does not cover a job that had its own narrower block", () => {
    const old = "on: push\npermissions: write-all\njobs:\n  x:\n    permissions:\n      contents: read\n  y:\n    runs-on: z\n";
    const nu = "on: push\npermissions: write-all\njobs:\n  x:\n    permissions: write-all\n  y:\n    permissions:\n      contents: write\n";
    expect(ecosystemSignals(wf(old), wf(nu))).toEqual([{ kind: "workflow-permissions-widened", path: WF, detail: "write access added: write-all" }]);
  });

  test("a job that stays is compared with its own old block, not the grants of other jobs", () => {
    const old = "on: push\njobs:\n  deploy:\n    permissions:\n      contents: write\n  test:\n    permissions:\n      contents: read\n";
    const nu = "on: push\njobs:\n  deploy:\n    permissions:\n      contents: write\n  test:\n    permissions:\n      contents: write\n";
    expect(ecosystemSignals(wf(old), wf(nu))).toEqual([{ kind: "workflow-permissions-widened", path: WF, detail: "write access added: contents write" }]);
    // A renamed job still meets the pool.
    expect(ecosystemSignals(wf(old), wf(nu.replace("test:", "check:")))).toEqual([]);
  });

  test("fallback reader: a closing bracket at column 0 ends the join, blank lines do not count toward the cap, import may break before (", () => {
    expect([...workflowTriggers("on: [push,\n  pull_request_target\n]\nbad: [\n")]).toEqual(["pull_request_target"]);
    expect([...workflowTriggers("on: [push,\n" + "\n".repeat(250) + "  pull_request_target]\nbad: [\n")]).toEqual(["pull_request_target"]);
    const go = (body: string) => files({ "main.go": `package main\n${body}\nfunc main() {}\n` });
    expect(kinds(ecosystemSignals(go(""), go('import\n( "fmt"; "C" )')))).toEqual(["go-cgo-added"]);
  });
});

describe("review fixes, round 7", () => {
  test("a nested permissions key does not close the outer block in the fallback reader", () => {
    const src = "jobs:\n  a:\n    permissions:\n      permissions:\n        contents: write\n      issues: write\n    runs-on: x\nbroken: [\n";
    expect(() => Bun.YAML.parse(src)).toThrow();
    expect([...workflowWriteGrants(src)]).toContain("issues write");
  });

  test("import then ( across CRLF, a // comment and blank lines is a one-line group", () => {
    const go = (body: string) => files({ "main.go": `package main\n${body}\nfunc main() {}\n` });
    for (const body of ['import\r\n( "fmt"; "C" )', 'import // deps\n( "C" )', 'import\n\n  \n( "C" )', 'import // a\r\n\n// b\n( "C" )']) {
      expect(kinds(ecosystemSignals(go(""), go(body))), JSON.stringify(body)).toEqual(["go-cgo-added"]);
    }
    expect(ecosystemSignals(go(""), go('import\nx\n( "C" )'))).toEqual([]);
  });
});

describe("review fixes, round 8", () => {
  test("a build.rs that turns from a file into a symlink with the same bytes is changed", () => {
    const bytes = enc.encode("fn main() {}\n");
    const link = markLink(new Uint8Array(bytes));
    expect(ecosystemSignals(new Map([["build.rs", bytes]]), new Map([["build.rs", link]]))).toEqual([{ kind: "rust-build-script-changed", path: "build.rs", detail: "build.rs changed; it runs at build time" }]);
  });

  test("CRLF comment lines between import and ( are read in linear time", () => {
    const t = performance.now();
    ecosystemSignals(files({}), files({ "main.go": "package main\nimport" + "//a\r\n".repeat(40) + "x\n" }));
    expect(performance.now() - t).toBeLessThan(1000);
  });
});

describe("guard: every line reader stays linear on 1 MB of repeated input", () => {
  const SIZE = 1_000_000;
  const PATTERNS: Record<string, string> = {
    spaces: " ", tabs: "\t", newlines: "\n", "[": "[", "{": "{", quotes: '"', "import ": "import ", "permissions:": "permissions:", letters: "a",
    "//\\r\\n": "//\r\n", "//a\\r\\n": "//a\r\n", "\\r\\n": "\r\n", "\\r": "\r", "mixed //a\\r\\n \\t\\r\\n": "//a\r\n \t\r\n",
    "\\t#": "\t#", "\\t#\\r": "\t#\r", '"C"/*\\r': ' "C"/*\r', "-:\\t\\r": "-:\t\r",
    // Lone carriage returns, a line end for YAML only.
    "a\\r": "a\r", "  a:\\r": "  a:\r", "- a\\r": "- a\r", '_ "C"\\r': '_ "C"\r', "`\\r": "`\r", "//`\\r": "//`\r", "/*\\r": "/*\r", "import (": "import (", 'import _"': 'import _"', '"\\\\\\r': '"\\\r',
  };
  const fill = (p: string) => p.repeat(Math.ceil(SIZE / p.length));
  // Each entry wraps the filler so the line reader (not only the parser) reads it: a Go file, a Cargo.toml the TOML
  // parser refuses, and a workflow the YAML parser refuses. Bare, after the key the reader looks for, and before a lone \r
  // (a line end for ^ and $ but not for . or a split on \r?\n).
  const ENTRIES: Record<string, { path: string; wrap: (body: string) => string[] }> = {
    go: { path: "main.go", wrap: (b) => [`package main\n${b}\nfunc main() {}\n`, `package main\nimport ${b}"fmt"\n`, `package main\nimport ${b}(\n"C"\n)\n`, `package main\nimport${b}x\n`] },
    cargo: { path: "Cargo.toml", wrap: (b) => [`[package\n${b}\n`, `[package]\nbuild = ${b}\n[x\n`, `[package\nx = 1${b}\rx\n`] },
    workflow: { path: ".github/workflows/x.yml", wrap: (b) => [`${b}\nbroken: [\n`, `permissions: ${b}\nbroken: [\n`, `on: [${b}\nbroken: [\n`, `jobs:\n  a:\n    permissions:\n      ${b}\nbroken: [\n`, `x: y${b}\rx\nbroken: [\n`, `- a:${b}\rx\nbroken: [\n`] },
  };
  for (const [entry, { path, wrap }] of Object.entries(ENTRIES)) {
    for (const [name, pattern] of Object.entries(PATTERNS)) {
      test(`${entry}: ${name}`, () => {
        for (const [i, src] of wrap(fill(pattern)).entries()) {
          const t = performance.now();
          ecosystemSignals(files({ [path]: "" }), files({ [path]: src }));
          const ms = performance.now() - t;
          expect(ms, `${entry} ${name} form ${i}: ${ms.toFixed(0)} ms`).toBeLessThan(1000);
        }
      });
    }
  }
});

describe("prepass carries the build and CI signals as soft, never hard", () => {
  test.each([
    ["pypi-rust-build-script-added", "pypi", "rust-build-script-added"],
    ["npm-go-generate-cgo-added", "npm", "go-generate-added"],
    ["npm-go-generate-cgo-added", "npm", "go-cgo-added"],
    ["npm-workflow-pull-request-target-write", "npm", "workflow-permissions-widened"],
    ["npm-workflow-pull-request-target-write", "npm", "workflow-trigger-added"],
  ] as const)("the corpus case %s raises %s", (k, eco, kind) => {
    const p = corpusPair(k);
    const r = prepass(eco, p.old, p.new);
    expect(kinds(r.soft)).toContain(kind);
    expect(r.hard.filter((h) => /^(rust|go|workflow)-/.test(h.kind))).toEqual([]);
    // The Go helper sits in its install script's surface, so the existing install hold stops that case; the others have no hard signal.
    if (k === "npm-go-generate-cgo-added") expect(r.hard.map((h) => h.detail)).toEqual(["file native/main.go"]);
    else expect(r.hard).toEqual([]);
  });

  test("the corpus cases would run: the Rust case builds with maturin, the Go case's install script builds the helper in both releases", () => {
    const rs = corpusPair("pypi-rust-build-script-added");
    for (const side of [rs.old, rs.new]) expect(dec.decode(side.get("pyproject.toml")!)).toMatch(/^build-backend = "maturin"$/m);
    expect(dec.decode(rs.new.get("Cargo.toml")!)).toContain('crate-type = ["cdylib"]');
    const go = corpusPair("npm-go-generate-cgo-added");
    const install = (m: FileMap) => JSON.parse(dec.decode(m.get("package.json")!)).scripts?.install;
    expect(install(go.new)).toMatch(/cd native && go generate .* && go build/);
    expect(install(go.old)).toBe(install(go.new));
  });

  test("a release with none of these raises none of them", () => {
    const r = prepass("npm", files({ "package.json": "{}" }), files({ "package.json": "{}", "src/a.go": "package a\n", "lib.rs": "fn x() {}" }));
    expect(r.soft.filter((s) => /^(rust|go|workflow)-/.test(s.kind))).toEqual([]);
  });
});

describe("review follow-ups: build key removed, one signal per script, new-job wording", () => {
  const toml = (build?: string) => `[package]\nname = "x"\nversion = "1.0.0"\n${build === undefined ? "" : `build = ${build}\n`}`;
  const rs = "fn main() {}\n";
  test("a root build.rs that the manifest stops turning off, or stops passing over, starts running: it is raised", () => {
    for (const [from, to] of [["false", undefined], ['"tools/gen.rs"', undefined], ["false", '"build.rs"'], ["false", '"./build.rs"']] as const) {
      for (const dir of ["", "c/"]) {
        const o = files({ [`${dir}Cargo.toml`]: toml(from), [`${dir}build.rs`]: rs, [`${dir}tools/gen.rs`]: rs });
        const n = files({ [`${dir}Cargo.toml`]: toml(to), [`${dir}build.rs`]: rs, [`${dir}tools/gen.rs`]: rs });
        expect(ecosystemSignals(o, n).map((x) => [x.kind, x.path]), `${dir} ${from} -> ${to}`).toEqual([["rust-build-script-added", `${dir}build.rs`]]);
      }
    }
    const s = ecosystemSignals(files({ "Cargo.toml": toml("false"), "build.rs": rs }), files({ "Cargo.toml": toml(), "build.rs": rs }));
    expect(s[0]!.detail).toBe("build.rs now runs: Cargo.toml no longer turns the build script off");
  });
  test("no new signal when the root build.rs ran before too, is still off, or is not shipped", () => {
    const same = (from: string | undefined, to: string | undefined, extra: Record<string, string> = { "build.rs": rs }) =>
      ecosystemSignals(files({ "Cargo.toml": toml(from), ...extra }), files({ "Cargo.toml": toml(to), ...extra }));
    expect(same('"build.rs"', undefined)).toEqual([]);
    expect(same(undefined, '"build.rs"')).toEqual([]);
    expect(same("true", undefined)).toEqual([]);
    expect(same("false", "false")).toEqual([]);
    expect(same("false", undefined, { "src/lib.rs": rs })).toEqual([]);
    // A brand-new Cargo.toml has no old key to compare: as before, nothing for an unchanged build.rs.
    expect(ecosystemSignals(files({ "build.rs": rs }), files({ "Cargo.toml": toml(), "build.rs": rs }))).toEqual([]);
    // The line reader (a manifest the TOML parser refuses) reads build = false too.
    expect(ecosystemSignals(files({ "Cargo.toml": "[package]\nbuild = false\nx = [\n", "build.rs": rs }), files({ "Cargo.toml": "[package]\nx = [\n", "build.rs": rs })).map((x) => x.path)).toEqual(["build.rs"]);
  });
  test("one signal per script path, however many manifests newly name it", () => {
    for (const script of ["shared/gen.rs", "shared/t/build.rs"]) {
      const o: Record<string, string> = { [script]: rs };
      const n: Record<string, string> = { [script]: rs };
      for (const c of ["a", "b", "c"]) {
        o[`${c}/Cargo.toml`] = toml();
        n[`${c}/Cargo.toml`] = toml(`"../${script}"`);
      }
      expect(ecosystemSignals(files(o), files(n)).map((x) => [x.kind, x.path]), script).toEqual([["rust-build-script-added", script]]);
    }
  });
  test("a removed block and a new job with no block are worded apart", () => {
    const wf = (src: string) => files({ [WF]: src });
    const old = "on: push\njobs:\n  a:\n    runs-on: x\n    permissions:\n      contents: read\n";
    const nu = "on: push\njobs:\n  a:\n    runs-on: x\n  b:\n    runs-on: x\n";
    expect(ecosystemSignals(wf(old), wf(nu))).toEqual([{ kind: "workflow-permissions-widened", path: WF, detail: "permissions removed, default applies: job a; no permissions block, default applies: job b" }]);
    expect(permissionsRemoved(old, nu)).toEqual(["job a", "job b"]);
  });
});

describe("soft-signal misses: Go import forms, new jobs without a block, more triggers, a named build.rs, lone CR", () => {
  const go = (body: string) => files({ "main.go": `package main\n${body}\nfunc main() {}\n` });
  const cgo = (body: string) => kinds(ecosystemSignals(go(""), go(body)));
  test('import "C" under a name: _, . or an identifier, alone or in a group', () => {
    for (const b of ['import _ "C"', 'import . "C"', 'import c "C"', 'import (\n\t_ "C"\n)', 'import (\n\t"fmt"\n\tc "C"\n)', 'import ( _ "C" )'])
      expect(cgo(b), b).toEqual(["go-cgo-added"]);
  });
  test("no space where Go needs none: import\"C\", import.\"C\", a name glued to a raw `C`", () => {
    for (const b of ['import"C"', "import _`C`", "import .`C`", "import x`C`", 'import."C"', 'import(_"C")', 'import ("C"\n)', 'import ("fmt")\nimport(`C`)'])
      expect(cgo(b), b).toEqual(["go-cgo-added"]);
    // Not an import: another identifier ending in import, a selector, a string that holds the words.
    for (const b of ['reimport "C"', 'x.import "C"', 'var s = "import (\\"C\\")"', "var r = '\"'\nvar q = \"C\""])
      expect(cgo(b), b).toEqual([]);
  });
  test("the raw-string import path `C`", () => {
    expect(cgo("import `C`")).toEqual(["go-cgo-added"]);
    expect(cgo("import (\n\t`fmt`\n\t`C`\n)")).toEqual(["go-cgo-added"]);
    expect(cgo("var s = `\nimport \"C\"\n`")).toEqual([]);
  });
  test("a lone carriage return is a space in Go, not a line end", () => {
    expect(cgo('import ("C"\r)')).toEqual(["go-cgo-added"]);
    expect(cgo('import (\r"fmt"\r"C"\r)')).toEqual(["go-cgo-added"]);
    expect(cgo('import\r"C"')).toEqual(["go-cgo-added"]);
  });
  test('a backquote inside a comment or a string does not hide import "C"', () => {
    expect(cgo('// use `go build` here\nimport "C"\n// and `this`')).toEqual(["go-cgo-added"]);
    expect(cgo('/* a ` b */\nimport "C"\nvar x = "`"')).toEqual(["go-cgo-added"]);
    expect(cgo('var a = "`"\nimport "C"\nvar b = \'`\'')).toEqual(["go-cgo-added"]);
    // Still no import: in a comment, or in a string.
    expect(cgo('// import "C"')).toEqual([]);
    expect(cgo('/*\nimport "C"\n*/')).toEqual([]);
    expect(cgo('var s = "import \\"C\\""')).toEqual([]);
  });

  const wf = (src: string) => files({ [WF]: src });
  test("a new or renamed job with no permissions block, where every old job had one, falls back to the default", () => {
    const old = "on: push\njobs:\n  a:\n    runs-on: x\n    permissions:\n      contents: read\n";
    expect(ecosystemSignals(wf(old), wf(old + "  b:\n    runs-on: x\n"))).toEqual([{ kind: "workflow-permissions-widened", path: WF, detail: "no permissions block, default applies: job b" }]);
    expect(permissionsRemoved(old, "on: push\njobs:\n  c:\n    runs-on: x\n")).toEqual(["job c"]);
    // Not when an old job already ran on the default, or a workflow block covers the new job.
    const mixed = old + "  d:\n    runs-on: x\n";
    expect(permissionsRemoved(mixed, mixed + "  e:\n    runs-on: x\n")).toEqual([]);
    expect(permissionsRemoved(old, "on: push\npermissions: read-all\njobs:\n  c:\n    runs-on: x\n")).toEqual([]);
  });
  test("issues, discussion and discussion_comment are risky triggers", () => {
    for (const t of ["issues", "discussion", "discussion_comment"]) {
      expect(ecosystemSignals(wf("on: push\njobs: {}\n"), wf(`on: [push, ${t}]\njobs: {}\n`)), t).toEqual([{ kind: "workflow-trigger-added", path: WF, detail: `new trigger: ${t}` }]);
      expect([...workflowTriggers(`on:\n  ${t}:\n    types: [opened]\nbroken: [\n`)]).toEqual([t]);
    }
  });
  test("a Cargo.toml newly naming a build.rs that is shipped but not at the crate root", () => {
    const toml = (b = "") => `[package]\nname = "x"\n${b}`;
    const s = ecosystemSignals(files({ "Cargo.toml": toml(), "tools/build.rs": "fn main() {}" }), files({ "Cargo.toml": toml('build = "tools/build.rs"\n'), "tools/build.rs": "fn main() {}" }));
    expect(s).toEqual([{ kind: "rust-build-script-added", path: "tools/build.rs", detail: "new custom build script named in Cargo.toml; it runs at build time" }]);
    // The crate root's build.rs runs anyway; an already-named one unchanged is none; a new one is raised on its own path once.
    expect(ecosystemSignals(files({ "Cargo.toml": toml(), "build.rs": "a" }), files({ "Cargo.toml": toml('build = "build.rs"\n'), "build.rs": "a" }))).toEqual([]);
    const named = toml('build = "tools/build.rs"\n');
    expect(ecosystemSignals(files({ "Cargo.toml": named, "tools/build.rs": "a" }), files({ "Cargo.toml": named, "tools/build.rs": "a" }))).toEqual([]);
    expect(kinds(ecosystemSignals(files({ "Cargo.toml": toml() }), files({ "Cargo.toml": named, "tools/build.rs": "a" })))).toEqual(["rust-build-script-added"]);
    // Named and changed in the same release: one signal, from its own path. Two manifests newly naming it: one signal.
    expect(kinds(ecosystemSignals(files({ "Cargo.toml": toml(), "tools/build.rs": "a" }), files({ "Cargo.toml": named, "tools/build.rs": "b" })))).toEqual(["rust-build-script-changed"]);
    const sub = `[package]\nname = "y"\nbuild = "../tools/build.rs"\n`;
    expect(kinds(ecosystemSignals(files({ "Cargo.toml": toml(), "y/Cargo.toml": `[package]\nname = "y"\n`, "tools/build.rs": "a" }), files({ "Cargo.toml": named, "y/Cargo.toml": sub, "tools/build.rs": "a" })))).toEqual(["rust-build-script-added"]);
  });
  test("the YAML line reader splits on a lone carriage return", () => {
    const src = "on: push\rpermissions: write-all\rjobs:\r  a:\r    runs-on: x\rbroken: [\n";
    expect([...workflowWriteGrants(src)]).toEqual(["write-all"]);
    expect([...workflowTriggers("on:\r  - issues\r  - pull_request_target\rbroken: [\n")].sort()).toEqual(["issues", "pull_request_target"]);
  });
});

describe("soft follow-ups: a script added and changed, normalized paths, a build.rs back on and changed, short labels", () => {
  const toml = (build?: string) => `[package]\nname = "x"\nversion = "1.0.0"\n${build === undefined ? "" : `build = ${build}\n`}`;
  test("a shared script new to one manifest and changed under another is one signal, added, in either order", () => {
    for (const order of [["a", "b"], ["b", "a"]]) {
      const old: Record<string, string> = { "a/Cargo.toml": toml('"../shared/gen.rs"'), "b/Cargo.toml": toml(), "shared/gen.rs": "a" };
      const nu: Record<string, string> = {};
      for (const c of order) nu[`${c}/Cargo.toml`] = toml('"../shared/gen.rs"');
      nu["shared/gen.rs"] = "b";
      expect(ecosystemSignals(files(old), files(nu)), order.join()).toEqual([
        { kind: "rust-build-script-added", path: "shared/gen.rs", detail: "new custom build script named in b/Cargo.toml; it runs at build time" },
      ]);
    }
  });
  test("a build path is compared normalized: the same script written two ways is not new", () => {
    for (const dir of ["", "c/"])
      for (const from of ['"././gen/make.rs"', '"tools/../gen/make.rs"']) {
        const o = { [`${dir}Cargo.toml`]: toml(from), [`${dir}gen/make.rs`]: "a" };
        expect(ecosystemSignals(files(o), files({ ...o, [`${dir}Cargo.toml`]: toml('"gen/make.rs"') })), `${dir} ${from}`).toEqual([]);
        const s = ecosystemSignals(files(o), files({ [`${dir}Cargo.toml`]: toml('"gen/make.rs"'), [`${dir}gen/make.rs`]: "b" }));
        expect(s.map((x) => [x.kind, x.path]), `${dir} ${from}`).toEqual([["rust-build-script-changed", `${dir}gen/make.rs`]]);
      }
  });
  test("a build.rs that was turned off comes back changed: one added signal that says both, in either order", () => {
    for (const [from, why] of [["false", "no longer turns the build script off"], ['"tools/gen.rs"', "no longer names another build script"]] as const) {
      const o = files({ "Cargo.toml": toml(from), "build.rs": "a", "tools/gen.rs": "g" });
      for (const n of [files({ "Cargo.toml": toml(), "build.rs": "b", "tools/gen.rs": "g" }), files({ "build.rs": "b", "Cargo.toml": toml(), "tools/gen.rs": "g" })])
        expect(ecosystemSignals(o, n), from).toEqual([{ kind: "rust-build-script-added", path: "build.rs", detail: `build.rs now runs, changed: Cargo.toml ${why}` }]);
    }
    // A new build.rs is raised on its own path once, as before.
    expect(ecosystemSignals(files({ "Cargo.toml": toml("false") }), files({ "Cargo.toml": toml(), "build.rs": "b" }))).toEqual([{ kind: "rust-build-script-added", path: "build.rs", detail: "new build.rs; it runs at build time" }]);
  });
  test("added grants, a removed block and a new job with no block fit under the 160-character cut together", () => {
    const old = "on: push\njobs:\n  build:\n    runs-on: x\n    permissions:\n      contents: read\n";
    const nu = "on: push\njobs:\n  build:\n    runs-on: x\n  publish:\n    runs-on: x\n  release:\n    runs-on: x\n    permissions:\n      contents: write\n      packages: write\n";
    const detail = "write access added: contents write; packages write; permissions removed, default applies: job build; no permissions block, default applies: job publish";
    expect(detail.length).toBeLessThanOrEqual(160);
    expect(ecosystemSignals(files({ [WF]: old }), files({ [WF]: nu }))).toEqual([{ kind: "workflow-permissions-widened", path: WF, detail }]);
  });
});

describe("a list-form Cargo build key raises soft signals", () => {
  const head = (dir = "") => `[package]\nname = "${dir || "x"}"\nversion = "1.0.0"\n`;
  // Forms: the TOML parser reads each one, and again with a broken tail so only the line reader can.
  const FORMS: Record<string, string> = {
    double: `build = ["a.rs", "b.rs"]`,
    single: `build = ['a.rs', 'b.rs']`,
    spaced: `build   =   [   "a.rs"  ,  "b.rs"   ]`,
    trailing: `build = ["a.rs", "b.rs",]`,
    multiline: `build = [\n  "a.rs",\n  "b.rs",\n]`,
    commented: `build = [ # scripts\n  "a.rs", # first\n  # "c.rs",\n  "b.rs"\n]`,
    dotslash: `build = ["./a.rs", "./b.rs"]`,
  };
  const BREAK = "\n[dependencies]\nbroken = [\n";
  const run = (o: Record<string, string>, n: Record<string, string>) => ecosystemSignals(files(o), files(n)).map((x) => `${x.kind} ${x.path}`);
  for (const [name, form] of Object.entries(FORMS)) {
    for (const [mode, tail] of [["parser", ""], ["line reader", BREAK]] as const) {
      test(`held: ${name}, ${mode}: a new list with two new scripts`, () => {
        const nu = { "Cargo.toml": head() + form + "\n" + tail, "a.rs": "1", "b.rs": "2" };
        expect(run({ "Cargo.toml": head() }, nu)).toEqual(["rust-build-script-added Cargo.toml", "rust-build-script-added a.rs", "rust-build-script-added b.rs"]);
      });
    }
  }
  test("held: a list with one entry", () => {
    expect(run({ "Cargo.toml": head() }, { "Cargo.toml": head() + 'build = ["gen.rs"]\n', "gen.rs": "1" })).toEqual(["rust-build-script-added Cargo.toml", "rust-build-script-added gen.rs"]);
  });
  test("held: a list whose script changed (list itself the same)", () => {
    const t = head() + 'build = ["a.rs", "b.rs"]\n';
    expect(run({ "Cargo.toml": t, "a.rs": "1", "b.rs": "2" }, { "Cargo.toml": t, "a.rs": "1", "b.rs": "3" })).toEqual(["rust-build-script-changed b.rs"]);
  });
  test("held: a list that gains an entry is a changed list and an added script", () => {
    const o = { "Cargo.toml": head() + 'build = ["a.rs"]\n', "a.rs": "1" };
    expect(run(o, { ...o, "Cargo.toml": head() + 'build = ["a.rs", "b.rs"]\n', "b.rs": "2" })).toEqual(["rust-build-script-changed Cargo.toml", "rust-build-script-added b.rs"]);
  });
  test("held: a list newly added over unchanged scripts is the list signal only", () => {
    const f = { "a.rs": "1", "b.rs": "2" };
    expect(run({ "Cargo.toml": head(), ...f }, { "Cargo.toml": head() + 'build = ["a.rs", "b.rs"]\n', ...f })).toEqual(["rust-build-script-added Cargo.toml"]);
  });
  test("held: scripts in subdirectories, and a list in a workspace member", () => {
    expect(run({ "Cargo.toml": head() }, { "Cargo.toml": head() + 'build = ["./tools/a.rs", "gen/b.rs"]\n', "tools/a.rs": "1", "gen/b.rs": "2" })).toEqual([
      "rust-build-script-added Cargo.toml", "rust-build-script-added tools/a.rs", "rust-build-script-added gen/b.rs",
    ]);
    const m = head("m") + 'build = ["scripts/a.rs", "../shared/b.rs"]\n';
    expect(run({ "Cargo.toml": "[workspace]\nmembers = [\"crates/m\"]\n" }, { "Cargo.toml": "[workspace]\nmembers = [\"crates/m\"]\n", "crates/m/Cargo.toml": m, "crates/m/scripts/a.rs": "1", "crates/shared/b.rs": "2" })).toEqual([
      "rust-build-script-added crates/m/Cargo.toml", "rust-build-script-added crates/m/scripts/a.rs", "rust-build-script-added crates/shared/b.rs",
    ]);
  });
  test("held: a listed script named by two manifests is one signal", () => {
    const t = head() + 'build = ["../shared/a.rs"]\n';
    expect(run({ "m1/Cargo.toml": head(), "m2/Cargo.toml": head() }, { "m1/Cargo.toml": t, "m2/Cargo.toml": t, "shared/a.rs": "1" })).toEqual([
      "rust-build-script-added m1/Cargo.toml", "rust-build-script-added shared/a.rs", "rust-build-script-added m2/Cargo.toml",
    ]);
  });
  test("held: a build.rs listed on its own path is raised once, there", () => {
    const t = head() + 'build = ["build.rs", "a.rs"]\n';
    expect(run({ "Cargo.toml": head() }, { "Cargo.toml": t, "build.rs": "1", "a.rs": "2" })).toEqual(["rust-build-script-added Cargo.toml", "rust-build-script-added a.rs", "rust-build-script-added build.rs"]);
  });
  test("held: a string key moving to a list names the new script as added", () => {
    const o = { "Cargo.toml": head() + 'build = "a.rs"\n', "a.rs": "1", "b.rs": "2" };
    expect(run(o, { ...o, "Cargo.toml": head() + 'build = ["a.rs", "b.rs"]\n' })).toEqual(["rust-build-script-added Cargo.toml"]);
    expect(run(o, { ...o, "Cargo.toml": head() + 'build = ["a.rs", "b.rs"]\n', "b.rs": "3" })).toEqual(["rust-build-script-added Cargo.toml", "rust-build-script-added b.rs"]);
  });
  test("quiet: plain, default, off, unchanged list, entries missing from the tree", () => {
    expect(run({ "Cargo.toml": head() }, { "Cargo.toml": head() + 'build = "build.rs"\n', "build.rs": "1" })).toEqual(["rust-build-script-added build.rs"]);
    expect(run({ "Cargo.toml": head(), "build.rs": "1" }, { "Cargo.toml": head() + 'build = "build.rs"\n', "build.rs": "1" })).toEqual([]);
    expect(run({ "Cargo.toml": head(), "build.rs": "1" }, { "Cargo.toml": head(), "build.rs": "1" })).toEqual([]);
    expect(run({ "Cargo.toml": head() }, { "Cargo.toml": head() + "build = false\n", "build.rs": "1" })).toEqual(["rust-build-script-added build.rs"]);
    const t = head() + 'build = ["a.rs", "b.rs"]\n';
    const f = { "a.rs": "1", "b.rs": "2" };
    expect(run({ "Cargo.toml": t, ...f }, { "Cargo.toml": t, ...f })).toEqual([]);
    expect(run({ "Cargo.toml": t, ...f }, { "Cargo.toml": t.replace("1.0.0", "1.0.1"), ...f })).toEqual([]);
    expect(run({ "Cargo.toml": head() }, { "Cargo.toml": t })).toEqual([]);
    expect(run({ "Cargo.toml": head() }, { "Cargo.toml": head() + "build = []\n", "a.rs": "1" })).toEqual([]);
    // Same entries in another order and spelling: not a changed list.
    expect(run({ "Cargo.toml": t, ...f }, { "Cargo.toml": head() + 'build = ["./b.rs", "a.rs"]\n', ...f })).toEqual([]);
  });
  test("a list read by the line reader needs the package section", () => {
    expect(run({ "Cargo.toml": "[x]\n" }, { "Cargo.toml": '[dependencies]\nbuild = ["a.rs"]\nbroken = [\n', "a.rs": "1" })).toEqual([]);
  });
  test("cost: an unterminated or huge list stays linear in size", () => {
    const time = (n: number) => {
      const body = `[package]\nbuild = [\n${'  "a.rs", # c\n'.repeat(n)}\nbroken = [\n`;
      const f = { "Cargo.toml": body, "a.rs": "1" };
      const t = performance.now();
      ecosystemSignals(files({ "Cargo.toml": "[package]\n" }), files(f));
      return performance.now() - t;
    };
    time(1000);
    const small = Math.max(time(20_000), 1);
    const big = time(160_000);
    // 8x the input: linear is about 8x; a quadratic reader would be about 64x.
    expect(big / small, `${small.toFixed(0)} ms -> ${big.toFixed(0)} ms`).toBeLessThan(24);
    expect(big).toBeLessThan(5000);
  });
});
