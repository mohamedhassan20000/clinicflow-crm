import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { DocumentConformanceHarness } from "@/components/documents/harness/document-conformance-harness";
import {
  P72_CONFORMANCE_MANIFEST,
  getP72ConformanceSummary,
  isP72DocumentConformant,
} from "@/components/documents/harness/p72-conformance-manifest";
import { generateDocumentVerificationQrDataUrl } from "@/lib/documents/verification-qr";

export const metadata: Metadata = {
  title: "P7-2 Document Conformance Harness",
  robots: { index: false, follow: false },
};

export default async function DocumentConformanceHarnessPage() {
  if (process.env.NODE_ENV === "production") notFound();

  const qrDataUrl = await generateDocumentVerificationQrDataUrl(
    "P72ConformanceToken_2026_000001",
  );
  const summary = getP72ConformanceSummary();

  return (
    <div className="space-y-8 pb-12">
      <header>
        <h1 className="text-2xl font-semibold">P7-2 design-to-engine conformance harness</h1>
        <p className="text-sm text-muted-foreground">
          Non-production structural proofs for all 16 bilingual designs. The gate fails closed until every Figma variant is verified.
        </p>
        <p className="text-sm" data-testid="p72-gate-status">
          Gate: {summary.gatePassed ? "PASSED" : "BLOCKED"} · {summary.verifiedVariants}/{summary.variants} variants verified · {summary.conformantDocuments}/{summary.documents} documents signed off
        </p>
      </header>

      {P72_CONFORMANCE_MANIFEST.map((entry) => (
        <section className="space-y-4" key={entry.code} data-testid="p72-conformance-entry">
          <h2 className="text-xl font-semibold">
            {String(entry.ordinal).padStart(2, "0")} · {entry.title} · {isP72DocumentConformant(entry) ? "CONFORMANT" : "BLOCKED"}
          </h2>
          <p className="text-xs text-muted-foreground">
            Primitive map: {entry.primitives.join(" → ")}
          </p>
          <DocumentConformanceHarness entry={entry} locale="en" qrDataUrl={qrDataUrl} />
          <DocumentConformanceHarness entry={entry} locale="ar" qrDataUrl={qrDataUrl} />
        </section>
      ))}
    </div>
  );
}
