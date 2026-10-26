// Ported from secure-update's stale-keg, linkage and relink cases (test/port/05). The label
// resolution and restart paths had no source tests; the "restart" block below is new.
import { describe, expect, test } from "bun:test";
import { killLive, realExec, resetStopping, type Exec } from "../../src/apply/exec.ts";
import { caskRunning, kegHolders, linkageCheck, lsofMaps, relinkUpgraded, staleKegCheck, type KegEnv, type KegOptions } from "../../src/apply/kegs.ts";
import type { QueuedOwner } from "../../src/apply/owner-waiter.ts";

const CELLAR = "/brew/Cellar";
// The fleet digest's trouble words: a note that must alarm has to contain one of them.
const TROUBLE_RE = /flag|block|cve|error|fail|abort|no status|stuck|stale|divergent/i;
const lsofLine = (pid: string, path: string) => `python ${pid} u txt REG 1,4 100 200 ${path}`;

interface Fake {
  lsof?: (string | number)[]; // successive answers: text, or an rc for a failure
  dirs?: string[];
  files?: string[];
  plists?: Record<string, string[]>;
  ps?: Record<string, { comm?: string; command?: string; ppid?: string }>;
  rc?: Record<string, number>; // exit code for a command line (default 0)
  out?: Record<string, string>;
  timeout?: readonly string[]; // command lines that time out
  selfPid?: number;
}

function fakeEnv(f: Fake) {
  const calls: string[] = [];
  const lsof = [...(f.lsof ?? [])];
  const exec: Exec = async (argv) => {
    const line = argv.join(" ");
    calls.push(line);
    if (argv[0]!.endsWith("lsof")) {
      const a = lsof.length > 1 ? lsof.shift()! : lsof[0];
      if (a === undefined) return { rc: 127, out: "", err: "" };
      return typeof a === "number" ? { rc: a, out: "", err: "" } : { rc: 0, out: a, err: "" };
    }
    if (argv[0] === "ps") {
      const p = f.ps?.[argv[4]!] ?? {};
      const v = argv[2] === "comm=" ? p.comm : argv[2] === "command=" ? p.command : p.ppid;
      return { rc: v === undefined ? 1 : 0, out: v === undefined ? "" : `${v}\n`, err: "" };
    }
    if (line === "brew --cellar") return { rc: 0, out: `${CELLAR}\n`, err: "" };
    if (line === "brew --prefix") return { rc: 0, out: "/brew\n", err: "" };
    if (f.timeout?.includes(line)) return { rc: 124, out: "", err: "", timedOut: true };
    return { rc: f.rc?.[line] ?? 0, out: f.out?.[line] ?? "", err: "" };
  };
  const dirs = new Set([CELLAR, ...(f.dirs ?? [])]);
  const files = new Set(f.files ?? []);
  const spawned: string[] = [];
  const env: KegEnv = {
    exec,
    isDir: async (p) => dirs.has(p),
    exists: async (p) => files.has(p) || dirs.has(p),
    listDir: async (p) => f.plists?.[p] ?? [],
    home: "/home.test",
    uid: 501,
    selfPid: f.selfPid ?? 999999,
    spawnDetached: async (argv, err) => (spawned.push(`${argv.join(" ")} 2>${err}`), 4242),
  };
  return { env, calls, files, spawned };
}

function opts(over: Partial<KegOptions> = {}) {
  const notices: string[] = [];
  const handoffs: string[] = [];
  const o: KegOptions = {
    brew: "brew", lsof: "/usr/sbin/lsof", dryRun: false, host: "fixture",
    notify: (t) => void notices.push(t),
    deferred: ["model-svc"],
    handoff: async (keg) => (handoffs.push(keg), "restart handed to waiter (pid 4242)"),
    trackStuck: () => [],
    ...over,
  };
  return { o, notices, handoffs };
}

describe("kegHolders", () => {
  test("pid, package and keg dir for files under the Cellar, deduplicated; other paths ignored", () => {
    const out = [
      "COMMAND PID USER FD TYPE DEVICE SIZE NODE NAME",
      lsofLine("10", `${CELLAR}/fakepkg/1.0_old/bin/python`),
      lsofLine("10", `${CELLAR}/fakepkg/1.0_old/lib/x.dylib`),
      lsofLine("11", `${CELLAR}/other/2.0/lib/y.dylib`),
      lsofLine("12", "/usr/lib/libSystem.B.dylib"),
      lsofLine("13", `${CELLAR}/toplevel`),
    ].join("\n");
    expect(kegHolders(out, CELLAR)).toEqual([
      { pid: "10", pkg: "fakepkg", keg: `${CELLAR}/fakepkg/1.0_old` },
      { pid: "11", pkg: "other", keg: `${CELLAR}/other/2.0` },
    ]);
  });
  test("pids in numeric order (label review 1)", () => {
    // Mutant caught: pids sorted as strings (12345 before 9876).
    const out = [lsofLine("12345", `${CELLAR}/bun/1.0_old/bin/bun`), lsofLine("9876", `${CELLAR}/bun/1.0_old/bin/bun`)].join("\n");
    expect(kegHolders(out, CELLAR).map((h) => h.pid)).toEqual(["9876", "12345"]);
  });
});

describe.if(process.platform === "darwin")("real lsof", () => {
  test("works by its absolute path (the LaunchDaemon PATH has no /usr/sbin)", async () => {
    const env = { ...fakeEnv({}).env, exec: realExec };
    const out = await lsofMaps(env, "/usr/sbin/lsof", []);
    expect(out?.split("\n").length ?? 0).toBeGreaterThan(10);
  });
});

describe("staleKegCheck: detection", () => {
  test("a stale keg is found and logged", async () => {
    const { env } = fakeEnv({ lsof: [lsofLine("10", `${CELLAR}/fakepkg/1.0_old/bin/python`)], ps: { "10": { comm: "python", command: "python x", ppid: "99" } } });
    const v = await staleKegCheck(env, opts().o);
    expect(v.log.join("\n")).toContain("STALE KEG: fakepkg — pid 10 (python x) still running from 1.0_old, which no longer exists");
    expect(v.note).toBe(""); // a user process resolves itself
  });
  test("a keg still on disk is not stale", async () => {
    const { env } = fakeEnv({ lsof: [lsofLine("10", `${CELLAR}/fakepkg/1.1/bin/python`)], dirs: [`${CELLAR}/fakepkg/1.1`] });
    const v = await staleKegCheck(env, opts().o);
    expect(v.note).toBe("");
    expect(v.log.join("\n")).not.toContain("STALE KEG");
  });
  for (const [label, answer] of [["missing", 127], ["empty output", ""], ["a non-zero exit", 1]] as const) {
    test(`lsof ${label} is a reported failure, never "nothing stale"`, async () => {
      const { env } = fakeEnv({ lsof: [answer] });
      const v = await staleKegCheck(env, opts().o);
      expect(v.note).toBe("STALE-KEG CHECK FAILED: lsof unusable (/usr/sbin/lsof)");
      expect(v.note).toMatch(TROUBLE_RE);
    });
  }
});

