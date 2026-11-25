// oupdate host --readiness: the "latest-readiness" report of this host (OUP-302 phase 0). Read-only.
// It runs the apply dry run as it is (src/apply/run.ts: every check, nothing changed, no log file, no
// state write, no notice sent; the app-bundle phase is left out, its dry run still fetches into the
// state dir) and adds what that run does not print as a table: each outdated brew
// formula, cask, npm global and App Store app with its pin state and the plan the dry run gave it,
// the disk free on the brew prefix, and a DNS/registry probe line. It never upgrades, pins or unpins.
// Not visible from here: brew itself drops a formula or cask that fails to load from `brew outdated` without a message
// (Homebrew formula.rb and caskroom.rb), so such a package is neither listed nor reported as not checked.

import type { ApplyConfig } from "../apply/config.ts";
import type { Exec } from "../apply/exec.ts";
import type { ApplyFs } from "../apply/fs.ts";
import { pinFilter } from "../apply/pins.ts";
import { applyHost } from "../apply/run.ts";
import { planKey } from "../apply/run-ctx.ts";
import type { AppNet } from "../apply/appbundle.ts";
import { parseNpmOutdated } from "../apply/npm.ts";
import { outdatedVersions } from "../apply/taps.ts";

// Whole escape sequences (CSI "ESC [ ... final", OSC "ESC ] ... BEL|ST"; an OSC left open ends at the next
// whitespace, so it cannot eat the rest of the line), then every remaining control, format, invisible,
// line/paragraph-separator, bidi and tag character and every lone surrogate: the text of brew, npm, mas
// and the dry run is untrusted and may carry ESC/OSC, CR, a line break, U+202E and the like. A line is
// cut at MAX_LINE code points.
const ANSI = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b\s]*(?:\u0007|\u001b\\)?)/g;
const HIDDEN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}\p{Default_Ignorable_Code_Point}]/gu;
const MAX_LINE = 400;
const clean = (s: string) => s.replace(ANSI, "").replace(/\t/g, " ").replace(HIDDEN, "");
/** A name as shown: cleaned and cut; a name that had text removed (or is empty after cleaning) says so, so two rows that look alike are told apart. */
const shown = (n: string) => {
  const f = field(n, 100);
  return `${blank(n) ? "<empty name>" : f}${f === n ? "" : " (text removed)"}`;
};
/** One field of a row cut on its own, so a long name cannot push the pin and plan columns off the line. */
const field = (s: string, n: number) => cap(clean(s), n).replace(/\|/g, "¦").replace(/→/g, "›");
const cap = (s: string, n = MAX_LINE) => {
  const cps = [...s];
  return cps.length > n ? `${cps.slice(0, n).join("")}…` : s;
};
const words = (s: string) => s.split(/\s+/).filter(Boolean);
const last = (n: string) => n.split("/").at(-1)!;

const NPM_ENV = { NO_UPDATE_NOTIFIER: "1", npm_config_update_notifier: "false" };
/** exec with the update notifier off for every call of the npm binary, an env the caller passed kept. */
export const npmQuiet = (npm: string | null, exec: Exec): Exec => (argv, o) => exec(argv, argv[0] === npm ? { ...o, env: { ...o?.env, ...NPM_ENV } } : o);
// Escape sequences as a terminal reads them, for the error check only (clean() above stops an open OSC at the next
// space so a line is never eaten; here a title with spaces must go): OSC up to BEL or ST (ESC \\ or the C1 ST), CSI
// (also the C1 form), charset and other nF escapes ("ESC ( B", "ESC % / G"), any other single-character ESC code
// ("ESC 7", "ESC c"), and the C1 OSC. Linear: every body class excludes the character that starts the same part (ESC,
// U+009B, U+009D) and the terminator, so a part cannot run past the next start of its own kind.
const ANSI_TERM = /\u001b(?:\][^\u0007\u001b\u009c]*(?:\u0007|\u001b\\|\u009c)|\[[0-?]*[ -/]*[@-~]|[ -/]+[0-~]|[0-Z\\^-~])|\u009b[0-?]*[ -/]*[@-~]|\u009d[^\u0007\u009c\u009d\u001b]*(?:\u0007|\u009c)/g;
/** The printable character that shows as a blank (braille blank; the hangul fillers are invisible characters clean() already removes): a name or version of only these shows nothing. */
const BLANKS = /\u2800/g;
/** True when a text shows as nothing once cleaned (empty, spaces, invisible or blank-looking characters only). */
const blank = (s: string) => clean(s).replace(BLANKS, "").trim() === "";
/** A line as the error check reads it, in this order: escapes removed; every visible whitespace character (tab, no-break space, U+3000, ...) and the braille blank U+2800 as a
 *  plain space (the BOM U+FEFF is whitespace to JS but invisible, so it is left for the next step); then every invisible character removed, as clean() removes it (so
 *  the hangul fillers U+3164, U+115F, U+1160, U+FFA0, which are default-ignorable, are removed, not gaps, in both). */
