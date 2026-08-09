-- P7-6A follow-up: PostgreSQL trigger records expose only the columns of the
-- current table. Branch before reading parent/id columns so shared helpers do
-- not touch a field that does not exist on the active trigger record.

create or replace function public.enforce_clinical_line_item_draft()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status text;
  v_parent_id uuid;
begin
  if tg_table_name = 'prescription_medications' then
    if tg_op = 'DELETE' then v_parent_id := old.prescription_id;
    else v_parent_id := new.prescription_id; end if;
    select p.status into v_status from public.prescriptions p where p.id = v_parent_id;
  else
    if tg_op = 'DELETE' then v_parent_id := old.lab_request_id;
    else v_parent_id := new.lab_request_id; end if;
    select l.status into v_status from public.lab_requests l where l.id = v_parent_id;
  end if;
  if v_status is distinct from 'draft' then
    raise exception 'CLINICAL_LINE_ITEMS_LOCKED' using errcode = '23514';
  end if;
  if tg_op <> 'DELETE' then new.updated_at := now(); end if;
  return coalesce(new, old);
end;
$$;
revoke all on function public.enforce_clinical_line_item_draft() from public;

create or replace function public.write_clinical_child_audit_log()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_old jsonb := case when tg_op = 'INSERT' then null else to_jsonb(old) end;
  v_new jsonb := case when tg_op = 'DELETE' then null else to_jsonb(new) end;
  v_record_id uuid;
  v_parent_id uuid;
  v_clinic_id uuid;
begin
  if tg_table_name = 'prescription_medications' then
    if tg_op = 'DELETE' then
      v_parent_id := old.prescription_id; v_record_id := old.id;
    else
      v_parent_id := new.prescription_id; v_record_id := new.id;
    end if;
    select p.clinic_id into v_clinic_id from public.prescriptions p where p.id = v_parent_id;
  elsif tg_table_name = 'lab_request_tests' then
    if tg_op = 'DELETE' then
      v_parent_id := old.lab_request_id; v_record_id := old.id;
    else
      v_parent_id := new.lab_request_id; v_record_id := new.id;
    end if;
    select l.clinic_id into v_clinic_id from public.lab_requests l where l.id = v_parent_id;
  elsif tg_table_name = 'drug_catalog_departments' then
    if tg_op = 'DELETE' then v_parent_id := old.drug_catalog_id;
    else v_parent_id := new.drug_catalog_id; end if;
    select c.clinic_id into v_clinic_id from public.drug_catalog c where c.id = v_parent_id;
    v_record_id := v_parent_id;
  else
    if tg_op = 'DELETE' then v_parent_id := old.lab_test_catalog_id;
    else v_parent_id := new.lab_test_catalog_id; end if;
    select c.clinic_id into v_clinic_id from public.lab_test_catalog c where c.id = v_parent_id;
    v_record_id := v_parent_id;
  end if;
  insert into public.audit_logs (actor_id, clinic_id, action, table_name, record_id, old_data, new_data)
  values (auth.uid(), v_clinic_id, tg_op, tg_table_name, v_record_id, v_old, v_new);
  return coalesce(new, old);
end;
$$;
revoke all on function public.write_clinical_child_audit_log() from public;
