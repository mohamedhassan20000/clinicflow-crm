"use client";

import Image from "next/image";
import { startTransition, useEffect, useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import {
  CalendarDays,
  Clock,
  FileText,
  FolderOpen,
  GraduationCap,
  Loader2,
  Phone,
  Plus,
  Save,
  Trash2,
  Upload,
  User,
  X,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
  deleteStaffFile,
  listStaffFiles,
  uploadStaffCertificate,
  uploadStaffContract,
  uploadStaffOtherDoc,
  type StaffFile,
  type StaffFiles,
} from "@/actions/staff-files";
import { getDoctorSchedule, upsertDoctorSchedule, getClinicWorkingHours } from "@/actions/settings";
import type { DoctorScheduleValues, ClinicWorkingHoursValues } from "@/lib/validations/settings";
import type { Tables } from "@/types/database";

type StaffMember = Tables<"profiles"> & {
  departments: { name: string; color?: string | null } | null;
};

const ROLE_LABELS: Record<string, string> = {
  admin: "Admin",
  doctor: "Doctor",
  receptionist: "Receptionist",
  manager: "Manager",
};

const ROLE_COLORS: Record<string, string> = {
  admin: "bg-violet-500/10 text-violet-700 border-violet-500/20",
  doctor: "bg-blue-500/10 text-blue-700 border-blue-500/20",
  receptionist: "bg-sky-500/10 text-sky-700 border-sky-500/20",
  manager: "bg-amber-500/10 text-amber-700 border-amber-500/20",
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
  const [files, setFiles] = useState<StaffFiles | null>(null);
  const [isPending, startTransition] = useTransition();

  const contractRef = useRef<HTMLInputElement>(null);
  const certRef = useRef<HTMLInputElement>(null);
  const otherRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open || !staff) return;
    let active = true;
    listStaffFiles(staff.id)
      .then((res) => {
        if (!active) return;
        if (res.error) {
          toast.error(res.error);
          setFiles({ photo: null, contract: null, certificates: [], other: [] });
        }
        else setFiles(res.data ?? null);
      });
    return () => { active = false; };
  }, [open, staff]);

  function handleOpenChange(nextOpen: boolean) {
    if (!nextOpen) {
      setFiles(null);
    }
    onOpenChange(nextOpen);
  }

  function triggerUpload(
    ref: React.RefObject<HTMLInputElement | null>,
    action: (staffId: string, fd: FormData) => Promise<{ data?: StaffFiles; error?: string }>,
  ) {
    if (!staff || !ref.current) return;
    ref.current.value = "";
    ref.current.onchange = () => {
      const file = ref.current?.files?.[0];
      if (!file) return;
      const fd = new FormData();
      fd.set("file", file);
      startTransition(async () => {
        const res = await action(staff.id, fd);
        if (res.error) toast.error(res.error);
        else { setFiles(res.data ?? null); toast.success("File uploaded."); }
      });
    };
    ref.current.click();
  }

  function handleDelete(filePath: string) {
    if (!staff) return;
    startTransition(async () => {
      const res = await deleteStaffFile(staff.id, filePath);
      if (res.error) toast.error(res.error);
      else { setFiles(res.data ?? null); toast.success("File removed."); }
    });
  }

  if (!staff) return null;
  const loadingFiles = open && files === null;

  return (
    <Sheet open={open} onOpenChange={handleOpenChange}>
      <SheetContent
        side="right"
        className="flex w-full flex-col gap-0 p-0 sm:max-w-2xl"
      >
        {/* ── Header ── */}
        <SheetHeader className="border-b border-border/50 px-8 py-5 pr-14">
          <div className="flex items-center gap-4">
            {staff.avatar_url ? (
              <Image
                src={staff.avatar_url}
                alt={staff.full_name}
                width={56}
                height={56}
                className="h-14 w-14 rounded-full object-cover ring-2 ring-border"
              />
            ) : (
              <span className="flex h-14 w-14 items-center justify-center rounded-full bg-muted ring-2 ring-border">
                <User className="h-7 w-7 text-muted-foreground" />
              </span>
            )}
            <div className="min-w-0">
              <SheetTitle className="text-lg leading-tight">
                {staff.full_name}
              </SheetTitle>
              <p className="mt-0.5 text-sm text-muted-foreground">
                {staff.role === "admin" || staff.role === "manager"
                  ? "Management / Administration"
                  : staff.departments?.name ?? "No department"}
              </p>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                <span
                  className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${ROLE_COLORS[staff.role] ?? "bg-muted text-foreground border-border"}`}
                >
                  {ROLE_LABELS[staff.role] ?? staff.role}
                </span>
                <span
                  className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${staff.is_active ? "bg-emerald-500/10 text-emerald-700 border-emerald-500/20" : "bg-muted text-muted-foreground border-border"}`}
                >
                  {staff.is_active ? "Active" : "Inactive"}
                </span>
              </div>
            </div>
          </div>
        </SheetHeader>

        {/* ── Tabs ── */}
        <Tabs defaultValue="profile" className="flex flex-1 flex-col overflow-hidden">
          {/* Hidden inputs */}
          <input ref={contractRef} type="file" accept=".pdf,.doc,.docx,image/jpeg,image/png" className="hidden" />
          <input ref={certRef} type="file" accept=".pdf,.doc,.docx,image/jpeg,image/png" className="hidden" />
          <input ref={otherRef} type="file" accept=".pdf,.doc,.docx,image/jpeg,image/png" className="hidden" />

          <TabsList className="mx-8 mt-4 w-fit">
            <TabsTrigger value="profile">Profile</TabsTrigger>
            <TabsTrigger value="documents">Documents</TabsTrigger>
            {staff.role === "doctor" && (
              <TabsTrigger value="schedule">Schedule</TabsTrigger>
            )}
          </TabsList>

          {/* ── Profile tab ── */}
          <TabsContent
            value="profile"
            className="flex-1 overflow-y-auto px-8 py-5"
          >
            <div className="space-y-5">
              <InfoRow icon={<User className="h-4 w-4" />} label="Full name" value={staff.full_name} />
              <InfoRow icon={<User className="h-4 w-4" />} label="Role" value={ROLE_LABELS[staff.role] ?? staff.role} />
              <InfoRow
                icon={<User className="h-4 w-4" />}
                label={
                  staff.role === "admin" || staff.role === "manager"
                    ? "Group"
                    : "Department"
                }
                value={
                  staff.role === "admin" || staff.role === "manager"
                    ? "Management / Administration"
                    : staff.departments?.name ?? "—"
                }
              />
              {staff.phone && (
                <InfoRow icon={<Phone className="h-4 w-4" />} label="Phone" value={staff.phone} />
              )}
              <Separator />
              <InfoRow
                icon={<CalendarDays className="h-4 w-4" />}
                label="Joined"
                value={fmt(staff.created_at)}
              />
              {lastSeen !== undefined && (
                <InfoRow
                  icon={<Clock className="h-4 w-4" />}
                  label="Last seen"
                  value={formatLastSeen(lastSeen)}
                />
              )}
              <InfoRow
                icon={<User className="h-4 w-4" />}
                label="Account status"
                value={
                  <Badge
                    variant={staff.is_active ? "default" : "secondary"}
                    className={`text-xs ${staff.is_active ? "bg-emerald-500/10 text-emerald-700 border-emerald-500/20" : ""}`}
                  >
                    {staff.is_active ? "Active" : "Inactive"}
                  </Badge>
                }
              />
              {staff.must_change_password && (
                <p className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-xs text-amber-700">
                  This staff member must change their password on next login.
                </p>
              )}
            </div>
          </TabsContent>

          {/* ── Schedule tab (doctors only) ── */}
          {staff.role === "doctor" && (
            <TabsContent value="schedule" className="flex-1 overflow-y-auto px-8 py-5">
              <DoctorScheduleTab doctorId={staff.id} open={open} isAdmin={!!isAdmin} />
            </TabsContent>
          )}

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
                {/* Contract */}
                <SingleFileSection
                  title="Employment contract"
                  icon={<FileText className="h-4 w-4" />}
                  hint="PDF or Word · max 10 MB"
                  file={files?.contract ?? null}
                  isPending={isPending}
                  onUpload={() => triggerUpload(contractRef, uploadStaffContract)}
                  onDelete={handleDelete}
                />

                <Separator />

                {/* Certificates */}
                <MultiFileSection
                  title="University certificates"
                  icon={<GraduationCap className="h-4 w-4" />}
                  hint="PDF or Word · max 10 MB each · multiple files allowed"
                  files={files?.certificates ?? []}
                  isPending={isPending}
                  onAdd={() => triggerUpload(certRef, uploadStaffCertificate)}
                  onDelete={handleDelete}
                  addLabel="Add certificate"
                  emptyLabel="No certificates uploaded yet"
                />

                <Separator />

                {/* Other documents */}
                <MultiFileSection
                  title="Other documents"
                  icon={<FolderOpen className="h-4 w-4" />}
                  hint="PDF or Word · max 10 MB each · multiple files allowed"
                  files={files?.other ?? []}
                  isPending={isPending}
                  onAdd={() => triggerUpload(otherRef, uploadStaffOtherDoc)}
                  onDelete={handleDelete}
                  addLabel="Add document"
                  emptyLabel="No other documents uploaded yet"
                />
              </div>
            )}
          </TabsContent>
        </Tabs>
      </SheetContent>
    </Sheet>
  );
}

