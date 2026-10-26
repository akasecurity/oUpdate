// What a pin group's source says about its pins: current, a newer value set with its evidence, held
// (not proposed, not trouble: e.g. the latest is a prerelease or its snapshot is not published yet),
// or an error (trouble: the source failed or gave something that cannot be a pin).

export const PLAIN_VERSION = /^\d+\.\d+\.\d+$/;

export type Discovery =
  | { state: "current"; group: string; version: string; note?: string }
  | {
      state: "newer";
      group: string;
      from: string;
      to: string;
      /** When the new release was published or built; undefined holds it (cooldown fails closed). */
      publishedAt: Date | undefined;
      /** Every key the bump changes, with its new value. */
      values: Record<string, string>;
      /** Where each value was read, one line each, for the log, the reviewer and the proposal. */
      evidence: string[];
      propose: boolean;
      note?: string;
    }
  | { state: "held"; group: string; why: string }
  | { state: "error"; group: string; why: string };
