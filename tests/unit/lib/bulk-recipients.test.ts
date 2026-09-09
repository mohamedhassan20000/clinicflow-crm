import { describe, expect, it } from "vitest";
import {
  buildBulkRecipients,
  bulkRecipientMatches,
  hasUsableDestination,
  type BulkRecipient,
} from "@/lib/messaging/bulk-recipients";

/**
 * Who a bulk send can reach, merged from the three lists the Inbox holds.
 *
 * The properties that matter are the ones a clinic would notice going wrong:
 * nobody is written to twice, nobody is offered who cannot be written to at
 * all, and where a person appears in more than one list the row that survives
 * is the one whose address is most certainly reachable.
 */

function merge(
  overrides: Partial<Parameters<typeof buildBulkRecipients>[0]> = {},
): BulkRecipient[] {
  return buildBulkRecipients({
    conversations: [],
    contacts: [],
    patients: [],
    fallbackName: "Unknown",
    ...overrides,
  });
}

const conversation = {
  id: "c1",
  sender: "+201000000001",
  patientName: "Fatima Ahmed",
  displayName: "Fatima",
  patientFileNumber: "F-001",
  status: "open",
};

const contact = {
  id: "w1",
  participantAddress: "+201000000002",
  displayName: "Omar Khaled",
  patientName: null,
  patientFileNumber: null,
};

const patient = {
  id: "p1",
  name: "Mona Sayed",
  phone: "+201000000003",
  fileNumber: "F-003",
};

describe("bulk recipients — the three sources", () => {
  it("offers conversations, contacts and patient files alike", () => {
    const merged = merge({
      conversations: [conversation],
      contacts: [contact],
      patients: [patient],
    });
    expect(merged.map((recipient) => recipient.source).sort()).toEqual([
      "contact",
      "conversation",
      "patient",
    ]);
  });

  it("names each recipient from the most authoritative label it has", () => {
    const merged = merge({ conversations: [conversation], patients: [patient] });
    // The patient record beats the WhatsApp display name on a linked thread.
    expect(merged[0]!.name).toBe("Fatima Ahmed");
    expect(merged[1]!.name).toBe("Mona Sayed");
  });
});

describe("bulk recipients — deduplication", () => {
  it("collapses the same number appearing in two sources onto one recipient", () => {
    const merged = merge({
      conversations: [conversation],
      contacts: [{ ...contact, participantAddress: "+201000000001" }],
      patients: [{ ...patient, phone: "+201000000001" }],
    });
    expect(merged).toHaveLength(1);
  });

  it("keeps the conversation when a person is in more than one list", () => {
    const merged = merge({
      conversations: [conversation],
      contacts: [{ ...contact, participantAddress: "+201000000001" }],
    });
    expect(merged[0]!.source).toBe("conversation");
    expect(merged[0]!.conversationId).toBe("c1");
  });

  it("prefers a contact over a patient file for the same number", () => {
    const merged = merge({
      contacts: [contact],
      patients: [{ ...patient, phone: "+201000000002" }],
    });
    expect(merged[0]!.source).toBe("contact");
  });

  it("treats the same number written differently as one person", () => {
    // Addressing only. Nothing here decides that the two rows are the same
    // *person* — only that they are the same destination.
    const merged = merge({
      conversations: [{ ...conversation, sender: "+20 100 000 0001" }],
      patients: [{ ...patient, phone: "+201000000001" }],
    });
    expect(merged).toHaveLength(1);
    expect(merged[0]!.source).toBe("conversation");
  });
});

describe("bulk recipients — nobody unreachable is offered", () => {
  it("excludes a patient file with no phone number", () => {
    expect(merge({ patients: [{ ...patient, phone: "" }] })).toHaveLength(0);
  });

  it("excludes a conversation with no participant address", () => {
    expect(merge({ conversations: [{ ...conversation, sender: null }] })).toHaveLength(0);
  });

  it("excludes a value too short to be a destination", () => {
    expect(hasUsableDestination("123")).toBe(false);
    expect(hasUsableDestination("+201000000001")).toBe(true);
    expect(merge({ patients: [{ ...patient, phone: "1234" }] })).toHaveLength(0);
  });

  it("still offers a closed conversation, so its skip can be explained", () => {
    const merged = merge({ conversations: [{ ...conversation, status: "closed" }] });
    expect(merged).toHaveLength(1);
  });
});

describe("bulk recipients — search", () => {
  const merged = merge({
    conversations: [conversation],
    contacts: [contact],
    patients: [patient],
  });

  it("matches on name", () => {
    expect(merged.filter((r) => bulkRecipientMatches(r, "omar"))).toHaveLength(1);
  });

  it("matches on file number", () => {
    expect(merged.filter((r) => bulkRecipientMatches(r, "F-003"))).toHaveLength(1);
  });

  it("matches on phone, however the query is punctuated", () => {
    expect(merged.filter((r) => bulkRecipientMatches(r, "+20 100 000 0002"))).toHaveLength(1);
    expect(merged.filter((r) => bulkRecipientMatches(r, "0000003"))).toHaveLength(1);
  });

  it("matches everything on an empty query", () => {
    expect(merged.filter((r) => bulkRecipientMatches(r, "  "))).toHaveLength(3);
  });
});
