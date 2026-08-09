"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { DateRangePicker } from "@/components/ui/clinic-date-picker";
import type { PatientDocumentOption } from "@/lib/documents/manual-authoring";
import type { Locale } from "@/lib/i18n/config";
import { saveDocumentDraft } from "@/actions/document-drafts";
import type { P712PatientHistoryDocumentCode } from "@/lib/documents/resolvers/patient-history";

const SELECT_CLASS = "h-10 w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50";

export type PatientHistorySetupLabels = {
  patient: string;
  selectPatient: string;
  period: string;
  allTime: string;
  lastWeek: string;
  lastMonth: string;
  lastYear: string;
  custom: string;
  from: string;
  to: string;
  saveDraft: string;
  empty: string;
};

export function PatientHistorySetupForm({ patients, locale, labels, documentType, draftId, initial }: {
  patients: PatientDocumentOption[];
  locale: Locale;
  labels: PatientHistorySetupLabels;
  documentType: P712PatientHistoryDocumentCode;
  draftId?: string;
  initial?: { patientId?: string; preset?: string; from?: string; to?: string };
}) {
  const router = useRouter();
  const [saving, startSaving] = useTransition();
  const [patientId, setPatientId] = useState(initial?.patientId ?? "");
  const [preset, setPreset] = useState(initial?.preset ?? "all");
  const [from, setFrom] = useState(initial?.from ?? "");
  const [to, setTo] = useState(initial?.to ?? "");
  const customIncomplete = preset === "custom" && (!from || !to);

  function saveDraft() {
    if (!patientId || customIncomplete) return;
    startSaving(async () => {
      const params: Record<string, string> = { patientId, preset };
      if (preset === "custom") { params.from = from; params.to = to; }
      const result = await saveDocumentDraft({
        draftId,
        documentType,
        locale,
        params,
        patientId,
      });
      if (result.data) router.push(result.data.previewHref);
    });
  }

  return <section className="space-y-5 rounded-xl border bg-card p-5">
    {patients.length === 0 ? <p className="text-sm text-muted-foreground">{labels.empty}</p> : <>
      <div className="grid gap-4 sm:grid-cols-2"><div className="space-y-1.5">
        <Label htmlFor="history-patient">{labels.patient}</Label>
        <select id="history-patient" className={SELECT_CLASS} value={patientId} onChange={(event) => setPatientId(event.target.value)}>
          <option value="">{labels.selectPatient}</option>{patients.map((patient) => <option key={patient.id} value={patient.id}>
            {patient.fullName}{patient.fileNumber ? ` · ${patient.fileNumber}` : ""}</option>)}</select>
      </div><div className="space-y-1.5"><Label htmlFor="history-period">{labels.period}</Label>
        <select id="history-period" className={SELECT_CLASS} value={preset} onChange={(event) => setPreset(event.target.value)}>
          <option value="all">{labels.allTime}</option><option value="last_week">{labels.lastWeek}</option>
          <option value="last_month">{labels.lastMonth}</option><option value="last_year">{labels.lastYear}</option>
          <option value="custom">{labels.custom}</option></select></div></div>
      {preset === "custom" && <DateRangePicker
        id="history-date-range"
        from={from}
        to={to}
        labels={{ from: labels.from, to: labels.to }}
        onFromChange={setFrom}
        onToChange={setTo}
        className="w-full"
      />}
      <div className="flex justify-end"><Button onClick={saveDraft} disabled={!patientId || customIncomplete || saving}>{labels.saveDraft}</Button></div>
    </>}
  </section>;
}
