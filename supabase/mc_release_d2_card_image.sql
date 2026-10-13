-- ============================================================================================
--  MANUFACTURER CENTER — CATALOG CARD IMAGE FOR GROUPED PAGES (Angelo 2026-10-12)
--  Runs AFTER mc_release_d1_content_approval.sql. Nothing is approved or published by running it.
--
--  THE RULE: a page that groups several SKUs (Assurance Round + Elongated) shows ONE catalog card before the dealer
--  picks an option. Its photo used to be whichever option came first in the catalog file. It is now the President's
--  explicit choice — an option's approved photo, another approved photo of the page, or none — recorded as a
--  content_approval decision, carried in the approved publication and covered by its plan hash. Presentation only:
--  no option photo, SKU order, grouping, price or pooling changes.
--
--  WHAT CHANGES HERE:
--    1. product_content.card_image (text, nullable): the chosen card photo — a live copy of this line
--       (product-content/<line>/live/...) or the word "none". NULL = no choice recorded (every page today; the
--       storefront then behaves exactly as before);
--    2. mfr_live_media_problem(): also checks card_image, so a draft or outside photo can never be published there;
--    3. mfr_approved_content() / mfr_content_publish() / mfr_content_publication_rollback(): card_image is written by a
--       publication and restored by a rollback, exactly like the other approved content fields.
--  The storefront reads card_image (and, until this file has run, reads the pages without it — no page is lost).
--
--  RULE 19: no new table, policy or grant. The new column is read only through product_content's existing public read
--  policy (visible pages only) — the storefront needs it there. The guard (mfr_content_guard) already covers every
--  column: a frozen line's card_image changes only through an approved publication (or a regression_fix). Functions
--  stay SECURITY DEFINER with a fixed search_path; publish/rollback executable by service_role only.
-- ============================================================================================
begin;

-- 1. The column (nothing is written to it here).
alter table public.product_content add column if not exists card_image text;

-- 2. (kind list unchanged: content_approval already exists)

-- 3. The live-image rule, now covering the catalog card image too ("none" is not an address and passes).
create or replace function public.mfr_live_media_problem(p_row jsonb, p_slug text) returns text
language plpgsql immutable set search_path = public, pg_temp as $$
declare u text; pre text;
begin
  pre := '^https://[a-z0-9]+\.supabase\.co/storage/v1/object/public/product-content/'
         || regexp_replace(p_slug, '([^a-z0-9])', '\\\1', 'g') || '/live/[^?#[:space:]]+$';
  for u in
    select v #>> '{}' from jsonb_path_query(
      jsonb_build_array(p_row -> 'image', p_row -> 'images_gallery', p_row -> 'skus', p_row -> 'card_image'),
      'lax $.** ? (@.type() == "string")') v
  loop
    if u ~* '^\s*(https?:|//|/)' and (u !~ pre or u ~ '/drafts/') then return u; end if;
  end loop;
  return null;
end $$;

-- 4. The approved content fields a publication may write (and a rollback restores) — now including card_image.
create or replace function public.mfr_approved_content(p_row jsonb) returns jsonb
language sql immutable set search_path = public, pg_temp as $$
  select coalesce(jsonb_object_agg(k, v), '{}'::jsonb) from jsonb_each(coalesce(p_row, '{}'::jsonb)) e(k, v)
   where k = any (array['name','tagline','description','features','clinical_applications','specs','billing_codes','sizing_table','sizing_note',
                        'warranty','documents','videos','source_url','category','subcategory','options','field_provenance','card_image'])
$$;

