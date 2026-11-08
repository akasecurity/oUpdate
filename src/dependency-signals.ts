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
  if (n.length < 5 || list.includes(n)) return undefined;
  return list.find((p) => p.length >= 5 && oneEditApart(n, norm(eco, p)));
}

// The inside of a bracketed list: quoted strings may hold brackets (an extra such as "pkg[extra]").
const LIST = String.raw`(?:[^\]"']|"[^"\n]*"|'[^'\n]*')*`;
const REQ_NAME = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)/;
const reqName = (s: string) => REQ_NAME.exec(s)?.[1];
const quoted = (block: string) => [...block.matchAll(/["']([^"'\n]+)["']/g)].map((m) => reqName(m[1]!));

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
  const text = dec.decode(bytes);
  const base = path.split("/").pop()!;
  const add = (n: string | undefined) => n && out.add(n);
  if (base === "setup.py") {
    for (const m of text.matchAll(new RegExp(`install_requires\\s*=\\s*\\[(${LIST})\\]`, "g"))) quoted(m[1]!).forEach(add);
  } else if (base === "pyproject.toml") {
    for (const m of text.matchAll(new RegExp(`^dependencies\\s*=\\s*\\[(${LIST})\\]`, "gm"))) quoted(m[1]!).forEach(add);
  } else if (base === "setup.cfg") {
    const m = /^install_requires\s*=[ \t]*\n?((?:[ \t]+\S.*\n?)*)/m.exec(text);
    for (const l of (m?.[1] ?? "").split("\n")) add(reqName(l));
  } else if (base === "METADATA" || base === "PKG-INFO") {
    for (const m of text.matchAll(/^Requires-Dist:\s*([A-Za-z0-9][A-Za-z0-9._-]*)/gm)) add(m[1]);
  } else if (base === "requires.txt") {
    for (const l of text.split("\n")) {
      if (l.startsWith("[")) break;
      add(reqName(l));
    }
  } else if (/^requirements.*\.txt$/.test(base)) {
    for (const l of text.split("\n")) if (!/^\s*(#|-)/.test(l)) add(reqName(l));
  }
  return out;
}

const NPM_MANIFEST = (p: string) => p.split("/").length <= 2 && p.split("/").pop() === "package.json" && !p.split("/").includes("node_modules");
const PYPI_MANIFEST = (p: string) => /(^|\/)(setup\.py|pyproject\.toml|setup\.cfg|METADATA|PKG-INFO|requires\.txt|requirements[^/]*\.txt)$/.test(p);

/**
 * Soft signals for dependency names the new release declares and the old one did not:
 * `dependency-added` for each manifest that gains a name, and `dependency-lookalike` for a new name that is one edit from a
 * popular package. Only an update (a manifest in both trees) is read; a first install has nothing to compare with.
 */
export function dependencySignals(eco: Ecosystem, oldFiles: FileMap, newFiles: FileMap): Signal[] {
  const out: Signal[] = [];
  const isManifest = eco === "npm" ? NPM_MANIFEST : PYPI_MANIFEST;
  const names = (p: string, f: FileMap) => (eco === "npm" ? npmNames(f.get(p)) : pypiNames(p, f.get(p)));
  for (const p of [...newFiles.keys()].filter(isManifest)) {
    if (!oldFiles.has(p)) continue;
    const before = new Set([...names(p, oldFiles)].map((n) => norm(eco, n)));
    const added = [...names(p, newFiles)].filter((n) => !before.has(norm(eco, n)));
    if (!added.length) continue;
    out.push({ kind: "dependency-added", path: p, detail: `new dependency name(s): ${added.slice(0, 8).join(", ").slice(0, 160)}` });
    for (const n of added) {
      const like = lookalikeOf(eco, n);
      if (like) out.push({ kind: "dependency-lookalike", path: p, detail: `new dependency ${n.slice(0, 80)} is one edit from the popular package ${like}` });
    }
  }
  return out;
}
