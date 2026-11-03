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
    ['A=(-r ./p.js a.js); node "${A[@]}"', "p.js"],
    ["node ${X:--r ./p.js a.js}", "p.js"],
    ["node {-r,./p.js} a.js", "p.js"],
    ["{node,-r,./p.js} a.js", "p.js"],
    ['N=b.js; (cat lib/hidden.js > "$N"); node b.js', "lib/hidden.js"],
    ["X='-r ./p.js a.js'; sh -c \"node $X\"", "p.js"],
    ["read PATH <<< ./bin; node a.js", "bin/node"],
    ["N=a.js\nif true; then N=b.js; fi\ncat lib/hidden.js > $N; node b.js", "lib/hidden.js"],
    ["N=a.js\nN=b.js | true\ncat lib/hidden.js > $N; node b.js", "lib/hidden.js"],
    ["N=a.js\nprintf -v N b.js\ncat lib/hidden.js > $N; node b.js", "lib/hidden.js"],
    ["N=a.js\n((N++))\ncat lib/hidden.js > $N; node b.js", "lib/hidden.js"],
    ["(cat lib/hidden.js > $N); node b.js", "lib/hidden.js"],
    ["cat lib/hidden.js | tee $N; node b.js", "lib/hidden.js"],
    ["dd if=lib/hidden.js of=$N; node b.js", "lib/hidden.js"],
    ["D=$(echo sub); node $D/a.js", "sub/a.js"],
    ["N=a.js; (N=b.js); cat lib/hidden.js > $N; node a.js", "lib/hidden.js"],
    ["N=a.js; x=$(N=b.js); cat lib/hidden.js > $N; node a.js", "lib/hidden.js"],
    ["node -ep 1 -r ./p.js a.js", "p.js"],
    ["node ${X:-./lib/hidden.js}", "lib/hidden.js"],
    ["npx cat lib/hidden.js > $npm_package_config_out; node b.js", "lib/hidden.js"],
    ["npm exec -- cat lib/hidden.js > $npm_package_config_out; node b.js", "lib/hidden.js"],
    ["pnpm dlx cat lib/hidden.js > $npm_package_config_out; node b.js", "lib/hidden.js"],
    ["npm run show > $npm_package_config_out; node b.js", "lib/hidden.js"],
    ["make show > $npm_package_config_out; node b.js", "lib/hidden.js"],
    ["php -r 'readfile(\"lib/hidden.js\");' > $npm_package_config_out; node b.js", "lib/hidden.js"],
    ["node lib/cat.js > $npm_package_config_out; node b.js", "lib/hidden.js"],
    ["set -- b.js; npx cat lib/hidden.js > $1; node b.js", "lib/hidden.js"],
    ["f() { npx cat lib/hidden.js > $1; }; f b.js; node b.js", "lib/hidden.js"],
    ["getopts o N; cat lib/hidden.js > $N; node b.js", "lib/hidden.js"],
    ["cat lib/hidden.js > ${npm_package_config_out:-/tmp/x}; node b.js", "lib/hidden.js"],
    ["npx cat lib/hidden.js > $npm_package_name.js; node x.js", "lib/hidden.js"],
    ['read OUT <<< b.js; sh -c "cat lib/hidden.js" > "$OUT"; node b.js', "lib/hidden.js"],
    ["N=b.js; N=a.js & cat lib/hidden.js > $N; node b.js", "lib/hidden.js"],
    ["N=b.js; false &&\nN=a.js\ncat lib/hidden.js > $N; node b.js", "lib/hidden.js"],
    ['cp -t"$DIR" lib/hidden.js; node b.js', "lib/hidden.js"],
    ["N=b.js eval 'cat lib/hidden.js > $N'; node b.js", "lib/hidden.js"],
    ["N=$(echo b.js); cat lib/hidden.js > ${N:-/tmp/x}; node b.js", "lib/hidden.js"],
    ["awk '{x=$1 / 2; system(\"sh lib/x.sh\"); y=$2 / 3}' a.js", "lib/x.sh"],
    ['N=b.js; (N=safe.js); cat lib/hidden.js > "$N"; node b.js', "lib/hidden.js"],
    ["N=b.js; x=$(N=safe.js); cat lib/hidden.js > $N; node b.js", "lib/hidden.js"],
    ['export ""$(cat lib/x.env) && node a.js', "lib/x.env"],
    ["export $(cat lib/x.env) && node a.js", "lib/x.env"],
    ["cat lib/hidden.js 1<>b.js && node b.js", "lib/hidden.js"],
    ["CC=~+/x.sh node-gyp rebuild", "x.sh"],
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

describe("a class still widens when the existing scan reaches the body through a runner", () => {
  test("npm run a -> a script that reads a program file the text does not name", () => {
    const base: Record<string, string> = { "package.json": JSON.stringify({ name: "x", version: "1", scripts: { postinstall: "npm run a", a: "sed -f p.sed x" } }), "ctl/z.js": "1" };
    const n = { ...base, "ctl/z.js": "changed()" };
    const d = prepass("npm", map(base), map(n)).hard.filter((s) => s.kind === "install-script").map((s) => s.detail);
    expect(d).toContain("file ctl/z.js");
  });
});
