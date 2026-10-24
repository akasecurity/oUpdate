// Live collection on this host: read-only commands, no shell, each with its own
// timeout. Nothing is updated or installed (HOMEBREW_NO_AUTO_UPDATE=1).

import type { RawProbe } from "./report.ts";

export type Runner = (argv: string[], timeoutMs: number) => Promise<{ code: number; stdout: string }>;

export const spawnRunner: Runner = async (argv, timeoutMs) => {
  try {
    const p = Bun.spawn(argv, { stdout: "pipe", stderr: "ignore", env: { ...process.env, HOMEBREW_NO_AUTO_UPDATE: "1" }, timeout: timeoutMs });
    const stdout = await new Response(p.stdout).text();
    return { code: await p.exited, stdout };
  } catch {
    return { code: 127, stdout: "" }; // not installed
  }
};

export const CLIS = ["claude", "codex", "grok", "agy", "gcloud"];

export async function probeHost(run: Runner): Promise<RawProbe> {
  const out = async (argv: string[], ms = 120_000) => (await run(argv, ms)).stdout;
  const clis: string[] = [];
  for (const c of CLIS) clis.push(`${c}\t${(await out([c, "--version"], 20_000)).split("\n").slice(0, 3).join(" ")}`);
  return {
    swVers: await out(["sw_vers"]),
    brewInfo: await out(["brew", "info", "--json=v2", "--installed"]),
    brewOutdated: await out(["brew", "outdated", "--json=v2", "--greedy-auto-updates"]),
    npmLs: await out(["npm", "ls", "-g", "--json", "--depth=0"]),
    npmOutdated: await out(["npm", "outdated", "-g", "--json"]),
    docker: await out(["docker", "images", "--digests", "--format", "{{json .}}"]),
    softwareUpdate: await out(["softwareupdate", "-l"]),
    clis: clis.join("\n"),
  };
}
