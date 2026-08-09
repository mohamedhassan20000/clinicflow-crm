"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { SlidersHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DateRangePicker } from "@/components/ui/clinic-date-picker";
import type { DocumentSetupField } from "@/lib/documents/module";
import type { Locale } from "@/lib/i18n/config";
import { saveDocumentDraft } from "@/actions/document-drafts";
import type { RegisteredDocumentTypeCode } from "@/lib/documents/catalog";

export type DocumentSetupOption = { id: string; name: string };

export type DocumentSetupOptions = {
  doctors: DocumentSetupOption[];
  departments: DocumentSetupOption[];
  receptionists: DocumentSetupOption[];
};

export type DocumentSetupValues = {
  preset?: string;
  from?: string;
  to?: string;
  doctor?: string;
  department?: string;
  receptionist?: string;
  q?: string;
};

export type DocumentSetupLabels = {
  period: string;
  presetThisWeek: string;
  presetThisMonth: string;
  presetToday: string;
  presetCustom: string;
  from: string;
  to: string;
  doctor: string;
  department: string;
  receptionist: string;
  search: string;
  searchPlaceholder: string;
  all: string;
  apply: string;
  saveContinue: string;
};

const ALL = "__all__";

const SELECT_CLASS =
  "h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50";

/**
 * P7 Phase 4 — the single filter surface for data-generated (Type A) documents.
 * Used both as the setup/filter popup before Preview (`mode="setup"`, Save →
 * Preview) and as the editable Preview toolbar (`mode="toolbar"`, applies on
 * change). Both build one canonical query (Phase 2: `preset=custom` + resolved
 * `from`/`to`, plus active non-date filters) into the same preview surface, so
 * the Preview dataset and the subsequently issued document always match.
 */
export function DocumentSetupControls({
  fields, options, initial, targetHref, locale, mode, labels, extraParams,
  documentType, draftId,
}: {
  fields: DocumentSetupField[];
  options: DocumentSetupOptions;
  initial: DocumentSetupValues;
  targetHref: string;
  locale: Locale;
  mode: "setup" | "toolbar";
  labels: DocumentSetupLabels;
  extraParams?: Record<string, string>;
  documentType?: RegisteredDocumentTypeCode;
  draftId?: string;
}) {
  const router = useRouter();
  const [isSaving, startSaving] = useTransition();
  const [values, setValues] = useState<DocumentSetupValues>({
    preset: initial.preset || "this_month",
    from: initial.from || "",
    to: initial.to || "",
    doctor: initial.doctor || ALL,
    department: initial.department || ALL,
    receptionist: initial.receptionist || ALL,
    q: initial.q || "",
  });

  const hasDateRange = fields.some((field) => field.key === "dateRange");
  const isCustom = values.preset === "custom";

  function buildQuery(next: DocumentSetupValues): string {
    const query = new URLSearchParams({ locale });
    for (const [key, value] of Object.entries(extraParams ?? {})) {
      if (value) query.set(key, value);
    }
    if (hasDateRange) {
      if (next.preset === "custom" && next.from && next.to) {
        query.set("preset", "custom");
        query.set("from", next.from);
        query.set("to", next.to);
      } else if (next.preset && next.preset !== "custom") {
        query.set("preset", next.preset);
      }
    }
    for (const field of fields) {
      if (field.key === "dateRange") continue;
      const value = next[field.key === "search" ? "q" : field.key];
      if (value && value !== ALL) query.set(field.param, value);
    }
    return query.toString();
  }

  function navigate(next: DocumentSetupValues) {
    const queryString = buildQuery(next);
    if (!documentType) {
      router.push(`${targetHref}?${queryString}`);
      return;
    }
    startSaving(async () => {
      const params = Object.fromEntries(new URLSearchParams(queryString));
      delete params.locale;
      delete params.origin;
      delete params.draftId;
      const result = await saveDocumentDraft({
        draftId,
        documentType,
        locale,
        params,
      });
      if (!result.data) return;
      router.push(result.data.previewHref);
    });
  }

  function update(patch: Partial<DocumentSetupValues>) {
    const next = { ...values, ...patch };
    setValues(next);
    // Custom range only navigates once both bounds are set (toolbar mode).
    if (mode === "toolbar") {
      const waitingForCustom = next.preset === "custom" && (!next.from || !next.to);
      if (!("q" in patch) && !waitingForCustom) navigate(next);
    }
  }

  const selectField = (
    key: "doctor" | "department" | "receptionist",
    label: string,
    opts: DocumentSetupOption[],
  ) => (
    <div className="space-y-1.5" key={key}>
      <Label htmlFor={`setup-${key}`}>{label}</Label>
      <select id={`setup-${key}`} className={SELECT_CLASS} value={values[key]}
        onChange={(event) => update({ [key]: event.target.value })}>
        <option value={ALL}>{labels.all}</option>
        {opts.map((option) => (
          <option key={option.id} value={option.id}>{option.name}</option>
        ))}
      </select>
    </div>
  );

  const controls = (
    <div className={mode === "setup"
      ? "grid gap-4 sm:grid-cols-2"
      : "flex flex-wrap items-end gap-3"}>
      {hasDateRange && (
        <div className="space-y-1.5">
          <Label htmlFor="setup-preset">{labels.period}</Label>
          <select id="setup-preset" className={SELECT_CLASS} value={values.preset}
            onChange={(event) => update({ preset: event.target.value })}>
            <option value="today">{labels.presetToday}</option>
            <option value="this_week">{labels.presetThisWeek}</option>
            <option value="this_month">{labels.presetThisMonth}</option>
            <option value="custom">{labels.presetCustom}</option>
          </select>
        </div>
      )}
      {hasDateRange && isCustom && (
        <DateRangePicker
          id="setup-date-range"
          from={values.from ?? ""}
          to={values.to ?? ""}
          labels={{ from: labels.from, to: labels.to }}
          onFromChange={(from) => update({ from })}
          onToChange={(to) => update({ to })}
          className={mode === "setup" ? "sm:col-span-2" : "w-full sm:w-[22rem]"}
        />
      )}
      {fields.some((field) => field.key === "doctor") &&
        selectField("doctor", labels.doctor, options.doctors)}
      {fields.some((field) => field.key === "department") &&
        selectField("department", labels.department, options.departments)}
      {fields.some((field) => field.key === "receptionist") &&
        selectField("receptionist", labels.receptionist, options.receptionists)}
      {fields.some((field) => field.key === "search") && (
        <div className="space-y-1.5">
          <Label htmlFor="setup-search">{labels.search}</Label>
          <Input id="setup-search" value={values.q} placeholder={labels.searchPlaceholder}
            onChange={(event) => setValues((current) => ({ ...current, q: event.target.value }))}
            onKeyDown={(event) => { if (event.key === "Enter") navigate(values); }}
            onBlur={() => { if (mode === "toolbar") navigate(values); }} />
        </div>
      )}
    </div>
  );

  if (mode === "toolbar") {
    return (
      <details className="rounded-lg border bg-card p-3 print:hidden">
        <summary className="flex cursor-pointer list-none items-center gap-2 text-sm font-medium">
          <SlidersHorizontal className="size-4" aria-hidden />
          {labels.apply}
        </summary>
        <div className="mt-3">{controls}</div>
      </details>
    );
  }

  return (
    <section className="space-y-4 rounded-xl border bg-card p-5">
      {controls}
      <div className="flex justify-end">
        <Button onClick={() => navigate(values)} disabled={isSaving}>
          {labels.saveContinue}
        </Button>
      </div>
    </section>
  );
}
