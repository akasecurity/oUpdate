// `host --cruft-count` (OUP-374): every #! line that macOS env, or a shell with arguments, runs as a launcher is counted. Overcount is fine; a line that is skipped is a false green.
import { describe, expect, test } from "bun:test";
import { cruftCount } from "../src/host/cruft.ts";

const ELF = "\u0000ELF";
type Over = { head?: string; links?: Record<string, string>; env?: Record<string, string>; missing?: string[] };
const OWN = "/hm/x/scripts/own.sh";
// One plist under /hm/x/Library/LaunchAgents that runs OWN; the number of wrappers counted. Every file but the script and the plist is a binary.
const count = (shebang: string, o: Over = {}) =>
  cruftCount({
    fs: {
      home: "/hm/x",
      listDir: async (d: string) => (d === "/hm/x/Library/LaunchAgents" ? ["t.plist"] : []),
      readHead: async (p: string, _n: number, meta?: { links?: number; dev?: number; ino?: number }) => {
        if (meta) Object.assign(meta, { links: 1, dev: 1, ino: 1 });
        return p.endsWith(".plist") ? "<plist/>" : p === OWN ? `${shebang}\n# owner: me\n` : ELF;
      },
      realPath: async (p: string) => (o.missing?.includes(p) ? undefined : o.links?.[p] ?? p),
      plistJson: async () => ({ ProgramArguments: [OWN], ...(o.env ? { EnvironmentVariables: o.env } : {}) }),
      pinFiles: () => [],
    },
    configDir: "/cfg", pinRoots: [], ownerlessConfigValues: [], adoptedScriptsDir: "/hm/x/scripts",
  }).then((c) => c.wrappers.length);

