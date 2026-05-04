"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { FileText, Loader2, Pencil, Trash2 } from "lucide-react";
import { toast } from "sonner";
import type { Tables } from "@/types/database";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  deleteMedicalNote,
  restoreMedicalNote,
  updateMedicalNote,
} from "@/actions/patients";

type MedicalNote = Tables<"medical_notes"> & {
  profiles: { full_name: string } | null;
};

interface MedicalNotesListProps {
  notes: MedicalNote[];
}

export function MedicalNotesList({ notes }: MedicalNotesListProps) {
  const router = useRouter();
  const [hiddenIds, setHiddenIds] = useState<Set<string>>(new Set());
  const [editingId, setEditingId] = useState<string | null>(null);
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
            <div className="flex items-center gap-1">
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
                onClick={() =>
                  startTransition(async () => {
                    const res = await deleteMedicalNote(note.id);
                    if (res.error || !res.note) {
                      toast.error(res.error ?? "Failed to delete note.");
                      return;
                    }
                    setHiddenIds((prev) => new Set(prev).add(note.id));
                    toast.success("Medical note deleted.", {
                      duration: 10000,
                      action: {
                        label: "Undo",
                        onClick: async () => {
                          const restored = await restoreMedicalNote(res.note!);
                          if (restored.error) toast.error(restored.error);
                          else {
                            setHiddenIds((prev) => {
                              const next = new Set(prev);
                              next.delete(note.id);
                              return next;
                            });
                            router.refresh();
                          }
                        },
                      },
                    });
                  })
                }
              >
                {isPending ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Trash2 className="h-3.5 w-3.5" />
                )}
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
        </div>
      ))}
    </div>
  );
}
