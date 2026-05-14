"use server";

import { createClient } from "@/lib/supabase/server";
import { requireRole } from "@/lib/rbac";

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

// Compute day-of-week (0=Sun…6=Sat) in Istanbul time for a given YYYY-MM-DD.
// Uses noon (+03:00) as anchor to avoid any midnight DST ambiguity.
function getIstanbulDayOfWeek(dateIso: string): number {
  const d = new Date(`${dateIso}T12:00:00+03:00`);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Istanbul",
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

  const dow = getIstanbulDayOfWeek(dateIso);

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
  let breakPeriods: ShiftWindow[] = [];

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

  // ── Fetch confirmed appointments for this doctor on this date ─────────────
  const dayStartIso = `${dateIso}T00:00:00+03:00`;
  const dayEndIso   = `${dateIso}T23:59:59+03:00`;

  const { data: confirmedAppts } = doctorId
    ? await supabase
        .from("appointments")
        .select("scheduled_at, duration_minutes, status")
        .eq("doctor_id", doctorId)
        .eq("clinic_id", user.clinicId)
        .eq("status", "confirmed")
        .is("deleted_at", null)
        .gte("scheduled_at", dayStartIso)
        .lte("scheduled_at", dayEndIso)
    : { data: [] };

  // ── Also fetch pending appointments (for informational label only) ─────────
  const { data: pendingAppts } = doctorId
    ? await supabase
        .from("appointments")
        .select("scheduled_at, duration_minutes, status")
        .eq("doctor_id", doctorId)
        .eq("clinic_id", user.clinicId)
        .eq("status", "pending")
        .is("deleted_at", null)
        .gte("scheduled_at", dayStartIso)
        .lte("scheduled_at", dayEndIso)
    : { data: [] };

  // ── Build blocked ranges (confirmed + 15-min buffer) ─────────────────────
  const BUFFER_MIN = 15;
  type BlockedRange = { start: number; end: number };
  const blockedRanges: BlockedRange[] = (confirmedAppts ?? []).map((a) => {
    const apptStart = timeStrToMinutes(
      new Date(a.scheduled_at)
        .toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Istanbul" }),
    );
    const apptEnd = apptStart + (a.duration_minutes ?? 30);
    return { start: apptStart - BUFFER_MIN, end: apptEnd + BUFFER_MIN };
  });

  // ── Build pending ranges (informational only) ─────────────────────────────
  type PendingRange = { start: number; end: number };
  const pendingRanges: PendingRange[] = (pendingAppts ?? []).map((a) => {
    const apptStart = timeStrToMinutes(
      new Date(a.scheduled_at)
        .toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Istanbul" }),
    );
    return { start: apptStart, end: apptStart + (a.duration_minutes ?? 30) };
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

    // Check if slot has a pending appointment (informational warning only)
    const hasPending = pendingRanges.some((p) => t < p.end && slotEnd > p.start);
    if (hasPending) {
      slots.push({ time: timeStr, disabled: false, label: "Pending – may conflict" });
      continue;
    }

    slots.push({ time: timeStr, disabled: false });
  }

  return { slots };
}