const plain = (l: string) => l.replace(ANSI_TERM, "").replace(/(?!\ufeff)[\s\u2800]/g, " ").replace(HIDDEN, "");
// An error the tool printed: "Error:" or "ERROR:" (not a lowercase "error: 0 warnings"), "==> Error:", "npm ERR!" and "npm error"
// in any case; warnings ("Warning:", "npm warn", "Errors: 0", "npm error-x@1") are not.
const ERR_TOOL = /^ *(?:==> *)?(?:Error|ERROR):/;
const ERR_NPM = /^ *npm *(?:err!|error(?=\s|$))/i;
/** The stderr a tool may print next to an empty list, read after the error check's cleaning, one line at a time, each in its full real shape:
 *  brew: a "Warning:" line and its continuation block (the indented lines and the "Please report this issue" line after it, up to a
 *  blank line), exactly "Already up-to-date." and "Updating Homebrew...", a Ruby "x.rb:3: warning:" line, Node's "(node:N) [DEPnnnn]
 *  DeprecationWarning|ExperimentalWarning|PunycodeWarning:" line and its "(Use `node --x ...` to show where the warning was created)" line;
 *  npm: "npm warn|notice|info|verbose|silly|timing" lines (npm 12 names; the older "verb" and "sill" too), "npm http fetch GET 2xx|3xx", and the Node
 *  lines. npm 12 prefixes every notice line, so no npm continuation rule exists.
 *  Any of them holding a failure word (FAILURE_WORD) is not benign. */
