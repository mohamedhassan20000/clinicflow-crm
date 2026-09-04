import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  setMode: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
}));

vi.mock("@/actions/patient-ai", () => ({
  setPatientAiReplyMode: mocks.setMode,
}));
vi.mock("sonner", () => ({
  toast: { success: mocks.success, error: mocks.error },
}));

import { InboxAiRepliesControl } from "@/components/inbox/inbox-ai-replies-control";

/**
 * P17 (§7) — the clinic-wide AI switch in the Inbox header.
 *
 * The property being pinned is that this is a *second view* of one setting and
 * not a second setting: every change goes through `setPatientAiReplyMode`, the
 * same admin-gated action `Settings → Messaging` and the Patient AI mode
 * selector call, writing the same `clinics.ai_reply_mode` that
 * `resolveEffectiveConversationAi` and `patient-reply` read. If anyone ever
 * gives the Inbox its own boolean, these tests break.
 */
beforeEach(() => {
  vi.clearAllMocks();
  mocks.setMode.mockResolvedValue({ success: true });
});

describe("the Inbox clinic-wide AI control", () => {
  it("shows the stored mode, on", () => {
    render(<InboxAiRepliesControl mode="auto" overrideCount={0} canManage />);
    expect(screen.getByTestId("inbox-global-ai")).toHaveAttribute("data-ai-mode", "auto");
    expect(screen.getByTestId("inbox-global-ai-switch")).toBeChecked();
  });

  it("reads `suggest` as on, because it is not `off`", () => {
    // `off` is the only value that stops the assistant. A clinic on `suggest`
    // is still being answered — as a draft — and a header that called that
    // "off" would be lying about the setting it governs.
    render(<InboxAiRepliesControl mode="suggest" overrideCount={0} canManage />);
    expect(screen.getByTestId("inbox-global-ai-switch")).toBeChecked();
  });

  it("shows the stored mode, off", () => {
    render(<InboxAiRepliesControl mode="off" overrideCount={0} canManage />);
    expect(screen.getByTestId("inbox-global-ai-switch")).not.toBeChecked();
  });

  it("turns the clinic default off through the existing action", async () => {
    render(<InboxAiRepliesControl mode="auto" overrideCount={0} canManage />);
    await userEvent.click(screen.getByTestId("inbox-global-ai-switch"));
    expect(mocks.setMode).toHaveBeenCalledTimes(1);
    expect(mocks.setMode).toHaveBeenCalledWith({ mode: "off" });
  });

  it("restores the clinic default through the same action, and lets the server pick the mode", async () => {
    render(<InboxAiRepliesControl mode="off" overrideCount={0} canManage />);
    await userEvent.click(screen.getByTestId("inbox-global-ai-switch"));
    // `auto` is asked for; a clinic without `ai.patient_auto` is downgraded to
    // `suggest` server-side. The component never decides the resulting mode.
    expect(mocks.setMode).toHaveBeenCalledWith({ mode: "auto" });
  });

  it("reverses an optimistic flip when the server refuses", async () => {
    mocks.setMode.mockResolvedValue({ error: "settings.patientAiNotEntitled" });
    render(<InboxAiRepliesControl mode="auto" overrideCount={0} canManage />);
    const toggle = screen.getByTestId("inbox-global-ai-switch");
    await userEvent.click(toggle);
    expect(toggle).toBeChecked();
    expect(mocks.error).toHaveBeenCalledWith("settings.patientAiNotEntitled");
  });

  it("is read-only for a role that may not change it", async () => {
    render(<InboxAiRepliesControl mode="auto" overrideCount={0} canManage={false} />);
    const toggle = screen.getByTestId("inbox-global-ai-switch");
    expect(toggle).toBeDisabled();
    await userEvent.click(toggle).catch(() => {});
    expect(mocks.setMode).not.toHaveBeenCalled();
  });

  it("does not claim every conversation follows the clinic default when some do not", () => {
    render(<InboxAiRepliesControl mode="off" overrideCount={2} canManage />);
    expect(screen.getByTestId("inbox-global-ai-overrides")).toBeInTheDocument();
  });

  it("says nothing about overrides when there are none", () => {
    render(<InboxAiRepliesControl mode="off" overrideCount={0} canManage />);
    expect(screen.queryByTestId("inbox-global-ai-overrides")).toBeNull();
  });

  it("yields to the server's value on re-render rather than pinning a stale flip", async () => {
    const { rerender } = render(
      <InboxAiRepliesControl mode="auto" overrideCount={0} canManage />,
    );
    await userEvent.click(screen.getByTestId("inbox-global-ai-switch"));
    // The page re-renders with what the database actually holds.
    rerender(<InboxAiRepliesControl mode="off" overrideCount={0} canManage />);
    expect(screen.getByTestId("inbox-global-ai-switch")).not.toBeChecked();
    rerender(<InboxAiRepliesControl mode="suggest" overrideCount={0} canManage />);
    expect(screen.getByTestId("inbox-global-ai-switch")).toBeChecked();
  });
});
