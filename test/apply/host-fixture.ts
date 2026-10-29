// A scripted host for the apply run: brew, lsof, launchctl, npm and the notify command answer from
// a script, as the previous updater's brew mocks did, and the file system is in memory. Every command
// line is recorded in order, so tests can assert on what ran and in which order.
import type { ApplyConfig } from "../../src/apply/config.ts";
import { DEFAULTS } from "../../src/apply/config.ts";
import type { Exec, ExecResult } from "../../src/apply/exec.ts";
import type { ApplyFs } from "../../src/apply/fs.ts";
import type { PinFile } from "../../src/apply/pins.ts";
import type { awaitingTapApproval, TypeBRun, typeBUpgrades } from "../../src/apply/typeb.ts";
import { outdatedVersions } from "../../src/apply/taps.ts";

export interface HostScript {
  /** `brew outdated --formula`. */
  formulas?: string;
  /** Installed version after an upgrade, by name; default is the version `verbose` offered. */
  installedVersion?: Record<string, string>;
  /** `brew outdated --cask`; a cask upgraded this run is no longer listed. */
  casks?: string;
  verbose?: string;
  formulaTaps?: Record<string, string>;
  caskTaps?: Record<string, string>;
  /** Casks whose artifacts include a pkg. */
  sudoCasks?: string[];
  pinned?: string;
  /** rc of `brew upgrade <args>` keyed by the args after "upgrade". */
  upgradeRc?: Record<string, number>;
  /** Command lines (or prefixes) that time out. */
  timeout?: string[];
  /** rc for a command line (exact). */
  rc?: Record<string, number>;
  /** Successive lsof answers. */
  lsof?: string[];
  npmOutdated?: string;
  files?: Record<string, string>;
  dirs?: string[];
  pinFiles?: PinFile[];
  /** Paths the fs reports executable (the native Claude Code binary). */
  executables?: string[];
  /** The native claude binary: `update` output and `--version` output (null: --version fails with rc 1, a line on stdout). */
  claudeUpdateOut?: string;
  claudeVersion?: string | null;
  /** `ps -o <field>= -p <pid>` answers by pid. */
  ps?: Record<string, { comm?: string; command?: string; ppid?: string }>;
}

const ok = (out = ""): ExecResult => ({ rc: 0, out, err: "" });

