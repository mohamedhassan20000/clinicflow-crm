"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { formatDocDate, formatDocMoney, formatDocNumber } from "@/lib/documents/format";
import type { InvoiceAuthoringOption } from "@/lib/documents/manual-authoring";
import type { Locale } from "@/lib/i18n/config";
import { saveDocumentDraft } from "@/actions/document-drafts";

const SELECT_CLASS = "h-10 w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50";

export type InvoiceAuthoringLabels = {
  patient: string;
  appointment: string;
  selectPatient: string;
  selectAppointment: string;
  services: string;
  service: string;
  unitPrice: string;
  quantity: string;
  lineTotal: string;
  total: string;
  empty: string;
  saveDraft: string;
};

export function InvoiceAuthoringForm({ options, locale, currency, timeZone, labels, draftId, initialAppointmentId }: {
  options: InvoiceAuthoringOption[];
  locale: Locale;
  currency: string;
  timeZone: string;
  labels: InvoiceAuthoringLabels;
  draftId?: string;
  initialAppointmentId?: string;
}) {
  const router = useRouter();
  const initialOption = options.find((option) => option.id === initialAppointmentId);
  const [patientId, setPatientId] = useState(initialOption?.patientId ?? "");
  const [appointmentId, setAppointmentId] = useState(initialAppointmentId ?? "");
  const [saving, startSaving] = useTransition();
  const patients = useMemo(() => Array.from(new Map(options.map((option) => [option.patientId,
    { id: option.patientId, name: option.patientName, fileNumber: option.fileNumber }])).values()), [options]);
  const appointments = options.filter((option) => option.patientId === patientId);
  const selected = options.find((option) => option.id === appointmentId);
  const format = { locale, currency, timeZone, timeFormat: "24h" as const };

  function saveDraft() {
    if (!selected) return;
    startSaving(async () => {
      const result = await saveDocumentDraft({
        draftId,
        documentType: "INVOICE",
        locale,
        params: { appointmentId: selected.id },
        appointmentId: selected.id,
        patientId: selected.patientId,
      });
      if (result.data) router.push(result.data.previewHref);
    });
  }

  return <section className="space-y-5 rounded-xl border bg-card p-5">
    {options.length === 0 ? <p className="text-sm text-muted-foreground">{labels.empty}</p> : <>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5"><Label htmlFor="invoice-patient">{labels.patient}</Label>
          <select id="invoice-patient" className={SELECT_CLASS} value={patientId} onChange={(event) => {
            setPatientId(event.target.value); setAppointmentId("");
          }}><option value="">{labels.selectPatient}</option>{patients.map((patient) => <option key={patient.id} value={patient.id}>
            {patient.name}{patient.fileNumber ? ` · ${patient.fileNumber}` : ""}</option>)}</select></div>
        <div className="space-y-1.5"><Label htmlFor="invoice-appointment">{labels.appointment}</Label>
          <select id="invoice-appointment" className={SELECT_CLASS} value={appointmentId}
            disabled={!patientId} onChange={(event) => setAppointmentId(event.target.value)}>
            <option value="">{labels.selectAppointment}</option>{appointments.map((appointment) => <option key={appointment.id} value={appointment.id}>
              {formatDocDate(appointment.scheduledAt, format, { dateStyle: "medium" })} · {formatDocMoney(appointment.total, format, { currencyDisplay: "code" })}
            </option>)}</select></div>
      </div>
      {selected && <div className="space-y-3"><h2 className="font-semibold">{labels.services}</h2>
        <div className="overflow-x-auto rounded-lg border"><table className="w-full text-sm"><thead className="bg-muted/50"><tr>
          <th className="p-3 text-start">{labels.service}</th><th className="p-3 text-end">{labels.unitPrice}</th>
          <th className="p-3 text-end">{labels.quantity}</th><th className="p-3 text-end">{labels.lineTotal}</th>
        </tr></thead><tbody>{selected.services.map((service) => <tr key={service.id} className="border-t">
          <td className="p-3">{service.name}</td><td className="p-3 text-end tabular-nums" dir="ltr">{formatDocMoney(service.unitPrice, format, { currencyDisplay: "code" })}</td>
          <td className="p-3 text-end tabular-nums" dir="ltr">{formatDocNumber(service.quantity, format)}</td>
          <td className="p-3 text-end tabular-nums" dir="ltr">{formatDocMoney(service.total, format, { currencyDisplay: "code" })}</td>
        </tr>)}</tbody></table></div>
        <div className="flex justify-end gap-4 text-sm"><span className="font-medium">{labels.total}</span>
          <strong className="tabular-nums" dir="ltr">{formatDocMoney(selected.total, format, { currencyDisplay: "code" })}</strong></div>
      </div>}
      <div className="flex justify-end"><Button onClick={saveDraft} disabled={!selected || saving}>{labels.saveDraft}</Button></div>
    </>}
  </section>;
}
