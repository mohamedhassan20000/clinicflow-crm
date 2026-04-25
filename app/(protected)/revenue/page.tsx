import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { ChevronLeft } from "lucide-react";
import { requireUser } from "@/lib/rbac";
import { createClient } from "@/lib/supabase/server";
import { RevenueReport } from "@/components/revenue/revenue-report";
import {
  PrintButton,
  PrintSettlementsButton,
} from "@/components/revenue/print-button";

export const metadata: Metadata = { title: "Revenue transactions" };

type PresetKey = "today" | "week" | "this_month" | "last_month" | "last_year" | "custom";

// ─── date helpers (Europe/Istanbul) ─────────────────────────────────────────
function toIstanbul(date: Date): Date {
  return new Date(date.toLocaleString("en-US", { timeZone: "Europe/Istanbul" }));
}

function startOfDay(d: Date): Date {
  const n = new Date(d);
  n.setHours(0, 0, 0, 0);
  return n;
}
function endOfDay(d: Date): Date {
  const n = new Date(d);
  n.setHours(23, 59, 59, 999);
  return n;
}
function fmtInput(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function resolveRange(preset: PresetKey, from?: string, to?: string) {
  const now = toIstanbul(new Date());
  if (preset === "custom" && from && to) {
    return {
      start: startOfDay(new Date(from)),
      end: endOfDay(new Date(to)),
    };
  }
  switch (preset) {
    case "today": {
      return { start: startOfDay(now), end: endOfDay(now) };
    }
    case "week": {
      const day = now.getDay();
      const diff = day === 0 ? -6 : 1 - day;
      const mon = new Date(now);
      mon.setDate(mon.getDate() + diff);
      const sun = new Date(mon);
      sun.setDate(sun.getDate() + 6);
      return { start: startOfDay(mon), end: endOfDay(sun) };
    }
    case "last_month": {
      const first = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const last = new Date(now.getFullYear(), now.getMonth(), 0);
      return { start: startOfDay(first), end: endOfDay(last) };
    }
    case "last_year": {
      const first = new Date(now.getFullYear() - 1, 0, 1);
      const last = new Date(now.getFullYear() - 1, 11, 31);
      return { start: startOfDay(first), end: endOfDay(last) };
    }
    case "this_month":
    default: {
      const first = new Date(now.getFullYear(), now.getMonth(), 1);
      const last = new Date(now.getFullYear(), now.getMonth() + 1, 0);
      return { start: startOfDay(first), end: endOfDay(last) };
    }
  }
}

interface PageProps {
  searchParams: Promise<{
    preset?: string;
    from?: string;
    to?: string;
  }>;
}

export default async function RevenuePage({ searchParams }: PageProps) {
  const user = await requireUser();
  if (user.role === "receptionist") redirect("/dashboard");

  const sp = await searchParams;
  const preset = (sp.preset as PresetKey) ?? "this_month";
  const range = resolveRange(preset, sp.from, sp.to);

  const supabase = await createClient();

  const [{ data: rows }, { data: settlements }] = await Promise.all([
    supabase
      .from("appointments")
      .select(
        "id, scheduled_at, paid_at, total_amount, paid_amount, insurance_amount, secondary_amount, outstanding_amount, payment_method, secondary_payment_method, payment_note, patients(full_name), profiles!doctor_id(full_name), departments(name, color), insurance_providers(name)",
      )
      .eq("clinic_id", user.clinicId)
      .eq("status", "completed")
      .gte("paid_at", range.start.toISOString())
      .lte("paid_at", range.end.toISOString())
      .order("paid_at", { ascending: false }),
    supabase
      .from("outstanding_settlements")
      .select(
        "id, settled_at, amount, payment_method, note, patient:patients(full_name), appointment:appointments(id, scheduled_at, total_amount, outstanding_amount, profiles!doctor_id(full_name), departments(name, color))",
      )
      .eq("clinic_id", user.clinicId)
      .gte("settled_at", range.start.toISOString())
      .lte("settled_at", range.end.toISOString())
      .order("settled_at", { ascending: false }),
  ]);

  const { data: clinic } = await supabase
    .from("clinics")
    .select("name, address, phone")
    .eq("id", user.clinicId)
    .single();

  const fromInput = sp.from ?? fmtInput(range.start);
  const toInput = sp.to ?? fmtInput(range.end);

  return (
    <div className="space-y-6">
      {/* Header — hidden in print */}
      <div className="print:hidden flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Link
            href="/dashboard"
            className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            <ChevronLeft className="h-4 w-4" />
            Dashboard
          </Link>
          <h1 className="text-2xl font-semibold tracking-tight">
            Revenue &amp; Transactions
          </h1>
        </div>
        <div className="flex items-center gap-2">
          <PrintSettlementsButton
            disabled={(settlements ?? []).length === 0}
          />
          <PrintButton />
        </div>
      </div>

      <RevenueReport
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        rows={(rows ?? []) as any}
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        settlements={(settlements ?? []) as any}
        range={{
          start: range.start.toISOString(),
          end: range.end.toISOString(),
        }}
        preset={preset}
        fromInput={fromInput}
        toInput={toInput}
        clinicName={clinic?.name ?? "ClinicFlow"}
        clinicAddress={clinic?.address ?? null}
        clinicPhone={clinic?.phone ?? null}
      />
    </div>
  );
}

