-- =============================================================================================
-- HCPS Academy — A2D migration M3: AUDITED LESSON-CONTENT OPERATIONS   supabase/academy_a2d_m3_author_ops.sql
-- STATUS: DEVELOPMENT (draft PR). Run ONLY after Angelo approves this exact file (preflight, review, approval, SQL editor
-- Run button with the committed file pasted verbatim, sha256 checked). Rollback: supabase/academy_a2d_m3_rollback.sql.
-- Tests: supabase/academy_a2d_m3_acceptance_tests.sql (and test/academy-m3.pg.test.js locally).
--
-- WHY (Angelo, 11 Oct 2026 17:23 — A2D plan approved, decisions A–G): the lesson builder needs to write lesson blocks,
-- the question bank, media records and product-fact links. M1/M2 locked content behind audited operations; these four
-- kinds of content had no operation yet. Every write below is ONE transaction: the change and its academy_events row
-- together or neither. Draft versions only; administrators only; the acting person comes from the verified sign-in.
--
-- Operations (SECURITY DEFINER, pinned search path, executable by the server role only):
--   academy_author_op_set_blocks          (p_actor, p_lesson_id, p_blocks)        lesson blocks, checked here
--   academy_author_op_reorder_modules     (p_actor, p_version_id, p_order uuid[])
--   academy_author_op_reorder_lessons     (p_actor, p_module_id, p_order uuid[])
--   academy_author_op_set_exam_distribution(p_actor, p_version_id, p_quotas)      decision B (configurable)
--   academy_author_op_create_question     (p_actor, p_id, p_version_id, p_question)
--   academy_author_op_update_question     (p_actor, p_id, p_changes)
--   academy_author_op_set_question_status (p_actor, p_id, p_status, p_reason)     retire / restore
--   academy_author_op_create_media        (p_actor, p_id, p_media)                rights + alt text (decision C)
--   academy_author_op_update_media        (p_actor, p_id, p_changes)
--   academy_author_op_delete_media        (p_actor, p_id)
--   academy_author_op_link_fact           (p_actor, p_id, p_link)                 lesson or question -> product fact
--   academy_author_op_unlink_fact         (p_actor, p_id)
-- Internal helpers (owner only): academy_author_text, academy_author_url, academy_author_uuid, academy_author_model,
--   academy_author_alt, academy_author_media_ref, academy_author_check_question, academy_author_check_media,
--   academy_author_check_blocks,
--   academy_author_exam_draw
-- Guards: academy_author_guard() — trigger academy_author_guard (rows) and academy_author_guard_truncate (TRUNCATE) on
--   academy_questions, academy_media, academy_content_refs: every write not made by an audited operation is refused
--   (the M1 operations pass: they run as the owner with the marker set). academy_author_publish_check() — trigger
--   academy_author_publish_check on academy_course_versions: a version becomes published only when its exam can be
--   drawn under its distribution and every lesson's blocks are still valid.
--
-- ONE CHANGE TO M1 (decision B; independently reviewed and tested): academy_op_start_attempt draws through
--   academy_author_exam_draw instead of "25 at random from the whole bank". Its signature, rights, owner and every other
--   line are unchanged. The draw (a) takes only exam questions whose pinned facts are still current and verified
--   (unverified or replaced facts never reach a scored exam), and (b) follows the version's distribution: when
--   academy_modules.exam_quota is set, every module gives exactly its number; when no module has one, every module needs
--   a usable exam question and gives at least one, the rest at random. Either way every module is represented. Facts are
--   checked when the exam is DRAWN; a fact withdrawn during an open attempt does not change that attempt's grading (M1
--   grading is unchanged). The M1 code fingerprint therefore changes (see the M3 postcheck); the rollback puts back the
--   original text byte for byte, but only before any version with a distribution is published (see the rollback).
-- ONE NEW COLUMN: academy_modules.exam_quota (nullable; the number of exam questions a module gives each attempt).
--   The A2D plan said "no new columns"; decision B ("configurable rather than hard-coded") needs a stored setting.
--
-- Reuses (owner-only, unchanged): M1 academy_op_begin / _end / _audit / _actor_staff; M2 academy_content_lock_draft /
--   academy_content_keys / academy_content_actor_president. Changes NOTHING outside the Academy. Every UPDATE / DELETE
--   carries a WHERE clause (pg-safeupdate). Runs as ONE transaction.
-- Answer keys: kept in academy_questions only; audit rows record "answer_key_changed", never the key.
-- Errors: 42501 not allowed · P0002 not found · 22023 invalid input · 55000 locked (not a draft, or in use) · 23505 duplicate.
-- =============================================================================================
begin;

do $$
begin
  if to_regprocedure('public.academy_op_begin(text,text)') is null or to_regprocedure('public.academy_audited_guard()') is null then
    raise exception 'M1 (audited operations) is not installed. Stop and investigate.';
  end if;
  if to_regprocedure('public.academy_content_lock_draft(uuid)') is null or to_regprocedure('public.academy_content_guard()') is null then
    raise exception 'M2 (content operations) is not installed. Stop and investigate.';
  end if;
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
             where n.nspname = 'public' and p.proname like 'academy\_author\_%') then
    raise exception 'M3 lesson-content operations already exist. Stop and investigate; do not re-run.';
  end if;
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'academy_modules'
             and column_name = 'exam_quota') then
    raise exception 'academy_modules.exam_quota already exists. Stop and investigate.';
  end if;
  if (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname = 'academy_op_start_attempt') <> 1 then
    raise exception 'academy_op_start_attempt is missing or overloaded. Stop and investigate.';
  end if;
end $$;

-- ---------------------------------------------------------------------------------------------
-- THE ONE NEW COLUMN (decision B)
-- ---------------------------------------------------------------------------------------------
alter table public.academy_modules
  add column exam_quota int check (exam_quota is null or exam_quota between 1 and 200);
comment on column public.academy_modules.exam_quota is
  'Exam questions this module gives each attempt (A2D decision B). Null on every module of a version = automatic:
   every module gives at least one. Set only by academy_author_op_set_exam_distribution.';