describe("staleKegCheck: restart", () => {
  const stale = (pkg: string, pid = "20") => lsofLine(pid, `${CELLAR}/${pkg}/1.0_old/bin/${pkg}`);
  const fresh = (pkg: string, pid = "21") => lsofLine(pid, `${CELLAR}/${pkg}/1.1/bin/${pkg}`);
  const base = (pkg: string, plists: Record<string, string[]>, extra: Partial<Fake> = {}): Fake => ({
    lsof: [stale(pkg), fresh(pkg)], dirs: [`${CELLAR}/${pkg}/1.1`], plists, ps: { "20": { comm: pkg, command: pkg, ppid: "1" } }, ...extra,
  });
  test("a daemon with one matching label is kickstarted, and the re-scan confirms it", async () => {
    const { env, calls } = fakeEnv(base("tailscale", { "/Library/LaunchDaemons": ["sh.brew.tailscale.plist"] }));
    const v = await staleKegCheck(env, opts().o);
    expect(calls).toContain("sudo -n launchctl kickstart -k system/sh.brew.tailscale");
    expect(v.note).toBe("restarted onto new keg: tailscale");
  });
  test("the restart helper is used for the packages it allows", async () => {
    const { env, calls } = fakeEnv({ ...base("tailscale", { "/Library/LaunchDaemons": ["sh.brew.tailscale.plist"] }), files: ["/usr/local/sbin/restart-helper"] });
    const v = await staleKegCheck(env, opts({ restartHelper: { path: "/usr/local/sbin/restart-helper", packages: ["tailscale"] } }).o);
    expect(calls).toContain("sudo -n /usr/local/sbin/restart-helper tailscale");
    expect(calls.some((c) => c.includes("launchctl kickstart"))).toBe(false);
    expect(v.log).toContain("    restarted system/sh.brew.tailscale (via restart-helper)");
  });
  test("the restart helper is never asked for a package it does not allow", async () => {
    const { env, calls } = fakeEnv({ ...base("tailscale", { "/Library/LaunchDaemons": ["sh.brew.tailscale.plist"] }), files: ["/usr/local/sbin/restart-helper"] });
    await staleKegCheck(env, opts({ restartHelper: { path: "/usr/local/sbin/restart-helper", packages: ["other"] } }).o);
    expect(calls.some((c) => c.includes("restart-helper"))).toBe(false);
    expect(calls).toContain("sudo -n launchctl kickstart -k system/sh.brew.tailscale");
  });
  test("a restart helper that fails falls back to the kickstart", async () => {
    const { env, calls } = fakeEnv({ ...base("tailscale", { "/Library/LaunchDaemons": ["sh.brew.tailscale.plist"] }), files: ["/usr/local/sbin/restart-helper"], rc: { "sudo -n /usr/local/sbin/restart-helper tailscale": 1 } });
    const v = await staleKegCheck(env, opts({ restartHelper: { path: "/usr/local/sbin/restart-helper", packages: ["tailscale"] } }).o);
    expect(calls).toContain("sudo -n /usr/local/sbin/restart-helper tailscale");
    expect(calls).toContain("sudo -n launchctl kickstart -k system/sh.brew.tailscale");
    expect(v.note).toBe("restarted onto new keg: tailscale");
  });
  test("a label is matched on the name before .plist, as the shell glob", async () => {
    const f = base("list", { "/Library/LaunchDaemons": ["com.x.other.plist", "com.x.list-server.plist"] });
    f.ps = { "20": { comm: "", command: "list", ppid: "1" } };
    const { env, calls } = fakeEnv(f);
    await staleKegCheck(env, opts().o);
    expect(calls).toContain("sudo -n launchctl kickstart -k system/com.x.list-server");
  });
  test("a kickstart that fails leaves an operator one-liner, an alarm and a notice", async () => {
    const { env } = fakeEnv({ ...base("tailscale", { "/Library/LaunchDaemons": ["sh.brew.tailscale.plist"] }), lsof: [stale("tailscale")], rc: { "sudo -n launchctl kickstart -k system/sh.brew.tailscale": 1 } });
    const { o, notices } = opts();
    const v = await staleKegCheck(env, o);
    expect(v.log).toContain("    cannot restart unattended — run: sudo launchctl kickstart -k system/sh.brew.tailscale");
    expect(v.note).toBe("STALE KEG: tailscale still running from a deleted keg");
    expect(v.note).toMatch(TROUBLE_RE);
    expect(notices[0]).toContain("Needs an operator: tailscale(system/sh.brew.tailscale)");
  });
  test("a user agent is kickstarted in the gui domain", async () => {
    const { env, calls } = fakeEnv(base("tool", { "/home.test/Library/LaunchAgents": ["homebrew.mxcl.tool.plist"] }));
    await staleKegCheck(env, opts().o);
    expect(calls).toContain("launchctl kickstart -k gui/501/homebrew.mxcl.tool");
  });
  test("labels are narrowed by the process name, so a sibling service is not bounced", async () => {
    const f = base("svc", { "/Library/LaunchDaemons": ["com.x.svc-server.plist", "com.x.svc-scheduler.plist"] });
    f.ps = { "20": { comm: "svc-server", command: "svc-server", ppid: "1" } };
    const { env, calls } = fakeEnv(f);
    await staleKegCheck(env, opts().o);
    expect(calls).toContain("sudo -n launchctl kickstart -k system/com.x.svc-server");
    expect(calls).not.toContain("sudo -n launchctl kickstart -k system/com.x.svc-scheduler");
  });
  test("still ambiguous after narrowing → named, never guessed", async () => {
    const f = base("svc", { "/Library/LaunchDaemons": ["com.x.svc-a.plist", "com.x.svc-b.plist"] });
    f.ps = { "20": { comm: "other", command: "other", ppid: "1" } };
    f.lsof = [stale("svc")];
    const { env, calls } = fakeEnv(f);
    const { o, notices } = opts();
    const v = await staleKegCheck(env, o);
    expect(calls.some((c) => c.includes("kickstart"))).toBe(false);
    expect(v.log).toContain("    ambiguous — com.x.svc-a.plist com.x.svc-b.plist all match; not guessing");
    expect(notices[0]).toContain("svc(ambiguous label)");
  });
  test("launchd-owned with no matching label → named for the operator", async () => {
    const f = base("svc", {});
    f.lsof = [stale("svc")];
    const { env } = fakeEnv(f);
    const { o, notices } = opts();
    const v = await staleKegCheck(env, o);
    expect(v.log).toContain("    launchd-owned (ppid 1) but no matching plist — label needs a look");
    expect(notices[0]).toContain("svc(no label found)");
  });
  test("dry-run says what it would kickstart and runs nothing", async () => {
    const { env, calls } = fakeEnv(base("tailscale", { "/Library/LaunchDaemons": ["sh.brew.tailscale.plist"] }));
    const v = await staleKegCheck(env, opts({ dryRun: true }).o);
    expect(v.log).toContain("    dry-run: would kickstart system/sh.brew.tailscale");
    expect(calls.some((c) => c.includes("kickstart") || c.startsWith("sudo"))).toBe(false);
    expect(v.note).toBe("");
  });
  test("an lsof failure on the re-scan is reported", async () => {
    const { env } = fakeEnv({ ...base("tailscale", { "/Library/LaunchDaemons": ["sh.brew.tailscale.plist"] }), lsof: [stale("tailscale"), 1] });
    expect((await staleKegCheck(env, opts().o)).note).toBe("STALE-KEG CHECK FAILED: lsof unusable on re-scan (/usr/sbin/lsof)");
  });
  test("still-stale packages are counted toward stuck, and the stuck entries ride on the note", async () => {
    const { env } = fakeEnv({ ...base("tailscale", { "/Library/LaunchDaemons": ["sh.brew.tailscale.plist"] }), lsof: [stale("tailscale")], rc: { "sudo -n launchctl kickstart -k system/sh.brew.tailscale": 1 } });
    const seen: string[][] = [];
    const v = await staleKegCheck(env, opts({ trackStuck: (s) => (seen.push(s), ["tailscale(3 runs, since 2026-10-20)"]) }).o);
    expect(seen).toEqual([["tailscale"]]);
    expect(v.note).toBe("STALE KEG: tailscale still running from a deleted keg [tailscale(3 runs, since 2026-10-20) ]");
  });
});

