// A pinned requirements file (pip-compile output, or any requirements*.txt / *.lock.txt) -> registry packages.
// Only exact `name==version` pins are read, with extras, environment markers, comments and `--hash` options
// dropped and `\` continuations joined. Skipped: includes (-r, -c), editables, direct references
// (`name @ url`), ranges, wildcards and `===`. An --index-url (or -i) other than PyPI names every pin by that
// host, wherever the option sits in the file, as pip applies it to the whole file. The `--hash` values are
// sha256, which the download check does not verify (it checks sha512 only).

import { collector, pypiPrivateIndex } from "./pylock.ts";
import type { LockedPackage } from "./types.ts";

const PIN = /^([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)\s*(?:\[[^\]]*\])?\s*==\s*([^\s,;=*]+)$/;
const INDEX = /^(?:-i\s*|--index-url(?:\s+|\s*=\s*))(\S+)$/;

export function parseRequirements(text: string): LockedPackage[] {
  const lines = text
    .replace(/\\\r?\n/g, " ")
    .split(/\r?\n/)
    .map((l) => l.replace(/(^|\s)#.*$/, "").trim())
    .filter(Boolean);
  let index: string | undefined;
  const pins: [string, string][] = [];
  for (const line of lines) {
    if (line.startsWith("-")) {
      const m = INDEX.exec(line);
      if (m) index = m[1];
      continue; // other options, includes, editables
    }
    const spec = line.replace(/\s--hash[=\s]\S+/g, "").split(";")[0]!.trim();
    const m = PIN.exec(spec);
    if (m) pins.push([m[1]!, m[2]!]);
  }
  const registry = pypiPrivateIndex(index);
  const c = collector();
  for (const [name, version] of pins) c.add(name, version, registry);
  return c.out;
}
