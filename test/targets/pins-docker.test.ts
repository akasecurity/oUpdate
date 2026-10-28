// The Docker CLI static index: a newer stable tarball is reported and never proposed. No network.
import { describe, expect, test } from "bun:test";
import { discoverDocker, newestDockerTgz, type DockerIndexSource } from "../../src/targets/pins/docker.ts";
import type { DockerStaticGroup } from "../../src/targets/pins/config.ts";

const G: DockerStaticGroup = {
  source: "docker-static",
  name: "docker-cli",
  versionKey: "DOCKER_CLI_VERSION",
  assetKey: "DOCKER_CLI_ASSET",
  shaKey: "DOCKER_CLI_SHA256",
  propose: false,
  note: "no upstream sums",
};
const CUR = new Map([["DOCKER_CLI_VERSION", "29.9.2"]]);
const INDEX = `
<a href="docker-29.9.2.tgz">docker-29.9.2.tgz</a>
<a href="docker-30.0.0-rc.1.tgz">docker-30.0.0-rc.1.tgz</a>
<a href="docker-29.9.3.tgz">docker-29.9.3.tgz</a>
<a href="docker-28.0.0.tgz">docker-28.0.0.tgz</a>
`;
const src = (listing: string | Error): DockerIndexSource => ({
  listing: async () => {
    if (listing instanceof Error) throw listing;
    return listing;
  },
});
const link = (name: string) => `<a href="${name}">${name}</a>`;

describe("docker static pins", () => {
  test("newestDockerTgz skips a prerelease and a non-tarball name", () => {
    expect(newestDockerTgz(INDEX)).toBe("29.9.3");
    expect(newestDockerTgz("no tarballs here")).toBeUndefined();
    expect(newestDockerTgz("docker-1.2.3.tgz.sha256\ndocker-1.2.4.tgz")).toBeUndefined();
  });

  test("only a same-directory href of docker-X.Y.Z.tgz counts", () => {
    const listing = [
      "docker-99.0.0.tgz",
      '<a href="../docker-98.0.0.tgz">parent</a>',
      '<a href="/mac/static/stable/aarch64/docker-97.0.0.tgz">abs</a>',
      '<a href="https://download.docker.com/mac/static/stable/aarch64/docker-96.0.0.tgz">url</a>',
      '<a href="subdir/docker-95.0.0.tgz">sub</a>',
      '<a href="docker-94.0.0.tgz?C=M">query</a>',
      '<a href="docker-30.0.0-rc.1.tgz">rc</a>',
      '<a href="docker-01.2.3.tgz">leading zero</a>',
      '<a href="docker-1.2.tgz">short</a>',
      '<a href="docker-1.2.3.tgz.sha256">sums</a>',
      '<a href="docker-29.9.3.tgz">file</a>',
      "<a href='docker-29.9.4.tgz'>quoted</a>",
    ].join("\n");
    expect(newestDockerTgz(listing)).toBe("29.9.4");
  });

  test("a newer stable tarball is reported and not proposed", async () => {
    const d = await discoverDocker(G, CUR, src(INDEX));
    expect(d).toMatchObject({
      state: "newer",
      group: "docker-cli",
      from: "29.9.2",
      to: "29.9.3",
      publishedAt: undefined,
      propose: false,
      note: "no upstream sums",
      values: { DOCKER_CLI_VERSION: "29.9.3" },
    });
    if (d.state !== "newer") throw new Error("not newer");
    expect(d.values).toEqual({ DOCKER_CLI_VERSION: "29.9.3" });
    expect(d.evidence[0]).toBe("docker static index docker-29.9.3.tgz (29.9.2 -> 29.9.3); no upstream sums, not proposed");
  });

  test("the pinned or an older tarball is current; an empty index or a failed fetch is an error", async () => {
    expect(await discoverDocker(G, CUR, src(link("docker-29.9.2.tgz")))).toEqual({ state: "current", group: "docker-cli", version: "29.9.2" });
    expect(await discoverDocker(G, CUR, src(link("docker-29.9.1.tgz")))).toEqual({ state: "current", group: "docker-cli", version: "29.9.2", note: "newest docker 29.9.1 is not newer than the pin" });
    expect(await discoverDocker(G, CUR, src(link("docker-30.0.0-rc.1.tgz")))).toEqual({ state: "error", group: "docker-cli", why: "no stable docker-<semver>.tgz on the index" });
    expect(await discoverDocker(G, CUR, src(new Error("HTTP 503")))).toEqual({ state: "error", group: "docker-cli", why: "docker static index: HTTP 503" });
    expect(await discoverDocker(G, new Map(), src(INDEX))).toEqual({ state: "error", group: "docker-cli", why: "DOCKER_CLI_VERSION is empty" });
  });
});
