import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizePaths, readArtifact } from "../src/artifact.ts";
import { prepass, type FileMap } from "../src/prepass.ts";

// Hold iff the install-time surface changed. An unresolved form (eval, binary,
// runner, gyp, node-gyp) is not a hold when the bytes npm would run match.
const enc = new TextEncoder();
const map = (f: Record<string, string>): FileMap => new Map(Object.entries(f).map(([k, v]) => [k, enc.encode(v)]));
const pj = (scripts: object, extra: object = {}) => JSON.stringify({ name: "x", version: "1", scripts, ...extra });

function hard(oldF: Record<string, string>, newF: Record<string, string>) {
  return prepass("npm", map(oldF), map(newF)).hard.filter((s) => s.kind === "install-script");
}
function details(oldF: Record<string, string>, newF: Record<string, string>) {
  return hard(oldF, newF).map((s) => s.detail).join(" ");
}

const gyp = (extra: string) => `{'targets':[{'target_name':'a','sources':['a.c'${extra}]}]}`;
const benignGyp = gyp("");
const evilGyp = gyp(",'<!(node -e \"process.exit(1)\")'");

describe("install surface", () => {
  test("F1 a gyp byte is surface when node-gyp-build also has a local prebuild", () => {
    const scripts = { postinstall: "node-gyp-build" };
    const file = "prebuilds/linux-x64/a.node";
    const base = { "package.json": pj(scripts), "a.c": "int x;\n", [file]: "bin" };
    expect(details({ ...base, "binding.gyp": benignGyp }, { ...base, "binding.gyp": evilGyp })).toMatch(/binding\.gyp|file/);
    expect(hard({ ...base, "binding.gyp": benignGyp }, { ...base, "binding.gyp": benignGyp, "README.md": "x" })).toEqual([]);
    // A hook that never reaches node-gyp still does not scan.
    const safe = { "package.json": pj({ install: "node safe.js" }), "safe.js": "1\n", "binding.gyp": benignGyp, "a.c": "int x;\n" };
    expect(hard(safe, { ...safe, "binding.gyp": evilGyp })).toEqual([]);
  });

  test("F2 an explicit node-gyp-build reads gyp bytes even when gypfile is false", () => {
    const scripts = { install: "node-gyp-build" };
    const base = { "package.json": pj(scripts, { gypfile: false }), "a.c": "int x;\n" };
    expect(details({ ...base, "binding.gyp": benignGyp }, { ...base, "binding.gyp": evilGyp })).toMatch(/binding\.gyp|file/);
    // Implicit rebuild still honors gypfile:false.
    const implicit = { "package.json": pj({}, { gypfile: false }), "binding.gyp": benignGyp, "a.c": "int x;\n" };
    expect(hard(implicit, { ...implicit, "binding.gyp": evilGyp })).toEqual([]);
  });

  test("F3 node install.js runs install.js.js when that is the file on disk", () => {
    const scripts = { install: "node install.js" };
    const p = pj(scripts);
    expect(details(
      { "package.json": p, "install.js.js": "benign\n" },
      { "package.json": p, "install.js.js": "payload\n" },
    )).toMatch(/install\.js\.js|file/);
    expect(hard(
      { "package.json": p, "install.js.js": "same\n" },
      { "package.json": p, "install.js.js": "same\n" },
    )).toEqual([]);
    // The exact file still wins over the appended extension.
    expect(details(
      { "package.json": p, "install.js": "benign\n", "install.js.js": "other\n" },
      { "package.json": p, "install.js": "payload\n", "install.js.js": "other\n" },
    )).toMatch(/file/);
    expect(hard(
      { "package.json": p, "install.js": "same\n", "install.js.js": "a\n" },
      { "package.json": p, "install.js": "same\n", "install.js.js": "b\n" },
    )).toEqual([]);
  });

  test("F4 node .npmignore runs the pacote-renamed .gitignore", () => {
    const p = pj({ postinstall: "node .npmignore" });
    expect(details(
      { "package.json": p, ".gitignore": "benign\n" },
      { "package.json": p, ".gitignore": "payload\n" },
    )).toMatch(/\.gitignore|file/);
    expect(hard(
      { "package.json": p, ".gitignore": "same\n" },
      { "package.json": p, ".gitignore": "same\n" },
    )).toEqual([]);
    // A real .npmignore is the file. The sibling .gitignore is not.
    const both = { "package.json": p, ".npmignore": "keep\n", ".gitignore": "a\n" };
    expect(hard(both, { ...both, ".gitignore": "b\n" })).toEqual([]);
    expect(details(both, { ...both, ".npmignore": "payload\n" })).toMatch(/file/);
  });

  test("F6 Package.json is the manifest, and one case-fold match is the hook file", () => {
    const scripts = { postinstall: "node Install.js" };
    const p = JSON.stringify({ name: "x", version: "1", scripts });
    expect(details(
      { "Package.json": p, "install.js": "benign\n" },
      { "Package.json": p, "install.js": "payload\n" },
    )).toMatch(/install\.js|file/);
    expect(hard(
      { "Package.json": p, "install.js": "same\n" },
      { "Package.json": p, "install.js": "same\n" },
    )).toEqual([]);
    // Two names that fold together stay a hold: which file npm reads is ambiguous.
    const clash = { "package.json": p, "Package.json": p, "install.js": "same\n" };
    expect(details(clash, clash)).toMatch(/case-fold/);
  });

  test("an unchanged install surface does not hold", () => {
    const cases: [string, Record<string, string>][] = [
      ["core-js eval", {
        "package.json": pj({ postinstall: "node -e \"try{require('./postinstall')}catch(e){}\"" }),
        "postinstall.js": "same\n",
        "_postinstall.js": "same\n",
      }],
      ["vue-demi eval", {
        "package.json": pj({ postinstall: "node -e \"try{require('./scripts/postinstall')}catch(e){}\"" }),
        "scripts/postinstall.js": "same\n",
      }],
      ["bcrypt node-pre-gyp", {
        "package.json": pj({ install: "node-pre-gyp install --fallback-to-build" }),
        "binding.gyp": benignGyp,
        "a.c": "int x;\n",
      }],
      ["sqlite3 node-pre-gyp", {
        "package.json": pj({ install: "node-pre-gyp install --fallback-to-build" }),
        "deps/common-sqlite.gypi": "a\n",
        "binding.gyp": "{'includes':['deps/common-sqlite.gypi']}\n",
      }],
      ["canvas prebuild-install", {
        "package.json": pj({ install: "prebuild-install -r napi || node-gyp rebuild" }),
        "binding.gyp": benignGyp,
        "a.c": "int x;\n",
      }],
      ["parcel binary", {
        "package.json": pj({ install: "node scripts/build-from-source.js" }, { binary: { module_name: "watcher" } }),
        "scripts/build-from-source.js": "1\n",
        "binding.gyp": benignGyp,
      }],
      ["msgpackr gyp expansion", {
        "package.json": pj({ install: "node-gyp-build-optional-packages" }),
        "binding.gyp": "{'targets':[{'sources':['<(os_linux_compiler)']}]}\n",
      }],
      ["lmdb rollup", {
        "package.json": pj({ install: "node-gyp-build-optional-packages", prepare: "rollup -c" }),
        "binding.gyp": benignGyp,
        "a.c": "int x;\n",
      }],
      ["node-pty tsc", {
        "package.json": pj({ install: "node scripts/install.js", postinstall: "node scripts/post-install.js", prepare: "npm run build", build: "tsc -p ." }),
        "scripts/install.js": "1\n",
        "scripts/post-install.js": "1\n",
      }],
    ];
    for (const [label, files] of cases) {
      const got = hard(files, { ...files, "README.md": "x" });
      // README is never install surface, including for rollup and tsc.
      expect(got, label).toEqual([]);
    }
  });

  test("a changed byte beside the same unresolved form still holds", () => {
    const hold = (label: string, oldF: Record<string, string>, newF: Record<string, string>) => {
      expect(details(oldF, newF), label).toMatch(/file|script/);
    };
    const evalPj = pj({ postinstall: "node -e \"try{require('./postinstall')}catch(e){}\"" });
    hold("eval file", { "package.json": evalPj, "postinstall.js": "a\n" }, { "package.json": evalPj, "postinstall.js": "b\n" });
    const gypPj = pj({ install: "node-pre-gyp install --fallback-to-build" });
    hold("node-pre-gyp gyp", { "package.json": gypPj, "binding.gyp": benignGyp }, { "package.json": gypPj, "binding.gyp": evilGyp });
    const prePj = pj({ install: "prebuild-install -r napi || node-gyp rebuild" });
    hold("prebuild-install gyp", { "package.json": prePj, "binding.gyp": benignGyp }, { "package.json": prePj, "binding.gyp": evilGyp });
    const binPj = pj({ install: "node scripts/build-from-source.js" }, { binary: { module_name: "watcher" } });
    hold("binary gyp", { "package.json": binPj, "scripts/build-from-source.js": "1\n", "binding.gyp": benignGyp }, { "package.json": binPj, "scripts/build-from-source.js": "1\n", "binding.gyp": evilGyp });
    const packPj = pj({ install: "node-gyp-build-optional-packages" });
    hold("gyp expansion bytes", { "package.json": packPj, "binding.gyp": "{'targets':[{'sources':['<(os_linux_compiler)']}]}\n" }, { "package.json": packPj, "binding.gyp": "{'targets':[{'sources':['<(os_linux_compiler_2)']}]}\n" });
    const rollPj = pj({ install: "node-gyp-build-optional-packages", prepare: "rollup -c" });
    hold("rollup gyp", { "package.json": rollPj, "binding.gyp": benignGyp }, { "package.json": rollPj, "binding.gyp": evilGyp });
    const pty = { install: "node scripts/install.js", postinstall: "node scripts/post-install.js", prepare: "npm run build", build: "tsc -p ." };
    hold("pty script", { "package.json": pj(pty), "scripts/install.js": "a\n", "scripts/post-install.js": "1\n" }, { "package.json": pj(pty), "scripts/install.js": "b\n", "scripts/post-install.js": "1\n" });
  });
});

