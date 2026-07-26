import { beforeAll, describe, expect, it, vi } from "vitest";

type ContextModule = typeof import("@/lib/ai/conversation-context");

let contextModule: ContextModule;

const IDS = {
  patient: "11111111-1111-4111-8111-111111111111",
  appointment: "22222222-2222-4222-8222-222222222222",
  invoice: "33333333-3333-4333-8333-333333333333",
  staff: "44444444-4444-4444-8444-444444444444",
  department: "55555555-5555-4555-8555-555555555555",
  report: "no_shows",
} as const;

beforeAll(async () => {
  vi.doMock("server-only", () => ({}));
  contextModule = await import("@/lib/ai/conversation-context");
});

describe("P4.10B cross-entity context schema", () => {
  it("round-trips one independently validated slot for every roadmap entity", () => {
    const now = new Date("2026-07-26T10:00:00.000Z");
    const proposals = contextModule.ACTIVE_CONTEXT_ENTITY_TYPES.map((entityType) => ({
      entityType,
      entityId: IDS[entityType],
      displayLabel: `${entityType} label`,
      setBy: "resolution" as const,
    }));

    const active = contextModule.applyProposals({}, proposals, now);
    const parsed = contextModule.parseActiveContext(active);

    expect(Object.keys(parsed)).toEqual(contextModule.ACTIVE_CONTEXT_ENTITY_TYPES);
    for (const entityType of contextModule.ACTIVE_CONTEXT_ENTITY_TYPES) {
      expect(contextModule.activeEntityId(parsed, entityType)).toBe(IDS[entityType]);
      expect(parsed[entityType]).toMatchObject({
        entity_type: entityType,
        entity_id: IDS[entityType],
        set_at: now.toISOString(),
      });
    }
  });

  it("accepts only allow-listed report slugs and UUIDs for every other type", () => {
    const validReport = contextModule.applyProposal({}, {
      entityType: "report",
      entityId: "revenue",
      displayLabel: "Revenue",
      setBy: "resolution",
    });
    expect(validReport.report?.entity_id).toBe("revenue");

    expect(contextModule.applyProposal({}, {
      entityType: "report",
      entityId: "invented_report",
      displayLabel: "Invented",
      setBy: "resolution",
    })).toEqual({});
    expect(contextModule.applyProposal({}, {
      entityType: "appointment",
      entityId: "not-a-uuid",
      displayLabel: "Appointment",
      setBy: "resolution",
    })).toEqual({});
  });
});

describe("P4.10B natural switching and clearing", () => {
  it("keeps one slot per type and switches only the newly resolved type", () => {
    const recorder = new contextModule.ConversationContextRecorder();
    recorder.propose("staff", IDS.staff, "Dr A");
    recorder.propose("appointment", IDS.appointment, "Appointment A");
    recorder.propose("staff", "66666666-6666-4666-8666-666666666666", "Dr B");

    expect(recorder.takeAll()).toEqual([
      {
        entityType: "staff",
        entityId: "66666666-6666-4666-8666-666666666666",
        displayLabel: "Dr B",
        setBy: "resolution",
      },
      {
        entityType: "appointment",
        entityId: IDS.appointment,
        displayLabel: "Appointment A",
        setBy: "resolution",
      },
    ]);

    const first = contextModule.applyProposals({}, recorder.takeAll());
    const switched = contextModule.applyProposal(first, {
      entityType: "appointment",
      entityId: "77777777-7777-4777-8777-777777777777",
      displayLabel: "Appointment B",
      setBy: "user_choice",
    });
    expect(switched.staff?.display_label).toBe("Dr B");
    expect(switched.appointment).toMatchObject({
      entity_id: "77777777-7777-4777-8777-777777777777",
      set_by: "user_choice",
    });
  });

  it("clears exactly the selected slot without disturbing its neighbors", () => {
    const active = contextModule.applyProposals({}, [
      {
        entityType: "patient",
        entityId: IDS.patient,
        displayLabel: "Patient",
        setBy: "resolution",
      },
      {
        entityType: "invoice",
        entityId: IDS.invoice,
        displayLabel: "Invoice",
        setBy: "resolution",
      },
    ]);
    const cleared = contextModule.clearActiveEntityContext(active, "patient");
    expect(cleared.patient).toBeUndefined();
    expect(cleared.invoice?.entity_id).toBe(IDS.invoice);
  });
});

describe("P4.10B prompt trust boundary", () => {
  it.each(["en", "ar"] as const)(
    "includes every internal default but never any UI display label in %s",
    (locale) => {
      const active = contextModule.applyProposals(
        {},
        contextModule.ACTIVE_CONTEXT_ENTITY_TYPES.map((entityType) => ({
          entityType,
          entityId: IDS[entityType],
          displayLabel: `PROMPT INJECTION ${entityType}`,
          setBy: "resolution" as const,
        })),
      );
      const prompt = contextModule.buildActiveContextPrompt(active, locale);

      for (const entityType of contextModule.ACTIVE_CONTEXT_ENTITY_TYPES) {
        expect(prompt).toContain(IDS[entityType]);
        expect(prompt).not.toContain(`PROMPT INJECTION ${entityType}`);
      }
      expect(prompt).toMatch(
        locale === "ar" ? /لا يمنح أي صلاحية/ : /grants no access/i,
      );
      expect(prompt).toMatch(
        locale === "ar" ? /use_active/ : /leave every use_active flag false or omitted/i,
      );
    },
  );
});
