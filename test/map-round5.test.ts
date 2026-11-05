import { test, expect } from "bun:test";
import { reviewUpdate } from "../src/review.ts";
import type { FileMap } from "../src/prepass.ts";
const enc = (s: string) => new TextEncoder().encode(s);
const files = (o: Record<string, string>): FileMap => new Map(Object.entries(o).map(([k, v]) => [k, enc(v)]));
const SPAWN = "require('child_process').exec(process.env.Q)";
const map = (seed: string, big: boolean, sources: string[], sc: (string | null)[]) => JSON.stringify({ version: 3, file: "index.js", sources, names: [], sourcesContent: sc, mappings: ("AAAA" + seed + "CAAO,aAAP,OAAO,uBAAP;").repeat(big ? 250_000 : 20) });
const LDk = (k: number) => "const m = JSON.parse(require('fs').readFileSync(__filename + '.m' + String('ap'), 'utf8'));\nrequire('vm').runInThisContext(m['sources'+'Content'][" + k + "]);\nexports.v = 2;\n";
// B1: a .js file with the bare ".map" suffix loader (the code-file path), B2 and B3: extensionless bins, B4: an extensionless package "main". None quotes the script stem.
const BIN2 = "#!/usr/bin/env node\nconst fs = require('fs');\nconst f = fs.readdirSync(__dirname + '/../lib').find((x) => x.endsWith('.map'));\nconst m = JSON.parse(fs.readFileSync(__dirname + '/../lib/' + f, 'utf8'));\nrequire('vm').runInThisContext(m['sources'+'Content'][0]);\n";
// B3: the same loader without a shebang; the file is an extensionless "bin" entry of package.json, which parseCode also treats as code.
const BIN3 = BIN2.replace("#!/usr/bin/env node\n", "");
const JSLOAD = "const fs = require('fs');\nconst f = fs.readdirSync(__dirname).find((x) => x.endsWith('.map'));\nconst m = JSON.parse(fs.readFileSync(__dirname + '/' + f, 'utf8'));\nrequire('vm').runInThisContext(m['sources'+'Content'][0]);\nexports.v = 2;\n";
// [label, loader code, old sources, old contents, new sources, new contents, extra files, hidden allowed on a padded map]
const cases: [string, string, string[], (string | null)[], string[], (string | null)[], Record<string, string>, boolean][] = [
  ["S1 swap [clean,P]->[P,clean] reads 0", LDk(0), ["a", "a"], ["ok", SPAWN], ["a", "a"], [SPAWN, "ok"], {}, false],
  ["S2 [clean,P]->[P,ok2] reads 0", LDk(0), ["a", "a"], ["ok", SPAWN], ["a", "a"], [SPAWN, "ok2"], {}, false],
  ["S3 shift [a,a]->[a,a,a] reads 2", LDk(2), ["a", "a"], ["ok", SPAWN], ["a", "a", "a"], ["ok", "ok", SPAWN], {}, false],
  ["S4 rename [a,a]->[b,a] reads 0", LDk(0), ["a", "a"], ["ok", SPAWN], ["b", "a"], [SPAWN, "ok"], {}, false],
  ["S5 reorder [x,a]->[a,x] reads 0", LDk(0), ["x", "a"], ["ok", SPAWN], ["a", "x"], [SPAWN, "ok"], {}, false],
  ["P2 same index, same text [ok,P]->[ok2,P] reads 1 (text already shipped: hidden is fine)", LDk(1), ["a", "b"], ["ok", SPAWN], ["a", "b"], ["ok2", SPAWN], {}, true],
  ["X2 extra entry past sources", LDk(1), ["a"], ["ok"], ["a"], ["ok", SPAWN], {}, false],
  ["B1 a .js file finds the map by a bare .map suffix", "exports.v = 2;\n", ["a"], ["ok"], ["a"], ["var marker_qq = 42;"], { "lib/loader.js": JSLOAD }, false],
  ["B2 extensionless node-shebang bin finds the map by a bare .map suffix", "exports.v = 2;\n", ["a"], ["ok"], ["a"], ["var marker_qq = 42;"], { "bin/cli": BIN2 }, false],
  ["B3 extensionless package.json bin entry without a shebang finds the map by a bare .map suffix", "exports.v = 2;\n", ["a"], ["ok"], ["a"], ["var marker_qq = 42;"], { "bin/cli": BIN3 }, false],
  ["B4 extensionless package main without a shebang finds the map by a bare .map suffix", "exports.v = 2;\n", ["a"], ["ok"], ["a"], ["var marker_qq = 42;"], { "lib/loader": BIN3, "package.json": '{"name":"lib","version":"b","main":"lib/loader"}' }, false],
];
for (const big of [true, false]) for (const [label, code, os, osc, ns, nsc, extra, hiddenOk] of cases)
  test(label + " big=" + big, async () => {
    const reviewed: string[] = [];
    await reviewUpdate({
      eco: "npm", name: "lib", from: "1.0.0", to: "1.0.1",
      registry: { latest: async () => undefined, publishedAt: async () => new Date("2020-01-01"), artifactUrls: async () => [] },
      advisories: { query: async () => [] },
      reviewer: { name: "fake", review: async (p) => (reviewed.push(p), "APPROVE\nno attack indicators found") },
      cooldownDays: 1, now: new Date("2026-10-21T00:00:00Z"), chunkChars: 60000,
      loadArtifacts: async () => ({
        old: files({ "package.json": '{"name":"lib","version":"a","main":"lib/index.js","bin":{"cli":"bin/cli"}}', "lib/index.js": "exports.v = 1;\n", "lib/index.js.map": map("a", big, os, osc) }),
        new: files({ "package.json": '{"name":"lib","version":"b","main":"lib/index.js","bin":{"cli":"bin/cli"}}', "lib/index.js": code, "lib/index.js.map": map("b", big, ns, nsc), ...extra }),
      }),
    });
    const t = reviewed.join("");
    // a small map is shown whole as a token diff, so the payload is looked for by its distinctive word
    const key = nsc.some((x) => x?.includes("marker_qq")) ? "marker_qq" : "process.env.Q";
    const shown = t.includes(key);
    // P2 on a padded map is the ruled case (review of PR 91: text unchanged at its index was already shipped in the old release): an entry unchanged at its index carries no new text, so it is not listed. Every other case shows the payload.
    expect({ label, big, payloadShown: shown }).toEqual({ label, big, payloadShown: !(hiddenOk && big) });
  }, 60000);

