"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import Image from "next/image";
import { Loader2, Save, Upload, X } from "lucide-react";
import { toast } from "sonner";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  getClinicianSignatureUrl,
  saveClinicianCredentials,
} from "@/actions/clinical/credentials";
import { clinicianCredentialsSchema } from "@/lib/validations/clinical";

type Props = {
  staffId: string;
  initial: {
    professionalLicenseNo: string | null;
    specialty: string | null;
    professionalTitle: string | null;
    signatureUrl?: string | null;
    hasSignature?: boolean;
  };
  readOnly?: boolean;
};

export function ClinicianCredentialsForm({ staffId, initial, readOnly = false }: Props) {
  return (
    <ClinicianCredentialsFormState
      key={staffId}
      staffId={staffId}
      initial={initial}
      readOnly={readOnly}
    />
  );
}

function ClinicianCredentialsFormState({ staffId, initial, readOnly = false }: Props) {
  const t = useTranslations("clinical");
  const fileRef = useRef<HTMLInputElement>(null);
  const [pending, startTransition] = useTransition();
  const [license, setLicense] = useState(initial.professionalLicenseNo ?? "");
  const [specialty, setSpecialty] = useState(initial.specialty ?? "");
  const [title, setTitle] = useState(initial.professionalTitle ?? "");
  const [signatureUrl, setSignatureUrl] = useState(initial.signatureUrl ?? null);
  const [pendingSignature, setPendingSignature] = useState<File | null | undefined>(undefined);
  const [pendingSignatureUrl, setPendingSignatureUrl] = useState<string | null>(null);
  const pendingSignatureUrlRef = useRef<string | null>(null);

  useEffect(() => {
    let active = true;
    if (initial.hasSignature && !initial.signatureUrl) {
      getClinicianSignatureUrl(staffId).then((result) => {
        if (active && result.url) setSignatureUrl(result.url);
      });
    }
    return () => { active = false; };
  }, [initial.hasSignature, initial.signatureUrl, staffId]);

  useEffect(() => {
    return () => {
      if (pendingSignatureUrlRef.current) URL.revokeObjectURL(pendingSignatureUrlRef.current);
    };
  }, []);

  function stageSignature(file: File | undefined) {
    if (!file) return;
    if (pendingSignatureUrlRef.current) URL.revokeObjectURL(pendingSignatureUrlRef.current);
    const url = URL.createObjectURL(file);
    pendingSignatureUrlRef.current = url;
    setPendingSignatureUrl(url);
    setPendingSignature(file);
  }

  function stageSignatureRemoval() {
    if (pendingSignatureUrlRef.current) URL.revokeObjectURL(pendingSignatureUrlRef.current);
    pendingSignatureUrlRef.current = null;
    setPendingSignatureUrl(null);
    setPendingSignature(null);
  }

  function save() {
    const parsed = clinicianCredentialsSchema.safeParse({
      professional_license_no: license,
      specialty,
      professional_title: title,
    });
    if (!parsed.success) {
      toast.error(t("validationError"));
      return;
    }
    const formData = new FormData();
    formData.set("professional_license_no", parsed.data.professional_license_no ?? "");
    formData.set("specialty", parsed.data.specialty ?? "");
    formData.set("professional_title", parsed.data.professional_title ?? "");
    formData.set(
      "signature_action",
      pendingSignature === undefined ? "keep" : pendingSignature === null ? "remove" : "replace",
    );
    if (pendingSignature instanceof File) formData.set("signature", pendingSignature);
    startTransition(async () => {
      const result = await saveClinicianCredentials(staffId, formData);
      if (result.error) toast.error(result.error);
      else {
        setSignatureUrl(result.data?.signatureUrl ?? null);
        if (pendingSignatureUrlRef.current) URL.revokeObjectURL(pendingSignatureUrlRef.current);
        pendingSignatureUrlRef.current = null;
        setPendingSignatureUrl(null);
        setPendingSignature(undefined);
        toast.success(t("credentialsSaved"));
      }
    });
  }

  const displayedSignatureUrl = pendingSignature === null
    ? null
    : pendingSignatureUrl ?? signatureUrl;

  return (
    <section className="space-y-4 rounded-xl border border-border/50 bg-card p-5">
      <div>
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          {t("clinicianCredentials")}
        </h2>
        <p className="mt-1 text-xs text-muted-foreground">{t("credentialsDescription")}</p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor={`clinical-license-${staffId}`}>{t("professionalLicense")}</Label>
          <Input id={`clinical-license-${staffId}`} value={license} onChange={(event) => setLicense(event.target.value)} disabled={pending || readOnly} maxLength={120} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`clinical-specialty-${staffId}`}>{t("specialty")}</Label>
          <Input id={`clinical-specialty-${staffId}`} value={specialty} onChange={(event) => setSpecialty(event.target.value)} disabled={pending || readOnly} maxLength={160} />
        </div>
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor={`clinical-title-${staffId}`}>{t("professionalTitle")}</Label>
          <Input id={`clinical-title-${staffId}`} value={title} onChange={(event) => setTitle(event.target.value)} disabled={pending || readOnly} maxLength={160} />
        </div>
      </div>
      <div className="space-y-2">
        <Label>{t("signatureStamp")}</Label>
        {displayedSignatureUrl ? (
          <div className="flex items-center gap-3 rounded-lg border p-3">
            <Image src={displayedSignatureUrl} alt={t("signatureStamp")} width={160} height={80} unoptimized className="h-20 w-40 object-contain" />
            {!readOnly && <Button type="button" variant="outline" size="sm" onClick={stageSignatureRemoval} disabled={pending}><X className="size-4" />{t("remove")}</Button>}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">{t("noSignatureStored")}</p>
        )}
        {!readOnly && (
          <>
            <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={(event) => stageSignature(event.target.files?.[0])} />
            <div className="flex flex-wrap items-center gap-2">
              <Button type="button" variant="outline" className="max-w-full whitespace-normal" onClick={() => fileRef.current?.click()} disabled={pending}><Upload className="size-4" />{t("uploadSignature")}</Button>
              <Button type="button" className="max-w-full whitespace-normal" onClick={save} disabled={pending}><>{pending ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}{t("saveCredentials")}</></Button>
            </div>
          </>
        )}
      </div>
    </section>
  );
}
