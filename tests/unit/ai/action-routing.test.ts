import { describe, expect, it, vi } from "vitest";
import { createServerActionMocks } from "../helpers/server-action-mocks";

/**
 * Action-routing regression lock — `docs/reports/AI_ASSISTANT_ACTION_ROUTING_REVIEW.md`.
 *
 * An authorized, entitled booking request lost the entire registered write
 * surface when it was phrased as a question: `isHelpIntent` classified any
 * instructional opener as `staff_help`, and `staff_help` is the one task class
 * narrow enough to unmount `execute_action` and `describe_action`. The assistant
 * then answered a fully-specified booking with a navigation link.
 *
 * These tests pin both halves of the fix — the router's write-intent guard and
 * the mount's reachability invariants — and, just as importantly, pin the
 * containment property the guard must not over-correct away.
 */

type Role = "admin" | "manager" | "receptionist" | "doctor" | "assistant";

const ADMINISTRATIVE_ROLES: readonly Role[] = ["admin", "manager", "receptionist"];
const CLINICAL_ROLES: readonly Role[] = ["doctor", "assistant"];
const ALL_ROLES: readonly Role[] = [...ADMINISTRATIVE_ROLES, ...CLINICAL_ROLES];

async function router() {
  vi.resetModules();
  vi.doMock("server-only", () => ({}));
  return import("@/lib/ai/platform/execution");
}

/**
 * The class an actionable write must land on for each role: whichever one mounts
 * `execute_action` for that persona. Asserted by name rather than by "not
 * staff_help" where the review names a specific destination (§9.1.5).
 */
function actionClassFor(role: Role): string {
  return CLINICAL_ROLES.includes(role) ? "staff_clinical_summary" : "staff_administrative";
}

// ---------------------------------------------------------------------------
// 1 — table-driven write-intent override (review §4.1 and §6, verbatim)
// ---------------------------------------------------------------------------

const INSTRUCTIONAL_BOOKINGS: readonly string[] = [
  "How do I book an appointment for Ahmed Ali with Dr. Sara on Sunday at 10:00?",
  "How can I schedule Ahmed Ali with Dr. Sara on Sunday at 10:00?",
  "Where do I book Ahmed Ali with Dr. Sara for Sunday 10:00?",
  "Show me how to book Ahmed Ali with Dr. Sara on Sunday at 10am",
  "How do I book Ahmed with Dr. Sara Sunday at 10?",
  "Walk me through booking Ahmed Ali with Dr. Sara on 2026-08-20",
];

const IMPERATIVE_BOOKINGS: readonly string[] = [
  "Book an appointment for Ahmed Ali with Dr. Sara on Sunday at 10:00",
  "Please book Ahmed Ali with Dr. Sara tomorrow at 10:00",
  "Can you book Ahmed Ali an appointment with Dr. Sara on 2026-08-20 at 10:00?",
];

const INSTRUCTIONAL_OTHER_WRITES: readonly string[] = [
  "How do I issue an invoice for Ahmed Ali?",
  "How do I record a follow-up outcome for Ahmed Ali?",
  "How do I cancel Ahmed Ali's appointment tomorrow?",
  "Where do I mark Ahmed Ali as arrived?",
  "Walk me through issuing a sick leave for Ahmed Ali",
  "How do I update Ahmed Ali's phone number?",
];

describe("1 — an instructionally-phrased write with concrete operands leaves staff_help", () => {
  it.each(INSTRUCTIONAL_BOOKINGS)(
    "routes to an action-capable class for every administrative role: %s",
    async (messageText) => {
      const { staffTaskForRole } = await router();
      for (const role of ADMINISTRATIVE_ROLES) {
        const { task } = staffTaskForRole(role, { analyticsEntitled: true, messageText });
        expect(task, `${role}: ${messageText}`).not.toBe("staff_help");
        expect(task, `${role}: ${messageText}`).toBe("staff_administrative");
      }
    },
  );

  it.each(IMPERATIVE_BOOKINGS)(
    "leaves the already-working imperative phrasing unchanged: %s",
    async (messageText) => {
      const { staffTaskForRole } = await router();
      expect(
        staffTaskForRole("receptionist", { analyticsEntitled: true, messageText }).task,
      ).toBe("staff_administrative");
    },
  );

  // §6: the defect is action-agnostic, so the fix must be too. The whole write
  // surface — billing, follow-ups, appointment status, patients, documents — is
  // carried by the same two tools and was lost in the same turns.
  it.each(INSTRUCTIONAL_OTHER_WRITES)(
    "covers the wider write surface, not just appointments: %s",
    async (messageText) => {
      const { staffTaskForRole } = await router();
      expect(
        staffTaskForRole("receptionist", { analyticsEntitled: true, messageText }).task,
      ).toBe("staff_administrative");
    },
  );

  it("does not fall through to the tighter operational class on a domain noun", async () => {
    const { staffTaskForRole } = await router();
    // "invoice" matches isOperationalQueryIntent; a preview → confirm → execute
    // turn must not inherit the budget sized for a typed aggregate.
    expect(
      staffTaskForRole("admin", {
        analyticsEntitled: true,
        messageText: "How do I issue an invoice for Ahmed Ali?",
      }).task,
    ).toBe("staff_administrative");
  });
});

