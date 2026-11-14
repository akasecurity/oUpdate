// The per-host digest: a short plain-words message after an apply run. What updated, what was
// held and why (the reason the run's log already carries), what waits on a person and the action
// to take. A pure function of the run's log text; it sends nothing.
//
// The summary lines are parts joined by "; " (src/apply/run-brew.ts assembleBrew, run-steps.ts
// finishRun). Some parts carry "; " themselves (the tap-approval list, Gatekeeper notes, a
// reviewer's free-text reason), so a fragment that starts no known part is joined back to the part
// before it when that part can hold one; anything else is shown as unrecognized, never dropped.

import { STUCK_SINCE } from "../apply/stuck.ts";
import { stripTerminal } from "../review.ts";
import { readRunBlock } from "./prev-log.ts";

export interface DigestInput {
  host: string;
  date: string;
  /** The run's log text, summary block included. */
  log: string;
}

const MAX_REASON = 200;
const words = (s: string) => s.split(/\s+/).filter(Boolean);
// Whole escape sequences (CSI "ESC [ ... letter", OSC "ESC ] ... BEL|ST"), then the remaining controls.
const ANSI = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)?)/g;
/**
 * One line, terminal controls dropped, cut by code points. Backticks become quotes: no text from the
 * log opens a code span; "<" and "](" are escaped, so it opens no tag or link either.
 */
