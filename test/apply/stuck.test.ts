// Ported from secure-update's stuck-tracking and pin cases (test/port/04 and the pin rule, §9b).
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { heldFromPinned, pinFilter, readPinFiles } from "../../src/apply/pins.ts";
import { pendingFromOutdated, trackStuck } from "../../src/apply/stuck.ts";

const T = { today: "2026-10-22", after: 3 };

describe("trackStuck", () => {
  test("a target identity is literal, and a changed target starts a fresh count", () => {
    let s = trackStuck("", "brew", ["app=1x2"], T).state;
    s = trackStuck(s, "brew", ["app=1.2"], T).state;
    expect(s).toBe("brew\tapp=1.2\t1\t2026-10-22\n");
  });
  test("counts consecutive runs, keeps the first date, reports at the threshold", () => {
    let r = trackStuck("brew\tapp=1.1\t2\t2026-10-20\n", "brew", ["app=1.1", "new=2"], T);
    expect(r.state).toBe("brew\tapp=1.1\t3\t2026-10-20\nbrew\tnew=2\t1\t2026-10-22\n");
    expect(r.stuck).toEqual(["app=1.1(3 runs, since 2026-10-20)"]);
    r = trackStuck(r.state, "brew", ["app=1.1"], T);
    expect(r.stuck).toEqual(["app=1.1(4 runs, since 2026-10-20)"]);
  });
  test("completed items clear, and other lanes are carried through untouched", () => {
    const r = trackStuck("npm\tnpm=1.0\t2\tyesterday\nbrew\tapp=1.1\t2\t2026-10-21\n", "brew", [], T);
    expect(r).toEqual({ state: "npm\tnpm=1.0\t2\tyesterday\n", stuck: [] });
  });
  test("excluded items are never counted", () => {
    expect(trackStuck("", "brew", ["zoom"], { ...T, exclude: ["zoom"] }).state).toBe("");
  });
  test("a malformed count restarts at one", () => {
    expect(trackStuck("brew\tapp=1\tx\t\n", "brew", ["app=1"], T).state).toBe("brew\tapp=1\t1\t2026-10-22\n");
  });
});

describe("pendingFromOutdated", () => {
  const json = JSON.stringify({
    formulae: [{ name: "duckdb", current_version: "2.0.0" }, { name: "example/svc/svc", current_version: "HEAD" }, { name: "git", current_version: "2.52" }],
    casks: [{ token: "brave-browser", current_version: "1.99" }, { token: "zoom", current_version: "7" }, { token: "app", current_version: "1.1" }],
  });
  test("records name=target for everything not held; held names match in full or by last segment", () => {
    expect(pendingFromOutdated(json, ["zoom", "brave-browser", "svc", "duckdb"])).toEqual(["git=2.52", "app=1.1"]);
  });
  for (const [label, text] of [
    ["not JSON", "{oops"],
    ["no casks array", JSON.stringify({ formulae: [] })],
    ["null", "null"],
    ["a name with a space", JSON.stringify({ formulae: [{ name: "a b", current_version: "1" }], casks: [] })],
    ["no target version", JSON.stringify({ formulae: [{ name: "a" }], casks: [] })],
    ["a non-object item", JSON.stringify({ formulae: [null], casks: [] })],
  ] as const) {
    test(`a malformed answer (${label}) is a failed query, not an empty list`, () => expect(pendingFromOutdated(text, [])).toBeUndefined());
  }
  test("pinFilter's PINNED entries, piped straight in, hold a tap formula that brew lists by its short name", () => {
    const pins = pinFilter("brew", ["example/svc/svc", "git"], { files: [{ repo: "r", path: "/r/pins.json", text: `{"brew":{"svc":"1"}}` }] }).pinned;
    expect(heldFromPinned(pins)).toEqual(["example/svc/svc", "svc"]);
    const out = JSON.stringify({ formulae: [{ name: "svc", current_version: "1" }, { name: "git", current_version: "2" }], casks: [] });
    expect(pendingFromOutdated(out, heldFromPinned(pins))).toEqual(["git=2"]);
  });
  test("held tools never count as stuck (the pin rule)", () => {
    const pending = pendingFromOutdated(json, ["zoom", "brave-browser", "example/svc/svc", "svc", "duckdb"])!;
    expect(trackStuck("", "brew", pending, { ...T, after: 1 }).stuck).toEqual(["git=2.52(1 runs, since 2026-10-22)", "app=1.1(1 runs, since 2026-10-22)"]);
  });
});

