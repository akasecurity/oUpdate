// A PEP 440 version in the one spelling its equals share, or undefined when it is not a version: "1.0" and "1.0.0" are
// one release, "1.0-1" is "1.0.post1", "1.0RC1" is "1.0rc1". Used to compare a release's version with the one a
// file name carries. The result is a comparison key, not the canonical display form (trailing release zeros are cut).
const VERSION = new RegExp(
  "^\\s*v?(?:(?:(\\d+)!)?(\\d+(?:\\.\\d+)*)" +
    "([-_.]?(alpha|a|beta|b|preview|pre|c|rc)[-_.]?(\\d+)?)?" +
    "((?:-(\\d+))|(?:[-_.]?(post|rev|r)[-_.]?(\\d+)?))?" +
    "([-_.]?(dev)[-_.]?(\\d+)?)?)" +
    "(?:\\+([a-z0-9]+(?:[-_.][a-z0-9]+)*))?\\s*$",
  "i",
);

const PRE: Record<string, string> = { alpha: "a", a: "a", beta: "b", b: "b", c: "rc", pre: "rc", preview: "rc", rc: "rc" };

export function normalizeVersion(text: string): string | undefined {
  const m = VERSION.exec(text);
  if (!m) return undefined;
  const num = (s: string | undefined) => String(BigInt(s ?? "0"));
  const release = m[2]!.split(".").map(num);
  while (release.length > 1 && release[release.length - 1] === "0") release.pop();
  const parts = [`${num(m[1])}!${release.join(".")}`];
  if (m[4]) parts.push(`${PRE[m[4].toLowerCase()]}${num(m[5])}`);
  if (m[6]) parts.push(`post${num(m[7] ?? m[9])}`);
  if (m[11]) parts.push(`dev${num(m[12])}`);
  if (m[13]) parts.push(`+${m[13].toLowerCase().split(/[-_.]/).map((p) => (/^\d+$/.test(p) ? num(p) : p)).join(".")}`);
  return parts.join(".");
}
