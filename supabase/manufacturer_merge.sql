-- ============================================================================
-- Manufacturer line consolidation — merge duplicate slugs across the ENTIRE platform.
--
--   golden  ->  golden-technologies    (canonical name "Golden Technologies")
--   bongo   ->  airavant-bongorx       (canonical name "AIRAVANT / BongoRx")
--
-- This is a MERGE, not a delete: every record tied to a duplicate slug is repointed
-- to the canonical slug, preserving account numbers, contract prices, logos, and
-- commission templates. Only the now-empty duplicate manufacturer row is removed.
--
-- It auto-discovers every table with a `manufacturer` column and repoints them, plus
-- explicitly handles the slug-bearing columns that aren't named `manufacturer`
-- (manufacturer_meta.slug, cross_sell.basis_slug/rec_slug, dealer_intent.top_manufacturer)
-- and the ctpl:<slug> commission-template keys in app_settings.
--
-- Composite-key safe: where a dealer/record already carries BOTH slugs (which would
-- collide on a primary key), the duplicate row is dropped only AFTER its account number
-- is carried onto the survivor — so nothing is lost. Idempotent: a second run is a no-op.
--
-- Run once in the Supabase SQL editor. Safe to run before or after wiping monthly_sales.
-- ============================================================================
do $$
declare
  pair     record;
  tbl      record;
  pkcols   text[];
  joincond text;
begin
  for pair in
    select * from (values ('golden','golden-technologies'),
                          ('bongo','airavant-bongorx')) as t(loser, survivor)
  loop
    continue when not exists (select 1 from manufacturers where slug = pair.loser);

    -- 1) Carry the account number & active flag onto the survivor grant BEFORE collapsing.
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

    -- 2) Every BASE TABLE with a `manufacturer` column: drop primary-key colliders, then repoint.
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
          -- a non-primary unique index collided — drop the leftover loser rows
          execute format('delete from %1$I where manufacturer = %2$L', tbl.table_name, pair.loser);
        end;
      exception when others then null;   -- never let one odd table abort the whole merge
      end;
    end loop;

    -- 3) manufacturer_meta is keyed by `slug` (logos, etc.) — merge, keeping any logo.
    begin
      update manufacturer_meta s set logo_url = coalesce(s.logo_url, l.logo_url)
        from manufacturer_meta l where s.slug = pair.survivor and l.slug = pair.loser;
      delete from manufacturer_meta l where l.slug = pair.loser
        and exists (select 1 from manufacturer_meta s where s.slug = pair.survivor);
      update manufacturer_meta set slug = pair.survivor where slug = pair.loser;
    exception when others then null;
    end;

    -- 4) cross_sell (basis_slug / rec_slug) is fully derived — drop loser refs; they rebuild.
    begin
      delete from cross_sell where basis_slug = pair.loser or rec_slug = pair.loser;
    exception when others then null;
    end;

    -- 5) dealer_intent.top_manufacturer (derived label) — repoint.
    begin
      update dealer_intent set top_manufacturer = pair.survivor where top_manufacturer = pair.loser;
    exception when others then null;
    end;

    -- 6) Commission-template key ctpl:<slug> — fold onto the survivor.
    begin
      if exists (select 1 from app_settings where key = 'ctpl:'||pair.loser) then
        if exists (select 1 from app_settings where key = 'ctpl:'||pair.survivor)
          then delete from app_settings where key = 'ctpl:'||pair.loser;
          else update app_settings set key = 'ctpl:'||pair.survivor where key = 'ctpl:'||pair.loser;
        end if;
      end if;
    exception when others then null;
    end;

    -- 7) Remove the now-orphan duplicate manufacturer record.
    delete from manufacturers where slug = pair.loser;
  end loop;

  -- Canonical names on the survivors.
  update manufacturers set name='Golden Technologies', active=true where slug='golden-technologies';
  update manufacturers set name='AIRAVANT / BongoRx',  active=true where slug='airavant-bongorx';
end $$;

-- ---- Verify (optional) — should return ONE Golden and ONE Airavant/Bongo, and no loser slugs anywhere.
-- select slug, name, active from manufacturers where lower(name) ~ 'golden|airavant|bongo' order by name;
-- select 'dealer_manufacturers' t, count(*) from dealer_manufacturers where manufacturer in ('golden','bongo')
-- union all select 'monthly_sales', count(*) from monthly_sales where manufacturer in ('golden','bongo');
