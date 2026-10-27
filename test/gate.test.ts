import { describe, expect, test } from "bun:test";
import { diffLocks } from "../src/lockdiff.ts";
import { giteaForge } from "../src/adapters/forge/gitea.ts";
import { runGate, gateState, type Change } from "../src/gate.ts";
import { LOCK_NAMES } from "../src/lockfile/index.ts";
import type { Forge, StatusState } from "../src/adapters/forge/types.ts";
import type { ReviewResult } from "../src/review.ts";

describe("diffLocks", () => {
  test("a bumped package pairs with the version it replaced; unchanged ones are dropped", () => {
    const old = [{ name: "yaml", version: "2.8.1" }, { name: "debug", version: "4.4.1" }];
    const neu = [{ name: "yaml", version: "2.8.3" }, { name: "debug", version: "4.4.1" }];
    expect(diffLocks(old, neu)).toEqual([{ name: "yaml", from: "2.8.1", to: "2.8.3" }]);
  });

  test("the integrity of the old and new version rides along when the lockfiles carry it", () => {
    const old = [{ name: "yaml", version: "2.8.1", integrity: "sha512-old" }];
    const neu = [{ name: "yaml", version: "2.8.3", integrity: "sha512-new" }, { name: "b", version: "1.0.0" }];
    expect(diffLocks(old, neu)).toEqual([
      { name: "yaml", from: "2.8.1", to: "2.8.3", fromIntegrity: "sha512-old", toIntegrity: "sha512-new" },
      { name: "b", from: null, to: "1.0.0" },
    ]);
  });

  test("a new package has no from; a second copy beside a kept one pairs with the highest old", () => {
    const old = [{ name: "a", version: "1.2.0" }, { name: "a", version: "1.10.0" }];
    const neu = [{ name: "a", version: "1.2.0" }, { name: "a", version: "1.10.0" }, { name: "a", version: "2.0.0" }, { name: "b", version: "0.1.0" }];
    expect(diffLocks(old, neu)).toEqual([
      { name: "a", from: "1.10.0", to: "2.0.0" },
      { name: "b", from: null, to: "0.1.0" },
    ]);
  });
});

function fakeFetch(routes: Record<string, (init?: RequestInit) => Response>, log: string[]): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const key = `${init?.method ?? "GET"} ${url.replace("https://forge.test/api/v1", "")}`;
    log.push(key + (init?.body ? ` ${init.body}` : ""));
    const h = routes[key];
    return h ? h(init) : new Response("nope", { status: 404 });
  }) as typeof fetch;
}

describe("giteaForge", () => {
  test("lists open PRs, reads a file at a sha, posts a status with the token", async () => {
    const log: string[] = [];
    let auth = "";
    const f = giteaForge({
      endpoint: "https://forge.test/api/v1",
      token: "t0k",
      fetch: fakeFetch({
        "GET /repos/o/r/pulls?state=open&limit=50&page=1": (i) => {
          auth = new Headers(i?.headers).get("authorization") ?? "";
          return Response.json([{ number: 7, head: { ref: "renovate/yaml-2.x", sha: "h1" }, base: { ref: "main", sha: "b1" } }]);
        },
        "GET /repos/o/r/pulls?state=open&limit=50&page=2": () => Response.json([]),
        "GET /repos/o/r/raw/bun.lock?ref=h1": () => new Response("LOCK"),
        "POST /repos/o/r/statuses/h1": () => Response.json({}, { status: 201 }),
      }, log),
    });
    expect(await f.openPulls("o/r")).toEqual([{ number: 7, headRef: "renovate/yaml-2.x", headSha: "h1", baseSha: "b1" }]);
    expect(auth).toBe("token t0k");
    expect(await f.readFile("o/r", "h1", "bun.lock")).toBe("LOCK");
    expect(await f.readFile("o/r", "h1", "missing.lock")).toBeUndefined();
    await f.setStatus("o/r", "h1", { state: "success", context: "oupdate/review", description: "ok" });
    expect(log.at(-1)).toBe('POST /repos/o/r/statuses/h1 {"state":"success","context":"oupdate/review","description":"ok"}');
  });

  test("upsertComment edits the comment carrying the marker, else creates one", async () => {
    const log: string[] = [];
    const f = giteaForge({
      endpoint: "https://forge.test/api/v1",
      token: "t",
      fetch: fakeFetch({
        "GET /repos/o/r/issues/7/comments": () => Response.json([{ id: 1, body: "hi" }, { id: 9, body: "<!-- m -->\nold" }]),
        "PATCH /repos/o/r/issues/comments/9": () => Response.json({}),
        "GET /repos/o/r/issues/8/comments": () => Response.json([]),
        "POST /repos/o/r/issues/8/comments": () => Response.json({}, { status: 201 }),
      }, log),
    });
    await f.upsertComment("o/r", 7, "<!-- m -->", "<!-- m -->\nnew");
    await f.upsertComment("o/r", 8, "<!-- m -->", "<!-- m -->\nnew");
    expect(log.filter((l) => !l.startsWith("GET"))).toEqual([
      'PATCH /repos/o/r/issues/comments/9 {"body":"<!-- m -->\\nnew"}',
      'POST /repos/o/r/issues/8/comments {"body":"<!-- m -->\\nnew"}',
    ]);
  });

  test("a failed write throws with the status", async () => {
    const f = giteaForge({ endpoint: "https://forge.test/api/v1", token: "t", fetch: fakeFetch({}, []) });
    await expect(f.setStatus("o/r", "x", { state: "success", context: "c", description: "d" })).rejects.toThrow(/404/);
  });
});