// A template whose tail is not the script name does not name the script, at either size (a known limit, pinned so a change to the stem rule is a decision).
for (const [label, code] of [["O1 `${d}index.js` (no slash after the substitution)", "const d = process.env.D;\nmodule.exports = `${d}index.js`;\n"], ["O2 `./index.js?${v}` (a query after the name)", "const v = process.env.V;\nmodule.exports = `./index.js?${v}`;\n"]] as const)
  for (const big of [true, false])
    test(`${label} leaves the map a hash line, big=${big}`, async () => {
      const reviewed: string[] = [];
      await reviewUpdate({
        eco: "npm", name: "lib", from: "1.0.0", to: "1.0.1",
        registry: { latest: async () => undefined, publishedAt: async () => new Date("2020-01-01"), artifactUrls: async () => [] },
        advisories: { query: async () => [] },
        reviewer: { name: "fake", review: async (p) => (reviewed.push(p), "APPROVE\nno attack indicators found") },
        cooldownDays: 1, now: new Date("2026-10-21T00:00:00Z"), chunkChars: 60000,
        loadArtifacts: async () => ({
          old: files({ "package.json": '{"name":"lib","version":"a","main":"lib/index.js"}', "lib/index.js": "exports.v = 1;\n", "lib/index.js.map": map("a", big, ["a"], ["ok"]) }),
          new: files({ "package.json": '{"name":"lib","version":"b","main":"lib/index.js"}', "lib/index.js": "exports.v = 2;\n", "lib/x.js": code, "lib/index.js.map": map("b", big, ["a"], ["var marker_qq = 42;"]) }),
        }),
      });
      expect(reviewed.join("")).toContain("[source map, strict v3 data");
    }, 60000);
