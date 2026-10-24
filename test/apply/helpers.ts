import type { Reviewer } from "../../src/review.ts";

/** A reviewer that answers from a script, one entry per call, then the fallback; an Error entry is a crash or an outage. */
export function scripted(answers: (string | Error)[], fallback?: string | Error) {
  const prompts: string[] = [];
  const queue = [...answers];
  const r: Reviewer = {
    name: "scripted",
    async review(p) {
      prompts.push(p);
      const a = queue.length ? queue.shift()! : fallback;
      if (a === undefined) throw new Error("no answer scripted");
      if (a instanceof Error) throw a;
      return a;
    },
  };
  return { r, prompts };
}

/** A synthetic patch block of `total` lines, header included. */
export function genFile(name: string, total: number): string {
  const out = [`=== ${name} (status: modified) ===`];
  for (let i = 1; i < total; i++) out.push(`+line ${i} of ${name}`);
  return out.join("\n");
}
