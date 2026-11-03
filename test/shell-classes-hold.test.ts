import { describe, expect, test } from "bun:test";
import { prepass, type FileMap } from "../src/prepass.ts";

const enc = new TextEncoder();
const map = (f: Record<string, string>): FileMap => new Map(Object.entries(f).map(([k, v]) => [k, enc.encode(v)]));
const pj = (hook: string) => JSON.stringify({ name: "x", version: "1", scripts: { postinstall: hook } });

// The hook runs a.js; only `changed` differs between the releases. The detail of each install-script hold is returned.
function details(hook: string, changed: string): string[] {
  const base: Record<string, string> = { "package.json": pj(hook), "a.js": "1", "lib/hidden.js": "1" };
  const o = { ...base, [changed]: "1" };
  const n = { ...base, [changed]: "changed()" };
  return prepass("npm", map(o), map(n)).hard.filter((s) => s.kind === "install-script").map((s) => s.detail);
}

describe("a form that loads or runs code the text does not name holds, naming the changed file", () => {
  const cases: [string, string][] = [
    ["OPENSSL_CONF=./o.cnf node a.js", "o.cnf"],
    ["PHP_INI_SCAN_DIR=. php a.php", "php.ini"],
    ["PHPRC=. php a.php", "php.ini"],
    ["GCONV_PATH=. node a.js", "gconv-modules"],
    ["$N -r ./p.js a.js", "p.js"],
    ["${N} -r ./p.js a.js", "p.js"],
    ["N=node; $N -r ./p.js a.js", "p.js"],
    ["N=node\n$N -r ./p.js a.js", "p.js"],
    ["x=1 $N -r ./p.js a.js", "p.js"],
    ["$(echo node) -r ./p.js a.js", "p.js"],
    ["`echo node` -r ./p.js a.js", "p.js"],
    ['env -S "$(cat lib/x.txt)"', "lib/x.txt"],
    ["$npm_node_execpath -r ./p.js a.js", "p.js"],
    ['N=b.js; cat lib/hidden.js > "$N"; node b.js', "lib/hidden.js"],
    ["N=b.js\ncat lib/hidden.js > $N\nnode b.js", "lib/hidden.js"],
    ["NODE_GYP_FORCE_PYTHON=./tools/py.sh node-gyp rebuild", "tools/py.sh"],
    ["LINK=./x.sh node-gyp rebuild", "x.sh"],
    ["CC_host=./c.sh node-gyp rebuild", "c.sh"],
    ["CXXFLAGS=-B./bin node-gyp rebuild", "bin/gcc"],
    ["CFLAGS=-fplugin=./p.so node-gyp rebuild", "p.so"],
    ["PYTHONUSERBASE=. python3 a.py", "lib/site.py"],
    ["sudo -D sub node a.js", "sub/a.js"],
    ["ruby -Csrc a.rb", "src/a.rb"],
    ["ruby -Xsrc a.rb", "src/a.rb"],
    ['cat lib/hidden.js &> "$N"; node b.js', "lib/hidden.js"],
    ['N=$(echo b.js); cat lib/hidden.js > "$N"; node b.js', "lib/hidden.js"],
    ['N=a; N=$(echo b.js); cat lib/hidden.js > "$N"; node b.js', "lib/hidden.js"],
    ["N=b.js\nread N <<< b.js\ncat lib/hidden.js > $N\nnode b.js", "lib/hidden.js"],
    ["D=sub; node $D/a.js", "sub/a.js"],
    ["CXXFLAGS='-B ./bin' node-gyp rebuild", "bin/gcc"],
    ["ruby -C sub a.rb", "sub/a.rb"],
    ["cat t > b.js && node lib/../b.js", "t"],
    ["cat t > lib/x.js && node lib/./x.js", "t"],
    ["PYTHON=./evil.sh node-gyp rebuild", "evil.sh"],
    ["CC=./x.sh node-gyp rebuild", "x.sh"],
  ];
  for (const [hook, file] of cases) {
    test(JSON.stringify(hook), () => {
      expect(details(hook, file)).toContain(`file ${file}`);
    });
  }
});

describe("a guard that runs nothing does not hold on an unrelated change", () => {
  for (const hook of ["command -v node >/dev/null 2>&1 && node a.js", "command -v python3 >/dev/null || exit 0", "bash --version", "node a.js", "CC=clang node-gyp rebuild"]) {
    test(JSON.stringify(hook), () => {
      expect(details(hook, "lib/hidden.js")).toEqual([]);
    });
  }
});

describe("a substitution that quotes a quote does not hide the command after it", () => {
  const head = `x=$(echo "$(printf '"')")`;
  const cases: [string, string][] = [["R=sh; $R evil.sh", "evil.sh"], ["${RUNNER:-sh} evil.sh", "evil.sh"], ["CC=$PWD/lib/x.sh node-gyp rebuild", "lib/x.sh"]];
  for (const [t, file] of cases) {
    for (const sep of ["; ", "\n"]) {
      test(JSON.stringify(head + sep + t), () => {
        expect(details(head + sep + t, file)).toContain(`file ${file}`);
      });
    }
  }
});
