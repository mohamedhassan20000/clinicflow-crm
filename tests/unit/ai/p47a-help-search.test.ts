import { describe, expect, it, vi } from "vitest";

// P4.7A — retrieval over the curated help corpus, and the four filters that
// decide which articles a given user may even see.
//
// The two promises under test: (1) an ar/en question reaches the right article,
// and (2) the assistant never describes a surface the caller cannot reach —
// role, entitlement, and per-user permission remove an article without a trace,
// while an admin-hidden page returns the article's location but not its steps or
// link.

type Role = "admin" | "manager" | "receptionist" | "doctor";

const CLINIC = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
function user(role: Role): never {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    clinicId: CLINIC,
    role,
  } as never;
}

const PRO_AI_FEATURES = {
  ai_assistant: true,
  "ai.staff_assistant": true,
  "ai.staff_analytics": true,
  "ai.financial_insights": true,
  whatsapp: true,
};

type LoadOptions = {
  features?: Record<string, boolean>;
  subscriptionAllowed?: boolean;
  financialPermission?: boolean;
  visibility?: Partial<Record<string, "visible" | "hidden" | "lookup_failed">>;
  primaryAdmin?: boolean;
};

async function load(options: LoadOptions = {}) {
  vi.resetModules();
  vi.doMock("server-only", () => ({}));
  vi.doMock("@/lib/entitlements", () => ({
    getEntitlements: vi.fn(async () => ({
      clinicId: CLINIC,
      planSlug: "pro_ai",
      features: options.features ?? PRO_AI_FEATURES,
      limits: {},
      subscriptionAllowed: options.subscriptionAllowed ?? true,
    })),
    hasFeature: (
      ents: { subscriptionAllowed: boolean; features: Record<string, boolean> },
      key: string,
    ) => ents.subscriptionAllowed && ents.features[key] === true,
  }));
  vi.doMock("@/lib/ai/permissions", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@/lib/ai/permissions")>();
    return {
      ...actual,
      hasAiUserPermission: vi.fn(async () => options.financialPermission ?? false),
    };
  });
  vi.doMock("@/lib/server-page-permissions", () => ({
    getPageVisibilityState: vi.fn(
      async (_u: unknown, slug: string) => options.visibility?.[slug] ?? "visible",
    ),
  }));
  vi.doMock("@/lib/primary-admin", () => ({
    isPrimaryClinicAdmin: vi.fn(async () => options.primaryAdmin ?? true),
  }));

  return import("@/lib/ai/help/search");
}

describe("P4.7A help retrieval — finds the right article", () => {
  it("answers an English 'how do I issue an invoice' with the invoicing article", async () => {
    const { searchHelp } = await load();
    const results = await searchHelp(user("receptionist"), {
      query: "how do I issue an invoice",
      locale: "en",
    });
    expect(results[0]?.article_id).toBe("record-payment-and-invoice");
    expect(results[0]?.steps.length).toBeGreaterThan(0);
    expect(results[0]?.link).toBe("/appointments");
  });

  it("answers the same question in Arabic with the Arabic steps", async () => {
    const { searchHelp } = await load();
    const results = await searchHelp(user("receptionist"), {
      query: "كيف أصدر فاتورة للمريض",
      locale: "ar",
    });
    expect(results[0]?.article_id).toBe("record-payment-and-invoice");
    expect(results[0]?.title).toBe("إصدار فاتورة الجلسة وتسجيل الدفع");
    // Arabic body, not an English stub.
    expect(results[0]?.steps.join(" ")).toMatch(/[؀-ۿ]/);
  });

  it("matches an Arabic query against an English-authored keyword via transliteration/cross-field", async () => {
    const { searchHelp } = await load();
    const results = await searchHelp(user("admin"), {
      query: "اين اضبط تذكيرات واتساب",
      locale: "ar",
    });
    expect(results.map((r) => r.article_id)).toContain("configure-reminders");
  });

  it("finds the reminders article from an English query too", async () => {
    const { searchHelp } = await load();
    const results = await searchHelp(user("admin"), {
      query: "where do I configure reminders",
      locale: "en",
    });
    expect(results[0]?.article_id).toBe("configure-reminders");
  });

  it("returns nothing for a question the corpus does not cover", async () => {
    const { searchHelp } = await load();
    const results = await searchHelp(user("admin"), {
      query: "how do I export the database to excel and email it to the ministry",
      locale: "en",
    });
    // No article is about database export; a spurious high-scoring match here is
    // exactly the hallucination surface the phase closes.
    expect(results).toEqual([]);
  });

  it("returns nothing for an empty or too-generic query", async () => {
    const { searchHelp } = await load();
    expect(await searchHelp(user("admin"), { query: "how do I", locale: "en" })).toEqual([]);
  });
});

