import { render, screen } from "@testing-library/react";
import { createFormatter, createTranslator } from "next-intl";
import { describe, expect, it, vi } from "vitest";

// The shared setup resolves `useTranslations` against the English catalog so the
// whole component suite can assert English copy. Arabic is asserted the same
// way — through next-intl's own resolver — by re-pointing that mock at the
// Arabic catalog for this file only.
vi.mock("next-intl", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next-intl")>();
  const messages = (await import("@/messages/ar.json")).default;
  return {
    ...actual,
    useLocale: () => "ar",
    useTranslations: (namespace?: string) =>
      createTranslator({ locale: "ar", messages, namespace: namespace as never }),
    useFormatter: () => createFormatter({ locale: "ar" }),
    useMessages: () => messages,
  };
});

vi.mock("@/actions/audit-log", () => ({ getAuditLog: vi.fn() }));
vi.mock("@/contexts/clinic-settings-context", () => ({
  useClinicSettings: () => ({
    locale: { currency: "KWD", digits: "arabic", locale: "ar" },
    formatDateTime: () => "١ سبتمبر ٢٠٢٦",
  }),
}));

const { AuditLogView } = await import("@/components/settings/audit-log/audit-log-view");
const event = {
  id: "e1",
  trail: "admin" as const,
  occurredAt: "2026-09-01T10:00:00.000Z",
  module: "services" as const,
  action: "service.price_changed",
  tone: "warning" as const,
  actorType: "staff" as const,
  actorId: "u1",
  actorName: "محمد",
  actorRole: "admin",
  viaAi: false,
  entityType: "service",
  entityId: "s1",
  entityRef: "كشف",
  before: { price: "25.000", currency: "KWD" },
  after: { price: "30.000", currency: "KWD" },
  changedFields: ["price"],
  surface: "staff_web" as const,
  outcome: "success" as const,
  correlationId: null,
  metadata: { currency: "KWD" },
};

function renderArabic() {
  return render(
    <AuditLogView initialEvents={[event]} initialCursor={null} actors={[]} canReadAi />,
  );
}

describe("audit log — Arabic", () => {
  it("renders the action, area and filters from the Arabic catalog", () => {
    renderArabic();
    expect(screen.getByText("تم تغيير سعر الخدمة")).toBeInTheDocument();
    expect(screen.getByText("الخدمات والأسعار")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "تطبيق" })).toBeInTheDocument();
    expect(screen.getByText("السعر")).toBeInTheDocument();
  });

  it("shows the money in the clinic's digits and the currency the event recorded", () => {
    const { container } = renderArabic();
    // A clinic set to Arabic-Indic digits reads its own numerals; the currency
    // is the one stored on the event, not the reader's display preference.
    const money = new Intl.NumberFormat("ar-u-nu-arab", {
      style: "currency",
      currency: "KWD",
      minimumFractionDigits: 3,
      maximumFractionDigits: 3,
    });
    expect(container.textContent).toContain(money.format(25));
    expect(container.textContent).toContain(money.format(30));
  });

  it("uses only direction-neutral arrows and logical spacing", () => {
    const { container } = renderArabic();
    // The before → after arrow must flip with the document direction.
    expect(container.querySelector(".rtl\\:rotate-180")).not.toBeNull();
    expect(container.innerHTML).not.toMatch(
      /class="[^"]*\b(ml-|mr-|pl-|pr-|text-left|text-right)/,
    );
  });
});
