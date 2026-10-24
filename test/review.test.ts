import { describe, expect, test } from "bun:test";
import { reviewUpdate, parseVerdict, chunkDiff, classifyOutcome, type LayerName } from "../src/review.ts";
import type { Registry } from "../src/adapters/ecosystem/types.ts";
import type { AdvisoryFeed, Advisory } from "../src/adapters/advisory/osv.ts";
import type { FileMap } from "../src/prepass.ts";

const enc = (s: string) => new TextEncoder().encode(s);
const files = (o: Record<string, string>): FileMap => new Map(Object.entries(o).map(([k, v]) => [k, enc(v)]));
const now = new Date("2026-10-21T18:00:00Z");
const hoursAgo = (h: number) => new Date(now.getTime() - h * 3_600_000);

function registry(published: Record<string, Date | undefined>): Registry {
  return {
    latest: async () => undefined,
    publishedAt: async (_n, v) => published[v],
    artifactUrls: async (_n, v) => [`https://files.example/${v}`],
  };
}
const noAdvisories: AdvisoryFeed = { query: async () => [] };
const approve = { name: "fake", review: async () => "APPROVE\nno attack indicators found" };
const flag = { name: "fake", review: async () => "FLAG\nexfil" };

const clean = { old: files({ "a.py": "x = 1\n" }), new: files({ "a.py": "x = 2\n" }) };
const evil = { old: files({ "a.py": "x = 1\n" }), new: files({ "a.py": "x = 1\n", "cook.pth": "import cook\n" }) };

function base(over: Partial<Parameters<typeof reviewUpdate>[0]> = {}): Parameters<typeof reviewUpdate>[0] {
  return {
    eco: "pypi",
    name: "pkg",
    from: "1.0.0",
    to: "1.0.1",
    registry: registry({ "1.0.1": hoursAgo(24 * 10) }),
    advisories: noAdvisories,
    reviewer: approve,
    cooldownDays: 7,
    now,
    loadArtifacts: async () => clean,
    ...over,
  };
}

