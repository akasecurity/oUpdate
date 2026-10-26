// A pins.env file as lines: comments and blanks kept byte for byte, KEY=value lines indexed.
// Only a value is ever replaced, and a new value must be one plain token, so a value read from a
// registry can never add a line, a shell expansion or a quote to a file a build script sources.

export type PinLine = { kind: "text"; text: string } | { kind: "pin"; key: string; value: string };

export interface PinsFile {
  lines: PinLine[];
  /** The file ended with a newline. */
  finalNewline: boolean;
}

const PIN = /^([A-Z][A-Z0-9_]*)=(.*)$/;

/** One token: letters, digits and . : + / = _ ~ @ - only (no whitespace, quote, $, backtick, ;, |, &, <, >, parentheses or backslash). */
export const SAFE_VALUE = /^[A-Za-z0-9.:+\/=_~@-]+$/;

export function parsePins(text: string): PinsFile {
  const finalNewline = text.endsWith("\n");
  const raw = (finalNewline ? text.slice(0, -1) : text).split("\n");
  const seen = new Set<string>();
  const lines = raw.map((l, i): PinLine => {
    if (l.trim() === "" || l.trimStart().startsWith("#")) return { kind: "text", text: l };
    const m = l.match(PIN);
    if (!m) throw new Error(`pins line ${i + 1} is not KEY=value`);
    const key = m[1]!;
    if (seen.has(key)) throw new Error(`pins line ${i + 1}: ${key} is set twice`);
    seen.add(key);
    return { kind: "pin", key, value: m[2]! };
  });
  return { lines, finalNewline };
}

export function pinValues(f: PinsFile): Map<string, string> {
  const out = new Map<string, string>();
  for (const l of f.lines) if (l.kind === "pin") out.set(l.key, l.value);
  return out;
}

export function renderPins(f: PinsFile): string {
  return f.lines.map((l) => (l.kind === "text" ? l.text : `${l.key}=${l.value}`)).join("\n") + (f.finalNewline ? "\n" : "");
}

/** A copy with the given keys' values replaced. Every key must exist and every value must be SAFE_VALUE. */
export function setPins(f: PinsFile, changes: Record<string, string>): PinsFile {
  const keys = new Set(f.lines.flatMap((l) => (l.kind === "pin" ? [l.key] : [])));
  for (const [k, v] of Object.entries(changes)) {
    if (!keys.has(k)) throw new Error(`pins has no ${k}`);
    if (!SAFE_VALUE.test(v)) throw new Error(`refusing value for ${k}: not one plain token`);
  }
  return {
    finalNewline: f.finalNewline,
    lines: f.lines.map((l): PinLine => (l.kind === "pin" && Object.hasOwn(changes, l.key) ? { kind: "pin", key: l.key, value: changes[l.key]! } : l)),
  };
}

/** One "-KEY=old" / "+KEY=new" pair per changed value, each under "@@ line N @@", in file order. */
export function pinsDiff(before: PinsFile, after: PinsFile): string {
  const out: string[] = [];
  before.lines.forEach((b, i) => {
    const a = after.lines[i];
    if (b.kind === "pin" && a?.kind === "pin" && a.key === b.key && a.value !== b.value) out.push(`@@ line ${i + 1} @@`, `-${b.key}=${b.value}`, `+${a.key}=${a.value}`);
  });
  return out.join("\n");
}
