import { describe, expect, test } from "bun:test";
import { installView } from "../src/install-closure.ts";
import { prepass } from "../src/prepass.ts";

const enc = new TextEncoder();
// The bin's file runs docs/evil.js; docs/ is left out of the plain widen, so only reading the bin's file reaches it.
const cli = '#!/usr/bin/env node\nconst cp = require("child_process");\ncp.spawnSync("node", ["./docs/evil.js"]);\n';
const view = (pj: Record<string, unknown>, files: Record<string, string> = {}) => {
  const o = { "package.json": JSON.stringify({ name: "@s/tool", version: "1.0.0", ...pj }), "bin/cli": cli, "docs/evil.js": "1;\n", "README.md": "x\n", ...files };
  return installView(new Map(Object.entries(o).map(([k, v]) => [k, enc.encode(v)])));
};
const reaches = (pj: Record<string, unknown>, files?: Record<string, string>) => view(pj, files).files.includes("docs/evil.js");
const tool = { bin: { tool: "bin/cli" } };

describe("a command that names one of the package's own bins runs that bin's file", () => {
  test.each([
    "tool",
    "tool --flag",
    "node_modules/.bin/tool",
    "../.bin/tool",
    "tool.cmd",
    "TOOL",
    "npx tool",
    "npx --no-install tool",
    "npx --cache /tmp/c tool",
    "npx --shell sh tool",
    "npx --tag latest tool",
    "npx --scope @s tool",
    "npx --tag --registry r tool",
    "npx --scope --registry r tool",
    "npx --tag -p x tool",
    "npx --tag tool",
    "npx --tag pnpm exec tool",
    "npx --tag npm exec tool",
    "bunx --scope npm exec tool",
    "npm --tag exec tool",
    "corepack --tag pnpm exec tool",
    "npx --scope yarn tool",
    "npx --scope tool",
    "bunx --tag tool",
    "npx --tag tool other",
    "npx --script-shell sh --tag latest tool",
    "npm exec tool",
    "yarn tool",
    "pnpm tool",
    "pnpm exec tool",
    "bunx tool",
    "bun x tool",
    "env A=1 tool",
    "sh -c tool",
  ])("postinstall %j with bin { tool: bin/cli }: the bin's file is read", (hook) => {
    expect(reaches({ ...tool, scripts: { postinstall: hook } })).toBe(true);
  });
  test("a bin string is named by the package name without its scope", () => {
    expect(reaches({ bin: "bin/cli", scripts: { postinstall: "tool" } })).toBe(true);
  });
  // npm names a string bin String(name) for a truthy name that is not a string (["tool"] -> .bin/tool, 7 -> .bin/7), as the bin stamp reads it. Fails at src/install-closure.ts ownBins (the string-bin branch needs a string name).
  test("a bin string of a package whose name is not a string is named by String(name)", () => {
    expect(reaches({ name: ["tool"], bin: "bin/cli", scripts: { postinstall: "tool" } })).toBe(true);
    expect(reaches({ name: 7, bin: "bin/cli", scripts: { postinstall: "7" } })).toBe(true);
  });
  test("control: a falsy name names no bin, and the name of another package is no bin of this one", () => {
    expect(reaches({ name: 0, bin: "bin/cli", scripts: { postinstall: "tool" } })).toBe(false);
    expect(reaches({ name: ["other"], bin: "bin/cli", scripts: { postinstall: "tool" } })).toBe(false);
    expect(reaches({ name: ["tool"], bin: { tool: "bin/cli" }, scripts: { postinstall: "tool" } })).toBe(true);
  });
  test("a .js target", () => {
    expect(reaches({ bin: { tool: "bin/cli.js" }, scripts: { postinstall: "tool" } }, { "bin/cli.js": cli })).toBe(true);
  });
  test("every file under directories.bin, by its base name", () => {
    expect(reaches({ directories: { bin: "bin" }, scripts: { postinstall: "cli" } })).toBe(true);
  });
  test("a bin whose file runs another bin by name", () => {
    expect(reaches({ bin: { a: "bin/a", tool: "bin/cli" }, scripts: { postinstall: "a" } }, { "bin/a": "#!/bin/sh\ntool\n" })).toBe(true);
  });
  test.each([
    'require("child_process").execSync("tool");',
    'require("child_process").execSync("A=1 tool --x && echo hi");',
    'require("child_process").spawnSync("tool", []);',
    'require("child_process").execFileSync("tool");',
    'require("child_process").execSync("npx tool");',
    'require("child_process").execSync("npx --shell sh tool");',
    'require("child_process").execSync("npx --tag tool");',
    'require("child_process").execSync("npx --tag pnpm exec tool");',
    'require("child_process").spawnSync("npx", ["--tag", "pnpm", "exec", "tool"]);',
    'require("child_process").execSync("npx --scope npm exec tool");',
    'require("child_process").spawnSync("npx", ["--scope", "tool"]);',
    'require("child_process").execSync("pnpm exec tool");',
    'require("child_process").execSync("bunx tool");',
    'require("child_process").spawnSync("bunx", ["tool"]);',
  ])("a hook file that runs %s: the bin's file is read", (code) => {
    expect(reaches({ ...tool, scripts: { postinstall: "node hook.js" } }, { "hook.js": `${code}\n` })).toBe(true);
  });
  test.each([
    ["no bin of that name", { scripts: { postinstall: "tool" } }, {}],
    ["the name only as an argument", { ...tool, scripts: { postinstall: "cp tool x" } }, {}],
    ["the name only echoed", { ...tool, scripts: { postinstall: "echo tool" } }, {}],
    ["a longer name", { ...tool, scripts: { postinstall: "toolx" } }, {}],
    ["the name only printed by a hook file", { ...tool, scripts: { postinstall: "node hook.js" } }, { "hook.js": 'console.log("tool");\n' }],
    ["the name only echoed by a hook file", { ...tool, scripts: { postinstall: "node hook.js" } }, { "hook.js": 'require("child_process").execSync("echo tool");\n' }],
  ] as const)("control, as on main: %s", (_, pj, files) => {
    expect(reaches(pj, files)).toBe(false);
  });
});

