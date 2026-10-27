import { expect, test } from "bun:test";
import { dropAllowed, ossScanText, parseAllow } from "../scripts/oss-scan.ts";

const rules = (t: string) => ossScanText("f", t).map((f) => f.rule);

test("flags host names, gitea addresses and secrets", () => {
  expect(rules("ssh host-a")).toContain("host-value");
  expect(rules('const h = ["host-a", "host-b"]')).toContain("host-quoted");
  expect(rules("url = foo.example-tailnet.ts.net")).toContain("tailnet-domain");
  expect(rules("git@nas:org/repo.git")).toContain("gitea-nas");
  expect(rules("-----BEGIN OPENSSH PRIVATE KEY-----")).toContain("private-key");
  expect(rules(`t = "ghp_${"a".repeat(36)}"`)).toContain("github-token");
  expect(rules("mail me@gmail.com")).toContain("email");
});

test("leaves ordinary words, placeholders and reserved emails alone", () => {
  expect(rules("no brew on this host: nothing to check")).toEqual([]);
  expect(rules('x ?? "nothing"')).toEqual([]);
  expect(rules('apiKey = "your-key-goes-here-1234"')).toEqual([]);
  expect(rules("me@example.com")).toEqual([]);
});

test(".publish-allow drops only a matching rule and exact path", () => {
  const allow = parseAllow("# fixtures\nemail\ttest/a.json\n*\tdata/b.txt\n");
  const f = (file: string, rule: string) => ({ file, line: 1, rule });
  const kept = dropAllowed([f("test/a.json", "email"), f("test/a.json", "github-token"), f("data/b.txt", "host-quoted"), f("test/c.json", "email")], allow);
  expect(kept.map((k) => `${k.file} ${k.rule}`)).toEqual(["test/a.json github-token", "test/c.json email"]);
});
