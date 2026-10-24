// The deterministic formula gates, ported from secure-update's helpers (test/port/02, section 2b).
import { describe, expect, test } from "bun:test";
import { artifactKind, formulaDeps, formulaUrls, loadsOtherFiles, supportFilesChanged, urlOrigin } from "../../src/apply/formula-gates.ts";

const PREBUILT = "https://github.com/example/tool/releases/download/v1.1/tool-darwin-arm64.tar.gz";
const SOURCE = "https://github.com/example/tool/archive/refs/tags/v1.1.tar.gz";

describe("formulaUrls", () => {
  test("top-level urls, including on_arm blocks; not resource, patch, head or livecheck blocks", () => {
    const rb = `class Tool < Formula
  url "${PREBUILT}"
  on_arm do
    url '${SOURCE}'
  end
  resource "extra" do
    url "https://elsewhere.example/x.tar.gz"
  end
  head do
    url "https://github.com/example/tool.git"
  end
  livecheck do
    url :stable
  end
  patch do
    url "https://patches.example/p.diff"
  end
  url("https://mirror.example/tool.tgz")
end`;
    expect(formulaUrls(rb)).toEqual([PREBUILT, SOURCE, "https://mirror.example/tool.tgz"]);
  });
  test("an empty url is dropped", () => {
    expect(formulaUrls(`  url ""\n  url "${PREBUILT}"`)).toEqual([PREBUILT]);
  });
  test("a nested do block inside a skipped block is skipped too", () => {
    const rb = `  resource "a" do\n    on_arm do\n      url "https://x.example/a"\n    end\n    url "https://x.example/b"\n  end\n  url "${PREBUILT}"`;
    expect(formulaUrls(rb)).toEqual([PREBUILT]);
  });
});

describe("urlOrigin", () => {
  for (const [url, want] of [
    [PREBUILT, "github.com/example/tool"],
    ["https://codeload.github.com/Example/Tool.git/tar.gz/v1", "github.com/example/tool"],
    ["https://www.github.com/example/tool/archive/v1.tar.gz?x=1", "github.com/example/tool"],
    ["https://releases.example.com/tool/1.0/tool.zip", "releases.example.com/tool"],
    ["https://Releases.Example.com", "releases.example.com/"],
    ["https://github.com/foo", "github.com/foo/foo"],
  ] as const) {
    test(`${url} → ${want}`, () => expect(urlOrigin(url)).toBe(want));
  }
});

describe("formulaDeps", () => {
  test("depends_on and uses_from_macos in either quote style, with or without parentheses; symbols are not formulae", () => {
    const rb = `  depends_on "openssl@3"\n  depends_on 'evil/tap/x'\n  depends_on("xz")\n  uses_from_macos "zlib"\n  depends_on :macos\n  depends_on xcode: :build\n  depends_on "openssl@3" => :build`;
    expect(formulaDeps(rb)).toEqual(["evil/tap/x", "openssl@3", "xz", "zlib"]);
  });
});

describe("artifactKind", () => {
  for (const [url, want] of [
    [PREBUILT, "prebuilt"],
    [SOURCE, "source"],
    ["https://x.example/tool.tar.xz", "source"],
    ["https://x.example/tool.tgz", "source"],
    ["https://github.com/example/tool.git", "source"],
    ["https://x.example/tool.zip", "prebuilt"],
    ["https://x.example/tool.dmg", "prebuilt"],
    ["https://x.example/tool.pkg", "prebuilt"],
    ["https://x.example/tool-1.0.arm64_sonoma.bottle.tar.gz", "source"],
    ["https://x.example/tool.bottle.json", "prebuilt"],
    ["https://x.example/tool", "source"],
  ] as const) {
    test(`${url} → ${want}`, () => expect(artifactKind(url)).toBe(want));
  }
});

describe("supportFilesChanged", () => {
  test("formulae, casks and docs are fine; anything else brew may load is named", () => {
    expect(
      supportFilesChanged([
        "Formula/tool.rb", "HomebrewFormula/x.rb", "Casks/app.rb", ".github/workflows/ci.yml", "README.md", "docs/a.md", "LICENSE", "LICENSE.txt",
        "cmd/evil.rb", "tap_migrations.json", "formula_renames.json", "scripts/post.sh", "Aliases/tool", "LICENSE.rb", "",
      ]),
    ).toEqual(["cmd/evil.rb", "tap_migrations.json", "formula_renames.json", "scripts/post.sh", "Aliases/tool", "LICENSE.rb"]);
  });
});

describe("loadsOtherFiles", () => {
  for (const line of [
    `  require_relative "helper"`, `  Kernel.require "json"`, `  load "x.rb"`, `  instance_eval IO.read("#{__FILE__}/../x.rb")`,
    `  LIST = File.readlines(buildpath/"x")`, `  HELPER = Pathname.new("x")`, `  eval "1"`, `  class_eval File.binread(File.dirname(__FILE__)+"/x")`,
    `  module_eval(IO.binread(x))`, `  send(:require, x)`, `  File.foreach("x") { }`, `  p __dir__`,
  ]) {
    test(`reads other files: ${line.trim()}`, () => expect(loadsOtherFiles(`class Tool < Formula\n${line}\nend`)).toBe(true));
  }
  test("an ordinary formula does not", () => {
    expect(loadsOtherFiles(`class Tool < Formula\n  url "${PREBUILT}"\n  def install\n    bin.install "tool"\n  end\n  def post_install\n    (var/"tool").mkpath\n  end\nend`)).toBe(false);
  });
});