describe("a bin is read as its own process, only where it runs", () => {
  const cdBin = { "bin/x": "#!/bin/sh\ncd sub\n", "docs/x.js": "1;\n", "sub/a.js": "1;\n" };
  const hasX = (pj: Record<string, unknown>) => view(pj, cdBin).files.includes("docs/x.js");
  test.each([
    [{ bin: { node: "bin/x" }, scripts: { postinstall: "node lib/../docs/x.js" } }],
    [{ bin: { tool: "bin/x" }, scripts: { postinstall: "tool && node lib/../docs/x.js" } }],
  ])("a cd in a bin does not move the commands after it: %j", (pj) => {
    expect(hasX(pj)).toBe(true);
  });
  test.each([
    ["bin/cli.js", "const m = process.argv.length > 2 ? 1 : 0;\nconst a = [m][0];\n"],
    ["bin/tool", "#!/usr/bin/env node\nconst m = process.argv.length > 2 ? 1 : 0;\nconst a = [m][0];\n"],
    ["bin/tool", "#!/usr/bin/env -S node --no-warnings\nconst m = process.argv.length > 2 ? 1 : 0;\nconst a = [m][0];\n"],
    ["bin/tool", "#!/usr/bin/env FOO=1 node\nconst m = process.argv.length > 2 ? 1 : 0;\nconst a = [m][0];\n"],
    ["bin/tool", "#!/usr/local/bin/node\nconst m = process.argv.length > 2 ? 1 : 0;\nconst a = [m][0];\n"],
  ])("a clean JavaScript bin (%s) with ? and [ is read as node reads it: no hold", (target, body) => {
    for (const hook of ["tool", "npx tool"]) {
      const v = view({ bin: { tool: target }, scripts: { postinstall: hook } }, { [target]: body });
      expect(v.hold).toBeUndefined();
      expect(v.files).toContain(target);
    }
  });
  test.each([
    ["npm run build -- tool", { build: "echo" }],
    ["npx -p tool other", {}],
    ["yarn add tool", {}],
    ["npm exec other -- tool", {}],
    ["pnpm --filter tool build", { build: "echo" }],
  ])("control: an argument that only shares the bin's name: %s", (hook, more) => {
    expect(reaches({ ...tool, scripts: { postinstall: hook, ...more } })).toBe(false);
  });
  test.each([
    'require("child_process").execSync("npx -p tool other");',
    'require("child_process").spawnSync("npx", ["-p", "tool", "other"]);',
    'require("child_process").execSync("npm run build -- tool");',
  ])("control: a scanned file passes the name only as an argument: %s", (code) => {
    expect(reaches({ ...tool, scripts: { postinstall: "node hook.js" } }, { "hook.js": `${code}\n` })).toBe(false);
  });
  test("control: a bin named like a shell builtin is not run by the builtin", () => {
    expect(reaches({ bin: { echo: "bin/cli" }, scripts: { postinstall: "echo hello" } })).toBe(false);
    expect(reaches({ bin: { echo: "bin/cli" }, scripts: { postinstall: "node hook.js" } }, { "hook.js": 'require("child_process").execSync("echo hello");\n' })).toBe(false);
  });
  test.each(['require("child_process").execSync("npx --yes tool");', 'require("child_process").execSync("npx -y tool");', 'require("child_process").execSync("nohup tool");'])(
    "a scanned file runs the bin after runner options: %s",
    (code) => {
      expect(reaches({ ...tool, scripts: { postinstall: "node hook.js" } }, { "hook.js": `${code}\n` })).toBe(true);
    },
  );
  test.each([[{ bin: { tool: "bin/../bin/cli" } }], [{ directories: { bin: "bin/" } }], [{ directories: { bin: "./bin/" } }]])("bin paths as npm resolves them: %j", (pj) => {
    const name = "bin" in pj ? "tool" : "cli";
    expect(reaches({ ...pj, scripts: { postinstall: name } })).toBe(true);
  });
});

