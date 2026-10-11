-- ============================================================================================
--  MANUFACTURER CENTER — RELEASE A: THE CONTENT FREEZE + ENRICHMENT WINDOWS (approved by Angelo 2026-10-11)
--  Phase 2's guard (mfr_freeze_guard) protects a frozen line's COMMERCIAL facts. This file adds the
--  matching guard for everything else a dealer sees on that line, at the database, whichever code path
--  sends the write (catalog-api, product-content, images-api, the ordering site's old catalog endpoint,
--  or hand-run SQL):
--    * product pages and their grouping, content, images and publish/hidden state — product_content
--      (every column, insert, delete);
--    * what the pages were built from — product_content_sources;
--    * gallery images, videos, brochures — product_media;  product links — product_links;
--    * related products / alternatives shown on the line's pages — product_related (rows FOR the line);
--    * the catalog layer's names, descriptions, categories, images, groups — product_overrides (every
--      patch key) and custom_products (every column);
--    * the line's logo, visibility, listing mode and categories — manufacturer_meta.logo_url, active,
--      enriched_only, category_order, category_map.
--  Phase 2's guard keeps doing its job; this one sits beside it (its own function and triggers).
--
--  The only ways through on a frozen line, both explicit and recorded in mfr_decisions:
--    * x-hcps-regression-fix = an unused regression_fix decision for that line (as in Phase 2; any change);
--    * x-hcps-enrichment-window = the line's OPEN enrichment_window decision. CONTENT DRAFTS ONLY: it lets
--      product_content and product_content_sources rows be written while the page stays hidden from
--      dealers before AND after the write (status not published/active/discontinued, or disabled). It
--      never covers the catalog layer, media, links, related products or the line's settings (those are
--      visible the moment they are written), never moves a row to another line, and never publishes.
--      A window is opened only by catalog-api mc_open_enrichment_window (one open window per line) and
--      closed by stamping its used_at once (mc_close_enrichment_window) — the decision itself is never
--      rewritten or deleted (mfr_append_only).
--  Dealer pricing, tiers/pooling, UOM/case qty, MSRP/MAP, freight and commercial status stay behind
--  Phase 2's guard: an enrichment window does not reach them at all.
--
--  RULE 19: both functions are SECURITY DEFINER (they read mfr_decisions and manufacturer_meta) with a
--  fixed search_path; EXECUTE is revoked from PUBLIC / anon / authenticated; the self-test is granted to
--  service_role only (catalog-api mc_guard_selftest). Nothing here grants anyone a read or a write.
-- ============================================================================================
begin;

-- 1. An enrichment window is a decision of its own kind; at most one is open per line.
do $$
declare c record;
begin   -- whatever the kind check is called in this project, replace it (never leave an old one beside the new)
  for c in select conname from pg_constraint
           where conrelid = 'public.mfr_decisions'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%regression_fix%' loop
    execute format('alter table public.mfr_decisions drop constraint %I', c.conname);
  end loop;
end $$;
alter table public.mfr_decisions add constraint mfr_decisions_kind_check
  check (kind in ('interpretation','conflict','exception','regression_fix','freight_terms','deferral','acceptance','enrichment_window'));
create unique index if not exists mfr_decisions_one_open_window
  on public.mfr_decisions (manufacturer) where kind = 'enrichment_window' and used_at is null;

-- 2. The guard.
create or replace function public.mfr_content_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_old    text;
  v_new    text;
  v_slug   text;
  f_old    boolean := false;
  f_new    boolean := false;
  touched  boolean := true;
  hdrs     text;
  tok      text;
  win      text;
  vis_old  boolean := false;
  vis_new  boolean := false;
