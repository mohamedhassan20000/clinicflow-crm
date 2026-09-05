import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { beforeEach, describe, expect, it, vi } from "vitest";
import en from "@/messages/en.json";
import ar from "@/messages/ar.json";
import {
  contactMatches,
  groupInboxContacts,
  type InboxContactDirectory,
  type InboxContactOption,
} from "@/lib/messaging/inbox-contact-groups";

/**
 * The New Conversation directory, redesigned.
 *
 * Production proved the data was there — hundreds of contacts scoped to the
 * authenticated account — while the dialog showed a flat, countless list that
 * said nothing about whether a number was already a patient here. These cases
 * pin the answers the redesign has to keep giving: the total before anyone
 * searches, the two tabs and their counts, an isolated search per tab, and the
 * rule that a thread is created only by the explicit action.
 */

/**
 * The shared setup pins every `useTranslations` to English so the suite's ~600
 * English assertions resolve through the real catalog. Arabic parity therefore
 * has to re-point it here, which is the established per-file pattern: the same
 * next-intl resolver, a different catalog.
 */
const intl = vi.hoisted(() => ({ locale: "en" as "en" | "ar" }));

vi.mock("next-intl", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next-intl")>();
  const catalogs = {
    en: (await import("@/messages/en.json")).default,
    ar: (await import("@/messages/ar.json")).default,
  };
  return {
    ...actual,
    useLocale: () => intl.locale,
    useTranslations: (namespace?: string) =>
      actual.createTranslator({
        locale: intl.locale,
        messages: catalogs[intl.locale] as never,
        namespace: namespace as never,
      }),
    useFormatter: () => actual.createFormatter({ locale: intl.locale }),
    useMessages: () => catalogs[intl.locale],
  };
});

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

function contact(overrides: Partial<InboxContactOption> = {}): InboxContactOption {
  return {
    id: "c-1",
    displayName: "Layla Haddad",
    participantAddress: "+201111111111",
    patientId: null,
    patientName: null,
    patientFileNumber: null,
    ...overrides,
  };
}

const LINKED = contact({
  id: "linked-1",
  displayName: "Mona Ali",
  participantAddress: "+201222222222",
  patientId: "patient-1",
  patientName: "Mona Ali",
  patientFileNumber: "CF-42",
});
const UNLINKED = contact({ id: "unlinked-1" });

function directory(
  contacts: InboxContactOption[],
  overrides: Partial<InboxContactDirectory> = {},
): InboxContactDirectory {
  const linked = contacts.filter((item) => item.patientId).length;
  return {
    contacts,
    total: contacts.length,
    linked,
    unlinked: contacts.length - linked,
    accountConnected: true,
    truncated: false,
    error: false,
    ...overrides,
  };
}

function renderDialog(
  contacts: InboxContactOption[],
  options: { locale?: "en" | "ar"; directory?: InboxContactDirectory } = {},
) {
  const locale = options.locale ?? "en";
  intl.locale = locale;
  return render(
    <NextIntlClientProvider locale={locale} messages={locale === "ar" ? ar : en}>
      <NewConversationDialog
        contacts={contacts}
        directory={options.directory ?? directory(contacts)}
      />
    </NextIntlClientProvider>,
  );
}

beforeEach(() => {
  intl.locale = "en";
  vi.clearAllMocks();
  mocks.open.mockResolvedValue({ success: true, conversationId: "conv-1" });
  mocks.refreshContacts.mockImplementation(async () => directory([LINKED, UNLINKED]));
});

describe("linkage grouping", () => {
  it("groups on the server-computed patient link and nothing else", () => {
    const { clinic, whatsapp } = groupInboxContacts([LINKED, UNLINKED]);
    expect(clinic.map((item) => item.id)).toEqual(["linked-1"]);
    expect(whatsapp.map((item) => item.id)).toEqual(["unlinked-1"]);
  });

  it("searches names, patient names, file numbers and numbers alike", () => {
    expect(contactMatches(LINKED, "mona")).toBe(true);
    expect(contactMatches(LINKED, "CF-42")).toBe(true);
    expect(contactMatches(LINKED, "+20 122")).toBe(true);
    expect(contactMatches(UNLINKED, "mona")).toBe(false);
  });
});

