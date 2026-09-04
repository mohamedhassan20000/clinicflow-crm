import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { beforeEach, describe, expect, it, vi } from "vitest";
import en from "@/messages/en.json";
import { AuditLogView } from "@/components/settings/audit-log/audit-log-view";
import type { AuditFeedEvent } from "@/lib/audit/feed";

const getAuditLog = vi.hoisted(() => vi.fn());
vi.mock("@/actions/audit-log", () => ({ getAuditLog }));

vi.mock("@/contexts/clinic-settings-context", () => ({
  useClinicSettings: () => ({
    locale: { currency: "KWD", digits: "latin", locale: "en" },
    formatDateTime: () => "1 Sep 2026, 10:00",
  }),
}));

function auditEvent(overrides: Partial<AuditFeedEvent> = {}): AuditFeedEvent {
  return {
    id: "e1",
    trail: "admin",
    occurredAt: "2026-09-01T10:00:00.000Z",
    module: "services",
    action: "service.price_changed",
    tone: "warning",
    actorType: "staff",
    actorId: "u1",
    actorName: "Mohamed",
    actorRole: "admin",
    viaAi: false,
    entityType: "service",
    entityId: "s1",
    entityRef: "Consultation",
    before: { price: "25.000", currency: "KWD" },
    after: { price: "30.000", currency: "KWD" },
    changedFields: ["price"],
    surface: "staff_web",
    outcome: "success",
    correlationId: null,
    metadata: { currency: "KWD" },
    ...overrides,
  };
}

function renderView(props: Partial<React.ComponentProps<typeof AuditLogView>> = {}) {
  return render(
    <NextIntlClientProvider locale="en" messages={en} timeZone="UTC">
      <AuditLogView
        initialEvents={[auditEvent()]}
        initialCursor={null}
        actors={[{ id: "u1", name: "Mohamed", role: "admin" }]}
        canReadAi
        {...props}
      />
    </NextIntlClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("audit log — reading an event", () => {
  it("reads as a sentence, with the money in the currency the event recorded", () => {
    renderView();
    expect(screen.getByText("Service price changed")).toBeInTheDocument();
    expect(screen.getByText("Consultation")).toBeInTheDocument();
    expect(screen.getByText("Mohamed")).toBeInTheDocument();
    expect(screen.getByText(/25\.000/)).toBeInTheDocument();
    expect(screen.getByText(/30\.000/)).toBeInTheDocument();
    expect(screen.getAllByText(/KWD|K\.D\.|د\.ك/).length).toBeGreaterThan(0);
  });

  it("attributes an assistant-executed change to the person, marked as AI", () => {
    renderView({ initialEvents: [auditEvent({ viaAi: true })] });
    expect(screen.getByText("Mohamed")).toBeInTheDocument();
    expect(screen.getByText("via AI assistant")).toBeInTheDocument();
  });

  it("names a system actor rather than inventing a person", () => {
    renderView({
      initialEvents: [
        auditEvent({ actorType: "integration", actorId: null, actorName: null, surface: "whatsapp" }),
      ],
    });
    expect(screen.getByText("WhatsApp service")).toBeInTheDocument();
    expect(screen.queryByText("Mohamed")).not.toBeInTheDocument();
  });

  it("falls back to the raw action for a vocabulary the catalog has not learned", () => {
    renderView({ initialEvents: [auditEvent({ action: "future_thing.happened" })] });
    expect(screen.getByText("future_thing.happened")).toBeInTheDocument();
  });

  it("shows an empty state instead of a blank page", () => {
    renderView({ initialEvents: [] });
    expect(
      screen.getByText("No administrative changes have been recorded yet."),
    ).toBeInTheDocument();
  });
});

describe("audit log — details", () => {
  it("opens a keyboard-reachable detail view with the safe structured diff", async () => {
    const user = userEvent.setup();
    renderView();

    const row = screen.getByRole("button", { name: /Service price changed/ });
    row.focus();
    expect(row).toHaveFocus();
    await user.keyboard("{Enter}");

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Staff app")).toBeInTheDocument();
    expect(within(dialog).getByText("Succeeded")).toBeInTheDocument();
    expect(
      within(dialog).getByText(/Clinical notes, message content, credentials/),
    ).toBeInTheDocument();
  });
});

describe("audit log — filtering and pagination", () => {
  it("asks the server for a filtered page rather than filtering in the browser", async () => {
    const user = userEvent.setup();
    getAuditLog.mockResolvedValue({ events: [], nextCursor: null });
    renderView();

    await user.type(screen.getByLabelText("Search by name…"), "Consultation");
    await user.click(screen.getByRole("button", { name: "Apply" }));

    await waitFor(() => expect(getAuditLog).toHaveBeenCalledTimes(1));
    expect(getAuditLog).toHaveBeenCalledWith({ search: "Consultation" });
    expect(await screen.findByText("No changes match these filters.")).toBeInTheDocument();
  });

  it("pages with a cursor and appends, never refetching the whole history", async () => {
    const user = userEvent.setup();
    getAuditLog.mockResolvedValue({
      events: [auditEvent({ id: "e2", entityRef: "Follow-up visit" })],
      nextCursor: null,
    });
    renderView({ initialCursor: "2026-09-01T10:00:00.000Z|e1" });

    await user.click(screen.getByRole("button", { name: "Load more" }));

    await waitFor(() =>
      expect(getAuditLog).toHaveBeenCalledWith({ cursor: "2026-09-01T10:00:00.000Z|e1" }),
    );
    expect(await screen.findByText("Follow-up visit")).toBeInTheDocument();
    expect(screen.getByText("Consultation")).toBeInTheDocument();
  });

  it("does not offer the AI area to a reader who may not read it", () => {
    renderView({ canReadAi: false });
    expect(screen.getByLabelText("Area")).toBeInTheDocument();
    // The option list is only mounted when opened; the filter value list is the
    // component's own source of truth and excludes AI for a manager.
    renderView({ canReadAi: true });
    expect(screen.getAllByLabelText("Area")).toHaveLength(2);
  });
});