describe("reviewUpdate", () => {
  test("a clean, old-enough bump lands with every layer recorded", async () => {
    const r = await reviewUpdate(base());
    expect(r.decision).toBe("land");
    expect(r.layers.map((l) => l.layer)).toEqual(["cooldown", "advisory", "prepass", "scan", "reviewer", "gate"]);
    expect(r.layers.find((l) => l.layer === "gate")?.verdict).toBe("skipped");
  });

  test("a fresh release is stopped by the cooldown, and later layers still run and record", async () => {
    const r = await reviewUpdate(base({ registry: registry({ "1.0.1": hoursAgo(1.7) }) }));
    expect(r.decision).toBe("hold");
    expect(r.layers.find((l) => l.layer === "cooldown")?.verdict).toBe("stop");
    expect(r.layers.find((l) => l.layer === "prepass")?.verdict).toBe("pass");
  });

  test("an advisory on the target version stops it", async () => {
    const adv: Advisory = { pkg: { ecosystem: "PyPI", name: "pkg", version: "1.0.1" }, id: "MAL-1", summary: "malicious", severity: "critical", fixed: [], malicious: true };
    const r = await reviewUpdate(base({ advisories: { query: async () => [adv] } }));
    expect(r.layers.find((l) => l.layer === "advisory")).toMatchObject({ verdict: "stop" });
    expect(r.decision).toBe("hold");
  });

  test("a hard pre-pass signal stops it even when the reviewer approves", async () => {
    const r = await reviewUpdate(base({ loadArtifacts: async () => evil, reviewer: approve }));
    expect(r.layers.find((l) => l.layer === "prepass")?.verdict).toBe("stop");
    expect(r.layers.find((l) => l.layer === "reviewer")?.verdict).toBe("pass");
    expect(r.decision).toBe("hold");
  });

  test("a reviewer FLAG stops it", async () => {
    const r = await reviewUpdate(base({ reviewer: flag }));
    expect(r.layers.find((l) => l.layer === "reviewer")?.verdict).toBe("stop");
    expect(r.decision).toBe("hold");
  });

  test("no reviewer configured holds (fail closed)", async () => {
    const r = await reviewUpdate(base({ reviewer: undefined }));
    expect(r.layers.find((l) => l.layer === "reviewer")?.verdict).toBe("error");
    expect(r.decision).toBe("hold");
  });

  describe("advisory split: malicious vs vulnerability", () => {
    const mk = (id: string, version: string, malicious = false): Advisory => ({ pkg: { ecosystem: "PyPI", name: "pkg", version }, id, summary: id, severity: "high", fixed: [], malicious });
    const feed = (advs: Advisory[]) => ({ query: async (pkgs: { version: string }[]) => advs.filter((a) => pkgs.some((p) => p.version === a.pkg.version)) });
    const adv = (r: Awaited<ReturnType<typeof reviewUpdate>>) => r.layers.find((l) => l.layer === "advisory")!;

    test("a malicious advisory on the target stops it and is named on the result", async () => {
      const r = await reviewUpdate(base({ advisories: feed([mk("MAL-1", "1.0.1", true), mk("GHSA-x", "1.0.0"), mk("GHSA-x", "1.0.1")]) }));
      expect(adv(r)).toMatchObject({ verdict: "stop" });
      expect(adv(r).detail).toStartWith("malicious: MAL-1");
      expect(r.malicious).toEqual(["MAL-1"]);
      expect(r.decision).toBe("hold");
    });

    test("a vulnerability the old version already has does not stop the update", async () => {
      const r = await reviewUpdate(base({ advisories: feed([mk("GHSA-x", "1.0.0"), mk("GHSA-x", "1.0.1")]) }));
      expect(adv(r).verdict).toBe("pass");
      expect(adv(r).detail).toContain("already in 1.0.0: GHSA-x");
      expect(r.malicious).toBeUndefined();
      expect(r.decision).toBe("land");
    });

    test("a vulnerability the update introduces stops it; one it removes is reported as fixed", async () => {
      const r = await reviewUpdate(base({ advisories: feed([mk("GHSA-old", "1.0.0"), mk("GHSA-new", "1.0.1")]) }));
      expect(adv(r).verdict).toBe("stop");
      expect(adv(r).detail).toContain("introduces: GHSA-new");
      expect(adv(r).detail).toContain("fixes: GHSA-old");
    });

    test("a new package (empty from) is checked on the target alone", async () => {
      const seen: string[] = [];
      const r = await reviewUpdate(base({ from: "", advisories: { query: async (p) => (seen.push(...p.map((x) => x.version)), [mk("GHSA-y", "1.0.1")]) } }));
      expect(seen).toEqual(["1.0.1"]);
      expect(adv(r).detail).toContain("introduces: GHSA-y");
    });
  });

  test("an advisory feed error holds and is recorded as error", async () => {
    const r = await reviewUpdate(base({ advisories: { query: async () => { throw new Error("osv 500"); } } }));
    expect(r.layers.find((l) => l.layer === "advisory")).toMatchObject({ verdict: "error" });
    expect(r.decision).toBe("hold");
  });

  test("artifacts that cannot load hold, and the reviewer is not asked", async () => {
    let asked = false;
    const r = await reviewUpdate(base({ loadArtifacts: async () => { throw new Error("quarantined"); }, reviewer: { name: "x", review: async () => { asked = true; return "APPROVE"; } } }));
    expect(r.layers.find((l) => l.layer === "prepass")?.verdict).toBe("error");
    expect(asked).toBe(false);
    expect(r.decision).toBe("hold");
  });

  test("a gate runs only when given, and a failing gate holds", async () => {
    const r = await reviewUpdate(base({ gate: { name: "g", run: async () => ({ ok: false, detail: "rc 1" }) } }));
    expect(r.layers.find((l) => l.layer === "gate")).toMatchObject({ verdict: "stop", detail: "rc 1" });
    expect(r.decision).toBe("hold");
  });

  test("only selected layers run when asked (per-layer replay)", async () => {
    const r = await reviewUpdate(base({ only: ["prepass"], loadArtifacts: async () => evil }));
    expect(r.layers.map((l) => [l.layer, l.verdict])).toEqual([
      ["cooldown", "skipped"],
      ["advisory", "skipped"],
      ["prepass", "stop"],
      ["scan", "skipped"],
      ["reviewer", "skipped"],
      ["gate", "skipped"],
    ]);
  });
});

