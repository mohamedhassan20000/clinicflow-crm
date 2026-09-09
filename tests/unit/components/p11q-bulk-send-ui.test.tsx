import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { beforeEach, describe, expect, it, vi } from "vitest";
import messages from "@/messages/en.json";
import type { BulkJobView } from "@/actions/bulk-messaging";
import type { BulkRecipient } from "@/lib/messaging/bulk-recipients";

/**
 * P11Q — the flow a receptionist actually walks through.
 *
 * The two things under test are the two that are irreversible if wrong: nothing
 * is sent without an explicit confirmation that names the number of people, and
 * a partial result is never dressed up as a success.
 */

const mocks = vi.hoisted(() => ({
  createBulkSend: vi.fn(),
  runBulkSend: vi.fn(),
  readBulkSendJob: vi.fn(),
}));

vi.mock("@/actions/bulk-messaging", () => ({
  createBulkSend: mocks.createBulkSend,
  runBulkSend: mocks.runBulkSend,
  readBulkSendJob: mocks.readBulkSendJob,
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    channel: () => ({ on() { return this; }, subscribe() { return this; } }),
    removeChannel: vi.fn(),
  }),
}));

import { BulkSendDialog } from "@/components/inbox/bulk-send-dialog";

/**
 * P18 — the dialog now takes the merged recipient list and owns the selection,
 * because recipients can come from the contact directory and the patient files
 * as well as from an Inbox thread. The three below are all conversations, so
 * every assertion about the confirmation flow is the same flow as before.
 */
const RECIPIENTS: BulkRecipient[] = [
  {
    key: "conversation:c1",
    source: "conversation",
    conversationId: "c1",
    address: "+201000000001",
    name: "Fatima Ahmed",
    fileNumber: null,
  },
  {
    key: "conversation:c2",
    source: "conversation",
    conversationId: "c2",
    address: "+201000000002",
    name: "Omar Khaled",
    fileNumber: null,
  },
  {
    key: "conversation:c3",
    source: "conversation",
    conversationId: "c3",
    address: "+201000000003",
    name: "Mona Sayed",
    fileNumber: null,
  },
];

const LABELS = RECIPIENTS.map((recipient) => ({
  conversationId: recipient.conversationId!,
  name: recipient.name,
}));

function job(overrides: Partial<BulkJobView> = {}): BulkJobView {
  return {
    id: "job-1",
    status: "completed",
    totalRecipients: 3,
    recipients: [
      { id: "r1", conversationId: "c1", name: "Fatima Ahmed", status: "sent", failureCode: null },
      { id: "r2", conversationId: "c2", name: "Omar Khaled", status: "sent", failureCode: null },
      { id: "r3", conversationId: "c3", name: "Mona Sayed", status: "sent", failureCode: null },
    ],
    ...overrides,
  };
}

function renderDialog(onOpenChange = vi.fn()) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
      <BulkSendDialog
        open
        onOpenChange={onOpenChange}
        recipients={RECIPIENTS}
        initialSelectedKeys={RECIPIENTS.map((recipient) => recipient.key)}
        onSent={vi.fn()}
      />
    </NextIntlClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.createBulkSend.mockResolvedValue({ success: true, jobId: "job-1" });
  mocks.runBulkSend.mockResolvedValue({ success: true, jobId: "job-1" });
  mocks.readBulkSendJob.mockResolvedValue({ job: job() });
});

describe("P11Q — nothing is sent without an explicit confirmation", () => {
  it("requires a message before recipients can even be reviewed", async () => {
    renderDialog();
    expect(screen.getByTestId("bulk-continue")).toBeDisabled();
  });

  it("shows the recipient list for review before any send", async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.type(screen.getByTestId("bulk-body"), "The clinic is closed tomorrow.");
    await user.click(screen.getByTestId("bulk-continue"));

    const list = screen.getByTestId("bulk-review-list");
    for (const label of LABELS) {
      expect(within(list).getByText(label.name)).toBeTruthy();
    }
    // Reviewing must not have sent anything.
    expect(mocks.createBulkSend).not.toHaveBeenCalled();
    expect(mocks.runBulkSend).not.toHaveBeenCalled();
  });

  it("names the number of people on the confirmation button", async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.type(screen.getByTestId("bulk-body"), "Closed tomorrow.");
    await user.click(screen.getByTestId("bulk-continue"));
    expect(screen.getByTestId("bulk-confirm").textContent).toContain("3");
  });

  it("sends only after the final confirmation", async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.type(screen.getByTestId("bulk-body"), "Closed tomorrow.");
    await user.click(screen.getByTestId("bulk-continue"));
    await user.click(screen.getByTestId("bulk-confirm"));
    await waitFor(() => expect(mocks.runBulkSend).toHaveBeenCalledTimes(1));
    expect(mocks.createBulkSend).toHaveBeenCalledWith({
      body: "Closed tomorrow.",
      conversationIds: ["c1", "c2", "c3"],
      addresses: [],
    });
  });

  /** A double-clicked button must not create two jobs. */
  it("does not create a second job when the confirm button is clicked twice", async () => {
    const user = userEvent.setup();
    let resolveCreate: (value: unknown) => void = () => {};
    mocks.createBulkSend.mockImplementation(
      () => new Promise((resolve) => {
        resolveCreate = resolve;
      }),
    );
    renderDialog();
    await user.type(screen.getByTestId("bulk-body"), "Closed tomorrow.");
    await user.click(screen.getByTestId("bulk-continue"));
    const confirm = screen.getByTestId("bulk-confirm");
    await user.click(confirm);
    await user.click(confirm).catch(() => {});
    resolveCreate({ success: true, jobId: "job-1" });
    await waitFor(() => expect(mocks.createBulkSend).toHaveBeenCalledTimes(1));
  });
});

