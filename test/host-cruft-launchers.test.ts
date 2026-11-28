// `host --cruft-count` (OUP-372): a program, an env word or an argument string that runs another program is counted, not skipped as a binary or adopted.
import { describe, expect, test } from "bun:test";
import { cruftCount } from "../src/host/cruft.ts";

const owned = "#!/bin/sh\n# owner: me\n";
const ELF = "\u0000ELF";
type Over = {
  argv: string[];
  head?: (p: string) => string;
  links?: Record<string, string>; // path -> real path
  env?: Record<string, string>;
};
// One plist under /hm/x/Library/LaunchAgents; the number of wrappers counted. Every file is a binary unless `head` says otherwise.
const count = (o: Over) =>
  cruftCount({
    fs: {
      home: "/hm/x",
      listDir: async (d: string) => (d === "/hm/x/Library/LaunchAgents" ? ["t.plist"] : []),
      readHead: async (p: string, _n: number, meta?: { links?: number; dev?: number; ino?: number }) => {
        if (meta) Object.assign(meta, { links: 1, dev: 1, ino: 1 });
        return p.endsWith(".plist") ? "<plist/>" : o.head ? o.head(p) : ELF;
      },
      realPath: async (p: string) => o.links?.[p] ?? p,
      plistJson: async () => ({ ProgramArguments: o.argv, ...(o.env ? { EnvironmentVariables: o.env } : {}) }),
      pinFiles: () => [],
    },
    configDir: "/cfg", pinRoots: [], ownerlessConfigValues: [], adoptedScriptsDir: "/hm/x/scripts",
  }).then((c) => c.wrappers.length);

const OWN = "/hm/x/scripts/own.sh";
const script = (shebang: string, extra: Partial<Over> = {}) => count({ argv: [OWN], head: () => `${shebang}\n# owner: me\n`, ...extra });

describe("a program that is a link to a shell or interpreter (shape (a))", () => {
  for (const target of ["/bin/bash", "/bin/sh", "/bin/zsh", "/usr/bin/python3", "/usr/bin/perl", "/usr/local/bin/node", "/usr/bin/ruby"])
    test(`/opt/x/tool -> ${target} is counted`, async () => {
      expect(await count({ argv: ["/opt/x/tool", OWN], links: { "/opt/x/tool": target } })).toBe(1);
    });
  test("control: a link to a binary that is no interpreter is still skipped", async () => {
    expect(await count({ argv: ["/opt/x/tool", OWN], links: { "/opt/x/tool": "/opt/x/real-tool" } })).toBe(0);
  });
});

describe("a link named run to env or an interpreter", () => {
  for (const target of ["/usr/bin/env", "/bin/bash", "/bin/sh", "/usr/bin/python3"])
    test(`/opt/x/run -> ${target} is counted`, async () => {
      expect(await count({ argv: ["/opt/x/run", OWN], links: { "/opt/x/run": target } })).toBe(1);
    });
});

describe("launchers the list lacked", () => {
  for (const name of ["npm", "yarn", "bunx", "nawk", "pm2"])
    test(`/usr/local/bin/${name} is counted`, async () => {
      expect(await count({ argv: [`/usr/local/bin/${name}`, OWN] })).toBe(1);
    });
});

describe("a launcher named inside an argument string", () => {
  for (const arg of ["curl x | sh", "echo hi; bash", "nohup ./x", "x && python3 -c y", "$(env x)", "`dash`"])
    test(`-c ${JSON.stringify(arg)} is counted`, async () => {
      expect(await count({ argv: ["/opt/x/tool", "-c", arg] })).toBe(1);
    });
  test("control: an argument string with no launcher in it is still skipped", async () => {
    expect(await count({ argv: ["/opt/x/tool", "-c", "echo hello world"] })).toBe(0);
  });
});

describe("a script whose #! line runs a launcher through env", () => {
  for (const line of [
    "#!/usr/bin/env -Sdash",
    "#!/usr/bin/env -S dash",
    "#!/usr/bin/env -S 'dash' -e",
    "#!/usr/bin/env -S \"dash\" -e",
    "#!/usr/bin/env -S\"dash\"",
    "#!/usr/bin/env ./dash",
    "#!/usr/bin/env 'dash'",
    "#!./dash",
    "#!/usr/bin/env -S npm run x",
  ])
    test(`${line} is counted`, async () => {
      expect(await script(line)).toBe(1);
    });
  for (const line of ["#!/bin/sh", "#!/usr/bin/env bash", "#!/usr/bin/env -S python3 -u", "#!/usr/bin/env -i FOO=bar bash"])
    test(`control: ${line} is adopted`, async () => {
      expect(await script(line)).toBe(0);
    });
});

describe("an env word looked up on a known PATH", () => {
  const links = { "/usr/local/bin/run": "/bin/dash", "/usr/bin/run": "/bin/dash" };
  test("a bare word that is a link to a launcher in a PATH dir is counted", async () => {
    expect(await script("#!/usr/bin/env run", { links, env: { PATH: "/usr/local/bin:/usr/bin" } })).toBe(1);
  });
  test("with no PATH in the plist the launchd default dirs are looked in", async () => {
    expect(await script("#!/usr/bin/env run", { links })).toBe(1);
  });
  test("a bare word that is a link to an interpreter behind a name that is not one is counted", async () => {
    expect(await script("#!/usr/bin/env run", { links: { "/usr/bin/run": "/bin/bash" } })).toBe(1);
  });
  test("control: a versioned interpreter name that links to an interpreter is adopted", async () => {
    expect(await script("#!/usr/bin/env python3", { links: { "/usr/bin/python3": "/usr/bin/python3.12" } })).toBe(0);
  });
  test("the PATH of the plist decides where the word is looked up: /usr/bin is not searched when the PATH is /usr/local/bin", async () => {
    expect(await script("#!/usr/bin/env run", { links: { "/usr/bin/run": "/bin/dash" }, env: { PATH: "/usr/local/bin" } })).toBe(0);
  });
  test("control: a bare word that is nowhere on the PATH is adopted", async () => {
    expect(await script("#!/usr/bin/env run", { links: { "/opt/other/run": "/bin/dash" }, env: { PATH: "/usr/bin" } })).toBe(0);
  });
  test("control: a bare word that links to a plain program is adopted", async () => {
    expect(await script("#!/usr/bin/env run", { links: { "/usr/bin/run": "/usr/bin/true" } })).toBe(0);
  });
});
