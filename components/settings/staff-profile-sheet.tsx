"use client";

import Link from "next/link";
import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  CalendarDays,
  Clock,
  FileText,
  FolderOpen,
  GraduationCap,
  Loader2,
  Save,
  Upload,
  User,
  X,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { TimePicker } from "@/components/ui/clinic-date-picker";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  listStaffFiles,
  saveStaffDocuments,
  type StaffFile,
  type StaffFiles,
} from "@/actions/staff-files";
import {
  getClinicWorkingHours,
  getStaffSchedule,
  getStaffShiftTemplates,
  updateStaffProfileSection,
  upsertStaffSchedule,
} from "@/actions/settings";
import type {
  DoctorScheduleValues,
  ClinicWorkingHoursValues,
  StaffShiftTemplatesValues,
} from "@/lib/validations/settings";
import type { Tables } from "@/types/database";
import { useTranslations } from "next-intl";
import { ScopedAssistantLauncher } from "@/components/assistant/assistant-launcher-scope";
import { ClinicianCredentialsForm } from "@/components/clinical/clinician-credentials-form";
import {
  canonicalClock,
  intervalsForSelection,
  matchTemplateSelection,
  validateStaffInterval,
} from "@/lib/scheduling/clock";

type StaffMember = Tables<"profiles"> & {
  departments: { name: string; color?: string | null } | null;
};

type PendingFile = File | null | undefined;

const ROLE_LABEL_KEYS: Record<string, string> = {
  admin: "roleAdmin",
  doctor: "roleDoctor",
  receptionist: "roleReceptionist",
  manager: "roleManager",
  assistant: "roleAssistant",
};

const ROLE_COLORS: Record<string, string> = {
  admin: "bg-violet-500/10 text-violet-700 border-violet-500/20",
  doctor: "bg-blue-500/10 text-blue-700 border-blue-500/20",
  receptionist: "bg-sky-500/10 text-sky-700 border-sky-500/20",
  manager: "bg-amber-500/10 text-amber-700 border-amber-500/20",
  assistant: "bg-teal-500/10 text-teal-700 border-teal-500/20",
};

function fmt(iso: string | null | undefined) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

