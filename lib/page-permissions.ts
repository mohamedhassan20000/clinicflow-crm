export type PermissionUserRole = "admin" | "receptionist" | "manager" | "doctor";

export type PageSlug =
  | "dashboard"
  | "patients"
  | "appointments"
  | "inbox"
  | "followups"
  | "revenue"
  | "reports"
  | "settings";

/**
 * P2C — a page definition is authorization data, and carries no display copy.
 *
 * The label lived here until P2C and was the reason the sidebar could not be translated: it was
 * resolved on the server and serialized into the client as a finished English string. Every consumer
 * now translates `nav.tenant.<slug>` from the message catalog instead, so the page's name and the
 * page's permissions are no longer the same object's problem.
 */
export type PageDefinition = {
  slug: PageSlug;
  href: string;
  alwaysVisible?: boolean;
};

export const PAGE_DEFINITIONS: PageDefinition[] = [
  { slug: "dashboard", href: "/dashboard", alwaysVisible: true },
  { slug: "patients", href: "/patients" },
  { slug: "appointments", href: "/appointments" },
  { slug: "inbox", href: "/inbox" },
  { slug: "followups", href: "/followups" },
  { slug: "revenue", href: "/revenue" },
  { slug: "reports", href: "/reports" },
  { slug: "settings", href: "/settings" },
];

export const ROLE_PAGE_SLUGS: Record<PermissionUserRole, PageSlug[]> = {
  admin: ["dashboard", "patients", "appointments", "inbox", "followups", "revenue", "reports", "settings"],
  receptionist: ["dashboard", "patients", "appointments", "inbox", "followups", "reports"],
  doctor: ["dashboard", "patients", "appointments", "followups"],
  manager: ["dashboard", "revenue", "reports", "settings"],
};

export function getRolePageSlugs(role: string | null | undefined): PageSlug[] {
  if (role === "admin" || role === "receptionist" || role === "doctor" || role === "manager") {
    return ROLE_PAGE_SLUGS[role];
  }
  return ["dashboard"];
}

export function getRolePages(role: string | null | undefined): PageDefinition[] {
  const allowed = new Set(getRolePageSlugs(role));
  return PAGE_DEFINITIONS.filter((page) => allowed.has(page.slug));
}

export function getPageSlugFromPath(pathname: string): PageSlug | null {
  if (pathname === "/" || pathname.startsWith("/dashboard")) return "dashboard";
  if (pathname.startsWith("/patients")) return "patients";
  if (pathname.startsWith("/appointments")) return "appointments";
  if (pathname.startsWith("/inbox")) return "inbox";
  if (pathname.startsWith("/followups")) return "followups";
  if (pathname.startsWith("/revenue")) return "revenue";
  if (pathname.startsWith("/reports")) return "reports";
  if (pathname.startsWith("/settings")) return "settings";
  return null;
}
