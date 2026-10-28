// `oupdate host --launchd-plist`: prints the LaunchDaemon that schedules `oupdate host --apply`.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseHostCommand } from "../../src/host/cli.ts";
import { launchdPlist, parseLaunchdArgs, type LaunchdArgs } from "../../src/host/launchd.ts";

const tree = resolve(import.meta.dir, "../..");
const root = mkdtempSync(join(tree, ".tmp-launchd-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
function config(apply: Record<string, unknown>) {
  const dir = join(root, `c${++n}`);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "config.json");
  writeFileSync(path, JSON.stringify({ apply: { stateDir: "/var/lib/oupdate", ...apply } }));
  return path;
}

const base = ["--label", "org.example.oupdate-apply", "--user", "svc", "--at", "03:30", "--home", "/var/svc", "--bun", "/opt/bun/bin/bun", "--app", "/srv/oupdate", "--stdout", "/var/log/oupdate/launchd-oupdate.log"];
const parse = (argv: string[], deps?: Parameters<typeof parseLaunchdArgs>[1]) => parseLaunchdArgs(argv, deps);
const without = (flag: string) => {
  const i = base.indexOf(flag);
  return [...base.slice(0, i), ...base.slice(i + 2)];
};
const swap = (flag: string, v: string) => base.map((a, i) => (base[i - 1] === flag ? v : a));

describe("parseLaunchdArgs", () => {
  test("the full form", () => {
    expect(parse(base)).toEqual({
      label: "org.example.oupdate-apply", user: "svc", hour: 3, minute: 30, home: "/var/svc",
      bun: "/opt/bun/bin/bun", app: "/srv/oupdate", stdout: "/var/log/oupdate/launchd-oupdate.log", path: [],
    });
  });
  test("missing label, user or time is an error", () => {
    expect(() => parse(without("--label"))).toThrow(/--label/);
    expect(() => parse(without("--user"))).toThrow(/--user/);
    expect(() => parse(without("--at"))).toThrow(/--at/);
  });
  test("--at takes HH:MM from 00:00 to 23:59", () => {
    expect(parse(swap("--at", "00:00"))).toMatchObject({ hour: 0, minute: 0 });
    expect(parse(swap("--at", "23:59"))).toMatchObject({ hour: 23, minute: 59 });
    for (const bad of ["24:00", "23:60", "3:30", "03:3", "0330", "ab:cd", "-1:00", "03:30:00", ""]) expect(() => parse(swap("--at", bad))).toThrow(/--at/);
  });
  test("paths must be absolute", () => {
    for (const f of ["--bun", "--app", "--home", "--stdout"]) expect(() => parse(swap(f, "rel/path"))).toThrow(new RegExp(`${f} must be an absolute path`));
    expect(() => parse([...base, "--config", "config.json"])).toThrow(/--config must be an absolute path/);
  });
  test("a stdout file named 2*.log is refused: a log reader takes the newest 2*.log", () => {
    expect(() => parse(swap("--stdout", "/var/log/oupdate/20261022.log"))).toThrow(/starts with 2/);
    expect(() => parse(swap("--stdout", "/var/log/oupdate/2.txt"))).toThrow(/starts with 2/);
    expect(parse(swap("--stdout", "/var/log/2026/launchd.log")).stdout).toBe("/var/log/2026/launchd.log");
  });
  test("a flag without a value, an unknown flag, or a control character is an error", () => {
    expect(() => parse(["--label"])).toThrow(/--label needs a value/);
    expect(() => parse(["--label", "--user", "svc"])).toThrow(/--label needs a value/);
    expect(() => parse([...base, "--bogus"])).toThrow(/unknown flag --bogus/);
    expect(() => parse(swap("--label", "a\u0001b"))).toThrow(/control character/);
  });
  test("bun defaults to the bun on PATH, unresolved; app to this tree", () => {
    // Mutant caught (launchd review 1): the default was process.execPath, the resolved Cellar path.
    const a = parse(without("--bun").filter((_, i, l) => !(l[i] === "--app" || l[i - 1] === "--app")), { which: () => "/opt/pkg/bin/bun" });
    expect(a.bun).toBe("/opt/pkg/bin/bun");
    expect(a.app).toBe(tree);
    expect(() => parse(without("--bun"), { which: () => null })).toThrow(/no bun on PATH: pass --bun/);
  });
  test("a bun under a Cellar is refused, given or default: brew cleanup deletes that dir after an upgrade", () => {
    // Mutant caught (launchd review 1): any absolute --bun was taken, a Cellar keg path included.
    expect(() => parse(swap("--bun", "/opt/homebrew/Cellar/bun/1.4.3/bin/bun"))).toThrow(/Cellar.*--bun \/opt\/homebrew\/bin\/bun/);
    expect(() => parse(without("--bun"), { which: () => "/usr/local/Cellar/bun/1.4.3/bin/bun" })).toThrow(/Cellar.*--bun \/usr\/local\/bin\/bun/);
    expect(parse(swap("--bun", "/opt/Cellarish/bin/bun")).bun).toBe("/opt/Cellarish/bin/bun");
  });
  test("a bun in a temp dir or a bun-node- shim dir is refused, given or default: gone at reboot or the next upgrade", () => {
    // Mutant caught (launchd re-review 1): under `bun run --bun` the found bun was
    // /private/tmp/bun-node-<rev>/bun, a temp link, and it went into the plist.
    for (const p of ["/tmp/x/bun", "/private/tmp/x/bun", "/var/folders/ab/T/bun", "/private/var/folders/ab/T/bun", "/opt/bun-node-26aa4e1a9/bun"]) {
      expect(() => parse(swap("--bun", p))).toThrow(/temporary.*--bun/);
      expect(() => parse(without("--bun"), { which: () => p })).toThrow(/temporary.*--bun/);
    }
    expect(parse(swap("--bun", "/opt/tmp/bin/bun")).bun).toBe("/opt/tmp/bin/bun");
  });
  test("a default bun under the invoker's home is refused for another user: require --bun", () => {
    // Mutant caught (launchd re-review 1): another user's job was given a bun it cannot traverse to.
    const invoker = { username: "me", homedir: "/srv/people/me" };
    const which = () => "/srv/people/me/.bun/bin/bun";
    expect(() => parse(without("--bun"), { which, invoker })).toThrow(/under the home of me.*svc.*--bun/);
    const mine = parse(without("--bun").map((a, i, l) => (l[i - 1] === "--user" ? "me" : a)), { which, invoker });
    expect(mine.bun).toBe("/srv/people/me/.bun/bin/bun");
    expect(parse(swap("--bun", "/srv/people/me/.bun/bin/bun"), { invoker }).bun).toBe("/srv/people/me/.bun/bin/bun");
    expect(parse(without("--bun"), { which: () => "/srv/people/meow/bin/bun", invoker }).bun).toBe("/srv/people/meow/bin/bun");
  });
  test("a config brew or npm dir with \":\" is refused: it would split PATH", () => {
    // Mutant caught (launchd re-review 2): only --path was checked for ":".
    expect(() => parse([...base, "--config", config({ brew: "/opt/a:b/brew" })])).toThrow(/apply\.brew.*":"/);
    expect(() => parse([...base, "--config", config({ npm: "/opt/a:b/npm" })])).toThrow(/apply\.npm.*":"/);
  });
  test("a config that cannot be read says why it is read and that --path can stand in", () => {
    // Mutant caught (launchd re-review 4): "cannot read config F" alone, with --stdout given.
    expect(() => parse([...base, "--config", join(root, "missing.json")])).toThrow(/cannot read config .*brew and npm dirs.*--path/);
    expect(() => parse([...base, "--config", config({ bogus: 1 })])).toThrow(/unknown key bogus.*brew and npm dirs.*--path/);
  });
  test("--label takes reverse-DNS characters only: it becomes the file name", () => {
    // Mutant caught (launchd review 6): any non-empty label was taken.
    for (const bad of ["org/example", "org example", "a&b", "org.example_x", "../x"]) expect(() => parse(swap("--label", bad))).toThrow(/--label/);
    expect(parse(swap("--label", "Org.Example-2.apply")).label).toBe("Org.Example-2.apply");
  });
  test("PATH gets the config's absolute brew and npm dirs and each --path, deduped", () => {
    // Mutant caught (launchd review 2): PATH was bun's dir and the system dirs only, so npm's
    // `#!/usr/bin/env node` failed when node was not beside bun.
    const c = config({ brew: "/opt/homebrew/bin/brew", npm: "/opt/node/bin/npm" });
    const a = parse([...base, "--config", c, "--path", "/opt/extra/bin", "--path", "/opt/node/bin"]);
    expect(a.path).toEqual(["/opt/homebrew/bin", "/opt/node/bin", "/opt/extra/bin"]);
    expect(parse([...base, "--config", config({ brew: "brew", npm: null })]).path).toEqual([]);
    expect(() => parse([...base, "--path", "rel/bin"])).toThrow(/--path must be an absolute path/);
    expect(() => parse([...base, "--path", "/a:/b"])).toThrow(/--path.*:/);
  });
  test("HOME is required for another user, derived for the user running it", () => {
    expect(() => parse(without("--home"))).toThrow(/--home/);
    const me = userInfo();
    expect(parse([...without("--home").map((a, i, l) => (l[i - 1] === "--user" ? me.username : a))]).home).toBe(me.homedir);
  });
  test("stdout defaults beside the config's logFile, else is required", () => {
    const c = config({ logFile: "/var/log/oupdate/{date}.log" });
    expect(parse([...without("--stdout"), "--config", c])).toMatchObject({ config: c, stdout: "/var/log/oupdate/launchd-oupdate.log" });
    expect(() => parse([...without("--stdout"), "--config", config({})])).toThrow(/--stdout/);
    expect(() => parse(without("--stdout"))).toThrow(/--stdout/);
    expect(() => parse([...without("--stdout"), "--config", config({ logFile: "/var/log/{date}/run.log" })])).toThrow(/--stdout/);
    expect(() => parse([...without("--stdout"), "--config", join(root, "missing.json")])).toThrow(/cannot read config/);
  });
});

describe("parseHostCommand", () => {
  test("--launchd-plist is its own mode", () => {
    expect(parseHostCommand(["--launchd-plist", ...base])).toEqual({ mode: "launchd", args: parse(base) });
    expect(() => parseHostCommand(["--launchd-plist", "--apply", ...base])).toThrow(/one of/);
    expect(() => parseHostCommand(["--launchd-plist", "--dry-run", ...base])).toThrow(/unknown flag --dry-run/);
  });
});

const args: LaunchdArgs = parse(base);

describe("launchdPlist", () => {
  test("keys and values", () => {
    const p = launchdPlist(args);
    expect(p.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist')).toBe(true);
    expect(p).toContain("<key>Label</key>\n  <string>org.example.oupdate-apply</string>");
    expect(p).toContain("<key>UserName</key>\n  <string>svc</string>");
    expect(p).toContain("<key>GroupName</key>\n  <string>staff</string>");
    expect(p).toContain("<key>RunAtLoad</key>\n  <false/>");
    expect(p).toContain("<key>StartCalendarInterval</key>\n  <dict>\n    <key>Hour</key>\n    <integer>3</integer>\n    <key>Minute</key>\n    <integer>30</integer>\n  </dict>");
    expect(p).toContain(
      "<key>ProgramArguments</key>\n  <array>\n    <string>/opt/bun/bin/bun</string>\n    <string>/srv/oupdate/src/cli.ts</string>\n    <string>host</string>\n    <string>--apply</string>\n  </array>",
    );
    expect(p).toContain("<key>HOME</key>\n    <string>/var/svc</string>");
    expect(p).toContain("<key>PATH</key>\n    <string>/opt/bun/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>");
    expect(p).toContain("<key>StandardOutPath</key>\n  <string>/var/log/oupdate/launchd-oupdate.log</string>");
    expect(p).toContain("<key>StandardErrorPath</key>\n  <string>/var/log/oupdate/launchd-oupdate.log</string>");
    expect(p).not.toContain("KeepAlive");
    expect(p).not.toContain("AbandonProcessGroup");
  });
  test("--config is passed through", () => {
    const p = launchdPlist({ ...args, config: "/etc/oupdate/config.json" });
    expect(p).toContain("<string>--apply</string>\n    <string>--config</string>\n    <string>/etc/oupdate/config.json</string>\n  </array>");
  });
  test("PATH is bun's dir, the extra dirs, then the system dirs", () => {
    expect(launchdPlist({ ...args, path: ["/opt/homebrew/bin", "/opt/node/bin", "/usr/bin"] })).toContain(
      "<string>/opt/bun/bin:/opt/homebrew/bin:/opt/node/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>",
    );
  });
  test("a bun in a system dir is not listed twice in PATH", () => {
    expect(launchdPlist({ ...args, bun: "/usr/bin/bun" })).toContain("<string>/usr/bin:/bin:/usr/sbin:/sbin</string>");
  });
  test("every string is XML-escaped", () => {
    const p = launchdPlist({ ...args, user: `a&b<c>"d'e`, app: "/srv/a&b", home: "/var/h<'>" });
    expect(p).toContain("<string>a&amp;b&lt;c&gt;&quot;d&apos;e</string>");
    expect(p).toContain("<string>/srv/a&amp;b/src/cli.ts</string>");
    expect(p).toContain("<string>/var/h&lt;&apos;&gt;</string>");
    expect(p).not.toMatch(/&(?!amp;|lt;|gt;|quot;|apos;)/);
  });
});

describe.if(process.platform === "darwin")("plutil", () => {
  const lint = (text: string) => {
    const f = join(root, `p${++n}.plist`);
    writeFileSync(f, text);
    const l = Bun.spawnSync(["plutil", "-lint", f]);
    const j = Bun.spawnSync(["plutil", "-convert", "json", "-o", "-", f]);
    return { rc: l.exitCode, json: j.exitCode === 0 ? JSON.parse(j.stdout.toString()) : undefined };
  };
  test("the plist passes plutil -lint and reads back as given", () => {
    const r = lint(launchdPlist({ ...args, config: "/etc/oupdate/config.json" }));
    expect(r.rc).toBe(0);
    expect(r.json).toEqual({
      Label: "org.example.oupdate-apply",
      UserName: "svc",
      GroupName: "staff",
      RunAtLoad: false,
      StartCalendarInterval: { Hour: 3, Minute: 30 },
      ProgramArguments: ["/opt/bun/bin/bun", "/srv/oupdate/src/cli.ts", "host", "--apply", "--config", "/etc/oupdate/config.json"],
      EnvironmentVariables: { HOME: "/var/svc", PATH: "/opt/bun/bin:/usr/bin:/bin:/usr/sbin:/sbin" },
      StandardOutPath: "/var/log/oupdate/launchd-oupdate.log",
      StandardErrorPath: "/var/log/oupdate/launchd-oupdate.log",
    });
  });
  test("escaped values pass plutil -lint and read back unescaped", () => {
    const r = lint(launchdPlist({ ...args, user: `a&b<c>"d'e`, app: "/srv/a&b" }));
    expect(r.rc).toBe(0);
    expect(r.json.UserName).toBe(`a&b<c>"d'e`);
    expect(r.json.ProgramArguments[1]).toBe("/srv/a&b/src/cli.ts");
  });
});

describe("the CLI", () => {
  const cli = (argv: string[]) => {
    const p = Bun.spawnSync(["bun", join(tree, "src/cli.ts"), "host", ...argv]);
    return { rc: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
  };
  test("prints the plist and writes nothing", () => {
    const c = config({ logFile: join(root, "logs", "{date}.log") });
    const r = cli(["--launchd-plist", ...without("--stdout"), "--config", c]);
    expect(r.rc).toBe(0);
    expect(r.out).toBe(launchdPlist({ ...args, config: c, stdout: join(root, "logs", "launchd-oupdate.log") }));
    expect(existsSync(join(root, "logs"))).toBe(false);
    expect(r.err).toBe("");
  });
  test("a bad argument exits 2 with the reason", () => {
    const r = cli(["--launchd-plist", ...swap("--at", "25:00")]);
    expect(r.rc).toBe(2);
    expect(r.out).toBe("");
    expect(r.err).toContain("--at");
  });
  test("bun defaults to the bun on PATH, not the resolved one", () => {
    const r = cli(["--launchd-plist", ...without("--bun")]);
    expect(r.rc).toBe(0);
    const bun = Bun.which("bun")!;
    expect(r.out).toContain(`<string>${bun}</string>`);
    expect(r.out).toContain(`<string>${dirname(bun)}:/usr/bin:/bin:/usr/sbin:/sbin</string>`);
  });
});