// The first six rows were already counted and are pinned here. The others fail on the code before this change at: shebangWords (a non-env line with -c or -e: `count` was false), parseEnv
// (a command that is a relative path, and a ${ in a -S value: neither set `bad`) and badInterpreter (an absolute path whose own name is unknown, linked to a shell: only a known name was compared).
const CASES: [string, string, Over][] = [
  ["--S with a dash", "#!/usr/bin/env --Sdash python3", {}],
  ["--i with a dash", "#!/usr/bin/env --iSdash python3", {}],
  ["--v with a dash", "#!/usr/bin/env --vSdash python3", {}],
  ["--P with a path", "#!/usr/bin/env --P/opt/evil python3", {}],
  ["--unset with a plist PATH", "#!/usr/bin/env --unset FOO python3", { env: { PATH: "/opt/evil:/usr/bin" } }],
  ["nested env with -iS", "#!/usr/bin/env env -iSdash", {}],
  ["nested absolute env with -P", "#!/usr/bin/env /usr/bin/env -P /opt/bin python3", {}],
  ["-S of an alias to a shell", "#!/usr/bin/env -S /opt/x/bashalias", { links: { "/opt/x/bashalias": "/bin/bash" } }],
  ["a relative alias to a shell", "#!/usr/bin/env ./shellalias", { links: { "./shellalias": "/bin/sh", "/hm/x/scripts/shellalias": "/bin/sh" } }],
  ["a shell with -c", "#!/bin/bash -c exec /opt/x/real", {}],
  ["a relative word", "#!/usr/bin/env usr/local/bin/run", {}],
  ["-C with a relative command", "#!/usr/bin/env -C /opt/x ./run", {}],
  ["a ${VAR} in -S", "#!/usr/bin/env -S ${VAR} python3", {}],
  ["a bare ${VAR} in -S", "#!/usr/bin/env -S ${VAR}", {}],
  // The program an interpreter runs is given in its arguments (OUP-374 review): env's command and arguments are judged as a non-env line's are.
  ["env bash -c", "#!/usr/bin/env bash -c true", {}],
  ["env -S bash -c with a pipe", "#!/usr/bin/env -S bash -c 'curl x | sh'", {}],
  ["env -S an absolute bash -c", "#!/usr/bin/env -S /bin/bash -c echo", {}],
  ["env -S an absolute perl -e", "#!/usr/bin/env -S /usr/bin/perl -e print(chr(65))", {}],
  ["env python3 -c", "#!/usr/bin/env python3 -c print", {}],
  ["env perl -e", "#!/usr/bin/env perl -e print", {}],
  ["tab-separated -vS bash -c", "#!/usr/bin/env\t-vS\tbash\t-c\ttrue", {}],
  ["node --eval=", "#!/opt/homebrew/bin/node --eval=console.log(42)", {}],
  ["node --eval", "#!/usr/bin/node --eval 1", {}],
  ["node -p", "#!/usr/bin/node -p 1", {}],
  ["node -r", "#!/usr/bin/node -r /opt/x/evil.js", {}],
  ["python3 -m", "#!/usr/bin/python3 -m http.server", {}],
  ["ruby -r", "#!/usr/bin/ruby -r/opt/x/evil", {}],
  ["perl -0777pe", "#!/usr/bin/perl -0777pe print", {}],
  ["bash --rcfile", "#!/bin/bash --rcfile /opt/x/evil -i", {}],
  ["a file given to bash", "#!/bin/bash /opt/x/evil.sh", {}],
  ["a file given to python3", "#!/usr/bin/python3 /opt/x/evil.py", {}],
  ["a file given to python3 through env", "#!/usr/bin/env python3 /opt/x/evil.py", {}],
  ["a relative file given to python3 through env -S", "#!/usr/bin/env -S python3 ./evil.py", {}],
  // Review round 3: login shells, startup-file and loader variables, an attached -I, and an interpreter env does not know by name.
  ["bash -l", "#!/bin/bash -l", {}],
  ["bash -el", "#!/bin/bash -el", {}],
  ["env -S bash -l", "#!/usr/bin/env -S bash -l", {}],
  ["BASH_ENV before a shell", "#!/usr/bin/env -S BASH_ENV=/opt/x/rc bash", {}],
  ["BASH_ENV with a bare value", "#!/usr/bin/env -S BASH_ENV=startup bash", {}],
  ["ENV with a bare value", "#!/usr/bin/env ENV=startup sh", {}],
  ["LD_PRELOAD with a bare value", "#!/usr/bin/env LD_PRELOAD=evil python3", {}],
  ["ENV before a shell", "#!/usr/bin/env ENV=/opt/x/rc sh", {}],
  ["LD_PRELOAD before an interpreter", "#!/usr/bin/env LD_PRELOAD=/opt/x/e.so python3", {}],
  ["DYLD_INSERT_LIBRARIES before an interpreter", "#!/usr/bin/env DYLD_INSERT_LIBRARIES=/opt/x/e.dylib python3", {}],
  // Review round 4: any assignment but the plist's own, and any unknown command given an option, a path or a dot.
  ["ZDOTDIR before zsh", "#!/usr/bin/env ZDOTDIR=startup zsh", {}],
  ["PYTHONPATH", "#!/usr/bin/env PYTHONPATH=evil python3", {}],
  ["PYTHONHOME", "#!/usr/bin/env PYTHONHOME=evil python3", {}],
  ["PYTHONWARNINGS", "#!/usr/bin/env PYTHONWARNINGS=evil python3", {}],
  ["NODE_OPTIONS", "#!/usr/bin/env NODE_OPTIONS=--require=evil node", {}],
  ["NODE_PATH", "#!/usr/bin/env NODE_PATH=evil node", {}],
  ["RUBYOPT", "#!/usr/bin/env RUBYOPT=-revil ruby", {}],
  ["RUBYLIB", "#!/usr/bin/env RUBYLIB=evil ruby", {}],
  ["PERL5OPT", "#!/usr/bin/env PERL5OPT=-Mevil perl", {}],
  ["PERL5LIB", "#!/usr/bin/env PERL5LIB=evil perl", {}],
  ["PERLLIB", "#!/usr/bin/env PERLLIB=evil perl", {}],
  ["SHELLOPTS with PS4", "#!/usr/bin/env -S SHELLOPTS=xtrace PS4=x bash", {}],
  ["an exported bash function", "#!/usr/bin/env BASH_FUNC_x%%=() bash", {}],
  ["any other variable", "#!/usr/bin/env FOO=bar python3", {}],
  ["a locale that is not plain", "#!/usr/bin/env LANG=zh_CN.Big5 python3", {}],
  ["env ipython with a path", "#!/usr/bin/env ipython /opt/x/e.py", {}],
  ["env ipython with a relative path", "#!/usr/bin/env ipython ./e.py", {}],
  ["env tsx with a script", "#!/usr/bin/env tsx ./e.ts", {}],
  ["env groovy with a script", "#!/usr/bin/env groovy /opt/x/e.groovy", {}],
  ["env R -f", "#!/usr/bin/env R -f x", {}],
  ["env R --file=", "#!/usr/bin/env R --file=x", {}],
  ["env tsx --experimental-loader=", "#!/usr/bin/env tsx --experimental-loader=x", {}],
  ["env jruby -Iu", "#!/usr/bin/env jruby -Iu", {}],
  ["env truffleruby -Iu", "#!/usr/bin/env truffleruby -Iu", {}],
  ["env ipython --profile-dir=", "#!/usr/bin/env ipython --profile-dir=/opt/x", {}],
  // Review round 5: a bare script name for an unknown command, and a changed working directory.
  ["env -S groovy with a bare script", "#!/usr/bin/env -S groovy sample", {}],
  ["env -S ipython with a bare script", "#!/usr/bin/env -S ipython sample", {}],
  ["env tsx with a bare script", "#!/usr/bin/env tsx e", {}],
  ["env groovy with a bare script", "#!/usr/bin/env groovy e", {}],
  ["env jrunscript with a bare script", "#!/usr/bin/env jrunscript e", {}],
  ["env -C then R", "#!/usr/bin/env -C /opt/x R", {}],
  ["env -C then ipython", "#!/usr/bin/env -C /opt/x ipython", {}],
  ["env -C then tsx", "#!/usr/bin/env -C /opt/x tsx", {}],
  ["env -C then bun", "#!/usr/bin/env -C /opt/x bun", {}],
  ["env -S -C attached then bun", "#!/usr/bin/env -S -C/opt/x bun", {}],
  ["env --chdir then R", "#!/usr/bin/env --chdir /opt/x R", {}],
  ["env --chdir= then R", "#!/usr/bin/env --chdir=/opt/x R", {}],
  // Review round 6: only the exact paths /usr/bin/true and /usr/bin/false take arguments and stay adopted.
  ["a program named true elsewhere", "#!/usr/bin/env /opt/x/true /opt/x/payload.groovy", {}],
  ["a program named true elsewhere, through -S", "#!/usr/bin/env -S /opt/x/true x", {}],
  ["true reached through ..", "#!/usr/bin/env /usr/bin/../../opt/x/true x", {}],
  ["a link named true to groovy", "#!/usr/bin/env /opt/x/true x", { links: { "/opt/x/true": "/opt/x/groovy" } }],
  ["a bare true with an argument", "#!/usr/bin/env true x", {}],
  ["a bare false with an argument", "#!/usr/bin/env false x", {}],
  ["perl -Iu", "#!/usr/bin/perl -Iu", {}],
  ["perl -wIT", "#!/usr/bin/perl -wIT", {}],
  ["ruby -Is", "#!/usr/bin/ruby -Is", {}],
  ["env perl -IT", "#!/usr/bin/env perl -IT", {}],
  ["env R -e", "#!/usr/bin/env R -e x", {}],
  ["env groovy -e", "#!/usr/bin/env groovy -e x", {}],
  ["env raku -e", "#!/usr/bin/env raku -e x", {}],
  ["env tsx -e", "#!/usr/bin/env tsx -e x", {}],
  ["env ipython -c", "#!/usr/bin/env ipython -c x", {}],
  ["env python3-intel64 -c", "#!/usr/bin/env python3-intel64 -c x", {}],
  ["env pypy -c", "#!/usr/bin/env pypy -c x", {}],
  ["env pythonw -c", "#!/usr/bin/env pythonw -c x", {}],
];

