// The broker-script verbs oupdate asks the broker for: each read verb's typed slots, answer cap and
// deadline, and each write verb's deadline. The caller checks every slot against its anchored rule before a request, so
// no value outside its rule leaves the runner; the broker and the target's script check again.

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
  // 64 KiB and 180 s (plugin checkall reaches the network).
  "plugin.check": { slots: [], capBytes: 64 * KIB, deadlineS: 180 },
  "plugin.file": { slots: ["plugin", "which", "copy"], capBytes: 352 * KIB, deadlineS: 10 },
  "os.version": { slots: [], capBytes: 1 * KIB, deadlineS: 5 },
};

export const WRITE_VERBS: Record<WriteVerb, { deadlineS: number }> = {
  "compose.apply": { deadlineS: 1500 },
  "image.prune": { deadlineS: 120 },
  "plugin.update": { deadlineS: 600 },
};

/** A target plugin's extra refusal for a slot value: why it is refused, or undefined. */
export type SlotGuard = (slot: SlotName, value: string) => string | undefined;
const SLOT_GUARDS: SlotGuard[] = [];
/** Adds a refusal every later checkSlots applies (once per guard). */
export function addSlotGuard(g: SlotGuard): void {
  if (!SLOT_GUARDS.includes(g)) SLOT_GUARDS.push(g);
}

/** Why these slots are refused for the verb, or undefined when every slot is present, known and inside its rule. */
export function checkSlots(verb: ReadVerb, slots: Record<string, string>): string | undefined {
  const want = READ_VERBS[verb].slots;
  const keys = Object.keys(slots);
  if (keys.length !== want.length || !want.every((k) => Object.hasOwn(slots, k))) return `${verb} takes slots ${want.join(", ") || "none"}`;
  for (const k of want) {
    const v = slots[k]!;
    if (!SLOT[k].test(v)) return `${verb}: slot ${k} is not valid: ${JSON.stringify(v.slice(0, 80))}`;
    for (const g of SLOT_GUARDS) {
      const why = g(k, v);
      if (why) return `${verb}: ${why}`;
    }
  }
  return undefined;
}