// ustar, so a member can be named `./package/...` (npm strip:1 keeps the dot).
function tarBytes(entries: { name: string; data: string }[]): Uint8Array {
  const blocks: Uint8Array[] = [];
  const put = (header: Uint8Array, off: number, text: string) => {
    const bytes = enc.encode(text);
    header.set(bytes.subarray(0, Math.min(bytes.length, header.length - off)), off);
  };
  for (const entry of entries) {
    const header = new Uint8Array(512);
    put(header, 0, entry.name);
    put(header, 100, "0000644\0");
    put(header, 108, "0000000\0");
    put(header, 116, "0000000\0");
    const body = enc.encode(entry.data);
    put(header, 124, body.length.toString(8).padStart(11, "0") + "\0");
    put(header, 136, "00000000000\0");
    header.fill(0x20, 148, 156);
    header[156] = "0".charCodeAt(0);
    put(header, 257, "ustar\0");
    put(header, 263, "00");
    let sum = 0;
    for (const b of header) sum += b;
    put(header, 148, sum.toString(8).padStart(6, "0") + "\0 ");
    blocks.push(header);
    const padded = new Uint8Array(Math.ceil(body.length / 512) * 512);
    padded.set(body);
    blocks.push(padded);
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

const tarDir = mkdtempSync(join(tmpdir(), "oup-surface-"));
let tarN = 0;

async function tarHard(oldMembers: { name: string; data: string }[], newMembers: { name: string; data: string }[]) {
  const a = join(tarDir, `${tarN++}-old.tar`);
  const b = join(tarDir, `${tarN}-new.tar`);
  writeFileSync(a, tarBytes(oldMembers));
  writeFileSync(b, tarBytes(newMembers));
  const oldFiles = normalizePaths(await readArtifact(a));
  const newFiles = normalizePaths(await readArtifact(b));
  return prepass("npm", oldFiles, newFiles).hard.filter((s) => s.kind === "install-script").map((s) => s.detail).join(" ");
}

const stripPj = JSON.stringify({ name: "x", version: "1", scripts: { postinstall: "node package/install.js" } });

describe("install surface npm strip", () => {
  test("F5 npm strip:1 collides ./package/install.js with package/package/install.js and the later member wins", async () => {
    const members = (benign: string, evil: string) => [
      { name: "package/package.json", data: stripPj },
      { name: "package/package/install.js", data: benign },
      { name: "./package/install.js", data: evil },
    ];
    // The later member is the file npm runs. A change to it holds.
    expect(await tarHard(members("benign\n", "evil-a\n"), members("benign\n", "evil-b\n"))).toMatch(/file|install\.js/);
    // A change only to the earlier member is not the file npm runs.
    expect(await tarHard(members("benign-a\n", "evil\n"), members("benign-b\n", "evil\n"))).toBe("");
    // The same collision on both sides is not a hold.
    expect(await tarHard(members("benign\n", "evil\n"), members("benign\n", "evil\n"))).toBe("");
  });
});

test("surface tar fixtures are removed", () => {
  rmSync(tarDir, { recursive: true, force: true });
});
