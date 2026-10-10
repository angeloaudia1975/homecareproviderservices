-- ============================================================================================
--  MANUFACTURER CENTER — PHASE 2 FREEZE GUARD (approved by Angelo 2026-10-10)
--  A frozen line (manufacturer_meta.frozen) refuses every COMMERCIAL write at the database,
--  whichever code path sends it: catalog-api, the images tool, the ordering site's old catalog
--  endpoint, or a hand-run SQL statement. The only way through is an explicit regression fix:
--  the request carries header x-hcps-regression-fix = the id of an unused mfr_decisions row of
--  kind 'regression_fix' for that same manufacturer (catalog-api marks it used afterwards).
--  A frozen line cannot be unfrozen, have its record authority switched, or its freight terms
--  changed without that same token. There is no silent unfreeze.
--
--  What counts as commercial:
--   * product_skus — every column except updated_at / updated_by (it IS the commercial master),
--     and any insert or delete;
--   * custom_products — code, base_price, msrp, map, msrp_auto, tiers, active, price_note,
--     and any insert or delete;
--   * product_overrides — the patch keys base_price, msrp, map, msrp_auto, tiers, active,
--     disposition, price_note, case_qty, effective_date, source_file; a delete of a patch that
--     holds any of them;
--   * manufacturer_meta — record_authoritative, frozen (true → false), freight_terms; delete.
--  Images, names, descriptions, links and categories are not blocked here (the written freeze
--  rule in CLAUDE.md still forbids changing them on these lines).
--
--  RULE 19: the guard function is SECURITY DEFINER (it must read mfr_decisions, which nobody but
--  service_role can read) with a fixed search_path, and EXECUTE is revoked from PUBLIC / anon /
--  authenticated. Triggers fire it regardless; nobody can call it directly.
--  Hand-run SQL on a frozen line after this point: first create the regression_fix decision, then
--  in the same transaction  select set_config('request.headers','{"x-hcps-regression-fix":"<id>"}', true);
-- ============================================================================================
begin;

create or replace function public.mfr_freeze_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_slug   text;
  v_frozen boolean;
  touched  boolean := false;
  tok      text;
  hdrs     text;
  k        text;
  oj       jsonb;
  nj       jsonb;
  ckeys    text[];
