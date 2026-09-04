import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { getAuditLog, getAuditLogActors } from "@/actions/audit-log";
import { AuditLogView } from "@/components/settings/audit-log/audit-log-view";
import { requireRole } from "@/lib/rbac";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("auditLog");
  return { title: t("title") };
}

/**
 * P18 — the administrative audit trail, for the roles that administer the
 * clinic.
 *
 * Authorization is the settings section's own: `/settings` is already
 * admin-and-manager, and the database policies decide what each of them
 * actually reads (AI configuration stays with the admins who can open the AI
 * screen). Nothing is re-derived here, so the page cannot drift from the
 * boundary that enforces it.
 */
export default async function AuditLogPage() {
  const t = await getTranslations("auditLog");
  const user = await requireRole(["admin", "manager"]);

  const [page, actors] = await Promise.all([getAuditLog(), getAuditLogActors()]);

  return (
    <div className="space-y-5">
      <div>
        <h2 className="font-semibold">{t("title")}</h2>
        <p className="text-sm text-muted-foreground">{t("description")}</p>
      </div>

      <AuditLogView
        initialEvents={page.events}
        initialCursor={page.nextCursor}
        actors={actors}
        canReadAi={user.role === "admin"}
      />
    </div>
  );
}
