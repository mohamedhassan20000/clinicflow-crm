"use server";

import { createClient } from "@/lib/supabase/server";

export interface DoctorStat {
  name: string;
  total: number;
  confirmed: number;
  cancelled: number;
  other: number;
  revenue: number;
}

export async function fetchInsuranceBreakdown(
  clinicId: string,
  start: string,
  end: string,
): Promise<{ name: string; value: number }[]> {
  const supabase = await createClient();

  const { data } = await supabase
    .from("appointments")
    .select("insurance_provider_id, insurance_providers(name)")
    .eq("clinic_id", clinicId)
    .gte("scheduled_at", start)
    .lte("scheduled_at", end);

  const map = new Map<string, number>();
  for (const a of data ?? []) {
    const raw = a.insurance_providers as { name: string } | null;
    const name = raw?.name ?? "No insurance";
    map.set(name, (map.get(name) ?? 0) + 1);
  }

  return Array.from(map.entries())
    .map(([name, value]) => ({ name, value }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 8);
}

export async function fetchDoctorStats(
  clinicId: string,
  start: string,
  end: string,
): Promise<DoctorStat[]> {
  const supabase = await createClient();

  const [{ data: doctors }, { data: appts }] = await Promise.all([
    supabase
      .from("profiles")
      .select("id, full_name")
      .eq("clinic_id", clinicId)
      .eq("role", "doctor")
      .eq("is_active", true),
    supabase
      .from("appointments")
      .select("doctor_id, status, paid_amount, insurance_amount, secondary_amount")
      .eq("clinic_id", clinicId)
      .gte("scheduled_at", start)
      .lte("scheduled_at", end),
  ]);

  const statsMap = new Map<string, DoctorStat>();
  for (const doc of doctors ?? []) {
    statsMap.set(doc.id, {
      name: doc.full_name,
      total: 0,
      confirmed: 0,
      cancelled: 0,
      other: 0,
      revenue: 0,
    });
  }

  for (const a of appts ?? []) {
    const entry = statsMap.get(a.doctor_id);
    if (!entry) continue;
    entry.total++;
    if (a.status === "confirmed") entry.confirmed++;
    else if (a.status === "cancelled") entry.cancelled++;
    else entry.other++;
    if (a.status === "completed") {
      entry.revenue +=
        (a.paid_amount ?? 0) +
        (a.insurance_amount ?? 0) +
        (a.secondary_amount ?? 0);
    }
  }

  return Array.from(statsMap.values()).sort((a, b) => b.total - a.total);
}

export async function fetchAppointmentsSeries(
  clinicId: string,
  start: string,
  end: string,
): Promise<{ date: string; appointments: number }[]> {
  const supabase = await createClient();

  const { data } = await supabase
    .from("appointments")
    .select("scheduled_at")
    .eq("clinic_id", clinicId)
    .gte("scheduled_at", start)
    .lte("scheduled_at", end)
    .not("status", "eq", "cancelled");

  const map = new Map<string, number>();
  const current = new Date(start);
  current.setHours(0, 0, 0, 0);
  const endDate = new Date(end);

  while (current <= endDate) {
    const key = current.toLocaleDateString("en-US", {
      timeZone: "Europe/Istanbul",
      month: "short",
      day: "numeric",
    });
    map.set(key, 0);
    current.setDate(current.getDate() + 1);
  }

  for (const a of data ?? []) {
    const key = new Date(a.scheduled_at).toLocaleDateString("en-US", {
      timeZone: "Europe/Istanbul",
      month: "short",
      day: "numeric",
    });
    if (map.has(key)) map.set(key, (map.get(key) ?? 0) + 1);
  }

  return Array.from(map.entries()).map(([date, appointments]) => ({
    date,
    appointments,
  }));
}
