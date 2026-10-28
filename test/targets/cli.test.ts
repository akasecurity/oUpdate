// `oupdate targets`: --apply required, --config required, --target repeatable; the main wires the
// config's reviewer, runs, prints one line per target and exits 1 on trouble.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { appRev, parseTargetsCommand, targetsMain, type TargetsMainDeps } from "../../src/targets/cli.ts";
import { parseTargetsConfig } from "../../src/targets/config.ts";
import { fakeClock, GCE_REACH, gceExec, inventory, VM_A } from "./fake-gce.ts";
import { fakeExec, memFs } from "./fakes.ts";

const ROOT = join(import.meta.dir, "..", "..");
const CONFIG = JSON.stringify({
  logDir: "/log",
  reviewer: { type: "command", name: "local", argv: ["/bin/cat"] },
  targets: [{ id: "laptop", os: "macos", reach: { kind: "local" }, legs: [{ kind: "brew" }], schedule: "nightly", summaryTo: "/status/laptop.tsv" }],
});

function deps(files: Record<string, string>) {
  const { fs, files: f } = memFs(files);
  const out: string[] = [];
  const specs: string[] = [];
  const d: TargetsMainDeps = {
    exec: fakeExec([]).exec, fs, now: new Date(2026, 9, 25, 4, 10), rev: "abc1234", tmpDir: "/tmp",
    sources: {
      npm: { latest: async () => undefined, publishedAt: async () => undefined, integrity: async () => undefined },
      github: { releases: async () => [] },
      oci: { index: async () => { throw new Error("unused"); } },
      snapshot: { exists: async () => false },
      docker: { listing: async () => { throw new Error("unused"); } },
    },
    makeReviewer: (s) => (specs.push(s.name), { name: s.name, review: async () => "APPROVE\nfine" }),
    releases: { latest: async () => "7.1.4" },
    reviewNpm: () => async () => { throw new Error("unused"); },
    out: (l) => out.push(l),
  };
  return { d, out, specs, files: f };
}

describe("oupdate targets", () => {
  test("parseTargetsCommand", () => {
    expect(parseTargetsCommand(["--apply", "--config", "/etc/t.json"])).toEqual({ config: "/etc/t.json", dryRun: false, only: [] });
    expect(parseTargetsCommand(["--apply", "--dry-run", "--config", "t.json", "--target", "a", "--target", "b"])).toEqual({ config: "t.json", dryRun: true, only: ["a", "b"] });
    expect(() => parseTargetsCommand(["--config", "t.json"])).toThrow("targets needs --apply");
    expect(() => parseTargetsCommand(["--apply"])).toThrow("targets needs --config FILE");
    expect(() => parseTargetsCommand(["--apply", "--config"])).toThrow("--config needs a value");
    expect(() => parseTargetsCommand(["--apply", "--config", "t.json", "--host", "x"])).toThrow("unknown flag --host");
  });

  test("targetsMain runs, prints one line per target, publishes and exits 1 on trouble", async () => {
    const { d, out, specs, files } = deps({ "/etc/t.json": CONFIG });
    const rc = await targetsMain({ config: "/etc/t.json", dryRun: false, only: [] }, d);
    expect(rc).toBe(1);
    expect(specs).toEqual(["local"]);
    expect(out).toContain("laptop: not checked — leg brew not built yet · error: see the targets log");
    expect(files.get("/status/laptop.tsv")).toBe("host\tlaptop\ndate\t2026-10-25 04:10\nrev\tabc1234\nsummary\tnot checked — leg brew not built yet · error: see the targets log\n");
  });

  test("a missing config file is an error", async () => {
    await expect(targetsMain({ config: "/nope.json", dryRun: false, only: [] }, deps({}).d)).rejects.toThrow("cannot read targets config /nope.json");
  });

  test("appRev is the short head, or unknown", async () => {
    expect(await appRev(fakeExec([(a) => (a.includes("rev-parse") ? { out: "abc1234\n" } : undefined)]).exec, "/app")).toBe("abc1234");
    expect(await appRev(fakeExec([]).exec, "/app")).toBe("unknown");
  });

  test("the example config parses", () => {
    const c = parseTargetsConfig(readFileSync(join(ROOT, "scripts", "targets.config.example.json"), "utf8"));
    expect(c.targets.map((t) => t.id)).toEqual(["images", "storage-box", "cloud-vms"]);
  });

  test("src/cli.ts dispatches targets and reports a usage error with exit 2", () => {
    const r = Bun.spawnSync(["bun", "src/cli.ts", "targets", "--dry-run"], { cwd: ROOT });
    expect(r.exitCode).toBe(2);
    expect(r.stderr.toString()).toContain("oupdate: targets needs --apply");
  });

  test("the second reviewer is made for the NAS legs", async () => {
    const cfg = JSON.parse(CONFIG);
    cfg.secondReviewer = { type: "command", name: "secondary", argv: ["/bin/cat"] };
    const { d, specs } = deps({ "/etc/t.json": JSON.stringify(cfg) });
    await targetsMain({ config: "/etc/t.json", dryRun: true, only: [] }, d);
    expect(specs).toEqual(["local", "secondary"]);
  });

  test("targetsMain wires both reviewers and the clock into the os-packages leg", async () => {
    const config = JSON.stringify({
      logDir: "/log",
      reviewer: { type: "command", name: "first-model", argv: ["/bin/cat"] },
      secondReviewer: { type: "command", name: "secondary-model", argv: ["/bin/cat"] },
      targets: [{ id: "cloud-vms", os: "linux", reach: { ...GCE_REACH, vms: [VM_A] }, legs: [{ kind: "os-packages", seenTo: "/state/seen.json", cooldownDays: 0 }], schedule: "nightly", summaryTo: "/status/cloud-vms.tsv" }],
    });
    const { d, out, specs } = deps({ "/etc/t.json": config });
    d.exec = gceExec({ vms: { [VM_A]: { inventory: [inventory()] } } }).exec;
    d.clock = fakeClock(0);
    expect(await targetsMain({ config: "/etc/t.json", dryRun: false, only: [] }, d)).toBe(0);
    expect(specs).toEqual(["first-model", "secondary-model"]);
    expect(out).toContain("cloud-vms: vm-a: would patch 2 · held 1");
  });
});