describe("the command of a runner in a scanned file", () => {
  test.each([
    'require("child_process").execSync("npm exec -- tool");',
    'require("child_process").execSync("npm x --yes tool");',
    'require("child_process").execSync("npx yarn tool");',
    'require("child_process").execSync("corepack pnpm exec tool");',
  ])("%s runs the bin", (code) => {
    expect(reaches({ ...tool, scripts: { postinstall: "node hook.js" } }, { "hook.js": `${code}\n` })).toBe(true);
  });
  test("control: a bin named like a package manager's own command is not run by it", () => {
    expect(reaches({ bin: { install: "bin/cli" }, scripts: { postinstall: "node hook.js" } }, { "hook.js": 'require("child_process").execSync("yarn install");\n' })).toBe(false);
  });
});

describe("a script of the same name runs first where the package manager says so", () => {
  const withScript = { ...tool, scripts: { postinstall: "node hook.js", tool: "echo hi" } };
  test.each([
    'require("child_process").execSync("yarn tool");',
    'require("child_process").execSync("pnpm tool");',
    'require("child_process").execSync("yarn run tool");',
    'require("child_process").spawnSync("bun", ["run", "tool"]);',
    'require("child_process").spawnSync("yarn", ["tool"]);',
  ])("control: %s with a script named tool runs the script, not the bin", (code) => {
    expect(reaches(withScript, { "hook.js": `${code}\n` })).toBe(false);
  });
  test.each(['require("child_process").execSync("yarn tool");', 'require("child_process").spawnSync("bun", ["run", "tool"]);', 'require("child_process").execSync("npx tool");'])(
    "%s with no script of that name runs the bin",
    (code) => {
      expect(reaches({ ...tool, scripts: { postinstall: "node hook.js" } }, { "hook.js": `${code}\n` })).toBe(true);
    },
  );
  test("npx runs the bin even when a script has its name", () => {
    expect(reaches(withScript, { "hook.js": 'require("child_process").execSync("npx tool");\n' })).toBe(true);
  });
  test.each(['require("child_process").execSync("npx --tag tool yarn tool");', 'require("child_process").execSync("npx --scope tool yarn tool");'])("%s with a script named tool still reads the bin", (code) => {
    expect(reaches(withScript, { "hook.js": `${code}\n` })).toBe(true);
  });
});