describe("parseVerdict", () => {
  test("line 1 APPROVE alone is approve", () => {
    expect(parseVerdict("APPROVE\nno attack indicators found")).toBe("APPROVE");
  });
  test("anything else on line 1 is FLAG", () => {
    expect(parseVerdict("APPROVE - looks fine")).toBe("FLAG");
    expect(parseVerdict("")).toBe("FLAG");
    expect(parseVerdict("Sure! APPROVE")).toBe("FLAG");
  });
  test("an APPROVE that contradicts itself later is FLAG", () => {
    expect(parseVerdict("APPROVE\nVerdict: FLAG")).toBe("FLAG");
    expect(parseVerdict("APPROVE\nI would block this")).toBe("FLAG");
    expect(parseVerdict("APPROVE\nwe should reject this release")).toBe("FLAG");
    expect(parseVerdict("APPROVE\nthis should be flagged for a human")).toBe("FLAG");
    expect(parseVerdict("APPROVE\ndo not land this")).toBe("FLAG");
    expect(parseVerdict("APPROVE\nFLAG")).toBe("FLAG");
    expect(parseVerdict("APPROVE\nok, but HOLD until checked")).toBe("FLAG");
  });
  test("the same words used as plain English in an APPROVE stay APPROVE", () => {
    // Opus calibration 10-21: yaml 2.8.3 and bitwarden 2026.3.0 controls, both APPROVE, read as FLAG.
    expect(parseVerdict("APPROVE\nAnchor assignment moved inside the try block.")).toBe("APPROVE");
    expect(parseVerdict("APPROVE\nthe new `ssoCookieVendor` bootstrap block is read from the server")).toBe("APPROVE");
    expect(parseVerdict("APPROVE\nbehind the `UnlockViaSDK` feature flag")).toBe("APPROVE");
    expect(parseVerdict("APPROVE\nthe map holds a reference; a deny list of hosts")).toBe("APPROVE");
  });
  test("leading whitespace and a trailing period are tolerated", () => {
    expect(parseVerdict("  APPROVE.\nok")).toBe("APPROVE");
    expect(parseVerdict("FLAG\nx")).toBe("FLAG");
  });
});

describe("chunkDiff", () => {
  test("splits on file boundaries under the size cap and keeps every file", () => {
    const old = files({});
    const next = files({ "a.py": "a".repeat(50), "b.py": "b".repeat(50), "c.py": "c".repeat(50) });
    const chunks = chunkDiff(old, next, 140);
    expect(chunks.length).toBeGreaterThan(1);
    const joined = chunks.join("");
    for (const f of ["a.py", "b.py", "c.py"]) expect(joined).toContain(f);
  });

  test("a single file over the cap is split into pieces, none dropped", () => {
    const chunks = chunkDiff(files({}), files({ "big.py": "x\n".repeat(200) }), 100);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("").split("+x").length - 1).toBe(200);
  });

  test("one line longer than the cap is sliced, no chunk over the cap", () => {
    const line = "Z".repeat(1050);
    const chunks = chunkDiff(files({}), files({ "cook.py": line }), 100);
    expect(Math.max(...chunks.map((c) => c.length))).toBeLessThanOrEqual(100);
    expect(chunks.join("").split("Z").length - 1).toBe(1050);
  });

  test("binary files are described, not inlined", () => {
    const chunks = chunkDiff(files({}), new Map([["blob.so", new Uint8Array([0, 1, 2, 0, 255])]]), 1000);
    expect(chunks.join("")).toContain("binary");
  });
});

