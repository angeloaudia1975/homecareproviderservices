-- ============================================================================================
--  MANUFACTURER CENTER — PHASE 1 BACKFILL (approved by Angelo 2026-10-10)
--  Run AFTER mc_phase1_foundation.sql and BEFORE mc_phase2_freeze_guard.sql (it refuses to run
--  once the freeze guard exists, because it writes to the frozen lines' records).
--  What it records — nothing a dealer sees changes (the storefront reads none of these columns):
--   1. the sources the four frozen lines were built from (legacy registrations — received date
--      unknown, never invented) and the Bemis 2026 price list (received 2026-10-10, effective
--      date pending) plus the Bemis Terms of Agreement;
--   2. product_skus.source_id for every record of those lines; Bemis dealer_unit_cost;
--   3. MSRP/MAP basis on pack SKUs, matching exactly what dealers see today;
--   4. Bemis decisions (Angelo, 2026-10-10) as rows in mfr_decisions;
--   5. freeze flag, the Bemis pages deferral, and freight terms with their trace.
--  Safe to re-run: every insert checks for an existing row first.
-- ============================================================================================
begin;
do $$ begin
  if exists (select 1 from pg_proc where proname = 'mfr_freeze_guard') then
    raise exception 'The Phase 2 freeze guard is already installed: this backfill writes to frozen lines and must run before it. Nothing was written.';
  end if;
end $$;

-- 1a. Legacy sources: one per distinct source file on the three earlier lines' records.
insert into public.mfr_sources (manufacturer, kind, title, file_name, legacy, manufacturer_effective_date, effective_date_status,
                                status, accepted_by, accepted_at, note, created_by)
select s.manufacturer, 'price_list', s.source_file, s.source_file, true, s.ed,
       case when s.ed is null then 'pending' else 'stated' end,
       'accepted', 'Angelo Audia', now(),
       'Legacy registration 2026-10-10: the source this line was activated from (Gold Standard). Received date was not recorded. Effective date carried from product_skus.effective_date'
         || case when s.n_dates > 1 then ' (records carry ' || s.n_dates || ' different dates, so it is left pending).' else '.' end,
       'mc-backfill'
from (select manufacturer, source_file,
             case when count(distinct effective_date) = 1 and count(*) = count(effective_date) then min(effective_date) end as ed,
             count(distinct effective_date) as n_dates
      from public.product_skus
      where manufacturer in ('climbing-steps','strongback-mobility','ovation-medical') and source_file is not null
      group by 1, 2) s
where not exists (select 1 from public.mfr_sources x where x.manufacturer = s.manufacturer and x.file_name = s.source_file);

-- 1b. Bemis 2026 Digital Price List (received 2026-10-10; manufacturer effective date pending).
insert into public.mfr_sources (manufacturer, kind, title, file_name, file_sha256, received_date, legacy, effective_date_status,
                                status, accepted_by, accepted_at, note, created_by)
select 'bemis', 'price_list', 'Bemis Digital Price List 2026', 'Bemis Digital Price List 2026(20261010-175622).xlsx',
       '7908618d92275e552498934d3456f1f993996bc5ba298703eec3350f016202fe', date '2026-10-10', false, 'pending',
       'accepted', 'Angelo Audia', timestamptz '2026-10-10 13:42:00-05',
       'Accepted by HCPS as the current 2026 Bemis price list; manufacturer effective date pending until Bemis supplies one. File stored in mfr-sources when uploaded.',
       'mc-backfill'
where not exists (select 1 from public.mfr_sources where manufacturer='bemis' and file_sha256='7908618d92275e552498934d3456f1f993996bc5ba298703eec3350f016202fe');

-- 1c. Bemis Terms of Agreement (dealer application, dated 2022-03-01) — the freight / fee source.
insert into public.mfr_sources (manufacturer, kind, title, file_name, legacy, manufacturer_effective_date, effective_date_status,
                                status, accepted_by, accepted_at, note, created_by)
select 'bemis', 'terms', 'Bemis Terms of Agreement (dealer application)', null, true, date '2022-03-01', 'stated',
       'accepted', 'Angelo Audia', timestamptz '2026-10-10 13:01:00-05',
       'Legacy registration: the dealer application held in homecareproviderservices/src/assets/docs. $500 minimum for prepaid freight; +$40 shipping & handling below $500; $10 less-than-case fee per line. Written confirmation that it is current for 2026 requested from Bemis.',
       'mc-backfill'
where not exists (select 1 from public.mfr_sources where manufacturer='bemis' and kind='terms');

-- 2a. source_id on every record of the four lines whose source_file matches a registered file.
update public.product_skus p set source_id = s.id
from public.mfr_sources s
where p.manufacturer in ('climbing-steps','strongback-mobility','ovation-medical','bemis')
  and s.manufacturer = p.manufacturer and s.kind = 'price_list' and s.file_name = p.source_file
  and p.source_id is distinct from s.id;

-- 2b. Bemis rows as received: link to the source, parse the case qty and unit cost exactly as written.
update public.price_imports i set
  source_id        = s.id,
  parsed_case_qty  = nullif(substring(i.raw->>'Master Case Qty' from '^\s*(\d+)'), '')::numeric,
  parsed_unit_cost = (i.raw->>'Dealer Cost Per Unit')::numeric
from public.mfr_sources s
where i.manufacturer = 'bemis' and i.import_label = 'bemis-2026-received-2026-10-10'
  and s.manufacturer = 'bemis' and s.kind = 'price_list' and s.file_sha256 = '7908618d92275e552498934d3456f1f993996bc5ba298703eec3350f016202fe';

-- 2c. Bemis accepted dealer unit cost = the value Bemis wrote (never dealer-facing, never used to price).
update public.product_skus p set dealer_unit_cost = i.parsed_unit_cost
from public.price_imports i
where p.manufacturer = 'bemis' and i.manufacturer = 'bemis' and i.import_label = 'bemis-2026-received-2026-10-10'
  and upper(regexp_replace(i.code, '[^A-Za-z0-9]', '', 'g')) = p.code_norm
  and p.dealer_unit_cost is distinct from i.parsed_unit_cost;

-- 3. MSRP / MAP basis on pack SKUs, matching what dealers see today:
--    Bemis case items: MSRP and MAP "each"; Strongback packs: MAP "each"; Ovation packs: MSRP per order unit.
update public.product_skus set msrp_basis = 'each', map_basis = 'each'
 where manufacturer = 'bemis' and case_qty > 1 and status = 'active';
update public.product_skus set map_basis = 'each'
 where manufacturer = 'strongback-mobility' and case_qty > 1 and map is not null and status = 'active';
update public.product_skus set msrp_basis = 'order_unit'
 where manufacturer = 'ovation-medical' and case_qty > 1 and msrp is not null and status = 'active';

-- 4. Decisions.
with bemis_src as (select id from public.mfr_sources where manufacturer='bemis' and kind='price_list' and file_sha256='7908618d92275e552498934d3456f1f993996bc5ba298703eec3350f016202fe'),
     bemis_terms as (select id from public.mfr_sources where manufacturer='bemis' and kind='terms'),
     d(manufacturer, src, code, field, mv, hv, kind, reason, at) as (values
  ('bemis','list',null,'source', null::jsonb, '{"status":"accepted","received_date":"2026-10-10","manufacturer_effective_date":"pending"}'::jsonb, 'acceptance',
   'Accepted by HCPS as the current 2026 Bemis price list; the manufacturer effective date is pending until Bemis supplies one and is not an activation blocker.', timestamptz '2026-10-10 14:35:00-05'),
  ('bemis','list',null,'base_price', '{"columns":["Dealer Cost Per Unit","Master Case Qty","Dealer Master Case Cost"]}'::jsonb,
   '{"rule":"dealer price = Dealer Master Case Cost; uom Case; case_qty = Master Case Qty, where supplied","never":"derive one price from the other"}'::jsonb, 'interpretation',
   'Normal case ordering uses the manufacturer''s explicit Master Case Cost as the dealer price. MAP and MSRP stay separate source fields.', timestamptz '2026-10-10 13:01:00-05'),
  ('bemis','list','7YR05310TSS','base_price','{"Dealer Master Case Cost":109.98}'::jsonb,'{"base_price":109.98,"previous":109.99}'::jsonb,'conflict','1 cent correction to the 2026 list approved.', timestamptz '2026-10-10 13:42:00-05'),
  ('bemis','list','7YE05310TSS','base_price','{"Dealer Master Case Cost":109.98}'::jsonb,'{"base_price":109.98,"previous":109.99}'::jsonb,'conflict','1 cent correction to the 2026 list approved.', timestamptz '2026-10-10 13:42:00-05'),
  ('bemis','list','7YA0AS100','base_price','{"Dealer Master Case Cost":99.98}'::jsonb,'{"base_price":99.98,"previous":99.99}'::jsonb,'conflict','1 cent correction to the 2026 list approved.', timestamptz '2026-10-10 13:42:00-05'),
  ('bemis','list','7YE82350TC','uom','{"Master Case Qty":null,"Dealer Master Case Cost":null,"Dealer Cost Per Unit":54.99}'::jsonb,'{"uom":"Each","case_qty":1}'::jsonb,'interpretation',
   'Not a case item: sold individually, as listed in the 2026 price list. Not flagged as missing a case quantity. A later Bemis source giving a pack quantity is a source change.', timestamptz '2026-10-10 14:35:00-05'),
  ('bemis','list','444DISPLAY','uom','{"Master Case Qty":null,"Dealer Master Case Cost":null,"Dealer Cost Per Unit":634.86}'::jsonb,'{"uom":"Display","case_qty":1}'::jsonb,'interpretation',
   'One orderable display, as listed in the 2026 price list; never a multi-unit Case. A later Bemis source giving a pack quantity is a source change.', timestamptz '2026-10-10 14:35:00-05'),
  ('bemis','list',null,'msrp_basis','{"MSRP":"per unit","MAP":"per unit"}'::jsonb,'{"msrp_basis":"each","map_basis":"each","applies_to":"items with a Master Case Qty"}'::jsonb,'interpretation',
   'Case-priced products read: dealer price per Case; MSRP $X each; MAP $X each.', timestamptz '2026-10-10 13:42:00-05'),
  ('bemis','terms',null,'freight','{"terms":"$500 minimum for prepaid freight; below $500 +$40 shipping & handling"}'::jsonb,
   '{"freeAt":500,"flatUnder":40,"freeLabel":"Prepaid freight","flatLabel":"shipping & handling"}'::jsonb,'freight_terms',
   'Bemis-only wording matches the manufacturer''s terms: Prepaid freight at $500+, $40 shipping & handling below $500.', timestamptz '2026-10-10 14:35:00-05'),
  ('bemis','terms',null,'fee_less_than_case','{"amount":10,"per":"line item"}'::jsonb,'{"status":"recorded, not coded"}'::jsonb,'exception',
   'Supported by the terms but unreachable: Partner 360 sells Bemis case items in whole cases. Recorded; no per-line fee code until a less-than-case order is possible.', timestamptz '2026-10-10 12:56:00-05'),
  ('bemis',null,null,'fee_dropship',null,'{"status":"HOLD"}'::jsonb,'exception',
   'The old $20 dropship fee appears in no Bemis source. On HOLD unless Bemis provides it in writing.', timestamptz '2026-10-10 12:56:00-05'),
  ('bemis',null,null,'enrichment_pages',null,'{"status":"deferred"}'::jsonb,'deferral',
   'Bemis product pages are intentionally deferred. catalog_audit''s "needs SKU review" for Bemis reflects this deferral only and is not a Gold Standard regression.', timestamptz '2026-10-10 15:13:00-05'),
  ('climbing-steps',null,null,'freight',null,null,'freight_terms','Legacy freight terms carried over unchanged from manufacturers.json at the freeze (2026-10-10).', timestamptz '2026-10-10 15:13:00-05'),
  ('strongback-mobility',null,null,'freight',null,null,'freight_terms','Legacy freight terms carried over unchanged from manufacturers.json at the freeze (2026-10-10); confirmed by HCPS 2026-10-09.', timestamptz '2026-10-10 15:13:00-05'),
  ('ovation-medical',null,null,'freight',null,null,'freight_terms','Legacy freight terms carried over unchanged from manufacturers.json at the freeze (2026-10-10): freight confirmed by HCPS per order.', timestamptz '2026-10-10 15:13:00-05')
)
insert into public.mfr_decisions (manufacturer, source_id, code, field, manufacturer_value, hcps_value, kind, reason, decided_by, decided_at)
select d.manufacturer,
       case d.src when 'list' then (select id from bemis_src) when 'terms' then (select id from bemis_terms) end,
       d.code, d.field, d.mv, d.hv, d.kind, d.reason, 'Angelo Audia', d.at
from d
where not exists (select 1 from public.mfr_decisions x where x.manufacturer=d.manufacturer and x.field=d.field
                    and x.code is not distinct from d.code and x.kind=d.kind and x.reason=d.reason);

-- 5a. Freeze the four Gold Standard lines.
update public.manufacturer_meta set frozen = true, frozen_at = coalesce(frozen_at, now()),
       frozen_reason = coalesce(frozen_reason, 'Gold Standard COMPLETE; frozen by Angelo 2026-10-10. Changes only for a regression (regression_fix decision) or a new manufacturer source.')
 where slug in ('climbing-steps','strongback-mobility','ovation-medical','bemis');

-- 5b. The Bemis pages deferral, pointing at its decision.
update public.manufacturer_meta m set deferrals = jsonb_build_array(jsonb_build_object(
         'item','enrichment_pages','status','deferred','decided','2026-10-10','by','Angelo Audia',
         'decision_id', (select id from public.mfr_decisions where manufacturer='bemis' and field='enrichment_pages' and kind='deferral' order by id limit 1),
         'note','Bemis product pages intentionally deferred; "needs SKU review" in catalog_audit is this deferral, not a regression.'))
 where m.slug = 'bemis' and not (m.deferrals @> '[{"item":"enrichment_pages"}]'::jsonb);

-- 5c. Freight terms = today's manufacturers.json entries, each with its trace (read from Phase 5 on).
update public.manufacturer_meta set freight_terms = '{"summary": "Free freight on all Climbing Steps orders.", "actualNote": "", "groups": [{"label": "All Climbing Steps items", "brandKeywords": ["*"], "freeAt": 0}], "elseActual": false}'::jsonb || jsonb_build_object('trace', jsonb_build_object('decision_id',(select id from public.mfr_decisions where manufacturer='climbing-steps' and kind='freight_terms' order by id limit 1),'carried_from','manufacturers.json 2026-10-10'))
 where slug = 'climbing-steps' and freight_terms is null;
update public.manufacturer_meta set freight_terms = '{"summary": "Wheelchairs, ErgoSteel and the SEATA rollator ship free. Accessories add one $15 shipping & handling charge per order, whatever the number of accessories.", "actualNote": "", "groups": [{"label": "Strongback accessories — shipping & handling", "categories": ["Accessories"], "flatFee": 15}, {"label": "Strongback models — shipping included", "brandKeywords": ["*"], "freeAt": 0}], "elseActual": false}'::jsonb || jsonb_build_object('trace', jsonb_build_object('decision_id',(select id from public.mfr_decisions where manufacturer='strongback-mobility' and kind='freight_terms' order by id limit 1),'carried_from','manufacturers.json 2026-10-10'))
 where slug = 'strongback-mobility' and freight_terms is null;
update public.manufacturer_meta set freight_terms = '{"summary": "Volume pricing applies to the combined quantity of an item across its sizes. Freight is calculated and confirmed by HCPS on your order (Ovation''s standard shipping terms — update here if free-freight thresholds apply).", "actualNote": "Freight is confirmed by HCPS on your order confirmation.", "groups": [], "elseActual": true}'::jsonb || jsonb_build_object('trace', jsonb_build_object('decision_id',(select id from public.mfr_decisions where manufacturer='ovation-medical' and kind='freight_terms' order by id limit 1),'carried_from','manufacturers.json 2026-10-10'))
 where slug = 'ovation-medical' and freight_terms is null;
update public.manufacturer_meta set freight_terms = '{"summary": "Prepaid freight on orders of $500 or more; $40 shipping & handling on orders under $500.", "actualNote": "", "groups": [{"label": "All Bemis items", "brandKeywords": ["*"], "freeAt": 500, "flatUnder": 40, "freeLabel": "Prepaid freight", "flatLabel": "shipping & handling"}], "elseActual": false}'::jsonb || jsonb_build_object('trace', jsonb_build_object('source_id',(select id from public.mfr_sources where manufacturer='bemis' and kind='terms' order by id limit 1),'decision_id',(select id from public.mfr_decisions where manufacturer='bemis' and kind='freight_terms' order by id limit 1),'carried_from','manufacturers.json 2026-10-10'))
 where slug = 'bemis' and freight_terms is null;

commit;

-- ---------------------------------------------------------------------------------------------
-- CHECK (read-only, one result table). Review each row; the values are what was recorded.
select * from (
  select 1 as n, 'source: ' || manufacturer || ' / ' || kind as item,
         title || ' | received ' || coalesce(received_date::text, 'not recorded (legacy)') || ' | effective ' ||
         case effective_date_status when 'stated' then manufacturer_effective_date::text else effective_date_status end || ' | ' || status as value
    from public.mfr_sources
  union all
  select 2, 'records: ' || manufacturer,
         count(*) || ' records, ' || count(source_id) || ' with source, ' || count(dealer_unit_cost) || ' with unit cost, ' ||
         count(msrp_basis) || ' msrp_basis, ' || count(map_basis) || ' map_basis'
    from public.product_skus where manufacturer in ('climbing-steps','strongback-mobility','ovation-medical','bemis') group by manufacturer
  union all
  select 3, 'decisions: ' || manufacturer, string_agg(kind || ' ' || n, ', ' order by kind)
    from (select manufacturer, kind, count(*) n from public.mfr_decisions group by 1, 2) d group by manufacturer
  union all
  select 4, 'line: ' || slug, 'frozen=' || frozen || ', deferrals=' || jsonb_array_length(deferrals) || ', freight trace=' || coalesce((freight_terms->'trace')::text, 'none')
    from public.manufacturer_meta where slug in ('climbing-steps','strongback-mobility','ovation-medical','bemis')
  union all
  select 5, 'bemis as received: ' || code, 'case qty ' || coalesce(parsed_case_qty::text, '—') || ', unit cost ' || coalesce(parsed_unit_cost::text, '—') || ', source ' || coalesce(source_id::text, 'NONE')
    from public.price_imports where manufacturer = 'bemis' and import_label = 'bemis-2026-received-2026-10-10'
) x order by n, item;
