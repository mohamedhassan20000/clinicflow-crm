import { PAGE_DEFINITIONS, type PageSlug } from "@/lib/page-permissions";

export type TenantShellNavItem = {
  href: string;
  /**
   * P2C — a message key under the `nav` namespace, not display copy.
   *
   * Navigation is resolved on the server (authorization lives in `getVisiblePageSlugs`), and the
   * result is serialized into a Client Component. Serializing an English label would have frozen the
   * sidebar in English regardless of the reader's locale — the one surface on every single page.
   * The item carries a key; the Sidebar translates it at render, in the reader's language.
   */
  labelKey: string;
  icon: PageSlug;
};

export type OperatorIconKey =
  | "mission-control"
  | "clinics"
  | "invitations"
  | "reports"
  | "ai-allowance"
  | "coupons"
  | "settings";

export type OperatorShellNavItem = {
  href: string;
  labelKey: string;
  icon: OperatorIconKey;
};

export type ShellNavItem = TenantShellNavItem | OperatorShellNavItem;

/**
 * Converts the already-authoritative visibility result into serializable shell
 * data. Authorization remains in getVisiblePageSlugs/middleware; this helper
 * deliberately performs no role or permission resolution of its own.
 */
export function getTenantShellNavigation(
  visiblePages: readonly PageSlug[],
): TenantShellNavItem[] {
  const visible = new Set(visiblePages);

  return PAGE_DEFINITIONS
    .filter((page) => page.alwaysVisible || visible.has(page.slug))
    .map((page) => ({
      href: page.href,
      labelKey: `tenant.${page.slug}`,
      icon: page.slug,
    }));
}

export const OPERATOR_SHELL_NAVIGATION: readonly OperatorShellNavItem[] = [
  { href: "/operator", labelKey: "operator.missionControl", icon: "mission-control" },
  { href: "/operator/clinics", labelKey: "operator.clinics", icon: "clinics" },
  { href: "/operator/invitations", labelKey: "operator.invitations", icon: "invitations" },
  { href: "/operator/reports", labelKey: "operator.reports", icon: "reports" },
  { href: "/operator/ai-allowance", labelKey: "operator.aiAllowance", icon: "ai-allowance" },
  { href: "/operator/coupons", labelKey: "operator.coupons", icon: "coupons" },
  { href: "/operator/settings", labelKey: "operator.settings", icon: "settings" },
];