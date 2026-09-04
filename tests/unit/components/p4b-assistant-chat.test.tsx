import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { AssistantPageContext } from "@/lib/ai/page-context";

const mocks = vi.hoisted(() => ({
  sendMessage: vi.fn(),
  stop: vi.fn(),
  clearError: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: mocks.refresh }),
}));

vi.mock("@ai-sdk/react", () => ({
  useChat: (options: { messages?: unknown[] }) => ({
    messages: options.messages ?? [],
    sendMessage: mocks.sendMessage,
    status: "ready",
    error: undefined,
    stop: mocks.stop,
    clearError: mocks.clearError,
  }),
}));

import {
  AssistantChat,
  buildAssistantChatRequestBody,
} from "@/components/assistant/assistant-chat";
import { AssistantAccessGate } from "@/components/assistant/assistant-access-gate";

beforeEach(() => vi.clearAllMocks());

describe("P4B assistant UI", () => {
  it("submits only the typed page context, never its UI display label", () => {
    const context = {
      type: "patient" as const,
      patientId: "00000000-0000-4000-8000-000000000011",
    };
    expect(buildAssistantChatRequestBody({
      id: "00000000-0000-4000-8000-000000000010",
      pageContext: context,
      message: {
        id: "message-1",
        role: "user",
        parts: [{ type: "text", text: "Summarize this patient" }],
      },
    })).toEqual({
      id: "00000000-0000-4000-8000-000000000010",
      context,
      message: {
        id: "message-1",
        role: "user",
        parts: [{ type: "text", text: "Summarize this patient" }],
      },
    });
  });

  it("offers patient-context prompts and submits the selected text", () => {
    render(
      <AssistantChat
        initialConversationId="00000000-0000-4000-8000-000000000010"
        initialMessages={[]}
        pageContext={{
          type: "patient",
          patientId: "00000000-0000-4000-8000-000000000011",
        }}
        contextLabel="Mona Ali"
        remaining={25}
        role="doctor"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Summarize this patient's clinical history" }));
    expect(screen.getByRole("textbox", { name: "Message the clinical assistant" })).toHaveValue(
      "Summarize this patient's clinical history",
    );
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    expect(mocks.sendMessage).toHaveBeenCalledWith({ text: "Summarize this patient's clinical history" });
  });

  it("renders an explicit plan upgrade gate without a misleading chat input", () => {
    render(<AssistantAccessGate access={{ state: "upgrade" }} />);
    expect(screen.getByRole("heading", { name: "Assistant is not included in this plan" })).toBeVisible();
    expect(screen.getByText("Read-only — never changes medical records")).toBeVisible();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("discloses when older conversation history was trimmed", () => {
    render(
      <AssistantChat
        initialConversationId="00000000-0000-4000-8000-000000000010"
        initialMessages={[{
          id: "assistant-1",
          role: "assistant",
          parts: [{ type: "text", text: "Recent context" }],
        }]}
        remaining={25}
        historyTruncated
        role="doctor"
      />,
    );

    expect(screen.getByText(/Only the most recent 40 messages/)).toBeVisible();
    const liveRegions = document.querySelectorAll("[aria-live]");
    expect(liveRegions).toHaveLength(1);
    expect(liveRegions[0]).toHaveAttribute("role", "status");
  });

  it.each(["admin", "manager", "receptionist"] as const)(
    "renders the non-clinical persona for %s",
    (role) => {
      render(
        <AssistantChat
          initialConversationId="00000000-0000-4000-8000-000000000010"
          initialMessages={[]}
          remaining={25}
          role={role}
        />,
      );

      expect(screen.getByRole("heading", { name: "How can I help with clinic operations?" })).toBeVisible();
      expect(screen.getByRole("textbox", { name: "Message the clinic assistant" })).toBeVisible();
      // The disclosure that this persona is non-clinical survived P4.6B's
      // rewrite of the administrative empty state; only its wording changed,
      // because the persona now also covers analytics and reports.
      expect(screen.getByText(/Individual clinical records stay with doctors/)).toBeVisible();
      expect(screen.queryByText("Summarize this patient's clinical history")).not.toBeInTheDocument();
    },
  );

  it.each([
    { type: "revenue", dateRange: { from: "2026-07-01", to: "2026-07-31" } },
    { type: "reports", report: "no_shows", range: { from: "2026-07-01", to: "2026-07-31" } },
    { type: "invoices", filter: "outstanding" },
    { type: "staff" },
    { type: "departments" },
  ] as AssistantPageContext[])(
    "does not invent $type suggestions when server capabilities are unavailable",
    (pageContext) => {
      render(
        <AssistantChat
          initialConversationId="00000000-0000-4000-8000-000000000010"
          initialMessages={[]}
          pageContext={pageContext}
          remaining={25}
          role="admin"
        />,
      );

      expect(screen.getByRole("button", { name: "Find an authorized patient by name" })).toBeVisible();
      expect(screen.getByRole("button", { name: "Check a doctor's availability tomorrow" })).toBeVisible();
      expect(screen.getByRole("button", { name: "What can you help me with?" })).toBeVisible();
      expect(screen.queryByRole("button", { name: /revenue|report|invoice|staff|department|schedule/i }))
        .not.toBeInTheDocument();
    },
  );

  it("offers no schedule-specific prompt when recurring-hours help capability is unavailable", () => {
    render(
      <AssistantChat
        initialConversationId="00000000-0000-4000-8000-000000000010"
        initialMessages={[]}
        pageContext={{ type: "doctor-schedule" }}
        remaining={25}
        role="admin"
      />,
    );
    expect(screen.queryByRole("button", { name: /schedule|availability/i }))
      .not.toBeInTheDocument();
  });

  it.each([
    {
      pageContext: { type: "appointments", dateRange: { from: "2026-07-01", to: "2026-07-07" } },
      toolNames: ["query_resource"],
      suggestion: "List appointments from 2026-07-01 to 2026-07-07",
    },
    {
      pageContext: { type: "revenue", dateRange: { from: "2026-07-01", to: "2026-07-31" } },
      toolNames: ["get_revenue_summary"],
      suggestion: "Summarize revenue from 2026-07-01 to 2026-07-31",
    },
    {
      pageContext: { type: "reports", report: "no_shows", range: { from: "2026-07-01", to: "2026-07-31" } },
      toolNames: ["run_clinic_report"],
      suggestion: "Summarize the report I'm viewing from 2026-07-01 to 2026-07-31",
    },
    {
      pageContext: { type: "invoices", filter: "outstanding" },
      toolNames: ["list_outstanding_invoices"],
      suggestion: "List the largest outstanding invoices",
    },
    {
      pageContext: { type: "staff" },
      toolNames: ["get_clinic_summary"],
      suggestion: "Summarize our current staffing",
    },
    {
      pageContext: { type: "departments" },
      toolNames: ["get_clinic_summary"],
      suggestion: "Summarize our departments and staffing",
    },
    {
      pageContext: { type: "doctor-schedule" },
      toolNames: ["search_help"],
      suggestion: "How do I update a doctor's working schedule?",
    },
  ] as const)("offers an authorized $pageContext.type contextual suggestion", ({ pageContext, toolNames, suggestion }) => {
    render(
      <AssistantChat
        initialConversationId="00000000-0000-4000-8000-000000000010"
        initialMessages={[]}
        pageContext={pageContext}
        remaining={25}
        role="admin"
        capabilities={{
          toolNames: [...toolNames],
          items: [],
          clinicAnalytics: true,
          operational: true,
          financial: "available",
          allowedReportIds:
            pageContext.type === "reports" ? ["no_shows"] : [],
          resources: [],
          actions: [],
        }}
      />,
    );

    expect(screen.getByRole("button", { name: suggestion })).toBeVisible();
  });

  it("does not offer financial contextual prompts without a mounted financial tool", () => {
    render(
      <AssistantChat
        initialConversationId="00000000-0000-4000-8000-000000000010"
        initialMessages={[]}
        pageContext={{ type: "revenue", dateRange: { from: "2026-07-01", to: "2026-07-31" } }}
        remaining={25}
        role="manager"
        capabilities={{
          toolNames: ["search_help"],
          items: [],
          clinicAnalytics: false,
          operational: false,
          financial: "not_granted",
          allowedReportIds: [],
          resources: [],
          actions: [],
        }}
      />,
    );

    expect(screen.queryByRole("button", { name: /Summarize revenue/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /outstanding balances related/ })).not.toBeInTheDocument();
  });

  it.each([
    ["revenue", "manager", []],
    ["followups", "manager", []],
    ["doctor_performance", "receptionist", []],
    ["receptionist_performance", "receptionist", []],
    ["no_shows", "receptionist", ["no_shows"]],
  ] as const)(
    "shows report-specific suggestions only when %s is allowed for %s",
    (report, role, allowedReportIds) => {
      render(
        <AssistantChat
          initialConversationId="00000000-0000-4000-8000-000000000010"
          initialMessages={[]}
          pageContext={{
            type: "reports",
            report,
            range: { from: "2026-07-01", to: "2026-07-31" },
          }}
          remaining={25}
          role={role}
          capabilities={{
            toolNames: ["run_clinic_report"],
            items: [],
            clinicAnalytics: false,
            operational: true,
            financial: "not_applicable",
            allowedReportIds: [...allowedReportIds],
            resources: [],
            actions: [],
          }}
        />,
      );

      if (allowedReportIds.length > 0) {
        expect(screen.getByRole("button", {
          name: "Summarize the report I'm viewing from 2026-07-01 to 2026-07-31",
        })).toBeVisible();
        expect(screen.queryByText(/This report is not available/)).not.toBeInTheDocument();
      } else {
        expect(screen.queryByRole("button", {
          name: /Summarize the report I'm viewing/,
        })).not.toBeInTheDocument();
        expect(screen.getByText(/This report is not available/)).toBeVisible();
      }
    },
  );

  it("offers only schedule help from the identity-free recurring-hours host", () => {
    render(
      <AssistantChat
        initialConversationId="00000000-0000-4000-8000-000000000010"
        initialMessages={[]}
        pageContext={{ type: "doctor-schedule" }}
        remaining={25}
        role="admin"
        capabilities={{
          toolNames: ["search_help", "query_resource", "check_availability"],
          items: [],
          clinicAnalytics: false,
          operational: true,
          financial: "not_applicable",
          allowedReportIds: [],
          resources: [],
          actions: [],
        }}
      />,
    );

    expect(screen.getAllByRole("button", { name: /working schedule/ })).toHaveLength(1);
    expect(screen.queryByRole("button", { name: /List clinic appointments/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /availability/ })).not.toBeInTheDocument();
  });
});
