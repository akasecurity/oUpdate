// Writes the layer tarballs under test/fixtures/oci/ that the image-layer tests read. Run `bun scripts/make-oci-fixtures.ts`
// and commit the result; the tests never run this.

import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";

type Spec = string | Buffer | { data?: string | Buffer; mode?: number; link?: string; dirMode?: number; fifo?: boolean };

const out = resolve(import.meta.dir, "../test/fixtures/oci");
const when = new Date("2026-01-01T00:00:00Z");

const apk = (pkgs: [string, string, string, string[]][]) =>
  pkgs.map(([name, version, dir, files]) => [`P:${name}`, `V:${version}`, `F:${dir}`, ...files.map((f) => `R:${f}`)].join("\n")).join("\n\n") + "\n";

const elf = Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]), Buffer.alloc(64, 1)]);

const LAYERS: Record<string, Record<string, Spec>> = {
  // The base every image shares.
  "base.tar": {
    "etc/alpine-release": "3.19.1\n",
    "etc/passwd": "root:x:0:0:root:/root:/bin/sh\n",
    "lib/apk/db/installed": apk([
      ["musl", "1.2.4-r0", "lib", ["ld-musl-x86_64.so.1"]],
      ["tzdata", "2024a-r0", "usr/share/zoneinfo", ["UTC"]],
    ]),
    "usr/share/zoneinfo/UTC": "TZ-2024a\n",
    "lib/ld-musl-x86_64.so.1": elf,
    "var/lib/app/data": "keep\n",
  },
  // The old image's own top layer.
  "old-top.tar": {
    "etc/motd": "welcome\n",
    "etc/s6-overlay/s6-rc.d/svc/run": "#!/bin/sh\nexec /app/server --port 80\n",
    "app/server": { data: "#!/bin/sh\necho server\n", mode: 0o755 },
  },
  // New top layers, one per case.
  "new-run.tar.gz": {
    "etc/s6-overlay/s6-rc.d/svc/run": "#!/bin/sh\nexec /app/server --port 8080\n",
  },
  "new-elf.tar": {
    "usr/local/bin/agent": { data: elf, mode: 0o755 },
  },
  "new-preload.tar": {
    "etc/ld.so.preload": "/lib/evil.so\n",
  },
  "new-apk.tar": {
    "lib/apk/db/installed": apk([
      ["musl", "1.2.4-r0", "lib", ["ld-musl-x86_64.so.1"]],
      ["tzdata", "2024b-r0", "usr/share/zoneinfo", ["UTC"]],
    ]),
    "usr/share/zoneinfo/UTC": "TZ-2024b\n",
  },
  "new-wh.tar": {
    "etc/.wh.motd": "",
    "var/lib/app/.wh..wh..opq": "",
    "var/lib/app/fresh": "new\n",
  },
  "new-setuid.tar": {
    "usr/bin/su2": { data: "#!/bin/sh\nid\n", mode: 0o4755 },
    "etc/mylink": { link: "/etc/passwd" },
  },
  // An upgrade whose package database claims it owns a setuid file, a startup script and a CA certificate.
  "new-apk-risky.tar": {
    "lib/apk/db/installed":
      "P:musl\nV:1.2.4-r0\nF:lib\nR:ld-musl-x86_64.so.1\n\nP:tzdata\nV:2024b-r0\nF:usr/share/zoneinfo\nR:UTC\nF:usr/bin\nR:su2\nF:etc/s6-overlay/s6-rc.d/svc\nR:run\nF:usr/local/share/ca-certificates\nR:corp.crt\n",
    "usr/share/zoneinfo/UTC": "TZ-2024b\n",
    "usr/bin/su2": { data: "#!/bin/sh\nid\n", mode: 0o4755 },
    "etc/s6-overlay/s6-rc.d/svc/run": "#!/bin/sh\nexec /app/server --port 9090\n",
    "usr/local/share/ca-certificates/corp.crt": "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n",
  },
  // A maintainer script under the package database's directory.
  "new-postinst.tar": {
    "var/lib/dpkg/info/foo.postinst": "#!/bin/sh\necho configured\n",
  },
  // Start-target resolution: a symlinked parent directory, relative and chained links, a loop, a relative path under WorkingDir.
  // The start targets are executable, as a start target must be.
  "ep-old.tar": {
    bin: { link: "usr/bin" },
    "usr/bin/launch": { data: "old launch\n", mode: 0o755 },
    "usr/lib/real": { data: "old real\n", mode: 0o755 },
    "usr/bin/l2": { link: "../lib/real" },
    "usr/bin/l3": { link: "l2" },
    "usr/bin/loop1": { link: "loop2" },
    "usr/bin/loop2": { link: "loop1" },
    "app/run.sh": { data: "old run\n", mode: 0o755 },
    "app/launch": { data: "old app launch\n", mode: 0o755 },
  },
  "ep-new.tar": {
    "usr/bin/launch": { data: "new launch\n", mode: 0o755 },
    "usr/lib/real": { data: "new real\n", mode: 0o755 },
    "app/run.sh": { data: "new run\n", mode: 0o755 },
    "app/launch": { data: "new app launch\n", mode: 0o755 },
    "usr/bin/su3": { data: "#!/bin/sh\nid\n", mode: 0o4755 },
    "etc/ca-certificates/x.crt": "cert\n",
  },
  // Cache and bookkeeping-lookalike paths: a setuid file under the apt cache, a file whose name merely starts with "status".
  "new-cache.tar": {
    "var/cache/apt/pwn": { data: "#!/bin/sh\nid\n", mode: 0o4755 },
    "var/lib/dpkg/status-helper": "#!/bin/sh\necho helper\n",
  },
  // Upgrades whose package database claims the file: an ELF start target, a maintainer script, a file whose only change is its mode.
  "new-owned-ep.tar": {
    "lib/apk/db/installed": "P:musl\nV:1.2.4-r0\nF:lib\nR:ld-musl-x86_64.so.1\n\nP:tzdata\nV:2024b-r0\nF:usr/local/bin\nR:app\n",
    "usr/local/bin/app": { data: elf, mode: 0o755 },
  },
  "new-owned-postinst.tar": {
    "lib/apk/db/installed": "P:musl\nV:1.2.4-r0\nF:lib\nR:ld-musl-x86_64.so.1\n\nP:tzdata\nV:2024b-r0\nF:var/lib/dpkg/info\nR:foo.postinst\n",
    "var/lib/dpkg/info/foo.postinst": "#!/bin/sh\necho configured\n",
  },
  "new-owned-chmod.tar": {
    "lib/apk/db/installed": "P:musl\nV:1.2.4-r0\nF:lib\nR:ld-musl-x86_64.so.1\n\nP:tzdata\nV:2024b-r0\nF:usr/share/zoneinfo\nR:UTC\n",
    "usr/share/zoneinfo/UTC": { data: "TZ-2024a\n", mode: 0o755 },
  },
  // 1,000,001 bytes of text: one over the shown limit; gzip makes it tiny.
  "new-big.tar.gz": {
    "app/server.py": "a\n".repeat(500_000) + "b",
  },
  // The same bytes as old-top's /etc/motd with the execute bits set.
  "new-chmod.tar": {
    "etc/motd": { data: "welcome\n", mode: 0o755 },
  },
  // An interpreted start: a python start binary and a 0644 script, then the script changed and claimed by a bumped package.
  "py-old.tar": {
    "usr/bin/python3": { data: "#!/bin/sh\necho python\n", mode: 0o755 },
    "app/server.py": "old\n",
  },
  "py-new.tar": {
    "lib/apk/db/installed": "P:musl\nV:1.2.4-r0\nF:lib\nR:ld-musl-x86_64.so.1\n\nP:tzdata\nV:2024b-r0\nF:app\nR:server.py\n",
    "app/server.py": "new\n",
  },
  // A mandatory path that is a symlink in a shared layer, whose target a later layer changes and a package claims.
  "lnk-old.tar": {
    "etc/ld.so.preload": { link: "/opt/preload" },
    "opt/preload": "/lib/a.so\n",
    "usr/bin/cat": { data: "#!/bin/sh\ncat\n", mode: 0o755 },
  },
  // Two links of different strength to one target: the hard one must not be replaced by the startup one.
  "alias-old.tar": {
    "etc/ld.so.preload": { link: "/opt/payload" },
    "etc/services.d/z": { link: "/opt/payload" },
    "opt/payload": "old\n",
  },
  "alias-new.tar": {
    "opt/payload": "new\n",
  },
  // A sticky bit removed from a world-writable PATH directory, and a writable ancestor of a PATH directory.
  "sticky-old.tar": {
    "usr/local/bin/keep": { data: "#!/bin/sh\n", mode: 0o755 },
    "usr/local/bin": { dirMode: 0o1777 },
  },
  "sticky-new.tar": {
    "usr/local/bin": { dirMode: 0o777 },
  },
  "anc-old.tar": {
    "opt/tools/bin/tool": { data: "#!/bin/sh\n", mode: 0o755 },
  },
  "anc-new.tar": {
    "opt/tools": { dirMode: 0o777 },
  },
  "lnk-new.tar": {
    "lib/apk/db/installed": "P:musl\nV:1.2.4-r0\nF:lib\nR:ld-musl-x86_64.so.1\n\nP:tzdata\nV:2024b-r0\nF:opt\nR:preload\n",
    "opt/preload": "/lib/evil.so\n",
  },
  // Directory permissions: a PATH directory and a cron directory made group/world writable, and an unremarkable one.
  "dir-old.tar": {
    "usr/local/bin/keep": { data: "#!/bin/sh\n", mode: 0o755 },
    "opt/other/f": "x\n",
    "etc/cron.d/placeholder": "x\n",
  },
  "dir-new.tar": {
    "usr/local/bin": { dirMode: 0o777 },
    "opt/other": { dirMode: 0o777 },
    "etc/cron.d": { dirMode: 0o775 },
  },
  "new-rootopq.tar": {
    ".wh..wh..opq": "",
  },
  // Ancestors of mandatory paths that exist in the image: an apk scripts archive, a .pth file and authorized_keys.
  "anc2-old.tar": {
    "lib/apk/db/scripts.tar": "scripts\n",
    "usr/lib/python3/site-packages/x.pth": "/opt/lib\n",
    "root/.ssh/authorized_keys": "ssh-ed25519 AAAA key\n",
  },
  "anc2-new.tar": {
    "lib/apk": { dirMode: 0o777 },
    "usr/lib/python3": { dirMode: 0o777 },
    "root": { dirMode: 0o777 },
  },
  // A mandatory directory that is a symlink: etc/init.d -> /opt/hooks, with a script changed under the target.
  "hooks-old.tar": {
    "etc/init.d": { link: "/opt/hooks" },
    "opt/hooks/boot.sh": "old\n",
  },
  "hooks-new.tar": {
    "opt/hooks/boot.sh": "new\n",
    opt: { dirMode: 0o777 },
  },
  // One resolver, six cases. U1: a directory below a mandatory directory link's target. U2: two directory links to one target.
  // U3: a link below an aliased directory. U4: a mandatory directory link added or redirected. U5: implicit target directories
  // and a link to the image root.
  "u1-old.tar": {
    "etc/init.d": { link: "/opt/hooks" },
    "opt/hooks/sub/boot.sh": "old\n",
  },
  "u1-new.tar": {
    "opt/hooks/sub": { dirMode: 0o777 },
  },
  "u2-old.tar": {
    "etc/init.d": { link: "/opt/hooks" },
    "etc/services.d": { link: "/opt/hooks" },
    "opt/hooks/boot.sh": "old\n",
  },
  "u2-new.tar": {
    "opt/hooks/boot.sh": "new\n",
  },
  "u3-old.tar": {
    "etc/init.d": { link: "/opt/hooks" },
    "opt/hooks/boot.sh": { link: "/opt/payload" },
    "opt/payload": "old\n",
  },
  "u3-new.tar": {
    "opt/payload": "new\n",
  },
  "u4-dirs.tar": {
    "opt/hooks/a": "a\n",
    "opt/evil/b": "b\n",
  },
  "u4-add.tar": {
    "etc/init.d": { link: "/opt/hooks" },
  },
  "u4-redirect.tar": {
    "etc/init.d": { link: "/opt/evil" },
  },
  "u5-old.tar": {
    "etc/init.d": { link: "/opt/hooks" },
    "opt/hooks/boot.sh": "old\n",
  },
  "u5-new.tar": {
    "opt/hooks/boot.sh": "new\n",
  },
  "u5r-old.tar": {
    "etc/init.d": { link: "/" },
    "opt/payload": "old\n",
  },
  "u5r-new.tar": {
    "opt/payload": "new\n",
  },
  // The virtual view. V1: an intermediate link redirected. V2: a mandatory file or link removed, or replaced by a FIFO or a
  // directory. V3: a link at an ancestor (etc) that activates a file already in the image. V4: a link that makes an existing
  // file newly reachable as a startup script.
  "v1-old.tar": {
    "etc/init.d": { link: "/opt/bridge" },
    "opt/bridge": { link: "/opt/hooks" },
    "opt/hooks/a": "a\n",
    "opt/evil/b": "b\n",
  },
  "v1-new.tar": {
    "opt/bridge": { link: "/opt/evil" },
  },
  "v2-old.tar": {
    "etc/ld.so.preload": "/lib/a.so\n",
    "etc/init.d": { link: "/opt/hooks" },
    "opt/hooks/a": "a\n",
  },
  "v2-rm.tar": {
    "etc/.wh.ld.so.preload": "",
    "etc/.wh.init.d": "",
  },
  "v2-fifo.tar": {
    "etc/ld.so.preload": { fifo: true },
  },
  "v2-dir.tar": {
    "etc/init.d": { dirMode: 0o755 },
  },
  "v3-old.tar": {
    "opt/config/ld.so.preload": "/lib/evil.so\n",
  },
  "v3-new.tar": {
    etc: { link: "/opt/config" },
  },
  "v4-old.tar": {
    "opt/services/run": { data: "#!/bin/sh\nexec /app/server\n", mode: 0o755 },
  },
  "v4-new.tar": {
    "etc/services.d": { link: "/opt/services" },
  },
  // W1: a hard link in a shared upper layer (see the raw tar below) to a file the lower layer holds; only the lower layer differs.
  "w1-old.tar": {
    "opt/preload": "/lib/a.so\n",
  },
  "w1-evil.tar": {
    "opt/preload": "/lib/evil.so\n",
  },
  // W2: root/.ssh and a python site directory are links, reached through an intermediate link that is redirected.
  "w2-old.tar": {
    "root/.ssh": { link: "/opt/bridge" },
    "opt/bridge": { link: "/opt/dirA" },
    "opt/dirA/authorized_keys": "ssh-ed25519 AAAA a\n",
    "opt/dirB/authorized_keys": "ssh-ed25519 BBBB b\n",
  },
  "w2-new.tar": {
    "opt/bridge": { link: "/opt/dirB" },
  },
  "w2p-old.tar": {
    "usr/lib/python3/site-packages": { link: "/opt/bridge2" },
    "opt/bridge2": { link: "/opt/siteA" },
    "opt/siteA/a.pth": "/lib/a\n",
    "opt/siteB/a.pth": "/lib/b\n",
  },
  "w2p-new.tar": {
    "opt/bridge2": { link: "/opt/siteB" },
  },
  // W3: a startup directory whose mode changes without a writable bit, and an empty one that is removed.
  "w3b-old.tar": {
    "etc/profile.d/a.sh": "echo a\n",
  },
  "w3b-mode.tar": {
    "etc/profile.d": { dirMode: 0o750 },
  },
  "w3c-old.tar": {
    "etc/cron.d": { dirMode: 0o755 },
  },
  "w3c-rm.tar": {
    "etc/.wh.cron.d": "",
  },
  // W4: a link added and, in the same layer, the file behind it changed.
  "w4-new.tar": {
    "etc/services.d": { link: "/opt/services" },
    "opt/services/run": { data: "#!/bin/sh\nexec /app/server --changed\n", mode: 0o755 },
  },
  // W5: dpkg ownership read from the file lists.
  "dpkg-old.tar": {
    "lib/apk/db/.wh.installed": "",
    "var/lib/dpkg/status": "Package: foo\nStatus: install ok installed\nVersion: 1\n",
    "var/lib/dpkg/info/foo.list": "/usr/share/foo/data\n",
    "usr/share/foo/data": "old\n",
  },
  "dpkg-new.tar": {
    "var/lib/dpkg/status": "Package: foo\nStatus: install ok installed\nVersion: 2\n",
    "usr/share/foo/data": "new\n",
  },
  // X1: a chain of hard links to a file a lower layer holds.
  "x1-old.tar": {
    "var/cache/apt/data": "/lib/a.so\n",
  },
  "x1-evil.tar": {
    "var/cache/apt/data": "/lib/evil.so\n",
  },
  // X2: root is a link to a directory whose .ssh is itself a link; only root changes (or is removed).
  "x2-old.tar": {
    root: { link: "/opt/A" },
    "opt/A/.ssh": { link: "/data/A" },
    "opt/B/.ssh": { link: "/data/B" },
    "data/A/authorized_keys": "ssh-ed25519 AAAA a\n",
    "data/B/authorized_keys": "ssh-ed25519 BBBB b\n",
  },
  "x2-new.tar": {
    root: { link: "/opt/B" },
  },
  "x2-rm.tar": {
    ".wh.root": "",
  },
  // X3: /etc/pki/tls is a link to a directory under an otherwise omitted cache path, and only the bundle behind it changes.
  "x3-old.tar": {
    "etc/pki/tls": { link: "/var/cache/apt/tls" },
    "var/cache/apt/tls/certs/ca-bundle.crt": "OLD CA\n",
  },
  "x3-new.tar": {
    "var/cache/apt/tls/certs/ca-bundle.crt": "EVIL CA\n",
  },
  // X4: empty startup and trust directories removed by whiteout.
  "x4-old.tar": {
    "etc/services.d": { dirMode: 0o755 },
    "etc/ssl/certs": { dirMode: 0o755 },
  },
  "x4-rm.tar": {
    "etc/.wh.services.d": "",
    "etc/ssl/.wh.certs": "",
  },
  "new-cacert.tar": {
    "usr/local/share/ca-certificates/corp.crt": "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n",
  },
};

