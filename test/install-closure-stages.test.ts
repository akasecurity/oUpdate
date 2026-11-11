import { expect, test } from "bun:test";
import { prepass, type FileMap } from "../src/prepass.ts";

const enc = (s: string) => new TextEncoder().encode(s);
const files = (o: Record<string, string>): FileMap => new Map(Object.entries(o).map(([k, v]) => [k, enc(v)]));
const holds = (old: FileMap, now: FileMap) => prepass("npm", old, now).hard.filter((s) => s.kind === "install-script").map((s) => s.detail);

// A hook line that is not split into commands (a pipe, a redirect, a subshell, a function definition) still runs the commands
// in it. `evil` is a script of the package that runs lib/evil.js; only lib/evil.js changes between the two releases.
const release = (v: string, hook: string, scripts: Record<string, string> = {}) =>
  files({
    "package.json": JSON.stringify({ name: "p", version: "1.0." + v, scripts: { postinstall: hook, evil: "node lib/evil.js", quiet: "echo hi", ...scripts } }),
    "lib/evil.js": `console.log("evil ${v}")\n`,
    "lib/ok.js": "console.log('ok')\n",
    "in.txt": "hello\n",
  });

const runs: [string, string][] = [
  ["npm run through a pipe", "npm run evil | cat"],
  ["npm run with a redirect", "npm run evil > out.log"],
  ["npm run in a subshell", "(npm run evil)"],
  ["npm run in a function body called on the line", "f() { npm run evil; }; f"],
  ["yarn run in a function body", "f() { yarn run evil; }; f"],
  ["pnpm run after a pipe stage", "echo hi | pnpm run evil"],
  ["npm run after a redirect on the line", "echo hi > out.log; npm run evil"],
  ["npm run in a function body on its own lines", "f() {\n  npm run evil | tee out.log\n}\nf"],
  ["npm run behind a keyword in a subshell", "( if true; then npm run evil; fi )"],
];

runs.push(
  ["an assignment prefix on a piped runner", "FOO=1 npm run evil | cat"],
  ["an assignment prefix with a build script name", "NODE_ENV=production npm run evil | tee log"],
  ["env before a piped runner", "env npm run evil | cat"],
  ["command before a piped runner", "command npm run evil | cat"],
  ["nohup before a piped runner", "nohup npm run evil | cat"],
  ["nice with a value before a piped runner", "nice -n 5 npm run evil | cat"],
  ["time before a piped runner", "time npm run evil | cat"],
  ["exec before a piped runner", "exec npm run evil | cat"],
  ["stdbuf before a piped runner", "stdbuf -oL npm run evil | cat"],
  ["a shell -c body after a pipe", "sh -c 'npm run evil' | cat"],
  ["a bash -c body with a prefix", "bash -c 'FOO=1 npm run evil' | cat"],
  ["xargs with a runner", "echo evil | xargs npm run"],
  ["a quoted runner word", '"npm" run evil | cat'],
  ["a backslash in the runner word", "n\\pm run evil | cat"],
  ["env by path", "/usr/bin/env npm run evil | cat"],
  ["npx run-s", "npx run-s evil | cat"],
  ["npm exec -- run-s", "npm exec -- run-s evil | cat"],
  ["corepack pnpm run", "corepack pnpm run evil | cat"],
  ["a function keyword body", "function f { npm run evil; }; f"],
  ["a runner on a line after a comment line", "# note\nnpm run evil | cat"],
);

for (const [label, hook] of runs) {
  test(`${label}: the script it runs is read, so the changed lib/evil.js holds`, () => {
    expect(holds(release("0", hook), release("1", hook)).length).toBeGreaterThan(0);
  });
}

const quiet: [string, string][] = [
  ["a function that only prints", "f() { echo hi; }; f"],
  ["a pipe of plain readers", "echo hi | cat"],
  ["a script that does not run the changed file, through a pipe", "npm run quiet | cat"],
  ["a redirect with no runner", "echo hi > out.log"],
  ["npm ls through a pipe runs no script", "npm ls | head -3"],
  ["yarn install through a pipe runs no script", "yarn install | cat"],
  ["a read with no runner", "read x < in.txt; echo $x"],
];