describe("review budget", () => {
  test("files that never execute are left out of the diff; code, manifests and .pth stay", () => {
    const next = files({
      "logo.png": "PNG", "dist/index.js.map": "{}", "types/index.d.ts": "export {}", "README.md": "# hi", "LICENSE": "MIT",
      "dist/index.js": "run()", "package.json": "{}", "cook.pth": "import cook",
    });
    const text = chunkDiff(files({}), next, 100_000).join("");
    for (const p of ["dist/index.js", "package.json", "cook.pth"]) expect(text).toContain(p);
    for (const p of ["logo.png", "index.js.map", "index.d.ts", "README.md", "LICENSE"]) expect(text).not.toContain(p);
  });

  test("a diff over maxParts is a reviewer stop that needs a human, and the reviewer is not called", async () => {
    let calls = 0;
    const big = { old: files({}), new: files({ "a.py": "x = 1\n".repeat(400) }) };
    const r = await reviewUpdate(base({ loadArtifacts: async () => big, chunkChars: 100, maxParts: 3, reviewer: { name: "fake", review: async () => (calls++, "APPROVE") } }));
    expect(calls).toBe(0);
    expect(r.layers.find((l) => l.layer === "reviewer")).toMatchObject({ verdict: "stop" });
    expect(r.layers.find((l) => l.layer === "reviewer")!.detail).toMatch(/too large for model review: \d+ parts > 3/);
  });

  // Priority chunks: over budget, review the files an attack needs (signals, new files, manifests and
  // install or startup files) and name what was left out, instead of holding the whole update.
  const plain = (n: number, v: string) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`lib/m${i}.py`, `x = ${v}\n`.repeat(20)]));
  const wide = {
    old: files({ ...plain(10, "1"), "setup.py": "v = 1\n", "lib/net.py": "a = 1\n" }),
    new: files({ ...plain(10, "2"), "setup.py": "v = 2\n", "lib/net.py": "a = 1\nimport subprocess; subprocess.run(['sh'])\n", "lib/new.py": "y = 1\n" }),
  };

  test("over maxParts, the reviewer sees only priority files and the detail names what it left out", async () => {
    const prompts: string[] = [];
    const r = await reviewUpdate(base({ loadArtifacts: async () => wide, chunkChars: 200, maxParts: 3, reviewer: { name: "fake", review: async (p) => (prompts.push(p), "APPROVE\nno attack indicators found") } }));
    const seen = prompts.join("");
    for (const p of ["setup.py", "lib/net.py", "lib/new.py"]) expect(seen).toContain(p);
    expect(seen).not.toContain("lib/m0.py");
    expect(seen).toContain("priority files only");
    const rev = r.layers.find((l) => l.layer === "reviewer")!;
    expect(rev.verdict).toBe("pass");
    expect(rev.detail).toMatch(/10 lower-priority file\(s\) not reviewed/);
  });

  test("a FLAG on a priority part still stops", async () => {
    const r = await reviewUpdate(base({ loadArtifacts: async () => wide, chunkChars: 200, maxParts: 3, reviewer: flag }));
    expect(r.layers.find((l) => l.layer === "reviewer")).toMatchObject({ verdict: "stop" });
    expect(r.decision).toBe("hold");
  });

  // Signal tier: when the priority files alone are over budget, review only the files with a pre-pass or
  // scanner signal (plus manifests and install or startup files). A FLAG there stops; an APPROVE never lands
  // the update, because the files left out were not read: it stays held for a human.
  const bigNew = { old: wide.old, new: new Map([...wide.new, ["lib/big.py", enc("z = 1\n".repeat(200))]]) };

  test("priority files alone over maxParts: the reviewer sees only the signal files; APPROVE is still held for a human", async () => {
    const prompts: string[] = [];
    const r = await reviewUpdate(base({ loadArtifacts: async () => bigNew, chunkChars: 200, maxParts: 3, reviewer: { name: "fake", review: async (p) => (prompts.push(p), "APPROVE") } }));
    const seen = prompts.join("");
    for (const p of ["lib/net.py", "setup.py"]) expect(seen).toContain(p);
    for (const p of ["lib/big.py", "lib/new.py", "lib/m0.py"]) expect(seen).not.toContain(p);
    expect(seen).toContain("signal files only");
    const rev = r.layers.find((l) => l.layer === "reviewer")!;
    expect(rev.verdict).toBe("stop");
    expect(rev.detail).toMatch(/^too large for model review: \d+ parts > 3 \(priority files alone\); fake APPROVE on the signal files \(\d+ part\(s\)\), 12 file\(s\) not reviewed; needs a human$/);
    expect(classifyOutcome(r)).toBe("held-human");
  });

  test("a FLAG on the signal files stops automatically", async () => {
    const r = await reviewUpdate(base({ loadArtifacts: async () => bigNew, chunkChars: 200, maxParts: 3, reviewer: flag }));
    const rev = r.layers.find((l) => l.layer === "reviewer")!;
    expect(rev.verdict).toBe("stop");
    expect(rev.detail).toMatch(/^fake FLAG on signal part\(s\) 1 of \d+; 12 file\(s\) not reviewed$/);
    expect(classifyOutcome(r)).toBe("stopped");
  });

  test("signal files alone over maxParts: a stop for a human, the reviewer is not called", async () => {
    let calls = 0;
    const loud = { old: bigNew.old, new: new Map([...bigNew.new, ["lib/net.py", enc("import subprocess; subprocess.run(['sh'])\n".repeat(60))]]) };
    const r = await reviewUpdate(base({ loadArtifacts: async () => loud, chunkChars: 200, maxParts: 3, reviewer: { name: "fake", review: async () => (calls++, "APPROVE") } }));
    expect(calls).toBe(0);
    expect(r.layers.find((l) => l.layer === "reviewer")!.detail).toMatch(/too large for model review: \d+ parts > 3 \(signal files alone\); needs a human/);
  });

  test("a diff within maxParts is reviewed whole, with no left-out note", async () => {
    const r = await reviewUpdate(base({ loadArtifacts: async () => wide, chunkChars: 200, maxParts: 50 }));
    expect(r.layers.find((l) => l.layer === "reviewer")!.detail).toMatch(/^fake APPROVE on \d+ part\(s\)$/);
  });
});

