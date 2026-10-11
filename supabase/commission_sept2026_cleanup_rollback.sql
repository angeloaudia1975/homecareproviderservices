-- ============================================================================================================
-- HCPS · ROLLBACK of commission_sept2026_cleanup.sql — puts the 7 Strongback September 2026 rows back.
-- NOT RUN. Use only if Angelo asks to undo the cleanup.
--
-- In ONE transaction: takes the 7 quarantined, not-yet-restored rows of reason
-- 'strongback_2026_09_blank_commission_rows', checks none of their ids is in monthly_sales, re-inserts each
-- WHOLE row from its stored copy (same id, same values), stamps the quarantine rows restored (kept as history),
-- and proves the restored rows are byte-identical to the preview (fingerprint c7b81f69…) and to their stored
-- copies, with sales and commission totals unchanged. The quarantine table itself is left in place.
-- Every UPDATE carries a WHERE clause (pg-safeupdate).
-- ============================================================================================================
begin;

create temp table _r on commit drop as
select * from public.monthly_sales_quarantine
where reason = 'strongback_2026_09_blank_commission_rows' and restored_at is null;

create temp table _rb on commit drop as
select count(*) n, sum(amount) sales, sum(commission) comm from public.monthly_sales;

do $$ begin
  if (select count(*) from _r) <> 7 then
    raise exception 'sept2026_rollback: expected 7 quarantined rows to restore, found % — nothing written', (select count(*) from _r); end if;
  if exists (select 1 from public.monthly_sales m where m.id::text in (select sales_row_id from _r)) then
    raise exception 'sept2026_rollback: a row with one of these ids already exists — nothing written'; end if;
  if exists (select 1 from _r where row_fp <> md5(row_data::text)) then
    raise exception 'sept2026_rollback: a stored copy no longer matches its fingerprint — nothing written'; end if;
end $$;

insert into public.monthly_sales
select (jsonb_populate_record(null::public.monthly_sales, r.row_data)).* from _r r;

update public.monthly_sales_quarantine x
   set restored_at = now(), restored_by = 'Angelo Audia (approved rollback) via SQL editor as ' || current_user
 where x.id in (select id from _r);

do $$ declare b record; a record; begin
  select * into b from _rb;
  select count(*) n, sum(amount) sales, sum(commission) comm into a from public.monthly_sales;
  if a.n <> b.n + 7 then raise exception 'sept2026_rollback: row count % -> %, expected +7', b.n, a.n; end if;
  if a.sales is distinct from b.sales or a.comm is distinct from b.comm then raise exception 'sept2026_rollback: totals moved'; end if;
  if (select md5(string_agg(to_jsonb(m)::text, '|' order by m.id::text)) from public.monthly_sales m
      where m.id::text in (select sales_row_id from _r)) <> 'c7b81f69492ca44fb229a3d757cdc015' then
    raise exception 'sept2026_rollback: restored rows differ from the preview fingerprint'; end if;
  if exists (select 1 from _r join public.monthly_sales m on m.id::text = _r.sales_row_id where md5(to_jsonb(m)::text) <> _r.row_fp) then
    raise exception 'sept2026_rollback: a restored row differs from its stored copy'; end if;
end $$;

commit;
