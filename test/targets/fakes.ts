// Scripted Exec for the targets tests: each rule may answer a call; an unscripted call is rc 127.
import type { Exec, ExecResult } from "../../src/apply/exec.ts";
import type { TargetFs } from "../../src/targets/run.ts";

export interface Call {
  argv: string[];
  env?: Record<string, string>;
  stdin?: string;
  cwd?: string;
  timeoutMs?: number;
}
export type Rule = (argv: string[], call: Call) => Partial<ExecResult> | undefined;

export function fakeExec(rules: Rule[]): { exec: Exec; calls: Call[] } {
  const calls: Call[] = [];
  const exec: Exec = async (argv, opts = {}) => {
    const call: Call = { argv, env: opts.env, stdin: opts.stdin, cwd: opts.cwd, timeoutMs: opts.timeoutMs };
    calls.push(call);
    for (const r of rules) {
      const hit = r(argv, call);
      if (hit) return { rc: 0, out: "", err: "", ...hit };
    }
    return { rc: 127, out: "", err: `unscripted: ${argv.join(" ")}` };
  };
  return { exec, calls };
}

/** The git arguments of a `git -C <repo> ...` call. */
export const gitArgs = (c: Call): string[] => (c.argv[0] === "git" && c.argv[1] === "-C" ? c.argv.slice(3) : []);

/** Answers `git -C <any repo> <prefix...>`. */
export function gitRule(prefix: string[], res: Partial<ExecResult> | ((call: Call) => Partial<ExecResult>)): Rule {
  return (_argv, call) => {
    const a = gitArgs(call);
    if (!a.length || !prefix.every((p, i) => a[i] === p)) return undefined;
    return typeof res === "function" ? res(call) : res;
  };
}


/** An in-memory TargetFs. */
export function memFs(seed: Record<string, string> = {}): { fs: TargetFs; files: Map<string, string> } {
  const files = new Map(Object.entries(seed));
  const fs: TargetFs = {
    readFile: async (p) => files.get(p),
    readText: async (p) => {
      const text = files.get(p);
      return text === undefined ? { missing: true } : { text };
    },
    writeFile: async (p, t) => void files.set(p, t),
    appendFile: async (p, t) => void files.set(p, (files.get(p) ?? "") + t),
    remove: async (p) => void files.delete(p),
  };
  return { fs, files };
}

/** A broker client argv: action, target, --why, --wait and each --param / --param-json (JSON parsed); undefined on anything else. */
export function clientArgs(argv: string[]): { action: string; target: string; why: string; wait: number; params: Record<string, unknown> } | undefined {
  const [, action = "", target = "", ...rest] = argv;
  const params: Record<string, unknown> = {};
  let why = "";
  let wait = -1;
  for (let i = 0; i < rest.length; i += 2) {
    const flag = rest[i]!;
    const v = rest[i + 1] ?? "";
    const eq = v.indexOf("=");
    if (flag === "--why") why = v;
    else if (flag === "--wait") wait = Number(v);
    else if (flag === "--param" && eq > 0) params[v.slice(0, eq)] = v.slice(eq + 1);
    else if (flag === "--param-json" && eq > 0) params[v.slice(0, eq)] = JSON.parse(v.slice(eq + 1));
    else return undefined;
  }
  return { action, target, why, wait, params };
}
