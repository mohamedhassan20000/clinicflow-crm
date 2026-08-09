import Link from "next/link";
import { ArrowDown, ArrowUp, Download, FileBarChart, FilterX } from "lucide-react";
import { ReportFilterCombobox } from "@/components/operator/report-filter-combobox";
import { DataTable } from "@/components/shared/data-table";
import { Button } from "@/components/ui/button";
import { MonthPicker, SingleDatePicker } from "@/components/ui/clinic-date-picker";
import { Input } from "@/components/ui/input";
import { pathWithSearch } from "@/lib/navigation/return-url";
import {
  REPORT_EXPORT_LIMIT,
  REPORT_AGGREGATE_SOURCE_LIMIT,
  REPORT_PAGE_SIZES,
  clearedReportSearchParams,
  reportParamsToSearchParams,
  type OperatorReportDefinition,
  type ParsedReportParams,
  type ReportFilterOption,
  type ReportQueryResult,
  type ReportRow,
} from "@/lib/operator-reports/types";
import { useTranslations } from "next-intl";

function hiddenState(
  definition: OperatorReportDefinition,
  params: ParsedReportParams,
  omitted: ReadonlySet<string>,
) {
  const values = reportParamsToSearchParams(definition, params);
  return [...values.entries()]
    .filter(([key]) => !omitted.has(key))
    .map(([key, value]) => <input key={key} type="hidden" name={key} value={value} />);
}

function reportHref(
  definition: OperatorReportDefinition,
  params: ParsedReportParams,
  changes: Partial<Pick<ParsedReportParams, "sort" | "direction" | "page" | "pageSize">>,
) {
  const next = { ...params, ...changes };
  return pathWithSearch(
    `/operator/reports/${definition.id}`,
    reportParamsToSearchParams(definition, next),
  );
}