describe("a bin is read by its shebang", () => {
  test.each([
    ["bin/x.js", "#!/bin/sh\nnode docs/evil.js\n"],
    ["bin/x.js", "#!/usr/bin/env -S sh # node\nnode docs/evil.js\n"],
    ["bin/x", "#!/usr/bin/env bash\nnode docs/evil.js\n"],
    ["bin/x.js", 'require("child_process").spawnSync("node", ["./docs/evil.js"]);\n'],
    ["bin/x.js", "#!\nnode docs/evil.js\n"],
    ["bin/x", "#!/usr/bin/env -S node --no-warnings\nrequire('child_process').spawnSync('node', ['./docs/evil.js']);\n"],
    ["bin/x", "#!/usr/bin/env FOO=1 node\nrequire('child_process').spawnSync('node', ['./docs/evil.js']);\n"],
  ])("%s %j: the file its interpreter runs is read", (target, body) => {
    expect(reaches({ bin: { tool: target }, scripts: { postinstall: "tool" } }, { [target]: body })).toBe(true);
  });
  test.each([
    ["npm", "npm install"],
    ["npx", "npx other"],
    ["yarn", "yarn"],
    ["pnpm", "pnpm install"],
  ])("a bin named %s runs in place of the runner: %s", (name, hook) => {
    expect(reaches({ bin: { [name]: "bin/cli" }, scripts: { postinstall: hook } })).toBe(true);
  });
  test("a bin named npm runs in place of npm in a scanned file too", () => {
    expect(reaches({ bin: { npm: "bin/cli" }, scripts: { postinstall: "node hook.js" } }, { "hook.js": 'require("child_process").execSync("npm install");\n' })).toBe(true);
  });
});

describe("a node shebang's own words run with the bin", () => {
  test.each([
    "#!/usr/bin/env -S node --require ./docs/evil.js",
    "#!/usr/bin/env -S NODE_OPTIONS=--require=./docs/evil.js node",
    "#!/usr/local/bin/node --require=./docs/evil.js",
    "#!/usr/bin/env -S node -e 'require(\"./docs/evil\")'",
    "#!/usr/bin/env -S -u UNUSED node --require ./docs/evil.js",
    "#!/usr/bin/env --split-string=node --require ./docs/evil.js",
    "#!/usr/bin/env -S node --require \"./docs/evil.js\"",
  ])("%s: the file it loads is read", (shebang) => {
    expect(reaches({ bin: { tool: "bin/x.js" }, scripts: { postinstall: "tool" } }, { "bin/x.js": `${shebang}\n1;\n` })).toBe(true);
  });
});