describe("P11Q — results are reported honestly", () => {
  async function sendAndSettle() {
    const user = userEvent.setup();
    renderDialog();
    await user.type(screen.getByTestId("bulk-body"), "Closed tomorrow.");
    await user.click(screen.getByTestId("bulk-continue"));
    await user.click(screen.getByTestId("bulk-confirm"));
    await waitFor(() => expect(screen.getByTestId("bulk-progress")).toBeTruthy());
    return user;
  }

  it("shows a per-recipient outcome for every recipient", async () => {
    await sendAndSettle();
    await waitFor(() =>
      expect(screen.getAllByTestId("bulk-result-row")).toHaveLength(3),
    );
    for (const row of screen.getAllByTestId("bulk-result-row")) {
      expect(row.dataset.status).toBeTruthy();
    }
  });

  it("does not show a single success when only some recipients succeeded", async () => {
    mocks.readBulkSendJob.mockResolvedValue({
      job: job({
        status: "completed_with_failures",
        recipients: [
          { id: "r1", conversationId: "c1", name: "Fatima Ahmed", status: "sent", failureCode: null },
          { id: "r2", conversationId: "c2", name: "Omar Khaled", status: "failed", failureCode: "SERVICE_WINDOW_CLOSED" },
          { id: "r3", conversationId: "c3", name: "Mona Sayed", status: "skipped", failureCode: "no_address" },
        ],
      }),
    });
    await sendAndSettle();
    await waitFor(() => expect(screen.getAllByTestId("bulk-result-row")).toHaveLength(3));

    const statuses = screen.getAllByTestId("bulk-result-row").map((row) => row.dataset.status);
    expect(statuses).toEqual(["sent", "failed", "skipped"]);
    // Counts are broken out rather than aggregated into one tick.
    expect(screen.getByTestId("bulk-progress").textContent).toContain("1 sent");
    expect(screen.getByTestId("bulk-progress").textContent).toContain("1 failed");
    expect(screen.getByTestId("bulk-progress").textContent).toContain("1 skipped");
  });

  it("surfaces the reason a recipient failed or was skipped", async () => {
    mocks.readBulkSendJob.mockResolvedValue({
      job: job({
        status: "completed_with_failures",
        recipients: [
          { id: "r1", conversationId: "c1", name: "Fatima Ahmed", status: "sent", failureCode: null },
          { id: "r2", conversationId: "c2", name: "Omar Khaled", status: "failed", failureCode: "SERVICE_WINDOW_CLOSED" },
          { id: "r3", conversationId: "c3", name: "Mona Sayed", status: "skipped", failureCode: "no_address" },
        ],
      }),
    });
    await sendAndSettle();
    await waitFor(() => expect(screen.getByTestId("bulk-reasons")).toBeTruthy());
    const reasons = screen.getByTestId("bulk-reasons").textContent!;
    // P11Q.1: the stable code stays in the database; staff read a sentence.
    expect(reasons).toContain(messages.inbox.bulk.failureReason.serviceWindowClosed);
    expect(reasons).toContain(messages.inbox.bulk.failureReason.noAddress);
    expect(reasons).not.toContain("SERVICE_WINDOW_CLOSED");
    expect(reasons).not.toContain("no_address");
  });

  it("offers retry only when something actually failed", async () => {
    await sendAndSettle();
    await waitFor(() => expect(screen.getAllByTestId("bulk-result-row")).toHaveLength(3));
    expect(screen.queryByTestId("bulk-retry-failed")).toBeNull();
  });

  it("retries through the same job, so successes are never resent", async () => {
    mocks.readBulkSendJob.mockResolvedValue({
      job: job({
        status: "completed_with_failures",
        recipients: [
          { id: "r1", conversationId: "c1", name: "Fatima Ahmed", status: "sent", failureCode: null },
          { id: "r2", conversationId: "c2", name: "Omar Khaled", status: "failed", failureCode: "PROVIDER_SEND_FAILED" },
          { id: "r3", conversationId: "c3", name: "Mona Sayed", status: "sent", failureCode: null },
        ],
      }),
    });
    const user = await sendAndSettle();
    await waitFor(() => expect(screen.getByTestId("bulk-retry-failed")).toBeTruthy());
    mocks.runBulkSend.mockClear();
    await user.click(screen.getByTestId("bulk-retry-failed"));
    await waitFor(() => expect(mocks.runBulkSend).toHaveBeenCalledTimes(1));
    // The retry is the same job id — the server-side claim decides what is
    // eligible, so the client cannot accidentally target a sent recipient.
    expect(mocks.runBulkSend).toHaveBeenCalledWith({ jobId: "job-1" });
  });
});
