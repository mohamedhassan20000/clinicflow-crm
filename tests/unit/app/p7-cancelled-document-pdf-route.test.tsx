import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DocumentPage } from "@/components/documents/engine";

const DOCUMENT_ID = "11111111-1111-4111-8111-111111111111";
const CLINIC_ID = "22222222-2222-4222-8222-222222222222";
const TOKEN = "0123456789abcdef0123456789abcdef";
const SNAPSHOT = { version: 1, content: "Immutable issued snapshot" };
const PARAMS = { sourceId: "source-at-issue" };
const CANONICAL_PATH =
  `documents/${CLINIC_ID}/GENERIC_DOCUMENT/${DOCUMENT_ID}.pdf`;

const mocks = vi.hoisted(() => ({
  status: "cancelled",
  locale: "en",
  renderer: vi.fn(),
  getDocumentPdfRenderer: vi.fn(),
  createSignedUrl: vi.fn(),
}));

vi.mock("@/lib/rbac", () => ({
  requireUser: vi.fn(async () => ({
    id: "33333333-3333-4333-8333-333333333333",
    clinicId: CLINIC_ID,
    email: "admin@clinic.test",
    role: "admin",
    fullName: "Clinic Admin",
    avatarUrl: null,
    departmentId: null,
    mustChangePassword: false,
  })),
}));

function documentsQuery() {
  const query: Record<string, unknown> = {};
  Object.assign(query, {
    select: vi.fn(() => query),
    eq: vi.fn(() => query),
    maybeSingle: vi.fn(async () => ({
      data: {
        id: DOCUMENT_ID,
        doc_type: "GENERIC_DOCUMENT",
        document_number: "GEN-2026-0001",
        verification_token: TOKEN,
        status: mocks.status,
        locale: mocks.locale,
        params: PARAMS,
        snapshot: SNAPSHOT,
        watermark_snapshot: "Original clinic watermark",
        pdf_storage_path: CANONICAL_PATH,
      },
      error: null,
    })),
  });
  return query;
}

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    from: vi.fn((table: string) => {
      if (table !== "documents") throw new Error(`Unexpected table: ${table}`);
      return documentsQuery();
    }),
    storage: {
      from: vi.fn(() => ({ createSignedUrl: mocks.createSignedUrl })),
    },
  })),
}));

vi.mock("@/lib/documents/renderers/registry", () => ({
  getDocumentPdfRenderer: mocks.getDocumentPdfRenderer,
}));

import { GET } from "@/app/(protected)/documents/[id]/pdf/route";

describe("cancelled document PDF presentation route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.status = "cancelled";
    mocks.locale = "en";
    mocks.getDocumentPdfRenderer.mockReturnValue(mocks.renderer);
    mocks.renderer.mockImplementation(async (reservation) => {
      const markup = renderToStaticMarkup(
        <DocumentPage
          locale={reservation.locale}
          lifecycle={reservation.presentationLifecycle}
          branding={{ name: "Clinic" }}
          identity={{
            title: "Immutable document",
            documentNumber: reservation.documentNumber,
            issueDate: "09 Aug 2026",
            labels: { documentNumber: "Document no.", issueDate: "Issued" },
          }}
          watermark={{ enabled: false }}
        >
          <p>{(reservation.snapshot as { content: string }).content}</p>
        </DocumentPage>,
      );
      return { pdf: new TextEncoder().encode(markup), pageCount: 1 };
    });
  });

  it.each([
    { locale: "en", label: "CANCELLED", direction: "ltr" },
    { locale: "ar", label: "ملغي", direction: "rtl" },
  ])("re-renders a $locale cancellation from the immutable snapshot", async ({
    locale,
    label,
    direction,
  }) => {
    mocks.locale = locale;

    const response = await GET(
      new Request(`https://clinic.test/documents/${DOCUMENT_ID}/pdf`),
      { params: Promise.resolve({ id: DOCUMENT_ID }) },
    );
    const presentation = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/pdf");
    expect(presentation).toContain(label);
    expect(presentation).toContain(`dir=\"${direction}\"`);
    expect(presentation).toContain("Immutable issued snapshot");
    expect(mocks.createSignedUrl).not.toHaveBeenCalled();
    expect(mocks.renderer).toHaveBeenCalledWith(expect.objectContaining({
      documentId: DOCUMENT_ID,
      documentNumber: "GEN-2026-0001",
      verificationToken: TOKEN,
      params: PARAMS,
      snapshot: SNAPSHOT,
      watermark: "Original clinic watermark",
      presentationLifecycle: "cancelled",
    }));
  });

  it("redirects an issued document to its untouched canonical PDF", async () => {
    mocks.status = "issued";
    mocks.createSignedUrl.mockResolvedValue({
      data: { signedUrl: "https://storage.test/immutable-issued.pdf" },
      error: null,
    });

    const response = await GET(
      new Request(`https://clinic.test/documents/${DOCUMENT_ID}/pdf`),
      { params: Promise.resolve({ id: DOCUMENT_ID }) },
    );

    expect(response.status).toBe(307);
    expect(response.headers.get("location"))
      .toBe("https://storage.test/immutable-issued.pdf");
    expect(mocks.createSignedUrl).toHaveBeenCalledWith(CANONICAL_PATH, 60);
    expect(mocks.renderer).not.toHaveBeenCalled();
  });
});
