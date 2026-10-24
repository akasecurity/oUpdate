// oupdate host --launchd-plist: prints the LaunchDaemon that runs `oupdate host --apply` once a
// day, in place of the old updater's job. It only prints; the operator installs it as root.

import { readFileSync } from "node:fs";
import { userInfo } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { parseApplyConfig } from "../apply/config.ts";

export interface LaunchdArgs {
  label: string;
  user: string;
  hour: number;
  minute: number;
  /** The run's HOME: where the default config ($HOME/.config/oupdate/config.json) is read. */
  home: string;
  bun: string;
  /** The oupdate tree; the job runs <app>/src/cli.ts. */
  app: string;
  /** launchd's StandardOutPath and StandardErrorPath. */
  stdout: string;
  /** Dirs between bun's and the system dirs: the config's brew and npm dirs, then each --path. */
  path: string[];
  config?: string;
}

export interface LaunchdDeps {
  /** Finds a command on PATH without resolving symlinks (default: Bun.which). */
  which?: (cmd: string) => string | null;
  /** The user running this (default: os.userInfo()). */
  invoker?: { username: string; homedir: string };
}

/** The tree this file is in. */
export const appRoot = () => resolve(import.meta.dir, "../..");

/** The system dirs, last on the job's PATH. */
const SYSTEM_PATH = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"];
const VALUE_FLAGS = new Set(["--label", "--user", "--at", "--config", "--bun", "--app", "--home", "--stdout", "--path"]);
const USAGE = "usage: oupdate host --launchd-plist --label LABEL --user USER --at HH:MM [--config FILE] [--bun PATH] [--app DIR] [--home DIR] [--stdout FILE] [--path DIR]...";

/** What the plist takes from the config: the stdout default beside its logFile, and the dirs of its absolute brew and npm. */
function fromConfig(config: string): { stdout?: string; dirs: string[] } {
  // Read even with --stdout given: the job's PATH needs the brew and npm dirs.
  const why = "--launchd-plist reads it for the brew and npm dirs on the job's PATH and the --stdout default; to skip it, leave out --config and give those dirs with --path DIR (the job then reads the default config)";
  let text: string;
  try {
    text = readFileSync(config, "utf8");
  } catch {
    throw new Error(`cannot read config ${config}: ${why}`);
  }
  let cfg: ReturnType<typeof parseApplyConfig>;
  try {
    cfg = parseApplyConfig(text, "-");
  } catch (e) {
    throw new Error(`config ${config}: ${e instanceof Error ? e.message : String(e)}; ${why}`);
  }
  // npm is `#!/usr/bin/env node`: its dir (where Homebrew's node sits too) must be on PATH.
  const dirs: string[] = [];
  for (const [k, p] of [["brew", cfg.brew], ["npm", cfg.npm]] as const) {
    if (!p || !isAbsolute(p)) continue;
    if (dirname(p).includes(":")) throw new Error(`config ${config}: apply.${k} ${p} is in a dir with ":", which would split the job's PATH`);
    dirs.push(dirname(p));
  }
  const stdout = cfg.logFile && !dirname(cfg.logFile).includes("{date}") ? join(dirname(cfg.logFile), "launchd-oupdate.log") : undefined;
  return { dirs, ...(stdout ? { stdout } : {}) };
}

/**
 * Refuses a bun inside a Homebrew Cellar keg: the first run that upgrades bun ends with brew
 * cleanup, which deletes that keg, and launchd then cannot exec the job.
 */
function stableBun(bun: string, given: boolean): string {
  const i = bun.indexOf("/Cellar/");
  if (i < 0) return bun;
  const link = join(bun.slice(0, i) || "/", "bin", basename(bun));
  throw new Error(`${given ? "--bun" : "the bun on PATH"} ${bun} is inside a Homebrew Cellar keg, which brew cleanup deletes after an upgrade: pass --bun ${link} (the stable link)`);
}

/** Temp dirs, gone at reboot; bun-node- is the node shim dir `bun run --bun` puts first on PATH. */
const TEMP_PREFIXES = ["/tmp/", "/private/tmp/", "/var/folders/", "/private/var/folders/"];
function notTemp(bun: string, given: boolean): string {
  if (TEMP_PREFIXES.some((t) => bun.startsWith(t)) || bun.split("/").some((seg) => seg.startsWith("bun-node-")))
    throw new Error(`${given ? "--bun" : "the bun on PATH"} ${bun} is a temporary path (a temp dir or bun's bun-node- shim), gone at reboot or the next bun upgrade: pass --bun with bun's installed path`);
  return bun;
}

