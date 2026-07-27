export type PermissionUserRole =
  | "admin"
  | "receptionist"
  | "manager"
  | "doctor"
  | "assistant";

export const PERMISSION_USER_ROLES: readonly PermissionUserRole[] = [
  "admin",
  "receptionist",
  "manager",
  "doctor",
  "assistant",
];

export type PageSlug =
  | "dashboard"
  | "patients"
  | "appointments"
  | "assistant"
  | "inbox"
  | "followups"
  | "revenue"
  | "reports"
  | "settings";

/**
 * P2C — a page definition is authorization data, and carries no display copy.
 * The label lives in the message catalog (`nav.tenant.<slug>`), never here.
 *
 * Future-proof page catalog: this is the SINGLE registration point for a page.
 * `defaultVisibilityByRole` is role-keyed so a new page (or a new role) only has
 * to be declared here to participate everywhere — navigation, role defaults,
 * Customize, the permissions UI, and Reset to Product Defaults all derive from
 * this catalog. Nothing downstream hardcodes a per-role page list.
 */
export type PageDefinition = {
  slug: PageSlug;
  href: string;
  alwaysVisible?: boolean;
  defaultVisibilityByRole: Record<PermissionUserRole, boolean>;
};

/** Shorthand builder so the catalog stays scannable. */
function visibility(
  roles: Partial<Record<PermissionUserRole, boolean>>,
): Record<PermissionUserRole, boolean> {
  return {
    admin: roles.admin ?? false,
    receptionist: roles.receptionist ?? false,
    manager: roles.manager ?? false,
    doctor: roles.doctor ?? false,
    assistant: roles.assistant ?? false,
  };
}

export const PAGE_CATALOG: readonly PageDefinition[] = [
  {
    slug: "dashboard",
    href: "/dashboard",
    alwaysVisible: true,
    defaultVisibilityByRole: visibility({
      admin: true,
      receptionist: true,
      manager: true,
      doctor: true,
      assistant: true,
    }),
  },
  {
    slug: "patients",
    href: "/patients",
    defaultVisibilityByRole: visibility({
      admin: true,
      receptionist: true,
      doctor: true,
      assistant: true,
    }),
  },
  {
    slug: "appointments",
    href: "/appointments",
    // Manager gains Appointments (P-role-expansion). Authorization unchanged.
    defaultVisibilityByRole: visibility({
      admin: true,
      receptionist: true,
      manager: true,
      doctor: true,
      assistant: true,
    }),
  },
  {
    slug: "assistant",
    href: "/assistant",
    defaultVisibilityByRole: visibility({
      admin: true,
      receptionist: true,
      manager: true,
      doctor: true,
      assistant: true,
    }),
  },
  {
    slug: "inbox",
    href: "/inbox",
    defaultVisibilityByRole: visibility({ admin: true, receptionist: true }),
  },
  {
    slug: "followups",
    href: "/followups",
    // Manager gains Follow-ups (P-role-expansion). Authorization unchanged.
    defaultVisibilityByRole: visibility({
      admin: true,
      receptionist: true,
      manager: true,
      doctor: true,
      assistant: true,
    }),
  },
  {
    slug: "revenue",
    href: "/revenue",
    defaultVisibilityByRole: visibility({ admin: true, manager: true }),
  },
  {
    slug: "reports",
    href: "/reports",
    // Doctor + Assistant gain Reports (scoped to their authorized data).
    defaultVisibilityByRole: visibility({
      admin: true,
      receptionist: true,
      manager: true,
      doctor: true,
      assistant: true,
    }),
  },
  {
    slug: "settings",
    href: "/settings",
    defaultVisibilityByRole: visibility({ admin: true, manager: true }),
  },
];

/**
 * Back-compat alias. `PAGE_DEFINITIONS` remains the flat page list consumers
 * iterate for navigation/labels; it is now a view over {@link PAGE_CATALOG}.
 */
export const PAGE_DEFINITIONS: readonly PageDefinition[] = PAGE_CATALOG;

/** Derived role → default-visible-slugs map (single source: the catalog). */
export const ROLE_PAGE_SLUGS: Record<PermissionUserRole, PageSlug[]> =
  PERMISSION_USER_ROLES.reduce(
    (acc, role) => {
      acc[role] = PAGE_CATALOG.filter(
        (page) => page.defaultVisibilityByRole[role],
      ).map((page) => page.slug);
      return acc;
    },
    {} as Record<PermissionUserRole, PageSlug[]>,
  );

function isPermissionUserRole(
  role: string | null | undefined,
): role is PermissionUserRole {
  return (
    role === "admin" ||
    role === "receptionist" ||
    role === "doctor" ||
    role === "manager" ||
    role === "assistant"
  );
}

export function getRolePageSlugs(role: string | null | undefined): PageSlug[] {
  if (isPermissionUserRole(role)) return ROLE_PAGE_SLUGS[role];
  return ["dashboard"];
}

export function getRolePages(role: string | null | undefined): PageDefinition[] {
  const allowed = new Set(getRolePageSlugs(role));
  return PAGE_CATALOG.filter((page) => allowed.has(page.slug));
}

export function getPageSlugFromPath(pathname: string): PageSlug | null {
  if (pathname === "/" || pathname.startsWith("/dashboard")) return "dashboard";
  if (pathname.startsWith("/patients")) return "patients";
  if (pathname.startsWith("/appointments")) return "appointments";
  if (pathname.startsWith("/assistant")) return "assistant";
  if (pathname.startsWith("/inbox")) return "inbox";
  if (pathname.startsWith("/followups")) return "followups";
  if (pathname.startsWith("/revenue")) return "revenue";
  if (pathname.startsWith("/reports")) return "reports";
  if (pathname.startsWith("/settings")) return "settings";
  return null;
}