begin
  if TG_TABLE_NAME = 'manufacturer_meta' then
    v_slug := coalesce(OLD.slug, NEW.slug);
    v_frozen := coalesce(OLD.frozen, false);            -- freezing a line is always allowed
  else
    v_slug := coalesce(case when TG_OP <> 'INSERT' then OLD.manufacturer end, NEW.manufacturer);
    select m.frozen into v_frozen from public.manufacturer_meta m where m.slug = v_slug;
    if TG_OP = 'UPDATE' and NEW.manufacturer is distinct from OLD.manufacturer and not coalesce(v_frozen,false) then
      select m.frozen into v_frozen from public.manufacturer_meta m where m.slug = NEW.manufacturer;   -- moving a row INTO a frozen line
    end if;
  end if;
  if not coalesce(v_frozen, false) then
    return case when TG_OP = 'DELETE' then OLD else NEW end;
  end if;

  if TG_TABLE_NAME = 'product_skus' then
    touched := TG_OP <> 'UPDATE'
            -- code_norm is a generated column: NULL in NEW inside a BEFORE trigger, derived from code (compared).
            or (to_jsonb(NEW) - 'updated_at' - 'updated_by' - 'code_norm') is distinct from (to_jsonb(OLD) - 'updated_at' - 'updated_by' - 'code_norm');
  elsif TG_TABLE_NAME = 'custom_products' then
    if TG_OP <> 'UPDATE' then touched := true;
    else
      oj := to_jsonb(OLD); nj := to_jsonb(NEW);
      foreach k in array array['manufacturer','code','base_price','msrp','map','msrp_auto','tiers','active','price_note'] loop
        if oj->k is distinct from nj->k then touched := true; end if;
      end loop;
    end if;
  elsif TG_TABLE_NAME = 'product_overrides' then
    ckeys := array['base_price','msrp','map','msrp_auto','tiers','active','disposition','price_note','case_qty','effective_date','source_file'];
    oj := case when TG_OP = 'INSERT' then '{}'::jsonb else coalesce(OLD.patch, '{}'::jsonb) end;
    nj := case when TG_OP = 'DELETE' then '{}'::jsonb else coalesce(NEW.patch, '{}'::jsonb) end;
    foreach k in array ckeys loop
      if oj->k is distinct from nj->k then touched := true; end if;
    end loop;
    if TG_OP = 'UPDATE' and (NEW.manufacturer is distinct from OLD.manufacturer or NEW.code is distinct from OLD.code) then touched := true; end if;
  elsif TG_TABLE_NAME = 'manufacturer_meta' then
    touched := TG_OP = 'DELETE'
            or NEW.record_authoritative is distinct from OLD.record_authoritative
            or NEW.frozen is distinct from OLD.frozen
            or NEW.freight_terms is distinct from OLD.freight_terms
            or NEW.slug is distinct from OLD.slug;
  end if;
  if not touched then
    return case when TG_OP = 'DELETE' then OLD else NEW end;
  end if;

  hdrs := current_setting('request.headers', true);
  if hdrs is not null and hdrs <> '' then
    begin tok := (hdrs::json) ->> 'x-hcps-regression-fix'; exception when others then tok := null; end;
  end if;
  if tok is null or tok !~ '^\d+$' or not exists (
       select 1 from public.mfr_decisions d
       where d.id = tok::bigint and d.kind = 'regression_fix' and d.manufacturer = v_slug and d.used_at is null) then
    raise exception 'line_frozen: % is frozen (Gold Standard). A commercial change to % needs a regression_fix decision.', v_slug, TG_TABLE_NAME
      using errcode = 'P0001', hint = 'Record a regression_fix decision in Manufacturer Center and send it with the change.';
  end if;
  return case when TG_OP = 'DELETE' then OLD else NEW end;
end $$;

revoke all on function public.mfr_freeze_guard() from public, anon, authenticated;

drop trigger if exists mfr_freeze_guard on public.product_skus;
create trigger mfr_freeze_guard before insert or update or delete on public.product_skus
  for each row execute function public.mfr_freeze_guard();
drop trigger if exists mfr_freeze_guard on public.custom_products;
create trigger mfr_freeze_guard before insert or update or delete on public.custom_products
  for each row execute function public.mfr_freeze_guard();
drop trigger if exists mfr_freeze_guard on public.product_overrides;
create trigger mfr_freeze_guard before insert or update or delete on public.product_overrides
  for each row execute function public.mfr_freeze_guard();
drop trigger if exists mfr_freeze_guard on public.manufacturer_meta;
create trigger mfr_freeze_guard before update or delete on public.manufacturer_meta
  for each row execute function public.mfr_freeze_guard();

/* SELF-TEST, callable only by service_role (catalog-api action mc_guard_selftest). For every frozen
   line it TRIES one commercial write per guarded table (a price on a record, a price key on an
   override, an added product, the authority flag, an unfreeze), each inside its own sub-transaction
   that is always rolled back, and reports "blocked" when the guard refused it. Nothing it attempts
   can survive: a write the guard failed to refuse is rolled back too and reported "NOT BLOCKED". */
create or replace function public.mfr_freeze_guard_selftest() returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  s   record;
  out jsonb := '[]'::jsonb;
  res text;
  tgt bigint;
  oc  text;
