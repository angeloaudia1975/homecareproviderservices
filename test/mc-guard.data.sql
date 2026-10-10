-- test/mc-guard.pg.test.js, step 2 (after migrate-phase2-product-skus.sql): four frozen-to-be lines in miniature.
insert into manufacturer_meta(slug,record_authoritative) values ('climbing-steps',true),('strongback-mobility',true),('ovation-medical',true),('bemis',true),('pedifix',false);
insert into product_skus(manufacturer,code,base_price,msrp,map,msrp_auto,status,uom,case_qty,source_file,effective_date) values
 ('bemis','7YR05310TSS',109.98,109.99,109.99,false,'active','Case',2,'Bemis Digital Price List 2026(20261010-175622).xlsx',null),
 ('bemis','7YE82350TC',54.99,109.99,109.99,false,'active','Each',1,'Bemis Digital Price List 2026(20261010-175622).xlsx',null),
 ('bemis','DO5300RD444',null,null,null,false,'discontinued',null,null,null,null),
 ('strongback-mobility','A1005',50,null,24.95,false,'active','4-pack',4,'Strongback Mobility · Dealer Pricing 2026 V2.pdf','2026-08-27'),
 ('strongback-mobility','1003AB',527,null,889,false,'active','Each',1,'Strongback Mobility · Dealer Pricing 2026 V2.pdf','2026-08-27'),
 ('ovation-medical','61000-210',139.95,279.9,null,false,'active','10-pack',10,'2026 ovation medical pricelist 1092026.xlsx','2026-10-09'),
 ('climbing-steps','FCOM-02',1399.99,4499.99,1999.99,false,'active',null,null,'cs.xlsx',null),
 ('climbing-steps','FCOM-03',1399.99,4499.99,1999.99,false,'active',null,null,'cs.xlsx','2026-01-01');
insert into price_imports(manufacturer,import_label,source_file,code,base_price,msrp,map,raw) values
 ('bemis','bemis-2026-received-2026-10-10','f','7YR05310TSS',109.98,109.99,109.99,'{"Dealer Cost Per Unit":64.99,"Master Case Qty":"2/CS"}'),
 ('bemis','bemis-2026-received-2026-10-10','f','7YE82350TC',54.99,109.99,109.99,'{"Dealer Cost Per Unit":54.99,"Master Case Qty":null}');
insert into product_overrides values ('bemis','7YR05310TSS','{"base_price":109.98,"image":"a.jpg"}',now());
insert into custom_products(manufacturer,code,name,base_price,msrp,map,active) values ('bemis','444DISPLAY','Display',634.86,1269.72,1269.72,true),('pedifix','P1','x',5,10,null,true);