describe("env options that take a value are not the interpreter", () => {
  // Valid JS that a shell reading would hold on; read as node it is clean.
  const body = "const m = process.argv.length > 2 ? 1 : 0;\nconst a = [m][0];\n";
  test.each([
    "#!/usr/bin/env -S -u UNUSED node",
    "#!/usr/bin/env -S --unset UNUSED node",
    "#!/usr/bin/env -S --unset=UNUSED node",
    "#!/usr/bin/env -S -C . node",
    "#!/usr/bin/env -S --chdir . node",
    "#!/usr/bin/env -S -P /usr/bin node",
    "#!/usr/bin/env -S -iu UNUSED node",
    "#!/usr/bin/env --split-string=node",
    "#!/usr/bin/env -Snode",
  ])("control: %s reads the bin as node, no hold", (shebang) => {
    const v = view({ bin: { tool: "bin/x" }, scripts: { postinstall: "tool" } }, { "bin/x": `${shebang}\n${body}` });
    expect(v.hold).toBeUndefined();
  });
});

describe("a runner's arguments and a shell builtin never name a bin (no signal on a docs-only update, as on main)", () => {
  const harmless = '#!/usr/bin/env node\nconsole.log("hello");\n';
  const signal = (pj: Record<string, unknown>, files: Record<string, string> = {}) => {
    const o = { "package.json": JSON.stringify({ name: "sample", ...pj }), "bin/cli": harmless, "docs/guide.md": "old", ...files };
    const m = (x: Record<string, string>) => new Map(Object.entries(x).map(([k, v]) => [k, enc.encode(v)]));
    return prepass("npm", m(o), m({ ...o, "docs/guide.md": "new" })).hard.length;
  };
  test.each([
    ["echo", "echo hello"],
    ["printf", "printf hello"],
  ])("control: a bin named %s with postinstall %j runs the builtin", (name, hook) => {
    expect(signal({ bin: { [name]: "bin/cli" }, scripts: { postinstall: hook } })).toBe(0);
  });
  test.each(["npm run build -- tool", "npx -p tool other", "npm exec other -- tool", "pnpm --filter tool build", "yarn add tool"])("control: postinstall %j", (hook) => {
    expect(signal({ bin: { tool: "bin/cli" }, scripts: { postinstall: hook, build: "echo hello" } })).toBe(0);
  });
  test.each([
    'require("child_process").execSync("npx -p tool other");',
    'require("child_process").execSync("npx other tool");',
    'require("child_process").spawnSync("npx", ["other", "tool"]);',
    'require("child_process").spawnSync("npx", ["-p", "tool", "other"]);',
    'require("child_process").execSync("echo hello");',
  ])("control: a hook file running %s", (code) => {
    const bin = code.includes("echo") ? { echo: "bin/cli" } : { tool: "bin/cli" };
    expect(signal({ bin, scripts: { postinstall: "node hook.js" } }, { "hook.js": `${code}\n` })).toBe(0);
  });
});

describe("nested runners, per-manager commands and wrappers", () => {
  const evil = 'require("child_process").spawnSync("node", ["./docs/evil.js"]);\n';
  test.each([
    [{ npm: "bin/x.js" }, "npx npm install"],
    [{ yarn: "bin/x.js" }, "npx yarn tool"],
    [{ build: "bin/x.js" }, "yarn build"],
    [{ test: "bin/x.js" }, "yarn test"],
  ])("postinstall with bin %j and %j runs the bin", (bin, hook) => {
    expect(reaches({ bin, scripts: { postinstall: hook } }, { "bin/x.js": evil })).toBe(true);
  });
  test.each(["npx npm install", "env -i -u X tool", "env -C sub tool", "nice -n 5 tool", "timeout -s KILL 10 tool", "sudo -u x tool", "xargs -n 1 tool", "yarn build"])(
    "a hook file running %j runs the bin",
    (cmd) => {
      const bin = cmd.startsWith("npx npm") ? { npm: "bin/x.js" } : cmd === "yarn build" ? { build: "bin/x.js" } : { tool: "bin/x.js" };
      expect(reaches({ bin, scripts: { postinstall: "node hook.js" } }, { "bin/x.js": evil, "hook.js": `require("child_process").execSync(${JSON.stringify(cmd)});\n` })).toBe(true);
    },
  );
  test.each([
    [{ build: "bin/x.js" }, "bun build"],
    [{ test: "bin/x.js" }, "pnpm test"],
    [{ build: "bin/x.js" }, "yarn build"],
  ])("control: bin %j, %j is the manager's own command or a script", (bin, hook) => {
    const scripts: Record<string, string> = { postinstall: "node hook.js" };
    if (hook === "yarn build") scripts.build = "echo hi";
    expect(reaches({ bin, scripts }, { "bin/x.js": evil, "hook.js": `require("child_process").execSync(${JSON.stringify(hook)});\n` })).toBe(false);
  });
});

