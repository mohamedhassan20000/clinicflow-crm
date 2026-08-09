"use client";

import { useActionState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Send } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { addMedicalNote } from "@/actions/patients";
import { useTranslations } from "next-intl";

interface NoteComposerProps {
  patientId: string;
  appointmentId?: string | null;
}

export function NoteComposer({ patientId, appointmentId }: NoteComposerProps) {
  const t = useTranslations("patients");
  const [state, formAction, isPending] = useActionState(addMedicalNote, null);
  const formRef = useRef<HTMLFormElement>(null);
  const router = useRouter();

  useEffect(() => {
    if (state && !state.error && !state.fieldErrors) {
      formRef.current?.reset();
      toast.success(t("noteSaved"));
      router.refresh();
    }
    if (state?.error) {
      toast.error(state.error);
    }
  }, [router, state]);

  return (
    <form ref={formRef} action={formAction} className="space-y-3">
      <input type="hidden" name="patient_id" value={patientId} />
      {appointmentId && (
        <input type="hidden" name="appointment_id" value={appointmentId} />
      )}
      <Textarea
        name="note"
        placeholder={t("writeAMedicalNote")}
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
            <Send className="h-3.5 w-3.5 rtl:-scale-x-100" />
          )}
          {t("addNote")}</Button>
      </div>
    </form>
  );
}
