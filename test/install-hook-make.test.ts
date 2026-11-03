import { describe, expect, test } from "bun:test";
import { prepass, type FileMap } from "../src/prepass.ts";

const enc = new TextEncoder();
const map = (f: Record<string, string>): FileMap => new Map(Object.entries(f).map(([k, v]) => [k, enc.encode(v)]));
const pj = (hook: string) => JSON.stringify({ name: "x", version: "1", scripts: { postinstall: hook } });

// A file make would read changes between the releases, and an unrelated file changes with it.
function details(hook: string, changed: string[] = ["sub/x.js"]): string[] {
  const base: Record<string, string> = { "package.json": pj(hook), "sub/x.js": "1", "Makefile": "1", "other/y.js": "1" };
  const n = { ...base };
  for (const c of changed) n[c] = "changed()";
  return prepass("npm", map(base), map(n)).hard.filter((s) => s.kind === "install-script").map((s) => s.detail);
}
const P = "make -C sub";

describe("make in a body that is not split into commands is still read", () => {
  const forms = [
    `${P} > build.log`,
    `${P} 2>&1`,
    `${P} >> build.log 2>&1`,
    `${P} &> build.log`,
    `${P} < /dev/null`,
    `echo hi > log; ${P}`,
    `echo a\\ b; ${P}`,
    `echo a(b); ${P}`,
    `(${P})`,
    `${P} | tee log`,
    `${P} &`,
    `V=1 ${P} > log`,
    `gmake -C sub > log`,
    `echo ok\n${P} > log\necho done`,
    `nice ${P} > log`,
    `nice -n 5 ${P} > log`,
    `env V=1 ${P} > log`,
    `command ${P} > log`,
    `exec ${P} > log`,
    `time ${P} > log`,
    `! ${P} > log`,
    `nohup ${P} > log`,
    `{ ${P}; } > log`,
    `if true; then ${P}; fi > log`,
    `for d in sub; do ${P} -j1; done > log`,
    `while true; do ${P}; break; done > log`,
    "${MAKE:-make} -C sub",
    "${MAKE} -C sub > log",
    `echo $(${P})`,
    `x=$(${P}) > log`,
  ];
  for (const f of forms) {
    test(JSON.stringify(f) + ": the payload is read, the twin and an unchanged package are quiet", () => {
      expect(details(f)).toContain("file sub/x.js");
      const twin = f.replace(/\$\{MAKE(?::-make)?\} -C sub|g?make -C sub/, "echo ok");
      expect(details(twin)).toEqual([]);
      expect(details(f, [])).toEqual([]);
    });
  }
  test("make with no -C reads every changed file", () => {
    expect(details("make > build.log", ["Makefile"])).toContain("file Makefile");
  });
  test("make inside quotes, a heredoc or a comment is not a command", () => {
    for (const f of ['echo "make -C sub" > log', "cat <<EOF > log\nmake -C sub\nEOF", "echo ok > log # make -C sub", "echo 'make' > log"]) expect(details(f), f).toEqual([]);
  });
});
