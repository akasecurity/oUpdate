// Package names and versions come from a lockfile a PR can edit, so they are checked against the registries'
// grammars before they are reviewed and escaped wherever they are shown (the gate comment, the review prompt).

import type { Ecosystem } from "./prepass.ts";

/** npm: an optional lowercase-or-legacy-uppercase scope, then a name of URL-safe characters, at most 214 long. */
const NPM_NAME = /^(@[a-z0-9~][a-z0-9._~-]*\/)?[a-z0-9~][a-z0-9._~-]*$/i;
/** PEP 503 (normalized or not): letters and digits, with `.`, `_` and `-` between them. */
const PYPI_NAME = /^[a-z0-9]([a-z0-9._-]*[a-z0-9])?$/i;
/** Semver and PEP 440 both fit: starts with an alphanumeric, then alphanumerics and `. + ! _ ~ -`. */
const VERSION = /^[a-z0-9][a-z0-9.+!_~-]*$/i;

/** Why a name is not a package name of the ecosystem, or undefined when it is one. */
export function badName(eco: Ecosystem, name: string): string | undefined {
  const ok = eco === "npm" ? name.length <= 214 && NPM_NAME.test(name) : PYPI_NAME.test(name);
  return ok ? undefined : `package name ${shown(name)} is not a valid ${eco} name`;
}

/** Why a version is not a plain version string, or undefined when it is one. */
export function badVersion(version: string): string | undefined {
  return version.length <= 256 && VERSION.test(version) ? undefined : `version ${shown(version)} has characters no registry version has`;
}

/** Text from a lockfile as it may be printed: anything outside a plain identifier charset is written as \u{hex}, and long text is cut. */
export function shown(text: string | null | undefined): string {
  const t = text ?? "";
  const cut = t.length > 100 ? `${t.slice(0, 100)}...` : t;
  return [...cut].map((ch) => (/[a-z0-9._@/+~!: -]/i.test(ch) ? ch : `\\u{${ch.codePointAt(0)!.toString(16)}}`)).join("");
}

/**
 * Text from a package (a file path in a layer detail, say) as it may sit in a markdown comment. Written as \u{hex}
 * so it cannot open a link, an image, a code span, a comment or a tag, nor reorder or hide text: backticks,
 * brackets, angle brackets, backslash (so an escape written here cannot be mistaken for text from the package), controls (Cc),
 * format characters (Cf: bidi, zero-width, soft hyphen, tags), every default-ignorable code point (variation selectors,
 * Khmer inherent vowels, the Hangul fillers, unassigned hidden code points), line and paragraph separators, every
 * space but the ASCII one, the combining grapheme joiner and the braille blank; also lone surrogates (Cs), private use (Co)
 * and unassigned code points (Cn). The result is safe only inside a code span: `&` and `@` are not escaped. Other characters are kept, so a sentence stays readable.
 */
const INERT = /[`[\]<>\\\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Default_Ignorable_Code_Point}\p{Zl}\p{Zp}\p{Zs}\u{34F}\u{FE00}-\u{FE0F}\u{E0100}-\u{E01EF}\u{115F}\u{1160}\u{3164}\u{FFA0}\u{2800}]/gu;
export function inert(text: string): string {
  return text.replace(INERT, (ch) => (ch === " " ? ch : `\\u{${ch.codePointAt(0)!.toString(16)}}`));
}
