-- HCPS · ROLLBACK of williams_brothers_alias_fix.sql — puts "Williams Brothers Healthcare Pharmacy" back on
-- Williams Brothers Princeton. NOT RUN. One dealer_aliases row; nothing else.
begin;
do $$ begin
  if (select count(*) from public.dealer_aliases where alias_norm = 'WILLIAMS BROTHERS HEALTHCARE PHARMACY'
      and dealer_id = '86baecc2-448f-4759-988d-bdc01c5123e6') <> 1 then
    raise exception 'wb_alias_rollback: the alias is not on the HQ — nothing written'; end if;
end $$;
update public.dealer_aliases
   set dealer_id = '3396b841-f1f3-41a3-9255-f9d880479f1d'
 where alias_norm = 'WILLIAMS BROTHERS HEALTHCARE PHARMACY'
   and dealer_id = '86baecc2-448f-4759-988d-bdc01c5123e6';
commit;
