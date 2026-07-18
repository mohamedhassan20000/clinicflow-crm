"use client";

import { useState, useTransition } from "react";
import { BellRing } from "lucide-react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { updateReminderSettings } from "@/actions/settings";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";

type Props = {
  enabled: boolean;
  canManage: boolean;
};

/**
 * Appointment-reminder settings (§7.2b). A single clinic-level toggle: when on,
 * the daily morning cron sends WhatsApp + Email reminders for today's and
 * tomorrow's confirmed appointments. Optimistic toggle with rollback on error.
 */
export function ReminderSettingsCard({ enabled, canManage }: Props) {
  const t = useTranslations("settings");
  const [checked, setChecked] = useState(enabled);
  const [pending, startTransition] = useTransition();

  function onToggle(next: boolean) {
    const previous = checked;
    setChecked(next);
    startTransition(async () => {
      const result = await updateReminderSettings(next);
      if (result.error) {
        setChecked(previous);
        toast.error(result.error);
      } else {
        toast.success(
          next ? t("remindersEnabledToast") : t("remindersDisabledToast"),
        );
      }
    });
  }

  return (
    <Card className="max-w-3xl">
      <CardHeader className="border-b">
        <div className="flex items-center gap-3">
          <span className="flex size-10 items-center justify-center rounded-lg bg-sky-500/10 text-sky-700 dark:text-sky-400">
            <BellRing className="size-5" aria-hidden />
          </span>
          <div className="space-y-1">
            <CardTitle>{t("reminderSettingsTitle")}</CardTitle>
            <CardDescription>{t("reminderSettingsDescription")}</CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="flex items-start justify-between gap-4 pt-6">
        <div className="space-y-1">
          <p className="text-sm font-medium">{t("reminderSettingsToggleLabel")}</p>
          <p className="text-sm text-muted-foreground">
            {t("reminderSettingsToggleHint")}
          </p>
        </div>
        <Switch
          checked={checked}
          onCheckedChange={onToggle}
          disabled={pending || !canManage}
          aria-label={t("reminderSettingsToggleLabel")}
        />
      </CardContent>
    </Card>
  );
}
