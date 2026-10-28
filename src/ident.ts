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
 * Text from a package (a file path in a layer detail, say) as it may sit in a markdown comment: backticks, brackets,
 * angle brackets and control characters are written as \u{hex}, so it cannot open a link, an image, a code span, a
 * comment or a tag. Other characters are kept, so a sentence stays readable.
 */
export function inert(text: string): string {
  return text.replace(/[`[\]<>\u0000-\u001f\u007f]/g, (ch) => `\\u{${ch.codePointAt(0)!.toString(16)}}`);
}
