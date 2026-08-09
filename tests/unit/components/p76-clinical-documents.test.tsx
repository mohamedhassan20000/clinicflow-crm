import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ClinicalDocument } from "@/components/documents/templates/clinical-documents";
import { getClinicalDocumentCopy } from "@/lib/documents/clinical-copy";
import { DOCUMENT_CATALOG } from "@/lib/documents/catalog";
import type { ClinicalDocumentSnapshot, P76ClinicalDocumentCode } from "@/lib/documents/resolvers/clinical-document";

const id = "11111111-1111-4111-8111-111111111111";
const common = {
  version: 1 as const, generatedAt: "2026-08-02T10:30:00.000Z", sourceRecordId: id,
  subject: { patientId: id, fullName: "Omar Hassan", dateOfBirth: "1990-05-12",
    nationalId: "PAT-44", fileNumber: "CF-4491", phone: "+96550000000", bloodType: "A+" },
  physician: { id, fullName: "Dr Sarah Ahmed", professionalLicenseNo: "MD-90112",
    specialty: "Cardiology", professionalTitle: "Senior Consultant", departmentName: "Cardiology",
    signatureSrc: null },
  branding: { name: "Central Health Clinic", logoSrc: "data:image/svg+xml;base64,PHN2Zy8+",
    address: "Medical District", phone: "+965 2222 2222", email: "care@example.com",
    website: "example.com", licenseNo: "CL-42", taxId: null, footerText: null },
  format: { timeZone: "Asia/Kuwait", timeFormat: "24h" as const },
  settings: { watermark: "Central Health Clinic", qrEnabled: true, numberingPrefix: "DOC",
    numberingYearlyReset: true, sequencePadding: 4 },
};
const recordCommon = { id, appointmentId: null, createdAt: "2026-08-02T08:00:00.000Z",
  finalizedAt: "2026-08-02T09:00:00.000Z", createdBy: { id, fullName: "Reception Staff" } };
const snapshots: Record<P76ClinicalDocumentCode, ClinicalDocumentSnapshot> = {
  PRESCRIPTION: { ...common, documentType: "PRESCRIPTION", data: { ...recordCommon,
    kind: "prescription", validUntil: "2026-08-09", notes: "Take after meals",
    medications: [{ id, drugName: "Amoxicillin 500mg", dose: "1 capsule", frequency: "3 daily",
      duration: "7 days", route: "Oral", quantity: "21", instructions: "With water", isControlled: false }] } },
  LAB_REQUEST: { ...common, documentType: "LAB_REQUEST", data: { ...recordCommon,
    kind: "lab-request", priority: "routine", laboratoryName: "Central Lab",
    clinicalContext: "Persistent fatigue", instructions: "Fasting", tests: [{ id, testName: "CBC", notes: null }] } },
  SICK_LEAVE_CERTIFICATE: { ...common, documentType: "SICK_LEAVE_CERTIFICATE", data: { ...recordCommon,
    kind: "sick-leave", appointmentId: id, leaveStartDate: "2026-08-02", leaveEndDate: "2026-08-06",
    recipientOrganization: "Employer", recipientReference: "HR-10", restrictions: "Rest at home",
    returnDate: "2026-08-07" } },
};
const orders: Record<P76ClinicalDocumentCode, string[]> = {
  PRESCRIPTION: ["field-grid", "section-header", "data-table", "notes-callout", "verification-block", "signature-block"],
  LAB_REQUEST: ["field-grid", "section-header", "field-grid", "checklist-panel", "notes-callout", "notes-callout", "verification-block", "signature-block"],
  SICK_LEAVE_CERTIFICATE: ["field-grid", "section-header", "field-grid", "certifying-prose", "notes-callout", "verification-block", "signature-block"],
};

