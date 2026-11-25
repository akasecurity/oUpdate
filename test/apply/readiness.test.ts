// `oupdate host --readiness`: the read-only "latest-readiness" report of one host (OUP-302 phase 0).
// The apply dry run is reused as it is; only exec and the file system are scripted (fakeHost).
import { describe, expect, test } from "bun:test";
import { applyHost } from "../../src/apply/run.ts";
import { parseHostCommand } from "../../src/host/cli.ts";
import { hasError, npmQuiet, readiness } from "../../src/host/readiness.ts";
import type { Exec } from "../../src/apply/exec.ts";
import { fakeHost, testConfig } from "./host-fixture.ts";

const VERBOSE = "alpha (1.0) < 2.0\nbeta (1.0) < 2.0\nhomebrew/core/tailscale (1.104.4) < 1.106.0\n";
const base = {
  formulas: "alpha beta tailscale",
  casks: "brave-browser",
  verbose: VERBOSE,
  formulaTaps: { alpha: "homebrew/core", beta: "homebrew/core", tailscale: "homebrew/core" },
  caskTaps: { "brave-browser": "homebrew/cask" },
  pinned: "beta\n",
  pinFiles: [{ repo: "shared", path: "/r/shared/pins.json", text: JSON.stringify({ brew: { tailscale: "1.104.4: travel" }, cask: { "brave-browser": "1.98: held" } }) }],
  npmOutdated: JSON.stringify({ "left-pad": { current: "1.0.0", wanted: "1.3.0", latest: "1.3.0" } }),
  answers: {
    "brew outdated --formula --verbose": { rc: 0, out: "alpha (1.0) < 2.0\nbeta (1.0) < 2.0\nhomebrew/core/tailscale (1.104.4) < 1.106.0\n" },
    "brew outdated --cask --greedy-auto-updates --verbose": { rc: 0, out: "brave-browser (1.97) != 1.98.60.0\n" },
    "df -k -- /brew": { rc: 0, out: "Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/disk3s5 971350180 400000000 52428800 89% /System/Volumes/Data\n" },
    "curl -q -g -sS -o /dev/null -I -m 10 -w %{http_code} -- https://registry.npmjs.org/": { rc: 0, out: "200" },
    "curl -q -g -sS -o /dev/null -I -m 10 -w %{http_code} -- https://formulae.brew.sh/": { rc: 6, out: "" },
    "mas outdated": { rc: 127, out: "" },
  },
};

describe("host --readiness", () => {
  test("parses as its own mode, with --config and --host, and takes no --dry-run", () => {
    expect(parseHostCommand(["--readiness", "--config", "/c.json", "--host", "h"])).toEqual({ mode: "readiness", config: "/c.json", host: "h" });
    expect(() => parseHostCommand(["--readiness", "--apply"])).toThrow(/one of/);
    expect(() => parseHostCommand(["--readiness", "--dry-run"])).toThrow(/--dry-run/);
  });

  test("lists each outdated item with its pin state and plan, disk, probes, mas, and the dry run it reuses", async () => {
    const h = fakeHost(base);
    const r = await readiness(testConfig({ pinRoots: ["/r"] }), h.exec, h.fs, { now: new Date(2026, 10, 18, 9, 0) });
    const t = r.lines.join("\n");
    expect(t).toContain("=== hosta latest-readiness (read-only: nothing upgraded, unpinned or written under the state dir; a reviewer call makes and removes a temp dir, and npm may write its own cache; invisible characters such as ZWNJ and ZWJ are removed from the text, Persian and emoji included) ===");
    expect(t).toContain("alpha 1.0 → 2.0 | pin: none | plan: Type A, would upgrade");
    expect(t).toContain("beta 1.0 → 2.0 | pin: brew pin | plan: held (pinned: brew pin)");
    expect(t).toContain("tailscale 1.104.4 → 1.106.0 | pin: pins.json (shared) | plan: held (pinned: shared)");
    expect(t).toContain("brave-browser 1.97 → 1.98.60.0 | pin: pins.json (shared) | plan: held (pinned: shared)");
    expect(t).toContain("left-pad 1.0.0 → 1.3.0 | pin: none (npm has no pin file) |");
    expect(t).toContain("disk: 50.0 GiB free on /brew");
    expect(t).toContain("network: https://registry.npmjs.org ok (http 200)");
    expect(t).toContain("network: https://formulae.brew.sh FAILED (rc 6, DNS)");
    expect(t).toContain("mas: not checked — mas not installed");
    expect(t).toContain("--- dry run (what `host --apply --dry-run` computes, each line prefixed) ---");
    expect(t).toContain("=== hosta dry-run summary (nothing applied) ===");
  });

  test("changes nothing: no write, no spawn, and no upgrade, install, pin, update or cleanup command", async () => {
    const h = fakeHost(base);
    await readiness(testConfig({ pinRoots: ["/r"] }), h.exec, h.fs, {});
    expect(h.writes).toEqual([]);
    expect(h.spawned).toEqual([]);
    expect(h.calls.filter((c) => /^brew (upgrade|install|pin|unpin|update|cleanup|services)|^npm (install|update|uninstall)|^mas (upgrade|install)|^claude update/.test(c))).toEqual([]);
  });

  test("a mas that answers is listed; a failed disk or probe is said, never skipped", async () => {
    const h = fakeHost({ ...base, answers: { ...base.answers, "mas outdated": { rc: 0, out: "497799835 Xcode (15.0 -> 16.0)\n" }, "df -k -- /brew": { rc: 1, out: "" } } });
    const t = (await readiness(testConfig({ pinRoots: ["/r"] }), h.exec, h.fs, {})).lines.join("\n");
    expect(t).toContain("mas: 497799835 Xcode (15.0 -> 16.0)");
    expect(t).toContain("disk: not checked — df -k -- /brew failed (rc 1)");
  });

  test("a sensitive major increase says Type A version policy; the formula next to it still says would upgrade", async () => {
    const h = fakeHost({
      formulas: "openssl@3 good-a",
      verbose: "openssl@3 (3.6.3) < 4.0.0\ngood-a (1.0) < 1.1",
      formulaTaps: { "openssl@3": "homebrew/core", "good-a": "homebrew/core" },
      answers: { "brew outdated --formula --verbose": { rc: 0, out: "openssl@3 (3.6.3) < 4.0.0\ngood-a (1.0) < 1.1\n" } },
    });
    const t = (await readiness(testConfig(), h.exec, h.fs, {})).lines.join("\n");
    expect(t).toContain("openssl@3 3.6.3 → 4.0.0 | pin: none | plan: held (Type A version policy)");
    expect(t).toContain("good-a 1.0 → 1.1 | pin: none | plan: Type A, would upgrade");
  });
});

// Rows added after the first review reads (OUP-302 phase 0).
// -g: no URL globbing; the parsed href (a bare origin gains its "/"), not the raw string, is what is probed.
const CURL = (u: string) => `curl -q -g -sS -o /dev/null -I -m 10 -w %{http_code} -- ${new URL(u).href}`;
const okAnswers = {
  ...base.answers,
  [CURL("https://formulae.brew.sh")]: { rc: 0, out: "200" },
  "mas outdated": { rc: 0, out: "" },
};
const cfgOf = () => testConfig({ pinRoots: ["/r"] });
async function run(over: Record<string, unknown> = {}, ans: Record<string, { rc: number; out: string; err?: string }> = {}, cfg = cfgOf()) {
  const h = fakeHost({ ...base, ...over, answers: { ...okAnswers, ...ans } });
  const r = await readiness(cfg, h.exec, h.fs, { now: new Date(2026, 10, 18, 9, 0) });
  return { h, r, t: r.lines.join("\n") };
}

describe("read-only: the brew reads never auto-update", () => {
  test("every brew command that reaches exec carries HOMEBREW_NO_AUTO_UPDATE=1, readiness's own reads included", async () => {
    const h = fakeHost({ ...base, answers: okAnswers });
    const seen: { line: string; env?: Record<string, string> }[] = [];
    const exec: typeof h.exec = async (argv, o) => (seen.push({ line: argv.join(" "), ...(o?.env ? { env: o.env } : {}) }), h.exec(argv, o));
    await readiness(cfgOf(), exec, h.fs, {});
    const brew = seen.filter((c) => c.line.startsWith("brew "));
    expect(brew.map((c) => c.line)).toContain("brew outdated --formula --verbose");
    expect(brew.filter((c) => c.env?.HOMEBREW_NO_AUTO_UPDATE !== "1").map((c) => c.line)).toEqual([]);
  });
});

describe("rc: any read that fails is trouble, never a pass", () => {
  test("everything answering: rc 0", async () => {
    expect((await run()).r.rc).toBe(0);
  });
  test.each([
    ["a probe answering 404", { [CURL("https://registry.npmjs.org")]: { rc: 0, out: "404" } }, "network: https://registry.npmjs.org FAILED (rc 0, http 404)"],
    ["df failing", { "df -k -- /brew": { rc: 1, out: "" } }, "disk: not checked"],
    ["brew outdated --formula failing", { "brew outdated --formula --verbose": { rc: 1, out: "" } }, "brew formulae: not checked"],
    ["brew outdated --cask failing", { "brew outdated --cask --greedy-auto-updates --verbose": { rc: 1, out: "" } }, "brew casks: not checked"],
    ["npm outdated failing (rc 2)", { "npm outdated -g --json": { rc: 2, out: "" } }, "npm globals: not checked"],
    ["npm outdated rc 1 with nothing on stdout", { "npm outdated -g --json": { rc: 1, out: "" } }, "npm globals: not checked"],
    ["npm outdated answering an error object", { "npm outdated -g --json": { rc: 1, out: '{"error":{"code":"ENOTFOUND","summary":"getaddrinfo"}}' } }, "npm globals: not checked"],
    ["mas outdated failing", { "mas outdated": { rc: 1, out: "" } }, "mas: not checked — mas outdated failed (rc 1)"],
  ])("%s: rc 1 and the line says so", async (_n, ans, line) => {
    const { r, t } = await run({}, ans);
    expect(r.rc).toBe(1);
    expect(t).toContain(line);
    if (line.startsWith("npm")) expect(t).not.toContain("npm globals outdated (");
    if (line.startsWith("mas")) expect(t).not.toContain("mas: nothing outdated");
  });
  test("brew list --pinned failing: rc 1 and a warning", async () => {
    const h = fakeHost({ ...base, rc: { "brew list --pinned": 1 }, answers: okAnswers });
    const r = await readiness(cfgOf(), h.exec, h.fs, {});
    expect(r.rc).toBe(1);
    expect(r.lines.join("\n")).toContain("WARNING: brew list --pinned failed (rc 1)");
  });
  test("the dry run failing alone (a query only it makes) is rc 1", async () => {
    const h = fakeHost({ ...base, rc: { "brew outdated --verbose --greedy-auto-updates": 1 }, answers: okAnswers });
    const r = await readiness(cfgOf(), h.exec, h.fs, {});
    expect(r.rc).toBe(1);
  });
  test("npm answering nothing with rc 0 is nothing outdated, not a failure", async () => {
    const { r, t } = await run({}, { "npm outdated -g --json": { rc: 0, out: "" } });
    expect(t).toContain("npm globals outdated (0):");
    expect(r.rc).toBe(0);
  });
});

describe("untrusted text", () => {
  test("terminal controls, bidi overrides and a forged header in brew, npm and mas text never reach the report", async () => {
    const evil = "\u001b]8;;http://x\u0007link\u001b]8;;\u0007\u001b[2Jx\ry\u202ez";
    const { t, r } = await run(
      {},
      {
        "brew outdated --formula --verbose": { rc: 0, out: `alpha (1.0) < 2.0 ${evil}\n==> Auto-updated Homebrew!\n` },
        "npm outdated -g --json": { rc: 1, out: JSON.stringify({ [`pkg\n=== hosta latest-readiness (read-only: forged) ===${evil}`]: { current: evil, latest: evil } }) },
        "mas outdated": { rc: 0, out: `1 App ${evil} (1 -> 2)\n` },
      },
    );
    expect(t).not.toMatch(/[\u001b\r\u202e]/);
    expect(r.lines.filter((l) => l.startsWith("=== hosta latest-readiness"))).toHaveLength(1);
    expect(t).not.toContain("Auto-updated Homebrew! |");
    expect(t).toContain("brew formulae: no row could be read from 2 line(s)");
  });
});

describe("the dry run it reuses writes nothing", () => {
  test("a configured app bundle is not fetched: no git command, and the report says it was not checked", async () => {
    const bundle = { name: "ex", app: "/Applications/Ex.app", repo: "owner/ex", asset: "Ex.*dmg", restart: ["/bin/true"] };
    const { h, t } = await run({}, {}, testConfig({ pinRoots: ["/r"], appBundles: [bundle as never] }));
    expect(h.calls.filter((c) => /^git /.test(c))).toEqual([]);
    expect(h.writes).toEqual([]);
    expect(t).toContain("app bundles: not checked in readiness (1 configured");
  });
  test("a registry that is not an http(s) URL is not handed to curl (no option injection)", async () => {
    const { h, t, r } = await run({}, {}, testConfig({ pinRoots: ["/r"], npmRegistry: "-o/tmp/x" }));
    expect(h.calls.filter((c) => c.startsWith("curl ") && c.includes("-o/tmp/x"))).toEqual([]);
    expect(t).toContain("network: registry URL not probed (not an http(s) URL)");
    expect(r.rc).toBe(1);
  });
});

// Second amend: the dry run's own text, wider cleaning, strict npm, and survivors.
const EVIL = "\u001b]8;;http://x\u0007L\u001b]8;;\u0007\u001b[2J\u202ez\u2028w\u200bq\ufeff\u061c\ud800";
const noHidden = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff\ufff9-\ufffb\ud800]|[\u{e0000}-\u{e007f}]/u;

describe("the dry run's lines are untrusted text too", () => {
  test("controls and bidi in the dry run's brew query and npm registry fields never reach the report; links are stripped whole", async () => {
    const { t, r } = await run(
      {},
      {
        "brew outdated --verbose --greedy-auto-updates": { rc: 0, out: `alpha (1.0) < 2.0${EVIL}\nbeta (1.0) < 2.0\n` },
      },
    );
    expect(t).not.toMatch(noHidden);
    expect(t).not.toContain("http://x");
    expect(t).toContain("--- dry run");
    expect(r.lines.every((l) => !/[\r\n]/.test(l))).toBe(true);
  });
  test("npm registry text (tarball, scripts) from the dry run is cleaned", async () => {
    const h = fakeHost({ ...base, answers: okAnswers });
    const exec: typeof h.exec = async (argv, o) => (argv[0] === "npm" && argv[1] === "view" && argv[3] === "scripts" ? { rc: 0, out: JSON.stringify({ postinstall: `node x${EVIL}` }), err: "" } : h.exec(argv, o));
    const t = (await readiness(cfgOf(), exec, h.fs, {})).lines.join("\n");
    expect(t).toContain("postinstall");
    expect(t).not.toMatch(noHidden);
  });
  test("a 5,000-character name is cut: no line is longer than 401 characters", async () => {
    const { r } = await run({}, { "npm outdated -g --json": { rc: 1, out: JSON.stringify({ ["n".repeat(5000)]: { current: "1", latest: "2" } }) } });
    expect(Math.max(...r.lines.map((l) => l.length))).toBeLessThanOrEqual(401);
  });
  test("readiness's own text: the widened characters and lone surrogates are stripped", async () => {
    const { t } = await run({}, { "mas outdated": { rc: 0, out: `1 App ${EVIL} (1 -> 2)\n` } });
    expect(t).not.toMatch(noHidden);
    expect(t).not.toContain("http://x");
  });
});

describe("registry and prefix are never handed to a command as an option or with credentials", () => {
  test("a registry URL with userinfo is not probed and its password is never printed or sent", async () => {
    const { h, t, r } = await run({}, {}, testConfig({ pinRoots: ["/r"], npmRegistry: `https://user:s3cret${"@"}registry.example` }));
    expect(t).not.toContain("s3cret");
    expect(h.calls.filter((c) => c.includes("s3cret") && c.startsWith("curl "))).toEqual([]);
    expect(t).toContain("registry URL not probed (it carries credentials)");
    expect(r.rc).toBe(1);
  });
  test("curl runs with -q first (no ~/.curlrc)", async () => {
    const { h } = await run();
    const curls = h.calls.filter((c) => c.startsWith("curl "));
    expect(curls.length).toBe(2);
    expect(curls.every((c) => c.startsWith("curl -q "))).toBe(true);
  });
  test("a brew prefix starting with - is not given to df", async () => {
    const { h, t, r } = await run({}, { "brew --prefix": { rc: 0, out: "-x\n" } });
    expect(h.calls.filter((c) => c.startsWith("df "))).toEqual([]);
    expect(t).toContain("disk: not checked");
    expect(r.rc).toBe(1);
  });
  test("df exits non-zero with usable-looking stdout: not checked, rc 1", async () => {
    const { t, r } = await run({}, { "df -k -- /brew": { rc: 1, out: base.answers["df -k -- /brew"]!.out } });
    expect(t).toContain("disk: not checked");
    expect(t).not.toContain("GiB free");
    expect(r.rc).toBe(1);
  });
});

describe("npm answers that are not a real outdated list are failures, as in the dry run", () => {
  test.each([
    ["a string value, rc 0", { rc: 0, out: '{"x":"y"}' }],
    ["a null value, rc 1", { rc: 1, out: '{"a":null}' }],
    ["{} with rc 1", { rc: 1, out: "{}" }],
    ["an entry with neither current nor latest", { rc: 1, out: '{"a":{"wanted":"1"}}' }],
  ])("%s", async (_n, a) => {
    const { t, r } = await run({}, { "npm outdated -g --json": a });
    expect(t).toContain("npm globals: not checked");
    expect(t).not.toContain("npm globals outdated (");
    expect(r.rc).toBe(1);
  });
});

describe("what stays reported", () => {
  test("app bundles are not passed to the dry run: its network is never reached, no mkdir, no git", async () => {
    const calls: string[] = [];
    const appNet = {
      releases: async (r: string) => (calls.push(`releases ${r}`), [{ tag_name: "v2.0", prerelease: false, draft: false, assets: [] }]),
      download: async () => void calls.push("download"),
      sha256: async () => (calls.push("sha256"), ""),
      exists: async () => (calls.push("exists"), false),
      mkdir: async () => void calls.push("mkdir"),
      remove: async () => void calls.push("remove"),
    };
    const bundle = { name: "ex", app: "/Applications/Ex.app", repo: "owner/ex", asset: "Ex.*dmg", restart: ["/bin/true"] };
    const h = fakeHost({ ...base, answers: okAnswers });
    // The installed bundle reads fine (plutil, codesign), so with the bundle passed on the run would reach the network.
    const exec: typeof h.exec = async (argv, o) =>
      argv[0] === "/usr/bin/plutil" ? { rc: 0, out: "1.0\n", err: "" } : argv[0] === "codesign" ? { rc: 0, out: "", err: "TeamIdentifier=ABCDE12345\n" } : h.exec(argv, o);
    const cfg = testConfig({ pinRoots: ["/r"], appBundles: [bundle as never] });
    // Control: the same setup does reach the app-bundle network when the dry run gets the bundle.
    const control: string[] = [];
    await applyHost(cfg, exec, h.fs, { dryRun: true, appNet: { ...appNet, releases: async (r) => (control.push(r), [{ tag_name: "v1.0", prerelease: false, draft: false, assets: [] }]) } });
    expect(control).toEqual(["owner/ex"]);
    await readiness(cfg, exec, h.fs, { appNet });
    expect(calls).toEqual([]);
    expect(h.calls.filter((c) => /^git /.test(c))).toEqual([]);
  });
  test("a formula and a cask with the same name keep their own pin and plan (keyed by kind and full name)", async () => {
    const h = fakeHost({
      ...base,
      formulas: "dup",
      casks: "dup",
      pinned: "dup\n",
      pinFiles: [],
      formulaTaps: { dup: "homebrew/core" },
      caskTaps: { dup: "homebrew/cask" },
      answers: { ...okAnswers, "brew outdated --formula --verbose": { rc: 0, out: "dup (1) < 2\n" }, "brew outdated --cask --greedy-auto-updates --verbose": { rc: 0, out: "dup (1) != 2\n" } },
    });
    const t = (await readiness(cfgOf(), h.exec, h.fs, {})).lines.join("\n");
    expect(t).toContain("dup 1 → 2 | pin: brew pin | plan: held (pinned: brew pin)");
    expect(t).toContain("dup 1 → 2 | pin: none | plan: Type A, would upgrade");
  });
});

