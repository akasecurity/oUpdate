import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { checkClientKeys, readKeyFiles, detectManagers, type KeyFinding } from "../src/clientkeys.ts";

const opts = { cooldownDays: 7 };
const find = (fs: KeyFinding[], manager: string, key: string) => fs.find((f) => f.manager === manager && f.key === key);

describe("detectManagers", () => {
  test("lockfiles name the managers in use", () => {
    expect(detectManagers({ "package-lock.json": "{}", "uv.lock": "" })).toEqual(["npm", "uv"]);
    expect(detectManagers({ "pnpm-lock.yaml": "" })).toEqual(["pnpm"]);
    expect(detectManagers({ "bun.lock": "{}" })).toEqual(["bun"]);
    expect(detectManagers({ "bun.lockb": "" })).toEqual(["bun"]);
    expect(detectManagers({ "README.md": "" })).toEqual([]);
  });
});

describe("npm keys", () => {
  test("a hardened .npmrc passes", () => {
    const fs = checkClientKeys({ "package-lock.json": "{}", ".npmrc": "ignore-scripts=true\nallow-git = none\nmin-release-age=7\n" }, opts);
    expect(fs.filter((f) => f.manager === "npm").map((f) => [f.key, f.status])).toEqual([
      ["ignore-scripts", "ok"],
      ["allow-git", "ok"],
      ["min-release-age", "ok"],
    ]);
  });

  test("no .npmrc: every key is missing", () => {
    const fs = checkClientKeys({ "package-lock.json": "{}" }, opts);
    expect(fs.filter((f) => f.manager === "npm").every((f) => f.status === "missing")).toBe(true);
  });

  test("a shorter age than the policy is weak", () => {
    const f = find(checkClientKeys({ "package-lock.json": "{}", ".npmrc": "min-release-age=2" }, opts), "npm", "min-release-age");
    expect(f?.status).toBe("weak");
    expect(f?.got).toBe("2");
    expect(f?.want).toContain("7");
  });

  test("ignore-scripts=false and allow-git=all are weak, comments are ignored", () => {
    const fs = checkClientKeys({ "package-lock.json": "{}", ".npmrc": "# ignore-scripts=true\nignore-scripts=false\n;allow-git=none\nallow-git=all\n" }, opts);
    expect(find(fs, "npm", "ignore-scripts")?.status).toBe("weak");
    expect(find(fs, "npm", "allow-git")?.status).toBe("weak");
  });
});

describe("pnpm keys", () => {
  test("workspace yaml keys pass, allowBuilds is listed", () => {
    const fs = checkClientKeys(
      { "pnpm-lock.yaml": "", "pnpm-workspace.yaml": "strictDepBuilds: true\nminimumReleaseAge: 10080\nallowBuilds:\n  esbuild: true\n  sharp: false\n" },
      opts,
    );
    expect(find(fs, "pnpm", "strictDepBuilds")?.status).toBe("ok");
    expect(find(fs, "pnpm", "minimumReleaseAge")?.status).toBe("ok");
    const allow = find(fs, "pnpm", "allowBuilds");
    expect(allow?.status).toBe("info");
    expect(allow?.got).toBe("esbuild");
  });

  test("older onlyBuiltDependencies list is shown too", () => {
    const fs = checkClientKeys({ "pnpm-lock.yaml": "", "pnpm-workspace.yaml": "onlyBuiltDependencies:\n  - esbuild\n" }, opts);
    expect(find(fs, "pnpm", "allowBuilds")?.got).toBe("esbuild");
  });

  test("minutes under the policy are weak, missing strictDepBuilds is missing", () => {
    const fs = checkClientKeys({ "pnpm-lock.yaml": "", "pnpm-workspace.yaml": "minimumReleaseAge: 1440\n" }, opts);
    expect(find(fs, "pnpm", "minimumReleaseAge")?.status).toBe("weak");
    expect(find(fs, "pnpm", "strictDepBuilds")?.status).toBe("missing");
  });

  test(".npmrc kebab-case keys count for pnpm", () => {
    const fs = checkClientKeys({ "pnpm-lock.yaml": "", ".npmrc": "strict-dep-builds=true\nminimum-release-age=20160\n" }, opts);
    expect(find(fs, "pnpm", "strictDepBuilds")?.status).toBe("ok");
    expect(find(fs, "pnpm", "minimumReleaseAge")?.status).toBe("ok");
  });

  test("an unparsable workspace yaml is an error finding, not a throw", () => {
    const fs = checkClientKeys({ "pnpm-lock.yaml": "", "pnpm-workspace.yaml": "a: [unclosed\n" }, opts);
    expect(fs.some((f) => f.manager === "pnpm" && f.status === "error")).toBe(true);
  });
});

