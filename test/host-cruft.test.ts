// `host --cruft-count` (OUP-349): read-only count of ownerless pins, tool-made backups, unadopted wrappers.
import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as nodeFs from "node:fs";
import { existsSync, linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realFs } from "../src/apply/fs.ts";
import { parseApplyConfig } from "../src/apply/config.ts";
import { cruftCount, cruftLines, launchScript, plistLaunch, safeName, sourceProblem } from "../src/host/cruft.ts";
import { parseHostCommand } from "../src/host/cli.ts";

/** A plist as the OS parser gives it: the fake plistJson reads the JSON text kept under the plist's name. */
const plist = (...args: string[]) => JSON.stringify({ Label: "x", ProgramArguments: args });

function fs(files: Record<string, string>, dirs: Record<string, string[]>, pins: { path: string; text: string | undefined }[] = []) {
  return {
    home: "/h",
    listDir: async (d: string) => dirs[d] ?? [],
    readHead: async (p: string, n: number) => (p in files ? (p.endsWith(".plist") ? `<plist>${files[p]}` : files[p]!).slice(0, n) : undefined),
    plistJson: async (p: string) => (p.endsWith(".plist") && p in files ? (JSON.parse(files[p]!) as Record<string, unknown>) : undefined),
    pinFiles: () => pins.map((p) => ({ repo: "r", ...p })),
  };
}