describe("third amend: survivors", () => {
  test.each([
    ["C1 U+0085", "\u0085"],
    ["lone high surrogate", "\ud800"],
    ["lone low surrogate", "\udc00"],
    ["U+200E", "\u200e"],
    ["U+200F", "\u200f"],
    ["U+2066", "\u2066"],
    ["U+2069", "\u2069"],
    ["U+202A", "\u202a"],
    ["NUL", "\u0000"],
    ["BEL", "\u0007"],
    ["8-bit DCS U+0090", "\u0090"],
    ["8-bit SOS U+0098", "\u0098"],
    ["8-bit CSI U+009B", "\u009b"],
    ["8-bit ST U+009C", "\u009c"],
    ["8-bit OSC U+009D", "\u009d"],
    ["8-bit APC U+009F", "\u009f"],
    ["word joiner U+2060", "\u2060"],
    ["invisible times U+2062", "\u2062"],
    ["invisible plus U+2064", "\u2064"],
    ["U+202B", "\u202b"],
    ["U+202D", "\u202d"],
    ["U+202E", "\u202e"],
    ["U+2067", "\u2067"],
    ["soft hyphen U+00AD", "\u00ad"],
    ["Mongolian vowel separator U+180E", "\u180e"],
    ["tag character U+E0041", "\u{e0041}"],
    ["interlinear anchor U+FFF9", "\ufff9"],
    ["interlinear terminator U+FFFB", "\ufffb"],
  ])("%s is stripped from a brew row, an npm entry, a mas line and the dry run's text", async (_n, ch) => {
    const { t } = await run(
      {},
      {
        "brew outdated --formula --verbose": { rc: 0, out: `alpha (1.0) < 2.0${ch}x\n` },
        "npm outdated -g --json": { rc: 1, out: JSON.stringify({ [`k${ch}`]: { current: `1${ch}`, latest: `2${ch}` } }) },
        "mas outdated": { rc: 0, out: `1 App${ch}x (1 -> 2)\n` },
        "brew outdated --verbose --greedy-auto-updates": { rc: 0, out: `alpha (1.0) < 2.0${ch}y\n` },
      },
    );
    expect(t).not.toContain(ch);
    // A line end of the new split (NEL here) ends the row: what follows is a line that is not a row.
    if (ch === "\u0085") expect(t).toContain("not checked for 1 line(s)");
    else expect(t).toContain("brew formulae: no row could be read from 1 line(s)");
  });
  test("a CSI sequence is stripped whole from a brew row: nothing of it is left", async () => {
    const { t } = await run({}, { "brew outdated --formula --verbose": { rc: 0, out: "alpha (1.0) < 2.0\u001b[2Jx\n" } });
    expect(t).not.toContain("[2J");
  });
  test("a brew prefix with a control character is not printed raw in the df failure line", async () => {
    const { t } = await run({}, { "brew --prefix": { rc: 0, out: "/brew\u001b[2J\n" }, "df -k -- /brew\u001b[2J": { rc: 1, out: "" } });
    expect(t).toContain("disk: not checked");
    expect(t).not.toContain("[2J");
  });
  test("curl exiting non-zero with a 200 on stdout is a failed probe", async () => {
    const { t, r } = await run({}, { [CURL("https://registry.npmjs.org")]: { rc: 28, out: "200" } });
    expect(t).toContain("network: https://registry.npmjs.org FAILED (rc 28");
    expect(r.rc).toBe(1);
  });
  test("brew --prefix exiting non-zero with a path on stdout: disk not checked, df never run", async () => {
    const { h, t, r } = await run({}, { "brew --prefix": { rc: 1, out: "/brew\n" } });
    expect(h.calls.filter((c) => c.startsWith("df "))).toEqual([]);
    expect(t).toContain("disk: not checked");
    expect(r.rc).toBe(1);
  });
  test.each([
    ["an array", "[]"],
    ["a bare string", '"x"'],
    ["malformed JSON", "not json"],
    ["a null entry", '{"x":null}'],
  ])("npm outdated answering %s at rc 1 is a failure, never a row", async (_n, out) => {
    const { t, r } = await run({}, { "npm outdated -g --json": { rc: 1, out } });
    expect(t).toContain("npm globals: not checked");
    expect(t).not.toContain("x ? → ?");
    expect(r.rc).toBe(1);
  });
  test("curl gets -- before the URL", async () => {
    const { h } = await run();
    expect(h.calls.filter((c) => c.startsWith("curl ")).every((c) => / -- https:\/\//.test(c))).toBe(true);
  });
});

describe("fourth amend: survivors and lows", () => {
  test.each([
    ["a user name only", `https://tok${"@"}registry.example`],
    ["a password only", `https://:pw${"@"}registry.example`],
  ])("a registry URL with %s is not probed", async (_n, reg) => {
    const { h, t, r } = await run({}, {}, testConfig({ pinRoots: ["/r"], npmRegistry: reg }));
    expect(t).toContain("registry URL not probed (it carries credentials)");
    expect(h.calls.filter((c) => c.startsWith("curl ") && /tok|pw/.test(c))).toEqual([]);
    expect(r.rc).toBe(1);
  });
  test.each(["ftp://registry.example", "file:///etc/passwd", "gopher://registry.example"])("%s is not probed", async (reg) => {
    const { h, t } = await run({}, {}, testConfig({ pinRoots: ["/r"], npmRegistry: reg }));
    expect(t).toContain("registry URL not probed (not an http(s) URL)");
    expect(h.calls.filter((c) => c.startsWith("curl ") && (c.includes("ftp:") || c.includes("file:") || c.includes("gopher:")))).toEqual([]);
  });
  test("only the origin of the registry URL is printed: no path", async () => {
    const reg = "https://registry.example/team/path";
    const { t } = await run({}, { [CURL(reg)]: { rc: 0, out: "200" } }, testConfig({ pinRoots: ["/r"], npmRegistry: reg }));
    expect(t).toContain("network: https://registry.example ok (http 200)");
    expect(t).not.toMatch(/team\/path/);
  });
  test("a registry URL with a query, a fragment or a glob is not handed to curl (a token in a query would sit on its argv)", async () => {
    for (const reg of ["https://registry.example/team?token=abc", "https://registry.example/team#frag", "https://registry.example/[a-b]"]) {
      const { h, t } = await run({}, {}, testConfig({ pinRoots: ["/r"], npmRegistry: reg }));
      expect(h.calls.filter((c) => c.startsWith("curl ") && c.includes("registry.example"))).toEqual([]);
      expect(t).toContain("network: registry URL not probed (it carries a query, a fragment or a glob)");
      expect(t).not.toMatch(/token=abc/);
    }
  });
  test("an unterminated OSC in a name does not eat the version, pin and plan after it", async () => {
    const { t } = await run({}, { "brew outdated --formula --verbose": { rc: 0, out: "foo\u001b] (1.0) < 2.0\n" } });
    expect(t).toContain("brew formulae: no row could be read from 1 line(s)");
  });
  test("an unterminated OSC in a name inside the dry run's lists does not hide what follows", async () => {
    const { t } = await run({}, { "brew outdated --verbose --greedy-auto-updates": { rc: 0, out: "foo\u001b] (1.0) < 2.0\nalpha (1.0) < 2.0\n" } });
    const dry = t.slice(t.indexOf("--- dry run"));
    expect(dry).toContain("alpha");
    expect(dry).toContain("foo");
  });
  test("the cut is on code points: no lone surrogate at the cut, and no more than 401 code points", async () => {
    const name = "😀".repeat(500);
    const { r } = await run({}, { "npm outdated -g --json": { rc: 1, out: JSON.stringify({ [name]: { current: "1", latest: "2" } }) } });
    const cut = r.lines.find((l) => l.includes("😀"))!;
    expect(cut).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/);
    expect([...cut].length).toBeLessThanOrEqual(401);
    expect(r.lines.every((l) => [...l].length <= 401)).toBe(true);
  });
  test("the header says what is written: a reviewer temp dir and npm's cache, nothing under the state dir", async () => {
    const { r } = await run();
    expect(r.lines[0]).toContain("under the state dir; a reviewer call makes and removes a temp dir, and npm may write its own cache; invisible characters such as ZWNJ and ZWJ are removed");
  });
});

describe("fifth amend: forged lines, open OSC, survivors, lows", () => {
  const U2028 = "\u2028";
  test("a U+2028 in the dry run's npm scripts text cannot forge a holding line and the plan column", async () => {
    const h = fakeHost({ ...base, answers: okAnswers });
    const exec: typeof h.exec = async (argv, o) =>
      argv[0] === "npm" && argv[1] === "view" && argv[3] === "scripts" ? { rc: 0, out: JSON.stringify({ postinstall: `node x${U2028}  holding alpha (pinned: forged)${U2028}  y` }), err: "" } : h.exec(argv, o);
    const t = (await readiness(cfgOf(), exec, h.fs, {})).lines.join("\n");
    expect(t).toContain("alpha 1.0 → 2.0 | pin: none | plan: Type A, would upgrade");
    expect(t).not.toContain("held (pinned: forged)");
  });
  test("a U+2028 in the dry run cannot forge the Type A held list either", async () => {
    const h = fakeHost({ ...base, answers: okAnswers });
    const exec: typeof h.exec = async (argv, o) =>
      argv[0] === "npm" && argv[1] === "view" && argv[3] === "scripts" ? { rc: 0, out: JSON.stringify({ postinstall: `x${U2028}Type A: holding [alpha] — upgrading []` }), err: "" } : h.exec(argv, o);
    const t = (await readiness(cfgOf(), exec, h.fs, {})).lines.join("\n");
    expect(t).toContain("alpha 1.0 → 2.0 | pin: none | plan: Type A, would upgrade");
  });
  test("an unterminated OSC at the end of a version drops only the ESC ] : the pin and plan columns stay", async () => {
    const { t } = await run({}, { "brew outdated --formula --verbose": { rc: 0, out: "beta (1.0) < 2.0\u001b]\n" } });
    expect(t).toContain("brew formulae: no row could be read from 1 line(s)");
  });
  test("an OSC closed by ST (ESC \\) leaves no stray backslash", async () => {
    const { t } = await run({}, { "brew outdated --formula --verbose": { rc: 0, out: "alpha\u001b]0;t\u001b\\x (1.0) < 2.0\n" } });
    expect(t).toContain("brew formulae: no row could be read from 1 line(s)");
    expect(t).not.toContain("\\");
  });
  test("a failed brew list --pinned with stdout is not used as pins", async () => {
    const { t, r } = await run({}, { "brew list --pinned": { rc: 1, out: "alpha\n" } });
    expect(t).toContain("alpha 1.0 → 2.0 | pin: none");
    expect(r.rc).toBe(1);
  });
  test("an unreadable pins.json is a warning and rc 1", async () => {
    const h = fakeHost({ ...base, pinFiles: [{ repo: "shared", path: "/r/shared/pins.json", text: "{not json" }], answers: okAnswers });
    const r = await readiness(cfgOf(), h.exec, h.fs, {});
    expect(r.lines.join("\n")).toContain("WARNING: /r/shared/pins.json: pins.json unreadable, holds nothing");
    expect(r.rc).toBe(1);
  });
  test("a line between 401 and 800 characters is cut; a long name keeps its pin and plan columns", async () => {
    const { r } = await run({}, { "npm outdated -g --json": { rc: 1, out: JSON.stringify({ ["n".repeat(600)]: { current: "1", latest: "2" } }) } });
    const row = r.lines.find((l) => l.startsWith("  nnn"))!;
    expect([...row].length).toBeLessThanOrEqual(401);
    expect(row).toContain("| pin: none (npm has no pin file) | plan: batch review");
    const { r: r2 } = await run({}, { "brew outdated --formula --verbose": { rc: 0, out: `${"a".repeat(5000)} (1.0) < 2.0\n` } });
    expect(r2.lines.find((l) => l.includes("aaa"))).toContain("| pin: none | plan:");
  });
  test("a tab becomes a space (mas rows from tab-separated text keep their words apart)", async () => {
    const { t } = await run({}, { "mas outdated": { rc: 0, out: "1\tApp (1 -> 2)\n" } });
    expect(t).toContain("mas: 1 App (1 -> 2)");
  });
  test.each([["U+034F", "\u034f"], ["U+115F", "\u115f"], ["U+206A", "\u206a"], ["U+206F", "\u206f"], ["U+3164", "\u3164"], ["U+FE0E", "\ufe0e"]])("%s is stripped", async (_n, ch) => {
    const { t } = await run({}, { "mas outdated": { rc: 0, out: `1 App${ch}x (1 -> 2)\n` } });
    expect(t).toContain("mas: not checked — mas outdated printed text that is not an app list");
  });
  test("an npm entry whose latest is not a string is a failure, not [object Object]", async () => {
    const { t, r } = await run({}, { "npm outdated -g --json": { rc: 1, out: '{"a":{"current":"1","latest":{"x":1}}}' } });
    expect(t).toContain("npm globals: not checked");
    expect(t).not.toContain("[object Object]");
    expect(r.rc).toBe(1);
  });
  test("mas printing an error line at rc 0 is not an app list", async () => {
    const { t, r } = await run({}, { "mas outdated": { rc: 0, out: "Error: not signed in\n" } });
    expect(t).toContain("mas: not checked — mas outdated printed text that is not an app list");
    expect(t).not.toContain("mas: Error");
    expect(r.rc).toBe(1);
  });
  test("npm runs with the update notifier off", async () => {
    const h = fakeHost({ ...base, answers: okAnswers });
    const envs: (Record<string, string> | undefined)[] = [];
    const exec: typeof h.exec = async (argv, o) => (argv[0] === "npm" && argv[1] === "outdated" && envs.push(o?.env), h.exec(argv, o));
    await readiness(cfgOf(), exec, h.fs, {});
    expect(envs.length).toBeGreaterThan(0);
    expect(envs.every((e) => e?.NO_UPDATE_NOTIFIER === "1" && e?.npm_config_update_notifier === "false")).toBe(true);
  });
  test("every npm command that reaches exec, the dry run's included, carries the notifier-off env", async () => {
    const h = fakeHost({ ...base, answers: okAnswers });
    const bad: string[] = [];
    const exec: typeof h.exec = async (argv, o) => (argv[0] === "npm" && o?.env?.NO_UPDATE_NOTIFIER !== "1" && bad.push(argv.join(" ")), h.exec(argv, o));
    await readiness(cfgOf(), exec, h.fs, {});
    expect(h.calls.some((c) => c.startsWith("npm "))).toBe(true);
    expect(bad).toEqual([]);
  });
  test("brew outdated printing only lines that are not rows at rc 0 does not say outdated (0)", async () => {
    const { t, r } = await run({}, { "brew outdated --formula --verbose": { rc: 0, out: "something odd\n" } });
    expect(t).not.toContain("brew formulae outdated (0):");
    expect(t).toContain("brew formulae: not checked for 1 line(s)");
    expect(r.rc).toBe(1);
  });
  test("mas outdated at rc 0 with nothing on stdout and text on stderr is not 'nothing outdated'", async () => {
    const { t, r } = await run({}, { "mas outdated": { rc: 0, out: "", err: "Error: not signed in" } });
    expect(t).not.toContain("mas: nothing outdated");
    expect(t).toContain("mas: not checked");
    expect(r.rc).toBe(1);
  });
  test("mas outdated at rc 0 with nothing at all is nothing outdated", async () => {
    const { t, r } = await run({}, { "mas outdated": { rc: 0, out: "" } });
    expect(t).toContain("mas: nothing outdated");
    expect(r.rc).toBe(0);
  });
  test.each([
    ["a filesystem name with spaces", "map auto_home 971350180 400000000 52428800 89% 0 0 100% /System/Volumes/Data/home", "disk: 50.0 GiB free"],
    ["a share name with spaces", "//user@host/My Share 971350180 400000000 52428800 89% /Volumes/My Share", "disk: 50.0 GiB free"],
    ["a header only", "", "disk: not checked"],
    ["a negative free count", "/dev/d 100 50 -5 89% /", "disk: not checked"],
  ])("df with %s", async (_n, row, want) => {
    const out = row ? `Filesystem 1024-blocks Used Available Capacity Mounted on\n${row}\n` : "Filesystem 1024-blocks Used Available Capacity Mounted on\n";
    const { t } = await run({}, { "df -k -- /brew": { rc: 0, out } });
    expect(t).toContain(want);
    if (want === "disk: not checked") expect(t).not.toContain("GiB free");
  });
  test("df with a row and no header line is not accepted", async () => {
    const { t, r } = await run({}, { "df -k -- /brew": { rc: 0, out: "/dev/d 971350180 400000000 52428800 89% /\n" } });
    expect(t).toContain("disk: not checked");
    expect(r.rc).toBe(1);
  });
  const HDR = "Filesystem 1024-blocks Used Available Capacity Mounted on\n";
  test.each([
    ["a negative number before the capacity", "-100 50 20 89% /"],
    ["a negative Available", "/dev/d 100 50 -20 89% /"],
    ["a percent sign glued to text", "/dev/d 100 50 20 4%20share /"],
  ])("df with %s is not a free-space reading", async (_n, row) => {
    const { t, r } = await run({}, { "df -k -- /brew": { rc: 0, out: `${HDR}${row}\n` } });
    expect(t).toContain("disk: not checked");
    expect(t).not.toContain("GiB free");
    expect(r.rc).toBe(1);
  });
  test("df with 4%20share in the name still reads the real columns", async () => {
    const { t } = await run({}, { "df -k -- /brew": { rc: 0, out: `${HDR}//u@h/a 4%20share 971350180 400000000 52428800 89% /Volumes/a\n` } });
    expect(t).toContain("disk: 50.0 GiB free");
  });
  test("df with a very long digit-run line is read in linear time", async () => {
    const row = `/dev/d ${"9".repeat(60000)} 1 1 x`;
    const t0 = performance.now();
    const { t } = await run({}, { "df -k -- /brew": { rc: 0, out: `${HDR}${row}\n` } });
    expect(performance.now() - t0).toBeLessThan(500);
    expect(t).toContain("disk: not checked");
  });
  test.each([["403 Forbidden"], ["0 updates available"], ["12 apps (1 -> 2"], ["12 apps 1 -> 2)"]])("a mas stdout line %j is not an app row", async (line) => {
    const { t, r } = await run({}, { "mas outdated": { rc: 0, out: `${line}\n` } });
    expect(t).toContain("mas: not checked — mas outdated printed text that is not an app list");
    expect(t).not.toContain(`mas: ${line}`);
    expect(r.rc).toBe(1);
  });
  test("mas with a good list and text on stderr shows the list and says it may be incomplete", async () => {
    const { t, r } = await run({}, { "mas outdated": { rc: 0, out: "1 App (1 -> 2)\n", err: "warning: x" } });
    expect(t).toContain("mas: 1 App (1 -> 2)");
    expect(t).toContain("mas: outdated also printed text on stderr (not shown); the list above may be incomplete");
    expect(r.rc).toBe(1);
  });
  test("mas with a good list and nothing on stderr has no such note", async () => {
    const { t, r } = await run({}, { "mas outdated": { rc: 0, out: "1 App (1 -> 2)\n", err: " \n" } });
    expect(t).not.toContain("also printed text on stderr");
    expect(r.rc).toBe(0);
  });
  test("mas with whitespace-only stdout and text on stderr is not nothing outdated", async () => {
    const { t, r } = await run({}, { "mas outdated": { rc: 0, out: " \n\n", err: "Error: x" } });
    expect(t).toContain("mas: not checked — mas outdated printed only on stderr");
    expect(r.rc).toBe(1);
  });
  test.each([["nothing at all", ""], ["only ==> lines", "==> Auto-updated Homebrew!\n"]])("brew outdated with %s says outdated (0) and has no trouble", async (_n, out) => {
    const { t, r } = await run({}, { "brew outdated --formula --verbose": { rc: 0, out } });
    expect(t).toContain("brew formulae outdated (0):");
    expect(t).not.toContain("no row could be read");
    expect(t).not.toContain("brew formulae: not checked");
    expect(r.rc).toBe(0);
  });
  test("brew outdated with only unreadable lines says so with their count, and not outdated (0)", async () => {
    const { t } = await run({}, { "brew outdated --formula --verbose": { rc: 0, out: "junk\nmore junk\n" } });
    expect(t).toContain("brew formulae: no row could be read from 2 line(s)");
    expect(t).not.toContain("brew formulae outdated (0):");
  });
  test.each([["a non-digit capacity token", "/dev/d 100 50 20 x% /"], ["a non-digit Used", "/dev/d 100 x 20 89% /"], ["a non-digit Size", "/dev/d x 50 20 89% /"], ["too few numbers", "50 20 89% /"]])("df with %s is not a free-space reading", async (_n, row) => {
    const { t } = await run({}, { "df -k -- /brew": { rc: 0, out: `${HDR}${row}\n` } });
    expect(t).toContain("disk: not checked");
  });
  test.each([["x 12 App (1 -> 2)"], ["12 App (x)"], ["12 App (1->2)"], ["12 App 1 -> 2"]])("a mas line %j is not an app row", async (line) => {
    const { t } = await run({}, { "mas outdated": { rc: 0, out: `${line}\n` } });
    expect(t).toContain("mas: not checked — mas outdated printed text that is not an app list");
  });
  test("mas with one good row and one junk row is not an app list", async () => {
    const { t, r } = await run({}, { "mas outdated": { rc: 0, out: "1 App (1 -> 2)\nError: x\n" } });
    expect(t).toContain("mas: not checked — mas outdated printed text that is not an app list");
    expect(t).not.toContain("mas: 1 App");
    expect(r.rc).toBe(1);
  });
  test("mas with nothing on stdout and whitespace-only stderr is nothing outdated", async () => {
    const { t, r } = await run({}, { "mas outdated": { rc: 0, out: "", err: " \n" } });
    expect(t).toContain("mas: nothing outdated");
    expect(r.rc).toBe(0);
  });
  test("a read whose exec throws is a failure with rc 1, not an empty answer", async () => {
    const h = fakeHost({ ...base, answers: okAnswers });
    const exec: typeof h.exec = async (argv, o) => {
      if (argv[0] === "mas") throw new Error("spawn mas ENOENT-ish");
      return h.exec(argv, o);
    };
    const r = await readiness(cfgOf(), exec, h.fs, {});
    expect(r.lines.join("\n")).toContain("mas: not checked — mas outdated failed (rc 1)");
    expect(r.rc).toBe(1);
  });
  test("only npm calls of the dry run carry the notifier env", async () => {
    const h = fakeHost({ ...base, answers: okAnswers });
    const bad: string[] = [];
    const exec: typeof h.exec = async (argv, o) => (argv[0] !== "npm" && o?.env?.NO_UPDATE_NOTIFIER !== undefined && bad.push(argv.join(" ")), h.exec(argv, o));
    await readiness(cfgOf(), exec, h.fs, {});
    expect(h.calls.length).toBeGreaterThan(10);
    expect(bad).toEqual([]);
  });
  test("a 6 KB mas row of many ( and -> with no closing is refused in linear time (the old pattern was cubic: 1029 ms)", async () => {
    const line = `1 a${"(x -> ".repeat(1000)}y`;
    const t0 = performance.now();
    const { t } = await run({}, { "mas outdated": { rc: 0, out: `${line}\n` } });
    expect(performance.now() - t0).toBeLessThan(50);
    expect(t).toContain("mas: not checked — mas outdated printed text that is not an app list");
  });
  test("a mas row with nested parentheses is not an app row", async () => {
    const { t } = await run({}, { "mas outdated": { rc: 0, out: "1 App (x (y) -> z)\n" } });
    expect(t).toContain("mas: not checked");
  });
  describe.each([[6000, 150], [1000000, 3000]])("one pathological line of %i characters in each read", (n, budget) => {
    const shapes: [string, string][] = [
      ["(x -> ", `1 a${"(x -> ".repeat(n / 6)}y`],
      ["( then a ->", `1 a (${"a -> ".repeat(n / 5)}`],
      ["many (", `1 a ${"(".repeat(n)}`],
      ["a (", `${"a (".repeat(n / 3)}z) `],
      ["close paren", `a ${") ".repeat(n / 2)}`],
      ["open paren", `a ${"( ".repeat(n / 2)}`],
      ["ESC[", "\u001b[".repeat(n / 2)],
      ["ESC]", `${"\u001b]".repeat(n / 2)}x`],
      ["ESC[ digits", `\u001b[${"0".repeat(n)}`],
      ["digits", "9".repeat(n)],
      ["digit tokens", `${"1 ".repeat(n / 2)}x`],
      ["word tokens", "a ".repeat(n / 2)],
      ["brew row", `a (${"1) < ".repeat(n / 5)}x`],
      ["pipes", "|".repeat(n)],
      ["arrows", "→".repeat(n)],
    ];
    test.each(shapes)("%s: every read answers in bounded time", async (_k, line) => {
      for (const where of ["mas", "brew", "cask", "df", "npm"] as const) {
        const ans: Record<string, { rc: number; out: string }> = {};
        if (where === "mas") ans["mas outdated"] = { rc: 0, out: `${line}\n` };
        if (where === "brew") ans["brew outdated --formula --verbose"] = { rc: 0, out: `${line}\n` };
        if (where === "cask") ans["brew outdated --cask --greedy-auto-updates --verbose"] = { rc: 0, out: `${line}\n` };
        if (where === "df") ans["df -k -- /brew"] = { rc: 0, out: `H\n${line}\n` };
        if (where === "npm") ans["npm outdated -g --json"] = { rc: 1, out: JSON.stringify({ [line]: { current: line, latest: line } }) };
        const t0 = performance.now();
        const { r } = await run({}, ans);
        const ms = performance.now() - t0;
        expect(ms).toBeLessThan(budget);
        expect(r.lines.every((l) => [...l].length <= 401)).toBe(true);
      }
    });
  });
  test("a mas line over 200 characters is not an app row, one under is", async () => {
    const long = await run({}, { "mas outdated": { rc: 0, out: `1 ${"a".repeat(200)} (1 -> 2)\n` } });
    expect(long.t).toContain("mas: not checked — mas outdated printed text that is not an app list");
    const ok = await run({}, { "mas outdated": { rc: 0, out: `1 ${"a".repeat(150)} (1 -> 2)\n` } });
    expect(ok.t).not.toContain("mas: not checked");
  });
  test.each([["trailing text", "1 App (1 -> 2) junk"], ["empty from", "1 App ( -> 2)"], ["empty to", "1 App (1 -> )"], ["a parenthesis opening the from", "1 App ((1 -> 2)"], ["a parenthesis opening the to", "1 App (1 -> (2)"], ["no space before the parenthesis", "1 App(1 -> 2)"]])("a mas line with %s is not an app row", async (_n, line) => {
    const { t } = await run({}, { "mas outdated": { rc: 0, out: `${line}\n` } });
    expect(t).toContain("mas: not checked — mas outdated printed text that is not an app list");
  });
  describe.each([["formulae", "brew outdated --formula --verbose", "brew formulae"], ["casks", "brew outdated --cask --greedy-auto-updates --verbose", "brew casks"]])("brew %s", (_k, key, label) => {
    test.each([
      ["Error on stderr, empty stdout", { rc: 0, out: "", err: "Error: alpha: undefined method" }],
      ["Error on indented stderr line", { rc: 0, out: "", err: "Warning: x\n  Error: tap broken" }],
      ["==> Error: on stdout", { rc: 0, out: "==> Error: tap broken\n" }],
      ["==> Error: with only ==> lines", { rc: 0, out: "==> Auto-updated\n==> Error: x\n" }],
    ])("%s is not nothing outdated", async (_n, a) => {
      const { t, r } = await run({}, { [key]: a });
      expect(t).toContain(`${label}: not checked — brew`);
      expect(t).not.toContain(`${label} outdated (0):`);
      expect(r.rc).toBe(1);
    });
    test("a Warning on stderr with empty stdout is still nothing outdated, rc 0", async () => {
      const { t, r } = await run({}, { [key]: { rc: 0, out: "", err: "Warning: something is old" } });
      expect(t).toContain(`${label} outdated (0):`);
      expect(r.rc).toBe(0);
    });
  });
  test("brew rows with an Error on stderr are still listed (the error rule is for no row)", async () => {
    const { t } = await run({}, { "brew outdated --formula --verbose": { rc: 0, out: "alpha (1.0) < 2.0\n", err: "Error: x" } });
    expect(t).toContain("alpha 1.0 → 2.0");
  });
  test.each([["empty stdout", ""], ["{}", "{}"]])("npm at rc 0 with %s and an npm ERR! on stderr is a failure", async (_n, out) => {
    const { t, r } = await run({}, { "npm outdated -g --json": { rc: 0, out, err: "npm ERR! code EACCES" } });
    expect(t).toContain("npm globals: not checked");
    expect(t).not.toContain("npm globals outdated (0):");
    expect(r.rc).toBe(1);
  });
  test("npm at rc 0 with {} and an npm warn on stderr is nothing outdated", async () => {
    const { t, r } = await run({}, { "npm outdated -g --json": { rc: 0, out: "{}", err: "npm warn config x" } });
    expect(t).toContain("npm globals outdated (0):");
    expect(r.rc).toBe(0);
  });
  test("a mas app with parentheses in its name is an app row", async () => {
    const a = await run({}, { "mas outdated": { rc: 0, out: "1 Pixelmator Pro (Mac) (3.0 -> 3.1)\n" } });
    expect(a.t).toContain("mas: 1 Pixelmator Pro (Mac) (3.0 -> 3.1)");
    expect(a.r.rc).toBe(0);
  });
  test("npm with a real list and an npm ERR! on stderr still lists the entries", async () => {
    const { t } = await run({}, { "npm outdated -g --json": { rc: 1, out: '{"a":{"current":"1","latest":"2"}}', err: "npm ERR! code E" } });
    expect(t).toContain("a 1 → 2");
    expect(t).not.toContain("npm globals: not checked");
  });
  test("two brew rows for one name each show their own versions", async () => {
    const { t } = await run({}, { "brew outdated --formula --verbose": { rc: 0, out: "zed (1.0) < 2.0\nzed (3.0) < 4.0\n" } });
    expect(t.match(/zed 1\.0 → 2\.0/g)?.length).toBe(1);
    expect(t.match(/zed 3\.0 → 4\.0/g)?.length).toBe(1);
  });
  test.each([
    ["lowercase npm error", "npm error code EACCES"],
    ["tab indentation", "\tError: x"],
    ["ANSI-colored Error", " \u001b[31mError:\u001b[0m x"],
    ["indented ==> Error: on stderr", " ==> Error: x"],
    ["npm ERR!", "npm ERR! code E"],
  ])("brew and npm: %s on stderr with no row and no list is a read problem", async (_n, err) => {
    const b = await run({}, { "brew outdated --formula --verbose": { rc: 0, out: "", err } });
    expect(b.t).toContain("brew formulae: not checked — brew");
    expect(b.r.rc).toBe(1);
    const n = await run({}, { "npm outdated -g --json": { rc: 0, out: "{}", err } });
    expect(n.t).toContain("npm globals: not checked");
    expect(n.r.rc).toBe(1);
  });
  test.each([
    ["an indented ==> Error: on stdout", " ==> Error: x\n"],
    ["an ==> Error: after ==> lines, indented", "==> Auto-updated\n  ==> Error: x\n"],
  ])("brew with %s and no row is a read problem", async (_n, out) => {
    const { t, r } = await run({}, { "brew outdated --formula --verbose": { rc: 0, out } });
    expect(t).toContain("brew formulae: not checked — brew");
    expect(r.rc).toBe(1);
  });
  const BREW_Q = { out: "", rc: 0 };
  test.each([["Warning: something is old\n\n  \n"], ["\u001b[33mWarning:\u001b[0m x"]])("brew stderr %j (a Warning: line) is quiet next to an empty list: outdated (0), rc 0", async (err) => {
    const b = await run({}, { "brew outdated --formula --verbose": { ...BREW_Q, err } });
    expect(b.t).toContain("brew formulae outdated (0):");
    expect(b.r.rc).toBe(0);
  });
  test.each([["npm warn config x"], ["npm notice New major version"], ["NPM  WARN x"], ["npm \twarn x"], ["npm warn a\nnpm notice b\n\n"], ["npm\u3000notice x"]])("npm stderr %j is quiet next to {}: outdated (0), rc 0", async (err) => {
    const n = await run({}, { "npm outdated -g --json": { rc: 0, out: "{}", err } });
    expect(n.t).toContain("npm globals outdated (0):");
    expect(n.r.rc).toBe(0);
  });
  const UNKNOWN = [
    "Warning: x Error: y", "Warning: npm error is old", "Errors: 0", "  note: Error: not at the start", "error: 0 warnings", "==> error: x", "eRROR: x", "npm errors: 0", "npm error-x@1.0.0", "npm erroneous",
    "npmerror x", "npm err x", "npm ERR x", "==> Errors: 0", "x ==> Error: y",
    "Error\uff1a x", "Error : x", "brew: Error: x", "* Error: x", "fatal: x", "\u009bError: x", "npm ERR code E", "npm error: E", "npm\u200bERR! E", "TypeError: x",
    "Warning: x\nfatal: y", "npm warn x\nboom", "boom",
  ];
  test.each(UNKNOWN.map((e) => [e]))("stderr %j next to an empty list is not checked (rc 1), brew and npm", async (err) => {
    const b = await run({}, { "brew outdated --formula --verbose": { rc: 0, out: "", err } });
    expect(b.t).toContain("brew formulae: not checked — brew");
    expect(b.t).not.toContain("brew formulae outdated (0)");
    expect(b.r.rc).toBe(1);
    const n = await run({}, { "npm outdated -g --json": { rc: 0, out: "{}", err } });
    expect(n.t).toContain("npm globals: not checked");
    expect(n.t).not.toContain("npm globals outdated (0)");
    expect(n.r.rc).toBe(1);
    const e = await run({}, { "npm outdated -g --json": { rc: 0, out: "", err } });
    expect(e.t).toContain("npm globals: not checked");
    expect(e.r.rc).toBe(1);
  });
  test("the benign form of the other tool is not benign: brew's Warning: next to npm {}, npm warn next to brew's empty list", async () => {
    const n = await run({}, { "npm outdated -g --json": { rc: 0, out: "{}", err: "Warning: x" } });
    expect(n.t).toContain("npm globals: not checked");
    const b = await run({}, { "brew outdated --formula --verbose": { rc: 0, out: "", err: "npm warn x" } });
    expect(b.t).toContain("brew formulae: not checked — brew");
  });
  test("stderr next to a listed row stays rc 0 (a row plus text is the accepted rule), brew and npm", async () => {
    const b = await run({}, { "brew outdated --formula --verbose": { rc: 0, out: "alpha (1.0) < 2.0\n", err: "fatal: x" } });
    expect(b.t).toContain("brew formulae outdated (1):");
    expect(b.r.rc).toBe(0);
    const n = await run({}, { "npm outdated -g --json": { rc: 1, out: JSON.stringify({ p: { current: "1", latest: "2" } }), err: "fatal: x" } });
    expect(n.t).toContain("p 1 → 2");
    expect(n.r.rc).toBe(0);
  });
  test.each([["a fullwidth word", "==> \uff25\uff52\uff52\uff4f\uff52 x"], ["a fullwidth arrow word", "==> \uff25rror\uff1a x"]])("brew stdout %s after the arrow is kept as an error line (NFKC): not a quiet heading", async (_n, out) => {
    const { t, r } = await run({}, { "brew outdated --formula --verbose": { rc: 0, out: `${out}\n` } });
    expect(t).not.toContain("brew formulae outdated (0)");
    expect(r.rc).toBe(1);
  });
  test.each([["U+115F", "\u115f"], ["U+1160", "\u1160"], ["U+FFA0", "\uffa0"], ["U+3164", "\u3164"], ["U+2800", "\u2800"]])("npm%s ERR! on stderr with {} is a failure (each blank-looking character alone)", async (_n, ch) => {
    const { t, r } = await run({}, { "npm outdated -g --json": { rc: 0, out: "{}", err: `npm${ch}ERR! x` } });
    expect(t).toContain("npm globals: not checked");
    expect(r.rc).toBe(1);
  });
  test.each([["both empty", '{"a":{"current":"","latest":""}}'], ["empty current", '{"a":{"current":"","latest":"2"}}'], ["empty latest", '{"a":{"current":"1","latest":""}}']])("an npm entry with %s is a failure, never a row", async (_n, out) => {
    const { t, r } = await run({}, { "npm outdated -g --json": { rc: 1, out } });
    expect(t).toContain("npm globals: not checked");
    expect(r.rc).toBe(1);
  });
  test("a mas line of exactly 200 characters is an app row (shown whole), 201 is not", async () => {
    const mk = (n: number) => { const tail = " (1 -> 2)"; return `1 ${"a".repeat(n - 2 - tail.length)}${tail}`; };
    expect(mk(200).length).toBe(200);
    const a = await run({}, { "mas outdated": { rc: 0, out: `${mk(200)}\n` } });
    expect(a.t).not.toContain("mas: not checked");
    expect(a.t).toContain(mk(200));
    expect(a.t).not.toContain("…");
    const b = await run({}, { "mas outdated": { rc: 0, out: `${mk(201)}\n` } });
    expect(b.t).toContain("mas: not checked");
  });
  test("a mas row with two spaces after the id is an app row", async () => {
    const { t } = await run({}, { "mas outdated": { rc: 0, out: "497799835  Xcode (15.0 -> 16.0)\n" } });
    expect(t).not.toContain("mas: not checked");
  });
  test.each([["1 App () -> 2)"], ["1 App (1 -> ))"], ["1 App (1(2 -> 3)"], ["1 App (1 -> 2(3)"]])("a mas line %j is not an app row", async (line) => {
    const { t } = await run({}, { "mas outdated": { rc: 0, out: `${line}\n` } });
    expect(t).toContain("mas: not checked — mas outdated printed text that is not an app list");
  });
  test.each([["spaces", " ".repeat(1000000)], ["lines of spaces", " \n".repeat(500000)], ["npm repeated", "npm ".repeat(250000)], ["==> repeated", "==> ".repeat(250000)], ["ESC runs", "\u001b[".repeat(500000)]])("1 MB of %s on stderr is classified in bounded time", async (_n, err) => {
    const t0 = performance.now();
    await run({}, { "brew outdated --formula --verbose": { rc: 0, out: "", err }, "npm outdated -g --json": { rc: 0, out: "{}", err } });
    expect(performance.now() - t0).toBeLessThan(3000);
  });
  test.each([
    ["an OSC title with spaces", "\u001b]0;brew out\u0007Error: x"],
    ["an OSC title ended by ST", "\u001b]0;a b\u001b\\Error: x"],
    ["a charset escape and tput sgr0", "\u001b(B\u001b[mError: x"],
    ["a bare CSI with no parameters", "\u001b[mError: x"],
    ["two colour sequences before it", "\u001b[1m\u001b[31mError: x"],
    ["an escape inside the word", "Er\u001b[0mror: x"],
    ["a C1 CSI", "\u009bmError: x"],
    ["a C1 OSC title", "\u009d0;title\u009cError: x"],
    ["ESC and a backslash", "\u001b\\Error: x"],
    ["ESC 7 (save cursor)", "\u001b7Error: x"],
    ["ESC c (reset)", "\u001bcError: x"],
    ["ESC ] ended by a C1 ST", "\u001b]0;a b\u009cError: x"],
    ["ESC ] ended by a C1 ST, a BEL later", "\u001b]0;a\u009cError: x\u0007"],
    ["a CSI with an intermediate byte", "\u001b[1 qError: x"],
    ["two intermediate bytes", "\u001b%/GError: x"],
    ["a C1 CSI with an intermediate byte", "\u009b1 qError: x"],
    ["a C1 OSC ended by BEL", "\u009d0;t\u0007Error: x"],
    ["a CSI ended by ~", "\u001b[15~Error: x"],
    ["a progress line then CR", "##### 100.0%\rError: x"],
    ["a progress line then CR LF", "##### 100.0%\r\nError: x"],
    ["a progress line then U+2028", "##### 100.0%\u2028Error: x"],
    ["a progress line then U+2029", "##### 100.0%\u2029Error: x"],
    ["a progress line then NEL", "##### 100.0%\u0085Error: x"],
    ["a progress line then VT", "##### 100.0%\u000bError: x"],
    ["a progress line then FF", "##### 100.0%\u000cError: x"],
    ["a tab between npm and error", "npm\terror x"],
    ["a BOM", "\ufeffError: x"],
    ["a no-break space", "\u00a0\u00a0Error: x"],
    ["a zero-width space", "\u200bError: x"],
    ["upper case", "ERROR: x"],
    ["==> Error: with no space", "==>Error: x"],
    ["==> Error: with one space", "==> Error: x"],
    ["==> Error: with two spaces", "==>  Error: x"],
    ["npm error ending the line", "npm error"],
    ["npm error code", "npm error code EACCES"],
    ["npm ERR! in capitals", "NPM ERR! code E"],
  ])("an error line with %s on stderr is a read problem (brew and npm)", async (_n, err) => {
    const b = await run({}, { "brew outdated --formula --verbose": { rc: 0, out: "", err } });
    expect(b.t).toContain("brew formulae: not checked — brew");
    expect(b.r.rc).toBe(1);
    const n = await run({}, { "npm outdated -g --json": { rc: 0, out: "{}", err } });
    expect(n.t).toContain("npm globals: not checked");
    expect(n.r.rc).toBe(1);
  });
  test.each([["a colored Error on stdout", "\u001b[31mError: x\n"], ["a bare Error on stdout", "Error: x\n"], ["an Error after a colored heading", "\u001b[34m==>\u001b[0m Auto-updated\nError: x\n"]])("brew with %s and no row says printed an error", async (_n, out) => {
    const { t, r } = await run({}, { "brew outdated --formula --verbose": { rc: 0, out } });
    expect(t).toContain("brew formulae: not checked — brew outdated --formula --verbose printed an error and no row");
    expect(r.rc).toBe(1);
  });
  test.each([["a bare ==>", "==>\nalpha (1.0) < 2.0\n"], ["==> glued to its text", "==>Auto-updated\nalpha (1.0) < 2.0\n"]])("%s on brew stdout is not a known heading: counted (rc 1), the row is listed", async (_n, out) => {
    const { t, r } = await run({}, { "brew outdated --formula --verbose": { rc: 0, out } });
    expect(t).toContain("brew formulae outdated (1):");
    expect(t).toContain("brew formulae: not checked for 1 line(s)");
    expect(r.rc).toBe(1);
  });
  // hasError on single escapes, as the line check reads them. Known and left: a CR or U+2028 inside an OSC title splits the
  // sequence (lines are split before the strip), which is not output a tool prints.
  test.each([
    ["ESC 0", "\u001b0Error: x"],
    ["ESC Z", "\u001bZError: x"],
    ["ESC ^", "\u001b^Error: x"],
    ["ESC ~", "\u001b~Error: x"],
    ["ESC [ 31 m", "\u001b[31mError: x"],
    ["an ESC ] title with a space ended by BEL", "\u001b]0;a b\u0007Error: x"],
    ["a C1 OSC cut by an ESC, then a BEL later (the body stops at the ESC)", "\u009d\u001b[mError: x\u0007"],
    ["a C1 OSC ended by the C1 ST, a BEL later (the body stops at the ST)", "\u009d0;a\u009cError: x\u0007"],
    ["a C1 OSC ended by BEL, a C1 ST later (the body stops at the BEL)", "\u009d0;a\u0007Error: x\u009c"],
    ["an ESC ] title ended by BEL, a C1 ST later (the body stops at the BEL)", "\u001b]0;a\u0007Error: x\u009c"],
  ])("hasError sees an Error: line after %s", (_n, text) => {
    expect(hasError(text)).toBe(true);
  });
  test.each([
    ["an ESC ] title never terminated before the text (its bracket stays, the line does not start with Error:)", "\u001b]Error: x"],
    ["an ESC ] title cut by another escape", "\u001b]0;t\u001b[mError: x"],
    ["an ESC [ that is not a CSI (its bracket stays)", "\u001b[\u0001Error: x"],
  ])("hasError does not strip %s: not an error line", (_n, text) => {
    expect(hasError(text)).toBe(false);
  });
  // A row must not vanish behind a "==>" heading: the heading is dropped only when it is a heading and nothing else.
  describe.each([
    ["the heading and the row on one line", "==> Outdated evil (1.0) < 2.0 \n"],
    ["a word after the heading", "==> x evil (1.0) < 2.0 \n"],
    ["the row right after the arrow", "==> evil (1.0) < 2.0 \n"],
    ["a NUL joining them", "==> Outdated\u0000evil (1.0) < 2.0\n"],
    ["a heading with only a parenthesis", "==> Outdated (3)\n"],
    ["a heading with only a <", "==> Outdated evil 1.0 < 2.0\n"],
    ["a heading with only a !=", "==> Outdated evil 1.0 != 2.0\n"],
  ])("brew stdout with %s", (_n, out) => {
    test("is not nothing outdated: rc 1 with the not-checked note", async () => {
      const { t, r } = await run({}, { "brew outdated --formula --verbose": { rc: 0, out } });
      expect(t).not.toContain("brew formulae outdated (0):");
      expect(t).toContain("brew formulae: no row could be read from 1 line(s)");
      expect(r.rc).toBe(1);
    });
  });
  test("a row inside an OSC title in front of a heading is not dropped: it is listed, its name marked as changed", async () => {
    const { t } = await run({}, { "brew outdated --formula --verbose": { rc: 0, out: "\u001b]0;evil (1.0) < 2.0\u0007==> Formulae\n" } });
    expect(t).not.toContain("brew formulae outdated (0):");
    expect(t).toContain("brew formulae: no row could be read from 1 line(s)");
  });
  test.each([["CR", "\r"], ["VT", "\u000b"], ["FF", "\u000c"], ["NEL", "\u0085"], ["U+2028", "\u2028"], ["U+2029", "\u2029"]])("a row after a heading, ended by %s, is listed", async (_n, sep) => {
    const { t, r } = await run({}, { "brew outdated --formula --verbose": { rc: 0, out: `==> Outdated Formulae${sep}evil (1.0) < 2.0\n` } });
    expect(t).toContain("brew formulae outdated (1):");
    expect(t).toContain("evil 1.0 → 2.0");
    expect(r.rc).toBe(0);
  });
  test.each([["a plain heading", "==> Outdated Formulae\n"], ["Auto-updated", "==> Auto-updated Homebrew!\n"], ["a colored heading", "\u001b[34m==>\u001b[0m \u001b[1mOutdated Formulae\u001b[0m\n"], ["an indented heading", "  ==> Outdated Formulae\n"]])("%s on its own is dropped quietly, with a row after it listed", async (_n, head) => {
    const { t, r } = await run({}, { "brew outdated --formula --verbose": { rc: 0, out: `${head}evil (1.0) < 2.0\n` } });
    expect(t).toContain("brew formulae outdated (1):");
    expect(t).not.toContain("not checked for");
    expect(r.rc).toBe(0);
  });
  test("a 1 MB heading line full of ( is classified in bounded time", async () => {
    const t0 = performance.now();
    await run({}, { "brew outdated --formula --verbose": { rc: 0, out: `==> ${"a (".repeat(333333)}\n` } });
    expect(performance.now() - t0).toBeLessThan(3000);
  });
  test.each([["U+009D runs", (n: number) => "\u009d".repeat(n)], ["U+009D then a letter", (n: number) => "\u009da".repeat(n / 2)], ["U+009D then a space", (n: number) => "\u009d ".repeat(n / 2)], ["ESC ] runs", (n: number) => "\u001b]".repeat(n / 2)], ["U+009B runs", (n: number) => "\u009b".repeat(n)]])("hasError on %s grows linearly (4x the text takes under 9x the time)", (_n, mk) => {
    const best = (n: number) => {
      const text = mk(n);
      let m = Infinity;
      for (let i = 0; i < 3; i++) {
        const t0 = performance.now();
        hasError(text);
        m = Math.min(m, performance.now() - t0);
      }
      return m;
    };
    best(8000);
    const a = Math.max(best(30000), 1);
    const b = best(120000);
    expect(b / a).toBeLessThan(9);
  });
  test("a colored known heading is quiet; an unknown heading is counted", async () => {
    const { t, r } = await run({}, { "brew outdated --formula --verbose": { rc: 0, out: "\u001b[34m==>\u001b[0m \u001b[1mAuto-updated Homebrew!\u001b[0m\n\u001b[0m ==> Another heading\nalpha (1.0) < 2.0\n" } });
    expect(t).toContain("brew formulae outdated (1):");
    expect(t).toContain("brew formulae: not checked for 1 line(s)");
    expect(r.rc).toBe(1);
  });
  test.each([["a null current", '{"a":{"current":null,"latest":"2"}}'], ["a null latest", '{"a":{"current":"1","latest":null}}']])("an npm entry with %s is a failure", async (_n, out) => {
    const { t, r } = await run({}, { "npm outdated -g --json": { rc: 1, out } });
    expect(t).toContain("npm globals: not checked");
    expect(r.rc).toBe(1);
  });
  test.each([["OSC open without end", "\u001b]0;".repeat(200000)], ["CSI runs", "\u001b[1;".repeat(300000)], ["charset escapes", "\u001b(".repeat(500000)], ["C1 runs", "\u009b".repeat(1000000)], ["spaces then Error", `${" ".repeat(1000000)}x`]])("1 MB of %s on stderr is classified in bounded time", async (_n, err) => {
    const t0 = performance.now();
    await run({}, { "brew outdated --formula --verbose": { rc: 0, out: "", err }, "npm outdated -g --json": { rc: 0, out: "{}", err } });
    expect(performance.now() - t0).toBeLessThan(3000);
  });
  test("npmQuiet forwards every other option and the caller's env cannot turn the notifier back on", async () => {
    let got: Parameters<Exec>[1];
    const base: Exec = async (_a, o) => ((got = o), { rc: 0, out: "", err: "" });
    await npmQuiet("npm", base)(["npm", "view"], { timeoutMs: 7, soft: true, cwd: "/w", stdin: "s", force: true, env: { NO_UPDATE_NOTIFIER: "0", npm_config_update_notifier: "true", K: "v" } });
    expect(got).toEqual({ timeoutMs: 7, soft: true, cwd: "/w", stdin: "s", force: true, env: { NO_UPDATE_NOTIFIER: "1", npm_config_update_notifier: "false", K: "v" } });
  });
  test("npmQuiet adds the notifier env to the npm binary only and keeps an env the caller passed", async () => {
    const seen: (Record<string, string> | undefined)[] = [];
    const base: Exec = async (_a, o) => (seen.push(o?.env), { rc: 0, out: "", err: "" });
    const e = npmQuiet("npm", base);
    await e(["npm", "view"], { env: { KEEP: "1" } });
    await e(["npm", "view"]);
    await e(["brew", "x"], { env: { B: "1" } });
    await e(["brew", "x"]);
    expect(seen[0]).toEqual({ KEEP: "1", NO_UPDATE_NOTIFIER: "1", npm_config_update_notifier: "false" });
    expect(seen[1]).toEqual({ NO_UPDATE_NOTIFIER: "1", npm_config_update_notifier: "false" });
    expect(seen[2]).toEqual({ B: "1" });
    expect(seen[3]).toBeUndefined();
    const none = npmQuiet(null, base);
    await none(["null", "x"]);
    expect(seen[4]).toBeUndefined();
  });
  test.each([
    ["two places that look like the columns", "fs 9 9 999999999 1% x 100 50 20 89% /"],
    ["300 digits of Available", `/dev/d 1 1 ${"9".repeat(300)} 1% /`],
    ["an Available over ten petabytes", "/dev/d 1 1 10000000000001 1% /"],
  ])("df with %s is not a free-space reading", async (_n, row) => {
    const { t } = await run({}, { "df -k -- /brew": { rc: 0, out: `${HDR}${row}\n` } });
    expect(t).toContain("disk: not checked");
    expect(t).not.toContain("GiB free");
  });
  test("df with an Available of exactly ten petabytes is read", async () => {
    const { t } = await run({}, { "df -k -- /brew": { rc: 0, out: `${HDR}/dev/d 1 1 10000000000000 1% /\n` } });
    expect(t).toContain("GiB free");
  });
  test("df with a long name wrapped onto its own line reads the numbers line (the last), not the name line", async () => {
    const { t } = await run({}, { "df -k -- /brew": { rc: 0, out: `${HDR}//user@host/a-very-long-share-name\n    971350180 400000000 52428800 89% /Volumes/a\n` } });
    expect(t).toContain("disk: 50.0 GiB free");
  });
  test("8000 distinct brew rows are listed in bounded time", async () => {
    const out = Array.from({ length: 8000 }, (_, i) => `pkg${i} (1.0) < 2.0`).join("\n");
    const t0 = performance.now();
    const { t } = await run({}, { "brew outdated --formula --verbose": { rc: 0, out } });
    expect(performance.now() - t0).toBeLessThan(1500);
    expect(t).toContain("brew formulae outdated (8000):");
  });
  test("npm entries: one-sided versions show ? for the missing one, an entry with neither is a failure", async () => {
    const a = await run({}, { "npm outdated -g --json": { rc: 1, out: '{"a":{"current":"1"},"b":{"latest":"2"}}' } });
    expect(a.t).toContain("a 1 → ?");
    expect(a.t).toContain("b ? → 2");
    const b = await run({}, { "npm outdated -g --json": { rc: 1, out: '{"a":{"wanted":"1"}}' } });
    expect(b.t).toContain("npm globals: not checked");
    expect(b.r.rc).toBe(1);
  });
  test("readiness's own reads: timeout and soft on every call, env only on brew and npm, and each its own env", async () => {
    const h = fakeHost({ ...base, answers: okAnswers });
    const seen: { argv: string[]; o: Record<string, unknown> | undefined }[] = [];
    const exec: typeof h.exec = async (argv, o) => (seen.push({ argv, o: o as never }), h.exec(argv, o));
    await readiness(cfgOf(), exec, h.fs, {});
    const own = seen.filter((c) => ["df", "curl", "mas"].includes(c.argv[0]!) || (c.argv[0] === "brew" && c.argv[1] === "--prefix"));
    expect(own.length).toBeGreaterThanOrEqual(5);
    for (const c of own) {
      expect(c.o?.timeoutMs).toBe(cfgOf().timeoutMs);
      expect(c.o?.soft).toBe(true);
      if (c.argv[0] === "brew") expect(c.o?.env).toEqual({ HOMEBREW_NO_AUTO_UPDATE: "1" });
      else expect(c.o?.env).toBeUndefined();
    }
    const npmAll = seen.filter((c) => c.argv.join(" ") === "npm outdated -g --json");
    expect(npmAll.length).toBe(2);
    const npmOwn = npmAll.filter((c) => c.o?.soft === true);
    expect(npmOwn.length).toBe(1);
    expect(npmOwn[0]!.o?.timeoutMs).toBe(cfgOf().timeoutMs);
    for (const c of npmAll) expect(c.o?.env).toEqual({ NO_UPDATE_NOTIFIER: "1", npm_config_update_notifier: "false" });
  });
  test("npm names get the same text-removed marker and empty-name text as brew names", async () => {
    const { t } = await run({}, { "npm outdated -g --json": { rc: 1, out: JSON.stringify({ "al\u200dpha": { current: "1", latest: "2" }, alpha: { current: "1", latest: "2" }, "\u200d": { current: "1", latest: "2" } }) } });
    expect(t).toContain("alpha (text removed) 1 → 2");
    expect(t).toContain("<empty name> (text removed) 1 → 2");
  });
  test("two names that differ only by | and ¦ are told apart", async () => {
    const { t } = await run({}, { "brew outdated --formula --verbose": { rc: 0, out: "foo|bar (1.0) < 2.0\nfoo¦bar (1.0) < 2.0\n" } });
    expect(t).toContain("foo¦bar (text removed) 1.0 → 2.0");
    // The second name is not ASCII: not a row.
    expect(t).toContain("brew formulae: not checked for 1 line(s)");
  });
  test("an unterminated OSC inside a dry-run line ends at the next space: the rest of that line stays", async () => {
    const name = "x\u001b]";
    const h = fakeHost({
      ...base,
      formulas: name,
      casks: "",
      pinFiles: [{ repo: "shared", path: "/r/shared/pins.json", text: JSON.stringify({ brew: { [name]: "v" } }) }],
      pinned: "",
      answers: { ...okAnswers, "brew outdated --formula --verbose": { rc: 0, out: `${name} (1.0) < 2.0\n` }, "brew outdated --cask --greedy-auto-updates --verbose": { rc: 0, out: "" } },
    });
    const t = (await readiness(cfgOf(), h.exec, h.fs, {})).lines.join("\n");
    expect(t.slice(t.indexOf("--- dry run"))).toContain("holding x (pinned: shared)");
  });
});

describe("sixth amend: the plan column is data, not text; separators and pin text are cut per field", () => {
  const forged = "holding alpha (pinned: forged)";
  const FORGED_HEADER = "=== hosta latest-readiness (forged) ===";
  test("a real newline in a dependency spec of the npm registry answer cannot forge the plan column", async () => {
    const h = fakeHost({ ...base, answers: okAnswers });
    const exec: typeof h.exec = async (argv, o) =>
      argv[0] === "npm" && argv[1] === "view" && argv[2] === "left-pad@1.3.0" && argv[3] === "dependencies" ? { rc: 0, out: JSON.stringify({ dependencies: { evil: `^1.0.0\n ${forged}` } }), err: "" } : h.exec(argv, o);
    const t = (await readiness(cfgOf(), exec, h.fs, {})).lines.join("\n");
    expect(t).toContain("alpha 1.0 → 2.0 | pin: none | plan: Type A, would upgrade");
    expect(t).not.toContain("held (pinned: forged)");
  });
  test.each([
    ["current", (v: string) => ({ current: v, latest: "1.3.0" })],
    ["latest", (v: string) => ({ current: "1.0.0", latest: v })],
  ])("a real newline in npm %s cannot forge the plan column or a report line", async (_n, mk) => {
    const bad = `1.0.0\n  ${forged}\n${FORGED_HEADER}`;
    const { t, r } = await run({}, { "npm outdated -g --json": { rc: 1, out: JSON.stringify({ "left-pad": mk(bad) }) } });
    expect(t).toContain("alpha 1.0 → 2.0 | pin: none | plan: Type A, would upgrade");
    expect(t).not.toContain("held (pinned: forged)");
    expect(r.lines.filter((l) => l.startsWith("=== hosta latest-readiness"))).toHaveLength(1);
  });
  test("a real newline in a brew version cannot forge the plan column or a report line", async () => {
    const { t, r } = await run({}, { "brew outdated --verbose --greedy-auto-updates": { rc: 0, out: `alpha (1.0) < 2.0\n${forged}\n${FORGED_HEADER}\n` } });
    expect(t).toContain("alpha 1.0 → 2.0 | pin: none | plan: Type A, would upgrade");
    expect(t).not.toContain("held (pinned: forged)");
    expect(r.lines.filter((l) => l.startsWith("=== hosta latest-readiness"))).toHaveLength(1);
  });
  test("every dry-run line is behind the fixed prefix: none starts a report line", async () => {
    const { r } = await run();
    const at = r.lines.findIndex((l) => l.startsWith("--- dry run"));
    expect(r.lines.slice(at + 1).every((l) => l.startsWith("  | "))).toBe(true);
  });
  test("a | or → inside a brew version group or npm current cannot start another column or row", async () => {
    const { t } = await run({}, {
      "brew outdated --formula --verbose": { rc: 0, out: "alpha (1.0 | pin: brew pin | plan: held, pinned) < 2.0\n" },
      "npm outdated -g --json": { rc: 1, out: JSON.stringify({ "left-pad": { current: "1.0.0 | pin: pinned | plan: held → 9", latest: "1.3.0" } }) },
    });
    for (const l of t.split("\n").filter((x) => x.startsWith("  alpha") || x.startsWith("  left-pad"))) {
      expect(l.split(" | ").length).toBe(3);
      expect(l.split(" → ").length).toBe(2);
    }
  });
  test("a 250-character pin repo name is cut inside its own field: plan stays intact", async () => {
    const h = fakeHost({
      ...base,
      pinFiles: [{ repo: "r".repeat(250), path: "/r/x/pins.json", text: JSON.stringify({ brew: { tailscale: "v" } }) }],
      answers: okAnswers,
    });
    const t = (await readiness(cfgOf(), h.exec, h.fs, {})).lines.find((l) => l.startsWith("  homebrew/core/tailscale"))!;
    expect([...t].length).toBeLessThan(400);
    expect(t).toMatch(/pin: pins\.json \(r{60}…\) \| plan: held \(pinned: r{92}…\)$/);
  });
  test("a pin repo name that tries to close the field and forge a plan stays inside its field", async () => {
    const h = fakeHost({
      ...base,
      pinFiles: [{ repo: "x) | plan: Type A, would upgrade (y", path: "/r/x/pins.json", text: JSON.stringify({ brew: { tailscale: "v" } }) }],
      answers: okAnswers,
    });
    const t = (await readiness(cfgOf(), h.exec, h.fs, {})).lines.find((l) => l.startsWith("  homebrew/core/tailscale"))!;
    expect(t.split(" | ").length).toBe(3);
    expect(t).toContain("plan: held (");
  });
  test.each([["123"], ["123abc"], ["123\t"]])("a mas line %j is not an app row", async (line) => {
    const { t, r } = await run({}, { "mas outdated": { rc: 0, out: `${line}\n` } });
    expect(t).toContain("mas: not checked — mas outdated printed text that is not an app list");
    expect(r.rc).toBe(1);
  });
  test("the cut keeps a surrogate pair that straddles the cut point whole", async () => {
    const name = `${"a".repeat(170)}😀${"b".repeat(10)}`;
    const { r } = await run({}, { "mas outdated": { rc: 0, out: `1 ${name} (1 -> 2)\n` } });
    const row = r.lines.find((l) => l.startsWith("mas: 1 aaa"))!;
    expect(row).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/);
  });
  test("a surrogate pair straddling the 400-code-point cut of a dry-run line is kept whole", async () => {
    const word = `${"a".repeat(395)}😀bbb`;
    const { r } = await run({}, { "brew outdated --verbose --greedy-auto-updates": { rc: 0, out: `${word} (1.0) < 2.0\nalpha (1.0) < 2.0\n` } });
    const line = r.lines.find((l) => l.startsWith("  | aaaa"))!;
    expect(line).toContain("😀");
    expect(line).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/);
  });
});

