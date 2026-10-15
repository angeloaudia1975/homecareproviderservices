'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '../src/admin/dealer.html'), 'utf8');
const start = html.indexOf('// Keep feedback visible even when the CRM cards re-render');
const end = html.indexOf('/* ── Cross-sell:', start);
assert.ok(start > 0 && end > start, 'touch notification code is located');
const feedbackCode = html.slice(start, end);

function fixture(response = {ok:true}) {
  const elements = {};
  const mk = attrs => Object.assign({
    value:'',textContent:'',style:{},disabled:false,isConnected:true,
    setAttribute(k,v){this.attrs=this.attrs||{};this.attrs[k]=v;},
    classList:{active:new Set(),add(c){this.active.add(c)},remove(c){this.active.delete(c)}},
    focus(){this.focused=true;}
  }, attrs);
  for (const id of ['la_kind','la_sum','la_det','la_fu','la_futitle','la_fudue','la_submit','la_msg']) elements[id]=mk({});
  elements.la_kind.value='call';
  elements.la_sum.value='Discussed delivery date';
  elements.la_det.value='Customer requested an update';
  elements.la_submit.textContent='Log activity';

  const sent=[]; let reloaded=0;let request=()=>Promise.resolve(response);let refresh=async()=>{};
  const document={
    getElementById(id){return elements[id]||null},
    createElement(){return mk({id:null})},
    body:{appendChild(el){elements[el.id]=el}}
  };
  const ctx=vm.createContext({
    document, $:selector=>elements[selector.slice(1)]||null,
    setTimeout:()=>1, clearTimeout:()=>{},
    CUR:'dealer-a',
    crm:body=>{sent.push(body);return request(body);},
    loadCRM:async()=>{reloaded++;return refresh()}
  });
  vm.runInContext(feedbackCode+'\nthis.API={logActivity, saving:()=>TOUCH_SAVING, notice:()=>TOUCH_LAST_STATUS};',ctx);
  return {
    elements, sent, api:ctx.API, get reloaded(){return reloaded},
    setResponse(fn){request=fn},
    setReload(fn){refresh=fn},
    toast(){return elements['touch-toast']}
  };
}

test('Dealer 360 exposes a visible accessible status beside Log Activity button',()=>{
  assert.match(html, /id="la_submit"[^>]*onclick="logActivity\(\)"/);
  assert.match(html, /id="la_msg"[^>]*role="status"[^>]*aria-live="polite"/);
  assert.match(html, /\$\{esc\(TOUCH_LAST_STATUS\)\}/);
  assert.doesNotMatch(html,/toast&&toast\("Enter what happened"\)/);
});

test('empty summary shows error and focuses input without making a request',async()=>{
  const x=fixture();x.elements.la_sum.value='   ';
  await x.api.logActivity();
  assert.equal(x.sent.length,0);
  assert.equal(x.elements.la_sum.focused,true);
  assert.match(x.elements.la_msg.textContent,/Enter what happened/);
  assert.equal(x.toast().attrs.role,'alert');
});

test('click shows Saving and blocks repeated submits until response',async()=>{
  const x=fixture();let resolve;
  x.setResponse(()=>new Promise(r=>{resolve=r}));
  const pending=x.api.logActivity();
  assert.equal(x.elements.la_submit.disabled,true);
  assert.equal(x.elements.la_submit.textContent,'Saving…');
  assert.equal(x.elements.la_msg.textContent,'Saving activity…');
  assert.equal(x.toast().textContent,'Saving activity…');
  assert.equal(x.sent.length,1);
  await x.api.logActivity();
  assert.equal(x.sent.length,1,'double clicks do not generate duplicate writes');
  resolve({ok:true});await pending;
  assert.equal(x.elements.la_submit.disabled,false);
  assert.equal(x.reloaded,1);
  assert.equal(x.sent[0].kind,'call');
  assert.equal(x.sent[0].summary,'Discussed delivery date');
  assert.equal(x.sent[0].detail,'Customer requested an update');
  assert.match(x.elements.la_msg.textContent,/Call logged successfully/);
  assert.equal(x.toast().attrs.role,'status');
  assert.equal(x.toast().classList.active.has('show'),true);
});