function formatLastSeen(iso: string | null | undefined): string {
  if (!iso) return "Never";
  const date = new Date(iso);
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfYesterday = new Date(startOfToday.getTime() - 86400000);
  const diffDays = Math.floor((startOfToday.getTime() - date.getTime()) / 86400000);
  const timeStr = date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
  if (date >= startOfToday) return `Today, ${timeStr}`;
  if (date >= startOfYesterday) return `Yesterday, ${timeStr}`;
  if (diffDays < 7) return `${diffDays} days ago`;
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

interface Props {
  staff: StaffMember | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  lastSeen?: string | null;
  isAdmin?: boolean;
}

export function StaffProfileSheet({ staff, open, onOpenChange, lastSeen, isAdmin }: Props) {
  const t = useTranslations("settings");
  const tDocuments = useTranslations("documentPlatform.ui");
  const router = useRouter();
  const [files, setFiles] = useState<StaffFiles | null>(null);
  const [isPending, startTransition] = useTransition();
  // undefined = use staff.avatar_url prop; null = cleared; string = new signed url
  const [localAvatarUrl, setLocalAvatarUrl] = useState<string | null | undefined>(undefined);
  const [pendingPhoto, setPendingPhoto] = useState<PendingFile>(undefined);
  const [pendingContract, setPendingContract] = useState<PendingFile>(undefined);
  const [pendingCertificates, setPendingCertificates] = useState<File[]>([]);
  const [pendingOther, setPendingOther] = useState<File[]>([]);
  const [removedPaths, setRemovedPaths] = useState<string[]>([]);
  const [pendingPhotoUrl, setPendingPhotoUrl] = useState<string | null>(null);

  const photoRef = useRef<HTMLInputElement>(null);
  const contractRef = useRef<HTMLInputElement>(null);
  const certRef = useRef<HTMLInputElement>(null);
  const otherRef = useRef<HTMLInputElement>(null);
  const pendingPhotoUrlRef = useRef<string | null>(null);
  const staffId = staff?.id;

  function resetDocumentDraft() {
    if (pendingPhotoUrlRef.current) URL.revokeObjectURL(pendingPhotoUrlRef.current);
    pendingPhotoUrlRef.current = null;
    setPendingPhotoUrl(null);
    setPendingPhoto(undefined);
    setPendingContract(undefined);
    setPendingCertificates([]);
    setPendingOther([]);
    setRemovedPaths([]);
  }

  useEffect(() => {
    if (!open || !staffId) return;
    let active = true;
    listStaffFiles(staffId)
      .then((res) => {
        if (!active) return;
        if (res.error) {
          toast.error(res.error);
          setFiles({ photo: null, contract: null, certificates: [], other: [] });
        }
        else setFiles(res.data ?? null);
      });
    return () => { active = false; };
  }, [open, staffId]);

  useEffect(() => {
    return () => {
      if (pendingPhotoUrlRef.current) URL.revokeObjectURL(pendingPhotoUrlRef.current);
    };
  }, []);

  function stagePhoto(file: File | undefined) {
    if (!file) return;
    if (pendingPhotoUrlRef.current) URL.revokeObjectURL(pendingPhotoUrlRef.current);
    const url = URL.createObjectURL(file);
    pendingPhotoUrlRef.current = url;
    setPendingPhotoUrl(url);
    setPendingPhoto(file);
  }

  function handleOpenChange(nextOpen: boolean) {
    if (!nextOpen) {
      setFiles(null);
      setLocalAvatarUrl(undefined);
      resetDocumentDraft();
    }
    onOpenChange(nextOpen);
  }

  function handleDelete(filePath: string) {
    setRemovedPaths((current) => current.includes(filePath) ? current : [...current, filePath]);
    if (filePath.includes("/photo.")) setPendingPhoto(null);
    if (filePath.includes("/contract.")) setPendingContract(null);
  }

  function saveDocuments() {
    if (!staff) return;
    const fd = new FormData();
    fd.set("photo_action", pendingPhoto === undefined ? "keep" : pendingPhoto === null ? "remove" : "replace");
    fd.set("contract_action", pendingContract === undefined ? "keep" : pendingContract === null ? "remove" : "replace");
    if (pendingPhoto instanceof File) fd.set("photo", pendingPhoto);
    if (pendingContract instanceof File) fd.set("contract", pendingContract);
    pendingCertificates.forEach((file) => fd.append("certificates", file));
    pendingOther.forEach((file) => fd.append("other", file));
    fd.set("remove_paths", JSON.stringify(removedPaths));
    startTransition(async () => {
      const res = await saveStaffDocuments(staff.id, fd);
      if (res.error) toast.error(res.error);
      else {
        setFiles(res.data ?? null);
        setLocalAvatarUrl(res.data?.photo?.url ?? null);
        resetDocumentDraft();
        router.refresh();
        toast.success(t("documentsSaved"));
      }
    });
  }

  if (!staff) return null;
  const loadingFiles = open && files === null;
  const storedPhoto = pendingPhoto === null || (files?.photo && removedPaths.includes(files.photo.path))
    ? null
    : files?.photo ?? null;
  const storedContract = pendingContract === null || (files?.contract && removedPaths.includes(files.contract.path))
    ? null
    : files?.contract ?? null;
  const storedCertificates = (files?.certificates ?? []).filter((file) => !removedPaths.includes(file.path));
  const storedOther = (files?.other ?? []).filter((file) => !removedPaths.includes(file.path));

  return (
    <Sheet open={open} onOpenChange={handleOpenChange}>
      <SheetContent
        side="inline-end"
        aria-describedby={undefined}
        className="flex w-full flex-col gap-0 p-0 sm:max-w-2xl"
      >
        {/* ── Header ── */}
        <SheetHeader className="border-b border-border/50 px-8 py-5 pe-14">
          <div className="flex items-center gap-4">
            <Avatar className="h-14 w-14 ring-2 ring-border">
              {(pendingPhoto === null
                ? null
                : pendingPhotoUrl ?? (localAvatarUrl !== undefined ? localAvatarUrl : staff.avatar_url)) && (
                <AvatarImage
                  src={(pendingPhotoUrl ?? (localAvatarUrl !== undefined ? localAvatarUrl : staff.avatar_url))!}
                  alt={staff.full_name}
                />
              )}
              <AvatarFallback>
                <User className="h-7 w-7 text-muted-foreground" />
              </AvatarFallback>
            </Avatar>
            <div className="min-w-0 flex-1">
              <SheetTitle className="text-lg leading-tight">
                {staff.full_name}
              </SheetTitle>
              <p className="mt-0.5 text-sm text-muted-foreground">
                {staff.role === "admin" || staff.role === "manager"
                  ? t("managementAdministration")
                  : staff.departments?.name ?? t("noDepartment")}
              </p>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                <span
                  className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${ROLE_COLORS[staff.role] ?? "bg-muted text-foreground border-border"}`}
                >
                  {ROLE_LABEL_KEYS[staff.role] ? t(ROLE_LABEL_KEYS[staff.role]) : staff.role}
                </span>
                <span
                  className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${staff.is_active ? "bg-emerald-500/10 text-emerald-700 hover:bg-emerald-500/10 dark:text-emerald-400" : "bg-muted text-muted-foreground border-border"}`}
                >
                  {staff.is_active ? t("active") : t("inactive")}
                </span>
              </div>
            </div>
          </div>
        </SheetHeader>

        {/* ── Tabs ── */}
        <Tabs defaultValue="profile" className="flex flex-1 flex-col overflow-hidden">
          {/* Hidden inputs */}
          <input ref={photoRef} aria-label={t("profilePhoto")} type="file" accept="image/jpeg,image/png,image/webp" className="hidden" onChange={(event) => stagePhoto(event.target.files?.[0])} />
          <input ref={contractRef} aria-label={t("employmentContract")} type="file" accept=".pdf,.doc,.docx,image/jpeg,image/png" className="hidden" onChange={(event) => setPendingContract(event.target.files?.[0])} />
          <input ref={certRef} aria-label={t("universityCertificates")} type="file" multiple accept=".pdf,.doc,.docx,image/jpeg,image/png" className="hidden" onChange={(event) => setPendingCertificates((current) => [...current, ...Array.from(event.target.files ?? [])])} />
          <input ref={otherRef} aria-label={t("otherDocuments")} type="file" multiple accept=".pdf,.doc,.docx,image/jpeg,image/png" className="hidden" onChange={(event) => setPendingOther((current) => [...current, ...Array.from(event.target.files ?? [])])} />

          <TabsList className="mx-8 mt-4 w-fit">
            <TabsTrigger value="profile">{t("profile")}</TabsTrigger>
            <TabsTrigger value="documents">{t("documents")}</TabsTrigger>
            <TabsTrigger value="schedule">{t("schedule")}</TabsTrigger>
          </TabsList>

          {/* ── Profile tab ── */}
          <TabsContent
            value="profile"
            className="flex-1 overflow-y-auto px-8 py-5"
          >
            <div className="space-y-5">
              <StaffProfileSection key={staff.id} staff={staff} />
              <Separator />
              <InfoRow icon={<User className="h-4 w-4" />} label={t("role")} value={ROLE_LABEL_KEYS[staff.role] ? t(ROLE_LABEL_KEYS[staff.role]) : staff.role} />
              <InfoRow
                icon={<User className="h-4 w-4" />}
                label={
                  staff.role === "admin" || staff.role === "manager"
                    ? t("group")
                    : t("department")
                }
                value={
                  staff.role === "admin" || staff.role === "manager"
                    ? t("managementAdministration")
                    : staff.departments?.name ?? "—"
                }
              />
              <Separator />
              <InfoRow
                icon={<CalendarDays className="h-4 w-4" />}
                label={t("joined")}
                value={fmt(staff.created_at)}
              />
              {lastSeen !== undefined && (
                <InfoRow
                  icon={<Clock className="h-4 w-4" />}
                  label={t("lastSeen")}
                  value={formatLastSeen(lastSeen)}
                />
              )}
              <InfoRow
                icon={<User className="h-4 w-4" />}
                label={t("accountStatus")}
                value={
                  <Badge
                    variant={staff.is_active ? "default" : "secondary"}
                    className={`text-xs ${staff.is_active ? "bg-emerald-500/10 text-emerald-700 hover:bg-emerald-500/10 dark:text-emerald-400" : ""}`}
                  >
                    {staff.is_active ? t("active") : t("inactive")}
                  </Badge>
                }
              />
              {staff.must_change_password && (
                <p className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-xs text-amber-700">
                  {t("thisStaffMemberMustChangeTheir")}
                </p>
              )}
              {staff.role === "doctor" && (
                <>
                  <Separator />
                  <ClinicianCredentialsForm
                    key={staff.id}
                    staffId={staff.id}
                    readOnly={!isAdmin}
                    initial={{
                      professionalLicenseNo: staff.professional_license_no,
                      specialty: staff.specialty,
                      professionalTitle: staff.professional_title,
                      hasSignature: Boolean(staff.signature_path),
                    }}
                  />
                </>
              )}
            </div>
          </TabsContent>

          {/* ── Schedule tab ── */}
          <TabsContent value="schedule" className="flex-1 overflow-y-auto px-8 py-5">
            <StaffScheduleTab staffId={staff.id} open={open} isAdmin={!!isAdmin} />
          </TabsContent>

          {/* ── Documents tab ── */}
          <TabsContent
            value="documents"
            className="flex-1 overflow-y-auto px-8 py-5"
          >
            {loadingFiles ? (
              <div className="flex justify-center py-16">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              </div>
            ) : (
              <div className="space-y-8">
                <div
                  data-testid="staff-documents-actions"
                  className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border/50 bg-muted/20 p-4"
                >
                  <div>
                    <p className="text-sm font-medium">{tDocuments("staffFileDocument")}</p>
                    <p className="text-xs text-muted-foreground">{t("staffFileDocumentDescription")}</p>
                  </div>
                  <Button asChild variant="outline" size="sm" className="gap-1.5">
                    <Link href={`/documents/roster-profile/staff-file?staffId=${encodeURIComponent(staff.id)}`}>
                      <FileText className="h-4 w-4" aria-hidden="true" />
                      {tDocuments("staffFileDocument")}
                    </Link>
                  </Button>
                </div>

                <Separator />

                {/* Profile photo */}
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-sm font-medium">{t("profilePhoto")}</p>
                      <p className="text-xs text-muted-foreground">{t("jpegPngOrWebpMax6")}</p>
                    </div>
                    <div className="flex items-center gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="gap-1.5"
                        disabled={isPending}
                        onClick={() => photoRef.current?.click()}
                      >
                        <Upload className="h-3.5 w-3.5" />
                        {pendingPhoto instanceof File || storedPhoto ? t("change") : t("upload")}
                      </Button>
                      {(pendingPhoto instanceof File || storedPhoto) && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="gap-1.5 text-destructive hover:text-destructive"
                          disabled={isPending}
                          onClick={() => {
                            if (storedPhoto) handleDelete(storedPhoto.path);
                            else setPendingPhoto(null);
                          }}
                        >
                          <X className="h-3.5 w-3.5" />
                          {t("remove")}
                        </Button>
                      )}
                    </div>
                  </div>
                  {(pendingPhoto instanceof File || storedPhoto) && (
                    <div className="flex items-center gap-3 rounded-lg border border-border/40 bg-muted/20 p-3">
                      <Avatar className="h-12 w-12 ring-2 ring-border">
                        <AvatarImage src={pendingPhotoUrl ?? storedPhoto?.url ?? ""} alt={t("staffPhoto")} />
                        <AvatarFallback><User className="h-6 w-6" /></AvatarFallback>
                      </Avatar>
                      <p className="text-xs text-muted-foreground truncate">
                        {pendingPhoto instanceof File ? pendingPhoto.name : storedPhoto?.name}
                      </p>
                    </div>
                  )}
                </div>

                <Separator />

                {/* Contract */}
                <SingleFileSection
                  title={t("employmentContract")}
                  icon={<FileText className="h-4 w-4" />}
                  hint={t("pdfOrWordMax10Mb")}
                  file={storedContract}
                  pendingFile={pendingContract instanceof File ? pendingContract : undefined}
                  isPending={isPending}
                  onUpload={() => contractRef.current?.click()}
                  onDelete={handleDelete}
                  onRemovePending={() => setPendingContract(null)}
                />

                <Separator />

                {/* Certificates */}
                <MultiFileSection
                  title={t("universityCertificates")}
                  icon={<GraduationCap className="h-4 w-4" />}
                  hint={t("pdfOrWordMax10MbEachMultiple")}
                  files={storedCertificates}
                  pendingFiles={pendingCertificates}
                  isPending={isPending}
                  onAdd={() => certRef.current?.click()}
                  onDelete={handleDelete}
                  onRemovePending={(index) => setPendingCertificates((current) => current.filter((_, itemIndex) => itemIndex !== index))}
                  addLabel={t("addCertificate")}
                  emptyLabel={t("noCertificatesUploadedYet")}
                />

                <Separator />

                {/* Other documents */}
                <MultiFileSection
                  title={t("otherDocuments")}
                  icon={<FolderOpen className="h-4 w-4" />}
                  hint={t("pdfOrWordMax10MbEachMultiple")}
                  files={storedOther}
                  pendingFiles={pendingOther}
                  isPending={isPending}
                  onAdd={() => otherRef.current?.click()}
                  onDelete={handleDelete}
                  onRemovePending={(index) => setPendingOther((current) => current.filter((_, itemIndex) => itemIndex !== index))}
                  addLabel={t("addDocument")}
                  emptyLabel={t("noOtherDocumentsUploadedYet")}
                />

                <div className="flex justify-end pt-2">
                  <Button type="button" onClick={saveDocuments} disabled={isPending} className="gap-2">
                    {isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                    {t("saveDocuments")}
                  </Button>
                </div>
              </div>
            )}
          </TabsContent>
        </Tabs>
      </SheetContent>
    </Sheet>
  );
}