describe("the New Conversation directory", () => {
  it("shows the total and both group counts before anyone searches", async () => {
    const user = userEvent.setup();
    renderDialog([LINKED, UNLINKED]);
    await user.click(screen.getByRole("button", { name: /new conversation/i }));

    expect(await screen.findByText("2 linked contacts")).toBeInTheDocument();
    const clinicGroup = screen.getByRole("listbox", { name: "Clinic contacts" });
    expect(within(clinicGroup).getByRole("option", { name: /Mona Ali/ })).toBeInTheDocument();
    expect(within(clinicGroup).getByText("In clinic")).toBeInTheDocument();
    expect(screen.queryByRole("listbox", { name: "WhatsApp contacts" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: /WhatsApp contacts\s*\(1\)/i }));
    const whatsappGroup = screen.getByRole("listbox", { name: "WhatsApp contacts" });
    expect(within(whatsappGroup).getByRole("option", { name: /Layla Haddad/ })).toBeInTheDocument();
    expect(within(whatsappGroup).getByText("Not linked")).toBeInTheDocument();
  });

  it("keeps both tabs fully inset in one fixed-height rail without crowding the list", async () => {
    const user = userEvent.setup();
    renderDialog([LINKED, UNLINKED]);
    await user.click(screen.getByRole("button", { name: /new conversation/i }));

    const rail = screen.getByRole("tablist");
    expect(rail).toHaveClass("h-10", "overflow-hidden", "rounded-lg", "p-1");

    const tabs = screen.getAllByRole("tab");
    expect(tabs).toHaveLength(2);
    for (const tab of tabs) {
      expect(tab).toHaveClass("h-full", "min-h-0", "min-w-0", "overflow-hidden");
    }

    const list = screen.getByRole("listbox", { name: "Clinic contacts" });
    expect(list).toHaveClass(
      "overflow-x-hidden",
      "overflow-y-auto",
      "rounded-lg",
      "[scrollbar-gutter:stable]",
    );
    expect(list.parentElement?.parentElement).toHaveClass("gap-3");

    tabs[0].focus();
    await user.keyboard("{ArrowRight}");
    expect(tabs[1]).toHaveFocus();
    expect(tabs[1]).toHaveAttribute("aria-selected", "true");
  });

  it("keeps a separate search inside each tab", async () => {
    const user = userEvent.setup();
    renderDialog([LINKED, UNLINKED]);
    await user.click(screen.getByRole("button", { name: /new conversation/i }));
    await user.type(screen.getByLabelText(/search Clinic contacts/i), "Layla");

    expect(screen.queryByRole("option", { name: /Mona Ali/ })).not.toBeInTheDocument();
    expect(screen.getByText("No contacts match this search.")).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: /WhatsApp contacts\s*\(1\)/i }));
    expect(screen.getByRole("option", { name: /Layla Haddad/ })).toBeInTheDocument();
    expect(screen.getByLabelText(/search WhatsApp contacts/i)).toHaveValue("");

    await user.type(screen.getByLabelText(/search WhatsApp contacts/i), "nobody");
    await user.click(screen.getByRole("tab", { name: /Clinic contacts\s*\(1\)/i }));
    expect(screen.getByLabelText(/search Clinic contacts/i)).toHaveValue("Layla");
  });

  it("creates nothing by selecting, and only opens on the explicit action", async () => {
    const user = userEvent.setup();
    renderDialog([LINKED, UNLINKED]);
    await user.click(screen.getByRole("button", { name: /new conversation/i }));
    await user.click(await screen.findByRole("option", { name: /Mona Ali/ }));

    expect(mocks.open).not.toHaveBeenCalled();
    expect(screen.getByLabelText(/whatsapp number/i)).toHaveValue("+201222222222");

    await user.click(screen.getByRole("button", { name: /open conversation/i }));
    await waitFor(() =>
      expect(mocks.open).toHaveBeenCalledWith({
        participant: "+201222222222",
        displayName: "Mona Ali",
      }),
    );
  });

  it("keeps manual international entry available with an empty directory", async () => {
    const user = userEvent.setup();
    mocks.refreshContacts.mockResolvedValue(directory([]));
    renderDialog([]);
    await user.click(screen.getByRole("button", { name: /new conversation/i }));

    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(screen.getByText(/no linked contacts have been synced/i)).toBeInTheDocument();

    await user.type(screen.getByLabelText(/whatsapp number/i), "+905550000000");
    await user.click(screen.getByRole("button", { name: /open conversation/i }));
    await waitFor(() =>
      expect(mocks.open).toHaveBeenCalledWith({
        participant: "+905550000000",
        displayName: null,
      }),
    );
  });

  it("re-reads contacts every time it is opened, so a stale page self-heals", async () => {
    const user = userEvent.setup();
    // The reported shape: the page rendered before the worker had imported
    // anything, and a hard refresh of the whole Inbox was the only cure.
    mocks.refreshContacts.mockResolvedValueOnce(directory([]));
    mocks.refreshContacts.mockResolvedValueOnce(directory([LINKED, UNLINKED]));
    renderDialog([], { directory: directory([]) });

    await user.click(screen.getByRole("button", { name: /new conversation/i }));
    await waitFor(() => expect(mocks.refreshContacts).toHaveBeenCalledTimes(1));
    expect(screen.getByText("No linked contacts")).toBeInTheDocument();

    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: /new conversation/i }));
    await waitFor(() => expect(mocks.refreshContacts).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("2 linked contacts")).toBeInTheDocument();
  });

  it("shows an account with no contacts of its own, never another account's", async () => {
    const user = userEvent.setup();
    // Isolation is a server property (the directory read filters on the bound
    // account); what the dialog owes is to render exactly what it was handed.
    mocks.refreshContacts.mockResolvedValue(directory([LINKED]));
    renderDialog([LINKED]);
    await user.click(screen.getByRole("button", { name: /new conversation/i }));

    expect(await screen.findByText("1 linked contact")).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /Layla Haddad/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: /WhatsApp contacts\s*\(0\)/i }));
    expect(screen.getByText("Every synced contact is already a patient file.")).toBeInTheDocument();
  });

  it("renders both groups in Arabic", async () => {
    const user = userEvent.setup();
    renderDialog([LINKED, UNLINKED], { locale: "ar" });
    await user.click(screen.getByRole("button", { name: ar.inbox.newConversation.trigger }));

    expect(
      await screen.findByRole("listbox", { name: ar.inbox.newConversation.clinicGroup }),
    ).toBeInTheDocument();
    expect(screen.getByText(ar.inbox.newConversation.inClinicBadge)).toBeInTheDocument();
    await user.click(
      screen.getByRole("tab", { name: new RegExp(ar.inbox.newConversation.whatsappGroup) }),
    );
    expect(
      screen.getByRole("listbox", { name: ar.inbox.newConversation.whatsappGroup }),
    ).toBeInTheDocument();
    expect(screen.getByText(ar.inbox.newConversation.notLinkedBadge)).toBeInTheDocument();
    // The number stays LTR inside an RTL dialog; a phone number read
    // right-to-left is a different number.
    expect(screen.getByText("+201111111111")).toHaveAttribute("dir", "ltr");
  });
});
