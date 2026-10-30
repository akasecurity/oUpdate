// Per-release measure of the npm-globals limit: how many global npm entries are transitive
// (not installed by name) and how many of them carry an install hook that the review never reads.
// Input is `npm ls -g --all --long --json` on stdin; output is one JSON object.
const HOOKS = ["preinstall", "install", "postinstall"] as const;

export type Measure = { direct: number; transitive: number; unique: number; withHook: { direct: string[]; transitive: string[] } };

export function measure(tree: any): Measure {
  const seen = new Set<string>();
  const hooked = { direct: new Set<string>(), transitive: new Set<string>() };
  let direct = 0;
  const walk = (deps: any, isDirect: boolean) => {
    for (const [name, d] of Object.entries<any>(deps ?? {})) {
      const id = `${name}@${d.version ?? ""}`;
      if (isDirect) direct++;
      seen.add(id);
      if (HOOKS.some((h) => d.scripts?.[h])) hooked[isDirect ? "direct" : "transitive"].add(id);
      walk(d.dependencies, false);
    }
  };
  walk(tree?.dependencies, true);
  return { direct, transitive: seen.size - direct, unique: seen.size, withHook: { direct: [...hooked.direct].sort(), transitive: [...hooked.transitive].sort() } };
}

if (import.meta.main) console.log(JSON.stringify(measure(JSON.parse(await Bun.stdin.text())), null, 2));