describe("staleKegCheck: the label from launchd, by pid", () => {
  const GUI = "launchctl print gui/501";
  const PRINT = "launchctl print system";
  const svcRows = (domain: string, ...rows: [string, string][]) =>
    [`${domain} = {`, `\ttype = ${domain === "system" ? "system" : "gui"}`, "\tservices = {", ...rows.map(([pid, label]) => `\t\t${pid.padStart(8)}      - \t${label}`), "\t}", "", "\tdisabled services = {", "\t\t\"org.example.off\" => disabled", "\t}", "}"].join("\n") + "\n";
  const gui = (...rows: [string, string][]) => svcRows("gui/501", ...rows);
  const print = (...rows: [string, string][]) => svcRows("system", ...rows);
  // A bun process run by a job whose label and plist name never say "bun".
  const stale = (pid = "20") => lsofLine(pid, `${CELLAR}/bun/1.0_old/bin/bun`);
  const base = (extra: Partial<Fake> = {}, pid = "20"): Fake => ({
    lsof: [stale(pid), lsofLine("21", `${CELLAR}/bun/1.1/bin/bun`)], dirs: [`${CELLAR}/bun/1.1`], ps: { [pid]: { comm: "bun", command: "bun run watch.ts", ppid: "1" } }, ...extra,
  });

  test("a user agent is found by its pid in launchctl print gui/<uid> and kickstarted there", async () => {
    // Mutants caught: name matching only; `launchctl list` (its user/<uid> labels fail as gui/<uid>/…) (label review 4).
    const { env, calls } = fakeEnv(base({ out: { [GUI]: gui(["0", "org.example.idle"], ["20", "org.example.serving-watch"]), "launchctl list": "PID\tStatus\tLabel\n20\t0\torg.example.user-domain\n" } }));
    const v = await staleKegCheck(env, opts().o);
    expect(v.log).toContain("    label org.example.serving-watch (from launchctl, pid 20)");
    expect(calls).toContain("launchctl kickstart -k gui/501/org.example.serving-watch");
    expect(calls).not.toContain("launchctl list");
    expect(calls.some((c) => c.startsWith("sudo"))).toBe(false);
    expect(v.note).toBe("restarted onto new keg: bun");
  });
  test("a system daemon is found by its pid in launchctl print system and kickstarted in system/", async () => {
    // Mutant caught: a launchd label always taken as gui (the daemon kickstarted in gui/501).
    const { env, calls } = fakeEnv(base({ out: { [GUI]: gui(["0", "org.example.idle"]), [PRINT]: print(["0", "org.example.x"], ["20", "org.example.agent-daemon"]) } }));
    const v = await staleKegCheck(env, opts().o);
    expect(v.log).toContain("    label org.example.agent-daemon (from launchctl, pid 20)");
    expect(calls).toContain("sudo -n launchctl kickstart -k system/org.example.agent-daemon");
    expect(calls.some((c) => c.includes("gui/501/"))).toBe(false);
  });
  test("a system label found by pid never goes through the restart helper (label review 2)", async () => {
    // Mutant caught: the helper (it takes a package and restarts that package's own service) used for a pid-found label.
    const { env, calls } = fakeEnv(base({ files: ["/usr/local/sbin/restart-helper"], out: { [PRINT]: print(["20", "org.example.agent-daemon"]) } }));
    const v = await staleKegCheck(env, opts({ restartHelper: { path: "/usr/local/sbin/restart-helper", packages: ["bun"] } }).o);
    expect(calls.some((c) => c.includes("restart-helper"))).toBe(false);
    expect(calls).toContain("sudo -n launchctl kickstart -k system/org.example.agent-daemon");
    expect(v.log).toContain("    restarted system/org.example.agent-daemon");
  });
  test("a system label that cannot be kickstarted leaves the operator one-liner", async () => {
    const { env } = fakeEnv(base({ lsof: [stale()], out: { [PRINT]: print(["20", "org.example.agent-daemon"]) }, rc: { "sudo -n launchctl kickstart -k system/org.example.agent-daemon": 1 } }));
    const { o, notices } = opts();
    const v = await staleKegCheck(env, o);
    expect(v.log).toContain("    cannot restart unattended — run: sudo launchctl kickstart -k system/org.example.agent-daemon");
    expect(notices[0]).toContain("bun(system/org.example.agent-daemon)");
  });
  test("a pid in system services wins over the same pid in the gui domain", async () => {
    const { env, calls } = fakeEnv(base({ out: { [GUI]: gui(["20", "org.example.agent-daemon"]), [PRINT]: print(["20", "org.example.agent-daemon"]) } }));
    await staleKegCheck(env, opts().o);
    expect(calls).toContain("sudo -n launchctl kickstart -k system/org.example.agent-daemon");
    expect(calls.some((c) => c.includes("gui/501/"))).toBe(false);
  });
  test("only the services block of print system is read", async () => {
    // Mutant caught: every pid-shaped line of print system taken as a service row.
    const out = print(["0", "org.example.x"]).replace("\tdisabled services = {", "\tother = {\n\t\t      20      - \torg.example.not-a-service");
    const { env, calls } = fakeEnv(base({ out: { [PRINT]: out } }));
    await staleKegCheck(env, opts().o);
    expect(calls.some((c) => c.includes("org.example.not-a-service"))).toBe(false);
  });
  test("a pid in neither domain → the plist name match still works", async () => {
    const { env, calls } = fakeEnv(base({
      out: { [GUI]: gui(["99", "org.example.other"]), [PRINT]: print(["98", "org.example.y"]) },
      plists: { "/Library/LaunchDaemons": ["sh.brew.bun.plist"] },
    }));
    const v = await staleKegCheck(env, opts().o);
    expect(calls).toContain("sudo -n launchctl kickstart -k system/sh.brew.bun");
    expect(v.log).toContain("    label sh.brew.bun (from the plist name)");
  });
  test("a pid in neither domain and no plist match → the existing note", async () => {
    const { env } = fakeEnv(base({ lsof: [stale()], out: { [GUI]: gui(["99", "org.example.other"]), [PRINT]: print(["98", "org.example.y"]) } }));
    const { o, notices } = opts();
    const v = await staleKegCheck(env, o);
    expect(v.log).toContain("    launchd-owned (ppid 1) but no matching plist — label needs a look");
    expect(notices[0]).toContain("bun(no label found)");
  });
  for (const [how, extra, said] of [
    ["exits non-zero (no GUI session)", { rc: { [GUI]: 113, [PRINT]: 1 } }, ["    launchctl print gui/501 failed (rc 113) — falling back to the plist name", "    launchctl print system failed (rc 1) — falling back to the plist name"]],
    ["times out", { timeout: [GUI, PRINT] }, ["    launchctl print gui/501 timed out — falling back to the plist name", "    launchctl print system timed out — falling back to the plist name"]],
  ] as const) {
    test(`a launchctl query that ${how} is a log note, then the plist name match`, async () => {
      // Mutant caught: a failed query read as "no row" silently, or as the end of the check.
      const { env, calls } = fakeEnv(base({ ...extra, plists: { "/home.test/Library/LaunchAgents": ["org.example.bun-watch.plist"] } }));
      const v = await staleKegCheck(env, opts().o);
      for (const l of said) expect(v.log).toContain(l);
      expect(calls).toContain("launchctl kickstart -k gui/501/org.example.bun-watch");
      expect(v.note).toBe("restarted onto new keg: bun");
    });
  }
  test("a launchctl query that throws is a note too, never a crash", async () => {
    const f = fakeEnv(base({ plists: { "/home.test/Library/LaunchAgents": ["org.example.bun-watch.plist"] } }));
    const exec = f.env.exec;
    f.env.exec = async (argv, o) => (argv[0] === "launchctl" && argv[1] === "print" ? Promise.reject(new Error("spawn failed")) : exec(argv, o));
    const v = await staleKegCheck(f.env, opts().o);
    expect(v.log).toContain("    launchctl print gui/501 failed (spawn failed) — falling back to the plist name");
    expect(f.calls).toContain("launchctl kickstart -k gui/501/org.example.bun-watch");
  });
  test("the queries go through env.query when given, not env.exec", async () => {
    // Mutant caught: the queries on the step's exec, whose timeout stops the whole step in the run.
    const f = fakeEnv(base());
    const asked: string[] = [];
    f.env.query = async (argv) => (asked.push(argv.join(" ")), { rc: 0, out: argv[2] === "system" ? print() : gui(["20", "org.example.serving-watch"]), err: "" });
    await staleKegCheck(f.env, opts().o);
    expect(asked).toEqual([PRINT, GUI]);
    expect(f.calls.some((c) => c === GUI || c === PRINT)).toBe(false);
    expect(f.calls).toContain("launchctl kickstart -k gui/501/org.example.serving-watch");
  });
  test("a label with regex metacharacters is taken literally", async () => {
    const { env, calls } = fakeEnv(base({ out: { [GUI]: gui(["20", "org.example.a+b"]) } }));
    await staleKegCheck(env, opts().o);
    expect(calls).toContain("launchctl kickstart -k gui/501/org.example.a+b");
  });
  test("a pid is matched as a whole field: 331 is not 33167, 1331 or 3310", async () => {
    // Mutant caught: startsWith / includes / endsWith on the pid field.
    const { env, calls } = fakeEnv(base({ lsof: [stale("331")], out: { [GUI]: gui(["33167", "org.example.other"]), [PRINT]: print(["1331", "org.example.y"], ["3310", "org.example.z"]) } }, "331"));
    const v = await staleKegCheck(env, opts().o);
    expect(calls.some((c) => c.includes("kickstart"))).toBe(false);
    expect(v.log).toContain("    launchd-owned (ppid 1) but no matching plist — label needs a look");
  });
  test("two labels for one pid in print system → stop: no gui query, no plist fallback (label review M4)", async () => {
    // Mutant caught: an ambiguous answer falling through to the next domain or the plist name.
    const { env, calls } = fakeEnv(base({
      lsof: [stale()], out: { [PRINT]: print(["20", "org.example.a"], ["20", "org.example.b"]), [GUI]: gui(["20", "org.example.c"]) },
      plists: { "/home.test/Library/LaunchAgents": ["org.example.bun-watch.plist"] },
    }));
    const { o, notices } = opts();
    const v = await staleKegCheck(env, o);
    expect(v.log).toContain("    launchctl print system: pid 20 runs under org.example.a org.example.b — not guessing");
    expect(calls).not.toContain(GUI);
    expect(calls.some((c) => c.includes("kickstart"))).toBe(false);
    expect(notices[0]).toContain("bun(ambiguous label)");
  });
  test("two labels for one pid in the gui domain → stop, never the plist name", async () => {
    const { env, calls } = fakeEnv(base({ lsof: [stale()], out: { [GUI]: gui(["20", "org.example.a"], ["20", "org.example.b"]) }, plists: { "/home.test/Library/LaunchAgents": ["org.example.bun-watch.plist"] } }));
    const v = await staleKegCheck(env, opts().o);
    expect(v.log).toContain("    launchctl print gui/501: pid 20 runs under org.example.a org.example.b — not guessing");
    expect(calls.some((c) => c.includes("kickstart"))).toBe(false);
  });
  test("the queries run once per check, however many holders", async () => {
    const lsof = [stale("20"), lsofLine("22", `${CELLAR}/node/1.0_old/bin/node`)].join("\n");
    const { env, calls } = fakeEnv(base({ lsof: [lsof], ps: { "20": { comm: "bun", ppid: "1" }, "22": { comm: "node", ppid: "1" } }, out: { [GUI]: gui(["20", "org.example.a"], ["22", "org.example.b"]) } }));
    await staleKegCheck(env, opts().o);
    expect(calls.filter((c) => c === GUI)).toHaveLength(1);
    expect(calls).toContain("launchctl kickstart -k gui/501/org.example.a");
    expect(calls).toContain("launchctl kickstart -k gui/501/org.example.b");
  });
  test("every stale pid is resolved: a user process holding the package first does not hide the job's process (label review 1)", async () => {
    // Mutant caught: one process per package (the interactive bun picked, the package dropped, no restart, no note).
    const lsof = [stale("4321"), stale("9876")].join("\n");
    const rescan = [stale("4321"), lsofLine("9877", `${CELLAR}/bun/1.1/bin/bun`)].join("\n");
    const { env, calls } = fakeEnv(base({
      lsof: [lsof, rescan], ps: { "4321": { comm: "bun", command: "bun repl", ppid: "700" }, "9876": { comm: "bun", command: "bun run watch.ts", ppid: "1" } },
      out: { [GUI]: gui(["9876", "org.example.serving-watch"]) },
    }));
    const { o, notices } = opts();
    const v = await staleKegCheck(env, o);
    expect(calls).toContain("launchctl kickstart -k gui/501/org.example.serving-watch");
    expect(v.note).toBe("restarted onto new keg: bun");
    expect(notices).toEqual([]);
  });
  test("this oupdate run is never restarted (label review 3)", async () => {
    // Mutant caught: no own-pid check (print system names oupdate's own LaunchDaemon; its kickstart kills the run).
    const { env, calls } = fakeEnv(base({ lsof: [stale()], out: { [PRINT]: print(["20", "org.example.oupdate"]) }, selfPid: 20 }));
    const { o, notices } = opts();
    const v = await staleKegCheck(env, o);
    expect(v.log).toContain("    bun: pid 20 is this oupdate run — restarts with its next run");
    expect(calls.some((c) => c.includes("kickstart"))).toBe(false);
    expect(v.note).toBe("");
    expect(notices).toEqual([]);
  });
  test("an ancestor of this run is never restarted either", async () => {
    // Mutant caught: only process.pid checked (a bun wrapper that started this run is restarted under it).
    const { env, calls } = fakeEnv(base({ lsof: [stale()], out: { [PRINT]: print(["20", "org.example.oupdate"]) }, selfPid: 4000, ps: { "4000": { ppid: "20" }, "20": { comm: "bun", ppid: "1" } } }));
    const v = await staleKegCheck(env, opts().o);
    expect(v.log).toContain("    bun: pid 20 is this oupdate run — restarts with its next run");
    expect(calls.some((c) => c.includes("kickstart"))).toBe(false);
  });
  test("a holder launchd did not start is never looked up by pid; a launchd parent is named, never restarted (label review 5)", async () => {
    // Mutants caught: a pid lookup for any ppid (pid reuse kickstarts an unrelated job); a restart through the parent chain.
    const { env, calls } = fakeEnv(base({
      lsof: [stale()], ps: { "20": { comm: "bun", command: "bun repl", ppid: "700" }, "700": { ppid: "1" } },
      out: { [GUI]: gui(["20", "org.example.reused"], ["700", "org.example.term"]) },
    }));
    const tracked: string[][] = [];
    const { o, notices } = opts({ trackStuck: (s) => (tracked.push(s), []) });
    const v = await staleKegCheck(env, o);
    expect(calls.some((c) => c.includes("kickstart"))).toBe(false);
    expect(v.log).toContain("    child of org.example.term (pid 700) — needs a look");
    // label re-review 2 (1): a job's child is named, noticed and counted, never dropped.
    // Mutant caught: a child of a launchd job left alone (note "", no notice, never stuck).
    expect(v.note).toBe("STALE KEG: bun still running from a deleted keg");
    expect(notices[0]).toContain("Needs an operator: bun(child of org.example.term)");
    expect(tracked).toEqual([["bun"]]);
  });
  test("a grandchild of a job (a shell in a session under a daemon) is logged only, never counted (label review 3 M1)", async () => {
    // Mutant caught: any launchd ancestor counted (bun(child of sh.brew.tailscale) alarmed every run).
    const { env, calls } = fakeEnv(base({
      lsof: [stale()], ps: { "20": { comm: "bun", command: "bun repl", ppid: "800" }, "800": { ppid: "700" }, "700": { ppid: "1" } },
      out: { [PRINT]: print(["700", "sh.brew.tailscale"]) },
    }));
    const { o, notices } = opts();
    const v = await staleKegCheck(env, o);
    expect(v.log).toContain("    child of sh.brew.tailscale via pid 700 — not counted");
    expect(calls.some((c) => c.includes("kickstart"))).toBe(false);
    expect(v.note).toBe("");
    expect(notices).toEqual([]);
  });
  test("a process launchd did not start, with no launchd parent, is left alone (an interactive process)", async () => {
    const { env } = fakeEnv(base({ lsof: [stale()], ps: { "20": { comm: "bun", command: "bun repl", ppid: "700" }, "700": { ppid: "650" }, "650": { ppid: "1" } }, out: { [GUI]: gui(["0", "org.example.idle"]) } }));
    const { o, notices } = opts();
    const v = await staleKegCheck(env, o);
    expect(v.note).toBe("");
    expect(notices).toEqual([]);
  });
  test("this run's own pid is left alone for its package only, never the package itself (label re-review 2 gap)", async () => {
    // Mutant caught: the own process left alone by pid alone (a pair lookup on the re-scan then misses it).
    const lsof = [stale("20"), stale("30")].join("\n");
    const { env } = fakeEnv(base({ lsof: [lsof, stale("20")], selfPid: 20, ps: { "20": { comm: "bun", ppid: "1" }, "30": { comm: "bun", ppid: "1" } }, out: { [PRINT]: print(["30", "org.example.agent-daemon"]) } }));
    const v = await staleKegCheck(env, opts().o);
    expect(v.note).toBe("restarted onto new keg: bun");
  });
  test("a label named like an Object prototype key is a label, never a policy", async () => {
    // Mutant caught: labelRestart read as o.labelRestart[label] (constructor → Object, taken as an owner command).
    const { env, calls, spawned } = fakeEnv(base({ out: { [GUI]: gui(["20", "constructor"]) } }));
    await staleKegCheck(env, opts({ labelRestart: {}, detachedLog: "/state.test/restart.log" }).o);
    expect(spawned).toEqual([]);
    expect(calls).toContain("launchctl kickstart -k gui/501/constructor");
  });
  test("one package reaching one target twice is named once (label re-review 2 (5))", async () => {
    // Mutant caught: push instead of add (bun(system/…) twice in the operator list).
    const lsof = [stale(), lsofLine("20", `${CELLAR}/bun/0.9_old/lib/x.dylib`)].join("\n");
    const { env } = fakeEnv(base({ lsof: [lsof], out: { [PRINT]: print(["20", "org.example.agent-daemon"]) }, rc: { "sudo -n launchctl kickstart -k system/org.example.agent-daemon": 1 } }));
    const { o, notices } = opts();
    await staleKegCheck(env, o);
    expect(notices[0]!.split("bun(system/org.example.agent-daemon)").length - 1).toBe(1);
  });
  test("two packages on one gui label that cannot be kickstarted: both named", async () => {
    // Mutant caught: the gui failure recorded under the first package for both.
    const lsof = [stale(), lsofLine("20", `${CELLAR}/openssl@3/3.0_old/lib/libssl.dylib`)].join("\n");
    const { env } = fakeEnv(base({ lsof: [lsof], out: { [GUI]: gui(["20", "org.example.serving-watch"]) }, rc: { "launchctl kickstart -k gui/501/org.example.serving-watch": 1 } }));
    const { o, notices } = opts();
    await staleKegCheck(env, o);
    expect(notices[0]).toContain("bun(gui/org.example.serving-watch) openssl@3(gui/org.example.serving-watch)");
  });
  test("one label is kickstarted once, however many of its packages are stale (label re-review gap)", async () => {
    // Mutant caught: the per-target dedupe deleted (node and node@20 bounce the same job twice).
    const lsof = [lsofLine("20", `${CELLAR}/node/1.0_old/bin/node`), lsofLine("20", `${CELLAR}/node@20/20.1_old/lib/libnode.dylib`)].join("\n");
    const { env, calls } = fakeEnv(base({ lsof: [lsof, ""], ps: { "20": { comm: "node", ppid: "1" } }, out: { [PRINT]: print(["20", "org.example.node-app"]) } }));
    await staleKegCheck(env, opts().o);
    expect(calls.filter((c) => c === "sudo -n launchctl kickstart -k system/org.example.node-app")).toHaveLength(1);
  });
  test("a process launchd did not start is never restarted by a plist name either (label re-review C)", async () => {
    // Mutant caught: a ppid≠1 holder kickstarted through a plist that merely names its package.
    const { env, calls } = fakeEnv(base({ lsof: [stale()], ps: { "20": { comm: "bun", command: "bun repl", ppid: "700" } }, plists: { "/Library/LaunchDaemons": ["sh.brew.bun.plist"] } }));
    const { o, notices } = opts();
    const v = await staleKegCheck(env, o);
    expect(calls.some((c) => c.includes("kickstart"))).toBe(false);
    expect(v.note).toBe("");
    expect(notices).toEqual([]);
  });
  test("a pid left alone for one package still counts on the re-scan for another (label re-review B)", async () => {
    // Mutant caught: leftAlone keyed by pid only (a kickstart that did nothing reads "restarted onto new keg: node").
    const first = [lsofLine("20", `${CELLAR}/node/1.0_old/bin/node`), lsofLine("50", `${CELLAR}/icu4c/74_old/lib/libicu.dylib`)].join("\n");
    const rescan = [lsofLine("50", `${CELLAR}/node/1.0_old/bin/node`), lsofLine("50", `${CELLAR}/icu4c/74_old/lib/libicu.dylib`)].join("\n");
    const { env } = fakeEnv(base({
      lsof: [first, rescan], ps: { "20": { comm: "node", ppid: "1" }, "50": { comm: "zsh", ppid: "700" } },
      plists: { "/Library/LaunchDaemons": ["sh.brew.node.plist"] },
    }));
    const v = await staleKegCheck(env, opts().o);
    // OUP-b10: the kickstart that did nothing is counted, the package still alarms.
    expect(v.note).toBe("STALE KEG: node(restarted 1) still running from a deleted keg");
  });
  test("a deferred service is handed off before any launchctl query", async () => {
    const { env, calls } = fakeEnv(base({ out: { [GUI]: gui(["20", "org.example.serving-watch"]) } }));
    const { o, handoffs } = opts({ deferred: ["bun"] });
    await staleKegCheck(env, o);
    expect(handoffs).toEqual([`${CELLAR}/bun/1.0_old`]);
    expect(calls.some((c) => c.startsWith("launchctl"))).toBe(false);
  });
  test("dry run: the queries run, the restart is only said", async () => {
    const { env, calls } = fakeEnv(base({ out: { [PRINT]: print(["20", "org.example.agent-daemon"]) } }));
    const v = await staleKegCheck(env, opts({ dryRun: true }).o);
    expect(calls).toContain(PRINT);
    expect(v.log).toContain("    dry-run: would kickstart system/org.example.agent-daemon");
    expect(calls.some((c) => c.includes("kickstart") || c.startsWith("sudo"))).toBe(false);
  });

  describe("labelRestart: restarts that belong to the job's owner", () => {
    const OWNER = ["/opt/owner.test/restart-when-quiet", "--wait"];
    test('"skip" on a pid-found label: no kickstart, no helper; the STALE KEG note says the owner has it', async () => {
      // Mutant caught: the policy not checked (kickstart -k keeps the old image for this job).
      const { env, calls } = fakeEnv(base({ lsof: [stale()], files: ["/usr/local/sbin/restart-helper"], out: { [PRINT]: print(["20", "org.example.agent-daemon"]) } }));
      const { o, notices } = opts({ labelRestart: { "org.example.agent-daemon": "skip" }, restartHelper: { path: "/usr/local/sbin/restart-helper", packages: ["bun"] } });
      const v = await staleKegCheck(env, o);
      expect(calls.some((c) => c.includes("kickstart") || c.includes("restart-helper"))).toBe(false);
      expect(v.log).toContain("    bun: org.example.agent-daemon restart left to its owner");
      expect(v.note).toBe("STALE KEG: bun(restart left to its owner) still running from a deleted keg");
      expect(notices).toHaveLength(1);
    });
    test('"skip" on a plist-name label is checked before the restart helper', async () => {
      // Mutant caught: the policy only on the pid path.
      const { env, calls } = fakeEnv(base({ files: ["/usr/local/sbin/restart-helper"], plists: { "/Library/LaunchDaemons": ["sh.brew.bun.plist"] } }));
      await staleKegCheck(env, opts({ labelRestart: { "sh.brew.bun": "skip" }, restartHelper: { path: "/usr/local/sbin/restart-helper", packages: ["bun"] } }).o);
      expect(calls.some((c) => c.includes("kickstart") || c.includes("restart-helper"))).toBe(false);
    });
    test("a label is matched literally, never as a pattern or prefix", async () => {
      const { env, calls } = fakeEnv(base({ out: { [GUI]: gui(["20", "org.example.a+b"]) } }));
      await staleKegCheck(env, opts({ labelRestart: { "org.example.a": "skip", "org.example.a.b": "skip" } }).o);
      expect(calls).toContain("launchctl kickstart -k gui/501/org.example.a+b");
    });
    test("an owner command runs once, detached, with the label appended; no kickstart; handed, not alarmed", async () => {
      // Mutants caught: the label not appended; waited on via exec; also kickstarted.
      const { env, calls, spawned } = fakeEnv(base({ lsof: [stale()], out: { [PRINT]: print(["20", "org.example.agent-daemon"]) } }));
      const { o, notices } = opts({ labelRestart: { "org.example.agent-daemon": OWNER }, detachedLog: "/state.test/restart.log" });
      const v = await staleKegCheck(env, o);
      expect(spawned).toEqual(["/opt/owner.test/restart-when-quiet --wait org.example.agent-daemon 2>/state.test/restart.log"]);
      expect(calls.some((c) => c.includes("kickstart") || c.includes("restart-when-quiet"))).toBe(false);
      expect(v.note).toBe("STALE KEG: bun handed to restart-when-quiet (org.example.agent-daemon)");
      expect(v.note).toMatch(TROUBLE_RE); // label re-review E: counted as stale until a run finds it gone
      expect(notices).toEqual([]);
    });
    const twoKegs = (extra: Partial<Fake> = {}): Fake => {
      const lsof = [stale(), lsofLine("20", `${CELLAR}/openssl@3/3.0_old/lib/libssl.dylib`)].join("\n");
      return base({ lsof: [lsof], out: { [PRINT]: print(["20", "org.example.agent-daemon"]) }, ...extra });
    };
    test("one daemon pid on two stale kegs, handed to its owner: both packages are handed, neither alarms (label re-review A)", async () => {
      // Mutant caught: the second package stops at "already restarted this run" and never joins handed (STALE KEG: openssl@3 every run).
      const { env, spawned } = fakeEnv(twoKegs());
      const { o, notices } = opts({ labelRestart: { "org.example.agent-daemon": OWNER }, detachedLog: "/state.test/restart.log" });
      const v = await staleKegCheck(env, o);
      expect(spawned).toHaveLength(1);
      // label re-review 2 (4), mutant caught: "already restarted" whatever the outcome.
      expect(v.log).toContain("    system/org.example.agent-daemon already handed to restart-when-quiet this run");
      expect(notices).toEqual([]);
      expect(v.note).toBe("STALE KEG: bun handed to restart-when-quiet (org.example.agent-daemon); STALE KEG: openssl@3 handed to restart-when-quiet (org.example.agent-daemon)");
      expect(v.note).toMatch(TROUBLE_RE);
    });
    test("one daemon pid on two stale kegs, left to its owner: both packages say so", async () => {
      // Mutant caught: the owner-left outcome kept for the first package only.
      const { env } = fakeEnv(twoKegs());
      const v = await staleKegCheck(env, opts({ labelRestart: { "org.example.agent-daemon": "skip" } }).o);
      expect(v.note).toBe("STALE KEG: bun(restart left to its owner) openssl@3(restart left to its owner) still running from a deleted keg");
    });
    test("one daemon pid on two stale kegs that cannot be kickstarted: both are named for the operator", async () => {
      // Mutant caught: the unresolved outcome kept for the first package only.
      const { env } = fakeEnv(twoKegs({ rc: { "sudo -n launchctl kickstart -k system/org.example.agent-daemon": 1 } }));
      const { o, notices } = opts();
      await staleKegCheck(env, o);
      expect(notices[0]).toContain("Needs an operator: bun(system/org.example.agent-daemon) openssl@3(system/org.example.agent-daemon)");
    });
    test("two packages on one label whose owner command cannot start: both named for the operator", async () => {
      // Mutant caught: the failure recorded under the first package for both.
      const f = fakeEnv(twoKegs());
      f.env.spawnDetached = async () => Promise.reject(new Error("no such file"));
      const { o, notices } = opts({ labelRestart: { "org.example.agent-daemon": OWNER }, detachedLog: "/state.test/restart.log" });
      await staleKegCheck(f.env, o);
      expect(notices[0]).toContain("bun(org.example.agent-daemon handoff to restart-when-quiet failed) openssl@3(org.example.agent-daemon handoff to restart-when-quiet failed)");
    });
    test("two packages on one label while stopping: both notes name their own package", async () => {
      // Mutant caught: the stopping note recorded under the first package for both.
      const { env, spawned } = fakeEnv(twoKegs());
      try {
        await killLive(1);
        const v = await staleKegCheck(env, opts({ labelRestart: { "org.example.agent-daemon": OWNER }, detachedLog: "/state.test/restart.log" }).o);
        expect(spawned).toEqual([]);
        expect(v.note).toContain("STALE KEG: bun not handed to restart-when-quiet (org.example.agent-daemon): oupdate is stopping; STALE KEG: openssl@3 not handed to restart-when-quiet (org.example.agent-daemon): oupdate is stopping");
      } finally {
        resetStopping();
      }
    });
    test("a label the restart step already handed to its owner this run is not handed again (label re-review 2 (2))", async () => {
      // Mutant caught: ownerHanded ignored (the owner command spawned a second time in one run).
      const { env, spawned } = fakeEnv(base({ lsof: [stale()], out: { [PRINT]: print(["20", "org.example.agent-daemon"]) } }));
      const { o, notices } = opts({ labelRestart: { "org.example.agent-daemon": OWNER }, detachedLog: "/state.test/restart.log", ownerHanded: new Map([["org.example.agent-daemon", "restart-when-quiet"]]) });
      const v = await staleKegCheck(env, o);
      expect(spawned).toEqual([]);
      expect(v.note).toBe("STALE KEG: bun handed to restart-when-quiet (org.example.agent-daemon)");
      expect(notices).toEqual([]);
    });
    test("a direct child of a label step 2 handed to its owner carries the handoff, not an alarm (label review 3 L1)", async () => {
      // Mutant caught: the child path not reading the handed labels (Needs an operator: bun(child of …) in the run that handed it).
      const { env, spawned } = fakeEnv(base({ lsof: [stale()], ps: { "20": { comm: "bun", ppid: "700" }, "700": { ppid: "1" } }, out: { [PRINT]: print(["700", "org.example.agent-daemon"]) } }));
      const { o, notices } = opts({ labelRestart: { "org.example.agent-daemon": OWNER }, detachedLog: "/state.test/restart.log", ownerHanded: new Map([["org.example.agent-daemon", "restart-when-quiet"]]) });
      const v = await staleKegCheck(env, o);
      expect(spawned).toEqual([]);
      expect(v.log).toContain("    its job system/org.example.agent-daemon was already handed to restart-when-quiet this run");
      expect(v.note).toBe("STALE KEG: bun handed to restart-when-quiet (org.example.agent-daemon)");
      expect(notices).toEqual([]);
    });
    test("a job and its direct child on one package, handed by this step: the note once (addNote dedupe)", async () => {
      // Mutants caught: addNote without its text dedupe (the note twice); the child path not carrying this step's outcome (an alarm).
      const lsof = [stale("700"), stale("900")].join("\n");
      const { env, spawned } = fakeEnv(base({ lsof: [lsof], ps: { "700": { comm: "bun", ppid: "1" }, "900": { comm: "bun", ppid: "700" } }, out: { [PRINT]: print(["700", "org.example.agent-daemon"]) } }, "700"));
      const { o, notices } = opts({ labelRestart: { "org.example.agent-daemon": OWNER }, detachedLog: "/state.test/restart.log" });
      const v = await staleKegCheck(env, o);
      expect(spawned).toHaveLength(1);
      expect(v.note).toBe("STALE KEG: bun handed to restart-when-quiet (org.example.agent-daemon)");
      expect(notices).toEqual([]);
    });
    test("an owner that finished before the re-scan: only \"restarted onto new keg\" (label re-review 2 (3))", async () => {
      // Mutant caught: the handoff note kept for a package the re-scan found gone.
      const { env } = fakeEnv(base({ out: { [PRINT]: print(["20", "org.example.agent-daemon"]) } }));
      const v = await staleKegCheck(env, opts({ labelRestart: { "org.example.agent-daemon": OWNER }, detachedLog: "/state.test/restart.log" }).o);
      expect(v.note).toBe("restarted onto new keg: bun");
    });
    test("while stopping, the owner command is not started", async () => {
      // Mutant caught: no stopping check (a detached restart started after the run was stopped).
      const { env, spawned } = fakeEnv(base({ out: { [PRINT]: print(["20", "org.example.agent-daemon"]) } }));
      try {
        await killLive(1);
        const v = await staleKegCheck(env, opts({ labelRestart: { "org.example.agent-daemon": OWNER }, detachedLog: "/state.test/restart.log" }).o);
        expect(spawned).toEqual([]);
        expect(v.log).toContain("    org.example.agent-daemon not handed to restart-when-quiet: oupdate is stopping");
      } finally {
        resetStopping();
      }
    });
    test("dry run: would hand / would leave, nothing spawned", async () => {
      const { env, calls, spawned } = fakeEnv(base({ out: { [PRINT]: print(["20", "org.example.agent-daemon"]) } }));
      const v = await staleKegCheck(env, opts({ dryRun: true, labelRestart: { "org.example.agent-daemon": OWNER }, detachedLog: "/state.test/restart.log" }).o);
      expect(spawned).toEqual([]);
      expect(v.log).toContain("    dry-run: would hand org.example.agent-daemon to restart-when-quiet");
      expect(calls.some((c) => c.includes("kickstart"))).toBe(false);
      const s = fakeEnv(base({ out: { [PRINT]: print(["20", "org.example.agent-daemon"]) } }));
      const w = await staleKegCheck(s.env, opts({ dryRun: true, labelRestart: { "org.example.agent-daemon": "skip" } }).o);
      expect(w.log).toContain("    dry-run: would leave system/org.example.agent-daemon to its owner");
    });
  });

  describe("staleKegUnlisted: report, the labelRestart list as an allow list", () => {
    const HELPER = { path: "/usr/local/sbin/restart-helper", packages: ["bun"] };
    const NOT_LISTED = "STALE KEG: bun(reported only, not on the restart list) still running from a deleted keg";
    test("a pid-found label not on the list: no kickstart, no helper, no spawn; named in the note and counted toward stuck", async () => {
      // Mutant caught: staleKegUnlisted ignored (every unlisted label kickstarted as before).
      const { env, calls, spawned } = fakeEnv(base({ lsof: [stale()], files: [HELPER.path], out: { [PRINT]: print(["20", "org.example.agent-daemon"]) } }));
      const tracked: string[][] = [];
      const { o, notices } = opts({ staleKegUnlisted: "report", restartHelper: HELPER, detachedLog: "/state.test/restart.log", trackStuck: (s) => (tracked.push(s), []) });
      const v = await staleKegCheck(env, o);
      expect(calls.some((c) => c.includes("kickstart") || c.includes("restart-helper"))).toBe(false);
      expect(spawned).toEqual([]);
      expect(v.log).toContain("    bun: org.example.agent-daemon not on the restart list — reported only");
      expect(v.note).toBe(NOT_LISTED);
      expect(v.note).toMatch(TROUBLE_RE);
      expect(tracked).toEqual([["bun"]]);
      expect(notices).toHaveLength(1);
      expect(notices[0]).not.toContain("Needs an operator");
    });
    test("a plist-name label not on the list: no helper, no kickstart", async () => {
      // Mutant caught: the report check only on the pid path (the name-matched label goes to the helper).
      const { env, calls, spawned } = fakeEnv(base({ lsof: [stale()], files: [HELPER.path], plists: { "/Library/LaunchDaemons": ["sh.brew.bun.plist"] } }));
      const v = await staleKegCheck(env, opts({ staleKegUnlisted: "report", restartHelper: HELPER }).o);
      expect(calls.some((c) => c.includes("kickstart") || c.includes("restart-helper"))).toBe(false);
      expect(spawned).toEqual([]);
      expect(v.log).toContain("    bun: sh.brew.bun not on the restart list — reported only");
      expect(v.note).toBe(NOT_LISTED);
    });
    test("a gui label not on the list is not kickstarted either", async () => {
      const { env, calls } = fakeEnv(base({ lsof: [stale()], out: { [GUI]: gui(["20", "org.example.serving-watch"]) } }));
      const v = await staleKegCheck(env, opts({ staleKegUnlisted: "report" }).o);
      expect(calls.some((c) => c.includes("kickstart"))).toBe(false);
      expect(v.note).toBe(NOT_LISTED);
    });
    test('a "kickstart" entry is restarted in report mode: kickstart on the pid path, the helper on the name path', async () => {
      // Mutant caught: "kickstart" read as unlisted (the allow entry reported only), or as an owner command (spawned).
      const pid = fakeEnv(base({ out: { [PRINT]: print(["20", "org.example.agent-daemon"]) } }));
      const v = await staleKegCheck(pid.env, opts({ staleKegUnlisted: "report", labelRestart: { "org.example.agent-daemon": "kickstart" }, detachedLog: "/state.test/restart.log" }).o);
      expect(pid.calls).toContain("sudo -n launchctl kickstart -k system/org.example.agent-daemon");
      expect(pid.spawned).toEqual([]);
      expect(v.note).toBe("restarted onto new keg: bun");
      const name = fakeEnv(base({ files: [HELPER.path], plists: { "/Library/LaunchDaemons": ["sh.brew.bun.plist"] } }));
      await staleKegCheck(name.env, opts({ staleKegUnlisted: "report", labelRestart: { "sh.brew.bun": "kickstart" }, restartHelper: HELPER }).o);
      expect(name.calls).toContain("sudo -n /usr/local/sbin/restart-helper bun");
    });
    test('"skip" and owner commands behave as before in report mode', async () => {
      const skip = fakeEnv(base({ lsof: [stale()], out: { [PRINT]: print(["20", "org.example.agent-daemon"]) } }));
      const v = await staleKegCheck(skip.env, opts({ staleKegUnlisted: "report", labelRestart: { "org.example.agent-daemon": "skip" } }).o);
      expect(v.note).toBe("STALE KEG: bun(restart left to its owner) still running from a deleted keg");
      expect(skip.calls.some((c) => c.includes("kickstart"))).toBe(false);
      const own = fakeEnv(base({ lsof: [stale()], out: { [PRINT]: print(["20", "org.example.agent-daemon"]) } }));
      const w = await staleKegCheck(own.env, opts({ staleKegUnlisted: "report", labelRestart: { "org.example.agent-daemon": ["/opt/owner.test/restart-when-quiet"] }, detachedLog: "/state.test/restart.log" }).o);
      expect(own.spawned).toEqual(["/opt/owner.test/restart-when-quiet org.example.agent-daemon 2>/state.test/restart.log"]);
      expect(w.note).toBe("STALE KEG: bun handed to restart-when-quiet (org.example.agent-daemon)");
    });
    test("dry run: would report only, nothing run", async () => {
      const { env, calls } = fakeEnv(base({ out: { [PRINT]: print(["20", "org.example.agent-daemon"]) } }));
      const v = await staleKegCheck(env, opts({ dryRun: true, staleKegUnlisted: "report" }).o);
      expect(v.log).toContain("    dry-run: would report system/org.example.agent-daemon only (not on the restart list)");
      expect(calls.some((c) => c.includes("kickstart") || c.startsWith("sudo"))).toBe(false);
    });
    test("one outcome per target: two packages on one unlisted label are both reported only", async () => {
      // Mutant caught: the report outcome kept for the first package only.
      const lsof = [stale(), lsofLine("20", `${CELLAR}/openssl@3/3.0_old/lib/libssl.dylib`)].join("\n");
      const { env } = fakeEnv(base({ lsof: [lsof], out: { [PRINT]: print(["20", "org.example.agent-daemon"]) } }));
      const v = await staleKegCheck(env, opts({ staleKegUnlisted: "report" }).o);
      expect(v.log).toContain("    system/org.example.agent-daemon already reported only this run");
      expect(v.note).toBe("STALE KEG: bun(reported only, not on the restart list) openssl@3(reported only, not on the restart list) still running from a deleted keg");
    });
    test("one package, one pid handed to its owner and one on an unlisted label: the note keeps both outcomes (slice 8 review 1)", async () => {
      // Mutant caught: a package in handed dropped from the STALE KEG note though another pid of it was reported only.
      const lsof = [stale("20"), stale("30")].join("\n");
      const { env, calls, spawned } = fakeEnv(base({ lsof: [lsof], ps: { "20": { comm: "bun", ppid: "1" }, "30": { comm: "bun", ppid: "1" } }, out: { [PRINT]: print(["20", "org.example.owned"], ["30", "org.example.other"]) } }));
      const { o, notices } = opts({ staleKegUnlisted: "report", labelRestart: { "org.example.owned": ["/opt/owner.test/restart-when-quiet"] }, detachedLog: "/state.test/restart.log" });
      const v = await staleKegCheck(env, o);
      expect(spawned).toEqual(["/opt/owner.test/restart-when-quiet org.example.owned 2>/state.test/restart.log"]);
      expect(calls.some((c) => c.includes("kickstart"))).toBe(false);
      expect(v.note).toBe(`${NOT_LISTED}; STALE KEG: bun handed to restart-when-quiet (org.example.owned)`);
      expect(notices).toHaveLength(1);
    });
    test('one package, one pid handed to its owner and one on a "skip" label: the note keeps both outcomes', async () => {
      // Mutant caught: the same drop for a package left to its owner.
      const lsof = [stale("20"), stale("30")].join("\n");
      const { env } = fakeEnv(base({ lsof: [lsof], ps: { "20": { comm: "bun", ppid: "1" }, "30": { comm: "bun", ppid: "1" } }, out: { [PRINT]: print(["20", "org.example.owned"], ["30", "org.example.other"]) } }));
      const v = await staleKegCheck(env, opts({ labelRestart: { "org.example.owned": ["/opt/owner.test/restart-when-quiet"], "org.example.other": "skip" }, detachedLog: "/state.test/restart.log" }).o);
      expect(v.note).toBe("STALE KEG: bun(restart left to its owner) still running from a deleted keg; STALE KEG: bun handed to restart-when-quiet (org.example.owned)");
    });
    test("a direct child of an unlisted label's job is never restarted, alone or beside its stale job (slice 8 review 2)", async () => {
      // Mutant caught: the child path restarting its parent job (kickstart, helper or spawn) in report mode.
      const child = fakeEnv(base({ lsof: [stale()], files: [HELPER.path], ps: { "20": { comm: "bun", ppid: "700" }, "700": { ppid: "1" } }, out: { [PRINT]: print(["700", "org.example.agent-daemon"]) } }));
      const a = await staleKegCheck(child.env, opts({ staleKegUnlisted: "report", restartHelper: HELPER, detachedLog: "/state.test/restart.log" }).o);
      expect(child.calls.some((c) => c.includes("kickstart") || c.includes("restart-helper"))).toBe(false);
      expect(child.spawned).toEqual([]);
      expect(a.note).toBe("STALE KEG: bun still running from a deleted keg");
      const lsof = [stale("700"), stale("900")].join("\n");
      const both = fakeEnv(base({ lsof: [lsof], ps: { "700": { comm: "bun", ppid: "1" }, "900": { comm: "bun", ppid: "700" } }, out: { [PRINT]: print(["700", "org.example.agent-daemon"]) } }, "700"));
      const b = await staleKegCheck(both.env, opts({ staleKegUnlisted: "report", detachedLog: "/state.test/restart.log" }).o);
      expect(both.calls.some((c) => c.includes("kickstart"))).toBe(false);
      expect(both.spawned).toEqual([]);
      expect(b.log).toContain("    its job system/org.example.agent-daemon was already reported only this run");
      expect(b.note).toBe(NOT_LISTED);
    });
    test('"kickstart" (and absent) still kickstart an unlisted label', async () => {
      for (const mode of ["kickstart", undefined] as const) {
        const { env, calls } = fakeEnv(base({ out: { [PRINT]: print(["20", "org.example.agent-daemon"]) } }));
        await staleKegCheck(env, opts({ staleKegUnlisted: mode }).o);
        expect(calls).toContain("sudo -n launchctl kickstart -k system/org.example.agent-daemon");
      }
    });
  });
});

