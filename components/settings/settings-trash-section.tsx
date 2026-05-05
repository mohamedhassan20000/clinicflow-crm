"use client";

import { useRef, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Trash2, RotateCcw, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
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

export interface TrashItem {
  id: string;
  label: string;
  subtitle?: string;
  deletedAt: string;
}

interface SettingsTrashSectionProps {
  items: TrashItem[];
  entityLabel: string;
  onRestore: (id: string) => Promise<{ error?: string; success?: boolean }>;
  onPermanentDelete?: (id: string) => Promise<{ error?: string; success?: boolean }>;
}

function daysLeft(deletedAt: string): number {
  const deletedMs = new Date(deletedAt).getTime();
  const nowMs = Date.now();
  const elapsed = Math.floor((nowMs - deletedMs) / (1000 * 60 * 60 * 24));
  return Math.max(0, 30 - elapsed);
}

function RestoreButton({
  id,
  label,
  onRestore,
}: {
  id: string;
  label: string;
  onRestore: (id: string) => Promise<{ error?: string; success?: boolean }>;
}) {
  const [isPending, start] = useTransition();
  const router = useRouter();
  const pendingRef = useRef(false);

  return (
    <Button
      variant="ghost"
      size="sm"
      className="h-7 gap-1.5 px-2 text-xs"
      disabled={isPending}
      onClick={() =>
        start(async () => {
          if (pendingRef.current) return;
          pendingRef.current = true;
          const res = await onRestore(id);
          if (res.error) toast.error(res.error);
          else {
            toast.success(`"${label}" restored.`);
            router.refresh();
          }
          pendingRef.current = false;
        })
      }
    >
      {isPending ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
      ) : (
        <RotateCcw className="h-3.5 w-3.5" />
      )}
      Restore
    </Button>
  );
}

function PermanentDeleteButton({
  id,
  label,
  onPermanentDelete,
}: {
  id: string;
  label: string;
  onPermanentDelete: (id: string) => Promise<{ error?: string; success?: boolean }>;
}) {
  const [isPending, start] = useTransition();
  const router = useRouter();
  const pendingRef = useRef(false);

  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 gap-1.5 px-2 text-xs text-destructive hover:text-destructive"
          disabled={isPending}
        >
          {isPending ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Trash2 className="h-3.5 w-3.5" />
          )}
          Delete permanently
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Permanently delete &ldquo;{label}&rdquo;?</AlertDialogTitle>
          <AlertDialogDescription>
            This cannot be undone. The record will be deleted forever.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isPending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={isPending}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            onClick={() =>
              start(async () => {
                if (pendingRef.current) return;
                pendingRef.current = true;
                const res = await onPermanentDelete(id);
                if (res.error) toast.error(res.error);
                else {
                  toast.success(`"${label}" permanently deleted.`);
                  router.refresh();
                }
                pendingRef.current = false;
              })
            }
          >
            Delete permanently
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function SettingsTrashSection({
  items,
  entityLabel,
  onRestore,
  onPermanentDelete,
}: SettingsTrashSectionProps) {
  if (items.length === 0) return null;

  return (
    <div className="rounded-xl border border-destructive/20 bg-destructive/5">
      <div className="flex items-center gap-2 border-b border-destructive/15 px-4 py-3">
        <Trash2 className="h-4 w-4 text-destructive/70" />
        <h3 className="text-sm font-semibold text-destructive/80">
          Recycle Bin
        </h3>
        <span className="ml-auto rounded-full bg-destructive/10 px-2 py-0.5 text-[11px] font-medium text-destructive/70">
          {items.length} {entityLabel}
          {items.length !== 1 ? "s" : ""}
        </span>
      </div>
      <p className="px-4 py-2 text-xs text-muted-foreground">
        Items are permanently deleted after 30 days. Restore to bring them back.
      </p>
      <div className="overflow-x-auto">
        <table className="w-full table-fixed text-sm">
          <colgroup>
            <col />
            <col className="w-32" />
            <col className={onPermanentDelete ? "w-56" : "w-24"} />
          </colgroup>
          <thead className="border-b border-destructive/10 bg-destructive/5">
            <tr>
              <th className="px-4 py-2 text-left text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                {entityLabel}
              </th>
              <th className="px-4 py-2 text-left text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                Deleted
              </th>
              <th className="px-4 py-2 text-right text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/40">
            {items.map((item) => {
              const days = daysLeft(item.deletedAt);
              return (
                <tr key={item.id} className="hover:bg-muted/20 transition-colors">
                  <td className="max-w-0 px-4 py-2.5">
                    <p className="truncate font-medium text-muted-foreground line-through decoration-destructive/40">
                      {item.label}
                    </p>
                    {item.subtitle && (
                      <p className="truncate text-xs text-muted-foreground/60">
                        {item.subtitle}
                      </p>
                    )}
                  </td>
                  <td className="px-4 py-2.5">
                    <span
                      className={`text-xs ${days <= 3 ? "font-semibold text-destructive" : "text-muted-foreground"}`}
                    >
                      {days === 0
                        ? "Expires today"
                        : `${days} day${days !== 1 ? "s" : ""} left`}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    <div className="flex items-center justify-end gap-1">
                      <RestoreButton
                        id={item.id}
                        label={item.label}
                        onRestore={onRestore}
                      />
                      {onPermanentDelete && (
                        <PermanentDeleteButton
                          id={item.id}
                          label={item.label}
                          onPermanentDelete={onPermanentDelete}
                        />
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