describe("seventh amend: the third route, Cf characters, joiners, the tap, test gaps", () => {
  const forged = "holding alpha (pinned: forged)";
  test.each([["LF", "\n"], ["CRLF", "\r\n"]])("a %s in an npm install-script body cannot forge a holding line or the Type A list", async (_n, nl) => {
    const h = fakeHost({ ...base, answers: okAnswers });
    const body = `node x${nl} ${forged}${nl}Type A: holding [alpha] — upgrading []${nl} y`;
    const exec: typeof h.exec = async (argv, o) =>
      argv[0] === "npm" && argv[1] === "view" && argv[2] === "left-pad@1.3.0" && argv[3] === "scripts" ? { rc: 0, out: JSON.stringify({ postinstall: body }), err: "" } : h.exec(argv, o);
    const { lines } = await readiness(cfgOf(), exec, h.fs, {});
    const t = lines.join("\n");
    expect(t).toContain("alpha 1.0 → 2.0 | pin: none | plan: Type A, would upgrade");
    expect(t).not.toContain("held (pinned: forged)");
    expect(lines.slice(lines.findIndex((l) => l.startsWith("--- dry run")) + 1).every((l) => l.startsWith("  | "))).toBe(true);
  });
  test.each([
    ["U+0600", "\u0600"], ["U+06DD", "\u06dd"], ["U+070F", "\u070f"], ["U+08E2", "\u08e2"], ["U+1D173", "\u{1d173}"], ["U+13430", "\u{13430}"],
    ["U+E0100", "\u{e0100}"], ["U+E0001 (tag)", "\u{e0001}"], ["U+E001F (tag)", "\u{e001f}"], ["DEL", "\u007f"], ["U+1160", "\u1160"],
  ])("%s is stripped from a brew row, an npm entry and a mas line", async (_n, ch) => {
    const { t } = await run({}, { "mas outdated": { rc: 0, out: `1 App${ch}x (1 -> 2)\n` }, "brew outdated --formula --verbose": { rc: 0, out: `alpha${ch}z (1.0) < 2.0\n` } });
    expect(t).toContain("mas: not checked — mas outdated printed text that is not an app list");
    expect(t).toContain("brew formulae: no row could be read from 1 line(s)");
    expect(t).not.toContain(ch);
  });
  test("ZWNJ, ZWJ and VS16 are stripped everywhere; a name that had text removed says so, an empty one gets a placeholder", async () => {
    const { t } = await run({}, { "mas outdated": { rc: 0, out: "1 می\u200cخواهم 👩\u200d💻 ❤\ufe0f x (1 -> 2)\n" }, "brew outdated --formula --verbose": { rc: 0, out: "al\u200dpha (1.0) < 2.0\nalpha (1.0) < 2.0\n\u200d (1.0) < 2.0\n" } });
    expect(t).toContain("mas: not checked — mas outdated printed text that is not an app list");
    expect(t).toContain("brew formulae: not checked for 2 line(s)");
    expect(t).toContain("\n  alpha 1.0 → 2.0 |");
    expect(t).not.toContain("text removed) 1.0");
  });
  test("a tap-qualified name is shown with its tap: alpha and evil/tap/alpha are told apart; the clean name is cut, not the raw", async () => {
    const { t } = await run({}, { "brew outdated --formula --verbose": { rc: 0, out: "alpha (1.0) < 2.0\nevil/tap/alpha (1.0) < 2.0\nfoo\u001b]8;;http://x (1.0) < 2.0\n" } });
    expect(t).toContain("\n  alpha 1.0 → 2.0 |");
    expect(t).toContain("\n  evil/tap/alpha 1.0 → 2.0 |");
    expect(t).not.toContain("http://x");
  });
  test("a line is cut after cleaning, not before: 480 characters of escape sequences do not eat the text after them", async () => {
    const word = `${"\u001b[2J".repeat(120)}TAIL`;
    const { r } = await run({}, { "brew outdated --verbose --greedy-auto-updates": { rc: 0, out: `${word} (1.0) < 2.0\nalpha (1.0) < 2.0\n` } });
    expect(r.lines.some((l) => l.startsWith("  | TAIL"))).toBe(true);
  });
  test.each(["x 123 y", "abc 1 App"])("a mas line %j is not an app row (the id is anchored at the start)", async (line) => {
    const { t } = await run({}, { "mas outdated": { rc: 0, out: `${line}\n` } });
    expect(t).toContain("mas: not checked");
  });
  test("npm: a non-string current is a failure even with a string latest; long versions are cut at 40 per field", async () => {
    const a = await run({}, { "npm outdated -g --json": { rc: 1, out: '{"a":{"current":1,"latest":"2"}}' } });
    expect(a.t).toContain("npm globals: not checked");
    const b = await run({}, { "npm outdated -g --json": { rc: 1, out: JSON.stringify({ a: { current: "c".repeat(100), latest: "l".repeat(100) } }) } });
    expect(b.t).toContain(`${"c".repeat(40)}… → ${"l".repeat(40)}…`);
    const c = await run({}, { "brew outdated --formula --verbose": { rc: 0, out: `alpha (${"c".repeat(100)}) < ${"n".repeat(100)}\n` } });
    expect(c.t).toContain(`${"c".repeat(40)}… → ${"n".repeat(40)}…`);
  });
});

