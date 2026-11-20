// OUP-302 phase 1a: the pre-flight of a host run, REPORT ONLY. It reads the disk free on the brew prefix
// and probes the two hosts a run needs (npm registry, formulae.brew.sh); it says what it would refuse and
// refuses nothing. Only a dry run calls it (run.ts): a threshold that stops a real run is a new live-path
// gate, and needs numbers from these reports first (ATLAS-4626 thread, OUP-302).

import type { ApplyConfig } from "./config.ts";
import type { Exec } from "./exec.ts";

/** Each pre-flight command's own bound (not the run's 45-minute command limit): a hung df or a stalled probe must not hold a dry run. */
export const PREFLIGHT_TIMEOUT_MS = 15_000;

/** An experiment value, not a measured one: below it a dry run reports "would refuse". Nothing enforces it. */
export const PREFLIGHT_MIN_FREE_GIB = 10;

export interface PreflightResult {
  /** The report lines, one per read. */
  lines: string[];
  /** Why a run would be refused; empty when nothing would be. */
  wouldRefuse: string[];
}

/**
 * `exec` is the RAW exec, not the run's wrapper: the wrapper counts a soft timeout toward the two-in-a-row upgrade stop, which a dry
 * run never resets, so a slow probe would make the dry run skip Type B. Here a timeout is only a would-refuse reason.
 */
export async function preflight(cfg: ApplyConfig, exec: Exec): Promise<PreflightResult> {
  const x = async (argv: string[]) => {
    try {
      const r = await exec(argv, { timeoutMs: PREFLIGHT_TIMEOUT_MS, ...(argv[0] === cfg.brew ? { env: { HOMEBREW_NO_AUTO_UPDATE: "1" } } : {}) });
      return r.timedOut ? { ...r, rc: r.rc === 0 ? 124 : r.rc } : r;
    } catch (e) {
      return { rc: 1, out: "", err: e instanceof Error ? e.message : String(e) };
    }
  };
  const lines: string[] = [];
  const wouldRefuse: string[] = [];
  const pre = await x([cfg.brew, "--prefix"]);
  const prefix = pre.rc === 0 ? pre.out.trim() : "";
  if (!prefix.startsWith("/")) {
    lines.push(`preflight: disk not read (${cfg.brew} --prefix rc ${pre.rc})`);
    wouldRefuse.push(`disk not read (${cfg.brew} --prefix rc ${pre.rc})`);
  } else {
    const df = await x(["df", "-k", "--", prefix]);
    const kb = Number(df.out.trim().split("\n").at(-1)!.trim().split(/\s+/)[3]);
    if (df.rc !== 0 || !Number.isFinite(kb)) {
      lines.push(`preflight: disk not read (df -k -- ${prefix} rc ${df.rc})`);
      wouldRefuse.push(`disk not read (df -k -- ${prefix} rc ${df.rc})`);
    } else {
      const gib = kb / 1048576;
      lines.push(`preflight: disk ${gib.toFixed(1)} GiB free on ${prefix}`);
      if (gib < PREFLIGHT_MIN_FREE_GIB) wouldRefuse.push(`disk ${gib.toFixed(1)} GiB free on ${prefix}, under ${PREFLIGHT_MIN_FREE_GIB} GiB`);
    }
  }
  for (const raw of [cfg.npmRegistry, "https://formulae.brew.sh"]) {
    // Only an http(s) URL without credentials, a query or a fragment is probed (a token in a query would sit on curl's argv), and only its origin is printed.
    let u: URL | undefined;
    try {
      u = new URL(raw);
    } catch {
      u = undefined;
    }
    if (!u || !/^https?:$/.test(u.protocol) || u.username || u.password || u.search || u.hash || /[[\]{}]/.test(u.pathname)) {
      const why = !u || !/^https?:$/.test(u.protocol) ? "not an http(s) URL" : u.username || u.password ? "it carries credentials" : "it carries a query, a fragment or a glob";
      lines.push(`preflight: registry URL not probed (${why})`);
      wouldRefuse.push(`registry URL not probed (${why})`);
      continue;
    }
    // -q: no ~/.curlrc; -g: no URL globbing; --: the URL is never an option; the parsed href, not the raw string, is what is probed.
    const c = await x(["curl", "-q", "-g", "-sS", "-o", "/dev/null", "-I", "-m", "10", "-w", "%{http_code}", "--", u.href]);
    const code = c.out.trim();
    if (c.rc === 0 && /^[23]\d\d$/.test(code)) lines.push(`preflight: ${u.origin} answered (http ${code})`);
    else {
      const why = `rc ${c.rc}${c.rc === 6 ? ", DNS" : ""}${code && code !== "000" ? `, http ${code}` : ""}`;
      lines.push(`preflight: ${u.origin} not reached (${why})`);
      wouldRefuse.push(`${u.origin} not reached (${why})`);
    }
  }
  return { lines, wouldRefuse };
}
