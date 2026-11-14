import { describe, expect, test } from "bun:test";
import { installView, setJsScanSteps } from "../src/install-closure.ts";
import { allowFaults } from "./fault-guard.ts";

const enc = new TextEncoder();
const view = (files: Record<string, string>) => installView(new Map(Object.entries(files).map(([k, v]) => [k, enc.encode(v)])));
const pj = JSON.stringify({ name: "p", version: "1.0.0", scripts: { postinstall: "node lib/a.js" } });
// The hook is in lib/, so a file at the root or in docs/ is in the closure only when the hook's text names it.
const pkg = (a: string): Record<string, string> => ({
  "package.json": pj,
  "lib/a.js": a,
  "lib/x.js": "1;\n",
  "b.js": "1;\n",
  "evil.js": "console.log(1);\n",
  "docs/evil.js": "console.log(2);\n",
  "z/other.js": "1;\n",
  "version.js": "1;\n",
  "build.config.js": "1;\n",
});
const cp = "const cp = require('child_process');\n";

describe("a node command in a shell string names the files it runs", () => {
  test("sh -c with a preload and a script: the preload is in the closure", () => {
    const r = view(pkg(cp + `cp.spawnSync("sh", ["-c", "node -r ./evil b.js"], { cwd: process.cwd() });\n`));
    expect(r.hold).toBeUndefined();
    expect(r.files).toContain("evil.js");
    expect(r.files).toContain("b.js");
  });
  test("execSync with a preload and a script", () => {
    const r = view(pkg(cp + `cp.execSync("node -r ./evil b.js", { cwd: process.cwd() });\n`));
    expect(r.files).toContain("evil.js");
    expect(r.files).toContain("b.js");
  });
  test("a --require value and a script with no extension", () => {
    for (const cmd of ["node --require ./evil b.js", "node ./evil", "node evil", "cd . && node -r ./evil"]) {
      const r = view(pkg(cp + `cp.execSync(${JSON.stringify(cmd)});\n`));
      expect(r.files).toContain("evil.js");
    }
  });
  test("an --import value with an extension, written with =", () => {
    const r = view(pkg(cp + `cp.execSync("node --import=./evil.js b.js");\n`));
    expect(r.files).toContain("evil.js");
  });
  test("an --import value with an extension, spaced (main reads it already as a quoted path word)", () => {
    const r = view(pkg(cp + `cp.execSync("node --import ./evil.js b.js");\n`));
    expect(r.files).toContain("evil.js");
  });
  test("a flag value written with =", () => {
    for (const cmd of ["node --require=./evil b.js", "node -r=./evil b.js"]) {
      const r = view(pkg(cp + `cp.execSync(${JSON.stringify(cmd)});\n`));
      expect(r.hold).toBeUndefined();
      expect(r.files).toContain("evil.js");
    }
  });
  test("a flag that takes a value is not the script; the script after it is read", () => {
    for (const flag of ["--conditions dev", "-C dev", "--loader ./z/other.js", "--experimental-loader ./z/other.js", "--env-file .env",
      "--title x", "--experimental-default-type module", "--input-type module"]) {
      const r = view(pkg(cp + `cp.execSync("node ${flag} ./evil");\n`));
      expect(r.hold).toBeUndefined();
      expect(r.files).toContain("evil.js");
    }
  });
  test("after a flag the reader does not know, every later word is a candidate script (it may have taken a value), never a hold", () => {
    for (const cmd of ["node --some-new-flag x ./evil", "node --experimental-config-file cfg.json ./evil", "node --experimental-policy p.json ./evil",
      "node --some-new-flag=1 ./evil"]) {
      const r = view(pkg(cp + `cp.execSync(${JSON.stringify(cmd)});\n`));
      expect(r.hold).toBeUndefined();
      expect(r.files).toContain("evil.js");
    }
  });
  test("real node flags not in the reader's lists: the script after them is read, never a hold", () => {
    for (const flag of ["--openssl-legacy-provider", "--expose-internals", "--allow-natives-syntax", "--jitless", "--disable-warning DEP0040",
      "--test-reporter spec", "--watch-path src", "--max-semi-space-size 64", "--run build"]) {
      const r = view(pkg(cp + `cp.execSync("node ${flag} ./evil");\n`));
      expect(r.hold).toBeUndefined();
      expect(r.files).toContain("evil.js");
    }
  });
  test("-- ends the flags: the next word is the script", () => {
    const r = view(pkg(cp + `cp.execSync("node -- ./evil");\n`));
    expect(r.files).toContain("evil.js");    // As after any script, the words after it are its arguments, not read as files (as for `node b.js ./evil`).
    const after = view(pkg(cp + `cp.execSync("node -- b.js ./evil");\n`));
    expect(after.files).toContain("b.js");
    expect(after.files).not.toContain("evil.js");
  });
  test("a shell inside the other quote kind is read on its -c argument", () => {
    for (const a of [`cp.execSync("sh -c 'node -r ./evil b.js'");\n`, `cp.execSync('bash -c "node ./evil"');\n`]) {
      const r = view(pkg(cp + a));
      expect(r.hold).toBeUndefined();
      expect(r.files).toContain("evil.js");
    }
  });
  test("every command of the string is read, not just the first", () => {
    for (const cmd of ["true && node ./evil", "true ; node ./evil", "false || node ./evil", "node b.js && node ./evil"]) {
      const r = view(pkg(cp + `cp.execSync(${JSON.stringify(cmd)});\n`));
      expect(r.files).toContain("evil.js");
    }
  });
  test("a quoted value inside the shell string", () => {
    const r = view(pkg(cp + `cp.execSync("node -r './evil' b.js");\n`));
    expect(r.files).toContain("evil.js");
  });
  test("a dotted script name with no extension", () => {
    const r = view(pkg(cp + `cp.execSync("node ./build.config");\n`));
    expect(r.files).toContain("build.config.js");
  });
  test("the args-array form of the same command: the same files, but for the stem the array form also names", () => {
    const str = view(pkg(cp + `cp.execSync("node -r ./evil b.js");\n`));
    const arr = view(pkg(cp + `cp.spawnSync("node", ["-r", "./evil", "b.js"]);\n`));
    // The string form names ./evil from the working directory only; the args-array reader also takes the stem "evil" anywhere
    // (docs/evil.js): wider, never narrower.
    expect(arr.files).toEqual([...str.files, "docs/evil.js"].sort());
  });
  test("control: a command that does not run node, and prose that mentions it, add nothing", () => {
    for (const a of [
      cp + `cp.execSync("git log -r ./evil");\n`,
      cp + `console.log("needs node 18 or newer");\n`,
      cp + `cp.execSync("node --version");\n`,
      cp + `cp.execSync("echo node ; cat ./evil");\n`,
      cp + `cp.execSync("node -e 1 ./evil");\n`,
      cp + `cp.execSync("echo node evil");\n`,
      cp + `cp.execSync("node --import ./evil b.js");\n`,
      cp + `cp.execSync("node - ./evil");\n`,
      cp + `console.log("node ./evil is how to run it");\n`,
    ]) {
      const r = view(pkg(a));
      expect(r.hold).toBeUndefined();
      expect(r.files).not.toContain("evil.js");
    }
  });
  test("control: prose with node, at the start or not, adds nothing and never holds (only an executed string is read)", () => {
    for (const a of [`console.log("requires node version 18");\n`, `console.log("node version 18 is required");\n`,
      `console.warn("node --openssl-legacy-provider is required");\n`, `console.warn("node --some-new-flag version");\n`]) {
      const r = view(pkg(cp + a));
      expect(r.hold).toBeUndefined();
      expect(r.files).not.toContain("version.js");
    }
  });
  test("control: a ./ script is named from the working directory only", () => {
    const r = view(pkg(cp + `cp.execSync("node ./evil");\n`));
    expect(r.files).toContain("evil.js");
    expect(r.files).not.toContain("docs/evil.js");
  });
  test("a shell's -c argument is read when the call's program is a shell (a path too)", () => {
    for (const a of [`cp.spawnSync("/bin/bash", ["-c", "node ./evil"]);\n`, `cp.execFile("sh", ["-c", "node ./evil"]);\n`]) {
      const r = view(pkg(cp + a));
      expect(r.files).toContain("evil.js");
    }
  });
  test("a shell inside a command string is read at command position only", () => {
    const r = view(pkg(cp + `cp.execSync("true && sh -c 'node ./evil'");\n`));
    expect(r.files).toContain("evil.js");
  });
  test("control: call syntax inside a string, a \"-c\" pair outside a shell's args array, and a shell word that is not a command add nothing", () => {
    for (const a of [
      `console.log('execSync("node version")');\n`,
      `console.log("-c", "node version");\n`,
      cp + `cp.execFile("printf", ["-c", "node version"]);\n`,
      cp + `const cmd = "true";\ncp.exec(cmd, "node ./version");\n`,
      cp + `cp.execSync("echo sh -c 'node ./version'");\n`,
      cp + `cp.execSync("printf '%s' sh -c 'node ./version'");\n`,
    ]) {
      const r = view(pkg(cp + a));
      expect(r.hold).toBeUndefined();
      expect(r.files).not.toContain("version.js");
    }
  });
  test("a bare script name is read as the args-array form reads it: name.js, never every name.* in any folder", () => {
    const more = { "build.js": "1;\n", "y/build.js": "1;\n", "w/build.cjs": "1;\n", "docs/build.md": "x\n" };
    const str = view({ ...pkg(cp + `cp.execSync("node build");\n`), ...more });
    const arr = view({ ...pkg(cp + `cp.spawnSync("node", ["build"]);\n`), ...more });
    expect(str.files).toContain("build.js");
    expect(str.files).not.toContain("y/build.js");
    expect(str.files).toEqual(arr.files);
  });
  test("budget: a command string is charged, and linearly (512 operators cost about as much as 512 letters)", () => {
    // Each limit below the cost is a budget fault on purpose.
    allowFaults();
    const fewest = (a: string): number => {
      let lo = 1;
      let hi = 50_000_000;
      while (lo < hi) {
        const m = Math.floor((lo + hi) / 2);
        setJsScanSteps(m);
        if (view(pkg(cp + a)).hold) lo = m + 1;
        else hi = m;
      }
      setJsScanSteps(undefined);
      return lo;
    };
    // The same call with a string the reader skips (it has an escape): the difference is what reading the command costs.
    const skipped = fewest(`cp.execSync("\\\\${"a".repeat(511)}");\n`);
    const ops = fewest(`cp.execSync("${";".repeat(512)}");\n`);
    const letters = fewest(`cp.execSync("${"a".repeat(512)}");\n`);
    expect(letters - skipped).toBeGreaterThanOrEqual(256);
    expect(ops - skipped).toBeLessThan(16 * 512);
    expect(Math.abs(ops - letters)).toBeLessThan(512);
  });
  test("control: a quoted operator is a plain word, never a command separator", () => {
    for (const cmd of ["echo ';' node ./version", "echo '&&' node ./version", "echo \"|\" node ./version", "echo '(' node ./version"]) {
      const r = view(pkg(cp + `cp.execSync(${JSON.stringify(cmd)});\n`));
      expect(r.hold).toBeUndefined();
      expect(r.files).not.toContain("version.js");
    }
  });
  test("control: only the first -c pair of a shell's args array is a command; later strings are its positional parameters", () => {
    for (const a of [`cp.spawn("sh", ["-c", "true", "-c", "node ./version"]);\n`, `cp.spawn("sh", ["-c", "true", "node ./version"]);\n`]) {
      const r = view(pkg(cp + a));
      expect(r.hold).toBeUndefined();
      expect(r.files).not.toContain("version.js");
    }
  });
  test("after a shell's -c, its options are skipped: the first string that is not an option is the command", () => {
    for (const a of [`cp.spawn("sh", ["-c", "-c", "node ./version"]);\n`, `cp.spawn("sh", ["-c", "-e", "-c", "node ./version"]);\n`,
      `cp.spawn("sh", ["-c", "--", "node ./version"]);\n`]) {
      const r = view(pkg(cp + a));
      expect(r.files).toContain("version.js");
    }
  });
  test("a bare -r value is a package specifier: named from the working directory only, never as a stem in another folder", () => {
    const more = { "docs/dotenv.js": "1;\n" };
    const r = view({ ...pkg(cp + `cp.execSync("node -r dotenv b.js");\n`), ...more });
    expect(r.files).toContain("b.js");
    expect(r.files).not.toContain("docs/dotenv.js");
  });

});

