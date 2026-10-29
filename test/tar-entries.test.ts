import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizePaths, readArtifact } from "../src/artifact.ts";
import { prepass } from "../src/prepass.ts";

// ustar members, including two entries with one name. npm keeps the earlier
// regular file and skips a link; the entry list is what we hold on.
function tarBytes(entries: { name: string; type: "file" | "sym" | "hard" | "dir"; data: string }[]): Uint8Array {
  const enc = new TextEncoder();
  const blocks: Uint8Array[] = [];
  const put = (header: Uint8Array, off: number, text: string) => {
    const bytes = enc.encode(text);
    header.set(bytes.subarray(0, Math.min(bytes.length, header.length - off)), off);
  };
  for (const entry of entries) {
    const header = new Uint8Array(512);
    put(header, 0, entry.name);
    // A directory member needs +x or the extract cannot be removed (ENOTEMPTY).
    put(header, 100, entry.type === "dir" ? "0000755\0" : "0000644\0");
    put(header, 108, "0000000\0");
    put(header, 116, "0000000\0");
    const body = entry.type === "file" ? enc.encode(entry.data) : new Uint8Array();
    put(header, 124, body.length.toString(8).padStart(11, "0") + "\0");
    put(header, 136, "00000000000\0");
    header.fill(0x20, 148, 156);
    header[156] = (entry.type === "file" ? "0" : entry.type === "sym" ? "2" : entry.type === "hard" ? "1" : "5").charCodeAt(0);
    if (entry.type === "sym" || entry.type === "hard") put(header, 157, entry.data);
    put(header, 257, "ustar\0");
    put(header, 263, "00");
    let sum = 0;
    for (const b of header) sum += b;
    put(header, 148, sum.toString(8).padStart(6, "0") + "\0 ");
    blocks.push(header);
    if (body.length) {
      const padded = new Uint8Array(Math.ceil(body.length / 512) * 512);
      padded.set(body);
      blocks.push(padded);
    }
  }
  blocks.push(new Uint8Array(1024));
  const out = new Uint8Array(blocks.reduce((n, b) => n + b.length, 0));
  let at = 0;
  for (const block of blocks) {
    out.set(block, at);
    at += block.length;
  }
  return out;
}

const dir = mkdtempSync(join(tmpdir(), "oup-tar-"));
let n = 0;

async function details(old: Uint8Array, now: Uint8Array): Promise<string> {
  const a = join(dir, `${n++}-old.tar`);
  const b = join(dir, `${n}-new.tar`);
  writeFileSync(a, old);
  writeFileSync(b, now);
  const oldFiles = normalizePaths(await readArtifact(a));
  const newFiles = normalizePaths(await readArtifact(b));
  return prepass("npm", oldFiles, newFiles).hard.map((s) => s.detail).join(" ");
}

const pj = (name: string) => JSON.stringify({ name, version: "1.0.0", scripts: { postinstall: "node install.js" } });
const benign = "// benign\n";
const payload = "require('child_process').execSync('id')\n";

