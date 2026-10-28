// Names an older deployment still uses. A target plugin (registry.ts) can give them so that its existing config files,
// broker and logs keep working; without one, the defaults here apply.

export interface Compat {
  /** Older config key names, old to current, accepted in the targets file and the eval config. */
  configKeys?: Record<string, string>;
  /** The approval broker client's default command and the environment variable that carries its base URL. */
  brokerClient?: { command?: string; baseUrlEnv?: string };
  /** The JSON keys of the two reviewers in a broker verdict. */
  verdictReviewerKeys?: { first: string; second: string };
  /** The previous updater's name in its log headers (the host report reads them; a host run writes "oupdate-<name>"). */
  previousUpdater?: string;
  /** Job runner commands the host apply names (never restarts) when its config sets no apply.jobRunners. */
  jobRunners?: string[];
}

export const DEFAULT_COMPAT = {
  brokerClient: { command: "broker-client", baseUrlEnv: "BROKER_BASE_URL" },
  verdictReviewerKeys: { first: "first", second: "second" },
  previousUpdater: "host-update",
} as const;

/**
 * A copy of a parsed JSON value with each object key that `keys` maps renamed to its current name, at every depth. A key
 * whose current name is also present is left as it is, so the strict parsers still report it.
 */
export function renameKeys(v: unknown, keys: Record<string, string> = {}): unknown {
  if (!Object.keys(keys).length) return v;
  if (Array.isArray(v)) return v.map((x) => renameKeys(x, keys));
  if (typeof v !== "object" || v === null) return v;
  const o = v as Record<string, unknown>;
  // fromEntries defines own properties, so a "__proto__" key stays a plain key.
  return Object.fromEntries(Object.entries(o).map(([k, x]) => [Object.hasOwn(keys, k) && !Object.hasOwn(o, keys[k]!) ? keys[k]! : k, renameKeys(x, keys)]));
}