describe("eighth amend: kind and full name, row shape", () => {
  test("an unknown-tap other/tap/alpha is not core alpha: its own versions and plan", async () => {
    const h = fakeHost({
      ...base,
      formulas: "alpha other/tap/alpha",
      casks: "",
      formulaTaps: { alpha: "homebrew/core", "other/tap/alpha": "other/tap" },
      answers: { ...okAnswers, "brew outdated --formula --verbose": { rc: 0, out: "alpha (1.0) < 2.0\nother/tap/alpha (7.0) < 8.0\n" }, "brew outdated --cask --greedy-auto-updates --verbose": { rc: 0, out: "" } },
    });
    const t = (await readiness(cfgOf(), h.exec, h.fs, {})).lines.join("\n");
    expect(t).toContain("\n  alpha 1.0 → 2.0 | pin: none | plan: Type A, would upgrade");
    expect(t).toContain("\n  other/tap/alpha 7.0 → 8.0 | pin: none | plan: not planned by the dry run");
  });
  test("a cask from an unapproved tap does not take the formula of the same name's plan", async () => {
    const h = fakeHost({
      ...base,
      formulas: "ollama",
      casks: "ollama",
      pinned: "",
      pinFiles: [],
      formulaTaps: { ollama: "homebrew/core" },
      caskTaps: { ollama: "someone/tap" },
      answers: { ...okAnswers, "brew outdated --formula --verbose": { rc: 0, out: "ollama (1.0) < 1.1\n" }, "brew outdated --cask --greedy-auto-updates --verbose": { rc: 0, out: "ollama (1.0) != 1.1\n" } },
    });
    const lines = (await readiness(cfgOf(), h.exec, h.fs, {})).lines;
    const cask = lines.slice(lines.findIndex((l) => l.startsWith("brew casks outdated"))).find((l) => l.startsWith("  ollama"))!;
    expect(cask).not.toContain("Type A, would upgrade");
  });
  test("a line that is not in brew's row shape is not a row: it is not checked, and the count is of real rows", async () => {
    const { t, r } = await run({}, { "brew outdated --formula --verbose": { rc: 0, out: "alpha (1.0) < 2.0\nbogus row\n" } });
    expect(t).toContain("brew formulae outdated (1):");
    expect(t).toContain("brew formulae: not checked for 1 line(s) that are not in the row shape");
    expect(t).not.toContain("bogus row |");
    expect(r.rc).toBe(1);
  });
});