describe("scan layer", () => {
  const pkg = { old: files({ "a.py": "x = 1\n" }), new: files({ "a.py": "x = 2\n", "lib/new.py": "y = 1\n" }) };
  const scanner = (byFile: Record<string, string[]>) => ({
    name: "gd",
    scan: async (_eco: string, f: FileMap) => [...f.keys()].flatMap((p) => (byFile[p] ?? []).map((rule) => ({ rule, path: p, detail: `${p}:1` }))),
  });

  test("no scanner given is skipped, not an error", async () => {
    const r = await reviewUpdate(base({ loadArtifacts: async () => pkg }));
    expect(r.layers.find((l) => l.layer === "scan")).toMatchObject({ verdict: "skipped" });
    expect(r.decision).toBe("land");
  });

  test("findings new in the new release pass as signals and reach the reviewer prompt", async () => {
    const prompts: string[] = [];
    const sc = { ...scanner({ "a.py": ["shady-links"], "lib/new.py": ["exec-base64"] }), scan: async (e: string, f: FileMap) => (f.has("lib/new.py") ? scanner({ "a.py": ["shady-links"], "lib/new.py": ["exec-base64"] }).scan(e, f) : scanner({ "a.py": ["shady-links"] }).scan(e, f)) };
    const r = await reviewUpdate(base({ loadArtifacts: async () => pkg, scanner: sc, reviewer: { name: "fake", review: async (p) => (prompts.push(p), "APPROVE\nno attack indicators found") } }));
    const layer = r.layers.find((l) => l.layer === "scan")!;
    expect(layer.verdict).toBe("pass");
    expect(layer.detail).toBe("gd: 2 changed file(s) scanned, 1 new finding(s): exec-base64 lib/new.py");
    expect(prompts.join("")).toContain("soft gd:exec-base64 lib/new.py");
    expect(prompts.join("")).not.toContain("gd:shady-links");
  });

  test("a scanner failure is an error, so the update holds", async () => {
    const r = await reviewUpdate(base({ loadArtifacts: async () => pkg, scanner: { name: "gd", scan: async () => { throw new Error("docker down"); } } }));
    expect(r.layers.find((l) => l.layer === "scan")).toMatchObject({ verdict: "error" });
    expect(r.decision).toBe("hold");
  });

  test("only added and changed files are scanned, old copies of the changed paths on the old side", async () => {
    const seen: string[][] = [];
    const rec = { name: "gd", scan: async (_e: string, f: FileMap) => (seen.push([...f.keys()].sort()), []) };
    const p = { old: files({ "same.py": "s\n", "a.py": "x = 1\n", "gone.py": "g\n" }), new: files({ "same.py": "s\n", "a.py": "x = 2\n", "lib/new.py": "y\n" }) };
    const r = await reviewUpdate(base({ loadArtifacts: async () => p, scanner: rec }));
    expect(seen).toEqual([["a.py"], ["a.py", "lib/new.py"]]);
    expect(r.layers.find((l) => l.layer === "scan")!.detail).toContain("2 changed file(s) scanned");
  });

  test("a per-package hit budget cannot hide a new file behind unchanged code (GuardDog max_hits)", async () => {
    // Models GuardDog 3.2.0: each rule reports its first match in sorted path order, then stops.
    const budget = { name: "gd", scan: async (_e: string, f: FileMap) => {
      const walk = (a: string, b: string) => { const x = a.split("/"), y = b.split("/"); for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i]! < y[i]! ? -1 : 1; return x.length - y.length; };
      const first = [...f.keys()].sort(walk).find((k) => new TextDecoder().decode(f.get(k)!).includes("b64exec"));
      return first ? [{ rule: "exec-base64", path: first, detail: "" }] : [];
    } };
    const p = { old: files({ "big/a.py": "b64exec\n" }), new: files({ "big/a.py": "b64exec\n", "big-1.0.data/purelib/hook.py": "b64exec\n" }) };
    const r = await reviewUpdate(base({ loadArtifacts: async () => p, scanner: budget }));
    expect(r.layers.find((l) => l.layer === "scan")!.detail).toContain("exec-base64 big-1.0.data/purelib/hook.py");
  });

  test("no changed files: the scanner is not called", async () => {
    let called = 0;
    const same = { old: files({ "a.py": "x\n" }), new: files({ "a.py": "x\n" }) };
    const r = await reviewUpdate(base({ loadArtifacts: async () => same, scanner: { name: "gd", scan: async () => (called++, []) } }));
    expect(called).toBe(0);
    expect(r.layers.find((l) => l.layer === "scan")).toMatchObject({ verdict: "pass", detail: "gd: no changed files" });
  });

  test("the scan layer runs between prepass and reviewer", async () => {
    const r = await reviewUpdate(base({ loadArtifacts: async () => pkg, scanner: scanner({}) }));
    expect(r.layers.map((l) => l.layer)).toEqual(["cooldown", "advisory", "prepass", "scan", "reviewer", "gate"]);
  });
});


describe("classifyOutcome", () => {
  const r = (decision: "land" | "hold", layers: { layer: LayerName; verdict: "pass" | "stop" | "error" | "skipped"; detail: string }[]) => ({ eco: "npm" as const, name: "x", from: "1", to: "2", decision, layers });
  test("a detection stop is stopped, even next to a too-large reviewer", () => {
    expect(classifyOutcome(r("hold", [{ layer: "prepass", verdict: "stop", detail: "install script" }, { layer: "reviewer", verdict: "stop", detail: "too large for model review: 9 parts > 4; needs a human" }]))).toBe("stopped");
  });
  test("only too large: held for a human", () => {
    expect(classifyOutcome(r("hold", [{ layer: "prepass", verdict: "pass", detail: "" }, { layer: "reviewer", verdict: "stop", detail: "too large for model review: 9 parts > 4; needs a human" }]))).toBe("held-human");
  });
  test("an error alone is error; a land is passed", () => {
    expect(classifyOutcome(r("hold", [{ layer: "scan", verdict: "error", detail: "docker" }]))).toBe("error");
    expect(classifyOutcome(r("land", [{ layer: "prepass", verdict: "pass", detail: "" }]))).toBe("passed");
  });
});
