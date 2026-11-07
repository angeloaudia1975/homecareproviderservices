-- ============================================================================
-- CATALOG 4 §8 — SOCIAL MEDIA AD BUILDER + (DISABLED) SCHEDULING / PUBLISHING (owner directive 2026-11-06 20:55 CT)
-- Additive only: four new tables + one private storage bucket. Nothing existing is read or changed.
--
-- dealer_social_ads            a dealer's saved ad designs (draft documents). One row per design; reopen / duplicate /
--                              archive. The ad keeps product REFERENCES only — the price shown is resolved again from the
--                              storefront's advertised price every time (never stored as the dealer's typed figure).
-- dealer_social_connections    a dealer's OWN authorization of a Facebook Page / Instagram Professional / LinkedIn Page,
--                              given through the platform's official sign-in. The access token is stored ENCRYPTED by the
--                              server (AES-256-GCM, key in Netlify env SOCIAL_TOKEN_KEY) and never sent to a browser.
--                              Empty until the platform apps are approved and the dealer connects.
-- dealer_social_posts          scheduled posts: draft → awaiting_approval → approved/scheduled → publishing → published |
--                              partially_published | failed; paused / cancelled at any time before publishing. The dealer
--                              approves every post before it can be published; HCPS never approves on a dealer's behalf.
-- dealer_social_post_targets   one row per post per platform (unique) — the duplicate guard: a platform is published at most
--                              once per post; retries reuse the same row.
-- storage bucket social-media  PRIVATE: the rendered image of a scheduled post (service role only, 8 MB, PNG / JPEG).
-- Publishing stays OFF: phase2_flags.social_publishing must be exactly true AND the platform's own app approval switch
-- (social_meta_approved / social_linkedin_approved). No flag is set here.
-- RULE 19: RLS on, no policies, nothing for anon / authenticated / public; service_role only.
-- Rollback (only while empty): drop table dealer_social_post_targets; drop table dealer_social_posts;
--   drop table dealer_social_connections; drop table dealer_social_ads;
--   set local storage.allow_delete_query = 'true'; delete from storage.buckets where id = 'social-media';
-- ============================================================================
create table if not exists public.dealer_social_ads (
  id             uuid         primary key default gen_random_uuid(),
  company_id     uuid         not null references public.dealers(id),     -- the head office (who may see every location's ads)
  dealer_id      uuid         not null references public.dealers(id),     -- the location the ad presents
  title          text         check (title is null or char_length(title) <= 80),
  ad             jsonb        not null,
  version        int          not null default 1,
  created_by     text         not null,
  created_at     timestamptz  not null default now(),
  updated_by     text         not null,
  updated_at     timestamptz  not null default now(),
  archived_at    timestamptz
);
create index if not exists dealer_social_ads_company_idx on public.dealer_social_ads (company_id, updated_at desc);
create index if not exists dealer_social_ads_dealer_idx on public.dealer_social_ads (dealer_id, updated_at desc);

create table if not exists public.dealer_social_connections (
  id               uuid         primary key default gen_random_uuid(),
  company_id       uuid         not null references public.dealers(id),
  dealer_id        uuid         not null references public.dealers(id),
  platform         text         not null check (platform in ('facebook','instagram','linkedin')),
  external_id      text         not null check (char_length(external_id) between 1 and 120),   -- Page / IG user / org id
  account_name     text         check (account_name is null or char_length(account_name) <= 200),
  status           text         not null default 'connected' check (status in ('connected','revoked','error','expired')),
  token_ciphertext text,                                                  -- AES-256-GCM, never returned to a browser
  token_expires_at timestamptz,
  scopes           text[]       not null default '{}',
  authorized_by    text         not null,
  authorized_at    timestamptz  not null default now(),
  revoked_at       timestamptz,
  last_error       text,
  updated_at       timestamptz  not null default now(),
  unique (dealer_id, platform, external_id)
);

create table if not exists public.dealer_social_posts (
  id               uuid         primary key default gen_random_uuid(),
  company_id       uuid         not null references public.dealers(id),
  dealer_id        uuid         not null references public.dealers(id),
  ad_id            uuid         references public.dealer_social_ads(id),
  caption          text         check (caption is null or char_length(caption) <= 2200),
  format           text         not null check (format in ('square','portrait','story','landscape')),
  media_path       text,                                                  -- social-media bucket
  media_sha256     text         check (media_sha256 is null or media_sha256 ~ '^[0-9a-f]{64}$'),
  platforms        text[]       not null check (cardinality(platforms) between 1 and 3 and platforms <@ array['facebook','instagram','linkedin']),
  scheduled_at     timestamptz  not null,
  status           text         not null default 'draft' check (status in ('draft','awaiting_approval','approved','paused','publishing','published','partially_published','failed','cancelled')),
  approved_by      text,
  approved_at      timestamptz,
  version          int          not null default 1,
  attempts         int          not null default 0 check (attempts >= 0),
  next_attempt_at  timestamptz,
  last_error       text,
  created_by       text         not null,
  created_at       timestamptz  not null default now(),
  updated_by       text         not null,
  updated_at       timestamptz  not null default now(),
  check (status not in ('approved','publishing','published','partially_published') or (approved_by is not null and approved_at is not null))
);
create index if not exists dealer_social_posts_due_idx on public.dealer_social_posts (status, scheduled_at);
create index if not exists dealer_social_posts_company_idx on public.dealer_social_posts (company_id, scheduled_at);

create table if not exists public.dealer_social_post_targets (
  id                uuid         primary key default gen_random_uuid(),
  post_id           uuid         not null references public.dealer_social_posts(id),
  platform          text         not null check (platform in ('facebook','instagram','linkedin')),
  connection_id     uuid         references public.dealer_social_connections(id),
  status            text         not null default 'pending' check (status in ('pending','publishing','published','failed','cancelled')),
  external_post_id  text,
  published_at      timestamptz,
  attempts          int          not null default 0,
  last_error        text,
  claimed_at        timestamptz,
  unique (post_id, platform)
);

alter table public.dealer_social_ads enable row level security;
alter table public.dealer_social_connections enable row level security;
alter table public.dealer_social_posts enable row level security;
alter table public.dealer_social_post_targets enable row level security;
revoke all on public.dealer_social_ads, public.dealer_social_connections, public.dealer_social_posts, public.dealer_social_post_targets from public, anon, authenticated;
revoke all on public.dealer_social_ads, public.dealer_social_connections, public.dealer_social_posts, public.dealer_social_post_targets from service_role;
grant select, insert, update on public.dealer_social_ads to service_role;            -- archive, never delete
grant select, insert, update on public.dealer_social_connections to service_role;    -- revoke, never delete
grant select, insert, update on public.dealer_social_posts to service_role;          -- cancel, never delete
grant select, insert, update on public.dealer_social_post_targets to service_role;

-- private bucket for the rendered image of a scheduled post (no storage policies = service role only)
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('social-media', 'social-media', false, 8388608, array['image/png','image/jpeg'])
on conflict (id) do nothing;

-- install check: one row, every column true
select
  (select count(*) = 4 from pg_tables where schemaname = 'public' and tablename in ('dealer_social_ads','dealer_social_connections','dealer_social_posts','dealer_social_post_targets') and rowsecurity) as rls_on,
  (select count(*) = 0 from pg_policies where schemaname = 'public' and tablename like 'dealer_social_%') as no_policies,
  (select count(*) = 0 from information_schema.role_table_grants where table_schema = 'public' and table_name like 'dealer_social_%' and grantee in ('anon','authenticated','PUBLIC')) as no_public_grants,
  (select count(*) = 0 from information_schema.role_table_grants where table_schema = 'public' and table_name like 'dealer_social_%' and grantee = 'service_role' and privilege_type in ('DELETE','TRUNCATE')) as no_deletes,
  (select exists (select 1 from storage.buckets where id = 'social-media' and public = false)) as bucket_private;
