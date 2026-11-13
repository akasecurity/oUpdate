import type { Ecosystem, FileMap, Signal } from "./prepass.ts";

// Soft signals about the dependency names a release adds. A new name has no floor to fall from, so it
// is no hold; these point the reviewer at the line. Names only, read from the manifests as text.

const dec = new TextDecoder("utf-8", { fatal: false });

const NPM_POPULAR = [
  "react", "react-dom", "lodash", "express", "axios", "chalk", "commander", "debug", "moment", "webpack", "typescript", "eslint", "prettier",
  "jest", "mocha", "request", "async", "bluebird", "underscore", "uuid", "yargs", "minimist", "glob", "rimraf", "mkdirp", "semver", "dotenv",
  "inquirer", "colors", "tslib", "rxjs", "vue", "next", "jquery", "bootstrap", "redux", "body-parser", "cors", "morgan", "mongoose", "socket.io",
  "passport", "jsonwebtoken", "bcrypt", "bcryptjs", "cheerio", "puppeteer", "nodemon", "babel-core", "classnames", "prop-types", "core-js",
  "fs-extra", "node-fetch", "ws", "yaml", "zod", "ora", "execa", "got", "cross-env", "http-proxy", "handlebars", "ejs", "pug", "marked",
  "chokidar", "readable-stream", "string_decoder", "event-stream", "left-pad", "isarray", "inherits", "lodash.merge", "date-fns", "dayjs",
  "validator", "joi", "ajv", "winston", "pino", "supertest", "sinon", "chai", "vite", "rollup", "esbuild", "tailwindcss", "postcss", "sass",
];
const PYPI_POPULAR = [
  "requests", "urllib3", "numpy", "pandas", "boto3", "botocore", "setuptools", "pip", "wheel", "six", "certifi", "idna", "charset-normalizer",
  "python-dateutil", "pyyaml", "cryptography", "cffi", "pycparser", "jinja2", "markupsafe", "click", "flask", "django", "pytest", "attrs",
  "packaging", "typing-extensions", "pytz", "scipy", "matplotlib", "pillow", "sqlalchemy", "psycopg2", "pymysql", "redis", "celery", "aiohttp",
  "httpx", "fastapi", "pydantic", "uvicorn", "gunicorn", "beautifulsoup4", "lxml", "scikit-learn", "tensorflow", "torch", "tqdm", "colorama",
  "docutils", "pygments", "rich", "paramiko", "pyjwt", "oauthlib", "protobuf", "grpcio", "werkzeug", "toml", "tomli", "virtualenv", "tox",
  "coverage", "mock", "simplejson", "ujson", "orjson", "regex", "decorator", "jsonschema", "pyparsing", "selenium", "openpyxl", "psutil",
  "websockets", "markdown", "docker", "kubernetes", "azure-core", "google-api-core", "numba", "sympy", "networkx", "nltk", "spacy", "keras",
];

/** Real packages that sit one edit from a popular one (scapy and scipy, preact and react, color and colors): a new dependency on one of these is no lookalike. */
const REAL_NEIGHBORS: Record<Ecosystem, readonly string[]> = {
  npm: ["preact", "color"],
  pypi: ["scapy", "markdown2"],
};

const norm = (eco: Ecosystem, n: string) => (eco === "pypi" ? n.toLowerCase().replace(/[-_.]+/g, "-") : n);

/** True when `a` and `b` differ by one inserted, dropped or changed character, or one swap of neighbors. */
export function oneEditApart(a: string, b: string): boolean {
  if (a === b || Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  if (a.length === b.length) {
    if (a.slice(i + 1) === b.slice(i + 1)) return true;
    return a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2);
  }
  const [s, l] = a.length < b.length ? [a, b] : [b, a];
  return s.slice(i) === l.slice(i + 1);
}

/** The popular names a new name is one edit from, never the name itself. Short names collide with real ones and are left out. */
export function lookalikeOf(eco: Ecosystem, name: string): string | undefined {
  const list = eco === "npm" ? NPM_POPULAR : PYPI_POPULAR;
  const n = norm(eco, name);
  if (n.length < 5 || list.includes(n) || REAL_NEIGHBORS[eco].includes(n)) return undefined;
  return list.find((p) => p.length >= 5 && oneEditApart(n, norm(eco, p)));
}

