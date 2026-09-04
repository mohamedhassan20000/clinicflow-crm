"use client";

import { useCallback, useMemo, useState, useTransition } from "react";
import { Loader2, MessageSquarePlus, Search, UserRound, UserRoundX } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { openNewWhatsAppConversation, refreshInboxContacts } from "@/actions/messaging";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  contactMatches,
  groupInboxContacts,
  type InboxContactDirectory,
  type InboxContactOption,
} from "@/lib/messaging/inbox-contact-groups";

/**
 * Starting a WhatsApp conversation from the linked account's contact directory.
 *
 * The directory is not the Inbox, and this dialog is built so that distinction
 * survives every interaction: rendering the list is a read, selecting a contact
 * only fills the recipient field, and a thread exists only once someone presses
 * the explicit action. No patient is created and no contact is linked to a
 * patient file by anything that happens here.
 *
 * Two groups, because "a contact" means two very different things to a clinic:
 *
 *   - **Clinic contacts** — this number is already a patient file here. The
 *     linkage is the system's own authoritative one (an existing
 *     `conversations.patient_id`, or an exact E.164 match on `patients.phone`),
 *     computed server-side in lib/messaging/inbox-contacts.ts. This dialog does
 *     not re-derive it and adds no fuzzy matching of its own.
 *   - **WhatsApp contacts** — synced from the currently authenticated account
 *     and not known to the clinic. Shown as exactly that, never as a patient.
 *
 * Contacts arrive from the worker asynchronously, often after this page has
 * already rendered with none. Opening the dialog re-fetches them, so the
 * directory is never a stale snapshot the user has to hard-refresh out of.
 */

type Props = {
  contacts: InboxContactOption[];
  /** Server-computed counts. Falls back to what `contacts` shows when absent. */
  directory?: InboxContactDirectory;
};

