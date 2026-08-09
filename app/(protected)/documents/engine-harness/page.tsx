import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { DocumentEngineHarness } from "@/components/documents/harness/document-engine-harness";
import { generateDocumentVerificationQrDataUrl } from "@/lib/documents/verification-qr";

export const metadata: Metadata = {
  title: "Document Engine Harness",
  robots: { index: false, follow: false },
};

export default async function DocumentEngineHarnessPage() {
  if (process.env.NODE_ENV === "production") notFound();

  const qrDataUrl = await generateDocumentVerificationQrDataUrl(
    "P71HarnessToken_2026_00000001",
  );
  return (
    <div className="space-y-8 pb-12">
      <div>
        <h1 className="text-2xl font-semibold">P7-1 document engine harness</h1>
        <p className="text-sm text-muted-foreground">
          Shared primitives in English LTR and Arabic RTL. This is an implementation harness, not the Documents module.
        </p>
      </div>
      <DocumentEngineHarness locale="en" qrDataUrl={qrDataUrl} />
      <DocumentEngineHarness locale="ar" qrDataUrl={qrDataUrl} />
    </div>
  );
}
