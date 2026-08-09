import { writeFile } from "node:fs/promises";
import { stat } from "node:fs/promises";
import { DocumentEngineHarness } from "@/components/documents/harness/document-engine-harness";
import { renderDocumentPdf, resolveChromiumExecutablePath } from "@/lib/documents/pdf";
import { generateDocumentVerificationQrDataUrl } from "@/lib/documents/verification-qr";

async function main() {
  const outputPath = process.argv[2];
  if (!outputPath) throw new Error("Usage: validate-p71-document-engine.tsx <output.pdf>");

  const qrDataUrl = await generateDocumentVerificationQrDataUrl(
    "P71RoundTripToken_2026_00000001",
  );
  const executablePath = await resolveChromiumExecutablePath();
  const result = await renderDocumentPdf({
    renderDocument: (renderContextBoundary) => (
      <DocumentEngineHarness locale="ar" qrDataUrl={qrDataUrl} lifecycle="issued"
        renderContextBoundary={renderContextBoundary} />
    ),
    locale: "ar",
    title: "P7-1 Arabic document engine round trip",
  });
  await writeFile(outputPath, result.pdf);
  const output = await stat(outputPath);
  process.stdout.write(`${JSON.stringify({
    outputPath,
    executablePath,
    pageCount: result.pageCount,
    bytes: output.size,
    pdfMagic: Buffer.from(result.pdf.subarray(0, 5)).toString("ascii"),
  })}\n`);
}

void main();
