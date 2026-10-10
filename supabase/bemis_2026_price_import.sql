-- Bemis Digital Price List 2026, AS RECEIVED (agreed 2026-10-10, Bemis Manufacturer Center pilot).
-- price_imports is the audit trail of manufacturer price lists exactly as received; the shop never reads it.
-- It is where this pilot keeps what product_skus has no column for:
--   * received date 2026-10-10 (HCPS received the file) -- NOT the manufacturer effective date;
--   * effective_date stays NULL until Bemis confirms one in writing;
--   * "Dealer Cost Per Unit" and "Master Case Qty" exactly as Bemis wrote them, in raw.
-- base_price = Dealer Master Case Cost where Bemis gives one, else Dealer Cost Per Unit (Steadfast, 444DISPLAY).
-- Nothing here changes a price: product_skus was staged from the same file through catalog-api.
-- Re-running is safe: an existing (manufacturer, import_label, code) row is left untouched.

do $$ begin
  if to_regclass('public.price_imports') is null then
    raise exception 'public.price_imports does not exist - run migrate-phase2-product-skus.sql section 2 first. Nothing was written.';
  end if;
end $$;

insert into public.price_imports
  (manufacturer, import_label, source_file, effective_date, imported_by,
   code, description, base_price, msrp, map, tiers, raw)