describe("P4.7A help retrieval — role/entitlement/permission remove articles silently", () => {
  it("never shows a receptionist an admin-only article (control page visibility)", async () => {
    const { searchHelp } = await load();
    const results = await searchHelp(user("receptionist"), {
      query: "hide a page from a staff member",
      locale: "en",
    });
    expect(results.map((r) => r.article_id)).not.toContain("control-page-visibility");
  });

  it("never shows a doctor the revenue article", async () => {
    const { searchHelp } = await load();
    const results = await searchHelp(user("doctor"), {
      query: "how much revenue did we collect this month",
      locale: "en",
    });
    expect(results.map((r) => r.article_id)).not.toContain("review-revenue");
  });

  it("drops the WhatsApp reply article when the clinic lacks the messaging module", async () => {
    const { searchHelp } = await load({
      features: { ...PRO_AI_FEATURES, whatsapp: false },
    });
    const results = await searchHelp(user("receptionist"), {
      query: "reply to a patient on whatsapp",
      locale: "en",
    });
    expect(results.map((r) => r.article_id)).not.toContain("reply-patient-whatsapp");
  });

  it("keeps reminder guidance when WhatsApp is absent, while describing the channel split", async () => {
    const { searchHelp } = await load({
      features: { ...PRO_AI_FEATURES, whatsapp: false },
    });
    const results = await searchHelp(user("manager"), {
      query: "configure appointment reminders and email followups",
      locale: "en",
    });
    const article = results.find((result) => result.article_id === "configure-reminders");
    expect(article?.link).toBe("/settings/messaging");
    expect(article?.notes.join(" ")).toMatch(/available without WhatsApp/i);
  });

  it("hides the financial-assistant article from a manager without the per-user grant", async () => {
    const { searchHelp } = await load({ financialPermission: false });
    const results = await searchHelp(user("manager"), {
      query: "ask the assistant about outstanding balances",
      locale: "en",
    });
    expect(results.map((r) => r.article_id)).not.toContain("ask-assistant-financial");
  });

  it("shows the financial-assistant article once the grant is present", async () => {
    const { searchHelp } = await load({ financialPermission: true });
    const results = await searchHelp(user("manager"), {
      query: "ask the assistant about outstanding balances revenue",
      locale: "en",
    });
    expect(results.map((r) => r.article_id)).toContain("ask-assistant-financial");
  });
});

describe("P4.7A help retrieval — primary-admin workflows are named but not taught", () => {
  it("withholds steps and links from a secondary admin for AI and Customize settings", async () => {
    const { searchHelp } = await load({ primaryAdmin: false });
    for (const query of ["manage assistant settings", "hide a page from staff"]) {
      const results = await searchHelp(user("admin"), { query, locale: "en" });
      const article = results.find((result) =>
        ["manage-ai-settings", "control-page-visibility"].includes(result.article_id),
      );
      expect(article).toBeDefined();
      expect(article?.unavailable_reason).toBe("primary_admin_required");
      expect(article?.steps).toEqual([]);
      expect(article?.link).toBeUndefined();
    }
  });
});

describe("P4.7A help retrieval — admin-hidden page is named but not taught", () => {
  it("returns location without steps or link when the destination page is hidden", async () => {
    const { searchHelp } = await load({ visibility: { settings: "hidden" } });
    const results = await searchHelp(user("admin"), {
      query: "how do I configure reminders",
      locale: "en",
    });
    const article = results.find((r) => r.article_id === "configure-reminders");
    expect(article).toBeDefined();
    // Honest: it exists and lives here...
    expect(article?.section).toBe("Settings → Messaging");
    // ...but it is not presented as something they can do right now.
    expect(article?.steps).toEqual([]);
    expect(article?.link).toBeUndefined();
    expect(article?.unavailable_reason).toBe("hidden_by_admin");
    expect(article?.guidance).toMatch(/administrator/i);
  });

  it("withholds steps and link when the visibility lookup failed", async () => {
    const { searchHelp } = await load({ visibility: { settings: "lookup_failed" } });
    const results = await searchHelp(user("admin"), {
      query: "how do I configure reminders",
      locale: "en",
    });
    const article = results.find((r) => r.article_id === "configure-reminders");
    expect(article?.unavailable_reason).toBe("lookup_failed");
    expect(article?.link).toBeUndefined();
    expect(article?.steps).toEqual([]);
  });
});
