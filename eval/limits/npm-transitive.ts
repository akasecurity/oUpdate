// Per-release measure of the npm-globals limit: how many global npm entries are transitive
// (not installed by name) and how many of them carry an install hook that the review never reads.
// Input is `npm ls -g --all --long --json` on stdin; output is one JSON object.
import { existsSync } from "node:fs";
import { join } from "node:path";

// `npm ls --long --json` reports a hook two ways: a global tree (no lockfile) carries `scripts`; a lockfile-backed
// tree carries `hasInstallScript` (preinstall, install, postinstall and implicit gyp) and no `scripts`.
// An entry with binding.gyp and no install script gets an implicit `node-gyp rebuild` at install time.
const HOOKS = ["preinstall", "install", "postinstall"] as const;
const isHooked = (d: any, hasGyp: (dir: string) => boolean) =>
  !!d.hasInstallScript || HOOKS.some((h) => d.scripts?.[h]) || (!!d.path && hasGyp(d.path));
const gypOnDisk = (dir: string) => existsSync(join(dir, "binding.gyp"));

export type Measure = { direct: number; transitive: number; unique: number; withHook: { direct: string[]; transitive: string[] } };

export function measure(tree: any, hasGyp: (dir: string) => boolean = gypOnDisk): Measure {
  const seen = new Set<string>();
  const hooked = { direct: new Set<string>(), transitive: new Set<string>() };
  let direct = 0;
  const walk = (deps: any, isDirect: boolean) => {
    for (const [name, d] of Object.entries<any>(deps ?? {})) {
      if (!d?.version) continue; // listed but not installed (optional dependency for another platform)
      const id = `${name}@${d.version}`;
      if (isDirect) direct++;
      seen.add(id);
      if (isHooked(d, hasGyp)) hooked[isDirect ? "direct" : "transitive"].add(id);
      walk(d.dependencies, false);
    }
  };
  walk(tree?.dependencies, true);
  return { direct, transitive: seen.size - direct, unique: seen.size, withHook: { direct: [...hooked.direct].sort(), transitive: [...hooked.transitive].sort() } };
}

if (import.meta.main) console.log(JSON.stringify(measure(JSON.parse(await Bun.stdin.text())), null, 2));
