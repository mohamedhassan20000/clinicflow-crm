import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { NotificationsList, type NotificationListItem } from "@/components/notifications/notifications-list";
import { PageHeader } from "@/components/shared/page-header";
import { listOwnNotifications } from "@/lib/notifications/queries";
import { requireUser } from "@/lib/rbac";

export async function generateMetadata(): Promise<Metadata> {
  const metadataT = await getTranslations("protected");
  return { title: metadataT("metadataNotifications") };
}

export default async function NotificationsPage() {
  const t = await getTranslations("notifications");
  await requireUser();
  const notifications = await listOwnNotifications();

  const items: NotificationListItem[] = notifications.map((row) => ({
    id: row.id,
    type: row.type,
    link: row.link,
    data:
      row.data && typeof row.data === "object" && !Array.isArray(row.data)
        ? Object.fromEntries(
            Object.entries(row.data).filter(
              (entry): entry is [string, string] => typeof entry[1] === "string",
            ),
          )
        : {},
    readAt: row.read_at,
    createdAt: row.created_at,
  }));

  return (
    <div className="space-y-6">
      <PageHeader
        back={{ href: "/dashboard", label: "dashboard" }}
        breadcrumbs={[
          { label: t("dashboard"), href: "/dashboard" },
          { label: t("title") },
        ]}
        title={t("title")}
        description={t("description")}
      />
      <NotificationsList notifications={items} />
    </div>
  );
}