// OUP-b10: owners restarted at an idle moment, oharness jobs and orphans named, every outcome counted.
describe("staleKegCheck: stale owners, oharness jobs and orphans", () => {
  const GUI = "launchctl print gui/501";
  const PRINT = "launchctl print system";
  const rows = (domain: string, ...rs: [string, string][]) => [`${domain} = {`, "\tservices = {", ...rs.map(([pid, label]) => `\t\t${pid.padStart(8)}      - \t${label}`), "\t}", "}"].join("\n") + "\n";
  const stale = (pid: string) => lsofLine(pid, `${CELLAR}/bun/1.0_old/bin/bun`);
  const KEG = `${CELLAR}/bun/1.0_old`;
  const OWNERS = [{ match: "org.example.serv*", probe: ["/opt/svc.test/idle"], health: "http://127.0.0.1:8080/health" }];
  const ohJob = (id: string) => `/brew/Cellar/bun/1.0_old/bin/bun /home.test/.oharness/deploy/x/packages/oharness/src/cli.ts run --notify --job ${id} --agent agent-x --label w --message done`;
  const queueOpts = (over: Partial<KegOptions> = {}) => {
    const queued: QueuedOwner[][] = [];
    const r = opts({ staleOwners: OWNERS, queueOwners: async (q) => (queued.push(q), "owner restart waiter started (pid 4242) for org.example.serving"), ...over });
    return { ...r, queued };
  };

  test("a label matching staleOwners is queued for the waiter, never kickstarted; the note says it waits", async () => {
    const { env, calls } = fakeEnv({ lsof: [stale("20")], ps: { "20": { comm: "bun", command: "bun serve.ts", ppid: "1" } }, out: { [GUI]: rows("gui/501", ["20", "org.example.serving"]) } });
    const { o, queued, notices } = queueOpts();
    const v = await staleKegCheck(env, o);
    expect(calls.some((c) => c.includes("kickstart"))).toBe(false);
    expect(queued).toEqual([[{ label: "org.example.serving", target: "gui/501/org.example.serving", pid: "20", keg: KEG, probe: ["/opt/svc.test/idle"], health: "http://127.0.0.1:8080/health" }]]);
    expect(v.log).toContain("    bun: org.example.serving queued for an idle restart");
    expect(v.note).toBe("STALE KEG: bun(waiting for idle restart 1) still running from a deleted keg; owner restart waiter started (pid 4242) for org.example.serving");
    expect(v.note).toMatch(TROUBLE_RE);
    expect(notices).toHaveLength(1);
  });
  test("the queued job carries the owner's restart mode and health window", async () => {
    const { env } = fakeEnv({ lsof: [stale("20")], ps: { "20": { comm: "bun", ppid: "1" } }, out: { [PRINT]: rows("system", ["20", "org.ofleet.ohost"]) } });
    const { o, queued } = queueOpts({ staleOwners: [{ match: "org.ofleet.ohost", restart: { bootstrap: "/Library/LaunchDaemons/org.ofleet.ohost.plist" }, healthWithinSec: 120 }] });
    await staleKegCheck(env, o);
    expect(queued).toEqual([[{ label: "org.ofleet.ohost", target: "system/org.ofleet.ohost", pid: "20", keg: KEG, restart: { bootstrap: "/Library/LaunchDaemons/org.ofleet.ohost.plist" }, healthWithinSec: 120 }]]);
  });
  test("staleOwners comes before labelRestart skip and staleKegUnlisted report", async () => {
    const { env, calls } = fakeEnv({ lsof: [stale("20")], ps: { "20": { comm: "bun", ppid: "1" } }, out: { [PRINT]: rows("system", ["20", "org.example.serving"]) } });
    const { o, queued } = queueOpts({ labelRestart: { "org.example.serving": "skip" }, staleKegUnlisted: "report" });
    const v = await staleKegCheck(env, o);
    expect(calls.some((c) => c.includes("kickstart"))).toBe(false);
    expect(queued[0]?.[0]?.target).toBe("system/org.example.serving");
    expect(v.note).toStartWith("STALE KEG: bun(waiting for idle restart 1) still");
  });
  test("a plist-name label matching staleOwners is queued only when launchd shows that label running the stale pid, before the restart helper", async () => {
    const proven = fakeEnv({
      lsof: [stale("20")], files: ["/usr/local/sbin/restart-helper"], ps: { "20": { comm: "bun", ppid: "1" } }, plists: { "/Library/LaunchDaemons": ["org.example.serving-bun.plist"] },
      out: { "launchctl print system/org.example.serving-bun": "system/org.example.serving-bun = {\n\tstate = running\n\tpid = 20\n}\n" },
    });
    const a = queueOpts({ restartHelper: { path: "/usr/local/sbin/restart-helper", packages: ["bun"] } });
    await staleKegCheck(proven.env, a.o);
    expect(proven.calls.some((c) => c.includes("kickstart") || c.includes("restart-helper"))).toBe(false);
    expect(a.queued[0]?.[0]?.target).toBe("system/org.example.serving-bun");
  });
  test("review 5: an orphan pid whose plist-name label launchd runs under another pid is never queued, only reported", async () => {
    // The plist name matched, but that service is a different process: queuing it would restart an unrelated job.
    const { env, calls } = fakeEnv({
      lsof: [stale("20")], ps: { "20": { comm: "bun", ppid: "1" } }, plists: { "/Library/LaunchDaemons": ["org.example.serving-bun.plist"] },
      out: { "launchctl print system/org.example.serving-bun": "system/org.example.serving-bun = {\n\tstate = running\n\tpid = 31\n}\n" },
    });
    const { o, queued } = queueOpts();
    const v = await staleKegCheck(env, o);
    expect(queued).toEqual([]);
    expect(calls.some((c) => c.includes("kickstart"))).toBe(false);
    expect(v.log).toContain("    org.example.serving-bun matched by plist name, but launchd does not run pid 20 under it — reported as an orphan");
    expect(v.note).toBe("STALE KEG: bun(orphans 1: pid 20) still running from a deleted keg");
  });
  test("dry run: says it would queue, queues nothing", async () => {
    const { env, calls } = fakeEnv({ lsof: [stale("20")], ps: { "20": { comm: "bun", ppid: "1" } }, out: { [GUI]: rows("gui/501", ["20", "org.example.serving"]) } });
    const { o, queued } = queueOpts({ dryRun: true });
    const v = await staleKegCheck(env, o);
    expect(v.log).toContain("    dry-run: would queue gui/501/org.example.serving for an idle restart");
    expect(queued).toEqual([]);
    expect(calls.some((c) => c.includes("kickstart"))).toBe(false);
  });
  test("a label the waiter failed is not queued again (FAILED); one it held busy is queued again (held busy)", async () => {
    const lsof = [stale("20"), stale("22")].join("\n");
    const { env } = fakeEnv({ lsof: [lsof], ps: { "20": { comm: "bun", ppid: "1" }, "22": { comm: "bun", ppid: "1" } }, out: { [GUI]: rows("gui/501", ["20", "org.example.serving"], ["22", "org.example.server2"]) } });
    const { o, queued } = queueOpts({ ownerFailed: new Set(["org.example.serving"]), ownerBusy: new Set(["org.example.server2"]) });
    const v = await staleKegCheck(env, o);
    expect(queued.flat().map((q) => q.label)).toEqual(["org.example.server2"]);
    expect(v.log).toContain("    bun: org.example.serving restart FAILED earlier — not retried");
    expect(v.note).toStartWith("STALE KEG: bun(held busy 1, FAILED 1) still running from a deleted keg");
  });
  test("the queue failing to start is in the note", async () => {
    const { env } = fakeEnv({ lsof: [stale("20")], ps: { "20": { comm: "bun", ppid: "1" } }, out: { [GUI]: rows("gui/501", ["20", "org.example.serving"]) } });
    const v = await staleKegCheck(env, queueOpts({ queueOwners: async () => "owner restart waiter FAILED to start (EAGAIN), org.example.serving queued" }).o);
    expect(v.note).toContain("owner restart waiter FAILED to start (EAGAIN)");
  });

  test("oharness jobs on the old keg are named with their ids and pids, never restarted, not by a plist name either", async () => {
    // A ppid-1 bun with no launchd label is an `oharness run --detach` job: restarting it kills live work.
    const lsof = [stale("20"), stale("22")].join("\n");
    const { env, calls } = fakeEnv({
      lsof: [lsof], ps: { "20": { comm: "bun", command: ohJob("job-a-1"), ppid: "1" }, "22": { comm: "bun", command: ohJob("job-b-2"), ppid: "1" } },
      out: { [GUI]: rows("gui/501"), [PRINT]: rows("system") }, plists: { "/Library/LaunchDaemons": ["sh.brew.bun.plist"] },
    });
    const { o, notices } = opts();
    const v = await staleKegCheck(env, o);
    expect(calls.some((c) => c.includes("kickstart"))).toBe(false);
    expect(v.log).toContain("    oharness job job-a-1 (pid 20) — not restarted, it ends on its own");
    expect(v.note).toBe("STALE KEG: bun(oharness jobs on old keg 2: job-a-1 (pid 20) job-b-2 (pid 22)) still running from a deleted keg");
    expect(notices).toHaveLength(1);
    expect(notices[0]).not.toContain("Needs an operator");
  });
  test("a ppid-1 holder with no label and no plist is an orphan: named with its pids, never restarted", async () => {
    const lsof = [stale("20"), stale("25")].join("\n");
    const { env, calls } = fakeEnv({ lsof: [lsof], ps: { "20": { comm: "bun", command: "bun x.ts", ppid: "1" }, "25": { comm: "bun", command: "bun y.ts", ppid: "1" } }, out: { [GUI]: rows("gui/501"), [PRINT]: rows("system") } });
    const { o, notices } = opts();
    const v = await staleKegCheck(env, o);
    expect(calls.some((c) => c.includes("kickstart"))).toBe(false);
    expect(v.note).toBe("STALE KEG: bun(orphans 2: pid 20 25) still running from a deleted keg");
    expect(notices[0]).toContain("bun(no label found)");
  });
  test("line-493 masking gone: one package's every outcome is counted, left-to-owner no longer hides the rest", async () => {
    // Mutant caught: the first special outcome (left to its owner) named alone, the queued, restarted and job pids dropped.
    const lsof = [stale("20"), stale("21"), stale("22"), stale("23"), stale("25")].join("\n");
    const { env } = fakeEnv({
      lsof: [lsof],
      ps: {
        "20": { comm: "bun", ppid: "1" }, "21": { comm: "bun", ppid: "1" }, "22": { comm: "bun", ppid: "1" },
        "23": { comm: "bun", command: ohJob("job-c-3"), ppid: "1" }, "25": { comm: "bun", command: "bun z.ts", ppid: "1" },
      },
      out: { [GUI]: rows("gui/501", ["20", "org.example.owned"], ["21", "org.example.serving"], ["22", "org.example.plain"]), [PRINT]: rows("system") },
    });
    const { o } = queueOpts({ labelRestart: { "org.example.owned": "skip" } });
    const v = await staleKegCheck(env, o);
    expect(v.note).toStartWith("STALE KEG: bun(restarted 1, waiting for idle restart 1, oharness jobs on old keg 1: job-c-3 (pid 23), orphans 1: pid 25, restart left to its owner) still running from a deleted keg");
    // No ";" inside the package's outcomes: the summary parser splits the brew line there.
    expect(v.note.split("still running")[0]).not.toContain(";");
  });
});

