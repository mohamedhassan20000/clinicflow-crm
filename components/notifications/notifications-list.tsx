"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
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
};

const GENERIC_MESSAGE_KEYS = {
  title: "type_generic_title",
  body: "type_generic_body",
};

function typeIcon(type: string) {
  if (type === "inbox_message") return MessageCircle;
  if (type === "ai_suggestion") return Sparkles;
  if (type === "reminder_failed" || type === "followup_failed" || type === "ai_escalation") {
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
          return (
            <li
              key={item.id}
              className={cn(
                "flex items-start gap-3 rounded-lg border p-4",
                unread ? "bg-primary/5 border-primary/20" : "bg-card",
              )}
              data-testid="notification-item"
              data-unread={unread || undefined}
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
                  {t(messageKeys.title)}
                  {unread ? (
                    <span
                      className="ms-2 inline-block size-2 rounded-full bg-primary align-middle"
                      aria-label={t("unread")}
                    />
                  ) : null}
                </p>
                <p className="mt-0.5 text-sm text-muted-foreground">
                  {t(messageKeys.body, {
                    patientName: item.data.patientName || t("aPatient"),
                  })}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {format.dateTime(new Date(item.createdAt), {
                    dateStyle: "medium",
                    timeStyle: "short",
                  })}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                {item.link ? (
                  <Button variant="ghost" size="sm" asChild>
                    <Link href={item.link}>{t("open")}</Link>
                  </Button>
                ) : null}
                {unread ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => markRead(item.id)}
                    disabled={busyId === item.id}
                    aria-label={t("markRead")}
                  >
                    <Check className="size-4" aria-hidden />
                    {t("markRead")}
                  </Button>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
