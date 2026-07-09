"use server";

import { fromZonedTime } from "date-fns-tz";
import { createClient } from "@/lib/supabase/server";
import { requireRole } from "@/lib/rbac";
import { DEFAULT_TIME_ZONE } from "@/lib/datetime";

export type SlotInfo = {
  time: string;      // "HH:MM"
  disabled: boolean;
  label?: string;    // "Break" | "Pending – may conflict"
};

type ShiftWindow = { start: number; end: number }; // minutes since midnight

function timeStrToMinutes(t: string): number {
  const [h, m] = t.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

function getClinicDayOfWeek(dateIso: string, timeZone: string): number {
  const d = fromZonedTime(`${dateIso}T12:00:00`, timeZone);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
  }).formatToParts(d);
  const day = parts.find((p) => p.type === "weekday")?.value ?? "Sun";
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(day);
}

export async function getAvailableTimeSlots(
  doctorId: string | null,
  dateIso: string, // "YYYY-MM-DD"
): Promise<{ slots: SlotInfo[]; error?: string }> {
  const user = await requireRole(["admin", "receptionist"]);
  const supabase = await createClient();

  const { data: clinic } = await supabase
    .from("clinics")
    .select("timezone")
    .eq("id", user.clinicId)
    .maybeSingle();
  const timeZone =
    typeof clinic?.timezone === "string" && clinic.timezone
      ? clinic.timezone
      : DEFAULT_TIME_ZONE;

  const dow = getClinicDayOfWeek(dateIso, timeZone);

  // ── Fetch doctor schedule + clinic hours in parallel ──────────────────────
  const [doctorResult, clinicResult] = await Promise.all([
    doctorId
      ? supabase
          .from("doctor_schedules")
          .select("start_time, end_time")
          .eq("doctor_id", doctorId)
          .eq("clinic_id", user.clinicId)
          .eq("day_of_week", dow)
          .maybeSingle()
      : Promise.resolve({ data: null, error: null }),

    supabase
      .from("clinic_working_hours")
      .select("shift_start, shift_end")
      .eq("clinic_id", user.clinicId)
      .eq("day_of_week", dow)
      .order("shift_start"),
  ]);

  // ── Determine active windows (fallback chain) ─────────────────────────────
  let windows: ShiftWindow[];
  const breakPeriods: ShiftWindow[] = [];

  if (doctorResult.data) {
    // Doctor has a specific schedule for this day
    windows = [
      {
        start: timeStrToMinutes((doctorResult.data.start_time as string).slice(0, 5)),
        end:   timeStrToMinutes((doctorResult.data.end_time as string).slice(0, 5)),
      },
    ];
  } else if (clinicResult.data && clinicResult.data.length > 0) {
    // Use clinic shifts; gaps between them are break periods
    const shifts = clinicResult.data.map((r) => ({
      start: timeStrToMinutes((r.shift_start as string).slice(0, 5)),
      end:   timeStrToMinutes((r.shift_end as string).slice(0, 5)),
    }));
    windows = shifts;

    // Gaps between consecutive shifts = break periods
    for (let i = 0; i < shifts.length - 1; i++) {
      const gapStart = shifts[i]!.end;
      const gapEnd   = shifts[i + 1]!.start;
      if (gapEnd > gapStart) {
        breakPeriods.push({ start: gapStart, end: gapEnd });
      }
    }
  } else {
    // Hard fallback: 08:00–18:00 (matches the old TIME_SLOTS constant)
    windows = [{ start: 8 * 60, end: 18 * 60 }];
  }

  // ── Fetch active appointments for this doctor on this date ────────────────
  const dayStartIso = fromZonedTime(`${dateIso}T00:00:00.000`, timeZone)
    .toISOString();
  const dayEndIso = fromZonedTime(`${dateIso}T23:59:59.999`, timeZone)
    .toISOString();

  const { data: activeAppts } = doctorId
    ? await supabase
        .from("appointments")
        .select("scheduled_at, duration_minutes, status")
        .eq("doctor_id", doctorId)
        .eq("clinic_id", user.clinicId)
        .in("status", ["confirmed", "arrived", "in_session"])
        .is("deleted_at", null)
        .gte("scheduled_at", dayStartIso)
        .lte("scheduled_at", dayEndIso)
    : { data: [] };

  // ── Build blocked ranges (active appointments + 15-min buffer) ───────────
  const BUFFER_MIN = 15;
  type BlockedRange = { start: number; end: number };
  const blockedRanges: BlockedRange[] = (activeAppts ?? []).map((a) => {
    const apptStart = timeStrToMinutes(
      new Date(a.scheduled_at)
        .toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone }),
    );
    const apptEnd = apptStart + (a.duration_minutes ?? 30);
    return { start: apptStart - BUFFER_MIN, end: apptEnd + BUFFER_MIN };
  });

  // ── Generate slots ────────────────────────────────────────────────────────
  const STEP = 15;
  const slots: SlotInfo[] = [];

  // Collect all slot times that fall within any active window
  const overallStart = Math.min(...windows.map((w) => w.start));
  const overallEnd   = Math.max(...windows.map((w) => w.end));

  for (let t = overallStart; t < overallEnd; t += STEP) {
    const slotEnd = t + STEP;

    // Check if this slot is inside any active window
    const inWindow = windows.some((w) => t >= w.start && slotEnd <= w.end);

    // Check if this slot is inside a break gap
    const inBreak = breakPeriods.some((b) => t >= b.start && slotEnd <= b.end);

    if (!inWindow && !inBreak) continue; // Outside all windows and not a break gap — skip entirely

    const h = String(Math.floor(t / 60)).padStart(2, "0");
    const m = String(t % 60).padStart(2, "0");
    const timeStr = `${h}:${m}`;

    if (inBreak) {
      slots.push({ time: timeStr, disabled: true, label: "Break" });
      continue;
    }

    // Check if slot overlaps a blocked (confirmed) range
    const isBlocked = blockedRanges.some((b) => t < b.end && slotEnd > b.start);
    if (isBlocked) {
      slots.push({ time: timeStr, disabled: true });
      continue;
    }

    slots.push({ time: timeStr, disabled: false });
  }

  return { slots };
}
