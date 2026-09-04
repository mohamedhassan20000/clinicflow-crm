import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

/**
 * Phase 6 review P6-01 / P6-03 / P6-09, on the rendered card.
 *
 * The server-side fixes are worthless if the change rows they add never reach a
 * human. These assert the rendered confirmation card: the complete authored body
 * is on screen *before* the confirm control, the clinical finalization is
 * disclosed there too, and no raw `documents.catalog.*` key is displayed.
 */

const mocks = vi.hoisted(() => ({
  sendMessage: vi.fn(),
  stop: vi.fn(),
  clearError: vi.fn(),
  refresh: vi.fn(),
  confirmAssistantAction: vi.fn(),
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: mocks.refresh }) }));
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
vi.mock("@/actions/assistant-actions", () => ({
  confirmAssistantAction: mocks.confirmAssistantAction,
}));

import { AssistantChat } from "@/components/assistant/assistant-chat";

const CONVERSATION_ID = "00000000-0000-4000-8000-000000000010";
const RECORD_ID = "00000000-0000-4000-8000-00000000000b";

const BLOCKS = [
  "To whom it may concern",
  "The bearer of this letter has been under the care of this clinic since March 2026 and is medically cleared for light duties.",
  "Please contact the clinic for any clarification regarding this statement.",
];

function toolMessage(preview: Record<string, unknown>, input: Record<string, unknown>) {
  return [
    {
      id: "assistant-1",
      role: "assistant" as const,
      parts: [
        {
          type: "tool-execute_action" as const,
          toolCallId: "call-1",
          state: "output-available" as const,
          input: { action: "documents.issue", input },
          output: {
            action_id: "documents.issue",
            phase: "preview",
            risk_class: "sensitive",
            confirmation_required: true,
            confirm_token: "t".repeat(60),
            expires_at: "2026-08-14T12:10:00.000Z",
            ...preview,
          },
        },
      ],
    },
  ];
}

function renderCard(messages: ReturnType<typeof toolMessage>) {
  return render(
    <AssistantChat
      initialConversationId={CONVERSATION_ID}
      initialMessages={messages as never}
      remaining={25}
      role="doctor"
    />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.confirmAssistantAction.mockResolvedValue({ ok: false, reason: "internal_error" });
});

describe("P6-01 the authored body is on the card before the confirm control", () => {
  const preview = {
    preview: {
      title: "Issue GENERIC_DOCUMENT",
      summary:
        "Issuing allocates a permanent document number, stores the canonical PDF, and makes the document verifiable. It cannot be un-issued, only cancelled. The title and body shown below were composed by the Assistant, not taken from clinic records. They will appear verbatim on a document carrying this clinic's name, logo, licence number and tax id, with a permanent document number and an externally verifiable code. Read the full text before confirming.",
      changes: [
        {
          label: "document",
          before: "not issued",
          after: "GENERIC_DOCUMENT — Document from scratch",
          identifiesRecord: true,
        },
        { label: "language", before: null, after: "en" },
        { label: "document title", before: null, after: "Fitness for duty" },
        ...BLOCKS.map((text, index) => ({
          label: `body ${index + 1} (paragraph)`,
          before: null,
          after: text,
        })),
      ],
    },
  };

  it("renders every authored block verbatim", () => {
    renderCard(
      toolMessage(preview, { document_type: "GENERIC_DOCUMENT", params: {} }),
    );
    for (const block of BLOCKS) {
      expect(screen.getByText(block)).toBeVisible();
    }
    expect(screen.getByText("Fitness for duty")).toBeVisible();
  });

  it("states that the body was composed by the Assistant", () => {
    renderCard(
      toolMessage(preview, { document_type: "GENERIC_DOCUMENT", params: {} }),
    );
    expect(
      screen.getByText(/composed by the Assistant/),
    ).toBeVisible();
    expect(screen.getByText(/appear verbatim/)).toBeVisible();
  });

  it("shows the body while the confirm control is still un-pressed", () => {
    renderCard(
      toolMessage(preview, { document_type: "GENERIC_DOCUMENT", params: {} }),
    );
    const confirm = screen.getByRole("button", { name: "Confirm and execute" });
    expect(confirm).toBeEnabled();
    // The whole body is already on screen at the moment the control is offered.
    for (const block of BLOCKS) expect(screen.getByText(block)).toBeVisible();
    expect(mocks.confirmAssistantAction).not.toHaveBeenCalled();
  });

  it("never renders a raw i18n key as the document title", () => {
    renderCard(
      toolMessage(preview, { document_type: "GENERIC_DOCUMENT", params: {} }),
    );
    expect(screen.queryByText(/^documents\.catalog\./)).not.toBeInTheDocument();
    expect(screen.getByText(/Document from scratch/)).toBeVisible();
  });

  it("shows the document's language on the card", () => {
    renderCard(
      toolMessage(preview, { document_type: "GENERIC_DOCUMENT", params: {} }),
    );
    expect(screen.getByText("language")).toBeVisible();
  });
});

