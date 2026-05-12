"use client";

import { useState } from "react";
import { ChevronsDownUp, ChevronsUpDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  AppointmentPaymentRow,
  type AppointmentPaymentRowData,
  type SettlementEntry,
} from "@/components/patients/appointment-payment-row";

interface Props {
  appointments: AppointmentPaymentRowData[];
  settlementsByAppt: Record<string, SettlementEntry[]>;
}

export function AppointmentsReportList({ appointments, settlementsByAppt }: Props) {
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
      <div className="rounded-xl border border-dashed border-border/60 bg-muted/20 px-6 py-12 text-center text-sm text-muted-foreground">
        No appointments match the selected date range.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {completedIds.length > 0 && (
        <div className="flex items-center gap-2 print:hidden">
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
  );
}
