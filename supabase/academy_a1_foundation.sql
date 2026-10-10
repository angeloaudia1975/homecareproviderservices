-- =============================================================================================
-- HCPS Academy — Phase A1 foundation migration            supabase/academy_a1_foundation.sql
-- Shared HCPS Supabase project. Prepared 2026-10-10. Approved scope: decisions 30–31 (18 tables).
-- STATUS: presented at the migration review gate. Run ONLY after Angelo's explicit approval,
-- after the read-only preflight (academy_a1_preflight.sql) has come back clean.
-- Rollback: supabase/academy_a1_foundation_rollback.sql. Tests: supabase/academy_a1_acceptance_tests.sql.
--
-- 18 new tables (17 academy_* + the shared product_facts), one private storage bucket,
-- one app_settings row. Nothing existing is altered: dealers, dealer_users, staff_users,
-- manufacturers, product_content*, email_* and every ordering table are only referenced.
--
-- Security model (CLAUDE.md rule on new database objects):
--   * RLS enabled on every new table, with NO policies.
--   * anon and authenticated get NO privileges (Supabase's default grants are revoked
--     explicitly — new objects are NOT private by default).
--   * All reads and writes go through Netlify functions using the service role, which
--     check the caller's role in code (same pattern as product-content.js).
--   * No views are created.
--
-- Runs as ONE transaction: either everything is created or nothing is.
-- =============================================================================================
begin;

-- Safety: refuse to run twice, over a partial install, or over any name conflict.
do $$
begin
  if exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
             where n.nspname = 'public' and (c.relname like 'academy\_%' or c.relname like 'product\_facts%')) then
    raise exception 'An academy_* or product_facts object already exists. Stop and investigate; do not re-run.';
  end if;
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
             where n.nspname = 'public' and (p.proname like 'academy\_%' or p.proname like 'product\_facts%')) then
    raise exception 'An academy_* or product_facts function already exists. Stop and investigate.';
  end if;
  if exists (select 1 from storage.buckets where id = 'academy-private') then
    raise exception 'Storage bucket academy-private already exists. Stop and investigate.';
  end if;
  if exists (select 1 from public.app_settings where key = 'academy') then
    raise exception 'app_settings key academy already exists. Stop and investigate.';
  end if;
  if not exists (select 1 from public.manufacturers where slug = 'golden-technologies') then
    raise exception 'Manufacturer golden-technologies not found. Stop and investigate.';
  end if;
end $$;