begin
  if TG_TABLE_NAME = 'manufacturer_meta' then
    v_slug := OLD.slug;                                   -- update / delete only (a new line is not frozen)
    if not coalesce(OLD.frozen, false) then
      return case when TG_OP = 'DELETE' then OLD else NEW end;
    end if;
    if TG_OP = 'UPDATE' then
      touched := NEW.logo_url is distinct from OLD.logo_url
              or NEW.active is distinct from OLD.active
              or NEW.enriched_only is distinct from OLD.enriched_only
              or NEW.category_order is distinct from OLD.category_order
              or NEW.category_map is distinct from OLD.category_map;
    end if;
  else
    if TG_OP <> 'INSERT' then v_old := OLD.manufacturer; end if;
    if TG_OP <> 'DELETE' then v_new := NEW.manufacturer; end if;
    if v_old is not null then select m.frozen into f_old from public.manufacturer_meta m where m.slug = v_old; end if;
    if v_new is not null then select m.frozen into f_new from public.manufacturer_meta m where m.slug = v_new; end if;
    f_old := coalesce(f_old, false); f_new := coalesce(f_new, false);
    if not (f_old or f_new) then
      return case when TG_OP = 'DELETE' then OLD else NEW end;
    end if;
    v_slug := case when f_old then v_old else v_new end;
    if TG_OP = 'UPDATE' then                              -- a write that changes nothing but its timestamp is not a change
      touched := (to_jsonb(NEW) - 'updated_at' - 'updated_by' - 'code_norm') is distinct from (to_jsonb(OLD) - 'updated_at' - 'updated_by' - 'code_norm');
    end if;
  end if;
  if not touched then
    return case when TG_OP = 'DELETE' then OLD else NEW end;
  end if;

  hdrs := current_setting('request.headers', true);
  if hdrs is not null and hdrs <> '' then
    begin
      tok := (hdrs::json) ->> 'x-hcps-regression-fix';
      win := (hdrs::json) ->> 'x-hcps-enrichment-window';
    exception when others then tok := null; win := null;
    end;
  end if;

  -- A regression fix covers any change on its own line (exactly as in Phase 2).
  if tok ~ '^\d+$' and exists (
       select 1 from public.mfr_decisions d
       where d.id = tok::bigint and d.kind = 'regression_fix' and d.manufacturer = v_slug and d.used_at is null) then
    return case when TG_OP = 'DELETE' then OLD else NEW end;
  end if;

  -- An open enrichment window covers hidden drafts on its own line, nothing else.
  if win ~ '^\d+$' and TG_TABLE_NAME in ('product_content', 'product_content_sources')
     and (v_old is null or v_old = v_slug) and (v_new is null or v_new = v_slug)
     and exists (
       select 1 from public.mfr_decisions d
       where d.id = win::bigint and d.kind = 'enrichment_window' and d.manufacturer = v_slug and d.used_at is null) then
    if TG_TABLE_NAME = 'product_content_sources' then
      return case when TG_OP = 'DELETE' then OLD else NEW end;
    end if;
    if TG_OP <> 'INSERT' then vis_old := OLD.status in ('published','active','discontinued') and not coalesce(OLD.disabled, false); end if;
    if TG_OP <> 'DELETE' then vis_new := NEW.status in ('published','active','discontinued') and not coalesce(NEW.disabled, false); end if;
    if not coalesce(vis_old, false) and not coalesce(vis_new, false) then
      return case when TG_OP = 'DELETE' then OLD else NEW end;
    end if;
    raise exception 'line_frozen: % — the enrichment window covers hidden draft pages only. Making a page visible, or changing a visible one, needs Approve & Publish Manufacturer.', v_slug
      using errcode = 'P0001', hint = 'Keep the page hidden while enriching; publish through Manufacturer Center.';
  end if;

  raise exception 'line_frozen: % is frozen (Gold Standard). A change to % needs a regression_fix decision (or, for hidden draft pages only, an open enrichment window).', v_slug, TG_TABLE_NAME
    using errcode = 'P0001', hint = 'Record a regression_fix in Manufacturer Center and send it with the change.';
end $$;

revoke all on function public.mfr_content_guard() from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function public.mfr_content_guard() from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on function public.mfr_content_guard() from authenticated'; end if;
end $$;

-- 3. The triggers — one per protected table (a table this project does not have is reported by the check below).
do $$
declare t text;
begin
  foreach t in array array['product_content','product_content_sources','product_media','product_links','product_related','product_overrides','custom_products'] loop
    if to_regclass('public.' || t) is not null then
      execute format('drop trigger if exists mfr_content_guard on public.%I', t);
      execute format('create trigger mfr_content_guard before insert or update or delete on public.%I for each row execute function public.mfr_content_guard()', t);
    end if;
  end loop;
  execute 'drop trigger if exists mfr_content_guard on public.manufacturer_meta';
  execute 'create trigger mfr_content_guard before update or delete on public.manufacturer_meta for each row execute function public.mfr_content_guard()';
end $$;

/* 4. SELF-TEST, callable only by service_role (catalog-api mc_guard_selftest, beside Phase 2's).
   For every frozen line it TRIES each content change, each in its own sub-transaction that is always
   rolled back, and reports the result next to what is expected: every plain attempt "blocked"; with an
   enrichment window, a hidden draft page "allowed" and everything a dealer would see "blocked". Nothing
   it attempts survives — not even the window it opens to test with. */
