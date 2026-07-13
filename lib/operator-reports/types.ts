import { z } from "zod";

export type ReportCell = string | number | null;
export type ReportRow = Record<string, ReportCell>;
export type ReportDirection = "asc" | "desc";
export type RawReportSearchParams = Record<
  string,
  string | string[] | undefined
>;

export const REPORT_PAGE_SIZES = [25, 50, 100] as const;
export const REPORT_EXPORT_LIMIT = 10_000;
export const REPORT_AGGREGATE_SOURCE_LIMIT = 10_000;

export type ReportFilterOption = {
  value: string;
  label: string;
};

export type ReportFilterDefinition = {
  key: string;
  label: string;
  kind: "select" | "combobox" | "date" | "month" | "text";
  defaultValue: string | ((now: Date) => string);
  clearValue: string;
  schema: z.ZodType<string>;
  options?: readonly ReportFilterOption[];
  optionSource?: "clinics" | "countries" | "plans";
  placeholder?: string;
};

export type ReportSortDefinition = {
  key: string;
  label: string;
  defaultDirection: ReportDirection;
};

export type ParsedReportParams = {
  filters: Record<string, string>;
  sort: string;
  direction: ReportDirection;
  page: number;
  pageSize: (typeof REPORT_PAGE_SIZES)[number];
  hasActiveFilters: boolean;
};

export type ReportQueryResult = {
  rows: ReportRow[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  hasAnyData: boolean;
  sourceTruncated?: boolean;
};

export type ReportQueryMode = "page" | "export";

export type OperatorReportDefinition = {
  id: string;
  title: string;
  description: string;
  columns: readonly {
    key: string;
    label: string;
    numeric?: boolean;
    sortable?: boolean;
  }[];
  filters: readonly ReportFilterDefinition[];
  sorts: readonly ReportSortDefinition[];
  defaultSort: string;
  normalize?: (params: ParsedReportParams, now: Date) => ParsedReportParams;
  query: (
    params: ParsedReportParams,
    mode?: ReportQueryMode,
  ) => Promise<ReportQueryResult>;
  export: (rows: ReportRow[]) => string;
};

const positiveInteger = z.coerce.number().int().positive().max(100_000);

function firstValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function defaultValue(filter: ReportFilterDefinition, now: Date): string {
  return typeof filter.defaultValue === "function"
    ? filter.defaultValue(now)
    : filter.defaultValue;
}

/**
 * Parse all report URL state through one fail-safe boundary. Missing values use
 * report defaults; explicit empty values retain an all-time/cleared filter;
 * malformed values never reach a query builder.
 */
export function parseReportParams(
  definition: Pick<
    OperatorReportDefinition,
    "filters" | "sorts" | "defaultSort" | "normalize"
  >,
  raw: RawReportSearchParams,
  now = new Date(),
): ParsedReportParams {
  const filters: Record<string, string> = {};

  for (const filter of definition.filters) {
    const rawValue = firstValue(raw[filter.key]);
    if (rawValue === undefined) {
      filters[filter.key] = defaultValue(filter, now);
      continue;
    }
    if (rawValue === "" && filter.clearValue === "") {
      filters[filter.key] = "";
      continue;
    }
    const parsed = filter.schema.safeParse(rawValue);
    filters[filter.key] = parsed.success
      ? parsed.data
      : defaultValue(filter, now);
  }

  const requestedSort = firstValue(raw.sort);
  const sort = definition.sorts.some((item) => item.key === requestedSort)
    ? requestedSort!
    : definition.defaultSort;
  const sortDefinition =
    definition.sorts.find((item) => item.key === sort) ??
    definition.sorts.find((item) => item.key === definition.defaultSort)!;
  const requestedDirection = firstValue(raw.dir);
  const direction: ReportDirection =
    requestedDirection === "asc" || requestedDirection === "desc"
      ? requestedDirection
      : sortDefinition.defaultDirection;
  const parsedPage = positiveInteger.safeParse(firstValue(raw.page));
  const requestedPageSize = Number(firstValue(raw.pageSize));
  const pageSize = REPORT_PAGE_SIZES.includes(
    requestedPageSize as (typeof REPORT_PAGE_SIZES)[number],
  )
    ? (requestedPageSize as (typeof REPORT_PAGE_SIZES)[number])
    : REPORT_PAGE_SIZES[0];

  let parsed: ParsedReportParams = {
    filters,
    sort,
    direction,
    page: parsedPage.success ? parsedPage.data : 1,
    pageSize,
    hasActiveFilters: definition.filters.some(
      (filter) => filters[filter.key] !== filter.clearValue,
    ),
  };
  if (definition.normalize) parsed = definition.normalize(parsed, now);
  parsed.hasActiveFilters = definition.filters.some(
    (filter) => parsed.filters[filter.key] !== filter.clearValue,
  );
  return parsed;
}

export function reportParamsToSearchParams(
  definition: Pick<OperatorReportDefinition, "filters">,
  params: ParsedReportParams,
  options: { includePage?: boolean; includePageSize?: boolean } = {},
): URLSearchParams {
  const search = new URLSearchParams();
  for (const filter of definition.filters) {
    search.set(filter.key, params.filters[filter.key] ?? filter.clearValue);
  }
  search.set("sort", params.sort);
  search.set("dir", params.direction);
  if (options.includePageSize !== false) {
    search.set("pageSize", String(params.pageSize));
  }
  if (options.includePage !== false) search.set("page", String(params.page));
  return search;
}

export function clearedReportSearchParams(
  definition: Pick<
    OperatorReportDefinition,
    "filters" | "sorts" | "defaultSort"
  >,
): URLSearchParams {
  const search = new URLSearchParams();
  for (const filter of definition.filters) {
    search.set(filter.key, filter.clearValue);
  }
  const sort = definition.sorts.find(
    (item) => item.key === definition.defaultSort,
  )!;
  search.set("sort", definition.defaultSort);
  search.set("dir", sort.defaultDirection);
  search.set("pageSize", String(REPORT_PAGE_SIZES[0]));
  search.set("page", "1");
  return search;
}

export function exportReportCsv(
  definition: Pick<OperatorReportDefinition, "columns">,
  rows: ReportRow[],
) {
  const escape = (value: ReportCell) => {
    const raw = String(value ?? "");
    const safe = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
    return `"${safe.replaceAll('"', '""')}"`;
  };
  return [
    definition.columns.map((column) => escape(column.label)).join(","),
    ...rows.map((row) =>
      definition.columns.map((column) => escape(row[column.key])).join(","),
    ),
  ].join("\n");
}