const one = (s: string) => {
  const t = stripTerminal(s.replace(ANSI, "").replace(/\s+/g, " ")).replace(/`/g, "'").trim();
  const cps = [...t];
  const cut = cps.length > MAX_REASON ? `${cps.slice(0, MAX_REASON - 1).join("")}…` : t;
  return cut.replace(/</g, "\\<").replace(/\]\(/g, "]\\(");
};
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** A name safe to print inside a copyable command: never one that reads as an option. */
const SAFE_NAME = /^(?!-)[A-Za-z0-9@+._/-]+$/;
const BY_HAND = "upgrade it by hand; its name has unusual characters, see the run log";

/** The reason a run logged for a package: its "<name>: <reason>" line, minus the trailing FLAG marker. */
function reasonFor(lines: string[], name: string): string {
  // Segments exclude "/", so a slash-heavy line that does not match fails in linear time.
  const re = new RegExp(`^\\s*(?:[^\\s/]+/)*${escape(name)}(?: \\(formula\\))?: (.+)$`);
  for (const l of lines) {
    const m = l.match(re);
    if (m && /FLAG|held|not upgrad/i.test(m[1]!)) return one(m[1]!.replace(/\s*—\s*FLAG\b.*$/, ""));
  }
  return "the review held it (see the run log)";
}

interface Out {
  up: Record<string, string[]>;
  updated: string[];
  held: string[];
  /** Formulas the summary says the review could not read; listed as held unless a Type B flag already names them. */
  unreadable: string[];
  waiting: string[];
  notes: string[];
  /** The brew core said only "FLAGGED": shown when nothing else explains the hold. */
  plainFlag?: boolean;
  /** A tap-approval or skipped-cask part already says what the review held. */
  flagExplained?: boolean;
  /** App bundles the body's review flag already lists: their summary hold is not listed again. */
  apps: Set<string>;
  /** Names a FAILED part listed ("release-check:<formula>" among them). */
  failed: Set<string>;
}

interface Part {
  re: RegExp;
  /** The part can carry "; ": a following fragment that starts no part (and matches this, when given) is joined back. */
  open?: true | RegExp;
  lane?: "brew" | "npm";
  on: (m: RegExpMatchArray, o: Out, lane: string) => void;
}

const STUCK_PART_ITEM = new RegExp(`(?:^|\\s)([^\\s=]+)=\\S*${STUCK_SINCE}(?=\\s|$)`, "g");
const each = (s: string, f: (n: string) => string) => words(s).map((n) => f(one(n)));
const TAP_ITEM = /^(\(unresolved tap\)|\S+) \((\S+) /;

const PARTS: Part[] = [
  { re: /^(?:casks )?upgraded:(.*)$/, on: (m, o, lane) => void (o.up[lane] ??= []).push(...each(m[1]!, (n) => n)) },
  { re: /^claude-code: FAILED \((.*)\)$/, on: (m, o) => void o.waiting.push(`claude-code: its update failed (${one(m[1]!)}); read the run log`) },
  { re: /^claude-code: (?:not configured|dry-run)$/, on: () => {} },
  { re: /^claude-code: (not completed|not run .*)$/, on: (m, o) => void o.notes.push(`claude-code: ${one(m[1]!)}`) },
  // The run records only the version after "claude update", never the one before: checked, not "updated".
  { re: /^claude-code: unknown$/, on: (_m, o) => void o.notes.push("claude-code: checked; its version could not be read") },
  { re: /^claude-code: (\S+)$/, on: (m, o) => void o.notes.push(`claude-code: ${one(m[1]!)} (checked)`) },
  { re: /^(?:nothing to update|nothing approved for upgrade|not run|dry-run OK|not managed here .*)$/, on: () => {} },
  { re: /^notify: not configured\b/, on: () => {} },
  { re: /^relinked after upgrade: /, on: () => {} },
  {
    // src/apply/restarts.ts: "<pkg>(<how>)" per service.
    re: /^restarted: (.*)$/,
    on: (m, o) => {
      const ok: string[] = [];
      for (const s of m[1]!.matchAll(/([^\s(]+)\(([^)]*)\)/g)) {
        const [n, how] = [one(s[1]!), s[2]!];
        if (/^(?:sys|user|sys,deferred|handed to .*)$/.test(how)) ok.push(n);
        else if (/FAILED/.test(how)) o.waiting.push(`${n}: its restart failed (${one(how)}); restart it by hand`);
        else o.held.push(`${n}: ${/not restarted/.test(how) ? one(how) : `not restarted (${one(how)})`}`);
      }
      if (ok.length) o.notes.push(`restarted: ${ok.join(", ")}`);
    },
  },
  { re: /^casks need sudo:(.*)$/, on: (m, o) => void o.waiting.push(...words(m[1]!).map((n) => (SAFE_NAME.test(n) ? `${n}: run \`brew upgrade --cask ${n}\` in a terminal where sudo works` : `${one(n)}: it needs sudo; ${BY_HAND}`))) },
  { re: /^casks held \(running\):(.*)$/, on: (m, o) => void o.held.push(...each(m[1]!, (n) => `${n}: it is running; the next run tries again`)) },
  { re: /^upgrades stopped by the time box, waiting for the next run:(.*)$/, on: (m, o) => void o.held.push(...each(m[1]!, (n) => `${n}: not tried, an earlier upgrade hit the time limit; the next run tries again`)) },
  // Listed by readDigest after the Type B flags, so a formula the flag notice already names is shown once.
  { re: /^held, reviewer cannot read the formula:(.*)$/, on: (m, o) => void o.unreadable.push(...words(m[1]!).map(one)) },
  { re: /^casks deferred:(.*)$/, on: (m, o) => void o.held.push(...each(m[1]!, (n) => `${n}: left for the end of the run and not tried (a step stopped first); the next run tries again`)) },
  {
    re: /^(?:casks )?FAILED:(.*)$/,
    on: (m, o) => {
      for (const n of words(m[1]!)) o.failed.add(n);
      o.waiting.push(...each(m[1]!, (n) => `${n}: the upgrade failed; read the run log`));
    },
  },
  { re: /^FAILED — (\S+)$/, on: (m, o, lane) => void o.waiting.push(`${one(m[1]!)}: the ${lane} step failed; read the run log`) },
  {
    re: /^FLAGGED — awaiting tap approval: (.*)$/s,
    open: TAP_ITEM,
    on: (m, o) => {
      o.flagExplained = true;
      // Text after the approve hint was joined back only because it looked like an item: it is not one.
      let past = false;
      for (const raw of m[1]!.split("; ")) {
        const cut: number = past ? -1 : raw.indexOf(" — approve a tap by adding it to ");
        const item = cut < 0 ? raw : raw.slice(0, cut);
        const t = past ? null : item.match(TAP_ITEM);
        past ||= cut >= 0;
        if (!t) {
          if (item.trim()) o.waiting.push(`unrecognized: ${one(item)}`);
          continue;
        }
        const pkg = one(t[2]!);
        if (t[1] === "(unresolved tap)") {
          o.held.push(`${pkg}: its tap could not be resolved`);
          o.waiting.push(`${pkg}: find which tap it comes from; read the run log`);
        } else {
          o.held.push(`${pkg}: its tap ${one(t[1]!)} is not approved yet`);
          o.waiting.push(`${pkg}: add the tap ${one(t[1]!)} to the approved-taps file to let the next run review it`);
        }
      }
    },
  },
  {
    re: /^(?:FLAGGED — )?trusted-tap cask\(s\) skipped \(no cask review path\):(.*)$/,
    on: (m, o) => {
      o.flagExplained = true;
      for (const s of words(m[1]!)) {
        const n = one(s.replace(/\(.*$/, ""));
        o.held.push(`${n}: its tap is trusted but has no cask review path, so it was skipped`);
        o.waiting.push(`${n}: check it and upgrade it by hand`);
      }
    },
  },
  { re: /^FLAGGED(?: \(see notifications\))?$/, lane: "brew", on: (_m, o) => void (o.plainFlag = true) },
  { re: /^PINNED:(.*)$/, on: (m, o) => { for (const s of m[1]!.matchAll(/([^\s(]+)\(([^)]*)\)/g)) o.held.push(`${one(s[1]!)}: pinned (${one(s[2]!)})`); } },
  {
    // "<name>=<version>(<runs> runs, since <date>)", space-joined; a version can hold "(" itself. Text that is no item is shown, never dropped.
    re: /^STUCK:(.*)$/,
    on: (m, o) => {
      const rest = m[1]!.replace(STUCK_PART_ITEM, (_all, name: string, runs: string, since: string) => {
        o.waiting.push(`${one(name)}: pending for ${runs} runs since ${one(since)}; upgrade it by hand or find what blocks it`);
        return " ";
      });
      if (rest.trim()) o.waiting.push(`unrecognized: STUCK: ${one(rest)}`);
    },
  },
  {
    // src/apply/run-brew.ts: "<name> <version>", "<name> (record unreadable)", "<name> (hold unreadable)", space-joined.
    re: /^HELD by release check:(.*)$/,
    on: (m, o) => {
      const rest = m[1]!.replace(/\s*(\S+) (\((record|hold) unreadable\)|[^\s(]\S*)/g, (_all, name: string, what: string, bad?: string) => {
        const n = one(name);
        if (bad) o.waiting.push(`${n}: its release check ${bad} is unreadable, so it is held; fix or remove it (see the run log)`);
        else o.held.push(`${n}: its release check failed on ${one(what)} and it was rolled back; a newer release is tried`);
        return "";
      });
      if (rest.trim()) o.waiting.push(`unrecognized: HELD by release check:${one(rest)}`);
    },
  },
  { re: /^HELD: (.*)$/, on: (m, o) => { for (const s of m[1]!.split(", ")) o.held.push(`${one(s.replace(/ \(runs under it\)$/, ""))}: the updater runs under it, so the run does not upgrade it; upgrade it by hand between runs`); } },
  // A FAIL, a failed step or a check that could not run needs a person; a PASS or a wait is a note.
  {
    re: /^release check: (.*)$/,
    on: (m, o) => {
      for (const note of rcNotes(m[1]!)) {
        if (!RC_BAD.test(note)) o.notes.push(`release check: ${one(note)}`);
        // A FAILED part naming the check already waits on you for it.
        else if (!o.failed.has(`release-check:${note.match(/^[^\s:]+/)?.[0] ?? ""}`)) o.waiting.push(`release check: ${one(note)}; read the run log`);
      }
    },
  },
  { re: /^GATEKEEPER pending: (.*)$/s, open: /^[^\s:]+: (?:\d+ unapproved|not checked)/, on: (m, o) => { for (const n of m[1]!.split("; ")) o.waiting.push(`Gatekeeper: ${one(n)}`); } },
  { re: /^(\S+) QUARANTINED — unreviewed install, not restarting \((.*)\)$/, on: (m, o) => void o.waiting.push(`${one(m[1]!)}: an unreviewed install is quarantined and not restarted; review it (${one(m[2]!)})`) },
  { re: /^(\S+) quarantined — not restarting \(see (.*)\)$/, on: (m, o) => void o.waiting.push(`${one(m[1]!)}: quarantined and not restarted; review it (${one(m[2]!)})`) },
  { re: /^(\S+) on hold\b.* — not restart(?:ing|ed)\b/, open: /^release: rm /, on: (m, o) => void o.held.push(one(m[0]!)) },
  { re: /^(\S+) stale — (.*)$/, on: (m, o) => (/FAILED|not handed off/.test(m[2]!) ? o.waiting : o.notes).push(`${one(m[1]!)}: still runs an old version; ${one(m[2]!)}`) },
  // src/apply/kegs.ts notes.
  { re: /^restarted onto new keg: (.*)$/, on: (m, o) => void o.notes.push(`restarted onto the new keg: ${words(m[1]!).map(one).join(", ")}`) },
  { re: /^STALE KEG: (.+) still running from a deleted keg$/, on: (m, o) => void o.waiting.push(`${one(m[1]!)}: still running from a deleted keg; restart it (see the run log)`) },
  { re: /^STALE KEG: (\S+) handed to (\S+) \((.*)\)$/, on: (m, o) => void o.notes.push(`${one(m[1]!)}: on a deleted keg, its restart handed to ${one(m[2]!)} (${one(m[3]!)})`) },
  { re: /^STALE KEG: (\S+) not handed to (.*)$/, on: (m, o) => void o.waiting.push(`${one(m[1]!)}: still on a deleted keg and not handed to ${one(m[2]!)}; restart it`) },
  { re: /^LINKAGE CHECK FAILED: /, on: (m, o) => void o.waiting.push(`${one(m.input!)}; read the run log`) },
  { re: /^STALE-KEG CHECK FAILED: /, on: (m, o) => void o.waiting.push(`${one(m.input!)}; read the run log`) },
  { re: /^owner restart (?:waiter )?FAILED\b/, on: (m, o) => void o.waiting.push(one(m.input!)) },
  { re: /^owner restart (?:waiter:|waiter started|waiter starts after|for the release check:)/, on: (m, o) => void o.notes.push(one(m.input!)) },
  { re: /^\S+ waiter: /, open: true, on: (m, o) => void (/FAILED/.test(m.input!) ? o.waiting : o.notes).push(one(m.input!)) },
  { re: /^(?:LINKAGE FAILED|UNLINKED KEG): /, open: /^fix: /, on: (m, o) => void o.waiting.push(one(m.input!)) },
  { re: /^outdated --fetch-HEAD FAILED\b/, on: (m, o) => void o.waiting.push(one(m.input!)) },
  { re: /^WARNING: /, on: (m, o) => void o.waiting.push(one(m.input!)) },
  { re: /^ERROR — (.*)$/, on: (m, o, lane) => void o.waiting.push(`${lane}: ${one(m[1]!)}; read the run log`) },
  { re: /^not completed(?: — still pending: (.*))?$/, lane: "npm", on: (m, o) => void o.waiting.push(`npm: the step did not finish${m[1] ? `; still pending: ${one(m[1])}` : ""}`) },
  // An app bundle: "<name> held: <why>", "<name> FAILED: <why>", "<name> <old> → <new> (<restart>)".
  // Its reason can carry "; " between release surface findings, each "<path>: <why>".
  { re: /^(\S+) held: (.*)$/, open: /^[^\s:;]+: /, on: (m, o) => void (o.apps.has(m[1]!) || o.held.push(`${one(m[1]!)}: ${one(m[2]!)}`)) },
  { re: /^(\S+) FAILED: (.*)$/, on: (m, o) => void o.waiting.push(`${one(m[1]!)}: ${one(m[2]!)}; read the run log`) },
  { re: /^(\S+) \S+ → (\S+) \(.*\)$/, lane: "brew", on: (m, o) => void o.updated.push(`${one(m[1]!)} ${one(m[2]!)}`) },
  {
    // Installed, then found off the reviewed version: the install already happened.
    re: /^FLAGGED — ([^\s,]+ installed [^\s,]+, reviewed [^\s,]+(?:, [^\s,]+ installed [^\s,]+, reviewed [^\s,]+)*)$/,
    lane: "npm",
    on: (m, o) => { for (const s of m[1]!.matchAll(/([^\s,]+) installed ([^\s,]+), reviewed ([^\s,]+)/g)) o.waiting.push(`${one(s[1]!)}: installed at ${one(s[2]!)}, but the review covered ${one(s[3]!)}; read the run log`); },
  },
  {
    re: /^(?:FLAGGED|STRUCTURAL FLAG)(?: — )?(.*)$/s,
    lane: "npm",
    open: true,
    on: (m, o) => {
      const why = one(m[1]!.replace(/^FLAG:\s*/, "")) || "the review held it (see the run log)";
      o.held.push(`npm (whole batch): ${why}`);
      o.waiting.push("npm: read the reason, then update the globals yourself or wait for a newer release");
    },
  },
];

// src/apply/run-release.ts and release-checks.ts notes, joined by ", " though a note can carry ", "
// itself: a piece starts a new note only when it reads as one and does not follow a "(held)".
const RC_START = /^\S+(?::| \S+ (?:PASS|FAIL|check |not checked)| (?:upgrade changed|not checked|not upgraded|upgraded unchecked|waits for|release check error))/;
const RC_BAD = /\bFAIL|failed|could not run|unreadable|\berror\b/;
function rcNotes(text: string): string[] {
  const pieces: string[] = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "(") depth++;
    else if (c === ")") depth = Math.max(0, depth - 1);
    else if (depth === 0 && c === "," && text[i + 1] === " ") {
      pieces.push(text.slice(from, i));
      from = i + 2;
    }
  }
  pieces.push(text.slice(from));
  const notes: string[] = [];
  for (const p of pieces) {
    const prev = notes.at(-1);
    if (prev !== undefined && (prev.endsWith("(held)") || !RC_START.test(p))) notes[notes.length - 1] = `${prev}, ${p}`;
    else notes.push(p);
  }
  return notes;
}

