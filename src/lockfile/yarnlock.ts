// yarn.lock -> registry packages. Two formats, told apart by the `__metadata` block only berry (yarn 2+) writes:
//   v1:    "# yarn lockfile v1", entries `"a@^1", a@^1.2:` with `version "x"`, `resolved "url#sha1"`, `integrity sri`
//   berry: YAML, entries `"a@npm:^1, a@npm:^1.2":` with `version`, `resolution: "a@npm:1.2.3"`, `checksum`
// An `npm:` alias names the real package, so the name comes from the spec (v1) or the resolution (berry), never the
// alias. A resolved URL that is not the registry's own tarball for name@version is a url dependency, as in
// package-lock.json. A berry checksum is a hash of yarn's own archive, not of the registry tarball, so it is kept as
// the digest (a swap changes it) and never as an integrity the download is checked against. Berry `workspace:` entries
// are the project's own packages, and `patch:` entries re-apply a patch file from the repo onto an `npm:` entry that
// is listed (and read) on its own; both are listed by resolution so a swap shows. An `npm:` resolution must match its
// version, and its `::` locator parameters (such as `__archiveUrl`) are kept as the source. Anything unreadable, a
// duplicate key or field, a non-string checksum or odd v1 indentation throws, holding the PR.

import { sriHashes } from "../targets/pins/npm.ts";
import {
  directKind,
  npmCanonicalTarball,
  npmPrivateRegistry,
  type LockedPackage,
} from "./types.ts";

const unquote = (s: string) => {
  if (!/^".*"$/.test(s)) return s;
  try {
    return JSON.parse(s) as string;
  } catch {
    throw new Error(
      `cannot read yarn.lock value ${JSON.stringify(s.slice(0, 100))}`,
    );
  }
};

/** The package name of a descriptor `name@range`; an `npm:real@range` range names the real package. */
function descriptorName(desc: string): string {
  const cut = desc.indexOf("@", 1);
  if (cut <= 0)
    throw new Error(
      `cannot read yarn.lock descriptor ${JSON.stringify(desc.slice(0, 100))}`,
    );
  const range = desc.slice(cut + 1);
  const alias = /^npm:((?:@[^/@]+\/)?[^@]+)@/.exec(range);
  return alias ? alias[1]! : desc.slice(0, cut);
}

const RE_NON_REGISTRY =
  /^(git\+|git:|github:|gitlab:|bitbucket:|ssh:|https?:|file:|link:|portal:|exec:|\.{0,2}\/|[\w.-]+\/[\w.-]+(#|$))/;

/** The range of a v1 entry that names no registry package (git, URL, file, user\/repo), else undefined. */
const v1Direct = (range: string) =>
  !range.startsWith("npm:") && RE_NON_REGISTRY.test(range) ? range : undefined;

interface V1Entry {
  descs: string[];
  fields: Map<string, string>;
}

/** v1 is not YAML: `key value` lines (value optionally quoted) two spaces in, nested maps four spaces in (skipped). */
function readV1(text: string): V1Entry[] {
  const out: V1Entry[] = [];
  const seenDescs = new Set<string>();
  let cur: V1Entry | undefined;
  let inBlock = false;
  for (const [i, raw] of text.split("\n").entries()) {
    const line = raw.replace(/\r$/, "");
    if (!line.trim() || line.startsWith("#")) continue;
    if (!line.startsWith(" ")) {
      if (!line.endsWith(":"))
        throw new Error(`cannot read yarn.lock line ${i + 1}`);
      const descs = (line.slice(0, -1).match(/"[^"]*"|[^,\s][^,]*/g) ?? []).map(
        (d) => unquote(d.trim()),
      );
      if (!descs.length) throw new Error(`cannot read yarn.lock line ${i + 1}`);
      if (new Set(descs.map(descriptorName)).size > 1)
        throw new Error(
          `yarn.lock line ${i + 1}: one entry names two packages`,
        );
      for (const d of descs) {
        if (seenDescs.has(d))
          throw new Error(`duplicate yarn.lock entry ${d} at line ${i + 1}`);
        seenDescs.add(d);
      }
      cur = { descs, fields: new Map() };
      out.push(cur);
      inBlock = false;
    } else if (/^ {2}\S/.test(line)) {
      if (!cur) throw new Error(`cannot read yarn.lock line ${i + 1}`);
      const m = /^ {2}("[^"]*"|[^\s"]+)\s*(.*)$/.exec(line);
      if (!m) throw new Error(`cannot read yarn.lock line ${i + 1}`);
      const key = unquote(m[1]!);
      if (cur.fields.has(key))
        throw new Error(`duplicate yarn.lock field ${key} at line ${i + 1}`);
      cur.fields.set(key, unquote(m[2]!));
      // A nested map (`dependencies:`) has no value; only it may have deeper lines under it.
      inBlock = !m[2];
    } else if (!inBlock || !/^( {2})+\S/.test(line)) {
      throw new Error(`cannot read yarn.lock indentation at line ${i + 1}`);
    }
  }
  return out;
}

