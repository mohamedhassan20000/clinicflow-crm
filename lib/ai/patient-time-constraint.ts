function westernDigits(value: string): string {
  return value
    .replace(/[٠-٩]/g, (digit) => String(digit.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (digit) => String(digit.charCodeAt(0) - 0x06f0));
}

/** Resolve a patient-facing lower time bound without committing a booking time. */
export function parsePatientAfterTime(value: string | null | undefined): number | null {
  const text = westernDigits((value ?? "").trim().toLocaleLowerCase());
  const match = /(?:بعد|after)?\s*(?:الساعة|at)?\s*(\d{1,2})(?:[:.]([0-5]\d))?\s*(ص|صباحا|صباحًا|am|م|مساء|مساءً|pm)?/i.exec(text);
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = Number(match[2] ?? 0);
  const period = match[3]?.toLocaleLowerCase() ?? "";
  if (hour > 23) return null;
  if (/^(?:م|مساء|مساءً|pm)$/.test(period) && hour < 12) hour += 12;
  if (/^(?:ص|صباحا|صباحًا|am)$/.test(period) && hour === 12) hour = 0;
  // In ordinary Arabic clinic speech, an unqualified "after 2/5" means PM.
  if (!period && hour >= 1 && hour <= 7) hour += 12;
  return hour * 60 + minute;
}

export function filterSlotsAfter(
  slots: readonly string[],
  afterMinutes: number | null,
): string[] {
  if (afterMinutes === null) return [...slots];
  return slots.filter((slot) => {
    const match = /^(\d{2}):(\d{2})$/.exec(slot);
    if (!match) return false;
    return Number(match[1]) * 60 + Number(match[2]) > afterMinutes;
  });
}