function result(c: Change, decision: "land" | "hold", stops: string[] = [], errors: string[] = []): ReviewResult {
  return {
    eco: "npm", name: c.name, from: c.from ?? "", to: c.to, decision,
    layers: [
      ...stops.map((l) => ({ layer: l as "cooldown", verdict: "stop" as const, detail: `${l} said no` })),
      ...errors.map((l) => ({ layer: l as "reviewer", verdict: "error" as const, detail: `${l} broke` })),
    ],
  };
}

describe("gateState", () => {
  test("all land -> success; a hard stop -> failure; only cooldown stops or errors -> pending (re-checked)", () => {
    const c: Change = { name: "x", from: "1.0.0", to: "1.0.1", eco: "npm" };
    expect(gateState([result(c, "land")])).toBe("success");
    expect(gateState([result(c, "land"), result(c, "hold", ["prepass"])])).toBe("failure");
    expect(gateState([result(c, "hold", ["cooldown"])])).toBe("pending");
    expect(gateState([result(c, "hold", [], ["reviewer"])])).toBe("pending");
    expect(gateState([result(c, "hold", ["cooldown", "advisory"])])).toBe("failure");
  });
});

function memForge(files: Record<string, string>, statuses: Record<string, StatusState> = {}): Forge & { log: string[] } {
  const log: string[] = [];
  return {
    log,
    openPulls: async () => [
      { number: 1, headRef: "renovate/yaml", headSha: "h1", baseSha: "b" },
      { number: 2, headRef: "feature/x", headSha: "h2", baseSha: "b" },
      { number: 3, headRef: "renovate/done", headSha: "h3", baseSha: "b" },
    ],
    readFile: async (_r, sha, path) => files[`${sha}:${path}`],
    statusOf: async (_r, sha) => statuses[sha],
    setStatus: async (_r, sha, s) => void log.push(`status ${sha} ${s.state} ${s.description}`),
    upsertComment: async (_r, n, marker, body) => void log.push(`comment ${n} ${body.startsWith(marker)} ${body.includes("yaml 2.8.1 -> 2.8.3")}`),
  };
}

const SRI = (c: string) => `sha512-${c.repeat(86)}==`;
const LOCK = (v: string, sri = "sha512-x") => `{"lockfileVersion":1,"packages":{"yaml":["yaml@${v}","",{},"${sri}"],}}`;
/** yaml from the default registry plus @corp/ui from a private one. */
const MIXED = (yaml: string, ui: string) => `{"lockfileVersion":1,"packages":{"yaml":["yaml@${yaml}","",{},"x"],"@corp/ui":["@corp/ui@${ui}","https://npm.corp.example/",{},"x"]}}`;

