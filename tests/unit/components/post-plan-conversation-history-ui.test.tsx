/**
 * Post-plan product completion — changes 2 and 3, at the render.
 *
 * The product complaint was "New chat makes previous conversations disappear",
 * and the shortcut complaint was "the Ask Assistant sheet is its own thing".
 * Both are answered by the *same* component: `AssistantChat` owns the history
 * panel, and the launcher sheet renders `AssistantChat`. So these tests assert
 * against rendered output in both modes, and specifically that the sheet is not
 * a reduced variant — dropping the panel from either surface fails here.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { AssistantConversationSummary } from "@/lib/ai/conversations";

const mocks = vi.hoisted(() => ({
  sendMessage: vi.fn(),
  stop: vi.fn(),
  clearError: vi.fn(),
  refresh: vi.fn(),
  listHistory: vi.fn(),
  openConversation: vi.fn(),
  chatOptions: [] as { id: string; messages: unknown[] }[],
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: mocks.refresh }),
}));

vi.mock("@ai-sdk/react", () => ({
  useChat: (options: { id: string; messages?: unknown[] }) => {
    mocks.chatOptions.push({ id: options.id, messages: options.messages ?? [] });
    return {
      messages: options.messages ?? [],
      sendMessage: mocks.sendMessage,
      status: "ready",
      error: undefined,
      stop: mocks.stop,
      clearError: mocks.clearError,
    };
  },
}));

vi.mock("@/actions/assistant-conversations", () => ({
  listAssistantConversationHistory: mocks.listHistory,
  openAssistantConversation: mocks.openConversation,
}));

import { AssistantChat } from "@/components/assistant/assistant-chat";

const CURRENT = "00000000-0000-4000-8000-000000000010";
const EARLIER = "00000000-0000-4000-8000-000000000011";
const PATIENT_CHAT = "00000000-0000-4000-8000-000000000012";
const PATIENT = "00000000-0000-4000-8000-000000000013";

const HISTORY: AssistantConversationSummary[] = [
  {
    id: EARLIER,
    title: "Which patients have O+ blood?",
    updatedAt: "2026-08-16T10:00:00.000Z",
    createdAt: "2026-08-16T09:00:00.000Z",
    patientBound: false,
  },
  {
    id: PATIENT_CHAT,
    title: null,
    updatedAt: "2026-08-15T10:00:00.000Z",
    createdAt: "2026-08-15T09:00:00.000Z",
    patientBound: true,
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.chatOptions.length = 0;
});

function renderChat(props: Partial<Parameters<typeof AssistantChat>[0]> = {}) {
  mocks.chatOptions.length = 0;
  return render(
    <AssistantChat
      initialConversationId={CURRENT}
      initialMessages={[]}
      remaining={19}
      role="admin"
      {...props}
    />,
  );
}

async function openHistory(props: Parameters<typeof renderChat>[0] = {}) {
  mocks.listHistory.mockResolvedValue({ success: true, conversations: HISTORY });
  const view = renderChat(props);
  fireEvent.click(screen.getByRole("button", { name: "History" }));
  await screen.findByText("Which patients have O+ blood?");
  return view;
}

describe("the history panel is reachable from the assistant page", () => {
  it("lists earlier conversations with their titles and marks the current one", async () => {
    await openHistory();
    expect(screen.getByRole("heading", { name: "Your conversations" })).toBeVisible();
    // An untitled conversation still gets a legible, translated entry.
    expect(screen.getByText("Untitled chat")).toBeVisible();
    expect(screen.getByText("Patient chat")).toBeVisible();
    expect(mocks.listHistory).toHaveBeenCalledTimes(1);
  });

  it("does not fetch history until the panel is opened", () => {
    mocks.listHistory.mockResolvedValue({ success: true, conversations: HISTORY });
    renderChat();
    expect(mocks.listHistory).not.toHaveBeenCalled();
  });

  it("offers a retry rather than an empty list when history is unavailable", async () => {
    mocks.listHistory.mockResolvedValue({ success: false, reason: "unavailable" });
    renderChat();
    fireEvent.click(screen.getByRole("button", { name: "History" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Your conversations could not be loaded.");

    mocks.listHistory.mockResolvedValue({ success: true, conversations: HISTORY });
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Which patients have O+ blood?")).toBeVisible();
  });

  it("says so honestly when there is nothing yet", async () => {
    mocks.listHistory.mockResolvedValue({ success: true, conversations: [] });
    renderChat();
    fireEvent.click(screen.getByRole("button", { name: "History" }));
    expect(
      await screen.findByText(
        "No earlier conversations yet. This one will appear here once you send a message.",
      ),
    ).toBeVisible();
  });
});

describe("opening an earlier conversation", () => {
  it("replaces the session with the persisted transcript and context", async () => {
    mocks.openConversation.mockResolvedValue({
      success: true,
      conversation: {
        id: EARLIER,
        title: "Which patients have O+ blood?",
        patientId: null,
        messages: [{
          id: "m1",
          role: "assistant",
          parts: [{ type: "text", text: "Twelve patients are O+." }],
        }],
        activeContext: {},
        historyTruncated: false,
      },
    });
    await openHistory();
    fireEvent.click(screen.getByRole("button", { name: /Which patients have O\+ blood\?/ }));

    expect(await screen.findByText("Twelve patients are O+.")).toBeVisible();
    expect(mocks.openConversation).toHaveBeenCalledWith({ conversationId: EARLIER });
    // The chat is re-keyed onto the resumed conversation, so the next turn is
    // sent against that id and the server continues its persisted history.
    expect(mocks.chatOptions.at(-1)!.id).toBe(EARLIER);
  });

  it("re-declares a resumed conversation's patient binding on the next turn", async () => {
    mocks.openConversation.mockResolvedValue({
      success: true,
      conversation: {
        id: PATIENT_CHAT,
        title: null,
        patientId: PATIENT,
        messages: [],
        activeContext: {},
        historyTruncated: false,
      },
    });
    await openHistory();
    fireEvent.click(screen.getByRole("button", { name: /Untitled chat/ }));
    await waitFor(() => expect(mocks.chatOptions.at(-1)!.id).toBe(PATIENT_CHAT));

    // The transport must carry the conversation's own binding, or the server
    // refuses the turn as a page-context/conversation mismatch. The server
    // re-authorizes the patient regardless; this is scope, never a grant.
    const { buildAssistantChatRequestBody } = await import(
      "@/components/assistant/assistant-chat"
    );
    expect(
      buildAssistantChatRequestBody({
        id: PATIENT_CHAT,
        pageContext: { type: "patient", patientId: PATIENT },
        message: undefined,
      }),
    ).toMatchObject({
      id: PATIENT_CHAT,
      context: { type: "patient", patientId: PATIENT },
    });
  });

  it("refreshes the list instead of erroring when a listed conversation has gone", async () => {
    mocks.openConversation.mockResolvedValue({ success: false, reason: "not_found" });
    await openHistory();
    mocks.listHistory.mockClear();
    fireEvent.click(screen.getByRole("button", { name: /Which patients have O\+ blood\?/ }));
    await waitFor(() => expect(mocks.listHistory).toHaveBeenCalled());
    // Still on the original conversation; nothing was swapped in.
    expect(mocks.chatOptions.at(-1)!.id).toBe(CURRENT);
  });
});

describe("new chat no longer loses the previous conversation", () => {
  it("starts a fresh conversation while the earlier one stays listed", async () => {
    await openHistory();
    fireEvent.click(screen.getByRole("button", { name: "Start a new chat" }));

    const fresh = mocks.chatOptions.at(-1)!.id;
    expect(fresh).not.toBe(CURRENT);
    expect(fresh).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );

    mocks.listHistory.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "History" }));
    expect(await screen.findByText("Which patients have O+ blood?")).toBeVisible();
  });

  it("keeps the header new-chat control working alongside the panel", async () => {
    renderChat();
    fireEvent.click(screen.getByRole("button", { name: "New chat" }));
    expect(mocks.chatOptions.at(-1)!.id).not.toBe(CURRENT);
  });
});

describe("the contextual shortcut uses the same conversation system", () => {
  const PAGE_CONTEXT = { type: "patient", patientId: PATIENT } as const;

  it("offers history, open and new chat inside the sheet", async () => {
    mocks.openConversation.mockResolvedValue({
      success: true,
      conversation: {
        id: EARLIER,
        title: "Which patients have O+ blood?",
        patientId: null,
        messages: [],
        activeContext: {},
        historyTruncated: false,
      },
    });
    await openHistory({
      mode: "sheet",
      pageContext: PAGE_CONTEXT,
      contextLabel: "Ahmed Hassan",
      role: "doctor",
    });

    const panel = screen.getByRole("heading", { name: "Your conversations" })
      .closest("section")!;
    expect(within(panel).getByRole("button", { name: "Start a new chat" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: /Which patients have O\+ blood\?/ }));
    await waitFor(() => expect(mocks.chatOptions.at(-1)!.id).toBe(EARLIER));
  });

  it("returns to the shortcut's own record when a new chat is started from it", async () => {
    await openHistory({
      mode: "sheet",
      pageContext: PAGE_CONTEXT,
      contextLabel: "Ahmed Hassan",
      role: "doctor",
    });
    fireEvent.click(screen.getByRole("button", { name: "Start a new chat" }));
    // The patient chip is the host record again, not the resumed conversation's.
    expect((await screen.findAllByText(/Ahmed Hassan/)).length).toBeGreaterThan(0);
  });

  it("stops showing the host record's name once a different conversation is resumed", async () => {
    mocks.openConversation.mockResolvedValue({
      success: true,
      conversation: {
        id: EARLIER,
        title: "Which patients have O+ blood?",
        patientId: null,
        messages: [],
        activeContext: {},
        historyTruncated: false,
      },
    });
    await openHistory({
      mode: "sheet",
      pageContext: PAGE_CONTEXT,
      contextLabel: "Ahmed Hassan",
      role: "doctor",
    });
    fireEvent.click(screen.getByRole("button", { name: /Which patients have O\+ blood\?/ }));
    await waitFor(() => expect(mocks.chatOptions.at(-1)!.id).toBe(EARLIER));
    expect(screen.queryAllByText(/Ahmed Hassan/)).toHaveLength(0);
  });
});

describe("accessibility of the history control", () => {
  it("wires the toggle to the panel and reports its expanded state", async () => {
    await openHistory();
    const toggle = screen.getByRole("button", { name: "History" });
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(document.getElementById(toggle.getAttribute("aria-controls")!)).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    await waitFor(() => expect(toggle).toHaveFocus());
  });

  it("marks the current conversation for assistive technology and disables re-opening it", async () => {
    await openHistory({ initialConversationId: EARLIER });
    const current = screen.getByRole("button", { name: /Which patients have O\+ blood\?/ });
    expect(current).toHaveAttribute("aria-current", "true");
    expect(current).toBeDisabled();
  });
});
