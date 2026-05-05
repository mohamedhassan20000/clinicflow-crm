"use client";

import { useActionState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Send } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { addMedicalNote } from "@/actions/patients";

interface NoteComposerProps {
  patientId: string;
}

export function NoteComposer({ patientId }: NoteComposerProps) {
  const [state, formAction, isPending] = useActionState(addMedicalNote, null);
  const formRef = useRef<HTMLFormElement>(null);
  const router = useRouter();

  useEffect(() => {
    if (state && !state.error && !state.fieldErrors) {
      formRef.current?.reset();
      toast.success("Note saved.");
      router.refresh();
    }
    if (state?.error) {
      toast.error(state.error);
    }
  }, [router, state]);

  return (
    <form ref={formRef} action={formAction} className="space-y-3">
      <input type="hidden" name="patient_id" value={patientId} />
      <Textarea
        name="note"
        placeholder="Write a medical note…"
        rows={4}
        disabled={isPending}
        className="resize-none text-sm"
        required
      />
      {state?.fieldErrors?.note && (
        <p className="text-xs text-destructive">{state.fieldErrors.note[0]}</p>
      )}
      <div className="flex justify-end">
        <Button type="submit" size="sm" disabled={isPending} className="gap-2">
          {isPending ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Send className="h-3.5 w-3.5" />
          )}
          Add note
        </Button>
      </div>
    </form>
  );
}