-- ---------------------------------------------------------------------------------------------
-- PEOPLE (4)
-- ---------------------------------------------------------------------------------------------
create table public.academy_learners (
  id             uuid primary key default gen_random_uuid(),
  auth_user_id   uuid not null unique references auth.users(id) on delete restrict,
  full_name      text not null check (length(trim(full_name)) > 0),
  email          text not null check (email = lower(email)),
  status         text not null default 'active' check (status in ('active','suspended','closed')),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
comment on table public.academy_learners is
  'One row per person who learns. Identity is the Supabase Auth user; no ordering access is implied.';

create table public.academy_memberships (
  id             uuid primary key default gen_random_uuid(),
  learner_id     uuid not null references public.academy_learners(id) on delete restrict,
  dealer_id      uuid not null references public.dealers(id) on delete restrict,
  role           text not null check (role in ('learner','training_manager')),
  access_type    text not null check (access_type in ('dealer_user','training_only')),
  status         text not null default 'active' check (status in ('active','ended','revoked')),
  started_at     timestamptz not null default now(),
  ended_at       timestamptz,
  ended_reason   text,
  created_by     text not null,
  check ((status = 'active') = (ended_at is null))
);
create unique index academy_memberships_one_active
  on public.academy_memberships (learner_id, dealer_id) where status = 'active';
create index academy_memberships_dealer on public.academy_memberships (dealer_id, status);

create table public.academy_invites (
  id                   uuid primary key default gen_random_uuid(),
  dealer_id            uuid not null references public.dealers(id) on delete restrict,
  email                text not null check (email = lower(email)),
  full_name            text,
  role                 text not null default 'learner' check (role in ('learner','training_manager')),
  token_hash           text not null unique,
  expires_at           timestamptz not null,
  invited_by_learner   uuid references public.academy_learners(id),
  invited_by_staff     text,
  status               text not null default 'pending' check (status in ('pending','accepted','revoked','expired')),
  accepted_learner_id  uuid references public.academy_learners(id),
  created_at           timestamptz not null default now(),
  accepted_at          timestamptz,
  check (invited_by_learner is not null or invited_by_staff is not null),
  check (expires_at > created_at)
);
create index academy_invites_dealer on public.academy_invites (dealer_id, status);

create table public.academy_handoff_codes (
  id            uuid primary key default gen_random_uuid(),
  code_hash     text not null unique,
  auth_user_id  uuid not null references auth.users(id) on delete cascade,
  created_at    timestamptz not null default now(),
  expires_at    timestamptz not null,
  used_at       timestamptz,
  check (expires_at > created_at and expires_at <= created_at + interval '120 seconds')
);
comment on table public.academy_handoff_codes is
  'Partner 360 -> Academy single-use handoff (decision 1). Only a hash is stored; codes live <= 120 s.';

-- ---------------------------------------------------------------------------------------------
-- CONTENT (6)
-- ---------------------------------------------------------------------------------------------
create table public.academy_courses (
  id                 uuid primary key default gen_random_uuid(),
  slug               text not null unique check (slug ~ '^[a-z0-9-]+$'),
  manufacturer_slug  text references public.manufacturers(slug),
  title              text not null,
  course_type        text not null check (course_type in ('hcps_certification','manufacturer_program','training')),
  issuer             text not null check (issuer in ('hcps','manufacturer','none')),
  category           text,
  external_url       text,
  status             text not null default 'draft' check (status in ('draft','published','retired')),
  created_at         timestamptz not null default now(),
  check (course_type <> 'manufacturer_program' or (external_url is not null and issuer = 'manufacturer' and manufacturer_slug is not null)),
  check (course_type <> 'hcps_certification' or issuer = 'hcps')
);

create table public.academy_course_versions (
  id              uuid primary key default gen_random_uuid(),
  course_id       uuid not null references public.academy_courses(id) on delete restrict,
  version         int  not null check (version > 0),
  status          text not null default 'draft' check (status in ('draft','in_review','published','retired')),
  pass_mark       int  not null default 80 check (pass_mark between 1 and 100),
  exam_questions  int  not null default 25 check (exam_questions > 0),
  validity_months int  check (validity_months is null or validity_months > 0),
  retake_policy   jsonb not null default '{"unlimited": true}'::jsonb,
  published_at    timestamptz,
  published_by    text,
  created_at      timestamptz not null default now(),
  unique (course_id, version),
  check ((status in ('published','retired')) = (published_at is not null))
);
create unique index academy_course_versions_one_published
  on public.academy_course_versions (course_id) where status = 'published';

create table public.academy_modules (
  id          uuid primary key default gen_random_uuid(),
  version_id  uuid not null references public.academy_course_versions(id) on delete cascade,
  position    int  not null check (position > 0),
  title       text not null,
  objectives  jsonb not null default '[]'::jsonb,
  unique (version_id, position)
);

create table public.academy_lessons (
  id           uuid primary key default gen_random_uuid(),
  module_id    uuid not null references public.academy_modules(id) on delete cascade,
  position     int  not null check (position > 0),
  title        text not null,
  est_minutes  int  not null check (est_minutes between 1 and 30),
  blocks       jsonb not null default '[]'::jsonb check (jsonb_typeof(blocks) = 'array'),
  unique (module_id, position)
);

create table public.academy_questions (
  id              uuid primary key default gen_random_uuid(),
  version_id      uuid not null references public.academy_course_versions(id) on delete cascade,
  module_id       uuid references public.academy_modules(id) on delete set null,
  kind            text not null check (kind in ('single','multi','scenario')),
  use             text not null default 'exam' check (use in ('exam','practice')),
  prompt          text not null,
  choices         jsonb not null check (jsonb_typeof(choices) = 'array' and jsonb_array_length(choices) >= 2),
  answer_key      jsonb not null,
  explanation     text not null,
  objective_tags  text[] not null default '{}',
  status          text not null default 'active' check (status in ('active','retired'))
);
comment on column public.academy_questions.answer_key is
  'Server-only. Never returned to a learner before submission (graded by a Netlify function).';

create table public.academy_media (
  id                 uuid primary key default gen_random_uuid(),
  kind               text not null check (kind in ('image','video','pdf','link')),
  storage_path       text,
  external_url       text,
  rights             text not null check (rights in ('hcps_owned','manufacturer_permitted','link_only')),
  manufacturer_slug  text references public.manufacturers(slug),
  permission_ref     text,
  alt_text           text,
  created_at         timestamptz not null default now(),
  check (storage_path is not null or external_url is not null),
  check (rights <> 'link_only' or (external_url is not null and storage_path is null)),
  check (rights <> 'manufacturer_permitted' or permission_ref is not null)
);

-- ---------------------------------------------------------------------------------------------
-- PRODUCT FACTS (2) — product_facts is shared HCPS infrastructure, not academy-only
-- ---------------------------------------------------------------------------------------------
create table public.product_facts (
  id                 uuid primary key default gen_random_uuid(),
  manufacturer_slug  text not null references public.manufacturers(slug),
  model_code         text not null check (model_code = upper(model_code)),
  field              text not null check (field ~ '^[a-z0-9_.]+$'),
  value              jsonb not null,
  unit               text,
  field_class        text not null check (field_class in ('display','approval_required')),
  status             text not null check (status in ('verified','awaiting_manufacturer')),
  source_url         text not null,
  source_label       text not null,
  verified_on        date not null,
  verified_by        text not null,
  note               text,
  valid_from         timestamptz not null default now(),
  valid_to           timestamptz,
  replaced_by        uuid references public.product_facts(id) deferrable initially deferred,
  content_page_key   text,
  check (valid_to is null or valid_to >= valid_from),
  check ((valid_to is null) = (replaced_by is null))
);
comment on table public.product_facts is
  'Verified product facts with source and date. Rows are never edited: a change closes the current row
   (valid_to, replaced_by = the new row''s id) and inserts the new row in the same transaction. Lessons show
   the current approved fact; academy_content_refs.pinned_fact_id records the version each lesson and question
   was published with, and the exam draw skips any question whose pinned fact has since been replaced.
   content_page_key optionally links to product_content(manufacturer, page_key) for Partner 360 enrichment.';
create unique index product_facts_one_current
  on public.product_facts (manufacturer_slug, model_code, field) where valid_to is null;
create index product_facts_model on public.product_facts (manufacturer_slug, model_code);

create table public.academy_content_refs (
  id                 uuid primary key default gen_random_uuid(),
  version_id         uuid not null references public.academy_course_versions(id) on delete cascade,
  lesson_id          uuid references public.academy_lessons(id) on delete cascade,
  question_id        uuid references public.academy_questions(id) on delete cascade,
  manufacturer_slug  text not null references public.manufacturers(slug),
  model_code         text not null,
  field              text,
  pinned_fact_id     uuid references public.product_facts(id),
  check ((lesson_id is not null) <> (question_id is not null))
);
create index academy_content_refs_fact on public.academy_content_refs (manufacturer_slug, model_code, field);

-- ---------------------------------------------------------------------------------------------
-- LEARNING (3)
-- ---------------------------------------------------------------------------------------------
create table public.academy_enrollments (
  id             uuid primary key default gen_random_uuid(),
  learner_id     uuid not null references public.academy_learners(id) on delete restrict,
  version_id     uuid not null references public.academy_course_versions(id) on delete restrict,
  membership_id  uuid references public.academy_memberships(id),
  access_source  text not null check (access_source in ('assigned','self','admin_grant')),
  assigned_by    text,
  due_on         date,
  status         text not null default 'not_started'
                 check (status in ('not_started','in_progress','completed','withdrawn')),
  created_at     timestamptz not null default now(),
  completed_at   timestamptz,
  unique (learner_id, version_id),
  check ((status = 'completed') = (completed_at is not null))
);
create index academy_enrollments_membership on public.academy_enrollments (membership_id);

create table public.academy_progress (
  enrollment_id  uuid not null references public.academy_enrollments(id) on delete cascade,
  lesson_id      uuid not null references public.academy_lessons(id) on delete restrict,
  status         text not null check (status in ('viewed','completed')),
  resume_block   int  not null default 0 check (resume_block >= 0),
  updated_at     timestamptz not null default now(),
  primary key (enrollment_id, lesson_id)
);

create table public.academy_attempts (
  id             uuid primary key default gen_random_uuid(),
  enrollment_id  uuid not null references public.academy_enrollments(id) on delete restrict,
  started_at     timestamptz not null default now(),
  question_ids   uuid[] not null check (cardinality(question_ids) > 0),
  answers        jsonb,
  submitted_at   timestamptz,
  score          int check (score between 0 and 100),
  passed         boolean,
  graded_at      timestamptz,
  check ((submitted_at is null) = (answers is null)),
  check ((graded_at is null) = (score is null) and (score is null) = (passed is null))
);
create index academy_attempts_enrollment on public.academy_attempts (enrollment_id);

-- ---------------------------------------------------------------------------------------------
-- CREDENTIALS (2)
-- ---------------------------------------------------------------------------------------------
create table public.academy_certificates (
  id                  uuid primary key default gen_random_uuid(),
  cert_number         text not null unique check (cert_number ~ '^HCPS-[A-Z0-9]{4}-[A-Z0-9]{4}$'),
  learner_id          uuid not null references public.academy_learners(id) on delete restrict,
  enrollment_id       uuid not null unique references public.academy_enrollments(id) on delete restrict,
  version_id          uuid not null references public.academy_course_versions(id) on delete restrict,
  attempt_id          uuid not null references public.academy_attempts(id) on delete restrict,
  learner_name        text not null,
  dealer_name         text,
  issued_at           timestamptz not null default now(),
  expires_at          timestamptz,
  status              text not null default 'valid' check (status in ('valid','revoked')),
  revoked_at          timestamptz,
  revoked_by          text,
  revoked_reason      text,
  check ((status = 'revoked') = (revoked_at is not null and revoked_reason is not null))
);
comment on table public.academy_certificates is
  'HCPS-issued certificates only. Golden credentials are tracked in academy_external_certs and are never
   shown on the HCPS public verification page.';

create table public.academy_external_certs (
  id                       uuid primary key default gen_random_uuid(),
  learner_id               uuid not null references public.academy_learners(id) on delete restrict,
  course_id                uuid not null references public.academy_courses(id) on delete restrict,
  manufacturer_slug        text not null references public.manufacturers(slug),
  status                   text not null default 'training_started' check (status in (
                             'training_started','training_completed','exam_opened','exam_reported',
                             'awaiting_certificate','certificate_uploaded','verified','rejected')),
  training_started_at      timestamptz not null default now(),
  training_completed_at    timestamptz,
  exam_opened_at           timestamptz,
  exam_reported_at         timestamptz,
  certificate_uploaded_at  timestamptz,
  upload_media_id          uuid references public.academy_media(id),
  evidence_type            text check (evidence_type in ('golden_certificate','manufacturer_confirmation')),
  evidence_ref             text,
  verified_by              text,
  verified_at              timestamptz,
  certificate_ref          text,
  expires_at               timestamptz,
  note                     text,
  created_at               timestamptz not null default now(),
  check (status <> 'certificate_uploaded' or upload_media_id is not null),
  check (status <> 'verified' or (
           verified_by is not null and verified_at is not null and (
             (evidence_type = 'golden_certificate' and upload_media_id is not null) or
             (evidence_type = 'manufacturer_confirmation' and evidence_ref is not null))))
);
comment on table public.academy_external_certs is
  'Manufacturer-issued credentials (decision 37). Opening the exam link or a learner''s own report never means
   passed: only a manufacturer certificate (uploaded) or another approved manufacturer confirmation, checked by
   HCPS staff, makes a row verified. Never shown on the HCPS certificate verification page.';

-- ---------------------------------------------------------------------------------------------
-- OPERATIONS (1)
-- ---------------------------------------------------------------------------------------------
create table public.academy_events (
  id          bigint generated always as identity primary key,
  at          timestamptz not null default now(),
  actor_type  text not null check (actor_type in ('staff','learner','system')),
  actor       text not null,
  entity      text not null,
  entity_id   text,
  action      text not null,
  before      jsonb,
  after       jsonb
);
create index academy_events_entity on public.academy_events (entity, entity_id, at desc);

-- ---------------------------------------------------------------------------------------------
-- RULES ENFORCED IN THE DATABASE
-- ---------------------------------------------------------------------------------------------
-- 1. A published or retired course version is frozen: its modules, lessons and questions cannot change.
create or replace function public.academy_block_frozen_content() returns trigger
language plpgsql set search_path = public as $$
declare v_status text; v_id uuid;
begin
  if tg_table_name = 'academy_lessons' then
    select cv.status into v_status from academy_modules m join academy_course_versions cv on cv.id = m.version_id
      where m.id = coalesce(new.module_id, old.module_id);
  else
    v_id := coalesce(new.version_id, old.version_id);
    select status into v_status from academy_course_versions where id = v_id;
  end if;
  if v_status in ('published','retired') then
    raise exception 'Course version is %; create a new version instead of editing it', v_status;
  end if;
  return coalesce(new, old);
end $$;
create trigger academy_modules_frozen   before insert or update or delete on public.academy_modules
  for each row execute function public.academy_block_frozen_content();
create trigger academy_lessons_frozen   before insert or update or delete on public.academy_lessons
  for each row execute function public.academy_block_frozen_content();
create trigger academy_questions_frozen before insert or update or delete on public.academy_questions
  for each row execute function public.academy_block_frozen_content();

-- 1b. A published version cannot be edited or un-published; it may only move from published to retired.
create or replace function public.academy_course_versions_guard() returns trigger
language plpgsql set search_path = public as $$
begin
  if tg_op = 'DELETE' then
    if old.status in ('published','retired') then raise exception 'published course versions are never deleted'; end if;
    return old;
  end if;
  if old.status = 'retired' then raise exception 'a retired course version cannot change'; end if;
  if old.status = 'published' then
    if new.status <> 'retired'
       or (to_jsonb(new) - 'status') <> (to_jsonb(old) - 'status') then
      raise exception 'a published course version can only be retired; create a new version instead';
    end if;
  end if;
  return new;
end $$;
create trigger academy_course_versions_guard before update or delete on public.academy_course_versions
  for each row execute function public.academy_course_versions_guard();

-- 2. Product facts are append-only: only closing the current row (valid_to + replaced_by) is allowed.
create or replace function public.product_facts_append_only() returns trigger
language plpgsql set search_path = public as $$
begin
  if tg_op = 'DELETE' then raise exception 'product_facts rows are never deleted'; end if;
  if old.valid_to is not null then raise exception 'a closed product fact cannot change'; end if;
  if (to_jsonb(new) - 'valid_to' - 'replaced_by') <> (to_jsonb(old) - 'valid_to' - 'replaced_by') then
    raise exception 'product_facts values are never edited; close this row and insert a new one';
  end if;
  return new;
end $$;
create trigger product_facts_append_only before update or delete on public.product_facts
  for each row execute function public.product_facts_append_only();

-- 3. The audit log is append-only.
create or replace function public.academy_events_append_only() returns trigger
language plpgsql set search_path = public as $$
begin raise exception 'academy_events is append-only'; end $$;
create trigger academy_events_append_only before update or delete on public.academy_events
  for each row execute function public.academy_events_append_only();

-- 4. Certificates keep their identity; only revocation fields may change.
create or replace function public.academy_certificates_guard() returns trigger
language plpgsql set search_path = public as $$
begin
  if tg_op = 'DELETE' then raise exception 'certificates are revoked, never deleted'; end if;
  if (to_jsonb(new) - 'status' - 'revoked_at' - 'revoked_by' - 'revoked_reason')
     <> (to_jsonb(old) - 'status' - 'revoked_at' - 'revoked_by' - 'revoked_reason') then
    raise exception 'only revocation fields of a certificate may change';
  end if;
  return new;
end $$;
create trigger academy_certificates_guard before update or delete on public.academy_certificates
  for each row execute function public.academy_certificates_guard();

revoke all on function public.academy_block_frozen_content(), public.academy_course_versions_guard(), public.product_facts_append_only(),
  public.academy_events_append_only(), public.academy_certificates_guard() from public, anon, authenticated;

-- ---------------------------------------------------------------------------------------------
-- PERMISSIONS: RLS on, no policies, no anon/authenticated privileges, service role only
-- ---------------------------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array[
    'academy_learners','academy_memberships','academy_invites','academy_handoff_codes',
    'academy_courses','academy_course_versions','academy_modules','academy_lessons','academy_questions','academy_media',
    'product_facts','academy_content_refs',
    'academy_enrollments','academy_progress','academy_attempts',
    'academy_certificates','academy_external_certs','academy_events']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from public, anon, authenticated', t);
    execute format('grant select, insert, update, delete on table public.%I to service_role', t);
  end loop;
end $$;
revoke all on sequence public.academy_events_id_seq from public, anon, authenticated;
grant usage on sequence public.academy_events_id_seq to service_role;

-- ---------------------------------------------------------------------------------------------
-- STORAGE + SETTINGS (reuse existing infrastructure)
-- ---------------------------------------------------------------------------------------------
-- Private: no storage policies are added, so only the service role can read or write files.
-- Limits: certificate uploads and course files only (10 MB; PDF, JPEG, PNG).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('academy-private', 'academy-private', false, 10485760, array['application/pdf','image/jpeg','image/png']);

insert into public.app_settings (key, value) values ('academy', jsonb_build_object(
  'product_monitoring_enabled', false,
  'auto_update_enabled', false,
  'auto_update_fields', jsonb_build_array('sell_sheet_url','sell_sheet_revision','product_page_url',
                                          'image_url','manufacturer_name','colors_added','verified_on'),
  'approved_sources', jsonb_build_array(),   -- per manufacturer: {manufacturer_slug, url, kind, permission_ref}
  'hcps_cert_validity_months', 12,
  'notifications', jsonb_build_object('channel','email_queue','daily_cap_per_learner',1)
));

commit;
