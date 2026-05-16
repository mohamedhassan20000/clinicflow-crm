"use client";

import { startTransition, useActionState, useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import {
  CheckCircle2,
  FileImage,
  Loader2,
  Save,
  Upload,
  User,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PatientPhoneInput } from "@/components/patients/patient-phone-input";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { patientSchema, type PatientFormValues } from "@/lib/validations/patient";
import type { ActionResult } from "@/actions/patients";
import type { Tables } from "@/types/database";
import { formatDoctorName } from "@/lib/format-doctor";
import { uploadPatientAvatar } from "@/actions/patient-avatar";
import { uploadPatientDocument } from "@/actions/patient-documents";

const BLOOD_TYPES = ["A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-"] as const;

interface Department {
  id: string;
  name: string;
  color: string;
}

interface Doctor {
  id: string;
  full_name: string;
  department_id: string | null;
}

interface InsuranceProvider {
  id: string;
  name: string;
}

interface PatientFormProps {
  action: (prev: ActionResult | null, fd: FormData) => Promise<ActionResult>;
  defaultValues?: Partial<PatientFormValues>;
  patient?: Tables<"patients">;
  departments?: Department[];
  doctors?: Doctor[];
  insuranceProviders?: InsuranceProvider[];
}

// ── Upload step after new patient creation ────────────────────────────────────

function FileUploadRow({
  label,
  hint,
  fileRef,
  accept,
  uploading,
  uploaded,
  onTrigger,
  onClear,
}: {
  label: string;
  hint: string;
  fileRef: React.RefObject<HTMLInputElement | null>;
  accept: string;
  uploading: boolean;
  uploaded: boolean;
  onTrigger: () => void;
  onClear: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-lg border border-border/40 bg-muted/20 p-3">
      <div className="flex items-center gap-3 min-w-0">
        <FileImage className="h-4 w-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0">
          <p className="text-sm font-medium">{label}</p>
          <p className="text-xs text-muted-foreground">{hint}</p>
        </div>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        {uploaded ? (
          <>
            <span className="text-xs text-emerald-600 font-medium">Uploaded</span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="gap-1 text-destructive hover:text-destructive h-7 px-2"
              onClick={onClear}
            >
              <X className="h-3 w-3" />
            </Button>
          </>
        ) : (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="gap-1.5 h-7"
            disabled={uploading}
            onClick={onTrigger}
          >
            {uploading ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Upload className="h-3 w-3" />
            )}
            {uploading ? "Uploading…" : "Upload"}
          </Button>
        )}
      </div>
      <input ref={fileRef} type="file" accept={accept} className="hidden" />
    </div>
  );
}

