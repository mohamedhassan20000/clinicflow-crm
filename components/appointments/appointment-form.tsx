"use client";

import { useActionState, useState } from "react";
import { useForm } from "react-hook-form";
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
import type { ActionResult } from "@/actions/appointments";
import type { Tables } from "@/types/database";

type Patient = Pick<Tables<"patients">, "id" | "full_name" | "phone">;
type Doctor = Pick<Tables<"profiles">, "id" | "full_name" | "department_id">;
type Department = Pick<Tables<"departments">, "id" | "name">;
type InsuranceProvider = Pick<Tables<"insurance_providers">, "id" | "name">;

interface AppointmentFormProps {
  action: (prev: ActionResult | null, fd: FormData) => Promise<ActionResult>;
  patients: Patient[];
  doctors: Doctor[];
  departments: Department[];
  insuranceProviders: InsuranceProvider[];
  defaultPatientId?: string;
}

// Generate 30-min slots 08:00-18:00
const TIME_SLOTS = Array.from({ length: 21 }, (_, i) => {
  const totalMinutes = 8 * 60 + i * 30;
  const h = String(Math.floor(totalMinutes / 60)).padStart(2, "0");
  const m = String(totalMinutes % 60).padStart(2, "0");
  return `${h}:${m}`;
});

export function AppointmentForm({
  action,
  patients,
  doctors,
  departments,
  insuranceProviders,
  defaultPatientId,
}: AppointmentFormProps) {
  const [state, formAction, isPending] = useActionState(action, null);
  const [patientOpen, setPatientOpen] = useState(false);
  const [selectedDept, setSelectedDept] = useState<string | null>(null);

  const form = useForm<AppointmentFormValues, unknown, AppointmentFormValues>({
    resolver: zodResolver(appointmentSchema) as never,
    defaultValues: {
      patient_id: defaultPatientId ?? "",
      doctor_id: "",
      department_id: null,
      scheduled_at: "",
      duration_minutes: 30,
      insurance_provider_id: null,
      notes: null,
    },
  });

  const filteredDoctors = selectedDept
    ? doctors.filter((d) => d.department_id === selectedDept)
    : doctors;

  function onSubmit(values: AppointmentFormValues) {
    const fd = new FormData();
    fd.set("patient_id", values.patient_id);
    fd.set("doctor_id", values.doctor_id);
    if (values.department_id) fd.set("department_id", values.department_id);
    fd.set("scheduled_at", values.scheduled_at);
    fd.set("duration_minutes", String(values.duration_minutes));
    if (values.insurance_provider_id)
      fd.set("insurance_provider_id", values.insurance_provider_id);
    if (values.notes) fd.set("notes", values.notes);
    formAction(fd);
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
              <Popover open={patientOpen} onOpenChange={setPatientOpen}>
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
                    <CommandInput placeholder="Name or phone…" />
                    <CommandList>
                      <CommandEmpty>No patients found.</CommandEmpty>
                      <CommandGroup>
                        {patients.map((p) => (
                          <CommandItem
                            key={p.id}
                            value={`${p.full_name} ${p.phone}`}
                            onSelect={() => {
                              field.onChange(p.id);
                              setPatientOpen(false);
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
                            <div>
                              <p className="font-medium">{p.full_name}</p>
                              <p className="text-xs text-muted-foreground">
                                {p.phone}
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
                  value={field.value ?? "__any__"}
                  onValueChange={(v) => {
                    const next = v === "__any__" ? null : v;
                    field.onChange(next);
                    setSelectedDept(next);
                    form.setValue("doctor_id", "");
                  }}
                  disabled={isPending}
                >
                  <FormControl>
                    <SelectTrigger>
                      <SelectValue placeholder="Any department" />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    <SelectItem value="__any__">Any department</SelectItem>
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
                  onValueChange={field.onChange}
                  disabled={isPending}
                >
                  <FormControl>
                    <SelectTrigger>
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
              return (
                <FormItem>
                  <FormLabel>Date</FormLabel>
                  <FormControl>
                    <Input
                      type="date"
                      disabled={isPending}
                      value={dateVal}
                      min={new Date().toISOString().split("T")[0]}
                      onChange={(e) => {
                        const t = timeVal || "09:00";
                        field.onChange(
                          e.target.value ? `${e.target.value}T${t}:00` : "",
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
              const dateVal = field.value ? field.value.split("T")[0] : "";
              const timeVal = field.value
                ? field.value.split("T")[1]?.slice(0, 5)
                : "";
              return (
                <FormItem>
                  <FormLabel>Time</FormLabel>
                  <Select
                    value={timeVal}
                    onValueChange={(t) => {
                      const d = dateVal || new Date().toISOString().split("T")[0];
                      field.onChange(`${d}T${t}:00`);
                    }}
                    disabled={isPending}
                  >
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder="Select time" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {TIME_SLOTS.map((t) => (
                        <SelectItem key={t} value={t}>
                          {t}
                        </SelectItem>
                      ))}
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
                  onValueChange={(v) => field.onChange(v === "__none__" ? null : v)}
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
          <Button type="submit" disabled={isPending} className="gap-2">
            {isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <CalendarPlus className="h-4 w-4" />
            )}
            Book appointment
          </Button>
        </div>
      </form>
    </Form>
  );
}
