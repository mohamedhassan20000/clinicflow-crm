import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DOCUMENT_ENGINE_CSS } from "@/components/documents/engine";
import { RosterProfileDocument } from "@/components/documents/templates/roster-profile-documents";
import { DOCUMENT_CATALOG } from "@/lib/documents/catalog";
import { buildDocumentHtml } from "@/lib/documents/pdf";
import { getRosterProfileCopy } from "@/lib/documents/roster-profile-copy";
import type {
  P75RosterProfileDocumentCode,
  RosterProfileDocumentSnapshot,
} from "@/lib/documents/resolvers/roster-profile";

const base = {
  version: 1 as const,
  generatedAt: "2026-08-01T09:15:00.000Z",
  filters: { patientId: null, staffId: null, departmentId: null, doctorId: null, role: null, search: null },
  branding: { name: "ClinicFlow Medical Group", logoSrc: null, address: "Medical District",
    phone: "+90 212 555 0199", email: "clinic@example.com", website: "clinic.example.com",
    licenseNo: "LIC-42", taxId: "TAX-42", footerText: null },
  format: { timeZone: "Europe/Istanbul", timeFormat: "24h" as const },
  settings: { watermark: "CONFIDENTIAL", qrEnabled: true, numberingPrefix: "DOC",
    numberingYearlyReset: true, sequencePadding: 4 },
  attachments: [],
};

const snapshots: Record<P75RosterProfileDocumentCode, RosterProfileDocumentSnapshot> = {
  PATIENT_LIST_REPORT: { ...base, documentType: "PATIENT_LIST_REPORT", data: {
    kind: "patient-list", rows: [{ id: "patient-1", fileNumber: "CF-0013",
      fullName: "Ada Lovelace", nationalId: "123456789", doctorName: "Dr. Sara Emad",
      phone: "+90 555 000 0000", bloodType: "A+", departmentId: "department-1",
      departmentName: "Dermatology" }],
  } },
  PATIENT_FILE: { ...base, documentType: "PATIENT_FILE", data: {
    kind: "patient-file", id: "patient-1", fullName: "Ada Lovelace", initials: "AL",
    imageSrc: null, fileNumber: "CF-0013", nationalId: "123456789", phone: "+90 555 000 0000",
    email: "ada@example.com", dateOfBirth: "1990-02-12", bloodType: "A+",
    createdAt: "2025-02-12T08:00:00.000Z", departmentName: "Dermatology",
    doctorName: "Dr. Sara Emad", insuranceName: "Private", isActive: true,
  } },
  SYSTEM_MEMBERS_REPORT: { ...base, documentType: "SYSTEM_MEMBERS_REPORT", data: {
    kind: "system-members", rows: [{ id: "staff-1", fullName: "Dr. Sara Emad", initials: "DS",
      departmentId: "department-1", departmentName: "Dermatology", role: "doctor",
      isActive: true, joinedAt: "2025-01-10T08:00:00.000Z" }],
  } },
  STAFF_FILE: { ...base, documentType: "STAFF_FILE", data: {
    kind: "staff-file", id: "staff-1", fullName: "Dr. Sara Emad", initials: "DS",
    imageSrc: null, phone: "+90 555 000 0001", role: "doctor", departmentName: "Dermatology",
    joinedAt: "2025-01-10T08:00:00.000Z", isActive: true,
    schedule: [{ dayOfWeek: 1, enabled: true, startTime: "09:00:00", endTime: "17:00:00" }],
  } },
};

const primitiveOrder: Record<P75RosterProfileDocumentCode, string[]> = {
  PATIENT_LIST_REPORT: ["grouped-tables", "verification-block", "signature-block"],
  PATIENT_FILE: ["identity-hero", "section-header", "field-grid", "verification-block", "signature-block"],
  SYSTEM_MEMBERS_REPORT: ["field-grid", "grouped-tables", "notes-callout", "verification-block"],
  STAFF_FILE: ["section-header", "identity-hero", "field-grid", "data-table",
    "totals-summary", "notes-callout", "signature-block", "verification-block"],
};

