"use client";

import { useEffect, useRef } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Bell } from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { createClient } from "@/lib/supabase/client";

type Props = {
  unreadCount: number;
};

/**
 * Header notification bell (§7.5 + approved P3D UX): unread badge, navigates
 * to the dedicated /notifications page. The count is server-rendered; a
 * Postgres Changes subscription on the recipient-scoped notifications table
 * refreshes it live (the P3C inbox realtime pattern).
 */
export function NotificationBell({ unreadCount }: Props) {
  const t = useTranslations("notifications");
  const router = useRouter();
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const supabase = createClient();
    let disposed = false;
    const refresh = () => {
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
      refreshTimer.current = setTimeout(() => router.refresh(), 250);
    };
    const channel = supabase.channel("clinic-notifications");
    async function subscribe() {
      const { data: { session } } = await supabase.auth.getSession();
      if (disposed) return;
      if (session?.access_token) await supabase.realtime.setAuth(session.access_token);
      if (disposed) return;
      channel
        .on(
          "postgres_changes",
          { event: "*", schema: "public", table: "notifications" },
          refresh,
        )
        .subscribe();
    }
    void subscribe();
    return () => {
      disposed = true;
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
      void supabase.removeChannel(channel);
    };
  }, [router]);

  const badge = unreadCount > 99 ? "99+" : String(unreadCount);

  return (
    <Button variant="ghost" size="icon" className="relative" asChild>
      <Link
        href="/notifications"
        aria-label={
          unreadCount > 0
            ? t("bellUnreadLabel", { count: badge })
            : t("bellLabel")
        }
        data-testid="notification-bell"
      >
        <Bell className="size-5" aria-hidden />
        {unreadCount > 0 ? (
          <span
            data-testid="notification-badge"
            className="absolute end-1 top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-semibold leading-none text-white"
          >
            {badge}
          </span>
        ) : null}
      </Link>
    </Button>
  );
}
