import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { InboxShell } from "@/components/inbox/inbox-shell";
import { loadInboxData } from "@/lib/messaging/inbox";
import { requireRole } from "@/lib/rbac";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("protected");
  return { title: t("metadataInbox") };
}

export default async function InboxPage({
  searchParams,
}: {
  searchParams: Promise<{ conversation?: string }>;
}) {
  const user = await requireRole(["admin", "receptionist"]);
  const { conversation } = await searchParams;
  const data = await loadInboxData(user, conversation);

  return (
    <InboxShell
      key={data.selectedConversationId ?? "empty"}
      data={data}
      clinicId={user.clinicId}
      viewerId={user.id}
    />
  );
}
