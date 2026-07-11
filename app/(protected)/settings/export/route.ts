import { NextResponse } from "next/server";
import { requireRole } from "@/lib/rbac";
import { createClient } from "@/lib/supabase/server";
import { buildZip, csvRow, type ZipEntry } from "@/lib/zip";

const SIGNED_URL_TTL_SECONDS = 24 * 60 * 60;

// PostgREST caps each response at max_rows (1,000), so every table is paged
// until a short page proves exhaustion. Page size must not exceed that cap.
const PAGE_SIZE = 1000;

// Hard budget for the in-memory archive: the ZIP is buffered in a serverless
// function, so the export refuses (413) instead of exhausting memory or
// silently truncating. Well below the 4 GiB non-ZIP64 limit buildZip enforces.
const MAX_EXPORT_BYTES = 256 * 1024 * 1024;

class ExportTooLargeError extends Error {}
class ExportQueryError extends Error {}
class ExportSigningError extends Error {}

type PageQuery<Row> = (
  from: number,
  to: number,
) => PromiseLike<{ data: Row[] | null; error: { message: string } | null }>;

/**
 * Fetches every row of one table through the caller's RLS session. Offset
 * pagination over a stable ordering (callers order by created_at, id); loops
 * until a short page so the export is complete regardless of table size.
 */
async function fetchAll<Row>(label: string, query: PageQuery<Row>): Promise<Row[]> {
  const rows: Row[] = [];
  for (;;) {
    const { data, error } = await query(rows.length, rows.length + PAGE_SIZE - 1);
    if (error) throw new ExportQueryError(label);
    rows.push(...(data ?? []));
    if (!data || data.length < PAGE_SIZE) return rows;
  }
}

/**
 * Per-clinic data export (§3.6): admin-only ZIP of CSVs plus 24-hour signed
 * URLs for stored documents. Every query runs through the caller's RLS
 * session, so the export can never contain another tenant's rows.
 *
 * Medical notes: metadata only by design (§3.6 — note bodies stay inside the
 * app). Notes whose patient is soft-deleted are excluded because the
 * medical_notes RLS policy requires a live patient row; including them would
 * need a service-role bypass of the PHI boundary, which this route must never
 * hold. patients.csv still lists soft-deleted patients (with deleted_at), so
 * the exclusion is visible rather than silent. Flagged in the P1D report.
 */
