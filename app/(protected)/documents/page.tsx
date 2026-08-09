import type { Metadata } from "next";
import Link from "next/link";
import { Plus } from "lucide-react";
import { getLocale, getTranslations } from "next-intl/server";
import {
  getDocumentFilterOptions,
  listClinicDocuments,
  type DocumentModuleListInput,
} from "@/actions/documents-module";
import { DocumentsFilterBar } from "@/components/documents/module/documents-filter-bar";
import { DocumentsTable } from "@/components/documents/module/documents-table";
import { Button } from "@/components/ui/button";
import { getDocumentTypeLabels } from "@/lib/documents/module-labels";
import { resolveDateRange, type DateRangePreset } from "@/lib/date-range";
import type { Locale } from "@/lib/i18n/config";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("documents.module");
  return { title: t("title") };
}

type SearchParams = {
  type?: string;
  status?: string;
  patientId?: string;
  creatorId?: string;
  dateFrom?: string;
  dateTo?: string;
  datePreset?: string;
  documentNumber?: string;
  page?: string;
};

const PAGE_SIZE = 20;

function toInput(sp: SearchParams): DocumentModuleListInput {
  const page = Number.parseInt(sp.page ?? "", 10);
  const presets: DateRangePreset[] = [
    "last_week", "this_month", "last_month", "last_year",
  ];
  const preset = presets.includes(sp.datePreset as DateRangePreset)
    ? sp.datePreset as DateRangePreset
    : null;
  const resolved = preset && (!sp.dateFrom || !sp.dateTo)
    ? resolveDateRange({ preset })
    : null;
  return {
    type: sp.type || null,
    status:
      sp.status === "not_issued" || sp.status === "issued" || sp.status === "cancelled"
        ? sp.status
        : null,
    patientId: sp.patientId || null,
    creatorId: sp.creatorId || null,
    dateFrom: sp.dateFrom || resolved?.from || null,
    dateTo: sp.dateTo || resolved?.to || null,
    documentNumber: sp.documentNumber?.trim() || null,
    page: Number.isFinite(page) && page > 0 ? page : 1,
    pageSize: PAGE_SIZE,
  };
}

export default async function DocumentsModulePage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const [sp, t, locale, typeLabels] = await Promise.all([
    searchParams,
    getTranslations("documents.module"),
    getLocale() as Promise<Locale>,
    getDocumentTypeLabels(),
  ]);

  const input = toInput(sp);
  const [listResult, optionsResult] = await Promise.all([
    listClinicDocuments(input),
    getDocumentFilterOptions(),
  ]);

  const list = listResult.data ?? {
    rows: [],
    total: 0,
    page: input.page ?? 1,
    pageSize: PAGE_SIZE,
  };
  const options = optionsResult.data ?? { types: [], patients: [], staff: [] };
  const typeOptions = options.types.map((code) => ({ code, label: typeLabels[code] }));

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{t("title")}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t("subtitle")}</p>
        </div>
        <Button asChild>
          <Link href="/documents/new">
            <Plus className="size-4" data-icon="inline-start" />
            {t("newDocument")}
          </Link>
        </Button>
      </div>

      <DocumentsFilterBar
        typeOptions={typeOptions}
        patientOptions={options.patients}
        staffOptions={options.staff}
      />

      <DocumentsTable
        rows={list.rows}
        total={list.total}
        page={list.page}
        pageSize={list.pageSize}
        locale={locale}
        typeLabels={typeLabels}
      />
    </div>
  );
}
