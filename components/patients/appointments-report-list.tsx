"use client";

import { useState } from "react";
import { ChevronsDownUp, ChevronsUpDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  AppointmentPaymentRow,
  type AppointmentPaymentRowData,
  type SettlementEntry,
} from "@/components/patients/appointment-payment-row";
import { DEFAULT_TIME_ZONE } from "@/lib/datetime";
import { formatDoctorName } from "@/lib/format-doctor";
import { useClinicSettings } from "@/contexts/clinic-settings-context";

interface Props {
  appointments: AppointmentPaymentRowData[];
  settlementsByAppt: Record<string, SettlementEntry[]>;
}

export function AppointmentsReportList({ appointments, settlementsByAppt }: Props) {
  const { formatCurrency } = useClinicSettings();
  const fmtMoney = (n: number) => formatCurrency(n);
  const [openIds, setOpenIds] = useState<Set<string>>(new Set());

  const completedIds = appointments
    .filter((a) => a.status === "completed")
    .map((a) => a.id);

  function expandAll() {
    setOpenIds(new Set(completedIds));
  }

  function collapseAll() {
    setOpenIds(new Set());
  }

  function toggle(id: string, next: boolean) {
    setOpenIds((prev) => {
      const s = new Set(prev);
      if (next) s.add(id);
      else s.delete(id);
      return s;
    });
  }

  if (appointments.length === 0) {
    return (
      <>
        <div className="rounded-xl border border-dashed border-border/60 bg-muted/20 px-6 py-12 text-center text-sm text-muted-foreground print:hidden">
          No appointments match the selected date range.
        </div>
        <p className="hidden text-sm print:block">
          No appointments match the selected date range.
        </p>
      </>
    );
  }

  return (
    <>
      <div className="space-y-3 print:hidden">
        {completedIds.length > 0 && (
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              className="h-7 gap-1.5 px-3 text-xs"
              onClick={expandAll}
            >
              <ChevronsUpDown className="h-3 w-3" />
              Expand all
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-7 gap-1.5 px-3 text-xs"
              onClick={collapseAll}
            >
              <ChevronsDownUp className="h-3 w-3" />
              Collapse all
            </Button>
            <span className="text-xs text-muted-foreground">
              {completedIds.length} completed appointment
              {completedIds.length !== 1 ? "s" : ""}
            </span>
          </div>
        )}
        <div className="rounded-xl border border-border/50 bg-card overflow-hidden">
          {appointments.map((a) => (
            <AppointmentPaymentRow
              key={a.id}
              a={a}
              settlements={settlementsByAppt[a.id] ?? []}
              open={openIds.has(a.id)}
              onOpenChange={(v) => toggle(a.id, v)}
            />
          ))}
        </div>
      </div>

      <div className="hidden print:block">
        <table>
          <thead>
            <tr>
              <th>Date &amp; Time</th>
              <th>Doctor</th>
              <th>Department</th>
              <th>Status</th>
              <th>Total</th>
              <th>Paid</th>
              <th>Outstanding</th>
            </tr>
          </thead>
          <tbody>
            {appointments.map((a) => {
              const packageLine = formatPackagePrintLine(a);
              const paid =
                (a.paid_amount ?? 0) +
                (a.insurance_amount ?? 0) +
                (a.secondary_amount ?? 0) +
                (a.deposit_amount ?? 0);

              return (
                <tr key={a.id}>
                  <td style={{ whiteSpace: "nowrap" }}>
                    {new Date(a.scheduled_at).toLocaleString("en-GB", {
                      timeZone: DEFAULT_TIME_ZONE,
                      dateStyle: "medium",
                      timeStyle: "short",
                    })}
                  </td>
                  <td>{formatDoctorName(a.profiles?.full_name)}</td>
                  <td>
                    <div>{a.departments?.name ?? "-"}</div>
                    {packageLine && (
                      <div
                        style={{
                          marginTop: 2,
                          fontSize: 9,
                          lineHeight: 1.35,
                          color: "#000",
                        }}
                      >
                        {packageLine}
                      </div>
                    )}
                  </td>
                  <td style={{ textTransform: "capitalize" }}>
                    {a.status.replace("_", " ")}
                  </td>
                  <td style={moneyCellStyle}>{fmtMoney(a.total_amount ?? 0)}</td>
                  <td style={moneyCellStyle}>{fmtMoney(paid)}</td>
                  <td style={moneyCellStyle}>
                    {fmtMoney(a.outstanding_amount ?? 0)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}

const moneyCellStyle = {
  textAlign: "right",
  fontVariantNumeric: "tabular-nums",
} as const;

function formatPackagePrintLine(a: AppointmentPaymentRowData) {
  const pkg = a.patient_packages;
  if (!pkg) return null;

  const remaining = Math.max(
    0,
    Number(pkg.total_sessions ?? 0) - Number(pkg.used_sessions ?? 0),
  );
  const sessionText = a.package_session_number
    ? `Session ${a.package_session_number} of ${pkg.total_sessions}`
    : `Total sessions ${pkg.total_sessions}`;

  return `Package: ${pkg.name} | ${sessionText} | Remaining ${remaining}`;
}
