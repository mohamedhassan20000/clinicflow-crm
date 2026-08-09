import { describe, expect, it } from "vitest";
import { ClinicalDocument } from "@/components/documents/templates/clinical-documents";
import { getClinicalDocumentCopy } from "@/lib/documents/clinical-copy";
import { buildDocumentHtml, renderDocumentPdf } from "@/lib/documents/pdf";
import type { ClinicalDocumentSnapshot } from "@/lib/documents/resolvers/clinical-document";
import { generateDocumentVerificationQrDataUrl } from "@/lib/documents/verification-qr";

const id = "11111111-1111-4111-8111-111111111111";
const snapshot: ClinicalDocumentSnapshot = {
  version: 1, documentType: "PRESCRIPTION", generatedAt: "2026-08-02T10:30:00.000Z", sourceRecordId: id,
  subject: { patientId: id, fullName: "عمر حسان", dateOfBirth: "1990-05-12", nationalId: "PAT-44",
    fileNumber: "CF-4491", phone: "+96550000000", bloodType: "A+" },
  physician: { id, fullName: "د. سارة أحمد", professionalLicenseNo: "MD-90112", specialty: "طب القلب",
    professionalTitle: "استشاري", departmentName: "القلب", signatureSrc: null },
  branding: { name: "مركز الرعاية الطبية", logoSrc: "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxMCIgaGVpZ2h0PSIxMCI+PHJlY3Qgd2lkdGg9IjEwIiBoZWlnaHQ9IjEwIiBmaWxsPSIjMDA2NTc1Ii8+PC9zdmc+",
    address: "الكويت", phone: "+965 2222 2222", email: "care@example.com", website: "example.com",
    licenseNo: "CL-42", taxId: null, footerText: null },
  format: { timeZone: "Asia/Kuwait", timeFormat: "24h" },
  settings: { watermark: "مركز الرعاية الطبية", qrEnabled: true, numberingPrefix: "RX",
    numberingYearlyReset: true, sequencePadding: 4 },
  data: { kind: "prescription", id, appointmentId: null, createdAt: "2026-08-02T08:00:00.000Z",
    finalizedAt: "2026-08-02T09:00:00.000Z", createdBy: { id, fullName: "موظف الاستقبال" },
    validUntil: "2026-08-09", notes: "بعد الطعام", medications: [{ id, drugName: "Amoxicillin 500mg",
      dose: "كبسولة", frequency: "٣ مرات يومياً", duration: "٧ أيام", route: "فموي", quantity: "٢١",
      instructions: "مع الماء", isControlled: false }] },
};

describe("P7-6 clinical PDF rendering", () => {
  it("renders the Arabic prescription with tenant logo, real QR, validity note, and blank signature area", async () => {
    const qrDataUrl = await generateDocumentVerificationQrDataUrl("0123456789abcdef0123456789abcdef");
    const renderDocument = (renderContextBoundary: Parameters<typeof ClinicalDocument>[0]["renderContextBoundary"]) => (
      <ClinicalDocument locale="ar" lifecycle="issued" snapshot={snapshot}
        copy={getClinicalDocumentCopy("ar", "PRESCRIPTION")} documentNumber="RX-٢٠٢٦-٠٠٠١"
        qrDataUrl={qrDataUrl} renderContextBoundary={renderContextBoundary} />
    );
    const html = await buildDocumentHtml({ renderDocument, locale: "ar", title: "P7-6 Arabic Prescription" });
    expect(html).toContain(snapshot.branding.logoSrc);
    expect(html).toContain("data:image/png;base64,");
    expect(html).toContain("لا تُعد هذه الوصفة الطبية معتمدة إلا بعد توقيع الطبيب أو ختمه أو كليهما.");
    expect(html).toContain("مساحة فارغة للتوقيع اليدوي");
    expect(html).toContain("RX-2026-0001");
    expect(html).not.toMatch(/[٠-٩۰-۹]/);
    const result = await renderDocumentPdf({ renderDocument, locale: "ar", title: "P7-6 Arabic Prescription" });
    expect(Buffer.from(result.pdf.subarray(0, 5)).toString("ascii")).toBe("%PDF-");
    expect(result.pdf.byteLength).toBeGreaterThan(10_000);
    expect(result.pageCount).toBeGreaterThanOrEqual(1);
  }, 60_000);
});