describe("P7-5 roster/profile documents", () => {
  it.each(Object.keys(snapshots) as P75RosterProfileDocumentCode[])(
    "renders %s through its approved primitive hierarchy",
    (documentType) => {
      const { container } = render(<RosterProfileDocument locale="en" lifecycle="issued"
        snapshot={snapshots[documentType]} copy={getRosterProfileCopy("en", documentType)}
        documentNumber="DOC-2026-0001" qrDataUrl="data:image/png;base64,iVBORw0KGgo=" />);
      const primitives = Array.from(container.querySelectorAll(".cf-document-body > [data-testid]"))
        .map((node) => node.getAttribute("data-testid"));
      expect(primitives).toEqual(primitiveOrder[documentType]);
      expect(container).toHaveTextContent("DOC-2026-0001");
      expect(container.querySelector("[data-testid='verification-block'] img"))
        .toHaveAttribute("src", "data:image/png;base64,iVBORw0KGgo=");
    },
  );

  it("keeps the Patient File photo slot identical in preview and issued output", () => {
    const imageSrc = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
    const imageBackgroundSrc = "data:image/webp;base64,UklGRg==";
    const snapshot: RosterProfileDocumentSnapshot = {
      ...snapshots.PATIENT_FILE,
      data: { ...snapshots.PATIENT_FILE.data, imageSrc, imageBackgroundSrc },
    } as RosterProfileDocumentSnapshot;
    const copy = getRosterProfileCopy("en", "PATIENT_FILE");

    const preview = render(<RosterProfileDocument locale="en" lifecycle="preview"
      snapshot={snapshot} copy={copy} />);
    const previewAvatar = preview.container.querySelector(".cf-doc-avatar-layered");
    expect(previewAvatar).toHaveClass("cf-doc-avatar");
    expect(previewAvatar?.querySelector(".cf-doc-avatar-background"))
      .toHaveAttribute("src", imageBackgroundSrc);
    expect(previewAvatar?.querySelector(".cf-doc-avatar-foreground"))
      .toHaveAttribute("src", imageSrc);
    preview.unmount();

    const issued = render(<RosterProfileDocument locale="en" lifecycle="issued"
      snapshot={snapshot} copy={copy} documentNumber="DOC-2026-0001" />);
    const issuedAvatar = issued.container.querySelector(".cf-doc-avatar-layered");
    expect(issuedAvatar?.querySelector(".cf-doc-avatar-background"))
      .toHaveAttribute("src", imageBackgroundSrc);
    expect(issuedAvatar?.querySelector(".cf-doc-avatar-foreground"))
      .toHaveAttribute("src", imageSrc);
  });

  it("carries the same Patient File photo into canonical PDF HTML", async () => {
    const imageSrc = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
    const imageBackgroundSrc = "data:image/webp;base64,UklGRg==";
    const snapshot: RosterProfileDocumentSnapshot = {
      ...snapshots.PATIENT_FILE,
      data: { ...snapshots.PATIENT_FILE.data, imageSrc, imageBackgroundSrc },
    } as RosterProfileDocumentSnapshot;

    const html = await buildDocumentHtml({
      locale: "en",
      title: "Patient File photo parity",
      renderDocument: (renderContextBoundary) => (
        <RosterProfileDocument locale="en" lifecycle="issued" snapshot={snapshot}
          copy={getRosterProfileCopy("en", "PATIENT_FILE")} documentNumber="DOC-2026-0001"
          renderContextBoundary={renderContextBoundary} />
      ),
    });

    expect(html).toContain(`src="${imageSrc}"`);
    expect(html).toContain(`src="${imageBackgroundSrc}"`);
    expect(html).toContain('class="cf-doc-avatar cf-doc-avatar-layered"');
    expect(html).toContain('class="cf-doc-avatar-foreground"');
  });

  it("layers an uncropped foreground over a blurred fill without changing the 72px photo box", () => {
    const backgroundRule = DOCUMENT_ENGINE_CSS.match(/\.cf-doc-avatar-background \{([\s\S]*?)\}/)?.[1] ?? "";
    expect(DOCUMENT_ENGINE_CSS).not.toContain(".cf-doc-avatar-contain {");
    expect(DOCUMENT_ENGINE_CSS).toContain("object-fit: cover;");
    expect(DOCUMENT_ENGINE_CSS).toContain("object-position: center;");
    expect(DOCUMENT_ENGINE_CSS).toContain("block-size: 72px;");
    expect(DOCUMENT_ENGINE_CSS).toContain("inline-size: 72px;");
    expect(DOCUMENT_ENGINE_CSS).toContain(".cf-doc-avatar-layered {");
    expect(DOCUMENT_ENGINE_CSS).toContain(".cf-doc-avatar-background {");
    expect(backgroundRule).toContain("filter: blur(6px);");
    expect(backgroundRule).toContain("object-fit: cover;");
    expect(DOCUMENT_ENGINE_CSS).toContain(".cf-doc-avatar-foreground {");
    expect(DOCUMENT_ENGINE_CSS).toContain(".cf-doc-avatar-foreground {\n  object-fit: contain;");
    expect(DOCUMENT_ENGINE_CSS).toContain(".cf-doc-list-avatar {");
    expect(DOCUMENT_ENGINE_CSS).toContain("block-size: 22px;");
    expect(DOCUMENT_ENGINE_CSS).toContain("inline-size: 22px;");
    expect(DOCUMENT_ENGINE_CSS).toContain("border-radius: 999px;");

    const staffImageSrc = "data:image/png;base64,c3RhZmY=";
    const staffSnapshot: RosterProfileDocumentSnapshot = {
      ...snapshots.STAFF_FILE,
      data: { ...snapshots.STAFF_FILE.data, imageSrc: staffImageSrc },
    } as RosterProfileDocumentSnapshot;
    const { container } = render(<RosterProfileDocument locale="en" lifecycle="preview"
      snapshot={staffSnapshot} copy={getRosterProfileCopy("en", "STAFF_FILE")} />);

    const staffAvatar = container.querySelector("[data-testid='identity-hero'] .cf-doc-avatar-layered");
    expect(staffAvatar).toHaveClass("cf-doc-avatar");
    expect(staffAvatar?.querySelector(".cf-doc-avatar-background")).toHaveAttribute("src", staffImageSrc);
    expect(staffAvatar?.querySelector(".cf-doc-avatar-foreground")).toHaveAttribute("src", staffImageSrc);
    expect(DOCUMENT_ENGINE_CSS).toContain(".cf-doc-list-avatar {");
    expect(DOCUMENT_ENGINE_CSS).toContain("object-fit: contain;");
  });

  it.each(["PATIENT_LIST_REPORT", "SYSTEM_MEMBERS_REPORT"] as const)(
    "shows no person photo in %s across preview, issued, and PDF output",
    async (documentType) => {
      // Roster listings are not the patient/employee file: they carry names
      // only, with no avatar element and no initials placeholder left behind.
      const source = snapshots[documentType];
      if (!("rows" in source.data)) throw new Error("List snapshot expected");
      const snapshot = source as RosterProfileDocumentSnapshot;
      const copy = getRosterProfileCopy("en", documentType);

      for (const lifecycle of ["preview", "issued"] as const) {
        const { container, unmount } = render(<RosterProfileDocument locale="en"
          lifecycle={lifecycle} snapshot={snapshot} copy={copy}
          documentNumber={lifecycle === "issued" ? "DOC-2026-0001" : undefined} />);
        expect(container.querySelectorAll(".cf-doc-list-avatar")).toHaveLength(0);
        expect(container.querySelectorAll(".cf-doc-avatar-name")).toHaveLength(0);
        // The clinic logo slot is untouched by the person-photo removal.
        expect(container.querySelector("[data-testid='document-header']")).toBeInTheDocument();
        unmount();
      }

      const html = await buildDocumentHtml({
        locale: "en", title: `${documentType} avatar parity`,
        renderDocument: (renderContextBoundary) => (
          <RosterProfileDocument locale="en" lifecycle="issued" snapshot={snapshot} copy={copy}
            documentNumber="DOC-2026-0001" renderContextBoundary={renderContextBoundary} />
        ),
      });
      // Markup only — the engine stylesheet still ships the avatar rules the
      // patient/employee file uses.
      expect(html).not.toContain('class="cf-doc-list-avatar');
      expect(html).not.toContain('class="cf-doc-avatar-name"');
    },
  );

  it.each(["en", "ar"] as const)(
    "keeps the Patient List columns in the requested order for %s preview and issued output",
    (locale) => {
      const copy = getRosterProfileCopy(locale, "PATIENT_LIST_REPORT");
      const expected = [copy.patient, copy.fileNumber, copy.nationalId, copy.doctor, copy.phone, copy.bloodType];

      for (const lifecycle of ["preview", "issued"] as const) {
        const { container, unmount } = render(<RosterProfileDocument locale={locale} lifecycle={lifecycle}
          snapshot={snapshots.PATIENT_LIST_REPORT} copy={copy}
          documentNumber={lifecycle === "issued" ? "DOC-2026-0001" : undefined} />);
        const headers = Array.from(container.querySelectorAll("[data-testid='grouped-tables'] th"))
          .map((header) => header.textContent);
        expect(headers).toEqual(expected);
        unmount();
      }
    },
  );

  it("keeps Patient before File No. in canonical Patient List PDF HTML", async () => {
    const copy = getRosterProfileCopy("en", "PATIENT_LIST_REPORT");
    const html = await buildDocumentHtml({
      locale: "en", title: "Patient List column order",
      renderDocument: (renderContextBoundary) => (
        <RosterProfileDocument locale="en" lifecycle="issued"
          snapshot={snapshots.PATIENT_LIST_REPORT} copy={copy}
          documentNumber="DOC-2026-0001" renderContextBoundary={renderContextBoundary} />
      ),
    });

    expect(html.indexOf(`>${copy.patient}</th>`)).toBeGreaterThan(-1);
    expect(html.indexOf(`>${copy.fileNumber}</th>`)).toBeGreaterThan(html.indexOf(`>${copy.patient}</th>`));
  });

  it.each(["PATIENT_LIST_REPORT", "SYSTEM_MEMBERS_REPORT"] as const)(
    "leaves no initials placeholder in %s now that person photos are gone",
    (documentType) => {
      const { container } = render(<RosterProfileDocument locale="ar" lifecycle="preview"
        snapshot={snapshots[documentType]} copy={getRosterProfileCopy("ar", documentType)} />);
      expect(container.querySelector(".cf-doc-list-avatar-fallback")).toBeNull();
      expect(container.querySelector("[data-testid='document-page']")).toHaveAttribute("dir", "rtl");
    },
  );

  it("preserves the Patient File photo slot when no photo exists", () => {
    const { container } = render(<RosterProfileDocument locale="en" lifecycle="preview"
      snapshot={snapshots.PATIENT_FILE} copy={getRosterProfileCopy("en", "PATIENT_FILE")} />);

    const hero = container.querySelector("[data-testid='identity-hero']");
    expect(hero?.querySelector("img")).toBeNull();
    expect(hero?.querySelector(".cf-doc-avatar")).toHaveTextContent("AL");
  });

  it.each(Object.keys(snapshots) as P75RosterProfileDocumentCode[])(
    "renders %s in Arabic RTL with Latin digits",
    (documentType) => {
      const copy = getRosterProfileCopy("ar", documentType);
      const { container } = render(<RosterProfileDocument locale="ar" lifecycle="issued"
        snapshot={snapshots[documentType]} copy={copy}
        documentNumber="DOC-2026-0001" qrDataUrl="data:image/png;base64,iVBORw0KGgo=" />);
      expect(container.querySelector("[data-testid='document-page']")).toHaveAttribute("dir", "rtl");
      expect(container.querySelector(".cf-doc-title")).toHaveTextContent(copy.title);
      expect(container.querySelector(".cf-doc-meta-grid")).toHaveTextContent("رقم المستند");
      expect(container.querySelector("[data-testid='verification-block']"))
        .toHaveTextContent("التحقق");
      expect(container.querySelector("[data-testid='document-footer']"))
        .toHaveTextContent("نظام كلينيك فلو للسجلات الطبية");
      for (const english of [
        getRosterProfileCopy("en", documentType).title,
        "Document no.",
        "Verification",
        "ClinicFlow Medical Records System",
      ]) {
        expect(container).not.toHaveTextContent(english);
      }
      expect(container.textContent).not.toMatch(/[٠-٩۰-۹]/);
    },
  );

  it("registers only the four P7-5 catalog entries with profile attachments opt-in", () => {
    expect(DOCUMENT_CATALOG.PATIENT_LIST_REPORT.archetype).toBe("roster");
    expect(DOCUMENT_CATALOG.SYSTEM_MEMBERS_REPORT.pageRoles).toEqual(["admin", "manager"]);
    expect(DOCUMENT_CATALOG.PATIENT_FILE.supportsAttachments).toBe(true);
    expect(DOCUMENT_CATALOG.STAFF_FILE.supportsAttachments).toBe(true);
    expect(DOCUMENT_CATALOG.PATIENT_LIST_REPORT).not.toHaveProperty("supportsAttachments");
    expect(DOCUMENT_CATALOG.SYSTEM_MEMBERS_REPORT).not.toHaveProperty("supportsAttachments");
  });
});