-- 5. Publish exactly the approved publication — photos AND approved content — atomically.
create or replace function public.mfr_content_publish(p_decision bigint, p_plan_hash text, p_by text default 'Manufacturer Center')
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  d      record;
  k      text;
  cur    jsonb;
  aft    jsonb;
  bad    text;
  rw     public.product_content%rowtype;
  nw     public.product_content%rowtype;
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
    select * into rw from public.product_content pc where pc.manufacturer = d.manufacturer and pc.page_key = k for update;
    if rw.page_key is null then
      raise exception 'publication_refused: page % no longer exists', k using errcode = 'P0001';
    end if;
    cur := to_jsonb(rw);
    if cur is distinct from (d.hcps_value -> 'before' -> k) then
      raise exception 'publication_refused: page % changed after the dry run. A new dry run and approval are needed.', k using errcode = 'P0001';
    end if;
    aft := d.hcps_value -> 'after' -> k;
    if aft is null then raise exception 'publication_refused: no approved content for page %', k using errcode = 'P0001'; end if;
    bad := public.mfr_live_media_problem(aft, d.manufacturer);
    if bad is not null then
      raise exception 'publication_refused: page % would point at an image that is not a live copy: %', k, left(bad, 160) using errcode = 'P0001';
    end if;
    nw := jsonb_populate_record(rw, public.mfr_approved_content(aft));
    update public.product_content pc
       set status = 'published', disabled = false, draft_window = null, published_at = now(),
           image = aft ->> 'image', images_gallery = aft -> 'images_gallery', skus = aft -> 'skus', reviewed_by = left(p_by, 80),
           name = nw.name, tagline = nw.tagline, description = nw.description, features = nw.features,
           clinical_applications = nw.clinical_applications, specs = nw.specs, billing_codes = nw.billing_codes,
           sizing_table = nw.sizing_table, sizing_note = nw.sizing_note, warranty = nw.warranty, documents = nw.documents,
           videos = nw.videos, source_url = nw.source_url, category = nw.category, subcategory = nw.subcategory,
           options = nw.options, field_provenance = nw.field_provenance, card_image = nw.card_image
     where pc.manufacturer = d.manufacturer and pc.page_key = k;
    n := n + 1;
  end loop;
  perform set_config('hcps.content_publication', '', true);
  update public.mfr_decisions set used_at = now(), used_by = left(p_by, 80) where id = p_decision and used_at is null;
  return jsonb_build_object('ok', true, 'decision', p_decision, 'published', n, 'pages', d.hcps_value -> 'pages');
end $$;

-- 6. Roll a publication back to its approved "before" rows — photos AND content — atomically (refused once Gold Standard).
create or replace function public.mfr_content_publication_rollback(p_decision bigint, p_by text default 'Manufacturer Center')
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  d   record;
  k   text;
  b   jsonb;
  rw  public.product_content%rowtype;
  nw  public.product_content%rowtype;
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
    select * into rw from public.product_content pc where pc.manufacturer = d.manufacturer and pc.page_key = k for update;
    if rw.page_key is null then continue; end if;
    nw := jsonb_populate_record(rw, public.mfr_approved_content(b));
    update public.product_content pc
       set status = b ->> 'status', disabled = coalesce((b ->> 'disabled')::boolean, false),
           draft_window = nullif(b ->> 'draft_window', '')::bigint, published_at = nullif(b ->> 'published_at', '')::timestamptz,
           image = b ->> 'image', images_gallery = b -> 'images_gallery', skus = b -> 'skus', reviewed_by = b ->> 'reviewed_by',
           name = nw.name, tagline = nw.tagline, description = nw.description, features = nw.features,
           clinical_applications = nw.clinical_applications, specs = nw.specs, billing_codes = nw.billing_codes,
           sizing_table = nw.sizing_table, sizing_note = nw.sizing_note, warranty = nw.warranty, documents = nw.documents,
           videos = nw.videos, source_url = nw.source_url, category = nw.category, subcategory = nw.subcategory,
           options = nw.options, field_provenance = nw.field_provenance, card_image = nw.card_image
     where pc.manufacturer = d.manufacturer and pc.page_key = k;
    n := n + 1;
  end loop;
  perform set_config('hcps.content_publication', '', true);
  return jsonb_build_object('ok', true, 'decision', p_decision, 'restored', n);
end $$;

revoke all on function public.mfr_approved_content(jsonb) from public;
revoke all on function public.mfr_live_media_problem(jsonb, text) from public;
revoke all on function public.mfr_content_publish(bigint, text, text) from public;
revoke all on function public.mfr_content_publication_rollback(bigint, text) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function public.mfr_approved_content(jsonb) from anon';
    execute 'revoke all on function public.mfr_live_media_problem(jsonb, text) from anon';
    execute 'revoke all on function public.mfr_content_publish(bigint, text, text) from anon';
    execute 'revoke all on function public.mfr_content_publication_rollback(bigint, text) from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on function public.mfr_approved_content(jsonb) from authenticated';
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