const UNRECOGNIZED: Part = { re: /^/, on: (m, o) => void o.waiting.push(`unrecognized: ${one(m.input!)}`) };
const partFor = (frag: string, lane: string) => PARTS.find((p) => (!p.lane || p.lane === lane) && p.re.test(frag));

const STUCK_ITEM = new RegExp(`([^\\s(\\]]+)${STUCK_SINCE} `, "g");
const STUCK_TAIL = new RegExp(`^(?:(.*?) )?\\[((?:[^\\s(\\]]+${STUCK_SINCE} )+)\\]$`);

/** One summary line's parts: split on the writers' "; ", joined back where a part carries "; " itself. */
function readLine(text: string, lane: string, o: Out) {
  const groups: { part: Part; text: string }[] = [];
  for (const raw of text.split("; ")) {
    let frag = raw.trim();
    // kegs.ts ends its note with " [<pkg>(N runs, since D) ... ]": the packages stale run after run.
    const st = frag.match(STUCK_TAIL);
    if (st) {
      for (const s of st[2]!.matchAll(STUCK_ITEM)) o.waiting.push(`${one(s[1]!)}: still on a deleted keg for ${s[2]} runs since ${one(s[3]!)}; restart it by hand`);
      frag = (st[1] ?? "").trim();
    }
    if (!frag) continue;
    const part = partFor(frag, lane);
    const prev = groups.at(-1);
    if (!part && prev?.part.open && (prev.part.open === true || prev.part.open.test(frag))) prev.text += `; ${frag}`;
    else groups.push({ part: part ?? UNRECOGNIZED, text: frag });
  }
  for (const g of groups) g.part.on(g.text.match(g.part.re)!, o, lane);
}

