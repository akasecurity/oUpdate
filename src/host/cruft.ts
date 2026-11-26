// `oupdate host --cruft-count`: a read-only count of the host's ownerless leftovers, for the weekly
// sweep summary. It reads and prints; it deletes, moves and writes nothing. Local host only.
//   pins:     a pins.json entry without a non-empty `owner` and `reason` string (the entry is then
//             an object: {"brew": {"duckdb": {"version": "1.5.5", "owner": "...", "reason": "..."}}}),
//             and every config pinRoots / caskExclude value the policy file does not list (policy.ts).
//   backups:  files in the config directory that match the fixed list of tool-generated backup names.
//   wrappers: a LaunchAgents/LaunchDaemons plist is ADOPTED only when it runs a script in one of three exact
//             shapes, the script is inside the adopted-scripts directory (config adoptedScriptsDir, default
//             <home>/scripts) and has a `# owner:` comment in its first lines:
//               (a) argv = [script, ...args]                    (the script starts with #!)
//               (b) argv = [interpreter, script, ...args]       (script is an absolute path, never an option)
//               (c) argv = [/usr/bin/env, interpreter, script, ...args]
//             An interpreter sits in /bin, /usr/bin, /usr/local/bin or /opt/homebrew/bin. Anything else (an
//             option before the script, a Program that differs from argv[0], an unknown or misplaced
//             interpreter, a relative path, a plist the OS parser cannot read, a variable that
//             makes an interpreter run other code) is counted UNADOPTED as "complex": an overcount is visible
//             and a person can judge it, an undercount would be a false green. A program that is a binary
//             (shape (a), no shebang) is not counted.

import { resolve } from "node:path";
import { PLIST_MAX_BYTES, type ApplyFs } from "../apply/fs.ts";

/** The fixed backup name prefixes (each pattern is `<prefix>*`, the rest may be empty). */
export const CRUFT_BACKUP_PREFIXES = ["config.json.bak-", "config.json.pre-oq4e", "oharness.pre-", "ilane.stale-"] as const;
/** Interpreters shapes (b) and (c) accept, by basename (versioned names such as python3.12 included). */
const INTERPRETER = /^(?:python3?|ruby|perl|node|bun|bash|zsh|sh)(?:[0-9]+(?:\.[0-9]+)*)?$/;
/** Where an interpreter (and, alone in /usr/bin, env) must sit to be one: a program of that name anywhere else is "complex". */
const INTERPRETER_DIRS = ["/bin", "/usr/bin", "/usr/local/bin", "/opt/homebrew/bin"];
/** Variables that make an interpreter run other code than the script that was checked; a plist setting one is "complex". */
const CODE_ENV = ["BASH_ENV", "ENV", "NODE_OPTIONS", "PERL5OPT", "RUBYOPT", "PYTHONPATH", "PYTHONSTARTUP", "BUN_OPTIONS", "ZDOTDIR", "HOME", "DYLD_INSERT_LIBRARIES", "DYLD_LIBRARY_PATH", "PERL5LIB", "RUBYLIB", "NODE_PATH", "PYTHONHOME"];
/** Top-level keys that change how launchd resolves the program or its arguments. */
const RESOLVE_KEYS = ["RootDirectory", "EnableGlobbing"];
const dirOf = (p: string) => p.slice(0, Math.max(p.lastIndexOf("/"), 0)) || "/";
const OWNER_LINE = /^#\s*owner:\s*\S/;

export interface Cruft {
  pins: string[];
  backups: string[];
  wrappers: string[];
}

type CruftFs = Pick<ApplyFs, "home" | "listDir" | "readHead" | "plistJson" | "pinFiles">;
/** How much of a script is read: the shebang and the owner line sit at the top; a later `# owner:` is not seen. */
const SCRIPT_BYTES = 512;
const base = (p: string) => p.split("/").at(-1)!;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const filled = (v: unknown) => typeof v === "string" && v.trim() !== "";

/** The entries of one pins.json text that lack an owner or a reason, as "<file>: <kind> <name>". */
function ownerlessPins(file: string, text: string): string[] {
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch {
    return [];
  }
  if (!isObj(root)) return [];
  const out: string[] = [];
  for (const kind of ["brew", "cask"]) {
    const group = root[kind];
    if (!isObj(group)) continue;
    for (const [name, v] of Object.entries(group)) if (!(isObj(v) && filled(v.owner) && filled(v.reason))) out.push(`${file}: ${kind} ${name}`);
  }
  return out;
}

