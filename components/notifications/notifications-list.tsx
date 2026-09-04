"use client";

import {
  useRef,
  useState,
  useTransition,
  type ComponentType,
  type MouseEvent as ReactMouseEvent,
} from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AlertTriangle, Bell, CheckCheck, Check, MessageCircle, Sparkles } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { toast } from "sonner";
import {
  markAllNotificationsRead,
  markNotificationRead,
} from "@/actions/notifications";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export type NotificationListItem = {
  id: string;
  type: string;
  link: string | null;
  data: Record<string, string>;
  readAt: string | null;
  createdAt: string;
};

const TYPE_MESSAGE_KEYS: Record<string, { title: string; body: string }> = {
  inbox_message: {
    title: "type_inbox_message_title",
    body: "type_inbox_message_body",
  },
  reminder_failed: {
    title: "type_reminder_failed_title",
    body: "type_reminder_failed_body",
  },
  followup_failed: {
    title: "type_followup_failed_title",
    body: "type_followup_failed_body",
  },
  ai_suggestion: {
    title: "type_ai_suggestion_title",
    body: "type_ai_suggestion_body",
  },
  ai_escalation: {
    title: "type_ai_escalation_title",
    body: "type_ai_escalation_body",
  },
  ai_booking_request: {
    title: "type_ai_booking_request_title",
    body: "type_ai_booking_request_body",
  },
  ai_patient_intake: {
    title: "type_ai_patient_intake_title",
    body: "type_ai_patient_intake_body",
  },
  ai_privileged_change: {
    title: "type_ai_privileged_change_title",
    body: "type_ai_privileged_change_body",
  },
  ai_usage_threshold: {
    title: "type_ai_usage_threshold_title",
    body: "type_ai_usage_threshold_body",
  },
};

const GENERIC_MESSAGE_KEYS = {
  title: "type_generic_title",
  body: "type_generic_body",
};

function typeIcon(type: string) {
  if (type === "inbox_message") return MessageCircle;
  if (
    type === "ai_suggestion" ||
    type === "ai_patient_intake" ||
    type === "ai_booking_request" ||
    type === "ai_privileged_change"
  ) return Sparkles;
  if (
    type === "reminder_failed" ||
    type === "followup_failed" ||
    type === "ai_escalation" ||
    type === "ai_usage_threshold"
  ) {
    return AlertTriangle;
  }
  return Bell;
}

