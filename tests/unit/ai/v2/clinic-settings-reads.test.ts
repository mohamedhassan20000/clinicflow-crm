/**
 * The two settings reads V2 could not previously reach, at the tool boundary.
 *
 * `readClinicFaq` existed and nothing called it. `readClinicInsurance` did not
 * exist at all, so the `insurance` topic — a valid `QUESTION_TOPIC` the
 * interpreter is prompted to emit — was answered from the clinic's *contact
 * row*. A clinic with eight insurers configured in Settings got its own address
 * back, and then, because `info.insurance` had no copy, the generic opening.
 *
 * The flow-level wiring is asserted in `conversational-parity.test.ts`. This
 * file asserts what the reads themselves do: the filters, the threshold, and
 * the fail-quiet behaviour that keeps a settings read from taking down a turn.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const searchPatientClinicFaq = vi.fn();

/** Records the filters a query applied, so they can be asserted as data. */
type Query = { table: string; eq: [string, unknown][]; is: [string, unknown][]; limit: number | null };
const queries: Query[] = [];
let insuranceRows: { name: string }[] = [];
let insuranceError: unknown = null;

function makeScopedClient() {
  return {
    from(table: string) {
      const query: Query = { table, eq: [], is: [], limit: null };
      queries.push(query);
      const builder: Record<string, unknown> = {};
      builder.select = () => builder;
      builder.order = () => builder;
      builder.eq = (column: string, value: unknown) => {
        query.eq.push([column, value]);
        return builder;
      };
      builder.is = (column: string, value: unknown) => {
        query.is.push([column, value]);
        return builder;
      };
      builder.limit = (value: number) => {
        query.limit = value;
        return builder;
      };
      builder.then = (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
        Promise.resolve({
          data: insuranceError ? null : insuranceRows,
          error: insuranceError,
        }).then(onF, onR);
      return builder;
    },
  };
}

vi.mock("@/lib/supabase/admin", () => ({
  createClinicScopedAdminClient: () => makeScopedClient(),
  searchPatientClinicFaq: (...args: unknown[]) => searchPatientClinicFaq(...args),
  // The rest of the module's surface, so the named imports in `tools.ts`
  // resolve. None of them is called by the two functions under test.
  cancelPatientAiAppointment: vi.fn(),
  createPatientPreliminaryBookingWithPackage: vi.fn(),
  findClinicPatientByIdentity: vi.fn(),
  listClinicPublicPackages: vi.fn(),
  listPatientAiDocuments: vi.fn(),
  listPatientAiPackages: vi.fn(),
  signClinicDocumentUrl: vi.fn(),
  getPatientClinicPublicInfo: vi.fn(),
  getClinicCurrency: vi.fn(),
  listPatientAiAppointments: vi.fn(),
  preparePatientAiReschedule: vi.fn(),
  reschedulePatientAiAppointment: vi.fn(),
  stagePatientIntakeFromConversation: vi.fn(),
}));

import { readClinicFaq, readClinicInsurance } from "@/lib/ai/v2/tools";
import type { TurnContext } from "@/lib/ai/v2/context";

const context = {
  clinicId: "clinic-1",
  conversationId: "conv-1",
  turn: { text: "في موقف عربيات؟", receivedAt: "", locale: "ar", attachments: [] },
} as unknown as TurnContext;

beforeEach(() => {
  vi.clearAllMocks();
  queries.length = 0;
  insuranceRows = [];
  insuranceError = null;
});

describe("readClinicInsurance", () => {
  it("reads only active, undeleted insurers of this clinic", async () => {
    insuranceRows = [{ name: "أكسا" }, { name: "مصر للتأمين" }];
    const providers = await readClinicInsurance(context);
    // The read now returns entities rather than bare strings: a label to show
    // and the clinic's other authored names to match on. `label` is the only
    // one that ever reaches a message.
    expect(providers.map((provider) => provider.label)).toEqual([
      "أكسا",
      "مصر للتأمين",
    ]);
    const query = queries.find((entry) => entry.table === "insurance_providers");
    expect(query).toBeDefined();
    // Deactivating an insurer in Settings must remove it from the answer.
    expect(query?.eq).toContainEqual(["is_active", true]);
    expect(query?.is).toContainEqual(["deleted_at", null]);
    expect(query?.limit).toBeGreaterThan(0);
  });

  it("returns an empty list rather than throwing when the read fails", async () => {
    insuranceError = { message: "boom" };
    // A settings read that cannot complete must not take the turn down; the
    // caller says "no insurers listed", which is the safe answer either way.
    await expect(readClinicInsurance(context)).resolves.toEqual([]);
  });

  it("drops blank names instead of quoting them", async () => {
    insuranceRows = [{ name: "  " }, { name: " أكسا " }];
    const providers = await readClinicInsurance(context);
    expect(providers.map((provider) => provider.label)).toEqual(["أكسا"]);
  });
});

describe("readClinicFaq", () => {
  it("applies the same match threshold the legacy FAQ tool applies", async () => {
    // 0.18, from `lib/ai/tools/answer-clinic-faq.ts`. A clinic that tuned its
    // FAQ text against one engine must not find it matching differently under
    // the other.
    searchPatientClinicFaq.mockResolvedValue({
      data: [
        { question: "q1", answer: "a strong match", score: 0.42 },
        { question: "q2", answer: "a weak match", score: 0.05 },
      ],
      error: null,
    });
    const rows = await readClinicFaq({ context, question: "في موقف عربيات؟" });
    expect(rows.map((row) => row.answer)).toEqual(["a strong match"]);
  });

  it("searches with the patient's words in the turn's own language", async () => {
    searchPatientClinicFaq.mockResolvedValue({ data: [], error: null });
    await readClinicFaq({ context, question: "في موقف عربيات؟" });
    expect(searchPatientClinicFaq).toHaveBeenCalledWith({
      clinicId: "clinic-1",
      conversationId: "conv-1",
      question: "في موقف عربيات؟",
      language: "ar",
    });
  });

  it("returns nothing when the search fails", async () => {
    searchPatientClinicFaq.mockResolvedValue({ data: null, error: { message: "boom" } });
    await expect(readClinicFaq({ context, question: "x" })).resolves.toEqual([]);
  });
});
