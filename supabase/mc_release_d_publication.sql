-- ============================================================================================
--  MANUFACTURER CENTER — RELEASE D: PUBLISH & VERIFY (approved to build by Angelo 2026-10-11)
--  Runs AFTER mc_release_b_draft_media.sql. Replaces mfr_content_guard() with Release B's guard plus two
--  narrowly-scoped additions, and adds the atomic publication functions. Nothing is published by running it.
--
--  THE QUESTION: how does a frozen line's approved enrichment become dealer-visible without a door that can
--  publish anything else? Answer: a single-use decision of kind content_publication that CONTAINS the approved
--  publication — the exact rows as they were at the dry run ("before") and the exact fields they become ("after"),
--  plus the plan hash — and one database function that applies exactly that, in ONE transaction:
--    · mfr_content_publish(decision, plan_hash): the decision must be an unspent content_publication of a frozen
--      line whose plan_hash matches; every page it names must still be EXACTLY its "before" row (any change since
--      the dry run — content, images, status, timestamp — refuses the whole publication); every "after" image must
--      be a live copy (product-content/<line>/live/...) and no draft-folder link may remain; then all pages become
--      published together (status published, not disabled, draft_window cleared) and the decision is spent.
--      Anything wrong → an exception → nothing changes. A held page is never touched: only pages named in the
--      approved decision can be written, and the server never puts a held page in a plan.
--    · mfr_content_publication_rollback(decision): restores every page of a spent publication to its "before"
--      row (status, visibility, draft_window and images), atomically — refused once a passing verification run
--      has recorded that publication as the line's new Gold Standard.
--  The guard lets these two functions through by a transaction-local setting they set themselves (clients
--  cannot set it: they can only call functions they are granted, and these are granted to service_role only),
--  and checks again, row by row, that the page is one the decision names.
--
--  ALSO: a closed enrichment window's HIDDEN drafts may be adopted by the line's next window (they stay hidden
--  and take the new window's stamp); before, a closed window's drafts could never be enriched again. A live
--  page, a page of another line and a hidden page no window built are still refused, exactly as before.
--
--  RULE 19: no new table; the decision kind list grows by one. Every function is SECURITY DEFINER with a fixed
--  search_path; none is executable by PUBLIC / anon / authenticated; the publish / rollback functions are granted
--  to service_role only. product_content keeps its one public read policy (visible pages only).
-- ============================================================================================
begin;

-- 1. Decision kind content_publication (replace the kind check; never two).
do $$
declare c record;
begin
  for c in select conname from pg_constraint
           where conrelid = 'public.mfr_decisions'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%regression_fix%' loop
    execute format('alter table public.mfr_decisions drop constraint %I', c.conname);
  end loop;
end $$;
alter table public.mfr_decisions add constraint mfr_decisions_kind_check
  check (kind in ('interpretation','conflict','exception','regression_fix','freight_terms','deferral','acceptance','enrichment_window','content_resolution','content_publication'));

-- 2. The live-image rule: the first image URL on an "after" row that is NOT a live copy of this line (NULL = fine).
create or replace function public.mfr_live_media_problem(p_row jsonb, p_slug text) returns text
language plpgsql immutable set search_path = public, pg_temp as $$
declare u text; pre text;
begin
  pre := '^https://[a-z0-9]+\.supabase\.co/storage/v1/object/public/product-content/'
         || regexp_replace(p_slug, '([^a-z0-9])', '\\\1', 'g') || '/live/[^?#[:space:]]+$';
  for u in
    select v #>> '{}' from jsonb_path_query(
      jsonb_build_array(p_row -> 'image', p_row -> 'images_gallery', p_row -> 'skus'),
      'lax $.** ? (@.type() == "string")') v
  loop
    if u ~* '^\s*(https?:|//|/)' and (u !~ pre or u ~ '/drafts/') then return u; end if;
  end loop;
  return null;
end $$;

-- 3. The guard: Release B's, plus the publication pass and the adoption of a closed window's hidden drafts.
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
  pub      text;
  vis_old  boolean := false;
  vis_new  boolean := false;
  bad_url  text;
  adopted  bigint;