describe("runGate", () => {
  test("reviews renovate PRs only, skips heads with a final status, posts pending then the verdict and a comment", async () => {
    const forge = memForge({ "b:bun.lock": LOCK("2.8.1"), "h1:bun.lock": LOCK("2.8.3"), "h3:bun.lock": LOCK("2.8.3") }, { h3: "success" });
    const seen: Change[] = [];
    const out = await runGate({ forge, repo: "o/r", review: async (c) => (seen.push(c), result(c, "land")) });
    expect(seen).toEqual([{ name: "yaml", from: "2.8.1", to: "2.8.3", eco: "npm" }]);
    expect(forge.log).toEqual(["status h1 pending reviewing 1 package change", "status h1 success 1 package: 1 land, 0 hold", "comment 1 true true"]);
    expect(out.map((p) => [p.number, p.state])).toEqual([[1, "success"], [3, "skipped"]]);
  });

  test("several branch prefixes each select PRs, so Renovate and Dependabot PRs share one gate", async () => {
    const forge = memForge({ "b:bun.lock": LOCK("2.8.1"), "h1:bun.lock": LOCK("2.8.3"), "h2:bun.lock": LOCK("2.8.3") }, { h3: "failure" });
    const out = await runGate({ forge, repo: "o/r", branchPrefixes: ["dependabot/", "feature/", "renovate/"], review: async (c) => result(c, "land") });
    expect(out.map((p) => [p.number, p.state])).toEqual([[1, "success"], [2, "success"], [3, "skipped"]]);
  });

  test("the lockfiles' sha512 integrity reaches the review, so it checks the bytes the install fetches", async () => {
    const forge = memForge({ "b:bun.lock": LOCK("2.8.1", SRI("A")), "h1:bun.lock": LOCK("2.8.3", SRI("B")) }, { h3: "failure" });
    const seen: Change[] = [];
    await runGate({ forge, repo: "o/r", review: async (c) => (seen.push(c), result(c, "land")) });
    expect(seen).toEqual([{ name: "yaml", from: "2.8.1", to: "2.8.3", eco: "npm", fromIntegrity: SRI("A"), toIntegrity: SRI("B") }]);
  });

  test("a malicious release gets a headline in the comment, above the layers", async () => {
    const forge = memForge({ "b:bun.lock": LOCK("2.8.1"), "h1:bun.lock": LOCK("2.8.3") }, { h3: "failure" });
    let body = "";
    forge.upsertComment = async (_r, _n, _m, b) => void (body = b);
    await runGate({ forge, repo: "o/r", review: async (c) => ({ ...result(c, "hold", ["advisory"]), malicious: ["MAL-2025-1"] }) });
    expect(body).toContain("**MALICIOUS: yaml 2.8.3 (MAL-2025-1).** Do not merge, and check where this version is already installed.");
    expect(body.indexOf("MALICIOUS")).toBeLessThan(body.indexOf("advisory"));
  });

  test("a review that throws counts as an error layer, so the PR stays pending", async () => {
    const forge = memForge({ "b:bun.lock": LOCK("2.8.1"), "h1:bun.lock": LOCK("2.8.3") }, { h3: "failure" });
    const out = await runGate({ forge, repo: "o/r", review: async () => { throw new Error("router down"); } });
    expect(out[0]!.state).toBe("pending");
    expect(out[0]!.results[0]!.eco).toBe("npm");
    expect(forge.log[1]).toBe("status h1 pending 1 package: 0 land, 1 hold");
  });

  test("several lock paths go into one status and comment; the same bump in two locks is reviewed once", async () => {
    const forge = memForge({ "b:bun.lock": LOCK("2.8.1"), "h1:bun.lock": LOCK("2.8.3"), "b:web/bun.lock": LOCK("2.8.1"), "h1:web/bun.lock": LOCK("2.8.3"), "b:api/bun.lock": LOCK("1.0.0"), "h1:api/bun.lock": LOCK("1.0.1") }, { h3: "failure" });
    let body = "";
    forge.upsertComment = async (_r, _n, _m, b) => void (body = b);
    const seen: Change[] = [];
    await runGate({ forge, repo: "o/r", lockPaths: ["bun.lock", "web/bun.lock", "api/bun.lock"], review: async (c) => (seen.push(c), result(c, "hold", ["prepass"])) });
    expect(seen.map((c) => c.to)).toEqual(["2.8.3", "1.0.1"]);
    expect(body).toContain("(bun.lock, web/bun.lock, api/bun.lock)");
    expect(forge.log[0]).toBe("status h1 pending reviewing 2 package changes");
  });

  test("with no lock paths given, the known lockfile names are looked up at the repo root", async () => {
    const forge = memForge({ "b:bun.lock": LOCK("2.8.1"), "h1:bun.lock": LOCK("2.8.3"), "h1:web/bun.lock": LOCK("9.9.9") }, { h3: "failure" });
    const read: string[] = [];
    const inner = forge.readFile;
    forge.readFile = async (r, sha, path) => (read.push(`${sha}:${path}`), inner(r, sha, path));
    const seen: Change[] = [];
    await runGate({ forge, repo: "o/r", review: async (c) => (seen.push(c), result(c, "land")) });
    expect(seen.map((c) => c.to)).toEqual(["2.8.3"]);
    for (const name of LOCK_NAMES) expect(read).toContain(`h1:${name}`);
    expect(read).not.toContain("h1:web/bun.lock");
  });

  test("a package-lock.json at the root is found and its bump reaches the review with eco and integrity", async () => {
    const NPMLOCK = (v: string, c: string) => JSON.stringify({ lockfileVersion: 3, packages: { "": { name: "root" }, "node_modules/yaml": { version: v, resolved: `https://registry.npmjs.org/yaml/-/yaml-${v}.tgz`, integrity: SRI(c) } } });
    const forge = memForge({ "b:package-lock.json": NPMLOCK("2.8.1", "A"), "h1:package-lock.json": NPMLOCK("2.8.3", "B") }, { h3: "failure" });
    const seen: Change[] = [];
    await runGate({ forge, repo: "o/r", review: async (c) => (seen.push(c), result(c, "land")) });
    expect(seen).toEqual([{ name: "yaml", from: "2.8.1", to: "2.8.3", eco: "npm", fromIntegrity: SRI("A"), toIntegrity: SRI("B") }]);
    expect(forge.log.at(-1)).toBe("comment 1 true true");
  });

  test("a uv.lock at the root is found: its bump reaches the review as pypi, a custom-index one is listed", async () => {
    const UV = (v: string, corp: string) => `version = 1\n\n[[package]]\nname = "PyYAML"\nversion = "${v}"\nsource = { registry = "https://pypi.org/simple" }\n\n[[package]]\nname = "corp-auth"\nversion = "${corp}"\nsource = { registry = "https://pypi.corp.example/simple" }\n`;
    const forge = memForge({ "b:uv.lock": UV("6.0.1", "4.1.0"), "h1:uv.lock": UV("6.0.2", "4.2.0") }, { h3: "failure" });
    let body = "";
    forge.upsertComment = async (_r, _n, _m, b) => void (body = b);
    const seen: Change[] = [];
    const out = await runGate({ forge, repo: "o/r", review: async (c) => (seen.push(c), result(c, "land")) });
    expect(seen).toEqual([{ name: "pyyaml", from: "6.0.1", to: "6.0.2", eco: "pypi" }]);
    expect(out[0]!.state).toBe("success");
    expect(body).toContain("**oupdate: success** (uv.lock)");
    expect(body).toContain("- `corp-auth 4.1.0 -> 4.2.0`: not reviewed (private registry pypi.corp.example)");
  });

  test("a requirements file named by lock path reaches the review as pypi; it is never read unasked", async () => {
    const REQ = (v: string) => `pyyaml==${v} \\\n    --hash=sha256:${"a".repeat(64)}\n`;
    const files = { "b:requirements.txt": REQ("6.0.1"), "h1:requirements.txt": REQ("6.0.2") };
    const seen: Change[] = [];
    await runGate({ forge: memForge(files, { h3: "failure" }), repo: "o/r", lockPaths: ["requirements.txt"], review: async (c) => (seen.push(c), result(c, "land")) });
    expect(seen).toEqual([{ name: "pyyaml", from: "6.0.1", to: "6.0.2", eco: "pypi" }]);
    const auto = await runGate({ forge: memForge(files, { h3: "failure" }), repo: "o/r", review: async () => { throw new Error("not called"); } });
    expect(auto[0]!.state).toBe("success");
  });

  test("a lockfileVersion 1 package-lock.json holds the PR at pending, asking for npm 7+", async () => {
    const v1 = JSON.stringify({ lockfileVersion: 1, dependencies: {} });
    const forge = memForge({ "b:package-lock.json": v1, "h1:package-lock.json": v1 }, { h3: "failure" });
    const out = await runGate({ forge, repo: "o/r", review: async () => { throw new Error("not called"); } });
    expect(out[0]!.state).toBe("pending");
    expect(forge.log[0]).toMatch(/^status h1 pending cannot read package-lock.json: .*npm 7/);
  });

  test("no known lockfile at the head -> success, saying none was found", async () => {
    const forge = memForge({}, { h3: "failure" });
    const out = await runGate({ forge, repo: "o/r", review: async () => { throw new Error("not called"); } });
    expect(out[0]!.state).toBe("success");
    expect(forge.log[0]).toMatch(/^status h1 success no lockfile found \(looked for bun.lock/);
  });

  test("a lockfile that cannot be parsed holds the PR at pending with the reason, never success", async () => {
    const forge = memForge({ "b:bun.lock": LOCK("2.8.1"), "h1:bun.lock": "{not json" }, { h3: "failure" });
    let body = "";
    forge.upsertComment = async (_r, _n, _m, b) => void (body = b);
    const out = await runGate({ forge, repo: "o/r", review: async () => { throw new Error("not called"); } });
    expect(out[0]!.state).toBe("pending");
    expect(forge.log[0]).toMatch(/^status h1 pending cannot read bun.lock: /);
    expect(body).toContain("cannot read bun.lock");
  });

  test("a version from a private registry is listed as not reviewed and leaves the state to the rest", async () => {
    const forge = memForge({ "b:bun.lock": MIXED("2.8.1", "3.0.0"), "h1:bun.lock": MIXED("2.8.3", "3.1.0") }, { h3: "failure" });
    let body = "";
    forge.upsertComment = async (_r, _n, _m, b) => void (body = b);
    const seen: Change[] = [];
    const out = await runGate({ forge, repo: "o/r", review: async (c) => (seen.push(c), result(c, "land")) });
    expect(seen.map((c) => c.name)).toEqual(["yaml"]);
    expect(out[0]!.state).toBe("success");
    expect(forge.log[1]).toBe("status h1 success 1 package: 1 land, 0 hold, 1 not reviewed (private registry)");
    expect(body).toContain("- `@corp/ui 3.0.0 -> 3.1.0`: not reviewed (private registry npm.corp.example)");
  });

  test("a PR touching only private-registry versions passes with the comment naming them", async () => {
    const forge = memForge({ "b:bun.lock": MIXED("2.8.1", "3.0.0"), "h1:bun.lock": MIXED("2.8.1", "3.1.0") }, { h3: "failure" });
    let body = "";
    forge.upsertComment = async (_r, _n, _m, b) => void (body = b);
    const out = await runGate({ forge, repo: "o/r", review: async () => { throw new Error("not called"); } });
    expect(out[0]!.state).toBe("success");
    expect(body).toContain("not reviewed (private registry npm.corp.example)");
  });

  test("the private-registry choice is one switch: hold keeps the PR pending, review sends it to the public registry", async () => {
    const files = { "b:bun.lock": MIXED("2.8.1", "3.0.0"), "h1:bun.lock": MIXED("2.8.1", "3.1.0") };
    const holdForge = memForge(files, { h3: "failure" });
    let body = "";
    holdForge.upsertComment = async (_r, _n, _m, b) => void (body = b);
    const held = await runGate({ forge: holdForge, repo: "o/r", privateRegistry: "hold", review: async () => { throw new Error("not called"); } });
    expect(held[0]!.state).toBe("pending");
    expect(body).toContain("@corp/ui 3.0.0 -> 3.1.0");
    expect(held[0]!.results[0]!.layers[0]!.detail).toContain("private registry npm.corp.example");
    const seen: Change[] = [];
    await runGate({ forge: memForge(files, { h3: "failure" }), repo: "o/r", privateRegistry: "review", review: async (c) => (seen.push(c), result(c, "land")) });
    expect(seen.map((c) => c.name)).toEqual(["@corp/ui"]);
  });

  test("no lockfile change -> success without a review", async () => {
    const forge = memForge({ "b:bun.lock": LOCK("2.8.1"), "h1:bun.lock": LOCK("2.8.1") }, { h3: "success" });
    const out = await runGate({ forge, repo: "o/r", review: async () => { throw new Error("not called"); } });
    expect(out[0]!.state).toBe("success");
    expect(forge.log).toEqual(["status h1 success no package changes in bun.lock"]);
  });
});
