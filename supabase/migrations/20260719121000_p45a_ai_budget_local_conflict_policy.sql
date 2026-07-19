-- P4.5A local-forward compatibility for a database that applied 20260719120000
-- before its explicit PL/pgSQL name-conflict directive was added. A fresh
-- database already has the directive and takes the no-op path below.
do $migration$
declare
  v_signature regprocedure := 'public.reserve_ai_budget(uuid,uuid,uuid,uuid,date,text,text,text,text,text,text,text,text[],text,text,text,bigint,bigint,integer)'::regprocedure;
  v_definition text;
begin
  select pg_get_functiondef(v_signature) into v_definition;
  if position('#variable_conflict use_column' in v_definition) = 0 then
    v_definition := replace(
      v_definition,
      E'AS $function$\n',
      E'AS $function$\n#variable_conflict use_column\n'
    );
    if position('#variable_conflict use_column' in v_definition) = 0 then
      raise exception 'AI_BUDGET_FUNCTION_REWRITE_FAILED';
    end if;
    execute v_definition;
  end if;
end;
$migration$;
