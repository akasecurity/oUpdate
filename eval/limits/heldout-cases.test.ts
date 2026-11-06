import { expect, test } from "bun:test";
import { HELDOUT } from "./heldout-cases.ts";
import models from "./models.json";

const text = (f: Map<string, Uint8Array>, k: string) => new TextDecoder().decode(f.get(k)!);
const byId = (id: string) => HELDOUT.find((c) => c.id === id)!;
/** Limits: only lowercase hex in double quotes is decoded (any other encoding, such as base64, is not). The file text plus every hex string literal decoded and put back in quotes (a bare hostname then reads as a quoted one). Entries under 8 hex characters are skipped. */
const unpacked = (s: string) => s + "\n" + (s.match(/"[0-9a-f]{8,}"/g) ?? []).map((h) => `"${Buffer.from(h.slice(1, -1), "hex").toString("latin1")}"`).join("\n");
// File names the guard skips: only these extensions. sh and md are not here because they are real country-code
// domains; a fixture that quotes a file name ending in either must be renamed or checked as a host.
const FILE_EXT = /\.(js|cjs|mjs|json|ts|gyp|npmrc|txt|out)$/;
// A quoted four-part number such as "1.2.3.4" counts as an address, not a version; three-part versions are skipped.
const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;
const hostsIn = (s: string) => [
  ...(s.match(/https?:\/\/[^\s"'`/\\]+/g) ?? []),
  ...[...s.matchAll(/["'`]([a-z0-9-]+(?:\.[a-z0-9-]+)+)["'`]/g)].map((m) => m[1]!).filter((t) => !FILE_EXT.test(t) && (IPV4.test(t) || !/^\d+(\.\d+)+$/.test(t))),
];
// Words a keyword scan would key on; in the two obfuscated payloads they may only appear after the table is decoded.
const PLAIN = ["child_process", ".npmrc", ".ssh", "readFileSync", "POST", "stage.example", "execFile", "spawn"];

test("every held-out case is a dated attack with a source page and only .example addresses", () => {
  expect(new Set(HELDOUT.map((c) => c.id)).size).toBe(HELDOUT.length);
  for (const c of HELDOUT) {
    expect(c.kind, c.id).toBe("attack");
    expect(c.expect, c.id).toBe("hold");
    expect(c.disclosed, c.id).toMatch(/^\d{4}-\d\d-\d\d$/);
    // run.ts counts a case as held out only when it was disclosed after the reviewer cutoff
    expect(c.disclosed > models.reviewer.cutoff, c.id).toBe(true);
    expect(c.source, c.id).toMatch(/^https:\/\/\S+$/);
    for (const p of [...c.base, ...c.head]) for (const [k, v] of p.files) {
      const body = unpacked(new TextDecoder().decode(v));
      for (const host of hostsIn(body)) expect(host.replace(/^https?:\/\//, ""), `${c.id} ${k}`).toMatch(/\.example$/);
      for (const m of body.matchAll(/github:([\w.-]+)\//g)) expect(m[1], `${c.id} ${k}`).toBe("example-org");
    }
  }
});

test("the host guard sees a hex-encoded real hostname", () => {
  const hex = Buffer.from("sh.evil.com").toString("hex");
  expect(hostsIn(unpacked(`const t = ["${hex}"];`))).toEqual(["sh.evil.com"]);
  expect(hostsIn(unpacked(`const t = ["${Buffer.from("see https://up.evil.com/c now").toString("hex")}"];`))).toContain("https://up.evil.com");
});

test("the host guard sees a quoted bare hostname and ignores file names with known extensions", () => {
  expect(hostsIn(`x("sh.stage.example"); y("ipc.cjs"); z("1.2.3"); w("evil.test")`)).toEqual(["sh.stage.example", "evil.test"]);
  expect(hostsIn(`x("203.0.113.7"); y("1.2.3")`)).toEqual(["203.0.113.7"]);
  expect(hostsIn(`x("run.sh"); y("go.md")`)).toEqual(["run.sh", "go.md"]);
});

test("node-ipc style: no install hook, main loads the bundle, the payload is appended after module.exports", () => {
  const c = byId("node-ipc-style-appended-require-payload");
  expect(c.disclosed).toBe("2026-05-14");
  const [b] = c.base, [h] = c.head;
  expect([b!.version, h!.version]).toEqual(["12.0.0", "12.0.1"]);
  for (const p of [b!, h!]) {
    const pj = JSON.parse(text(p.files, "package.json"));
    expect(pj.scripts).toBeUndefined();
    expect(pj.main).toBe("ipc.cjs");
    expect(pj.exports["."]).toEqual({ import: "./index.mjs", require: "./ipc.cjs" });
    expect(p.files.has("ipc.cjs") && p.files.has("index.mjs")).toBe(true);
  }
  const bundle = text(h!.files, "ipc.cjs"), old = text(b!.files, "ipc.cjs");
  expect(bundle.startsWith(old)).toBe(true);
  expect(old).toContain("module.exports");
  const tail = bundle.slice(old.length);
  for (const w of PLAIN) expect(tail, w).not.toContain(w);
  const seen = unpacked(tail);
  for (const w of ["child_process", "spawn", ".npmrc", ".ssh", "readFileSync", "POST", "sh.stage.example"]) expect(seen, w).toContain(w);
  // the gate: a hash of the module file name that is the real name of this bundle
  expect(tail).toContain(new Bun.CryptoHasher("sha256").update("ipc.cjs").digest("hex"));
  expect(() => new Function(tail), "parses").not.toThrow();
  // detach-then-send: the first run starts the marked copy and returns; only the marked copy reads and posts
  const gate = tail.indexOf("if (!process"), unref = tail.indexOf(".unref();"), ret = tail.indexOf("return;", unref), send = tail.indexOf("_0xout");
  expect(gate).toBeGreaterThan(-1);
  expect(gate).toBeLessThan(unref);
  expect(unref).toBeLessThan(ret);
  expect(ret).toBeLessThan(send);
  expect(text(h!.files, "index.mjs")).toBe(text(b!.files, "index.mjs"));
});

test("tanstack style: the only manifest change is a git-hosted optionalDependency, an obfuscated file sits outside files", () => {
  const c = byId("tanstack-style-git-optional-dependency");
  expect(c.disclosed).toBe("2026-05-11");
  // the postmortem names only the two malicious versions, so the note must say where the clean base comes from
  expect(c.note).toMatch(/registry/);
  expect(c.note).toMatch(/postmortem/);
  const [b] = c.base, [h] = c.head;
  // host package only: the git dependency's own code is not in the reviewed set, so the case measures the manifest change
  expect(c.base).toHaveLength(1);
  expect(c.head).toHaveLength(1);
  expect(c.note).toMatch(/not modeled/);
  expect(c.note).toMatch(/install-dependency-git-url/);
  expect([b!.version, h!.version]).toEqual(["1.161.6", "1.161.9"]);
  const bp = JSON.parse(text(b!.files, "package.json")), hp = JSON.parse(text(h!.files, "package.json"));
  expect(hp.scripts).toBeUndefined();
  expect(hp.optionalDependencies["@route/setup"]).toMatch(/^github:example-org\/example-router#[0-9a-f]{40}$/);
  expect({ ...hp, version: "", optionalDependencies: undefined }).toEqual({ ...bp, version: "" });
  expect(hp.files).toContain("dist");
  expect(hp.files).not.toContain("router_init.js");
  expect(h!.files.has("router_init.js")).toBe(true);
  expect(b!.files.has("router_init.js")).toBe(false);
  const init = text(h!.files, "router_init.js");
  expect(init.length).toBeGreaterThan(1500);
  for (const w of PLAIN) expect(init, w).not.toContain(w);
  const seen = unpacked(init);
  for (const w of ["child_process", "execFile"]) expect(seen, w).toContain(w);
  expect(() => new Function(init), "parses").not.toThrow();
});