quiet.push(
  ["a runner in a comment after a plain command", "echo hi # ; npm run evil | cat"],
  ["a runner in a quoted heredoc body", "cat <<'EOF'\nnpm run evil\nEOF"],
  ["a runner word as a redirect operand", "echo hi > npm run evil"],
  ["a runner in a single-quoted echo", "echo 'npm run evil' | cat"],
);

for (const [label, hook] of quiet) {
  test(`${label} stays quiet: the changed lib/evil.js is not an install change`, () => {
    expect(holds(release("0", hook), release("1", hook))).toEqual([]);
  });
}

test("the same runner line with the same bytes holds nothing", () => {
  const hook = "f() { npm run evil | cat; }; f";
  expect(holds(release("0", hook), release("0", hook))).toEqual([]);
});

// Lifecycle scripts a command runs without naming them: the script is set to run the changed file.
const lifecycle: [string, string, Record<string, string>][] = [
  ["npm it runs test", "npm it | cat", { test: "node lib/evil.js" }],
  ["npm install-test runs test", "npm install-test | cat", { test: "node lib/evil.js" }],
  ["npm pack runs prepack", "npm pack | cat", { prepack: "node lib/evil.js" }],
  ["npm pack runs prepare", "npm pack | cat", { prepare: "node lib/evil.js" }],
  ["npm pack runs postpack", "(npm pack)", { postpack: "node lib/evil.js" }],
  ["npm pack with a prefix", "FOO=1 npm pack | cat", { prepack: "node lib/evil.js" }],
];

for (const [label, hook, scripts] of lifecycle) {
  test(`${label} in a split line: the script it runs is read`, () => {
    expect(holds(release("0", hook, scripts), release("1", hook, scripts)).length).toBeGreaterThan(0);
  });
}

test("npm pack in a split line with no lifecycle script stays quiet", () => {
  expect(holds(release("0", "npm pack | cat"), release("1", "npm pack | cat"))).toEqual([]);
});

// Read-only npm subcommands and name lookups run no script, though a lifecycle script or the runner is named in the line.
const lookups: [string, string][] = [
  ["npm view with a lifecycle word as an operand", "npm view pack version | cat"],
  ["npm config get with a script name as an operand", "npm config get test | cat"],
  ["npm ls with a script name as an operand", "npm ls test | cat"],
  ["npm help run", "npm help run | cat"],
  ["command -v only looks the runner up", "command -v npm run evil | cat"],
  ["command -V only looks the runner up", "command -V npm run evil | cat"],
  ["type only looks the runner up", "type npm run evil | cat"],
  ["which only looks the runner up", "which npm run evil | cat"],
  ["hash only looks the runner up", "hash npm run evil | cat"],
];

for (const [label, hook] of lookups) {
  test(`${label} stays quiet with test, prepack and prepare scripts that run the changed file`, () => {
    const scripts = { test: "node lib/evil.js", prepack: "node lib/evil.js", postpack: "node lib/evil.js" };
    expect(holds(release("0", hook, scripts), release("1", hook, scripts))).toEqual([]);
  });
}

// Flag values are not subcommands, and a version flag after the subcommand belongs to the script.
const dirRelease = (v: string, hook: string, dir: "lib" | "docs" | "test") =>
  files({
    "package.json": JSON.stringify({ name: "p", version: "1.0." + v, scripts: { postinstall: hook, evil: `node ${dir}/evil.js` } }),
    [`${dir}/evil.js`]: `console.log("evil ${v}")\n`,
    "lib/ok.js": "console.log('ok')\n",
  });

const flagValueRuns: [string, string][] = [
  ["a cache flag value that looks like view", "npm --cache view run evil | cat"],
  ["a prefix flag value that looks like ls", "npm --prefix ls run evil | cat"],
  ["a workspace flag value that looks like config", "npm -w config run-script evil | cat"],
  ["a registry flag value that looks like help, rum", "npm --registry help rum evil | cat"],
  ["a version flag after the script word", "npm run evil -- --version | cat"],
  ["a short version flag after the script word", "npm run evil --silent -- -v | cat"],
  ["command before npm with a version flag after the script", "command npm run evil -- -v | cat"],
  ["command before npm with a version flag after the runner", "command npm run evil --version | cat"],
];

for (const [label, hook] of flagValueRuns) {
  for (const dir of ["lib", "docs", "test"] as const) {
    test(`${label} runs the script: a changed ${dir}/evil.js holds`, () => {
      expect(holds(dirRelease("0", hook, dir), dirRelease("1", hook, dir)).length).toBeGreaterThan(0);
    });
  }
}

