-- ============================================================================
-- Dealer email verification status. Lets you add a dealer with an UNVERIFIED email address
-- (fast new-dealer onboarding / dealer requests) and confirm it later WITHOUT recreating the
-- dealer. A dealer whose email you change also drops back to Pending automatically.
--   email_verified = true            -> confirmed correct
--   email_verified = false OR null   -> Pending verification (shown as a badge in Dealer Manager)
-- Existing dealers that already have an email on file are grandfathered as verified, so only NEW
-- dealers (and any whose email is changed from here on) surface as Pending — the queue stays clean.
-- Wrapped so the grandfather step runs ONCE (first install only) and the whole script is re-runnable.
-- ============================================================================
do $$
begin
  if not exists (select 1 from information_schema.columns
                 where table_name='dealers' and column_name='email_verified') then
    alter table dealers add column email_verified boolean;
    alter table dealers add column email_verified_at timestamptz;
    update dealers set email_verified=true, email_verified_at=now() where email is not null;
  end if;
end $$;
create index if not exists dealers_email_verified_idx on dealers(email_verified);