/**
 * A parsed property list's launch: Program and ProgramArguments (argv). A string is the reason it cannot be judged:
 * neither key, a Program that is no non-empty string, a ProgramArguments that is no non-empty list of non-empty
 * strings, an EnvironmentVariables that is no object or names a variable that makes an interpreter run other code.
 */
export function plistLaunch(o: Record<string, unknown>): { program?: string; argv: string[] } | string {
  const str = (v: unknown): v is string => typeof v === "string" && v !== "";
  const { Program: program, ProgramArguments: args, EnvironmentVariables: env } = o;
  const resolves = RESOLVE_KEYS.find((k) => k in o);
  if (resolves) return `sets ${resolves}`;
  // launchctl reads the file with libxpc, plutil with CoreFoundation; a NUL (cut off by one, kept by the other) is a form they read differently.
  if (JSON.stringify(o).includes("\\u0000")) return "NUL";
  if (program === undefined && args === undefined) return "no Program or ProgramArguments";
  if (program !== undefined && !str(program)) return "Program is not a string";
  if (args !== undefined && !(Array.isArray(args) && args.length > 0 && args.every(str))) return "ProgramArguments is not a list of strings";
  if (env !== undefined) {
    if (typeof env !== "object" || env === null || Array.isArray(env)) return "EnvironmentVariables is not a dictionary";
    const code = Object.keys(env).find((k) => CODE_ENV.includes(k));
    if (code) return `sets ${code}`;
  }
  // launchd runs Program when it is present, with ProgramArguments as the argv; with no ProgramArguments the argv is [Program].
  const argv = (args as string[] | undefined) ?? [program as string];
  return { ...(program !== undefined ? { program } : {}), argv };
}

/**
 * The script a launch runs when it matches shape (a), (b) or (c) of the header, or "complex" for any other form.
 * `shebang` is whether the script must start with #! to count as a script (shape (a) only: in (b) and (c) the
 * interpreter runs the file whatever it starts with).
 */
export function launchScript(l: { program?: string; argv: string[] }): { script: string; shebang: boolean } | "complex" {
  const { argv } = l;
  if (l.program !== undefined && l.program !== argv[0]) return "complex";
  const abs = (w: string | undefined): w is string => w !== undefined && w.startsWith("/");
  const interp = (w: string | undefined) => w !== undefined && INTERPRETER.test(base(w)) && INTERPRETER_DIRS.includes(dirOf(w));
  const first = argv[0]!;
  // A program named env or like an interpreter that is not in a standard place is not trusted to be one.
  if (base(first) === "env") return first === "/usr/bin/env" && interp(argv[1]) && abs(argv[2]) ? { script: argv[2], shebang: false } : "complex";
  if (INTERPRETER.test(base(first))) return interp(first) && abs(argv[1]) ? { script: argv[1], shebang: false } : "complex";
  return abs(first) ? { script: first, shebang: true } : "complex";
}

