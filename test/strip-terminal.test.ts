import { expect, test } from "bun:test";
import { stripTerminal } from "../src/review.ts";

const cp = (...n: number[]) => String.fromCodePoint(...n);
const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);

// Characters that print as nothing or move the cursor, so model text echoing package bytes can hide or fake a line.
const DROPPED: [string, number[]][] = [
  ["C0 controls and DEL", [...range(0, 0x1f), 0x7f]],
  ["C1 controls", range(0x80, 0x9f)],
  ["soft hyphen", [0xad]],
  ["combining grapheme joiner", [0x34f]],
  ["arabic letter mark", [0x61c]],
  ["hangul fillers", [0x115f, 0x1160, 0x3164, 0xffa0]],
  ["khmer inherent vowels", [0x17b4, 0x17b5]],
  ["mongolian free variation selectors and vowel separator", range(0x180b, 0x180f)],
  ["zero-width, joiners and direction marks", range(0x200b, 0x200f)],
  ["line and paragraph separators", [0x2028, 0x2029]],
  ["bidi embeddings and overrides", range(0x202a, 0x202e)],
  ["invisible operators, the unassigned slot and bidi isolates", range(0x2060, 0x2069)],
  ["deprecated format characters", range(0x206a, 0x206f)],
  ["braille blank", [0x2800]],
  ["variation selectors", range(0xfe00, 0xfe0f)],
  ["byte order mark", [0xfeff]],
  ["interlinear annotation", range(0xfff9, 0xfffb)],
  ["tag characters", range(0xe0000, 0xe007f)],
  ["variation selectors supplement", range(0xe0100, 0xe01ef)],
  // Named by no list: the class is built from Unicode properties (Cf, Default_Ignorable_Code_Point).
  ["musical symbol format controls", range(0x1d173, 0x1d17a)],
  ["shorthand format controls", range(0x1bca0, 0x1bca3)],
  ["egyptian hieroglyph format controls", range(0x13430, 0x1343f)],
  ["unassigned default-ignorable specials", range(0xfff0, 0xfff8)],
  ["unassigned default-ignorable tag-plane points", range(0xe0080, 0xe0fff)],
];

for (const [label, points] of DROPPED)
  test(`stripTerminal drops ${label}`, () => {
    const left = points.filter((n) => stripTerminal(`a${cp(n)}b`) !== "ab");
    expect(left.map((n) => n.toString(16))).toEqual([]);
  });

test("stripTerminal keeps printable text, including non-ASCII letters, emoji and combining marks", () => {
  for (const s of ["plain text: FLAG (x)", "naïve café", "日本語", "😀", " nbsp", "á"]) expect(stripTerminal(s)).toBe(s);
});