-- CHECK (read-only, one result table). Every row: ok = true. Nothing is approved or published by this file.
select * from (
  select 1 as n, 'product_content.card_image exists (text)' as check_name,
         coalesce(max(data_type), 'MISSING') as value, count(*) = 1 and max(data_type) = 'text' as ok
    from information_schema.columns where table_schema = 'public' and table_name = 'product_content' and column_name = 'card_image'
  union all
  select 2, 'no page carries a card image yet (nothing chosen or published by this file)', count(*)::text, count(*) = 0
    from public.product_content where card_image is not null
  union all
  select 3, 'the live-image rule refuses a draft or outside card image and accepts "none"',
         (public.mfr_live_media_problem('{"card_image":"https://x.supabase.co/storage/v1/object/public/product-content/bemis/drafts/w1/p/a.jpg"}'::jsonb, 'bemis') is not null
          and public.mfr_live_media_problem('{"card_image":"https://www.toiletseats.com/a.jpg"}'::jsonb, 'bemis') is not null
          and public.mfr_live_media_problem('{"card_image":"none"}'::jsonb, 'bemis') is null
          and public.mfr_live_media_problem('{"card_image":"https://abcdefghijklmnop.supabase.co/storage/v1/object/public/product-content/bemis/live/p/abc.jpg"}'::jsonb, 'bemis') is null)::text,
         public.mfr_live_media_problem('{"card_image":"https://x.supabase.co/storage/v1/object/public/product-content/bemis/drafts/w1/p/a.jpg"}'::jsonb, 'bemis') is not null
          and public.mfr_live_media_problem('{"card_image":"https://www.toiletseats.com/a.jpg"}'::jsonb, 'bemis') is not null
          and public.mfr_live_media_problem('{"card_image":"none"}'::jsonb, 'bemis') is null
          and public.mfr_live_media_problem('{"card_image":"https://abcdefghijklmnop.supabase.co/storage/v1/object/public/product-content/bemis/live/p/abc.jpg"}'::jsonb, 'bemis') is null
  union all
  select 4, 'publish and rollback write / restore card_image',
         (position('card_image = nw.card_image' in pg_get_functiondef('public.mfr_content_publish(bigint, text, text)'::regprocedure)) > 0
          and position('card_image = nw.card_image' in pg_get_functiondef('public.mfr_content_publication_rollback(bigint, text)'::regprocedure)) > 0)::text,
         position('card_image = nw.card_image' in pg_get_functiondef('public.mfr_content_publish(bigint, text, text)'::regprocedure)) > 0
          and position('card_image = nw.card_image' in pg_get_functiondef('public.mfr_content_publication_rollback(bigint, text)'::regprocedure)) > 0
  union all
  select 5, 'the approved-content filter carries card_image and still drops status / page / line / image / window',
         public.mfr_approved_content('{"card_image":"none","status":"published","page_key":"p","manufacturer":"m","image":"i","draft_window":1}'::jsonb)::text,
         public.mfr_approved_content('{"card_image":"none","status":"published","page_key":"p","manufacturer":"m","image":"i","draft_window":1}'::jsonb) = '{"card_image":"none"}'::jsonb
  union all
  select 6, 'anon/authenticated can execute publish, rollback, the content filter or the live-image rule (expect false)',
         bool_or(has_function_privilege(r, 'public.mfr_content_publish(bigint, text, text)', 'execute') or has_function_privilege(r, 'public.mfr_content_publication_rollback(bigint, text)', 'execute')
                 or has_function_privilege(r, 'public.mfr_approved_content(jsonb)', 'execute') or has_function_privilege(r, 'public.mfr_live_media_problem(jsonb, text)', 'execute'))::text,
         not bool_or(has_function_privilege(r, 'public.mfr_content_publish(bigint, text, text)', 'execute') or has_function_privilege(r, 'public.mfr_content_publication_rollback(bigint, text)', 'execute')
                 or has_function_privilege(r, 'public.mfr_approved_content(jsonb)', 'execute') or has_function_privilege(r, 'public.mfr_live_media_problem(jsonb, text)', 'execute'))
    from unnest(array['anon','authenticated']) r where exists (select 1 from pg_roles where rolname = r)
  union all
  select 7, 'publish and rollback stay SECURITY DEFINER with a fixed search_path', count(*)::text || ' of 2', count(*) = 2
    from pg_proc p where p.oid in ('public.mfr_content_publish(bigint, text, text)'::regprocedure, 'public.mfr_content_publication_rollback(bigint, text)'::regprocedure)
     and p.prosecdef and exists (select 1 from unnest(p.proconfig) c where c like 'search_path=%')
  union all
  select 8, 'no unspent content_publication is waiting (nothing approved by this file)', count(*)::text, count(*) = 0
    from public.mfr_decisions where kind = 'content_publication' and used_at is null
  union all
  select 9, 'every read policy on product_content is limited to visible pages',
         count(*)::text || ' read polic' || case when count(*) = 1 then 'y' else 'ies' end,
         count(*) >= 1 and bool_and(qual like '%published%' and qual like '%disabled%')
    from pg_policies where schemaname = 'public' and tablename = 'product_content' and cmd = 'SELECT'
  union all
  select 10, 'self-test: ' || (e->>'line') || ' — ' || (e->>'attempt'), (e->>'result') || ' (expect ' || (e->>'expect') || ')',
         (e->>'result') = (e->>'expect') or (e->>'result') = 'nothing to try'
    from jsonb_array_elements(public.mfr_content_guard_selftest()) e
) x order by n, check_name;
