"use client";

import { startTransition, useActionState, useEffect, useMemo, useRef, useState } from "react";
import { useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Check, ChevronsUpDown, Loader2, CalendarPlus } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
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
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  appointmentSchema,
  type AppointmentFormValues,
} from "@/lib/validations/appointment";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { checkSameDayPatient, type ActionResult } from "@/actions/appointments";
import { getAvailableTimeSlots, type SlotInfo } from "@/actions/time-slots";
import type { Tables } from "@/types/database";

type Patient = Pick<
  Tables<"patients">,
  | "id"
  | "full_name"
  | "phone"
  | "department_id"
  | "assigned_doctor_id"
  | "insurance_provider_id"
  | "national_id"
  | "file_number"
>;
type Doctor = Pick<Tables<"profiles">, "id" | "full_name" | "department_id">;
type PatientDoctorRelation = Doctor | Doctor[] | null;
type Department = Pick<Tables<"departments">, "id" | "name">;
type InsuranceProvider = Pick<Tables<"insurance_providers">, "id" | "name">;
type PatientWithDoctor = Patient & {
  assigned_doctor?: PatientDoctorRelation;
};

interface AppointmentFormProps {
  action: (prev: ActionResult | null, fd: FormData) => Promise<ActionResult>;
  patients: PatientWithDoctor[];
  doctors: Doctor[];
  departments: Department[];
  insuranceProviders: InsuranceProvider[];
  defaultPatientId?: string;
  defaultDoctorId?: string;
  defaultDepartmentId?: string;
  defaultInsuranceId?: string;
}


// All clinic times are authored in Europe/Istanbul (UTC+3, no DST).
// Tag the local date/time with the +03:00 offset so Postgres timestamptz
// stores the exact wall-clock moment the receptionist picked, regardless
// of server or browser timezone.
const CLINIC_TZ_OFFSET = "+03:00";
function buildClinicIso(date: string, time: string): string {
  return `${date}T${time}:00${CLINIC_TZ_OFFSET}`;
}

function clinicNowParts() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Istanbul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date());
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const hour = Number(get("hour"));
  const minute = Number(get("minute"));
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    minutes: hour * 60 + minute,
  };
}

function timeToMinutes(time: string): number {
  const [h, m] = time.split(":").map(Number);
  return h * 60 + m;
}

function isPastClinicSlot(value: string): boolean {
  const date = value.split("T")[0] ?? "";
  const time = value.split("T")[1]?.slice(0, 5) ?? "";
  if (!date || !time) return false;
  const now = clinicNowParts();
  if (date < now.date) return true;
  if (date > now.date) return false;
  return timeToMinutes(time) <= now.minutes;
}

function getAssignedDoctor(patient: PatientWithDoctor | undefined): Doctor | null {
  const relation = patient?.assigned_doctor;
  if (!relation) return null;
  return Array.isArray(relation) ? (relation[0] ?? null) : relation;
}

