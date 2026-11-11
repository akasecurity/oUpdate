import { expect, test } from "bun:test";
import { prepass, type FileMap } from "../src/prepass.ts";

const enc = (s: string) => new TextEncoder().encode(s);
const files = (o: Record<string, string>): FileMap => new Map(Object.entries(o).map(([k, v]) => [k, enc(v)]));
const holds = (old: FileMap, now: FileMap) => prepass("npm", old, now).hard.filter((s) => s.kind === "install-script").map((s) => s.detail);

// A hook line the shell reader cannot split (a pipe, a redirect, a subshell) that also holds an expansion it cannot resolve
// runs a file the text does not name. Only one file of the package changes between the two releases.
const release = (v: string, hook: string, changed: "lib/evil.js" | "docs/evil.js" | "none") =>
  files({
    "package.json": JSON.stringify({ name: "p", version: v, scripts: { postinstall: hook } }),
    "lib/evil.js": changed === "lib/evil.js" ? `console.log("evil ${v}")\n` : "console.log('evil')\n",
    "docs/evil.js": changed === "docs/evil.js" ? `console.log("evil ${v}")\n` : "console.log('evil')\n",
    "lib/ok.js": "console.log('ok')\n",
    "name.txt": "lib/evil.js\n",
  });

const unresolved: [string, string][] = [
  ["a printf-built file name before a pipe", 'node $(printf "%s" "lib/evil.js") | cat'],
  ["a substituted file name before a pipe into tee", "node $(cat name.txt) | tee out"],
  ["a substituted script for sh before a pipe", "sh $(cat name.txt) | grep x"],
  ["a backtick file name before a pipe", "node `cat name.txt` | cat"],
  ["a substituted file name at the end of a pipe", "echo ok | node $(cat name.txt)"],
  ["a substituted file name with a redirect", "node $(cat name.txt) 2>&1 | cat"],
  ["a substituted file name in a subshell", "(node $(cat name.txt)) | cat"],
  ["a substituted file name in the middle of a long pipe", "node $(cat name.txt) | cat | wc"],
  ["an unresolved command word before a pipe", "$(echo node) lib/evil.js | cat"],
];

for (const [label, hook] of unresolved) {
  for (const changed of ["lib/evil.js", "docs/evil.js"] as const) {
    test(`${label} reads every file: a changed ${changed} holds`, () => {
      expect(holds(release("1.0.0", hook, "none"), release("1.0.1", hook, changed)).length).toBeGreaterThan(0);
    });
  }
}

const controls: [string, string][] = [
  ["an echo of a substitution into a pipe", "echo $(date) | cat"],
  ["a literal node file into a pipe, the other file changed", "node lib/ok.js | cat"],
  ["a plain pipe of readers", "true | cat"],
  ["an echo of a substitution", "echo $(date)"],
  ["a printf of a substitution into a reader", 'printf "%s" $(date) | grep x'],
];

for (const [label, hook] of controls) {
  test(`${label} stays quiet when an unrelated file changes`, () => {
    expect(holds(release("1.0.0", hook, "none"), release("1.0.1", hook, "lib/evil.js"))).toEqual([]);
  });
}
