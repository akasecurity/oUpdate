// A pinned requirements file (pip-compile output, or any requirements*.txt / *.lock.txt) -> registry packages.
// Exact `name==version` pins are read, with extras, environment markers, comments and `--hash` options dropped and
// `\` continuations joined. Direct references (`name @ url`) and editables (-e) are read as direct dependencies with
// that source. Any other line throws, so the gate holds rather than drop it: includes (-r, -c), ranges, wildcards,
// `===`, bare URLs and paths, and options it does not know. An --index-url (or -i) other than PyPI names every pin
// by that host, wherever the option sits in the file, as pip applies it to the whole file; an --extra-index-url or
// --find-links (-f) does the same, since pip may take any pin from there, and is part of each pin's source. The
// `--hash` values are sha256, which the download check does not verify (it checks sha512 only).

import { collector, digestOf, pypiPrivateIndex } from "./pylock.ts";
import { directKind, type LockedPackage } from "./types.ts";

const PIN = /^([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)\s*(?:\[[^\]]*\])?\s*==\s*([^\s,;=*]+)$/;
const INDEX = /^(?:-i\s*|--index-url(?:\s+|\s*=\s*))(\S+)$/;
const EDITABLE = /^(?:-e\s*|--editable(?:\s+|\s*=\s*))(\S+)$/;
const DIRECT = /^([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)\s*(?:\[[^\]]*\])?\s*@\s*(\S+)/;
/** Other places pip may fetch any pin from. */
const EXTRA = /^(?:--extra-index-url|-f|--find-links)(?:\s+|\s*=\s*|(?<=-f))(\S+)$/;
/** Options that change neither what is installed nor where from. */
const HARMLESS = /^(?:--require-hashes|--prefer-binary|--pre|--(?:only|no)-binary(?:\s+|\s*=\s*)\S+|--trusted-host(?:\s+|\s*=\s*)\S+)$/;

const unsupported = (line: string) => new Error(`unsupported requirements line \`${line.slice(0, 120)}\`: oupdate reads only name==version pins, name @ url and -e lines`);

export function parseRequirements(text: string): LockedPackage[] {
  const lines = text
    .replace(/\\\r?\n/g, " ")
    .split(/\r?\n/)
    .map((l) => l.replace(/(^|\s)#.*$/, "").trim())
    .filter(Boolean);
  let index: string | undefined;
  const extras: string[] = [];
  const pins: [string, string, string | undefined][] = [];
  const directs: [string | undefined, string][] = [];
  for (const line of lines) {
    if (line.startsWith("-")) {
      const m = INDEX.exec(line);
      const x = EXTRA.exec(line);
      const e = EDITABLE.exec(line);
      if (m) index = m[1];
      else if (x) extras.push(x[1]!);
      else if (e) directs.push([/#egg=([^&\s]+)/.exec(e[1]!)?.[1], e[1]!]);
      else if (!HARMLESS.test(line)) throw unsupported(line);
      continue;
    }
    const d = DIRECT.exec(line.split(";")[0]!.trim());
    if (d) {
      directs.push([d[1], d[2]!]);
      continue;
    }
    const hashes = [...line.matchAll(/\s--hash[=\s](\S+)/g)].map((h) => h[1]);
    const spec = line.replace(/\s--hash[=\s]\S+/g, "").split(";")[0]!.trim();
    const m = PIN.exec(spec);
    if (!m) throw unsupported(line);
    pins.push([m[1]!, m[2]!, digestOf(hashes)]);
  }
  // Each extra location pip may take a pin from is private unless it is PyPI itself; the main index's host wins.
  const registry = pypiPrivateIndex(index) ?? extras.map(pypiPrivateIndex).find(Boolean);
  const source = [index, ...extras.sort()].filter(Boolean).join(" ") || undefined;
  const c = collector();
  for (const [name, version, digest] of pins) c.add(name, version, registry, { source, digest });
  for (const [name, source] of directs) c.direct(name, undefined, directKind(source), source);
  return c.out;
}