describe("amend 17: mas is split on every line end hasError reads", () => {
  const A = "1 AppA (1.0 -> 2.0)";
  const B = "2 AppB (3.0 -> 4.0)";
  const masRun = (out: string) => run({}, { "mas outdated": { rc: 0, out } });
  test.each([["NEL", "\u0085"], ["VT", "\u000b"], ["FF", "\u000c"], ["U+2028", " "], ["U+2029", " "], ["CR", "\r"], ["CRLF", "\r\n"]])("two valid rows joined by %s are both listed at rc 0", async (_n, sep) => {
    const { t, r } = await masRun(`${A}${sep}${B}\n`);
    expect(t).toContain("mas: 1 AppA (1.0 -> 2.0)");
    expect(t).toContain("mas: 2 AppB (3.0 -> 4.0)");
    expect(r.rc).toBe(0);
  });
  test.each([["NEL", "\u0085"], ["VT", "\u000b"], ["FF", "\u000c"], ["U+2028", " "], ["U+2029", " "], ["CR", "\r"]])("a row and an error line joined by %s is not an app list (rc 1)", async (_n, sep) => {
    const { t, r } = await masRun(`${A}${sep}Error: not signed in${sep}${B}\n`);
    expect(t).toContain("mas: not checked — mas outdated printed text that is not an app list");
    expect(t).not.toContain("mas: 1 AppA");
    expect(r.rc).toBe(1);
  });
  test("a fused row longer than 200 characters does not lose the later app", async () => {
    const long = `1 ${"A".repeat(150)} (1.0 -> 2.0)`;
    const { t, r } = await masRun(`${long}\u0085${B}\n`);
    expect(t).toContain("mas: 2 AppB (3.0 -> 4.0)");
    expect(r.rc).toBe(0);
  });
  test("blank lines between rows are skipped", async () => {
    const { t, r } = await masRun(`${A}\n\n${B}\n`);
    expect(t).toContain("mas: 2 AppB (3.0 -> 4.0)");
    expect(r.rc).toBe(0);
  });
  test("a CR progress prefix is its own line, which is not a row: not an app list", async () => {
    const { t, r } = await masRun(`Searching...\r497799835 Xcode (15.0 -> 16.0)\n`);
    expect(t).toContain("not an app list");
    expect(r.rc).toBe(1);
  });
});

describe("amend 17: the error-line reader's escape ranges and anchors, one row per range end", () => {
  test.each([
    ["ESC [ ? 25 h", "\u001b[?25h"],
    ["U+009B ? 25 h", "\u009b?25h"],
    ["ESC [ 1 / @", "\u001b[1/@"],
    ["U+009B 0 / @", "\u009b0/@"],
    ["U+009B 15 ~", "\u009b15~"],
    ["ESC [ 1 ; 2 m", "\u001b[1;2m"],
    ["ESC SP 0", "\u001b 0"],
    ["ESC ( ~", "\u001b(~"],
    ["ESC ( B", "\u001b(B"],
    ["ESC ] title BEL", "\u001b]0;t\u0007"],
  ])("hasError sees an Error: line after %s", (_n, esc) => {
    expect(hasError(`${esc}Error: x`)).toBe(true);
  });
  test("hasError sees an npm error line led by spaces", () => {
    expect(hasError(" npm error code EACCES")).toBe(true);
    expect(hasError("npm error code EACCES")).toBe(true);
  });
  test("hasError: '=> Error: x' and ' ] Error: x' are not error lines; '==> Error: x' is", () => {
    expect(hasError("=> Error: x")).toBe(false);
    expect(hasError(" ] Error: x")).toBe(false);
    expect(hasError("==> Error: x")).toBe(true);
  });
  test("a brew stdout line that only contains '==>' is not a heading: no row could be read", async () => {
    const { t, r } = await run({}, { "brew outdated --formula --verbose": { rc: 0, out: "bogus ==> text\n" } });
    expect(t).toContain("no row could be read from 1 line(s)");
    expect(r.rc).toBe(1);
  });
  test("a whitespace-only brew line is blank (outdated 0); an indented row is listed", async () => {
    const a = await run({}, { "brew outdated --formula --verbose": { rc: 0, out: " \n" } });
    expect(a.t).toContain("brew formulae outdated (0):");
    expect(a.t).not.toContain("no row could be read");
    const b = await run({}, { "brew outdated --formula --verbose": { rc: 0, out: " alpha (1.0) < 2.0\n" } });
    expect(b.t).toContain("alpha");
    expect(b.t).toContain("brew formulae outdated (1):");
  });
});

