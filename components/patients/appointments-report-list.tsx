"use client";

import { useState } from "react";
import { ChevronsDownUp, ChevronsUpDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  AppointmentPaymentRow,
  type AppointmentPaymentRowData,
  type SettlementEntry,
} from "@/components/patients/appointment-payment-row";
import { formatDoctorName } from "@/lib/format-doctor";
import { useClinicSettings } from "@/contexts/clinic-settings-context";
import { useTranslations } from "next-intl";

interface Props {
  appointments: AppointmentPaymentRowData[];
  settlementsByAppt: Record<string, SettlementEntry[]>;
}

export function AppointmentsReportList({ appointments, settlementsByAppt }: Props) {
  const t = useTranslations("patients");
  const { formatCurrency, formatDateTime } = useClinicSettings();
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
          {t("noAppointmentsMatchTheSelectedDate")}</div>
        <p className="hidden text-sm print:block">
          {t("noAppointmentsMatchTheSelectedDate")}</p>
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
              {t("expandAll")}</Button>
            <Button
              size="sm"
              variant="outline"
              className="h-7 gap-1.5 px-3 text-xs"
              onClick={collapseAll}
            >
              <ChevronsDownUp className="h-3 w-3" />
              {t("collapseAll")}</Button>
            <span className="text-xs text-muted-foreground">
              {completedIds.length} {t("completedAppointment")}{completedIds.length !== 1 ? "s" : ""}
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
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("dateTime")}</TableHead>
              <TableHead>{t("doctor")}</TableHead>
              <TableHead>{t("department")}</TableHead>
              <TableHead>{t("status")}</TableHead>
              <TableHead className="text-end">{t("total")}</TableHead>
              <TableHead className="text-end">{t("insuranceContribution")}</TableHead>
              <TableHead className="text-end">{t("patientResponsibility")}</TableHead>
              <TableHead className="text-end">{t("totalPatientPaid")}</TableHead>
              <TableHead className="text-end">{t("remainingPatientBalance")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {appointments.map((a) => {
              const packageLine = formatPackagePrintLine(a);
              const patientPaid =
                (a.paid_amount ?? 0) +
                (a.secondary_amount ?? 0) +
                (a.deposit_amount ?? 0);
              const insurance = a.insurance_amount ?? 0;
              const patientResponsibility =
                a.patient_responsibility ??
                Math.max(0, (a.total_amount ?? 0) - insurance);

              return (
                <TableRow key={a.id}>
                  <TableCell style={{ whiteSpace: "nowrap" }}>
                    {formatDateTime(a.scheduled_at, {
                      dateStyle: "medium",
                      timeStyle: "short",
                    })}
                  </TableCell>
                  <TableCell>{formatDoctorName(a.profiles?.full_name)}</TableCell>
                  <TableCell>
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
                  </TableCell>
                  <TableCell style={{ textTransform: "capitalize" }}>
                    {a.status.replace("_", " ")}
                  </TableCell>
                  <TableCell style={moneyCellStyle}>{fmtMoney(a.total_amount ?? 0)}</TableCell>
                  <TableCell style={moneyCellStyle}>{fmtMoney(insurance)}</TableCell>
                  <TableCell style={moneyCellStyle}>
                    {fmtMoney(patientResponsibility)}
                  </TableCell>
                  <TableCell style={moneyCellStyle}>{fmtMoney(patientPaid)}</TableCell>
                  <TableCell style={moneyCellStyle}>
                    {fmtMoney(a.outstanding_amount ?? 0)}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
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
