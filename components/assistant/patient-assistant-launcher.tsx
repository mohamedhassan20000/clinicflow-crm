"use client";

import { Sparkles } from "lucide-react";
import { useTranslations } from "next-intl";
import { AssistantAccessGate } from "@/components/assistant/assistant-access-gate";
import { AssistantChat } from "@/components/assistant/assistant-chat";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import type { StaffAssistantUIMessage } from "@/lib/ai/staff-agent";
import type { StaffAssistantSurfaceAccess } from "@/lib/ai/surface";

export function PatientAssistantLauncher({
  patient,
  access,
  initialConversationId,
  initialMessages,
  historyTruncated,
}: {
  patient: { id: string; name: string };
  access: StaffAssistantSurfaceAccess;
  initialConversationId: string;
  initialMessages: StaffAssistantUIMessage[];
  historyTruncated: boolean;
}) {
  const t = useTranslations("assistant");
  return (
    <Sheet>
      <SheetTrigger asChild>
        <Button type="button" variant="outline" size="sm" className="gap-1.5 border-primary/25 text-primary hover:bg-primary/5 hover:text-primary">
          <Sparkles className="size-3.5" aria-hidden="true" />
          {t("askAboutPatient")}
        </Button>
      </SheetTrigger>
      <SheetContent side="inline-end" className="w-full gap-0 p-0 sm:max-w-2xl" aria-describedby="patient-assistant-description">
        <SheetHeader className="border-b border-border/60 px-5 py-4">
          <SheetTitle>{t("patientSheetTitle", { patient: patient.name })}</SheetTitle>
          <SheetDescription id="patient-assistant-description">
            {t("patientSheetDescription")}
          </SheetDescription>
        </SheetHeader>
        {access.state === "available" ? (
          <AssistantChat
            initialConversationId={initialConversationId}
            initialMessages={initialMessages}
            historyTruncated={historyTruncated}
            patient={patient}
            remaining={access.remaining}
            mode="sheet"
            role="doctor"
          />
        ) : (
          <AssistantAccessGate access={access} compact />
        )}
      </SheetContent>
    </Sheet>
  );
}
