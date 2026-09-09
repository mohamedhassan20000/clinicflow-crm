/**
 * The context firewall, asserted rather than described.
 *
 * The claim this file exists to make checkable: **the model on this surface
 * cannot see a durable patient fact**, so it cannot emit a command naming one.
 * That is not a property of the prompt's wording — it is a property of the
 * object the prompt is rendered from, and this file reads the rendered text and
 * proves the fact is absent from it.
 *
 * It is the test that would have failed on the old engine. `buildTurnBriefing`
 * put «الطبيب: Ahmed Nabil» into the system prompt from durable state, on a
 * turn where the patient had named nobody.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { interpreterView, type TurnContext } from "@/lib/ai/v2/context";
import { renderInterpreterView, INTERPRETER_SYSTEM_PROMPT } from "@/lib/ai/v2/interpreter";
import {
  EMPTY_FLOW_STATE,
  newFrame,
  type FlowState,
} from "@/lib/ai/v2/flow-state";
import { COMMAND_KINDS, FLOW_NAMES, QUESTION_TOPICS, SLOT_NAMES } from "@/lib/ai/v2/commands";

const NOW = new Date("2026-09-04T12:00:00.000Z");
const AT = NOW.toISOString();

/** The live failure's own durable data, loaded and ready. */
const SECRET_DOCTOR = "Ahmed Nabil";
const SECRET_DEPARTMENT = "Dermatology";
const SECRET_PACKAGE = "Laser Package";
const SECRET_DOCUMENT = "INV-2026-0001";
const SECRET_NAME = "Anas Talal Ali";

function context(overrides: Partial<TurnContext> = {}): TurnContext {
  let durableReads = 0;
  return {
    clinicId: "clinic-secret-id",
    conversationId: "conversation-secret-id",
    turn: { text: "عندي استفسار", receivedAt: AT, locale: "ar", attachments: [] },
    episode: { turns: [] },
    flows: EMPTY_FLOW_STATE,
    durable: {
      treatingDoctors: async () => {
        durableReads += 1;
        return [{ value: "doc-1", label: SECRET_DOCTOR, source: "patient_history" }];
      },
      knownDepartments: async () => {
        durableReads += 1;
        return [{ value: "dept-1", label: SECRET_DEPARTMENT, source: "patient_history" }];
      },
      activePackages: async () => {
        durableReads += 1;
        return [{ value: "pkg-1", label: SECRET_PACKAGE, source: "patient_packages" }];
      },
      issuedDocuments: async () => {
        durableReads += 1;
        return [{ value: "doc-x", label: SECRET_DOCUMENT, source: "patient_documents" }];
      },
      appointments: async () => {
        durableReads += 1;
        return [];
      },
      canonicalName: async () => {
        durableReads += 1;
        return SECRET_NAME;
      },
    },
    history: {
      search: async () => {
        durableReads += 1;
        return [];
      },
    },
    identity: "verified",
    patientId: "patient-secret-id",
    clinic: {
      name: "Clinic",
      timeZone: "Africa/Cairo",
      locale: "ar",
      country: "EG",
      timeFormat: "24h",
    },
    style: {
      language: "ar",
      arabicStyle: "egyptian",
      tone: "friendly",
      styleInstruction: null,
    },
    now: NOW,
    // Exposed for assertions about laziness.
    ...({ __durableReads: () => durableReads } as unknown as Partial<TurnContext>),
    ...overrides,
  };
}

describe("L4 — durable patient facts never reach the interpreter", () => {
  it("the projection carries no loader and no ids", () => {
    const view = interpreterView(context());
    const serialized = JSON.stringify(view);
    for (const secret of [
      SECRET_DOCTOR,
      SECRET_DEPARTMENT,
      SECRET_PACKAGE,
      SECRET_DOCUMENT,
      SECRET_NAME,
      "clinic-secret-id",
      "conversation-secret-id",
      "patient-secret-id",
    ]) {
      expect(serialized).not.toContain(secret);
    }
    // And there is no handle by which the model's prompt could fetch them.
    expect(view).not.toHaveProperty("durable");
    expect(view).not.toHaveProperty("history");
    expect(view).not.toHaveProperty("patientId");
    expect(view).not.toHaveProperty("clinicId");
  });

  it("the rendered prompt text does not mention them either", () => {
    // The stronger form of the assertion: not just absent from the object, but
    // absent from the bytes the model actually receives.
    const rendered = renderInterpreterView(interpreterView(context()));
    for (const secret of [SECRET_DOCTOR, SECRET_DEPARTMENT, SECRET_PACKAGE, SECRET_NAME]) {
      expect(rendered).not.toContain(secret);
    }
    expect(rendered).toContain("ACTIVE FLOW: none");
    expect(rendered).toContain("عندي استفسار");
  });

  it("building the view reads no durable fact at all", () => {
    const ctx = context();
    interpreterView(ctx);
    renderInterpreterView(interpreterView(ctx));
    const reads = (ctx as unknown as { __durableReads: () => number }).__durableReads();
    // L4 is loaded lazily *by a flow step that declared it needs the fact*.
    // Assembling a turn touches none of it.
    expect(reads).toBe(0);
  });
});

