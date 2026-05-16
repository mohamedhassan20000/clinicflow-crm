export type PermissionUserRole = "admin" | "receptionist" | "manager" | "doctor";

export type PageSlug =
  | "dashboard"
  | "patients"
  | "appointments"
  | "followups"
  | "revenue"
  | "reports"
  | "settings";

export type PageDefinition = {
  slug: PageSlug;
  href: string;
  label: string;
  alwaysVisible?: boolean;
};

export const PAGE_DEFINITIONS: PageDefinition[] = [
  { slug: "dashboard", href: "/dashboard", label: "Dashboard", alwaysVisible: true },
  { slug: "patients", href: "/patients", label: "Patients" },
  { slug: "appointments", href: "/appointments", label: "Appointments" },
  { slug: "followups", href: "/followups", label: "Follow-ups" },
  { slug: "revenue", href: "/revenue", label: "Revenue" },
  { slug: "reports", href: "/reports", label: "Reports" },
  { slug: "settings", href: "/settings", label: "Settings" },
];

export const ROLE_PAGE_SLUGS: Record<PermissionUserRole, PageSlug[]> = {
  admin: ["dashboard", "patients", "appointments", "followups", "revenue", "reports", "settings"],
  receptionist: ["dashboard", "patients", "appointments", "followups", "reports"],
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
  if (pathname.startsWith("/followups")) return "followups";
  if (pathname.startsWith("/revenue")) return "revenue";
  if (pathname.startsWith("/reports")) return "reports";
  if (pathname.startsWith("/settings")) return "settings";
  return null;
}
