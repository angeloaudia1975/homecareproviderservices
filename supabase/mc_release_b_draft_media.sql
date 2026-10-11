-- ============================================================================================
--  MANUFACTURER CENTER — RELEASE B, GATE 1: DRAFT MEDIA UNDER AN ENRICHMENT WINDOW (approved by Angelo 2026-10-11)
--  Runs AFTER mc_release_a_content_freeze.sql. It replaces mfr_content_guard() and its self-test with a
--  stricter version; nothing else in Release A changes (same triggers, same tables, same regression_fix).
--
--  THE QUESTION: can an open enrichment window put photos on Bemis's draft pages without weakening the freeze?
--  product_media cannot prove an image belongs only to a hidden draft — its rows are keyed by SKU and read
--  publicly with no visibility rule, so a row there is on the storefront the moment it is written. It stays
--  fully frozen (no exemption, with or without a window).
--  A draft page's photos live ON THE PAGE ROW instead (product_content.image / images_gallery / skus[].image /
--  options), which the storefront reads only while the page is visible. This file adds the smallest mechanism
--  that makes that provable, row by row, in the database:
--    1. product_content.draft_window — which enrichment window built this draft. Under a window the guard
--       stamps it on every row it writes, and a window may change or delete ONLY the drafts it stamped itself:
--       never a live page, never another line's page, never an older hidden page.
--    2. Under a window, every image URL on the row must be a copy in HCPS storage filed under THAT window:
--         https://<project>.supabase.co/storage/v1/object/public/product-content/<line>/drafts/w<window id>/...
--       (product-content.js writes window uploads and rehosts there, never overwriting). An outside link, the
--       catalog's own photos, another line's folder or another window's folder is refused.
--    3. Under a window a draft is never given a dealer-visible status (published / active / discontinued),
--       not even switched off — so no single later flag can make a draft or its photos visible. Going live
--       is Approve & Publish Manufacturer (Release D) plus a passing verification.
--  Still refused under a window, exactly as in Release A: the catalog layer (product_overrides,
--  custom_products — including their images), product_media, product_links, product_related, the line's
--  settings, every commercial fact (Phase 2's guard), any other line, and any window once closed.
--
--  ALSO: decision kind content_resolution — Review Issues records each one-click resolution as an
--  append-only mfr_decisions row (field page:<page_key>, hcps_value {issue, choice, ...}); a later choice
--  supersedes an earlier one (supersedes_id), never rewrites it. Match ignores the kind (not a deciding kind).
--
--  RULE 19: product_content keeps its RLS and its one public read policy (visible pages only); draft_window is a
--  plain column, NULL on every live page. Both functions stay SECURITY DEFINER with a fixed search_path and no
--  EXECUTE for PUBLIC / anon / authenticated; the image-rule helper is IMMUTABLE, reads no table and is
--  revoked from them too. The self-test is granted to service_role only.
-- ============================================================================================
begin;

-- 1. Which window built a draft.
alter table public.product_content add column if not exists draft_window bigint;
comment on column public.product_content.draft_window is
  'Manufacturer Center: the enrichment_window decision (mfr_decisions.id) that built this hidden draft. NULL on every page not built under a window. Set by mfr_content_guard, never by hand.';

-- 2. Decision kinds: Release A's list plus content_resolution (replace whatever kind check exists; never two).
do $$
declare c record;
begin
  for c in select conname from pg_constraint
           where conrelid = 'public.mfr_decisions'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%regression_fix%' loop
    execute format('alter table public.mfr_decisions drop constraint %I', c.conname);
  end loop;
end $$;
alter table public.mfr_decisions add constraint mfr_decisions_kind_check
  check (kind in ('interpretation','conflict','exception','regression_fix','freight_terms','deferral','acceptance','enrichment_window','content_resolution'));

-- 3. The image rule. Returns the first image URL on the row that is NOT a copy filed under this window (NULL = all fine).
--    Looks at every string in image, images_gallery, skus and options that is a link (http, // or /).
create or replace function public.mfr_draft_media_problem(p_row jsonb, p_slug text, p_win bigint) returns text
language plpgsql immutable set search_path = public, pg_temp as $$
declare
  u   text;
  pre text;
begin
  pre := '^https://[a-z0-9]+\.supabase\.co/storage/v1/object/public/product-content/'
         || regexp_replace(p_slug, '([^a-z0-9])', '\\\1', 'g') || '/drafts/w' || p_win::text || '/[^?#[:space:]]+$';
  for u in
    select v #>> '{}' from jsonb_path_query(
      jsonb_build_array(p_row -> 'image', p_row -> 'images_gallery', p_row -> 'skus', p_row -> 'options'),
      'lax $.** ? (@.type() == "string")') v
  loop
    if u ~* '^\s*(https?:|//|/)' and u !~ pre then
      return u;
    end if;
  end loop;
  return null;
end $$;

-- 4. The guard (Release A's, with the window branch tightened as described above).
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
  bad_url  text;
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

  -- A regression fix covers any change on its own line (exactly as in Phase 2 and Release A).
  if tok ~ '^\d+$' and exists (
       select 1 from public.mfr_decisions d
       where d.id = tok::bigint and d.kind = 'regression_fix' and d.manufacturer = v_slug and d.used_at is null) then
    return case when TG_OP = 'DELETE' then OLD else NEW end;
  end if;

  -- An open enrichment window covers ITS OWN hidden drafts on its own line, and their captured sources. Nothing else.
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
    if coalesce(vis_old, false) or coalesce(vis_new, false) then
      raise exception 'line_frozen: % — the enrichment window covers hidden draft pages only. Making a page visible, or changing a visible one, needs Approve & Publish Manufacturer.', v_slug
        using errcode = 'P0001', hint = 'Keep the page hidden while enriching; publish through Manufacturer Center.';
    end if;
    if TG_OP <> 'DELETE' and NEW.status in ('published','active','discontinued') then
      raise exception 'line_frozen: % — under an enrichment window a draft never gets a dealer-visible status, not even switched off. Publishing needs Approve & Publish Manufacturer.', v_slug
        using errcode = 'P0001', hint = 'Leave the draft pending_review / approved / hidden.';
    end if;
    if TG_OP <> 'INSERT' and OLD.draft_window is distinct from win::bigint then
      raise exception 'line_frozen: % — this hidden page was not built under enrichment window %; a window changes only the drafts it created.', v_slug, win
        using errcode = 'P0001', hint = 'Older hidden pages need a regression_fix.';
    end if;
    if TG_OP = 'DELETE' then
      return OLD;
    end if;
    NEW.draft_window := win::bigint;
    bad_url := public.mfr_draft_media_problem(to_jsonb(NEW), v_slug, win::bigint);
    if bad_url is not null then
      raise exception 'line_frozen: % — under an enrichment window every image on a draft must be a copy in HCPS storage made under this window (product-content/%/drafts/w%/...). Refused: %', v_slug, v_slug, win, left(bad_url, 160)
        using errcode = 'P0001', hint = 'Rehost the image through Product Enrichment; it lands in the window''s own folder.';
    end if;
    return NEW;
  end if;

  raise exception 'line_frozen: % is frozen (Gold Standard). A change to % needs a regression_fix decision (or, for hidden draft pages only, an open enrichment window).', v_slug, TG_TABLE_NAME
    using errcode = 'P0001', hint = 'Record a regression_fix in Manufacturer Center and send it with the change.';
end $$;

revoke all on function public.mfr_content_guard() from public;
revoke all on function public.mfr_draft_media_problem(jsonb, text, bigint) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function public.mfr_content_guard() from anon';
    execute 'revoke all on function public.mfr_draft_media_problem(jsonb, text, bigint) from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on function public.mfr_content_guard() from authenticated';
    execute 'revoke all on function public.mfr_draft_media_problem(jsonb, text, bigint) from authenticated';
  end if;
end $$;

/* 5. SELF-TEST, callable only by service_role (catalog-api mc_guard_selftest). Release A's 16 attempts per
   frozen line plus the draft-media ones. Every attempt runs in its own sub-transaction that is always rolled
   back — including any setup it needs (a draft to publish, a window of another line, a window stamped closed)
   and the window it opens to test with. Placeholders: %1$s line, %2$s window id, %3$s another frozen line. */
create or replace function public.mfr_content_guard_selftest() returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  s     record;
  a     record;
  out   jsonb := '[]'::jsonb;
  res   text;
  n     bigint;
  wid   bigint;
  w2    bigint;
  oth   text;
  img   text;
begin
  for s in select m.slug from public.manufacturer_meta m where m.frozen order by m.slug loop
    select m.slug into oth from public.manufacturer_meta m where m.frozen and m.slug <> s.slug order by m.slug limit 1;
    for a in select * from (values
      (1,  'add a draft page',                    'product_content',  'none',  'blocked', null,
           'insert into public.product_content (manufacturer, page_key, name, status) values (%1$L, ''__mc_selftest__'', ''self-test'', ''pending_review'')'),
      (2,  'edit a live page',                    'product_content',  'none',  'blocked', null,
           'update public.product_content set name = coalesce(name, '''') || '' (self-test)'' where id = (select id from public.product_content where manufacturer = %1$L and status in (''published'',''active'',''discontinued'') and not coalesce(disabled, false) order by page_key limit 1)'),
      (3,  'unpublish a live page',               'product_content',  'none',  'blocked', null,
           'update public.product_content set status = ''hidden'' where id = (select id from public.product_content where manufacturer = %1$L and status in (''published'',''active'',''discontinued'') and not coalesce(disabled, false) order by page_key limit 1)'),
      (4,  'rename a product on the catalog layer','product_overrides','none',  'blocked', null,
           'insert into public.product_overrides (manufacturer, code, patch) values (%1$L, ''__mc_selftest__'', ''{"name":"self-test"}''::jsonb)'),
      (5,  'add a gallery image',                 'product_media',    'none',  'blocked', null,
           'insert into public.product_media (manufacturer, code, kind, url) values (%1$L, ''__mc_selftest__'', ''image'', ''https://example.invalid/x.jpg'')'),
      (6,  'add a product link',                  'product_links',    'none',  'blocked', null,
           'insert into public.product_links (manufacturer, code, url) values (%1$L, ''__mc_selftest__'', ''https://example.invalid/'')'),
      (7,  'add a related product',               'product_related',  'none',  'blocked', null,
           'insert into public.product_related (manufacturer, code, related_manufacturer, related_code) values (%1$L, ''__mc_selftest__'', %1$L, ''__mc_selftest_2__'')'),
      (8,  'change the category map',             'manufacturer_meta','none',  'blocked', null,
           'update public.manufacturer_meta set category_map = coalesce(category_map, ''{}''::jsonb) || ''{"__mc_selftest__":"x"}''::jsonb where slug = %1$L'),
      (9,  'change the logo',                     'manufacturer_meta','none',  'blocked', null,
           'update public.manufacturer_meta set logo_url = coalesce(logo_url, '''') || ''#selftest'' where slug = %1$L'),
      (10, 'hide the whole line',                 'manufacturer_meta','none',  'blocked', null,
           'update public.manufacturer_meta set active = not coalesce(active, true) where slug = %1$L'),
      (11, 'window: add a hidden draft page',     'product_content',  'own',   'allowed', null,
           'insert into public.product_content (manufacturer, page_key, name, status) values (%1$L, ''__mc_selftest__'', ''self-test'', ''pending_review'')'),
      (12, 'window: add a page already published','product_content',  'own',   'blocked', null,
           'insert into public.product_content (manufacturer, page_key, name, status) values (%1$L, ''__mc_selftest__'', ''self-test'', ''published'')'),
      (13, 'window: edit a live page',            'product_content',  'own',   'blocked', null,
           'update public.product_content set name = coalesce(name, '''') || '' (self-test)'' where id = (select id from public.product_content where manufacturer = %1$L and status in (''published'',''active'',''discontinued'') and not coalesce(disabled, false) order by page_key limit 1)'),
      (14, 'window: rename on the catalog layer', 'product_overrides','own',   'blocked', null,
           'insert into public.product_overrides (manufacturer, code, patch) values (%1$L, ''__mc_selftest__'', ''{"name":"self-test"}''::jsonb)'),
      (15, 'window: add a gallery image',         'product_media',    'own',   'blocked', null,
           'insert into public.product_media (manufacturer, code, kind, url) values (%1$L, ''__mc_selftest__'', ''image'', ''https://example.invalid/x.jpg'')'),
      (16, 'window: change the category map',     'manufacturer_meta','own',   'blocked', null,
           'update public.manufacturer_meta set category_map = coalesce(category_map, ''{}''::jsonb) || ''{"__mc_selftest__":"x"}''::jsonb where slug = %1$L'),
      (17, 'window: draft image on its hidden draft page', 'product_content', 'own', 'allowed', null,
           'insert into public.product_content (manufacturer, page_key, name, status, image, images_gallery) values (%1$L, ''__mc_selftest__'', ''self-test'', ''pending_review'', ''https://selftest.supabase.co/storage/v1/object/public/product-content/%1$s/drafts/w%2$s/__mc_selftest__/a.jpg'', jsonb_build_array(jsonb_build_object(''url'', ''https://selftest.supabase.co/storage/v1/object/public/product-content/%1$s/drafts/w%2$s/__mc_selftest__/a.jpg'', ''primary'', true)))'),
      (18, 'window: change the image on a live page', 'product_content', 'own', 'blocked', null,
           'update public.product_content set image = ''https://selftest.supabase.co/storage/v1/object/public/product-content/%1$s/drafts/w%2$s/__mc_selftest__/a.jpg'' where id = (select id from public.product_content where manufacturer = %1$L and status in (''published'',''active'',''discontinued'') and not coalesce(disabled, false) order by page_key limit 1)'),
      (19, 'window: draft image from outside HCPS storage', 'product_content', 'own', 'blocked', null,
           'insert into public.product_content (manufacturer, page_key, name, status, image) values (%1$L, ''__mc_selftest__'', ''self-test'', ''pending_review'', ''https://example.invalid/x.jpg'')'),
      (20, 'window: draft image filed under another window', 'product_content', 'own', 'blocked', null,
           'insert into public.product_content (manufacturer, page_key, name, status, images_gallery) values (%1$L, ''__mc_selftest__'', ''self-test'', ''pending_review'', jsonb_build_array(jsonb_build_object(''url'', ''https://selftest.supabase.co/storage/v1/object/public/product-content/%1$s/drafts/w9%2$s/__mc_selftest__/a.jpg'')))'),
      (21, 'window: another line''s window used here', 'product_content', 'other', 'blocked', null,
           'insert into public.product_content (manufacturer, page_key, name, status) values (%1$L, ''__mc_selftest__'', ''self-test'', ''pending_review'')'),
      (22, 'window: publish a draft page with its image', 'product_content', 'own', 'blocked',
           'insert into public.product_content (manufacturer, page_key, name, status, image) values (%1$L, ''__mc_selftest__'', ''self-test'', ''approved'', ''https://selftest.supabase.co/storage/v1/object/public/product-content/%1$s/drafts/w%2$s/__mc_selftest__/a.jpg'')',
           'update public.product_content set status = ''published'' where manufacturer = %1$L and page_key = ''__mc_selftest__'''),
      (23, 'window: a draft given a live status, switched off', 'product_content', 'own', 'blocked', null,
           'insert into public.product_content (manufacturer, page_key, name, status, disabled) values (%1$L, ''__mc_selftest__'', ''self-test'', ''active'', true)'),
      (24, 'window: a closed window', 'product_content', 'closed', 'blocked', null,
           'insert into public.product_content (manufacturer, page_key, name, status) values (%1$L, ''__mc_selftest__'', ''self-test'', ''pending_review'')'),
      (25, 'window: a hidden page this window did not build', 'product_content', 'own', 'blocked', null,
           'update public.product_content set name = coalesce(name, '''') || '' (self-test)'' where id = (select id from public.product_content where manufacturer = %1$L and not (status in (''published'',''active'',''discontinued'') and not coalesce(disabled, false)) and draft_window is distinct from %2$s order by page_key limit 1)')
    ) as v(n, attempt, tbl, win_mode, expect, setup, stmt) order by n loop
      wid := null; w2 := null;
      if to_regclass('public.' || a.tbl) is null then
        res := 'table not present';
      elsif a.win_mode = 'other' and oth is null then
        res := 'nothing to try';
      else
        begin
          if a.win_mode <> 'none' then
            select d.id into wid from public.mfr_decisions d where d.manufacturer = s.slug and d.kind = 'enrichment_window' and d.used_at is null limit 1;
            if wid is null then
              insert into public.mfr_decisions (manufacturer, field, kind, reason, decided_by)
                values (s.slug, 'enrichment_window', 'enrichment_window', 'self-test (always rolled back)', 'mfr_content_guard_selftest')
                returning id into wid;
            end if;
            perform set_config('request.headers', json_build_object('x-hcps-enrichment-window', wid::text)::text, true);
            if a.setup is not null then
              execute format(a.setup, s.slug, wid, oth);
            end if;
            if a.win_mode = 'other' then
              select d.id into w2 from public.mfr_decisions d where d.manufacturer = oth and d.kind = 'enrichment_window' and d.used_at is null limit 1;
              if w2 is null then
                insert into public.mfr_decisions (manufacturer, field, kind, reason, decided_by)
                  values (oth, 'enrichment_window', 'enrichment_window', 'self-test (always rolled back)', 'mfr_content_guard_selftest')
                  returning id into w2;
              end if;
              perform set_config('request.headers', json_build_object('x-hcps-enrichment-window', w2::text)::text, true);
            elsif a.win_mode = 'closed' then
              update public.mfr_decisions set used_at = now(), used_by = 'mfr_content_guard_selftest' where id = wid;
            end if;
          end if;
          execute format(a.stmt, s.slug, wid, oth);
          get diagnostics n = row_count;
          if n = 0 then raise exception 'mc_selftest_nothing'; end if;
          raise exception 'mc_selftest_not_blocked';
        exception when others then
          res := case when sqlerrm like 'line_frozen%' then 'blocked'
                      when sqlerrm = 'mc_selftest_not_blocked' then (case when a.expect = 'allowed' then 'allowed' else 'NOT BLOCKED' end)
                      when sqlerrm = 'mc_selftest_nothing' then 'nothing to try'
                      else 'error: ' || sqlerrm end;
        end;
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
  select 1 as n, 'content guard still on ' || t as check_name,
         case when to_regclass('public.' || t) is null then 'TABLE MISSING'
              when exists (select 1 from pg_trigger g where g.tgname = 'mfr_content_guard' and g.tgrelid = to_regclass('public.' || t)) then 'installed'
              else 'NOT INSTALLED' end as value,
         exists (select 1 from pg_trigger g where g.tgname = 'mfr_content_guard' and g.tgrelid = to_regclass('public.' || t)) as ok
    from unnest(array['product_content','product_content_sources','product_media','product_links','product_related','product_overrides','custom_products','manufacturer_meta']) t
  union all
  select 2, 'Phase 2 commercial guard still installed (4 tables)', count(*)::text, count(*) = 4 from pg_trigger where tgname = 'mfr_freeze_guard'
  union all
  select 3, 'product_content.draft_window exists; no live page carries one',
         (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'product_content' and column_name = 'draft_window')::text
           || ' column / ' || (select count(*) from public.product_content where draft_window is not null)::text || ' rows set',
         (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'product_content' and column_name = 'draft_window') = 1
           and not exists (select 1 from public.product_content where draft_window is not null and status in ('published','active','discontinued'))
  union all
  select 4, 'decision kinds include enrichment_window and content_resolution (one kind check, one open window per line)',
         count(*)::text || ' kind check / index ' || (to_regclass('public.mfr_decisions_one_open_window') is not null)::text,
         count(*) = 1 and bool_and(pg_get_constraintdef(c.oid) like '%content_resolution%' and pg_get_constraintdef(c.oid) like '%enrichment_window%')
           and to_regclass('public.mfr_decisions_one_open_window') is not null
    from pg_constraint c where c.conrelid = 'public.mfr_decisions'::regclass and c.contype = 'c' and pg_get_constraintdef(c.oid) like '%regression_fix%'
  union all
  select 5, 'anon/authenticated can execute the guard, its image rule or its self-test (expect false)',
         bool_or(has_function_privilege(r, 'public.mfr_content_guard()', 'execute') or has_function_privilege(r, 'public.mfr_content_guard_selftest()', 'execute')
                 or has_function_privilege(r, 'public.mfr_draft_media_problem(jsonb, text, bigint)', 'execute'))::text,
         not bool_or(has_function_privilege(r, 'public.mfr_content_guard()', 'execute') or has_function_privilege(r, 'public.mfr_content_guard_selftest()', 'execute')
                 or has_function_privilege(r, 'public.mfr_draft_media_problem(jsonb, text, bigint)', 'execute'))
    from unnest(array['anon','authenticated']) r
  union all
  select 6, 'every read policy on product_content is limited to visible pages (drafts never readable by the storefront)',
         count(*)::text || ' read polic' || case when count(*) = 1 then 'y' else 'ies' end,
         count(*) >= 1 and bool_and(qual like '%published%' and qual like '%disabled%')
    from pg_policies where schemaname = 'public' and tablename = 'product_content' and cmd = 'SELECT'
  union all
  select 7, 'open enrichment windows right now (expect 0 until the window is opened)', count(*)::text, count(*) = 0
    from public.mfr_decisions where kind = 'enrichment_window' and used_at is null
  union all
  select 8, 'self-test: ' || (e->>'line') || ' — ' || (e->>'attempt'), (e->>'result') || ' (expect ' || (e->>'expect') || ')',
         (e->>'result') = (e->>'expect') or (e->>'result') = 'nothing to try'
    from jsonb_array_elements(public.mfr_content_guard_selftest()) e
) x order by n, check_name;