export async function GET() {
  const user = await requireRole("admin");
  const supabase = await createClient();

  try {
    const [patients, appointments, notes, services, deposits, settlements, documents] =
      await Promise.all([
        fetchAll("patients", (from, to) =>
          supabase
            .from("patients")
            .select("id, file_number, full_name, phone, email, date_of_birth, national_id, blood_type, created_at, is_archived, deleted_at")
            .eq("clinic_id", user.clinicId)
            .order("created_at")
            .order("id")
            .range(from, to),
        ),
        fetchAll("appointments", (from, to) =>
          supabase
            .from("appointments")
            .select("id, scheduled_at, duration_minutes, status, patient_id, doctor_id, notes, created_at")
            .eq("clinic_id", user.clinicId)
            .order("scheduled_at")
            .order("id")
            .range(from, to),
        ),
        fetchAll("medical_notes", (from, to) =>
          supabase
            .from("medical_notes")
            .select("id, patient_id, doctor_id, created_at, created_by")
            .order("created_at")
            .order("id")
            .range(from, to),
        ),
        fetchAll("appointment_services", (from, to) =>
          supabase
            .from("appointment_services")
            .select("id, appointment_id, name, price, quantity, created_at")
            .eq("clinic_id", user.clinicId)
            .order("created_at")
            .order("id")
            .range(from, to),
        ),
        fetchAll("patient_deposits", (from, to) =>
          supabase
            .from("patient_deposits")
            .select("id, patient_id, amount, payment_method, note, created_at")
            .eq("clinic_id", user.clinicId)
            .order("created_at")
            .order("id")
            .range(from, to),
        ),
        fetchAll("outstanding_settlements", (from, to) =>
          supabase
            .from("outstanding_settlements")
            .select("id, patient_id, appointment_id, amount, payment_method, settled_at, note, created_at")
            .eq("clinic_id", user.clinicId)
            .order("created_at")
            .order("id")
            .range(from, to),
        ),
        fetchAll("patient_documents", (from, to) =>
          supabase
            .from("patient_documents")
            .select("id, patient_id, file_name, category, mime_type, size_bytes, storage_path, created_at")
            .eq("clinic_id", user.clinicId)
            .is("deleted_at", null)
            .order("created_at")
            .order("id")
            .range(from, to),
        ),
      ]);

    // Signed URLs: a failed bulk call fails the export outright; a per-entry
    // failure is recorded in a signing_error column so the archive is never an
    // apparently complete export with silently unusable blank links.
    const signedByPath = new Map<string, string>();
    if (documents.length > 0) {
      const { data: signed, error: signError } = await supabase.storage
        .from("patient-assets")
        .createSignedUrls(documents.map((row) => row.storage_path), SIGNED_URL_TTL_SECONDS);
      if (signError) throw new ExportSigningError();
      for (const entry of signed ?? []) {
        if (entry.path && entry.signedUrl && !entry.error) {
          signedByPath.set(entry.path, entry.signedUrl);
        }
      }
    }

    const entries: ZipEntry[] = [];
    let totalBytes = 0;
    const addEntry = (name: string, rows: string[]) => {
      const data = rows.join("\n");
      totalBytes += Buffer.byteLength(data, "utf8");
      if (totalBytes > MAX_EXPORT_BYTES) throw new ExportTooLargeError();
      entries.push({ name, data });
    };

    addEntry("patients.csv", [
      csvRow(["id", "file_number", "full_name", "phone", "email", "date_of_birth", "national_id", "blood_type", "created_at", "is_archived", "deleted_at"]),
      ...patients.map((row) =>
        csvRow([row.id, row.file_number, row.full_name, row.phone, row.email, row.date_of_birth, row.national_id, row.blood_type, row.created_at, String(row.is_archived), row.deleted_at]),
      ),
    ]);
    addEntry("appointments.csv", [
      csvRow(["id", "scheduled_at", "duration_minutes", "status", "patient_id", "doctor_id", "notes", "created_at"]),
      ...appointments.map((row) =>
        csvRow([row.id, row.scheduled_at, row.duration_minutes, row.status, row.patient_id, row.doctor_id, row.notes, row.created_at]),
      ),
    ]);
    // Metadata only by design (§3.6): note bodies stay inside the app.
    addEntry("medical_notes_metadata.csv", [
      csvRow(["id", "patient_id", "doctor_id", "created_at", "created_by"]),
      ...notes.map((row) => csvRow([row.id, row.patient_id, row.doctor_id, row.created_at, row.created_by])),
    ]);
    addEntry("invoices.csv", [
      csvRow(["type", "id", "patient_id", "appointment_id", "name", "amount", "quantity", "payment_method", "settled_at", "note", "created_at"]),
      ...services.map((row) =>
        csvRow(["service", row.id, "", row.appointment_id, row.name, row.price, row.quantity, "", "", "", row.created_at]),
      ),
      ...deposits.map((row) =>
        csvRow(["deposit", row.id, row.patient_id, "", "", row.amount, "", row.payment_method, "", row.note, row.created_at]),
      ),
      ...settlements.map((row) =>
        csvRow(["settlement", row.id, row.patient_id, row.appointment_id, "", row.amount, "", row.payment_method, row.settled_at, row.note, row.created_at]),
      ),
    ]);
    addEntry("documents.csv", [
      csvRow(["id", "patient_id", "file_name", "category", "mime_type", "size_bytes", "signed_url_24h", "signing_error"]),
      ...documents.map((row) => {
        const signedUrl = signedByPath.get(row.storage_path);
        return csvRow([row.id, row.patient_id, row.file_name, row.category, row.mime_type, row.size_bytes, signedUrl ?? "", signedUrl ? "" : "signing_failed"]);
      }),
    ]);

    const zip = buildZip(entries);
    const stamp = new Date().toISOString().slice(0, 10);
    return new NextResponse(new Uint8Array(zip), {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="clinic-export-${stamp}.zip"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    if (error instanceof ExportQueryError) {
      return NextResponse.json({ error: "Export failed. Please try again." }, { status: 500 });
    }
    if (error instanceof ExportSigningError) {
      return NextResponse.json(
        { error: "Export failed: document links could not be signed. Please try again." },
        { status: 502 },
      );
    }
    if (error instanceof ExportTooLargeError || error instanceof RangeError) {
      return NextResponse.json(
        {
          error:
            "Export exceeds the 256 MB self-service limit. Contact platform support for an operator-assisted export of the full dataset.",
        },
        { status: 413 },
      );
    }
    throw error;
  }
}