// ── Doctor Schedule Tab ───────────────────────────────────────────────────────

const SCHEDULE_DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const SCHEDULE_DAY_ORDER = [1, 2, 3, 4, 5, 6, 0];

// Returns true if the clinic has working hours configured and the given dow is closed.
function isClinicDayClosed(clinicHours: ClinicWorkingHoursValues, dow: number): boolean {
  const hasAnyConfig = clinicHours.some((d) => d.open);
  if (!hasAnyConfig) return false;
  const day = clinicHours.find((d) => d.day_of_week === dow);
  return !day?.open;
}

function DoctorScheduleTab({
  doctorId,
  open,
  isAdmin,
}: {
  doctorId: string;
  open: boolean;
  isAdmin: boolean;
}) {
  const [schedule, setSchedule] = useState<DoctorScheduleValues | null>(null);
  const [clinicHours, setClinicHours] = useState<ClinicWorkingHoursValues>([]);
  const [saving, startSave] = useTransition();
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let active = true;
    setSchedule(null);
    Promise.all([
      getDoctorSchedule(doctorId),
      getClinicWorkingHours(),
    ]).then(([scheduleData, hoursData]) => {
      if (!active) return;
      setSchedule(scheduleData);
      setClinicHours(hoursData ?? []);
    });
    return () => { active = false; };
  }, [open, doctorId]);

  function toggleDay(dow: number, works: boolean) {
    setSchedule((prev) =>
      prev?.map((d) =>
        d.day_of_week === dow
          ? { ...d, works, start_time: works ? (d.start_time ?? "09:00") : null, end_time: works ? (d.end_time ?? "17:00") : null }
          : d,
      ) ?? null,
    );
  }

  function updateTime(dow: number, field: "start_time" | "end_time", value: string) {
    setSchedule((prev) =>
      prev?.map((d) => (d.day_of_week === dow ? { ...d, [field]: value } : d)) ?? null,
    );
  }

  function onSave() {
    if (!schedule) return;
    setSaveError(null);
    const fd = new FormData();
    fd.set("schedule", JSON.stringify(schedule));
    startSave(async () => {
      const res = await upsertDoctorSchedule(doctorId, null, fd);
      if (res.error) setSaveError(res.error);
      else toast.success("Schedule saved.");
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
      <p className="text-xs text-muted-foreground">
        Set which days this doctor works and their hours for each day.
      </p>

      {saveError && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          {saveError}
        </div>
      )}

      <div className="space-y-2">
        {SCHEDULE_DAY_ORDER.map((dow) => {
          const day = schedule.find((d) => d.day_of_week === dow);
          if (!day) return null;

          const clinicClosed = isClinicDayClosed(clinicHours, dow);

          return (
            <div
              key={dow}
              className={`rounded-lg border border-border/40 p-3 ${clinicClosed ? "bg-muted/10 opacity-60" : "bg-muted/20"}`}
            >
              <div className="flex items-center gap-3">
                <Checkbox
                  id={`sched-${doctorId}-${dow}`}
                  checked={day.works}
                  onCheckedChange={(v) => isAdmin && !clinicClosed && toggleDay(dow, !!v)}
                  disabled={!isAdmin || saving || clinicClosed}
                />
                <Label
                  htmlFor={`sched-${doctorId}-${dow}`}
                  className="w-24 cursor-pointer text-sm font-medium select-none"
                >
                  {SCHEDULE_DAY_NAMES[dow]}
                </Label>
                {clinicClosed ? (
                  <span className="text-xs text-muted-foreground/60 italic">Clinic closed</span>
                ) : !day.works ? (
                  <span className="text-xs text-muted-foreground">Day off</span>
                ) : null}
              </div>

              {day.works && !clinicClosed && (
                <div className="mt-3 flex items-center gap-2 pl-7">
                  <input
                    type="time"
                    value={day.start_time ?? ""}
                    disabled={!isAdmin || saving}
                    onChange={(e) => updateTime(dow, "start_time", e.target.value)}
                    className="h-8 w-32 rounded-md border border-input bg-background px-2 text-sm text-foreground [color-scheme:light] dark:[color-scheme:dark] focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-50"
                  />
                  <span className="text-xs text-muted-foreground">to</span>
                  <input
                    type="time"
                    value={day.end_time ?? ""}
                    disabled={!isAdmin || saving}
                    onChange={(e) => updateTime(dow, "end_time", e.target.value)}
                    className="h-8 w-32 rounded-md border border-input bg-background px-2 text-sm text-foreground [color-scheme:light] dark:[color-scheme:dark] focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-50"
                  />
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
            Save schedule
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

function SingleFileSection({
  title,
  icon,
  hint,
  file,
  isPending,
  onUpload,
  onDelete,
}: {
  title: string;
  icon: React.ReactNode;
  hint: string;
  file: StaffFile | null;
  isPending: boolean;
  onUpload: () => void;
  onDelete: (path: string) => void;
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
          onClick={onUpload}
        >
          <Upload className="h-3.5 w-3.5" />
          {file ? "Replace" : "Upload"}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">{hint}</p>
      {file ? (
        <FileRow file={file} isPending={isPending} onDelete={onDelete} />
      ) : (
        <p className="rounded-lg border border-dashed border-border/60 py-6 text-center text-xs text-muted-foreground">
          Not uploaded yet
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
  isPending,
  onAdd,
  onDelete,
  addLabel,
  emptyLabel,
}: {
  title: string;
  icon: React.ReactNode;
  hint: string;
  files: StaffFile[];
  isPending: boolean;
  onAdd: () => void;
  onDelete: (path: string) => void;
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
      {files.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border/60 py-6 text-center text-xs text-muted-foreground">
          {emptyLabel}
        </p>
      ) : (
        <div className="space-y-1.5">
          {files.map((f) => (
            <FileRow key={f.path} file={f} isPending={isPending} onDelete={onDelete} />
          ))}
        </div>
      )}
    </div>
  );
}