describe("a bin is read once, in the widest context", () => {
  test("a bin first reached under npm_config_ignore_scripts is read with its pre scripts, so a later plain run of it is covered", () => {
    const pj = {
      bin: { tool: "bin/x" },
      scripts: { postinstall: "npm_config_ignore_scripts=true npm run a; sh bin/x", a: "tool", evil: "echo hi", preevil: "node docs/evil.js" },
    };
    expect(reaches(pj, { "bin/x": "#!/bin/sh\nnpm run evil\n" })).toBe(true);
  });
  test("the same with no flags: tool; nohup sh bin/x", () => {
    const pj = { bin: { tool: "bin/x" }, scripts: { postinstall: "tool; nohup sh bin/x", evil: "echo hi", preevil: "node docs/evil.js" } };
    expect(reaches(pj, { "bin/x": "#!/bin/sh\nnpm_config_ignore_scripts=true npm run evil\n" })).toBe(true);
  });
});

describe("a lookup, help or version runs nothing (no signal on a docs-only update, as on main)", () => {
  const harmless = '#!/usr/bin/env node\nconsole.log("hello");\n';
  const signal = (pj: Record<string, unknown>, files: Record<string, string> = {}) => {
    const o = { "package.json": JSON.stringify({ name: "sample", ...pj }), "bin/cli": harmless, "docs/guide.md": "old", ...files };
    const m = (x: Record<string, string>) => new Map(Object.entries(x).map(([k, v]) => [k, enc.encode(v)]));
    return prepass("npm", m(o), m({ ...o, "docs/guide.md": "new" })).hard.length;
  };
  const cmds = ["command -v tool", "command -V tool", "sudo -l tool", "sudo -ll tool", "npx --version tool", "npx --help tool", "npx -v tool", "npm exec --help tool"];
  test.each(cmds)("control: postinstall %j", (hook) => {
    expect(signal({ bin: { tool: "bin/cli" }, scripts: { postinstall: hook } })).toBe(0);
  });
  test.each(cmds)("control: a hook file running execSync(%j)", (cmd) => {
    expect(signal({ bin: { tool: "bin/cli" }, scripts: { postinstall: "node hook.js" } }, { "hook.js": `require("child_process").execSync(${JSON.stringify(cmd)});\n` })).toBe(0);
  });
});

describe("more env shebang forms read the bin as node", () => {
  const body = "const m = process.argv.length > 2 ? 1 : 0;\nconst a = [m][0];\n";
  test.each(["#!/usr/bin/env -S'node --no-warnings'", '#!/usr/bin/env -S"node --no-warnings"', "#!/usr/bin/env - node", "#!/usr/bin/env -S --unse UNUSED node", "#!/usr/bin/env -S --chd . node"])(
    "control: %s reads the bin as node, no hold",
    (shebang) => {
      expect(view({ bin: { tool: "bin/x" }, scripts: { postinstall: "tool" } }, { "bin/x": `${shebang}\n${body}` }).hold).toBeUndefined();
    },
  );
});

