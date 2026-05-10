"use client";

import { Maximize2 } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

interface PatientAvatarPreviewProps {
  avatarUrl: string | null;
  fullName: string;
  initials: string;
}

export function PatientAvatarPreview({
  avatarUrl,
  fullName,
  initials,
}: PatientAvatarPreviewProps) {
  const avatar = (
    <Avatar className="h-14 w-14 print:h-20 print:w-20">
      {avatarUrl && (
        <AvatarImage src={avatarUrl} alt={`${fullName} avatar`} />
      )}
      <AvatarFallback className="bg-primary/10 text-base font-semibold text-primary print:bg-primary/15 print:text-primary">
        {initials || "?"}
      </AvatarFallback>
    </Avatar>
  );

  if (!avatarUrl) return avatar;

  return (
    <Dialog>
      <DialogTrigger asChild>
        <button
          type="button"
          className="group relative rounded-full outline-none transition focus-visible:ring-3 focus-visible:ring-ring/50 print:pointer-events-none"
          aria-label={`Preview ${fullName} avatar`}
        >
          {avatar}
          <span className="absolute -right-1 -bottom-1 flex h-5 w-5 items-center justify-center rounded-full border border-border bg-background text-muted-foreground shadow-sm transition group-hover:text-foreground print:hidden">
            <Maximize2 className="h-3 w-3" />
          </span>
        </button>
      </DialogTrigger>
      <DialogContent
        className="max-w-[calc(100%-2rem)] p-3 sm:max-w-2xl"
        aria-describedby="patient-avatar-preview-description"
      >
        <DialogTitle>{fullName}</DialogTitle>
        <DialogDescription
          id="patient-avatar-preview-description"
          className="sr-only"
        >
          Patient photo preview
        </DialogDescription>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={avatarUrl}
          alt={`${fullName} full-size avatar`}
          className="max-h-[75vh] w-full rounded-lg object-contain"
        />
      </DialogContent>
    </Dialog>
  );
}
