"use client";

import Link from "next/link";
import { startTransition, useActionState, useEffect, useMemo, useRef, useState } from "react";
import { useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Check, ChevronsUpDown, Loader2, CalendarPlus, Info, Package } from "lucide-react";
import { formatInTimeZone, fromZonedTime } from "date-fns-tz";
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
import type { ClinicWorkingHoursValues } from "@/lib/validations/settings";
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
import { getAvailableTimeSlots } from "@/actions/time-slots";
import type { AvailabilityResult } from "@/lib/booking/availability";
import type { Tables } from "@/types/database";
import { useClinicSettings } from "@/contexts/clinic-settings-context";
import { CALENDAR_STYLES } from "@/components/appointments/calendar-visuals";
import { UnsavedChangesGuard } from "@/components/shared/unsaved-changes-guard";
import { useTranslations } from "next-intl";

export type Patient = Pick<
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
export type Doctor = Pick<Tables<"profiles">, "id" | "full_name" | "department_id">;
type PatientDoctorRelation = Doctor | Doctor[] | null;
export type Department = Pick<Tables<"departments">, "id" | "name">;
export type InsuranceProvider = Pick<Tables<"insurance_providers">, "id" | "name">;
export type AppointmentPackageOption = Pick<
  Tables<"patient_packages">,
  "id" | "patient_id" | "name" | "total_sessions" | "used_sessions" | "price_per_session"
>;
export type PatientWithDoctor = Patient & {
  assigned_doctor?: PatientDoctorRelation;
};

interface AppointmentFormProps {
  action: (prev: ActionResult | null, fd: FormData) => Promise<ActionResult>;
  patients: PatientWithDoctor[];
  doctors: Doctor[];
  departments: Department[];
  insuranceProviders: InsuranceProvider[];
  packages?: AppointmentPackageOption[];
  defaultPatientId?: string;
  defaultDoctorId?: string;
  defaultDepartmentId?: string;
  defaultInsuranceId?: string;
  clinicWorkingHours?: ClinicWorkingHoursValues;
  onPatientChange?: (patient: PatientWithDoctor | null) => void;
  cancelHref?: string;
}


function buildClinicIso(date: string, time: string, timeZone: string): string {
  return fromZonedTime(`${date}T${time}:00`, timeZone).toISOString();
}

function clinicValuePart(
  value: string,
  timeZone: string,
  part: "date" | "time",
): string {
  if (!value || Number.isNaN(new Date(value).getTime())) return "";
  return formatInTimeZone(
    value,
    timeZone,
    part === "date" ? "yyyy-MM-dd" : "HH:mm",
  );
}

function clinicNowParts(timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
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
  const instant = new Date(value).getTime();
  return Number.isFinite(instant) && instant <= Date.now();
}

function getAssignedDoctor(patient: PatientWithDoctor | undefined): Doctor | null {
  const relation = patient?.assigned_doctor;
  if (!relation) return null;
  return Array.isArray(relation) ? (relation[0] ?? null) : relation;
}

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;

function getClosedDaysOfWeek(clinicHours: ClinicWorkingHoursValues): Set<number> {
  if (!clinicHours.some((d) => d.open)) return new Set();
  return new Set(clinicHours.filter((d) => !d.open).map((d) => d.day_of_week));
}