test("a version flag before the subcommand prints the version and runs nothing", () => {
  expect(holds(dirRelease("0", "npm -v run evil | cat", "docs"), dirRelease("1", "npm -v run evil | cat", "docs"))).toEqual([]);
});

// Lifecycle words name their scripts only as the parsed subcommand, and --ignore-scripts switches the lifecycle and the pre and
// post scripts off while the named script still runs.
const lifeRelease = (v: string, hook: string, dir: "docs" | "test", scripts: Record<string, string>) =>
  files({
    "package.json": JSON.stringify({ name: "p", version: "1.0." + v, scripts: { postinstall: hook, build: "echo hi", ...scripts } }),
    [`${dir}/evil.js`]: `console.log("evil ${v}")\n`,
    "lib/ok.js": "console.log('ok')\n",
  });

const lifeQuiet: [string, string, Record<string, string>][] = [
  ["pack as an argument of another script, piped", "npm run build pack | cat", { prepack: "node DIR/evil.js" }],
  ["pack as an argument of another script, redirected", "npm run build pack > log", { prepack: "node DIR/evil.js" }],
  ["version as an argument of another script", "npm run build version | cat", { preversion: "node DIR/evil.js" }],
  ["pack with --ignore-scripts after &&", "true && npm pack --ignore-scripts", { prepack: "node DIR/evil.js" }],
  ["pack with --ignore-scripts in an if", "if npm pack --ignore-scripts; then echo ok; fi", { prepack: "node DIR/evil.js" }],
  ["pack with --ignore-scripts, piped", "npm pack --ignore-scripts | cat", { prepack: "node DIR/evil.js", postpack: "node DIR/evil.js" }],
  ["pack with the env spelling, piped", "npm_config_ignore_scripts=true npm pack | cat", { prepack: "node DIR/evil.js" }],
  ["it with --ignore-scripts and only a pre script changed", "npm it --ignore-scripts | cat", { test: "echo hi", pretest: "node DIR/evil.js" }],
  ["a pre script of a named script with --ignore-scripts", "npm run evil --ignore-scripts | cat", { evil: "echo hi", preevil: "node DIR/evil.js" }],
  ["a post script of test with --ignore-scripts", "npm test --ignore-scripts | cat", { test: "echo hi", posttest: "node DIR/evil.js" }],
];

for (const [label, hook, scripts] of lifeQuiet) {
  for (const dir of ["docs", "test"] as const) {
    test(`${label} stays quiet: a changed ${dir}/evil.js is not an install change`, () => {
      const sc = Object.fromEntries(Object.entries(scripts).map(([k, v]) => [k, v.replace("DIR", dir)]));
      expect(holds(lifeRelease("0", hook, dir, sc), lifeRelease("1", hook, dir, sc))).toEqual([]);
    });
  }
}

const lifeRuns: [string, string, Record<string, string>][] = [
  ["a named script with --ignore-scripts, piped", "npm run evil --ignore-scripts | cat", { evil: "node DIR/evil.js" }],
  ["test with --ignore-scripts, piped", "npm test --ignore-scripts | cat", { test: "node DIR/evil.js" }],
  ["a named script with the env spelling", "npm_config_ignore_scripts=true npm run evil | cat", { evil: "node DIR/evil.js" }],
  ["pack with no flag, piped", "npm pack | cat", { prepack: "node DIR/evil.js" }],
  ["pack with no flag after &&", "true && npm pack", { prepack: "node DIR/evil.js" }],
  ["pack with --ignore-scripts=false", "npm pack --ignore-scripts=false | cat", { prepack: "node DIR/evil.js" }],
  ["a pre script of a named script with no flag", "npm run evil | cat", { evil: "echo hi", preevil: "node DIR/evil.js" }],
];

for (const [label, hook, scripts] of lifeRuns) {
  for (const dir of ["docs", "test"] as const) {
    test(`${label} runs the script: a changed ${dir}/evil.js holds`, () => {
      const sc = Object.fromEntries(Object.entries(scripts).map(([k, v]) => [k, v.replace("DIR", dir)]));
      expect(holds(lifeRelease("0", hook, dir, sc), lifeRelease("1", hook, dir, sc)).length).toBeGreaterThan(0);
    });
  }
}

