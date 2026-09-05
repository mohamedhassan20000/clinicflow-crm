"use client";

import { useEffect, useId, useRef, useState } from "react";
import { LoaderCircle, RefreshCw, Sparkles, TriangleAlert } from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import type { AssistantCapabilities } from "@/lib/ai/capabilities";
import type { LaunchableAssistantPageContext } from "@/lib/ai/page-context";
import type { StaffAssistantUIMessage } from "@/lib/ai/staff-agent";
import type { ActiveContext } from "@/lib/ai/conversation-context";
import type { PermissionUserRole } from "@/lib/page-permissions";

type AssistantChatModule = typeof import("@/components/assistant/assistant-chat");

type LauncherSession = {
  initialConversationId: string;
  initialMessages: StaffAssistantUIMessage[];
  initialActiveContext: ActiveContext;
  historyTruncated: boolean;
  remaining: number;
  capabilities: AssistantCapabilities | null;
};

function titleKey(context: LaunchableAssistantPageContext) {
  const keys = {
    patient: "patientSheetTitle",
    appointments: "appointmentsSheetTitle",
    dashboard: "dashboardSheetTitle",
    revenue: "revenueSheetTitle",
    reports: "reportsSheetTitle",
    invoices: "invoicesSheetTitle",
    staff: "staffSheetTitle",
    departments: "departmentsSheetTitle",
    "doctor-schedule": "doctorScheduleSheetTitle",
  } as const;
  return keys[context.type];
}

function descriptionKey(context: LaunchableAssistantPageContext) {
  const keys = {
    patient: "patientSheetDescription",
    appointments: "appointmentsSheetDescription",
    dashboard: "dashboardSheetDescription",
    revenue: "revenueSheetDescription",
    reports: "reportsSheetDescription",
    invoices: "invoicesSheetDescription",
    staff: "staffSheetDescription",
    departments: "departmentsSheetDescription",
    "doctor-schedule": "doctorScheduleSheetDescription",
  } as const;
  return keys[context.type];
}

/**
 * One Sheet launcher for every contextual Assistant entry point. The context
 * sent to chat is the strict, minimized contract; display labels (such as a
 * patient name) stay UI-only and never enter the request payload.
 *
 * The Sheet hosts the *same* `AssistantChat` as `/assistant` — same transport,
 * same conversation persistence, same confirmation pipeline, and since the
 * post-plan completion pass the same conversation history. There is deliberately
 * no shortcut-only chat implementation: opening a shortcut starts a new
 * conversation seeded server-side with the record on screen, and the user can
 * still browse to, and continue, any earlier conversation from inside it.
 */
export function AssistantLauncher({
  context,
  contextLabel,
  role,
}: {
  context: LaunchableAssistantPageContext;
  contextLabel?: string | null;
  role: PermissionUserRole;
}) {
  const t = useTranslations("assistant");
  const descriptionId = useId();
  const [open, setOpen] = useState(false);
  const [loadState, setLoadState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [session, setSession] = useState<LauncherSession | null>(null);
  const [Chat, setChat] = useState<AssistantChatModule["AssistantChat"] | null>(null);
  const loadPromiseRef = useRef<Promise<void> | null>(null);
  const retryButtonRef = useRef<HTMLButtonElement>(null);
  const title = context.type === "patient"
    ? t(titleKey(context), { patient: contextLabel ?? t("patientContextFallback") })
    : t(titleKey(context));

  async function loadSession() {
    if (loadState === "ready" || loadPromiseRef.current) return;
    setLoadState("loading");
    const pending = (async () => {
      try {
        const [chatModule, response] = await Promise.all([
          import("@/components/assistant/assistant-chat"),
          fetch("/api/agent/launcher-session", {
            method: "POST",
            credentials: "same-origin",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ context }),
          }),
        ]);
        if (!response.ok) throw new Error("launcher_session_unavailable");
        const payload = (await response.json()) as LauncherSession;
        setSession(payload);
        setChat(() => chatModule.AssistantChat);
        setLoadState("ready");
      } catch {
        setLoadState("error");
      }
    })();
    loadPromiseRef.current = pending;
    try {
      await pending;
    } finally {
      loadPromiseRef.current = null;
    }
  }

  function handleOpenChange(nextOpen: boolean) {
    setOpen(nextOpen);
    if (nextOpen) void loadSession();
  }

  useEffect(() => {
    if (loadState === "error") retryButtonRef.current?.focus();
  }, [loadState]);

  return (
    <Sheet open={open} onOpenChange={handleOpenChange}>
      <SheetTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="gap-1.5 border-primary/25 text-primary hover:bg-primary/5 hover:text-primary"
        >
          <Sparkles className="size-3.5" aria-hidden="true" />
          {context.type === "patient" ? t("askAboutPatient") : t("askAssistant")}
        </Button>
      </SheetTrigger>
      <SheetContent
        side="inline-end"
        className="w-full gap-0 p-0 sm:max-w-2xl"
        aria-describedby={descriptionId}
      >
        <SheetHeader className="border-b border-border/60 px-5 py-4">
          <SheetTitle>{title}</SheetTitle>
          <SheetDescription id={descriptionId}>
            {t(descriptionKey(context))}
          </SheetDescription>
        </SheetHeader>
        {loadState === "ready" && session && Chat ? (
          <Chat
            initialConversationId={session.initialConversationId}
            initialMessages={session.initialMessages}
            initialActiveContext={session.initialActiveContext}
            historyTruncated={session.historyTruncated}
            pageContext={context}
            contextLabel={contextLabel}
            remaining={session.remaining}
            mode="sheet"
            role={role}
            capabilities={session.capabilities}
          />
        ) : loadState === "error" ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
            <TriangleAlert className="size-6 text-destructive" aria-hidden="true" />
            <div role="alert" aria-live="assertive" aria-atomic="true">
              <p className="font-medium">{t("unavailableTitle")}</p>
              <p className="mt-1 max-w-md text-sm text-muted-foreground">
                {t("unavailableDescription")}
              </p>
            </div>
            <Button
              ref={retryButtonRef}
              type="button"
              variant="outline"
              onClick={() => void loadSession()}
            >
              <RefreshCw className="size-4" aria-hidden="true" />
              {t("retrySession")}
            </Button>
          </div>
        ) : (
          <div
            className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground"
            role="status"
            aria-live="polite"
          >
            <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
            {t("loadingSession")}
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
