-- =============================================================================================
-- HCPS Academy — A2D migration M3.1: ATOMIC LESSON SAVE           supabase/academy_a2d_m3_1_save_lesson.sql
-- STATUS: DEVELOPMENT (draft PR). Design approved by Angelo 12 Oct 2026 21:00 CT for development and local testing only.
-- Run ONLY after Angelo approves this exact file (read-only preflight, review, approval, SQL editor Run button with the
-- committed file pasted verbatim, sha256 checked). Rollback: supabase/academy_a2d_m3_1_rollback.sql.
-- Checks: supabase/academy_a2d_m3_1_{preflight,postcheck,acceptance_tests}.sql; test/academy-m3_1.pg.test.js locally.
--
-- WHY: the Stage 3 builder saves a lesson as a sequence of separately committed M3 operations (link facts, re-check,
-- set_blocks, read the audit row, put back, prune). That never silently overwrites anyone, but between two of its steps
-- another editor's save could be replaced and then put back, a refused save could leave links behind if their undo also
-- failed, and a failed clean-up was itself possible. M3.1 does the whole save as ONE transaction:
--
--   academy_save_op_lesson(p_actor text, p_lesson_id uuid, p_base_blocks jsonb, p_blocks jsonb) returns jsonb
--     1. the acting person must be an active administrator (M1 academy_op_actor_staff), named from the verified sign-in;
--     2. LOCK FIRST: the draft version (M2 academy_content_lock_draft: draft only, else 55000), then the lesson row
--        FOR UPDATE. A second save of the same lesson waits here until the first commits or rolls back;
--     3. COMPARE-AND-SET: the stored blocks must equal p_base_blocks (jsonb equality: key order never matters). If not,
--        40001 "changed" — nothing has been written, so another editor's work is never overwritten, even for a moment;
--     4. the product-fact links the screens need are DERIVED from p_blocks by the database (every fact block and every
--        comparison cell). The request never supplies a link list;
--     5. missing links are inserted, then the M3 block checker (academy_author_check_blocks, unchanged) validates the
--        screens — it sees the new links because they are in the same transaction, so its "link the fact to this
--        lesson first" rule is met by this very save, and a refused save takes its new links with it;
--     6. the screens are written; this lesson's links that the saved screens no longer use are deleted. Only rows with
--        lesson_id = this lesson: exam/practice question links (question_id) and other lessons' links are never
--        touched, and no product_facts row is ever read for writing, changed or deleted;
--     7. ONE audit row: entity academy_lessons, action save_lesson, before = the lesson row, after = the new lesson row
--        plus "_links": {"added": [...], "removed": [...]}. If the audit row cannot be written, everything rolls back.
--   Any error at any step rolls back the whole save (one statement = one transaction through PostgREST).
--
-- Reuses (owner-only, unchanged): M1 academy_op_begin / _end / _audit / _actor_staff; M2 academy_content_lock_draft /
--   academy_content_keys; M3 academy_author_model / academy_author_check_blocks. M3's set_blocks, link_fact and
--   unlink_fact stay installed and unchanged (questions still use link_fact).
-- Prefix academy_save_ (not academy_author_) so the M3 fingerprint, function counts and rollback are untouched.
-- New: 1 operation (server role only) + 1 helper (owner only). No table, column, trigger, policy or grant on a table
--   changes. Every UPDATE / DELETE carries a WHERE clause (pg-safeupdate). Runs as ONE transaction.
-- President-only editing is NOT moved into the database: the server gate (PRESIDENT_ONLY_EDITING) stays in force until
--   Angelo lifts it; the database keeps M3's rule (any active administrator).
-- Errors: 42501 not allowed · P0002 not found · 22023 invalid input · 55000 locked (not a draft) · 40001 changed.
-- =============================================================================================
begin;

