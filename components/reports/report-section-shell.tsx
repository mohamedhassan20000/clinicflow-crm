"use client";

import type { ReactNode } from "react";
import { PrintHeader } from "@/components/shared/print-header";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { PrintSectionButton, type ReportPrintSection } from "@/components/reports/print-all-button";
import type { ClinicPrintMeta } from "@/types/reports";

export function ReportSectionShell({
  section,
  title,
  description,
  rangeLabel,
  clinic,
  children,
}: {
  section: Exclude<ReportPrintSection, "all">;
  title: string;
  description: string;
  rangeLabel: string;
  clinic: ClinicPrintMeta;
  children: ReactNode;
}) {
  return (
    <section data-report-section={section} className="break-inside-avoid-page">
      <PrintHeader
        clinicName={clinic.clinicName || "ClinicFlow"}
        clinicAddress={clinic.clinicAddress}
        clinicPhone={clinic.clinicPhone}
        logoUrl={clinic.clinicLogoUrl}
        documentName="Reports"
        generatedAt={clinic.generatedAt}
      />
      <Card className="rounded-xl border border-border/50 shadow-sm print:rounded-none print:border-none print:shadow-none">
        <CardHeader className="border-b border-border/50 print:border-black">
          <CardTitle>{title}</CardTitle>
          <CardDescription>
            {description} <span className="print:inline">({rangeLabel})</span>
          </CardDescription>
          <CardAction>
            <PrintSectionButton section={section} />
          </CardAction>
        </CardHeader>
        <CardContent className="space-y-4">{children}</CardContent>
      </Card>
    </section>
  );
}

export function EmptyReportState({ message }: { message?: string }) {
  return (
    <div className="rounded-lg border border-dashed border-border/70 bg-muted/25 px-4 py-6 text-center text-sm text-muted-foreground print:border-black print:bg-white print:text-black">
      {message ?? "No data for the selected date range."}
    </div>
  );
}

export function MetricGrid({
  items,
}: {
  items: { label: string; value: string; hint?: string }[];
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {items.map((item) => (
        <div
          key={item.label}
          className="rounded-lg border border-border/50 bg-muted/20 p-3 print:border-black print:bg-white"
        >
          <p className="text-xs text-muted-foreground print:text-black">{item.label}</p>
          <p className="mt-1 text-xl font-semibold tabular-nums print:text-base">
            {item.value}
          </p>
          {item.hint && (
            <p className="mt-1 text-xs text-muted-foreground print:text-black">{item.hint}</p>
          )}
        </div>
      ))}
    </div>
  );
}