/** `--launchd-plist` arguments (the mode flag itself is skipped). */
export function parseLaunchdArgs(argv: string[], deps: LaunchdDeps = {}): LaunchdArgs {
  const f = new Map<string, string>();
  const extra: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--launchd-plist") continue;
    if (!VALUE_FLAGS.has(a)) throw new Error(`unknown flag ${a}\n${USAGE}`);
    const v = argv[++i];
    if (v === undefined || v.startsWith("--")) throw new Error(`${a} needs a value`);
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f]/.test(v)) throw new Error(`${a}: a control character cannot go in a plist`);
    if (a === "--path") extra.push(v);
    else f.set(a, v);
  }
  const need = (k: string, what: string) => {
    const v = f.get(k);
    if (!v) throw new Error(`--launchd-plist needs ${k} ${what}\n${USAGE}`);
    return v;
  };
  const abs = (k: string, v: string) => {
    if (!isAbsolute(v)) throw new Error(`${k} must be an absolute path, got ${v}`);
    return v;
  };
  const label = need("--label", "LABEL");
  // It becomes the file name /Library/LaunchDaemons/<label>.plist.
  if (!/^[A-Za-z0-9.-]+$/.test(label)) throw new Error(`--label takes reverse-DNS characters only (A-Z a-z 0-9 . -), got ${label}`);
  const user = need("--user", "USER");
  const at = /^(\d\d):(\d\d)$/.exec(need("--at", "HH:MM"));
  const hour = at ? Number(at[1]) : NaN;
  const minute = at ? Number(at[2]) : NaN;
  if (!(hour <= 23 && minute <= 59)) throw new Error(`--at takes HH:MM from 00:00 to 23:59, got ${f.get("--at")}`);
  const config = f.has("--config") ? abs("--config", f.get("--config")!) : undefined;
  const invoker = deps.invoker ?? userInfo();
  let bun = f.get("--bun");
  if (bun === undefined) {
    // The PATH entry, not process.execPath: that is the resolved path, inside the Cellar keg for a brew bun.
    const found = (deps.which ?? ((c: string) => Bun.which(c)))("bun");
    if (!found) throw new Error("no bun on PATH: pass --bun PATH");
    bun = notTemp(stableBun(abs("the bun on PATH", found), false), false);
    // Another user cannot traverse into the invoker's home (mode 700 by default).
    if (user !== invoker.username && bun.startsWith(`${invoker.homedir.replace(/\/+$/, "")}/`))
      throw new Error(`the bun on PATH ${bun} is under the home of ${invoker.username}, which ${user} may not be able to reach: pass --bun with a bun ${user} can run`);
  } else bun = notTemp(stableBun(abs("--bun", bun), true), true);
  const app = abs("--app", f.get("--app") ?? appRoot());
  let home = f.get("--home");
  if (home === undefined) {
    // Only the passwd entry of the user running this is known safely; anyone else's HOME is given.
    const me = invoker;
    if (me.username !== user) throw new Error(`--launchd-plist needs --home DIR for user ${user} (derived only for ${me.username})`);
    home = me.homedir;
  }
  abs("--home", home);
  const fromCfg = config ? fromConfig(config) : { dirs: [] };
  for (const d of extra) {
    abs("--path", d);
    if (d.includes(":")) throw new Error(`--path ${d}: a dir with ":" cannot go on PATH`);
  }
  const path = [...new Set([...fromCfg.dirs, ...extra])];
  const stdout = f.get("--stdout") ?? fromCfg.stdout;
  if (!stdout) throw new Error("--launchd-plist needs --stdout FILE (the default sits beside the config's apply.logFile, and none was given)");
  abs("--stdout", stdout);
  if (basename(stdout).startsWith("2")) throw new Error(`--stdout ${stdout}: a name that starts with 2 looks like a run log to the digest, which reads the newest 2*.log`);
  return { label, user, hour, minute, home, bun, app, stdout, path, ...(config ? { config } : {}) };
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
const str = (s: string) => `<string>${esc(s)}</string>`;

/** The LaunchDaemon plist. No KeepAlive and no AbandonProcessGroup: the idle waiter detaches itself. */
export function launchdPlist(a: LaunchdArgs): string {
  const argv = [a.bun, join(a.app, "src", "cli.ts"), "host", "--apply", ...(a.config ? ["--config", a.config] : [])];
  const path = [...new Set([dirname(a.bun), ...a.path, ...SYSTEM_PATH])].join(":");
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "  <key>Label</key>",
    `  ${str(a.label)}`,
    "  <key>UserName</key>",
    `  ${str(a.user)}`,
    "  <key>GroupName</key>",
    `  ${str("staff")}`,
    "  <key>ProgramArguments</key>",
    "  <array>",
    ...argv.map((v) => `    ${str(v)}`),
    "  </array>",
    "  <key>EnvironmentVariables</key>",
    "  <dict>",
    "    <key>HOME</key>",
    `    ${str(a.home)}`,
    "    <key>PATH</key>",
    `    ${str(path)}`,
    "  </dict>",
    "  <key>RunAtLoad</key>",
    "  <false/>",
    "  <key>StartCalendarInterval</key>",
    "  <dict>",
    "    <key>Hour</key>",
    `    <integer>${a.hour}</integer>`,
    "    <key>Minute</key>",
    `    <integer>${a.minute}</integer>`,
    "  </dict>",
    "  <key>StandardOutPath</key>",
    `  ${str(a.stdout)}`,
    "  <key>StandardErrorPath</key>",
    `  ${str(a.stdout)}`,
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}
