import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { getLocale, getTranslations } from "next-intl/server";
import { DocumentSetupControls } from "@/components/documents/module/document-setup-controls";
import { Button } from "@/components/ui/button";
import { isRegisteredDocumentType } from "@/lib/documents/catalog";
import {
  canRoleAccessDocumentType,
  documentNeedsSetup,
  documentPreviewSurfaceHref,
  documentSetupFields,
} from "@/lib/documents/module";
import { getDocumentTypeLabels } from "@/lib/documents/module-labels";
import { getDocumentSetupLabels, loadDocumentSetupOptions } from "@/lib/documents/setup";
import { requireUser } from "@/lib/rbac";
import type { Locale } from "@/lib/i18n/config";
import { getClinicDocumentDraft } from "@/actions/document-drafts";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("documents.module.setup");
  return { title: t("title") };
}

export default async function DocumentSetupPage({ params, searchParams }: {
  params: Promise<{ code: string }>;
  searchParams: Promise<{ draftId?: string }>;
}) {
  const [{ code }, sp, user, t, defaultLocale] = await Promise.all([
    params,
    searchParams,
    requireUser(),
    getTranslations("documents.module.setup"),
    getLocale() as Promise<Locale>,
  ]);
  if (!isRegisteredDocumentType(code) || !documentNeedsSetup(code)) notFound();
  if (!canRoleAccessDocumentType(user.role, code)) notFound();

  const fields = documentSetupFields(code);
  const [options, setupLabels, typeLabels, draftResult] = await Promise.all([
    loadDocumentSetupOptions(user, fields),
    getDocumentSetupLabels(),
    getDocumentTypeLabels(),
    sp.draftId ? getClinicDocumentDraft(sp.draftId) : Promise.resolve(null),
  ]);
  const draft = draftResult?.data;
  if (sp.draftId && (!draft || draft.documentType !== code)) notFound();
  const initial = (draft?.params ?? {}) as Record<string, string>;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Button asChild variant="ghost" size="sm">
          <Link href="/documents/new">
            <ArrowLeft className="rtl:rotate-180" data-icon="inline-start" />
            {t("back")}
          </Link>
        </Button>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">
          {t("prepare", { name: typeLabels[code] })}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">{t("subtitle")}</p>
      </div>
      <DocumentSetupControls
        fields={fields}
        options={options}
        initial={initial}
        targetHref={documentPreviewSurfaceHref(code)}
        locale={defaultLocale}
        mode="setup"
        labels={setupLabels}
        extraParams={{ origin: "documents" }}
        documentType={code}
        draftId={draft?.id}
      />
    </div>
  );
}
