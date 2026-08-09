"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
  Camera,
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  Save,
  Trash2,
  Upload,
  User,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { InternationalPhoneInput } from "@/components/shared/international-phone-input";
import { cn } from "@/lib/utils";
import {
  changeMyPassword,
  removeAvatar,
  updateProfile,
  uploadAvatar,
} from "@/actions/profile";
import { useTranslations } from "next-intl";
import { useClinicSettings } from "@/contexts/clinic-settings-context";
import { ClinicianCredentialsForm } from "@/components/clinical/clinician-credentials-form";

interface ProfileData {
  id: string;
  full_name: string;
  phone: string | null;
  avatar_url: string | null;
  role: string;
  email: string;
  created_at: string;
  professional_license_no?: string | null;
  specialty?: string | null;
  professional_title?: string | null;
  signature_path?: string | null;
  department: { name: string; color: string } | null;
}

export function ProfilePage({ profile }: { profile: ProfileData }) {
  const t = useTranslations("profile");
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{t("myProfile")}</h1>
        <p className="text-sm text-muted-foreground">
          {t("updateYourPhotoPersonalDetailsAnd")}</p>
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <ProfileCard profile={profile} />
        <div className="space-y-6 lg:col-span-2">
          <DetailsForm profile={profile} />
          {profile.role === "doctor" && (
            <ClinicianCredentialsForm
              staffId={profile.id}
              initial={{
                professionalLicenseNo: profile.professional_license_no ?? null,
                specialty: profile.specialty ?? null,
                professionalTitle: profile.professional_title ?? null,
                hasSignature: Boolean(profile.signature_path),
              }}
            />
          )}
          <PasswordForm />
        </div>
      </div>
    </div>
  );
}

function initials(name: string) {
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? "")
    .join("");
}

