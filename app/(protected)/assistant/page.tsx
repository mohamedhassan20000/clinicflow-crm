import type { Metadata } from "next";
import { BrainCircuit, ShieldCheck } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { AssistantAccessGate } from "@/components/assistant/assistant-access-gate";
import { AssistantChat } from "@/components/assistant/assistant-chat";
import { loadLatestDoctorConversation } from "@/lib/ai/conversations";
import type { DoctorAssistantUIMessage } from "@/lib/ai/doctor-agent";
import { getDoctorAssistantSurfaceAccess } from "@/lib/ai/surface";
import { requireRole } from "@/lib/rbac";
import { createClient } from "@/lib/supabase/server";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("assistant");
  return { title: t("metadataTitle") };
}

export default async function AssistantPage() {
  const [t, user] = await Promise.all([
    getTranslations("assistant"),
    requireRole(["admin", "doctor"]),
  ]);
  const access = await getDoctorAssistantSurfaceAccess(user);
  const conversation = access.state === "available"
    ? await loadLatestDoctorConversation({ supabase: await createClient(), user })
    : null;

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-3">
          <div className="grid size-11 shrink-0 place-items-center rounded-2xl border border-primary/15 bg-primary/8 text-primary">
            <BrainCircuit className="size-5" aria-hidden="true" />
          </div>
          <div>
            <h1 className="font-heading text-2xl font-semibold tracking-tight">{t("title")}</h1>
            <p className="mt-1 max-w-2xl text-sm leading-6 text-muted-foreground">{t("description")}</p>
          </div>
        </div>
        <div className="inline-flex items-center gap-2 rounded-full border border-border/70 bg-card px-3 py-1.5 text-xs font-medium text-muted-foreground shadow-xs">
          <ShieldCheck className="size-3.5 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
          {t("privacyBadge")}
        </div>
      </header>

      {access.state === "available" ? (
        <section className="flex min-h-[38rem] overflow-hidden rounded-3xl border border-border/70 bg-background shadow-sm">
          <AssistantChat
            initialConversationId={conversation?.id ?? crypto.randomUUID()}
            initialMessages={(conversation?.messages ?? []) as DoctorAssistantUIMessage[]}
            historyTruncated={conversation?.historyTruncated ?? false}
            remaining={access.remaining}
          />
        </section>
      ) : (
        <AssistantAccessGate access={access} />
      )}
    </div>
  );
}
