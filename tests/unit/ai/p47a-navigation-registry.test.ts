import { describe, expect, it, vi } from "vitest";

// P4.7A — the navigation registry and its permission-aware resolution.
//
// This is the security core of the sub-phase: the property under test is that
// guidance can never contradict server-side authorization. Every assertion here
// drives the resolver directly against mocked role/entitlement/visibility state
// and checks that a link is handed out only when every applicable gate passes, and that
// the reason for a denial is reported honestly and distinctly.

type Role = "admin" | "manager" | "receptionist" | "doctor";

type MockUser = { id: string; clinicId: string; role: Role };

const CLINIC = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function user(role: Role): MockUser {
  return { id: "11111111-1111-4111-8111-111111111111", clinicId: CLINIC, role };
}

type LoadOptions = {
  features?: Record<string, boolean>;
  subscriptionAllowed?: boolean;
  /** page_slug -> visibility. Any slug absent defaults to "visible". */
  visibility?: Partial<Record<string, "visible" | "hidden" | "lookup_failed">>;
  primaryAdmin?: boolean;
  primaryLookupFails?: boolean;
};

const PRO_AI_FEATURES = {
  ai_assistant: true,
  "ai.staff_assistant": true,
  "ai.staff_analytics": true,
  "ai.financial_insights": true,
  "ai.assistant_customization": true,
  whatsapp: true,
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
  const getPageVisibilityState = vi.fn(
    async (_u: unknown, slug: string) => options.visibility?.[slug] ?? "visible",
  );
  vi.doMock("@/lib/server-page-permissions", () => ({ getPageVisibilityState }));
  const isPrimaryClinicAdmin = options.primaryLookupFails
    ? vi.fn(async () => {
        throw new Error("primary lookup failed");
      })
    : vi.fn(async () => options.primaryAdmin ?? true);
  vi.doMock("@/lib/primary-admin", () => ({ isPrimaryClinicAdmin }));

  const mod = await import("@/lib/ai/help/navigation");
  return { ...mod, getPageVisibilityState, isPrimaryClinicAdmin };
}

describe("P4.7A navigation registry integrity", () => {
  it("every target's pageSlug is a real registered page", async () => {
    const { NAVIGATION_TARGETS, REGISTERED_PAGE_SLUGS } = await load();
    for (const target of NAVIGATION_TARGETS) {
      expect(
        REGISTERED_PAGE_SLUGS.has(target.pageSlug),
        `${target.id} points at unknown page ${target.pageSlug}`,
      ).toBe(true);
    }
  });

  it("every target's roles are a subset of that page's role matrix", async () => {
    const { NAVIGATION_TARGETS } = await load();
    const { getRolePageSlugs } = await import("@/lib/page-permissions");
    for (const target of NAVIGATION_TARGETS) {
      for (const role of target.roles) {
        expect(
          getRolePageSlugs(role).includes(target.pageSlug),
          `${target.id} lists role ${role}, but ${role} cannot see page ${target.pageSlug}`,
        ).toBe(true);
      }
    }
  });

  it("hands out ids and labels in both locales", async () => {
    const { NAVIGATION_TARGETS } = await load();
    for (const target of NAVIGATION_TARGETS) {
      expect(target.labels.en.length).toBeGreaterThan(0);
      expect(target.labels.ar.length).toBeGreaterThan(0);
      expect(target.breadcrumb.en.length).toBeGreaterThan(0);
      expect(target.breadcrumb.ar.length).toBeGreaterThan(0);
    }
  });
});

describe("P4.7A navigation resolution — role gate", () => {
  it("gives an entitled, visible page a working link", async () => {
    const { resolveNavigationTarget } = await load();
    const result = await resolveNavigationTarget(user("admin"), "revenue", "en");
    expect(result.status).toBe("available");
    expect(result.href).toBe("/revenue");
    expect(result.breadcrumb).toBe("Revenue");
  });

  it("denies a page the role cannot reach, and never returns its href", async () => {
    const { resolveNavigationTarget } = await load();
    // Receptionists are redirected away from Revenue.
    const result = await resolveNavigationTarget(user("receptionist"), "revenue", "en");
    expect(result.status).toBe("role_forbidden");
    expect(result.href).toBeUndefined();
    // The section name is still returned so the answer can be specific.
    expect(result.breadcrumb).toBe("Revenue");
  });

  it("denies a doctor the settings surfaces entirely", async () => {
    const { resolveNavigationTarget } = await load();
    for (const id of ["settings_staff", "revenue", "inbox"] as const) {
      const result = await resolveNavigationTarget(user("doctor"), id, "en");
      expect(result.status).toBe("role_forbidden");
      expect(result.href).toBeUndefined();
    }
  });
});