export function NotificationsList({
  notifications,
}: {
  notifications: NotificationListItem[];
}) {
  const t = useTranslations("notifications");
  const format = useFormatter();
  const router = useRouter();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const unreadCount = notifications.filter((item) => !item.readAt).length;

  function markRead(id: string) {
    setBusyId(id);
    startTransition(async () => {
      const result = await markNotificationRead(id);
      setBusyId(null);
      if (result.error) toast.error(result.error);
    });
  }

  /**
   * P10 — opening a notification is what marks it read.
   *
   * Before this, "Open" was a plain link and the only thing that cleared the
   * unread state was the separate "Mark read" button beside it. So the ordinary
   * path — see the badge, click through, deal with the thing — left the
   * notification unread and the badge counting it forever, and staff either
   * learned to press two buttons or learned to ignore the badge.
   *
   * The navigation is not made to wait on the write. `markNotificationRead` is
   * already idempotent (`.is("read_at", null)`) and already scoped to the
   * caller's own rows by recipient and clinic, so the worst case of a failed
   * write is a notification that stays unread — which is exactly today's
   * behaviour — and the best case of not awaiting it is that following a
   * notification never feels slower than following a link.
   *
   * `router.refresh()` afterwards is what updates the bell: the count is
   * server-rendered, and the realtime subscription on the bell also picks the
   * change up, so this is belt and braces on a cheap operation.
   */
  function openNotification(item: NotificationListItem) {
    if (item.readAt) return;
    startTransition(async () => {
      const result = await markNotificationRead(item.id);
      if (result.error) {
        // Deliberately quiet: the staff member is mid-navigation and a toast
        // about bookkeeping on the page they are leaving is noise. The
        // notification simply stays unread, and "Mark read" still works.
        return;
      }
      router.refresh();
    });
  }

  function markAllRead() {
    startTransition(async () => {
      const result = await markAllNotificationsRead();
      if (result.error) toast.error(result.error);
    });
  }

  if (notifications.length === 0) {
    return (
      <div className="rounded-lg border border-dashed p-10 text-center">
        <Bell className="mx-auto size-8 text-muted-foreground" aria-hidden />
        <p className="mt-3 text-sm text-muted-foreground">{t("empty")}</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          {t("unreadSummary", { count: String(unreadCount) })}
        </p>
        <Button
          variant="outline"
          size="sm"
          onClick={markAllRead}
          disabled={pending || unreadCount === 0}
        >
          <CheckCheck className="size-4" aria-hidden />
          {t("markAllRead")}
        </Button>
      </div>

      <ul className="space-y-2">
        {notifications.map((item) => {
          const Icon = typeIcon(item.type);
          const unread = !item.readAt;
          const messageKeys = TYPE_MESSAGE_KEYS[item.type] ?? GENERIC_MESSAGE_KEYS;
          // One value bag for both title and body: the AI-usage notice varies its
          // *title* by threshold too, which a param-less title call cannot do.
          const messageValues = {
            patientName: item.data.patientName || t("aPatient"),
            actorName: item.data.actorName || t("unknownActor"),
            targetName: item.data.targetName || t("unknownTarget"),
            threshold: item.data.threshold || "warning",
            percent: item.data.percent || "0",
            resetDate: item.data.resetDate || "",
            byokConfigured: item.data.byokConfigured || "false",
          };
          return (
            <NotificationRow
              key={item.id}
              item={item}
              Icon={Icon}
              unread={unread}
              title={t(messageKeys.title, messageValues)}
              body={t(messageKeys.body, messageValues)}
              timestamp={format.dateTime(new Date(item.createdAt), {
                dateStyle: "medium",
                timeStyle: "short",
              })}
              unreadLabel={t("unread")}
              openLabel={t("open")}
              markReadLabel={t("markRead")}
              busy={busyId === item.id}
              onOpen={() => openNotification(item)}
              onMarkRead={() => markRead(item.id)}
            />
          );
        })}
      </ul>
    </div>
  );
}

/**
 * One notification, as one thing you can click.
 *
 * ### Why the card is the target and not just the "Open" button
 *
 * A notification card is entirely about one destination — the thread, the
 * intake, the failed reminder. Everything on it (the icon, the sentence, the
 * time) describes that one place, and the only way to get there was a 44px word
 * in the far corner. People clicked the sentence, nothing happened, and they
 * clicked it again. So the rectangle is the hit area now.
 *
 * ### Why this is still exactly one link
 *
 * The obvious implementation — `onClick` on the `<li>` plus the existing
 * `<a>` inside it — is two interactive elements nested inside each other: two
 * stops in the tab order for one destination, two things announced to a screen
 * reader, and a click on the inner one firing both handlers. Instead the
 * anchor stays the *only* interactive element and grows to the card's size
 * through a `before:absolute before:inset-0` overlay, which is what gives the
 * whole rectangle its pointer cursor and its hit area in a real browser.
 *
 * `onCardClick` then exists for the clicks the overlay cannot receive — and,
 * usefully, for jsdom, which has no layout and so has no overlay at all. It
 * forwards to the same anchor rather than navigating itself, so there is one
 * navigation path, once, however the card was clicked. Clicks that started on
 * a control of their own (Mark read) are left alone: that button owns them.
 *
 * ### Keyboard
 *
 * Focus lands on the anchor, and the ring is drawn around the whole card via
 * `has-[...]:` on the container, so what looks focused is what will open.
 * Enter is the anchor's own behaviour. Space is not — browsers scroll instead —
 * so it is handled explicitly, which is what the card being a "card" leads
 * people to expect.
 */
function NotificationRow({
  item,
  Icon,
  unread,
  title,
  body,
  timestamp,
  unreadLabel,
  openLabel,
  markReadLabel,
  busy,
  onOpen,
  onMarkRead,
}: {
  item: NotificationListItem;
  Icon: ComponentType<{ className?: string }>;
  unread: boolean;
  title: string;
  body: string;
  timestamp: string;
  unreadLabel: string;
  openLabel: string;
  markReadLabel: string;
  busy: boolean;
  onOpen: () => void;
  onMarkRead: () => void;
}) {
  const linkRef = useRef<HTMLAnchorElement | null>(null);
  const interactive = Boolean(item.link);

  function onCardClick(event: ReactMouseEvent<HTMLLIElement>) {
    if (!interactive) return;
    const target = event.target as HTMLElement | null;
    // A click that began on a control of its own — Mark read, or the anchor
    // itself — is that control's to handle. Forwarding it too would run the
    // open twice.
    if (target?.closest("a,button")) return;
    linkRef.current?.click();
  }

  return (
    <li
      className={cn(
        "relative flex items-start gap-3 rounded-lg border p-4 transition-colors",
        unread ? "bg-primary/5 border-primary/20" : "bg-card",
        interactive &&
          "cursor-pointer hover:border-primary/40 hover:bg-primary/10 has-[a:focus-visible]:outline-2 has-[a:focus-visible]:outline-offset-2 has-[a:focus-visible]:outline-ring",
      )}
      data-testid="notification-item"
      data-unread={unread || undefined}
      data-interactive={interactive || undefined}
      onClick={onCardClick}
    >
      <span
        className={cn(
          "mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg",
          item.type === "inbox_message"
            ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
            : "bg-amber-500/10 text-amber-700 dark:text-amber-400",
        )}
      >
        <Icon className="size-4" aria-hidden />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">
          {title}
          {unread ? (
            <span
              className="ms-2 inline-block size-2 rounded-full bg-primary align-middle"
              aria-label={unreadLabel}
            />
          ) : null}
        </p>
        <p className="mt-0.5 text-sm text-muted-foreground">{body}</p>
        <p className="mt-1 text-xs text-muted-foreground">{timestamp}</p>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {item.link ? (
          <Button
            variant="ghost"
            size="sm"
            asChild
            /*
             * The stretched link. The anchor is deliberately *not* positioned,
             * so its `::after` resolves against the nearest positioned
             * ancestor — the card — and covers it edge to edge. That overlay is
             * part of the anchor, which is what makes the whole rectangle
             * clickable with the pointer cursor and no second element in the
             * accessibility tree.
             */
            className="after:absolute after:inset-0 after:content-['']"
          >
            <Link
              ref={linkRef}
              href={item.link}
              data-testid="notification-open"
              onClick={onOpen}
              onKeyDown={(event) => {
                // Enter is the anchor's own. Space is not, and a card that
                // looks pressable should answer it.
                if (event.key !== " " && event.key !== "Spacebar") return;
                event.preventDefault();
                event.currentTarget.click();
              }}
            >
              {openLabel}
            </Link>
          </Button>
        ) : null}
        {unread ? (
          <Button
            variant="ghost"
            size="sm"
            // Above the stretched link's overlay, or the overlay would swallow
            // this button's clicks and every "Mark read" would open instead.
            className="relative z-10"
            onClick={onMarkRead}
            disabled={busy}
            aria-label={markReadLabel}
          >
            <Check className="size-4" aria-hidden />
            {markReadLabel}
          </Button>
        ) : null}
      </div>
    </li>
  );
}