describe("P7-6 clinical documents", () => {
  it.each(Object.keys(snapshots) as P76ClinicalDocumentCode[])("renders %s through the approved hierarchy", (type) => {
    const { container } = render(<ClinicalDocument locale="en" lifecycle="issued" snapshot={snapshots[type]}
      copy={getClinicalDocumentCopy("en", type)} documentNumber="DOC-2026-0001"
      qrDataUrl="data:image/png;base64,iVBORw0KGgo=" />);
    expect(Array.from(container.querySelectorAll(".cf-document-body > [data-testid]"))
      .map((node) => node.getAttribute("data-testid"))).toEqual(orders[type]);
    expect(container.querySelector(".cf-doc-logo")).toHaveAttribute("src", snapshots[type].branding.logoSrc);
    expect(container.querySelector(".cf-doc-qr")).toHaveAttribute("src", "data:image/png;base64,iVBORw0KGgo=");
    expect(container).toHaveTextContent("Blank area for manual signature");
  });

  it("keeps the Arabic prescription notice fully RTL without English legal copy", () => {
    const { container } = render(<ClinicalDocument locale="ar" lifecycle="preview" snapshot={snapshots.PRESCRIPTION}
      copy={getClinicalDocumentCopy("ar", "PRESCRIPTION")} qrDataUrl="data:image/png;base64,preview" />);
    expect(container).toHaveTextContent("لا تُعد هذه الوصفة الطبية معتمدة إلا بعد توقيع الطبيب أو ختمه أو كليهما.");
    expect(container).not.toHaveTextContent("This prescription is not considered valid unless signed, stamped, or both by the responsible physician.");
    const notice = container.querySelector("[data-testid='notes-callout']");
    expect(notice).toHaveTextContent("وصفة صادرة عن العيادة");
    expect(notice?.querySelector("[dir='ltr']")).not.toBeInTheDocument();
    expect(notice?.querySelectorAll(".cf-doc-callout-content > p")).toHaveLength(3);
    expect(container.querySelector("[data-testid='verification-block']")).not.toBeInTheDocument();
    expect(container.querySelector("[data-testid='document-page']")).toHaveAttribute("dir", "rtl");
    expect(container.textContent).not.toMatch(/[٠-٩۰-۹]/);
    expect(container).toHaveTextContent("اعتماد العيادة / الختم الرسمي");
  });

  it.each(Object.keys(snapshots) as P76ClinicalDocumentCode[])(
    "renders fully localized Arabic system copy for %s",
    (type) => {
      const copy = getClinicalDocumentCopy("ar", type);
      const { container } = render(<ClinicalDocument locale="ar" lifecycle="issued"
        snapshot={snapshots[type]} copy={copy} documentNumber="DOC-2026-0001"
        qrDataUrl="data:image/png;base64,iVBORw0KGgo=" />);

      expect(container.querySelector(".cf-doc-title")).toHaveTextContent(copy.title);
      expect(container.querySelector(".cf-doc-meta-grid")).toHaveTextContent("رقم المستند");
      expect(container.querySelector("[data-testid='field-grid']"))
        .toHaveTextContent("الاسم الكامل");
      expect(container.querySelector("[data-testid='field-grid']"))
        .toHaveTextContent("اسم الطبيب");
      expect(container.querySelector("[data-testid='verification-block']"))
        .toHaveTextContent("التحقق من المستند");
      expect(container.querySelector("[data-testid='signature-block']"))
        .toHaveTextContent("توقيع الطبيب المسؤول");
      expect(container.querySelector("[data-testid='document-footer']"))
        .toHaveTextContent("نظام كلينيك فلو للسجلات الطبية");
      for (const english of [
        "Document ID",
        "Patient information",
        "Responsible physician",
        "Order verification",
        "Responsible physician signature",
        "ClinicFlow Medical Records System",
      ]) {
        expect(container).not.toHaveTextContent(english);
      }
      expect(container.textContent).not.toMatch(/[٠-٩۰-۹]/);
    },
  );

  it("keeps the English prescription notice fully LTR without Arabic legal copy", () => {
    const { container } = render(<ClinicalDocument locale="en" lifecycle="preview"
      snapshot={snapshots.PRESCRIPTION} copy={getClinicalDocumentCopy("en", "PRESCRIPTION")} />);
    const notice = container.querySelector("[data-testid='notes-callout']");

    expect(container.querySelector("[data-testid='document-page']")).toHaveAttribute("dir", "ltr");
    expect(notice).toHaveTextContent("This prescription is not considered valid unless signed, stamped, or both by the responsible physician.");
    expect(notice).not.toHaveTextContent("لا تُعد هذه الوصفة الطبية معتمدة");
    expect(notice?.querySelector("[dir='rtl']")).not.toBeInTheDocument();
  });

  it("renders a saved draft before finalization without inventing a finalization date", () => {
    const snapshot = { ...snapshots.PRESCRIPTION, data: {
      ...snapshots.PRESCRIPTION.data, finalizedAt: null,
    } } satisfies ClinicalDocumentSnapshot;
    const { container } = render(<ClinicalDocument locale="en" lifecycle="preview" snapshot={snapshot}
      copy={getClinicalDocumentCopy("en", "PRESCRIPTION")} qrDataUrl="data:image/png;base64,preview" />);
    expect(container.querySelector("[data-testid='document-page']")).toBeInTheDocument();
    expect(container.querySelector("[data-testid='verification-block']")).not.toBeInTheDocument();
    expect(container).toHaveTextContent("Clinic approval / official stamp");
  });

  it("registers exactly the three clinical codes with their approved prefixes and roles", () => {
    expect(DOCUMENT_CATALOG.PRESCRIPTION.numbering.prefix).toBe("RX");
    expect(DOCUMENT_CATALOG.LAB_REQUEST.numbering.prefix).toBe("LAB");
    expect(DOCUMENT_CATALOG.SICK_LEAVE_CERTIFICATE.numbering.prefix).toBe("SL");
    for (const code of ["PRESCRIPTION", "LAB_REQUEST", "SICK_LEAVE_CERTIFICATE"] as const) {
      expect(DOCUMENT_CATALOG[code].archetype).toBe("clinical");
      expect(DOCUMENT_CATALOG[code].pageRoles).toEqual(["admin", "manager", "receptionist", "doctor", "assistant"]);
    }
  });
});
