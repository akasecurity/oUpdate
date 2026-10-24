// Ported from the previous updater's cask-gatekeeper cases (test/port/06). They run on real xattr, file
// and find (macOS only) against copies of /bin/echo, with the Team ID and notarization gates faked.
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realExec } from "../../src/apply/exec.ts";
import { gkCheck, gkRelease, gkRevert, gkSnapshot, realGates, type GkEnv, type GkOptions } from "../../src/apply/gatekeeper.ts";

const mac = process.platform === "darwin";
const root = mkdtempSync(join(tmpdir(), "oupdate-gk-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const DYLIB = mac ? ["/opt/homebrew/lib", "/usr/local/lib"].flatMap((d) => (existsSync(d) ? readdirSync(d).filter((f) => f.endsWith(".dylib")).map((f) => join(d, f)) : []))[0] : undefined;

const sh = (...argv: string[]) => Bun.spawnSync(argv);
// Quarantine flags: 0181 unapproved, 01c1 user-approved (bit 0x40).
const q = (flags: string, file: string) => sh("xattr", "-w", "com.apple.quarantine", `${flags};6abd1b71;Homebrew Cask;A17BEE11-8508-47AD-AC7D-37C383401AA3`, file);
const st = (file: string) => {
  const r = sh("xattr", "-p", "com.apple.quarantine", file);
  return r.exitCode === 0 ? r.stdout.toString().slice(0, 4) : "none";
};

let n = 0;
// teams and reject apply to files of the new version (1.2) only, by base name.
function fixture(o: { teams?: Record<string, string>; reject?: string[]; notarizedAny?: boolean } = {}) {
  const dir = join(root, `case-${++n}`);
  const teamOf = (f: string) => (f.includes("/1.2/") ? o.teams?.[f.split("/").at(-1)!] : undefined) ?? "TEAMAAAAAA";
  const env: GkEnv = {
    exec: realExec,
    caskroom: join(dir, "Caskroom"),
    prefix: join(dir, "prefix"),
    stateDir: join(dir, "state"),
    team: async (f) => teamOf(f),
    notarized: async (f, team) => !(f.includes("/1.2/") && (o.reject ?? []).includes(f.split("/").at(-1)!)) && (o.notarizedAny || teamOf(f) === team),
  };
  mkdirSync(join(env.prefix, "bin"), { recursive: true });
  mkdirSync(env.stateDir, { recursive: true });
  const version = (v: string, oldFlags?: string) => {
    const ver = join(env.caskroom, "tool", v);
    mkdirSync(join(ver, "bin"), { recursive: true });
    for (const b of ["tool", "helper"]) {
      copyFileSync("/bin/echo", join(ver, "bin", b));
      if (oldFlags) q(oldFlags, join(ver, "bin", b));
    }
    return ver;
  };
  const link = (ver: string) => {
    for (const b of ["tool", "helper"]) {
      const l = join(env.prefix, "bin", b);
      if (existsSync(l) || sh("test", "-L", l).exitCode === 0) unlinkSync(l);
      symlinkSync(join(ver, "bin", b), l);
    }
  };
  // The upgrade: a new version dir with quarantined binaries, relinked, the old one removed.
  const upgrade = (oldVer: string) => {
    const ver = version("1.2", "0181");
    const later = new Date(Date.now() + 60_000);
    utimesSync(ver, later, later);
    link(ver);
    rmSync(oldVer, { recursive: true, force: true });
    return ver;
  };
  const notices: string[] = [];
  const opts = (dryRun = false): GkOptions => ({ dryRun, host: "fixture", notify: (t) => void notices.push(t) });
  return { env, version, link, upgrade, notices, opts, dir };
}

describe.if(mac)("gkCheck", () => {
  test("an unapproved quarantined executable is reported and notified", async () => {
    const f = fixture();
    const ver = f.version("1.2");
    q("0181", join(ver, "bin/tool"));
    const v = await gkCheck(f.env, "tool", f.opts());
    expect(v.note).toBe("tool: 1 unapproved");
    expect(v.log).toContain("    bin/tool");
    expect(f.notices).toHaveLength(1);
    expect(f.notices[0]).toContain("Gatekeeper approval pending");
  });
  test("approved (0x40), unquarantined, non-Mach-O and in-.app files are not reported", async () => {
    const f = fixture();
    const ver = f.version("1.2");
    q("01c1", join(ver, "bin/tool"));
    writeFileSync(join(ver, "bin/script"), "#!/bin/sh\necho\n");
    q("0181", join(ver, "bin/script"));
    mkdirSync(join(ver, "Tool.app/Contents/MacOS"), { recursive: true });
    copyFileSync("/bin/echo", join(ver, "Tool.app/Contents/MacOS/Tool"));
    q("0181", join(ver, "Tool.app/Contents/MacOS/Tool"));
    expect((await gkCheck(f.env, "tool", f.opts())).note).toBe("");
    expect(f.notices).toEqual([]);
  });
  test.if(DYLIB !== undefined)("a quarantined dylib is counted, not listed as an executable", async () => {
    const f = fixture();
    const ver = f.version("1.2");
    q("0181", join(ver, "bin/tool"));
    mkdirSync(join(ver, "lib"));
    copyFileSync(DYLIB!, join(ver, "lib/x.dylib"));
    chmodSync(join(ver, "lib/x.dylib"), 0o644); // brew's dylibs are read-only, and xattr needs write
    q("0181", join(ver, "lib/x.dylib"));
    const v = await gkCheck(f.env, "tool", f.opts());
    expect(v.note).toBe("tool: 1 unapproved + 1 dylib");
    expect(v.log.join("\n")).not.toContain("x.dylib");
  });
  test("Homebrew's .metadata dir is never taken for the version dir, however new", async () => {
    const f = fixture();
    const ver = f.version("1.2");
    q("0181", join(ver, "bin/tool"));
    mkdirSync(join(f.env.caskroom, "tool", ".metadata"));
    const later = new Date(Date.now() + 120_000);
    utimesSync(join(f.env.caskroom, "tool", ".metadata"), later, later);
    expect((await gkCheck(f.env, "tool", f.opts())).note).toBe("tool: 1 unapproved");
  });
  test("a dangling link in the cask dir (e.g. latest → gone) is skipped, not fatal", async () => {
    const f = fixture();
    const ver = f.version("1.2");
    q("0181", join(ver, "bin/tool"));
    symlinkSync(join(f.env.caskroom, "tool", "gone"), join(f.env.caskroom, "tool", "latest"));
    expect((await gkCheck(f.env, "tool", f.opts())).note).toBe("tool: 1 unapproved");
  });
  test("only the newest version directory is scanned", async () => {
    const f = fixture();
    const old = f.version("1.1");
    q("0181", join(old, "bin/tool"));
    utimesSync(old, new Date("2026-01-01"), new Date("2026-01-01"));
    f.version("1.2");
    expect((await gkCheck(f.env, "tool", f.opts())).note).toBe("");
  });
  test("a missing caskroom is a no-op, never a failure", async () => {
    expect(await gkCheck(fixture().env, "nosuchcask", fixture().opts())).toEqual({ note: "", log: [] });
  });
});

describe.if(mac)("gkRelease", () => {
  const released = async (o: Parameters<typeof fixture>[0], oldFlags: string | undefined, setup?: (f: ReturnType<typeof fixture>) => void, dryRun = false) => {
    const f = fixture(o);
    const old = f.version("1.1", oldFlags);
    f.link(old);
    setup?.(f);
    const prior = await gkSnapshot(f.env, "tool");
    const ver = f.upgrade(old);
    const log = await gkRelease(f.env, "tool", f.opts(dryRun), { prior });
    return { f, ver, log, prior, tool: st(join(ver, "bin/tool")), helper: st(join(ver, "bin/helper")) };
  };
  test("prior approved, same team, notarized → quarantine removed, logged, the team pinned", async () => {
    const v = await released({}, "01c1");
    expect([v.tool, v.helper]).toEqual(["none", "none"]);
    expect(await Bun.file(join(v.f.env.stateDir, "gatekeeper-teams.tsv")).text()).toBe("tool\tTEAMAAAAAA\n");
    expect((await Bun.file(join(v.f.env.stateDir, "gatekeeper-release.tsv")).text()).trim().split("\n")).toHaveLength(2);
    expect(v.log).toContain("  tool: Gatekeeper — released 2 file(s), notarized TEAMAAAAAA");
  });
  test("prior never approved → nothing released", async () => {
    const v = await released({}, "0181");
    expect(v.tool).toBe("0181");
    expect(v.log.join("\n")).toContain("previous version was never approved");
  });
  test("an unquarantined prior counts as approved (Homebrew's rule)", async () => {
    const v = await released({}, undefined);
    expect(v.tool).toBe("none");
  });
  test("a new file signed by another team is kept, with an alert, even when Gatekeeper accepts it", async () => {
    const v = await released({ teams: { helper: "EVILTEAM00" }, notarizedAny: true }, "01c1");
    expect([v.tool, v.helper]).toEqual(["none", "0181"]);
    expect(v.f.notices.at(-1)).toContain("EVILTEAM00");
  });
  test("a pinned team that differs → nothing released, with an alert", async () => {
    const v = await released({}, "01c1", (f) => writeFileSync(join(f.env.stateDir, "gatekeeper-teams.tsv"), "tool\tPINNEDTEAM\n"));
    expect([v.tool, v.helper]).toEqual(["0181", "0181"]);
    expect(v.f.notices.at(-1)).toContain("PINNEDTEAM");
  });
  test("a pin that matches the team releases, and no second pin line is written", async () => {
    const v = await released({}, "01c1", (f) => writeFileSync(join(f.env.stateDir, "gatekeeper-teams.tsv"), "tool\tTEAMAAAAAA\n"));
    expect([v.tool, v.helper]).toEqual(["none", "none"]);
    expect(await Bun.file(join(v.f.env.stateDir, "gatekeeper-teams.tsv")).text()).toBe("tool\tTEAMAAAAAA\n");
  });
  test("an unreadable pins file holds, it never reads as no pin", async () => {
    const v = await released({}, "01c1", (f) => mkdirSync(join(f.env.stateDir, "gatekeeper-teams.tsv")));
    expect([v.tool, v.helper]).toEqual(["0181", "0181"]);
    expect(v.log.join("\n")).toContain("quarantine kept — cannot read");
  });
  test("a Gatekeeper rejection keeps that file quarantined", async () => {
    const v = await released({ reject: ["helper"] }, "01c1");
    expect([v.tool, v.helper]).toEqual(["none", "0181"]);
  });
  test("dry-run changes nothing", async () => {
    const v = await released({}, "01c1", undefined, true);
    expect(v.tool).toBe("0181");
    expect(v.log).toContain("  tool: would release bin/tool");
    expect(existsSync(join(v.f.env.stateDir, "gatekeeper-teams.tsv"))).toBe(false);
    expect(existsSync(join(v.f.env.stateDir, "gatekeeper-release.tsv"))).toBe(false);
  });
  test("a removal that cannot be logged is not made", async () => {
    const v = await released({}, "01c1", (f) => mkdirSync(join(f.env.stateDir, "gatekeeper-release.tsv")));
    expect([v.tool, v.helper]).toEqual(["0181", "0181"]);
    expect(v.f.notices.at(-1)).toContain("release log not writable");
  });
  test("revert with an unreadable release log says so and restores nothing", async () => {
    const f = fixture();
    mkdirSync(join(f.env.stateDir, "gatekeeper-release.tsv"));
    expect((await gkRevert(f.env, "tool"))[0]).toContain("cannot read");
  });
  test("revert restores every recorded quarantine value", async () => {
    const v = await released({}, "01c1");
    expect(v.tool).toBe("none");
    const log = await gkRevert(v.f.env, "tool");
    expect(log).toEqual(["  tool: restored quarantine on 2 file(s)"]);
    expect([st(join(v.ver, "bin/tool")), st(join(v.ver, "bin/helper"))]).toEqual(["0181", "0181"]);
  });
  test("approve with two teams on the linked binaries keeps the quarantine", async () => {
    const f = fixture({ teams: { helper: "TEAMBBBBBB" } });
    const ver = f.version("1.2", "0181");
    f.link(ver);
    const log = await gkRelease(f.env, "tool", f.opts(), "approve");
    expect([st(join(ver, "bin/tool")), st(join(ver, "bin/helper"))]).toEqual(["0181", "0181"]);
    expect(log).toContain("  tool: quarantine kept — no single Team ID on the linked binaries");
  });
  test("approve ignores an unsigned linked binary when the rest share one team", async () => {
    const f = fixture({ teams: { helper: "" } });
    const ver = f.version("1.2", "0181");
    f.link(ver);
    await gkRelease(f.env, "tool", f.opts(), "approve");
    expect(st(join(ver, "bin/tool"))).toBe("none");
    expect(await Bun.file(join(f.env.stateDir, "gatekeeper-teams.tsv")).text()).toBe("tool\tTEAMAAAAAA\n");
  });
  test("approve (the operator's bootstrap) needs no prior state and pins the linked binaries' team", async () => {
    const f = fixture();
    const ver = f.version("1.2", "0181");
    f.link(ver);
    await gkRelease(f.env, "tool", f.opts(), "approve");
    expect([st(join(ver, "bin/tool")), st(join(ver, "bin/helper"))]).toEqual(["none", "none"]);
    expect(await Bun.file(join(f.env.stateDir, "gatekeeper-teams.tsv")).text()).toBe("tool\tTEAMAAAAAA\n");
  });
  test("the real gates reject a copy of a system binary (no Developer ID team, not notarized)", async () => {
    const f = fixture();
    const g = realGates(realExec);
    const ver = f.version("1.2", "0181");
    f.link(ver);
    expect(await g.notarized(join(ver, "bin/tool"), "TEAMAAAAAA")).toBe(false);
    const env = { ...f.env, ...g };
    await gkRelease(env, "tool", f.opts(), { prior: { prior: "ok", team: "TEAMAAAAAA" } });
    expect(st(join(ver, "bin/tool"))).toBe("0181");
  });
});

describe.if(mac)("gkSnapshot", () => {
  for (const [label, teams] of [
    ["two teams", { tool: "TEAMAAAAAA", helper: "TEAMBBBBBB" }],
    ["an unsigned binary", { helper: "" }],
    ["a binary whose team is not set", { helper: "not set" }],
  ] as const) {
    test(`${label} on the linked binaries → unknown, so nothing is released`, async () => {
      const f = fixture();
      const old = f.version("1.1", "01c1");
      f.link(old);
      const env = { ...f.env, team: async (p: string) => (teams as Record<string, string>)[p.split("/").at(-1)!] ?? "TEAMAAAAAA" };
      expect(await gkSnapshot(env, "tool")).toEqual({ prior: "unknown", team: "" });
    });
  }
});

describe.if(mac)("spctl by absolute path", () => {
  test("realGates calls /usr/sbin/spctl by path, so it works with no /usr/sbin on PATH", async () => {
    const seen: string[] = [];
    const g = realGates(async (argv) => (seen.push(argv[0]!), realExec(argv, { env: { PATH: "/opt/homebrew/bin:/usr/bin:/bin" } })));
    expect(await g.notarized("/bin/echo", "TEAMAAAAAA")).toBe(false);
    expect(seen).toEqual(["/usr/sbin/spctl"]);
    const r = await realExec(["/usr/sbin/spctl", "--status"], { env: { PATH: "/opt/homebrew/bin:/usr/bin:/bin" } });
    expect(`${r.out}${r.err}`).toMatch(/assessments (enabled|disabled)/);
  });
});
