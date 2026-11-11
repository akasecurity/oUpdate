import { describe, expect, test } from "bun:test";
import { chunkDiff } from "../src/review.ts";
import { renderLineDiff } from "../src/linediff.ts";
import type { FileMap } from "../src/prepass.ts";

const enc = (s: string) => new TextEncoder().encode(s);
const files = (o: Record<string, string>): FileMap => new Map(Object.entries(o).map(([k, v]) => [k, enc(v)]));
const full = (old: FileMap, now: FileMap) => chunkDiff(old, now, 50_000).join("");
const sha = (b: Uint8Array) => new Bun.CryptoHasher("sha256").update(b).digest("hex");

// Shaped like the llhttp WebAssembly module a bundled action carries: a long base64 string whose bytes stay the same
// between releases while the minifier renames the variable that holds it.
const bytes = (seed: number, n = 900) => Uint8Array.from({ length: n }, (_, i) => (i * 31 + seed * 7 + (i >> 3)) & 0xff);
const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");
const wasm = bytes(1);
const blob = b64(wasm);
const bundle = (name: string, data: string, tail = "") => `var ${name}=Buffer.from("${data}","base64");module.exports=${name};${tail}\n`;

describe("an encoded blob the old release has byte for byte", () => {
  test("an identical blob under a renamed variable is shown as one unchanged-blob note", () => {
    const out = full(files({ "dist/index.js": bundle("aF", blob) }), files({ "dist/index.js": bundle("dF", blob) }));
    expect(out).toContain(`unchanged blob ${sha(wasm)}`);
    expect(out).not.toContain(blob.slice(0, 120));
    expect(out).toContain("dF");
  });

  test("a blob with one byte changed is shown as today", () => {
    const changed = Uint8Array.from(wasm);
    changed[450] = changed[450]! ^ 1;
    const out = full(files({ "dist/index.js": bundle("aF", blob) }), files({ "dist/index.js": bundle("dF", b64(changed)) }));
    expect(out).not.toContain("unchanged blob");
    expect(out).toBe(`=== dist/index.js (changed) ===\n${renderLineDiff(bundle("aF", blob), bundle("dF", b64(changed)))}`);
  });

  test("a new blob is shown as today", () => {
    const fresh = b64(bytes(9));
    const out = full(files({ "dist/index.js": bundle("aF", blob) }), files({ "dist/index.js": bundle("aF", blob, `var x=Buffer.from("${fresh}","base64");`) }));
    expect(out).toContain(fresh);
    expect(out).not.toContain(blob.slice(0, 120));
    expect(out).toContain(`unchanged blob ${sha(wasm)}`);
  });

  test("the same blob moved to a new file still gets the note", () => {
    const out = full(files({ "dist/a.js": bundle("aF", blob) }), files({ "dist/a.js": "module.exports=require('./b.js');\n", "dist/b.js": bundle("dF", blob) }));
    expect(out).toContain("=== dist/b.js (added) ===");
    expect(out).toContain(`unchanged blob ${sha(wasm)}`);
    expect(out).not.toContain(blob.slice(0, 120));
  });

  test("the code around an unchanged blob is still shown: a new eval of it is visible", () => {
    const out = full(files({ "dist/index.js": bundle("aF", blob) }), files({ "dist/index.js": bundle("aF", blob, "eval(aF.toString());") }));
    expect(out).toContain("eval(aF.toString());");
    expect(out).toContain(`unchanged blob ${sha(wasm)}`);
  });

  test("a long run that is not base64 keeps the exact-text rule: identical text gets the note, by the text's hash", () => {
    const run = "-_".repeat(250) + "x";
    const out = full(files({ "a.js": `var a="${run}";\n` }), files({ "a.js": `var b="${run}";\n` }));
    expect(out).toContain(`unchanged blob ${sha(enc(run))}`);
  });
});

test("a newly reached unchanged file is shown whole: a dormant blob the new release starts loading is not reduced to a note", () => {
  const pj = (o: object) => JSON.stringify({ name: "lib", version: "1.0.0", main: "index.js", ...o });
  const data = `module.exports="${blob}";\n`;
  const old = files({ "package.json": pj({}), "index.js": "a()\n", "data.js": data });
  const now = files({ "package.json": pj({ version: "1.0.1" }), "index.js": "eval(Buffer.from(require('./data.js'),'base64').toString())\n", "data.js": data });
  const out = full(old, now);
  expect(out).toContain("=== data.js (now loaded by changed code, unchanged) ===");
  expect(out).toContain(blob.slice(0, 120));
});
