-- Bemis 2026 price list: HCPS decisions recorded beside the file AS RECEIVED (Angelo, 2026-10-10).
-- Annotations only (keys starting "_hcps_"); Bemis's own columns in raw are never edited.
-- 1. Accepted by HCPS as the current 2026 Bemis price list; manufacturer effective date pending.
-- 2. 7YE82350TC and 444DISPLAY are NOT case items: the 2026 list prices each as a single unit.
--    Each / 1 and Display / 1. Not "missing" a case quantity. A later Bemis source giving a pack
--    quantity for either is a source change that Manufacturer Center flags.

update public.price_imports
   set raw = raw || jsonb_build_object(
         '_hcps_source_status', 'accepted by HCPS 2026-10-10 as the current 2026 Bemis price list; manufacturer effective date pending')
 where manufacturer='bemis' and import_label='bemis-2026-received-2026-10-10';

update public.price_imports
   set raw = raw || jsonb_build_object('_hcps_uom',
         case code when '7YE82350TC' then 'Each / case_qty 1 - sold individually as listed (not a case item)'
                   when '444DISPLAY' then 'Display / case_qty 1 - one orderable display as listed (not a case item)' end)
 where manufacturer='bemis' and import_label='bemis-2026-received-2026-10-10'
   and code in ('7YE82350TC','444DISPLAY');

-- Check: 9 rows carry the source status; exactly 2 carry a UOM note.
select code, effective_date, raw->>'Master Case Qty' as bemis_case_qty,
       raw->>'_hcps_uom' as hcps_uom, raw->>'_hcps_source_status' as source_status
from public.price_imports
where manufacturer='bemis' and import_label='bemis-2026-received-2026-10-10'
order by code;