// Chains of symlinks to an executable: 40 links resolve, 41 do not.
for (const n of [40, 41]) {
  const files: Record<string, Spec> = { "usr/bin/ctarget": { data: "#!/bin/sh\necho chain\n", mode: 0o755 } };
  for (let i = 1; i <= n; i++) files[`usr/bin/c${i}`] = { link: i === n ? "ctarget" : `c${i + 1}` };
  LAYERS[`ep-chain${n}.tar`] = files;
}

// Layers that carry only their file members, with no directory entries above them (implicit parent directories).
const MEMBERS_ONLY = new Set(["u5-old.tar", "u5-new.tar", "u5r-old.tar", "u5r-new.tar"]);

const tmp = mkdtempSync(join(tmpdir(), "oup28-fixtures-"));
mkdirSync(out, { recursive: true });
try {
  for (const [name, files] of Object.entries(LAYERS)) {
    // A fixture already committed is left alone, so adding one never rewrites the others' bytes.
    if (existsSync(join(out, name))) continue;
    const dir = join(tmp, name);
    mkdirSync(dir);
    const dirModes: [string, number][] = [];
    for (const [path, spec] of Object.entries(files)) {
      const abs = join(dir, path);
      mkdirSync(dirname(abs), { recursive: true });
      const s = typeof spec === "string" || Buffer.isBuffer(spec) ? { data: spec } : spec;
      if (s.fifo) {
        const f = Bun.spawnSync(["mkfifo", abs]);
        if (f.exitCode !== 0) throw new Error(`mkfifo ${path}: ${f.stderr.toString()}`);
      } else if (s.dirMode !== undefined) {
        mkdirSync(abs, { recursive: true });
        dirModes.push([abs, s.dirMode]);
      } else if (s.link !== undefined) symlinkSync(s.link, abs);
      else {
        writeFileSync(abs, s.data ?? "");
        chmodSync(abs, s.mode ?? 0o644);
        utimesSync(abs, when, when);
      }
    }
    for (const [d, m] of dirModes) chmodSync(d, m);
    const flag = name.endsWith(".gz") ? "-czf" : "-cf";
    const what = MEMBERS_ONLY.has(name) ? Object.keys(files).map((f) => `./${f}`) : ["."];
    const p = Bun.spawnSync(["bsdtar", "--uid", "0", "--gid", "0", "--numeric-owner", flag, join(out, name), "-C", dir, ...what]);
    if (p.exitCode !== 0) throw new Error(`bsdtar ${name}: ${p.stderr.toString()}`);
  }
  // A layer that names one file twice, so its extracted length is not the size either header declares.
  if (!existsSync(join(out, "new-dup.tar"))) {
    const dup = join(tmp, "dup");
    mkdirSync(join(dup, "etc"), { recursive: true });
    writeFileSync(join(dup, "etc/dupfile"), "twice\n");
    const d = Bun.spawnSync(["bsdtar", "--uid", "0", "--gid", "0", "-cf", join(out, "new-dup.tar"), "-C", dup, "./etc/dupfile", "./etc/dupfile"]);
    if (d.exitCode !== 0) throw new Error(`bsdtar new-dup.tar: ${d.stderr.toString()}`);
  }
  // Members with no directory entries above them (implicit parents), and a name with a doubled slash (bsdtar writes it only with -P).
  if (!existsSync(join(out, "new-implicit.tar"))) {
    const imp = join(tmp, "implicit");
    mkdirSync(join(imp, "opt/svc"), { recursive: true });
    writeFileSync(join(imp, "opt/svc/start"), "#!/bin/sh\necho start\n");
    chmodSync(join(imp, "opt/svc/start"), 0o755);
    writeFileSync(join(imp, "opt/svc/zzz-setuid"), "#!/bin/sh\nid\n");
    chmodSync(join(imp, "opt/svc/zzz-setuid"), 0o4755);
    const m = Bun.spawnSync(["bsdtar", "--uid", "0", "--gid", "0", "-cf", join(out, "new-implicit.tar"), "-C", imp, "./opt/svc/start", "./opt/svc/zzz-setuid"]);
    if (m.exitCode !== 0) throw new Error(`bsdtar new-implicit.tar: ${m.stderr.toString()}`);
  }
  if (!existsSync(join(out, "new-slashes.tar"))) {
    const sl = join(tmp, "slashes");
    mkdirSync(join(sl, "etc"), { recursive: true });
    writeFileSync(join(sl, "etc/ld.so.preload"), "/lib/evil.so\n");
    const m = Bun.spawnSync(["bsdtar", "--uid", "0", "--gid", "0", "-P", "-cf", join(out, "new-slashes.tar"), "etc//ld.so.preload"], { cwd: sl });
    if (m.exitCode !== 0) throw new Error(`bsdtar new-slashes.tar: ${m.stderr.toString()}`);
  }
  // Layers holding only hard links, to files another layer holds (bsdtar writes a hard link only beside its target).
  const rawHardlinks = (file: string, links: [string, string][]) => {
    if (existsSync(join(out, file))) return;
    const blocks = links.map(([name, target]) => {
      const header = Buffer.alloc(512);
      header.write(name, 0);
      header.write("0000644\0", 100);
      header.write("0000000\0", 108);
      header.write("0000000\0", 116);
      header.write("00000000000\0", 124);
      header.write("00000000000\0", 136);
      header.write("        ", 148);
      header.write("1", 156);
      header.write(target, 157);
      header.write("ustar\0", 257);
      header.write("00", 263);
      let sum = 0;
      for (const b of header) sum += b;
      header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
      return header;
    });
    writeFileSync(join(out, file), Buffer.concat([...blocks, Buffer.alloc(1024)]));
  };
  rawHardlinks("w1-link.tar", [["etc/ld.so.preload", "opt/preload"]]);
  rawHardlinks("x1-link.tar", [
    ["var/cache/apt/mid", "var/cache/apt/data"],
    ["etc/ld.so.preload", "var/cache/apt/mid"],
  ]);
  // A layer whose member name climbs out of its directory, which bsdtar writes only with -P.
  const sub = join(tmp, "unsafe/sub");
  mkdirSync(sub, { recursive: true });
  writeFileSync(join(tmp, "unsafe/escape"), "x\n");
  const p = existsSync(join(out, "new-unsafe.tar")) ? { exitCode: 0, stderr: "" } : Bun.spawnSync(["bsdtar", "--uid", "0", "--gid", "0", "-P", "-cf", join(out, "new-unsafe.tar"), "../escape"], { cwd: sub });
  if (p.exitCode !== 0) throw new Error(`bsdtar new-unsafe.tar: ${p.stderr.toString()}`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
