"use client";

import { useRef, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, RotateCcw, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
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
import { DEFAULT_TIME_ZONE } from "@/lib/datetime";
import { useTranslations } from "next-intl";

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
    timeZone: DEFAULT_TIME_ZONE,
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
  const t = useTranslations("appointments");
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
            toast.success(t("appointmentRestoredForPatient", { patient: item.patientName }));
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
      {t("restore")}</Button>
  );
}

function PermanentDeleteButton({
  item,
  onPermanentDelete,
}: {
  item: AppointmentTrashItem;
  onPermanentDelete: AppointmentsRecycleBinProps["onPermanentDelete"];
}) {
  const t = useTranslations("appointments");
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
          {t("deletePermanently2")}</Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {t("permanentlyDeleteThisAppointment")}</AlertDialogTitle>
          <AlertDialogDescription>
            {t("permanentDeleteAppointmentDescription", { patient: item.patientName, date: fmtDate(item.scheduledAt) })}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isPending}>{t("cancel")}</AlertDialogCancel>
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
                  toast.success(t("appointmentPermanentlyDeleted"));
                  router.refresh();
                }
                pendingRef.current = false;
              })
            }
          >
            {t("deletePermanently")}</AlertDialogAction>
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
  const t = useTranslations("appointments");
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
          {t("emptyTrash")}</Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("emptyAppointmentRecycleBin")}</AlertDialogTitle>
          <AlertDialogDescription>
            {t("emptyTrashAppointmentDescription", { count })}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isPending}>{t("cancel")}</AlertDialogCancel>
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
                    toast.success(t("appointmentRecycleBinEmptied"));
                    router.refresh();
                  }
                } finally {
                  pendingRef.current = false;
                }
              })
            }
          >
            {isPending ? (
              <Loader2 className="me-2 h-3.5 w-3.5 animate-spin" />
            ) : null}
            {t("emptyTrash")}</AlertDialogAction>
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
  const t = useTranslations("appointments");
  if (items.length === 0) return null;

  return (
    <div className="overflow-hidden rounded-xl border border-destructive/20 bg-destructive/5">
      <div className="flex items-center gap-2 border-b border-destructive/15 px-4 py-3">
        <Trash2 className="h-4 w-4 text-destructive/70" />
        <h2 className="text-sm font-semibold text-destructive/80">
          {t("recycleBin")}</h2>
        <span className="ms-auto rounded-full bg-destructive/10 px-2 py-0.5 text-[11px] font-medium text-destructive/70">
          {t("appointmentCount", { count: items.length })}
        </span>
        <EmptyTrashButton count={items.length} onEmptyTrash={onEmptyTrash} />
      </div>
      <p className="px-4 py-2 text-xs text-muted-foreground">
        {t("appointmentsArePermanentlyDeletedAfter30")}</p>
      <Table className="table-fixed">
        <colgroup>
          <col />
          <col className="w-44" />
          <col className="w-40" />
          <col className="w-56" />
        </colgroup>
        <TableHeader className="[&_tr]:border-b-2 [&_tr]:border-destructive/10 bg-destructive/5">
          <TableRow>
            <TableHead>{t("patient")}</TableHead>
            <TableHead>{t("doctor")}</TableHead>
            <TableHead>{t("date")}</TableHead>
            <TableHead className="text-end">{t("actions")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((item) => {
            const days = daysLeft(item.deletedAt);
            return (
              <TableRow key={item.id}>
                <TableCell className="max-w-0">
                  <p className="truncate font-medium text-muted-foreground line-through decoration-destructive/40">
                    {item.patientName}
                  </p>
                  <p
                    className={`text-xs ${days <= 3 ? "font-semibold text-destructive" : "text-muted-foreground/70"}`}
                  >
                    {days === 0
                      ? t("expirestoday")
                      : t("daysLeft", { days })}
                  </p>
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {item.doctorName}
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {fmtDate(item.scheduledAt)}
                </TableCell>
                <TableCell className="text-end">
                  <div className="flex items-center justify-end gap-1">
                    <RestoreButton item={item} onRestore={onRestore} />
                    <PermanentDeleteButton
                      item={item}
                      onPermanentDelete={onPermanentDelete}
                    />
                  </div>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