describe("staleKegCheck: deferred services", () => {
  test("a deferred service is handed off once, never kickstarted or alarmed; another holder of its keg is still handled", async () => {
    const lsof = [
      lsofLine("30", `${CELLAR}/model-svc/HEAD-old/libexec/bin/python`),
      lsofLine("31", `${CELLAR}/python@3.11/3.11.15/lib/libpython.dylib`),
      lsofLine("32", `${CELLAR}/python@3.11/3.11.15/lib/libpython.dylib`),
    ].join("\n");
    const { env, calls } = fakeEnv({
      lsof: [lsof],
      ps: { "30": { comm: "model-svc-server", ppid: "1" }, "31": { comm: "model-svc-server", ppid: "1" }, "32": { comm: "bash", ppid: "99" } },
      plists: { "/Library/LaunchDaemons": ["com.x.model-svc-server.plist"] },
    });
    const tracked: string[][] = [];
    const { o, notices, handoffs } = opts({ trackStuck: (s) => (tracked.push(s), []) });
    const v = await staleKegCheck(env, o);
    expect(handoffs).toEqual([`${CELLAR}/model-svc/HEAD-old`]);
    // a handed package stays counted toward stuck even though its other holder resolved itself
    expect(tracked).toEqual([["model-svc", "python@3.11"]]);
    expect(v.log).toContain("    already handed to the waiter this run");
    expect(v.log.join("\n")).toContain("STALE KEG: python@3.11 — pid 32");
    expect(calls.some((c) => c.includes("kickstart"))).toBe(false);
    expect(notices).toEqual([]);
    expect(v.note).toBe("restart handed to waiter (pid 4242)");
  });
});

