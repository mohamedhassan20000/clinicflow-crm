"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  CheckCircle2,
  FileText,
  FolderOpen,
  GraduationCap,
  Loader2,
  Upload,
  User,
  UserPlus,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { CreateStaffForm } from "@/components/settings/staff-form";
import { createStaff } from "@/actions/settings";
import { resetUserPageVisibilityToRoleDefaults } from "@/actions/page-permissions";
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

type Department = Pick<Tables<"departments">, "id" | "name">;

interface CreatedSnapshot {
  staffId: string;
  full_name: string;
  role: string;
  department_name: string | null;
  phone: string | null;
}

export function AddStaffDialog({
  departments,
  currentRole,
  canCustomize,
}: {
  departments: Department[];
  currentRole: string;
  canCustomize: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<"form" | "files">("form");
  const [created, setCreated] = useState<CreatedSnapshot | null>(null);
  const [files, setFiles] = useState<StaffFiles | null>(null);
  const [loadingFiles, setLoadingFiles] = useState(false);
  const [isPending, startTransition] = useTransition();

  const photoRef = useRef<HTMLInputElement>(null);
  const contractRef = useRef<HTMLInputElement>(null);
  const certRef = useRef<HTMLInputElement>(null);
  const otherRef = useRef<HTMLInputElement>(null);

  function handleOpenChange(next: boolean) {
    setOpen(next);
    if (!next) {
      // Reset after close animation
      setTimeout(() => {
        setStep("form");
        setCreated(null);
        setFiles(null);
      }, 300);
    }
  }

  function handleCreated(
    staffId: string,
    snapshot: Omit<CreatedSnapshot, "staffId">,
  ) {
    const snap: CreatedSnapshot = { staffId, ...snapshot };
    setCreated(snap);
    setStep("files");
    router.refresh();

    // Preload file list
    setLoadingFiles(true);
    listStaffFiles(staffId)
      .then((res) => {
        if (res.error) toast.error(res.error);
        else setFiles(res.data ?? null);
      })
      .finally(() => setLoadingFiles(false));
  }

  function triggerUpload(
    ref: React.RefObject<HTMLInputElement | null>,
    action: (
      staffId: string,
      fd: FormData,
    ) => Promise<{ data?: StaffFiles; error?: string }>,
  ) {
    if (!created || !ref.current) return;
    ref.current.value = "";
    ref.current.onchange = () => {
      const file = ref.current?.files?.[0];
      if (!file) return;
      const fd = new FormData();
      fd.set("file", file);
      startTransition(async () => {
        const res = await action(created.staffId, fd);
        if (res.error) toast.error(res.error);
        else {
          setFiles(res.data ?? null);
          toast.success("File uploaded.");
        }
      });
    };
    ref.current.click();
  }

  function handleDelete(filePath: string) {
    if (!created) return;
    startTransition(async () => {
      const res = await deleteStaffFile(created.staffId, filePath);
      if (res.error) toast.error(res.error);
      else {
        setFiles(res.data ?? null);
        toast.success("File removed.");
      }
    });
  }

  function useRoleDefaults() {
    if (!created) return;
    startTransition(async () => {
      const res = await resetUserPageVisibilityToRoleDefaults(created.staffId);
      if (res.error) toast.error(res.error);
      else {
        toast.success("Role default pages saved.");
        handleOpenChange(false);
      }
    });
  }

  function customizePagesNow() {
    if (!created) return;
    handleOpenChange(false);
    router.push(`/settings/customize?staff=${created.staffId}`);
  }

  return (
    <Sheet open={open} onOpenChange={handleOpenChange}>
      <SheetTrigger asChild>
        <Button size="sm" className="gap-2">
          <UserPlus className="h-4 w-4" />
          Add staff
        </Button>
      </SheetTrigger>

      <SheetContent
        side="right"
        className="flex w-full flex-col gap-0 p-0 sm:max-w-2xl"
      >
        {step === "form" ? (
          <>
            <SheetHeader className="border-b border-border/50 px-8 py-5 pr-14">
              <SheetTitle>Add staff member</SheetTitle>
              <SheetDescription>
                Fill in the details below. You can upload documents right after
                creating the account.
              </SheetDescription>
            </SheetHeader>
            <div className="flex-1 overflow-y-auto px-8 py-6">
              <CreateStaffForm
                action={createStaff}
                departments={departments}
                onCreated={handleCreated}
              />
            </div>
          </>
        ) : (
          <>
            {/* Step 2 — Documents */}
            <SheetHeader className="border-b border-border/50 px-8 py-5 pr-14">
              <div className="flex items-center gap-3">
                <span className="flex h-10 w-10 items-center justify-center rounded-full bg-emerald-500/10">
                  <CheckCircle2 className="h-5 w-5 text-emerald-600" />
                </span>
                <div>
                  <SheetTitle className="text-base">
                    {created?.full_name} created
                  </SheetTitle>
                  <p className="text-xs text-muted-foreground">
                    Upload their documents below — you can also do this later from
                    the staff profile.
                  </p>
                </div>
              </div>
            </SheetHeader>

            <div className="flex-1 overflow-y-auto px-8 py-6">
              <div className="mb-6 grid gap-2 sm:grid-cols-2">
                {currentRole === "admin" && canCustomize && (
                  <Button
                    type="button"
                    variant="default"
                    onClick={customizePagesNow}
                    disabled={!created || isPending}
                  >
                    Customize pages now
                  </Button>
                )}
                <Button
                  type="button"
                  variant="outline"
                  onClick={useRoleDefaults}
                  disabled={!created || isPending}
                  className={
                    currentRole === "admin" && canCustomize ? "" : "sm:col-span-2"
                  }
                >
                  {isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  Use role defaults
                </Button>
              </div>

              {/* Hidden inputs */}
              <input
                ref={photoRef}
                type="file"
                accept="image/jpeg,image/png,image/webp"
                className="hidden"
              />
              <input
                ref={contractRef}
                type="file"
                accept=".pdf,.doc,.docx,image/jpeg,image/png"
                className="hidden"
              />
              <input
                ref={certRef}
                type="file"
                accept=".pdf,.doc,.docx,image/jpeg,image/png"
                className="hidden"
              />
              <input
                ref={otherRef}
                type="file"
                accept=".pdf,.doc,.docx,image/jpeg,image/png"
                className="hidden"
              />

              {loadingFiles ? (
                <div className="flex justify-center py-16">
                  <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                </div>
              ) : (
                <div className="space-y-8">
                  <DocSection
                    title="Profile photo"
                    icon={<User className="h-4 w-4" />}
                    hint="JPEG, PNG, or WebP · max 2 MB"
                    file={files?.photo ?? null}
                    isPending={isPending}
                    onUpload={() => triggerUpload(photoRef, uploadStaffPhoto)}
                    onDelete={handleDelete}
                    multi={false}
                  />

                  <Separator />

                  <DocSection
                    title="Employment contract"
                    icon={<FileText className="h-4 w-4" />}
                    hint="PDF or Word · max 10 MB"
                    file={files?.contract ?? null}
                    isPending={isPending}
                    onUpload={() =>
                      triggerUpload(contractRef, uploadStaffContract)
                    }
                    onDelete={handleDelete}
                    multi={false}
                  />

                  <Separator />

                  <DocSection
                    title="University certificates"
                    icon={<GraduationCap className="h-4 w-4" />}
                    hint="PDF or Word · max 10 MB each"
                    files={files?.certificates ?? []}
                    isPending={isPending}
                    onUpload={() =>
                      triggerUpload(certRef, uploadStaffCertificate)
                    }
                    onDelete={handleDelete}
                    multi={true}
                    addLabel="Add certificate"
                    emptyLabel="No certificates uploaded yet"
                  />

                  <Separator />

                  <DocSection
                    title="Other documents"
                    icon={<FolderOpen className="h-4 w-4" />}
                    hint="PDF or Word · max 10 MB each"
                    files={files?.other ?? []}
                    isPending={isPending}
                    onUpload={() =>
                      triggerUpload(otherRef, uploadStaffOtherDoc)
                    }
                    onDelete={handleDelete}
                    multi={true}
                    addLabel="Add document"
                    emptyLabel="No other documents uploaded yet"
                  />
                </div>
              )}
            </div>

            <div className="border-t border-border/50 px-8 py-4">
              <Button className="w-full" onClick={() => handleOpenChange(false)}>
                Done
              </Button>
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

// ── shared doc section components ─────────────────────────────────────────────

type DocSectionProps =
  | {
      multi: false;
      title: string;
      icon: React.ReactNode;
      hint: string;
      file: StaffFile | null;
      files?: never;
      isPending: boolean;
      onUpload: () => void;
      onDelete: (path: string) => void;
      addLabel?: never;
      emptyLabel?: never;
    }
  | {
      multi: true;
      title: string;
      icon: React.ReactNode;
      hint: string;
      file?: never;
      files: StaffFile[];
      isPending: boolean;
      onUpload: () => void;
      onDelete: (path: string) => void;
      addLabel: string;
      emptyLabel: string;
    };

function DocSection(props: DocSectionProps) {
  const { title, icon, hint, isPending, onUpload, onDelete } = props;

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
          {props.multi
            ? props.addLabel
            : props.file
              ? "Replace"
              : "Upload"}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">{hint}</p>

      {props.multi ? (
        props.files.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border/60 py-6 text-center text-xs text-muted-foreground">
            {props.emptyLabel}
          </p>
        ) : (
          <div className="space-y-1.5">
            {props.files.map((f) => (
              <FileRow
                key={f.path}
                file={f}
                isPending={isPending}
                onDelete={onDelete}
              />
            ))}
          </div>
        )
      ) : props.file ? (
        <FileRow
          file={props.file}
          isPending={isPending}
          onDelete={onDelete}
        />
      ) : (
        <p className="rounded-lg border border-dashed border-border/60 py-6 text-center text-xs text-muted-foreground">
          Not uploaded yet
        </p>
      )}
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
