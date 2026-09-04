import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AssistantPageContext } from "@/lib/ai/page-context";

const mocks = vi.hoisted(() => ({ chatProps: vi.fn(), fetch: vi.fn() }));

vi.mock("@/components/assistant/assistant-chat", () => ({
  AssistantChat: (props: {
    pageContext: AssistantPageContext;
    contextLabel?: string | null;
  }) => {
    mocks.chatProps(props);
    return <div data-testid="assistant-chat">Assistant chat</div>;
  },
}));

import { AssistantLauncher } from "@/components/assistant/assistant-launcher";

const ACCESS = { state: "available" as const, remaining: 19, limit: 20 };
const BASE = {
  role: "doctor" as const,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", mocks.fetch);
  mocks.fetch.mockResolvedValue(new Response(JSON.stringify({
    initialConversationId: "00000000-0000-4000-8000-000000000010",
    initialMessages: [],
    historyTruncated: false,
    remaining: ACCESS.remaining,
    capabilities: null,
  }), { status: 200, headers: { "content-type": "application/json" } }));
});

describe("P4.8A reusable AssistantLauncher", () => {
  it("loads the patient chat only after opening without sending the display label", async () => {
    const context = {
      type: "patient" as const,
      patientId: "00000000-0000-4000-8000-000000000011",
    };
    render(
      <AssistantLauncher
        {...BASE}
        context={context}
        contextLabel="Mona Ali"
      />,
    );

    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.chatProps).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Ask assistant" }));
    expect(screen.getByRole("heading", { name: "Clinical assistant · Mona Ali" })).toBeVisible();
    expect(screen.getByText(/scoped to the patient profile/)).toBeVisible();
    expect(await screen.findByTestId("assistant-chat")).toBeVisible();
    expect(mocks.fetch).toHaveBeenCalledWith(
      "/api/agent/launcher-session",
      expect.objectContaining({
        method: "POST",
        credentials: "same-origin",
        body: JSON.stringify({ context }),
      }),
    );
    expect(mocks.chatProps).toHaveBeenCalledWith(expect.objectContaining({
      pageContext: context,
      contextLabel: "Mona Ali",
    }));
    expect(context).not.toHaveProperty("name");
  });

  it.each([
    [
      "appointments",
      { type: "appointments", dateRange: { from: "2026-07-01", to: "2026-07-07" } },
      "Appointments assistant",
      /visible calendar range/,
    ],
    [
      "dashboard",
      { type: "dashboard" },
      "Dashboard assistant",
      /opened the dashboard/,
    ],
    [
      "revenue",
      { type: "revenue", dateRange: { from: "2026-07-01", to: "2026-07-31" } },
      "Revenue assistant",
      /whole clinic/,
    ],
    [
      "reports",
      { type: "reports", report: "no_shows", range: { from: "2026-07-01", to: "2026-07-31" } },
      "Report assistant",
      /report and visible date range/,
    ],
    [
      "invoices",
      { type: "invoices", filter: "outstanding" },
      "Invoice assistant",
      /financial permissions/,
    ],
    [
      "staff",
      { type: "staff" },
      "Staff assistant",
      /exact review, current-password reauthentication/,
    ],
    [
      "departments",
      { type: "departments" },
      "Departments assistant",
      /cannot change departments/,
    ],
    [
      "doctor schedule",
      { type: "doctor-schedule" },
      "Doctor schedule assistant",
      /cannot change working hours/,
    ],
  ] as const)("renders the %s entry point through the same component", async (_area, context, title, description) => {
    render(<AssistantLauncher {...BASE} context={context} />);
    fireEvent.click(screen.getByRole("button", { name: "Ask assistant" }));
    expect(screen.getByRole("heading", { name: title })).toBeVisible();
    expect(screen.getByText(description)).toBeVisible();
    expect(await screen.findByTestId("assistant-chat")).toBeVisible();
    expect(mocks.chatProps).toHaveBeenCalledWith(expect.objectContaining({
      pageContext: context,
    }));
    expect(screen.getByRole("dialog")).toHaveAccessibleDescription(description);
  });

  it("shows a retryable fail-soft state when deferred hydration is unavailable", async () => {
    mocks.fetch.mockResolvedValueOnce(new Response(null, { status: 503 }));
    render(<AssistantLauncher {...BASE} context={{ type: "dashboard" }} />);
    fireEvent.click(screen.getByRole("button", { name: "Ask assistant" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Assistant temporarily unavailable",
    );
    expect(screen.queryByTestId("assistant-chat")).not.toBeInTheDocument();

    const retry = screen.getByRole("button", { name: "Try again" });
    expect(retry).toHaveFocus();
    fireEvent.click(retry);
    expect(await screen.findByTestId("assistant-chat")).toBeVisible();
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
  });

  it("keeps an enabled P4.9A placement keyboard-operable with a named, described dialog", async () => {
    const user = userEvent.setup();
    render(<AssistantLauncher {...BASE} context={{ type: "dashboard" }} />);

    await user.tab();
    const trigger = screen.getByRole("button", { name: "Ask assistant" });
    expect(trigger).toHaveFocus();
    await user.keyboard("{Enter}");

    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAccessibleName("Dashboard assistant");
    expect(dialog).toHaveAccessibleDescription(/opened the dashboard/);
    expect(await screen.findByTestId("assistant-chat")).toBeVisible();
  });
});