// The last setting wins, a flag beats the env, an empty or false value leaves scripts on, and only leading assignments and flags
// before `--` count.
const ignoreHolds: [string, string, Record<string, string>][] = [
  ["a later --ignore-scripts=false", "npm pack --ignore-scripts --ignore-scripts=false | cat", { prepack: "node DIR/evil.js" }],
  ["a later --no-ignore-scripts", "npm pack --ignore-scripts --no-ignore-scripts | cat", { prepack: "node DIR/evil.js" }],
  ["a flag that turns the env off", "npm_config_ignore_scripts=true npm pack --ignore-scripts=false | cat", { prepack: "node DIR/evil.js" }],
  ["an empty env value", "npm_config_ignore_scripts= npm pack | cat", { prepack: "node DIR/evil.js" }],
  ["an empty env value on a named script", "npm_config_ignore_scripts= npm run build | cat", { prebuild: "node DIR/evil.js" }],
  ["a false env value", "npm_config_ignore_scripts=false npm pack | cat", { prepack: "node DIR/evil.js" }],
  ["a zero env value after env", "env npm_config_ignore_scripts=0 npm pack | cat", { prepack: "node DIR/evil.js" }],
  ["an empty env value after env", "env npm_config_ignore_scripts= npm pack | cat", { prepack: "node DIR/evil.js" }],
  ["an env-looking argument after --", "npm run build -- npm_config_ignore_scripts=true | cat", { prebuild: "node DIR/evil.js" }],
  ["the flag after --", "npm run build -- --ignore-scripts | cat", { prebuild: "node DIR/evil.js" }],
  ["bun run with the flag after the script", "bun run build --ignore-scripts | cat", { prebuild: "node DIR/evil.js" }],
  ["bun run with the flag before the script", "bun --ignore-scripts run build | cat", { prebuild: "node DIR/evil.js" }],
  ["yarn run with the flag", "yarn run build --ignore-scripts | cat", { prebuild: "node DIR/evil.js" }],
  ["pnpm run with the flag", "pnpm run build --ignore-scripts | cat", { prebuild: "node DIR/evil.js" }],
  ["the env on yarn", "npm_config_ignore_scripts=true yarn run build | cat", { prebuild: "node DIR/evil.js" }],
];

for (const [label, hook, scripts] of ignoreHolds) {
  for (const dir of ["docs", "test"] as const) {
    test(`${label} leaves the scripts on: a changed ${dir}/evil.js holds`, () => {
      const sc = Object.fromEntries(Object.entries(scripts).map(([k, v]) => [k, v.replace("DIR", dir)]));
      expect(holds(lifeRelease("0", hook, dir, sc), lifeRelease("1", hook, dir, sc)).length).toBeGreaterThan(0);
    });
  }
}

const ignoreQuiet: [string, string, Record<string, string>][] = [
  ["a later --ignore-scripts", "npm pack --ignore-scripts=false --ignore-scripts | cat", { prepack: "node DIR/evil.js" }],
  ["the env on pack", "npm_config_ignore_scripts=true npm pack | cat", { prepack: "node DIR/evil.js" }],
  ["the env after env", "env npm_config_ignore_scripts=true npm pack | cat", { prepack: "node DIR/evil.js" }],
  ["a flag that turns the env on", "npm_config_ignore_scripts=false npm pack --ignore-scripts | cat", { prepack: "node DIR/evil.js" }],
  ["a pre script of a named script", "npm run build --ignore-scripts | cat", { prebuild: "node DIR/evil.js" }],
  ["pack with the flag, redirected", "npm pack --ignore-scripts > log", { prepack: "node DIR/evil.js" }],
];

for (const [label, hook, scripts] of ignoreQuiet) {
  for (const dir of ["docs", "test"] as const) {
    test(`${label} stays quiet: a changed ${dir}/evil.js is not an install change`, () => {
      const sc = Object.fromEntries(Object.entries(scripts).map(([k, v]) => [k, v.replace("DIR", dir)]));
      expect(holds(lifeRelease("0", hook, dir, sc), lifeRelease("1", hook, dir, sc))).toEqual([]);
    });
  }
}

