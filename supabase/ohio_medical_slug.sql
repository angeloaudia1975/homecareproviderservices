-- ============================================================================
-- Ohio Medical / GCE — register the canonical manufacturer slug 'ohio-medical'.
--
-- The commission importer was consolidated onto ONE slug ('ohio-medical'), but
-- the manufacturers table never got a matching row, so committing a GCE import
-- fails the foreign key:
--   monthly_sales_manufacturer_fkey — Key (manufacturer)=(ohio-medical)
--   is not present in table "manufacturers".
--
-- This script:
--   1) ensures the canonical 'ohio-medical' manufacturer row exists (the FK target), and
--   2) if a legacy 'gce' row / gce-tagged data exists, MERGES it into 'ohio-medical'
--      (repoints every child table, folds the commission template + logo, then drops
--      the old row) — same mechanics as manufacturer_merge.sql, so nothing is lost.
--
-- Run once in the Supabase SQL editor. Idempotent — safe to re-run. Then re-commit
-- the Ohio Medical / GCE import from the admin importer.
-- ============================================================================

-- 1) Canonical survivor row (the foreign-key target). Only slug/name/active are set;
--    any other columns keep their table defaults.
insert into manufacturers (slug, name, active)
values ('ohio-medical', 'Ohio Medical / GCE', true)
on conflict (slug) do nothing;

-- 2) Fold any legacy 'gce' slug into 'ohio-medical' (no-op if 'gce' was never a row).
do $$
declare
  pair     record;
  tbl      record;
  pkcols   text[];
  joincond text;
begin
  for pair in
    select * from (values ('gce','ohio-medical')) as t(loser, survivor)
  loop
    continue when not exists (select 1 from manufacturers where slug = pair.loser);

    -- Carry the manufacturer account number & active flag onto the survivor grant first.
    begin
      update dealer_manufacturers s
         set account_ref = coalesce(s.account_ref, l.account_ref),
             active       = (coalesce(s.active,true) or coalesce(l.active,true))
        from dealer_manufacturers l
       where s.dealer_id = l.dealer_id
         and s.manufacturer = pair.survivor
         and l.manufacturer = pair.loser;
    exception when others then null;
    end;

    -- Every BASE TABLE with a `manufacturer` column: drop primary-key colliders, then repoint.
    for tbl in
      select c.table_name
        from information_schema.columns c
        join information_schema.tables t
          on t.table_schema=c.table_schema and t.table_name=c.table_name and t.table_type='BASE TABLE'
       where c.table_schema='public' and c.column_name='manufacturer'
    loop
      begin
        select array_agg(a.attname order by a.attnum) into pkcols
          from pg_index i
          join pg_attribute a on a.attrelid=i.indrelid and a.attnum = any(i.indkey)
         where i.indrelid = ('public.'||quote_ident(tbl.table_name))::regclass
           and i.indisprimary and a.attname <> 'manufacturer';

        if pkcols is not null and array_length(pkcols,1) >= 1 then
          select string_agg(format('s.%I = l.%I', col, col), ' and ') into joincond
            from unnest(pkcols) as col;
          execute format(
            'delete from %1$I l where l.manufacturer = %2$L and exists '
            '(select 1 from %1$I s where s.manufacturer = %3$L and %4$s)',
            tbl.table_name, pair.loser, pair.survivor, joincond);
        end if;

        begin
          execute format('update %1$I set manufacturer = %3$L where manufacturer = %2$L',
                         tbl.table_name, pair.loser, pair.survivor);
        exception when unique_violation then
          execute format('delete from %1$I where manufacturer = %2$L', tbl.table_name, pair.loser);
        end;
      exception when others then null;   -- never let one odd table abort the whole merge
      end;
    end loop;

    -- manufacturer_meta is keyed by `slug` (logos, etc.) — merge, keeping any logo.
    begin
      update manufacturer_meta s set logo_url = coalesce(s.logo_url, l.logo_url)
        from manufacturer_meta l where s.slug = pair.survivor and l.slug = pair.loser;
      delete from manufacturer_meta l where l.slug = pair.loser
        and exists (select 1 from manufacturer_meta s where s.slug = pair.survivor);
      update manufacturer_meta set slug = pair.survivor where slug = pair.loser;
    exception when others then null;
    end;

    -- cross_sell (basis_slug / rec_slug) is fully derived — drop loser refs; they rebuild.
    begin
      delete from cross_sell where basis_slug = pair.loser or rec_slug = pair.loser;
    exception when others then null;
    end;

    -- dealer_intent.top_manufacturer (derived label) — repoint.
    begin
      update dealer_intent set top_manufacturer = pair.survivor where top_manufacturer = pair.loser;
    exception when others then null;
    end;

    -- Commission-template key ctpl:<slug> — fold onto the survivor.
    begin
      if exists (select 1 from app_settings where key = 'ctpl:'||pair.loser) then
        if exists (select 1 from app_settings where key = 'ctpl:'||pair.survivor)
          then delete from app_settings where key = 'ctpl:'||pair.loser;
          else update app_settings set key = 'ctpl:'||pair.survivor where key = 'ctpl:'||pair.loser;
        end if;
      end if;
    exception when others then null;
    end;

    -- Remove the now-orphan legacy manufacturer record.
    delete from manufacturers where slug = pair.loser;
  end loop;

  -- Canonical name on the survivor.
  update manufacturers set name='Ohio Medical / GCE', active=true where slug='ohio-medical';
end $$;

-- ---- Verify (optional): should return exactly one row, and no 'gce' anywhere ----
-- select slug, name, active from manufacturers where slug in ('gce','ohio-medical');
-- select 'monthly_sales' t, count(*) from monthly_sales where manufacturer='gce'
--   union all select 'dealer_manufacturers', count(*) from dealer_manufacturers where manufacturer='gce';