describe("a lookup covers the whole command it looks up", () => {
  const harmless = '#!/usr/bin/env node\nconsole.log("hello");\n';
  const signal = (pj: Record<string, unknown>, files: Record<string, string> = {}) => {
    const o = { "package.json": JSON.stringify({ name: "sample", ...pj }), "bin/cli": harmless, "docs/guide.md": "old", ...files };
    const m = (x: Record<string, string>) => new Map(Object.entries(x).map(([k, v]) => [k, enc.encode(v)]));
    return prepass("npm", m(o), m({ ...o, "docs/guide.md": "new" })).hard.length;
  };
  const cmds = ["command -v npm exec tool", "env --help npm exec tool", "xargs --help npm exec tool", "sudo -u x -l tool", "sudo -l env tool", "sudo -l npx tool", "env --help sh -c tool"];
  test.each(cmds)("control: postinstall %j", (hook) => {
    expect(signal({ bin: { tool: "bin/cli" }, scripts: { postinstall: hook } })).toBe(0);
  });
  test.each(cmds)("control: a hook file running execSync(%j)", (cmd) => {
    expect(signal({ bin: { tool: "bin/cli" }, scripts: { postinstall: "node hook.js" } }, { "hook.js": `require("child_process").execSync(${JSON.stringify(cmd)});\n` })).toBe(0);
  });
  const evil = 'require("child_process").spawnSync("node", ["./docs/evil.js"]);\n';
  test.each(["sudo -k tool", "sudo --reset-timestamp tool", "sudo -uwill tool", "sudo -p -l tool"])("%j runs the command: the bin is read", (cmd) => {
    expect(reaches({ bin: { tool: "bin/x.js" }, scripts: { postinstall: cmd } }, { "bin/x.js": evil })).toBe(true);
    expect(reaches({ bin: { tool: "bin/x.js" }, scripts: { postinstall: "node hook.js" } }, { "bin/x.js": evil, "hook.js": `require("child_process").execSync(${JSON.stringify(cmd)});\n` })).toBe(true);
  });
});

describe("a lookup marks nothing as read for a later real run", () => {
  const evil = 'require("child_process").spawnSync("node", ["./docs/evil.js"]);\n';
  test.each([
    { postinstall: "sudo -l npm run a; npm run a", a: "tool" },
    { postinstall: "env --help npm run a; npm run a", a: "tool" },
    { postinstall: "npm exec --help npm run a; npm run a", a: "tool" },
    { postinstall: "sudo -l npm run a; npm run b", a: "tool", b: "npm run a" },
    { postinstall: "command -v npm run a; npm run a", a: "tool" },
    { postinstall: "sudo -l sh run.sh; sh run.sh" },
  ])("%j: the later run reads the bin", (scripts) => {
    expect(reaches({ bin: { tool: "bin/x.js" }, scripts }, { "bin/x.js": evil, "run.sh": "tool\n" })).toBe(true);
  });
  test.each([
    ["dev", "command dev"],
    ["vtool", "command vtool"],
  ])("a bin named %s run as %j is read (a command word is no option)", (name, hook) => {
    expect(reaches({ bin: { [name]: "bin/x.js" }, scripts: { postinstall: hook } }, { "bin/x.js": evil })).toBe(true);
  });
  const harmless = '#!/usr/bin/env node\nconsole.log("hello");\n';
  test.each(["nohup sudo -l tool", "env sudo -l tool", "nice -n 5 command -v tool"])("control: postinstall %j reads no bin (no signal, as on main)", (hook) => {
    const o = { "package.json": JSON.stringify({ name: "sample", bin: { tool: "bin/cli" }, scripts: { postinstall: hook } }), "bin/cli": harmless, "docs/guide.md": "old" };
    const m = (x: Record<string, string>) => new Map(Object.entries(x).map(([k, v]) => [k, enc.encode(v)]));
    expect(prepass("npm", m(o), m({ ...o, "docs/guide.md": "new" })).hard.length).toBe(0);
  });
});