describe("tar entry list", () => {
  test("a symlink member holds even when it reuses a regular file's name", async () => {
    const members = (body: string) => tarBytes([
      { name: "package/package.json", type: "file", data: pj("a-sym") },
      { name: "package/lib.js", type: "file", data: benign },
      { name: "package/install.js", type: "file", data: body },
      { name: "package/install.js", type: "sym", data: "lib.js" },
    ]);
    expect(await details(members(benign), members(payload))).toMatch(/symlink/);
  });

  test("a hardlink member holds", async () => {
    const members = (body: string) => tarBytes([
      { name: "package/package.json", type: "file", data: pj("e-hard") },
      { name: "package/lib.js", type: "file", data: benign },
      { name: "package/install.js", type: "file", data: body },
      { name: "package/install.js", type: "hard", data: "package/lib.js" },
    ]);
    expect(await details(members(benign), members(payload))).toMatch(/hardlink/);
  });

  test("a case-fold collision holds", async () => {
    const members = (body: string) => tarBytes([
      { name: "package/README.md", type: "file", data: "readme" },
      { name: "package/package.json", type: "file", data: pj("c-case") },
      { name: "package/install.js", type: "file", data: body },
      { name: "package/Install.js", type: "file", data: benign },
    ]);
    expect(await details(members(benign), members(payload))).toMatch(/case-fold/);
  });

  test("two top dirs hold", async () => {
    const members = (body: string) => tarBytes([
      { name: "zz/install.js", type: "file", data: benign },
      { name: "package/package.json", type: "file", data: pj("b-two2") },
      { name: "package/install.js", type: "file", data: body },
    ]);
    expect(await details(members(benign), members(payload))).toMatch(/top dirs/);
  });

  test("one top dir of regular files is not a tar-entry hold", async () => {
    const members = (readme: string) => tarBytes([
      { name: "package/package.json", type: "file", data: pj("clean") },
      { name: "package/install.js", type: "file", data: benign },
      { name: "package/README.md", type: "file", data: readme },
    ]);
    expect(await details(members("a"), members("b"))).not.toMatch(/symlink|hardlink|case-fold|top dirs|duplicate path|root file|node_modules|non-ascii/);
  });

  test("a root file beside package/ holds", async () => {
    const members = (body: string) => tarBytes([
      { name: "install.js", type: "file", data: benign },
      { name: "package/package.json", type: "file", data: pj("f-root") },
      { name: "package/install.js", type: "file", data: body },
    ]);
    expect(await details(members(benign), members(payload))).toMatch(/root file/);
  });

  test("a bundled node_modules member holds", async () => {
    const members = (body: string) => tarBytes([
      { name: "package/package.json", type: "file", data: pj("k-bun") },
      { name: "package/index.js", type: "file", data: benign },
      { name: "package/node_modules/kevil/package.json", type: "file", data: pj("kevil") },
      { name: "package/node_modules/kevil/p.js", type: "file", data: body },
    ]);
    expect(await details(members(benign), members(payload))).toMatch(/node_modules/);
  });

  test("a non-ascii member name holds", async () => {
    const members = (body: string) => tarBytes([
      { name: "package/package.json", type: "file", data: pj("g-ls") },
      { name: "package/install.js", type: "file", data: body },
      { name: "package/in\u017ftall.js", type: "file", data: benign },
    ]);
    expect(await details(members(benign), members(payload))).toMatch(/non-ascii/);
  });

  test("a dot segment and an empty segment are the same path", async () => {
    const dot = (body: string) => tarBytes([
      { name: "package/package.json", type: "file", data: pj("h-dot") },
      { name: "package/install.js", type: "file", data: body },
      { name: "package/./install.js", type: "file", data: benign },
    ]);
    const slash = (body: string) => tarBytes([
      { name: "package/package.json", type: "file", data: pj("h-ds") },
      { name: "package/install.js", type: "file", data: body },
      { name: "package//install.js", type: "file", data: benign },
    ]);
    expect(await details(dot(benign), dot(payload))).toMatch(/duplicate path/);
    expect(await details(slash(benign), slash(payload))).toMatch(/duplicate path/);
  });

  test("a package directory entry is not a root file", async () => {
    const members = (readme: string) => tarBytes([
      { name: "package/", type: "dir", data: "" },
      { name: "package/package.json", type: "file", data: pj("clean-dir") },
      { name: "package/install.js", type: "file", data: benign },
      { name: "package/README.md", type: "file", data: readme },
    ]);
    expect(await details(members("a"), members("b"))).not.toMatch(/symlink|hardlink|case-fold|top dirs|duplicate path|root file|node_modules|non-ascii/);
  });
});

test("tar entry fixtures are removed", () => {
  rmSync(dir, { recursive: true, force: true });
});
