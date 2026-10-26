// The NAS verbs oupdate asks the broker for (CRB-b128 design rev 3d §2): each read verb's typed slots, answer cap and
// deadline, and each write verb's deadline. The caller checks every slot against its anchored rule before a request, so
// no value outside its rule leaves the runner; the broker and the NAS script check again.

export const SLOT = {
  ref: /^[a-z0-9][a-z0-9./_:@-]{0,199}$/,
  service: /^[a-z0-9][a-z0-9_-]{0,63}$/,
  id: /^sha256:[0-9a-f]{64}$/,
  sha256: /^[0-9a-f]{64}$/,
  digest: /^sha256:[0-9a-f]{64}$/,
  copy: /^[A-Za-z0-9]{6,16}$/,
  plugin: /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/,
  which: /^(old|new)$/,
};
export type SlotName = keyof typeof SLOT;

export type ReadVerb = "self" | "compose.state" | "image.evidence" | "image.candidate" | "plugin.check" | "plugin.file" | "os.version";
export type WriteVerb = "compose.apply" | "image.prune" | "plugin.update";

export interface VerbSpec {
  slots: SlotName[];
  capBytes: number;
  deadlineS: number;
}

const KIB = 1024;
export const READ_VERBS: Record<ReadVerb, VerbSpec> = {
  self: { slots: [], capBytes: 4 * KIB, deadlineS: 10 },
  "compose.state": { slots: [], capBytes: 16 * KIB, deadlineS: 30 },
  "image.evidence": { slots: ["id"], capBytes: 64 * KIB, deadlineS: 30 },
  "image.candidate": { slots: ["ref"], capBytes: 64 * KIB, deadlineS: 60 },
  // Open question O-4, answered by the design's rev 3e §2.2: 64 KiB and 180 s (plugin checkall reaches the network).
  "plugin.check": { slots: [], capBytes: 64 * KIB, deadlineS: 180 },
  "plugin.file": { slots: ["plugin", "which", "copy"], capBytes: 352 * KIB, deadlineS: 10 },
  "os.version": { slots: [], capBytes: 1 * KIB, deadlineS: 5 },
};

export const WRITE_VERBS: Record<WriteVerb, { deadlineS: number }> = {
  "compose.apply": { deadlineS: 1500 },
  "image.prune": { deadlineS: 120 },
  "plugin.update": { deadlineS: 600 },
};

/** The OS itself (unRAIDServer*, any case): never a slot value, never updated by a leg. */
export const isOsPlugin = (name: string): boolean => /^unraidserver/i.test(name);

/** Why these slots are refused for the verb, or undefined when every slot is present, known and inside its rule. */
export function checkSlots(verb: ReadVerb, slots: Record<string, string>): string | undefined {
  const want = READ_VERBS[verb].slots;
  const keys = Object.keys(slots);
  if (keys.length !== want.length || !want.every((k) => Object.hasOwn(slots, k))) return `${verb} takes slots ${want.join(", ") || "none"}`;
  for (const k of want) {
    const v = slots[k]!;
    if (!SLOT[k].test(v)) return `${verb}: slot ${k} is not valid: ${JSON.stringify(v.slice(0, 80))}`;
    if (k === "plugin" && isOsPlugin(v)) return `${verb}: plugin ${v} is the OS, never touched`;
  }
  return undefined;
}
