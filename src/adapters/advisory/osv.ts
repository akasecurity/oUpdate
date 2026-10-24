// OSV advisory feed: one querybatch for the inventory, then one GET per
// distinct vuln id for severity and fixed versions. Any HTTP error throws:
// a failed lookup must never read as "no advisories".

export interface PackageRef {
  ecosystem: string; // OSV ecosystem name: npm, PyPI, Go, crates.io, SwiftURL
  name: string;
  version: string;
}

export interface Advisory {
  pkg: PackageRef;
  id: string;
  summary: string;
  severity: string; // critical | high | moderate | low | unknown
  fixed: string[];
  published?: string;
  // Known malicious package (an OpenSSF MAL- entry, by id or alias), not a vulnerability.
  malicious: boolean;
}

export interface AdvisoryFeed {
  query(pkgs: PackageRef[]): Promise<Advisory[]>;
}

interface OsvVuln {
  id: string;
  summary?: string;
  aliases?: string[];
  published?: string;
  database_specific?: { severity?: string };
  affected?: { package?: { ecosystem?: string; name?: string }; ranges?: { events?: { fixed?: string }[] }[] }[];
}

// Entries for malware that carry no MAL- alias (older PYSEC, some GHSA). Narrow on
// purpose: "malicious input" or "maliciously crafted" describes a vulnerability.
const MALWARE_WORDING = /\bmalware\b|\b(contain(s|ed)?|embedded|with) malicious (code|software|crypto)|crypto ?miner|backdoor/i;

const BATCH = 1000;

export function osvFeed(deps: { fetch?: typeof fetch; base?: string } = {}): AdvisoryFeed {
  const f = deps.fetch ?? fetch;
  const base = deps.base ?? "https://api.osv.dev/v1";
  const details = new Map<string, Promise<OsvVuln>>();
  const detail = (id: string) => {
    let p = details.get(id);
    if (!p) {
      p = (async () => {
        const r = await f(`${base}/vulns/${encodeURIComponent(id)}`);
        if (!r.ok) throw new Error(`osv ${r.status} for vuln ${id}`);
        return (await r.json()) as OsvVuln;
      })();
      details.set(id, p);
    }
    return p;
  };

  return {
    async query(pkgs) {
      const out: Advisory[] = [];
      for (let i = 0; i < pkgs.length; i += BATCH) {
        const chunk = pkgs.slice(i, i + BATCH);
        const r = await f(`${base}/querybatch`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ queries: chunk.map((p) => ({ package: { ecosystem: p.ecosystem, name: p.name }, version: p.version })) }),
        });
        if (!r.ok) throw new Error(`osv ${r.status} for querybatch`);
        const body = (await r.json()) as { results?: { vulns?: { id: string }[] }[] };
        const results = body.results ?? [];
        if (results.length !== chunk.length) throw new Error(`osv querybatch returned ${results.length} results for ${chunk.length} queries`);
        for (let j = 0; j < chunk.length; j++) {
          const pkg = chunk[j]!;
          for (const { id } of results[j]!.vulns ?? []) {
            const v = await detail(id);
            const fixed = new Set<string>();
            for (const a of v.affected ?? []) {
              if (a.package?.name !== pkg.name || a.package?.ecosystem !== pkg.ecosystem) continue;
              for (const rg of a.ranges ?? []) for (const e of rg.events ?? []) if (e.fixed) fixed.add(e.fixed);
            }
            out.push({
              pkg,
              id: v.id,
              summary: v.summary ?? "",
              severity: (v.database_specific?.severity ?? "unknown").toLowerCase(),
              fixed: [...fixed],
              malicious: [v.id, ...(v.aliases ?? [])].some((x) => x.startsWith("MAL-")) || MALWARE_WORDING.test(v.summary ?? ""),
              ...(v.published ? { published: v.published } : {}),
            });
          }
        }
      }
      return out;
    },
  };
}