test('failed response keeps form and prevents false success or timeline refresh',async()=>{
  const x=fixture({ok:false,error:'save_failed'});
  await x.api.logActivity();
  assert.equal(x.reloaded,0);
  assert.equal(x.elements.la_sum.value,'Discussed delivery date');
  assert.equal(x.elements.la_det.value,'Customer requested an update');
  assert.equal(x.elements.la_submit.disabled,false);
  assert.match(x.elements.la_msg.textContent,/Check the timeline before retrying/);
  assert.equal(x.toast().attrs.role,'alert');
  assert.doesNotMatch(x.api.notice(),/successfully/);
});

test('network failure preserves text and allows manual retry',async()=>{
  const x=fixture();x.setResponse(async()=>{throw Error('offline')});
  await x.api.logActivity();
  assert.equal(x.reloaded,0);
  assert.equal(x.elements.la_sum.value,'Discussed delivery date');
  assert.equal(x.api.saving(),false);
  x.setResponse(async()=>({ok:true}));
  await x.api.logActivity();
  assert.equal(x.sent.length,2);
  assert.equal(x.reloaded,1);
});

test('follow-up task fields are sent only when checked and success is truthful',async()=>{
  const x=fixture({ok:true,task:{id:'task1'}});
  x.elements.la_fu.checked=true;
  x.elements.la_futitle.value='Call Thursday';
  x.elements.la_fudue.value='2026-10-22';
  await x.api.logActivity();
  assert.equal(x.sent[0].followup_title,'Call Thursday');
  assert.equal(x.sent[0].followup_due,'2026-10-22');
  assert.match(x.api.notice(),/follow-up task created/);
});

test('save stays confirmed even when refreshing CRM view throws',async()=>{
  const x=fixture({ok:true});
  x.setReload(async()=>{throw Error('timeline temporarily unavailable')});
  await x.api.logActivity();
  assert.equal(x.reloaded,1);
  assert.match(x.api.notice(),/Call logged successfully/);
  assert.match(x.api.notice(),/Refresh the timeline/);
  assert.equal(x.toast().attrs.role,'status');
  assert.doesNotMatch(x.api.notice(),/Couldn't confirm/);
});

test('switching dealers clears prior-account confirmation',()=>{
  assert.match(html, /if\(CUR!==d\.id\) TOUCH_LAST_STATUS=""/);
});

test('dealer 360 boot restores the current dealer and starts all loaders',()=>{
  const marker='if(CUR!==d.id) TOUCH_LAST_STATUS=""';
  const at=html.indexOf(marker);
  assert.ok(at>0,'account-switch status reset is present');
  const line=html.slice(html.lastIndexOf('\n',at)+1,html.indexOf('\n',at));
  assert.equal(line.includes(String.fromCharCode(92)+'n'),false, 'no escaped newline hidden inside JS comment');
  assert.match(line,/TOUCH_LAST_STATUS="";/, 'dealer status reset is a complete statement');
  const next=html.slice(html.indexOf('\n',at)+1).split('\n')[0];
  assert.match(next,/^\s*CUR=d\.id;\s*DPHONE=d\.phone\|\|"";/, 'dealer ID and phone initialized on executable line');
  for(const fn of ['loadCRM','loadIntel','loadContacts','loadSales','loadEmails','loadVisits','loadHandout','loadMfrIntel']){
    assert.ok(next.includes(fn+'()'),fn+' invoked after selecting a dealer');
  }
});

test('touch feedback code compiles as an inline browser script',()=>{
  const all=html.match(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)||[];
  assert.ok(all.length>=1);
  for(const block of all){
    const source=block.slice(block.indexOf('>')+1,-9);
    new vm.Script(source);
  }
});