function ProfileCard({ profile }: { profile: ProfileData }) {
  const t = useTranslations("profile");
  const { formatDate } = useClinicSettings();
  const fileRef = useRef<HTMLInputElement>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [avatarRemoved, setAvatarRemoved] = useState(false);
  const [state, formAction, isPending] = useActionState(uploadAvatar, null);
  const [removeState, removeAction, isRemoving] = useActionState(
    removeAvatar,
    null,
  );
  const handledRef = useRef(state);
  const removeHandledRef = useRef(removeState);

  useEffect(() => {
    if (!state || handledRef.current === state) return;
    handledRef.current = state;
    if (state.error) toast.error(state.error);
    else if (state.ok) {
      toast.success(t("profilePhotoUpdated"));
      queueMicrotask(() => {
        setAvatarRemoved(false);
        setPreviewUrl(null);
      });
    }
  }, [state]);

  useEffect(() => {
    if (!removeState || removeHandledRef.current === removeState) return;
    removeHandledRef.current = removeState;
    if (removeState.error) toast.error(removeState.error);
    else if (removeState.ok) {
      toast.success(t("profilePhotoRemoved"));
      queueMicrotask(() => {
        setPreviewUrl(null);
        setAvatarRemoved(true);
      });
    }
  }, [removeState]);

  function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.currentTarget.files?.[0];
    if (!file) return;
    setPreviewUrl(URL.createObjectURL(file));
    // Submit immediately — keeps the flow tight.
    e.currentTarget.form?.requestSubmit();
  }

  const avatar = previewUrl ?? (avatarRemoved ? null : profile.avatar_url);
  const avatarActionPending = isPending || isRemoving;

  return (
    <div className="space-y-4 rounded-xl border border-border/50 bg-card p-5">
      <form action={formAction} className="flex flex-col items-center gap-3">
        <div className="relative">
          <Avatar
            className={cn(
              "h-32 w-32 border-4 border-background bg-primary/10 text-3xl font-semibold text-primary shadow-sm ring-1 ring-border/40 after:hidden",
            )}
          >
            {avatar && (
              <AvatarImage
                src={avatar}
                alt={profile.full_name}
                className={cn(
                  avatarActionPending && "opacity-60",
                )}
              />
            )}
            <AvatarFallback className="bg-primary/10 text-3xl font-semibold text-primary">
              {initials(profile.full_name) || "?"}
            </AvatarFallback>
            {avatarActionPending && (
              <span className="absolute inset-0 z-30 flex items-center justify-center bg-background/40">
                <Loader2 className="h-6 w-6 animate-spin text-primary" />
              </span>
            )}
          </Avatar>
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            disabled={avatarActionPending}
            className="absolute bottom-1 end-1 inline-flex h-9 w-9 items-center justify-center rounded-full border-2 border-background bg-primary text-primary-foreground shadow-md transition-transform hover:scale-105 active:scale-95 disabled:opacity-60"
            aria-label={t("changeProfilePhoto")}
          >
            <Camera className="h-4 w-4" />
          </button>
        </div>
        <input
          ref={fileRef}
          type="file"
          name="avatar"
          accept="image/jpeg,image/png,image/webp,image/gif"
          className="hidden"
          onChange={onPick}
        />
        <div className="flex flex-wrap justify-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="gap-1.5"
            disabled={avatarActionPending}
            onClick={() => fileRef.current?.click()}
          >
            <Upload className="h-3.5 w-3.5" />
            {isPending ? t("uploading") : t("uploadnewphoto")}
          </Button>
        </div>
        <p className="text-center text-[11px] text-muted-foreground">
          {t("jpegPngWebpGifUpTo")}</p>
      </form>
      {avatar && (
        <form action={removeAction} className="flex justify-center">
          <Button
            type="submit"
            variant="ghost"
            size="sm"
            className="gap-1.5 text-muted-foreground hover:text-destructive"
            disabled={avatarActionPending}
          >
            {isRemoving ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Trash2 className="h-3.5 w-3.5" />
            )}
            {t("removePhoto")}</Button>
        </form>
      )}

      <div className="space-y-2 border-t border-border/40 pt-4 text-sm">
        <div>
          <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            {t("fullName")}</p>
          <p className="font-medium">{profile.full_name}</p>
        </div>
        <div>
          <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            {t("email")}</p>
          <p className="break-all text-sm">{profile.email}</p>
        </div>
        <div>
          <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            {t("role")}</p>
          <p className="capitalize">{profile.role}</p>
        </div>
        {profile.department && (
          <div>
            <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
              {t("department")}</p>
            <p className="inline-flex items-center gap-1.5">
              <span
                aria-hidden
                className="h-2 w-2 rounded-full"
                style={{ backgroundColor: profile.department.color }}
              />
              {profile.department.name}
            </p>
          </div>
        )}
        <div>
          <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            {t("joined")}</p>
          <p>{formatDate(profile.created_at)}</p>
        </div>
      </div>
    </div>
  );
}

function DetailsForm({ profile }: { profile: ProfileData }) {
  const t = useTranslations("profile");
  const [state, formAction, isPending] = useActionState(updateProfile, null);
  const [fullName, setFullName] = useState(profile.full_name);
  const [phone, setPhone] = useState(profile.phone ?? "");
  const handledRef = useRef(state);

  useEffect(() => {
    if (!state || handledRef.current === state) return;
    handledRef.current = state;
    if (state.error) toast.error(state.error);
    else if (state.ok) toast.success(t("profileUpdated"));
  }, [state]);

  return (
    <form
      action={formAction}
      className="space-y-4 rounded-xl border border-border/50 bg-card p-5"
    >
      <div className="flex items-center gap-2">
        <User className="h-4 w-4 text-muted-foreground" />
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          {t("personalDetails")}</h2>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="profile-name" className="text-xs">
            {t("fullName")}</Label>
          <Input
            id="profile-name"
            name="full_name"
            value={fullName}
            disabled={isPending}
            onChange={(e) => setFullName(e.target.value)}
            placeholder={t("janeDoe")}
            maxLength={100}
            required
          />
          {state?.fieldErrors?.full_name && (
            <p className="text-xs text-destructive">
              {state.fieldErrors.full_name[0]}
            </p>
          )}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="profile-phone" className="text-xs">
            {t("phone")}</Label>
          <InternationalPhoneInput id="profile-phone" name="phone" value={phone} disabled={isPending} onChange={setPhone} />
          {state?.fieldErrors?.phone && (
            <p className="text-xs text-destructive">
              {state.fieldErrors.phone[0]}
            </p>
          )}
        </div>
      </div>

      <div className="flex justify-end">
        <Button type="submit" disabled={isPending} className="gap-1.5">
          {isPending ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Save className="h-3.5 w-3.5" />
          )}
          {t("saveChanges")}</Button>
      </div>
    </form>
  );
}