export function fakeHost(s: HostScript = {}) {
  const calls: string[] = [];
  const upgraded = new Set<string>();
  const npmInstalled = new Map<string, string>();
  const lsof = [...(s.lsof ?? [])];
  const installedOf = (n: string) => s.installedVersion?.[n] ?? outdatedVersions(n, s.verbose ?? "").split("→")[1]!;
  const exec: Exec = async (argv) => {
    const line = argv.join(" ");
    calls.push(line);
    if ((s.timeout ?? []).some((t) => line.startsWith(t))) return { rc: 143, out: "", err: "", timedOut: true };
    if (s.rc?.[line] !== undefined) return { rc: s.rc[line]!, out: "", err: "" };
    const [cmd, ...a] = argv;
    const rest = a.join(" ");
    if (cmd === "brew") {
      if (rest === "--version") return ok("Homebrew 5.0.0\n");
      if (rest === "update") return ok("Already up-to-date.\n");
      if (rest === "--cellar") return ok("/brew/Cellar\n");
      if (rest === "--prefix") return ok("/brew\n");
      if (rest === "--caskroom") return ok("/brew/Caskroom\n");
      if (rest === "list --pinned") return ok(s.pinned ?? "");
      if (rest === "list --formula") return ok("good-a\n");
      if (rest.startsWith("linkage")) return ok();
      if (rest === "cleanup" || rest.startsWith("cleanup ")) return ok("CLEANUP\n");
      if (rest.startsWith("outdated --json=v2")) {
        const names = (x?: string) => (x ?? "").split(/\s+/).filter(Boolean);
        const f = names(s.formulas).filter((n) => !upgraded.has(n)).map((name) => ({ name, current_version: "9.9" }));
        const c = names(s.casks).filter((n) => !upgraded.has(n)).map((name) => ({ name, current_version: "9.9" }));
        return ok(JSON.stringify({ formulae: f, casks: c }));
      }
      if (rest.startsWith("outdated --verbose")) return ok(s.verbose ?? "");
      if (rest === "outdated --fetch-HEAD --formula" || rest === "outdated --formula") return ok(s.formulas ?? "");
      if (rest === "outdated --cask --greedy-auto-updates") return ok((s.casks ?? "").split(/\s+/).filter((n) => n && !upgraded.has(n)).join("\n"));
      if (rest.startsWith("info --json=v2 --cask ")) {
        const ks = a.slice(3);
        if (ks.length === 1 && (s.sudoCasks ?? []).includes(ks[0]!)) return ok(JSON.stringify({ casks: [{ token: ks[0], artifacts: [{ pkg: ["x.pkg"] }] }] }));
        return ok(JSON.stringify({ casks: ks.filter((k) => s.caskTaps?.[k]).map((k) => ({ token: k, tap: s.caskTaps![k], artifacts: [{ app: ["X.app"] }], ...(upgraded.has(k) ? { installed: installedOf(k) } : {}) })) }));
      }
      if (rest.startsWith("info --json=v2 ")) {
        const fs = a.slice(2);
        return ok(JSON.stringify({ formulae: fs.filter((f) => s.formulaTaps?.[f]).map((f) => ({ name: f, tap: s.formulaTaps![f], ...(upgraded.has(f) ? { installed: [{ version: installedOf(f) }] } : {}) })) }));
      }
      if (a[0] === "upgrade") {
        const what = a.slice(1).join(" ");
        const rc = s.upgradeRc?.[what] ?? 0;
        if (rc === 0) upgraded.add(a.at(-1)!);
        return { rc, out: `ATTEMPT ${line}\n`, err: "" };
      }
      return { rc: 99, out: "", err: `UNEXPECTED ${line}` };
    }
    if (cmd!.endsWith("lsof")) {
      const next = lsof.length > 1 ? lsof.shift()! : lsof[0];
      return next === undefined ? { rc: 1, out: "", err: "" } : ok(next);
    }
    if (cmd === "ps") {
      const p = s.ps?.[argv[4]!];
      const v = argv[2] === "comm=" ? p?.comm : argv[2] === "command=" ? p?.command : p?.ppid;
      return v === undefined ? { rc: 1, out: "", err: "" } : ok(`${v}\n`);
    }
    if (cmd!.endsWith("/claude")) {
      if (rest === "update") return { rc: 0, out: s.claudeUpdateOut ?? "Checking for updates\nSuccessfully updated\n", err: "" };
      if (rest === "--version") return s.claudeVersion === null ? { rc: 1, out: "dyld: missing symbol\n", err: "" } : ok(`${s.claudeVersion ?? "2.0.0"} (Claude Code)\n`);
      return { rc: 99, out: "", err: `UNEXPECTED ${line}` };
    }
    if (cmd === "npm") {
      if (rest === "outdated -g --json") return { rc: s.npmOutdated && s.npmOutdated !== "{}" ? 1 : 0, out: s.npmOutdated ?? "{}", err: "" };
      if (a[0] === "view" && a[2] === "dist.tarball") return ok(`https://registry.npmjs.org/${a[1]!.replace(/@[^@/]*$/, "")}/-/x.tgz\n`);
      // install -g <name>@<version> records it; ls -g reads it back.
      const pin = a[0] === "install" ? a.at(-1)!.match(/^(.+)@([^@/]+)$/) : null;
      if (pin) npmInstalled.set(pin[1]!, pin[2]!);
      if (a[0] === "ls") {
        const v = npmInstalled.get(a.at(-1)!);
        return ok(JSON.stringify({ dependencies: v ? { [a.at(-1)!]: { version: v } } : {} }));
      }
      return ok();
    }
    return ok();
  };

  const files = new Map(Object.entries(s.files ?? {}));
  const dirs = new Set(s.dirs ?? []);
  const writes: string[] = [];
  const spawned: string[][] = [];
  const fs: ApplyFs = {
    home: "/home.test",
    uid: 501,
    exists: async (p) => files.has(p) || dirs.has(p),
    isDir: async (p) => dirs.has(p),
    isExecutable: async (p) => (s.executables ?? []).includes(p),
    listDir: async () => [],
    readFile: async (p) => files.get(p),
    writeFile: async (p, t) => {
      writes.push(p);
      files.set(p, t);
    },
    remove: async (p) => {
      writes.push(`rm ${p}`);
      files.delete(p);
    },
    mtimeDay: async () => "2026-10-20",
    spawnDetached: async (argv) => {
      spawned.push(argv);
      calls.push(`spawn ${argv.join(" ")}`);
      return 4242;
    },
    pinFiles: () => s.pinFiles ?? [],
  };
  return { exec, fs, calls, files, writes, spawned };
}