describe("staleKegCheck: deferred and unresolved", () => {
  test("a package both handed off and unresolved for another process still alarms", async () => {
    const lsof = [lsofLine("30", `${CELLAR}/libpy/3.11.15/lib/libpython.dylib`), lsofLine("31", `${CELLAR}/libpy/3.11.15/lib/libpython.dylib`)].join("\n");
    const { env } = fakeEnv({
      lsof: [lsof],
      ps: { "30": { comm: "model-svc-server", ppid: "1" }, "31": { comm: "other", ppid: "1" } },
      plists: { "/Library/LaunchDaemons": ["com.x.libpy-a.plist", "com.x.libpy-b.plist"] },
    });
    const { o, notices } = opts();
    const v = await staleKegCheck(env, o);
    expect(v.note).toStartWith("STALE KEG: libpy still running from a deleted keg");
    expect(notices).toHaveLength(1);
  });
  test("one deferred process stale on two kegs is handed off exactly once", async () => {
    const lsof = [lsofLine("40", `${CELLAR}/model-svc/HEAD-old/libexec/bin/python`), lsofLine("40", `${CELLAR}/python@3.11/3.11.15/lib/libpython.dylib`)].join("\n");
    const { env } = fakeEnv({ lsof: [lsof], ps: { "40": { comm: "model-svc-server", ppid: "1" } } });
    const { o, handoffs } = opts();
    await staleKegCheck(env, o);
    expect(handoffs).toHaveLength(1);
  });
  test("two deferred services: each is handed off once, told which service it is (slice 7 review)", async () => {
    // Mutant caught: one handoff per run for all services, and no service name (the run guessed deferred[0]).
    const lsof = [lsofLine("40", `${CELLAR}/libdep/1.0_old/lib/libdep.dylib`), lsofLine("41", `${CELLAR}/svc2/1.0_old/bin/svc2`)].join("\n");
    const { env } = fakeEnv({ lsof: [lsof], ps: { "40": { comm: "svc1-server", ppid: "1" }, "41": { comm: "svc2", ppid: "1" } } });
    const seen: string[] = [];
    const { o } = opts({ deferred: ["svc1", "svc2"], handoff: async (keg, svc) => (seen.push(`${svc} ${keg}`), `${svc} handed`) });
    const r = await staleKegCheck(env, o);
    expect(seen).toEqual([`svc1 ${CELLAR}/libdep/1.0_old`, `svc2 ${CELLAR}/svc2/1.0_old`]);
    expect(r.note).toContain("svc1 handed; svc2 handed");
  });
  test("an empty deferred entry never matches", async () => {
    const { env, calls } = fakeEnv({
      lsof: [lsofLine("20", `${CELLAR}/tailscale/1.0_old/bin/tailscale`), lsofLine("21", `${CELLAR}/tailscale/1.1/bin/tailscale`)],
      dirs: [`${CELLAR}/tailscale/1.1`], plists: { "/Library/LaunchDaemons": ["sh.brew.tailscale.plist"] }, ps: { "20": { comm: "tailscaled", ppid: "1" } },
    });
    const { o, handoffs } = opts({ deferred: [""] });
    await staleKegCheck(env, o);
    expect(handoffs).toEqual([]);
    expect(calls).toContain("sudo -n launchctl kickstart -k system/sh.brew.tailscale");
  });
});

