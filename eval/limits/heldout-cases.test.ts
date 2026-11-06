import { expect, test } from "bun:test";
import { HELDOUT } from "./heldout-cases.ts";

const text = (f: Map<string, Uint8Array>, k: string) => new TextDecoder().decode(f.get(k)!);
const byId = (id: string) => HELDOUT.find((c) => c.id === id)!;

test("every held-out case is an attack with a date, a source page and a synthetic body", () => {
  expect(new Set(HELDOUT.map((c) => c.id)).size).toBe(HELDOUT.length);
  for (const c of HELDOUT) {
    expect(c.kind, c.id).toBe("attack");
    expect(c.expect, c.id).toBe("hold");
    expect(c.disclosed, c.id).toMatch(/^2026-\d\d-\d\d$/);
    expect(c.source, c.id).toMatch(/^https:\/\/\S+$/);
    for (const p of [...c.base, ...c.head]) for (const [k, v] of p.files) {
      const body = new TextDecoder().decode(v);
      for (const host of body.match(/https?:\/\/[^\s"'`/]+/g) ?? []) expect(host, `${c.id} ${k}`).toMatch(/\.example$/);
    }
  }
});

test("node-ipc style: no install hook, the payload is appended after module.exports and runs at require", () => {
  const c = byId("node-ipc-style-appended-require-payload");
  expect(c.disclosed).toBe("2026-05-14");
  const [b] = c.base, [h] = c.head;
  expect([b!.version, h!.version]).toEqual(["12.0.0", "12.0.1"]);
  const pj = JSON.parse(text(h!.files, "package.json"));
  expect(pj.scripts).toBeUndefined();
  const bundle = text(h!.files, "ipc.cjs"), old = text(b!.files, "ipc.cjs");
  expect(bundle.startsWith(old)).toBe(true);
  const tail = bundle.slice(old.length);
  expect(tail).toContain("child_process");
  expect(tail).toContain("process.env");
  expect(tail).toContain("sh.stage.example");
  expect(text(h!.files, "index.mjs")).toBe(text(b!.files, "index.mjs"));
});

test("tanstack style: the only manifest change is a git-hosted optionalDependency, the payload file is outside files", () => {
  const c = byId("tanstack-style-git-optional-dependency");
  expect(c.disclosed).toBe("2026-05-11");
  expect(c.note).toContain("1.161.6");
  const [b] = c.base, [h] = c.head;
  expect([b!.version, h!.version]).toEqual(["1.161.6", "1.161.9"]);
  const bp = JSON.parse(text(b!.files, "package.json")), hp = JSON.parse(text(h!.files, "package.json"));
  expect(hp.scripts).toBeUndefined();
  expect(hp.optionalDependencies["@route/setup"]).toMatch(/^github:[\w-]+\/[\w-]+#[0-9a-f]{40}$/);
  const { optionalDependencies, version, ...hrest } = hp, { version: _v, ...brest } = bp;
  expect(hrest).toEqual(brest);
  expect(optionalDependencies).toBeDefined();
  expect(hp.files).toContain("dist");
  expect(hp.files).not.toContain("router_init.js");
  expect(h!.files.has("router_init.js")).toBe(true);
  expect(b!.files.has("router_init.js")).toBe(false);
});
