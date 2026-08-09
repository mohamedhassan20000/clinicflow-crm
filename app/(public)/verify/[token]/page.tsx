import type { Metadata } from "next";
import { headers } from "next/headers";
import { getLocale, getTranslations } from "next-intl/server";
import { BadgeCheck, CircleAlert, CircleX } from "lucide-react";
import { formatDocDate } from "@/lib/documents/format";
import {
  lookupPublicDocumentVerification,
  verificationDocumentTypeLabelKey,
} from "@/lib/documents/verification";
import { checkRateLimit } from "@/lib/rate-limit";
import type { Locale } from "@/lib/i18n/config";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("documentPlatform.verification");
  return { title: t("title"), robots: { index: false, follow: false } };
}

export default async function VerifyDocumentPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const [{ token }, requestHeaders, locale, t] = await Promise.all([
    params,
    headers(),
    getLocale() as Promise<Locale>,
    getTranslations("documentPlatform.verification"),
  ]);
  const identifier =
    requestHeaders.get("x-forwarded-for")?.split(",", 1)[0]?.trim()
    || requestHeaders.get("x-real-ip")?.trim()
    || "unknown";
  const limit = await checkRateLimit("document-verification", identifier, {
    limit: 30,
    windowSeconds: 60,
    failureMode: "closed",
  });
  const verification = limit.allowed
    ? await lookupPublicDocumentVerification(token)
    : {
      status: "unavailable" as const,
      documentNumber: null,
      documentType: null,
      issueDate: null,
      clinicName: null,
    };
  const available = verification.status !== "unavailable";
  const Icon = verification.status === "valid"
    ? BadgeCheck
    : verification.status === "unavailable"
      ? CircleAlert
      : CircleX;
  const statusLabel = verification.status === "valid"
    ? t("statuses.valid")
    : verification.status === "void"
      ? t("statuses.void")
      : verification.status === "cancelled"
        ? t("statuses.cancelled")
        : t("statuses.unavailable");

  return (
    <main className="flex min-h-dvh items-center justify-center bg-muted/30 px-4 py-12">
      <section className="w-full max-w-lg rounded-2xl border bg-card p-6 shadow-sm sm:p-8">
        <div className="flex items-start gap-4">
          <Icon className="mt-1 size-8 shrink-0 text-primary" aria-hidden />
          <div>
            {/* i18n-allow: registered product name */}
            <p className="text-sm font-medium text-primary">ClinicFlow</p>
            <h1 className="mt-1 text-2xl font-bold">{t("title")}</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              {available ? t("confirmed") : t("unavailableDescription")}
            </p>
          </div>
        </div>

        <dl className="mt-8 divide-y rounded-xl border">
          <VerificationRow label={t("status")} value={statusLabel} />
          {available && (
            <>
              <VerificationRow label={t("documentNumber")} value={verification.documentNumber!} ltr />
              <VerificationRow
                label={t("documentType")}
                value={documentTypeLabel(verification.documentType, t)}
              />
              <VerificationRow
                label={t("issueDate")}
                value={formatDocDate(verification.issueDate!, { locale }, { dateStyle: "long" })}
                ltr
              />
              <VerificationRow label={t("issuingClinic")} value={verification.clinicName!} />
            </>
          )}
        </dl>
      </section>
    </main>
  );
}

type VerificationTranslator = Awaited<
  ReturnType<typeof getTranslations<"documentPlatform.verification">>
>;

function documentTypeLabel(
  documentType: string | null,
  t: VerificationTranslator,
): string {
  return t(verificationDocumentTypeLabelKey(documentType));
}

function VerificationRow({
  label,
  value,
  ltr = false,
}: {
  label: string;
  value: string;
  ltr?: boolean;
}) {
  return (
    <div className="grid grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)] gap-4 px-4 py-3">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="text-end text-sm font-medium" dir={ltr ? "ltr" : undefined}>{value}</dd>
    </div>
  );
}
