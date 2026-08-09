"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, FileCheck2, Languages, Pencil, Printer } from "lucide-react";
import { toast } from "sonner";
import { useTranslations } from "next-intl";
import { GenericDocument } from "@/components/documents/templates/generic-document";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { issueGenericDocument, previewGenericDocument } from "@/actions/generic-documents";
import { saveDocumentDraft } from "@/actions/document-drafts";
import { getGenericDocumentCopy } from "@/lib/documents/generic-copy";
import {
  parseGenericBody,
  type GenericDocumentSnapshot,
} from "@/lib/documents/generic-shared";
import { issuedDocumentDetailHref } from "@/lib/documents/module";
import type { Locale } from "@/lib/i18n/config";

type Props = {
  defaultLocale: Locale;
  idempotencyKey: string;
  initialDraft?: {
    id: string;
    title: string;
    body: string;
    locale: Locale;
    snapshot: GenericDocumentSnapshot;
  };
};

/**
 * P7 Phase 4 — "Create document from scratch" composer. Single client surface
 * that runs the standard lifecycle without a source table: empty authoring form
 * → Save → Preview (with language / print / issue / edit) → Issue redirects to
 * the server-rendered issued surface (QR + history + reprint).
 */
export function GenericDocumentComposer({ defaultLocale, idempotencyKey, initialDraft }: Props) {
  const t = useTranslations("documents.module.generic");
  const router = useRouter();
  const [title, setTitle] = useState(initialDraft?.title ?? "");
  const [body, setBody] = useState(initialDraft?.body ?? "");
  const [locale, setLocale] = useState<Locale>(initialDraft?.locale ?? defaultLocale);
  const [draftId, setDraftId] = useState(initialDraft?.id);
  const [snapshot, setSnapshot] = useState<GenericDocumentSnapshot | null>(
    initialDraft?.snapshot ?? null,
  );
  const [isSaving, startSave] = useTransition();
  const [isIssuing, startIssue] = useTransition();

  const blocks = useMemo(() => parseGenericBody(body), [body]);
  const canSave = title.trim().length > 0 && blocks.length > 0;

  function save(nextLocale: Locale = locale) {
    if (!canSave) return;
    startSave(async () => {
      const result = await previewGenericDocument({
        documentType: "GENERIC_DOCUMENT", title: title.trim(), blocks,
      });
      if (!result.data) {
        toast.error(t("previewFailed"));
        return;
      }
      const persisted = await saveDocumentDraft({
        draftId,
        documentType: "GENERIC_DOCUMENT",
        locale: nextLocale,
        params: {
          documentType: "GENERIC_DOCUMENT",
          title: title.trim(),
          blocks,
        },
      });
      if (!persisted.data) {
        toast.error(t("previewFailed"));
        return;
      }
      setDraftId(persisted.data.id);
      setLocale(nextLocale);
      setSnapshot(result.data);
    });
  }

  function issue() {
    startIssue(async () => {
      const result = await issueGenericDocument({
        documentType: "GENERIC_DOCUMENT", title: title.trim(), blocks, locale,
        idempotencyKey: draftId ?? idempotencyKey,
        draftId,
      });
      if (!result.data) {
        toast.error(t("issueFailed"));
        return;
      }
      toast.success(t("issued"));
      router.replace(issuedDocumentDetailHref(result.data.documentId));
    });
  }

  if (snapshot) {
    const copy = getGenericDocumentCopy(locale);
    return (
      <div className="flex flex-col gap-6">
        <div className="flex flex-wrap items-start justify-between gap-3 print:hidden">
          <div>
            <Button variant="ghost" size="sm" onClick={() => setSnapshot(null)}>
              <ArrowLeft className="rtl:rotate-180" data-icon="inline-start" />
              {t("backToAuthoring")}
            </Button>
            <h1 className="mt-2 text-xl font-semibold">{t("draftTitle", { name: title.trim() })}</h1>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-1 rounded-lg border bg-background p-1">
              <Languages className="mx-1 size-4 text-muted-foreground" aria-hidden />
              <Button size="sm" variant={locale === "en" ? "secondary" : "ghost"} onClick={() => save("en")}>
                {t("english")}
              </Button>
              <Button size="sm" variant={locale === "ar" ? "secondary" : "ghost"} onClick={() => save("ar")}>
                {t("arabic")}
              </Button>
            </div>
            <Button variant="outline" onClick={() => setSnapshot(null)}>
              <Pencil data-icon="inline-start" />{t("edit")}
            </Button>
            <Button variant="outline" onClick={() => window.print()}>
              <Printer data-icon="inline-start" />{t("printDraft")}
            </Button>
            <Button onClick={issue} disabled={isIssuing}>
              <FileCheck2 data-icon="inline-start" />{isIssuing ? t("issuing") : t("issue")}
            </Button>
          </div>
        </div>
        <GenericDocument locale={locale} lifecycle="preview" snapshot={snapshot} copy={copy} />
      </div>
    );
  }

  return (
    <section className="rounded-xl border bg-card p-5">
      <h2 className="mb-1 font-semibold">{t("formHeading")}</h2>
      <p className="mb-4 text-sm text-muted-foreground">{t("formSubtitle")}</p>
      <div className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="generic-title">{t("titleLabel")}</Label>
          <Input id="generic-title" value={title} maxLength={160}
            onChange={(event) => setTitle(event.target.value)} placeholder={t("titlePlaceholder")} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="generic-body">{t("bodyLabel")}</Label>
          <Textarea id="generic-body" value={body} rows={14}
            onChange={(event) => setBody(event.target.value)} placeholder={t("bodyPlaceholder")} />
          <p className="text-xs text-muted-foreground">{t("bodyHint")}</p>
        </div>
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-1 rounded-lg border bg-background p-1">
            <Languages className="mx-1 size-4 text-muted-foreground" aria-hidden />
            <Button size="sm" type="button" variant={locale === "en" ? "secondary" : "ghost"} onClick={() => setLocale("en")}>
              {t("english")}
            </Button>
            <Button size="sm" type="button" variant={locale === "ar" ? "secondary" : "ghost"} onClick={() => setLocale("ar")}>
              {t("arabic")}
            </Button>
          </div>
          <Button onClick={() => save()} disabled={!canSave || isSaving}>
            {isSaving ? t("saving") : t("saveContinue")}
          </Button>
        </div>
      </div>
    </section>
  );
}
