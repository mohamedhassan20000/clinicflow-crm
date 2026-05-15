-- Performance Phase 1: additive indexes for high-volume filters and summaries.
-- These indexes do not change RLS, constraints, or application behavior.

create index if not exists perf_appointments_clinic_status_paid_at_idx
  on public.appointments (clinic_id, status, paid_at desc)
  where deleted_at is null and paid_at is not null;
create index if not exists perf_appointments_clinic_doctor_scheduled_idx
  on public.appointments (clinic_id, doctor_id, scheduled_at)
  where deleted_at is null;
create index if not exists perf_appointments_clinic_department_scheduled_idx
  on public.appointments (clinic_id, department_id, scheduled_at)
  where deleted_at is null;
create index if not exists perf_outstanding_settlements_clinic_settled_at_idx
  on public.outstanding_settlements (clinic_id, settled_at desc);
create index if not exists perf_appointments_clinic_patient_outstanding_idx
  on public.appointments (clinic_id, patient_id)
  where deleted_at is null and outstanding_amount > 0;
create index if not exists perf_patient_deposits_clinic_patient_idx
  on public.patient_deposits (clinic_id, patient_id);
create index if not exists perf_patients_file_number_trgm_idx
  on public.patients using gin (file_number public.gin_trgm_ops)
  where is_deleted = false;
create index if not exists perf_patients_national_id_trgm_idx
  on public.patients using gin (national_id public.gin_trgm_ops)
  where is_deleted = false;
create index if not exists perf_patients_phone_trgm_idx
  on public.patients using gin (phone public.gin_trgm_ops)
  where is_deleted = false;