describe("amend 18: a separator-only stdout is never silent", () => {
  const NEL = String.fromCharCode(0x85);
  const LS = String.fromCharCode(0x2028);
  test.each([["NEL", NEL], ["NEL NEL", NEL + NEL], [" NEL ", ` ${NEL} `], ["NEL U+2028", NEL + LS], ["NEL LF", NEL + "\n"]])("mas stdout of only %s says it is not an app list (rc 1)", async (_n, out) => {
    const { t, r } = await run({}, { "mas outdated": { rc: 0, out } });
    expect(t).toContain("mas: not checked — mas outdated printed text that is not an app list");
    expect(t).not.toContain("mas: nothing outdated");
    expect(r.rc).toBe(1);
  });
  test("mas stdout of only U+2028 is whitespace to trim(), like empty stdout: nothing outdated", async () => {
    const { t, r } = await run({}, { "mas outdated": { rc: 0, out: LS } });
    expect(t).toContain("mas: nothing outdated");
    expect(r.rc).toBe(0);
  });
  test("the other reads with separator-only stdout say something: brew is outdated (0) as for empty, the rest fail closed", async () => {
    const b = await run({}, { "brew outdated --formula --verbose": { rc: 0, out: NEL + LS + "\r" } });
    expect(b.t).toContain("brew formulae outdated (0):");
    const n = await run({}, { "npm outdated -g --json": { rc: 1, out: NEL } });
    expect(n.t).toContain("npm globals: not checked");
    expect(n.r.rc).toBe(1);
    const d = await run({}, { "df -k -- /brew": { rc: 0, out: NEL } });
    expect(d.t).toContain("disk: not checked");
    expect(d.r.rc).toBe(1);
    const c = await run({}, { "curl -q -g -sS -o /dev/null -I -m 10 -w %{http_code} -- https://registry.npmjs.org/": { rc: 0, out: NEL } });
    expect(c.t).toContain("network: https://registry.npmjs.org FAILED");
    expect(c.r.rc).toBe(1);
  });
});

describe("amend 18: a mas line holding a control or invisible character is not a row", () => {
  const A = "1 AppA (1.0 -> 2.0)";
  const B = "2 AppB (3.0 -> 4.0)";
  const NA = "mas: not checked — mas outdated printed text that is not an app list";
  const SEPS = [["US", "\u001f"], ["ZWSP", "\u200b"], ["BOM", "\ufeff"], ["ESC E", "\u001bE"], ["ESC D", "\u001bD"], ["CSI 1E", "\u001b[1E"], ["U+009B 1E", "\u009b1E"], ["NUL", "\u0000"], ["DEL", "\u007f"], ["U+2060", "\u2060"]] as const;
  test.each(SEPS)("two valid rows joined by %s on one line are not an app list (rc 1)", async (_n, sep) => {
    const { t, r } = await run({}, { "mas outdated": { rc: 0, out: `${A}${sep}${B}\n` } });
    expect(t).toContain(NA);
    expect(t).not.toContain("mas: 1 AppA");
    expect(r.rc).toBe(1);
  });
  test.each(SEPS)("a row and an error line joined by %s is not an app list (rc 1)", async (_n, sep) => {
    const { t, r } = await run({}, { "mas outdated": { rc: 0, out: `${A}${sep}Error: not signed in${sep}${B}\n` } });
    expect(t).toContain(NA);
    expect(r.rc).toBe(1);
  });
  test("a fused first row over 200 characters cannot drop the second app silently", async () => {
    const { t, r } = await run({}, { "mas outdated": { rc: 0, out: `1 ${"A".repeat(250)} (1.0 -> 2.0)\u001f${B}\n` } });
    expect(t).toContain(NA);
    expect(r.rc).toBe(1);
  });
  test("two ' -> ' groups on one line are not an app list", async () => {
    const { t, r } = await run({}, { "mas outdated": { rc: 0, out: "1 AppA (1.0 -> 2.0) Error: x (3.0 -> 4.0)\n" } });
    expect(t).toContain(NA);
    expect(r.rc).toBe(1);
  });
  test("real rows with a tab gap or two-space gaps stay listed", async () => {
    const { t, r } = await run({}, { "mas outdated": { rc: 0, out: "1\tAppA (1.0 -> 2.0)\n  2  AppB (3.0 -> 4.0)  \n" } });
    expect(t).toContain("mas: 1 AppA (1.0 -> 2.0)");
    expect(t).toContain("mas: 2  AppB (3.0 -> 4.0)");
    expect(r.rc).toBe(0);
  });
});

describe("amend 19: brew rows run together by a separator outside the line ends", () => {
  const A = "alpha (1.0) < 2.0";
  const B = "beta (1.0) < 2.0";
  const F = "brew outdated --formula --verbose";
  const ALL = [
    ["U+001C", "\u001c"], ["U+001D", "\u001d"], ["U+001E", "\u001e"], ["U+001F", "\u001f"], ["NUL", "\u0000"], ["ZWSP", "​"], ["U+3000", "　"], ["NBSP", " "],
    ["U+2800", "⠀"], ["BOM", "﻿"], ["ESC E", "\u001bE"], ["CSI 1E", "\u001b[1E"], ["tag U+E0041", "\u{e0041}"], ["RLO", "‮"], ["LRM", "‎"], ["U+2066", "⁦"], ["DEL", "\u007f"], ["U+009B 1E", "\u009b1E"],
  ] as const;
  test.each(ALL)("two valid rows joined by %s (bare or with a space each side) are not both read as one row: not checked, rc 1", async (_n, sep) => {
    for (const j of [sep, ` ${sep} `]) {
      const { t, r } = await run({}, { [F]: { rc: 0, out: `${A}${j}${B}\n` } });
      expect(t).toContain("brew formulae: no row could be read from 1 line(s)");
      expect(r.rc).toBe(1);
    }
  });
  test.each(ALL.filter(([n]) => !["U+3000", "NBSP", "U+2800"].includes(n)))("a row and an error line joined by %s: not checked, rc 1", async (_n, sep) => {
    const { t, r } = await run({}, { [F]: { rc: 0, out: `${A}${sep}Error: x\n` } });
    expect(t).toContain("brew formulae: no row could be read from 1 line(s)");
    expect(r.rc).toBe(1);
  });
  test("a cask row run together with another by a separator is not read either", async () => {
    const { t, r } = await run({}, { "brew outdated --cask --greedy-auto-updates --verbose": { rc: 0, out: "a (1) != 2\u001fb (1) != 2\n" } });
    expect(t).toContain("brew casks: no row could be read from 1 line(s)");
    expect(r.rc).toBe(1);
  });
  test.each([
    ["multi-keg", "alpha (1.0, 1.1) < 2.0"],
    ["pinned at", "alpha (1.0) < 2.0 [pinned at 1.0]"],
    ["pinned", "alpha (1.0) < 2.0 [pinned]"],
    ["HEAD", "alpha (HEAD-abc) < HEAD-def"],
    ["cask !=", "alpha (1.0) != 2.0"],
    ["a tap name", "homebrew/core/alpha (1.0) < 2.0"],
    ["a version with a plus and dash", "alpha (1.0_1) < 2.0+build-3"],
  ])("a real brew shape stays listed: %s", async (_n, row) => {
    const { t, r } = await run({}, { [F]: { rc: 0, out: `${row}\nbeta (1.0) < 2.0\n` } });
    expect(t).toContain("brew formulae outdated (2):");
    expect(t).not.toContain("not checked for");
    expect(r.rc).toBe(0);
  });
  test("a hidden character inside a name, inside an installed version or after the new version: not a row, rc 1", async () => {
    for (const row of ["al\u200bpha (1.0) < 2.0", "alpha (1.\u200b0) < 2.0", "alpha (1.0) < 2.\u200b0", "alpha (1.0) < 2.0\u200bx"]) {
      const { t, r } = await run({}, { [F]: { rc: 0, out: `${row}\n` } });
      expect(t).toContain("brew formulae: no row could be read from 1 line(s)");
      expect(r.rc).toBe(1);
    }
  });
});

describe("amend 19: mas mutant rows", () => {
  const NA = "mas: not checked — mas outdated printed text that is not an app list";
  test("an unspaced -> in a mas name does not make a second group", async () => {
    const { t, r } = await run({}, { "mas outdated": { rc: 0, out: "1 A->B (1.0 -> 2.0)\n" } });
    expect(t).toContain("mas: 1 A->B (1.0 -> 2.0)");
    expect(r.rc).toBe(0);
  });
  test.each([["high", "\ud800"], ["low", "\udc00"]])("a lone %s surrogate in a mas row is not an app list", async (_n, ch) => {
    const { t, r } = await run({}, { "mas outdated": { rc: 0, out: `1 App${ch}x (1 -> 2)\n` } });
    expect(t).toContain(NA);
    expect(r.rc).toBe(1);
  });
  test("a mas row with two tabs is listed (every tab is a space)", async () => {
    const { t, r } = await run({}, { "mas outdated": { rc: 0, out: "1\tApp\tX (1 -> 2)\n" } });
    expect(t).toContain("mas: 1 App X (1 -> 2)");
    expect(r.rc).toBe(0);
  });
});

describe("amend 20: a brew list line holding a character the cleaner strips is not a row", () => {
  const A = "alpha (1.0) < 2.0";
  const B = "beta (1.0) < 2.0";
  const F = "brew outdated --formula --verbose";
  const C = "brew outdated --cask --greedy-auto-updates --verbose";
  const SEPS = [["US", "\u001f"], ["ESC E", "\u001bE"], ["CSI 1E", "\u001b[1E"], ["ZWSP", "​"], ["NBSP", " "], ["U+3000", "　"], ["NUL", "\u0000"], ["BOM", "﻿"], ["tag", "\u{e0041}"], ["RLO", "‮"], ["U+2060", "⁠"]] as const;
  const NR = (label: string) => `${label}: no row could be read from 1 line(s)`;
  const kinds = [["formula", F, "brew formulae", "<"], ["cask", C, "brew casks", "!="]] as const;
  for (const [kind, key, label, op] of kinds) {
    const a = `alpha (1.0) ${op} 2.0`;
    const b = `beta (1.0) ${op} 2.0`;
    test.each(SEPS)(`${kind}: %s as prefix fragment + row, row + fragment, row + row, row + error line: not a row, rc 1`, async (_n, sep) => {
      for (const line of [`Error: (could not read gamma)${sep}${b}`, `${a}${sep}note`, `alpha (1.0)${sep}${b}`, `${a}${sep}${b}`, `${a} ${sep} ${b}`, `${a}${sep}Error: x`]) {
        const { t, r } = await run({}, { [key]: { rc: 0, out: `${line}\n` } });
        // A line that starts with Error: takes the error branch ("printed an error and no row"); both are rc 1.
        expect(t.includes(NR(label)) || t.includes(`${label}: not checked — brew outdated`)).toBe(true);
        expect(t).not.toContain(`${label} outdated (1):`);
        expect(r.rc).toBe(1);
      }
    });
  }
  test("a row, a hidden-character line and another row: only the plain rows are listed, the middle one is counted", async () => {
    const { t, r } = await run({}, { [F]: { rc: 0, out: `${A}\nzeta (1.0)\u001f< 2.0\n${B}\n` } });
    expect(t).toContain("brew formulae: not checked for 1 line(s)");
    expect(t).toContain("brew formulae outdated (2):");
    expect(r.rc).toBe(1);
  });
  test("a space-joined pair of rows is two groups: not a row", async () => {
    const { t, r } = await run({}, { [F]: { rc: 0, out: `${A} ${B}\n` } });
    expect(t).toContain(NR("brew formulae"));
    expect(r.rc).toBe(1);
  });
  test("real shapes unchanged: only plain spaces", async () => {
    const { t, r } = await run({}, { [F]: { rc: 0, out: `${A}\nmulti (1.0, 1.1) < 2.0 [pinned at 1.0]\n` } });
    expect(t).toContain("brew formulae outdated (2):");
    expect(r.rc).toBe(0);
  });
  // The group split needs the spaces: a "<" without them is not a group, so these stay rows.
  test.each(["alpha (1.0<1.1) < 2.0"])("%s is one group and stays a row", async (row) => {
    const { t, r } = await run({}, { [F]: { rc: 0, out: `${row}\n` } });
    expect(t).toContain("brew formulae outdated (1):");
    expect(r.rc).toBe(0);
  });
  test.each(["alpha (1.0) < 2.0 <3", "alpha (1.0) < 2.0 !=3", "alpha (1.0 < 1.1) < 2.0", "alpha (1.0) < latest HEAD"])("%s is not a row (not a brew shape)", async (row) => {
    const { t, r } = await run({}, { [F]: { rc: 0, out: `${row}\n` } });
    expect(t).toContain("brew formulae: no row could be read from 1 line(s)");
    expect(r.rc).toBe(1);
  });
  test("'alpha (1.0) <2.0' and 'alpha (1.0)< 2.0' are not rows (brew prints spaces both sides)", async () => {
    for (const row of ["alpha (1.0) <2.0", "alpha (1.0)< 2.0"]) {
      const { t, r } = await run({}, { [F]: { rc: 0, out: `${row}\n` } });
      expect(t).toContain(NR("brew formulae"));
      expect(r.rc).toBe(1);
    }
  });
  test("an error word in the name part stays a row when nothing is hidden", async () => {
    const { t, r } = await run({}, { [F]: { rc: 0, out: "Error: (1.0) < 2.0\n" } });
    expect(t).toContain("brew formulae outdated (1):");
    expect(r.rc).toBe(0);
  });
});

describe("amend 21: plain-space fusion of brew rows, the anchored grammar", () => {
  const F = "brew outdated --formula --verbose";
  const C = "brew outdated --cask --greedy-auto-updates --verbose";
  test.each([
    "alpha (1.0) beta (1.0) < 2.0",
    "alpha (1.0) beta (1.0) != 2.0",
    "alpha (1.0)beta (1.0) < 2.0",
    "alpha (1.0) < 2.0 beta (1.0)",
    "alpha (1.0) < 2.0 [pinned at 1.0] beta",
    "alpha (1.0) < 2.0 [pinned at 1.0",
    "alpha (1.0) < 2.0 [pinned at ]",
  ])("%s is not a row: counted, rc 1, no package listed", async (row) => {
    for (const [key, label] of [[F, "brew formulae"], [C, "brew casks"]] as const) {
      const { t, r } = await run({}, { [key]: { rc: 0, out: `${row}\n` } });
      expect(t).toContain(`${label}: no row could be read from 1 line(s)`);
      expect(t).not.toContain(`${label} outdated (1):`);
      expect(r.rc).toBe(1);
    }
  });
  test.each([
    "alpha (1.0) < 2.0 [pinned at 1.0]",
    "alpha (1.0) < 2.0 [pinned]",
    "alpha (1.0, 1.1) < 2.0",
    "alpha (1.0) != 2.0",
    "tap/x/alpha (1.0_1) < 2.0+build-3",
  ])("%s is a row", async (row) => {
    const { t, r } = await run({}, { [F]: { rc: 0, out: `${row}\n` } });
    expect(t).toContain("brew formulae outdated (1):");
    expect(r.rc).toBe(0);
  });
  test("mas: parens in a name are one app; a trailing group or a second arrow is not a row", async () => {
    const ok = await run({}, { "mas outdated": { rc: 0, out: "1 Pro (Beta) App (1.0 -> 2.0)\n" } });
    expect(ok.t).toContain("mas: 1 Pro (Beta) App (1.0 -> 2.0)");
    expect(ok.r.rc).toBe(0);
    for (const out of ["1 A (1.0 -> 2.0) (3 -> 4)\n", "1 A (1.0 -> 2.0) (3)\n", "1 A (1.0 -> 2.0) 2 B (3.0 -> 4.0)\n"]) {
      const { t, r } = await run({}, { "mas outdated": { rc: 0, out } });
      expect(t).toContain("mas: not checked — mas outdated printed text that is not an app list");
      expect(r.rc).toBe(1);
    }
  });
  test("mas: a name holding a fused app shows the whole name, nothing is cut", async () => {
    const { t } = await run({}, { "mas outdated": { rc: 0, out: "1 A (1.0) 2 B (3.0 -> 4.0)\n" } });
    expect(t).toContain("mas: 1 A (1.0) 2 B (3.0 -> 4.0)");
  });
});

describe("amend 21: literal spaces and ASCII only, names without parens", () => {
  const F = "brew outdated --formula --verbose";
  const C = "brew outdated --cask --greedy-auto-updates --verbose";
  const notRow = async (key: string, label: string, row: string) => {
    const { t, r } = await run({}, { [key]: { rc: 0, out: `${row}\n` } });
    expect(t).toMatch(new RegExp(`${label}: (no row could be read from 1 line|not checked — brew outdated)`));
    expect(t).not.toContain(`${label} outdated (1):`);
    expect(r.rc).toBe(1);
  };
  test.each([
    ["TAB around the second <", "alpha (1.0) < 2.0\tbeta (1.0)\t<\t3.0"],
    ["TAB around the first <", "alpha (1.0)\t<\t2.0"],
    ["U+2800 joiners", "alpha (1.0) < 2.0⠀beta (1.0)⠀<⠀3.0"],
    ["U+FFFC joiners", "alpha (1.0) < 2.0￼beta (1.0)￼<￼3.0"],
    ["a combining U+0301", "alpha (1.0) < 2.0́"],
    ["U+1D159", "alpha (1.0) < 2.0\u{1d159}beta"],
    ["Error: fragment before a row", "Error: (could not read gamma) beta (1.0) < 2.0"],
    ["a paren in the name", "al(pha (1.0) < 2.0"],
    ["a closing paren in the name", "al)pha (1.0) < 2.0"],
    ["an empty installed group", "alpha () < 2.0"],
    ["a != inside the installed group", "alpha (1.0 != 1.1) != 2.0"],
    ["a < inside the installed group", "alpha (1.0 < 1.1) < 2.0"],
  ])("%s: not a row, formula and cask, rc 1", async (_n, row) => {
    await notRow(F, "brew formulae", row);
    await notRow(C, "brew casks", row.replace(/ < /g, " != "));
  });
  test("a cask row run into another by a plain space is not a row", async () => {
    await notRow(C, "brew casks", "a (1) != 2 b (1) != 3");
  });
  test("a name printed twice is listed twice, each with its own versions and the pin of its name", async () => {
    const { t } = await run({}, { [F]: { rc: 0, out: "beta (1.0) < 2.0\nbeta (5.0) < 6.0\n" } });
    expect(t).toContain("beta 1.0 → 2.0 | pin: brew pin");
    expect(t).toContain("beta 5.0 → 6.0 | pin: brew pin");
  });
  test("a mas row at 200 characters is listed, at 201 is not an app list", async () => {
    const mk = (n: number) => `1 ${"a".repeat(n - 15)} (1.0 -> 2.0)`;
    expect(mk(200).length).toBe(200);
    const a = await run({}, { "mas outdated": { rc: 0, out: `${mk(200)}\n` } });
    expect(a.t).toContain(`mas: ${mk(200)}`);
    const b = await run({}, { "mas outdated": { rc: 0, out: `${mk(201)}\n` } });
    expect(b.t).toContain("mas: not checked — mas outdated printed text that is not an app list");
    expect(b.r.rc).toBe(1);
  });
});

describe("amend 22: mas reads one text (tabs are spaces) for every check and the display", () => {
  const NA = "mas: not checked — mas outdated printed text that is not an app list";
  test.each([
    "1 A (1\t-> 2) 2 B (3 -> 4)",
    "1 A (1\t-> 2)\t2 B (3 -> 4)",
    "1 A (1\t-> 2) Error: x (3 -> 4)",
    "1 A (1\t-> 2) (3 -> 4)",
    "1 A (1 ->\t2) 2 B (3\t->\t4)",
  ])("%j is not an app list (rc 1), never two apps shown as one", async (out) => {
    const { t, r } = await run({}, { "mas outdated": { rc: 0, out: `${out}\n` } });
    expect(t).toContain(NA);
    expect(t).not.toContain("mas: 1 A");
    expect(r.rc).toBe(1);
  });
  test("a tab inside the arrow of one app is read as the spaced arrow and listed once", async () => {
    const { t, r } = await run({}, { "mas outdated": { rc: 0, out: "1 A (1\t->\t2)\n" } });
    expect(t).toContain("mas: 1 A (1 -> 2)");
    expect(r.rc).toBe(0);
  });
  test.each([["NBSP", " "], ["U+3000", "　"], ["U+2003", " "]])("a mas row holding %s is not an app list", async (_n, ch) => {
    for (const out of [`1${ch}App (1.0 -> 2.0)`, `1 App${ch}X (1.0 -> 2.0)`]) {
      const { t, r } = await run({}, { "mas outdated": { rc: 0, out: `${out}\n` } });
      expect(t).toContain(NA);
      expect(r.rc).toBe(1);
    }
  });
});

