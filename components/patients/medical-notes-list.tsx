"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { FileText, Pencil, Trash2 } from "lucide-react";
import { toast } from "sonner";
import type { Tables } from "@/types/database";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  deleteMedicalNote,
  restoreMedicalNote,
  updateMedicalNote,
} from "@/actions/patients";
import { MedicalNoteAttachments } from "@/components/patients/medical-note-attachments";
import type { MedicalNoteAttachmentItem } from "@/actions/medical-note-attachments";

export type MedicalNoteWithAttachments = Tables<"medical_notes"> & {
  profiles: { full_name: string } | null;
  attachments?: MedicalNoteAttachmentItem[];
};

interface MedicalNotesListProps {
  notes: MedicalNoteWithAttachments[];
  patientId: string;
  currentUserId: string;
  canManageAllAttachments: boolean;
}

export function MedicalNotesList({
  notes,
  patientId,
  currentUserId,
  canManageAllAttachments,
}: MedicalNotesListProps) {
  const router = useRouter();
  const [hiddenIds, setHiddenIds] = useState<Set<string>>(new Set());
  const [editingId, setEditingId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [isPending, startTransition] = useTransition();

  if (notes.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border py-12 text-center">
        <FileText className="mb-2 h-8 w-8 text-muted-foreground/40" />
        <p className="text-sm text-muted-foreground">No medical notes yet.</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {notes.filter((note) => !hiddenIds.has(note.id)).map((note) => (
        <div
          key={note.id}
          className="rounded-xl border border-border/50 bg-card p-4 space-y-2"
        >
          <div className="flex items-start justify-between gap-2 text-xs text-muted-foreground">
            <div>
              <span className="font-medium text-foreground/80">
                {note.profiles?.full_name ?? "Unknown doctor"}
              </span>
              <time className="ml-2" dateTime={note.created_at}>
                {new Date(note.created_at).toLocaleString("en-GB", {
                  dateStyle: "medium",
                  timeStyle: "short",
                })}
              </time>
            </div>
            <div className="flex items-center gap-1 print:hidden">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 gap-1 px-2 text-xs"
                disabled={isPending}
                onClick={() => {
                  setEditingId(note.id);
                  setDraft(note.note);
                }}
              >
                <Pencil className="h-3.5 w-3.5" />
                Edit
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 gap-1 px-2 text-xs text-destructive hover:text-destructive"
                disabled={isPending}
                onClick={() => setConfirmDeleteId(note.id)}
              >
                <Trash2 className="h-3.5 w-3.5" />
                Delete
              </Button>
            </div>
          </div>
          {editingId === note.id ? (
            <div className="space-y-2">
              <Textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                rows={4}
                disabled={isPending}
                className="resize-none text-sm"
              />
              <div className="flex justify-end gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={isPending}
                  onClick={() => setEditingId(null)}
                >
                  Cancel
                </Button>
                <Button
                  type="button"
                  size="sm"
                  disabled={isPending || !draft.trim()}
                  onClick={() =>
                    startTransition(async () => {
                      const res = await updateMedicalNote(note.id, draft);
                      if (res.error) toast.error(res.error);
                      else {
                        toast.success("Medical note updated.");
                        setEditingId(null);
                        router.refresh();
                      }
                    })
                  }
                >
                  Save
                </Button>
              </div>
            </div>
          ) : (
            <p className="text-sm leading-relaxed whitespace-pre-wrap text-foreground">
              {note.note}
            </p>
          )}
          <MedicalNoteAttachments
            patientId={patientId}
            noteId={note.id}
            noteAuthorId={note.created_by}
            currentUserId={currentUserId}
            canManageAllAttachments={canManageAllAttachments}
            initialAttachments={note.attachments ?? []}
          />
        </div>
      ))}

      <AlertDialog
        open={confirmDeleteId !== null}
        onOpenChange={(open) => { if (!open) setConfirmDeleteId(null); }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Move note to trash?</AlertDialogTitle>
            <AlertDialogDescription>
              This medical note will be moved to trash. You can restore it using
              the undo action that appears immediately after deletion.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={isPending}
              onClick={(e) => {
                e.preventDefault();
                const id = confirmDeleteId;
                if (!id) return;
                setConfirmDeleteId(null);
                startTransition(async () => {
                  const res = await deleteMedicalNote(id);
                  if (res.error) {
                    toast.error(res.error ?? "Failed to delete note.");
                    return;
                  }
                  setHiddenIds((prev) => new Set(prev).add(id));
                  toast.success("Medical note moved to trash.", {
                    duration: 15000,
                    action: {
                      label: "Undo",
                      onClick: async () => {
                        const restore = await restoreMedicalNote(id);
                        if (restore.error) {
                          toast.error(restore.error);
                          return;
                        }
                        setHiddenIds((prev) => {
                          const next = new Set(prev);
                          next.delete(id);
                          return next;
                        });
                        toast.success("Medical note restored.");
                        router.refresh();
                      },
                    },
                  });
                  router.refresh();
                });
              }}
            >
              Move to trash
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
