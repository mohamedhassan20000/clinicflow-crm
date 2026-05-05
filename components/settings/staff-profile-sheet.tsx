"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import {
  CalendarDays,
  Clock,
  FileText,
  FolderOpen,
  GraduationCap,
  Loader2,
  Phone,
  Upload,
  User,
  X,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
  uploadStaffPhoto,
  type StaffFile,
  type StaffFiles,
} from "@/actions/staff-files";
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

interface Props {
  staff: StaffMember | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function StaffProfileSheet({ staff, open, onOpenChange }: Props) {
  const [files, setFiles] = useState<StaffFiles | null>(null);
  const [isPending, startTransition] = useTransition();

  const photoRef = useRef<HTMLInputElement>(null);
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
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={staff.avatar_url}
                alt={staff.full_name}
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
                {staff.departments?.name ?? "No department"}
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
          <TabsList className="mx-8 mt-4 w-fit">
            <TabsTrigger value="profile">Profile</TabsTrigger>
            <TabsTrigger value="documents">Documents</TabsTrigger>
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
                label="Department"
                value={staff.departments?.name ?? "—"}
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
              <InfoRow
                icon={<Clock className="h-4 w-4" />}
                label="Last login"
                value={fmt(staff.last_login_at)}
              />
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

          {/* ── Documents tab ── */}
          <TabsContent
            value="documents"
            className="flex-1 overflow-y-auto px-8 py-5"
          >
            {/* Hidden inputs */}
            <input ref={photoRef} type="file" accept="image/jpeg,image/png,image/webp" className="hidden" />
            <input ref={contractRef} type="file" accept=".pdf,.doc,.docx,image/jpeg,image/png" className="hidden" />
            <input ref={certRef} type="file" accept=".pdf,.doc,.docx,image/jpeg,image/png" className="hidden" />
            <input ref={otherRef} type="file" accept=".pdf,.doc,.docx,image/jpeg,image/png" className="hidden" />

            {loadingFiles ? (
              <div className="flex justify-center py-16">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              </div>
            ) : (
              <div className="space-y-8">
                {/* Photo */}
                <SingleFileSection
                  title="Profile photo"
                  icon={<User className="h-4 w-4" />}
                  hint="JPEG, PNG, or WebP · max 2 MB"
                  file={files?.photo ?? null}
                  isPending={isPending}
                  onUpload={() => triggerUpload(photoRef, uploadStaffPhoto)}
                  onDelete={handleDelete}
                />

                <Separator />

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