describe("P6-03 the clinical finalization is disclosed on the card", () => {
  const preview = {
    preview: {
      title: "Issue PRESCRIPTION",
      summary:
        `Issuing allocates a permanent document number, stores the canonical PDF, and makes the document verifiable. It cannot be un-issued, only cancelled. Confirming also finalizes prescriptions ${RECORD_ID}. A finalized clinical record cannot return to draft; it can only be voided afterwards.`,
      changes: [
        {
          label: "document",
          before: "not issued",
          after: "PRESCRIPTION — Prescription",
          identifiesRecord: true,
        },
        { label: "language", before: null, after: "en" },
        {
          label: `prescriptions ${RECORD_ID}`,
          before: "draft",
          after: "finalized",
          identifiesRecord: true,
        },
      ],
    },
  };

  it("names the record and its draft → finalized transition", () => {
    renderCard(toolMessage(preview, { document_type: "PRESCRIPTION", params: {} }));
    expect(screen.getByText(`prescriptions ${RECORD_ID}`)).toBeVisible();
    expect(screen.getByText("draft")).toBeVisible();
    expect(screen.getByText("finalized")).toBeVisible();
    expect(screen.getByText(/cannot return to draft/)).toBeVisible();
  });
});

describe("P6-07 the confirm resends the server's canonical input", () => {
  it("sends action_input rather than the model's original arguments", () => {
    const canonical = {
      document_type: "REVENUE_REPORT",
      params: { from: "2026-08-01", to: "2026-08-31" },
      locale: "en",
    };
    renderCard(
      toolMessage(
        {
          action_input: canonical,
          preview: {
            title: "Issue REVENUE_REPORT",
            summary: "Issuing allocates a permanent document number.",
            changes: [
              {
                label: "document",
                before: "not issued",
                after: "REVENUE_REPORT — Revenue Report",
                identifiesRecord: true,
              },
            ],
          },
        },
        // What the model actually called with: no resolved period at all.
        { document_type: "REVENUE_REPORT", params: {}, period_preset: "this_month" },
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Confirm and execute" }));
    expect(mocks.confirmAssistantAction).toHaveBeenCalledWith(
      expect.objectContaining({ input: canonical }),
    );
  });

  it("falls back to the model input for an action that does not canonicalise", () => {
    const modelInput = { document_id: "00000000-0000-4000-8000-0000000000d1" };
    renderCard(
      toolMessage(
        {
          preview: {
            title: "Reprint REV-2026-0001",
            summary: "Reprinting re-serves the stored PDF.",
            changes: [{ label: "print_count", before: 2, after: 3 }],
          },
        },
        modelInput,
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Confirm and execute" }));
    expect(mocks.confirmAssistantAction).toHaveBeenCalledWith(
      expect.objectContaining({ input: modelInput }),
    );
  });
});