// ---------------------------------------------------------------------------
// 2 — help containment preserved (the fix must not over-correct)
// ---------------------------------------------------------------------------

const GENUINE_HELP: readonly string[] = [
  "How do I book an appointment?",
  "How do I issue an invoice?",
  "Where is the appointments page?",
  "Where do I find the Invoices page?",
  "Walk me through issuing a sick leave",
  "How do I use the assistant",
  "Show me how to cancel an appointment",
  "How does the reminder setting work?",
];

describe("2 — operand-free instructional questions stay on the cheap staff_help class", () => {
  it.each(GENUINE_HELP)("stays staff_help: %s", async (messageText) => {
    const { staffTaskForRole } = await router();
    for (const role of ALL_ROLES) {
      expect(
        staffTaskForRole(role, { analyticsEntitled: true, messageText }).task,
        `${role}: ${messageText}`,
      ).toBe("staff_help");
    }
  });

  it("stays staff_help even when the conversation has a live entity context", async () => {
    const { staffTaskForRole } = await router();
    // A resolved patient must not turn every later documentation question into
    // an expensive turn: the active context is an operand only when the turn
    // actually refers to it.
    expect(
      staffTaskForRole("receptionist", {
        analyticsEntitled: true,
        messageText: "How do I book an appointment?",
        hasActiveEntityContext: true,
      }).task,
    ).toBe("staff_help");
  });
});

// ---------------------------------------------------------------------------
// 3 — both signals are required (guard must not degenerate into a verb match)
// ---------------------------------------------------------------------------

