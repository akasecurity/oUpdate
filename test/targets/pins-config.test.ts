// The pin-bump leg's config: strict keys, safe templates, a branch prefix that can never name the base,
// and every pins key named exactly once.
import { describe, expect, test } from "bun:test";
import { groupKeys, parsePinBumpLeg, type PinBumpLeg } from "../../src/targets/pins/config.ts";

const LEG = () => ({
  kind: "pin-bump",
  pinsPath: "img/pins.env",
  branchPrefix: "oupdate/",
  proposalDir: "/asks",
  groups: [
    { source: "npm", name: "cli", package: "@scope/cli", versionKey: "CLI_VERSION", integrity: { CLI_INTEGRITY: "@scope/cli@{v}", CLI_PLAT: "@scope/cli@{v}-linux-x64" } },
    { source: "github-release", name: "tool", repo: "example/tool", tag: "v{v}", versionKey: "TOOL_VERSION", assets: { TOOL_SHA256_X64: "tool_{v}_linux_amd64.tar.gz" }, propose: false, note: "coupled" },
    { source: "oci-index", name: "base", registry: "docker-hub", repository: "library/sample", tagKey: "IMAGE_TAG", digestKey: "IMAGE_DIGEST", snapshot: { key: "APT_SNAPSHOT", base: "https://snapshot.example.com/ubuntu", suite: "noble" } },
  ],
  fixed: ["PROJECT"],
  notChecked: { LATER: "no source yet" },
});
const P = (over: Record<string, unknown> = {}) => parsePinBumpLeg({ ...LEG(), ...over }, "leg");

describe("parsePinBumpLeg", () => {
  test("parses a full leg with defaults", () => {
    const l: PinBumpLeg = P();
    expect(l.push).toBe(false);
    expect(l.cooldownDays).toBe(2);
    expect(l.author).toEqual({ name: "oupdate", email: "oupdate@invalid" });
    expect(l.groups[0]).toMatchObject({ source: "npm", propose: true });
    expect(l.groups[1]).toMatchObject({ source: "github-release", propose: false, note: "coupled" });
    expect(l.fixed).toEqual(["PROJECT"]);
    expect(l.notChecked).toEqual({ LATER: "no source yet" });
  });

  test("groupKeys lists every key a group reads or writes", () => {
    const l = P();
    expect(l.groups.map(groupKeys)).toEqual([["CLI_VERSION", "CLI_INTEGRITY", "CLI_PLAT"], ["TOOL_VERSION", "TOOL_SHA256_X64"], ["IMAGE_TAG", "IMAGE_DIGEST", "APT_SNAPSHOT"]]);
  });

  test("an unknown key is an error, at the leg and in a group", () => {
    expect(() => P({ pushh: true })).toThrow("leg: unknown key pushh");
    const g = LEG().groups;
    expect(() => P({ groups: [{ ...g[0], extra: 1 }] })).toThrow("leg.groups[0]: unknown key extra");
  });

  // Review Focus 2: no prefix can make a branch name equal to, or above, the base branch.
  test.each(["main", "oupdate", "../", "Oupdate/", "a//", "/x/", "oupdate/../", "oup..date/", "a/b..c/"])("refuses the branch prefix %p", (p) => {
    expect(() => P({ branchPrefix: p })).toThrow('leg.branchPrefix must be lowercase segments ending in "/"');
  });

  test.each(["/abs/pins.env", "../pins.env", "img/../pins.env", "img//pins.env", "./pins.env", "img/pins env"])("refuses the pins path %p", (p) => {
    expect(() => P({ pinsPath: p })).toThrow("leg.pinsPath must be a path inside the repository");
  });

  test("proposalDir must be absolute", () => {
    expect(() => P({ proposalDir: "asks" })).toThrow("leg.proposalDir must be an absolute path");
  });

  test("a key named twice anywhere is an error", () => {
    expect(() => P({ fixed: ["PROJECT", "CLI_VERSION"] })).toThrow("leg: CLI_VERSION is named by group cli and fixed");
    expect(() => P({ notChecked: { PROJECT: "x" } })).toThrow("leg: PROJECT is named by fixed and notChecked");
  });

  test("two groups with one name is an error", () => {
    const g = LEG().groups;
    expect(() => P({ groups: [g[0], { ...g[1], name: "cli" }] })).toThrow("leg: two groups are named cli");
  });

  test("templates must carry {v} where a version belongs", () => {
    const g = LEG().groups;
    expect(() => P({ groups: [{ ...g[0], integrity: { CLI_INTEGRITY: "@scope/cli@1.0.0" } }] })).toThrow('leg.groups[0].integrity["CLI_INTEGRITY"] is not valid');
    expect(() => P({ groups: [{ ...g[1], tag: "latest" }] })).toThrow("leg.groups[0].tag is not valid");
    expect(() => P({ groups: [{ ...g[1], assets: { TOOL_SHA256_X64: "tool_{x}.tgz" } }] })).toThrow('leg.groups[0].assets["TOOL_SHA256_X64"] is not valid');
    expect(() => P({ groups: [{ ...g[1], assets: {} }] })).toThrow("leg.groups[0].assets must name at least one pinned asset hash");
  });

  test("only docker-hub is read so far, and the source must be known", () => {
    const g = LEG().groups;
    expect(() => P({ groups: [{ ...g[2], registry: "quay" }] })).toThrow('leg.groups[0].registry must be "docker-hub"');
    expect(() => P({ groups: [{ source: "pypi", name: "x" }] })).toThrow("leg.groups[0].source must be npm, github-release or oci-index");
  });

  test("groups must be non-empty and keys must be PIN_KEY shaped", () => {
    expect(() => P({ groups: [] })).toThrow("leg.groups must be a non-empty array");
    expect(() => P({ fixed: ["lower"] })).toThrow("leg.fixed must be an array of valid non-empty strings");
  });

  test("author, push and cooldownDays are read when given", () => {
    const l = P({ author: { name: "bot", email: "bot@example.com" }, push: true, cooldownDays: 3 });
    expect(l).toMatchObject({ author: { name: "bot", email: "bot@example.com" }, push: true, cooldownDays: 3 });
    expect(() => P({ cooldownDays: -1 })).toThrow("leg.cooldownDays must be a number >= 0");
  });
});