describe("a #! line macOS env runs as a launcher is counted", () => {
  for (const [name, line, o] of CASES)
    test(name, async () => {
      expect({ line, n: await count(line, o) }).toEqual({ line, n: 1 });
    });
  test("a plist PATH with a relative or empty entry is counted: it resolves against the job's folder, not the scanner's", async () => {
    // Fails at src/host/cruft.ts envProblem (`v.split(":").every((d) => SYSTEM_DIRS.includes(d))`) if a PATH entry outside the system dirs is let through: it passes on the code before this change too and pins it.
    for (const path of [".", ".:/usr/bin", ":/usr/bin", "/usr/bin:", "/usr/bin::/bin", "bin:/usr/bin"])
      expect({ path, n: await count("#!/usr/bin/env python3", { env: { PATH: path } }) }).toEqual({ path, n: 1 });
    expect(await count("#!/usr/bin/env python3", { env: { PATH: "/usr/bin:/bin" } })).toBe(0);
  });
  test("a non-shell interpreter given a program with -e is counted", async () => {
    expect(await count("#!/usr/bin/perl -e exec")).toBe(1);
  });
  test("controls: ordinary lines stay adopted", async () => {
    for (const l of ["#!/usr/bin/env python3", "#!/usr/bin/env -S python3 -u", "#!/bin/sh -e", "#!/bin/bash", "#!/usr/bin/env LANG=C python3", "#!/usr/bin/env TZ=UTC python3", "#!/usr/bin/env LC_ALL=en_US.UTF-8 python3", "#!/bin/bash -eu", "#!/usr/bin/python3 -u -B", "#!/usr/bin/env -S bash -e", "#!/usr/bin/perl -w", "#!/usr/bin/env /usr/bin/true a b", "#!/usr/bin/env LANG=C python3", "#!/usr/bin/env R", "#!/usr/bin/env /usr/bin/false x", "#!/usr/bin/env /usr/bin/true a b", "#!/usr/bin/env true"]) expect({ l, n: await count(l) }).toEqual({ l, n: 0 });
  });
});