export function AppointmentForm({
  action,
  patients,
  doctors,
  departments,
  insuranceProviders,
  defaultPatientId,
  defaultDoctorId,
  defaultDepartmentId,
  defaultInsuranceId,
}: AppointmentFormProps) {
  const [state, formAction, isPending] = useActionState(action, null);
  const [patientOpen, setPatientOpen] = useState(false);
  const [sameDayWarning, setSameDayWarning] = useState(false);
  const [pendingFd, setPendingFd] = useState<FormData | null>(null);
  const [checkingDay, setCheckingDay] = useState(false);
  // Initialize refs to true when URL defaults are provided so that applyPatientDefaults
  // (triggered by defaultPatientId) does not overwrite the pre-filled values.
  const departmentChangedRef = useRef(!!defaultDepartmentId);
  const doctorChangedRef = useRef(!!defaultDoctorId);
  const doctorInteractedRef = useRef(false);
  const insuranceChangedRef = useRef(!!defaultInsuranceId);

  const form = useForm<AppointmentFormValues, unknown, AppointmentFormValues>({
    resolver: zodResolver(appointmentSchema) as never,
    defaultValues: {
      patient_id: defaultPatientId ?? "",
      doctor_id: defaultDoctorId ?? "",
      department_id: defaultDepartmentId ?? departments[0]?.id ?? null,
      scheduled_at: "",
      duration_minutes: 30,
      insurance_provider_id: defaultInsuranceId ?? null,
      notes: null,
    },
  });

  function applyPatientDefaults(patient: Patient) {
    if (!departmentChangedRef.current) {
      form.setValue("department_id", patient.department_id ?? null, {
        shouldDirty: true,
        shouldValidate: true,
      });
    }

    if (!doctorChangedRef.current) {
      form.setValue("doctor_id", patient.assigned_doctor_id ?? "", {
        shouldDirty: true,
        shouldValidate: true,
      });
    }

    if (!insuranceChangedRef.current) {
      form.setValue("insurance_provider_id", patient.insurance_provider_id ?? null, {
        shouldDirty: true,
        shouldValidate: true,
      });
    }
  }

  // When the page is opened with ?patient_id=… (e.g. "Book for this patient"
  // from the patient file), preselect the patient's appointment context.
  useEffect(() => {
    if (!defaultPatientId) return;
    const p = patients.find((x) => x.id === defaultPatientId);
    if (!p) return;
    queueMicrotask(() => {
      applyPatientDefaults(p);
    });
    // Run once on mount; patients list is stable for the lifetime of the page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selectedPatientId = useWatch({ control: form.control, name: "patient_id" });
  const selectedDoctorId = useWatch({ control: form.control, name: "doctor_id" });
  const activeDept = useWatch({ control: form.control, name: "department_id" }) ?? null;
  const selectedPatientDoctor = getAssignedDoctor(
    patients.find((p) => p.id === selectedPatientId),
  );
  const filteredDoctors = useMemo(() => {
    const base = activeDept
      ? doctors.filter((d) => d.department_id === activeDept)
      : doctors;
    const selectedDoctor =
      doctors.find((d) => d.id === selectedDoctorId) ??
      selectedPatientDoctor ??
      null;

    if (!selectedDoctor || base.some((d) => d.id === selectedDoctor.id)) {
      return base;
    }
    return [...base, selectedDoctor];
  }, [activeDept, doctors, selectedDoctorId, selectedPatientDoctor]);

  useEffect(() => {
    if (!selectedPatientId || doctorChangedRef.current) return;
    const patient = patients.find((p) => p.id === selectedPatientId);
    if (!patient) return;
    const doctorId = patient.assigned_doctor_id ?? "";
    if (form.getValues("doctor_id") === doctorId) return;
    form.setValue("doctor_id", doctorId, {
      shouldDirty: true,
      shouldValidate: true,
    });
  }, [form, patients, selectedPatientId]);

  // ── Smart time slots ───────────────────────────────────────────────────────
  const scheduledAt = useWatch({ control: form.control, name: "scheduled_at" });
  const dateVal = scheduledAt ? scheduledAt.split("T")[0] ?? "" : "";

  const [slots, setSlots] = useState<SlotInfo[]>([]);
  const [slotsLoading, setSlotsLoading] = useState(false);

  useEffect(() => {
    if (!selectedDoctorId || !dateVal) {
      setSlots([]);
      return;
    }
    let cancelled = false;
    setSlotsLoading(true);
    getAvailableTimeSlots(selectedDoctorId, dateVal)
      .then(({ slots: s }) => { if (!cancelled) setSlots(s); })
      .finally(() => { if (!cancelled) setSlotsLoading(false); });
    return () => { cancelled = true; };
  }, [selectedDoctorId, dateVal]);

  function buildFd(values: AppointmentFormValues): FormData {
    const fd = new FormData();
    fd.set("patient_id", values.patient_id);
    fd.set("doctor_id", values.doctor_id);
    if (values.department_id) fd.set("department_id", values.department_id);
    fd.set("scheduled_at", values.scheduled_at);
    fd.set("duration_minutes", String(values.duration_minutes));
    if (values.insurance_provider_id)
      fd.set("insurance_provider_id", values.insurance_provider_id);
    if (values.notes) fd.set("notes", values.notes);
    return fd;
  }

  function submitFd(fd: FormData) {
    startTransition(() => formAction(fd));
  }

  function onSubmit(values: AppointmentFormValues) {
    if (isPastClinicSlot(values.scheduled_at)) {
      form.setError("scheduled_at", {
        type: "validate",
        message: "Choose a future date and time for the appointment.",
      });
      return;
    }

    const fd = buildFd(values);
    setCheckingDay(true);
    checkSameDayPatient(values.patient_id, values.scheduled_at)
      .then(({ hasSameDay }) => {
        if (hasSameDay) {
          setPendingFd(fd);
          setSameDayWarning(true);
        } else {
          submitFd(fd);
        }
      })
      .finally(() => setCheckingDay(false));
  }

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-5">
        {state?.error && (
          <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
            {state.error}
          </div>
        )}

        {/* Patient combobox */}
        <FormField
          control={form.control}
          name="patient_id"
          render={({ field }) => (
            <FormItem className="flex flex-col">
              <FormLabel>Patient</FormLabel>
              <Popover
                open={patientOpen}
                onOpenChange={(open) => {
                  setPatientOpen(open);
                  if (!open || !doctorChangedRef.current) return;
                  const patient = patients.find((p) => p.id === field.value);
                  if (!patient) return;
                  doctorChangedRef.current = false;
                  doctorInteractedRef.current = false;
                  applyPatientDefaults(patient);
                }}
              >
                <PopoverTrigger asChild>
                  <FormControl>
                    <Button
                      variant="outline"
                      role="combobox"
                      disabled={isPending}
                      className={cn(
                        "w-full justify-between font-normal",
                        !field.value && "text-muted-foreground",
                      )}
                    >
                      {field.value
                        ? patients.find((p) => p.id === field.value)?.full_name
                        : "Search patient…"}
                      <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                    </Button>
                  </FormControl>
                </PopoverTrigger>
                <PopoverContent className="w-[400px] p-0" align="start">
                  <Command>
                    <CommandInput placeholder="Name, phone, file # or national ID…" />
                    <CommandList>
                      <CommandEmpty>No patients found.</CommandEmpty>
                      <CommandGroup>
                        {patients.map((p) => (
                          <CommandItem
                            key={p.id}
                            data-testid={`patient-option-${p.id}`}
                            value={`${p.full_name} ${p.phone} ${p.file_number ?? ""} ${p.national_id ?? ""}`}
                            onClick={() => {
                              doctorChangedRef.current = false;
                              doctorInteractedRef.current = false;
                              field.onChange(p.id);
                              setPatientOpen(false);
                              applyPatientDefaults(p);
                            }}
                            onSelect={() => {
                              doctorChangedRef.current = false;
                              doctorInteractedRef.current = false;
                              field.onChange(p.id);
                              setPatientOpen(false);
                              applyPatientDefaults(p);
                            }}
                          >
                            <Check
                              className={cn(
                                "mr-2 h-4 w-4",
                                field.value === p.id
                                  ? "opacity-100"
                                  : "opacity-0",
                              )}
                            />
                            <div className="min-w-0">
                              <p className="font-medium">{p.full_name}</p>
                              <p className="text-xs text-muted-foreground">
                                {p.phone}
                                {p.file_number && (
                                  <span className="ml-2 font-mono">
                                    #{p.file_number}
                                  </span>
                                )}
                                {p.national_id && (
                                  <span className="ml-2 font-mono">
                                    {p.national_id}
                                  </span>
                                )}
                              </p>
                            </div>
                          </CommandItem>
                        ))}
                      </CommandGroup>
                    </CommandList>
                  </Command>
                </PopoverContent>
              </Popover>
              <FormMessage />
            </FormItem>
          )}
        />

        <div className="grid gap-5 sm:grid-cols-2">
          {/* Department */}
          <FormField
            control={form.control}
            name="department_id"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Department</FormLabel>
                <Select
                  value={field.value ?? undefined}
                  onValueChange={(v) => {
                    departmentChangedRef.current = true;
                    field.onChange(v);
                    if (!doctorChangedRef.current) form.setValue("doctor_id", "");
                  }}
                  disabled={isPending}
                >
                  <FormControl>
                    <SelectTrigger>
                      <SelectValue placeholder="Select department" />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    {departments.map((d) => (
                      <SelectItem key={d.id} value={d.id}>
                        {d.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )}
          />

          {/* Doctor */}
          <FormField
            control={form.control}
            name="doctor_id"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Doctor</FormLabel>
                <Select
                  value={field.value}
                  onValueChange={(value) => {
                    if (doctorInteractedRef.current) {
                      doctorChangedRef.current = true;
                    }
                    field.onChange(value);
                  }}
                  disabled={isPending}
                >
                  <FormControl>
                    <SelectTrigger
                      onPointerDown={() => {
                        doctorInteractedRef.current = true;
                      }}
                      onKeyDown={() => {
                        doctorInteractedRef.current = true;
                      }}
                    >
                      <SelectValue placeholder="Select doctor" />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    {filteredDoctors.length === 0 ? (
                      <SelectItem value="__empty__" disabled>
                        No doctors in this department
                      </SelectItem>
                    ) : (
                      filteredDoctors.map((d) => (
                        <SelectItem key={d.id} value={d.id}>
                          {d.full_name}
                        </SelectItem>
                      ))
                    )}
                  </SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )}
          />

          {/* Date */}
          <FormField
            control={form.control}
            name="scheduled_at"
            render={({ field }) => {
              const dateVal = field.value ? field.value.split("T")[0] : "";
              const timeVal = field.value
                ? field.value.split("T")[1]?.slice(0, 5)
                : "";
              const today = clinicNowParts().date;
              return (
                <FormItem>
                  <FormLabel>Date</FormLabel>
                  <FormControl>
                    <Input
                      type="date"
                      disabled={isPending}
                      value={dateVal}
                      min={today}
                      onChange={(e) => {
                        const t = timeVal || "09:00";
                        field.onChange(
                          e.target.value ? buildClinicIso(e.target.value, t) : "",
                        );
                      }}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              );
            }}
          />

          {/* Time slot */}
          <FormField
            control={form.control}
            name="scheduled_at"
            render={({ field }) => {
              const timeVal = field.value
                ? field.value.split("T")[1]?.slice(0, 5)
                : "";
              const now = clinicNowParts();
              const selectedDate = dateVal || now.date;
              return (
                <FormItem>
                  <FormLabel>Time</FormLabel>
                  <Select
                    value={timeVal}
                    onValueChange={(t) => {
                      field.onChange(buildClinicIso(selectedDate, t));
                    }}
                    disabled={isPending || slotsLoading}
                  >
                    <FormControl>
                      <SelectTrigger>
                        {slotsLoading ? (
                          <span className="flex items-center gap-1.5 text-muted-foreground">
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            Loading…
                          </span>
                        ) : (
                          <SelectValue placeholder="Select time" />
                        )}
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent position="popper" align="start">
                      {slots.length === 0 && !slotsLoading && (
                        <SelectItem value="__empty__" disabled>
                          {selectedDoctorId && dateVal
                            ? "No slots available"
                            : "Select a doctor and date first"}
                        </SelectItem>
                      )}
                      {slots.map((slot) => {
                        const isPast =
                          selectedDate < now.date ||
                          (selectedDate === now.date &&
                            timeToMinutes(slot.time) <= now.minutes);
                        const isDisabled = slot.disabled || isPast;
                        return (
                          <SelectItem
                            key={slot.time}
                            value={slot.time}
                            disabled={isDisabled}
                            className={
                              slot.label === "Break"
                                ? "text-muted-foreground italic"
                                : slot.label
                                  ? "text-amber-600"
                                  : undefined
                            }
                          >
                            {slot.label ? `${slot.time} — ${slot.label}` : slot.time}
                          </SelectItem>
                        );
                      })}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              );
            }}
          />

          {/* Duration */}
          <FormField
            control={form.control}
            name="duration_minutes"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Duration</FormLabel>
                <Select
                  value={String(field.value)}
                  onValueChange={(v) => field.onChange(Number(v))}
                  disabled={isPending}
                >
                  <FormControl>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    <SelectItem value="15">15 min</SelectItem>
                    <SelectItem value="30">30 min</SelectItem>
                    <SelectItem value="45">45 min</SelectItem>
                    <SelectItem value="60">60 min</SelectItem>
                    <SelectItem value="90">90 min</SelectItem>
                  </SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )}
          />

          {/* Insurance */}
          <FormField
            control={form.control}
            name="insurance_provider_id"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Insurance</FormLabel>
                <Select
                  value={field.value ?? "__none__"}
                  onValueChange={(v) => {
                    insuranceChangedRef.current = true;
                    field.onChange(v === "__none__" ? null : v);
                  }}
                  disabled={isPending}
                >
                  <FormControl>
                    <SelectTrigger>
                      <SelectValue placeholder="None / Unknown" />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    <SelectItem value="__none__">None / Unknown</SelectItem>
                    {insuranceProviders.map((ip) => (
                      <SelectItem key={ip.id} value={ip.id}>
                        {ip.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        {/* Notes */}
        <FormField
          control={form.control}
          name="notes"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Notes (optional)</FormLabel>
              <FormControl>
                <Textarea
                  {...field}
                  value={field.value ?? ""}
                  placeholder="Any additional information…"
                  rows={3}
                  disabled={isPending}
                  className="resize-none text-sm"
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <div className="flex justify-end gap-3 pt-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => window.history.back()}
            disabled={isPending}
          >
            Cancel
          </Button>
          <Button type="submit" disabled={isPending || checkingDay} className="gap-2">
            {isPending || checkingDay ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <CalendarPlus className="h-4 w-4" />
            )}
            Book appointment
          </Button>
        </div>
      </form>

      <AlertDialog open={sameDayWarning} onOpenChange={setSameDayWarning}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Patient already has an appointment today</AlertDialogTitle>
            <AlertDialogDescription>
              This patient already has an appointment scheduled for this day. Do
              you want to continue and book another appointment?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setPendingFd(null)}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (pendingFd) submitFd(pendingFd);
                setPendingFd(null);
              }}
            >
              Continue booking
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Form>
  );
}
