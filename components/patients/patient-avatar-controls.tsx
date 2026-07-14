"use client";

import { useRef, useTransition, type ChangeEvent } from "react";
import { Camera, Loader2, Trash2 } from "lucide-react";
import { toast } from "sonner";
import {
  removePatientAvatar,
  uploadPatientAvatar,
} from "@/actions/patient-avatar";
import { Button } from "@/components/ui/button";
import { useTranslations } from "next-intl";

interface PatientAvatarControlsProps {
  patientId: string;
  hasAvatar: boolean;
}

export function PatientAvatarControls({
  patientId,
  hasAvatar,
}: PatientAvatarControlsProps) {
  const t = useTranslations("patients");
  const inputRef = useRef<HTMLInputElement>(null);
  const [isPending, startTransition] = useTransition();

  function onFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;

    const formData = new FormData();
    formData.set("avatar", file);

    startTransition(async () => {
      const result = await uploadPatientAvatar(patientId, formData);
      if (result.error) toast.error(result.error);
      else toast.success(t("patientAvatarUpdated"));
      event.target.value = "";
    });
  }

  function onRemove() {
    startTransition(async () => {
      const result = await removePatientAvatar(patientId);
      if (result.error) toast.error(result.error);
      else toast.success(t("patientAvatarRemoved"));
    });
  }

  return (
    <div className="flex flex-wrap items-center gap-2 print:hidden">
      <input
        ref={inputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        className="hidden"
        onChange={onFileChange}
      />
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="gap-1.5"
        disabled={isPending}
        onClick={() => inputRef.current?.click()}
      >
        {isPending ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <Camera className="h-3.5 w-3.5" />
        )}
        {t("uploadPhoto")}</Button>
      {hasAvatar && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="gap-1.5 text-destructive hover:text-destructive"
          disabled={isPending}
          onClick={onRemove}
        >
          <Trash2 className="h-3.5 w-3.5" />
          {t("remove")}</Button>
      )}
    </div>
  );
}