export function renderDigest(a: DigestInput): string {
  const lines = a.log.split("\n");
  const at = Math.max(lines.lastIndexOf(`=== ${a.host} summary ===`), lines.findIndex((l) => l.startsWith(`=== ${a.host} dry-run summary`)));
  const out: string[] = [`# ${a.host}: ${a.date}`, ""];
  if (at < 0) {
    out.push("The run did not reach its summary, so nothing here is certain. Open the run log.", "");
    return out.join("\n");
  }
  const dry = lines[at]!.includes("dry-run");
  const body = lines.slice(0, at);
  const o: Out = { up: {}, updated: [], held: [], unreadable: [], waiting: [], notes: [], apps: new Set(), failed: new Set() };
  const heldNames = new Set<string>();
  const run = readRunBlock(lines, at, { host: a.host, end: (l) => /^=== /.test(l) });

  if (run.aborted) o.waiting.push("the run was stopped and did not complete; read the run log");
  for (const { name: raw, kind } of run.typeB) {
    if (heldNames.has(raw)) continue;
    heldNames.add(raw);
    const n = one(raw);
    o.held.push(`${n}: ${reasonFor(body, raw)}`);
    // An app bundle is no formula: the summary's "<name> held" is this same hold.
    if (kind === "app bundle") {
      o.apps.add(raw);
      o.waiting.push(`${n}: review its release, then update the app by hand`);
      continue;
    }
    const cmd = kind === "HEAD" ? `brew upgrade --fetch-HEAD ${raw}` : `brew upgrade ${raw}`;
    o.waiting.push(SAFE_NAME.test(raw) ? `${n}: review it, then upgrade it yourself with \`${cmd}\`` : `${n}: review it, then ${BY_HAND}`);
  }
  for (const ex of run.excluded) o.held.push(`${one(ex)}: excluded in your config`);

  // Every lane line, a repeated one too: a hold is never hidden by a later line.
  for (const { lane, text } of run.lanes) readLine(text, lane, o);
  for (const n of new Set(o.unreadable)) if (!heldNames.has(n) && !heldNames.has(n.split("/").at(-1)!)) o.held.push(`${n}: held, the reviewer cannot read the formula; it needs a manual look`);
  // A line of the block that is no lane line (a hold text that broke across lines): shown, never dropped.
  for (const l of run.other) o.waiting.push(`unrecognized: ${one(l)}`);

  // A Type B flag or tap-approval item already says what the review held: no second, generic line.
  if (o.plainFlag && !heldNames.size && !o.flagExplained) o.waiting.push("brew: the review held something this run; read the notifications and the run log");
  for (const lane of ["npm", "brew"]) if (o.up[lane]?.length) o.updated.unshift(`${lane}: ${o.up[lane]!.join(", ")}`);
  const list = (title: string, items: string[], none: string) => out.push(`## ${title}`, ...(items.length ? items.map((i) => `- ${i}`) : [none]), "");
  if (dry) out.push("Dry run: nothing was applied.", "");
  list("Updated", dry ? [] : o.updated, "Nothing updated.");
  list("Held", o.held, "Nothing is held.");
  list("Waiting on you", o.waiting, "Nothing waits on you.");
  if (o.notes.length) list("Notes", o.notes, "");
  return out.join("\n");
}