export async function cruftCount(a: { fs: CruftFs; configDir: string; pinRoots: string[]; ownerlessConfigValues: string[]; adoptedScriptsDir?: string }): Promise<Cruft> {
  const { fs } = a;
  const pins = [...a.ownerlessConfigValues];
  for (const f of fs.pinFiles(a.pinRoots)) if (f.text !== undefined) pins.push(...ownerlessPins(f.path, f.text));

  const dir = a.configDir.replace(/\/+$/, "") || "/";
  const backups = (await fs.listDir(dir)).filter((n) => CRUFT_BACKUP_PREFIXES.some((p) => n.startsWith(p))).sort().map((n) => `${dir}/${n}`);

  const wrappers: string[] = [];
  const home = fs.home.replace(/\/+$/, "");
  const dirCfg = a.adoptedScriptsDir ?? `${home}/scripts`;
  const adopted = `${resolve(dirCfg.startsWith("~/") ? `${home}/${dirCfg.slice(2)}` : dirCfg).replace(/\/+$/, "")}/`;
  for (const d of [`${fs.home}/Library/LaunchAgents`, "/Library/LaunchAgents", "/Library/LaunchDaemons"]) {
    for (const n of (await fs.listDir(d)).filter((x) => x.endsWith(".plist")).sort()) {
      const obj = await fs.plistJson?.(`${d}/${n}`);
      if (obj === undefined) {
        wrappers.push(`${d}/${n} complex plist: unreadable`);
        continue;
      }
      // launchctl (libxpc) and plutil read the same text differently in places, so a text plist is judged only when its
      // source is plain: a whitelist, not a list of bad spellings. This source check and plutil's read are two
      // separate reads of the file, so the raw read must succeed (one that fails, or fills the read bound, is not trusted).
      const raw = await fs.readHead?.(`${d}/${n}`, PLIST_MAX_BYTES);
      const problem = raw === undefined || Buffer.byteLength(raw) >= PLIST_MAX_BYTES ? "unreadable" : sourceProblem(raw);
      if (problem) {
        wrappers.push(`${d}/${n} complex plist: ${problem}`);
        continue;
      }
      const launch = plistLaunch(obj);
      if (typeof launch === "string") {
        wrappers.push(`${d}/${n} complex plist: ${launch}`);
        continue;
      }
      const run = launchScript(launch);
      if (run === "complex") {
        wrappers.push(`${d}/${n} complex argv: ${launch.argv.slice(0, 4).join(" ")}`);
        continue;
      }
      const body = await fs.readHead?.(run.script, SCRIPT_BYTES);
      // Nothing readable (missing, a FIFO): not counted. Shape (a) with no shebang is a binary program: not counted.
      if (body === undefined || (run.shebang && !body.startsWith("#!"))) continue;
      // The path is resolved first: scripts/../../x is outside the directory.
      const owned = resolve(run.script).startsWith(adopted) && body.split("\n", 6).slice(0, 5).some((l) => OWNER_LINE.test(l));
      if (!owned) wrappers.push(`${d}/${n} runs ${run.script}`);
    }
  }
  return { pins, backups, wrappers };
}

/**
 * Why the source text of a plist is not plain enough to judge, or undefined. A binary plist (bplist) has no text to
 * check. A text plist must have no NUL byte (UTF-16/32) and start with "<" after an optional UTF-8 BOM, mention an
 * encoding only in a leading XML declaration that names UTF-8, have no CDATA
 * (libxpc decodes entities inside it, plutil does not), and every "&" must start amp; lt; gt; quot; or apos; (a
 * decimal or hex reference decodes differently in the two readers).
 */
export function sourceProblem(raw: string): string | undefined {
  if (raw.startsWith("bplist")) return undefined;
  // trimStart also strips a leading BOM (U+FEFF).
  const t = raw.trimStart();
  if (raw.includes("\u0000") || !t.startsWith("<")) return "plist encoding";
  // plutil follows a declared encoding (UTF-7, windows-1252...), libxpc reads the bytes as written: the only accepted
  // mention of an encoding is the leading XML declaration naming UTF-8.
  if (/encoding/i.test(raw)) {
    const m = /^<\?xml[^>?]{0,256}\sencoding\s{0,8}=\s{0,8}(["'])utf-8\1[^>?]{0,256}\?>/i.exec(t);
    if (!m || (m[0].match(/encoding/gi) ?? []).length !== 1 || /encoding/i.test(t.slice(m[0].length))) return "plist encoding";
  }
  if (raw.includes("<![CDATA[")) return "CDATA";
  if (/&(?!(?:amp|lt|gt|quot|apos);)/.test(raw)) return "entity";
  return undefined;
}

/** A name as one printable line: JSON-style escapes for control bytes and newlines (also DEL, C1 and the Unicode line separators). */
export const safeName = (n: string) =>
  JSON.stringify(n)
    .slice(1, -1)
    .replace(/[\u007f-\u009f\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);

/** The summary line, then one indented line per name. */
export function cruftLines(c: Cruft): string[] {
  return [
    `cruft: pins ${c.pins.length} ownerless, backups ${c.backups.length}, wrappers ${c.wrappers.length} unadopted (this host only)`,
    ...c.pins.map((p) => `  pin: ${safeName(p)}`),
    ...c.backups.map((p) => `  backup: ${safeName(p)}`),
    ...c.wrappers.map((p) => `  wrapper: ${safeName(p)}`),
  ];
}