describe("amend 22: brew grammar edges", () => {
  const F = "brew outdated --formula --verbose";
  test.each(["alpha (1.0 beta (2.0) < 3.0", "alpha ((1.0) < 2.0", "alpha (1.0)) < 2.0", "alpha (1.0) < 2.0 [pinned at 1.0] beta [pinned]", "alpha (1.0) < 2.0 [pinned at 1.0] [pinned]"])("%s is not a row (rc 1)", async (row) => {
    const { t, r } = await run({}, { [F]: { rc: 0, out: `${row}\n` } });
    expect(t).toContain("brew formulae: no row could be read from 1 line(s)");
    expect(r.rc).toBe(1);
  });
  test.each(["alpha (1.0) < 2.0~rc1", "alpha (1.0~rc1) < 2.0", "alpha (1.0) < 2.0 [pinned at 1.0~1]", "al~pha (1.0) < 2.0"])("%s is a row (~ is ASCII)", async (row) => {
    const { t, r } = await run({}, { [F]: { rc: 0, out: `${row}\n` } });
    expect(t).toContain("brew formulae outdated (1):");
    expect(r.rc).toBe(0);
  });
  test("DEL is not ASCII text: not a row", async () => {
    const { t } = await run({}, { [F]: { rc: 0, out: "alpha (1.0) < 2.0\u007f\n" } });
    expect(t).toContain("brew formulae: no row could be read from 1 line(s)");
  });
});

describe("amend 23: the error check and the heading filter read the same text; npm versions are judged as shown", () => {
  const F = "brew outdated --formula --verbose";
  const SP = [["U+3000", "　"], ["U+2003", " "], ["U+202F", " "], ["U+1680", " "], ["U+2000", " "], ["U+205F", " "]] as const;
  test.each(SP)("%s: a brew error line is an error, not a heading and not nothing outdated", async (_n, sp) => {
    for (const out of [`${sp}==> Error: tap broken\n`, `==>${sp}Error: tap broken\n`, `${sp}==>${sp}Error: tap broken\n`]) {
      const { t, r } = await run({}, { [F]: { rc: 0, out } });
      expect(t).toContain("brew formulae: not checked — brew");
      expect(t).not.toContain("brew formulae outdated (0)");
      expect(r.rc).toBe(1);
    }
  });
  test.each(SP)("%s before Error: on brew stderr is an error (rc 1)", async (_n, sp) => {
    const { t, r } = await run({}, { [F]: { rc: 0, out: "", err: `${sp}Error: tap broken` } });
    expect(t).toContain("brew formulae: not checked — brew");
    expect(r.rc).toBe(1);
  });
  test.each(SP)("%s after npm in an npm ERR! line on stderr, stdout {}, is a failure (rc 1)", async (_n, sp) => {
    const { t, r } = await run({}, { "npm outdated -g --json": { rc: 0, out: "{}", err: `npm${sp}ERR! code EACCES` } });
    expect(t).toContain("npm globals: not checked");
    expect(r.rc).toBe(1);
  });
  test("a real heading with a Unicode space is still a quiet heading", async () => {
    const { t, r } = await run({}, { [F]: { rc: 0, out: "　==> Outdated Formulae\nalpha (1.0) < 2.0\n" } });
    expect(t).toContain("brew formulae outdated (1):");
    expect(r.rc).toBe(0);
  });
  test.each([
    ["ZWSP", "​"],
    ["ANSI only", "\u001b[31m\u001b[0m"],
    ["a bare ESC ] open OSC", "\u001b]"],
    ["blanks", " \t "],
  ])("an npm version of only %s is a failure, for current and for latest", async (_n, v) => {
    for (const entry of [{ current: v, latest: "2.0.0" }, { current: "1.0.0", latest: v }]) {
      const { t, r } = await run({}, { "npm outdated -g --json": { rc: 1, out: JSON.stringify({ pkg: entry }) } });
      expect(t).toContain("npm globals: not checked");
      expect(r.rc).toBe(1);
    }
  });
  test("an npm version that keeps text after cleaning is listed", async () => {
    const { t, r } = await run({}, { "npm outdated -g --json": { rc: 1, out: JSON.stringify({ pkg: { current: "1.​0.0", latest: "2.0.0" } }) } });
    expect(t).toContain("pkg 1.0.0 → 2.0.0");
    expect(r.rc).toBe(0);
  });
});

describe("amend 24: runs of spaces, blank-looking characters, error words in a heading, blank npm names", () => {
  const F = "brew outdated --formula --verbose";
  const NPM = "npm outdated -g --json";
  test.each([
    ["two spaces", "npm  ERR! code EACCES"],
    ["space and tab", "npm \tERR! code EACCES"],
    ["two U+3000", "npm　　ERR! code EACCES"],
    ["npm error, two spaces", "npm  error code X"],
    ["U+3164 between", "npmㅤERR! code EACCES"],
    ["U+2800 between", "npm⠀ERR! code EACCES"],
    ["U+115F and U+1160", "npmᅟᅠerror code X"],
    ["U+FFA0", "npmﾠERR! code X"],
  ])("npm stderr %s with stdout {} is a failure (rc 1)", async (_n, err) => {
    const { t, r } = await run({}, { [NPM]: { rc: 0, out: "{}", err } });
    expect(t).toContain("npm globals: not checked");
    expect(t).not.toContain("npm globals outdated (0)");
    expect(r.rc).toBe(1);
  });
  test.each([
    ["two spaces", "npm  ERR! code E"],
    ["tab", "npm\tERR! code E"],
    ["U+3164", "npmㅤerror code E"],
  ])("brew stderr %s npm-style error is read as an error too (rc 1)", async (_n, err) => {
    const { t, r } = await run({}, { [F]: { rc: 0, out: "", err: `${err}` } });
    expect(t).toContain("brew formulae: not checked");
    expect(r.rc).toBe(1);
  });
  test("the error check reads an ESC before a Unicode space as one escape-free line", async () => {
    expect(hasError("\u001b　Error: x")).toBe(true);
    expect(hasError("ㅤError: x")).toBe(true);
  });
  test.each([
    ["a second >", "==>> Error: x"],
    ["ESC before Error", "==> \u001bError: x"],
    ["a fullwidth colon", "==> Error： x"],
    ["lowercase error word", "==> error reading tap"],
    ["an invisible character inside the word", "==> Er\u200bror: x"],
    ["ERROR in the middle", "==> Tap ERROR happened"],
  ])("a '==>' line with %s is not a quiet heading: counted, rc 1", async (_n, line) => {
    const { t, r } = await run({}, { [F]: { rc: 0, out: `${line}\n` } });
    expect(t).not.toContain("brew formulae outdated (0)");
    expect(t).toMatch(/brew formulae: (no row could be read from 1 line|not checked)/);
    expect(r.rc).toBe(1);
  });
  test("with a row listed, a '==>' line whose error word shows only after cleaning is counted (rc 1), not dropped", async () => {
    const { t, r } = await run({}, { [F]: { rc: 0, out: "alpha (1.0) < 2.0\n==> Er\u200bror: x\n" } });
    expect(t).toContain("brew formulae outdated (1):");
    expect(t).toContain("brew formulae: not checked for 1 line(s)");
    expect(r.rc).toBe(1);
  });
  test("with a row listed, a '==>' line with a raw error word is counted too", async () => {
    const { t, r } = await run({}, { [F]: { rc: 0, out: "alpha (1.0) < 2.0\n==>> Error\uff1a x\n" } });
    expect(t).toContain("brew formulae: not checked for 1 line(s)");
    expect(r.rc).toBe(1);
  });
  test("real headings stay quiet", async () => {
    const { t, r } = await run({}, { [F]: { rc: 0, out: "==> Outdated Formulae\n==> Auto-updated Homebrew!\n==> Updated Casks\nalpha (1.0) < 2.0\n" } });
    expect(t).toContain("brew formulae outdated (1):");
    expect(r.rc).toBe(0);
  });
  test.each([
    ["U+2800", "⠀"], ["U+3164", "ㅤ"], ["U+115F", "ᅟ"], ["U+1160", "ᅠ"], ["U+FFA0", "ﾠ"], ["a space", " "], ["U+2800 and spaces", " ⠀ "],
  ])("an npm version of only %s is a failure (current and latest)", async (_n, v) => {
    for (const entry of [{ current: v, latest: "2.0.0" }, { current: "1.0.0", latest: v }]) {
      const { t, r } = await run({}, { [NPM]: { rc: 1, out: JSON.stringify({ pkg: entry }) } });
      expect(t).toContain("npm globals: not checked");
      expect(r.rc).toBe(1);
    }
  });
  test.each([["U+2800", "⠀"], ["U+3164", "ㅤ"]])("an npm name of only %s shows as <empty name>", async (_n, name) => {
    const { t } = await run({}, { [NPM]: { rc: 1, out: JSON.stringify({ [name]: { current: "1.0.0", latest: "2.0.0" } }) } });
    expect(t).toContain("<empty name>");
  });
  test("a visible npm name is shown as is", async () => {
    const { t } = await run({}, { [NPM]: { rc: 1, out: JSON.stringify({ "left-pad": { current: "1.0.0", latest: "2.0.0" } }) } });
    expect(t).toContain("left-pad 1.0.0 → 2.0.0");
    expect(t).not.toContain("<empty name>");
  });
});

describe("amend 25/29: U+2800 is a gap; the default-ignorable hangul fillers are removed, as clean() removes them", () => {
  test("npm<U+2800>warn x next to {} is quiet (a gap, so it reads 'npm warn x')", async () => {
    const { t, r } = await run({}, { "npm outdated -g --json": { rc: 0, out: "{}", err: "npm\u2800warn x" } });
    expect(t).toContain("npm globals outdated (0):");
    expect(r.rc).toBe(0);
  });
  test.each([["U+115F", "\u115f"], ["U+1160", "\u1160"], ["U+FFA0", "\uffa0"], ["U+3164", "\u3164"]])("npm%swarn x is removed to 'npmwarn x': not benign (rc 1)", async (_n, ch) => {
    const { t, r } = await run({}, { "npm outdated -g --json": { rc: 0, out: "{}", err: `npm${ch}warn x` } });
    expect(t).toContain("npm globals: not checked");
    expect(r.rc).toBe(1);
  });
});

describe("amend 25: the benign forms are anchored and bounded", () => {
  test.each([["npm warning x"], ["npm noticed x"], ["x npm warn y"], ["xnpm warn y"], ["npm​warn x\nnpm warning y"]])("npm stderr %j next to {} is not benign (rc 1)", async (err) => {
    const { t, r } = await run({}, { "npm outdated -g --json": { rc: 0, out: "{}", err } });
    expect(t).toContain("npm globals: not checked");
    expect(r.rc).toBe(1);
  });
  test.each([["x Warning: y"], ["Warning x"], ["warning: x"]])("brew stderr %j next to an empty list is not benign (rc 1)", async (err) => {
    const { t, r } = await run({}, { "brew outdated --formula --verbose": { rc: 0, out: "", err } });
    expect(t).toContain("brew formulae: not checked — brew");
    expect(r.rc).toBe(1);
  });
  test("a '==>' line whose error word is fullwidth after an escape is kept (the raw text is normalized too)", async () => {
    const { t, r } = await run({}, { "brew outdated --formula --verbose": { rc: 0, out: "alpha (1.0) < 2.0\n==> \u001bEｒｒｏｒ x\n" } });
    expect(t).toContain("brew formulae: not checked for 1 line(s)");
    expect(r.rc).toBe(1);
  });
});

describe("amend 26: real quiet stderr stays quiet; headings are an allowlist", () => {
  const F = "brew outdated --formula --verbose";
  const NPM = "npm outdated -g --json";
  const DEPRECATION = [
    "Warning: Calling `bottle :unneeded` is deprecated! There is no replacement.",
    "Please report this issue to the foo/bar tap (not Homebrew/brew or Homebrew/core):",
    "  /opt/homebrew/Library/Taps/foo/homebrew-bar/Formula/x.rb:3",
    "",
  ].join("\n");
  const NODE = "(node:1234) [DEP0040] DeprecationWarning: The `punycode` module is deprecated. Please use a userland alternative instead.\n(Use `node --trace-deprecation ...` to show where the warning was created)\n";
  test.each([
    ["a multi-line tap deprecation block", DEPRECATION],
    ["Already up-to-date.", "Already up-to-date.\n"],
    ["Updating Homebrew...", "Updating Homebrew...\n"],
    ["a Ruby warning", "/opt/homebrew/Library/Homebrew/x.rb:3: warning: already initialized constant Y\n"],
    ["Node's deprecation warning", NODE],
    ["a warning, a blank line and another warning", "Warning: a\n\nWarning: b\n  /p/x.rb:1\n"],
  ])("brew stderr %s next to an empty list is quiet (outdated 0, rc 0)", async (_n, err) => {
    const { t, r } = await run({}, { [F]: { rc: 0, out: "", err } });
    expect(t).toContain("brew formulae outdated (0):");
    expect(r.rc).toBe(0);
  });
  test.each([
    ["npm info", "npm info using npm@10.2.0\nnpm info using node@v20.0.0\n"],
    ["npm http", "npm http fetch GET 200 https://registry.npmjs.org/x 12ms (cache hit)\n"],
    ["npm verb, sill, timing", "npm verb cli /usr/bin/node\nnpm sill logfile x\nnpm timing command:outdated Completed in 55ms\n"],
    ["an npm 12 notice block (every line prefixed)", "npm notice\nnpm notice New minor version of npm available! 10.1.0 -> 10.2.0\nnpm notice Run `npm install -g npm@10.2.0` to update!\n"],
    ["npm verbose and silly (npm 12 level names)", "npm verbose cli /usr/bin/node\nnpm silly logfile x\n"],
    ["Node's deprecation warning", NODE],
  ])("npm stderr %s next to {} is quiet (outdated 0, rc 0)", async (_n, err) => {
    const { t, r } = await run({}, { [NPM]: { rc: 0, out: "{}", err } });
    expect(t).toContain("npm globals outdated (0):");
    expect(r.rc).toBe(0);
  });
  test.each([
    ["a Please report line with no Warning before it", "Please report this issue to the foo tap"],
    ["an indented line with no Warning before it", "  /opt/x.rb:3"],
    ["an indented line after a blank line", "Warning: a\n\n  /opt/x.rb:3"],
    ["an indented continuation that holds error", "Warning: a\n  Error: tap broken"],
    ["a flush unknown line after a block", "Warning: a\n  /p/x.rb:1\nfatal: y"],
    ["a Ruby line that is not a warning", "/p/x.rb:3: syntax error"],
    ["an almost Node line", "(node) x"],
    ["Already up-to-date. glued to text", "xAlready up-to-date."],
    ["npmwarn", "npmwarn x"],
    ["npmnotice", "npmnotice x"],
    ["an npm indented line with no notice before it", "  indented"],
    ["an npm line that is an info word glued", "npm information x"],
  ])("stderr %s is not benign: not checked, rc 1 (brew and npm)", async (_n, err) => {
    const b = await run({}, { [F]: { rc: 0, out: "", err } });
    expect(b.t).toContain("brew formulae: not checked — brew");
    expect(b.r.rc).toBe(1);
    const n = await run({}, { [NPM]: { rc: 0, out: "{}", err } });
    expect(n.t).toContain("npm globals: not checked");
    expect(n.r.rc).toBe(1);
  });
  test.each([["CR", "\r"], ["VT", "\u000b"], ["FF", "\u000c"], ["NEL", "\u0085"], ["U+2028", " "], ["U+2029", " "], ["LF", "\n"]])("a benign line and an unknown one joined by %s: not checked", async (_n, sep) => {
    const b = await run({}, { [F]: { rc: 0, out: "", err: `Warning: x${sep}fatal: y` } });
    expect(b.t).toContain("brew formulae: not checked — brew");
    expect(b.r.rc).toBe(1);
    const n = await run({}, { [NPM]: { rc: 0, out: "{}", err: `npm warn x${sep}fatal: y` } });
    expect(n.t).toContain("npm globals: not checked");
    expect(n.r.rc).toBe(1);
  });
  test.each([["Cyrillic E", "==> Еrror x"], ["a combining mark", "==> E̶rror x"], ["Failed to load", "==> Failed to load x"], ["an unknown heading", "==> Other"], ["a heading with a tail", "==> Outdated Formulae x"]])("brew stdout %s is not a known heading: counted, rc 1", async (_n, line) => {
    const { t, r } = await run({}, { [F]: { rc: 0, out: `${line}\n` } });
    expect(t).not.toContain("brew formulae outdated (0)");
    expect(t).toContain("brew formulae: no row could be read from 1 line(s)");
    expect(r.rc).toBe(1);
  });
  test.each([
    "==> Auto-updated Homebrew!", "==> Auto-updating Homebrew...", "==> Updating Homebrew...", "==> Updated Formulae", "==> Updated Casks", "==> New Formulae", "==> New Casks",
    "==> Deleted Formulae", "==> Deleted Casks", "==> Renamed Formulae", "==> Outdated Formulae", "==> Outdated Casks", "==> Formulae", "==> Casks", "==> Auto-updated",
    "\u001b[34m==>\u001b[0m \u001b[1mOutdated Formulae\u001b[0m", "  ==>  Casks  ",
  ])("the heading %j is quiet, and the row after it is listed (rc 0)", async (h) => {
    const { t, r } = await run({}, { [F]: { rc: 0, out: `${h}\nalpha (1.0) < 2.0\n` } });
    expect(t).toContain("brew formulae outdated (1):");
    expect(t).not.toContain("brew formulae: not checked");
    expect(r.rc).toBe(0);
  });
  test("a heading alone is an empty list: outdated (0), rc 0", async () => {
    const { t, r } = await run({}, { [F]: { rc: 0, out: "==> Outdated Formulae\n" } });
    expect(t).toContain("brew formulae outdated (0):");
    expect(r.rc).toBe(0);
  });
});

