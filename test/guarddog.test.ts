import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { guarddogScanner, parseGuardDog } from "../src/adapters/scanner/guarddog.ts";
import { parseScannerSpec } from "../src/adapters/scanner/spec.ts";
import type { FileMap } from "../src/prepass.ts";

const enc = (s: string) => new TextEncoder().encode(s);
const files = (o: Record<string, string>): FileMap => new Map(Object.entries(o).map(([k, v]) => [k, enc(v)]));
const fake = join(import.meta.dir, "fixtures/fake-guarddog.ts");

describe("parseGuardDog", () => {
  test("real sandbox output: one finding per matched location, empty rules ignored", () => {
    const out = readFileSync(join(import.meta.dir, "fixtures/guarddog-npm-probe.json"), "utf8");
    const f = parseGuardDog(out);
    expect(f.map((x) => x.rule).sort()).toEqual(["capability-network-lolbas", "capability-process-spawn", "threat-process-download-exec", "threat-runtime-obfuscation-base64exec"]);
    expect(f.every((x) => x.path === "i.js")).toBe(true);
    expect(f.find((x) => x.rule === "capability-network-lolbas")!.detail).toContain("curl http://");
  });

  test("a metadata rule hit (string or non-empty object) is a package-level finding", () => {
    const f = parseGuardDog(JSON.stringify({ results: { "typosquatting": "close to react", "empty_information": { message: "no description" }, "x": {} }, errors: {} }));
    expect(f).toEqual([
      { rule: "typosquatting", path: "", detail: "close to react" },
      { rule: "empty_information", path: "", detail: "no description" },
    ]);
  });

  test("strips the scanned dir prefix and keeps a path with a colon", () => {
    const f = parseGuardDog(JSON.stringify({ results: { r: [{ location: "/scan/lib/a:b.js:12", message: "m" }] }, errors: {} }), "/scan");
    expect(f[0]!.path).toBe("lib/a:b.js");
  });

  test("rule errors and non-JSON output are errors, not a clean scan", () => {
    expect(() => parseGuardDog(JSON.stringify({ results: {}, errors: { "r": "semgrep missing" } }))).toThrow(/rule error/);
    expect(() => parseGuardDog("Traceback ...")).toThrow(/JSON/);
    expect(() => parseGuardDog(JSON.stringify({ errors: {} }))).toThrow(/results/);
  });
});

describe("guarddogScanner", () => {
  test("runs argv with {eco} and {dir} filled in, on a copy of the files, and cleans up", async () => {
    const root = mkdtempSync(join(import.meta.dir, ".gd-"));
    try {
      const s = guarddogScanner({ name: "guarddog", argv: ["bun", fake, "{eco}", "{dir}"], workRoot: root });
      const f = await s.scan("npm", files({ "a.js": "ok", "lib/b.js": "eval(x)" }));
      expect(f).toEqual([{ rule: "threat-runtime-eval", path: "lib/b.js", detail: "eval in npm: eval(" }]);
      expect(readdirSync(root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a non-zero exit or a timeout throws", async () => {
    const root = mkdtempSync(join(import.meta.dir, ".gd-"));
    try {
      await expect(guarddogScanner({ name: "g", argv: ["bun", fake, "{eco}", "{dir}", "fail"], workRoot: root }).scan("pypi", files({ "a.py": "1" }))).rejects.toThrow(/exit 3: boom/);
      await expect(guarddogScanner({ name: "g", argv: ["bun", fake, "{eco}", "{dir}", "hang"], workRoot: root, timeoutMs: 300 }).scan("pypi", files({ "a.py": "1" }))).rejects.toThrow(/timed out/);
      expect(readdirSync(root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("parseScannerSpec", () => {
  test("accepts a guarddog spec and refuses bad ones", () => {
    expect(parseScannerSpec('{"type":"guarddog","name":"guarddog","argv":["docker","run","{dir}"],"workRoot":"w","stripPrefix":"/scan"}').argv).toEqual(["docker", "run", "{dir}"]);
    expect(() => parseScannerSpec("nope")).toThrow(/--scanner must be JSON/);
    expect(() => parseScannerSpec('{"type":"semgrep","name":"x","argv":["a"]}')).toThrow(/type must be guarddog/);
    expect(() => parseScannerSpec('{"type":"guarddog","name":"x","argv":[]}')).toThrow(/argv/);
    expect(() => parseScannerSpec('{"type":"guarddog","argv":["a"]}')).toThrow(/name/);
    expect(() => parseScannerSpec('{"type":"guarddog","name":"x","argv":["a"],"timeoutMs":"5"}')).toThrow(/timeoutMs/);
  });
});