begin
  for s in select m.slug from public.manufacturer_meta m where m.frozen order by m.slug loop
    res := 'no active record'; tgt := null;
    select p.id into tgt from public.product_skus p where p.manufacturer = s.slug and p.status = 'active' order by p.id limit 1;
    if tgt is not null then
      begin
        update public.product_skus set base_price = coalesce(base_price, 0) + 0.01 where id = tgt;
        raise exception 'mc_selftest_not_blocked';
      exception when others then
        res := case when sqlerrm like 'line_frozen%' then 'blocked' when sqlerrm = 'mc_selftest_not_blocked' then 'NOT BLOCKED' else 'error: ' || sqlerrm end;
      end;
    end if;
    out := out || jsonb_build_object('line', s.slug, 'attempt', 'record price +1 cent', 'result', res);
    oc := null;
    begin
      select o.code into oc from public.product_overrides o where o.manufacturer = s.slug order by o.code limit 1;
      if oc is not null then
        update public.product_overrides set patch = coalesce(patch, '{}'::jsonb) || jsonb_build_object('base_price', 0.01) where manufacturer = s.slug and code = oc;
      else
        insert into public.product_overrides (manufacturer, code, patch) values (s.slug, '__mc_selftest__', '{"base_price":0.01}'::jsonb);
      end if;
      raise exception 'mc_selftest_not_blocked';
    exception when others then
      res := case when sqlerrm like 'line_frozen%' then 'blocked' when sqlerrm = 'mc_selftest_not_blocked' then 'NOT BLOCKED' else 'error: ' || sqlerrm end;
    end;
    out := out || jsonb_build_object('line', s.slug, 'attempt', 'override price key', 'result', res);
    begin
      insert into public.custom_products (manufacturer, code, base_price, active) values (s.slug, '__mc_selftest__', 1, true);
      raise exception 'mc_selftest_not_blocked';
    exception when others then
      res := case when sqlerrm like 'line_frozen%' then 'blocked' when sqlerrm = 'mc_selftest_not_blocked' then 'NOT BLOCKED' else 'error: ' || sqlerrm end;
    end;
    out := out || jsonb_build_object('line', s.slug, 'attempt', 'added product', 'result', res);
    begin
      update public.manufacturer_meta set record_authoritative = not coalesce(record_authoritative, false) where slug = s.slug;
      raise exception 'mc_selftest_not_blocked';
    exception when others then
      res := case when sqlerrm like 'line_frozen%' then 'blocked' when sqlerrm = 'mc_selftest_not_blocked' then 'NOT BLOCKED' else 'error: ' || sqlerrm end;
    end;
    out := out || jsonb_build_object('line', s.slug, 'attempt', 'authority flag', 'result', res);
    begin
      update public.manufacturer_meta set frozen = false where slug = s.slug;
      raise exception 'mc_selftest_not_blocked';
    exception when others then
      res := case when sqlerrm like 'line_frozen%' then 'blocked' when sqlerrm = 'mc_selftest_not_blocked' then 'NOT BLOCKED' else 'error: ' || sqlerrm end;
    end;
    out := out || jsonb_build_object('line', s.slug, 'attempt', 'unfreeze', 'result', res);
  end loop;
  return out;
end $$;
revoke all on function public.mfr_freeze_guard_selftest() from public, anon, authenticated;
grant execute on function public.mfr_freeze_guard_selftest() to service_role;

commit;

-- CHECK (read-only, one result table). Every row: ok = true. The self-test rows each try one write
-- on a frozen line inside a rolled-back sub-transaction and must read "blocked".
select * from (
  select 1 as n, 'guard trigger on ' || tgrelid::regclass::text as check_name, 'installed' as value, true as ok
    from pg_trigger where tgname = 'mfr_freeze_guard'
  union all
  select 2, 'anon/authenticated can execute guard or self-test (expect false)',
         bool_or(has_function_privilege(r, 'public.mfr_freeze_guard()', 'execute') or has_function_privilege(r, 'public.mfr_freeze_guard_selftest()', 'execute'))::text,
         not bool_or(has_function_privilege(r, 'public.mfr_freeze_guard()', 'execute') or has_function_privilege(r, 'public.mfr_freeze_guard_selftest()', 'execute'))
    from unnest(array['anon','authenticated']) r
  union all
  select 3, 'self-test: ' || (e->>'line') || ' — ' || (e->>'attempt'), e->>'result', (e->>'result') in ('blocked','no active record')
    from jsonb_array_elements(public.mfr_freeze_guard_selftest()) e
) x order by n, check_name;