describe("3 — the override requires a write verb AND a concrete operand", () => {
  it("a write verb without an operand stays staff_help", async () => {
    const { staffTaskForRole, hasWriteIntentVerb, hasConcreteOperand } = await router();
    const messageText = "How do I cancel an appointment?";
    expect(hasWriteIntentVerb(messageText)).toBe(true);
    expect(hasConcreteOperand(messageText)).toBe(false);
    expect(
      staffTaskForRole("receptionist", { analyticsEntitled: true, messageText }).task,
    ).toBe("staff_help");
  });

  it("an operand without a write verb stays staff_help", async () => {
    const { staffTaskForRole, hasWriteIntentVerb, hasConcreteOperand } = await router();
    const messageText = "Where do I find Ahmed Ali's file?";
    expect(hasWriteIntentVerb(messageText)).toBe(false);
    expect(hasConcreteOperand(messageText)).toBe(true);
    expect(
      staffTaskForRole("receptionist", { analyticsEntitled: true, messageText }).task,
    ).toBe("staff_help");
  });

  it("an aggregation question keeps its data tools and never becomes a write turn", async () => {
    const { staffTaskForRole } = await router();
    expect(
      staffTaskForRole("admin", {
        analyticsEntitled: true,
        messageText: "How many invoices did we issue for Ahmed Ali on Sunday?",
      }).task,
    ).toBe("staff_operational_query");
  });

  it("does not mistake a capitalized product noun for a named person", async () => {
    const { hasConcreteOperand } = await router();
    expect(hasConcreteOperand("How do I book an appointment on the Appointments page?")).toBe(
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// 4 — bilingual parity
// ---------------------------------------------------------------------------

const ARABIC_ACTIONABLE: readonly string[] = [
  "كيف أحجز موعدًا لأحمد مع د. سارة؟",
  "كيف أحجز موعدًا لأحمد علي مع د. سارة يوم الأحد الساعة 10؟",
  "أين أسجل وصول المريض أحمد علي؟",
  "كيف ألغي موعد المريض أحمد غدًا؟",
  "كيف أصدر فاتورة للمريض أحمد علي؟",
];

const ARABIC_HELP: readonly string[] = [
  "كيف أصدر فاتورة؟",
  "كيف أحجز موعدًا؟",
  "أين أجد إعدادات التذكيرات؟",
  "كيف أستخدم المساعد؟",
];

describe("4 — Arabic behaves identically to English at every point", () => {
  it.each(ARABIC_ACTIONABLE)("overrides an Arabic actionable write: %s", async (messageText) => {
    const { staffTaskForRole } = await router();
    expect(
      staffTaskForRole("receptionist", { analyticsEntitled: true, messageText }).task,
    ).toBe("staff_administrative");
  });

  it.each(ARABIC_HELP)("keeps a genuine Arabic help question on staff_help: %s", async (
    messageText,
  ) => {
    const { staffTaskForRole } = await router();
    expect(
      staffTaskForRole("receptionist", { analyticsEntitled: true, messageText }).task,
    ).toBe("staff_help");
  });

  it("does not match an Arabic write stem inside an unrelated word", async () => {
    const { hasWriteIntentVerb } = await router();
    // "معدل" (average) contains the stem "عدل" (amend); "الإعدادات" contains
    // neither, but both are the kind of collision an unbounded stem match makes.
    expect(hasWriteIntentVerb("ما هو معدل الحضور؟")).toBe(false);
    expect(hasWriteIntentVerb("أين أجد الإعدادات؟")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 5 — role coverage
// ---------------------------------------------------------------------------

describe("5 — every staff role reaches an action-capable class", () => {
  it.each(ALL_ROLES)("role %s", async (role) => {
    const { staffTaskForRole } = await router();
    const { task, persona } = staffTaskForRole(role, {
      analyticsEntitled: true,
      messageText: "How do I book Ahmed Ali with Dr. Sara on Sunday at 10:00?",
    });
    expect(task).toBe(actionClassFor(role));
    expect(persona).toBe(CLINICAL_ROLES.includes(role) ? "doctor" : "administrative_staff");
  });

  it("routes a doctor's instructional prescription request to the clinical class", async () => {
    const { staffTaskForRole } = await router();
    expect(
      staffTaskForRole("doctor", {
        analyticsEntitled: true,
        messageText: "How do I write a prescription for Ahmed Ali?",
      }).task,
    ).toBe("staff_clinical_summary");
  });

  it("keeps the doctor's operand-free version on staff_help", async () => {
    const { staffTaskForRole } = await router();
    expect(
      staffTaskForRole("doctor", {
        analyticsEntitled: true,
        messageText: "How do I write a prescription?",
      }).task,
    ).toBe("staff_help");
  });
});

// ---------------------------------------------------------------------------
// 6 — composite interaction
// ---------------------------------------------------------------------------

describe("6 — a turn matching both help and composite phrasing resolves to staff_composite", () => {
  it("English", async () => {
    const { staffTaskForRole, isHelpIntent, isCompositeIntent } = await router();
    const messageText =
      "How do I check availability for Dr. Sara on Sunday and then book Ahmed Ali at 10:00?";
    expect(isHelpIntent(messageText)).toBe(true);
    expect(isCompositeIntent(messageText)).toBe(true);
    expect(
      staffTaskForRole("receptionist", { analyticsEntitled: true, messageText }).task,
    ).toBe("staff_composite");
  });

  it("does not steal a genuine, operand-free help turn from staff_help", async () => {
    const { staffTaskForRole } = await router();
    // Composite phrasing alone must not defeat help containment: without the
    // operand this is still a documentation question.
    expect(
      staffTaskForRole("receptionist", {
        analyticsEntitled: true,
        messageText: "How do I check availability and then book an appointment?",
      }).task,
    ).toBe("staff_help");
  });
});

// ---------------------------------------------------------------------------
// Multi-turn: the reported transcript (review §4.2, turn 3)
// ---------------------------------------------------------------------------

describe("multi-turn — a pronoun resolving against a live entity context is an operand", () => {
  it.each([
    "How do I book him for that slot?",
    "Where do I book her for that appointment?",
    "كيف أحجز له موعدًا؟",
    "كيف أحجزه؟",
  ])("turn 3 leaves staff_help when the context is live: %s", async (messageText) => {
    const { staffTaskForRole } = await router();
    expect(
      staffTaskForRole("receptionist", {
        analyticsEntitled: true,
        messageText,
        hasActiveEntityContext: true,
      }).task,
    ).toBe("staff_administrative");
  });

  it("the identical turn without a live context stays staff_help", async () => {
    const { staffTaskForRole } = await router();
    expect(
      staffTaskForRole("receptionist", {
        analyticsEntitled: true,
        messageText: "How do I book him for that slot?",
        hasActiveEntityContext: false,
      }).task,
    ).toBe("staff_help");
  });
});

// ---------------------------------------------------------------------------
// Mount invariants (review §9.2)
// ---------------------------------------------------------------------------

const CLINIC = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PRO_AI_FEATURES = {
  ai_assistant: true,
  "ai.read_clinical": true,
  "ai.read_operational": true,
  "ai.staff_assistant": true,
  "ai.staff_analytics": true,
  "ai.financial_insights": true,
  "ai.documents": true,
  "ai.write_scheduling": true,
  whatsapp: true,
};

async function mountFor(role: Role, taskClass?: string) {
  vi.resetModules();
  const mocks = createServerActionMocks();
  vi.doMock("server-only", () => ({}));
  vi.doMock("@sentry/nextjs", () => ({
    captureException: vi.fn(),
    captureMessage: vi.fn(),
  }));
  vi.doMock("@/lib/supabase/server", () => ({
    createClient: vi.fn(async () => mocks.client()),
  }));
  vi.doMock("@/lib/supabase/admin", () => ({
    logAgentToolCall: vi.fn(async () => ({ data: "audit-1", error: null })),
  }));
  vi.doMock("@/lib/entitlements", () => ({
    getEntitlements: vi.fn(async () => ({
      clinicId: CLINIC,
      planSlug: "pro_ai",
      features: PRO_AI_FEATURES,
      limits: {},
      subscriptionAllowed: true,
    })),
    hasFeature: (
      ents: { subscriptionAllowed: boolean; features: Record<string, boolean> },
      key: string,
    ) => ents.subscriptionAllowed && ents.features[key] === true,
  }));
  vi.doMock("@/lib/server-page-permissions", () => ({
    getPageVisibilityState: vi.fn(async () => "visible"),
  }));
  vi.doMock("@/lib/primary-admin", () => ({
    isPrimaryClinicAdmin: vi.fn(async () => true),
  }));
  vi.doMock("@/lib/ai/permissions", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@/lib/ai/permissions")>();
    return { ...actual, hasAiUserPermission: vi.fn(async () => false) };
  });

  const { resolveToolMount, STAFF_TASK_CLASSES_BY_ROLE } = await import("@/lib/ai/tools");
  const { ACTION_CAPABLE_ROLES } = await import("@/lib/ai/tools/registry");
  const mount = await resolveToolMount({
    user: { id: "11111111-1111-4111-8111-111111111111", clinicId: CLINIC, role } as never,
    locale: "en",
    taskClass: taskClass as never,
  });
  return {
    names: mount.definitions.map((definition) => definition.name),
    classes: STAFF_TASK_CLASSES_BY_ROLE[role] as readonly string[],
    actionCapableRoles: ACTION_CAPABLE_ROLES as readonly string[],
  };
}

describe("7 — the action tools are reachable in every non-help class", () => {
  it.each(ALL_ROLES)("role %s", async (role) => {
    const { classes, actionCapableRoles } = await mountFor(role);
    expect(actionCapableRoles).toContain(role);
    for (const taskClass of classes) {
      if (taskClass === "staff_help") continue;
      const { names } = await mountFor(role, taskClass);
      expect(names, `${role} / ${taskClass}`).toContain("execute_action");
      expect(names, `${role} / ${taskClass}`).toContain("describe_action");
    }
  });
});

describe("8 — the staff_composite mount invariant (review §6.1)", () => {
  it.each(ALL_ROLES)("staff_composite mounts a non-empty tool set including execute_action for %s", async (
    role,
  ) => {
    const { names } = await mountFor(role, "staff_composite");
    // No tool in AI_TOOL_REGISTRY declares `staff_composite`. The mount is
    // non-empty only because the candidate filter is deliberately permissive for
    // every non-help class. If someone "tightens" that gate to a strict
    // declaration check, composite turns would silently mount zero tools — this
    // assertion is what makes that fail loudly instead.
    expect(names.length).toBeGreaterThan(0);
    expect(names).toContain("execute_action");
    expect(names).toContain("describe_action");
  });

  it("confirms no tool actually declares staff_composite (the reason the gate stays permissive)", async () => {
    vi.resetModules();
    vi.doMock("server-only", () => ({}));
    const { AI_TOOL_REGISTRY } = await import("@/lib/ai/tools/registry");
    expect(
      AI_TOOL_REGISTRY.filter((definition) =>
        (definition.taskClasses as readonly string[]).includes("staff_composite"),
      ),
    ).toEqual([]);
  });
});

describe("9 — staff_help containment is unchanged apart from the metadata backstop", () => {
  it("mounts only data-free tools, now including describe_action", async () => {
    const { names } = await mountFor("admin", "staff_help");
    expect(names.sort()).toEqual([
      "describe_action",
      "describe_capabilities",
      "get_navigation_target",
      "list_my_capabilities",
      "search_help",
    ]);
  });

  it("still does not mount execute_action or any clinic-data tool on a help turn", async () => {
    for (const role of ALL_ROLES) {
      const { names } = await mountFor(role, "staff_help");
      expect(names, role).not.toContain("execute_action");
      for (const dataTool of [
        "query_resource",
        "get_record",
        "aggregate_resource",
        "search_authorized_patients",
        "check_availability",
        "get_clinic_summary",
        "get_revenue_summary",
        "list_outstanding_invoices",
        "run_clinic_report",
        "preview_document",
      ]) {
        expect(names, `${role} / ${dataTool}`).not.toContain(dataTool);
      }
    }
  });
});
