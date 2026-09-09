"use client";

import { useState, useTransition } from "react";
import { CheckCheck, Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { closeOpenConversations, countOpenConversations } from "@/actions/messaging";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";

/**
 * "Close all open conversations", for an admin, with the number said out loud.
 *
 * ## What it closes
 *
 * `conversations.status = 'open'`, inside the clinic's proved WhatsApp account
 * boundary, and nothing else. That is the same `open` the single Close button
 * on a thread writes and the same one the inbound path reopens; this action
 * invents no status of its own. It is deliberately *not* the visible status
 * badge — a thread reading `Needs review` or `Awaiting patient` is normally
 * `status = 'open'` and is exactly the sort of thread this is for. Rows that
 * are already `closed` are not selected, so they are not rewritten at all.
 *
 * ## Why the count is fetched rather than counted here
 *
 * The Inbox list is a page of at most a few hundred threads and is filtered by
 * whatever the staff member has typed. Counting what the browser happens to be
 * rendering would put a number in this modal that is not the number of rows
 * about to change. So the count comes from the server, over the same query the
 * action itself closes, and it is re-read every time the modal opens.
 */
export function BulkCloseDialog() {
  const t = useTranslations("inbox.bulkClose");
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [total, setTotal] = useState<number | null>(null);
  const [counting, setCounting] = useState(false);
  const [pending, startTransition] = useTransition();

  async function onOpenChange(next: boolean) {
    setOpen(next);
    if (!next) {
      setTotal(null);
      return;
    }
    setCounting(true);
    setTotal(null);
    try {
      const result = await countOpenConversations();
      if (result.error) {
        toast.error(result.error);
        setOpen(false);
        return;
      }
      setTotal(result.total ?? 0);
    } catch {
      toast.error(t("countFailed"));
      setOpen(false);
    } finally {
      setCounting(false);
    }
  }

  function confirm() {
    startTransition(async () => {
      const result = await closeOpenConversations();
      if (result.error) {
        toast.error(result.error);
        return;
      }
      // A partial result is reported as a partial result. The one thing this
      // must never do is show a plain success over conversations that did not
      // close — in either of the two ways a run can fall short.
      const requested = result.total ?? 0;
      const succeeded = result.closed ?? 0;
      const failures = result.failed ?? 0;
      if (failures > 0) {
        toast.warning(t("partial", { closed: succeeded, failed: failures }));
      } else if (succeeded < requested) {
        // Nothing was *rejected*, but the run did not get through the set — a
        // read failure part-way, which leaves rows still open. Saying "all
        // closed" here would be the same lie by a different route.
        toast.warning(
          t("incomplete", {
            closed: succeeded,
            total: requested,
            remaining: requested - succeeded,
          }),
        );
      } else {
        toast.success(t("closed", { count: succeeded }));
      }
      setOpen(false);
      router.refresh();
    });
  }

  return (
    <AlertDialog open={open} onOpenChange={(next) => void onOpenChange(next)}>
      <Button
        size="sm"
        variant="outline"
        onClick={() => void onOpenChange(true)}
        data-testid="bulk-close-trigger"
      >
        <CheckCheck className="size-4" aria-hidden />
        {t("trigger")}
      </Button>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("title")}</AlertDialogTitle>
          <AlertDialogDescription>{t("description")}</AlertDialogDescription>
        </AlertDialogHeader>
        <p className="text-sm font-medium" data-testid="bulk-close-count">
          {counting || total === null ? t("counting") : t("countLabel", { count: total })}
        </p>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>{t("cancel")}</AlertDialogCancel>
          <Button
            onClick={confirm}
            disabled={pending || counting || !total}
            data-testid="bulk-close-confirm"
          >
            {pending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
            {pending ? t("closing") : t("confirm", { count: total ?? 0 })}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