describe("linkageCheck", () => {
  test("no brew on the host → nothing to check, no note", async () => {
    const { env } = fakeEnv({ rc: { "brew list --formula": 127 } });
    expect((await linkageCheck(env, opts().o)).note).toBe("");
  });
  test("a dependent left linking a removed dylib is named, alerted, and counts as trouble", async () => {
    const linkage = "==> Checking aws-c-s3 linkage\n==> Checking awscli linkage\nMissing libraries:\n  /brew/opt/aws-c-s3/lib/libaws-c-s3.1.2.dylib\n==> Checking zstd linkage\n";
    const { env } = fakeEnv({ out: { "brew list --formula": "aws-c-s3\nawscli\nzstd\n", "brew linkage --test aws-c-s3 awscli zstd": linkage }, rc: { "brew linkage --test aws-c-s3 awscli zstd": 1 } });
    const { o, notices } = opts();
    const v = await linkageCheck(env, o);
    expect(v.note).toBe("LINKAGE FAILED: awscli; fix: brew reinstall --build-from-source <formula>");
    expect(v.note).toMatch(TROUBLE_RE);
    expect(v.log.join("\n")).toContain("libaws-c-s3.1.2.dylib");
    expect(notices).toHaveLength(1);
  });
  test("all clean → no note, no notice", async () => {
    const { env } = fakeEnv({ out: { "brew list --formula": "zstd\n" } });
    const { o, notices } = opts();
    expect((await linkageCheck(env, o)).note).toBe("");
    expect(notices).toEqual([]);
  });
  test("a failing brew list is reported as unchecked, not as clean", async () => {
    const { env, calls } = fakeEnv({ rc: { "brew list --formula": 1 } });
    const v = await linkageCheck(env, opts().o);
    expect(v.note).toBe("LINKAGE CHECK FAILED: brew list --formula failed, linkage not checked");
    expect(v.note).toMatch(TROUBLE_RE);
    expect(calls.some((c) => c.startsWith("brew linkage"))).toBe(false);
  });
});

