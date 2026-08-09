-- P7-8 F1 — External-subject sick leaves.
-- The founder decision keeps SICK_LEAVE_CERTIFICATE.allowsExternalSubject = true.
-- Prescriptions and lab requests already allow a null appointment for external
-- subjects; sick_leaves.appointment_id was NOT NULL, making that path a dead end.
--
-- After this migration:
--   * registered patient (patient_id NOT NULL) still requires an appointment;
--   * external subject (patient_id NULL) may omit the appointment.
-- The exactly-one-of subject rule (sick_leaves_subject_check) and the shared
-- tenant/reference trigger (which still enforces patient⇄appointment match when
-- an appointment is present) are unchanged.

alter table public.sick_leaves
  alter column appointment_id drop not null;

alter table public.sick_leaves
  add constraint sick_leaves_appointment_required_for_patient check (
    patient_id is null or appointment_id is not null
  );

comment on constraint sick_leaves_appointment_required_for_patient on public.sick_leaves is
  'P7-8: appointment required for registered patients; optional for external subjects.';
