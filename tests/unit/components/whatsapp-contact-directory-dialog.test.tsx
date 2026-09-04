import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { beforeEach, describe, expect, it, vi } from "vitest";
import messages from "@/messages/en.json";
import type { InboxContactOption } from "@/lib/messaging/inbox";

/**
 * The contact directory is not the Inbox.
 *
 * Everything the linked device tells us about the scanned account's contacts is
 * persisted and searchable, but a directory entry is a *recipient*, not a
 * thread. A clinic that has just linked a personal handset would otherwise find
 * its Inbox pre-populated with every person the phone has ever known, which is
 * neither what they asked for nor something they can undo.
 *
 * So: a thread exists only when staff explicitly start one, when real traffic
 * arrives, or when account-scoped history creates one. These cases pin the
 * first of those three — the only one a person drives.
 */

const mocks = vi.hoisted(() => ({
  open: vi.fn(),
  refreshContacts: vi.fn(),
  push: vi.fn(),
  refresh: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.push, refresh: mocks.refresh }),
}));
vi.mock("@/actions/messaging", () => ({
  openNewWhatsAppConversation: mocks.open,
  refreshInboxContacts: mocks.refreshContacts,
}));
vi.mock("sonner", () => ({ toast: { error: mocks.toastError, success: vi.fn() } }));

import { NewConversationDialog } from "@/components/inbox/new-conversation-dialog";

const CONTACTS: InboxContactOption[] = [
  {
    id: "c1",
    displayName: "Layla Haddad",
    participantAddress: "+201111111111",
    patientId: null,
    patientName: null,
    patientFileNumber: null,
  },
  {
    id: "c2",
    displayName: null,
    participantAddress: "+201222222222",
    patientId: null,
    patientName: null,
    patientFileNumber: null,
  },
];

function renderDialog(contacts = CONTACTS) {
  currentContacts = contacts;
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <NewConversationDialog contacts={contacts} />
    </NextIntlClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.open.mockResolvedValue({ conversationId: "conv-1" });
  // The dialog re-reads the directory whenever it opens; by default the refresh
  // answers with exactly what was rendered, so these cases stay about the UI.
  mocks.refreshContacts.mockImplementation(async () =>
    directoryOf(currentContacts),
  );
});

let currentContacts: InboxContactOption[] = CONTACTS;

function directoryOf(contacts: InboxContactOption[]) {
  const linked = contacts.filter((contact) => contact.patientId).length;
  return {
    contacts,
    total: contacts.length,
    linked,
    unlinked: contacts.length - linked,
    accountConnected: true,
    truncated: false,
    error: false,
  };
}

describe("starting a conversation from the linked-account contact directory", () => {
  it("lists linked contacts without opening a thread for any of them", async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.click(screen.getByRole("button", { name: /new conversation/i }));
    await user.click(screen.getByRole("tab", { name: /WhatsApp contacts/i }));

    expect(screen.getByText("Layla Haddad")).toBeInTheDocument();
    // Rendering the directory is a read. Nothing has been started.
    expect(mocks.open).not.toHaveBeenCalled();
  });

  it("still opens nothing when a contact is selected — only when the clinic says so", async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.click(screen.getByRole("button", { name: /new conversation/i }));
    await user.click(screen.getByRole("tab", { name: /WhatsApp contacts/i }));
    await user.click(screen.getByText("Layla Haddad"));

    // Selection fills the recipient field; it is not itself an intent to talk.
    expect(mocks.open).not.toHaveBeenCalled();
    expect(screen.getByLabelText(/whatsapp number/i)).toHaveValue("+201111111111");

    await user.click(screen.getByRole("button", { name: /open conversation/i }));
    await waitFor(() =>
      expect(mocks.open).toHaveBeenCalledWith({
        participant: "+201111111111",
        displayName: "Layla Haddad",
      }),
    );
  });

  it("keeps manual international numbers available for someone not in the directory", async () => {
    const user = userEvent.setup();
    renderDialog([]);
    await user.click(screen.getByRole("button", { name: /new conversation/i }));

    // An empty directory is a normal state — Baileys promises no complete
    // address book — and must never be a dead end. The picker collapses; the
    // number field does not.
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    await user.type(screen.getByLabelText(/whatsapp number/i), "+905550000000");
    await user.click(screen.getByRole("button", { name: /open conversation/i }));

    await waitFor(() =>
      expect(mocks.open).toHaveBeenCalledWith({
        participant: "+905550000000",
        displayName: null,
      }),
    );
  });

  it("says linked WhatsApp contacts, never the phone's address book", async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.click(screen.getByRole("button", { name: /new conversation/i }));

    // Wording is a correctness question here: the linked-device protocol
    // exposes the contacts it chooses to sync, and promising the handset's
    // address book would be a claim this system cannot keep.
    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent?.toLowerCase()).toContain("linked contact");
    expect(dialog.textContent?.toLowerCase()).not.toContain("address book");
    expect(dialog.textContent?.toLowerCase()).not.toContain("phone contacts");
  });
});