export function ReportShell({
  definition,
  result,
  params,
  filterOptions,
}: {
  definition: OperatorReportDefinition;
  result: ReportQueryResult;
  params: ParsedReportParams;
  filterOptions: Record<string, readonly ReportFilterOption[]>;
}) {
  const t = useTranslations("operator");
  const basePath = `/operator/reports/${definition.id}`;
  const clearHref = pathWithSearch(basePath, clearedReportSearchParams(definition));
  const exportParams = reportParamsToSearchParams(definition, params, {
    includePage: false,
    includePageSize: false,
  });
  const exportHref = pathWithSearch(`${basePath}/export`, exportParams);
  const firstVisible = result.total === 0 ? 0 : (result.page - 1) * result.pageSize + 1;
  const lastVisible = Math.min(result.total, result.page * result.pageSize);
  const ascendingLabel = t("ascending");
  const descendingLabel = t("descending");

  const columns = definition.columns.map((column) => {
    const sortDefinition = definition.sorts.find((sort) => sort.key === column.key);
    const active = params.sort === column.key;
    const nextDirection = active
      ? params.direction === "asc"
        ? "desc"
        : "asc"
      : sortDefinition?.defaultDirection ?? "asc";
    return {
      key: column.key,
      numeric: column.numeric,
      ariaSort: column.sortable
        ? active
          ? params.direction === "asc"
            ? ("ascending" as const)
            : ("descending" as const)
          : ("none" as const)
        : undefined,
      label: column.sortable ? (
        <Link
          href={reportHref(definition, params, {
            sort: column.key,
            direction: nextDirection,
            page: 1,
          })}
          className="inline-flex min-h-11 items-center gap-1.5 rounded-sm underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          aria-label={t("sortByDirection", { column: column.label, direction: nextDirection === "asc" ? ascendingLabel : descendingLabel })}
        >
          {column.label}
          {active ? (
            params.direction === "asc" ? (
              <ArrowUp className="size-3.5" aria-hidden="true" />
            ) : (
              <ArrowDown className="size-3.5" aria-hidden="true" />
            )
          ) : null}
        </Link>
      ) : (
        column.label
      ),
    };
  });

  return (
    <div className="space-y-4">
      <form method="get" className="rounded-2xl border bg-card p-4 shadow-sm">
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {definition.filters.map((filter) => {
            const value = params.filters[filter.key] ?? filter.clearValue;
            const options = filterOptions[filter.key] ?? filter.options ?? [];
            return (
              <label key={filter.key} className="grid content-start gap-1.5 text-sm font-medium">
                <span>{filter.label}</span>
                {filter.kind === "combobox" ? (
                  <ReportFilterCombobox
                    key={`${filter.key}:${value}`}
                    name={filter.key}
                    value={value}
                    options={options}
                    label={filter.label}
                    placeholder={filter.placeholder ?? filter.label}
                  />
                ) : filter.kind === "select" ? (
                  <select
                    key={`${filter.key}:${value}`}
                    name={filter.key}
                    defaultValue={value}
                    className="h-10 rounded-md border border-input bg-background px-3 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
                  >
                    {options.map((option) => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                ) : filter.kind === "date" ? (
                  <SingleDatePicker
                    key={`${filter.key}:${value}`}
                    name={filter.key}
                    defaultValue={value === filter.clearValue ? "" : value}
                    label={filter.label}
                    className="h-10 rounded-md"
                  />
                ) : filter.kind === "month" ? (
                  <MonthPicker
                    key={`${filter.key}:${value}`}
                    name={filter.key}
                    defaultValue={value === filter.clearValue ? "" : value}
                    label={filter.label}
                    className="h-10 rounded-md"
                  />
                ) : (
                  <Input
                    key={`${filter.key}:${value}`}
                    type="text"
                    name={filter.key}
                    defaultValue={value === filter.clearValue ? "" : value}
                    placeholder={filter.placeholder}
                    maxLength={filter.kind === "text" ? 80 : undefined}
                  />
                )}
              </label>
            );
          })}
        </div>
        {hiddenState(definition, params, new Set([
          ...definition.filters.map((filter) => filter.key),
          "page",
        ]))}
        <input type="hidden" name="page" value="1" />
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Button type="submit">{t("applyFilters")}</Button>
          <Button asChild type="button" variant="outline">
            <Link href={clearHref}>
              <FilterX className="size-4" aria-hidden="true" />
              {t("clearFilters2")}</Link>
          </Button>
        </div>
      </form>

      <section className="overflow-hidden rounded-2xl border bg-card shadow-sm" aria-labelledby={`${definition.id}-table-title`}>
        <div className="flex flex-wrap items-center justify-between gap-4 border-b p-5">
          <div>
            <h2 id={`${definition.id}-table-title`} className="text-lg font-semibold">{definition.title}</h2>
            <p className="text-sm text-muted-foreground">
              {result.total === 0
                ? t("norows")
                : t("showingRangeOfTotal", { first: firstVisible, last: lastVisible, total: result.total })}
            </p>
          </div>
          <Button asChild variant="outline">
            <a href={exportHref}>
              <Download className="size-4" aria-hidden="true" />
              {t("exportFilteredCsv")}</a>
          </Button>
        </div>

        {result.sourceTruncated ? (
          <p role="status" className="border-b border-amber-300 bg-amber-50 px-5 py-3 text-sm text-amber-950 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100">
            {t("thisAggregateReachedIts")}{REPORT_AGGREGATE_SOURCE_LIMIT.toLocaleString()}{t("rowSafetyCapNarrowTheFilters")}</p>
        ) : null}

        <DataTable
          columns={columns}
          rows={result.rows as ReportRow[]}
          rowKey={(row, index) => String(row.clinic_id ?? row.invitation_id ?? row.audit_id ?? row.month ?? index)}
          caption={`${definition.title} report`}
          stickyHeader
          empty={{
            icon: result.hasAnyData ? FilterX : FileBarChart,
            title: result.hasAnyData ? t("norowsmatchthesefilters") : t("noreportdatayet"),
            description: result.hasAnyData
              ? t("cleartheactivefilterstoreturn")
              : t("dataappearsherewhentheplatform"),
            action: result.hasAnyData ? (
              <Button asChild variant="outline"><Link href={clearHref}>{t("clearFilters")}</Link></Button>
            ) : undefined,
          }}
        />

        <div className="flex flex-wrap items-center justify-between gap-3 border-t px-5 py-4">
          <form method="get" className="flex items-center gap-2 text-sm">
            {hiddenState(definition, params, new Set(["page", "pageSize"]))}
            <input type="hidden" name="page" value="1" />
            <label htmlFor={`${definition.id}-page-size`} className="text-muted-foreground">{t("rowsPerPage")}</label>
            <select
              key={params.pageSize}
              id={`${definition.id}-page-size`}
              name="pageSize"
              defaultValue={String(params.pageSize)}
              className="h-9 rounded-md border border-input bg-background px-2 text-sm"
            >
              {REPORT_PAGE_SIZES.map((size) => <option key={size} value={size}>{size}</option>)}
            </select>
            <Button type="submit" size="sm" variant="outline">{t("update")}</Button>
          </form>

          <nav aria-label={`${definition.title} pagination`} className="flex items-center gap-2">
            <Button asChild variant="outline" size="sm" aria-disabled={result.page <= 1}>
              <Link
                href={reportHref(definition, params, { page: Math.max(1, result.page - 1) })}
                tabIndex={result.page <= 1 ? -1 : undefined}
                className={result.page <= 1 ? "pointer-events-none opacity-50" : undefined}
              >
                {t("previous")}</Link>
            </Button>
            <span className="min-w-24 text-center text-sm tabular-nums text-muted-foreground">
              {t("pageOf", { page: result.page, totalPages: result.totalPages })}
            </span>
            <Button asChild variant="outline" size="sm" aria-disabled={result.page >= result.totalPages}>
              <Link
                href={reportHref(definition, params, { page: Math.min(result.totalPages, result.page + 1) })}
                tabIndex={result.page >= result.totalPages ? -1 : undefined}
                className={result.page >= result.totalPages ? "pointer-events-none opacity-50" : undefined}
              >
                {t("next")}</Link>
            </Button>
          </nav>
        </div>
        <p className="sr-only">{t("csvExportsIgnorePaginationAndAre")}{REPORT_EXPORT_LIMIT.toLocaleString()} {t("filteredRows")}</p>
      </section>
    </div>
  );
}
