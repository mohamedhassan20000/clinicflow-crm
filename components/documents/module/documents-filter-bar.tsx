"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { parseAsInteger, parseAsString, useQueryStates } from "nuqs";
import { Filter, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DateRangePicker } from "@/components/ui/clinic-date-picker";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type {
  DocumentFilterKey,
  RegisteredDocumentTypeCode,
} from "@/lib/documents/catalog";
import { documentFilterKeysFor } from "@/lib/documents/module";
import { resolveDateRange, type DateRangePreset } from "@/lib/date-range";

type Option = { id: string; name: string };

type Props = {
  typeOptions: { code: RegisteredDocumentTypeCode; label: string }[];
  patientOptions: Option[];
  staffOptions: Option[];
};

const ALL = "all";

const FILTER_STATE = {
  type: parseAsString,
  status: parseAsString,
  patientId: parseAsString,
  creatorId: parseAsString,
  dateFrom: parseAsString,
  dateTo: parseAsString,
  datePreset: parseAsString,
  documentNumber: parseAsString,
  page: parseAsInteger,
};

export function DocumentsFilterBar({ typeOptions, patientOptions, staffOptions }: Props) {
  const t = useTranslations("documents.module.filters");
  const [filters, setFilters] = useQueryStates(FILTER_STATE, { shallow: false });
  // Locally-controlled draft for the free-text number field; committed to the
  // URL on a debounce and reset directly by the Clear handler (never synced in
  // an effect, which would trip the cascading-render lint rule).
  const [numberDraft, setNumberDraft] = useState(filters.documentNumber ?? "");

  // Debounce the free-text document-number filter so typing does not push a
  // history entry (and a server round-trip) on every keystroke.
  useEffect(() => {
    const current = filters.documentNumber ?? "";
    if (numberDraft === current) return;
    const timeout = setTimeout(() => {
      void setFilters({ documentNumber: numberDraft || null, page: null });
    }, 400);
    return () => clearTimeout(timeout);
  }, [numberDraft, filters.documentNumber, setFilters]);

  const selectedType =
    filters.type && isRegistered(filters.type, typeOptions) ? filters.type : null;
  const relevant = new Set<DocumentFilterKey>(documentFilterKeysFor(selectedType));
  const showPatient = relevant.has("patient");
  const showEmployee = relevant.has("creator") || relevant.has("employee") || relevant.has("doctor");

  const hasActive = Boolean(
    filters.type ||
      filters.status ||
      filters.patientId ||
      filters.creatorId ||
      filters.dateFrom ||
      filters.dateTo ||
      filters.datePreset ||
      filters.documentNumber,
  );

  function clearAll() {
    setNumberDraft("");
    void setFilters({
      type: null,
      status: null,
      patientId: null,
      creatorId: null,
      dateFrom: null,
      dateTo: null,
      datePreset: null,
      documentNumber: null,
      page: null,
    });
  }

  return (
    <section className="rounded-xl border border-border/50 bg-card p-4 print:hidden">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-sm font-medium">
          <Filter className="size-4 text-muted-foreground" aria-hidden />
          {t("title")}
        </div>
        {hasActive && (
          <Button variant="ghost" size="sm" onClick={clearAll}>
            <X className="size-4" data-icon="inline-start" />
            {t("clear")}
          </Button>
        )}
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <div className="space-y-1.5">
          <Label>{t("type")}</Label>
          <Select
            value={filters.type ?? ALL}
            onValueChange={(value) =>
              setFilters({
                type: value === ALL ? null : value,
                patientId: null,
                page: null,
              })
            }
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>{t("allTypes")}</SelectItem>
              {typeOptions.map((option) => (
                <SelectItem key={option.code} value={option.code}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label>{t("status")}</Label>
          <Select
            value={filters.status ?? ALL}
            onValueChange={(value) =>
              setFilters({ status: value === ALL ? null : value, page: null })
            }
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>{t("allStatuses")}</SelectItem>
              <SelectItem value="not_issued">{t("statusNotIssued")}</SelectItem>
              <SelectItem value="issued">{t("statusIssued")}</SelectItem>
              <SelectItem value="cancelled">{t("statusCancelled")}</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="documents-number">{t("documentNumber")}</Label>
          <Input
            id="documents-number"
            value={numberDraft}
            placeholder={t("documentNumberPlaceholder")}
            onChange={(event) => setNumberDraft(event.target.value)}
          />
        </div>

        {showPatient && (
          <div className="space-y-1.5">
            <Label>{t("patient")}</Label>
            <Select
              value={filters.patientId ?? ALL}
              onValueChange={(value) =>
                setFilters({ patientId: value === ALL ? null : value, page: null })
              }
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>{t("allPatients")}</SelectItem>
                {patientOptions.map((option) => (
                  <SelectItem key={option.id} value={option.id}>
                    {option.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        {showEmployee && (
          <div className="space-y-1.5">
            <Label>{t("creator")}</Label>
            <Select
              value={filters.creatorId ?? ALL}
              onValueChange={(value) =>
                setFilters({ creatorId: value === ALL ? null : value, page: null })
              }
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>{t("allCreators")}</SelectItem>
                {staffOptions.map((option) => (
                  <SelectItem key={option.id} value={option.id}>
                    {option.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        <div className="space-y-1.5">
          <Label>{t("datePreset")}</Label>
          <Select
            value={filters.datePreset ?? ALL}
            onValueChange={(value) => {
              if (value === ALL) {
                void setFilters({ datePreset: null, dateFrom: null, dateTo: null, page: null });
                return;
              }
              const range = resolveDateRange({ preset: value as DateRangePreset });
              void setFilters({
                datePreset: value,
                dateFrom: range.from,
                dateTo: range.to,
                page: null,
              });
            }}
          >
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>{t("dateAny")}</SelectItem>
              <SelectItem value="last_week">{t("dateLastWeek")}</SelectItem>
              <SelectItem value="this_month">{t("dateThisMonth")}</SelectItem>
              <SelectItem value="last_month">{t("dateLastMonth")}</SelectItem>
              <SelectItem value="last_year">{t("dateLastYear")}</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="self-end sm:col-span-2">
          <DateRangePicker
            id="documents-date-range"
            from={filters.dateFrom ?? ""}
            to={filters.dateTo ?? ""}
            labels={{ from: t("dateFrom"), to: t("dateTo") }}
            onFromChange={(dateFrom) => {
              void setFilters({ datePreset: null, dateFrom: dateFrom || null, page: null });
            }}
            onToChange={(dateTo) => {
              void setFilters({ datePreset: null, dateTo: dateTo || null, page: null });
            }}
            className="w-full"
          />
        </div>
      </div>
    </section>
  );
}

function isRegistered(
  value: string,
  options: { code: RegisteredDocumentTypeCode }[],
): value is RegisteredDocumentTypeCode {
  return options.some((option) => option.code === value);
}