function PatientFilesStep({
  patientId,
  autoUploadAvatar,
  onDone,
}: {
  patientId: string;
  autoUploadAvatar?: File | null;
  onDone: () => void;
}) {
  const avatarRef = useRef<HTMLInputElement>(null);
  const nationalIdRef = useRef<HTMLInputElement>(null);
  const insuranceRef = useRef<HTMLInputElement>(null);

  const [avatarUploaded, setAvatarUploaded] = useState(false);
  const [nationalIdUploaded, setNationalIdUploaded] = useState(false);
  const [insuranceUploaded, setInsuranceUploaded] = useState(false);

  // Start as uploading if a pre-selected file was passed in
  const [avatarUploading, setAvatarUploading] = useState(!!autoUploadAvatar);
  const [nationalIdUploading, setNationalIdUploading] = useState(false);
  const [insuranceUploading, setInsuranceUploading] = useState(false);

  // Auto-upload avatar selected before patient creation (state is pre-set to uploading above)
  useEffect(() => {
    if (!autoUploadAvatar) return;
    const fd = new FormData();
    fd.set("avatar", autoUploadAvatar);
    uploadPatientAvatar(patientId, fd).then((res) => {
      setAvatarUploading(false);
      if (res.error) {
        toast.error(`Photo upload failed: ${res.error}. You can retry below.`);
      } else {
        setAvatarUploaded(true);
      }
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function triggerFileInput(
    ref: React.RefObject<HTMLInputElement | null>,
    onFile: (file: File) => void,
  ) {
    if (!ref.current) return;
    ref.current.value = "";
    ref.current.onchange = () => {
      const file = ref.current?.files?.[0];
      if (file) onFile(file);
    };
    ref.current.click();
  }

  async function handleAvatarUpload(file: File) {
    setAvatarUploading(true);
    const fd = new FormData();
    fd.set("avatar", file);
    const res = await uploadPatientAvatar(patientId, fd);
    setAvatarUploading(false);
    if (res.error) toast.error(res.error);
    else setAvatarUploaded(true);
  }

  async function handleDocUpload(
    file: File,
    category: "national_id" | "insurance",
    setUploading: (v: boolean) => void,
    setUploaded: (v: boolean) => void,
  ) {
    setUploading(true);
    const fd = new FormData();
    fd.set("file", file);
    const res = await uploadPatientDocument(patientId, category, fd);
    setUploading(false);
    if (res.error) toast.error(res.error);
    else setUploaded(true);
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <span className="flex h-9 w-9 items-center justify-center rounded-full bg-emerald-500/10">
          <CheckCircle2 className="h-5 w-5 text-emerald-600" />
        </span>
        <div>
          <p className="text-sm font-semibold">Patient created successfully</p>
          <p className="text-xs text-muted-foreground">
            Optionally upload files below, then open the patient profile.
          </p>
        </div>
      </div>

      <Separator />

      <div className="space-y-3">
        <FileUploadRow
          label="Profile photo"
          hint="JPEG, PNG, or WebP · max 2 MB"
          fileRef={avatarRef}
          accept="image/jpeg,image/png,image/webp"
          uploading={avatarUploading}
          uploaded={avatarUploaded}
          onTrigger={() => triggerFileInput(avatarRef, handleAvatarUpload)}
          onClear={() => setAvatarUploaded(false)}
        />
        <FileUploadRow
          label="National ID image"
          hint="JPEG, PNG, WebP, or PDF · max 10 MB"
          fileRef={nationalIdRef}
          accept="image/jpeg,image/png,image/webp,application/pdf"
          uploading={nationalIdUploading}
          uploaded={nationalIdUploaded}
          onTrigger={() =>
            triggerFileInput(nationalIdRef, (f) =>
              handleDocUpload(f, "national_id", setNationalIdUploading, setNationalIdUploaded),
            )
          }
          onClear={() => setNationalIdUploaded(false)}
        />
        <FileUploadRow
          label="Insurance card image"
          hint="JPEG, PNG, WebP, or PDF · max 10 MB"
          fileRef={insuranceRef}
          accept="image/jpeg,image/png,image/webp,application/pdf"
          uploading={insuranceUploading}
          uploaded={insuranceUploaded}
          onTrigger={() =>
            triggerFileInput(insuranceRef, (f) =>
              handleDocUpload(f, "insurance", setInsuranceUploading, setInsuranceUploaded),
            )
          }
          onClear={() => setInsuranceUploaded(false)}
        />
      </div>

      <Button className="w-full" onClick={onDone}>
        Open patient profile
      </Button>
    </div>
  );
}

// ── Main form ─────────────────────────────────────────────────────────────────

export function PatientForm({
  action,
  defaultValues,
  departments = [],
  doctors = [],
  insuranceProviders = [],
  patient,
}: PatientFormProps) {
  const router = useRouter();
  const [state, formAction, isPending] = useActionState(action, null);
  const [, startNav] = useTransition();

  const [selectedAvatar, setSelectedAvatar] = useState<File | null>(null);
  const [avatarPreview, setAvatarPreview] = useState<string | null>(null);
  const avatarPickerRef = useRef<HTMLInputElement>(null);

  // When patientId is set the creation succeeded — show the file upload step
  const createdPatientId = state?.patientId ?? null;

  const form = useForm<PatientFormValues>({
    resolver: zodResolver(patientSchema),
    defaultValues: {
      full_name: "",
      national_id: "",
      date_of_birth: "",
      phone: "",
      email: "",
      blood_type: null,
      department_id: null,
      assigned_doctor_id: null,
      insurance_provider_id: null,
      ...defaultValues,
    },
  });

  const selectedDept = form.watch("department_id");
  const filteredDoctors = selectedDept
    ? doctors.filter((d) => d.department_id === selectedDept)
    : doctors;

  function onSubmit(values: PatientFormValues) {
    const fd = new FormData();
    Object.entries(values).forEach(([k, v]) => {
      if (v != null) fd.set(k, String(v));
    });
    startTransition(() => formAction(fd));
  }

  function navigateToProfile() {
    if (!createdPatientId) return;
    startNav(() => router.push(`/patients/${createdPatientId}`));
  }

  // After creation — show upload step
  if (createdPatientId) {
    return (
      <PatientFilesStep
        patientId={createdPatientId}
        autoUploadAvatar={selectedAvatar}
        onDone={navigateToProfile}
      />
    );
  }

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-5">
        {state?.error && (
          <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
            {state.error}
          </div>
        )}

        {/* Optional profile photo picker */}
        <div className="flex items-center gap-4 rounded-lg border border-border/40 bg-muted/20 p-3">
          <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-muted overflow-hidden">
            {avatarPreview ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={avatarPreview} alt="Preview" className="h-full w-full object-cover" />
            ) : (
              <User className="h-7 w-7 text-muted-foreground" />
            )}
          </span>
          <div className="flex flex-col gap-1.5 min-w-0">
            <p className="text-sm font-medium leading-none">
              Profile photo{" "}
              <span className="text-xs font-normal text-muted-foreground">(optional)</span>
            </p>
            <div className="flex items-center gap-2">
              <button
                type="button"
                className="inline-flex h-7 items-center gap-1.5 rounded-md border border-input bg-background px-3 text-xs font-medium shadow-sm transition-colors hover:bg-accent hover:text-accent-foreground disabled:opacity-50"
                disabled={isPending}
                onClick={() => avatarPickerRef.current?.click()}
              >
                <Upload className="h-3 w-3" />
                {selectedAvatar ? "Change" : "Choose"}
              </button>
              {selectedAvatar && (
                <button
                  type="button"
                  className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs text-muted-foreground transition-colors hover:text-destructive disabled:opacity-50"
                  disabled={isPending}
                  onClick={() => {
                    setSelectedAvatar(null);
                    setAvatarPreview(null);
                  }}
                >
                  <X className="h-3.5 w-3.5" />
                  Remove
                </button>
              )}
            </div>
            {selectedAvatar && (
              <p className="truncate text-xs text-muted-foreground max-w-48">{selectedAvatar.name}</p>
            )}
          </div>
          <input
            ref={avatarPickerRef}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (!file) return;
              setSelectedAvatar(file);
              setAvatarPreview(URL.createObjectURL(file));
              e.target.value = "";
            }}
          />
        </div>

        <div className="grid gap-5 sm:grid-cols-2">
          <FormField
            control={form.control}
            name="full_name"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Full name</FormLabel>
                <FormControl>
                  <Input {...field} placeholder="e.g. John Smith" disabled={isPending} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="national_id"
            render={({ field }) => (
              <FormItem>
                <FormLabel>National ID</FormLabel>
                <FormControl>
                  <Input
                    {...field}
                    placeholder="11 digits"
                    disabled={isPending}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          {patient?.file_number && (
            <FormItem>
              <FormLabel>File number</FormLabel>
              <FormControl>
                <Input value={patient.file_number} readOnly disabled className="font-mono" />
              </FormControl>
            </FormItem>
          )}

          <FormField
            control={form.control}
            name="date_of_birth"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Date of birth</FormLabel>
                <FormControl>
                  <Input {...field} type="date" disabled={isPending} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="blood_type"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Blood type</FormLabel>
                <Select
                  value={field.value ?? undefined}
                  onValueChange={(v) => field.onChange(v)}
                  disabled={isPending}
                >
                  <FormControl>
                    <SelectTrigger>
                      <SelectValue placeholder="Select blood type" />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    {BLOOD_TYPES.map((bt) => (
                      <SelectItem key={bt} value={bt}>
                        {bt}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="department_id"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Department</FormLabel>
                <Select
                  value={field.value ?? "__none__"}
                  onValueChange={(v) => field.onChange(v === "__none__" ? null : v)}
                  disabled={isPending}
                >
                  <FormControl>
                    <SelectTrigger>
                      <SelectValue placeholder="Assign department" />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    <SelectItem value="__none__">Unassigned</SelectItem>
                    {departments.map((d) => (
                      <SelectItem key={d.id} value={d.id}>
                        <span className="inline-flex items-center gap-2">
                          <span
                            className="h-2.5 w-2.5 rounded-full"
                            style={{ backgroundColor: d.color }}
                          />
                          {d.name}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="assigned_doctor_id"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Treating doctor</FormLabel>
                <Select
                  value={field.value ?? "__none__"}
                  onValueChange={(v) => field.onChange(v === "__none__" ? null : v)}
                  disabled={isPending}
                >
                  <FormControl>
                    <SelectTrigger>
                      <SelectValue placeholder="Assign doctor" />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    <SelectItem value="__none__">Unassigned</SelectItem>
                    {filteredDoctors.map((d) => (
                      <SelectItem key={d.id} value={d.id}>
                        {formatDoctorName(d.full_name)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="insurance_provider_id"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Insurance</FormLabel>
                <Select
                  value={field.value ?? "__none__"}
                  onValueChange={(v) => field.onChange(v === "__none__" ? null : v)}
                  disabled={isPending}
                >
                  <FormControl>
                    <SelectTrigger>
                      <SelectValue placeholder="Select insurance" />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    <SelectItem value="__none__">No insurance</SelectItem>
                    {insuranceProviders.map((provider) => (
                      <SelectItem key={provider.id} value={provider.id}>
                        {provider.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="phone"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Phone number</FormLabel>
                <FormControl>
                  <PatientPhoneInput {...field} value={field.value ?? ""} disabled={isPending} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="email"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Email</FormLabel>
                <FormControl>
                  <Input
                    {...field}
                    type="email"
                    placeholder="patient@example.com"
                    disabled={isPending}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        <div className="flex justify-end gap-3 pt-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => window.history.back()}
            disabled={isPending}
          >
            Cancel
          </Button>
          <Button type="submit" disabled={isPending} className="gap-2">
            {isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Save className="h-4 w-4" />
            )}
            Save patient
          </Button>
        </div>
      </form>
    </Form>
  );
}