// A bare --ignore-scripts takes a following true/false/1/0 as its value, install-test still runs `test`, and the env is read in
// order across launcher words.
const moreHolds: [string, string, Record<string, string>][] = [
  ["a separate false after the flag", "npm pack --ignore-scripts false | cat", { prepack: "node DIR/evil.js" }],
  ["a separate 0 after the flag", "npm pack --ignore-scripts 0 | cat", { prepack: "node DIR/evil.js" }],
  ["a separate false before the subcommand", "npm --ignore-scripts false pack | cat", { prepack: "node DIR/evil.js" }],
  ["it with the flag still runs test", "npm it --ignore-scripts | cat", { test: "node DIR/evil.js" }],
  ["cit with the flag still runs test", "npm cit --ignore-scripts | cat", { test: "node DIR/evil.js" }],
  ["install-test with the flag still runs test", "npm install-test --ignore-scripts | cat", { test: "node DIR/evil.js" }],
  ["an inner env that turns it off across nice", "npm_config_ignore_scripts=true nice -n 5 env npm_config_ignore_scripts=false npm pack | cat", { prepack: "node DIR/evil.js" }],
  ["an inner env that turns it off across sudo -u", "npm_config_ignore_scripts=true sudo -u x env npm_config_ignore_scripts=false npm pack | cat", { prepack: "node DIR/evil.js" }],
  ["an inner env that turns it off across timeout", "npm_config_ignore_scripts=true timeout 5 env npm_config_ignore_scripts=false npm pack | cat", { prepack: "node DIR/evil.js" }],
  ["an upper-case variable name", "NPM_CONFIG_IGNORE_SCRIPTS=true npm pack | cat", { prepack: "node DIR/evil.js" }],
  ["an upper-case value", "npm_config_ignore_scripts=TRUE npm pack | cat", { prepack: "node DIR/evil.js" }],
  ["an upper-case false after a lower-case true", "npm_config_ignore_scripts=true NPM_CONFIG_IGNORE_SCRIPTS=false npm pack | cat", { prepack: "node DIR/evil.js" }],
  ["an assignment after nice, which is a command word", "nice -n 5 npm_config_ignore_scripts=true npm pack | cat", { prepack: "node DIR/evil.js" }],
  ["an assignment after nice, no pipe", "nice -n 5 npm_config_ignore_scripts=true npm pack", { prepack: "node DIR/evil.js" }],
];

for (const [label, hook, scripts] of moreHolds) {
  for (const dir of ["docs", "test"] as const) {
    test(`${label} leaves the script on: a changed ${dir}/evil.js holds`, () => {
      const sc = Object.fromEntries(Object.entries(scripts).map(([k, v]) => [k, v.replace("DIR", dir)]));
      expect(holds(lifeRelease("0", hook, dir, sc), lifeRelease("1", hook, dir, sc)).length).toBeGreaterThan(0);
    });
  }
}

const moreQuiet: [string, string, Record<string, string>][] = [
  ["a separate true after the flag", "npm pack --ignore-scripts true | cat", { prepack: "node DIR/evil.js" }],
  ["an inner env that turns it on across nice", "npm_config_ignore_scripts=false nice -n 5 env npm_config_ignore_scripts=true npm pack | cat", { prepack: "node DIR/evil.js" }],
  ["an inner env that turns it on across timeout", "npm_config_ignore_scripts=false timeout 5 env npm_config_ignore_scripts=true npm pack | cat", { prepack: "node DIR/evil.js" }],
];

for (const [label, hook, scripts] of moreQuiet) {
  for (const dir of ["docs", "test"] as const) {
    test(`${label} stays quiet: a changed ${dir}/evil.js is not an install change`, () => {
      const sc = Object.fromEntries(Object.entries(scripts).map(([k, v]) => [k, v.replace("DIR", dir)]));
      expect(holds(lifeRelease("0", hook, dir, sc), lifeRelease("1", hook, dir, sc))).toEqual([]);
    });
  }
}

