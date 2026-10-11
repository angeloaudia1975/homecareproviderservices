/* Manufacturer Center Phase 6 CORRECTION (approved 2026-10-11) — Match & decide on the LIVE shape of the four
   frozen lines. On production, Match proposed every Bemis SKU active → "HOLD" (fee exceptions #10/#11 read as a
   product status), the pack-only MSRP/MAP basis (#8, "items with a Master Case Qty") on the two single items,
   and "not in source, needs a decision" for every SKU of Climbing Steps, Strongback and Ovation (legacy sources
   registered without row-level price_imports). These tests use the live wording of all 15 decisions
   (test/fixtures/mc-live-frozen.json) and Bemis's price list rows (test/fixtures/bemis-copy.json):
     · decisions are field-scoped: a decision changes only the product field it names (with its partner);
     · a pack-only rule follows the structured case quantity, whatever its sentence says;
     · a legacy source without stored rows is labelled, never a fake decision queue;
     · and through catalog-api, Match on frozen Bemis- and legacy-shaped lines proposes no dealer-facing change,
       writes nothing, and every workflow write is still refused (423 line_frozen). */
const {M,ROOT,MC,L,fx,norm,clone,PACKS,SINGLES,LEGACY,bemisRows,bemisMatch,legacyRecords,world,mod,call}=require('./mcmatch.world.js');
let fail=0, pass=0;
async function t(name,fn){ try{ await fn(); pass++; console.log('ok   '+name); }catch(e){ fail++; console.log('FAIL '+name+'\n     '+(e&&e.message||e)); } }
const eq=(a,b,w)=>{ if(JSON.stringify(a)!==JSON.stringify(b)) throw new Error((w||'')+' got '+JSON.stringify(a)+' expected '+JSON.stringify(b)); };
const ok=(c,w)=>{ if(!c) throw new Error(w); };
(async()=>{
await t('the live fixture holds all 15 production decisions with their exact wording',async()=>{
  eq(Object.values(L.decisions).reduce((n,a)=>n+a.length,0),15);
  eq(L.decisions.bemis.map(d=>d.id),[1,2,3,4,5,6,7,8,9,10,11,12]);
  eq(L.decisions.bemis.find(d=>d.id===11).hcps_value,{status:'HOLD'}); eq(L.decisions.bemis.find(d=>d.id===8).hcps_value.applies_to,'items with a Master Case Qty');
});

for(const parsed of [false,true]){
await t(`Bemis (case qty ${parsed?'parsed at import':'read from raw'}): 9 current SKUs, no false "HOLD", no pack basis on the singles, no change proposed`,async()=>{
  const m=bemisMatch(parsed), row=c=>m.rows.find(r=>r.code===c);
  eq(m.rows.filter(r=>r.source).length,9,'9 current SKUs in the source'); eq(L.bemis_records.filter(r=>r.status==='active').length,9,'9 active records');
  eq(m.rows.filter(r=>'status' in r.hcps||r.diffs.some(d=>d.field==='status')).map(r=>r.code),[],'no status proposed from a fee exception');
  for(const c of SINGLES){ ok(!('msrp_basis' in row(c).hcps)&&!('map_basis' in row(c).hcps),c+' gets no pack basis'); ok(row(c).decision_ids.indexOf(8)<0,c+' not covered by #8'); }
  for(const c of PACKS){ eq([row(c).hcps.msrp_basis,row(c).hcps.map_basis],['each','each'],c+' case item gets MSRP/MAP each'); ok(row(c).decision_ids.indexOf(8)>=0,c+' covered by #8'); }
  eq([row('7YE82350TC').hcps,row('444DISPLAY').hcps],[{uom:'Each',case_qty:1},{uom:'Display',case_qty:1}],'their own order-unit decisions (#6, #7)');
  eq([row('7YR05310TSS').hcps.base_price,row('7YE05310TSS').hcps.base_price,row('7YA0AS100').hcps.base_price],[109.98,109.98,99.98],'the 1-cent conflicts (#3–#5)');
  eq(m.rows.map(r=>r.diffs).flat(),[],'nothing differs from the Gold Standard record');
  eq([m.summary.new,m.summary.changes,m.summary.same,m.summary.retired,m.summary.not_in_source,m.summary.needs_decision,m.summary.proposed_changes,m.summary.comparison],[0,0,9,1,0,0,0,'available']);
  eq(m.blocked,[],'no fake decision queue'); eq(m.unapplied,[],'every line-wide decision understood');
  ok(m.stage_rows.every(p=>{ const r=L.bemis_records.find(x=>x.code===p.code); return ['base_price','msrp','map','uom','case_qty','dealer_unit_cost','msrp_basis','map_basis'].every(f=>!(f in p)||String(p[f])===String(r[f])); }),'every proposed value equals the record');
});
}

await t('field-scoped: fee, freight, deferral and acceptance decisions never touch a SKU; a nested "status" describes its decision',async()=>{
  const D=L.decisions.bemis, by=id=>D.find(d=>d.id===id);
  for(const id of [1,2,9,10,11,12]) eq(MC.decisionValues(by(id)),null,'#'+id+' ('+by(id).field+') changes no product field');
  eq(MC.decisionValues(by(3)),{base_price:109.98},'#3 gives its base_price, never its "previous"');
  eq(MC.decisionValues(by(6)),{uom:'Each',case_qty:1}); eq(MC.decisionValues(by(8)),{msrp_basis:'each',map_basis:'each'},'#8 gives the basis pair, never applies_to');
  /* a decision whose FIELD is status does set it */
  const st={id:90,kind:'exception',field:'status',code:'7YA0AS100',decided_at:'2026-10-11T00:00:00Z',hcps_value:{status:'discontinued',status_note:'withdrawn by Bemis'}};
  eq(MC.interpretationFor('7YA0AS100',D.concat([st]),norm,{caseQty:2}).values.status,'discontinued','a status decision applies');
  /* keys outside the named field are ignored, not merged */
  eq(MC.decisionValues({field:'uom',hcps_value:{uom:'Case',msrp_basis:'each',status:'HOLD',base_price:1}}),{uom:'Case'});
  eq(MC.decisionValues({field:'tiers',hcps_value:[{min:6,price:5}]}),{tiers:[{min:6,price:5}]},'a plain value is the named field');
  eq(MC.decisionValues({field:'base_price',hcps_value:12.5}),{base_price:12.5});
  eq(MC.decisionValues({field:'',hcps_value:{uom:'Case'}}),null,'no field, no change');
});

await t('basis applicability follows the structured case quantity; "packs" still works; unknown wording is not guessed',async()=>{
  const d8=L.decisions.bemis.find(d=>d.id===8), pk=Object.assign(clone(d8),{id:81,hcps_value:{msrp_basis:'each',map_basis:'each',applies_to:'packs'}});
  for(const d of [d8,pk]){
    eq(MC.interpretationFor('X',[d],norm,{caseQty:2}).values,{msrp_basis:'each',map_basis:'each'},(d.hcps_value.applies_to)+': a 2/CS item');
    eq(MC.interpretationFor('X',[d],norm,{caseQty:1}).values,{},(d.hcps_value.applies_to)+': a single');
    eq(MC.interpretationFor('X',[d],norm,{caseQty:null}).values,{},(d.hcps_value.applies_to)+': no case quantity');
  }
  eq(MC.appliesTo({hcps_value:{applies_to:'case items'}}),'packs'); eq(MC.appliesTo({hcps_value:{}}),'all'); eq(MC.appliesTo({hcps_value:{applies_to:'all'}}),'all');
  const odd=Object.assign(clone(d8),{id:82,hcps_value:{msrp_basis:'each',map_basis:'each',applies_to:'gray finishes only'}});
  const r=MC.interpretationFor('X',[odd],norm,{caseQty:2}); eq([r.values,r.unapplied.map(u=>u.id)],[{},[82]],'not applied, and listed as not applied');
  const m=bemisMatch(false,clone(L.decisions.bemis).concat([odd])); eq(m.unapplied.map(u=>u.id),[82],'Match lists it');
  /* a SKU's own order-unit decision decides whether it is a pack before a pack-only rule is judged */
  const single={id:83,kind:'interpretation',field:'uom',code:'X',decided_at:'2026-10-10T19:00:00Z',hcps_value:{uom:'Each',case_qty:1}};
  eq(MC.interpretationFor('X',[d8,single],norm,{caseQty:2}).values,{uom:'Each',case_qty:1},'a source "2/CS" overruled to Each/1 is not a pack');
  eq(MC.interpretationFor('X',[d8],norm,true).values.msrp_basis,'each','the old boolean form still works');
});

await t('a real difference is still proposed and counted; a SKU\'s own decision beats a line-wide one',async()=>{
  const recs=clone(L.bemis_records); recs.find(r=>r.code==='7YA04505T').base_price=118.5;
  const m=MC.matchLine({sourceRows:bemisRows(false),records:recs,storefrontCodes:[],decisions:clone(L.decisions.bemis),normCode:norm,source:L.sources.bemis[0]});
  eq([m.summary.changes,m.summary.proposed_changes,m.rows.find(r=>r.code==='7YA04505T').diffs],[1,1,[{field:'base_price',record:118.5,proposed:119.97}]]);
  const n=MC.matchLine({sourceRows:bemisRows(false).filter(r=>r.code==='7YA04505T'),records:[],storefrontCodes:[],decisions:clone(L.decisions.bemis).concat([{id:91,kind:'interpretation',field:'uom',code:null,decided_at:'2026-10-11T00:00:00Z',hcps_value:{uom:'Case'}}]),normCode:norm,source:L.sources.bemis[0]});
  eq([n.summary.new,n.summary.proposed_changes],[1,1],'a new SKU is a proposed change');
  const line={id:92,kind:'interpretation',field:'uom',code:null,decided_at:'2026-10-11T00:00:00Z',hcps_value:{uom:'Case'}};
  eq(MC.interpretationFor('7YE82350TC',clone(L.decisions.bemis).concat([line]),norm,{caseQty:null}).values.uom,'Each','#6 (the SKU) beats a newer line-wide rule');
});
for(const slug of LEGACY){
await t(`${slug}: an accepted legacy source without stored rows is labelled — no "not in source", no decision queue`,async()=>{
  const recs=legacyRecords(slug), R=L.legacy_records[slug], src=L.sources[slug][L.sources[slug].length-1];
  ok(src.legacy===true,'the live source is legacy');
  const m=MC.matchLine({sourceRows:[],records:recs,storefrontCodes:recs.map(r=>r.code),decisions:clone(L.decisions[slug]),normCode:norm,source:src});
  eq(m.comparison,{available:false,reason:'legacy_rows_not_stored',message:'Accepted legacy source — row-level source data not stored; Match comparison unavailable.'});
  eq([m.summary.not_in_source,m.summary.needs_decision,m.summary.ready_to_stage,m.summary.proposed_changes,m.summary.changes,m.summary.new],[0,0,0,0,0,0]);
  eq([m.summary.not_compared,m.summary.retired,m.summary.records],[R.by_status.active,R.count-R.by_status.active,R.count]);
  eq([m.blocked,m.stage_rows],[[],[]]); ok(m.rows.every(r=>!r.needs_decision.length&&!r.diffs.length),'no row asks for a decision');
});
}
await t('only a LEGACY source gets the label: a current source whose rows are missing still asks what happens to each SKU',async()=>{
  const recs=legacyRecords('strongback-mobility'), src=Object.assign(clone(L.sources['strongback-mobility'][0]),{legacy:false});
  const m=MC.matchLine({sourceRows:[],records:recs,storefrontCodes:[],decisions:[],normCode:norm,source:src});
  eq([m.comparison.available,m.summary.not_in_source,m.summary.needs_decision],[true,14,14]);
  const m2=MC.matchLine({sourceRows:[{code:'1003AB',base_price:10,raw:{}}],records:recs,storefrontCodes:[],decisions:[],normCode:norm,source:L.sources['strongback-mobility'][0]});
  eq(m2.comparison.available,true,'a legacy source WITH stored rows is compared');
});
await t('a record that already names its order unit keeps it (staging keeps omitted fields); a new SKU still needs one',async()=>{
  const m=bemisMatch(false,clone(L.decisions.bemis).filter(d=>d.id!==6));
  eq(m.rows.find(r=>r.code==='7YE82350TC').needs_decision,[],'record says Each/1');
  const n=MC.matchLine({sourceRows:bemisRows(false).filter(r=>r.code==='7YA04505T'),records:[],storefrontCodes:[],decisions:clone(L.decisions.bemis),normCode:norm,source:L.sources.bemis[0]});
  eq(n.rows[0].needs_decision.map(x=>x.field),['uom'],'no record: the unit must be decided');
});

/* Through catalog-api, on frozen lines shaped exactly like production. */
const snap=W=>JSON.stringify(Object.keys(W.db).sort().map(k=>[k,W.db[k].map(r=>{ const x=Object.assign({},r); delete x.code_norm; return x; })]));
await t('catalog-api · Match on frozen Bemis (live decisions): no dealer-facing change proposed, nothing written',async()=>{
  const W=world(), C=mod(W), before=snap(W);
  const r=await call(C,{action:'mc_match',manufacturer:'bemis'}); eq(r.status,200,JSON.stringify(r.body).slice(0,300));
  eq([r.body.source.id,r.body.summary.changes,r.body.summary.new,r.body.summary.same,r.body.summary.needs_decision,r.body.summary.proposed_changes],[5,0,0,9,0,0]);
  eq(r.body.rows.filter(x=>x.diffs.length).map(x=>x.code),[]); eq(snap(W),before,'nothing written');
});
for(const slug of LEGACY){
await t(`catalog-api · Match on frozen ${slug}: labelled as a legacy source, no decision queue, nothing written`,async()=>{
  const W=world(), C=mod(W), before=snap(W);
  const r=await call(C,{action:'mc_match',manufacturer:slug}); eq(r.status,200,JSON.stringify(r.body).slice(0,300));
  eq([r.body.comparison.available,r.body.comparison.reason,r.body.summary.needs_decision,r.body.summary.not_in_source,r.body.summary.not_compared],[false,'legacy_rows_not_stored',0,0,L.legacy_records[slug].by_status.active]);
  eq(snap(W),before,'nothing written');
});
}
await t('frozen-line write protection unchanged: all 7 workflow writes refused on all 4 lines (28/28, even as dry runs)',async()=>{
  const W=world(), C=mod(W), before=snap(W); let refused=0;
  const acts=[{action:'mc_register_source',kind:'price_list',title:'probe',received_date:'2026-10-11',dry_run:true},{action:'mc_accept_source',source_id:5,dry_run:true},
    {action:'mc_import_source_rows',source_id:5,rows:[],dry_run:true},{action:'mc_approve_gate',gate:'stage',plan_hash:'x',plan_kind:'records',reason:'probe',dry_run:true},
    {action:'mc_set_freight_terms',terms:{freeAt:500},dry_run:true},{action:'stage_record_source',source_id:5,rows:[{code:'7YR05310TSS',base_price:1}],dry_run:true},{action:'set_record_authority',authoritative:false,dry_run:true}];
  for(const slug of Object.keys(L.fingerprints)) for(const a of acts){ const r=await call(C,Object.assign({manufacturer:slug},a)); if(r.status===423&&r.body.error==='line_frozen') refused++; }
  eq(refused,28); eq(snap(W),before,'nothing written');
});

console.log(`mc match on live frozen lines: ${pass} passed, ${fail} failed`); process.exit(fail?1:0);
})();