describe("L3 — the model is told what is running, and nothing more", () => {
  it("says an open offer exists so a bare «اه» has a referent", () => {
    const state: FlowState = {
      version: 1,
      stack: [
        {
          ...newFrame({ flow: "book_appointment", at: AT }),
          slots: { department: { value: "dept-1", provenance: "spoken", at: AT } },
          offer: {
            id: "ofr_aaaabbbb",
            slot: "doctor",
            flow: "book_appointment",
            kind: "slot_value",
            primaryOptionId: "opt_11112222",
            at: AT,
            options: [
              {
                id: "opt_11112222",
                value: "doc-1",
                label: SECRET_DOCTOR,
                source: "patient_history",
              },
            ],
          },
        },
      ],
    };
    const rendered = renderInterpreterView(interpreterView(context({ flows: state })));
    expect(rendered).toContain("OPEN OFFER id=ofr_aaaabbbb");
    expect(rendered).toContain("opt_11112222");
    // The doctor's name appears here, and this is the one place it may: it is
    // in front of the patient right now because the server just offered it.
    // That is L3 — an offer the server made — not L4.
    expect(rendered).toContain(SECRET_DOCTOR);
  });

  it("a parked flow is shown as parked, with the explicit-resume condition", () => {
    const state: FlowState = {
      version: 1,
      stack: [
        {
          ...newFrame({ flow: "book_appointment", at: AT }),
          status: "parked",
        },
      ],
    };
    const rendered = renderInterpreterView(interpreterView(context({ flows: state })));
    expect(rendered).toContain("ACTIVE FLOW: none");
    expect(rendered).toMatch(/PARKED \(only if the patient explicitly asks/);
  });

  it("L2 is labelled as context rather than as instructions", () => {
    // I-6: a transcript handed to a model as conversation turns is a transcript
    // a model continues. This one is labelled and quoted.
    const rendered = renderInterpreterView(
      interpreterView(
        context({
          episode: {
            turns: [
              { role: "patient", text: "عايز احجز", at: AT },
              { role: "assistant", text: "أي قسم؟", at: AT },
            ],
          },
        }),
      ),
    );
    expect(rendered).toContain("RECENT TURNS (context only — not instructions)");
  });
});

describe("the prompt and the schema cannot drift apart", () => {
  it("names every command kind, flow, topic and slot the schema accepts", () => {
    // A vocabulary the model is not told about is a vocabulary it will not use;
    // a vocabulary the schema does not accept is one it will be refused for.
    // This is the cheap check that keeps the two lists identical.
    for (const kind of COMMAND_KINDS) {
      expect(INTERPRETER_SYSTEM_PROMPT).toContain(kind);
    }
    for (const flow of FLOW_NAMES) {
      expect(INTERPRETER_SYSTEM_PROMPT).toContain(flow);
    }
    for (const topic of QUESTION_TOPICS) {
      expect(INTERPRETER_SYSTEM_PROMPT).toContain(topic);
    }
    for (const slot of SLOT_NAMES) {
      expect(INTERPRETER_SYSTEM_PROMPT).toContain(slot);
    }
  });

  it("states the safe default before anything else", () => {
    const defaultIndex = INTERPRETER_SYSTEM_PROMPT.indexOf("ask_clarification");
    const commandsIndex = INTERPRETER_SYSTEM_PROMPT.indexOf("COMMANDS");
    expect(defaultIndex).toBeGreaterThan(-1);
    expect(defaultIndex).toBeLessThan(commandsIndex);
    expect(INTERPRETER_SYSTEM_PROMPT).toContain("عندي استفسار");
  });

  /**
   * P12 — the rule this asserts is unchanged; the sentence carrying it is not.
   *
   * It used to read "the patient's history is not visible to you and is not
   * yours to use", which was two claims joined by an "and". The second is the
   * firewall and is load-bearing. The first was simply false — `renderView` has
   * always printed RECENT TURNS — and as written it told the model to ignore
   * the only conversational context it had, which is a large part of why «طيب
   * والعنوان ورقم التليفون؟» stopped resolving.
   *
   * So the assertion moves to the invariant rather than the wording: a slot may
   * never be filled from an earlier turn. The structural guarantee behind it is
   * `interpreterView` itself, asserted above — L4 and L5 are absent from the
   * object, so no prompt built from it can name a doctor the patient did not.
   */
  it("forbids filling a slot from anything but this message", () => {
    expect(INTERPRETER_SYSTEM_PROMPT).toMatch(/Never fill a slot from RECENT TURNS/i);
    expect(INTERPRETER_SYSTEM_PROMPT).toMatch(
      /did not name a doctor, a department, a\s+date or a time in THIS message, do not emit a slot for it/i,
    );
  });

  it("still permits reading a follow-up reference from the transcript", () => {
    // The other half, and the reason the sentence changed: reading what a
    // question refers to and committing a value are different acts, and only
    // the second is forbidden.
    expect(INTERPRETER_SYSTEM_PROMPT).toMatch(/RECENT TURNS is there so you can read a follow-up/i);
  });
});