const NODE_LINES = [/^\(node:\d+\) (?:\[DEP\d+\] )?(?:Deprecation|Experimental|Punycode)Warning:/, /^\(Use `node --[a-z-]+ \.\.\.` to show where the warning was created\)$/];
const BENIGN_BREW = [/^Warning:/, /^Already up-to-date\.$/, /^Updating Homebrew\.\.\.$/, /^\S+\.rb:\d+: warning:/, ...NODE_LINES];
const BREW_BLOCK = /^Warning:/;
const BREW_CONT = /^Please report this issue/;
const BENIGN_NPM = [/^npm +(?:warn|notice|info|verbose|silly|verb|sill|timing)\b/i, /^npm +http +fetch +GET +[23]\d\d\b/, ...NODE_LINES];
/** A word that makes a line a failure whatever form it has: a benign line (or a continuation) holding one is not benign. Read after NFKC. */
const FAILURE_WORD = /error|fail|fatal|denied|refused|EACCES|ENOTFOUND|ETIMEDOUT|ECONN/i;
/** True when stderr holds a line that is not blank and not a known benign form: the tool may have failed in a way no pattern names. */
const unknownErr = (err: string, benign: RegExp[], block?: RegExp, cont?: RegExp) => {
  let inBlock = false;
  for (const l of err.split(LINE_END)) {
    const p = plain(l);
    const t = p.trim();
    if (t === "") inBlock = false;
    else if (benign.some((b) => b.test(t)) && !FAILURE_WORD.test(p.normalize("NFKC"))) inBlock = block?.test(t) ?? false;
    else if (inBlock && (p.startsWith(" ") || (cont !== undefined && cont.test(t))) && !FAILURE_WORD.test(p.normalize("NFKC"))) continue;
    else return true;
  }
  return false;
};
/** Colour codes (SGR) only: a heading may be coloured, but any other escape (an OSC title with text in it) makes the line not a heading. */
const SGR = /\u001b\[[0-9;]*m/g;
/** The "==>" headings brew prints around a list, on stdout or after an auto-update: only these are dropped, every other "==>" line is counted. */
const BREW_HEADING = /^==> +(?:Auto-updat(?:ing|ed)(?: Homebrew(?:\.\.\.|!)?)?|Updating Homebrew\.\.\.|(?:Updated|New|Deleted|Outdated) (?:Formulae|Casks)|Renamed Formulae|Formulae|Casks)$/;
/** Line ends a terminal or a tool may use: LF, CR (a progress line ends in CR), VT, FF, NEL, LS, PS. */
const LINE_END = /[\n\r\v\f\u0085\u2028\u2029]/;
/** True when a line of the text is an error line (colour codes, title sequences and the like do not hide it). */
export const hasError = (text: string) => text.split(LINE_END).some((l) => {
  const p = plain(l);
  return ERR_TOOL.test(p) || ERR_NPM.test(p);
});
/** A list line holding a control, invisible or separator character (ESC included) is not a row: clean() would strip it on display and fuse two rows. Read the line after tabs are made spaces (the display does that), never before. */
const LINE_HIDDEN = new RegExp(`${HIDDEN.source}|\\u2800`, "u");
const hiddenIn = (l: string) => {
  // Any whitespace but the plain space (NBSP, U+3000, ...) is a separator too: a row never holds one.
  return LINE_HIDDEN.test(l) || /[^\S ]/.test(l);
};
/** A `brew outdated --verbose` row, literal spaces only and ASCII only (brew names and versions are), anchored: "<name> (<installed>) < <new>" (or !=), then at most brew's own "[pinned at X]" / "[pinned]". The installed group holds no parenthesis, so text run into a row cannot hide in it (outdatedVersions reads the same three fields). */
const BREW_ROW = /^[^\s()]+ \([^()\s][^()]*\) (?:<|!=) \S+(?: \[pinned(?: at [^\]\s]+)?\])?$/;
/** The longest mas line taken for an app row (the width it is shown at, so no version is cut off): a longer line is a body (a proxy page), not a list entry. */
const MAX_ROW = 200;
/** The largest Available (1 KiB blocks) read as a size: 10^13 is ten petabytes. */
const MAX_KB = 1e13;

export interface ReadinessResult {
  lines: string[];
  /** 1 when the dry run failed or any read could not be made. */
  rc: 0 | 1;
}

