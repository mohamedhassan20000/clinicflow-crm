import { FileText } from "lucide-react";
import type { Tables } from "@/types/database";

type MedicalNote = Tables<"medical_notes"> & {
  profiles: { full_name: string } | null;
};

interface MedicalNotesListProps {
  notes: MedicalNote[];
}

export function MedicalNotesList({ notes }: MedicalNotesListProps) {
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
      {notes.map((note) => (
        <div
          key={note.id}
          className="rounded-xl border border-border/50 bg-card p-4 space-y-2"
        >
          <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
            <span className="font-medium text-foreground/80">
              {note.profiles?.full_name ?? "Unknown doctor"}
            </span>
            <time dateTime={note.created_at}>
              {new Date(note.created_at).toLocaleString("en-GB", {
                dateStyle: "medium",
                timeStyle: "short",
              })}
            </time>
          </div>
          <p className="text-sm leading-relaxed whitespace-pre-wrap text-foreground">
            {note.note}
          </p>
        </div>
      ))}
    </div>
  );
}