describe("P4.7A navigation resolution — entitlement gate", () => {
  it("keeps Messaging available without WhatsApp because reminders and email remain usable", async () => {
    const { resolveNavigationTarget } = await load({
      features: { ...PRO_AI_FEATURES, whatsapp: false },
    });
    const result = await resolveNavigationTarget(user("admin"), "settings_messaging", "en");
    expect(result.status).toBe("available");
    expect(result.href).toBe("/settings/messaging");
  });

  it("still withholds WhatsApp-only destinations when WhatsApp is absent", async () => {
    const { resolveNavigationTarget } = await load({
      features: { ...PRO_AI_FEATURES, whatsapp: false },
    });
    const result = await resolveNavigationTarget(user("admin"), "inbox", "en");
    expect(result.status).toBe("not_entitled");
    expect(result.href).toBeUndefined();
  });

  it("treats an inactive subscription as not entitled for a gated page", async () => {
    const { resolveNavigationTarget } = await load({ subscriptionAllowed: false });
    const result = await resolveNavigationTarget(user("admin"), "inbox", "en");
    expect(result.status).toBe("not_entitled");
  });

  it("still links a non-gated page when subscription is inactive (only gated pages check it)", async () => {
    const { resolveNavigationTarget } = await load({ subscriptionAllowed: false });
    // patients has no requiredFeatures, so subscription is not consulted here —
    // the surface-level gate lives elsewhere. This asserts the registry does not
    // over-reach into authorization it does not own.
    const result = await resolveNavigationTarget(user("admin"), "patients_list", "en");
    expect(result.status).toBe("available");
  });
});

describe("P4.7A navigation resolution — primary-admin authority", () => {
  it("withholds AI and Customize settings from a secondary admin", async () => {
    const { resolveNavigationTarget } = await load({ primaryAdmin: false });
    for (const id of ["settings_ai", "settings_assistant", "settings_customize"] as const) {
      const result = await resolveNavigationTarget(user("admin"), id, "en");
      expect(result.status).toBe("primary_admin_required");
      expect(result.href).toBeUndefined();
    }
  });

  it("fails closed when primary-admin authority cannot be verified", async () => {
    const { resolveNavigationTarget } = await load({ primaryLookupFails: true });
    const result = await resolveNavigationTarget(user("admin"), "settings_ai", "en");
    expect(result.status).toBe("lookup_failed");
    expect(result.href).toBeUndefined();
  });

  it("shares one primary-admin lookup across a batch of protected targets", async () => {
    const { resolveNavigationTargets, isPrimaryClinicAdmin } = await load();
    const result = await resolveNavigationTargets(
      user("admin"),
      ["settings_ai", "settings_assistant", "settings_customize"],
      "en",
    );
    expect(result.get("settings_ai")?.status).toBe("available");
    expect(result.get("settings_assistant")?.status).toBe("available");
    expect(result.get("settings_customize")?.status).toBe("available");
    expect(isPrimaryClinicAdmin).toHaveBeenCalledTimes(1);
  });
});

describe("P4.7A navigation resolution — page visibility gate (the headline honesty case)", () => {
  it("never presents an admin-hidden page as accessible", async () => {
    const { resolveNavigationTarget } = await load({
      visibility: { revenue: "hidden" },
    });
    const result = await resolveNavigationTarget(user("admin"), "revenue", "en");
    expect(result.status).toBe("hidden_by_admin");
    expect(result.href).toBeUndefined();
    // But the section name survives — "that lives under Revenue, but it isn't
    // enabled for your account" is the honest answer this phase promises.
    expect(result.breadcrumb).toBe("Revenue");
  });

  it("fails closed when the visibility lookup itself could not complete", async () => {
    const { resolveNavigationTarget } = await load({
      visibility: { reports: "lookup_failed" },
    });
    const result = await resolveNavigationTarget(user("manager"), "reports_index", "en");
    expect(result.status).toBe("lookup_failed");
    expect(result.href).toBeUndefined();
  });

  it("an unknown target id resolves to a denial, never a probe result", async () => {
    const { resolveNavigationTarget } = await load();
    const result = await resolveNavigationTarget(
      user("admin"),
      "does_not_exist" as never,
      "en",
    );
    expect(result.status).toBe("role_forbidden");
    expect(result.href).toBeUndefined();
  });
});

describe("P4.7A navigation resolution — localization", () => {
  it("returns Arabic labels and breadcrumbs when asked", async () => {
    const { resolveNavigationTarget } = await load();
    const result = await resolveNavigationTarget(user("admin"), "settings_messaging", "ar");
    expect(result.status).toBe("available");
    expect(result.breadcrumb).toBe("الإعدادات ← المراسلة");
    expect(result.label).toBe("المراسلة");
  });
});

describe("P4.7A batch resolution shares one visibility read per slug", () => {
  it("resolves several settings targets with a single read for the settings slug", async () => {
    const { resolveNavigationTargets, getPageVisibilityState } = await load();
    const map = await resolveNavigationTargets(
      user("admin"),
      ["settings_staff", "settings_services", "settings_departments", "revenue"],
      "en",
    );
    expect(map.get("settings_staff")?.status).toBe("available");
    expect(map.get("revenue")?.status).toBe("available");

    // "settings" resolved once despite three settings targets; "revenue" once
    // and "dashboard" not at all here.
    const slugsRead = getPageVisibilityState.mock.calls.map((call) => call[1]);
    expect(slugsRead.filter((slug) => slug === "settings")).toHaveLength(1);
    expect(slugsRead.filter((slug) => slug === "revenue")).toHaveLength(1);
  });

  it("applies the hidden verdict to every target on that slug", async () => {
    const { resolveNavigationTargets } = await load({
      visibility: { settings: "hidden" },
    });
    const map = await resolveNavigationTargets(
      user("admin"),
      ["settings_staff", "settings_ai"],
      "en",
    );
    expect(map.get("settings_staff")?.status).toBe("hidden_by_admin");
    expect(map.get("settings_ai")?.status).toBe("hidden_by_admin");
  });
});