do $$
begin
  if to_regprocedure('public.academy_op_begin(text,text)') is null or to_regprocedure('public.academy_op_actor_staff(text)') is null then
    raise exception 'M1 (audited operations) is not installed. Stop and investigate.';
  end if;
  if to_regprocedure('public.academy_content_lock_draft(uuid)') is null or to_regprocedure('public.academy_content_keys(jsonb,text[])') is null then
    raise exception 'M2 (content operations) is not installed. Stop and investigate.';
  end if;
  if to_regprocedure('public.academy_author_check_blocks(uuid,uuid,jsonb)') is null or to_regprocedure('public.academy_author_model(jsonb)') is null
     or to_regprocedure('public.academy_author_guard()') is null then
    raise exception 'M3 (lesson-content operations) is not installed. Stop and investigate.';
  end if;
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
             where n.nspname = 'public' and p.proname like 'academy\_save\_%') then
    raise exception 'M3.1 already exists. Stop and investigate; do not re-run.';
  end if;
end $$;

-- ---------------------------------------------------------------------------------------------
-- HELPER (owner only): the product-fact links a lesson's screens need, derived from the screens themselves.
-- One row per (manufacturer, model, field): every fact block, and every cell (model x field) of every comparison.
-- Shapes the block checker would refuse are skipped here; the checker then refuses them with its own message.
-- A manufacturer outside the HCPS list, or a model code the M3 rule refuses, is refused here (it could not be linked).
-- ---------------------------------------------------------------------------------------------
create function public.academy_save_lesson_links(p_blocks jsonb)
returns table (manufacturer_slug text, model_code text, field text)
language plpgsql set search_path = pg_catalog, public, pg_temp as $$
declare b jsonb; m jsonb; f jsonb; v_mfr text; v_field text;
begin
  if p_blocks is null or jsonb_typeof(p_blocks) <> 'array' then
    raise exception 'academy: blocks must be a list' using errcode = '22023';
  end if;
  for b in select x from jsonb_array_elements(p_blocks) x loop
    continue when jsonb_typeof(b) <> 'object' or b->>'kind' is null or b->>'kind' not in ('fact', 'comparison');
    v_mfr := b->>'manufacturer_slug';
    if v_mfr is null or not exists (select 1 from manufacturers mm where mm.slug = v_mfr) then
      raise exception 'academy: that manufacturer is not in the HCPS manufacturer list' using errcode = '22023';
    end if;
    if b->>'kind' = 'fact' then
      v_field := b->>'field';
      continue when v_field is null or v_field !~ '^[a-z0-9_.]{1,60}$';
      manufacturer_slug := v_mfr; model_code := academy_author_model(b->'model_code'); field := v_field;
      return next;
    else
      continue when jsonb_typeof(b->'models') is distinct from 'array' or jsonb_typeof(b->'fields') is distinct from 'array';
      for f in select x from jsonb_array_elements(b->'fields') x loop
        continue when jsonb_typeof(f) <> 'object';
        v_field := f->>'field';
        continue when v_field is null or v_field !~ '^[a-z0-9_.]{1,60}$';
        for m in select x from jsonb_array_elements(b->'models') x loop
          manufacturer_slug := v_mfr; model_code := academy_author_model(m); field := v_field;
          return next;
        end loop;
      end loop;
    end if;
  end loop;
end $$;