function parseV1(text: string): LockedPackage[] {
  const out: LockedPackage[] = [];
  const seen = new Set<string>();
  for (const { descs, fields } of readV1(text)) {
    const name = descriptorName(descs[0]!);
    const range = descs[0]!.slice(descs[0]!.indexOf("@", 1) + 1);
    const version = fields.get("version");
    if (!version)
      throw new Error(`cannot read yarn.lock entry ${name}: no version`);
    const resolved = fields.get("resolved");
    const integrity = fields.get("integrity");
    const direct = v1Direct(range);
    let p: LockedPackage;
    if (direct || (resolved && !/^https?:\/\//.test(resolved))) {
      const source = resolved ?? direct!;
      p = {
        name,
        version: source,
        source,
        direct: /^git\+|^github:|^gitlab:|^bitbucket:|^ssh:|\.git(#|$)/.test(
          source,
        )
          ? "git"
          : directKind(source),
      };
      if (integrity) p.digest = integrity;
    } else {
      p = { name, version };
      const [url, frag] = (resolved ?? "").split("#") as [
        string,
        string | undefined,
      ];
      if (resolved) {
        if (!npmCanonicalTarball(url, name, version)) p.direct = "url";
        else {
          const reg = npmPrivateRegistry(url);
          if (reg) p.registry = reg;
        }
        p.source = url;
      }
      if (integrity) {
        try {
          p.integrity = sriHashes(integrity)
            .map((h) => h.sri)
            .join(" ");
        } catch (err) {
          throw new Error(
            `cannot read ${name}@${version}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        p.digest = integrity;
      } else if (frag && /^[0-9a-f]{40}$/.test(frag)) {
        // An older lockfile pins the tarball by the sha1 after the URL's #; the download is checked against it.
        p.integrity = `sha1-${Buffer.from(frag, "hex").toString("base64")}`;
        p.digest = p.integrity;
      } else p.unhashed = true;
    }
    const k = `${p.name}@${p.version} ${p.source ?? ""} ${p.digest ?? ""}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(p);
  }
  return out;
}

interface BerryEntry {
  version?: unknown;
  resolution?: unknown;
  checksum?: unknown;
}

/** `name@protocol:ref` of a berry resolution: the name (scope-aware), the protocol and the rest. */
function splitResolution(res: string): {
  name: string;
  protocol: string;
  ref: string;
} {
  const cut = res.indexOf("@", 1);
  if (cut <= 0)
    throw new Error(
      `cannot read yarn.lock resolution ${JSON.stringify(res.slice(0, 100))}`,
    );
  const rest = res.slice(cut + 1);
  const m = /^([a-z][a-z0-9+.-]*):(.*)$/.exec(rest);
  return {
    name: res.slice(0, cut),
    protocol: m ? m[1]! : "",
    ref: m ? m[2]! : rest,
  };
}

/** Bun.YAML keeps the last of a duplicate key, hiding the earlier one: refuse a repeated entry or field, in any spelling. */
function rejectBerryDuplicates(text: string) {
  const entries = new Set<string>();
  let fields = new Set<string>();
  for (const [i, raw] of text.split("\n").entries()) {
    const line = raw.replace(/\r$/, "");
    if (!line.trim() || line.startsWith("#")) continue;
    if (!line.startsWith(" ")) {
      if (!line.endsWith(":"))
        throw new Error(`cannot read yarn.lock line ${i + 1}`);
      const key = unquote(line.slice(0, -1));
      if (entries.has(key))
        throw new Error(`duplicate yarn.lock entry at line ${i + 1}`);
      entries.add(key);
      fields = new Set();
    } else {
      const m = /^ {2}("[^"]*"|[^\s":]+):/.exec(line);
      if (m) {
        const key = unquote(m[1]!);
        if (fields.has(key))
          throw new Error(`duplicate yarn.lock field ${key} at line ${i + 1}`);
        fields.add(key);
      } else if (/^ {2}\S/.test(line)) {
        throw new Error(`cannot read yarn.lock line ${i + 1}`);
      }
    }
  }
}

function parseBerry(text: string): LockedPackage[] {
  rejectBerryDuplicates(text);
  const lock = Bun.YAML.parse(text) as Record<string, unknown>;
  const out: LockedPackage[] = [];
  const seen = new Set<string>();
  for (const [key, raw] of Object.entries(lock)) {
    if (key === "__metadata") continue;
    if (!raw || typeof raw !== "object")
      throw new Error(
        `cannot read yarn.lock entry ${JSON.stringify(key.slice(0, 100))}`,
      );
    const e = raw as BerryEntry;
    if (typeof e.resolution !== "string")
      throw new Error(
        `cannot read yarn.lock entry ${JSON.stringify(key.slice(0, 100))}: no resolution`,
      );
    const { name, protocol, ref } = splitResolution(e.resolution);
    if (e.checksum !== undefined && typeof e.checksum !== "string")
      throw new Error(`cannot read yarn.lock entry ${name}: checksum`);
    const checksum = e.checksum;
    let p: LockedPackage;
    if (protocol === "workspace" || protocol === "patch") {
      // Listed so a swap to or from one shows as a change; a file source, so it is held for a look, never read as a registry version.
      p = { name, version: e.resolution.slice(name.length + 1) };
      p.source = p.version;
      p.direct = "file";
      if (checksum) p.digest = checksum;
    } else if (protocol === "npm") {
      if (typeof e.version !== "string")
        throw new Error(`cannot read yarn.lock entry ${name}: no version`);
      const [locVersion, ...params] = ref.split("::");
      if (locVersion !== e.version)
        throw new Error(
          `yarn.lock entry ${name}: version ${e.version} does not match its resolution ${locVersion}`,
        );
      p = { name, version: e.version };
      // An archive override points the download elsewhere than the registry: reviewed as a url source, new or bumped too.
      if (params.length) {
        p.source = params.join("::");
        p.direct = "url";
      }
      if (checksum) p.digest = checksum;
      else p.unhashed = true;
    } else {
      // git (a `#commit=` or a repo URL), a tarball URL, and file, link, portal and exec sources: no registry review reads them.
      const source = protocol ? `${protocol}:${ref}` : ref;
      const isGit =
        /^(git\+|git:|github:|gitlab:|bitbucket:|ssh:)/.test(source) ||
        /\.git(#|$)/.test(source) ||
        /#commit=/.test(source);
      p = {
        name,
        version: source,
        source,
        direct: isGit ? "git" : directKind(source),
      };
      if (checksum) p.digest = checksum;
    }
    const k = `${p.name}@${p.version} ${p.source ?? ""} ${p.digest ?? ""}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(p);
  }
  return out;
}

const isBerry = (text: string) => /^__metadata:/m.test(text);

export function parseYarnLock(text: string): LockedPackage[] {
  if (isBerry(text)) return parseBerry(text);
  if (!/^# yarn lockfile v1/m.test(text))
    throw new Error(
      "yarn.lock is neither a v1 lockfile (no `# yarn lockfile v1` header) nor a berry one (no `__metadata`)",
    );
  return parseV1(text);
}

/** Berry's `workspace:` entries are the project's own packages: their folders (v1 does not record workspaces). */
export function yarnMembers(text: string): string[] {
  if (!isBerry(text)) return [];
  const lock = Bun.YAML.parse(text) as Record<string, { resolution?: unknown }>;
  const out: string[] = [];
  for (const [key, e] of Object.entries(lock)) {
    if (key === "__metadata" || typeof e?.resolution !== "string") continue;
    const { protocol, ref } = splitResolution(e.resolution);
    if (protocol === "workspace" && ref !== ".") out.push(ref);
  }
  return out;
}
