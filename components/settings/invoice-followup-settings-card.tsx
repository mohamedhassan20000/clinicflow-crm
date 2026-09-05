"use client";

import { useState, useTransition } from "react";
import { Loader2, ReceiptText, Save } from "lucide-react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { updateInvoiceFollowupSettings } from "@/actions/settings";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";

type Props = {
  enabled: boolean;
  firstDays: number;
  secondDays: number;
  emailSubject: string | null;
  emailBody: string | null;
  /**
   * The clinic's own name, so the subject placeholder can show the exact
   * default line this clinic would send. Required rather than optional: the
   * placeholder message takes it as an ICU argument, and a caller that omits it
   * makes next-intl throw `FORMATTING_ERROR` at render — which is how this was
   * missed the first time.
   */
  clinicName: string;
  canManage: boolean;
};

/**
 * Per-clinic overdue-invoice reminder configuration (§7.3b, 2026-07-19 flow
 * revision): on/off, first/second reminder day offsets, and the email
 * subject/body. WhatsApp wording is the clinic's own `invoice_followup`
 * template (managed under message templates).
 */
export function InvoiceFollowupSettingsCard({
  enabled: initialEnabled,
  firstDays: initialFirst,
  secondDays: initialSecond,
  emailSubject: initialSubject,
  emailBody: initialBody,
  clinicName,
  canManage,
}: Props) {
  const t = useTranslations("settings");
  const [enabled, setEnabled] = useState(initialEnabled);
  const [firstDays, setFirstDays] = useState(String(initialFirst));
  const [secondDays, setSecondDays] = useState(String(initialSecond));
  const [emailSubject, setEmailSubject] = useState(initialSubject ?? "");
  const [emailBody, setEmailBody] = useState(initialBody ?? "");
  const [pending, startTransition] = useTransition();

  function save() {
    startTransition(async () => {
      const result = await updateInvoiceFollowupSettings({
        enabled,
        firstDays: Number(firstDays),
        secondDays: Number(secondDays),
        emailSubject: emailSubject.trim() ? emailSubject : null,
        emailBody: emailBody.trim() ? emailBody : null,
      });
      if (result.error) toast.error(result.error);
      else toast.success(t("invoiceFollowupSaved"));
    });
  }

  const disabled = pending || !canManage;

  return (
    <Card className="max-w-3xl">
      <CardHeader className="border-b">
        <div className="flex items-center gap-3">
          <span className="flex size-10 items-center justify-center rounded-lg bg-amber-500/10 text-amber-700 dark:text-amber-400">
            <ReceiptText className="size-5" aria-hidden />
          </span>
          <div className="space-y-1">
            <CardTitle>{t("invoiceFollowupTitle")}</CardTitle>
            <CardDescription>{t("invoiceFollowupDescription")}</CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-5 pt-6">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <p className="text-sm font-medium">{t("invoiceFollowupToggleLabel")}</p>
            <p className="text-sm text-muted-foreground">
              {t("invoiceFollowupToggleHint")}
            </p>
          </div>
          <Switch
            checked={enabled}
            onCheckedChange={setEnabled}
            disabled={disabled}
            aria-label={t("invoiceFollowupToggleLabel")}
          />
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="followup-first-days">{t("invoiceFollowupFirstDays")}</Label>
            <Input
              id="followup-first-days"
              type="number"
              min={1}
              max={365}
              value={firstDays}
              onChange={(e) => setFirstDays(e.target.value)}
              disabled={disabled || !enabled}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="followup-second-days">{t("invoiceFollowupSecondDays")}</Label>
            <Input
              id="followup-second-days"
              type="number"
              min={1}
              max={365}
              value={secondDays}
              onChange={(e) => setSecondDays(e.target.value)}
              disabled={disabled || !enabled}
            />
          </div>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="followup-subject">{t("invoiceFollowupEmailSubject")}</Label>
          <Input
            id="followup-subject"
            value={emailSubject}
            onChange={(e) => setEmailSubject(e.target.value)}
            placeholder={
              // The built-in dunning subject is "Outstanding balance — <clinic>"
              // (see `followupCopy` in lib/messaging/patient-copy.ts), so with a
              // name to hand the placeholder is the real default rather than an
              // illustration. Without one there is nothing to interpolate, and
              // the field label reads better than a dangling dash.
              clinicName.trim()
                ? t("invoiceFollowupEmailSubjectPlaceholder", { clinicName: clinicName.trim() })
                : t("invoiceFollowupEmailSubject")
            }
            maxLength={200}
            disabled={disabled || !enabled}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="followup-body">{t("invoiceFollowupEmailBody")}</Label>
          <Textarea
            id="followup-body"
            value={emailBody}
            onChange={(e) => setEmailBody(e.target.value)}
            placeholder={t("invoiceFollowupEmailBodyPlaceholder")}
            rows={3}
            maxLength={2000}
            className="resize-none text-sm"
            disabled={disabled || !enabled}
          />
          <p className="text-xs text-muted-foreground">
            {t("invoiceFollowupEmailHint")}
          </p>
        </div>

        <div className="flex justify-end">
          <Button type="button" onClick={save} disabled={disabled} className="gap-2">
            {pending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Save className="h-4 w-4" />
            )}
            {t("saveSettings")}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