export function NewConversationDialog({ contacts, directory }: Props) {
  const t = useTranslations("inbox.newConversation");
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [activeGroup, setActiveGroup] = useState<"clinic" | "whatsapp">("clinic");
  const [clinicQuery, setClinicQuery] = useState("");
  const [whatsappQuery, setWhatsappQuery] = useState("");
  const [number, setNumber] = useState("");
  const [displayName, setDisplayName] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [known, setKnown] = useState<InboxContactOption[]>(contacts);
  const [total, setTotal] = useState<number>(directory?.total ?? contacts.length);
  const [refreshing, setRefreshing] = useState(false);

  // Newer server data replaces what a refresh put here, adjusted during render
  // rather than in an effect: an effect would render the stale list once first,
  // and this list is exactly the thing that was stale to begin with.
  const [renderedFrom, setRenderedFrom] = useState(contacts);
  if (renderedFrom !== contacts) {
    setRenderedFrom(contacts);
    setKnown(contacts);
    setTotal(directory?.total ?? contacts.length);
  }

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const fresh = await refreshInboxContacts();
      // A failed read leaves whatever was already on screen rather than
      // blanking a directory the user can see is populated.
      if (fresh.error) return;
      setKnown(fresh.contacts);
      setTotal(fresh.total);
    } catch {
      // Same reasoning: the dialog is still usable, and manual entry is
      // unaffected by a directory that could not be refreshed.
    } finally {
      setRefreshing(false);
    }
  }, []);

  function onOpenChange(next: boolean) {
    setOpen(next);
    // Every open, not only the first: the worker may have imported more since
    // the last time this was looked at.
    if (next) void refresh();
  }

  const allGroups = useMemo(() => groupInboxContacts(known), [known]);
  const activeQuery = activeGroup === "clinic" ? clinicQuery : whatsappQuery;
  const activeRows = useMemo(
    () => allGroups[activeGroup].filter((contact) => contactMatches(contact, activeQuery)),
    [activeGroup, activeQuery, allGroups],
  );

  function chooseContact(contact: InboxContactOption) {
    // Selection is not an intent to talk: it fills the recipient and nothing
    // else is called.
    setNumber(contact.participantAddress);
    setDisplayName(contact.displayName ?? contact.patientName ?? null);
  }

  function openConversation() {
    if (!number.trim()) return;
    startTransition(async () => {
      const result = await openNewWhatsAppConversation({
        participant: number,
        displayName,
      });
      if (result.error || !result.conversationId) {
        toast.error(result.error ?? t("openFailed"));
        return;
      }
      setOpen(false);
      router.push(`/inbox?conversation=${encodeURIComponent(result.conversationId)}`);
      router.refresh();
    });
  }

  function renderGroup(key: "clinic" | "whatsapp", rows: InboxContactOption[]) {
    const heading = key === "clinic" ? t("clinicGroup") : t("whatsappGroup");
    return (
      <section key={key}>
        <div
          className="max-h-56 overflow-x-hidden overflow-y-auto overscroll-contain rounded-lg border bg-background [scrollbar-gutter:stable]"
          role="listbox"
          aria-label={heading}
        >
          {rows.length > 0 ? (
            rows.map((contact) => (
              <button
                key={contact.id}
                type="button"
                role="option"
                aria-selected={number === contact.participantAddress}
                className="flex w-full items-start justify-between gap-3 border-b px-3 py-2.5 text-start first:rounded-t-lg last:rounded-b-lg last:border-b-0 hover:bg-muted focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
                onClick={() => chooseContact(contact)}
              >
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="truncate text-sm" dir="auto">
                    {contact.displayName ?? contact.patientName ?? t("unnamedContact")}
                  </span>
                  <span className="text-xs text-muted-foreground" dir="ltr">
                    {contact.participantAddress}
                  </span>
                </span>
                <Badge
                  variant={contact.patientId ? "secondary" : "outline"}
                  className="shrink-0 gap-1"
                >
                  {contact.patientId ? (
                    <UserRound className="size-3" aria-hidden />
                  ) : (
                    <UserRoundX className="size-3" aria-hidden />
                  )}
                  {contact.patientId ? t("inClinicBadge") : t("notLinkedBadge")}
                </Badge>
              </button>
            ))
          ) : (
            <p className="p-4 text-center text-sm text-muted-foreground" dir="auto">
              {activeQuery.trim()
                ? t("noMatches")
                : key === "clinic"
                  ? t("emptyClinicGroup")
                  : t("emptyWhatsappGroup")}
            </p>
          )}
        </div>
      </section>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button size="sm">
          <MessageSquarePlus className="size-4" aria-hidden />
          {t("trigger")}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* The headline count, visible before anyone types. */}
          <div className="flex items-center justify-between gap-2 rounded-lg border bg-muted/40 px-3 py-2">
            <p className="text-sm font-medium" dir="auto">
              {t("totalContacts", { count: total })}
            </p>
            {refreshing ? (
              <Loader2 className="size-4 animate-spin text-muted-foreground" aria-hidden />
            ) : null}
          </div>

          <div className="space-y-2">
            <label htmlFor="new-whatsapp-number" className="text-sm font-medium">
              {t("numberLabel")}
            </label>
            <Input
              id="new-whatsapp-number"
              value={number}
              onChange={(event) => {
                setNumber(event.target.value);
                setDisplayName(null);
              }}
              dir="ltr"
              inputMode="tel"
              autoComplete="tel"
              placeholder={t("numberPlaceholder")}
            />
            <p className="text-xs text-muted-foreground">{t("noPatientCreation")}</p>
          </div>

          {known.length > 0 ? (
            <Tabs
              value={activeGroup}
              onValueChange={(value) => setActiveGroup(value as "clinic" | "whatsapp")}
              className="gap-3"
            >
              <TabsList className="grid h-10 w-full grid-cols-2 overflow-hidden rounded-lg p-1">
                <TabsTrigger
                  value="clinic"
                  className="h-full min-h-0 min-w-0 overflow-hidden rounded-md px-2 py-0 text-center text-[13px] leading-none sm:text-sm"
                >
                  <span className="min-w-0 truncate" dir="auto">{t("clinicGroup")}</span>
                  <span className={"shrink-0 tabular-nums" /* i18n-allow: Tailwind utility classes, not user-facing copy */} dir="ltr">({allGroups.clinic.length})</span>
                </TabsTrigger>
                <TabsTrigger
                  value="whatsapp"
                  className="h-full min-h-0 min-w-0 overflow-hidden rounded-md px-2 py-0 text-center text-[13px] leading-none sm:text-sm"
                >
                  <span className="min-w-0 truncate" dir="auto">{t("whatsappGroup")}</span>
                  <span className={"shrink-0 tabular-nums" /* i18n-allow: Tailwind utility classes, not user-facing copy */} dir="ltr">({allGroups.whatsapp.length})</span>
                </TabsTrigger>
              </TabsList>

              {/* Only the active directory is mounted. Each tab owns its query,
                  so changing tabs neither searches the other group nor loses
                  what the user typed when they return. */}
              <TabsContent value={activeGroup} className="grid min-w-0 gap-3">
                <div className="relative">
                  <Search
                    className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
                    aria-hidden
                  />
                  <Input
                    value={activeQuery}
                    onChange={(event) => {
                      if (activeGroup === "clinic") setClinicQuery(event.target.value);
                      else setWhatsappQuery(event.target.value);
                    }}
                    className="ps-9"
                    placeholder={
                      activeGroup === "clinic"
                        ? t("searchClinicContacts")
                        : t("searchWhatsappContacts")
                    }
                    aria-label={
                      activeGroup === "clinic"
                        ? t("searchClinicContacts")
                        : t("searchWhatsappContacts")
                    }
                  />
                </div>
                {renderGroup(activeGroup, activeRows)}
              </TabsContent>
            </Tabs>
          ) : (
            // An empty directory is a normal state — WhatsApp promises no
            // complete address book, and the worker may not have synced yet —
            // and must never be a dead end. Manual entry above still works.
            <p className="rounded-lg border border-dashed p-4 text-center text-sm text-muted-foreground" dir="auto">
              {t("noContacts")}
            </p>
          )}

          <Button className="w-full" disabled={pending || !number.trim()} onClick={openConversation}>
            {pending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
            {t("open")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