create or replace function public.mfr_content_guard_selftest() returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  s    record;
  a    record;
  out  jsonb := '[]'::jsonb;
  res  text;
  n    bigint;
  wid  bigint;
begin
  for s in select m.slug from public.manufacturer_meta m where m.frozen order by m.slug loop
    for a in select * from (values
      (1,  'add a draft page',                    'product_content',  false, 'blocked',
           'insert into public.product_content (manufacturer, page_key, name, status) values (%1$L, ''__mc_selftest__'', ''self-test'', ''pending_review'')'),
      (2,  'edit a live page',                    'product_content',  false, 'blocked',
           'update public.product_content set name = coalesce(name, '''') || '' (self-test)'' where id = (select id from public.product_content where manufacturer = %1$L and status in (''published'',''active'',''discontinued'') and not coalesce(disabled, false) order by page_key limit 1)'),
      (3,  'unpublish a live page',               'product_content',  false, 'blocked',
           'update public.product_content set status = ''hidden'' where id = (select id from public.product_content where manufacturer = %1$L and status in (''published'',''active'',''discontinued'') and not coalesce(disabled, false) order by page_key limit 1)'),
      (4,  'rename a product on the catalog layer','product_overrides',false, 'blocked',
           'insert into public.product_overrides (manufacturer, code, patch) values (%1$L, ''__mc_selftest__'', ''{"name":"self-test"}''::jsonb)'),
      (5,  'add a gallery image',                 'product_media',    false, 'blocked',
           'insert into public.product_media (manufacturer, code, kind, url) values (%1$L, ''__mc_selftest__'', ''image'', ''https://example.invalid/x.jpg'')'),
      (6,  'add a product link',                  'product_links',    false, 'blocked',
           'insert into public.product_links (manufacturer, code, url) values (%1$L, ''__mc_selftest__'', ''https://example.invalid/'')'),
      (7,  'add a related product',               'product_related',  false, 'blocked',
           'insert into public.product_related (manufacturer, code, related_manufacturer, related_code) values (%1$L, ''__mc_selftest__'', %1$L, ''__mc_selftest_2__'')'),
      (8,  'change the category map',             'manufacturer_meta',false, 'blocked',
           'update public.manufacturer_meta set category_map = coalesce(category_map, ''{}''::jsonb) || ''{"__mc_selftest__":"x"}''::jsonb where slug = %1$L'),
      (9,  'change the logo',                     'manufacturer_meta',false, 'blocked',
           'update public.manufacturer_meta set logo_url = coalesce(logo_url, '''') || ''#selftest'' where slug = %1$L'),
      (10, 'hide the whole line',                 'manufacturer_meta',false, 'blocked',
           'update public.manufacturer_meta set active = not coalesce(active, true) where slug = %1$L'),
      (11, 'window: add a hidden draft page',     'product_content',  true,  'allowed',
           'insert into public.product_content (manufacturer, page_key, name, status) values (%1$L, ''__mc_selftest__'', ''self-test'', ''pending_review'')'),
      (12, 'window: add a page already published','product_content',  true,  'blocked',
           'insert into public.product_content (manufacturer, page_key, name, status) values (%1$L, ''__mc_selftest__'', ''self-test'', ''published'')'),
      (13, 'window: edit a live page',            'product_content',  true,  'blocked',
           'update public.product_content set name = coalesce(name, '''') || '' (self-test)'' where id = (select id from public.product_content where manufacturer = %1$L and status in (''published'',''active'',''discontinued'') and not coalesce(disabled, false) order by page_key limit 1)'),
      (14, 'window: rename on the catalog layer', 'product_overrides',true,  'blocked',
           'insert into public.product_overrides (manufacturer, code, patch) values (%1$L, ''__mc_selftest__'', ''{"name":"self-test"}''::jsonb)'),
      (15, 'window: add a gallery image',         'product_media',    true,  'blocked',
           'insert into public.product_media (manufacturer, code, kind, url) values (%1$L, ''__mc_selftest__'', ''image'', ''https://example.invalid/x.jpg'')'),
      (16, 'window: change the category map',     'manufacturer_meta',true,  'blocked',
           'update public.manufacturer_meta set category_map = coalesce(category_map, ''{}''::jsonb) || ''{"__mc_selftest__":"x"}''::jsonb where slug = %1$L')
    ) as v(n, attempt, tbl, with_window, expect, stmt) order by n loop
      if to_regclass('public.' || a.tbl) is null then
        res := 'table not present';
      else
        begin
          if a.with_window then
            select d.id into wid from public.mfr_decisions d where d.manufacturer = s.slug and d.kind = 'enrichment_window' and d.used_at is null limit 1;
            if wid is null then
              insert into public.mfr_decisions (manufacturer, field, kind, reason, decided_by)
                values (s.slug, 'enrichment_window', 'enrichment_window', 'self-test (always rolled back)', 'mfr_content_guard_selftest')
                returning id into wid;
            end if;
            perform set_config('request.headers', json_build_object('x-hcps-enrichment-window', wid::text)::text, true);
          end if;
          execute format(a.stmt, s.slug);
          get diagnostics n = row_count;
          if n = 0 then raise exception 'mc_selftest_nothing'; end if;
          raise exception 'mc_selftest_not_blocked';
        exception when others then
          res := case when sqlerrm like 'line_frozen%' then 'blocked'
                      when sqlerrm = 'mc_selftest_not_blocked' then (case when a.expect = 'allowed' then 'allowed' else 'NOT BLOCKED' end)
                      when sqlerrm = 'mc_selftest_nothing' then 'nothing to try'
                      else 'error: ' || sqlerrm end;
        end;
        wid := null;
      end if;
      out := out || jsonb_build_object('line', s.slug, 'attempt', a.attempt, 'result', res, 'expect', a.expect);
    end loop;
  end loop;
  return out;
end $$;
revoke all on function public.mfr_content_guard_selftest() from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function public.mfr_content_guard_selftest() from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on function public.mfr_content_guard_selftest() from authenticated'; end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then execute 'grant execute on function public.mfr_content_guard_selftest() to service_role'; end if;
end $$;

commit;

-- CHECK (read-only, one result table). Every row: ok = true.
select * from (
  select 1 as n, 'content guard on ' || t as check_name,
         case when to_regclass('public.' || t) is null then 'TABLE MISSING'
              when exists (select 1 from pg_trigger g where g.tgname = 'mfr_content_guard' and g.tgrelid = to_regclass('public.' || t)) then 'installed'
              else 'NOT INSTALLED' end as value,
         exists (select 1 from pg_trigger g where g.tgname = 'mfr_content_guard' and g.tgrelid = to_regclass('public.' || t)) as ok
    from unnest(array['product_content','product_content_sources','product_media','product_links','product_related','product_overrides','custom_products','manufacturer_meta']) t
  union all
  select 2, 'Phase 2 commercial guard still installed (4 tables)', count(*)::text, count(*) = 4 from pg_trigger where tgname = 'mfr_freeze_guard'
  union all
  select 3, 'decision kind enrichment_window allowed (no older kind check left); one open window per line',
         count(*) filter (where pg_get_constraintdef(c.oid) like '%enrichment_window%')::text || ' new, ' ||
         count(*) filter (where pg_get_constraintdef(c.oid) not like '%enrichment_window%')::text || ' old / index ' || (to_regclass('public.mfr_decisions_one_open_window') is not null)::text,
         count(*) filter (where pg_get_constraintdef(c.oid) like '%enrichment_window%') = 1
           and count(*) filter (where pg_get_constraintdef(c.oid) not like '%enrichment_window%') = 0
           and to_regclass('public.mfr_decisions_one_open_window') is not null
    from pg_constraint c where c.conrelid = 'public.mfr_decisions'::regclass and c.contype = 'c' and pg_get_constraintdef(c.oid) like '%regression_fix%'
  union all
  select 4, 'anon/authenticated can execute the content guard or its self-test (expect false)',
         bool_or(has_function_privilege(r, 'public.mfr_content_guard()', 'execute') or has_function_privilege(r, 'public.mfr_content_guard_selftest()', 'execute'))::text,
         not bool_or(has_function_privilege(r, 'public.mfr_content_guard()', 'execute') or has_function_privilege(r, 'public.mfr_content_guard_selftest()', 'execute'))
    from unnest(array['anon','authenticated']) r
  union all
  select 5, 'open enrichment windows right now (expect 0 until Angelo opens Bemis''s)', count(*)::text, count(*) = 0
    from public.mfr_decisions where kind = 'enrichment_window' and used_at is null
  union all
  select 6, 'self-test: ' || (e->>'line') || ' — ' || (e->>'attempt'), (e->>'result') || ' (expect ' || (e->>'expect') || ')',
         (e->>'result') = (e->>'expect') or (e->>'result') = 'nothing to try'
    from jsonb_array_elements(public.mfr_content_guard_selftest()) e
) x order by n, check_name;