// env -i clears the variable, xargs keeps the assignments of its inner env, and pack and version run this package's scripts only
// for a directory spec or a version operand.
const clearHolds: [string, string, Record<string, string>][] = [
  ["env -i clears the setting", "npm_config_ignore_scripts=true env -i npm pack | cat", { prepack: "node DIR/evil.js" }],
  ["env - clears the setting", "npm_config_ignore_scripts=true env - npm pack | cat", { prepack: "node DIR/evil.js" }],
  ["env -u clears the setting", "npm_config_ignore_scripts=true env -u npm_config_ignore_scripts npm pack | cat", { prepack: "node DIR/evil.js" }],
  ["env -i clears the setting, no pipe", "npm_config_ignore_scripts=true env -i npm pack", { prepack: "node DIR/evil.js" }],
  ["an inner env under xargs that turns it off", "printf x | npm_config_ignore_scripts=true xargs env npm_config_ignore_scripts=false npm pack", { prepack: "node DIR/evil.js" }],
  ["version with a bump", "npm version patch | cat", { preversion: "node DIR/evil.js" }],
  ["version with a semver", "npm version 1.2.3 | cat", { preversion: "node DIR/evil.js" }],
  ["version from git", "npm version from-git | cat", { postversion: "node DIR/evil.js" }],
  ["pack of the current directory", "npm pack . | cat", { prepack: "node DIR/evil.js" }],
  ["pack of a local path", "npm pack ./sub | cat", { prepack: "node DIR/evil.js" }],
  ["pack with a destination", "npm pack --pack-destination out | cat", { prepack: "node DIR/evil.js" }],
];

for (const [label, hook, scripts] of clearHolds) {
  for (const dir of ["docs", "test"] as const) {
    test(`${label} runs the script: a changed ${dir}/evil.js holds`, () => {
      const sc = Object.fromEntries(Object.entries(scripts).map(([k, v]) => [k, v.replace("DIR", dir)]));
      expect(holds(lifeRelease("0", hook, dir, sc), lifeRelease("1", hook, dir, sc)).length).toBeGreaterThan(0);
    });
  }
}

const clearQuiet: [string, string, Record<string, string>][] = [
  ["a bare npm version", "npm version | cat", { preversion: "node DIR/evil.js" }],
  ["packing a registry package", "npm pack ms@2.1.3 | cat", { prepack: "node DIR/evil.js" }],
  ["packing a registry package by name", "npm pack ms | cat", { prepack: "node DIR/evil.js" }],
  ["packing a registry package after &&", "true && npm pack ms@2.1.3", { prepack: "node DIR/evil.js" }],
  ["an env that sets it again after -i", "npm_config_ignore_scripts=false env -i npm_config_ignore_scripts=true npm pack | cat", { prepack: "node DIR/evil.js" }],
  ["an inner env under xargs that turns it on", "printf x | npm_config_ignore_scripts=false xargs env npm_config_ignore_scripts=true npm pack", { prepack: "node DIR/evil.js" }],
];

for (const [label, hook, scripts] of clearQuiet) {
  for (const dir of ["docs", "test"] as const) {
    test(`${label} stays quiet: a changed ${dir}/evil.js is not an install change`, () => {
      const sc = Object.fromEntries(Object.entries(scripts).map(([k, v]) => [k, v.replace("DIR", dir)]));
      expect(holds(lifeRelease("0", hook, dir, sc), lifeRelease("1", hook, dir, sc))).toEqual([]);
    });
  }
}

// A `name@file:.` or `name@./` spec is a directory, a tarball path is not, env's assignments survive the plain path, and a bare
// `npm version` with only flags lists versions.
const specHolds: [string, string, Record<string, string>][] = [
  ["a scoped name at file:.", "npm pack @scope/x@file:. | cat", { prepack: "node DIR/evil.js" }],
  ["a name at file:., plain", "npm pack x@file:.", { prepack: "node DIR/evil.js" }],
  ["a name at ./", "npm pack x@./ | cat", { prepack: "node DIR/evil.js" }],
  ["a name at an absolute path", "npm pack x@/abs/dir | cat", { postpack: "node DIR/evil.js" }],
];

for (const [label, hook, scripts] of specHolds) {
  for (const dir of ["docs", "test"] as const) {
    test(`${label} is a directory spec: a changed ${dir}/evil.js holds`, () => {
      const sc = Object.fromEntries(Object.entries(scripts).map(([k, v]) => [k, v.replace("DIR", dir)]));
      expect(holds(lifeRelease("0", hook, dir, sc), lifeRelease("1", hook, dir, sc)).length).toBeGreaterThan(0);
    });
  }
}