// ── Doctor Schedule Tab ───────────────────────────────────────────────────────

function StaffProfileSection({ staff }: { staff: StaffMember }) {
  const t = useTranslations("settings");
  const router = useRouter();
  const [fullName, setFullName] = useState(staff.full_name);
  const [phone, setPhone] = useState(staff.phone ?? "");
  // The names patients are shown. `full_name` above stays the clinic's record;
  // these are display only, and an empty one means "use the stored name".
  const [displayNameAr, setDisplayNameAr] = useState(staff.display_name_ar ?? "");
  const [displayNameEn, setDisplayNameEn] = useState(staff.display_name_en ?? "");
  const [saving, startSave] = useTransition();

  function saveProfile() {
    startSave(async () => {
      const result = await updateStaffProfileSection(staff.id, {
        full_name: fullName,
        phone: phone || null,
        display_name_ar: displayNameAr || null,
        display_name_en: displayNameEn || null,
      });
      if (result.error) toast.error(result.error);
      else {
        router.refresh();
        toast.success(t("profileSaved"));
      }
    });
  }

  return (
    <section className="space-y-4 rounded-xl border border-border/50 bg-card p-5">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor={`staff-profile-name-${staff.id}`}>{t("fullName")}</Label>
          <Input
            id={`staff-profile-name-${staff.id}`}
            value={fullName}
            maxLength={100}
            disabled={saving}
            onChange={(event) => setFullName(event.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`staff-profile-phone-${staff.id}`}>{t("phone")}</Label>
          <Input
            id={`staff-profile-phone-${staff.id}`}
            type="tel"
            value={phone}
            disabled={saving}
            onChange={(event) => setPhone(event.target.value)}
          />
        </div>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor={`staff-profile-name-ar-${staff.id}`}>
            {t("displayNameArabic")}
          </Label>
          <Input
            id={`staff-profile-name-ar-${staff.id}`}
            dir="rtl"
            value={displayNameAr}
            maxLength={120}
            disabled={saving}
            onChange={(event) => setDisplayNameAr(event.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`staff-profile-name-en-${staff.id}`}>
            {t("displayNameEnglish")}
          </Label>
          <Input
            id={`staff-profile-name-en-${staff.id}`}
            dir="ltr"
            value={displayNameEn}
            maxLength={120}
            disabled={saving}
            onChange={(event) => setDisplayNameEn(event.target.value)}
          />
        </div>
      </div>
      <p className="text-xs text-muted-foreground">{t("displayNameHint")}</p>
      <div className="flex justify-end">
        <Button type="button" onClick={saveProfile} disabled={saving} className="gap-2">
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
          {t("saveProfile")}
        </Button>
      </div>
    </section>
  );
}

const SCHEDULE_DAY_KEYS = ["daySunday", "dayMonday", "dayTuesday", "dayWednesday", "dayThursday", "dayFriday", "daySaturday"];
const SCHEDULE_DAY_ORDER = [1, 2, 3, 4, 5, 6, 0];

// Returns true if the clinic has working hours configured and the given dow is closed.
function isClinicDayClosed(clinicHours: ClinicWorkingHoursValues, dow: number): boolean {
  const hasAnyConfig = clinicHours.some((d) => d.open);
  if (!hasAnyConfig) return false;
  const day = clinicHours.find((d) => d.day_of_week === dow);
  return !day?.open;
}

type DayIntervals = { start_time: string; end_time: string }[];

function StaffScheduleTab({
  staffId,
  open,
  isAdmin,
}: {
  staffId: string;
  open: boolean;
  isAdmin: boolean;
}) {
  const t = useTranslations("settings");
  const [schedule, setSchedule] = useState<DoctorScheduleValues | null>(null);
  const [clinicHours, setClinicHours] = useState<ClinicWorkingHoursValues>([]);
  const [templates, setTemplates] = useState<StaffShiftTemplatesValues>([]);
  const [selections, setSelections] = useState<Map<number, Set<number>>>(() => new Map());
  const [customDays, setCustomDays] = useState<Set<number>>(() => new Set());
  const [saving, startSave] = useTransition();
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let active = true;
    queueMicrotask(() => {
      if (active) {
        setSchedule(null);
        setCustomDays(new Set());
        setSelections(new Map());
      }
    });
    Promise.all([
      getStaffSchedule(staffId),
      getClinicWorkingHours(),
      getStaffShiftTemplates(),
    ]).then(([scheduleData, hoursData, templateData]) => {
      if (!active) return;
      const enabled = (templateData ?? []).filter((template) => template.is_enabled);
      const nextSelections = new Map<number, Set<number>>();
      const nextCustom = new Set<number>();
      for (const day of scheduleData) {
        if (!day.works || day.intervals.length === 0) continue;
        const match = matchTemplateSelection(day.intervals, enabled);
        if (match) nextSelections.set(day.day_of_week, match);
        else nextCustom.add(day.day_of_week);
      }
      setSchedule(scheduleData);
      setClinicHours(hoursData ?? []);
      setTemplates(enabled);
      setSelections(nextSelections);
      setCustomDays(nextCustom);
    });
    return () => { active = false; };
  }, [open, staffId]);

  function applyIntervals(dow: number, intervals: DayIntervals) {
    setSchedule((prev) =>
      prev?.map((day) =>
        day.day_of_week === dow
          ? {
              ...day,
              works: intervals.length > 0,
              intervals,
              start_time: intervals[0]?.start_time ?? null,
              end_time: intervals.at(-1)?.end_time ?? null,
            }
          : day,
      ) ?? null,
    );
  }

  function toggleDay(dow: number, works: boolean) {
    if (!works) {
      setSelections((current) => {
        const next = new Map(current);
        next.delete(dow);
        return next;
      });
      setCustomDays((current) => {
        const next = new Set(current);
        next.delete(dow);
        return next;
      });
      applyIntervals(dow, []);
      return;
    }
    const existing = schedule?.find((day) => day.day_of_week === dow)?.intervals ?? [];
    if (existing.length > 0) {
      applyIntervals(dow, existing);
      return;
    }
    const first = templates[0];
    if (first) {
      setSelections((current) => new Map(current).set(dow, new Set([0])));
      applyIntervals(dow, [{ start_time: first.start_time, end_time: first.end_time }]);
      return;
    }
    setCustomDays((current) => new Set(current).add(dow));
    applyIntervals(dow, [{ start_time: "09:00", end_time: "17:00" }]);
  }

  function toggleTemplate(dow: number, index: number) {
    const current = customDays.has(dow) ? new Set<number>() : new Set(selections.get(dow) ?? []);
    if (current.has(index)) current.delete(index);
    else current.add(index);
    setCustomDays((prev) => {
      const next = new Set(prev);
      next.delete(dow);
      return next;
    });
    if (current.size === 0) {
      // Nothing selected: fall back to a custom interval rather than silently
      // turning the day off.
      setSelections((prev) => {
        const next = new Map(prev);
        next.delete(dow);
        return next;
      });
      setCustomDays((prev) => new Set(prev).add(dow));
      return;
    }
    setSelections((prev) => new Map(prev).set(dow, current));
    applyIntervals(dow, intervalsForSelection(current, templates));
  }

  function chooseCustom(dow: number) {
    setSelections((prev) => {
      const next = new Map(prev);
      next.delete(dow);
      return next;
    });
    setCustomDays((prev) => new Set(prev).add(dow));
    const existing = schedule?.find((day) => day.day_of_week === dow)?.intervals ?? [];
    applyIntervals(dow, existing.length > 0 ? [existing[0]!] : [{ start_time: "09:00", end_time: "17:00" }]);
  }

  function updateTime(dow: number, field: "start_time" | "end_time", value: string) {
    const day = schedule?.find((item) => item.day_of_week === dow);
    const base = day?.intervals[0] ?? { start_time: "09:00", end_time: "17:00" };
    applyIntervals(dow, [{ ...base, [field]: value }]);
  }

  function onSave() {
    if (!schedule) return;
    setSaveError(null);

    // Client-side pre-validation against clinic hours. Staff intervals still
    // have to sit inside the clinic's opening intervals; shift templates only
    // changed where those intervals come from.
    if (clinicHours.some((d) => d.open)) {
      const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
      for (const day of schedule) {
        if (!day.works || day.intervals.length === 0) continue;
        const clinicDay = clinicHours.find((c) => c.day_of_week === day.day_of_week);
        if (!clinicDay?.open || clinicDay.shifts.length === 0) {
          setSaveError(t("staffScheduleOnClosedDay", { day: DAY_NAMES[day.day_of_week] }));
          return;
        }
        for (const entry of day.intervals) {
          const interval = validateStaffInterval(entry.start_time, entry.end_time, clinicDay.shifts);
          if (!interval.ok) {
            setSaveError(t("staffHoursOutsideClinicHours", {
              day: DAY_NAMES[day.day_of_week],
              start: entry.start_time,
              end: entry.end_time,
              clinicOpen: interval.clinicOpen ?? "—",
              clinicClose: interval.clinicClose ?? "—",
            }));
            return;
          }
        }
      }
    }

    const fd = new FormData();
    fd.set("schedule", JSON.stringify(schedule));
    startSave(async () => {
      const res = await upsertStaffSchedule(staffId, null, fd);
      if (res.error) setSaveError(res.error);
      else toast.success(t("scheduleSaved"));
    });
  }

  if (!schedule) {
    return (
      <div className="flex justify-center py-16">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          {t("setWhichDaysThisStaffMemberWorks")}
        </p>
        <ScopedAssistantLauncher />
      </div>

      {saveError && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          {saveError}
        </div>
      )}

      {templates.length === 0 && (
        <p className="rounded-lg border border-dashed border-border/50 px-4 py-3 text-xs text-muted-foreground">
          {t("noStaffShiftTemplatesHint")}
        </p>
      )}

      <div className="space-y-2">
        {SCHEDULE_DAY_ORDER.map((dow) => {
          const day = schedule.find((d) => d.day_of_week === dow);
          if (!day) return null;

          const clinicClosed = isClinicDayClosed(clinicHours, dow);
          const isCustom = customDays.has(dow);
          const selection = selections.get(dow) ?? new Set<number>();
          const editable = day.intervals[0];

          return (
            <div
              key={dow}
              className={`rounded-lg border border-border/40 p-3 ${clinicClosed ? "bg-muted/10 opacity-60" : "bg-muted/20"}`}
            >
              <div className="flex items-center gap-3">
                {/* i18n-allow: DOM id joining a doctor UUID and weekday index */}
                <Checkbox
                  id={`sched-${staffId}-${dow}`} // i18n-allow: technical checkbox DOM id
                  checked={day.works}
                  onCheckedChange={(v) => isAdmin && !clinicClosed && toggleDay(dow, !!v)}
                  disabled={!isAdmin || saving || clinicClosed}
                />
                {/* i18n-allow: htmlFor must match the technical checkbox DOM id */}
                <Label
                  htmlFor={`sched-${staffId}-${dow}`} // i18n-allow: technical DOM id reference
                  className="w-24 cursor-pointer text-sm font-medium select-none"
                >
                  {t(SCHEDULE_DAY_KEYS[dow] ?? "daySunday")}
                </Label>
                {clinicClosed ? (
                  <span className="text-xs text-muted-foreground/60 italic">{t("clinicClosed")}</span>
                ) : !day.works ? (
                  <span className="text-xs text-muted-foreground">{t("dayOff")}</span>
                ) : null}
              </div>

              {day.works && !clinicClosed && (
                <div className="mt-3 space-y-2 ps-7">
                  <div className="flex flex-wrap gap-1.5" role="group" aria-label={t("shiftTemplateSelection")}>
                    {templates.map((template, index) => (
                      <Button
                        key={template.id ?? template.name}
                        type="button"
                        size="xs"
                        variant={!isCustom && selection.has(index) ? "default" : "outline"}
                        aria-pressed={!isCustom && selection.has(index)}
                        disabled={!isAdmin || saving}
                        onClick={() => toggleTemplate(dow, index)}
                      >
                        {template.name}
                      </Button>
                    ))}
                    <Button
                      type="button"
                      size="xs"
                      variant={isCustom ? "default" : "outline"}
                      aria-pressed={isCustom}
                      disabled={!isAdmin || saving}
                      onClick={() => chooseCustom(dow)}
                    >
                      {t("customHours")}
                    </Button>
                  </div>

                  {isCustom ? (
                    <div className="flex items-center gap-2">
                      <TimePicker
                        value={editable?.start_time ?? ""}
                        disabled={!isAdmin || saving}
                        onChange={(time) => updateTime(dow, "start_time", time)}
                        label={t("startTime")}
                        compact
                        className="h-8 w-32 rounded-md px-2 text-sm"
                      />
                      <span className="text-xs text-muted-foreground">{t("to")}</span>
                      <TimePicker
                        value={editable?.end_time ?? ""}
                        disabled={!isAdmin || saving}
                        onChange={(time) => updateTime(dow, "end_time", time)}
                        label={t("endTime")}
                        compact
                        className="h-8 w-32 rounded-md px-2 text-sm"
                      />
                    </div>
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      {day.intervals
                        .map((interval) => `${canonicalClock(interval.start_time)} – ${canonicalClock(interval.end_time)}`)
                        .join(" · ")}
                    </p>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {isAdmin && (
        <div className="flex justify-end pt-2">
          <Button onClick={onSave} disabled={saving} className="gap-2">
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            {t("saveSchedule")}
          </Button>
        </div>
      )}
    </div>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function InfoRow({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: React.ReactNode;
}) {
  return (
    <div className="flex items-start gap-3">
      <span className="mt-0.5 text-muted-foreground">{icon}</span>
      <div className="flex-1">
        <p className="text-xs text-muted-foreground">{label}</p>
        <div className="mt-0.5 text-sm font-medium">{value}</div>
      </div>
    </div>
  );
}

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function FileRow({
  file,
  isPending,
  onDelete,
}: {
  file: StaffFile;
  isPending: boolean;
  onDelete: (path: string) => void;
}) {
  const t = useTranslations("settings");
  const displayName = file.name.replace(/^\d+_/, "");
  return (
    <div className="flex items-center gap-2 rounded-lg border border-border/50 bg-card px-3 py-2 text-sm">
      <a
        href={file.url}
        target="_blank"
        rel="noopener noreferrer"
        className="flex-1 truncate font-medium hover:underline"
      >
        {displayName}
      </a>
      <span className="shrink-0 text-xs text-muted-foreground">
        {formatSize(file.size)}
      </span>
      <Button
        variant="ghost"
        size="icon"
        className="h-6 w-6 shrink-0 text-muted-foreground hover:text-destructive"
        aria-label={t("remove")}
        disabled={isPending}
        onClick={() => onDelete(file.path)}
      >
        {isPending ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <X className="h-3.5 w-3.5" />
        )}
      </Button>
    </div>
  );
}

function PendingFileRow({ file, onDelete }: { file: File; onDelete: () => void }) {
  const t = useTranslations("settings");
  return (
    <div className="flex items-center gap-2 rounded-lg border border-dashed border-border/60 bg-muted/20 px-3 py-2 text-sm">
      <span className="flex-1 truncate font-medium">{file.name}</span>
      <span className="shrink-0 text-xs text-muted-foreground">{formatSize(file.size)}</span>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="h-6 w-6 shrink-0 text-muted-foreground hover:text-destructive"
        aria-label={t("remove")}
        onClick={onDelete}
      >
        <X className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}

function SingleFileSection({
  title,
  icon,
  hint,
  file,
  pendingFile,
  isPending,
  onUpload,
  onDelete,
  onRemovePending,
}: {
  title: string;
  icon: React.ReactNode;
  hint: string;
  file: StaffFile | null;
  pendingFile?: File;
  isPending: boolean;
  onUpload: () => void;
  onDelete: (path: string) => void;
  onRemovePending: () => void;
}) {
  const t = useTranslations("settings");
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm font-medium">
          {icon} {title}
        </div>
        <Button
          variant="outline"
          size="sm"
          className="h-7 gap-1.5 text-xs"
          disabled={isPending}
          onClick={onUpload}
        >
          <Upload className="h-3.5 w-3.5" />
          {pendingFile || file ? t("replace") : t("upload")}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">{hint}</p>
      {pendingFile ? (
        <PendingFileRow file={pendingFile} onDelete={onRemovePending} />
      ) : file ? (
        <FileRow file={file} isPending={isPending} onDelete={onDelete} />
      ) : (
        <p className="rounded-lg border border-dashed border-border/60 py-6 text-center text-xs text-muted-foreground">
          {t("notUploadedYet")}
        </p>
      )}
    </div>
  );
}

function MultiFileSection({
  title,
  icon,
  hint,
  files,
  pendingFiles,
  isPending,
  onAdd,
  onDelete,
  onRemovePending,
  addLabel,
  emptyLabel,
}: {
  title: string;
  icon: React.ReactNode;
  hint: string;
  files: StaffFile[];
  pendingFiles: File[];
  isPending: boolean;
  onAdd: () => void;
  onDelete: (path: string) => void;
  onRemovePending: (index: number) => void;
  addLabel: string;
  emptyLabel: string;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm font-medium">
          {icon} {title}
        </div>
        <Button
          variant="outline"
          size="sm"
          className="h-7 gap-1.5 text-xs"
          disabled={isPending}
          onClick={onAdd}
        >
          <Upload className="h-3.5 w-3.5" />
          {addLabel}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">{hint}</p>
      {files.length === 0 && pendingFiles.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border/60 py-6 text-center text-xs text-muted-foreground">
          {emptyLabel}
        </p>
      ) : (
        <div className="space-y-1.5">
          {files.map((f) => (
            <FileRow key={f.path} file={f} isPending={isPending} onDelete={onDelete} />
          ))}
          {pendingFiles.map((file, index) => (
            <PendingFileRow
              key={`${file.name}-${file.size}-${index}`}
              file={file}
              onDelete={() => onRemovePending(index)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
