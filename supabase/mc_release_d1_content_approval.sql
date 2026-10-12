-- ============================================================================================
--  MANUFACTURER CENTER — APPROVE CONTENT & IMAGES (Angelo 2026-10-12, before Bemis's Gold Standard)
--  Runs AFTER mc_release_d_publication.sql. Nothing is approved or published by running it.
--
--  THE RULE: Auto-Enrich proposes; only the President decides what becomes dealer-facing. Each selection
--  (Keep current / Use proposed / Edit; for photos: keep the current dealer image / use this image / none;
--  the gallery photo by photo) is a decision of the new kind content_approval (append-only, like every
--  decision). The publication plan is built from those selections only — no selection = keep the current
--  dealer view — and the plan hash covers them, so a selection changed after the dry run invalidates it.
--
--  WHAT CHANGES HERE:
--    1. decision kind content_approval (the kind check is replaced; never two);
--    2. mfr_content_publish(): the approved publication now carries the approved CONTENT too (name, short and
--       full description, features, specs, sizing, warranty, documents/videos, category/subcategory, options,
--       provenance) and the function writes exactly the fields the approval names, in the same single
--       transaction, with the same checks as before (unspent decision, plan hash, frozen line, every page
--       still exactly its "before" row, every image a live copy). A field the approval does not name is left
--       as it is (an approval recorded before today names none: it behaves exactly as Release D did);
--    3. mfr_content_publication_rollback(): restores those content fields from the "before" rows as well, so a
--       rollback still returns every page exactly as it was. Still refused once the publication is the line's
--       Gold Standard.
--  The guard (mfr_content_guard) is unchanged: it lets these two functions through for the pages their
--  decision names, and nothing else.
--
--  RULE 19: no new table, no new policy, no new grant beyond the two functions' existing ones. Both stay
--  SECURITY DEFINER with a fixed search_path, executable by service_role only (never PUBLIC/anon/authenticated).
-- ============================================================================================
begin;

-- 1. Decision kind content_approval (replace the kind check; never two).
do $$
declare c record;
begin
  for c in select conname from pg_constraint
           where conrelid = 'public.mfr_decisions'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%regression_fix%' loop
    execute format('alter table public.mfr_decisions drop constraint %I', c.conname);
  end loop;
end $$;
alter table public.mfr_decisions add constraint mfr_decisions_kind_check
  check (kind in ('interpretation','conflict','exception','regression_fix','freight_terms','deferral','acceptance','enrichment_window','content_resolution','content_publication','content_approval'));

-- 2. The approved content fields a publication may write (and a rollback restores). Nothing else on the row.
create or replace function public.mfr_approved_content(p_row jsonb) returns jsonb
language sql immutable set search_path = public, pg_temp as $$
  select coalesce(jsonb_object_agg(k, v), '{}'::jsonb) from jsonb_each(coalesce(p_row, '{}'::jsonb)) e(k, v)
   where k = any (array['name','tagline','description','features','clinical_applications','specs','billing_codes','sizing_table','sizing_note',
                        'warranty','documents','videos','source_url','category','subcategory','options','field_provenance'])
$$;

-- 3. Publish exactly the approved publication — photos AND approved content — atomically.
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
           options = nw.options, field_provenance = nw.field_provenance
     where pc.manufacturer = d.manufacturer and pc.page_key = k;
    n := n + 1;
  end loop;
  perform set_config('hcps.content_publication', '', true);
  update public.mfr_decisions set used_at = now(), used_by = left(p_by, 80) where id = p_decision and used_at is null;
  return jsonb_build_object('ok', true, 'decision', p_decision, 'published', n, 'pages', d.hcps_value -> 'pages');
end $$;

-- 4. Roll a publication back to its approved "before" rows — photos AND content — atomically (refused once Gold Standard).
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
           options = nw.options, field_provenance = nw.field_provenance
     where pc.manufacturer = d.manufacturer and pc.page_key = k;
    n := n + 1;
  end loop;
  perform set_config('hcps.content_publication', '', true);
  return jsonb_build_object('ok', true, 'decision', p_decision, 'restored', n);
end $$;

revoke all on function public.mfr_approved_content(jsonb) from public;
revoke all on function public.mfr_content_publish(bigint, text, text) from public;
revoke all on function public.mfr_content_publication_rollback(bigint, text) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function public.mfr_approved_content(jsonb) from anon';
    execute 'revoke all on function public.mfr_content_publish(bigint, text, text) from anon';
    execute 'revoke all on function public.mfr_content_publication_rollback(bigint, text) from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on function public.mfr_approved_content(jsonb) from authenticated';
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
  select 1 as n, 'decision kinds include content_approval (one kind check, publication kinds kept)' as check_name,
         count(*)::text || ' kind check' as value,
         count(*) = 1 and bool_and(pg_get_constraintdef(c.oid) like '%content_approval%' and pg_get_constraintdef(c.oid) like '%content_publication%'
                                   and pg_get_constraintdef(c.oid) like '%content_resolution%' and pg_get_constraintdef(c.oid) like '%enrichment_window%') as ok
    from pg_constraint c where c.conrelid = 'public.mfr_decisions'::regclass and c.contype = 'c' and pg_get_constraintdef(c.oid) like '%regression_fix%'
  union all
  select 2, 'publish and rollback write the approved content fields (and only those)',
         (position('mfr_approved_content' in pg_get_functiondef('public.mfr_content_publish(bigint, text, text)'::regprocedure)) > 0
          and position('mfr_approved_content' in pg_get_functiondef('public.mfr_content_publication_rollback(bigint, text)'::regprocedure)) > 0)::text,
         position('mfr_approved_content' in pg_get_functiondef('public.mfr_content_publish(bigint, text, text)'::regprocedure)) > 0
          and position('mfr_approved_content' in pg_get_functiondef('public.mfr_content_publication_rollback(bigint, text)'::regprocedure)) > 0
  union all
  select 2, 'product_content has every approved content column the functions write (17)',
         count(*)::text || ' of 17', count(*) = 17
    from information_schema.columns
   where table_schema = 'public' and table_name = 'product_content'
     and column_name = any (array['name','tagline','description','features','clinical_applications','specs','billing_codes','sizing_table','sizing_note',
                                  'warranty','documents','videos','source_url','category','subcategory','options','field_provenance'])
  union all
  select 3, 'the approved-content filter keeps content fields only (no status, page, line, image or window)',
         public.mfr_approved_content('{"description":"x","status":"published","page_key":"p","manufacturer":"m","image":"i","draft_window":1,"disabled":false}'::jsonb)::text,
         public.mfr_approved_content('{"description":"x","status":"published","page_key":"p","manufacturer":"m","image":"i","draft_window":1,"disabled":false}'::jsonb) = '{"description":"x"}'::jsonb
  union all
  select 4, 'anon/authenticated can execute publish, rollback or the content filter (expect false)',
         bool_or(has_function_privilege(r, 'public.mfr_content_publish(bigint, text, text)', 'execute')
                 or has_function_privilege(r, 'public.mfr_content_publication_rollback(bigint, text)', 'execute')
                 or has_function_privilege(r, 'public.mfr_approved_content(jsonb)', 'execute'))::text,
         not bool_or(has_function_privilege(r, 'public.mfr_content_publish(bigint, text, text)', 'execute')
                 or has_function_privilege(r, 'public.mfr_content_publication_rollback(bigint, text)', 'execute')
                 or has_function_privilege(r, 'public.mfr_approved_content(jsonb)', 'execute'))
    from unnest(array['anon','authenticated']) r where exists (select 1 from pg_roles where rolname = r)
  union all
  select 5, 'service_role can execute publish and rollback',
         (has_function_privilege('service_role', 'public.mfr_content_publish(bigint, text, text)', 'execute')
          and has_function_privilege('service_role', 'public.mfr_content_publication_rollback(bigint, text)', 'execute'))::text,
         has_function_privilege('service_role', 'public.mfr_content_publish(bigint, text, text)', 'execute')
          and has_function_privilege('service_role', 'public.mfr_content_publication_rollback(bigint, text)', 'execute')
  union all
  select 6, 'publish and rollback stay SECURITY DEFINER with a fixed search_path',
         count(*)::text || ' of 2', count(*) = 2
    from pg_proc p where p.oid in ('public.mfr_content_publish(bigint, text, text)'::regprocedure, 'public.mfr_content_publication_rollback(bigint, text)'::regprocedure)
     and p.prosecdef and exists (select 1 from unnest(p.proconfig) c where c like 'search_path=%')
  union all
  select 7, 'no unspent content_publication is waiting (nothing approved by this file)', count(*)::text, count(*) = 0
    from public.mfr_decisions where kind = 'content_publication' and used_at is null
  union all
  select 8, 'no live page carries a draft_window', count(*)::text, count(*) = 0
    from public.product_content where draft_window is not null and status in ('published','active','discontinued')
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