describe("lookups keep their own read-once records", () => {
  const timed = (n: number) => {
    const scripts = { postinstall: Array.from({ length: n }, () => "sudo -l npm run a").join("; "), a: Array.from({ length: n }, () => "echo ok").join("; ") };
    const files = new Map(Object.entries({ "package.json": JSON.stringify({ name: "s", bin: { tool: "bin/cli" }, scripts }), "bin/cli": "1;\n" }).map(([k, v]) => [k, enc.encode(v)]));
    const t = performance.now();
    installView(files);
    return performance.now() - t;
  };
  test("many lookups of one script read it once under a lookup (linear growth)", () => {
    timed(100);
    const best = (n: number) => Math.min(timed(n), timed(n));
    let ratio = Infinity;
    for (let a = 0; a < 3 && ratio >= 9; a++) ratio = best(1600) / Math.max(best(400), 5);
    expect(ratio).toBeLessThan(9);
  }, 60000);
  test("a script read under a lookup and then for real counts once toward the script limit", () => {
    const scripts: Record<string, string> = {};
    const parts: string[] = [];
    for (let k = 0; k < 63; k++) {
      scripts[`a${k}`] = "echo ok";
      parts.push(`sudo -l npm run a${k}`);
    }
    scripts.postinstall = [...parts, "npm run a0"].join("; ");
    expect(view({ bin: { tool: "bin/cli" }, scripts }).hold).toBeUndefined();
  });
});

describe("a lookup read counts as main counts it, and blocks no later hop", () => {
  test("sudo -l node hook.js; node hook.js: the real run follows hook.js -> tool (sh) -> tool2", () => {
    const pj = { bin: { tool: "bin/t.sh", tool2: "bin/t2.js" }, scripts: { postinstall: "sudo -l node hook.js; node hook.js" } };
    const files = {
      "hook.js": 'require("child_process").execSync("tool");\n',
      "bin/t.sh": "#!/bin/sh\ntool2\n",
      "bin/t2.js": 'require("child_process").spawnSync("node", ["./docs/evil.js"]);\n',
    };
    expect(reaches(pj, files)).toBe(true);
  });
  test("sh files read under a lookup count toward the sh-file cap, so the hold main gives stays", () => {
    const files: Record<string, string> = {};
    const parts: string[] = [];
    for (let k = 0; k < 70; k++) {
      files[`s${k}.sh`] = "echo ok\n";
      parts.push(`sudo -l sh s${k}.sh`);
    }
    const v = view({ bin: { tool: "bin/cli" }, scripts: { postinstall: parts.join("; ") } }, files);
    expect(v.hold ?? "none").not.toBe("none");
  });
});

describe("the sh-file cap counts each file once across lookups and real runs", () => {
  const shRun = (parts: string[], n: number) => {
    const files: Record<string, string> = {};
    for (let k = 0; k < n; k++) files[`s${k}.txt`] = "echo ok\n";
    return view({ bin: { tool: "bin/cli" }, scripts: { postinstall: parts.join("; ") } }, files);
  };
  const looked = Array.from({ length: 64 }, (_, k) => `sudo -l sh s${k}.txt`);
  test("64 looked-up sh files, then a real run of one of them: no hold, as on main", () => {
    expect(shRun([...looked, "sh s0.txt"], 64).hold).toBeUndefined();
  });
  test("a real run of one sh file, then 64 looked-up ones including it: no hold, as on main", () => {
    expect(shRun(["sh s0.txt", ...looked], 64).hold).toBeUndefined();
  });
  test("40 looked-up and 30 real sh files hold at the sh-file cap, as on main (each file counts once, in either group)", () => {
    const parts = Array.from({ length: 70 }, (_, k) => (k < 40 ? `sudo -l sh s${k}.txt` : `sh s${k}.txt`));
    expect(shRun(parts, 70).hold ?? "none").not.toBe("none");
  });
  test("70 looked-up sh files hold at the sh-file cap, as on main", () => {
    expect(shRun(Array.from({ length: 70 }, (_, k) => `sudo -l sh s${k}.txt`), 70).hold ?? "none").not.toBe("none");
  });
});
