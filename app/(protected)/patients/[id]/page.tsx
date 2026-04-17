import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft, Pencil, Trash2 } from "lucide-react";
import { requireUser } from "@/lib/rbac";
import { createClient } from "@/lib/supabase/server";
import { MedicalNotesList } from "@/components/patients/medical-notes-list";
import { NoteComposer } from "@/components/patients/note-composer";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { DeletePatientButton } from "@/components/patients/delete-patient-button";

export const metadata: Metadata = { title: "Patient" };

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function PatientDetailPage({ params }: PageProps) {
  const { id } = await params;
  const user = await requireUser();
  const supabase = await createClient();

  const { data: patient } = await supabase
    .from("patients")
    .select("*")
    .eq("id", id)
    .eq("clinic_id", user.clinicId)
    .single();

  if (!patient) notFound();

  const { data: notes } = await supabase
    .from("medical_notes")
    .select("*, profiles!doctor_id(full_name)")
    .eq("patient_id", id)
    .order("created_at", { ascending: false });

  const isAdmin = user.role === "admin";
  const canEdit = user.role !== "manager" && !patient.is_deleted;
  const age = new Date().getFullYear() - new Date(patient.date_of_birth).getFullYear();

  return (
    <div className="space-y-6">
      {/* Breadcrumb */}
      <div className="flex items-center gap-3">
        <Link
          href="/patients"
          className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <ChevronLeft className="h-4 w-4" />
          Patients
        </Link>
      </div>

      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight">
              {patient.full_name}
            </h1>
            {patient.is_deleted && (
              <Badge variant="destructive" className="text-xs">
                Deleted
              </Badge>
            )}
          </div>
          <p className="text-sm text-muted-foreground">
            {age} years old ·{" "}
            {new Date(patient.date_of_birth).toLocaleDateString("tr-TR")}
            {patient.blood_type && ` · ${patient.blood_type}`}
          </p>
        </div>

        {canEdit && (
          <div className="flex items-center gap-2">
            <Link href={`/patients/${id}/edit`}>
              <Button variant="outline" size="sm" className="gap-1.5">
                <Pencil className="h-3.5 w-3.5" />
                Edit
              </Button>
            </Link>
            {isAdmin && !patient.is_deleted && (
              <DeletePatientButton patientId={id} />
            )}
          </div>
        )}
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        {/* Profile card */}
        <div className="lg:col-span-1 space-y-4">
          <div className="rounded-xl border border-border/50 bg-card p-5 space-y-4">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
              Contact
            </h2>
            <dl className="space-y-3 text-sm">
              <div>
                <dt className="text-xs text-muted-foreground">Phone</dt>
                <dd className="font-medium">{patient.phone}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Email</dt>
                <dd className="font-medium break-all">{patient.email}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Registered</dt>
                <dd className="font-medium">
                  {new Date(patient.created_at).toLocaleDateString("tr-TR")}
                </dd>
              </div>
            </dl>
          </div>
        </div>

        {/* Medical notes */}
        <div className="lg:col-span-2 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
              Medical Notes
            </h2>
            <span className="text-xs text-muted-foreground">
              {notes?.length ?? 0} note{notes?.length !== 1 ? "s" : ""}
            </span>
          </div>

          {isAdmin && !patient.is_deleted && (
            <div className="rounded-xl border border-border/50 bg-card p-4">
              <NoteComposer patientId={id} />
            </div>
          )}

          {!isAdmin && (
            <div className="rounded-lg border border-border/30 bg-muted/20 px-4 py-3 text-xs text-muted-foreground">
              Medical notes are visible to admins only.
            </div>
          )}

          {isAdmin && (
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            <MedicalNotesList notes={(notes ?? []) as any} />
          )}
        </div>
      </div>
    </div>
  );
}