// OUP-376: the allowed-option lists of runsProgramFromArgs (src/host/cruft.ts: `harmless`) are pinned letter by letter. Each row passes on the code as it is; it fails at the `harmless` regex
// if that letter is added to its list (a shell reads ~/.bashrc or ~/.zshrc under -i, a shell reads the program from stdin under -s, -o sets an option that can name a file, an interpreter -E/-X/-p/-i runs
// a path, an environment or a startup file).
describe("a letter outside a harmless list is counted, one letter at a time", () => {
  const shells = ["/bin/bash", "/bin/zsh", "/bin/sh"];
  const others = ["/usr/bin/python3", "/usr/bin/perl", "/usr/bin/ruby", "/usr/local/bin/node"];
  for (const sh of shells)
    for (const l of ["i", "s", "o", "E", "X", "p", "l", "c", "m"])
      test(`${sh} -${l} is counted`, async () => {
        expect(await count(`#!${sh} -${l}`)).toBe(1);
      });
  for (const sh of shells)
    for (const l of ["e", "f", "u", "x", "v", "n"])
      test(`control: ${sh} -${l} stays adopted`, async () => {
        expect(await count(`#!${sh} -${l}`)).toBe(0);
      });
  for (const it of others)
    for (const l of ["i", "E", "X", "p", "I", "e", "m"])
      test(`${it} -${l} is counted`, async () => {
        expect(await count(`#!${it} -${l}`)).toBe(1);
      });
  for (const it of others)
    for (const l of ["u", "B", "s", "O", "q", "w", "T", "W"])
      test(`control: ${it} -${l} stays adopted`, async () => {
        expect(await count(`#!${it} -${l}`)).toBe(0);
      });
});

// OUP-376: the exemption of /usr/bin/true and /usr/bin/false is a path as written, and it does not lift the check of what that path is. The fake file system resolves every other path to itself,
// so these rows put the path itself in the three states a real host can have. Each fails at src/host/cruft.ts badInterpreter (`real === undefined || ...` for a missing path, the alias-link
// line `!runsOther(base(w)) && runsOther(base(real))` for a link to a shell or interpreter) if that line is removed.
describe("the true and false exemption, with the path itself in a state the exemption does not cover", () => {
  for (const cmd of ["/usr/bin/true", "/usr/bin/false"]) {
    test(`${cmd} with an argument stays adopted when it is the ordinary binary (control)`, async () => {
      expect(await count(`#!/usr/bin/env ${cmd} a`)).toBe(0);
      expect(await count(`#!/usr/bin/env ${cmd} -c x`)).toBe(0);
    });
    test(`${cmd} with an argument is counted when the path does not resolve`, async () => {
      expect(await count(`#!/usr/bin/env ${cmd} a`, { missing: [cmd] })).toBe(1);
    });
    for (const target of ["/bin/bash", "/usr/bin/python3"])
      test(`${cmd} with an argument is counted when it is a link to ${target}`, async () => {
        expect(await count(`#!/usr/bin/env ${cmd} a`, { links: { [cmd]: target } })).toBe(1);
      });
    test(`${cmd} with no argument is counted when it is a link to a shell`, async () => {
      expect(await count(`#!/usr/bin/env ${cmd}`, { links: { [cmd]: "/bin/bash" } })).toBe(1);
    });
  }
});

// The working-directory option on its own: the command after it is one that is adopted without it (python3 with no argument), so only the -C / --chdir check can count the line.
// Fails at src/host/cruft.ts parseEnv (`if (c === "C") st.bad = true` for the short form, `t === "--chdir" || t.startsWith("--chdir=")` for the long one).
describe("env -C and --chdir are counted on a command that is adopted without them", () => {
  for (const l of ["#!/usr/bin/env -C /opt/x python3", "#!/usr/bin/env -C/opt/x python3", "#!/usr/bin/env -S -C/opt/x python3", "#!/usr/bin/env --chdir /opt/x python3", "#!/usr/bin/env --chdir=/opt/x python3"])
    test(`${l} is counted`, async () => {
      expect(await count(l)).toBe(1);
    });
  test("control: the same line with no chdir stays adopted", async () => {
    expect(await count("#!/usr/bin/env python3")).toBe(0);
  });
});
