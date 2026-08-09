"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { useTranslations } from "next-intl";
import {
  createColumnHelper,
  getCoreRowModel,
  useReactTable,
} from "@tanstack/react-table";
import { parseAsInteger, useQueryState } from "nuqs";
import { ChevronLeft, ChevronRight, FileText, Pencil, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { DocumentModuleRow } from "@/actions/documents-module";
import type { RegisteredDocumentTypeCode } from "@/lib/documents/catalog";
import { groupDocumentTypesByArchetype } from "@/lib/documents/module";
import { deleteDocumentDraft } from "@/actions/document-drafts";
import { toast } from "sonner";

type Props = {
  rows: DocumentModuleRow[];
  total: number;
  page: number;
  pageSize: number;
  locale: "ar" | "en";
  typeLabels: Record<string, string>;
};

const columnHelper = createColumnHelper<DocumentModuleRow>();

function statusVariant(status: DocumentModuleRow["status"]) {
  if (status === "issued") return "default" as const;
  if (status === "cancelled") return "destructive" as const;
  return "secondary" as const;
}

export function DocumentsTable({
  rows,
  total,
  page,
  pageSize,
  locale,
  typeLabels,
}: Props) {
  const t = useTranslations("documents.module.table");
  const tStatus = useTranslations("documents.module.filters");
  const router = useRouter();
  const [deleting, startDelete] = useTransition();
  const [, setPage] = useQueryState("page", parseAsInteger.withOptions({ shallow: false }));

  const dateFormatter = new Intl.DateTimeFormat(locale === "ar" ? "ar-EG" : "en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
    numberingSystem: "latn",
  });

  const statusLabel: Record<DocumentModuleRow["status"], string> = {
    not_issued: tStatus("statusNotIssued"),
    issued: tStatus("statusIssued"),
    cancelled: tStatus("statusCancelled"),
  };

  const columns = [
    columnHelper.accessor("documentNumber", { id: "documentNumber" }),
    columnHelper.accessor("subjectName", { id: "subjectName" }),
    columnHelper.accessor("issuedByName", { id: "issuedByName" }),
    columnHelper.accessor("issuedAt", { id: "issuedAt" }),
    columnHelper.accessor("status", { id: "status" }),
  ];

  const table = useReactTable({
    data: rows,
    columns,
    getCoreRowModel: getCoreRowModel(),
  });

  const modelRows = table.getRowModel().rows;
  const presentCodes = Array.from(
    new Set(modelRows.map((row) => row.original.docType)),
  ) as RegisteredDocumentTypeCode[];
  const groups = groupDocumentTypesByArchetype(presentCodes);

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const firstIndex = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const lastIndex = Math.min(page * pageSize, total);

  function removeDraft(id: string) {
    if (!window.confirm(t("deleteDraftConfirm"))) return;
    startDelete(async () => {
      const result = await deleteDocumentDraft(id);
      if (!result.data) {
        toast.error(t("deleteDraftFailed"));
        return;
      }
      toast.success(t("draftDeleted"));
      router.refresh();
    });
  }

  if (rows.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed py-16 text-center">
        <FileText className="size-8 text-muted-foreground" aria-hidden />
        <p className="text-sm text-muted-foreground">{t("empty")}</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {groups.map((group) =>
        group.codes.map((code) => {
          const groupRows = modelRows.filter((row) => row.original.docType === code);
          if (groupRows.length === 0) return null;
          return (
            <section key={code} className="overflow-hidden rounded-xl border">
              <div className="flex items-center gap-2 border-b bg-muted/40 px-4 py-2.5">
                <FileText className="size-4 text-muted-foreground" aria-hidden />
                <h2 className="text-sm font-semibold">{typeLabels[code] ?? code}</h2>
                <span className="text-xs text-muted-foreground">({groupRows.length})</span>
              </div>
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t("columnNumber")}</TableHead>
                      <TableHead>{t("columnSubject")}</TableHead>
                      <TableHead>{t("columnIssuedBy")}</TableHead>
                      <TableHead>{t("columnIssuedAt")}</TableHead>
                      <TableHead>{t("columnStatus")}</TableHead>
                      <TableHead className="text-end">{t("columnActions")}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {groupRows.map((row) => {
                      const document = row.original;
                      return (
                        <TableRow key={document.id}>
                          <TableCell className="font-medium tabular-nums">
                            {document.documentNumber ?? t("numberPending")}
                          </TableCell>
                          <TableCell>{document.subjectName ?? "—"}</TableCell>
                          <TableCell>{document.issuedByName ?? "—"}</TableCell>
                          <TableCell className="whitespace-nowrap text-muted-foreground">
                            {dateFormatter.format(new Date(document.issuedAt))}
                          </TableCell>
                          <TableCell>
                            <Badge variant={statusVariant(document.status)}>
                              {statusLabel[document.status]}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-end">
                            <div className="flex justify-end gap-2">
                              {document.editHref && (
                                <Button asChild size="sm" variant="ghost">
                                  <Link href={document.editHref}>
                                    <Pencil className="size-4" data-icon="inline-start" />
                                    {t("edit")}
                                  </Link>
                                </Button>
                              )}
                              {document.isDraft && (
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  disabled={deleting}
                                  onClick={() => removeDraft(document.id)}
                                >
                                  <Trash2 className="size-4" data-icon="inline-start" />
                                  {t("deleteDraft")}
                                </Button>
                              )}
                              <Button asChild size="sm" variant="outline">
                                <Link href={document.viewHref}>
                                  {document.isDraft ? t("preview") : t("view")}
                                </Link>
                              </Button>
                            </div>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            </section>
          );
        }),
      )}

      <div className="flex flex-wrap items-center justify-between gap-3 print:hidden">
        <p className="text-sm text-muted-foreground">
          {t("showing", { from: firstIndex, to: lastIndex, total })}
        </p>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={page <= 1}
            onClick={() => setPage(page <= 2 ? null : page - 1)}
          >
            <ChevronLeft className="size-4 rtl:rotate-180" data-icon="inline-start" />
            {t("previous")}
          </Button>
          <span className="text-sm tabular-nums text-muted-foreground">
            {page} / {totalPages}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={page >= totalPages}
            onClick={() => setPage(page + 1)}
          >
            {t("next")}
            <ChevronRight className="size-4 rtl:rotate-180" data-icon="inline-end" />
          </Button>
        </div>
      </div>
    </div>
  );
}