export function AppointmentForm({
  action,
  patients,
  doctors,
  departments,
  insuranceProviders,
  packages = [],
  defaultPatientId,
  defaultDoctorId,
  defaultDepartmentId,
  defaultInsuranceId,
  clinicWorkingHours,
  onPatientChange,
  cancelHref = "/appointments",
}: AppointmentFormProps) {
  const t = useTranslations("appointments");
  const tProtected = useTranslations("protected");
  const closedDays = clinicWorkingHours ? getClosedDaysOfWeek(clinicWorkingHours) : new Set<number>();
  const { formatCurrency, formatSlotTime, locale } = useClinicSettings();
  const [state, formAction, isPending] = useActionState(action, null);
  const [patientOpen, setPatientOpen] = useState(false);
  const [sameDayWarning, setSameDayWarning] = useState(false);
  const [pendingFd, setPendingFd] = useState<FormData | null>(null);
  const [checkingDay, setCheckingDay] = useState(false);
  const [discardDialogOpen, setDiscardDialogOpen] = useState(false);
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
      package_id: null,
      notes: null,
    },
  });

  function applyPatientDefaults(patient: Patient, shouldDirty = true) {
    if (!departmentChangedRef.current) {
      form.setValue("department_id", patient.department_id ?? null, {
        shouldDirty,
        shouldValidate: true,
      });
    }

    if (!doctorChangedRef.current) {
      form.setValue("doctor_id", patient.assigned_doctor_id ?? "", {
        shouldDirty,
        shouldValidate: true,
      });
    }

    if (!insuranceChangedRef.current) {
      form.setValue("insurance_provider_id", patient.insurance_provider_id ?? null, {
        shouldDirty,
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
      applyPatientDefaults(p, false);
      onPatientChange?.(p);
    });
    // Run once on mount; patients list is stable for the lifetime of the page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selectedPatientId = useWatch({ control: form.control, name: "patient_id" });
  const selectedPackageId = useWatch({ control: form.control, name: "package_id" });
  const selectedDoctorId = useWatch({ control: form.control, name: "doctor_id" });
  const selectedDuration = useWatch({ control: form.control, name: "duration_minutes" });
  const activeDept = useWatch({ control: form.control, name: "department_id" }) ?? null;
  const previousPatientIdRef = useRef(defaultPatientId ?? "");
  const availablePackages = useMemo(
    () =>
      packages.filter(
        (pkg) =>
          pkg.patient_id === selectedPatientId &&
          Number(pkg.used_sessions) < Number(pkg.total_sessions),
      ),
    [packages, selectedPatientId],
  );
  const selectedPackage = availablePackages.find((pkg) => pkg.id === selectedPackageId) ?? null;
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
    if (previousPatientIdRef.current !== selectedPatientId) {
      previousPatientIdRef.current = selectedPatientId ?? "";
      form.setValue("package_id", null, {
        shouldDirty: true,
        shouldValidate: true,
      });
    }
  }, [form, selectedPatientId]);

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
  const dateVal = clinicValuePart(scheduledAt, locale.timeZone, "date");

  const [availability, setAvailability] = useState<AvailabilityResult | null>(null);
  const [slotsLoading, setSlotsLoading] = useState(false);

  useEffect(() => {
    if (!selectedDoctorId || !dateVal) {
      queueMicrotask(() => setAvailability(null));
      return;
    }
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      setSlotsLoading(true);
      setAvailability(null);
      getAvailableTimeSlots(selectedDoctorId, dateVal, selectedDuration)
        .then((result) => {
          if (!cancelled) setAvailability(result);
        })
        .catch(() => {
          if (!cancelled) {
            setAvailability({
              slots: [],
              reason: "unable_to_calculate",
              dateIso: dateVal,
              dayOfWeek: new Date(`${dateVal}T12:00:00`).getDay(),
              workingHours: [],
            });
          }
        })
        .finally(() => { if (!cancelled) setSlotsLoading(false); });
    });
    return () => { cancelled = true; };
  }, [selectedDoctorId, dateVal, selectedDuration]);

  const slots = availability?.slots ?? [];
  const openSlots = slots.filter((slot) => !slot.disabled);
  const selectedDoctorName =
    availability?.doctorName ??
    doctors.find((doctor) => doctor.id === selectedDoctorId)?.full_name ??
    t("thisDoctor");
  const selectedWeekday = dateVal
    ? new Intl.DateTimeFormat(locale.locale, {
        weekday: "long",
        timeZone: locale.timeZone,
      }).format(fromZonedTime(`${dateVal}T12:00:00`, locale.timeZone))
    : "";
  const selectedDateIsToday =
    Boolean(dateVal) && dateVal === clinicNowParts(locale.timeZone).date;

  const availabilityMessage = availability
    ? {
        available: null,
        doctor_required: t("selectADoctorAndDateFirst"),
        doctor_not_found: t("availabilityDoctorUnavailable"),
        no_schedule_configured: t("availabilityNoSchedule", {
          doctor: selectedDoctorName,
        }),
        doctor_off_weekday: selectedDateIsToday
          ? t("availabilityDoctorOffToday", { doctor: selectedDoctorName })
          : t("availabilityDoctorDoesNotWorkWeekday", {
              doctor: selectedDoctorName,
              weekday: selectedWeekday,
            }),
        schedule_disabled: t("availabilityScheduleDisabled", {
          doctor: selectedDoctorName,
        }),
        outside_schedule_range: t("availabilityOutsideSchedule", {
          doctor: selectedDoctorName,
        }),
        clinic_closed: t("availabilityClinicClosed"),
        on_leave: t("availabilityDoctorOnLeave", {
          doctor: selectedDoctorName,
        }),
        working_hours_passed: t("availabilityWorkingHoursPassed"),
        all_slots_booked: t("availabilityAllBooked"),
        all_slots_blocked: t("availabilityAllBlocked"),
        duration_unavailable: t("availabilityDurationUnavailable", {
          duration: selectedDuration,
        }),
        unable_to_calculate: t("availabilityUnableToCalculate"),
      }[availability.reason]
    : null;

  function buildFd(values: AppointmentFormValues): FormData {
    const fd = new FormData();
    fd.set("patient_id", values.patient_id);
    fd.set("doctor_id", values.doctor_id);
    if (values.department_id) fd.set("department_id", values.department_id);
    fd.set("scheduled_at", values.scheduled_at);
    fd.set("duration_minutes", String(values.duration_minutes));
    if (values.insurance_provider_id)
      fd.set("insurance_provider_id", values.insurance_provider_id);
    if (values.package_id) fd.set("package_id", values.package_id);
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
        message: t("chooseAFutureDateAndTime"),
      });
      return;
    }

    if (closedDays.size > 0) {
      const dateStr = clinicValuePart(
        values.scheduled_at,
        locale.timeZone,
        "date",
      );
      if (dateStr) {
        const dow = new Date(`${dateStr}T12:00:00`).getDay();
        if (closedDays.has(dow)) {
          form.setError("scheduled_at", {
            type: "validate",
            message: `The clinic is closed on ${DAY_NAMES[dow]}s. Please select a different date.`,
          });
          return;
        }
      }
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
      <UnsavedChangesGuard
        when={
          form.formState.isDirty &&
          !form.formState.isSubmitting &&
          !isPending &&
          !checkingDay
        }
      />
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
              <FormLabel>{t("patient")}</FormLabel>
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
                        : t("searchpatient")}
                      <ChevronsUpDown className="ms-2 h-4 w-4 shrink-0 opacity-50" />
                    </Button>
                  </FormControl>
                </PopoverTrigger>
                <PopoverContent className="w-[400px] p-0" align="start">
                  <Command>
                    <CommandInput placeholder={t("namePhoneFileOrNationalId")} />
                    <CommandList>
                      <CommandEmpty>{t("noPatientsFound")}</CommandEmpty>
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
                              form.setValue("package_id", null, {
                                shouldDirty: true,
                                shouldValidate: true,
                              });
                              setPatientOpen(false);
                              applyPatientDefaults(p);
                              onPatientChange?.(p);
                            }}
                            onSelect={() => {
                              doctorChangedRef.current = false;
                              doctorInteractedRef.current = false;
                              field.onChange(p.id);
                              form.setValue("package_id", null, {
                                shouldDirty: true,
                                shouldValidate: true,
                              });
                              setPatientOpen(false);
                              applyPatientDefaults(p);
                              onPatientChange?.(p);
                            }}
                          >
                            <Check
                              className={cn(
                                "me-2 h-4 w-4",
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
                                  <span className="ms-2 font-mono">
                                    #{p.file_number}
                                  </span>
                                )}
                                {p.national_id && (
                                  <span className="ms-2 font-mono">
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

        {selectedPatientId && (
          <FormField
            control={form.control}
            name="package_id"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{t("packageOptional")}</FormLabel>
                <Select
                  value={field.value ?? "__none__"}
                  onValueChange={(value) =>
                    field.onChange(value === "__none__" ? null : value)
                  }
                  disabled={isPending}
                >
                  <FormControl>
                    <SelectTrigger>
                      <SelectValue placeholder={t("noPackage")} />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    <SelectItem value="__none__">{t("noPackage")}</SelectItem>
                    {availablePackages.map((pkg) => {
                      const remaining =
                        Number(pkg.total_sessions) - Number(pkg.used_sessions);
                      const nextSession = Number(pkg.used_sessions) + 1;
                      return (
                        <SelectItem key={pkg.id} value={pkg.id}>
                          <span className="flex flex-col gap-0.5">
                            <span className="font-medium">{pkg.name}</span>
                            <span className="text-xs text-muted-foreground">
                              {remaining}/{pkg.total_sessions} {t("remainingSession")}{nextSession}
                              {pkg.price_per_session != null
                                ? ` · ${formatCurrency(Number(pkg.price_per_session))}`
                                : ""}
                            </span>
                          </span>
                        </SelectItem>
                      );
                    })}
                  </SelectContent>
                </Select>
                {availablePackages.length === 0 ? (
                  <p className="text-xs text-muted-foreground">
                    {t("noActivePackagesWithRemainingSessions")}</p>
                ) : selectedPackage ? (
                  <div className="flex flex-wrap items-center gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 text-xs text-emerald-700 dark:text-emerald-400">
                    <Package className="h-3.5 w-3.5" />
                    <span className="font-medium">{selectedPackage.name}</span>
                    <span>
                          {t("sessionOfTotal", { session: Number(selectedPackage.used_sessions) + 1, total: selectedPackage.total_sessions })}
                    </span>
                    <span>
                      {Number(selectedPackage.total_sessions) -
                        Number(selectedPackage.used_sessions)}{" "}
                          {t("remaining")}
                    </span>
                    {selectedPackage.price_per_session != null && (
                      <span>{formatCurrency(Number(selectedPackage.price_per_session))}</span>
                    )}
                  </div>
                ) : null}
                <FormMessage />
              </FormItem>
            )}
          />
        )}

        <div className="grid gap-5 sm:grid-cols-2">
          {/* Department */}
          <FormField
            control={form.control}
            name="department_id"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{t("department")}</FormLabel>
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
                      <SelectValue placeholder={t("selectDepartment")} />
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
                <FormLabel>{t("doctor")}</FormLabel>
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
                      <SelectValue placeholder={t("selectDoctor")} />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    {filteredDoctors.length === 0 ? (
                      <SelectItem value="__empty__" disabled>
                        {t("noDoctorsInThisDepartment")}</SelectItem>
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
              const dateVal = clinicValuePart(
                field.value,
                locale.timeZone,
                "date",
              );
              const timeVal = clinicValuePart(
                field.value,
                locale.timeZone,
                "time",
              );
              const today = clinicNowParts(locale.timeZone).date;
              const selectedDow = dateVal ? new Date(`${dateVal}T12:00:00`).getDay() : null;
              const isClosedDay = selectedDow !== null && closedDays.has(selectedDow);
              return (
                <FormItem>
                  <FormLabel>{t("date")}</FormLabel>
                  <FormControl>
                    <Input
                      type="date"
                      disabled={isPending}
                      value={dateVal}
                      min={today}
                      onChange={(e) => {
                        const t = timeVal || "09:00";
                        field.onChange(
                          e.target.value
                            ? buildClinicIso(e.target.value, t, locale.timeZone)
                            : "",
                        );
                      }}
                    />
                  </FormControl>
                  {isClosedDay && (
                    <p className="text-sm text-destructive">
                      {t("theClinicIsClosedOn")}{DAY_NAMES[selectedDow!]}{t("sPleaseSelectADifferentDate")}</p>
                  )}
                  <FormMessage />
                </FormItem>
              );
            }}
          />

          {selectedDoctorId && dateVal && availabilityMessage && !slotsLoading && (
            <div
              role="status"
              className="flex gap-2 rounded-lg border border-sky-500/25 bg-sky-500/5 px-3 py-2.5 text-sm text-foreground"
            >
              <Info className="mt-0.5 size-4 shrink-0 text-sky-600 dark:text-sky-400" />
              <span>{availabilityMessage}</span>
            </div>
          )}

          {availability && availability.workingHours.length > 0 && (
            <div className="rounded-lg border border-border/60 bg-muted/30 px-3 py-2 text-sm">
              <span className="font-medium">{t("workingHours")}</span>{" "}
              {availability.workingHours
                .map(
                  (window) =>
                    `${formatSlotTime(window.start)} – ${formatSlotTime(window.end)}`,
                )
                .join(" · ")}
            </div>
          )}

          {/* Time slot */}
          <FormField
            control={form.control}
            name="scheduled_at"
            render={({ field }) => {
              const timeVal = clinicValuePart(
                field.value,
                locale.timeZone,
                "time",
              );
              const now = clinicNowParts(locale.timeZone);
              const selectedDate = dateVal || now.date;
              const timeSelectionDisabled =
                isPending ||
                slotsLoading ||
                !selectedDoctorId ||
                !dateVal ||
                openSlots.length === 0;
              return (
                <FormItem>
                  <FormLabel>{t("time")}</FormLabel>
                  <Select
                    value={timeVal}
                    onValueChange={(t) => {
                      if (!/^\d{2}:\d{2}$/.test(t)) return;
                      field.onChange(
                        buildClinicIso(selectedDate, t, locale.timeZone),
                      );
                    }}
                    disabled={timeSelectionDisabled}
                  >
                    <FormControl>
                      <SelectTrigger
                        data-calendar-slot-selected={timeVal ? "true" : undefined}
                        className={timeVal ? CALENDAR_STYLES.selectedSlotTrigger : undefined}
                      >
                        {slotsLoading ? (
                          <span className="flex items-center gap-1.5 text-muted-foreground">
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            {t("loading")}</span>
                        ) : (
                          <SelectValue placeholder={t("selectTime")} />
                        )}
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent position="popper" align="start">
                      {slots.length === 0 && !slotsLoading && (
                        <SelectItem value="__empty__" disabled>
                          {selectedDoctorId && dateVal
                            ? availabilityMessage ??
                              t("availabilityUnableToCalculate")
                            : t("selectADoctorAndDateFirst")}
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
                            className={cn(
                              CALENDAR_STYLES.selectedSlotItem,
                              slot.label === "break" && "text-muted-foreground italic",
                            )}
                          >
                            {slot.label ? `${formatSlotTime(slot.time)} — ${t("calendarBreak")}` : formatSlotTime(slot.time)}
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
                <FormLabel>{t("duration")}</FormLabel>
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
                    <SelectItem value="15">{t("15Min")}</SelectItem>
                    <SelectItem value="30">{t("30Min")}</SelectItem>
                    <SelectItem value="45">{t("45Min")}</SelectItem>
                    <SelectItem value="60">{t("60Min")}</SelectItem>
                    <SelectItem value="90">{t("90Min")}</SelectItem>
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
                <FormLabel>{t("insurance")}</FormLabel>
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
                      <SelectValue placeholder={t("noneUnknown")} />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    <SelectItem value="__none__">{t("noneUnknown")}</SelectItem>
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
              <FormLabel>{t("notesOptional")}</FormLabel>
              <FormControl>
                <Textarea
                  {...field}
                  value={field.value ?? ""}
                  placeholder={t("anyAdditionalInformation")}
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
          {form.formState.isDirty ? (
            <Button
              type="button"
              variant="outline"
              disabled={isPending || checkingDay}
              onClick={() => setDiscardDialogOpen(true)}
            >
              {t("cancel")}
            </Button>
          ) : (
            <Button asChild type="button" variant="outline">
              <Link
                href={cancelHref}
                aria-disabled={isPending}
                tabIndex={isPending ? -1 : undefined}
                className={isPending ? "pointer-events-none opacity-50" : undefined}
              >
                {t("cancel")}
              </Link>
            </Button>
          )}
          <Button type="submit" disabled={isPending || checkingDay} className="gap-2">
            {isPending || checkingDay ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <CalendarPlus className="h-4 w-4" />
            )}
            {t("bookAppointment")}</Button>
        </div>
      </form>

      <AlertDialog open={sameDayWarning} onOpenChange={setSameDayWarning}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("patientAlreadyHasAnAppointmentToday")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("thisPatientAlreadyHasAnAppointment")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setPendingFd(null)}>
              {t("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (pendingFd) submitFd(pendingFd);
                setPendingFd(null);
              }}
            >
              {t("continueBooking")}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={discardDialogOpen} onOpenChange={setDiscardDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{tProtected("discardChangesTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {tProtected("discardChangesDescription")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{tProtected("keepEditing")}</AlertDialogCancel>
            <AlertDialogAction asChild>
              <Link href={cancelHref}>{tProtected("discardChanges")}</Link>
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Form>
  );
}
