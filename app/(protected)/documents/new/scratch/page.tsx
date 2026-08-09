import { randomUUID } from "node:crypto";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { getLocale, getTranslations } from "next-intl/server";
import { GenericDocumentComposer } from "@/components/documents/module/generic-document-composer";
import { Button } from "@/components/ui/button";
import { getDocumentCatalogEntry } from "@/lib/documents/catalog";
import { requireUser } from "@/lib/rbac";
import type { Locale } from "@/lib/i18n/config";
import { getClinicDocumentDraft } from "@/actions/document-drafts";
import { previewGenericDocument } from "@/actions/generic-documents";
import type { GenericDocumentBlock } from "@/lib/documents/generic-shared";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("documents.module.generic");
  return { title: t("title") };
}

export default async function NewGenericDocumentPage({ searchParams }: {
  searchParams: Promise<{ draftId?: string }>;
}) {
  const sp = await searchParams;
  const [user, t, defaultLocale] = await Promise.all([
    requireUser(),
    getTranslations("documents.module.generic"),
    getLocale() as Promise<Locale>,
  ]);
  const catalog = getDocumentCatalogEntry("GENERIC_DOCUMENT");
  if (!catalog.pageRoles.includes(user.role)) notFound();
  const draftResult = sp.draftId ? await getClinicDocumentDraft(sp.draftId) : null;
  const draft = draftResult?.data;
  if (sp.draftId && (!draft || draft.documentType !== "GENERIC_DOCUMENT")) notFound();
  const title = typeof draft?.params.title === "string" ? draft.params.title : "";
  const blocks = Array.isArray(draft?.params.blocks)
    ? draft.params.blocks as GenericDocumentBlock[]
    : [];
  const preview = draft
    ? await previewGenericDocument({ documentType: "GENERIC_DOCUMENT", title, blocks })
    : null;
  if (draft && !preview?.data) notFound();
  const body = blocks.map((block) => block.kind === "heading" ? `# ${block.text}` : block.text).join("\n\n");

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Button asChild variant="ghost" size="sm">
          <Link href="/documents/new">
            <ArrowLeft className="rtl:rotate-180" data-icon="inline-start" />
            {t("back")}
          </Link>
        </Button>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">{t("title")}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t("subtitle")}</p>
      </div>
      <GenericDocumentComposer
        defaultLocale={defaultLocale}
        idempotencyKey={draft?.id ?? randomUUID()}
        initialDraft={draft && preview?.data ? {
          id: draft.id,
          title,
          body,
          locale: draft.locale,
          snapshot: preview.data,
        } : undefined}
      />
    </div>
  );
}
