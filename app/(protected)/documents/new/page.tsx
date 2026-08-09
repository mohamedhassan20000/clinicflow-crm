import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft, ArrowRight, FileText } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { Button } from "@/components/ui/button";
import { requireUser } from "@/lib/rbac";
import type { DocumentArchetype } from "@/lib/documents/catalog";
import {
  createDocumentHref,
  createFlowIsDirect,
  documentNeedsSetup,
  getAccessibleDocumentTypeCodes,
  groupDocumentTypesByArchetype,
} from "@/lib/documents/module";
import { getDocumentTypeLabels } from "@/lib/documents/module-labels";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("documents.module.new");
  return { title: t("title") };
}

export default async function NewDocumentPage() {
  const [user, t, typeLabels] = await Promise.all([
    requireUser(),
    getTranslations("documents.module.new"),
    getDocumentTypeLabels(),
  ]);

  const accessible = getAccessibleDocumentTypeCodes(user.role);
  const groups = groupDocumentTypesByArchetype(accessible);

  const archetypeLabel: Record<DocumentArchetype, string> = {
    financial: t("archetypeFinancial"),
    clinical: t("archetypeClinical"),
    analytical: t("archetypeAnalytical"),
    roster: t("archetypeRoster"),
    profile: t("archetypeProfile"),
    history: t("archetypeHistory"),
    generic: t("archetypeGeneric"),
  };

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Button asChild variant="ghost" size="sm">
          <Link href="/documents">
            <ArrowLeft className="rtl:rotate-180" data-icon="inline-start" />
            {t("back")}
          </Link>
        </Button>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">{t("title")}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t("subtitle")}</p>
      </div>

      {groups.length === 0 ? (
        <p className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">
          {t("noneAvailable")}
        </p>
      ) : (
        groups.map((group) => (
          <section key={group.archetype} className="space-y-3">
            <h2 className="text-sm font-semibold text-muted-foreground">
              {archetypeLabel[group.archetype]}
            </h2>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {group.codes.map((code) => (
                <Link
                  key={code}
                  href={createDocumentHref(code)}
                  className="group flex items-start justify-between gap-3 rounded-xl border bg-card p-4 transition-colors hover:border-primary/40 hover:bg-accent/40"
                >
                  <div className="flex items-start gap-3">
                    <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                      <FileText className="size-4" aria-hidden />
                    </span>
                    <div>
                      <p className="font-medium">{typeLabels[code]}</p>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {documentNeedsSetup(code)
                          ? t("setupHint")
                          : createFlowIsDirect(code)
                            ? t("directHint")
                            : t("selectSubjectHint")}
                      </p>
                    </div>
                  </div>
                  <ArrowRight
                    className="mt-1 size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 rtl:rotate-180"
                    aria-hidden
                  />
                </Link>
              ))}
            </div>
          </section>
        ))
      )}
    </div>
  );
}
