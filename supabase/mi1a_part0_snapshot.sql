-- ============================================================================
-- MI-1a · Part 0 — pre-migration snapshot (run FIRST, immediately before Part 1).
-- Supabase keeps daily physical backups but Point-in-Time Recovery is NOT enabled on this project,
-- and restoring a daily backup would also discard every other change made since it was taken.
-- So MI-1a keeps its own exact copy of the table it touches, inside the database.
-- Creates two tables; changes no existing row. Refuses to overwrite an earlier snapshot.
-- ============================================================================
begin;
do $$ begin
  if to_regclass('public.mi1a_snapshot_monthly_sales') is not null then
    raise exception 'MI-1a snapshot already exists — keep it; do not take a second one over it';
  end if;
end $$;
create table public.mi1a_snapshot_monthly_sales as select * from public.monthly_sales;
create table public.mi1a_snapshot_meta as
select now() as taken_at,
       (select count(*) from public.monthly_sales) as total_rows,
       (select md5(string_agg(concat_ws('|',manufacturer,source,month,rows,sales,commission), ';' order by manufacturer,source,month))
          from (select manufacturer, coalesce(source,'(none)') as source, to_char(period,'YYYY-MM') as month,
                       count(*) as rows, sum(amount) as sales, sum(commission) as commission
                from public.monthly_sales group by 1,2,3) m) as fingerprint;
alter table public.mi1a_snapshot_monthly_sales enable row level security;
alter table public.mi1a_snapshot_meta enable row level security;
-- Must equal the live checks: 11,997 rows · fingerprint dde7a2cef62eb5e5d3525a7a49e9b949 (10 Oct 2026),
-- unless an import ran since — then the new figures are the baseline and are reported before Part 1.
select taken_at, total_rows, fingerprint,
       (select count(*) from public.mi1a_snapshot_monthly_sales) as snapshot_rows
from public.mi1a_snapshot_meta;
commit;