const specQuiet: [string, string, Record<string, string>][] = [
  ["a tarball path", "npm pack ./x.tgz | cat", { prepack: "node DIR/evil.js" }],
  ["a tar.gz path", "npm pack ./x.tar.gz", { prepack: "node DIR/evil.js" }],
  ["a tar path", "npm pack ../x.tar | cat", { prepack: "node DIR/evil.js" }],
  ["env -i then the setting, plain", "env -i npm_config_ignore_scripts=true npm pack", { prepack: "node DIR/evil.js" }],
  ["env --ignore-environment then the setting, plain", "env --ignore-environment npm_config_ignore_scripts=true npm pack", { prepack: "node DIR/evil.js" }],
  ["env -i then the setting, piped", "env -i npm_config_ignore_scripts=true npm pack | cat", { prepack: "node DIR/evil.js" }],
  ["npm version with an unfamiliar flag", "npm version --timing | cat", { preversion: "node DIR/evil.js" }],
  ["npm version with --json", "npm version --json | cat", { preversion: "node DIR/evil.js" }],
];

for (const [label, hook, scripts] of specQuiet) {
  for (const dir of ["docs", "test"] as const) {
    test(`${label} stays quiet: a changed ${dir}/evil.js is not an install change`, () => {
      const sc = Object.fromEntries(Object.entries(scripts).map(([k, v]) => [k, v.replace("DIR", dir)]));
      expect(holds(lifeRelease("0", hook, dir, sc), lifeRelease("1", hook, dir, sc))).toEqual([]);
    });
  }
}

// Pack is quiet only when every operand is a literal registry spec or tarball path; a computed or local operand keeps the
// lifecycle, and any version operand (a range, a computed word, one after --) runs the version scripts.
const invHolds: [string, string, Record<string, string>][] = [
  ["a name at file:. with --dry-run", "npm pack q@file:. --dry-run", { prepack: "node DIR/evil.js" }],
  ["a name at . with --dry-run", "npm pack q@. --dry-run", { prepack: "node DIR/evil.js" }],
  ["a substituted directory", "npm pack $(pwd) --dry-run", { prepack: "node DIR/evil.js" }],
  ["a quoted variable directory", 'npm pack "$PWD" --dry-run', { prepack: "node DIR/evil.js" }],
  ["a directory with a trailing slash", "npm pack D/ --dry-run", { prepack: "node DIR/evil.js" }],
  ["a git spec", "npm pack user/repo --dry-run", { prepack: "node DIR/evil.js" }],
  ["a registry spec beside a directory", "npm pack ms@2.1.3 . --dry-run", { prepack: "node DIR/evil.js" }],
  ["a version with an equals sign", "npm version =1.0.2", { preversion: "node DIR/evil.js" }],
  ["a computed version", "V=minor; npm version $V", { preversion: "node DIR/evil.js" }],
  ["a version after --", "npm version -- patch", { preversion: "node DIR/evil.js" }],
];

for (const [label, hook, scripts] of invHolds) {
  for (const dir of ["docs", "test"] as const) {
    test(`${label} keeps the lifecycle: a changed ${dir}/evil.js holds`, () => {
      const sc = Object.fromEntries(Object.entries(scripts).map(([k, v]) => [k, v.replace("DIR", dir)]));
      expect(holds(lifeRelease("0", hook, dir, sc), lifeRelease("1", hook, dir, sc)).length).toBeGreaterThan(0);
    });
  }
}

const invQuiet: [string, string, Record<string, string>][] = [
  ["a registry spec", "npm pack ms@2.1.3 --dry-run", { prepack: "node DIR/evil.js" }],
  ["a scoped registry spec with a tag", "npm pack @scope/x@latest | cat", { prepack: "node DIR/evil.js" }],
  ["two registry specs", "npm pack ms@^2 chalk | cat", { prepack: "node DIR/evil.js" }],
  ["a tarball path", "npm pack ./x.tgz --dry-run", { prepack: "node DIR/evil.js" }],
];

for (const [label, hook, scripts] of invQuiet) {
  for (const dir of ["docs", "test"] as const) {
    test(`${label} stays quiet: a changed ${dir}/evil.js is not an install change`, () => {
      const sc = Object.fromEntries(Object.entries(scripts).map(([k, v]) => [k, v.replace("DIR", dir)]));
      expect(holds(lifeRelease("0", hook, dir, sc), lifeRelease("1", hook, dir, sc))).toEqual([]);
    });
  }
}
