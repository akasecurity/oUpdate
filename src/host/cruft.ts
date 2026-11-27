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
//             (shape (a), no shebang and a binary-looking head) is not counted, unless it is a shell or launcher (dash, ksh, osascript, nohup...): those run other files.

import { resolve } from "node:path";
import { PLIST_MAX_BYTES, type ApplyFs } from "../apply/fs.ts";

/** The fixed backup name prefixes (each pattern is `<prefix>*`, the rest may be empty). */
export const CRUFT_BACKUP_PREFIXES = ["config.json.bak-", "config.json.pre-oq4e", "oharness.pre-", "ilane.stale-"] as const;
/** Interpreters shapes (b) and (c) accept, by basename (versioned names such as python3.12 included). */
const INTERPRETER = /^(?:python3?|ruby|perl|node|bun|bash|zsh|sh)(?:[0-9]+(?:\.[0-9]+)*)?$/;
/** Programs that run another file or command (shells and launchers the interpreter list lacks): never a binary to skip, by basename. */
const LAUNCHERS = /^(?:dash|ksh|ksh93|tcsh|csh|osascript|nohup|caffeinate)$/;
/** Where an interpreter (and, alone in /usr/bin, env) must sit to be one: a program of that name anywhere else is "complex". */
const INTERPRETER_DIRS = ["/bin", "/usr/bin", "/usr/local/bin", "/opt/homebrew/bin"];
/** The system dirs a judged plist's PATH may name (each entry exactly one of these). */
const SYSTEM_DIRS = ["/usr/bin", "/bin", "/usr/sbin", "/sbin", "/usr/local/bin", "/opt/homebrew/bin", "/opt/homebrew/sbin"];
/** Locale values that keep a script's bytes read as the script wrote them: C, POSIX, or letters_letters.UTF-8. */
const PLAIN_LOCALE = /^(?:C|POSIX|[A-Za-z]+(?:_[A-Za-z]+)?\.UTF-8)$/;
/**
 * Why an EnvironmentVariables dictionary is not safe for a judged plist, or undefined. Only PATH (exact system dirs, so a
 * planted dir cannot shadow env, bash or date), LANG, LC_ALL, LC_CTYPE (a plain locale: a multibyte one such as Big5 or
 * GBK makes bash read part of a UTF-8 script as a quote) and TZ are allowed; any other name, the empty one included, is
 * a variable that may make an interpreter run other code.
 */
function envProblem(env: Record<string, unknown>): string | undefined {
  for (const [k, v] of Object.entries(env)) {
    if (k === "TZ" && typeof v === "string") continue;
    if (k === "PATH" && typeof v === "string" && v.split(":").every((d) => SYSTEM_DIRS.includes(d))) continue;
    if ((k === "LANG" || k === "LC_ALL" || k === "LC_CTYPE") && typeof v === "string" && PLAIN_LOCALE.test(v)) continue;
    return `sets ${k}`;
  }
  return undefined;
}
/**
 * The only top-level keys (lower case: launchd lowercases every job key, so Foo, foo and FOO are one key) a judged plist
 * may have, each one in `man launchd.plist`. None changes the program, its argv, cwd, stdin, user, group, home or
 * environment. Any other key, the unknown and underscore-prefixed ones included, makes the plist "complex".
 * Accepted lows, no behavior change: StandardOutPath, StandardErrorPath, Umask and the resource limits can feed or
 * overwrite an owned script that reads its stdio or is writable, and rejecting them would leave most real wrappers
 * (which log) unadopted.
 */
const ALLOWED_KEYS = new Set([
  "label", "program", "programarguments", "environmentvariables", "disabled", "runatload", "keepalive", "ondemand",
  "startinterval", "startcalendarinterval", "startonmount", "watchpaths", "queuedirectories", "throttleinterval",
  "standardoutpath", "standarderrorpath", "processtype", "nice", "lowpriorityio", "lowprioritybackgroundio",
  "abandonprocessgroup", "launchonlyonce", "exittimeout", "timeout", "umask", "limitloadtohosts", "limitloadfromhosts",
  "limitloadtosessiontype", "limitloadtohardware", "limitloadfromhardware", "softresourcelimits", "hardresourcelimits",
  "enabletransactions", "enablepressuredexit", "sessioncreate", "associatedbundleidentifiers", "machservices",
]);
const dirOf = (p: string) => p.slice(0, Math.max(p.lastIndexOf("/"), 0)) || "/";
const OWNER_LINE = /^#\s*owner:\s*\S/;