export function testConfig(over: Partial<ApplyConfig> = {}): ApplyConfig {
  return {
    host: "hosta",
    stateDir: "/state.test",
    brew: "brew",
    npm: "npm",
    lsof: "/usr/sbin/lsof",
    officialTaps: ["homebrew/core", "homebrew/cask"],
    typeBTaps: ["example/svc"],
    upstreamTaps: [],
    appBundles: [],
    hostPrefixes: [],
    pinRoots: [],
    caskExclude: [],
    stuckAfter: 1,
    sensitive: DEFAULTS.sensitive,
    deferred: [],
    timeoutMs: 1000,
    npmRegistry: DEFAULTS.npmRegistry,
    ...over,
  };
}

/**
 * Stand-ins for the Type B review and the advisory review (ported and tested in slice 2), as the
 * bash tests mocked type_b_brew_review: each records what it was asked and with which notify.
 * rc 0 approves (the upgrade then goes through the run's own upgrade function), 1 FLAGs, 2 is no review.
 */
export function fakeTypeB(rc: 0 | 1 | 2 = 0, kind = "formula-only, prebuilt") {
  const seen: string[] = [];
  const upgrades: typeof typeBUpgrades = async (_env, _r, pairs, o) => {
    const run: TypeBRun = o.into ?? { upgraded: [], upgradedFull: [], failed: [], flagged: false, log: [] };
    for (const { pkg, tap } of pairs) {
      seen.push(`TBREVIEW ${pkg} ${tap} suppress=0`);
      if (rc !== 0) {
        run.flagged = true;
        await o.notify(`⚠️ <b>${o.host} Type B FLAG — ${pkg}</b>\nfixture FLAG\nLog: -`);
        continue;
      }
      if (o.dryRun) {
        run.log.push(`  dry-run: would upgrade ${pkg}`);
        continue;
      }
      if ((await o.upgrade(`${tap}/${pkg}`)) === 0) {
        run.upgraded.push(pkg);
        run.upgradedFull.push(`${tap}/${pkg}`);
      } else {
        run.failed.push(pkg);
        run.flagged = true;
      }
    }
    return run;
  };
  const awaiting: typeof awaitingTapApproval = async (_env, _r, formulas, casks, verbose, o) => {
    const log: string[] = [];
    const items: string[] = [];
    for (const { pkg, tap } of formulas) {
      seen.push(`TBREVIEW ${pkg} ${tap} suppress=1`);
      // The advisory review's own notices are logged, never sent (the real one swaps the notify).
      log.push(`[advisory — not notified] ${o.host} Type B FLAG — ${pkg}`);
      const verdict = rc === 0 ? `APPROVE (${kind})` : rc === 1 ? `FLAG (${kind})` : "n/a";
      items.push(`${tap} (${pkg} ${outdatedVersions(pkg, verbose)}, review: ${verdict})`);
    }
    for (const { pkg, tap } of casks) items.push(`${tap === "tap-unresolved" ? "(unresolved tap)" : tap} (${pkg} ${outdatedVersions(pkg, verbose)}, review: n/a (cask))`);
    return { items: items.join("; "), log };
  };
  return { seen, typeB: { upgrades, awaiting } };
}