describe("cruft count", () => {
  test("a pins.json entry counts unless it has a non-empty owner and reason", async () => {
    const text = JSON.stringify({ brew: { a: "1.0", b: { version: "1", owner: "o", reason: "r" }, c: { owner: "o", reason: " " } }, cask: { d: { reason: "r", owner: "o" } } });
    const c = await cruftCount({ fs: fs({}, {}, [{ path: "/r/pins.json", text }]), configDir: "/cfg", pinRoots: ["/r"], ownerlessConfigValues: ["config caskExclude zoom"] });
    expect(c.pins).toEqual(["config caskExclude zoom", "/r/pins.json: brew a", "/r/pins.json: brew c"]);
  });
  test("only the fixed backup patterns count, in the config directory", async () => {
    const names = ["config.json", "config.json.bak-1", "config.json.pre-oq4e", "config.json.pre-oq4e.x", "config.json.bak-pre-staleowners", "oharness.pre-9", "ilane.stale-2", "renovate", "renovate-token", "config.json.pre-other"];
    const c = await cruftCount({ fs: fs({}, { "/cfg": names }), configDir: "/cfg/", pinRoots: [], ownerlessConfigValues: [] });
    expect(c.backups).toEqual(["/cfg/config.json.bak-1", "/cfg/config.json.bak-pre-staleowners", "/cfg/config.json.pre-oq4e", "/cfg/config.json.pre-oq4e.x", "/cfg/ilane.stale-2", "/cfg/oharness.pre-9"]);
  });
  test("a wrapper is adopted only in the adopted-scripts directory with an owner line; a binary is not counted", async () => {
    const A = "/h/Library/LaunchAgents";
    const files = {
      [`${A}/ok.plist`]: plist("/h/scripts/ok.sh"),
      [`${A}/noowner.plist`]: plist("/h/scripts/noowner.sh"),
      [`${A}/outside.plist`]: plist("/opt/x/outside.sh"),
      [`${A}/viashell.plist`]: plist("/bin/bash", "/opt/x/viashell.sh"),
      [`${A}/bin.plist`]: plist("/usr/local/bin/tool"),
      "/h/scripts/ok.sh": "#!/bin/sh\n# owner: team\necho",
      "/h/scripts/noowner.sh": "#!/bin/sh\necho",
      "/opt/x/outside.sh": "#!/bin/sh\n# owner: team\n",
      "/opt/x/viashell.sh": "#!/bin/bash\n",
      "/usr/local/bin/tool": "\u0000ELF",
    };
    const c = await cruftCount({ fs: fs(files, { [A]: ["ok.plist", "noowner.plist", "outside.plist", "viashell.plist", "bin.plist", "notes.txt"] }), configDir: "/cfg", pinRoots: [], ownerlessConfigValues: [] });
    expect(c.wrappers).toEqual([`${A}/noowner.plist runs /h/scripts/noowner.sh`, `${A}/outside.plist runs /opt/x/outside.sh`, `${A}/viashell.plist runs /opt/x/viashell.sh`]);
  });
  test("a script path that climbs out of the adopted-scripts directory is not adopted", async () => {
    const A = "/h/Library/LaunchAgents";
    const files = { [`${A}/up.plist`]: plist("/h/scripts/../../../opt/o.sh"), "/h/scripts/../../../opt/o.sh": "#!/bin/sh\n# owner: team\n" };
    const c = await cruftCount({ fs: fs(files, { [A]: ["up.plist"] }), configDir: "/cfg", pinRoots: [], ownerlessConfigValues: [] });
    expect(c.wrappers).toEqual([`${A}/up.plist runs /h/scripts/../../../opt/o.sh`]);
  });
  test("the owner line is read from the first five lines only", async () => {
    const A = "/h/Library/LaunchAgents";
    const files = { [`${A}/l6.plist`]: plist("/h/scripts/l6.sh"), "/h/scripts/l6.sh": `#!/bin/sh\n${"#\n".repeat(4)}# owner: team\n` };
    const c = await cruftCount({ fs: fs(files, { [A]: ["l6.plist"] }), configDir: "/cfg", pinRoots: [], ownerlessConfigValues: [] });
    expect(c.wrappers).toEqual([`${A}/l6.plist runs /h/scripts/l6.sh`]);
  });
  test("the owner line behind more than 512 bytes of comment is not read", async () => {
    const A = "/h/Library/LaunchAgents";
    const files = { [`${A}/far.plist`]: plist("/h/scripts/far.sh"), "/h/scripts/far.sh": `#!/bin/sh\n#${"x".repeat(600)}\n# owner: team\n` };
    const c = await cruftCount({ fs: fs(files, { [A]: ["far.plist"] }), configDir: "/cfg", pinRoots: [], ownerlessConfigValues: [] });
    expect(c.wrappers).toEqual([`${A}/far.plist runs /h/scripts/far.sh`]);
  });
  test("a script that is missing or that readHead cannot give (a FIFO) is unadopted, not left out", async () => {
    const A = "/h/Library/LaunchAgents";
    // Fails at cruft.ts:219 if the body === undefined branch goes back to `continue`: the plist is then left out of the count.
    const c = await cruftCount({ fs: fs({ [`${A}/fifo.plist`]: plist("/opt/fifo.sh"), [`${A}/gone.plist`]: plist("/bin/sh", "/h/scripts/gone.sh") }, { [A]: ["fifo.plist", "gone.plist"] }), configDir: "/cfg", pinRoots: [], ownerlessConfigValues: [] });
    expect(c.wrappers).toEqual([`${A}/fifo.plist runs /opt/fifo.sh`, `${A}/gone.plist runs /h/scripts/gone.sh`]);
    // A shape (a) program with no shebang stays a binary, not counted.
    const bin = await cruftCount({ fs: fs({ [`${A}/b.plist`]: plist("/opt/prog"), "/opt/prog": "\u0000ELF" }, { [A]: ["b.plist"] }), configDir: "/cfg", pinRoots: [], ownerlessConfigValues: [] });
    expect(bin.wrappers).toEqual([]);
  });
  test("a sibling directory that only shares the prefix is not adopted", async () => {
    const A = "/h/Library/LaunchAgents";
    const files = { [`${A}/s.plist`]: plist("/h/scripts-evil/x.sh"), "/h/scripts-evil/x.sh": "#!/bin/sh\n# owner: t\n" };
    const c = await cruftCount({ fs: fs(files, { [A]: ["s.plist"] }), configDir: "/cfg", pinRoots: [], ownerlessConfigValues: [], adoptedScriptsDir: "/h/scripts" });
    expect(c.wrappers).toEqual([`${A}/s.plist runs /h/scripts-evil/x.sh`]);
  });
  test("a name with a newline and an escape prints on one escaped line", () => {
    const evil = "/cfg/a\ncruft: pins 0 ownerless\u001b[2J\u0085";
    const lines = cruftLines({ pins: [], backups: [evil], wrappers: [] });
    expect(lines).toHaveLength(2);
    expect(lines[1]).toBe("  backup: /cfg/a\\ncruft: pins 0 ownerless\\u001b[2J\\u0085");
    expect(safeName("a\tb")).toBe("a\\tb");
  });
  test("adoptedScriptsDir picks the adopted directory: absolute or ~/, default <home>/scripts", async () => {
    const A = "/h/Library/LaunchAgents";
    const files = { [`${A}/a.plist`]: plist("/opt/adopted/a.sh"), [`${A}/b.plist`]: plist("/h/mine/b.sh"), [`${A}/c.plist`]: plist("/h/scripts/c.sh"), "/opt/adopted/a.sh": "#!/bin/sh\n# owner: t\n", "/h/mine/b.sh": "#!/bin/sh\n# owner: t\n", "/h/scripts/c.sh": "#!/bin/sh\n# owner: t\n" };
    const count = async (adoptedScriptsDir?: string) => (await cruftCount({ fs: fs(files, { [A]: ["a.plist", "b.plist", "c.plist"] }), configDir: "/cfg", pinRoots: [], ownerlessConfigValues: [], ...(adoptedScriptsDir ? { adoptedScriptsDir } : {}) })).wrappers.map((w) => w.split("/").at(-1));
    expect(await count()).toEqual(["a.plist runs /opt/adopted/a.sh", "b.plist runs /h/mine/b.sh"].map((w) => w.split("/").at(-1)));
    expect(await count("/opt/adopted/")).toEqual(["b.sh", "c.sh"]);
    expect(await count("~/mine")).toEqual(["a.sh", "c.sh"]);
  });
  test("config adoptedScriptsDir must be absolute or start with ~/", () => {
    const cfg = (v: unknown) => parseApplyConfig(JSON.stringify({ apply: { stateDir: "/state.test", adoptedScriptsDir: v } }), "hosta");
    expect(cfg("/hm/u/scripts").adoptedScriptsDir).toBe("/hm/u/scripts");
    expect(cfg("~/scripts").adoptedScriptsDir).toBe("~/scripts");
    expect(parseApplyConfig(JSON.stringify({ apply: { stateDir: "/state.test" } }), "hosta").adoptedScriptsDir).toBeUndefined();
    expect(() => cfg("scripts")).toThrow("adoptedScriptsDir must be an absolute path or start with ~/");
    expect(() => cfg("")).toThrow("adoptedScriptsDir");
    expect(() => cfg(5)).toThrow("adoptedScriptsDir");
  });
  const A = "/h/Library/LaunchAgents";
  const owned = "#!/bin/sh\n# owner: team\n";
  const wrappersOf = async (xml: string, extra: Record<string, string> = {}) => (await cruftCount({ fs: fs({ [`${A}/t.plist`]: xml, ...extra }, { [A]: ["t.plist"] }), configDir: "/cfg", pinRoots: [], ownerlessConfigValues: [] })).wrappers;
  test("shapes (a), (b) and (c) adopt an owned script in the adopted directory", async () => {
    const own = { "/h/scripts/own.sh": owned };
    expect(await wrappersOf(plist("/h/scripts/own.sh", "--flag", "x"), own)).toEqual([]);
    for (const interp of ["/bin/sh", "/bin/bash", "/bin/zsh", "/usr/local/bin/node", "/opt/homebrew/bin/bun", "/usr/bin/python3", "/usr/bin/python3.12", "/usr/bin/ruby", "/usr/bin/perl"]) {
      expect({ interp, w: await wrappersOf(plist(interp, "/h/scripts/own.sh", "arg"), own) }).toEqual({ interp, w: [] });
      expect({ interp, w: await wrappersOf(plist("/usr/bin/env", interp, "/h/scripts/own.sh"), own) }).toEqual({ interp, w: [] });
    }
  });
  test("every other form is counted unadopted as complex argv, whatever the script's owner line says", async () => {
    const own = { "/h/scripts/own.sh": owned, "/h/scripts/own.py": owned, "/h/scripts/own.js": owned, "/opt/evil.sh": "#!/bin/sh\n", "/opt/evil.py": "#!/bin/sh\n", "/opt/evil.rb": "#!/bin/sh\n" };
    const forms: string[][] = [
      ["/bin/bash", "-eo", "pipefail", "/opt/evil.sh"],
      ["/bin/bash", "-oe", "pipefail", "/opt/evil.sh"],
      ["/bin/bash", "-oo", "a", "b", "/opt/evil.sh"],
      ["/bin/bash", "-", "/opt/evil.sh"],
      ["/bin/bash", "--", "/opt/evil.sh"],
      ["/bin/bash", "-s", "/h/scripts/own.sh"],
      ["/bin/bash", "-c", "echo hi"],
      ["/bin/bash", "--init-file", "/h/scripts/own.sh", "/opt/evil.sh"],
      ["/usr/bin/python3", "-I", "/opt/evil.py", "/h/scripts/own.py"],
      ["/usr/bin/python3", "-m", "mod", "/h/scripts/own.py"],
      ["/usr/bin/python3", "-c", "print(1)"],
      ["/usr/bin/perl", "-W", "/opt/evil.sh", "/h/scripts/own.sh"],
      ["/usr/bin/ruby", "-E", "UTF-8", "/opt/evil.rb"],
      ["/usr/bin/ruby", "-W", "/opt/evil.rb"],
      ["/usr/local/bin/node", "-p", "1", "/h/scripts/own.js"],
      ["/usr/local/bin/node", "--require", "/h/scripts/own.js", "/opt/evil.sh"],
      ["/opt/homebrew/bin/bun", "exec", "/h/scripts/own.sh"],
      ["/opt/homebrew/bin/bun", "x", "/h/scripts/own.sh"],
      ["/opt/homebrew/bin/bun", "run", "/h/scripts/own.sh"],
      ["/usr/bin/env", "-S", "bash /opt/evil.sh"],
      ["/usr/bin/env", "-Sbash /opt/evil.sh"],
      ["/usr/bin/env", "-u", "FOO", "bash", "/opt/evil.sh"],
      ["/usr/bin/env", "-i", "bash", "/opt/evil.sh"],
      ["/usr/bin/env", "-", "bash", "/opt/evil.sh"],
      ["/usr/bin/env", "FOO=1", "bash", "/h/scripts/own.sh"],
      ["/usr/bin/env", "--", "bash", "/opt/evil.sh"],
      ["/usr/bin/env", "env", "bash", "/opt/evil.sh"],
      ["/usr/bin/env", "bash"],
      ["/usr/bin/env", "/opt/evil", "/h/scripts/own.sh"],
      ["/usr/bin/env", "/usr/bin/evil", "/h/scripts/own.sh"],
      ["/usr/bin/env", "bash", "-x", "/opt/evil.sh"],
      ["/bin/bash"],
      ["zzz-unknown-interp", "/h/scripts/own.sh"],
      ["relative/own.sh"],
    ];
    for (const argv of forms) {
      const w = await wrappersOf(plist(...argv), own);
      expect({ argv, n: w.length, complex: w[0]?.includes(" complex argv: ") }).toEqual({ argv, n: 1, complex: true });
    }
  });
  test("shapes (b) and (c) judge a script that has no shebang; shape (a) skips a binary", async () => {
    const files = { "/h/scripts/own.py": "print(1)\n", "/opt/evil.py": "print(1)\n", "/opt/bin.bin": "\u0000ELF" };
    expect(await wrappersOf(plist("/usr/bin/python3", "/opt/evil.py"), files)).toEqual([`${A}/t.plist runs /opt/evil.py`]);
    expect(await wrappersOf(plist("/usr/local/bin/node", "/opt/evil.py"), files)).toEqual([`${A}/t.plist runs /opt/evil.py`]);
    expect(await wrappersOf(plist("/usr/bin/env", "python3", "/opt/evil.py"), files)).toEqual([`${A}/t.plist complex argv: /usr/bin/env python3 /opt/evil.py`]); // a bare interpreter name is not in a standard directory
    expect(await wrappersOf(plist("/usr/bin/env", "/usr/bin/python3", "/opt/evil.py"), files)).toEqual([`${A}/t.plist runs /opt/evil.py`]);
    expect(await wrappersOf(plist("/usr/bin/python3", "/h/scripts/own.py"), files)).toEqual([`${A}/t.plist runs /h/scripts/own.py`]); // no owner line
    expect(await wrappersOf(plist("/opt/bin.bin", "--x"), files)).toEqual([]);
  });
  test("an interpreter or env outside the standard directories, or with a malformed version, is complex", async () => {
    const files = { "/h/scripts/own.sh": owned };
    for (const argv of [["/tmp/bash", "/h/scripts/own.sh"], ["/opt/x/bash", "/h/scripts/own.sh"], ["/tmp/env", "bash", "/h/scripts/own.sh"], ["/usr/local/bin/env", "/bin/bash", "/h/scripts/own.sh"]]) {
      const w = await wrappersOf(plist(...argv), files);
      expect({ argv, complex: w.length === 1 && w[0]!.includes("complex argv") }).toEqual({ argv, complex: true });
    }
    // A name that is no interpreter (sh.., python3.) is a program of its own: shape (a), judged as a script.
    const own2 = { ...files, "/bin/sh..": "#!/bin/sh\n", "/usr/bin/python3.": "#!/bin/sh\n" };
    expect(await wrappersOf(plist("/bin/sh..", "/h/scripts/own.sh"), own2)).toEqual([`${A}/t.plist runs /bin/sh..`]);
    expect(await wrappersOf(plist("/usr/bin/python3.", "/h/scripts/own.sh"), own2)).toEqual([`${A}/t.plist runs /usr/bin/python3.`]);
    expect(await wrappersOf(plist("/usr/bin/bash5.1", "/h/scripts/own.sh"), files)).toEqual([]);
    expect(await wrappersOf(plist("/usr/bin/env", "/bin/bash", "/h/scripts/own.sh"), files)).toEqual([]);
  });
  test("a parsed plist that cannot be judged is complex, named by why; unreadable is complex too", async () => {
    const files = { "/h/scripts/own.sh": owned };
    const forms: Record<string, [Record<string, unknown>, string]> = {
      emptyArray: [{ ProgramArguments: [] }, "ProgramArguments is not a list of strings"],
      emptyString: [{ ProgramArguments: ["", "/h/scripts/own.sh"] }, "ProgramArguments is not a list of strings"],
      integer: [{ ProgramArguments: ["/h/scripts/own.sh", 1] }, "ProgramArguments is not a list of strings"],
      notArray: [{ ProgramArguments: "/h/scripts/own.sh" }, "ProgramArguments is not a list of strings"],
      programNotString: [{ Program: 5, ProgramArguments: ["/h/scripts/own.sh"] }, "Program is not a string"],
      neither: [{ Label: "x" }, "no Program or ProgramArguments"],
      envNotDict: [{ ProgramArguments: ["/h/scripts/own.sh"], EnvironmentVariables: ["x"] }, "EnvironmentVariables is not a dictionary"],
    };
    for (const [name, [obj, why]] of Object.entries(forms)) expect({ name, w: await wrappersOf(JSON.stringify(obj), files) }).toEqual({ name, w: [`${A}/t.plist complex plist: ${why}`] });
    // plistJson gives nothing (no plutil, a non-plist, too big, not an object): unreadable.
    const f = fs({}, { [A]: ["t.plist"] });
    const unreadable = await cruftCount({ fs: { ...f, plistJson: async () => undefined }, configDir: "/cfg", pinRoots: [], ownerlessConfigValues: [] });
    expect(unreadable.wrappers).toEqual([`${A}/t.plist complex plist: unreadable`]);
    const absent = await cruftCount({ fs: { home: "/h", listDir: async (d: string) => (d === A ? ["t.plist"] : []), readHead: async () => undefined, pinFiles: () => [] }, configDir: "/cfg", pinRoots: [], ownerlessConfigValues: [] });
    expect(absent.wrappers).toEqual([`${A}/t.plist complex plist: unreadable`]);
    // A plain legit plist (a KeepAlive dict and other keys) reads and adopts.
    expect(await wrappersOf(JSON.stringify({ Label: "x", ProgramArguments: ["/h/scripts/own.sh"], KeepAlive: { Crashed: true }, RunAtLoad: true }), files)).toEqual([]);
  });
  test("a variable that makes an interpreter run other code makes the plist complex", async () => {
    const files = { "/h/scripts/own.sh": owned };
    for (const key of ["BASH_ENV", "ENV", "NODE_OPTIONS", "PERL5OPT", "RUBYOPT", "PYTHONPATH", "PYTHONSTARTUP", "BUN_OPTIONS", "ZDOTDIR", "HOME", "DYLD_INSERT_LIBRARIES", "DYLD_LIBRARY_PATH", "PERL5LIB", "RUBYLIB", "NODE_PATH", "PYTHONHOME"]) {
      const o = JSON.stringify({ ProgramArguments: ["/h/scripts/own.sh"], EnvironmentVariables: { [key]: "x" } });
      expect({ key, w: await wrappersOf(o, files) }).toEqual({ key, w: [`${A}/t.plist complex plist: sets ${key}`] });
    }
  });
  test("only a listed environment variable keeps a plist judged: any other name is complex", async () => {
    const files = { "/h/scripts/own.sh": owned };
    const env = (e: Record<string, string>) => wrappersOf(JSON.stringify({ ProgramArguments: ["/h/scripts/own.sh"], EnvironmentVariables: e }), files);
    expect(await env({ PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/sbin", LANG: "en_US.UTF-8", LC_ALL: "C", LC_CTYPE: "POSIX", TZ: "UTC" })).toEqual([]);
    const sets = (k: string) => [`${A}/t.plist complex plist: sets ${k}`];
    // PATH: only exact system dirs (a planted dir ahead of /usr/bin runs its own env, bash or date for the owned script).
    for (const path of ["/tmp/planted:/usr/bin:/bin", "", "/usr/bin::/bin", "bin:/usr/bin", "/usr/bin/../../tmp", "/usr/bin/", "/hm/x/bin:/usr/bin"])
      expect({ path, w: await env({ PATH: path }) }).toEqual({ path, w: sets("PATH") });
    // Locale: C, POSIX, or <letters>_<letters>.UTF-8 only (a Big5 or GBK locale makes bash read a multibyte tail as a quote).
    for (const [k, v] of [["LANG", "zh_TW.Big5"], ["LC_ALL", "zh_CN.GBK"], ["LC_CTYPE", "en_US"], ["LANG", ""], ["LANG", "en_US.UTF-8x"], ["LANG", "../x.UTF-8"]] as const)
      expect({ k, v, w: await env({ [k]: v }) }).toEqual({ k, v, w: sets(k) });
    // An empty name is complex itself and does not hide a later key.
    expect(await env({ "": "v", BASH_ENV: "x" })).toEqual(sets(""));
    expect(await env({ TMPDIR: "/tmp" })).toEqual(sets("TMPDIR"));
    // TZ: a string, and it does not end the loop (a later bad key is still judged).
    expect(await env({ TZ: "UTC", BASH_ENV: "x" })).toEqual(sets("BASH_ENV"));
    expect(await env({ TZ: ["UTC"] as unknown as string })).toEqual(sets("TZ"));
    expect(await env({ TZ: { a: "b" } as unknown as string })).toEqual(sets("TZ"));
    expect(await env({ PATH: ["/usr/bin"] as unknown as string })).toEqual(sets("PATH"));
    for (const path of [".", "/tmp", "/usr/bin:.", "/var/tmp:/usr/bin"]) expect({ path, w: await env({ PATH: path }) }).toEqual({ path, w: sets("PATH") });
    // Names the old list of code-running variables did not hold: lower case, other interpreters' hooks, loader and shell settings.
    for (const key of ["bash_env", "LD_PRELOAD", "GEM_HOME", "RUBYGEMS_GEMDEPS", "PYTHONUSERBASE", "BASH_FUNC_x%%", "SHELLOPTS", "PS4", "NODE_EXTRA_CA_CERTS", "MY_FLAG"])
      expect({ key, w: await env({ LANG: "C", [key]: "x" }) }).toEqual({ key, w: [`${A}/t.plist complex plist: sets ${key}`] });
  });
  test("a NUL anywhere in the parsed plist, an entity in its source, and a key that changes what runs are complex", async () => {
    const files = { "/h/scripts/own.sh": owned };
    const nul = (o: object) => JSON.stringify(o);
    expect(await wrappersOf(nul({ "Program\u0000x": "/opt/evil.sh", ProgramArguments: ["/h/scripts/own.sh"] }), files)).toEqual([`${A}/t.plist complex plist: NUL`]);
    expect(await wrappersOf(nul({ ProgramArguments: ["/h/scripts/own.sh"], EnvironmentVariables: { "BASH_ENV\u0000": "x" } }), files)).toEqual([`${A}/t.plist complex plist: NUL`]);
    expect(await wrappersOf(nul({ ProgramArguments: ["/h/scripts/own.sh\u0000x"] }), files)).toEqual([`${A}/t.plist complex plist: NUL`]);
    for (const e of ["&#x2F;", "&#X2f;"]) expect(await wrappersOf(`{"ProgramArguments":["/h/scripts${e}own.sh"]}`, files)).toEqual([`${A}/t.plist complex plist: entity`]);
    expect(await wrappersOf(`{"ProgramArguments":["/h/scripts/own.sh"],"Label":"a&amp;b &lt; c"}`, files)).toEqual([]); // the five named entities read the same in both parsers
    for (const key of ["RootDirectory", "EnableGlobbing", "WorkingDirectory", "BundleProgram", "StandardInPath", "inetdCompatibility"]) expect(await wrappersOf(nul({ ProgramArguments: ["/h/scripts/own.sh"], [key]: true }), files)).toEqual([`${A}/t.plist complex plist: sets ${key}`]);
  });
  test("top-level keys are matched without case and only a listed key keeps a plist judged", async () => {
    const own = ["/h/scripts/own.sh"];
    const files = { "/h/scripts/own.sh": owned };
    const w = (o: object) => wrappersOf(JSON.stringify(o), files);
    const sets = (k: string) => [`${A}/t.plist complex plist: sets ${k}`];
    const PROGRAM_DIFFERS = [`${A}/t.plist complex argv: /h/scripts/own.sh`];
    // launchd lowercases every job key, so a differently cased spelling is the same key.
    for (const key of ["workingdirectory", "workingDirectory", "WORKINGDIRECTORY", "rootdirectory", "enableglobbing"]) expect({ key, w: await w({ ProgramArguments: own, [key]: "/tmp/planted" }) }).toEqual({ key, w: sets(key) });
    expect(await w({ programarguments: own, LABEL: "x", runatload: true })).toEqual([]); // fails at cruft.ts:118 if programarguments is read by exact case
    expect(await w({ PROGRAM: "/h/scripts/own.sh", programarguments: own })).toEqual([]); // Program equal to argv[0] is shape (a)
    for (const key of ["PROGRAM", "pRoGrAm"]) expect({ key, w: await w({ [key]: "/opt/evil.sh", ProgramArguments: own }) }).toEqual({ key, w: PROGRAM_DIFFERS }); // fails at cruft.ts:117 if Program is read as o.Program or o.program ?? o.Program
    expect(await w({ program: "/opt/evil.sh", ProgramArguments: own })).toEqual(PROGRAM_DIFFERS); // fails at cruft.ts:117 if Program is read as o.Program: the lowercase one is missed and the plist counts adopted
    expect(await w({ programarguments: ["/opt/evil.sh"], ProgramArguments: own })).toEqual([`${A}/t.plist complex plist: duplicate key ProgramArguments`]); // fails at cruft.ts:112 if the duplicate check is dropped
    expect(await w({ Program: "/opt/evil.sh", program: "/h/scripts/own.sh", ProgramArguments: own })).toEqual([`${A}/t.plist complex plist: duplicate key program`]);
    expect(await w({ ProgramArguments: own, environmentvariables: { BASH_ENV: "/tmp/x.sh" } })).toEqual(sets("BASH_ENV")); // fails at cruft.ts:119 if EnvironmentVariables is read as o.EnvironmentVariables
    expect(await w({ ProgramArguments: own, EnvironmentVARIABLES: { LANG: "zh_TW.Big5" } })).toEqual(sets("LANG"));
    expect(await w({ ProgramArguments: own, environmentvariables: { LANG: "C" } })).toEqual([]);
    // Only a key on the list keeps it judged: unknown, underscore-prefixed, and the keys that change who or how it runs.
    for (const key of ["Bogus", "_SubsystemRoot", "BinaryOrderPreference", "DisableASLR", "UserEnvironmentVariables", "UserName", "GroupName", "InitGroups", "Sockets", "Debug", "LaunchEvents", "HopefullyExitsLast"])
      expect({ key, w: await w({ ProgramArguments: own, [key]: key === "UserEnvironmentVariables" ? { BASH_ENV: "/tmp/x.sh" } : "x" }) }).toEqual({ key, w: sets(key) });
    // The listed keys (each is in `man launchd.plist`) keep it judged. This only checks that each name is admitted, so every value is a placeholder.
    for (const key of ["Label", "Disabled", "RunAtLoad", "KeepAlive", "OnDemand", "StartInterval", "StartCalendarInterval", "StartOnMount", "WatchPaths", "QueueDirectories", "ThrottleInterval", "StandardOutPath", "StandardErrorPath", "ProcessType", "Nice", "LowPriorityIO", "LowPriorityBackgroundIO", "AbandonProcessGroup", "LaunchOnlyOnce", "ExitTimeOut", "TimeOut", "Umask", "LimitLoadToHosts", "LimitLoadFromHosts", "LimitLoadToSessionType", "LimitLoadToHardware", "LimitLoadFromHardware", "SoftResourceLimits", "HardResourceLimits", "EnableTransactions", "EnablePressuredExit", "SessionCreate", "AssociatedBundleIdentifiers", "MachServices"])
      expect({ key, w: await w({ ProgramArguments: own, [key]: "x" }) }).toEqual({ key, w: [] });
  });
  test("the encoding declaration is matched in bounded time on a crafted full-size plist", () => {
    // Many UTF-8 encoding attributes and no "?>": an unbounded [^>?]* pair retries the whole tail from each one (quadratic).
    const raw = `<?xml${' encoding="utf-8"'.repeat(Math.floor((256 * 1024 - 8) / 17))}`;
    const t0 = performance.now();
    expect(sourceProblem(raw)).toBe("plist encoding");
    expect(performance.now() - t0).toBeLessThan(500);
    expect(sourceProblem('<?xml version="1.0" encoding="UTF-8"?>\n<plist/>')).toBeUndefined();
  });
  test("the encoding declaration bounds are exact: 8 spaces around = and a 256-character tail pass, 9 and 257 do not", () => {
    const decl = (sp: number, tail: number) => `<?xml version="1.0" encoding${" ".repeat(sp)}=${" ".repeat(sp)}"utf-8"${"x".repeat(tail)}?><plist/>`;
    expect(sourceProblem(decl(8, 0))).toBeUndefined(); // fails if \s{0,8} is widened or narrowed
    expect(sourceProblem(decl(9, 0))).toBe("plist encoding");
    const side = (before: number, after: number) => `<?xml version="1.0" encoding${" ".repeat(before)}=${" ".repeat(after)}"utf-8"?><plist/>`;
    expect(sourceProblem(side(9, 0))).toBe("plist encoding"); // fails if the \s{0,8} before = is widened
    expect(sourceProblem(side(0, 9))).toBe("plist encoding"); // fails if the \s{0,8} after = is widened
    expect(sourceProblem(side(8, 0))).toBeUndefined();
    expect(sourceProblem(side(0, 8))).toBeUndefined();
    expect(sourceProblem(decl(1, 256))).toBeUndefined(); // fails if the tail {0,256} is widened or narrowed
    expect(sourceProblem(decl(1, 257))).toBe("plist encoding");
    const head = (n: number) => `<?xml${" ".repeat(n)} encoding="utf-8"?><plist/>`;
    expect(sourceProblem(head(255))).toBeUndefined(); // fails if the head run before encoding is widened or narrowed
    expect(sourceProblem(head(257))).toBe("plist encoding");
  });
  test("a text plist is judged only when its source is plain: encoding, CDATA, entity, an unreadable or full raw read", async () => {
    const own = "/h/scripts/own.sh";
    const files: Record<string, string> = { [own]: owned };
    const judge = async (raw: string | undefined) => (await cruftCount({ fs: { home: "/h", listDir: async (d: string) => (d === A ? ["t.plist"] : []), readHead: async (p: string, n: number) => (p.endsWith(".plist") ? raw?.slice(0, n) : files[p]), plistJson: async () => ({ ProgramArguments: [own] }), pinFiles: () => [] }, configDir: "/cfg", pinRoots: [], ownerlessConfigValues: [] })).wrappers;
    const w = (why: string) => [`${A}/t.plist complex plist: ${why}`];
    expect(await judge("<plist><dict/></plist>")).toEqual([]);
    expect(await judge("\uFEFF \n<plist>x &amp; &quot;y&apos; &lt;&gt;</plist>")).toEqual([]);
    expect(await judge("bplist00\u0000\u0001")).toEqual([]);
    expect(await judge("\uFFFD\uFFFD<\u0000p\u0000")).toEqual(w("plist encoding"));
    expect(await judge("<\u0000p")).toEqual(w("plist encoding"));
    expect(await judge("{\"ProgramArguments\":[]}")).toEqual(w("plist encoding"));
    expect(await judge("<plist><![CDATA[/a/b&#46;sh]]></plist>")).toEqual(w("CDATA"));
    for (const e of ["&#46;", "&#x2F;", "&#X2f;", "&foo;", "& ", "&amp"]) expect({ e, w: await judge(`<plist>a${e}b</plist>`) }).toEqual({ e, w: w("entity") });
    // A declared encoding: only the leading declaration naming UTF-8 is accepted (plutil follows others, libxpc does not).
    for (const ok of ['<?xml version="1.0" encoding="UTF-8"?><plist/>', "<?xml version='1.0' encoding='utf-8'?><plist/>", '\uFEFF<?xml version="1.0" encoding = "Utf-8" standalone="yes"?><plist/>', '<?xml version="1.0"?><plist/>']) expect({ ok, w: await judge(ok) }).toEqual({ ok, w: [] });
    for (const bad of ['<?xml version="1.0" encoding="UTF-7"?><plist/>', "<?xml version='1.0' encoding='utf-7'?><plist/>", '<?xml version="1.0" encoding="ISO-8859-1"?><plist/>', '<?xml version="1.0" encoding="UTF-8"?><?xml version="1.0" encoding="UTF-7"?><plist/>', '<?xml version="1.0" encoding="UTF-8" encoding="UTF-7"?><plist/>', '<plist><!-- x --><?xml encoding="UTF-8"?></plist>', '<?xml version="1.0" encoding="windows-1252"?><plist/>', '<plist encoding="UTF-8"/>', '<?xml version="1.0" encoding="UTF-8x"?><plist/>']) expect({ bad, w: await judge(bad) }).toEqual({ bad, w: w("plist encoding") });
    expect(await judge(undefined)).toEqual(w("unreadable"));
    expect(await judge(`<plist>${"x".repeat(256 * 1024)}</plist>`)).toEqual(w("unreadable")); // fills the read bound: it may have been cut
  });
  test("a Program that differs from argv[0] is complex; one equal to it, or alone, is judged as shape (a)", async () => {
    const own = { "/h/scripts/own.sh": owned, "/opt/evil.sh": "#!/bin/sh\n" };
    const withProgram = (program: string, ...argv: string[]) => JSON.stringify({ Program: program, ProgramArguments: argv });
    expect(await wrappersOf(withProgram("/opt/evil.sh", "/h/scripts/own.sh"), own)).toEqual([`${A}/t.plist complex argv: /h/scripts/own.sh`]);
    expect(await wrappersOf(withProgram("/h/scripts/own.sh", "/h/scripts/own.sh"), own)).toEqual([]);
    expect(await wrappersOf(JSON.stringify({ Program: "/h/scripts/own.sh" }), own)).toEqual([]);
    expect(await wrappersOf(JSON.stringify({ Program: "/opt/evil.sh" }), own)).toEqual([`${A}/t.plist runs /opt/evil.sh`]);
  });
  test("a program whose name only starts like an interpreter is shape (a), judged as its own script", async () => {
    const files = { "/h/scripts/own.sh": owned, "/opt/bin/bash-evil": "#!/bin/sh\n" };
    expect(await wrappersOf(plist("/opt/bin/bash-evil", "/h/scripts/own.sh"), files)).toEqual([`${A}/t.plist runs /opt/bin/bash-evil`]);
  });
  test("shape (b) takes no option word before the script", () => {
    expect(launchScript({ argv: ["/bin/bash", "/opt/a.sh"] })).toEqual({ script: "/opt/a.sh", shebang: false });
    expect(launchScript({ argv: ["/bin/bash", "-x", "/opt/a.sh"] })).toBe("complex");
  });
  test("plistLaunch reads Program and ProgramArguments of a parsed plist", () => {
    expect(plistLaunch({ ProgramArguments: ["/a", "b"] })).toEqual({ argv: ["/a", "b"] });
    expect(plistLaunch({ Program: "/p" })).toEqual({ program: "/p", argv: ["/p"] });
    expect(plistLaunch({ Label: "x" })).toBe("no Program or ProgramArguments");
  });
  test("the summary line carries the three counts and says it is this host only", () => {
    expect(cruftLines({ pins: ["p"], backups: ["a", "b"], wrappers: [] })[0]).toBe("cruft: pins 1 ownerless, backups 2, wrappers 0 unadopted (this host only)");
  });
  test("--cruft-count is a host mode that takes --config", () => {
    expect(parseHostCommand(["--cruft-count", "--config", "/c.json"])).toEqual({ mode: "cruft", config: "/c.json" });
    expect(() => parseHostCommand(["--cruft-count", "--apply"])).toThrow();
  });
});

describe("realFs.readHead", () => {
  const root = mkdtempSync(join(tmpdir(), "oupdate-cruft-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  test("reads only the first bytes of a regular file; a directory, a FIFO and a link to a FIFO read as nothing, without waiting", async () => {
    writeFileSync(join(root, "f"), "#!/bin/sh\n0123456789");
    execFileSync("mkfifo", [join(root, "p")]);
    expect(await realFs.readHead!(join(root, "f"), 9)).toBe("#!/bin/sh");
    expect(await realFs.readHead!(root, 9)).toBeUndefined();
    expect(await realFs.readHead!(join(root, "p"), 9)).toBeUndefined();
    symlinkSync(join(root, "p"), join(root, "l"));
    expect(await realFs.readHead!(join(root, "l"), 9)).toBeUndefined();
    expect(await realFs.readHead!(join(root, "missing"), 9)).toBeUndefined();
    expect(await realFs.readHead!("/dev/null", 6)).toBeUndefined(); // a character device: only the fstat guard refuses it
  });
});

describe("realFs.readHead opens only a regular file (OUP-367)", () => {
  test("a device or a directory is rejected by a stat before any open", async () => {
    const opened: string[] = [];
    const spy = spyOn(nodeFs, "openSync").mockImplementation(((p: string) => { opened.push(String(p)); throw new Error("blocked by the test"); }) as typeof nodeFs.openSync);
    try {
      // Fails at fs.ts readHead (the stat before openSync): the old code opened /dev/null, then asked the descriptor.
      expect(await realFs.readHead!("/dev/null", 6)).toBeUndefined();
      expect(await realFs.readHead!("/dev", 6)).toBeUndefined();
      expect(opened).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });
  test("with noFollow the open carries O_NOFOLLOW, and a link at the path is rejected by lstat before any open (OUP-367)", async () => {
    const r = realpathSync(mkdtempSync(join(tmpdir(), "oupdate-nofollow-")));
    const calls: { p: string; flags: number }[] = [];
    const spy = spyOn(nodeFs, "openSync").mockImplementation(((p: string, flags: number) => { calls.push({ p: String(p), flags }); throw new Error("blocked by the test"); }) as typeof nodeFs.openSync);
    try {
      writeFileSync(join(r, "solo"), "x");
      symlinkSync(join(r, "solo"), join(r, "sl"));
      // Fails at fs.ts readHead (the O_NOFOLLOW term of the open flags): lstat and the open flag overlap, so only the flags show it.
      await realFs.readHead!(join(r, "solo"), 9, { noFollow: true });
      expect(calls.length).toBe(1);
      expect(calls[0]!.flags & nodeFs.constants.O_NOFOLLOW).toBe(nodeFs.constants.O_NOFOLLOW);
      await realFs.readHead!(join(r, "solo"), 9);
      expect(calls[1]!.flags & nodeFs.constants.O_NOFOLLOW).toBe(0);
      // Fails at fs.ts readHead (the O_NONBLOCK term): a FIFO swapped in after the stat would otherwise wait for a writer forever.
      expect(calls[0]!.flags & nodeFs.constants.O_NONBLOCK).toBe(nodeFs.constants.O_NONBLOCK);
      // Fails at fs.ts readHead (lstat instead of stat when meta.noFollow): a link at the path never reaches openSync.
      calls.length = 0;
      expect(await realFs.readHead!(join(r, "sl"), 9, { noFollow: true })).toBeUndefined();
      expect(calls).toEqual([]);
    } finally {
      spy.mockRestore();
      rmSync(r, { recursive: true, force: true });
    }
  });
  test("a regular file is read, and the same open reports its link count; a link is not followed when asked (OUP-367)", async () => {
    const r = realpathSync(mkdtempSync(join(tmpdir(), "oupdate-head-")));
    try {
      writeFileSync(join(r, "f"), "#!/bin/sh\n");
      linkSync(join(r, "f"), join(r, "g"));
      writeFileSync(join(r, "solo"), "x");
      symlinkSync(join(r, "solo"), join(r, "sl"));
      const links = async (p: string, noFollow = false) => { const m: { links?: number; noFollow?: boolean } = { noFollow }; return { text: await realFs.readHead!(p, 9, m), links: m.links }; };
      // Fails at fs.ts readHead (meta.links = fstat nlink of the open descriptor): the count comes from the descriptor that was read.
      expect(await links(join(r, "f"))).toEqual({ text: "#!/bin/sh", links: 2 });
      expect(await links(join(r, "solo"))).toEqual({ text: "x", links: 1 });
      expect((await links(join(r, "missing"))).text).toBeUndefined();
      // Fails at fs.ts readHead (O_NOFOLLOW when meta.noFollow is set): a link swapped in after the path was resolved is not read.
      expect((await links(join(r, "sl"), true)).text).toBeUndefined();
      expect((await links(join(r, "sl"))).text).toBe("x");
    } finally {
      rmSync(r, { recursive: true, force: true });
    }
  });
});

describe("adoption resolves symlinks (OUP-366)", () => {
  // The temp root is canonical (/var is /private/var on macOS), so a failing link check is the link, not the prefix.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "oupdate-link-")));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const A = "/h/Library/LaunchAgents";
  const owned = "#!/bin/sh\n# owner: t\n";
  const adopted = join(root, "scripts");
  const outside = join(root, "outside");
  const real = join(root, "real-scripts");
  for (const d of [adopted, outside, real, join(outside, "d"), join(outside, "w")]) mkdirSync(d, { recursive: true });
  writeFileSync(join(outside, "x.sh"), owned);
  writeFileSync(join(outside, "d", "x.sh"), owned);
  writeFileSync(join(outside, "own.sh"), owned);
  writeFileSync(join(adopted, "own.sh"), owned);
  writeFileSync(join(real, "r.sh"), owned);
  symlinkSync(join(outside, "x.sh"), join(adopted, "link.sh"));
  symlinkSync(join(outside, "d"), join(adopted, "link"));
  symlinkSync(join(outside, "d"), join(adopted, "hop"));
  symlinkSync(adopted, join(outside, "w", "in"));
  symlinkSync(real, join(root, "scripts-link"));
  symlinkSync(adopted, join(outside, "w2"));
  symlinkSync(join(root, "nowhere"), join(adopted, "dangling.sh"));
  const host = (script: string, dir: string, over: Record<string, unknown> = {}) =>
    cruftCount({
      fs: { home: "/h", listDir: async (d: string) => (d === A ? ["t.plist"] : []), readHead: async (p: string, n: number, m?: { links?: number; noFollow?: boolean }) => (p.endsWith(".plist") ? "<plist/>" : realFs.readHead!(p, n, m)), realPath: realFs.realPath!, plistJson: async () => ({ ProgramArguments: [script] }), pinFiles: () => [], ...over },
      configDir: "/cfg", pinRoots: [], ownerlessConfigValues: [], adoptedScriptsDir: dir,
    }).then((c) => c.wrappers);
  const runs = (s: string) => [`${A}/t.plist runs ${s}`];
  test("a link inside the adopted directory that points outside it, or a directory that is itself a link, is judged by its real path", async () => {
    // Fail at cruft.ts:246 (`real!.startsWith(realAdopted)`) if the script is judged by its lexical path: the link counts adopted.
    expect(await host(join(adopted, "link.sh"), adopted)).toEqual(runs(join(adopted, "link.sh")));
    expect(await host(join(adopted, "own.sh"), adopted)).toEqual([]);
    // Fail at cruft.ts:175 if the adopted dir is compared lexically: its real files are inside its real path.
    expect(await host(join(root, "scripts-link", "r.sh"), join(root, "scripts-link"))).toEqual([]);
    expect(await host(join(real, "r.sh"), join(root, "scripts-link"))).toEqual([]);
    expect(await host(join(adopted, "dangling.sh"), adopted)).toEqual(runs(join(adopted, "dangling.sh"))); // no body: counted as missing
  });
  test("a .. after a link is followed by the link first, as the kernel does; so is the adopted dir's own ..", async () => {
    // This script is already rejected by the dotted term, so this line does not pin fs.ts realPath being .native: the adopted-dir
    // lines below (scripts/hop/..) and the missing/.. test do.
    expect(await host(`${adopted}/link/../own.sh`, adopted)).toEqual(runs(`${adopted}/link/../own.sh`));
    // Fails at cruft.ts:175 if the adopted dir is collapsed by resolve() before it is canonicalized (scripts/hop/.. is outside).
    expect(await host(join(adopted, "own.sh"), `${adopted}/hop/..`)).toEqual(runs(join(adopted, "own.sh")));
  });
  test("both the path as given and its real path must be inside the adopted directory", async () => {
    // Fails at cruft.ts:246 (the `run.script.startsWith` terms) if the plain path is not also checked: outside/w2 links to scripts, so the real path is inside.
    expect(await host(join(outside, "w2", "own.sh"), adopted)).toEqual(runs(join(outside, "w2", "own.sh")));
    expect(await host(join(outside, "w", "in", "own.sh"), adopted)).toEqual(runs(join(outside, "w", "in", "own.sh")));
  });
  test("a script path with a . or .. segment is unadopted, even when the plain and the real form both land inside", async () => {
    mkdirSync(join(adopted, "sub"), { recursive: true });
    writeFileSync(join(adopted, "sub", "own.sh"), owned);
    symlinkSync(join(adopted, "sub"), join(adopted, "inlink"));
    // Fails at the `!dotted(run.script)` term in cruft.ts:246: adopted/inlink/../own.sh is adopted/own.sh both as resolve() and as the kernel reads it.
    expect(await host(`${adopted}/inlink/../own.sh`, adopted)).toEqual(runs(`${adopted}/inlink/../own.sh`));
    expect(await host(`${adopted}/./own.sh`, adopted)).toEqual(runs(`${adopted}/./own.sh`));
    expect(await host(join(adopted, "own.sh"), adopted)).toEqual([]); // the plain spelling stays adopted
  });
  test("a configured adopted dir that does not resolve adopts nothing, and one with a dot segment is compared by its real path only", async () => {
    const own = join(adopted, "own.sh");
    // Fails at cruft.ts:175 and :186 (realAdopted): the lexical fallback turns scripts/missing/.. into scripts.
    expect(await host(own, `${adopted}/missing/..`)).toEqual(runs(own));
    expect(await host(own, join(root, "no-such-dir"))).toEqual(runs(own));
    // A failed lookup of the adopted dir, with a script whose real path (stubbed) reads "undefined/...": fails at the
    // `realAdopted !== undefined` term in cruft.ts:246, where startsWith(undefined) would look for the string "undefined".
    const ghost = join(root, "no-such-dir", "own.sh");
    const odd = "undefined/own.sh";
    expect(await host(ghost, join(root, "no-such-dir"), { realPath: async (p: string) => (p === ghost ? odd : realFs.realPath!(p)), readHead: async (p: string, n: number) => (p === odd ? owned : p.endsWith(".plist") ? "<plist/>" : realFs.readHead!(p, n)) })).toEqual(runs(ghost));
    // A dot segment that does resolve still adopts the files really inside it.
    expect(await host(own, `${adopted}/.`)).toEqual([]);
    // The plain prefix is the configured string, never resolve()d (cruft.ts:176): toSub -> scripts/sub, so outside/toSub/.. is
    // really scripts; resolve() would make it outside/, and outside/w2 (a link to scripts) would look adopted.
    mkdirSync(join(adopted, "sub"), { recursive: true });
    symlinkSync(join(adopted, "sub"), join(outside, "toSub"));
    expect(await host(join(outside, "w2", "own.sh"), `${outside}/toSub/..`)).toEqual(runs(join(outside, "w2", "own.sh")));
  });
  test("a no-shebang program is checked for a second resolution before it is skipped as a binary", async () => {
    const bin = join(adopted, "bin.out");
    writeFileSync(bin, "\u0001\u0002 not a script");
    expect(await host(bin, adopted)).toEqual([]);
    let n = 0;
    // Fails at the order of cruft.ts:224 (second realPath), :225 (`stable`) and :232 (binary skip): the binary shortcut returned before the second realPath, so a swapped path counted as 0.
    expect(await host(bin, adopted, { realPath: async (p: string) => (p === bin && ++n === 2 ? join(outside, "x.sh") : realFs.realPath!(p)) })).toEqual(runs(bin));
  });
  test("the file read and the file judged are one: a path that resolves differently on the second look is unadopted", async () => {
    const script = join(adopted, "job.sh");
    const inside = join(adopted, "own.sh");
    const elsewhere = join(outside, "x.sh");
    const reads: string[] = [];
    let n = 0;
    // The first resolution says outside (owned), the second says inside: readHead read the outside file, the check sees the inside one.
    const retarget = { realPath: async (p: string) => (p === script ? (++n === 1 ? elsewhere : inside) : realFs.realPath!(p)), readHead: async (p: string, b: number) => { reads.push(p); return p.endsWith(".plist") ? "<plist/>" : realFs.readHead!(p, b); } };
    // Outside first, inside second: cruft.ts:225 (`stable`) and cruft.ts:246 (`real!.startsWith`) each block this fixture alone, so it pins neither; the next two fixtures pin `stable`.
    expect(await host(script, adopted, retarget)).toEqual(runs(script));
    expect(reads).toContain(elsewhere); // what was read is the first resolved path, not the one as given
    // The dangerous direction: inside first (owned, adopted), outside second. Fails at cruft.ts:225 (`stable`) if `again === real` is dropped.
    let k = 0;
    expect(await host(inside, adopted, { realPath: async (p: string) => (p === inside && ++k === 2 ? elsewhere : realFs.realPath!(p)) })).toEqual(runs(inside));
    // Fails at cruft.ts:225 (`stable`) too: a second resolution that fails is unadopted, not adopted.
    let m = 0;
    expect(await host(inside, adopted, { realPath: async (p: string) => (p === inside && ++m === 2 ? undefined : realFs.realPath!(p)) })).toEqual(runs(inside));
    // And a script that does not resolve at all is counted, not left out.
    expect(await host(inside, adopted, { realPath: async (p: string) => (p === inside ? undefined : realFs.realPath!(p)) })).toEqual(runs(inside));
  });
  test("an empty direct script is counted, and a binary is still not (OUP-367)", async () => {
    const empty = join(adopted, "empty.sh");
    writeFileSync(empty, "");
    // Fails at the binary skip in cruft.ts (`!body.startsWith("#!")`): an empty body is not a binary, it falls to the owner check.
    expect(await host(empty, adopted)).toEqual(runs(empty));
    const bin = join(adopted, "mach.bin");
    writeFileSync(bin, "\u0001\u0002 binary");
    expect(await host(bin, adopted)).toEqual([]);
  });
  test("a script with more than one name (a hard link) is unadopted (OUP-367)", async () => {
    const hl = join(adopted, "hard.sh");
    linkSync(join(outside, "own.sh"), hl);
    // Fails at the link-count term in cruft.ts: the hard link is inside, owned, its real path is inside, and the file is also outside.
    expect(await host(hl, adopted)).toEqual(runs(hl));
    expect(await host(join(adopted, "own.sh"), adopted)).toEqual([]);
  });
  test("a binary that is swapped for a script after it was read is counted, not skipped (OUP-367)", async () => {
    const bin = join(adopted, "swap.out");
    writeFileSync(bin, "\u0001\u0002 binary");
    let n = 0;
    // Fails at the second read in cruft.ts before the binary skip: the first read says binary, the second says an unowned script.
    expect(await host(bin, adopted, { readHead: async (p: string, b: number) => (p === bin ? (++n === 1 ? "\u0001\u0002 binary" : "#!/bin/sh\n") : p.endsWith(".plist") ? "<plist/>" : realFs.readHead!(p, b)) })).toEqual(runs(bin));
  });
  test("a first head that carries an owner, swapped before the second read for an ownerless script, is counted (OUP-367)", async () => {
    const bin = join(adopted, "own-swap.out");
    writeFileSync(bin, "x");
    const reads = (second: string | undefined, third?: string) => {
      let n = 0;
      return { readHead: async (p: string, b: number) => (p === bin ? (++n === 1 ? "\u0001\u0002\n# owner: x\n" : second) : p.endsWith(".plist") ? "<plist/>" : realFs.readHead!(p, b)) };
    };
    // Fails at cruft.ts (the owner is judged on the second head): the first head's owner line was used after the second read.
    expect(await host(bin, adopted, reads("#!/bin/sh\n"))).toEqual(runs(bin));
    // The second read failing counts too, with the owner of the stale first head not trusted.
    expect(await host(bin, adopted, reads(undefined))).toEqual(runs(bin));
    // Both heads owned and a script: adopted.
    expect(await host(bin, adopted, reads("#!/bin/sh\n# owner: x\n"))).toEqual([]);
  });
  test("the link count comes from the read that supplied the head (OUP-367)", async () => {
    const own = join(adopted, "own.sh");
    // Fails at cruft.ts (links taken from the readHead meta): the count came from a later path lookup, which a swap defeats.
    const twoNames = { readHead: async (p: string, b: number, m?: { links?: number }) => { if (m && p === own) m.links = 2; return p.endsWith(".plist") ? "<plist/>" : realFs.readHead!(p, b); } };
    expect(await host(own, adopted, twoNames)).toEqual(runs(own));
    expect(await host(own, adopted)).toEqual([]);
  });
  test("an empty first head is counted even when a second read would say binary (OUP-367)", async () => {
    const e = join(adopted, "empty2.sh");
    writeFileSync(e, "");
    let n = 0;
    // Fails at the `body !== ""` term of the first guard in cruft.ts: the second read's own guard alone would let it through as a binary.
    expect(await host(e, adopted, { readHead: async (p: string, b: number) => (p === e ? (++n === 1 ? "" : "\u0001") : p.endsWith(".plist") ? "<plist/>" : realFs.readHead!(p, b)) })).toEqual(runs(e));
  });
  test("home spelled another way, a link, or a dot in the configured dir is still a broad dir (OUP-367)", async () => {
    const hm = realpathSync(mkdtempSync(join(tmpdir(), "oupdate-home-")));
    try {
      const at = (home: string, script: string, dir: string) =>
        cruftCount({
          fs: { ...realFs, home, listDir: async (d: string) => (d === `${home}/Library/LaunchAgents` ? ["t.plist"] : []), readHead: async (p: string, n: number, m?: { links?: number }) => (p.endsWith(".plist") ? "<plist/>" : realFs.readHead!(p, n, m)), plistJson: async () => ({ ProgramArguments: [script] }), pinFiles: () => [] },
          configDir: "/cfg", pinRoots: [], ownerlessConfigValues: [], adoptedScriptsDir: dir,
        }).then((c) => c.wrappers.length);
      for (const d of ["Accounts", "Elsewhere", "R", "target", "h1", "h1/scripts"]) mkdirSync(join(hm, d), { recursive: true });
      for (const f of ["Accounts/owned.sh", "R/owned.sh", "target/owned.sh", "h1/owned.sh", "h1/scripts/owned.sh"]) writeFileSync(join(hm, f), owned);
      symlinkSync(join(hm, "Elsewhere"), join(hm, "Accounts", "x")); // home is a link
      symlinkSync(join(hm, "R"), join(hm, "Alias"));
      symlinkSync(join(hm, "Elsewhere"), join(hm, "R", "x"));
      symlinkSync(join(hm, "target"), join(hm, "hl"));
      mkdirSync(join(hm, "R", "dir"));
      // Fails at cruft.ts:183-186 (broad, lexically collapsed plain dir): Alias/. and Alias/dir/.. are Alias, whose home Alias/x is under it.
      expect(await at(`${hm}/Alias/x`, `${hm}/R/owned.sh`, `${hm}/Alias/.`)).toBe(1);
      expect(await at(`${hm}/Alias/x`, `${hm}/R/owned.sh`, `${hm}/Alias/dir/..`)).toBe(1);
      // Fails at the homeReal entry: home is a link, and its real target (or the real parent of it) is the configured dir.
      expect(await at(`${hm}/hl`, `${hm}/target/owned.sh`, `${hm}/target`)).toBe(1);
      expect(await at(`${hm}/hl`, `${hm}/target/owned.sh`, hm)).toBe(1);
      // Fails at broad(realSlash): the configured dir is a link whose real target holds the home.
      expect(await at(`${hm}/R/x`, `${hm}/R/owned.sh`, `${hm}/Alias`)).toBe(1);
      // ~/scripts/.. is home itself.
      expect(await at(`${hm}/h1`, `${hm}/h1/owned.sh`, "~/scripts/..".replace("~", `${hm}/h1`))).toBe(1);
      // Case: on a case-insensitive volume the other spelling of home is the same place.
      if (existsSync(join(hm, "accounts"))) expect(await at(`${hm}/accounts/x`, `${hm}/Accounts/owned.sh`, `${hm}/Accounts`)).toBe(1);
      // A directory of its own inside home is adopted.
      expect(await at(`${hm}/h1`, `${hm}/h1/scripts/owned.sh`, `${hm}/h1/scripts`)).toBe(0);
    } finally {
      rmSync(hm, { recursive: true, force: true });
    }
  });
  test("a binary first read and an owned script with two names on the second read is counted: the second read's link count is judged (OUP-367)", async () => {
    const bin = join(adopted, "links-swap.out");
    writeFileSync(bin, "x");
    let n = 0;
    // Fails at cruft.ts `links = m2.links` (the second read's count): the first read said one name, the second says two.
    const reads = { readHead: async (p: string, b: number, m?: { links?: number }) => { if (p !== bin) return p.endsWith(".plist") ? "<plist/>" : realFs.readHead!(p, b, m); n++; if (m) m.links = n === 1 ? 1 : 2; return n === 1 ? "\u0001\u0002" : "#!/bin/sh\n# owner: x\n"; } };
    expect(await host(bin, adopted, reads)).toEqual(runs(bin));
  });
  test("both script reads refuse a link at the resolved path, and the plist read does not (OUP-367)", async () => {
    const bin = join(adopted, "nf.out");
    writeFileSync(bin, "x");
    const seen: { p: string; noFollow: boolean | undefined }[] = [];
    // Fails at cruft.ts (`noFollow: true` of m1, and of m2): dropping it at either call site leaves one read following a link.
    await host(bin, adopted, { readHead: async (p: string, b: number, m?: { noFollow?: boolean }) => { seen.push({ p, noFollow: m?.noFollow }); return p.endsWith(".plist") ? "<plist/>" : p === bin ? "\u0001\u0002" : realFs.readHead!(p, b); } });
    const scriptReads = seen.filter((x) => x.p === bin);
    expect(scriptReads.map((x) => x.noFollow)).toEqual([true, true]);
    expect(seen.filter((x) => x.p.endsWith(".plist")).every((x) => x.noFollow === undefined)).toBe(true);
  });
  test("an NFC/NFD pair does not hide a broad dir (OUP-367)", async () => {
    // Fails at cruft.ts `.normalize("NFC")` in fold: José spelled decomposed in home and composed in the configured dir.
    const stub = (home: string, script: string, dir: string) =>
      cruftCount({
        fs: { home, listDir: async (d: string) => (d === `${home}/Library/LaunchAgents` ? ["t.plist"] : []), readHead: async (p: string) => (p.endsWith(".plist") ? "<plist/>" : owned), realPath: async (p: string) => p, plistJson: async () => ({ ProgramArguments: [script] }), pinFiles: () => [] },
        configDir: "/cfg", pinRoots: [], ownerlessConfigValues: [], adoptedScriptsDir: dir,
      }).then((c) => c.wrappers.length);
    expect(await stub("/hm/Jose\u0301", "/hm/Jos\u00e9/own.sh", "/hm/Jos\u00e9")).toBe(1);
    expect(await stub("/hm/Jose\u0301", "/hm/Jos\u00e9/scripts/own.sh", "/hm/Jos\u00e9/scripts")).toBe(0);
  });
  test("a root, a top-level directory, the home dir or an ancestor of it adopts nothing (OUP-367)", async () => {
    const stub = (home: string, script: string, dir: string) =>
      cruftCount({
        fs: { home, listDir: async (d: string) => (d === `${home}/Library/LaunchAgents` ? ["t.plist"] : []), readHead: async (p: string) => (p.endsWith(".plist") ? "<plist/>" : owned), realPath: async (p: string) => p, plistJson: async () => ({ ProgramArguments: [script] }), pinFiles: () => [] },
        configDir: "/cfg", pinRoots: [], ownerlessConfigValues: [], adoptedScriptsDir: dir,
      }).then((c) => c.wrappers.length);
    // Fails at the broad-dir test in cruft.ts: each of these adopted every script under it.
    expect(await stub("/hm/x", "/opt/own.sh", "/")).toBe(1);
    expect(await stub("/hm/x", "/hm/y/own.sh", "/hm")).toBe(1);
    expect(await stub("/hm/x", "/hm/x/own.sh", "/hm/x")).toBe(1);
    expect(await stub("/hm/x", "/hm/own.sh", "/hm")).toBe(1);
    expect(await stub("/hm/x", "/opt/own.sh", "/opt")).toBe(1); // top level, not an ancestor of home: the depth test alone
    // A directory of its own, two levels down or inside home, is still adopted.
    expect(await stub("/hm/x", "/opt/scripts/own.sh", "/opt/scripts")).toBe(0);
    expect(await stub("/hm/x", "/hm/x/scripts/own.sh", "~/scripts")).toBe(0);
  });
});

describe("the real plutil read (OUP-349)", () => {
  const have = existsSync("/usr/bin/plutil");
  (have ? test : test.skip)("probe plists: what plutil reads is what is judged; oversize, FIFO and odd names are handled", async () => {
    const root = mkdtempSync(join(tmpdir(), "oupdate-cruft-pl-"));
    try {
      const agents = join(root, "Library", "LaunchAgents");
      mkdirSync(agents, { recursive: true });
      mkdirSync(join(root, "scripts"));
      writeFileSync(join(root, "scripts", "own.sh"), "#!/bin/sh\n# owner: team\n");
      writeFileSync(join(root, "evil.sh"), "#!/bin/sh\n");
      const own = join(root, "scripts", "own.sh");
      const evil = join(root, "evil.sh");
      const wrap = (inner: string, pre = "", post = "") => `<?xml version="1.0"?>${pre}<plist version="1.0"><dict>${inner}</dict></plist>${post}`;
      const args = `<key>ProgramArguments</key><array><string>${own}</string></array>`;
      writeFileSync(join(agents, "a-attr.plist"), wrap(`<key a="1">Program</key><string>${evil}</string>${args}`));
      writeFileSync(join(agents, "b-pi.plist"), wrap(`${args}<key>Program</key><string>${evil}</string>`, "<?x <!-- ?>", "<?y --> ?>"));
      writeFileSync(join(agents, "c-big.plist"), wrap(`<!--${"x".repeat(300 * 1024)}-->${args}`));
      writeFileSync(join(agents, "d-legit.plist"), wrap(`<!-- note -->${args}<key>KeepAlive</key><dict><key>Crashed</key><true/></dict>`));
      writeFileSync(join(agents, "-dash.plist"), wrap(args));
      writeFileSync(join(agents, "sp ace\nnl.plist"), wrap(args));
      execFileSync("mkfifo", [join(agents, "f-fifo.plist")]);
      const t0 = Date.now();
      const c = await cruftCount({ fs: { ...realFs, home: root, listDir: async (d) => (d.startsWith(root) ? realFs.listDir(d) : []) }, configDir: "/cfg", pinRoots: [], ownerlessConfigValues: [] });
      expect(Date.now() - t0).toBeLessThan(3000); // a FIFO never reaches plutil (it would wait out the 5 s timeout)
      const names = c.wrappers.map((w) => w.replace(`${agents}/`, ""));
      expect(names.filter((w) => w.startsWith("a-attr") || w.startsWith("b-pi")).length).toBe(2);
      expect(names).toContain("c-big.plist complex plist: unreadable");
      expect(names).toContain("f-fifo.plist complex plist: unreadable");
      expect(names.some((w) => w.startsWith("d-legit") || w.startsWith("-dash") || w.startsWith("sp ace"))).toBe(false);
      expect(names).toHaveLength(4);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  (have ? test : test.skip)("plutil keeps a NUL and a hex reference that libxpc reads differently: both are counted, and a relative -x.plist needs the --", async () => {
    const root = mkdtempSync(join(tmpdir(), "oupdate-cruft-nul-"));
    const cwd = process.cwd();
    try {
      const agents = join(root, "Library", "LaunchAgents");
      mkdirSync(agents, { recursive: true });
      mkdirSync(join(root, "scripts"));
      writeFileSync(join(root, "scripts", "own.sh"), "#!/bin/sh\n# owner: team\n");
      const own = join(root, "scripts", "own.sh");
      const wrap = (inner: string) => `<?xml version="1.0"?><plist version="1.0"><dict>${inner}</dict></plist>`;
      const args = `<key>ProgramArguments</key><array><string>${own}</string></array>`;
      writeFileSync(join(agents, "a-key-nul.plist"), wrap(`<key>Program&#0;x</key><string>/opt/evil.sh</string>${args}`));
      writeFileSync(join(agents, "b-env-nul.plist"), wrap(`${args}<key>EnvironmentVariables</key><dict><key>BASH_ENV&#0;</key><string>x</string></dict>`));
      writeFileSync(join(agents, "c-raw-nul.plist"), wrap(`<key>ProgramArguments</key><array><string>${own}\u0000x</string></array>`));
      writeFileSync(join(agents, "d-hex.plist"), wrap(`<key>ProgramArguments</key><array><string>${join(root, "scripts")}&#x2F;own.sh</string></array>`));
      writeFileSync(join(agents, "e-legit.plist"), wrap(args));
      writeFileSync(join(agents, "f-utf16.plist"), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(wrap(`<key>ProgramArguments</key><array><string>${join(root, "scripts")}&#x2F;own.sh</string></array>`), "utf16le")]));
      writeFileSync(join(agents, "g-cdata.plist"), wrap(`<key>ProgramArguments</key><array><string><![CDATA[${join(root, "scripts")}/own&#46;sh]]></string></array>`));
      writeFileSync(join(agents, "h-dec.plist"), wrap(`<key>ProgramArguments</key><array><string>${join(root, "scripts")}/own&#46;sh</string></array>`));
      const decl = (enc: string, extra = "") => `<?xml version="1.0" encoding="${enc}"?>${extra}<plist version="1.0"><dict><key>ProgramArguments</key><array><string>${join(root, "x")}+AC8-..+AC8-scripts+AC8-own.sh</string></array></dict></plist>`;
      writeFileSync(join(agents, "j-utf7.plist"), decl("UTF-7"));
      writeFileSync(join(agents, "k-utf7q.plist"), decl("UTF-7").replace(/"UTF-7"/, "'utf-7'"));
      writeFileSync(join(agents, "l-latin.plist"), decl("ISO-8859-1"));
      writeFileSync(join(agents, "m-second.plist"), decl("UTF-8", '<?xml version="1.0" encoding="UTF-7"?>'));
      writeFileSync(join(agents, "n-utf8.plist"), `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict>${args}</dict></plist>`);
      writeFileSync(join(agents, "o-lower.plist"), `<?xml version='1.0' encoding='utf-8'?><plist version="1.0"><dict>${args}</dict></plist>`);
      writeFileSync(join(agents, "p-none.plist"), `<?xml version="1.0"?><plist version="1.0"><dict>${args}</dict></plist>`);
      writeFileSync(join(agents, "i-amp.plist"), wrap(`${args}<key>Label</key><string>a&amp;b &lt;c&gt;</string>`));
      const c = await cruftCount({ fs: { ...realFs, home: root, listDir: async (d) => (d.startsWith(root) ? realFs.listDir(d) : []) }, configDir: "/cfg", pinRoots: [], ownerlessConfigValues: [] });
      const names = c.wrappers.map((w) => w.replace(`${agents}/`, ""));
      // Whichever way plutil reads each (an error is "unreadable"), none is adopted; the legit one is.
      expect(names.map((w) => w.slice(0, 1)).sort()).toEqual(["a", "b", "c", "d", "f", "g", "h", "j", "k", "l", "m"]);
      for (const f of ["j-utf7", "k-utf7q", "l-latin", "m-second"]) expect(names.find((w) => w.startsWith(f))).toBe(`${f}.plist complex plist: plist encoding`);
      expect(names.find((w) => w.startsWith("f-utf16"))).toBe("f-utf16.plist complex plist: plist encoding");
      expect(names.find((w) => w.startsWith("g-cdata"))).toBe("g-cdata.plist complex plist: CDATA");
      expect(names.find((w) => w.startsWith("h-dec"))).toBe("h-dec.plist complex plist: entity");
      expect(names.find((w) => w.startsWith("d-hex"))).toBe("d-hex.plist complex plist: entity");
      // A relative name that starts with "-" reaches plutil only behind `--`.
      writeFileSync(join(root, "-x.plist"), wrap(args));
      process.chdir(root);
      expect(await realFs.plistJson!("-x.plist")).toEqual({ ProgramArguments: [own] });
    } finally {
      process.chdir(cwd);
      rmSync(root, { recursive: true, force: true });
    }
  });
  test("a malformed version ending in a dot is rejected in linear time", () => {
    const t = Date.now();
    expect(launchScript({ argv: [`/usr/bin/python3${"1".repeat(40)}.`, "/opt/a.sh"] })).toEqual({ script: `/usr/bin/python3${"1".repeat(40)}.`, shebang: true });
    expect(Date.now() - t).toBeLessThan(50);
  });
});

describe("cruft count follow-ups (OUP-368)", () => {
  const owned = "#!/bin/sh\n# owner: me\n";
  type Over = { realPath?: (p: string) => Promise<string | undefined>; listDir?: (d: string) => Promise<string[]>; listDirOk?: (d: string) => Promise<string[] | undefined>; head?: (p: string, meta?: { links?: number; noFollow?: boolean }) => string | undefined; argv?: string[] };
  // One plist under home's LaunchAgents running `script`; the number of wrappers counted.
  const stub = (home: string, script: string, dir: string, o: Over = {}) =>
    cruftCount({
      fs: {
        home,
        listDir: o.listDir ?? (async (d: string) => (d === `${home}/Library/LaunchAgents` ? ["t.plist"] : [])),
        ...(o.listDirOk ? { listDirOk: o.listDirOk } : {}),
        readHead: async (p: string, _n: number, meta?: { links?: number; noFollow?: boolean }) => (p.endsWith(".plist") ? "<plist/>" : o.head ? o.head(p, meta) : owned),
        realPath: o.realPath ?? (async (p: string) => p),
        plistJson: async () => ({ ProgramArguments: o.argv ?? [script] }),
        pinFiles: () => [],
      },
      configDir: "/cfg", pinRoots: [], ownerlessConfigValues: [], adoptedScriptsDir: dir,
    }).then((c) => c.wrappers.length);

  test("a redundant slash in the home spelling does not hide a broad dir (OUP-368 item 1)", async () => {
    // Fails at cruft.ts `broad`: "/hm//x/" does not start with "/hm/x/" until runs of slashes are folded to one.
    expect(await stub("/hm//x", "/hm/x/own.sh", "/hm/x")).toBe(1);
    expect(await stub("/hm/x", "/hm/x/own.sh", "/hm//x")).toBe(1);
    expect(await stub("/hm//x", "/hm//x/scripts/own.sh", "~/scripts")).toBe(0); // control: a directory of its own is still adopted
  });
});