// The inside of a bracketed list: quoted strings may hold brackets (an extra such as "pkg[extra]").
const LIST = String.raw`(?:[^\]"']|"[^"\n]*"|'[^'\n]*')*`;
const REQ_NAME = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)/;
const reqName = (s: string) => REQ_NAME.exec(s)?.[1];
const STRIP_PY = /("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*')|#[^\n]*/g;
// A TOML literal string (single quotes) has no escapes: a backslash before the closing quote ends nothing.
const STRIP_TOML = /("(?:[^"\\\n]|\\.)*"|'[^'\n]*')|#[^\n]*/g;
/** The text with # comments cut, quoted strings left whole (a "#" inside a string is no comment). `tomlLiteral`: single-quoted strings take no escapes (TOML); off, they do (Python). */
export function stripHashComments(text: string, o: { tomlLiteral: boolean } = { tomlLiteral: false }): string {
  return text.replace(o.tomlLiteral ? STRIP_TOML : STRIP_PY, (_m, q: string | undefined) => q ?? "");
}
const quoted = (block: string) => [...block.matchAll(/["']([^"'\n]+)["']/g)].map((m) => reqName(m[1]!));

const RUNTIME_SECTIONS = ["dependencies", "optionalDependencies", "peerDependencies"];
const ALL_SECTIONS = [...RUNTIME_SECTIONS, "devDependencies"];

