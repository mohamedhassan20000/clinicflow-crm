"use client";

import { useState, useTransition } from "react";
import { Loader2, Pencil, Plus, Send, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import {
  deleteMessageTemplate,
  saveMessageTemplate,
  submitWhatsAppTemplate,
} from "@/actions/messaging";
import { LOCALE_LABELS } from "@/lib/i18n/config";
import { TEMPLATE_VARIABLE_OPTIONS } from "@/lib/validations/messaging";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";

export type TemplateListItem = {
  id: string;
  channel: "whatsapp" | "email";
  name: string;
  language: "ar" | "en";
  body: string;
  variables: string[];
  approvalStatus: "draft" | "submitted" | "approved" | "rejected";
  updatedAt: string;
};

type Props = {
  templates: TemplateListItem[];
  whatsappEntitled: boolean;
};

const STATUS_BADGE: Record<TemplateListItem["approvalStatus"], "default" | "secondary" | "outline" | "destructive"> = {
  draft: "outline",
  submitted: "secondary",
  approved: "default",
  rejected: "destructive",
};

const STATUS_LABEL_KEY = {
  draft: "templateStatus_draft",
  submitted: "templateStatus_submitted",
  approved: "templateStatus_approved",
  rejected: "templateStatus_rejected",
} as const;

const CHANNEL_LABEL_KEY = {
  whatsapp: "channel_whatsapp",
  email: "channel_email",
} as const;

const TEMPLATE_CATEGORIES = ["UTILITY", "MARKETING", "AUTHENTICATION"] as const;

const CATEGORY_LABEL_KEY = {
  UTILITY: "templateCategory_UTILITY",
  MARKETING: "templateCategory_MARKETING",
  AUTHENTICATION: "templateCategory_AUTHENTICATION",
} as const;

export function MessageTemplatesManager({ templates, whatsappEntitled }: Props) {
  const t = useTranslations("settings");
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<TemplateListItem | null>(null);
  const [channel, setChannel] = useState<TemplateListItem["channel"]>("whatsapp");
  const [category, setCategory] = useState<(typeof TEMPLATE_CATEGORIES)[number]>("UTILITY");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function openEditor(template: TemplateListItem | null) {
    setEditing(template);
    setChannel(template?.channel ?? "whatsapp");
    setSaveError(null);
    setEditorOpen(true);
  }

  function handleSave(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    startTransition(async () => {
      const result = await saveMessageTemplate(null, formData);
      if (result.error) {
        setSaveError(result.error);
        return;
      }
      toast.success(t("templateSaved"));
      setSaveError(null);
      setEditorOpen(false);
    });
  }

  function submitTemplate(template: TemplateListItem) {
    setBusyId(template.id);
    startTransition(async () => {
      const result = await submitWhatsAppTemplate(template.id, category);
      setBusyId(null);
      if (result.error) toast.error(result.error);
      else toast.success(t("templateSubmitted"));
    });
  }

  function removeTemplate(template: TemplateListItem) {
    setBusyId(template.id);
    startTransition(async () => {
      const result = await deleteMessageTemplate(template.id);
      setBusyId(null);
      if (result.error) toast.error(result.error);
      else toast.success(t("templateDeleted"));
    });
  }

  const locked =
    editing?.approvalStatus === "submitted" || editing?.approvalStatus === "approved";

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">
          {t("templatesReservedNamesHint")}
        </p>
        <Button onClick={() => openEditor(null)}>
          <Plus className="size-4" aria-hidden />
          {t("newTemplate")}
        </Button>
      </div>

      {templates.length === 0 ? (
        <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
          {t("noTemplatesYet")}
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("templateName")}</TableHead>
                <TableHead>{t("templateChannel")}</TableHead>
                <TableHead>{t("templateLanguage")}</TableHead>
                <TableHead>{t("templateStatus")}</TableHead>
                <TableHead className="text-end">{t("actions")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {templates.map((template) => (
                <TableRow key={template.id}>
                  <TableCell className="font-medium">{template.name}</TableCell>
                  <TableCell>{t(CHANNEL_LABEL_KEY[template.channel])}</TableCell>
                  <TableCell>{LOCALE_LABELS[template.language].native}</TableCell>
                  <TableCell>
                    <Badge variant={STATUS_BADGE[template.approvalStatus]}>
                      {t(STATUS_LABEL_KEY[template.approvalStatus])}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center justify-end gap-1">
                      {template.channel === "whatsapp" &&
                      whatsappEntitled &&
                      (template.approvalStatus === "draft" ||
                        template.approvalStatus === "rejected") ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={busyId === template.id}
                          onClick={() => submitTemplate(template)}
                        >
                          {busyId === template.id ? (
                            <Loader2 className="size-4 animate-spin" aria-hidden />
                          ) : (
                            <Send className="size-4 rtl:-scale-x-100" aria-hidden />
                          )}
                          {t("submitForApproval")}
                        </Button>
                      ) : null}
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={t("editTemplate")}
                        onClick={() => openEditor(template)}
                      >
                        <Pencil className="size-4" aria-hidden />
                      </Button>
                      {template.approvalStatus !== "submitted" ? (
                        <AlertDialog>
                          <AlertDialogTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon"
                              aria-label={t("deleteTemplate")}
                              disabled={busyId === template.id}
                            >
                              <Trash2 className="size-4 text-destructive" aria-hidden />
                            </Button>
                          </AlertDialogTrigger>
                          <AlertDialogContent>
                            <AlertDialogHeader>
                              <AlertDialogTitle>{t("deleteTemplate")}</AlertDialogTitle>
                              <AlertDialogDescription>
                                {t("deleteTemplateConfirm", { name: template.name })}
                              </AlertDialogDescription>
                            </AlertDialogHeader>
                            <AlertDialogFooter>
                              <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
                              <AlertDialogAction onClick={() => removeTemplate(template)}>
                                {t("deleteTemplate")}
                              </AlertDialogAction>
                            </AlertDialogFooter>
                          </AlertDialogContent>
                        </AlertDialog>
                      ) : null}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <Label htmlFor="template-category" className="text-xs">
          {t("whatsAppSubmissionCategory")}
        </Label>
        <Select value={category} onValueChange={(value) => setCategory(value as typeof category)}>
          <SelectTrigger id="template-category" className="h-8 w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {TEMPLATE_CATEGORIES.map((option) => (
              <SelectItem key={option} value={option}>
                {t(CATEGORY_LABEL_KEY[option])}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <Dialog open={editorOpen} onOpenChange={setEditorOpen}>
        <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{editing ? t("editTemplate") : t("newTemplate")}</DialogTitle>
            <DialogDescription>{t("templateEditorDescription")}</DialogDescription>
          </DialogHeader>
          {locked ? (
            <p className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-sm text-amber-800 dark:text-amber-300">
              {t("templateLockedHint")}
            </p>
          ) : null}
          <form onSubmit={handleSave} className="space-y-4">
            {saveError ? (
              <div
                role="alert"
                className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive"
              >
                {saveError}
              </div>
            ) : null}
            {editing ? <input type="hidden" name="id" value={editing.id} /> : null}
            <input type="hidden" name="channel" value={channel} />
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="template-channel">{t("templateChannel")}</Label>
                <Select
                  value={channel}
                  onValueChange={(value) => setChannel(value as TemplateListItem["channel"])}
                  disabled={locked}
                >
                  <SelectTrigger id="template-channel" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="whatsapp">{t("channel_whatsapp")}</SelectItem>
                    <SelectItem value="email">{t("channel_email")}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="template-language">{t("templateLanguage")}</Label>
                <select
                  id="template-language"
                  name="language"
                  defaultValue={editing?.language ?? "ar"}
                  disabled={locked}
                  className="border-input bg-transparent h-9 w-full rounded-md border px-3 text-sm shadow-xs"
                >
                  <option value="ar">{LOCALE_LABELS.ar.native}</option>
                  <option value="en">{LOCALE_LABELS.en.native}</option>
                </select>
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="template-name">{t("templateName")}</Label>
              <Input
                id="template-name"
                name="name"
                required
                maxLength={200}
                defaultValue={editing?.name ?? ""}
                disabled={locked}
                dir="ltr"
              />
              <p className="text-xs text-muted-foreground">{t("templateNameHint")}</p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="template-body">{t("templateBody")}</Label>
              <Textarea
                id="template-body"
                name="body"
                required
                maxLength={1024}
                rows={5}
                defaultValue={editing?.body ?? ""}
                disabled={locked}
              />
              <p className="text-xs text-muted-foreground">{t("templateBodyHint")}</p>
            </div>
            <fieldset className="space-y-2" disabled={locked}>
              <legend className="text-sm font-medium">{t("templateVariables")}</legend>
              <div className="grid gap-2 sm:grid-cols-2">
                {TEMPLATE_VARIABLE_OPTIONS.map((variable) => (
                  <label key={variable} className="flex items-center gap-2 text-sm">
                    <Checkbox
                      name="variables"
                      value={variable}
                      defaultChecked={editing?.variables.includes(variable) ?? false}
                    />
                    <span dir="ltr">{`{{${variable}}}`}</span>
                  </label>
                ))}
              </div>
            </fieldset>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => setEditorOpen(false)}>
                {t("cancel")}
              </Button>
              <Button type="submit" disabled={pending || locked}>
                {pending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
                {t("saveTemplate")}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
