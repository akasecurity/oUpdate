// `host --cruft-count` (OUP-372): a program, an env word or an argument string that runs another program is counted, not skipped as a binary or adopted.
import { describe, expect, test } from "bun:test";
import { cruftCount } from "../src/host/cruft.ts";

const owned = "#!/opt/x/tool\n# owner: me\n";
const ELF = "\u0000ELF";
type Over = {
  argv: string[];
  head?: (p: string) => string;
  links?: Record<string, string>; // path -> real path
  env?: Record<string, string>;
  missing?: (p: string) => boolean; // a path that does not resolve (realPath answers undefined)
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
      realPath: async (p: string) => (o.missing?.(p) ? undefined : o.links?.[p] ?? p),
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
    "#!./dash",
    "#!/usr/bin/env -S npm run x",
  ])
    test(`${line} is counted`, async () => {
      expect(await script(line)).toBe(1);
    });
  for (const line of ["#!/opt/x/tool", "#!/usr/bin/env bash", "#!/usr/bin/env -S python3 -u", "#!/usr/bin/env FOO=bar bash", "#!/bin/sh"])
    test(`control: ${line} is adopted`, async () => {
      expect(await script(line)).toBe(0);
    });
});

describe("quotes: removed only inside the value of -S", () => {
  // The path as written does not resolve (a quote in a name), the path with the quotes removed does: env -S removes them, a plain word keeps them.
  const quoted = (p: string) => /["']/.test(p);
  for (const line of [
    "#!/usr/bin/env -S /usr/bin/\"python3\"",
    "#!/usr/bin/env -S /usr/bin/'python3'",
    "#!/usr/bin/env -S /usr/bin/\"python3\" -u",
    "#!/usr/bin/env /usr/bin/\"python3\"",
    "#!/usr/bin/env /usr/bin/'python3'",
    "#!/usr/bin/env /opt/x/qu'ote",
    "#!/usr/bin/env py'thon3",
    "#!/usr/bin/env 'dash'",
  ])
    test(`${line}: the word as written does not resolve, so it is counted`, async () => {
      expect(await script(line, { missing: quoted })).toBe(1);
    });
  test("a plain word with a quote that links to a launcher is counted", async () => {
    expect(await script("#!/usr/bin/env /opt/x/qu'ote", { links: { "/opt/x/qu'ote": "/bin/dash" } })).toBe(1);
  });
  test("control: -S with the quotes removed that names a plain interpreter is adopted", async () => {
    expect(await script("#!/usr/bin/env -S 'python3' -u", { missing: quoted })).toBe(0);
  });
});

describe("an env command that is found nowhere, and a lookup that goes on past a dir", () => {
  test("a command word that resolves in no PATH dir is counted", async () => {
    expect(await script("#!/usr/bin/env missingcmd", { missing: (p) => p.endsWith("/missingcmd") })).toBe(1);
  });
  test("control: an option value that resolves nowhere is not the command", async () => {
    expect(await script("#!/usr/bin/env -u SOMEVAR bash", { missing: (p) => p.endsWith("/SOMEVAR") })).toBe(0);
  });
  test("a link to a launcher in a later PATH dir counts when an earlier dir holds a plain file of that name", async () => {
    expect(await script("#!/usr/bin/env run", { links: { "/usr/local/bin/run": "/usr/local/bin/run", "/usr/bin/run": "/bin/dash" }, env: { PATH: "/usr/local/bin:/usr/bin" } })).toBe(1);
  });
});

describe("an interpreter path that links to a program of another family, and a value after =", () => {
  test("/usr/local/bin/python3 -> /bin/bash is counted (shape (b))", async () => {
    expect(await count({ argv: ["/usr/local/bin/python3", OWN], head: () => owned, links: { "/usr/local/bin/python3": "/bin/bash" } })).toBe(1);
  });
  test("control: /usr/local/bin/python3 -> python3.12 is adopted", async () => {
    expect(await count({ argv: ["/usr/local/bin/python3", OWN], head: () => owned, links: { "/usr/local/bin/python3": "/usr/local/bin/python3.12" } })).toBe(0);
  });
  test("a VAR=value word names its value: env FOO=dash bash", async () => {
    expect(await script("#!/usr/bin/env FOO=dash bash")).toBe(1);
  });
  test("a value that is a link to a launcher is counted: env FOO=sh bash", async () => {
    expect(await script("#!/usr/bin/env FOO=sh bash", { links: { "/usr/bin/sh": "/usr/bin/dash" } })).toBe(1);
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
  test("a link in a dir the PATH does not name is not looked at: the word is found nowhere, so it is counted", async () => {
    expect(await script("#!/usr/bin/env run", { links: { "/opt/other/run": "/bin/dash" }, env: { PATH: "/usr/bin" }, missing: (p) => p.endsWith("/run") })).toBe(1);
  });
  test("a bare interpreter name that links to another family is counted (python3 -> bash, python3 -> env)", async () => {
    expect(await script("#!/usr/bin/env python3", { links: { "/usr/bin/python3": "/bin/bash" } })).toBe(1);
    expect(await script("#!/usr/bin/env python3", { links: { "/usr/bin/python3": "/usr/bin/env" } })).toBe(1);
  });
  test("control: a bare word that links to a plain program is adopted", async () => {
    expect(await script("#!/usr/bin/env run", { links: { "/usr/bin/run": "/usr/bin/true" } })).toBe(0);
  });
});

describe("env options inside and around a -S value (OUP-372 review round 2)", () => {
  // Each line runs dash. env reads the words of a -S value as options again, takes quotes off inside it, splits on a backslash-underscore, and takes -S in a cluster of flags.
  for (const line of [
    "#!/usr/bin/env -S -Sdash",
    "#!/usr/bin/env -S -S'dash -e'",
    "#!/usr/bin/env -S -i -Sdash",
    "#!/usr/bin/env -Sdash\\_-e",
    "#!/usr/bin/env -S dash\\_-e",
    "#!/usr/bin/env -iSdash",
    "#!/usr/bin/env -vS'da''sh'",
    "#!/usr/bin/env --split-string=dash",
    "#!/usr/bin/env --split-string dash -e",
    "#!/usr/bin/env -S -u X dash",
    "#!/usr/bin/env -u dash bash",
    "#!/usr/bin/env -S FOO=1 dash",
    "#!/usr/bin/env 'dash'",
    "#!/usr/bin/env \"dash\"",
  ])
    test(`${line} is counted`, async () => {
      expect(await script(line)).toBe(1);
    });
  test("a decoded name that does not resolve is counted: -Spy\\'thon3", async () => {
    expect(await script("#!/usr/bin/env -Spy\\'thon3", { missing: (p) => p.includes("'") })).toBe(1);
  });
  test("a command word after an option value is the command: -S -u X missingcmd is counted", async () => {
    expect(await script("#!/usr/bin/env -S -u X missingcmd", { missing: (p) => p.endsWith("/missingcmd") })).toBe(1);
  });
  test("a PATH the line sets changes where the command is looked up, so it is counted: -P and PATH=", async () => {
    expect(await script("#!/usr/bin/env -P /opt/homebrew/bin python3")).toBe(1);
    expect(await script("#!/usr/bin/env PATH=/opt/homebrew/bin python3")).toBe(1);
    expect(await script("#!/usr/bin/env -S PATH=/opt/homebrew/bin python3")).toBe(1);
  });
  test("control: a plain variable does not change the lookup", async () => {
    expect(await script("#!/usr/bin/env FOO=bar python3")).toBe(0);
    expect(await script("#!/usr/bin/env -S python3 -u")).toBe(0);
  });
});

describe("env line: what the earlier readers counted stays counted, and the review round 3 and 4 gaps (OUP-372)", () => {

  const fsLinks: Record<string, string> = { "/opt/x/alias": "/bin/dash", "/opt/x/linkdash": "/bin/dash", "/usr/bin/run": "/bin/dash", "/usr/bin/X": "/bin/ksh", "/usr/bin/ruby": "/bin/bash", "/opt/x/dash": "/opt/x/real" };
  const gone = (p: string) => p.startsWith("/missing") || p.includes("\\") || p.endsWith("/missingcmd");
  const real = (p: string): string | undefined => (gone(p) ? undefined : fsLinks[p] ?? p);
  const name = (p: string) => p.split("/").pop()!;

  // Two reference judges, each an independent copy of an earlier reader of an env line (not an import): the first (OUP-370, 748cf35e) reads every word as
  // written; the second (OUP-372 round 1, 7a2e2814) removes the quotes inside -S, judges the value of X=value words, looks a bare word up in the dirs of
  // PATH and counts a command found nowhere or a link to a program of another family. The head must count every line either counts.
  // The launcher lists, as the two readers had them (copied from the revisions, case-insensitive).
  const L748 = /^g?(?:dash|ksh|ksh93|tcsh|csh|fish|osascript|nohup|caffeinate|arch|nice|xargs|sudo|tclsh|wish|expect|time|exec|command|setsid|ash|mksh|yash|busybox|deno|php|lua|luajit|julia|Rscript|pwsh|powershell|awk|gawk|mawk|xcrun|open|launchctl|timeout|gtimeout|stdbuf|su|doas|chroot|unbuffer|flock|ionice|taskset|strace|ltrace|watch|script|screen|tmux|parallel|make|gmake|find|ssh|lldb|gdb|rlwrap|genv|uv|pypy3|nodejs|go|cargo|dotnet|mono|vim|nvim|emacs|sed|m4|gnuplot|dtrace|socat|ncat|nc|tini|dumb-init|entr|watchexec|nix|mise|pkgx|ssh-agent|dbus-launch|shortcuts|automator|runuser|unshare|nsenter|chpst|pkexec|at|batch|pnpm|erl|escript|elixir|racket|guile|nu|elvish|xonsh|rc|osh|ysh|qemu-aarch64|sandbox-exec|taskpolicy|swift|toybox|login|java|npx|uvx|git|docker|sbcl)(?:[0-9]+(?:\.[0-9]+)*)?$/i;
  const L2 = /^g?(?:dash|ksh|ksh93|tcsh|csh|fish|osascript|nohup|caffeinate|arch|nice|xargs|sudo|tclsh|wish|expect|time|exec|command|setsid|ash|mksh|yash|busybox|deno|php|lua|luajit|julia|Rscript|pwsh|powershell|awk|gawk|mawk|xcrun|open|launchctl|timeout|gtimeout|stdbuf|su|doas|chroot|unbuffer|flock|ionice|taskset|strace|ltrace|watch|script|screen|tmux|parallel|make|gmake|find|ssh|lldb|gdb|rlwrap|genv|uv|pypy3|nodejs|go|cargo|dotnet|mono|vim|nvim|emacs|sed|m4|gnuplot|dtrace|socat|ncat|nc|tini|dumb-init|entr|watchexec|nix|mise|pkgx|ssh-agent|dbus-launch|shortcuts|automator|runuser|unshare|nsenter|chpst|pkexec|at|batch|pnpm|erl|escript|elixir|racket|guile|nu|elvish|xonsh|rc|osh|ysh|qemu-aarch64|sandbox-exec|taskpolicy|swift|toybox|login|java|npx|uvx|git|docker|sbcl|npm|yarn|bunx|nawk|pm2)(?:[0-9]+(?:\.[0-9]+)*)?$/i;
  const INTERP = /^(?:python3?|ruby|perl|node|bun|bash|zsh|sh)(?:[0-9]+(?:\.[0-9]+)*)?$/;
  const INTERP_ANY = new RegExp(INTERP.source, "i");
  const runsOther = (n: string): boolean => L2.test(n) || INTERP_ANY.test(n) || n.toLowerCase() === "env";
  const fam = (n: string) => n.toLowerCase().replace(/[0-9.]+$/, "");
  const envWords = (line: string): string[] => line.slice(2).split("\n", 1)[0]!.trim().split(/\s+/).filter(Boolean);
  const first = (line: string): boolean => {
    const words = envWords(line);
    const list = words[0] !== undefined && name(words[0]).toLowerCase() === "env" ? words : [words[0]];
    for (const w of list) {
      if (w === undefined) continue;
      if (!w.startsWith("/")) {
        if (L748.test(w)) return true;
        continue;
      }
      const r = real(w);
      if (r === undefined || L748.test(name(r))) return true;
    }
    return false;
  };
  const second = (line: string): boolean => {
    const raw = envWords(line);
    if (raw[0] === undefined) return false;
    if (name(raw[0]).toLowerCase() !== "env") return judge([raw[0]], -1);
    const words: string[] = [raw[0]];
    let cmd = -1;
    const add = (w: string): void => {
      if (w === "") return;
      if (cmd < 0 && !w.startsWith("-") && !w.includes("=")) cmd = words.length;
      words.push(w);
      const eq = w.indexOf("=");
      if (eq > 0 && !w.startsWith("/")) words.push(w.slice(eq + 1));
    };
    for (let i = 1; i < raw.length; i++) {
      const w = raw[i]!;
      if (w.startsWith("-S")) {
        const rest = [w.slice(2), ...raw.slice(i + 1)].join(" ");
        for (const t of rest.split(/\s+/)) if (t.startsWith("/") && /["']/.test(t)) words.push(t);
        for (const t of rest.replace(/["']/g, "").split(/\s+/)) add(t);
        break;
      }
      if (w === "-u" || w === "-C" || w === "-P" || w === "--unset" || w === "--chdir") {
        words.push(w);
        if (raw[i + 1] !== undefined) words.push(raw[++i]!);
        continue;
      }
      add(w);
    }
    return judge(words, cmd);
  };
  const judge = (words: string[], cmd: number): boolean => {
    for (const [i, w] of words.entries()) {
      if (!w.startsWith("/")) {
        if (L2.test(name(w))) return true;
        if (w.startsWith("-") || w.includes("/") || w.includes("=")) continue;
        let found = false;
        for (const d of ["/usr/bin", "/bin", "/usr/sbin", "/sbin"]) {
          const r = real(`${d}/${w}`);
          if (r === undefined) continue;
          found = true;
          if (L2.test(name(r)) || (runsOther(name(r)) && !runsOther(w))) return true;
        }
        if (!found && i === cmd) return true;
        continue;
      }
      const r = real(w);
      if (r === undefined || L2.test(name(r))) return true;
      if (runsOther(name(w)) && runsOther(name(r)) && fam(name(w)) !== fam(name(r))) return true;
    }
    return false;
  };
  const counted = (line: string, extra: Partial<Over> = {}) => script(line, { links: fsLinks, missing: gone, ...extra });
  // A line only the structural read counts: the head counts it and neither reference judge does, so no older reader can produce the count.
  const onlyNew = async (line: string): Promise<void> => {
    expect({ line, first: first(line), second: second(line) }).toEqual({ line, first: false, second: false });
    expect({ line, n: await counted(line) }).toEqual({ line, n: 1 });
  };

  // The older readers also count a line with a launcher in a deep -S, a link or a backslash path (they read the words flat), so these are not "only new" lines.
  // Cases the older readers also count: kept as plain counts of what an option value, a lookup path or an X=value word does.
  test("plain counts: separated option values, a changed PATH and a tab-separated X=value", async () => {
    for (const l of ["#!/usr/bin/env -C /opt/x/alias python3", "#!/usr/bin/env -C /missing/x python3", "#!/usr/bin/env -iP/usr/bin python3", "#!/usr/bin/env PATH=dash", "#!/usr/bin/env python3\t--exec=dash"])
      expect({ l, n: await counted(l) }).toEqual({ l, n: 1 });
  });
  test("more -S levels than are read are counted, not dropped", async () => {
    for (const n of [6, 7, 8, 9]) {
      expect(await counted(`#!/usr/bin/env ${"-S ".repeat(n)}dash`)).toBe(1);
      expect(await counted(`#!/usr/bin/env ${"-S ".repeat(n)}missingcmd`)).toBe(1);
      expect(await counted(`#!/usr/bin/env ${"-S ".repeat(n)}/opt/x/linkdash`)).toBe(1);
    }
  });
  test("--split-string reads its value as a -S value: an option inside it is read, nested and attached", async () => {
    await onlyNew('#!/usr/bin/env --split-string "-u/opt/x/alias python3"');
    await onlyNew("#!/usr/bin/env --split-string=-u/opt/x/alias python3");
    await onlyNew('#!/usr/bin/env --split-string --split-string "-u/opt/x/alias python3"');
    // A value only the inner split reveals: the outer value alone is a word with a blank in it.
    await onlyNew('#!/usr/bin/env --split-string "--split-string=-u/opt/x/alias python3"');
    await onlyNew('#!/usr/bin/env --split-string=--split-string\\_"-u/opt/x/alias python3"');
    await onlyNew("#!/usr/bin/env --split-string=--split-string=-u/opt/x/alias python3");
  });
  test("an option value is judged where only the structural read sees it: attached to its option, as a link to a launcher or a path that resolves nowhere", async () => {
    for (const l of ["#!/usr/bin/env -u FOO=/opt/x/alias python3", "#!/usr/bin/env -u/opt/x/alias python3", "#!/usr/bin/env -C/opt/x/alias python3", "#!/usr/bin/env -a/opt/x/alias python3", "#!/usr/bin/env -C/missing/x python3"]) await onlyNew(l);
  });
  test("an option value that is a path named like a launcher is counted whatever it links to", async () => {
    await onlyNew("#!/usr/bin/env -u /opt/x/dash python3");
    await onlyNew("#!/usr/bin/env -C /opt/x/dash python3");
  });
  test("a path named like a launcher that links to something else is counted as a program word too", async () => {
    await onlyNew("#!/opt/x/dash");
  });
  test("the value of an X=value or --x=value word after the command is judged, where the older readers do not see it", async () => {
    for (const l of ['#!/usr/bin/env python3 FOO="dash"', '#!/usr/bin/env python3 --exec="dash"']) await onlyNew(l);
  });
  // The older readers also see a launcher inside a quoted or escaped blank of a -S value (they remove its quotes), so these are not "only new" lines.
  test("a word with a quoted or escaped blank has each piece judged", async () => {
    for (const l of ["#!/usr/bin/env -S python3 'a dash b'", "#!/usr/bin/env -S python3 x\\ dash", '#!/usr/bin/env -S python3 "x dash']) expect({ l, n: await counted(l) }).toEqual({ l, n: 1 });
  });
  test("a path written with a backslash is judged as written too", async () => {
    expect(await counted("#!/usr/bin/env -S /usr/bin/python\\3")).toBe(1);
  });
  test("a changed lookup path is counted with a benign command: -i, -P, -u PATH, --unset=PATH, --ignore-environment, PATH=", async () => {
    for (const l of [
      "#!/usr/bin/env -i python3",
      "#!/usr/bin/env -vP/opt/bin python3",
      "#!/usr/bin/env -P /opt/bin python3",
      "#!/usr/bin/env -S -vP /opt/bin python3",
      "#!/usr/bin/env -u PATH python3",
      "#!/usr/bin/env --unset=PATH python3",
      "#!/usr/bin/env --ignore-environment python3",
      "#!/usr/bin/env --unset FOO python3",
      "#!/usr/bin/env PATH=/opt/bin python3",
      "#!/usr/bin/env PATH=/opt/bin",
    ])
      await onlyNew(l);
  });
  test("a long option that env does not have, and an env that runs env, are counted", async () => {
    for (const l of ["#!/usr/bin/env --Sdash python3", "#!/usr/bin/env --iSdash python3", "#!/usr/bin/env --vSdash python3", "#!/usr/bin/env --P/opt/evil python3", "#!/usr/bin/env env python3", "#!/usr/bin/env /usr/bin/env -P /opt/bin python3"])
      await onlyNew(l);
  });
  test("controls: ordinary env lines stay adopted", async () => {
    for (const l of ["#!/usr/bin/env python3", "#!/usr/bin/env --null python3", "#!/usr/bin/env FOO=bar python3", "#!/usr/bin/env -S python3 -u", "#!/usr/bin/env -u FOO python3"])
      expect({ l, n: await counted(l) }).toEqual({ l, n: 0 });
  });

  test("env pins: nested -S past the cap counts a benign command, a bare - and -- are read", async () => {
    for (const n of [7, 8, 9]) await onlyNew(`#!/usr/bin/env ${"-S ".repeat(n)}python3`);
    await onlyNew("#!/usr/bin/env - python3");
    await onlyNew("#!/usr/bin/env - date");
    // Controls: six nested -S, a `--` before the command and a -S with nothing after it are ordinary.
    for (const l of ["#!/usr/bin/env -S -S -S -S -S -S python3", "#!/usr/bin/env -- python3", "#!/usr/bin/env --split-string", "#!/usr/bin/env -S"]) expect({ l, n: await counted(l) }).toEqual({ l, n: 0 });
  });
  test("a link to a launcher found by a bare word in a later dir is counted", async () => {
    expect(await counted("#!/usr/bin/env run")).toBe(1);
  });

  test("a corpus of 3,000 env lines: the head counts every line either earlier reader counted", async () => {
    let seed = 20261128;
    const rnd = (n: number) => ((seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff) % n);
    const vocab = [
      "-S", "-i", "-u", "-C", "-P", "-iS", "-iSdash", "-vP/opt/evil", "--split-string", "--split-string=python3", "--unset=/opt/x/alias", "--chdir=/missing", "--default-signal",
      "PATH=/usr/bin", "PATH=dash", "FOO=dash", "FOO=bar", "python3", "dash", "bash", "ksh", "run", "X", "missingcmd", "/opt/x/alias", "/opt/x/linkdash", "/missing/x",
      "/usr/bin/python3", "/usr/bin/python\\3", "'a", "dash", "b'", 'x\\', "dash", "-e", "--exec=dash", "--", "awk", '"dash"', "'dash'", "ruby", "perl", "env", "/usr/bin/env", "/usr/bin/ruby", "npm", "yarn", "bunx", "nawk", "pm2",
    ];
    const lines: string[] = [];
    while (lines.length < 3000) {
      const n = 1 + rnd(5);
      const w: string[] = [];
      for (let k = 0; k < n; k++) w.push(vocab[rnd(vocab.length)]!);
      lines.push(`#!/usr/bin/env ${w.join(" ")}`);
    }
    // Lines only the second reader counts: a command found nowhere, a quote removed inside -S, a link to a program of another family.
    lines.push("#!/usr/bin/env missingcmd", '#!/usr/bin/env -S "dash"', "#!/usr/bin/env -S 'dash' -e", "#!/usr/bin/env ruby", "#!/usr/bin/env -S ruby -w");
    // The second reader's own launcher list and interpreter list matter: these lines are counted by it and by no other reader.
    for (const l of ["#!/usr/bin/env /usr/bin/ruby", "#!/usr/bin/env npm", "#!/usr/bin/env -S pm2 x", "#!/usr/bin/env yarn", "#!/usr/bin/env bunx", "#!/usr/bin/env nawk"]) expect({ l, second: second(l) }).toEqual({ l, second: true });
    expect(new Set(lines).size).toBeGreaterThan(2100);
    const missed: string[] = [];
    let n1 = 0;
    let n2 = 0;
    let only2 = 0;
    for (const l of lines) {
      const a = first(l);
      const b = second(l);
      if (a) n1++;
      if (b) n2++;
      if (b && !a) only2++;
      if ((a || b) && (await counted(l)) !== 1) missed.push(l);
    }
    expect(n1).toBeGreaterThan(500);
    expect(only2).toBeGreaterThan(50);
    expect(n2).toBeGreaterThanOrEqual(n1);
    expect(missed).toEqual([]);
  });
});

describe("a line with many words or a long PATH is judged in bounded time (OUP-372)", () => {
  // `missing` is asked once per lookup: it counts them. Every word `aN` is found nowhere (the command word then counts the line).
  const run = async (line: string, dirs?: number) => {
    let calls = 0;
    const t = Date.now();
    const n = await count({
      argv: [OWN],
      head: () => `${line}\n# owner: me\n`,
      ...(dirs ? { env: { PATH: Array(dirs).fill("/bin").join(":") } } : {}),
      missing: (q) => (calls++, /\/a\d*$/.test(q)),
    });
    return { n, calls, ms: Date.now() - t };
  };
  const words = (k: number) => Array.from({ length: k }, (_, i) => `a${i}`).join(" ");
  test("49,000 repeated PATH dirs and 232 distinct words: one dir is looked at, in under 1 s", async () => {
    const r = await run(`#!/usr/bin/env ${words(232)}`, 49000);
    expect(r.n).toBe(1);
    expect(r.calls).toBeLessThan(600);
    expect(r.ms).toBeLessThan(1000);
  });
  test("a repeated PATH dir is looked at once: 3 words and 49,000 copies of /bin make 3 lookups", async () => {
    const r = await run(`#!/usr/bin/env ${words(3)}`, 49000);
    expect(r.n).toBe(1);
    expect(r.calls).toBeLessThan(10);
  });
  test("49,000 distinct words are counted after the lookup cap, not after 49,000 x 4 lookups", async () => {
    const r = await run(`#!/usr/bin/env ${words(49000)}`);
    expect(r.n).toBe(1);
    expect(r.calls).toBeLessThan(700);
  });
  test("a repeated word is looked up once: 5,000 copies of one word found nowhere", async () => {
    const r = await run(`#!/usr/bin/env ${Array(5000).fill("a").join(" ")}`);
    expect(r.n).toBe(1);
    expect(r.calls).toBeLessThan(30);
  });
});