/** Every version string each npm dependency name asks for in the given sections, as text (a non-string value is no version). */
function npmSpecs(bytes: Uint8Array | undefined, sections: string[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  if (!bytes) return out;
  try {
    const pj = JSON.parse(dec.decode(bytes)) as Record<string, unknown>;
    for (const f of sections) {
      const b = pj?.[f];
      if (b && typeof b === "object" && !Array.isArray(b)) for (const [k, v] of Object.entries(b)) out.set(k, [...(out.get(k) ?? []), ...(typeof v === "string" ? [v] : [])]);
    }
  } catch { /* an unreadable manifest adds no names */ }
  return out;
}

// A lower bound: an optional ^ ~ >= > = v, then a major with optional minor and patch (a number, x, X or *), then an optional pre-release or build.
const LOWER_BOUND = /^(?:\^|~|>=|>|=)?v?(\d+)(?:\.(?:\d+|[xX*])){0,2}(?:[-+][0-9A-Za-z.+-]*)?$/;
/** True when a version string is a registry range with a lower bound whose major is 90 to 999 (a dependency-confusion release, never a normal floor; calendar versions are 4 digits). A URL, git, file, link or workspace spec, a GitHub shorthand, and an upper bound alone ("<100") never count; an npm: alias is read after its last "@"; each "||" alternative is tested. */
export function highMajorFloor(spec: string): boolean {
  // A real range is far shorter: cutting first keeps the reading linear on a manifest that is only capped by the artifact limits.
  let s = spec.slice(0, 256).trim();
  if (s.startsWith("npm:")) {
    const at = s.lastIndexOf("@");
    if (at <= 3) return false;
    s = s.slice(at + 1).trim();
  }
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(s) || /^(?:\.|\/|~\/)/.test(s) || /^[\w.-]+\/[\w.-]+(?:#.*)?$/.test(s)) return false;
  return s.split("||").some((raw) => {
    // An operator written apart from its number ("< 99", ">= 99.0.0") is joined to it, so an upper bound never reads as a lower one.
    const alt = raw.trim().replace(/(<=|>=|<|>|=|\^|~)\s+/g, "$1");
    const hyphen = alt.split(/\s+-\s+/);
    return (hyphen.length > 1 ? hyphen.slice(0, 1) : alt.split(/\s+/)).some((tok) => {
      const m = LOWER_BOUND.exec(tok);
      return !!m && Number(m[1]) >= 90 && Number(m[1]) < 1000;
    });
  });
}

function npmNames(bytes: Uint8Array | undefined): Set<string> {
  const out = new Set<string>();
  if (!bytes) return out;
  try {
    const pj = JSON.parse(dec.decode(bytes)) as Record<string, unknown>;
    for (const f of ["dependencies", "optionalDependencies", "peerDependencies"]) {
      const b = pj?.[f];
      if (b && typeof b === "object" && !Array.isArray(b)) for (const k of Object.keys(b)) out.add(k);
    }
  } catch { /* an unreadable manifest adds no names */ }
  return out;
}

function pypiNames(path: string, bytes: Uint8Array | undefined): Set<string> {
  const out = new Set<string>();
  if (!bytes) return out;
  const raw = dec.decode(bytes);
  const base = path.split("/").pop()!;
  const add = (n: string | undefined) => n && out.add(n);
  const text = base === "setup.py" || base === "pyproject.toml" ? stripHashComments(raw, { tomlLiteral: base === "pyproject.toml" }) : raw;
  if (base === "setup.py") {
    for (const m of text.matchAll(new RegExp(`install_requires\\s*=\\s*\\[(${LIST})\\]`, "g"))) quoted(m[1]!).forEach(add);
  } else if (base === "pyproject.toml") {
    for (const m of text.matchAll(new RegExp(`^dependencies\\s*=\\s*\\[(${LIST})\\]`, "gm"))) quoted(m[1]!).forEach(add);
  } else if (base === "setup.cfg") {
    const m = /^install_requires[ \t]*=[ \t]*([^\n]*)\n?((?:[ \t]+\S.*\n?)*)/m.exec(text);
    for (const l of [m?.[1] ?? "", ...(m?.[2] ?? "").split("\n")]) add(reqName(l));
  } else if (base === "METADATA" || base === "PKG-INFO") {
    for (const m of text.matchAll(/^Requires-Dist:\s*([A-Za-z0-9][A-Za-z0-9._-]*)/gm)) add(m[1]);
  } else if (base === "requires.txt") {
    for (const l of text.split("\n")) {
      if (l.startsWith("[")) break;
      add(reqName(l));
    }
  } else if (/^requirements.*\.txt$/.test(base)) {
    // A line with a scheme (git+https://..., https://...) or a path is no name; "name @ url" keeps the name.
    for (const l of text.split("\n")) if (!/^\s*(#|-|\.|\/)/.test(l) && !/^\s*[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(l)) add(reqName(l));
  }
  return out;
}

/** A package.json the package itself declares: at the root, or (by default) one directory down, never inside node_modules. */
export function isNpmManifest(p: string, maxDepth = 2): boolean {
  const parts = p.split("/");
  return parts.length <= maxDepth && parts[parts.length - 1] === "package.json" && !parts.includes("node_modules");
}
const NPM_MANIFEST = (p: string) => isNpmManifest(p, 1);
// Root files, the METADATA of a top-level dist-info directory, and the egg-info of a setuptools sdist (the artifact is re-rooted at its PKG-INFO folder, so
// its dependencies sit in <name>.egg-info/requires.txt, or src/<name>.egg-info/requires.txt): a file deeper in the tree (docs, tests, vendored code) declares nothing of this package.
const PYPI_MANIFEST = (p: string) =>
  /^(setup\.py|pyproject\.toml|setup\.cfg|PKG-INFO|requirements[^/]*\.txt|[^/]+\.dist-info\/METADATA|[^/]+\.egg-info\/(requires\.txt|PKG-INFO)|src\/[^/]+\.egg-info\/requires\.txt)$/.test(p);

/**
 * Soft signals for dependency names the new release declares and the old one did not:
 * `dependency-added` for each manifest that gains a name, `dependency-high-floor` for a new npm name that asks for a major of 90 to 999, and `dependency-lookalike` for a new name that is one edit from a
 * popular package. A manifest with no old copy counts all its names as new.
 */
export function dependencySignals(eco: Ecosystem, oldFiles: FileMap, newFiles: FileMap): Signal[] {
  const out: Signal[] = [];
  const isManifest = eco === "npm" ? NPM_MANIFEST : PYPI_MANIFEST;
  const names = (p: string, f: FileMap) => (eco === "npm" ? npmNames(f.get(p)) : pypiNames(p, f.get(p)));
  for (const p of [...newFiles.keys()].filter(isManifest)) {
    const before = new Set([...names(p, oldFiles)].map((n) => norm(eco, n)));
    const added = [...names(p, newFiles)].filter((n) => !before.has(norm(eco, n)));
    if (!added.length) continue;
    out.push({ kind: "dependency-added", path: p, detail: `new dependency name(s): ${added.slice(0, 8).join(", ").slice(0, 160)}` });
    if (eco === "npm") {
      // A name an old section (devDependencies too) already asked for at a high floor is not new news; only the runtime sections of the new release are read.
      const oldAny = npmSpecs(oldFiles.get(p), ALL_SECTIONS);
      const specs = npmSpecs(newFiles.get(p), RUNTIME_SECTIONS);
      const high = added.flatMap((n) => {
        const hit = !(oldAny.get(n) ?? []).some(highMajorFloor) && (specs.get(n) ?? []).find(highMajorFloor);
        return hit ? [`${n.slice(0, 60)}@${hit.slice(0, 40)}`] : [];
      });
      if (high.length) out.push({ kind: "dependency-high-floor", path: p, detail: `${high.length} new ${high.length === 1 ? "dependency asks" : "dependencies ask"} for a very high version (${high.slice(0, 5).join(", ")}${high.length > 5 ? `, ${high.length - 5} more` : ""}), for a name the old release did not depend on; a very high major is a dependency-confusion pattern, so check that the real public releases of the name reach that major`.slice(0, 900) });
    }
    for (const n of added) {
      const like = lookalikeOf(eco, n);
      if (like) out.push({ kind: "dependency-lookalike", path: p, detail: `new dependency ${n.slice(0, 80)} is one edit from the popular package ${like}` });
    }
  }
  return out;
}