export interface Cruft {
  pins: string[];
  backups: string[];
  wrappers: string[];
}

type CruftFs = Pick<ApplyFs, "home" | "listDir" | "listDirStrict" | "readHead" | "realPath" | "plistJson" | "pinFiles">;
/** How much of a script is read: the shebang and the owner line sit at the top; a later `# owner:` is not seen. */
const SCRIPT_BYTES = 512;
/** A head that reads as a binary: a NUL, a control byte other than tab, newline, form feed and CR, or a replacement character (what a Mach-O or ELF magic decodes to). */
const looksBinary = (h: string) => /[\u0000-\u0008\u000b\u000e-\u001f\ufffd]/.test(h);
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
  // launchctl reads the file with libxpc, plutil with CoreFoundation; a NUL (cut off by one, kept by the other) is a form they read differently.
  if (JSON.stringify(o).includes("\\u0000")) return "NUL";
  // launchd lowercases (ASCII) every job key before it stores or looks one up: read the keys the same way.
  const byLower = new Map<string, string>();
  for (const k of Object.keys(o)) {
    const l = k.replace(/[A-Z]/g, (c) => c.toLowerCase());
    if (byLower.has(l)) return `duplicate key ${k}`;
    if (!ALLOWED_KEYS.has(l)) return `sets ${k}`;
    byLower.set(l, k);
  }
  const at = (l: string) => (byLower.has(l) ? o[byLower.get(l)!] : undefined);
  const program = at("program");
  const args = at("programarguments");
  const env = at("environmentvariables");
  if (program === undefined && args === undefined) return "no Program or ProgramArguments";
  if (program !== undefined && !str(program)) return "Program is not a string";
  if (args !== undefined && !(Array.isArray(args) && args.length > 0 && args.every(str))) return "ProgramArguments is not a list of strings";
  if (env !== undefined) {
    if (typeof env !== "object" || env === null || Array.isArray(env)) return "EnvironmentVariables is not a dictionary";
    const bad = envProblem(env as Record<string, unknown>);
    if (bad !== undefined) return bad;
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
  // A launcher is no binary to skip: it runs whatever file or command it is given, so the plist is counted.
  if (LAUNCHERS.test(base(first))) return "complex";
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
  const adoptedRaw = (dirCfg.startsWith("~/") ? `${home}/${dirCfg.slice(2)}` : dirCfg).replace(/\/+$/, "");
  // The adopted dir is canonicalized from the raw string by the OS (native realpath: a link is followed before a ".." after
  // it). If that lookup fails, nothing is adopted: no lexical fallback (scripts/missing/.. is not scripts). The plain
  // spelling (the configured string with a "/" added, never resolve()d) is also accepted; a script path with a "." or ".."
  // segment is rejected before that, so a dotted configured dir never matches it.
  // Accepted lows, all needing write access inside the adopted dir or its configured path, or only overcounting:
  // (a) a same-path content swap between the read and the second lookup; (b) a link chain created inside the adopted dir
  // (alias.sh -> an outside link -> own.sh); (c) the configured dir being a symlink that retargets during one scan;
  // (d) a different spelling of the same place (case, NFC/NFD, /var for /private/var), which only overcounts.
  // (e) the depth rule still adopts a shared top-level-plus-one directory (/private/tmp, a shared directory under the users root, another user's home);
  // (h) a hard link made between the fstat of the read and the second realPath; (i) `~/scripts/..` through a symlinked home is
  // now broad where it was adopted before: an overcount. Not fixed here (tracked as follow-up rows): a redundant slash in a
  // symlinked home spelling (fixed since, OUP-368).
  // (f) two names for one owned script inside the adopted dir count as unadopted by design (overcount); (g) a device swapped in
  // between the stat and the open of a script reaches openSync before the descriptor check rejects it (needs write access there).
  const dotted = (p: string) => p.split("/").some((x) => x === "." || x === "..");
  // An fs with no realPath (a test fake) has no links: the lexically resolved path (resolve()) is its real path. A lookup that fails adopts nothing.
  const realRaw = fs.realPath ? await fs.realPath(adoptedRaw) : resolve(adoptedRaw);
  const plainAdopted = `${adoptedRaw}/`;
  // A root, a top-level directory, the home dir or an ancestor of it is too broad to be a scripts directory: it adopts
  // nothing (an overcount is the fail-closed side). Home is checked as given and by its real path.
  const homeReal = (fs.realPath ? await fs.realPath(home) : undefined) ?? home;
  // Spellings only widen the test: names are folded (case, NFC, runs of slashes, the /System/Volumes/Data firmlink root), and the configured dir is also taken with its "." and ".."
  // collapsed as text, so Alias/. and Alias/dir/.. count as Alias. Wrong-spelling only overcounts.
  const fold = (x: string) => x.normalize("NFC").toLowerCase().replace(/\/{2,}/g, "/").replace(/^\/system\/volumes\/data(?=\/|$)/, "");
  const broad = (d: string) => d.split("/").filter(Boolean).length < 2 || [`${home}/`, `${homeReal}/`].some((h) => fold(h).startsWith(fold(d)));
  const realSlash = realRaw === undefined ? undefined : `${realRaw.replace(/\/+$/, "")}/`;
  const collapsed = `${resolve(adoptedRaw).replace(/\/+$/, "")}/`;
  const realAdopted = realSlash === undefined || [realSlash, plainAdopted, collapsed].some(broad) ? undefined : realSlash;
  for (const d of [`${fs.home}/Library/LaunchAgents`, "/Library/LaunchAgents", "/Library/LaunchDaemons"]) {
    // A directory that exists but cannot be listed (no access) is one problem to count, not an empty one: its plists would vanish.
    const names = fs.listDirStrict ? await fs.listDirStrict(d) : await fs.listDir(d);
    if (names === undefined) {
      wrappers.push(`${d} complex dir: unlistable`);
      continue;
    }
    for (const n of names.filter((x) => x.endsWith(".plist")).sort()) {
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
      // Resolve the script to its real path, read that path, then resolve again: the file read and the file judged are one.
      const real = fs.realPath ? await fs.realPath(run.script) : resolve(run.script);
      // The head and the link count come from one open (meta.links); no link is followed at the resolved path.
      const m1: { links?: number; noFollow?: boolean } = { noFollow: true };
      const body = real === undefined ? undefined : await fs.readHead?.(fs.realPath ? real : run.script, SCRIPT_BYTES, m1);
      // A script that is missing or cannot be read (a FIFO, no access) is unadopted: it is not left out of the count.
      if (body === undefined) {
        wrappers.push(`${d}/${n} runs ${run.script}`);
        continue;
      }
      // The second look comes before any skip, so no path is left out of the count before it has been resolved twice.
      const again = fs.realPath ? await fs.realPath(run.script) : real;
      let stable = again === real;
      // Shape (a) with no shebang is a binary program: not counted, once it resolved the same twice and a second read of the
      // head still says binary. An empty file is not a binary: it falls to the owner check and is counted.
      // Whatever the second read says is what is judged from here on (head and link count): a swap is never judged on the
      // first read's owner line; a second read that fails counts.
      let head = body;
      let links = m1.links;
      if (stable && run.shebang && body !== "" && !body.startsWith("#!") && looksBinary(body)) {
        const m2: { links?: number; noFollow?: boolean } = { noFollow: true };
        const body2 = await fs.readHead?.(fs.realPath ? real! : run.script, SCRIPT_BYTES, m2);
        // A third lookup after the second read: a path retargeted during that read is unstable, so it is counted, never skipped.
        if (fs.realPath && (await fs.realPath(run.script)) !== real) stable = false;
        // A binary with another name (a hard link) is shared with a place outside the directory: counted, not skipped.
        if (stable && body2 !== undefined && body2 !== "" && !body2.startsWith("#!") && looksBinary(body2) && (m2.links === undefined || m2.links === 1)) continue;
        head = body2 ?? "";
        links = m2.links;
      }
      // A file with another name (a hard link) is shared with a place outside the directory: unadopted. A fake fs with no
      // link count (links undefined) has no hard links.
      // The path as given must have no "." or ".." segment: resolve() erases link/.. as text while the kernel follows the
      // link first, so such a path is never adopted. Then both the path as given and its real path must be inside the
      // directory (outside/w -> scripts is not adopted; a link inside that points outside is not).
      // Accepted lows (a)-(d) are listed where realAdopted is built: they need write access in the adopted dir, where an
      // owned script can be edited anyway, or only overcount.
      const inside = !dotted(run.script) && stable && (links === undefined || links === 1) && realAdopted !== undefined && real!.startsWith(realAdopted) && (run.script.startsWith(realAdopted) || run.script.startsWith(plainAdopted));
      const owned = inside && head.split("\n", 6).slice(0, 5).some((l) => OWNER_LINE.test(l));
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
