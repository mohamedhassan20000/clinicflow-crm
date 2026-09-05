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
  searchParams: Promise<{ conversation?: string; q?: string }>;
}) {
  const user = await requireRole(["admin", "receptionist"]);
  const { conversation, q } = await searchParams;
  const data = await loadInboxData(user, conversation, q);

  /*
   * P12 — no `key` here, deliberately.
   *
   * This component used to be keyed on the selected conversation, which meant
   * every click on a name in the left-hand list threw the whole Inbox away and
   * built a new one. React cannot preserve the scroll position of a DOM node it
   * has just destroyed, so the conversation list snapped back to the top on
   * every selection — the further down someone had scrolled to find a thread,
   * the more work the click undid.
   *
   * What the key was buying is per-conversation freshness: a reply draft, a
   * staged attachment or a half-recorded voice note must never survive into a
   * different patient's thread. None of that depended on this key — the
   * composer has always carried its own `key={selected.id}` — and what remains
   * is now guaranteed by a key on the thread `<section>` inside
   * {@link InboxShell}: the same remount, scoped to the pane that is about one
   * conversation, leaving the list pane (which is about all of them) alone.
   */
  return (
    <InboxShell
      data={data}
      clinicId={user.clinicId}
      viewerId={user.id}
      viewerRole={user.role === "admin" ? "admin" : "receptionist"}
    />
  );
}
