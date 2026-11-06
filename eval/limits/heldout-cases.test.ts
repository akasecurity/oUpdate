import { expect, test } from "bun:test";
import { HELDOUT } from "./heldout-cases.ts";
import models from "./models.json";
import { INSTALL_ATTACKS } from "./install-cases.ts";

const text = (f: Map<string, Uint8Array>, k: string) => new TextDecoder().decode(f.get(k)!);
const byId = (id: string) => HELDOUT.find((c) => c.id === id)!;
/** Limits: only lowercase hex in double quotes is decoded (any other encoding, such as base64, is not). The file text plus every hex string literal decoded and put back in quotes (a bare hostname then reads as a quoted one). Entries under 8 hex characters are skipped. */
const unpacked = (s: string) => s + "\n" + (s.match(/"[0-9a-f]{8,}"/g) ?? []).map((h) => `"${Buffer.from(h.slice(1, -1), "hex").toString("latin1")}"`).join("\n");
// File names the guard skips: only these extensions. sh and md are not here because they are real country-code
// domains; a fixture that quotes a file name ending in either must be renamed or checked as a host.
const FILE_EXT = /\.(js|cjs|mjs|json|ts|gyp|npmrc|txt|out)$/;
// A quoted four-part number whose parts are each 0 to 255, such as "1.2.3.4", counts as an address and is checked as a host: a
// fixture that needs such a version string must build it (for example "1.2.3" + ".4") or write it with another form. Three-part
// versions, and four-part ones with a part over 255 and no leading zero, are not addresses and are skipped. A part with a leading
// zero counts as an address whatever its length (octal forms), and such a part also accepts 8 and 9, which are not octal digits.
// Short forms such as "127.1" and "0177.1" stay out of scope.
const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d|0\d+)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d|0\d+)$/;
const hostsIn = (s: string) => [
  ...(s.match(/https?:\/\/[^\s"'`/\\]+/g) ?? []),
  ...[...s.matchAll(/["'`]([a-z0-9-]+(?:\.[a-z0-9-]+)+)["'`]/g)].map((m) => m[1]!).filter((t) => !FILE_EXT.test(t) && (IPV4.test(t) || !/^\d+(\.\d+)+$/.test(t))),
];
/** run.ts counts a case as held out only when it was disclosed after the reviewer cutoff; the message says what to do when the cutoff moves. */
const cutoffProblem = (id: string, disclosed: string, cutoff: string) =>
  disclosed > cutoff ? undefined : `${id} was disclosed ${disclosed}, not after the reviewer cutoff ${cutoff} in models.json: it no longer measures an unseen attack. Re-date it only if the write-up is newer; otherwise move it out of HELDOUT into the earlier attacks.`;
// Words a keyword scan would key on; in the obfuscated payloads they may only appear after the table is decoded.
const PLAIN = ["child_process", ".npmrc", ".ssh", "readFileSync", "POST", "stage.example", "execFile", "spawn"];

test("every held-out case is a dated attack with a source page and only .example addresses", () => {
  expect(new Set(HELDOUT.map((c) => c.id)).size).toBe(HELDOUT.length);
  for (const c of HELDOUT) {
    expect(c.kind, c.id).toBe("attack");
    expect(c.expect, c.id).toBe("hold");
    expect(c.disclosed, c.id).toMatch(/^\d{4}-\d\d-\d\d$/);
    expect(cutoffProblem(c.id, c.disclosed, models.reviewer.cutoff), c.id).toBeUndefined();
    expect(c.source, c.id).toMatch(/^https:\/\/\S+$/);
    for (const p of [...c.base, ...c.head]) for (const [k, v] of p.files) {
      const body = unpacked(new TextDecoder().decode(v));
      for (const host of hostsIn(body)) expect(host.replace(/^https?:\/\//, ""), `${c.id} ${k}`).toMatch(/\.example$/);
      for (const m of body.matchAll(/github:([\w.-]+)\//g)) expect(m[1], `${c.id} ${k}`).toBe("example-org");
    }
  }
});

test("a case at or before the reviewer cutoff fails with what to do", () => {
  expect(cutoffProblem("x", "2026-04-15", "2026-04-15")).toMatch(/Re-date.*move it out of HELDOUT/);
  expect(cutoffProblem("x", "2026-04-16", "2026-04-15")).toBeUndefined();
});

test("the host guard sees a hex-encoded real hostname", () => {
  const hex = Buffer.from("sh.evil.com").toString("hex");
  expect(hostsIn(unpacked(`const t = ["${hex}"];`))).toEqual(["sh.evil.com"]);
  expect(hostsIn(unpacked(`const t = ["${Buffer.from("see https://up.evil.com/c now").toString("hex")}"];`))).toContain("https://up.evil.com");
});

test("the host guard sees a quoted bare hostname and ignores file names with known extensions", () => {
  expect(hostsIn(`x("sh.stage.example"); y("ipc.cjs"); z("1.2.3"); w("evil.test")`)).toEqual(["sh.stage.example", "evil.test"]);
  expect(hostsIn(`x("203.0.113.7"); y("1.2.3")`)).toEqual(["203.0.113.7"]);
  // documented limit: a quoted four-part number that fits 0 to 255 reads as an address; one with a part over 255 is a version
  expect(hostsIn(`x("1.2.3.4"); y("12.0.1.1000"); z("1.2.3.256")`)).toEqual(["1.2.3.4"]);
  // a part with a leading zero is read as octal by many resolvers ("0177.0.0.1" is a loopback address), so it is an address whatever its length
  expect(hostsIn(`x("0177.0.0.1"); y("1.2.3.0400"); z("10.0.1.1000")`)).toEqual(["0177.0.0.1", "1.2.3.0400"]);
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

/**
 * Names of globals that reach the outside world. This is a text guard against accidental use, not a sandbox: a payload that builds a
 * name from pieces (a split-string constructor), or reaches Worker or navigator, still gets to real globals. The decoded payload must
 * not name any of these and the run shadows the plain identifiers. "import(" is matched as import followed by an opening
 * parenthesis with any space between, and "constructor" is matched even after a dot (a function's constructor is the real Function);
 * both, and self, also flag harmless code that happens to use the word. process.binding and process.dlopen are text-checked only:
 * process is a stub.
 */
const IO_GLOBALS = ["globalThis", "global", "self", "Bun", "fetch", "import(", "eval", "Function", "constructor", "XMLHttpRequest", "WebSocket", "process.binding", "process.dlopen"];
const ioGlobals = (src: string) =>
  IO_GLOBALS.filter((n) =>
    n === "import(" ? /(?<![\w$.])import\s*\(/.test(src)
    : n === "constructor" ? /(?<![\w$])constructor(?![\w$])/.test(src)
    : new RegExp(`(?<![\\w$.])${n.replace(".", "\\.")}(?![\\w$])`).test(src));
/** The names shadowed with undefined in the run: the plain identifiers of IO_GLOBALS, less eval, which a strict function cannot bind (the guard refuses the word instead), and less constructor, a property name that no binding shadows. */
const shadowNames = () => IO_GLOBALS.filter((n) => /^[A-Za-z_$][\w$]*$/.test(n) && n !== "eval" && n !== "constructor");

interface Run { calls: string[]; spawns: { cmd: string; args: string[]; detached?: boolean; marked: boolean }[]; bodies: string[] }
/** Runs the appended payload with every require stubbed and the I/O globals shadowed with undefined; a payload that names one is refused before it runs. This is a text guard against accidental use of the real modules and globals, not a sandbox. */
function runTail(tail: string, env: Record<string, string>, filename = "/pkg/ipc.cjs"): Run {
  const named = ioGlobals(unpacked(tail));
  if (named.length) throw new Error(`payload names I/O globals: ${named.join(", ")}`);
  const out: Run = { calls: [], spawns: [], bodies: [] };
  const crypto = require("node:crypto"), path = require("node:path");
  const stubs: Record<string, unknown> = {
    crypto, path,
    child_process: { spawn: (cmd: string, args: string[], o: { detached?: boolean; env: Record<string, string> }) => (out.calls.push(`spawn detached=${o.detached} marked=${Boolean(o.env.__ipc_marker)}`), out.spawns.push({ cmd, args, detached: o.detached, marked: Boolean(o.env.__ipc_marker) }), { unref: () => out.calls.push("unref") }) },
    fs: { readFileSync: (p: string) => (out.calls.push(`read ${path.basename(p)}`), `content-of-${path.basename(p)}`) },
    os: { homedir: () => "/stub-home" },
    https: { request: (o: { host: string; method: string }) => (out.calls.push(`request ${o.method} ${o.host}`), { on: () => {}, end: (b: string) => (out.bodies.push(b), out.calls.push(`end ${b.includes("TOKEN") ? "with-env" : "no-env"}`)) }) },
  };
  const req = (n: string) => { if (!(n in stubs)) throw new Error(`unexpected require ${n}`); return stubs[n]; };
  const shadow = shadowNames();
  new Function("require", "process", "__filename", ...shadow, `"use strict";\n${tail}`)(req, { env, execPath: "node", argv: ["node", "app.js"] }, filename, ...shadow.map(() => undefined));
  return out;
}

test("the I/O guard names a global used by a payload, plain or hex-encoded", () => {
  expect(ioGlobals(`fetch("x"); const g = globalThis; Bun.spawn(); eval("1"); import("m"); new Function("a")`)).toEqual(["globalThis", "Bun", "fetch", "import(", "eval", "Function"]);
  expect(ioGlobals(`myfetch(); x.eval(); Functional; nofetch`)).toEqual([]);
  expect(ioGlobals(unpacked(`const t = ["${Buffer.from("globalThis.fetch").toString("hex")}"];`))).toEqual(["globalThis"]);
  const refused = (name: string) => `payload names I/O globals: ${name}`;
  expect(() => runTail(`fetch("https://x.example");`, {})).toThrow(refused("fetch"));
  // other ways to the real globals are refused by the text check or fail inside the strict function (each payload only names the function, it never calls the network)
  for (const [body, message] of [
    [`const f = global.fetch;`, refused("global")],
    [`const f = self.fetch;`, refused("self")],
    [`(() => {}).constructor("return 1")();`, refused("constructor")],
    [`const m = import ("x");`, refused("import(")],
    [`const f = globalThis["fe" + "tch"];`, refused("globalThis")],
    [`const f = this.fetch;`, "this.fetch"], // passes the text check (a dotted name); stopped by the strict function, where this is undefined
  ] as const) expect(() => runTail(body, {}), body).toThrow(message);
  // passes the text check (an escaped identifier hides the word) and is stopped only by the hidden name: fetch is shadowed with undefined
  let hidden = "";
  try { runTail(`\\u0066etch("https://x.example");`, {}); } catch (e) { hidden = (e as Error).message; }
  expect(hidden).toContain("u0066etch is not a function");
  expect(hidden).toContain("is undefined");
  expect(hidden).not.toContain("names I/O globals");
  expect(ioGlobals("import  ( 'm' )")).toEqual(["import("]);
  expect(ioGlobals("a.constructor(1)")).toEqual(["constructor"]);
  expect(ioGlobals("global.x; self.y")).toEqual(["global", "self"]);
  // the shadow list comes from IO_GLOBALS: plain identifiers only, never eval (a strict function cannot bind it) and never constructor (a property name, not a binding)
  expect(shadowNames()).toEqual(["globalThis", "global", "self", "Bun", "fetch", "Function", "XMLHttpRequest", "WebSocket"]);
});

test("node-ipc style behavior: unmarked it only detaches a marked copy; marked it reads then sends; a wrong file name does nothing", () => {
  const c = byId("node-ipc-style-appended-require-payload");
  const tail = text(c.head[0]!.files, "ipc.cjs").slice(text(c.base[0]!.files, "ipc.cjs").length);
  const first = runTail(tail, { TOKEN: "t" });
  expect(first.calls).toEqual(["spawn detached=true marked=true", "unref"]);
  // the detached copy is this same program: the node binary and the script it was started with
  expect(first.spawns).toEqual([{ cmd: "node", args: ["app.js"], detached: true, marked: true }]);
  const m = runTail(tail, { TOKEN: "t", __ipc_marker: "1" });
  expect(m.calls.slice(0, 3).sort()).toEqual(["read .npmrc", "read credentials", "read id_rsa"]);
  expect(m.calls.slice(3)).toEqual(["request POST sh.stage.example", "end with-env"]);
  expect(m.spawns).toEqual([]);
  // the body carries what was read and the environment
  expect(m.bodies).toHaveLength(1);
  const body = JSON.parse(m.bodies[0]!);
  expect(body.env.TOKEN).toBe("t");
  for (const f of [".npmrc", "id_rsa", "credentials"]) expect(Object.values(body).join("\n")).toContain(`content-of-${f}`);
  expect(runTail(tail, { TOKEN: "t" }, "/pkg/other.cjs").calls).toEqual([]);
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
  // the git dependency is deliberately not in the reviewed set, and the note says so
  expect(c.note).toMatch(/not modeled/);
  // the note compares the case with an existing install-time attack by its id
  expect(INSTALL_ATTACKS.some((x) => c.note.includes(x.id))).toBe(true);
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

test("mastra style: a new typosquat dependency whose patch release gains a postinstall dropper", () => {
  const c = byId("mastra-style-typosquat-dependency-postinstall");
  expect(c.disclosed).toBe("2026-06-17");
  expect(c.source).toContain("microsoft.com/en-us/security/blog/2026/06/17/");
  const [host, dep] = c.head;
  expect(c.base).toHaveLength(1);
  expect(c.head).toHaveLength(2);
  expect([c.base[0]!.version, host!.version]).toEqual(["1.13.0", "1.13.1"]);
  const bp = JSON.parse(text(c.base[0]!.files, "package.json")), hp = JSON.parse(text(host!.files, "package.json"));
  expect(bp.dependencies).toBeUndefined();
  expect(hp.dependencies).toEqual({ [dep!.name]: "^1.11.21" });
  expect({ ...hp, version: "", dependencies: undefined }).toEqual({ ...bp, version: "" });
  // the dependency name is a look-alike of a popular date library with a prefix added, and the resolved patch is the weaponized one
  expect(dep!.name).toMatch(/day-js$/);
  expect(dep!.version).toBe("1.11.22");
  const dp = JSON.parse(text(dep!.files, "package.json"));
  expect(dp.scripts).toEqual({ postinstall: "node setup.cjs --no-warnings" });
  const setup = text(dep!.files, "setup.cjs");
  for (const w of PLAIN) expect(setup, w).not.toContain(w);
  const seen = unpacked(setup);
  for (const w of ["NODE_TLS_REJECT_UNAUTHORIZED", "child_process", "spawn", "POST"]) expect(seen, w).toContain(w);
  expect(ioGlobals(unpacked(setup)), "I/O globals").toEqual([]);
  expect(() => new Function(setup), "parses").not.toThrow();
  expect(dep!.files.has("dayjs.min.js")).toBe(true);
});

test("red hat wave style: the main file is replaced by a much larger obfuscated bundle and the manifest only changes its version", () => {
  const c = byId("redhat-wave-style-main-replaced");
  expect(c.disclosed).toBe("2026-06-01");
  expect(c.source).toContain("unit42.paloaltonetworks.com");
  const [b] = c.base, [h] = c.head;
  expect(c.base).toHaveLength(1);
  expect(c.head).toHaveLength(1);
  expect([b!.version, h!.version]).toEqual(["7.7.1", "7.7.2"]);
  const bp = JSON.parse(text(b!.files, "package.json")), hp = JSON.parse(text(h!.files, "package.json"));
  expect(hp.scripts).toBeUndefined();
  expect({ ...hp, version: "" }).toEqual({ ...bp, version: "" });
  const old = text(b!.files, "index.js"), now = text(h!.files, "index.js");
  expect(now.length).toBeGreaterThan(old.length * 10);
  expect(now).not.toContain(old.slice(0, 80)); // replaced, not appended to
  for (const w of PLAIN) expect(now, w).not.toContain(w);
  const seen = unpacked(now);
  for (const w of ["readFileSync", "POST", ".npmrc"]) expect(seen, w).toContain(w);
  expect(ioGlobals(unpacked(now)), "I/O globals").toEqual([]);
  expect(() => new Function(now), "parses").not.toThrow();
});

test("antv wave style: a version jump with a preinstall that runs bun on a new file, bun as a dependency and a git optionalDependency", () => {
  const c = byId("antv-wave-style-preinstall-bun");
  expect(c.disclosed).toBe("2026-05-19");
  expect(c.source).toContain("unit42.paloaltonetworks.com");
  const [b] = c.base, [h] = c.head;
  expect(c.base).toHaveLength(1);
  expect(c.head).toHaveLength(1);
  expect([b!.version, h!.version]).toEqual(["2.2.0", "2.4.0"]); // the write-up gives the jump from 2.2.0 to 2.4.0
  const bp = JSON.parse(text(b!.files, "package.json")), hp = JSON.parse(text(h!.files, "package.json"));
  // main is the library file in both releases: index.js is the payload and must not be what a require loads
  expect(bp.main).toBe("lib.js");
  expect(hp.main).toBe("lib.js");
  expect(bp.scripts).toBeUndefined();
  expect(hp.scripts).toEqual({ preinstall: "bun run index.js" });
  expect({ ...hp, version: "", scripts: undefined, dependencies: undefined, optionalDependencies: undefined }).toEqual({ ...bp, version: "" });
  expect(bp.dependencies?.bun).toBeUndefined();
  expect(hp.dependencies.bun).toMatch(/^\d/);
  expect(hp.optionalDependencies[Object.keys(hp.optionalDependencies)[0]!]).toMatch(/^github:example-org\/example-chart#[0-9a-f]{40}$/);
  expect(b!.files.has("index.js")).toBe(false);
  const payload = text(h!.files, "index.js");
  expect(payload.length).toBeGreaterThan(8000);
  for (const w of PLAIN) expect(payload, w).not.toContain(w);
  const seen = unpacked(payload);
  for (const w of ["readFileSync", "POST", "/v1/traces"]) expect(seen, w).toContain(w);
  expect(ioGlobals(unpacked(payload)), "I/O globals").toEqual([]);
  expect(() => new Function(payload), "parses").not.toThrow();
});