values
  ('bemis', 'bemis-2026-received-2026-10-10', 'Bemis Digital Price List 2026(20261010-175622).xlsx', null, 'president',
   '7YR05310TSS', 'Assurance Round Toilet Seat with Clean Shield, Raised 3" with Stay-Tite Installation System, 1000 LB Seat Capacity,  SUPPORT ARMS SOLD SEPERATELY', 109.98, 109.99, 109.99, null,
   $j${"Model Number": "7YR05310TSS", "Item Description": "Assurance Round Toilet Seat with Clean Shield, Raised 3\" with Stay-Tite Installation System, 1000 LB Seat Capacity,  SUPPORT ARMS SOLD SEPERATELY", "Dealer Cost Per Unit": 64.99, "Master Case Qty": "2/CS", "Dealer Master Case Cost": 109.98, "MSRP": 109.99, "MAP": 109.99, "_received_date": "2026-10-10", "_manufacturer_effective_date": "pending Bemis confirmation", "_sheet": "Sheet1"}$j$::jsonb),
  ('bemis', 'bemis-2026-received-2026-10-10', 'Bemis Digital Price List 2026(20261010-175622).xlsx', null, 'president',
   '7YE05310TSS', 'Assurance Elongated Toilet Seat with Clean Shield, Raised 3" with Stay-Tite Installation System, 1000 LB Seat Capacity, SUPPORT ARMS SOLD SEPERATELY', 109.98, 109.99, 109.99, null,
   $j${"Model Number": "7YE05310TSS", "Item Description": "Assurance Elongated Toilet Seat with Clean Shield, Raised 3\" with Stay-Tite Installation System, 1000 LB Seat Capacity, SUPPORT ARMS SOLD SEPERATELY", "Dealer Cost Per Unit": 64.99, "Master Case Qty": "2/CS", "Dealer Master Case Cost": 109.98, "MSRP": 109.99, "MAP": 109.99, "_received_date": "2026-10-10", "_manufacturer_effective_date": "pending Bemis confirmation", "_sheet": "Sheet1"}$j$::jsonb),
  ('bemis', 'bemis-2026-received-2026-10-10', 'Bemis Digital Price List 2026(20261010-175622).xlsx', null, 'president',
   '7YA05313GRY', 'Assurance Support Arms Only SET/2, 350 LB Capacity Each Arm, Gray Color Frame with White Grips', 119.96, 59.99, 59.99, null,
   $j${"Model Number": "7YA05313GRY", "Item Description": "Assurance Support Arms Only SET/2, 350 LB Capacity Each Arm, Gray Color Frame with White Grips", "Dealer Cost Per Unit": 39.99, "Master Case Qty": "4/CS", "Dealer Master Case Cost": 119.96, "MSRP": 59.99, "MAP": 59.99, "_received_date": "2026-10-10", "_manufacturer_effective_date": "pending Bemis confirmation", "_sheet": "Sheet1"}$j$::jsonb),
  ('bemis', 'bemis-2026-received-2026-10-10', 'Bemis Digital Price List 2026(20261010-175622).xlsx', null, 'president',
   '7YA05313BLK', 'Assurance Support Arms Only SET/2, 350 LB Capacity Each Arm, Black Color Frame with White Grips', 119.96, 59.99, 59.99, null,
   $j${"Model Number": "7YA05313BLK", "Item Description": "Assurance Support Arms Only SET/2, 350 LB Capacity Each Arm, Black Color Frame with White Grips", "Dealer Cost Per Unit": 39.99, "Master Case Qty": "4/CS", "Dealer Master Case Cost": 119.96, "MSRP": 59.99, "MAP": 59.99, "_received_date": "2026-10-10", "_manufacturer_effective_date": "pending Bemis confirmation", "_sheet": "Sheet1"}$j$::jsonb),
  ('bemis', 'bemis-2026-received-2026-10-10', 'Bemis Digital Price List 2026(20261010-175622).xlsx', null, 'president',
   '7YA06303TWA', 'Assurance Personal Wash Bidet attachment Only exclusivly for the Assurance Toilet Seat', 74.98, 74.99, 74.99, null,
   $j${"Model Number": "7YA06303TWA", "Item Description": "Assurance Personal Wash Bidet attachment Only exclusivly for the Assurance Toilet Seat", "Dealer Cost Per Unit": 47.49, "Master Case Qty": "2/CS", "Dealer Master Case Cost": 74.98, "MSRP": 74.99, "MAP": 74.99, "_received_date": "2026-10-10", "_manufacturer_effective_date": "pending Bemis confirmation", "_sheet": "Sheet1"}$j$::jsonb),
  ('bemis', 'bemis-2026-received-2026-10-10', 'Bemis Digital Price List 2026(20261010-175622).xlsx', null, 'president',
   '7YA04505T', 'Rise 4.5" Raised Toilet Seat with Arms and w/Dual Lock Security, adjustable base fits both round and elongated toilets, 300 LB Capacity', 119.97, 79.99, 79.99, null,
   $j${"Model Number": "7YA04505T", "Item Description": "Rise 4.5\" Raised Toilet Seat with Arms and w/Dual Lock Security, adjustable base fits both round and elongated toilets, 300 LB Capacity ", "Dealer Cost Per Unit": 49.99, "Master Case Qty": "3/CS", "Dealer Master Case Cost": 119.97, "MSRP": 79.99, "MAP": 79.99, "_received_date": "2026-10-10", "_manufacturer_effective_date": "pending Bemis confirmation", "_sheet": "Sheet1"}$j$::jsonb),
  ('bemis', 'bemis-2026-received-2026-10-10', 'Bemis Digital Price List 2026(20261010-175622).xlsx', null, 'president',
   '7YA0AS100', 'Assist Non-Elevated Premium Toilet Seat with Arms and Stay Tite Installation, 500 LB Capacity', 99.98, 99.99, 99.99, null,
   $j${"Model Number": "7YA0AS100", "Item Description": "Assist Non-Elevated Premium Toilet Seat with Arms and Stay Tite Installation, 500 LB Capacity", "Dealer Cost Per Unit": 59.99, "Master Case Qty": "2/CS", "Dealer Master Case Cost": 99.98, "MSRP": 99.99, "MAP": 99.99, "_received_date": "2026-10-10", "_manufacturer_effective_date": "pending Bemis confirmation", "_sheet": "Sheet1"}$j$::jsonb),
  ('bemis', 'bemis-2026-received-2026-10-10', 'Bemis Digital Price List 2026(20261010-175622).xlsx', null, 'president',
   '7YE82350TC', 'Steadfast Elongated 3" Raised Toilet Seat, Open Front Ring with Stay Tite Installation System', 54.99, 109.99, 109.99, null,
   $j${"Model Number": "7YE82350TC", "Item Description": "Steadfast Elongated 3\" Raised Toilet Seat, Open Front Ring with Stay Tite Installation System", "Dealer Cost Per Unit": 54.99, "Master Case Qty": null, "Dealer Master Case Cost": null, "MSRP": 109.99, "MAP": 109.99, "_received_date": "2026-10-10", "_manufacturer_effective_date": "pending Bemis confirmation", "_sheet": "Sheet1"}$j$::jsonb),
  ('bemis', 'bemis-2026-received-2026-10-10', 'Bemis Digital Price List 2026(20261010-175622).xlsx', null, 'president',
   '444DISPLAY', '4 Assurance Round seats, 4 Elongated seats, 4 Support Arm sets (gray), and 2 Bidet attachments, plus the floor base display and a display toilet.', 634.86, 1269.72, 1269.72, null,
   $j${"Model Number": "444DISPLAY", "Item Description": "4 Assurance Round seats, 4 Elongated seats, 4 Support Arm sets (gray), and 2 Bidet attachments, plus the floor base display and a display toilet.", "Dealer Cost Per Unit": 634.86, "Master Case Qty": null, "Dealer Master Case Cost": null, "MSRP": 1269.72, "MAP": 1269.72, "_received_date": "2026-10-10", "_manufacturer_effective_date": "pending Bemis confirmation", "_sheet": "Sheet1"}$j$::jsonb)
on conflict do nothing;

-- Check: 9 rows, effective_date null, received date and Bemis unit cost kept as written.
select code, base_price, msrp, map, effective_date,
       raw->>'Dealer Cost Per Unit' as bemis_unit_cost, raw->>'Master Case Qty' as bemis_case_qty,
       raw->>'_received_date' as received
from public.price_imports
where manufacturer='bemis' and import_label='bemis-2026-received-2026-10-10'
order by code;