begin
  if TG_TABLE_NAME = 'manufacturer_meta' then
    v_slug := OLD.slug;
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
    if TG_OP = 'UPDATE' then
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

  if tok ~ '^\d+$' and exists (
       select 1 from public.mfr_decisions d
       where d.id = tok::bigint and d.kind = 'regression_fix' and d.manufacturer = v_slug and d.used_at is null) then
    return case when TG_OP = 'DELETE' then OLD else NEW end;
  end if;

  -- Release D: the publication functions (and only they) set hcps.content_publication = '<decision>:publish|rollback'.
  pub := current_setting('hcps.content_publication', true);
  if pub ~ '^\d+:(publish|rollback)$' and TG_TABLE_NAME = 'product_content' and TG_OP = 'UPDATE' then   -- (nested: plpgsql does not promise to short-circuit)
    if v_old = v_slug and v_new = v_slug and OLD.page_key = NEW.page_key and exists (
         select 1 from public.mfr_decisions d
         where d.id = split_part(pub, ':', 1)::bigint and d.kind = 'content_publication' and d.manufacturer = v_slug
           and (d.hcps_value -> 'pages') ? OLD.page_key
           and ((split_part(pub, ':', 2) = 'publish' and d.used_at is null) or (split_part(pub, ':', 2) = 'rollback' and d.used_at is not null))) then
      return NEW;
    end if;
  end if;

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
    -- a window changes the drafts it built — and may adopt the HIDDEN drafts a closed window of this line left behind
    if TG_OP <> 'INSERT' and OLD.draft_window is distinct from win::bigint then
      if OLD.draft_window is not null and exists (
           select 1 from public.mfr_decisions c where c.id = OLD.draft_window and c.kind = 'enrichment_window'
             and c.manufacturer = v_slug and c.used_at is not null) then
        adopted := OLD.draft_window;
      end if;
    end if;
    if TG_OP <> 'INSERT' and OLD.draft_window is distinct from win::bigint and adopted is null then
      raise exception 'line_frozen: % — this hidden page was not built under enrichment window %; a window changes only the drafts it created (or adopts those a closed window of this line left hidden).', v_slug, win
        using errcode = 'P0001', hint = 'Older hidden pages need a regression_fix.';
    end if;
    if TG_OP = 'DELETE' then
      return OLD;
    end if;
    NEW.draft_window := win::bigint;
    bad_url := public.mfr_draft_media_problem(to_jsonb(NEW), v_slug, win::bigint);
    if bad_url is not null and adopted is not null then
      -- an adopted draft may keep the photos its first window copied (that window's own folder), nothing else
      bad_url := public.mfr_draft_media_problem(
        jsonb_set(to_jsonb(NEW), '{image}', to_jsonb(replace(coalesce(NEW.image, ''), '/drafts/w' || adopted::text || '/', '/drafts/w' || win || '/')))
        || jsonb_build_object('images_gallery', replace(coalesce(NEW.images_gallery::text, 'null'), '/drafts/w' || adopted::text || '/', '/drafts/w' || win || '/')::jsonb,
                              'skus', replace(coalesce(NEW.skus::text, 'null'), '/drafts/w' || adopted::text || '/', '/drafts/w' || win || '/')::jsonb,
                              'options', replace(coalesce(NEW.options::text, 'null'), '/drafts/w' || adopted::text || '/', '/drafts/w' || win || '/')::jsonb),
        v_slug, win::bigint);
    end if;
    if bad_url is not null then
      raise exception 'line_frozen: % — under an enrichment window every image on a draft must be a copy in HCPS storage made under this window (product-content/%/drafts/w%/...). Refused: %', v_slug, v_slug, win, left(bad_url, 160)
        using errcode = 'P0001', hint = 'Rehost the image through Product Enrichment; it lands in the window''s own folder.';
    end if;
    return NEW;
  end if;

  raise exception 'line_frozen: % is frozen (Gold Standard). A change to % needs a regression_fix decision (or, for hidden draft pages only, an open enrichment window; publishing, an approved content_publication).', v_slug, TG_TABLE_NAME
    using errcode = 'P0001', hint = 'Record a regression_fix in Manufacturer Center and send it with the change.';
end $$;

-- 4. Publish exactly the approved publication, atomically.
create or replace function public.mfr_content_publish(p_decision bigint, p_plan_hash text, p_by text default 'Manufacturer Center')
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  d      record;
  k      text;
  cur    jsonb;
  aft    jsonb;
  bad    text;
  n      int := 0;
begin
  select * into d from public.mfr_decisions where id = p_decision for update;
  if d.id is null or d.kind <> 'content_publication' then
    raise exception 'publication_refused: decision % is not a content_publication', p_decision using errcode = 'P0001';
  end if;
  if d.used_at is not null then
    raise exception 'publication_refused: decision % is already spent (%). A new dry run and approval are needed.', p_decision, d.used_at using errcode = 'P0001';
  end if;
  if coalesce(d.hcps_value ->> 'plan_hash', '') = '' or d.hcps_value ->> 'plan_hash' <> coalesce(p_plan_hash, '') then
    raise exception 'publication_refused: the plan hash does not match the approved dry run. A new dry run and approval are needed.' using errcode = 'P0001';
  end if;
  if not exists (select 1 from public.manufacturer_meta m where m.slug = d.manufacturer and m.frozen) then
    raise exception 'publication_refused: % is not a frozen (Gold Standard) line', d.manufacturer using errcode = 'P0001';
  end if;
  if jsonb_typeof(d.hcps_value -> 'pages') <> 'array' or jsonb_array_length(d.hcps_value -> 'pages') = 0 then
    raise exception 'publication_refused: the approval names no pages' using errcode = 'P0001';
  end if;
  perform set_config('hcps.content_publication', p_decision::text || ':publish', true);
  for k in select jsonb_array_elements_text(d.hcps_value -> 'pages') loop
    select to_jsonb(pc) into cur from public.product_content pc where pc.manufacturer = d.manufacturer and pc.page_key = k for update;
    if cur is null then
      raise exception 'publication_refused: page % no longer exists', k using errcode = 'P0001';
    end if;
    if cur is distinct from (d.hcps_value -> 'before' -> k) then
      raise exception 'publication_refused: page % changed after the dry run. A new dry run and approval are needed.', k using errcode = 'P0001';
    end if;
    aft := d.hcps_value -> 'after' -> k;
    if aft is null then raise exception 'publication_refused: no approved content for page %', k using errcode = 'P0001'; end if;
    bad := public.mfr_live_media_problem(aft, d.manufacturer);
    if bad is not null then
      raise exception 'publication_refused: page % would point at an image that is not a live copy: %', k, left(bad, 160) using errcode = 'P0001';
    end if;
    update public.product_content pc
       set status = 'published', disabled = false, draft_window = null, published_at = now(),
           image = aft ->> 'image', images_gallery = aft -> 'images_gallery', skus = aft -> 'skus', reviewed_by = left(p_by, 80)
     where pc.manufacturer = d.manufacturer and pc.page_key = k;
    n := n + 1;
  end loop;
  perform set_config('hcps.content_publication', '', true);
  update public.mfr_decisions set used_at = now(), used_by = left(p_by, 80) where id = p_decision and used_at is null;
  return jsonb_build_object('ok', true, 'decision', p_decision, 'published', n, 'pages', d.hcps_value -> 'pages');
end $$;

-- 5. Roll a publication back to its approved "before" rows, atomically (refused once it is the Gold Standard).
create or replace function public.mfr_content_publication_rollback(p_decision bigint, p_by text default 'Manufacturer Center')
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  d   record;
  k   text;
  b   jsonb;
  n   int := 0;
begin
  select * into d from public.mfr_decisions where id = p_decision;
  if d.id is null or d.kind <> 'content_publication' then
    raise exception 'rollback_refused: decision % is not a content_publication', p_decision using errcode = 'P0001';
  end if;
  if d.used_at is null then
    raise exception 'rollback_refused: publication % was never carried out', p_decision using errcode = 'P0001';
  end if;
  if exists (select 1 from public.mfr_verification_runs r
             where r.manufacturer = d.manufacturer and r.result = 'pass'
               and r.checks @> jsonb_build_array(jsonb_build_object('id', 'publication', 'detail', jsonb_build_object('decision', p_decision)))) then
    raise exception 'rollback_refused: publication % passed verification and is the Gold Standard; a change now needs a regression_fix', p_decision using errcode = 'P0001';
  end if;
  perform set_config('hcps.content_publication', p_decision::text || ':rollback', true);
  for k in select jsonb_array_elements_text(d.hcps_value -> 'pages') loop
    b := d.hcps_value -> 'before' -> k;
    update public.product_content pc
       set status = b ->> 'status', disabled = coalesce((b ->> 'disabled')::boolean, false),
           draft_window = nullif(b ->> 'draft_window', '')::bigint, published_at = nullif(b ->> 'published_at', '')::timestamptz,
           image = b ->> 'image', images_gallery = b -> 'images_gallery', skus = b -> 'skus', reviewed_by = b ->> 'reviewed_by'
     where pc.manufacturer = d.manufacturer and pc.page_key = k;
    n := n + 1;
  end loop;
  perform set_config('hcps.content_publication', '', true);
  return jsonb_build_object('ok', true, 'decision', p_decision, 'restored', n);
end $$;

-- 6. The self-test (catalog-api mc_guard_selftest), Release B's attempts with #25 narrowed to hidden pages no window built,
--    plus: a closed window's hidden draft adopted by the next window (allowed); a publication approval used on a page it
--    does not name, to publish or to unpublish (blocked). Every attempt is rolled back.
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
      (25, 'window: a hidden page no window built', 'product_content', 'own', 'blocked', null,
           'update public.product_content set name = coalesce(name, '''') || '' (self-test)'' where id = (select id from public.product_content where manufacturer = %1$L and not (status in (''published'',''active'',''discontinued'') and not coalesce(disabled, false)) and draft_window is null order by page_key limit 1)'),
      (26, 'window: adopt a hidden draft a closed window left', 'product_content', 'adopt', 'allowed',
           'insert into public.product_content (manufacturer, page_key, name, status) values (%1$L, ''__mc_selftest__'', ''self-test'', ''pending_review'')',
           'update public.product_content set name = ''self-test adopted'' where manufacturer = %1$L and page_key = ''__mc_selftest__'''),
      (27, 'publication: a page the approval does not name', 'product_content', 'publish', 'blocked', null,
           'update public.product_content set name = coalesce(name, '''') || '' (self-test)'', status = ''published'' where id = (select id from public.product_content where manufacturer = %1$L and page_key <> ''__mc_selftest__'' order by page_key limit 1)'),
      (28, 'publication: unpublish with a spent approval outside its pages', 'product_content', 'rollback_other', 'blocked', null,
           'update public.product_content set status = ''hidden'' where id = (select id from public.product_content where manufacturer = %1$L and status in (''published'',''active'',''discontinued'') order by page_key limit 1)')
    ) as v(n, attempt, tbl, win_mode, expect, setup, stmt) order by n loop
      wid := null; w2 := null; perform set_config('hcps.content_publication', '', true);
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
            elsif a.win_mode = 'adopt' then
              -- the draft was built under wid; wid closes; the line's next window adopts it
              update public.mfr_decisions set used_at = now(), used_by = 'mfr_content_guard_selftest' where id = wid;
              insert into public.mfr_decisions (manufacturer, field, kind, reason, decided_by)
                values (s.slug, 'enrichment_window', 'enrichment_window', 'self-test (always rolled back)', 'mfr_content_guard_selftest')
                returning id into w2;
              perform set_config('request.headers', json_build_object('x-hcps-enrichment-window', w2::text)::text, true);
            elsif a.win_mode in ('publish', 'rollback_other') then
              -- an approval naming only the self-test page; the attempt touches another page
              insert into public.mfr_decisions (manufacturer, field, kind, reason, decided_by, hcps_value, used_at)
                values (s.slug, 'content_publication', 'content_publication', 'self-test (always rolled back)', 'mfr_content_guard_selftest',
                        '{"pages":["__mc_selftest__"]}'::jsonb, case when a.win_mode = 'rollback_other' then now() end)
                returning id into w2;
              perform set_config('request.headers', '', true);
              perform set_config('hcps.content_publication', w2::text || ':' || case when a.win_mode = 'publish' then 'publish' else 'rollback' end, true);
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

revoke all on function public.mfr_content_guard_selftest() from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function public.mfr_content_guard_selftest() from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on function public.mfr_content_guard_selftest() from authenticated'; end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then execute 'grant execute on function public.mfr_content_guard_selftest() to service_role'; end if;
end $$;

revoke all on function public.mfr_content_guard() from public;
revoke all on function public.mfr_live_media_problem(jsonb, text) from public;
revoke all on function public.mfr_content_publish(bigint, text, text) from public;
revoke all on function public.mfr_content_publication_rollback(bigint, text) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function public.mfr_content_guard() from anon';
    execute 'revoke all on function public.mfr_live_media_problem(jsonb, text) from anon';
    execute 'revoke all on function public.mfr_content_publish(bigint, text, text) from anon';
    execute 'revoke all on function public.mfr_content_publication_rollback(bigint, text) from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on function public.mfr_content_guard() from authenticated';
    execute 'revoke all on function public.mfr_live_media_problem(jsonb, text) from authenticated';
    execute 'revoke all on function public.mfr_content_publish(bigint, text, text) from authenticated';
    execute 'revoke all on function public.mfr_content_publication_rollback(bigint, text) from authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.mfr_content_publish(bigint, text, text) to service_role';
    execute 'grant execute on function public.mfr_content_publication_rollback(bigint, text) to service_role';
  end if;
end $$;

commit;

-- CHECK (read-only, one result table). Every row: ok = true. Nothing is published by this file.
select * from (
  select 1 as n, 'content guard still on ' || t as check_name,
         case when exists (select 1 from pg_trigger g where g.tgname = 'mfr_content_guard' and g.tgrelid = to_regclass('public.' || t)) then 'installed' else 'NOT INSTALLED' end as value,
         exists (select 1 from pg_trigger g where g.tgname = 'mfr_content_guard' and g.tgrelid = to_regclass('public.' || t)) as ok
    from unnest(array['product_content','product_content_sources','product_media','product_links','product_related','product_overrides','custom_products','manufacturer_meta']) t
    where to_regclass('public.' || t) is not null
  union all
  select 2, 'Phase 2 commercial guard still installed (4 tables)', count(*)::text, count(*) = 4 from pg_trigger where tgname = 'mfr_freeze_guard'
  union all
  select 3, 'decision kinds include content_publication (one kind check)', count(*)::text || ' kind check',
         count(*) = 1 and bool_and(pg_get_constraintdef(c.oid) like '%content_publication%' and pg_get_constraintdef(c.oid) like '%content_resolution%')
    from pg_constraint c where c.conrelid = 'public.mfr_decisions'::regclass and c.contype = 'c' and pg_get_constraintdef(c.oid) like '%regression_fix%'
  union all
  select 4, 'anon/authenticated can execute the guard, the live-image rule, publish or rollback (expect false)',
         bool_or(has_function_privilege(r, 'public.mfr_content_guard()', 'execute') or has_function_privilege(r, 'public.mfr_live_media_problem(jsonb, text)', 'execute')
                 or has_function_privilege(r, 'public.mfr_content_publish(bigint, text, text)', 'execute')
                 or has_function_privilege(r, 'public.mfr_content_publication_rollback(bigint, text)', 'execute'))::text,
         not bool_or(has_function_privilege(r, 'public.mfr_content_guard()', 'execute') or has_function_privilege(r, 'public.mfr_live_media_problem(jsonb, text)', 'execute')
                 or has_function_privilege(r, 'public.mfr_content_publish(bigint, text, text)', 'execute')
                 or has_function_privilege(r, 'public.mfr_content_publication_rollback(bigint, text)', 'execute'))
    from unnest(array['anon','authenticated']) r where exists (select 1 from pg_roles where rolname = r)
  union all
  select 5, 'service_role can execute publish and rollback',
         (has_function_privilege('service_role', 'public.mfr_content_publish(bigint, text, text)', 'execute')
          and has_function_privilege('service_role', 'public.mfr_content_publication_rollback(bigint, text)', 'execute'))::text,
         has_function_privilege('service_role', 'public.mfr_content_publish(bigint, text, text)', 'execute')
          and has_function_privilege('service_role', 'public.mfr_content_publication_rollback(bigint, text)', 'execute')
  union all
  select 6, 'no content_publication decision exists yet (nothing approved or published by this file)',
         count(*)::text, count(*) = 0 from public.mfr_decisions where kind = 'content_publication'
  union all
  select 7, 'no live page carries a draft_window', count(*)::text, count(*) = 0
    from public.product_content where draft_window is not null and status in ('published','active','discontinued')
  union all
  select 8, 'every read policy on product_content is limited to visible pages',
         count(*)::text || ' read polic' || case when count(*) = 1 then 'y' else 'ies' end,
         count(*) >= 1 and bool_and(qual like '%published%' and qual like '%disabled%')
    from pg_policies where schemaname = 'public' and tablename = 'product_content' and cmd = 'SELECT'
  union all
  select 9, 'self-test: ' || (e->>'line') || ' — ' || (e->>'attempt'), (e->>'result') || ' (expect ' || (e->>'expect') || ')',
         (e->>'result') = (e->>'expect') or (e->>'result') = 'nothing to try'
    from jsonb_array_elements(public.mfr_content_guard_selftest()) e
) x order by n, check_name;