describe("bun keys", () => {
  test("scripts are denied by default; trustedDependencies is listed; age in seconds", () => {
    const fs = checkClientKeys(
      { "bun.lock": "{}", "package.json": JSON.stringify({ trustedDependencies: ["esbuild"] }), "bunfig.toml": "[install]\nminimumReleaseAge = 604800\n" },
      opts,
    );
    expect(find(fs, "bun", "trustedDependencies")).toMatchObject({ status: "info", got: "esbuild" });
    expect(find(fs, "bun", "minimumReleaseAge")?.status).toBe("ok");
  });

  test("no bunfig: age is missing; one day is weak", () => {
    expect(find(checkClientKeys({ "bun.lock": "{}" }, opts), "bun", "minimumReleaseAge")?.status).toBe("missing");
    expect(find(checkClientKeys({ "bun.lock": "{}", "bunfig.toml": "[install]\nminimumReleaseAge = 86400\n" }, opts), "bun", "minimumReleaseAge")?.status).toBe("weak");
  });

  test("a key outside [install] does not count", () => {
    expect(find(checkClientKeys({ "bun.lock": "{}", "bunfig.toml": "minimumReleaseAge = 604800\n" }, opts), "bun", "minimumReleaseAge")?.status).toBe("missing");
  });
});

describe("uv keys", () => {
  test("relative exclude-newer in pyproject passes", () => {
    for (const v of ['"7 days"', '"P7D"', '"1 week"', '"P2W"']) {
      const f = find(checkClientKeys({ "uv.lock": "", "pyproject.toml": `[tool.uv]\nexclude-newer = ${v}\n` }, opts), "uv", "exclude-newer");
      expect(f?.status, v).toBe("ok");
    }
  });

  test("uv.toml works, short durations are weak, a fixed timestamp is weak", () => {
    expect(find(checkClientKeys({ "uv.lock": "", "uv.toml": 'exclude-newer = "7 days"\n' }, opts), "uv", "exclude-newer")?.status).toBe("ok");
    expect(find(checkClientKeys({ "uv.lock": "", "uv.toml": 'exclude-newer = "2 days"\n' }, opts), "uv", "exclude-newer")?.status).toBe("weak");
    const fixed = find(checkClientKeys({ "uv.lock": "", "uv.toml": 'exclude-newer = "2026-01-01T00:00:00Z"\n' }, opts), "uv", "exclude-newer");
    expect(fixed?.status).toBe("weak");
    expect(fixed?.note).toContain("fixed date");
  });

  test("no setting is missing", () => {
    expect(find(checkClientKeys({ "uv.lock": "", "pyproject.toml": "[project]\nname='x'\n" }, opts), "uv", "exclude-newer")?.status).toBe("missing");
  });
});

describe("readKeyFiles", () => {
  test("reads only the known file names from a directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "oupdate-keys-"));
    try {
      writeFileSync(join(dir, ".npmrc"), "ignore-scripts=true\n");
      writeFileSync(join(dir, "package-lock.json"), "{}");
      writeFileSync(join(dir, "other.txt"), "x");
      const files = readKeyFiles(dir);
      expect(Object.keys(files).sort()).toEqual([".npmrc", "package-lock.json"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("renderKeys and parseKeysArgs", () => {
  test("render says what to set and what was found", async () => {
    const { renderKeys } = await import("../src/clientkeys.ts");
    const text = renderKeys("repo", checkClientKeys({ "package-lock.json": "{}", ".npmrc": "ignore-scripts=true\n" }, opts));
    expect(text.split("\n")[0]).toBe("repo: 2 key(s) to set");
    expect(text).toContain("npm  ok      .npmrc ignore-scripts: got true; want true");
    expect(text).toContain("npm  missing .npmrc allow-git:; want none");
    expect(renderKeys("empty", [])).toContain("nothing to check");
  });

  test("parseKeysArgs takes a dir, a cooldown and --json", async () => {
    const { parseKeysArgs } = await import("../src/cli.ts");
    expect(parseKeysArgs([])).toEqual({ dir: ".", cooldownDays: 2, json: false });
    expect(parseKeysArgs(["some/repo", "--cooldown-days", "3", "--json"])).toEqual({ dir: "some/repo", cooldownDays: 3, json: true });
    expect(() => parseKeysArgs(["a", "b"])).toThrow("usage");
    expect(() => parseKeysArgs(["--cooldown-days", "x"])).toThrow(">= 0");
    expect(() => parseKeysArgs(["--nope"])).toThrow("unknown flag");
  });
});
