import "server-only";

import { createClient } from "@/lib/supabase/server";

export type FollowupPatientFilters = {
  query?: string | null;
  name?: string | null;
  fileNumber?: string | null;
  nationalId?: string | null;
  phone?: string | null;
};

type ClinicClient = Awaited<ReturnType<typeof createClient>>;

export function hasFollowupPatientFilters(filters: FollowupPatientFilters): boolean {
  return Boolean(
    filters.query
    || filters.name
    || filters.fileNumber
    || filters.nationalId
    || filters.phone,
  );
}

export async function resolveFollowupPatientIds(
  clinicId: string,
  filters: FollowupPatientFilters,
  client?: ClinicClient,
): Promise<string[] | null> {
  if (!hasFollowupPatientFilters(filters)) return null;
  const supabase = client ?? await createClient();
  let query = supabase
    .from("patients")
    .select("id")
    .eq("clinic_id", clinicId)
    .limit(500);

  if (filters.query) {
    query = query.or(
      `full_name.ilike.%${filters.query}%,phone.ilike.%${filters.query}%,file_number.ilike.%${filters.query}%,national_id.ilike.%${filters.query}%`,
    );
  }
  if (filters.name) query = query.ilike("full_name", `%${filters.name}%`);
  if (filters.fileNumber) query = query.ilike("file_number", `%${filters.fileNumber}%`);
  if (filters.nationalId) query = query.ilike("national_id", `%${filters.nationalId}%`);
  if (filters.phone) query = query.ilike("phone", `%${filters.phone}%`);

  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return (data ?? []).map((patient) => patient.id);
}
