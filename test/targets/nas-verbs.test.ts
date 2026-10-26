// The NAS verb table: every slot rule anchored, the OS plugin refused in any case, and the caps and deadlines of CRB-b128 §2.2.
import { describe, expect, test } from "bun:test";
import { checkSlots, isOsPlugin, READ_VERBS, SLOT, WRITE_VERBS } from "../../src/targets/nas/verbs.ts";

const ID = `sha256:${"a".repeat(64)}`;

describe("nas verbs", () => {
  test("valid slots pass", () => {
    expect(checkSlots("self", {})).toBeUndefined();
    expect(checkSlots("image.evidence", { id: ID })).toBeUndefined();
    expect(checkSlots("image.candidate", { ref: "registry.example/team/app:1.2" })).toBeUndefined();
    expect(checkSlots("plugin.file", { plugin: "example.plugin", which: "new", copy: "Ab12Cd34" })).toBeUndefined();
  });

  test.each([
    ["a ref with a space", "image.candidate", { ref: "app latest" }],
    ["a ref with a shell expansion", "image.candidate", { ref: "app$(id)" }],
    ["a ref with a newline", "image.candidate", { ref: "app\n__OUP_RC=0" }],
    ["a ref with a semicolon", "image.candidate", { ref: "app;reboot" }],
    ["an uppercase ref", "image.candidate", { ref: "App:1" }],
    ["a short id", "image.evidence", { id: "sha256:abc" }],
    ["an id with no prefix", "image.evidence", { id: "a".repeat(64) }],
    ["a copy that is too short", "plugin.file", { plugin: "p", which: "old", copy: "ab" }],
    ["which outside old|new", "plugin.file", { plugin: "p", which: "both", copy: "Ab12Cd34" }],
  ] as const)("%s is refused (Review Focus 2)", (_what, verb, slots) => {
    expect(checkSlots(verb, slots as Record<string, string>)).toContain("is not valid");
  });

  test("a missing or extra slot is refused", () => {
    expect(checkSlots("image.evidence", {})).toBe("image.evidence takes slots id");
    expect(checkSlots("self", { ref: "app" })).toBe("self takes slots none");
    expect(checkSlots("image.evidence", { id: ID, ref: "app" })).toBe("image.evidence takes slots id");
  });

  test("the OS plugin is never a slot value, in any case (Review Focus 2)", () => {
    for (const p of ["unRAIDServer", "unraidserver-7.1", "UNRAIDSERVER"]) {
      expect(isOsPlugin(p)).toBe(true);
      expect(checkSlots("plugin.file", { plugin: p, which: "old", copy: "Ab12Cd34" })).toBe(`plugin.file: plugin ${p} is the OS, never touched`);
    }
    expect(isOsPlugin("example.plugin")).toBe(false);
  });

  test("every rule is anchored", () => {
    for (const re of Object.values(SLOT)) expect(re.source.startsWith("^") && re.source.endsWith("$")).toBe(true);
  });

  test("caps and deadlines are the design's", () => {
    expect(READ_VERBS.self).toEqual({ slots: [], capBytes: 4096, deadlineS: 10 });
    expect(READ_VERBS["compose.state"]).toEqual({ slots: [], capBytes: 16384, deadlineS: 30 });
    expect(READ_VERBS["image.evidence"]).toEqual({ slots: ["id"], capBytes: 65536, deadlineS: 30 });
    expect(READ_VERBS["image.candidate"]).toEqual({ slots: ["ref"], capBytes: 65536, deadlineS: 60 });
    expect(READ_VERBS["plugin.check"]).toEqual({ slots: [], capBytes: 65536, deadlineS: 180 });
    expect(READ_VERBS["plugin.file"]).toEqual({ slots: ["plugin", "which", "copy"], capBytes: 352 * 1024, deadlineS: 10 });
    expect(READ_VERBS["os.version"]).toEqual({ slots: [], capBytes: 1024, deadlineS: 5 });
    expect(WRITE_VERBS).toEqual({ "compose.apply": { deadlineS: 1500 }, "image.prune": { deadlineS: 120 }, "plugin.update": { deadlineS: 600 } });
  });
});
