"use client";

import {
  useRef,
  useState,
  useTransition,
  type ChangeEvent,
} from "react";
import { Eye, FileText, Loader2, Trash2, Upload } from "lucide-react";
import { toast } from "sonner";
import {
  deleteMedicalNoteAttachment,
  getMedicalNoteAttachmentSignedUrl,
  restoreMedicalNoteAttachment,
  uploadMedicalNoteAttachment,
  type MedicalNoteAttachmentItem,
} from "@/actions/medical-note-attachments";
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

const ACCEPTED_ATTACHMENTS = "application/pdf,image/jpeg,image/png,image/webp";

function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 KB";
  const units = ["B", "KB", "MB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function formatMime(type: string) {
  if (type === "application/pdf") return "PDF";
  if (type === "image/jpeg") return "JPG";
  if (type === "image/png") return "PNG";
  if (type === "image/webp") return "WebP";
  return "File";
}

function formatDate(value: string) {
  return new Date(value).toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

interface MedicalNoteAttachmentsProps {
  patientId: string;
  noteId: string;
  noteAuthorId: string | null;
  currentUserId: string;
  canManageAllAttachments: boolean;
  initialAttachments: MedicalNoteAttachmentItem[];
}

export function MedicalNoteAttachments({
  patientId,
  noteId,
  noteAuthorId,
  currentUserId,
  canManageAllAttachments,
  initialAttachments,
}: MedicalNoteAttachmentsProps) {
  const [attachments, setAttachments] = useState(initialAttachments);
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const inputRef = useRef<HTMLInputElement>(null);

  function canDelete(attachment: MedicalNoteAttachmentItem) {
    return (
      canManageAllAttachments ||
      attachment.uploadedById === currentUserId ||
      noteAuthorId === currentUserId
    );
  }

  function onUpload(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;

    const formData = new FormData();
    formData.set("file", file);
    setPendingKey("upload");

    startTransition(async () => {
      const result = await uploadMedicalNoteAttachment(
        patientId,
        noteId,
        formData,
      );
      if (result.error) {
        toast.error(result.error);
      } else {
        if (result.data) setAttachments(result.data);
        toast.success("Attachment uploaded.");
      }
      event.target.value = "";
      setPendingKey(null);
    });
  }

  function onView(attachment: MedicalNoteAttachmentItem) {
    setPendingKey(`view:${attachment.id}`);
    startTransition(async () => {
      const result = await getMedicalNoteAttachmentSignedUrl(
        patientId,
        noteId,
        attachment.id,
      );
      if (result.error) {
        toast.error(result.error);
      } else if (result.data?.url) {
        window.open(result.data.url, "_blank", "noopener,noreferrer");
      }
      setPendingKey(null);
    });
  }

  function onDelete(attachment: MedicalNoteAttachmentItem) {
    setPendingKey(`delete:${attachment.id}`);
    startTransition(async () => {
      const result = await deleteMedicalNoteAttachment(
        patientId,
        noteId,
        attachment.id,
      );
      if (result.error) {
        toast.error(result.error);
      } else {
        if (result.data) setAttachments(result.data);
        toast.success("Attachment moved to trash.", {
          duration: 15000,
          action: {
            label: "Undo",
            onClick: async () => {
              const restored = await restoreMedicalNoteAttachment(
                patientId,
                noteId,
                attachment.id,
              );
              if (restored.error) {
                toast.error(restored.error);
                return;
              }
              if (restored.data) setAttachments(restored.data);
              toast.success("Attachment restored.");
            },
          },
        });
      }
      setPendingKey(null);
    });
  }

  return (
    <div
      className="mt-3 rounded-lg border border-border/40 bg-muted/10 p-3"
      data-medical-note-attachments
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2 text-xs font-medium text-muted-foreground">
          <FileText className="h-3.5 w-3.5" />
          <span>
            {attachments.length} attachment
            {attachments.length !== 1 ? "s" : ""}
          </span>
        </div>
        <input
          ref={inputRef}
          type="file"
          aria-label="Upload medical note attachment"
          accept={ACCEPTED_ATTACHMENTS}
          className="hidden"
          onChange={onUpload}
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7 gap-1.5 px-2 text-xs"
          disabled={isPending}
          onClick={() => inputRef.current?.click()}
        >
          {pendingKey === "upload" ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Upload className="h-3.5 w-3.5" />
          )}
          Attach file
        </Button>
      </div>

      {attachments.length > 0 && (
        <ul className="mt-2 divide-y divide-border/30 rounded-md border border-border/30 bg-background/50">
          {attachments.map((attachment) => {
            const viewPending = pendingKey === `view:${attachment.id}`;
            const deletePending = pendingKey === `delete:${attachment.id}`;
            return (
              <li
                key={attachment.id}
                className="flex flex-col gap-2 px-3 py-2 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="min-w-0 space-y-1">
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    <p className="min-w-0 truncate text-xs font-medium">
                      {attachment.fileName}
                    </p>
                    <Badge variant="secondary" className="text-[10px]">
                      {formatMime(attachment.mimeType)}
                    </Badge>
                  </div>
                  <p className="text-[11px] text-muted-foreground">
                    {formatBytes(attachment.sizeBytes)} · Uploaded{" "}
                    {formatDate(attachment.createdAt)}
                    {attachment.uploadedByName
                      ? ` by ${attachment.uploadedByName}`
                      : ""}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-7 gap-1 px-2 text-xs"
                    aria-label={`View ${attachment.fileName}`}
                    disabled={isPending}
                    onClick={() => onView(attachment)}
                  >
                    {viewPending ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Eye className="h-3.5 w-3.5" />
                    )}
                    View
                  </Button>
                  {canDelete(attachment) && (
                    <DeleteAttachmentDialog
                      attachment={attachment}
                      disabled={isPending}
                      pending={deletePending}
                      onDelete={onDelete}
                    />
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function DeleteAttachmentDialog({
  attachment,
  disabled,
  pending,
  onDelete,
}: {
  attachment: MedicalNoteAttachmentItem;
  disabled: boolean;
  pending: boolean;
  onDelete: (attachment: MedicalNoteAttachmentItem) => void;
}) {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7 gap-1 px-2 text-xs text-destructive hover:text-destructive"
          aria-label={`Delete ${attachment.fileName}`}
          disabled={disabled}
        >
          <Trash2 className="h-3.5 w-3.5" />
          Delete
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete attachment?</AlertDialogTitle>
          <AlertDialogDescription>
            This removes {attachment.fileName} from the medical note.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={() => onDelete(attachment)}
            disabled={pending}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90 gap-2"
          >
            {pending && <Loader2 className="h-4 w-4 animate-spin" />}
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
