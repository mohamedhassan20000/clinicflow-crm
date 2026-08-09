import { describe, expect, it } from "vitest";
import { getTenantShellNavigation, OPERATOR_SHELL_NAVIGATION } from "@/lib/dashboard-navigation";
import {
  getPageSlugFromPath,
  getRolePageSlugs,
  type PageSlug,
} from "@/lib/page-permissions";

describe("dashboard navigation serialization", () => {
  it("transforms authoritative role visibility without adding unauthorized entries", () => {
    const visible = getRolePageSlugs("doctor");
    const navigation = getTenantShellNavigation(visible);

    expect(navigation.map((item) => item.icon)).toEqual(visible);
    expect(navigation.map((item) => item.href)).toContain("/patients");
    expect(navigation.map((item) => item.href)).not.toContain("/revenue");
    expect(navigation.map((item) => item.href)).not.toContain("/settings");
  });

  it("keeps the always-visible dashboard when a customization result omits it", () => {
    const navigation = getTenantShellNavigation(["patients"]);
    expect(navigation.map((item) => item.icon)).toEqual(["dashboard", "patients"]);
  });

  it("preserves PageSlug keys and emits JSON-serializable data only", () => {
    const visible: PageSlug[] = ["dashboard", "reports"];
    const navigation = getTenantShellNavigation(visible);
    expect(JSON.parse(JSON.stringify(navigation))).toEqual(navigation);
    expect(navigation.every((item) => typeof item.icon === "string")).toBe(true);
    expect(JSON.parse(JSON.stringify(OPERATOR_SHELL_NAVIGATION))).toEqual(OPERATOR_SHELL_NAVIGATION);
  });

  it("makes the inbox a default admin/receptionist page without exposing it to doctors or managers", () => {
    expect(getRolePageSlugs("admin")).toContain("inbox");
    expect(getRolePageSlugs("receptionist")).toContain("inbox");
    expect(getRolePageSlugs("doctor")).not.toContain("inbox");
    expect(getRolePageSlugs("manager")).not.toContain("inbox");
    expect(getTenantShellNavigation(getRolePageSlugs("receptionist"))).toContainEqual(
      expect.objectContaining({ href: "/inbox", icon: "inbox", labelKey: "tenant.inbox" }),
    );
  });

  it("registers the assistant for every normal clinic role", () => {
    expect(getRolePageSlugs("admin")).toContain("assistant");
    expect(getRolePageSlugs("doctor")).toContain("assistant");
    expect(getRolePageSlugs("receptionist")).toContain("assistant");
    expect(getRolePageSlugs("manager")).toContain("assistant");
    expect(getTenantShellNavigation(getRolePageSlugs("doctor"))).toContainEqual(
      expect.objectContaining({
        href: "/assistant",
        icon: "assistant",
        labelKey: "tenant.assistant",
      }),
    );
  });

  it("maps contextual document routes to their owning source page", () => {
    expect(getPageSlugFromPath("/documents/roster-profile/patient-list")).toBe("patients");
    expect(getPageSlugFromPath("/documents/roster-profile/patient-file")).toBe("patients");
    expect(getPageSlugFromPath("/documents/roster-profile/system-members")).toBe("settings");
    expect(getPageSlugFromPath("/documents/roster-profile/staff-file")).toBe("settings");
  });

  it("maps the P7-8 Central Document Factory hub, create flow, and detail to the documents slug", () => {
    expect(getPageSlugFromPath("/documents")).toBe("documents");
    expect(getPageSlugFromPath("/documents/new")).toBe("documents");
    expect(getPageSlugFromPath("/documents/new/clinical/prescription")).toBe("documents");
    expect(getPageSlugFromPath("/documents/clinical/prescription")).toBe("documents");
    expect(getPageSlugFromPath("/documents/00000000-0000-0000-0000-000000000000")).toBe(
      "documents",
    );
  });

  it("exposes the documents entry in the tenant shell navigation for every role", () => {
    expect(getRolePageSlugs("doctor")).toContain("documents");
    expect(getTenantShellNavigation(getRolePageSlugs("doctor"))).toContainEqual(
      expect.objectContaining({
        href: "/documents",
        icon: "documents",
        labelKey: "tenant.documents",
      }),
    );
  });
});
