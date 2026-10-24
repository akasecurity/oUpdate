// Routine updates wait `days` after publication; advisory fixes skip the wait.
// An unknown or future publish time is held: the age gate fails closed.

export interface CooldownInput {
  publishedAt: Date | undefined;
  now: Date;
  days: number;
  advisoryFix: boolean;
}

export interface CooldownVerdict {
  eligible: boolean;
  ageHours: number | undefined;
  reason: string;
}

export function cooldownVerdict({ publishedAt, now, days, advisoryFix }: CooldownInput): CooldownVerdict {
  const ageHours = publishedAt ? (now.getTime() - publishedAt.getTime()) / 3_600_000 : undefined;
  if (advisoryFix) {
    return { eligible: true, ageHours, reason: "advisory fix: cooldown skipped" };
  }
  if (ageHours === undefined || Number.isNaN(ageHours)) {
    return { eligible: false, ageHours, reason: "held: publish time unknown" };
  }
  if (ageHours < 0) {
    return { eligible: false, ageHours, reason: "held: publish time is in the future" };
  }
  if (ageHours < days * 24) {
    return { eligible: false, ageHours, reason: `held: ${ageHours.toFixed(1)} h old, cooldown ${days} d` };
  }
  return { eligible: true, ageHours, reason: `eligible: ${(ageHours / 24).toFixed(1)} d old` };
}
