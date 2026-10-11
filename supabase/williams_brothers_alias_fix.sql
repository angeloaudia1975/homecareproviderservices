-- ============================================================================================================
-- HCPS · Williams Brothers generic alias → the company, not the Princeton branch.  NOT RUN — awaiting approval.
-- Rollback: supabase/williams_brothers_alias_fix_rollback.sql.
--
-- On 2026-10-10 23:48 UTC the Commission Report Import "Assign" saved the generic name
-- "Williams Brothers Healthcare Pharmacy" on Williams Brothers PRINCETON (3396b841…). The importers already pick
-- the branch by ship-to ZIP inside the family (the September brochure line, ZIP 47670, is Princeton either way),
-- but analytics, the signal engine and any row without a dealer use the alias directly — so every future
-- Williams Brothers line that reaches them by name would be credited to Princeton. RULE 2026-10-10: an alias
-- names the COMPANY. This moves that one alias to Williams Brothers Washington HQ (86baecc2…).
-- It changes ONE dealer_aliases row and nothing else: no monthly_sales row, no dealer, no account number.
-- (Two older generic aliases have the same shape and are listed for review only — not changed here:
--  "Williams Brothers Healthcare" → Henderson, "WILLIAMS BROS HEALTH CARE" → Columbus.)
-- ============================================================================================================
begin;
do $$ begin
  if (select count(*) from public.dealer_aliases
      where alias_norm = 'WILLIAMS BROTHERS HEALTHCARE PHARMACY'
        and dealer_id = '3396b841-f1f3-41a3-9255-f9d880479f1d') <> 1 then
    raise exception 'wb_alias_fix: the alias is not (or no longer) on Princeton — nothing written'; end if;
  if not exists (select 1 from public.dealers where id = '86baecc2-448f-4759-988d-bdc01c5123e6' and parent_id is null) then
    raise exception 'wb_alias_fix: Williams Brothers Washington HQ not found as a company — nothing written'; end if;
  if (select parent_id from public.dealers where id = '3396b841-f1f3-41a3-9255-f9d880479f1d') is distinct from '86baecc2-448f-4759-988d-bdc01c5123e6'::uuid then
    raise exception 'wb_alias_fix: Princeton is no longer a branch of the HQ — nothing written'; end if;
end $$;
update public.dealer_aliases
   set dealer_id = '86baecc2-448f-4759-988d-bdc01c5123e6'
 where alias_norm = 'WILLIAMS BROTHERS HEALTHCARE PHARMACY'
   and dealer_id = '3396b841-f1f3-41a3-9255-f9d880479f1d';
do $$ begin
  if (select count(*) from public.dealer_aliases where alias_norm = 'WILLIAMS BROTHERS HEALTHCARE PHARMACY'
      and dealer_id = '86baecc2-448f-4759-988d-bdc01c5123e6') <> 1 then raise exception 'wb_alias_fix: not moved'; end if;
end $$;
commit;