describe("amend 26: a benign line that does not start a block does not open one", () => {
  const F = "brew outdated --formula --verbose";
  const NPM = "npm outdated -g --json";
  test.each([["Already up-to-date.\n  indented"], ["Updating Homebrew...\n  indented"], ["/p/x.rb:3: warning: x\n  indented"], ["(node:1234) x\n  indented"], ["Warning: a\nPlease report this issue to x\n\nPlease report this issue to y"]])("brew stderr %j: the indented or Please report line after it is not benign", async (err) => {
    const { t, r } = await run({}, { [F]: { rc: 0, out: "", err } });
    expect(t).toContain("brew formulae: not checked — brew");
    expect(r.rc).toBe(1);
  });
  test.each([["npm warn x\n  indented"], ["npm info x\n  indented"], ["npm http x\n  indented"], ["npm timing x\n  indented"], ["(node:1234) x\n  indented"]])("npm stderr %j: the indented line after a non-notice line is not benign", async (err) => {
    const { t, r } = await run({}, { [NPM]: { rc: 0, out: "{}", err } });
    expect(t).toContain("npm globals: not checked");
    expect(r.rc).toBe(1);
  });
  test("a notice block ends at a blank line", async () => {
    const { t, r } = await run({}, { [NPM]: { rc: 0, out: "{}", err: "npm notice a\n\n  indented" } });
    expect(t).toContain("npm globals: not checked");
    expect(r.rc).toBe(1);
  });
  test.each([["(node:abc) x"], ["(node:) x"], ["(nodes:1) x"]])("npm and brew stderr %j is not a Node line", async (err) => {
    const n = await run({}, { [NPM]: { rc: 0, out: "{}", err } });
    expect(n.t).toContain("npm globals: not checked");
    const b = await run({}, { [F]: { rc: 0, out: "", err } });
    expect(b.t).toContain("brew formulae: not checked — brew");
  });
  test("a fullwidth error word in a continuation line is not benign", async () => {
    const { t } = await run({}, { [F]: { rc: 0, out: "", err: "Warning: a\n  Ｅｒｒｏｒ x" } });
    expect(t).toContain("brew formulae: not checked — brew");
  });
  test("a heading from the allowlist inside stderr is not benign (stderr has its own forms)", async () => {
    const { t } = await run({}, { [F]: { rc: 0, out: "", err: "==> Auto-updated Homebrew!" } });
    expect(t).toContain("brew formulae: not checked — brew");
  });
});

describe("amend 27: benign forms are anchored to their real shape and a failure word voids them", () => {
  const F = "brew outdated --formula --verbose";
  const NPM = "npm outdated -g --json";
  test.each([
    ["npm http 500 with failed...error", "npm http fetch GET 500 https://registry.example/x attempt 3 failed with error"],
    ["npm info run error EACCES", "npm info run x@1 install: error EACCES"],
    ["npm timing with error", "npm timing command:outdated Completed with error"],
    ["Node UnhandledPromiseRejectionWarning", "(node:1234) UnhandledPromiseRejectionWarning: Error: EACCES"],
    ["Node bare Error", "(node:99) Error: boom"],
    ["Node DEP line with error", "(node:1) [DEP0040] DeprecationWarning: the error handler is deprecated"],
    ["npm http 404", "npm http fetch GET 404 https://registry.example/x 12ms"],
    ["npm http POST 200", "npm http fetch POST 200 https://registry.example/x 12ms"],
    ["npm http no status", "npm http fetch GET https://registry.example/x"],
    ["Use node line with a tail", "(Use `node --trace-deprecation ...` to show where the warning was created) error"],
    ["Use node line, another text", "(Use `node --x` to do something)"],
    ["npm warn with fail", "npm warn exec The following package failed to install"],
    ["npm notice denied", "npm notice permission denied"],
    ["npm info ECONNRESET", "npm info retry fetch attempt 2 failed with ECONNRESET"],
    ["npm verb ENOTFOUND", "npm verb stack getaddrinfo ENOTFOUND registry.npmjs.org"],
    ["npm sill refused", "npm sill connection refused"],
    ["npm warn ETIMEDOUT", "npm warn ETIMEDOUT"],
    ["npm warn fatal", "npm warn fatal x"],
    ["a fullwidth error word", "npm warn Ｅｒｒｏｒ x"],
  ])("npm stderr %s next to {} is not benign (rc 1)", async (_n, err) => {
    const { t, r } = await run({}, { [NPM]: { rc: 0, out: "{}", err } });
    expect(t).toContain("npm globals: not checked");
    expect(t).not.toContain("npm globals outdated (0)");
    expect(r.rc).toBe(1);
  });
  test.each([
    ["Updating Homebrew failed", "Updating Homebrew failed: Error: fetch failed"],
    ["Updating Homebrew with a tail", "Updating Homebrew... done"],
    ["Already up-to-date with an Error", "Already up-to-date. Error: tap broken"],
    ["Already up-to-date with a tail", "Already up-to-date. x"],
    ["Warning with an indented fatal", "Warning: something\n  fatal: unable to access tap"],
    ["Warning with a failure word", "Warning: unable to fetch: connection refused"],
    ["Warning: permission denied", "Warning: permission denied"],
    ["Warning: ENOTFOUND", "Warning: ENOTFOUND github.com"],
    ["a Ruby warning with failed", "/p/x.rb:3: warning: failed to load"],
    ["Please report line with error", "Warning: a\nPlease report this issue: error"],
    ["Node Unhandled", "(node:1234) UnhandledPromiseRejectionWarning: x"],
  ])("brew stderr %s next to an empty list is not benign (rc 1)", async (_n, err) => {
    const { t, r } = await run({}, { [F]: { rc: 0, out: "", err } });
    expect(t).toContain("brew formulae: not checked — brew");
    expect(t).not.toContain("brew formulae outdated (0)");
    expect(r.rc).toBe(1);
  });
  test.each([
    ["npm http 200", "npm http fetch GET 200 https://registry.npmjs.org/x 12ms (cache hit)"],
    ["npm http 304", "npm http fetch GET 304 https://registry.npmjs.org/x 3ms (cache revalidated)"],
    ["npm http 301", "npm http fetch GET 301 https://registry.npmjs.org/x 3ms"],
    ["Node Experimental", "(node:7) ExperimentalWarning: VM Modules is an experimental feature"],
    ["Node Punycode with DEP", "(node:1234) [DEP0040] DeprecationWarning: The `punycode` module is deprecated. Please use a userland alternative instead."],
    ["Use node with trace-warnings", "(Use `node --trace-warnings ...` to show where the warning was created)"],
    ["npm timing success", "npm timing command:outdated Completed in 55ms"],
  ])("%s is still quiet next to {} (outdated 0, rc 0)", async (_n, err) => {
    const { t, r } = await run({}, { [NPM]: { rc: 0, out: "{}", err } });
    expect(t).toContain("npm globals outdated (0):");
    expect(r.rc).toBe(0);
  });
});

describe("amend 27: each failure word and each anchor alone", () => {
  const NPM = "npm outdated -g --json";
  test.each([
    ["EACCES alone", "npm warn EACCES x"],
    ["ECONNRESET alone", "npm warn ECONNRESET x"],
    ["lowercase eacces", "npm info eacces x"],
    ["a status of four digits", "npm http fetch GET 2000 https://registry.example/x"],
    ["http request instead of fetch", "npm http request GET 200 https://registry.example/x"],
    ["a Use node line with a plain tail", "(Use `node --trace-deprecation ...` to show where the warning was created) later"],
    ["a Use node line without the dots", "(Use `node --trace-deprecation` to show where the warning was created)"],
  ])("npm stderr %s next to {} is not benign (rc 1)", async (_n, err) => {
    const { t, r } = await run({}, { [NPM]: { rc: 0, out: "{}", err } });
    expect(t).toContain("npm globals: not checked");
    expect(r.rc).toBe(1);
  });
});

describe("amend 28: continuation words, indentation read after cleaning, anchors, npm level names", () => {
  const F = "brew outdated --formula --verbose";
  const NPM = "npm outdated -g --json";
  test.each([
    ["an indented fatal", "Warning: a\n  fatal: unable to access tap"],
    ["an indented Failed to load", "Warning: a\n  Failed to load x"],
    ["an indented permission denied", "Warning: a\n  permission denied"],
    ["an indented ECONNRESET", "Warning: a\n  ECONNRESET"],
    ["a tab-indented fatal", "Warning: a\n\tfatal: x"],
  ])("brew stderr %s under a Warning: line is not benign (rc 1)", async (_n, err) => {
    const { t, r } = await run({}, { [F]: { rc: 0, out: "", err } });
    expect(t).toContain("brew formulae: not checked — brew");
    expect(r.rc).toBe(1);
  });
  test.each([["a tab-indented line", "Warning: a\n\t/p/x.rb:1"], ["an NBSP-indented line", "Warning: a\n  /p/x.rb:1"], ["an ANSI then spaces", "Warning: a\n\u001b[0m  /p/x.rb:1"], ["a U+3000-indented line", "Warning: a\n　/p/x.rb:1"]])("brew stderr %s under a Warning: line is a continuation (quiet)", async (_n, err) => {
    const { t, r } = await run({}, { [F]: { rc: 0, out: "", err } });
    expect(t).toContain("brew formulae outdated (0):");
    expect(r.rc).toBe(0);
  });
  test.each([["npm notice then an indented fatal", "npm notice a\n  fatal: y"], ["npm notice then an indented plain line (npm 12 prefixes every line)", "npm notice a\n  indented"]])("npm stderr %s is not benign", async (_n, err) => {
    const { t, r } = await run({}, { [NPM]: { rc: 0, out: "{}", err } });
    expect(t).toContain("npm globals: not checked");
    expect(r.rc).toBe(1);
  });
  test.each([
    ["a Ruby path without the dot", "/p/xyrb:3: warning: x"],
    ["a Ruby line with text before the path", "boom /p/y.rb:3: warning: z"],
    ["a Ruby path with a space", "/srv/my mac/x.rb:3: warning: z"],
    ["text before Updating Homebrew...", "x Updating Homebrew..."],
    ["text before Already up-to-date.", "x Already up-to-date."],
    ["text before a Node warning", "x (node:1) DeprecationWarning: y"],
    ["text before a Use node line", "x (Use `node --a ...` to show where the warning was created)"],
  ])("brew stderr %s is not benign (rc 1)", async (_n, err) => {
    const { t, r } = await run({}, { [F]: { rc: 0, out: "", err } });
    expect(t).toContain("brew formulae: not checked — brew");
    expect(r.rc).toBe(1);
    const n = await run({}, { [NPM]: { rc: 0, out: "{}", err } });
    expect(n.t).toContain("npm globals: not checked");
  });
  test.each([["a Ruby warning", "/opt/homebrew/Library/Homebrew/x.rb:3: warning: already initialized constant Y"], ["a Ruby warning in a gem path", "/opt/homebrew/Library/Homebrew/vendor/gems/x-1.0/lib/y.rb:12: warning: method redefined"]])("brew stderr %s stays quiet", async (_n, err) => {
    const { t, r } = await run({}, { [F]: { rc: 0, out: "", err } });
    expect(t).toContain("brew formulae outdated (0):");
    expect(r.rc).toBe(0);
  });
  test.each([["ESC[2K", "\u001b[2K"], ["ESC[1A", "\u001b[1A"], ["ESC[2J", "\u001b[2J"]])("%s before a known heading is not colour: the line is not a heading, counted (rc 1)", async (_n, esc) => {
    const { t, r } = await run({}, { [F]: { rc: 0, out: `${esc}==> Formulae\nalpha (1.0) < 2.0\n` } });
    expect(t).toContain("brew formulae outdated (1):");
    expect(t).toContain("brew formulae: not checked for 1 line(s)");
    expect(r.rc).toBe(1);
  });
  test.each([["npm verb x"], ["npm sill x"], ["npm verbose x"], ["npm silly x"]])("%s is quiet next to {}", async (err) => {
    const { t, r } = await run({}, { [NPM]: { rc: 0, out: "{}", err } });
    expect(t).toContain("npm globals outdated (0):");
    expect(r.rc).toBe(0);
  });
  test.each([["npm verbosely x"], ["npm sillyx"]])("%s is not a level word: not benign", async (err) => {
    const { t, r } = await run({}, { [NPM]: { rc: 0, out: "{}", err } });
    expect(t).toContain("npm globals: not checked");
    expect(r.rc).toBe(1);
  });
});

describe("amend 28: a Ruby warning needs a line number", () => {
  test("a Ruby warning line with a non-numeric line is not benign", async () => {
    const { t, r } = await run({}, { "brew outdated --formula --verbose": { rc: 0, out: "", err: "/p/x.rb:abc: warning: y" } });
    expect(t).toContain("brew formulae: not checked — brew");
    expect(r.rc).toBe(1);
  });
});

describe("amend 29: invisible characters are removed before whitespace is mapped (BOM and ZWSP behave the same)", () => {
  const F = "brew outdated --formula --verbose";
  const NPM = "npm outdated -g --json";
  const INV = [["U+FEFF", "﻿"], ["U+200B", "​"]] as const;
  test.each(INV)("%s: a continuation, a split failure word, a glued benign form are not benign (rc 1)", async (_n, x) => {
    for (const err of [
      `Warning: x\n${x}Tap broken`,
      `Warning: permission de${x}nied`,
      `Already${x}up-to-date.`,
      `Updating${x}Homebrew...`,
    ]) {
      const { t, r } = await run({}, { [F]: { rc: 0, out: "", err } });
      expect(t).toContain("brew formulae: not checked — brew");
      expect(r.rc).toBe(1);
    }
    for (const err of [`npm warn E${x}ACCES`, `npm${x}warn x`, `npm warn fa${x}ilure`, `npm notice a\n${x}b`]) {
      const { t, r } = await run({}, { [NPM]: { rc: 0, out: "{}", err } });
      expect(t).toContain("npm globals: not checked");
      expect(r.rc).toBe(1);
    }
  });
  test.each(INV)("hasError sees Er%sror: x as an error line, and an Error: line after %s", (_n, x) => {
    expect(hasError(`Er${x}ror: x`)).toBe(true);
    expect(hasError(`${x}Error: x`)).toBe(true);
    expect(hasError(`npm${x} ERR! x`)).toBe(true);
  });
  test.each(INV)("%s inside a quiet benign line leaves it quiet (the character is invisible, the text is still benign)", async (_n, x) => {
    const { t, r } = await run({}, { [F]: { rc: 0, out: "", err: `Warning:${x} something is old` } });
    expect(t).toContain("brew formulae outdated (0):");
    expect(r.rc).toBe(0);
  });
});

describe("amend 29: mas rows holding U+2800 are not rows", () => {
  const NA = "mas: not checked — mas outdated printed text that is not an app list";
  test.each([
    "1 AppA (1.0⠀->⠀2.0) 2 AppB (3.0 -> 4.0)",
    "1 AppA (1.0⠀->⠀2.0)⠀Error: x (3.0 -> 4.0)",
    "1 ⠀ (⠀ -> ⠀)",
    "1 App⠀X (1.0 -> 2.0)",
  ])("%j is not an app list (rc 1)", async (out) => {
    const { t, r } = await run({}, { "mas outdated": { rc: 0, out: `${out}\n` } });
    expect(t).toContain(NA);
    expect(r.rc).toBe(1);
  });
});

describe("amend 29: the brew row's installed group and pinned tail", () => {
  const F = "brew outdated --formula --verbose";
  test.each([["a blank installed group", "alpha ( ) < 2.0"], ["a space-led installed group", "alpha ( 1.0) < 2.0"], ["an empty pinned at", "alpha (1.0) < 2.0 [pinned at ]"], ["a pinned at with text", "alpha (1.0) < 2.0 [pinned at 1.0 Error: tap broken]"], ["a pinned at with two words", "alpha (1.0) < 2.0 [pinned at 1.0 2.0]"], ["a doubled bracket", "alpha (1.0) < 2.0 [pinned at 1.0]]"]])("%s is not a row (rc 1)", async (_n, row) => {
    const { t, r } = await run({}, { [F]: { rc: 0, out: `${row}\n` } });
    expect(t).toContain("brew formulae: no row could be read from 1 line(s)");
    expect(r.rc).toBe(1);
  });
  test.each([["alpha (1.0) < 2.0 [pinned at 1.0]"], ["alpha (1.0) < 2.0 [pinned]"], ["alpha (1.0 ) < 2.0"], ["alpha (1.0, 1.1) < 2.0 [pinned at 1.1_1]"]])("%s is a row", async (row) => {
    const { t, r } = await run({}, { [F]: { rc: 0, out: `${row}\n` } });
    expect(t).toContain("brew formulae outdated (1):");
    expect(r.rc).toBe(0);
  });
});

describe("amend 29: the pinned list is read like the outdated list", () => {
  const P = "brew list --pinned";
  const NOTE = "WARNING: brew list --pinned printed an error or text that is not a pin list";
  test.each([
    ["Error on stderr", { rc: 0, out: "", err: "Error: tap broken" }],
    ["unknown text on stderr", { rc: 0, out: "beta\n", err: "boom" }],
    ["a fatal on stderr", { rc: 0, out: "beta\n", err: "fatal: x" }],
    ["==> Error: on stdout", { rc: 0, out: "==> Error: tap broken\n" }],
    ["Error: on stdout", { rc: 0, out: "Error: x\n" }],
    ["a stripped Er<BOM>ror on stdout", { rc: 0, out: "Er﻿ror: x\n" }],
  ])("%s: the brew pins are not checked (a note, rc 1)", async (_n, a) => {
    const { t, r } = await run({}, { [P]: a });
    expect(t).toContain(NOTE);
    expect(r.rc).toBe(1);
  });
  test.each([["a Warning: line", "Warning: something is old"], ["Already up-to-date.", "Already up-to-date."], ["empty stderr", ""]])("%s next to the pin list is quiet", async (_n, err) => {
    const { t, r } = await run({}, { [P]: { rc: 0, out: "beta\n", err } });
    expect(t).not.toContain(NOTE);
    expect(t).toContain("beta 1.0 → 2.0 | pin: brew pin");
    expect(r.rc).toBe(0);
  });
  test("a failed pin read keeps its own note and not the new one", async () => {
    const { t, r } = await run({}, { [P]: { rc: 1, out: "", err: "Error: x" } });
    expect(t).toContain("brew list --pinned failed (rc 1)");
    expect(t).not.toContain(NOTE);
    expect(r.rc).toBe(1);
  });
});

describe("amend 30: an npm error line with an invisible character between the words is still an error", () => {
  const NPM = "npm outdated -g --json";
  const G = [["U+3164", "\u3164"], ["U+115F", "\u115f"], ["U+1160", "\u1160"], ["U+FFA0", "\uffa0"], ["U+FEFF", "\ufeff"], ["U+200B", "\u200b"]] as const;
  test.each(G)("hasError sees npm%sERR! x and npm%serror x", (_n, g) => {
    expect(hasError(`npm${g}ERR! x`)).toBe(true);
    expect(hasError(`npm${g}error x`)).toBe(true);
    expect(hasError(` npm${g}err! code E`)).toBe(true);
  });
  test.each(G)("npm%sERR! on stderr with {} is a failure (rc 1)", async (_n, g) => {
    for (const err of [`npm${g}ERR! x`, `npm${g}error x`]) {
      const { t, r } = await run({}, { [NPM]: { rc: 0, out: "{}", err } });
      expect(t).toContain("npm globals: not checked");
      expect(r.rc).toBe(1);
    }
  });
  test.each([["npm errors: 0"], ["npm erroneous"], ["npm error-x@1.0.0"], ["npm err x"], ["npmerrors x"]])("hasError does not see %j", (text) => {
    expect(hasError(text)).toBe(false);
  });
  test.each(G)("the benign form does not glue: npm%swarn x stays not benign (rc 1)", async (_n, g) => {
    for (const err of [`npm${g}warn x`, `npm${g}notice x`, `npm${g}info x`]) {
      const { t, r } = await run({}, { [NPM]: { rc: 0, out: "{}", err } });
      expect(t).toContain("npm globals: not checked");
      expect(r.rc).toBe(1);
    }
  });
});
