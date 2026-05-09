"use client";

import { useRef, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, RotateCcw, Trash2 } from "lucide-react";
import { toast } from "sonner";
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

export interface AppointmentTrashItem {
  id: string;
  patientName: string;
  doctorName: string;
  scheduledAt: string;
  deletedAt: string;
}

interface AppointmentsRecycleBinProps {
  items: AppointmentTrashItem[];
  onRestore: (id: string) => Promise<{ error?: string; success?: boolean }>;
  onPermanentDelete: (id: string) => Promise<{ error?: string; success?: boolean }>;
  onEmptyTrash: () => Promise<{ error?: string; success?: boolean }>;
}

function daysLeft(deletedAt: string): number {
  const deletedMs = new Date(deletedAt).getTime();
  const elapsed = Math.floor((Date.now() - deletedMs) / (1000 * 60 * 60 * 24));
  return Math.max(0, 30 - elapsed);
}

function fmtDate(value: string) {
  return new Date(value).toLocaleString("en-GB", {
    timeZone: "Europe/Istanbul",
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function RestoreButton({
  item,
  onRestore,
}: {
  item: AppointmentTrashItem;
  onRestore: AppointmentsRecycleBinProps["onRestore"];
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
          const res = await onRestore(item.id);
          if (res.error) toast.error(res.error);
          else {
            toast.success(`Appointment for ${item.patientName} restored.`);
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
  item,
  onPermanentDelete,
}: {
  item: AppointmentTrashItem;
  onPermanentDelete: AppointmentsRecycleBinProps["onPermanentDelete"];
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
          <AlertDialogTitle>
            Permanently delete this appointment?
          </AlertDialogTitle>
          <AlertDialogDescription>
            This cannot be undone. The appointment for {item.patientName} on{" "}
            {fmtDate(item.scheduledAt)} will be deleted forever.
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
                const res = await onPermanentDelete(item.id);
                if (res.error) toast.error(res.error);
                else {
                  toast.success("Appointment permanently deleted.");
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

function EmptyTrashButton({
  count,
  onEmptyTrash,
}: {
  count: number;
  onEmptyTrash: AppointmentsRecycleBinProps["onEmptyTrash"];
}) {
  const [isPending, start] = useTransition();
  const router = useRouter();
  const pendingRef = useRef(false);

  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="h-7 gap-1.5 border-destructive/30 px-2 text-xs text-destructive hover:text-destructive"
          disabled={isPending}
        >
          {isPending ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Trash2 className="h-3.5 w-3.5" />
          )}
          Empty trash
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Empty appointment recycle bin?</AlertDialogTitle>
          <AlertDialogDescription>
            This will permanently delete {count} appointment
            {count !== 1 ? "s" : ""} already in the recycle bin. Active
            appointments will not be affected.
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
                try {
                  const res = await onEmptyTrash();
                  if (res.error) toast.error(res.error);
                  else {
                    toast.success("Appointment recycle bin emptied.");
                    router.refresh();
                  }
                } finally {
                  pendingRef.current = false;
                }
              })
            }
          >
            {isPending ? (
              <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
            ) : null}
            Empty trash
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function AppointmentsRecycleBin({
  items,
  onRestore,
  onPermanentDelete,
  onEmptyTrash,
}: AppointmentsRecycleBinProps) {
  if (items.length === 0) return null;

  return (
    <div className="overflow-hidden rounded-xl border border-destructive/20 bg-destructive/5">
      <div className="flex items-center gap-2 border-b border-destructive/15 px-4 py-3">
        <Trash2 className="h-4 w-4 text-destructive/70" />
        <h2 className="text-sm font-semibold text-destructive/80">
          Recycle Bin
        </h2>
        <span className="ml-auto rounded-full bg-destructive/10 px-2 py-0.5 text-[11px] font-medium text-destructive/70">
          {items.length} appointment{items.length !== 1 ? "s" : ""}
        </span>
        <EmptyTrashButton count={items.length} onEmptyTrash={onEmptyTrash} />
      </div>
      <p className="px-4 py-2 text-xs text-muted-foreground">
        Appointments are permanently deleted after 30 days. Restore to bring
        them back.
      </p>
      <div className="overflow-x-auto">
        <table className="w-full table-fixed text-sm">
          <colgroup>
            <col />
            <col className="w-44" />
            <col className="w-40" />
            <col className="w-56" />
          </colgroup>
          <thead className="border-b border-destructive/10 bg-destructive/5">
            <tr>
              <th className="px-4 py-2 text-left text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                Patient
              </th>
              <th className="px-4 py-2 text-left text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                Doctor
              </th>
              <th className="px-4 py-2 text-left text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                Date
              </th>
              <th className="px-4 py-2 text-right text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                Actions
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
                      {item.patientName}
                    </p>
                    <p
                      className={`text-xs ${days <= 3 ? "font-semibold text-destructive" : "text-muted-foreground/70"}`}
                    >
                      {days === 0
                        ? "Expires today"
                        : `${days} day${days !== 1 ? "s" : ""} left`}
                    </p>
                  </td>
                  <td className="px-4 py-2.5 text-muted-foreground">
                    {item.doctorName}
                  </td>
                  <td className="px-4 py-2.5 text-xs text-muted-foreground">
                    {fmtDate(item.scheduledAt)}
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    <div className="flex items-center justify-end gap-1">
                      <RestoreButton item={item} onRestore={onRestore} />
                      <PermanentDeleteButton
                        item={item}
                        onPermanentDelete={onPermanentDelete}
                      />
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