-- ---------------------------------------------------------------------------------------------
-- THE OPERATION
-- ---------------------------------------------------------------------------------------------
create function public.academy_save_op_lesson(p_actor text, p_lesson_id uuid, p_base_blocks jsonb, p_blocks jsonb)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare v_old academy_lessons; v_ver uuid; v_blocks jsonb; v_new jsonb; v_added jsonb; v_removed jsonb; v_want text[];
begin
  perform academy_op_actor_staff(p_actor);
  perform academy_op_begin('save_lesson', p_actor);
  if p_lesson_id is null then raise exception 'academy: lesson not found' using errcode = 'P0002'; end if;
  if p_base_blocks is null or jsonb_typeof(p_base_blocks) <> 'array' then
    raise exception 'academy: the save must name the content it started from' using errcode = '22023';
  end if;
  -- 2. lock first: the version (draft only), then the lesson row
  select m.version_id into v_ver from academy_lessons l join academy_modules m on m.id = l.module_id where l.id = p_lesson_id;
  if v_ver is null then raise exception 'academy: lesson not found' using errcode = 'P0002'; end if;
  perform academy_content_lock_draft(v_ver);
  select * into v_old from academy_lessons where id = p_lesson_id for update;
  if not found then raise exception 'academy: lesson not found' using errcode = 'P0002'; end if;
  if (select m.version_id from academy_modules m where m.id = v_old.module_id) is distinct from v_ver then
    raise exception 'academy: changed: the lesson moved while it was being saved; reload it' using errcode = '40001';
  end if;
  -- 3. compare-and-set: nothing is written unless the lesson still holds the content this save started from
  if v_old.blocks is distinct from p_base_blocks then
    raise exception 'academy: changed: this lesson was saved by someone else since you opened it; reload it to see their version'
      using errcode = '40001';
  end if;
  -- 4-5. links the screens need: insert the missing ones (same transaction), then the unchanged M3 block checker.
  --      A wanted link is the key manufacturer|MODEL|field (none of the three can contain '|').
  v_want := array(select distinct w.manufacturer_slug || '|' || w.model_code || '|' || w.field from academy_save_lesson_links(p_blocks) w);
  with ins as (
    insert into academy_content_refs (id, version_id, lesson_id, question_id, manufacturer_slug, model_code, field)
    select gen_random_uuid(), v_ver, p_lesson_id, null, split_part(k, '|', 1), split_part(k, '|', 2), split_part(k, '|', 3)
      from unnest(v_want) k
     where not exists (select 1 from academy_content_refs r where r.lesson_id = p_lesson_id
                         and r.manufacturer_slug || '|' || upper(r.model_code) || '|' || coalesce(r.field, '') = k)
    returning academy_content_refs.*)
  select coalesce(jsonb_agg(jsonb_build_object('id', ins.id, 'manufacturer_slug', ins.manufacturer_slug, 'model_code', ins.model_code,
                            'field', ins.field) order by ins.manufacturer_slug, ins.model_code, ins.field), '[]') into v_added from ins;
  v_blocks := academy_author_check_blocks(p_lesson_id, v_ver, p_blocks);
  -- 6. write the screens; remove only THIS lesson's links that the saved screens no longer use
  update academy_lessons set blocks = v_blocks where id = p_lesson_id returning to_jsonb(academy_lessons.*) into strict v_new;
  with del as (
    delete from academy_content_refs r
     where r.lesson_id = p_lesson_id and r.question_id is null
       and not (r.manufacturer_slug || '|' || upper(r.model_code) || '|' || coalesce(r.field, '') = any (v_want))
    returning r.*)
  select coalesce(jsonb_agg(jsonb_build_object('id', del.id, 'manufacturer_slug', del.manufacturer_slug, 'model_code', del.model_code,
                            'field', del.field) order by del.manufacturer_slug, del.model_code, del.field), '[]') into v_removed from del;
  -- 7. one audit row; if it cannot be written, the whole save rolls back
  perform academy_op_audit('staff', p_actor, 'academy_lessons', p_lesson_id::text, 'save_lesson', to_jsonb(v_old),
                           v_new || jsonb_build_object('_links', jsonb_build_object('added', v_added, 'removed', v_removed)));
  perform academy_op_end();
  return jsonb_build_object('lesson', v_new, 'links_added', jsonb_array_length(v_added), 'links_removed', jsonb_array_length(v_removed));
end $$;

-- ---------------------------------------------------------------------------------------------
-- PRIVILEGES (rule 19): the operation — server role only; the helper — owner only. Nothing for public/anon/authenticated.
-- ---------------------------------------------------------------------------------------------
revoke all on function public.academy_save_lesson_links(jsonb) from public, anon, authenticated, service_role;
revoke all on function public.academy_save_op_lesson(text, uuid, jsonb, jsonb) from public, anon, authenticated, service_role;
grant execute on function public.academy_save_op_lesson(text, uuid, jsonb, jsonb) to service_role;

commit;