describe("pinFilter", () => {
  const files = (pins: string) => [{ repo: "example-repo", path: "/repos/example-repo/pins.json", text: pins }];
  test("brew-pinned and repo-pinned formulae are held, the rest kept", () => {
    const r = pinFilter("brew", ["duckdb", "git", "ripgrep", "example/svc/svc"], { brewPinned: ["ripgrep"], files: files(`{"brew": {"duckdb": "1.5.5"}}`) });
    expect(r).toEqual({ kept: ["git", "example/svc/svc"], pinned: ["duckdb(example-repo)", "ripgrep(brew pin)"], warnings: [] });
  });
  test("a repo pin on a cask holds the cask; brew pins never apply to casks", () => {
    const r = pinFilter("cask", ["brave-browser", "ripgrep", "zoom"], { brewPinned: ["ripgrep"], files: files(`{"cask": {"brave-browser": "1.97"}}`) });
    expect(r).toMatchObject({ kept: ["ripgrep", "zoom"], pinned: ["brave-browser(example-repo)"] });
  });
  test("a tap-qualified name matches its pin by last segment", () => {
    expect(pinFilter("brew", ["example/svc/svc", "git"], { files: files(`{"brew": {"svc": "0.7.0"}}`) })).toMatchObject({ kept: ["git"], pinned: ["example/svc/svc(example-repo)"] });
  });
  test("an unreadable pins.json is reported, holds nothing, never aborts", () => {
    const r = pinFilter("brew", ["duckdb", "git"], { files: files("{not json") });
    expect(r).toEqual({ kept: ["duckdb", "git"], pinned: [], warnings: ["WARNING: /repos/example-repo/pins.json: pins.json unreadable, holds nothing"] });
  });
  test("a pins.json of null, an array or unreadable text holds nothing and warns", () => {
    for (const text of ["null", "[1]", undefined]) {
      const r = pinFilter("brew", ["duckdb"], { files: [{ repo: "r", path: "/r/pins.json", text }] });
      expect(r).toEqual({ kept: ["duckdb"], pinned: [], warnings: ["WARNING: /r/pins.json: pins.json unreadable, holds nothing"] });
    }
  });
  test("the first holder wins: a brew pin is named before a repo pin, earlier repos before later ones", () => {
    const r = pinFilter("brew", ["duckdb"], { brewPinned: ["duckdb"], files: [...files(`{"brew": {"duckdb": "1"}}`), { repo: "other", path: "/x", text: `{"brew": {"duckdb": "2"}}` }] });
    expect(r.pinned).toEqual(["duckdb(brew pin)"]);
  });
});

describe("readPinFiles", () => {
  const root = mkdtempSync(join(tmpdir(), "oupdate-pins-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  test("reads <root>/<repo>/pins.json one level down, in name order; missing roots and repos without one are skipped", () => {
    mkdirSync(join(root, "a", "b"), { recursive: true });
    mkdirSync(join(root, "z"), { recursive: true });
    mkdirSync(join(root, "m"), { recursive: true });
    writeFileSync(join(root, "z", "pins.json"), "{}");
    writeFileSync(join(root, "a", "b", "pins.json"), "{}");
    writeFileSync(join(root, "m", "pins.json"), `{"brew":{}}`);
    mkdirSync(join(root, ".hid"), { recursive: true });
    writeFileSync(join(root, ".hid", "pins.json"), `{"brew":{"x":"1"}}`);
    const got = readPinFiles([join(root, "missing"), root]);
    expect(got.map((f) => f.repo)).toEqual(["m", "z"]);
    expect(got[0]).toEqual({ repo: "m", path: join(root, "m", "pins.json"), text: `{"brew":{}}` });
  });
});
