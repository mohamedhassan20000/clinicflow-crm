"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Pencil, Plus, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import {
  deletePatientFaq,
  savePatientFaq,
  setPatientAiReplyMode,
} from "@/actions/patient-ai";
import type { PatientFaqItem } from "@/lib/ai/patient-faq-settings";
import type { ClinicAiReplyMode } from "@/lib/ai/patient-reply-mode";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
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
import { Textarea } from "@/components/ui/textarea";

type FaqDraft = {
  id: string | null;
  question: string;
  answer: string;
  language: "ar" | "en";
  isActive: boolean;
};

const EMPTY_DRAFT: FaqDraft = {
  id: null,
  question: "",
  answer: "",
  language: "ar",
  isActive: true,
};

export function PatientAiSettingsPanel({
  replyMode,
  autoEntitled,
  faqs,
}: {
  replyMode: ClinicAiReplyMode;
  autoEntitled: boolean;
  faqs: PatientFaqItem[];
}) {
  const t = useTranslations("settings");
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [mode, setMode] = useState<ClinicAiReplyMode>(replyMode);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [draft, setDraft] = useState<FaqDraft>(EMPTY_DRAFT);

  function changeMode(next: ClinicAiReplyMode) {
    const previous = mode;
    setMode(next);
    startTransition(async () => {
      const result = await setPatientAiReplyMode({ mode: next });
      if (result.error) {
        setMode(previous);
        toast.error(result.error);
        return;
      }
      toast.success(t("patientAiModeSaved"));
      router.refresh();
    });
  }

  function openCreate() {
    setDraft(EMPTY_DRAFT);
    setDialogOpen(true);
  }

  function openEdit(item: PatientFaqItem) {
    setDraft({
      id: item.id,
      question: item.question,
      answer: item.answer,
      language: item.language,
      isActive: item.isActive,
    });
    setDialogOpen(true);
  }

  function saveFaq() {
    if (!draft.question.trim() || !draft.answer.trim()) return;
    startTransition(async () => {
      const result = await savePatientFaq({
        id: draft.id,
        question: draft.question,
        answer: draft.answer,
        language: draft.language,
        isActive: draft.isActive,
      });
      if (result.error) {
        toast.error(result.error);
        return;
      }
      setDialogOpen(false);
      toast.success(t("patientAiFaqSaved"));
      router.refresh();
    });
  }

  function removeFaq(id: string) {
    startTransition(async () => {
      const result = await deletePatientFaq({ id });
      if (result.error) {
        toast.error(result.error);
        return;
      }
      toast.success(t("patientAiFaqDeleted"));
      router.refresh();
    });
  }

  return (
    <div className="space-y-8">
      <section className="space-y-3 rounded-xl border bg-card p-4">
        <div>
          <h3 className="font-medium">{t("patientAiModeTitle")}</h3>
          <p className="mt-1 text-sm text-muted-foreground">{t("patientAiModeDescription")}</p>
        </div>
        <div className="max-w-xs">
          <Label htmlFor="patient-ai-mode" className="sr-only">
            {t("patientAiModeTitle")}
          </Label>
          <Select
            value={mode}
            onValueChange={(value) => changeMode(value as ClinicAiReplyMode)}
            disabled={pending}
          >
            <SelectTrigger id="patient-ai-mode" aria-label={t("patientAiModeTitle")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="off">{t("patientAiModeOff")}</SelectItem>
              <SelectItem value="suggest">{t("patientAiModeSuggest")}</SelectItem>
              <SelectItem value="auto" disabled={!autoEntitled}>
                {t("patientAiModeAuto")}
                {!autoEntitled ? ` · ${t("patientAiModeAutoLocked")}` : ""}
              </SelectItem>
            </SelectContent>
          </Select>
          <p className="mt-2 text-xs text-muted-foreground">
            {mode === "off"
              ? t("patientAiModeOffHint")
              : mode === "suggest"
                ? t("patientAiModeSuggestHint")
                : t("patientAiModeAutoHint")}
          </p>
        </div>
      </section>

      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="font-medium">{t("patientAiFaqTitle")}</h3>
            <p className="mt-1 text-sm text-muted-foreground">{t("patientAiFaqDescription")}</p>
          </div>
          <Button size="sm" onClick={openCreate} disabled={pending}>
            <Plus className="size-4" aria-hidden />
            {t("patientAiFaqAdd")}
          </Button>
        </div>

        {faqs.length === 0 ? (
          <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
            {t("patientAiFaqEmpty")}
          </p>
        ) : (
          <ul className="space-y-2" data-testid="patient-faq-list">
            {faqs.map((item) => (
              <li key={item.id} className="rounded-lg border bg-card p-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="truncate text-sm font-medium">{item.question}</p>
                      <Badge variant="outline">{item.language.toUpperCase()}</Badge>
                      {!item.isActive ? (
                        <Badge variant="secondary">{t("patientAiFaqInactive")}</Badge>
                      ) : null}
                    </div>
                    <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">{item.answer}</p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => openEdit(item)}
                      disabled={pending}
                      aria-label={t("patientAiFaqEdit")}
                    >
                      <Pencil className="size-4" aria-hidden />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => removeFaq(item.id)}
                      disabled={pending}
                      aria-label={t("patientAiFaqDelete")}
                    >
                      <Trash2 className="size-4 text-destructive" aria-hidden />
                    </Button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{draft.id ? t("patientAiFaqEdit") : t("patientAiFaqAdd")}</DialogTitle>
            <DialogDescription>{t("patientAiFaqDialogDescription")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="faq-question">{t("patientAiFaqQuestion")}</Label>
              <Input
                id="faq-question"
                value={draft.question}
                maxLength={500}
                onChange={(event) => setDraft((d) => ({ ...d, question: event.target.value }))}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="faq-answer">{t("patientAiFaqAnswer")}</Label>
              <Textarea
                id="faq-answer"
                value={draft.answer}
                maxLength={4000}
                className="min-h-28"
                onChange={(event) => setDraft((d) => ({ ...d, answer: event.target.value }))}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="faq-language">{t("patientAiFaqLanguage")}</Label>
              <Select
                value={draft.language}
                onValueChange={(value) => setDraft((d) => ({ ...d, language: value as "ar" | "en" }))}
              >
                <SelectTrigger id="faq-language" className="max-w-40">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ar">{t("patientAiFaqLanguageAr")}</SelectItem>
                  <SelectItem value="en">{t("patientAiFaqLanguageEn")}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)} disabled={pending}>
              {t("patientAiFaqCancel")}
            </Button>
            <Button
              onClick={saveFaq}
              disabled={pending || !draft.question.trim() || !draft.answer.trim()}
            >
              {pending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
              {t("patientAiFaqSave")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
