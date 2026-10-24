import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { materialize } from "../src/adapters/scanner/guarddog.ts";
import { newFindings } from "../src/adapters/scanner/types.ts";
import type { FileMap } from "../src/prepass.ts";

const enc = (s: string) => new TextEncoder().encode(s);
const files = (o: Record<string, string>): FileMap => new Map(Object.entries(o).map(([k, v]) => [k, enc(v)]));

describe("materialize", () => {
  test("writes every file under the dir, world-readable for the sandbox user", () => {
    const root = mkdtempSync(join(import.meta.dir, ".mat-"));
    try {
      const dir = join(root, "pkg");
      materialize(files({ "a.py": "x", "lib/b/c.js": "y" }), dir);
      expect(readFileSync(join(dir, "lib/b/c.js"), "utf8")).toBe("y");
      expect(statSync(join(dir, "a.py")).mode & 0o004).toBe(0o004);
      expect(statSync(join(dir, "lib/b")).mode & 0o005).toBe(0o005);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("refuses a path that leaves the dir, and writes nothing", () => {
    const root = mkdtempSync(join(import.meta.dir, ".mat-"));
    try {
      for (const bad of ["../x", "a/../../x", "/etc/x", "C:/x"]) {
        expect(() => materialize(files({ "ok.py": "1", [bad]: "2" }), join(root, "p"))).toThrow(/unsafe/);
      }
      expect(existsSync(join(root, "x"))).toBe(false);
      expect(existsSync(join(root, "p"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("newFindings", () => {
  test("keeps rule+path pairs found only in the new version; line numbers do not matter", () => {
    const old = [{ rule: "exec-base64", path: "a.py", detail: "a.py:3" }];
    const now = [
      { rule: "exec-base64", path: "a.py", detail: "a.py:9" },
      { rule: "exfiltrate-sensitive-data", path: "a.py", detail: "a.py:20" },
      { rule: "exec-base64", path: "b.py", detail: "b.py:1" },
    ];
    expect(newFindings(old, now).map((f) => `${f.rule} ${f.path}`)).toEqual(["exfiltrate-sensitive-data a.py", "exec-base64 b.py"]);
  });
});