function PasswordForm() {
  const t = useTranslations("profile");
  const [state, formAction, isPending] = useActionState(changeMyPassword, null);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [showPwd, setShowPwd] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const handledRef = useRef(state);

  useEffect(() => {
    if (!state || handledRef.current === state) return;
    handledRef.current = state;
    if (state.error) toast.error(state.error);
    else if (state.ok) {
      toast.success(t("passwordUpdated"));
      queueMicrotask(() => {
        setPassword("");
        setConfirm("");
      });
    }
  }, [state]);

  return (
    <form
      action={formAction}
      className="space-y-4 rounded-xl border border-border/50 bg-card p-5"
    >
      <div className="flex items-center gap-2">
        <KeyRound className="h-4 w-4 text-muted-foreground" />
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          {t("changePassword")}</h2>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="profile-pwd" className="text-xs">
            {t("newPassword")}</Label>
          <div className="relative">
            <Input
              id="profile-pwd"
              name="password"
              type={showPwd ? "text" : "password"}
              value={password}
              disabled={isPending}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              autoComplete="new-password"
              className="pe-10"
              minLength={8}
              required
            />
            <button
              type="button"
              onClick={() => setShowPwd((v) => !v)}
              disabled={isPending}
              aria-label={showPwd ? t("hidepassword") : t("showpassword")}
              className="absolute end-3 top-1/2 -translate-y-1/2 text-muted-foreground transition-colors hover:text-foreground"
            >
              {showPwd ? (
                <EyeOff className="h-4 w-4" />
              ) : (
                <Eye className="h-4 w-4" />
              )}
            </button>
          </div>
          {state?.fieldErrors?.password && (
            <p className="text-xs text-destructive">
              {state.fieldErrors.password[0]}
            </p>
          )}
          <p className="text-[10px] text-muted-foreground">
            {t("8CharactersWithAnUppercaseLetter")}</p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="profile-pwd2" className="text-xs">
            {t("confirmNewPassword")}</Label>
          <div className="relative">
            <Input
              id="profile-pwd2"
              name="confirmPassword"
              type={showConfirm ? "text" : "password"}
              value={confirm}
              disabled={isPending}
              onChange={(e) => setConfirm(e.target.value)}
              placeholder="••••••••"
              autoComplete="new-password"
              className="pe-10"
              minLength={8}
              required
            />
            <button
              type="button"
              onClick={() => setShowConfirm((v) => !v)}
              disabled={isPending}
              aria-label={showConfirm ? t("hidepassword") : t("showpassword")}
              className="absolute end-3 top-1/2 -translate-y-1/2 text-muted-foreground transition-colors hover:text-foreground"
            >
              {showConfirm ? (
                <EyeOff className="h-4 w-4" />
              ) : (
                <Eye className="h-4 w-4" />
              )}
            </button>
          </div>
          {state?.fieldErrors?.confirmPassword && (
            <p className="text-xs text-destructive">
              {state.fieldErrors.confirmPassword[0]}
            </p>
          )}
        </div>
      </div>

      <div className="flex justify-end">
        <Button type="submit" disabled={isPending} className="gap-1.5">
          {isPending ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <KeyRound className="h-3.5 w-3.5" />
          )}
          {t("updatePassword")}</Button>
      </div>
    </form>
  );
}