export async function readiness(cfg: ApplyConfig, exec: Exec, fs: ApplyFs, o: { now?: Date; /** A test seam: the app-bundle network (never reached, app bundles are left out). */ appNet?: AppNet }): Promise<ReadinessResult> {
  let trouble = false;
  const note = (s: string) => {
    trouble = true;
    return s;
  };
  // Every brew read runs with auto-update off, as the apply run does (run.ts): `brew outdated` would
  // otherwise fetch the taps first.
  const x = async (argv: string[]) => {
    try {
      return await exec(argv, { timeoutMs: cfg.timeoutMs, soft: true, ...(argv[0] === cfg.brew ? { env: { HOMEBREW_NO_AUTO_UPDATE: "1" } } : argv[0] === cfg.npm ? { env: NPM_ENV } : {}) });
    } catch (e) {
      return { rc: 1, out: "", err: e instanceof Error ? e.message : String(e) };
    }
  };

  // The dry run's own npm calls (outdated, view) get the same notifier-off environment as the reads above.
  const dry = await applyHost({ ...cfg, appBundles: [] }, npmQuiet(cfg.npm, exec), fs, { dryRun: true, skipPreflight: true, ...(o.now ? { now: o.now } : {}), ...(o.appNet ? { appNet: o.appNet } : {}) });
  const dryLines = [...dry.log, ...dry.summary].flatMap((l) => l.split(/\r?\n/));
  if (dry.rc !== 0) trouble = true;

  // The plan column comes from the dry run's structured decisions (dry.plan), never from its text: that text
  // carries outside strings (registry answers, versions, names) that could forge a line.
  const holds = new Map(Object.entries(dry.plan.holds));
  const typeAHeld = new Set(dry.plan.typeAHeld);
  const typeAUp = new Set(dry.plan.typeAUp);
  const plan = (kind: "formula" | "cask", name: string) => {
    const k = planKey(kind, name);
    if (holds.has(k)) return `held (${field(holds.get(k)!, 100)})`;
    if (typeAHeld.has(k)) return "held (Type A version policy)";
    if (typeAUp.has(k)) return "Type A, would upgrade";
    return "not planned by the dry run (a Type B or unknown-tap package, a deferred cask, or held by another rule: see the dry run below)";
  };

  const out: string[] = [`=== ${cfg.host} latest-readiness (read-only: nothing upgraded, unpinned or written under the state dir; a reviewer call makes and removes a temp dir, and npm may write its own cache; invisible characters such as ZWNJ and ZWJ are removed from the text, Persian and emoji included) ===`];

  // Disk and network.
  const pre = await x([cfg.brew, "--prefix"]);
  const prefix = pre.rc === 0 ? pre.out.trim() : "";
  if (!prefix.startsWith("/")) out.push(note(`disk: not checked — ${cfg.brew} --prefix failed (rc ${pre.rc})`));
  else {
    const df = await x(["df", "-k", "--", prefix]);
    // Header plus a row. The row is read as whitespace tokens (one pass, no backtracking): the first token that is
    // "<digits>%" and has three all-digit tokens before it is the capacity column, and the token before it is
    // Available. A filesystem name with spaces ("map auto_home") cannot shift the numbers, and "-100" or "4%20x" is not one.
    const dl = df.out.trim().split("\n");
    const tk = dl.length >= 2 ? dl.at(-1)!.trim().split(/\s+/) : [];
    const cis = tk.flatMap((t, i) => (/^\d+%$/.test(t) && /^\d+$/.test(tk[i - 1]!) && /^\d+$/.test(tk[i - 2]!) && /^\d+$/.test(tk[i - 3]!) ? [i] : []));
    // Two places that look like the columns (a name such as "fs 1 2 3 4%") are not read.
    const kb = cis.length === 1 ? Number(tk[cis[0]! - 1]) : NaN;
    if (df.rc !== 0 || !(kb <= MAX_KB)) out.push(note(`disk: not checked — df -k -- ${prefix} failed (rc ${df.rc})`));
    else out.push(`disk: ${(kb / 1048576).toFixed(1)} GiB free on ${prefix}`);
  }
  for (const raw of [cfg.npmRegistry, "https://formulae.brew.sh"]) {
    // Only an http(s) URL without credentials, a query or a fragment is probed (a token in a query would sit on curl's argv), and only its origin is printed.
    let u: URL | undefined;
    try {
      u = new URL(raw);
    } catch {
      u = undefined;
    }
    if (!u || !/^https?:$/.test(u.protocol) || u.username || u.password || u.search || u.hash || /[[\]{}]/.test(u.pathname)) {
      const why = !u || !/^https?:$/.test(u.protocol) ? "not an http(s) URL" : u.username || u.password ? "it carries credentials" : "it carries a query, a fragment or a glob";
      out.push(note(`network: registry URL not probed (${why})`));
      continue;
    }
    const label = u.origin;
    // -q: no ~/.curlrc; -g: no URL globbing; --: the URL is never an option; the parsed href, not the raw string, is what is probed.
    const c = await x(["curl", "-q", "-g", "-sS", "-o", "/dev/null", "-I", "-m", "10", "-w", "%{http_code}", "--", u.href]);
    const code = c.out.trim();
    if (c.rc === 0 && /^[23]\d\d$/.test(code)) out.push(`network: ${label} ok (http ${code})`);
    else out.push(note(`network: ${label} FAILED (rc ${c.rc}${c.rc === 6 ? ", DNS" : ""}${code && code !== "000" ? `, http ${code}` : ""})`));
  }

  // brew: formulae and casks, with brew pins and pins.json.
  const pinnedQ = await x([cfg.brew, "list", "--pinned"]);
  const files = fs.pinFiles(cfg.pinRoots);
  for (const [kind, label, args] of [
    ["brew", "brew formulae", ["outdated", "--formula", "--verbose"]],
    ["cask", "brew casks", ["outdated", "--cask", "--greedy-auto-updates", "--verbose"]],
  ] as const) {
    const q = await x([cfg.brew, ...args]);
    if (q.rc !== 0) {
      out.push(note(`${label}: not checked — ${cfg.brew} ${args.join(" ")} failed (rc ${q.rc})`));
      continue;
    }
    // Names stay raw here: they key the pin and plan lookups, which the dry run made on the same raw names. What is
    // shown is the whole name, cleaned by field() (so `foo ESC]8;;http://x` shows as "foo", never as its last segment "x").
    // Lines end where a terminal would end them (as hasError reads them). Only a known brew heading (BREW_HEADING) is dropped:
    // every other "==>" line, like any other line, is not a row and is counted.
    const all = q.out.split(LINE_END).map((l) => l.trim()).filter((l) => l && !BREW_HEADING.test(l.replace(SGR, "").trim()));
    // A row is "<name> (<installed>) < <new>" (or !=): any other line is not a row and is not listed as one.
    // A row holds no character the cleaner strips and no whitespace but a plain space (two rows or a row and other text
    // run together by a separator would be read as one), and one " < " / " != " group only (two rows run together by a
    // plain space are one line with two). Such a line is not a row; it stays in `all` and is counted below.
    const oneGroup = (l: string) => l.split(/ (?:<|!=) /).length === 2;
    const rows = all.filter((l) => BREW_ROW.test(l) && !/[^\x20-\x7e]/.test(l) && oneGroup(l));
    // Any stderr line that is not a known warning, or a "==> Error:" line, with no row is not "nothing outdated": brew said it could not look.
    if (rows.length === 0 && (unknownErr(q.err, BENIGN_BREW, BREW_BLOCK, BREW_CONT) || hasError(q.out))) {
      out.push(note(`${label}: not checked — ${cfg.brew} ${args.join(" ")} printed an error and no row`));
      continue;
    }
    if (rows.length !== all.length) out.push(note(`${label}: not checked for ${all.length - rows.length} line(s) that are not in the row shape "<name> (<from>) < <to>"`));
    out.push(rows.length === 0 && all.length > 0 ? `${label}: no row could be read from ${all.length} line(s)` : `${label} outdated (${rows.length}):`);
    const names = rows.map((l) => words(l)[0]!);
    const pins = pinFilter(kind, names, { brewPinned: pinnedQ.rc === 0 ? words(pinnedQ.out) : [], files });
    const pinWhy = new Map(pins.pinned.map((p) => [p.replace(/\(.*$/, ""), p.replace(/^[^(]*\(|\)$/g, "")]));
    for (const l of rows) {
      const n = words(l)[0]!;
      // Each row shows its own versions (a name printed twice is listed twice), so core `alpha` and `other/tap/alpha` never share them.
      const ver = outdatedVersions(n, l);
      const cut = ver.lastIndexOf("→");
      const v = `${field(ver.slice(0, cut), 40)} → ${field(ver.slice(cut + 1), 40)}`;
      const why = pinWhy.get(n);
      out.push(`  ${shown(n)} ${v} | pin: ${why === undefined ? "none" : why === "brew pin" ? "brew pin" : `pins.json (${field(why, 60)})`} | plan: ${plan(kind === "brew" ? "formula" : "cask", n)}`);
    }
    for (const w of pins.warnings) out.push(note(`  ${w}`));
  }
  if (pinnedQ.rc !== 0) out.push(note(`  WARNING: brew list --pinned failed (rc ${pinnedQ.rc}) — brew pins not shown, repo pins still shown`));
  // The pinned list is read like the outdated list: stderr that is not a known warning, or an error line on stdout, means brew may not have said every pin
  // (a pinned formula would show "pin: none"), so the brew pins are not checked.
  else if (unknownErr(pinnedQ.err, BENIGN_BREW, BREW_BLOCK, BREW_CONT) || hasError(pinnedQ.out)) out.push(note("  WARNING: brew list --pinned printed an error or text that is not a pin list — brew pins may be missing, repo pins still shown"));

  // npm globals: no pin file exists for them.
  if (cfg.npm) {
    const n = await x([cfg.npm, "outdated", "-g", "--json"]);
    // npm outdated exits 1 when something is outdated, with an object of entries on stdout. A failed query
    // is never "nothing outdated": rc 1 with nothing or {} on stdout, an {"error": ...} object, and an
    // entry that is not an object with a string current or latest are all failures (as the dry run's parse).
    const parsed = parseNpmOutdated(n.out);
    const j = parsed ? (JSON.parse(n.out.trim() || "{}") as Record<string, { current?: unknown; latest?: unknown }>) : {};
    // A version is judged as it is shown: one that is empty or blank after cleaning is a failure, like the empty string.
    const shownVersion = (x: unknown) => x === undefined || (typeof x === "string" && !blank(x));
    const failed = (n.rc !== 0 && n.rc !== 1) || !parsed || (!parsed.size && unknownErr(n.err, BENIGN_NPM)) || (n.rc === 1 && !parsed.size) || !Object.values(j).every((v) => (typeof v.current === "string" || typeof v.latest === "string") && shownVersion(v.current) && shownVersion(v.latest));
    if (failed) out.push(note(`npm globals: not checked — npm outdated -g failed (rc ${n.rc}) or printed no outdated list`));
    else {
      out.push(`npm globals outdated (${parsed!.size}):`);
      for (const [name, v] of Object.entries(j)) out.push(`  ${shown(name)} ${field(String(v.current ?? "?"), 40)} → ${field(String(v.latest ?? "?"), 40)} | pin: none (npm has no pin file) | plan: batch review (see the dry run below)`);
    }
  } else out.push("npm globals: not configured");

  // Mac App Store: read-only, `mas outdated`.
  const mas = await x(["mas", "outdated"]);
  if (mas.rc === 127) out.push("mas: not checked — mas not installed");
  else if (mas.rc !== 0) out.push(note(`mas: not checked — mas outdated failed (rc ${mas.rc})`));
  else if (!mas.out.trim() && mas.err.trim()) out.push(note("mas: not checked — mas outdated printed only on stderr"));
  else if (!mas.out.trim()) out.push("mas: nothing outdated");
  else {
    // Every check below, and the display, read the same text: tabs are spaces from here on.
    const rows = mas.out.split(LINE_END).map((l) => l.replace(/\t/g, " ").trim()).filter(Boolean);
    // A row is "<app id> <name> (<from> -> <to>)": anything else on stdout ("403 Forbidden", an error line) is not a list.
    if (rows.length === 0 || !rows.every((l) => l.length <= MAX_ROW && !hiddenIn(l) && l.split(" -> ").length === 2 && /^\d+\s+\S.* \([^()\s][^()]* -> [^()\s][^()]*\)$/.test(l))) out.push(note("mas: not checked — mas outdated printed text that is not an app list"));
    else {
      for (const l of rows) out.push(`mas: ${field(l, 200)}`);
      if (mas.err.trim()) out.push(note("mas: outdated also printed text on stderr (not shown); the list above may be incomplete"));
    }
  }

  if (cfg.appBundles.length) out.push(`app bundles: not checked in readiness (${cfg.appBundles.length} configured; their dry run fetches into the state dir)`);
  // Every dry-run line is shown behind a fixed prefix: text in it can never start a report line (a header, a row).
  out.push("--- dry run (what `host --apply --dry-run` computes, each line prefixed) ---", ...dryLines.map((l) => `  | ${l}`));
  return { lines: out.map((l) => cap(clean(l))), rc: trouble ? 1 : 0 };
}