describe("relinkUpgraded", () => {
  const LINKED = "/brew/var/homebrew/linked";
  const kegOnly = (names: string[]) => JSON.stringify({ formulae: names.map((name) => ({ name, keg_only: true })) });
  test("an upgrade that left a keg unlinked is relinked", async () => {
    const f = fakeEnv({ dirs: [LINKED], out: { "brew info --json=v2 model-svc": kegOnly([]) } });
    const exec = f.env.exec;
    f.env.exec = async (argv) => {
      if (argv.join(" ") === "brew link model-svc") f.files.add(`${LINKED}/model-svc`);
      return exec(argv);
    };
    const v = await relinkUpgraded(f.env, ["model-svc"], { brew: "brew" });
    expect(v.log).toContain("  model-svc: upgraded but NOT linked — relinking before restart");
    expect(v.note).toBe("relinked after upgrade: model-svc");
  });
  test("an already-linked upgrade is silent", async () => {
    const { env } = fakeEnv({ dirs: [LINKED], files: [`${LINKED}/model-svc`], out: { "brew info --json=v2 model-svc": kegOnly([]) } });
    const v = await relinkUpgraded(env, ["model-svc"], { brew: "brew" });
    expect(v).toEqual({ note: "", log: [] });
  });
  test("formulae outside the upgraded list are never touched", async () => {
    const { env, calls } = fakeEnv({ dirs: [LINKED], files: [`${LINKED}/model-svc`] });
    await relinkUpgraded(env, ["model-svc"], { brew: "brew" });
    expect(calls.join("\n")).not.toContain("opencode");
    expect(calls.some((c) => c.startsWith("brew link") || c.startsWith("brew unlink"))).toBe(false);
  });
  test("keg-only formulae are skipped, not link-failed", async () => {
    const { env } = fakeEnv({ dirs: [LINKED], out: { "brew info --json=v2 openssl@3": kegOnly(["openssl@3"]) } });
    expect((await relinkUpgraded(env, ["openssl@3"], { brew: "brew" })).note).toBe("");
  });
  test("a failed relink is reported with a word the digest counts as trouble", async () => {
    const { env } = fakeEnv({ dirs: [LINKED], rc: { "brew link model-svc": 1, "brew unlink model-svc": 1 }, out: { "brew info --json=v2 model-svc": kegOnly([]) } });
    const v = await relinkUpgraded(env, ["model-svc"], { brew: "brew" });
    expect(v.note).toBe("UNLINKED KEG: brew link failed for model-svc");
    expect(v.note).toMatch(TROUBLE_RE);
  });
  test("a stale prefix symlink is cleared, then relinked", async () => {
    const f = fakeEnv({ dirs: [LINKED], out: { "brew info --json=v2 model-svc": kegOnly([]) } });
    let unlinked = false;
    const exec = f.env.exec;
    f.env.exec = async (argv) => {
      const line = argv.join(" ");
      if (line === "brew unlink model-svc") unlinked = true;
      if (line === "brew link model-svc") {
        if (!unlinked) return { rc: 1, out: "", err: "is a symlink belonging to model-svc" };
        f.files.add(`${LINKED}/model-svc`);
      }
      return exec(argv);
    };
    const v = await relinkUpgraded(f.env, ["model-svc"], { brew: "brew" });
    expect(v.log).toContain("    (cleared a stale prefix symlink first)");
    expect(v.note).toBe("relinked after upgrade: model-svc");
  });
});

describe("caskRunning", () => {
  const ROOM = "/brew/Caskroom";
  const out = [lsofLine("11", `${ROOM}/gcloud-cli/5.0/google-cloud-sdk/bin/gcloud`), lsofLine("12", "/Applications/X.app/Contents/MacOS/X"), lsofLine("13", `${ROOM}/gcloud-cli-extra/1/bin/y`)].join("\n");
  test("a process mapping a file under the cask's Caskroom dir or its app is running it", () => {
    expect(caskRunning(out, ROOM, "gcloud-cli", [])).toEqual(["11"]);
    expect(caskRunning(out, ROOM, "x", ["/Applications/X.app"])).toEqual(["12"]);
  });
  test("a sibling cask sharing a name prefix, or nothing running, is not a match", () => {
    expect(caskRunning(out, ROOM, "gcloud", [])).toEqual([]);
    expect(caskRunning("", ROOM, "gcloud-cli", [])).toEqual([]);
  });
});