-- ---------------------------------------------------------------------------------------------
-- INTERNAL HELPERS (owner only)
-- ---------------------------------------------------------------------------------------------
-- A text value: a JSON string, trimmed, p_min..p_max characters, no HTML and no control characters. p_min = 0 means
-- optional (missing, null or blank -> null).
create function public.academy_author_text(p jsonb, p_what text, p_min int, p_max int) returns text
language plpgsql immutable set search_path = pg_catalog, public, pg_temp as $$
declare v text;
begin
  if p is null or p = 'null'::jsonb then
    if p_min = 0 then return null; end if;
    raise exception 'academy: % is required', p_what using errcode = '22023';
  end if;
  if jsonb_typeof(p) <> 'string' then raise exception 'academy: % must be text', p_what using errcode = '22023'; end if;
  v := btrim(p #>> '{}', E' \t\r\n');
  if v = '' and p_min = 0 then return null; end if;
  if length(v) < greatest(p_min, 1) or length(v) > p_max then
    raise exception 'academy: % must be %–% characters', p_what, greatest(p_min, 1), p_max using errcode = '22023';
  end if;
  if v ~ '<[A-Za-z/!?]' then raise exception 'academy: % may not contain HTML', p_what using errcode = '22023'; end if;
  if v ~ '[\x01-\x08\x0B\x0C\x0E-\x1F\x7F]' then
    raise exception 'academy: % contains a control character', p_what using errcode = '22023';
  end if;
  return v;
end $$;

-- An https:// address (p_required false: missing or blank -> null).
create function public.academy_author_url(p jsonb, p_what text, p_required boolean) returns text
language plpgsql immutable set search_path = pg_catalog, public, pg_temp as $$
declare v text;
begin
  v := academy_author_text(p, p_what, case when p_required then 1 else 0 end, 1000);
  if v is not null and v !~ '^https://[A-Za-z0-9.-]+\.[A-Za-z]{2,}(:[0-9]{2,5})?(/[^[:space:]<>"]*)?$' then
    raise exception 'academy: % must be an https:// address', p_what using errcode = '22023';
  end if;
  return v;
end $$;

create function public.academy_author_uuid(p jsonb, p_what text) returns uuid
language plpgsql immutable set search_path = pg_catalog, public, pg_temp as $$
begin
  if p is null or jsonb_typeof(p) <> 'string' or (p #>> '{}') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    raise exception 'academy: % must be an id', p_what using errcode = '22023';
  end if;
  return (p #>> '{}')::uuid;
end $$;

-- A model code as product_facts stores it (upper case).
create function public.academy_author_model(p jsonb) returns text
language plpgsql immutable set search_path = pg_catalog, public, pg_temp as $$
declare v text;
begin
  v := upper(academy_author_text(p, 'the model code', 1, 40));
  if v !~ '^[A-Z0-9][A-Z0-9._/-]*$' then raise exception 'academy: % is not a model code', v using errcode = '22023'; end if;
  return v;
end $$;

-- Alt text for a meaningful image (decision C): describes what the picture shows — 10–300 characters, not a file name.
-- A decorative image is stored with alt text '' (screen readers skip it); that choice is made on the media record only.
create function public.academy_author_alt(p jsonb, p_what text) returns text
language plpgsql immutable set search_path = pg_catalog, public, pg_temp as $$
declare v text;
begin
  v := academy_author_text(p, p_what, 10, 300);
  if v ~* '\.(jpe?g|png|webp|gif|svg|pdf)$' or v ~* '^(img|dsc|image|photo|picture)[ _-]?[0-9]*$' then
    raise exception 'academy: % must describe what the picture shows, not name the file', p_what using errcode = '22023';
  end if;
  return v;
end $$;

-- A media record a block points to: it must exist and be of an allowed kind. Locked (shared) so that it cannot be
-- changed or deleted while this transaction uses it.
create function public.academy_author_media_ref(p jsonb, p_kinds text[]) returns uuid
language plpgsql set search_path = pg_catalog, public, pg_temp as $$
declare v_id uuid; v_kind text;
begin
  v_id := academy_author_uuid(p, 'media_id');
  select kind into v_kind from academy_media where id = v_id for share;
  if not found then raise exception 'academy: media % not found', v_id using errcode = '22023'; end if;
  if exists (select 1 from academy_external_certs where upload_media_id = v_id) then   -- a learner's own evidence, never lesson content
    raise exception 'academy: media % belongs to a credential and cannot be shown in a lesson', v_id using errcode = '22023';
  end if;
  if not (v_kind = any (p_kinds)) then
    raise exception 'academy: media % is a %; this block needs %', v_id, v_kind, array_to_string(p_kinds, ' or ') using errcode = '22023';
  end if;
  return v_id;
end $$;

-- A complete question, checked and normalized (choices, answer key, tags). Returns the row's values as JSON.
create function public.academy_author_check_question(p_version_id uuid, q jsonb, p_self uuid) returns jsonb
language plpgsql set search_path = pg_catalog, public, pg_temp as $$
declare
  v_kind text; v_use text; v_prompt text; v_expl text; v_mod uuid; v_choices jsonb := '[]'; v_ids text[] := '{}';
  v_key jsonb; v_keys text[]; v_tags text[] := '{}'; c jsonb; t jsonb; v_id text; v_norm text;
begin
  v_kind := q->>'kind';
  if v_kind is null or v_kind not in ('single','multi','scenario') then
    raise exception 'academy: the question kind must be single, multi or scenario' using errcode = '22023';
  end if;
  v_use := coalesce(q->>'use', 'exam');
  if v_use not in ('exam','practice') then raise exception 'academy: a question is for the exam or for practice' using errcode = '22023'; end if;
  v_prompt := academy_author_text(q->'prompt', 'the question', 1, 2000);
  v_expl := academy_author_text(q->'explanation', 'the explanation', 1, 2000);
  if q->'module_id' is not null and q->'module_id' <> 'null'::jsonb then
    v_mod := academy_author_uuid(q->'module_id', 'module_id');
    if not exists (select 1 from academy_modules where id = v_mod and version_id = p_version_id) then
      raise exception 'academy: that module is not part of this course version' using errcode = '22023';
    end if;
  end if;
  if q->'choices' is null or jsonb_typeof(q->'choices') <> 'array' or jsonb_array_length(q->'choices') not between 2 and 6 then
    raise exception 'academy: a question has 2–6 choices' using errcode = '22023';
  end if;
  for c in select e from jsonb_array_elements(q->'choices') e loop
    perform academy_content_keys(c, array['id','text']);
    v_id := c->>'id';
    if v_id is null or v_id !~ '^[a-f]$' or v_id = any (v_ids) then
      raise exception 'academy: choice ids are a–f, each used once' using errcode = '22023';
    end if;
    v_ids := v_ids || v_id;
    v_choices := v_choices || jsonb_build_array(jsonb_build_object('id', v_id, 'text', academy_author_text(c->'text', 'a choice', 1, 500)));
  end loop;
  v_key := q->'answer_key';
  if v_kind in ('single','scenario') then
    if v_key is null or jsonb_typeof(v_key) <> 'string' or not ((v_key #>> '{}') = any (v_ids)) then
      raise exception 'academy: the answer is one of the choice ids' using errcode = '22023';
    end if;
  else
    if v_key is null or jsonb_typeof(v_key) <> 'array' or jsonb_array_length(v_key) < 1
       or exists (select 1 from jsonb_array_elements(v_key) e where jsonb_typeof(e) <> 'string' or not ((e #>> '{}') = any (v_ids))) then
      raise exception 'academy: the answer is a list of choice ids' using errcode = '22023';
    end if;
    v_keys := array(select distinct e from jsonb_array_elements_text(v_key) e order by e);
    if cardinality(v_keys) <> jsonb_array_length(v_key) then raise exception 'academy: the answer repeats a choice' using errcode = '22023'; end if;
    v_key := to_jsonb(v_keys);
  end if;
  if q->'objective_tags' is null or jsonb_typeof(q->'objective_tags') <> 'array' or jsonb_array_length(q->'objective_tags') not between 1 and 10 then
    raise exception 'academy: a question has 1–10 topic tags' using errcode = '22023';
  end if;
  for t in select e from jsonb_array_elements(q->'objective_tags') e loop
    if jsonb_typeof(t) <> 'string' or (t #>> '{}') !~ '^[a-z0-9][a-z0-9._-]{0,59}$' or (t #>> '{}') = any (v_tags) then
      raise exception 'academy: topic tags are lowercase words (letters, numbers, . _ -), each used once' using errcode = '22023';
    end if;
    v_tags := v_tags || (t #>> '{}');
  end loop;
  -- An exam question is never also a practice question: practice feedback would give its answer away.
  v_norm := lower(regexp_replace(v_prompt, '[[:space:]]+', ' ', 'g'));
  if exists (select 1 from academy_questions o where o.version_id = p_version_id and o.id is distinct from p_self
               and o.use <> v_use and lower(regexp_replace(o.prompt, '[[:space:]]+', ' ', 'g')) = v_norm) then
    raise exception 'academy: the same question is already in the % bank; exam and practice questions must differ',
      case v_use when 'exam' then 'practice' else 'exam' end using errcode = '22023';
  end if;
  return jsonb_build_object('module_id', v_mod, 'kind', v_kind, 'use', v_use, 'prompt', v_prompt, 'choices', v_choices,
                            'answer_key', v_key, 'explanation', v_expl, 'objective_tags', to_jsonb(v_tags));
end $$;

-- A lesson's blocks (decision A: 14 kinds), checked and normalized. Unknown kinds or keys, HTML, control characters,
-- oversize content, outside hosts, missing alt text, media of the wrong kind, product facts not linked to the lesson,
-- and knowledge checks that point at anything but this version's active practice questions are refused.
create function public.academy_author_check_blocks(p_lesson_id uuid, p_version_id uuid, p_blocks jsonb) returns jsonb
language plpgsql set search_path = pg_catalog, public, pg_temp as $$
declare
  b jsonb; i bigint; v_kind text; v_out jsonb := '[]'; v_b jsonb; v_items jsonb; e jsonb; v_list jsonb; v_n int;
  v_mfr text; v_model text; v_field text; v_qids uuid[]; v_ids text[]; v_best int; v_media uuid; v_style text; f jsonb;
  m jsonb; v_date date; v_has_media boolean; v_has_ph boolean;
  KINDS constant text[] := array['objectives','text','callout','quote','image','video','document','fact','comparison',
                                 'explorer','steps','scenario','check','takeaways'];
begin
  if p_blocks is null or jsonb_typeof(p_blocks) <> 'array' then raise exception 'academy: blocks must be a list' using errcode = '22023'; end if;
  if jsonb_array_length(p_blocks) > 40 then raise exception 'academy: a lesson has at most 40 blocks' using errcode = '22023'; end if;
  if octet_length(p_blocks::text) > 65536 then raise exception 'academy: the lesson is too large (64 KB at most)' using errcode = '22023'; end if;
  for b, i in select x, n from jsonb_array_elements(p_blocks) with ordinality t(x, n) loop
    if jsonb_typeof(b) <> 'object' then raise exception 'academy: block % is not a block', i using errcode = '22023'; end if;
    v_kind := b->>'kind';
    if v_kind is null or not (v_kind = any (KINDS)) then
      raise exception 'academy: block % has an unknown kind', i using errcode = '22023';
    end if;
    v_has_media := b ? 'media_id' and b->'media_id' <> 'null'::jsonb;
    v_has_ph := b ? 'placeholder' and b->'placeholder' <> 'null'::jsonb;
    case v_kind
    when 'objectives' then
      perform academy_content_keys(b, array['kind','items']);
      if i <> 1 then raise exception 'academy: the objectives come first in a lesson' using errcode = '22023'; end if;
      if jsonb_typeof(b->'items') is distinct from 'array' or jsonb_array_length(b->'items') not between 2 and 4 then
        raise exception 'academy: objectives are 2–4 statements' using errcode = '22023';
      end if;
      v_items := '[]';
      for e in select x from jsonb_array_elements(b->'items') x loop v_items := v_items || to_jsonb(academy_author_text(e, 'an objective', 1, 200)); end loop;
      v_b := jsonb_build_object('kind', v_kind, 'items', v_items);
    when 'text' then
      perform academy_content_keys(b, array['kind','heading','body']);
      v_b := jsonb_build_object('kind', v_kind, 'heading', academy_author_text(b->'heading', 'a heading', 0, 120),
                                'body', academy_author_text(b->'body', 'the text', 1, 4000));
    when 'callout' then
      perform academy_content_keys(b, array['kind','tone','body']);
      if b->>'tone' is null or b->>'tone' not in ('tip','caution','ask_manufacturer') then
        raise exception 'academy: a callout is a tip, a caution or ask_manufacturer' using errcode = '22023';
      end if;
      v_b := jsonb_build_object('kind', v_kind, 'tone', b->>'tone', 'body', academy_author_text(b->'body', 'the callout', 1, 600));
    when 'quote' then
      perform academy_content_keys(b, array['kind','text','manufacturer_slug','source_label','source_url','source_date']);
      v_mfr := b->>'manufacturer_slug';
      if v_mfr is null or not exists (select 1 from manufacturers where slug = v_mfr) then
        raise exception 'academy: a manufacturer quote names a manufacturer in the HCPS list' using errcode = '22023';
      end if;
      if coalesce(b->>'source_date', '') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
        raise exception 'academy: a manufacturer quote needs its source date (YYYY-MM-DD)' using errcode = '22023';
      end if;
      begin v_date := (b->>'source_date')::date;
      exception when others then raise exception 'academy: the source date is not a date' using errcode = '22023'; end;
      if v_date > current_date then raise exception 'academy: the source date is in the future' using errcode = '22023'; end if;
      v_b := jsonb_build_object('kind', v_kind, 'text', academy_author_text(b->'text', 'the quote', 1, 1000), 'manufacturer_slug', v_mfr,
                                'source_label', academy_author_text(b->'source_label', 'the source', 1, 200),
                                'source_url', academy_author_url(b->'source_url', 'the source link', false), 'source_date', v_date);
    when 'image', 'video', 'document' then
      perform academy_content_keys(b, case v_kind when 'image' then array['kind','media_id','placeholder','alt','caption']
                                                  when 'video' then array['kind','media_id','placeholder','caption']
                                                  else array['kind','media_id','placeholder','title'] end);
      if v_has_media = v_has_ph then
        raise exception 'academy: block % needs either a media record or a labelled placeholder', i using errcode = '22023';
      end if;
      v_b := jsonb_build_object('kind', v_kind);
      if v_has_media then
        if b ? 'alt' then raise exception 'academy: alt text belongs to the media record' using errcode = '22023'; end if;
        v_b := v_b || jsonb_build_object('media_id', academy_author_media_ref(b->'media_id',
                 case v_kind when 'image' then array['image'] when 'video' then array['video'] else array['pdf','link'] end));
      else
        v_b := v_b || jsonb_build_object('placeholder', academy_author_text(b->'placeholder', 'the placeholder label', 1, 200));
        if v_kind = 'image' then v_b := v_b || jsonb_build_object('alt', academy_author_alt(b->'alt', 'the alt text')); end if;
      end if;
      if v_kind in ('image','video') then
        v_b := v_b || jsonb_build_object('caption', academy_author_text(b->'caption', 'the caption', 0, 300));
      else
        v_b := v_b || jsonb_build_object('title', academy_author_text(b->'title', 'the document title', 1, 200));
      end if;
    when 'fact' then
      perform academy_content_keys(b, array['kind','manufacturer_slug','model_code','field','label']);
      v_mfr := b->>'manufacturer_slug'; v_model := academy_author_model(b->'model_code'); v_field := b->>'field';
      if v_field is null or v_field !~ '^[a-z0-9_.]{1,60}$' then raise exception 'academy: a fact names its field' using errcode = '22023'; end if;
      if not exists (select 1 from academy_content_refs where lesson_id = p_lesson_id and manufacturer_slug = v_mfr
                       and upper(model_code) = v_model and field = v_field) then
        raise exception 'academy: link the fact % % % to this lesson first', v_mfr, v_model, v_field using errcode = '22023';
      end if;
      v_b := jsonb_build_object('kind', v_kind, 'manufacturer_slug', v_mfr, 'model_code', v_model, 'field', v_field,
                                'label', academy_author_text(b->'label', 'the label', 0, 120));
    when 'comparison' then
      perform academy_content_keys(b, array['kind','title','manufacturer_slug','models','fields']);
      v_mfr := b->>'manufacturer_slug';
      if jsonb_typeof(b->'models') is distinct from 'array' or jsonb_array_length(b->'models') not between 2 and 6 then
        raise exception 'academy: a comparison has 2–6 models' using errcode = '22023';
      end if;
      if jsonb_typeof(b->'fields') is distinct from 'array' or jsonb_array_length(b->'fields') not between 1 and 12 then
        raise exception 'academy: a comparison has 1–12 features' using errcode = '22023';
      end if;
      v_ids := '{}'; v_items := '[]';
      for e in select x from jsonb_array_elements(b->'models') x loop
        v_model := academy_author_model(e);
        if v_model = any (v_ids) then raise exception 'academy: % appears twice in the comparison', v_model using errcode = '22023'; end if;
        v_ids := v_ids || v_model; v_items := v_items || to_jsonb(v_model);
      end loop;
      v_list := '[]';
      for f in select x from jsonb_array_elements(b->'fields') x loop
        perform academy_content_keys(f, array['field','label']);
        v_field := f->>'field';
        if v_field is null or v_field !~ '^[a-z0-9_.]{1,60}$' then raise exception 'academy: a comparison row names its field' using errcode = '22023'; end if;
        foreach v_model in array v_ids loop   -- every cell is a linked product fact
          if not exists (select 1 from academy_content_refs where lesson_id = p_lesson_id and manufacturer_slug = v_mfr
                           and upper(model_code) = v_model and field = v_field) then
            raise exception 'academy: link the fact % % % to this lesson first', v_mfr, v_model, v_field using errcode = '22023';
          end if;
        end loop;
        v_list := v_list || jsonb_build_array(jsonb_build_object('field', v_field, 'label', academy_author_text(f->'label', 'a feature label', 1, 80)));
      end loop;
      v_b := jsonb_build_object('kind', v_kind, 'title', academy_author_text(b->'title', 'the title', 0, 120), 'manufacturer_slug', v_mfr,
                                'models', v_items, 'fields', v_list);
    when 'explorer' then
      perform academy_content_keys(b, array['kind','style','title','media_id','items']);
      v_style := b->>'style';
      if v_style is null or v_style not in ('tabs','hotspots','cards') then
        raise exception 'academy: an explorer is tabs, hotspots or cards' using errcode = '22023';
      end if;
      if v_style = 'hotspots' and not v_has_media then raise exception 'academy: a hotspot explorer needs its picture' using errcode = '22023'; end if;
      if jsonb_typeof(b->'items') is distinct from 'array' or jsonb_array_length(b->'items') not between 2 and 12 then
        raise exception 'academy: an explorer has 2–12 items' using errcode = '22023';
      end if;
      v_items := '[]';
      for e in select x from jsonb_array_elements(b->'items') x loop
        perform academy_content_keys(e, case when v_style = 'hotspots' then array['title','body','media_id','x','y'] else array['title','body','media_id'] end);
        m := jsonb_build_object('title', academy_author_text(e->'title', 'an item title', 1, 80), 'body', academy_author_text(e->'body', 'an item text', 1, 600));
        if e ? 'media_id' and e->'media_id' <> 'null'::jsonb then m := m || jsonb_build_object('media_id', academy_author_media_ref(e->'media_id', array['image'])); end if;
        if v_style = 'hotspots' then
          if jsonb_typeof(e->'x') is distinct from 'number' or jsonb_typeof(e->'y') is distinct from 'number'
             or (e->>'x')::numeric not between 0 and 100 or (e->>'y')::numeric not between 0 and 100 then
            raise exception 'academy: a hotspot has x and y between 0 and 100' using errcode = '22023';
          end if;
          m := m || jsonb_build_object('x', (e->>'x')::numeric, 'y', (e->>'y')::numeric);
        end if;
        v_items := v_items || jsonb_build_array(m);
      end loop;
      v_b := jsonb_build_object('kind', v_kind, 'style', v_style, 'title', academy_author_text(b->'title', 'the title', 0, 120), 'items', v_items);
      if v_has_media then v_b := v_b || jsonb_build_object('media_id', academy_author_media_ref(b->'media_id', array['image'])); end if;
    when 'steps' then
      perform academy_content_keys(b, array['kind','title','items','source_label','media_id']);
      if jsonb_typeof(b->'items') is distinct from 'array' or jsonb_array_length(b->'items') not between 2 and 20 then
        raise exception 'academy: a procedure has 2–20 steps' using errcode = '22023';
      end if;
      v_items := '[]';
      for e in select x from jsonb_array_elements(b->'items') x loop v_items := v_items || to_jsonb(academy_author_text(e, 'a step', 1, 400)); end loop;
      v_b := jsonb_build_object('kind', v_kind, 'title', academy_author_text(b->'title', 'the title', 0, 120), 'items', v_items,
                                'source_label', academy_author_text(b->'source_label', 'the source document', 1, 200));
      if v_has_media then v_b := v_b || jsonb_build_object('media_id', academy_author_media_ref(b->'media_id', array['pdf','link'])); end if;
    when 'scenario' then
      perform academy_content_keys(b, array['kind','prompt','choices']);
      if jsonb_typeof(b->'choices') is distinct from 'array' or jsonb_array_length(b->'choices') not between 3 and 4 then
        raise exception 'academy: a scenario has 3–4 choices' using errcode = '22023';
      end if;
      v_items := '[]'; v_ids := '{}'; v_best := 0;
      for e in select x from jsonb_array_elements(b->'choices') x loop
        perform academy_content_keys(e, array['id','text','feedback','best']);
        if e->>'id' is null or e->>'id' !~ '^[a-d]$' or e->>'id' = any (v_ids) then
          raise exception 'academy: scenario choice ids are a–d, each used once' using errcode = '22023';
        end if;
        if e ? 'best' and jsonb_typeof(e->'best') <> 'boolean' then raise exception 'academy: best is true or false' using errcode = '22023'; end if;
        v_ids := v_ids || (e->>'id');
        if coalesce((e->>'best')::boolean, false) then v_best := v_best + 1; end if;
        v_items := v_items || jsonb_build_array(jsonb_build_object('id', e->>'id', 'text', academy_author_text(e->'text', 'a choice', 1, 300),
                   'feedback', academy_author_text(e->'feedback', 'the feedback', 1, 500), 'best', coalesce((e->>'best')::boolean, false)));
      end loop;
      if v_best < 1 then raise exception 'academy: a scenario marks at least one best choice' using errcode = '22023'; end if;
      v_b := jsonb_build_object('kind', v_kind, 'prompt', academy_author_text(b->'prompt', 'the situation', 1, 1000), 'choices', v_items);
    when 'check' then
      perform academy_content_keys(b, array['kind','question_ids']);
      if jsonb_typeof(b->'question_ids') is distinct from 'array' or jsonb_array_length(b->'question_ids') not between 2 and 5 then
        raise exception 'academy: a knowledge check has 2–5 practice questions' using errcode = '22023';
      end if;
      v_qids := '{}';
      for e in select x from jsonb_array_elements(b->'question_ids') x loop v_qids := v_qids || academy_author_uuid(e, 'a question id'); end loop;
      if cardinality(v_qids) <> (select count(distinct x) from unnest(v_qids) x) then
        raise exception 'academy: a knowledge check repeats a question' using errcode = '22023';
      end if;
      select count(*) into v_n from academy_questions where id = any (v_qids) and version_id = p_version_id
         and use = 'practice' and status = 'active';
      if v_n <> cardinality(v_qids) then   -- never an exam question: its answer would be shown in the lesson
        raise exception 'academy: a knowledge check uses only active practice questions of this course version' using errcode = '22023';
      end if;
      perform 1 from academy_questions where id = any (v_qids) for share;
      v_b := jsonb_build_object('kind', v_kind, 'question_ids', to_jsonb(v_qids));
    when 'takeaways' then
      perform academy_content_keys(b, array['kind','items']);
      if jsonb_typeof(b->'items') is distinct from 'array' or jsonb_array_length(b->'items') not between 3 and 5 then
        raise exception 'academy: takeaways are 3–5 points' using errcode = '22023';
      end if;
      v_items := '[]';
      for e in select x from jsonb_array_elements(b->'items') x loop v_items := v_items || to_jsonb(academy_author_text(e, 'a takeaway', 1, 300)); end loop;
      v_b := jsonb_build_object('kind', v_kind, 'items', v_items);
    end case;
    v_out := v_out || jsonb_build_array(jsonb_strip_nulls(v_b));
  end loop;
  return v_out;
exception when invalid_text_representation or numeric_value_out_of_range then
  raise exception 'academy: a block holds a value of the wrong type' using errcode = '22023';
end $$;

-- The exam draw (decision B). Eligible = active exam questions of the version whose pinned product facts are still
-- current and verified. Distribution set (any module has exam_quota): every module needs one, they add up to the
-- version's exam_questions, each module gives exactly its number, and no eligible question may sit outside a module.
-- Automatic (no quota anywhere): every module needs an eligible question; one from each, the rest at random.
-- p_strict false: any shortage returns an empty list instead (the M1 checks then give their usual message).
create function public.academy_author_exam_draw(p_version_id uuid, p_strict boolean) returns uuid[]
language plpgsql volatile set search_path = pg_catalog, public, pg_temp as $$
declare v_ver academy_course_versions; v_elig uuid[]; v_ids uuid[] := '{}'; v_pick uuid[]; r record; v_sum int; v_mods int;
begin
  begin
    select * into v_ver from academy_course_versions where id = p_version_id;
    if not found then raise exception 'academy: course version not found' using errcode = '22023'; end if;
    v_elig := array(
      select q.id from academy_questions q
       where q.version_id = p_version_id and q.use = 'exam' and q.status = 'active'
         and not exists (select 1 from academy_content_refs cr left join product_facts f on f.id = cr.pinned_fact_id
                          where cr.question_id = q.id and cr.field is not null
                            and (f.id is null or f.valid_to is not null or f.status <> 'verified')));
    if exists (select 1 from academy_modules where version_id = p_version_id and exam_quota is not null) then
      if exists (select 1 from academy_modules where version_id = p_version_id and exam_quota is null) then
        raise exception 'academy: the exam distribution is incomplete: module "%" has no number of questions',
          (select title from academy_modules where version_id = p_version_id and exam_quota is null order by position limit 1)
          using errcode = '22023';
      end if;
      select sum(exam_quota) into v_sum from academy_modules where version_id = p_version_id;
      if v_sum <> v_ver.exam_questions then
        raise exception 'academy: the exam distribution adds up to % questions; this version draws %', v_sum, v_ver.exam_questions
          using errcode = '22023';
      end if;
      if exists (select 1 from academy_questions where id = any (v_elig) and module_id is null) then
        raise exception 'academy: every exam question needs its module when an exam distribution is set' using errcode = '22023';
      end if;
      for r in select id, title, exam_quota from academy_modules where version_id = p_version_id order by position loop
        v_pick := array(select q.id from academy_questions q where q.id = any (v_elig) and q.module_id = r.id
                         order by random() limit r.exam_quota);
        if cardinality(v_pick) < r.exam_quota then
          raise exception 'academy: module "%" has % usable exam question(s); the exam draws % from it', r.title, cardinality(v_pick), r.exam_quota
            using errcode = '22023';
        end if;
        v_ids := v_ids || v_pick;
      end loop;
    else
      if exists (select 1 from academy_modules m where m.version_id = p_version_id
                   and not exists (select 1 from academy_questions q where q.id = any (v_elig) and q.module_id = m.id)) then
        raise exception 'academy: module "%" has no usable exam question; every module is represented in the exam',
          (select m.title from academy_modules m where m.version_id = p_version_id
             and not exists (select 1 from academy_questions q where q.id = any (v_elig) and q.module_id = m.id) order by m.position limit 1)
          using errcode = '22023';
      end if;
      select count(distinct module_id) into v_mods from academy_questions where id = any (v_elig) and module_id is not null;
      if v_mods > v_ver.exam_questions then
        raise exception 'academy: % modules have exam questions but the exam draws only %; set an exam distribution', v_mods, v_ver.exam_questions
          using errcode = '22023';
      end if;
      v_ids := array(select (array_agg(q.id order by random()))[1] from academy_questions q
                      where q.id = any (v_elig) and q.module_id is not null group by q.module_id);
      v_ids := v_ids || array(select x from unnest(v_elig) x where not (x = any (v_ids))
                              order by random() limit v_ver.exam_questions - cardinality(v_ids));
      if cardinality(v_ids) < v_ver.exam_questions then
        raise exception 'academy: % usable exam question(s); the exam draws %', cardinality(v_ids), v_ver.exam_questions using errcode = '22023';
      end if;
    end if;
  exception when sqlstate '22023' then
    if p_strict then raise; end if;
    return '{}';
  end;
  return array(select x from unnest(v_ids) x order by random());   -- modules are not presented in blocks
end $$;

-- ---------------------------------------------------------------------------------------------
-- THE M1 CHANGE (decision B): start-attempt draws through academy_author_exam_draw. Only the draw line differs from M1.
-- ---------------------------------------------------------------------------------------------
create or replace function public.academy_op_start_attempt(p_actor text, p_enrollment_id uuid)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare v_enr academy_enrollments; v_ver academy_course_versions; v_ids uuid[]; v_id uuid;
begin
  select * into v_enr from academy_enrollments where id = p_enrollment_id for update;
  if not found then raise exception 'academy: enrollment not found' using errcode = 'P0002'; end if;
  perform academy_op_actor_learner(p_actor, v_enr.learner_id);
  perform academy_op_begin('start_attempt', p_actor);
  if exists (select 1 from academy_attempts where enrollment_id = p_enrollment_id and submitted_at is null) then
    raise exception 'academy: an exam attempt is already open for this course' using errcode = '22023';
  end if;
  select * into v_ver from academy_course_versions where id = v_enr.version_id;
  v_ids := academy_author_exam_draw(v_ver.id, v_ver.status = 'published' and v_enr.status <> 'withdrawn');   -- A2D M3: per-module draw
  perform academy_op_attempt_check(p_enrollment_id, v_ids, 'start');      -- withdrawn, published, count, duplicates
  insert into academy_attempts (enrollment_id, question_ids) values (p_enrollment_id, v_ids) returning id into v_id;
  perform academy_op_audit('learner', p_actor, 'academy_attempts', v_id::text, 'start_attempt', null,
    jsonb_build_object('enrollment_id', p_enrollment_id, 'questions', cardinality(v_ids)));
  perform academy_op_end();
  return jsonb_build_object('id', v_id, 'question_ids', to_jsonb(v_ids));
end $$;

-- ---------------------------------------------------------------------------------------------
-- GUARDS
-- ---------------------------------------------------------------------------------------------
create function public.academy_author_guard() returns trigger
language plpgsql set search_path = pg_catalog, public, pg_temp as $$
begin
  if coalesce(current_setting('academy.op', true), '') <> ''
     and current_user = (select pg_get_userbyid(p.proowner) from pg_proc p
                          where p.oid = 'public.academy_author_guard()'::regprocedure) then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  raise exception 'academy: % changes must go through the Academy Command Center (audited operations)', tg_table_name
    using errcode = '42501';
end $$;

create trigger academy_author_guard before insert or update or delete on public.academy_questions
  for each row execute function public.academy_author_guard();
create trigger academy_author_guard before insert or update or delete on public.academy_media
  for each row execute function public.academy_author_guard();
create trigger academy_author_guard before insert or update or delete on public.academy_content_refs
  for each row execute function public.academy_author_guard();
create trigger academy_author_guard_truncate before truncate on public.academy_questions
  for each statement execute function public.academy_author_guard();
create trigger academy_author_guard_truncate before truncate on public.academy_media
  for each statement execute function public.academy_author_guard();
create trigger academy_author_guard_truncate before truncate on public.academy_content_refs
  for each statement execute function public.academy_author_guard();

-- Publishing (M1 academy_op_publish_version, unchanged) passes through this check: the exam must be drawable under its
-- distribution and every lesson's blocks must still pass. Re-checking the blocks also locks (shared) every media record
-- they use until the publish commits, so a media edit or delete running at the same time waits and then refuses.
create function public.academy_author_publish_check() returns trigger
language plpgsql set search_path = pg_catalog, public, pg_temp as $$
declare r record;
begin
  for r in select l.id, l.blocks from academy_lessons l join academy_modules m on m.id = l.module_id where m.version_id = new.id loop
    perform academy_author_check_blocks(r.id, new.id, r.blocks);
  end loop;
  perform academy_author_exam_draw(new.id, true);
  return new;
end $$;

create trigger academy_author_publish_check before update of status on public.academy_course_versions
  for each row when (new.status = 'published' and old.status is distinct from 'published')
  execute function public.academy_author_publish_check();

-- ---------------------------------------------------------------------------------------------
-- LESSON BLOCKS AND ORDER (draft versions only)
-- ---------------------------------------------------------------------------------------------
create function public.academy_author_op_set_blocks(p_actor text, p_lesson_id uuid, p_blocks jsonb)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare v_old academy_lessons; v_ver uuid; v_blocks jsonb; v_new jsonb;
begin
  perform academy_op_actor_staff(p_actor);
  perform academy_op_begin('set_blocks', p_actor);
  select m.version_id into v_ver from academy_lessons l join academy_modules m on m.id = l.module_id where l.id = p_lesson_id;
  if v_ver is null then raise exception 'academy: lesson not found' using errcode = 'P0002'; end if;
  perform academy_content_lock_draft(v_ver);
  select * into v_old from academy_lessons where id = p_lesson_id for update;      -- read again under the version lock
  if not found then raise exception 'academy: lesson not found' using errcode = 'P0002'; end if;
  v_blocks := academy_author_check_blocks(p_lesson_id, v_ver, p_blocks);
  update academy_lessons set blocks = v_blocks where id = p_lesson_id returning to_jsonb(academy_lessons.*) into strict v_new;
  perform academy_op_audit('staff', p_actor, 'academy_lessons', p_lesson_id::text, 'set_blocks', to_jsonb(v_old), v_new);
  perform academy_op_end();
  return v_new;
end $$;

create function public.academy_author_op_reorder_modules(p_actor text, p_version_id uuid, p_order uuid[])
returns jsonb language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare v_before jsonb; v_after jsonb; v_n int;
begin
  perform academy_op_actor_staff(p_actor);
  perform academy_op_begin('reorder_modules', p_actor);
  perform academy_content_lock_draft(p_version_id);
  perform 1 from academy_modules where version_id = p_version_id for update;
  if p_order is null or cardinality(p_order) <> (select count(distinct x) from unnest(p_order) x)
     or (select array_agg(id order by id) from academy_modules where version_id = p_version_id)
        is distinct from (select array_agg(x order by x) from unnest(p_order) x) then
    raise exception 'academy: the new order must list every module of this version exactly once' using errcode = '22023';
  end if;
  select jsonb_agg(jsonb_build_object('id', id, 'position', position) order by position) into v_before from academy_modules where version_id = p_version_id;
  update academy_modules set position = position + 100000 where version_id = p_version_id;   -- clears the unique positions first
  update academy_modules m set position = o.n from unnest(p_order) with ordinality o(id, n) where m.id = o.id and m.version_id = p_version_id;
  get diagnostics v_n = row_count;
  if v_n <> cardinality(p_order) then raise exception 'academy: the order changed while saving' using errcode = '55000'; end if;
  select jsonb_agg(jsonb_build_object('id', id, 'position', position) order by position) into v_after from academy_modules where version_id = p_version_id;
  perform academy_op_audit('staff', p_actor, 'academy_course_versions', p_version_id::text, 'reorder_modules', v_before, v_after);
  perform academy_op_end();
  return v_after;
end $$;

create function public.academy_author_op_reorder_lessons(p_actor text, p_module_id uuid, p_order uuid[])
returns jsonb language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare v_ver uuid; v_before jsonb; v_after jsonb; v_n int;
begin
  perform academy_op_actor_staff(p_actor);
  perform academy_op_begin('reorder_lessons', p_actor);
  select version_id into v_ver from academy_modules where id = p_module_id;
  if v_ver is null then raise exception 'academy: module not found' using errcode = 'P0002'; end if;
  perform academy_content_lock_draft(v_ver);
  perform 1 from academy_modules where id = p_module_id for update;
  if not found then raise exception 'academy: module not found' using errcode = 'P0002'; end if;
  perform 1 from academy_lessons where module_id = p_module_id for update;
  if p_order is null or cardinality(p_order) <> (select count(distinct x) from unnest(p_order) x)
     or (select array_agg(id order by id) from academy_lessons where module_id = p_module_id)
        is distinct from (select array_agg(x order by x) from unnest(p_order) x) then
    raise exception 'academy: the new order must list every lesson of this module exactly once' using errcode = '22023';
  end if;
  select jsonb_agg(jsonb_build_object('id', id, 'position', position) order by position) into v_before from academy_lessons where module_id = p_module_id;
  update academy_lessons set position = position + 100000 where module_id = p_module_id;
  update academy_lessons l set position = o.n from unnest(p_order) with ordinality o(id, n) where l.id = o.id and l.module_id = p_module_id;
  get diagnostics v_n = row_count;
  if v_n <> cardinality(p_order) then raise exception 'academy: the order changed while saving' using errcode = '55000'; end if;
  select jsonb_agg(jsonb_build_object('id', id, 'position', position) order by position) into v_after from academy_lessons where module_id = p_module_id;
  perform academy_op_audit('staff', p_actor, 'academy_modules', p_module_id::text, 'reorder_lessons', v_before, v_after);
  perform academy_op_end();
  return v_after;
end $$;

-- p_quotas: {"<module id>": n, ...} naming EVERY module of the version (each 1–200, adding up to exam_questions),
-- or {} / null to go back to the automatic draw.
create function public.academy_author_op_set_exam_distribution(p_actor text, p_version_id uuid, p_quotas jsonb)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare v_ver academy_course_versions; v_before jsonb; v_after jsonb; k text; v_sum int := 0; v_n int; v_count int; v_q jsonb := '{}';
begin
  perform academy_op_actor_staff(p_actor);
  perform academy_op_begin('set_exam_distribution', p_actor);
  v_ver := academy_content_lock_draft(p_version_id);
  perform 1 from academy_modules where version_id = p_version_id for update;
  select count(*) into v_count from academy_modules where version_id = p_version_id;
  if p_quotas is not null and p_quotas <> 'null'::jsonb and jsonb_typeof(p_quotas) <> 'object' then
    raise exception 'academy: the distribution is a list of modules and numbers' using errcode = '22023';
  end if;
  select coalesce(jsonb_object_agg(id::text, exam_quota), '{}') into v_before from academy_modules where version_id = p_version_id;
  if p_quotas is null or p_quotas = 'null'::jsonb or p_quotas = '{}'::jsonb then
    update academy_modules set exam_quota = null where version_id = p_version_id;
  else
    for k in select jsonb_object_keys(p_quotas) loop
      if k !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
         or not exists (select 1 from academy_modules where id = k::uuid and version_id = p_version_id) then
        raise exception 'academy: % is not a module of this version', k using errcode = '22023';
      end if;
      if jsonb_typeof(p_quotas->k) <> 'number' or (p_quotas->>k) !~ '^[0-9]{1,3}$' or (p_quotas->>k)::int not between 1 and 200 then
        raise exception 'academy: every module gives 1–200 questions' using errcode = '22023';
      end if;
      if v_q ? (k::uuid::text) then raise exception 'academy: module % is named twice', k using errcode = '22023'; end if;
      v_q := v_q || jsonb_build_object(k::uuid::text, (p_quotas->>k)::int);   -- ids compared in their standard (lower-case) form
      v_sum := v_sum + (p_quotas->>k)::int;
    end loop;
    if (select count(*) from jsonb_object_keys(v_q)) <> v_count then
      raise exception 'academy: the distribution must name every module of this version (every module is represented)' using errcode = '22023';
    end if;
    if v_sum <> v_ver.exam_questions then
      raise exception 'academy: the distribution adds up to % questions; this version draws %', v_sum, v_ver.exam_questions using errcode = '22023';
    end if;
    update academy_modules m set exam_quota = (v_q->>m.id::text)::int where m.version_id = p_version_id;
    get diagnostics v_n = row_count;
    if v_n <> v_count then raise exception 'academy: the modules changed while saving' using errcode = '55000'; end if;
  end if;
  select coalesce(jsonb_object_agg(id::text, exam_quota), '{}') into v_after from academy_modules where version_id = p_version_id;
  perform academy_op_audit('staff', p_actor, 'academy_course_versions', p_version_id::text, 'set_exam_distribution', v_before, v_after);
  perform academy_op_end();
  return v_after;
end $$;

-- ---------------------------------------------------------------------------------------------
-- QUESTION BANK (draft versions only; answer keys never written to the audit log)
-- ---------------------------------------------------------------------------------------------
create function public.academy_author_op_create_question(p_actor text, p_id uuid, p_version_id uuid, p_question jsonb)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare q jsonb; v_new jsonb;
begin
  perform academy_op_actor_staff(p_actor);
  perform academy_op_begin('create_question', p_actor);
  perform academy_content_keys(p_question, array['module_id','kind','use','prompt','choices','answer_key','explanation','objective_tags']);
  perform academy_content_lock_draft(p_version_id);
  q := academy_author_check_question(p_version_id, p_question, null);
  insert into academy_questions (id, version_id, module_id, kind, use, prompt, choices, answer_key, explanation, objective_tags, status)
  values (coalesce(p_id, gen_random_uuid()), p_version_id, (q->>'module_id')::uuid, q->>'kind', q->>'use', q->>'prompt', q->'choices',
          q->'answer_key', q->>'explanation', array(select jsonb_array_elements_text(q->'objective_tags')), 'active')
  returning to_jsonb(academy_questions.*) into v_new;
  perform academy_op_audit('staff', p_actor, 'academy_questions', v_new->>'id', 'create_question', null,
    (v_new - 'answer_key') || jsonb_build_object('answer_key_changed', true));
  perform academy_op_end();
  return v_new;                                     -- to the staff editor only
end $$;

create function public.academy_author_op_update_question(p_actor text, p_id uuid, p_changes jsonb)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare v_old academy_questions; v_ver uuid; q jsonb; v_new jsonb;
begin
  perform academy_op_actor_staff(p_actor);
  perform academy_op_begin('update_question', p_actor);
  perform academy_content_keys(p_changes, array['module_id','kind','use','prompt','choices','answer_key','explanation','objective_tags']);
  if p_changes = '{}'::jsonb then raise exception 'academy: nothing to change' using errcode = '22023'; end if;
  select version_id into v_ver from academy_questions where id = p_id;
  if v_ver is null then raise exception 'academy: question not found' using errcode = 'P0002'; end if;
  perform academy_content_lock_draft(v_ver);
  select * into v_old from academy_questions where id = p_id for update;
  if not found then raise exception 'academy: question not found' using errcode = 'P0002'; end if;
  q := academy_author_check_question(v_ver, (to_jsonb(v_old) - 'id' - 'version_id' - 'status') || p_changes, p_id);
  if (q->>'use') <> v_old.use and exists (select 1 from academy_lessons l join academy_modules m on m.id = l.module_id
       where m.version_id = v_ver and jsonb_path_exists(l.blocks, '$[*] ? (@.kind == "check").question_ids[*] ? (@ == $id)',
                                                        jsonb_build_object('id', p_id::text))) then
    raise exception 'academy: this question is used in a lesson knowledge check; remove it there first' using errcode = '55000';
  end if;
  update academy_questions
     set module_id = (q->>'module_id')::uuid, kind = q->>'kind', use = q->>'use', prompt = q->>'prompt', choices = q->'choices',
         answer_key = q->'answer_key', explanation = q->>'explanation',
         objective_tags = array(select jsonb_array_elements_text(q->'objective_tags'))
   where id = p_id returning to_jsonb(academy_questions.*) into strict v_new;
  perform academy_op_audit('staff', p_actor, 'academy_questions', p_id::text, 'update_question', to_jsonb(v_old) - 'answer_key',
    (v_new - 'answer_key') || jsonb_build_object('answer_key_changed', v_new->'answer_key' is distinct from to_jsonb(v_old.answer_key)));
  perform academy_op_end();
  return v_new;
end $$;

create function public.academy_author_op_set_question_status(p_actor text, p_id uuid, p_status text, p_reason text)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare v_old academy_questions; v_ver uuid; v_new jsonb;
begin
  perform academy_op_actor_staff(p_actor);
  perform academy_op_begin('set_question_status', p_actor);
  if p_status is null or p_status not in ('active','retired') then raise exception 'academy: a question is active or retired' using errcode = '22023'; end if;
  if p_status = 'retired' and (p_reason is null or length(trim(p_reason)) = 0) then
    raise exception 'academy: retiring a question needs a reason' using errcode = '22023';
  end if;
  select version_id into v_ver from academy_questions where id = p_id;
  if v_ver is null then raise exception 'academy: question not found' using errcode = 'P0002'; end if;
  perform academy_content_lock_draft(v_ver);
  select * into v_old from academy_questions where id = p_id for update;
  if not found then raise exception 'academy: question not found' using errcode = 'P0002'; end if;
  if v_old.status = p_status then raise exception 'academy: the question is already %', p_status using errcode = '22023'; end if;
  if p_status = 'retired' and exists (select 1 from academy_lessons l join academy_modules m on m.id = l.module_id
       where m.version_id = v_ver and jsonb_path_exists(l.blocks, '$[*] ? (@.kind == "check").question_ids[*] ? (@ == $id)',
                                                        jsonb_build_object('id', p_id::text))) then
    raise exception 'academy: this question is used in a lesson knowledge check; remove it there first' using errcode = '55000';
  end if;
  update academy_questions set status = p_status where id = p_id returning to_jsonb(academy_questions.*) into strict v_new;
  perform academy_op_audit('staff', p_actor, 'academy_questions', p_id::text,
    case p_status when 'retired' then 'retire_question' else 'restore_question' end,
    to_jsonb(v_old) - 'answer_key', (v_new - 'answer_key') || jsonb_build_object('reason', p_reason));
  perform academy_op_end();
  return v_new;
end $$;

-- ---------------------------------------------------------------------------------------------
-- MEDIA (rights and alt text; a file in use by learners' content never changes)
-- ---------------------------------------------------------------------------------------------
-- Checks a whole media record and returns it normalized. Images live in the private bucket (path chosen by the server);
-- videos are YouTube (no-cookie) or Vimeo embeds; documents are a private file or an https link.
-- A stored image, and any stored manufacturer file (rights manufacturer_permitted), is recorded by the President only: it
-- stands for Angelo's approval of that specific file (no Golden photography without it). The database cannot tell a
-- manufacturer photo from an HCPS one, so every stored image needs the President.
create function public.academy_author_check_media(p_actor text, m jsonb) returns jsonb
language plpgsql set search_path = pg_catalog, public, pg_temp as $$
declare v_kind text; v_path text; v_url text; v_rights text; v_mfr text; v_perm text; v_alt text;
begin
  v_kind := m->>'kind';
  if v_kind is null or v_kind not in ('image','video','pdf','link') then raise exception 'academy: media is an image, video, pdf or link' using errcode = '22023'; end if;
  v_rights := m->>'rights';
  if v_rights is null or v_rights not in ('hcps_owned','manufacturer_permitted','link_only') then
    raise exception 'academy: rights are hcps_owned, manufacturer_permitted or link_only' using errcode = '22023';
  end if;
  v_path := academy_author_text(m->'storage_path', 'the file path', 0, 200);
  if v_path is not null and (v_path !~ '^media/[a-z0-9-]{1,60}/[a-z0-9][a-z0-9._-]{0,120}$' or v_path ~ '\.\.') then
    raise exception 'academy: the file path is chosen by the server (media/<folder>/<file>)' using errcode = '22023';
  end if;
  v_url := academy_author_url(m->'external_url', 'the link', false);
  v_mfr := nullif(trim(coalesce(m->>'manufacturer_slug', '')), '');
  if v_mfr is not null and not exists (select 1 from manufacturers where slug = v_mfr) then
    raise exception 'academy: that manufacturer is not in the HCPS manufacturer list' using errcode = '22023';
  end if;
  v_perm := academy_author_text(m->'permission_ref', 'the permission reference', 0, 300);
  if (v_path is null) = (v_url is null) then raise exception 'academy: media is either a stored file or a link' using errcode = '22023'; end if;
  case v_kind
  when 'image' then
    if v_path is null or v_path !~ '\.(jpe?g|png|webp)$' then raise exception 'academy: an image is a stored JPEG, PNG or WebP file' using errcode = '22023'; end if;
    if m->'alt_text' is null or m->'alt_text' = 'null'::jsonb then
      raise exception 'academy: an image needs alt text (or "" for a purely decorative image)' using errcode = '22023';
    end if;
    v_alt := case when m->>'alt_text' = '' then '' else academy_author_alt(m->'alt_text', 'the alt text') end;
  when 'video' then
    if v_url is null or v_url !~ '^https://(www\.youtube-nocookie\.com/embed/[A-Za-z0-9_-]{6,20}|player\.vimeo\.com/video/[0-9]{3,12})(\?[A-Za-z0-9=&_.-]*)?$' then
      raise exception 'academy: a video is a YouTube (youtube-nocookie.com/embed) or Vimeo (player.vimeo.com) link' using errcode = '22023';
    end if;
    v_alt := academy_author_text(m->'alt_text', 'the video title', 3, 300);
  when 'pdf' then
    if v_path is not null and v_path !~ '\.pdf$' then raise exception 'academy: a stored document is a PDF' using errcode = '22023'; end if;
    v_alt := academy_author_text(m->'alt_text', 'the document title', 0, 300);
  when 'link' then
    if v_url is null then raise exception 'academy: a link needs its https:// address' using errcode = '22023'; end if;
    v_alt := academy_author_text(m->'alt_text', 'the link title', 0, 300);
  end case;
  if v_rights = 'link_only' and v_path is not null then raise exception 'academy: link-only media is never stored by HCPS' using errcode = '22023'; end if;
  if v_rights = 'manufacturer_permitted' and (v_mfr is null or v_perm is null) then
    raise exception 'academy: manufacturer-permitted media names the manufacturer and the permission' using errcode = '22023';
  end if;
  if v_rights = 'hcps_owned' and v_mfr is not null then
    raise exception 'academy: HCPS-owned media names no manufacturer as rights holder' using errcode = '22023';
  end if;
  if v_rights = 'hcps_owned' and v_path is null then raise exception 'academy: HCPS-owned media is a stored file' using errcode = '22023'; end if;
  if v_path is not null and (v_rights = 'manufacturer_permitted' or v_kind = 'image') then
    begin perform academy_content_actor_president(p_actor);   -- every stored photo is approved by the President (no Golden photography without it)
    exception when insufficient_privilege then
      raise exception 'academy: only the President approves a stored photo or manufacturer file' using errcode = '42501';
    end;
  end if;
  return jsonb_build_object('kind', v_kind, 'storage_path', v_path, 'external_url', v_url, 'rights', v_rights,
                            'manufacturer_slug', v_mfr, 'permission_ref', v_perm, 'alt_text', v_alt);
end $$;

create function public.academy_author_op_create_media(p_actor text, p_id uuid, p_media jsonb)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare m jsonb; v_new jsonb;
begin
  perform academy_op_actor_staff(p_actor);
  perform academy_op_begin('create_media', p_actor);
  perform academy_content_keys(p_media, array['kind','storage_path','external_url','rights','manufacturer_slug','permission_ref','alt_text']);
  m := academy_author_check_media(p_actor, p_media);
  if m->>'storage_path' is not null then perform pg_advisory_xact_lock(hashtext('academy_media:' || (m->>'storage_path'))); end if;
  if m->>'storage_path' is not null and exists (select 1 from academy_media where storage_path = m->>'storage_path') then
    raise exception 'academy: a media record already uses that file' using errcode = '23505';
  end if;
  insert into academy_media (id, kind, storage_path, external_url, rights, manufacturer_slug, permission_ref, alt_text)
  values (coalesce(p_id, gen_random_uuid()), m->>'kind', m->>'storage_path', m->>'external_url', m->>'rights',
          m->>'manufacturer_slug', m->>'permission_ref', m->>'alt_text')
  returning to_jsonb(academy_media.*) into v_new;
  perform academy_op_audit('staff', p_actor, 'academy_media', v_new->>'id', 'create_media', null, v_new);
  perform academy_op_end();
  return v_new;
end $$;

-- Only the alt text, the rights and the permission may change, and only while no lesson outside a draft uses the record.
-- A stored manufacturer file or image stays the President's decision: changing it, or changing it AWAY from
-- manufacturer_permitted, needs the President (academy_author_check_media checks the new state as well).
create function public.academy_author_op_update_media(p_actor text, p_id uuid, p_changes jsonb)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare v_old academy_media; m jsonb; v_new jsonb;
begin
  perform academy_op_actor_staff(p_actor);
  perform academy_op_begin('update_media', p_actor);
  perform academy_content_keys(p_changes, array['rights','manufacturer_slug','permission_ref','alt_text']);
  if p_changes = '{}'::jsonb then raise exception 'academy: nothing to change' using errcode = '22023'; end if;
  select * into v_old from academy_media where id = p_id for update;
  if not found then raise exception 'academy: media not found' using errcode = 'P0002'; end if;
  if v_old.storage_path is not null and (v_old.rights = 'manufacturer_permitted' or v_old.kind = 'image') then
    begin perform academy_content_actor_president(p_actor);
    exception when insufficient_privilege then
      raise exception 'academy: only the President changes a stored photo or manufacturer file' using errcode = '42501';
    end;
  end if;
  if exists (select 1 from academy_lessons l join academy_modules mo on mo.id = l.module_id
               join academy_course_versions v on v.id = mo.version_id
              where v.status <> 'draft' and jsonb_path_exists(l.blocks, '$.**.media_id ? (@ == $id)', jsonb_build_object('id', p_id::text)))
     or exists (select 1 from academy_external_certs where upload_media_id = p_id) then
    raise exception 'academy: this media is used by content learners can see (or a credential); add a new media record instead' using errcode = '55000';
  end if;
  m := academy_author_check_media(p_actor, (to_jsonb(v_old) - 'id' - 'created_at') || p_changes);
  update academy_media set rights = m->>'rights', manufacturer_slug = m->>'manufacturer_slug', permission_ref = m->>'permission_ref',
                           alt_text = m->>'alt_text'
   where id = p_id returning to_jsonb(academy_media.*) into strict v_new;
  perform academy_op_audit('staff', p_actor, 'academy_media', p_id::text, 'update_media', to_jsonb(v_old), v_new);
  perform academy_op_end();
  return v_new;
end $$;

create function public.academy_author_op_delete_media(p_actor text, p_id uuid)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare v_old academy_media;
begin
  perform academy_op_actor_staff(p_actor);
  perform academy_op_begin('delete_media', p_actor);
  select * into v_old from academy_media where id = p_id for update;
  if not found then raise exception 'academy: media not found' using errcode = 'P0002'; end if;
  if exists (select 1 from academy_lessons l where jsonb_path_exists(l.blocks, '$.**.media_id ? (@ == $id)', jsonb_build_object('id', p_id::text)))
     or exists (select 1 from academy_external_certs where upload_media_id = p_id) then
    raise exception 'academy: this media is still used; remove it from every lesson first' using errcode = '55000';
  end if;
  delete from academy_media where id = p_id;
  if not found then raise exception 'academy: nothing was deleted' using errcode = 'P0002'; end if;
  perform academy_op_audit('staff', p_actor, 'academy_media', p_id::text, 'delete_media', to_jsonb(v_old), null);
  perform academy_op_end();
  return jsonb_build_object('deleted', p_id);
end $$;

-- ---------------------------------------------------------------------------------------------
-- PRODUCT-FACT LINKS (draft versions only)
-- ---------------------------------------------------------------------------------------------
-- p_link: {lesson_id | question_id, manufacturer_slug, model_code, field (optional: null = the model itself)}.
-- The fact need not be verified yet (a lesson shows "awaiting manufacturer"); M1 publishing refuses an exam question
-- whose fact is not verified, and the exam draw drops it if the fact is later replaced.
create function public.academy_author_op_link_fact(p_actor text, p_id uuid, p_link jsonb)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare v_lesson uuid; v_question uuid; v_ver uuid; v_mfr text; v_model text; v_field text; v_new jsonb;
begin
  perform academy_op_actor_staff(p_actor);
  perform academy_op_begin('link_fact', p_actor);
  perform academy_content_keys(p_link, array['lesson_id','question_id','manufacturer_slug','model_code','field']);
  if (p_link ? 'lesson_id' and p_link->'lesson_id' <> 'null'::jsonb) = (p_link ? 'question_id' and p_link->'question_id' <> 'null'::jsonb) then
    raise exception 'academy: a fact link belongs to one lesson or one question' using errcode = '22023';
  end if;
  if p_link ? 'lesson_id' and p_link->'lesson_id' <> 'null'::jsonb then
    v_lesson := academy_author_uuid(p_link->'lesson_id', 'lesson_id');
    select m.version_id into v_ver from academy_lessons l join academy_modules m on m.id = l.module_id where l.id = v_lesson;
    if v_ver is null then raise exception 'academy: lesson not found' using errcode = 'P0002'; end if;
  else
    v_question := academy_author_uuid(p_link->'question_id', 'question_id');
    select version_id into v_ver from academy_questions where id = v_question;
    if v_ver is null then raise exception 'academy: question not found' using errcode = 'P0002'; end if;
  end if;
  perform academy_content_lock_draft(v_ver);
  if v_lesson is not null then perform 1 from academy_lessons where id = v_lesson for update;
  else perform 1 from academy_questions where id = v_question for update; end if;
  if not found then raise exception 'academy: the lesson or question is gone' using errcode = 'P0002'; end if;
  v_mfr := p_link->>'manufacturer_slug';
  if v_mfr is null or not exists (select 1 from manufacturers where slug = v_mfr) then
    raise exception 'academy: that manufacturer is not in the HCPS manufacturer list' using errcode = '22023';
  end if;
  v_model := academy_author_model(p_link->'model_code');
  v_field := nullif(p_link->>'field', '');
  if v_field is not null and v_field !~ '^[a-z0-9_.]{1,60}$' then raise exception 'academy: % is not a fact field', v_field using errcode = '22023'; end if;
  if exists (select 1 from academy_content_refs where lesson_id is not distinct from v_lesson and question_id is not distinct from v_question
               and manufacturer_slug = v_mfr and upper(model_code) = v_model and field is not distinct from v_field) then
    raise exception 'academy: that fact is already linked' using errcode = '23505';
  end if;
  insert into academy_content_refs (id, version_id, lesson_id, question_id, manufacturer_slug, model_code, field)
  values (coalesce(p_id, gen_random_uuid()), v_ver, v_lesson, v_question, v_mfr, v_model, v_field)
  returning to_jsonb(academy_content_refs.*) into v_new;
  perform academy_op_audit('staff', p_actor, 'academy_content_refs', v_new->>'id', 'link_fact', null, v_new);
  perform academy_op_end();
  return v_new;
end $$;

create function public.academy_author_op_unlink_fact(p_actor text, p_id uuid)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare v_old academy_content_refs;
begin
  perform academy_op_actor_staff(p_actor);
  perform academy_op_begin('unlink_fact', p_actor);
  select * into v_old from academy_content_refs where id = p_id;
  if not found then raise exception 'academy: fact link not found' using errcode = 'P0002'; end if;
  perform academy_content_lock_draft(v_old.version_id);
  select * into v_old from academy_content_refs where id = p_id for update;
  if not found then raise exception 'academy: fact link not found' using errcode = 'P0002'; end if;
  if v_old.lesson_id is not null then
    perform 1 from academy_lessons where id = v_old.lesson_id for update;
    if exists (select 1 from academy_lessons l, jsonb_array_elements(l.blocks) b
                where l.id = v_old.lesson_id and b->>'manufacturer_slug' = v_old.manufacturer_slug
                  and ((b->>'kind' = 'fact' and b->>'model_code' = upper(v_old.model_code) and b->>'field' = v_old.field)
                    or (b->>'kind' = 'comparison' and b->'models' ? upper(v_old.model_code)
                        and exists (select 1 from jsonb_array_elements(b->'fields') f where f->>'field' = v_old.field)))) then
      raise exception 'academy: a block in this lesson shows that fact; change the block first' using errcode = '55000';
    end if;
  end if;
  delete from academy_content_refs where id = p_id;
  if not found then raise exception 'academy: nothing was deleted' using errcode = 'P0002'; end if;
  perform academy_op_audit('staff', p_actor, 'academy_content_refs', p_id::text, 'unlink_fact', to_jsonb(v_old), null);
  perform academy_op_end();
  return jsonb_build_object('deleted', p_id);
end $$;

-- ---------------------------------------------------------------------------------------------
-- PRIVILEGES (rule 19): the 12 operations — server role only. Helpers and guards — owner only.
-- academy_op_start_attempt keeps its M1 rights (create or replace keeps owner and grants).
-- ---------------------------------------------------------------------------------------------
do $$
declare f record;
begin
  for f in select p.oid::regprocedure as sig, p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname like 'academy\_author\_%' loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role', f.sig);
    if f.proname like 'academy\_author\_op\_%' then
      execute format('grant execute on function %s to service_role', f.sig);
    end if;
  end loop;
end $$;

commit;
