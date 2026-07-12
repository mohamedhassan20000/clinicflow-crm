import { PAGE_DEFINITIONS, type PageSlug } from "@/lib/page-permissions";

export type TenantShellNavItem = {
  href: string;
  label: string;
  icon: PageSlug;
};

export type OperatorIconKey =
  | "mission-control"
  | "clinics"
  | "invitations"
  | "reports"
  | "coupons"
  | "settings";

export type OperatorShellNavItem = {
  href: string;
  label: string;
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
      label: page.label,
      icon: page.slug,
    }));
}

export const OPERATOR_SHELL_NAVIGATION: readonly OperatorShellNavItem[] = [
  { href: "/operator", label: "Mission Control", icon: "mission-control" },
  { href: "/operator/clinics", label: "Clinics", icon: "clinics" },
  { href: "/operator/invitations", label: "Invitations", icon: "invitations" },
  { href: "/operator/reports", label: "Reports", icon: "reports" },
  { href: "/operator/coupons", label: "Coupons", icon: "coupons" },
  { href: "/operator/settings", label: "Settings", icon: "settings" },
];
