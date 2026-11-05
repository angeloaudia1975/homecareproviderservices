// _golden_addresses.js — B7 (owner directive 2026-11-05): the Golden ACCOUNT NUMBER HCPS records is the pricing
// contract, and HCPS is the ship-to system of record for Golden orders placed in Partner 360.
//
//   accountFor(sbGet, dealerId)  the Golden account number of a location: its OWN active dealer_manufacturers row for
//                                Golden, else its head office's. → { ok:true, acct, owner } | { ok:false, reason }.
//                                owner = the HCPS dealer whose row holds the number (sent to Golden as sub_dealer).
//                                Two different numbers on one dealer = ambiguous → fail closed. Reads are strict.
//   locationsFor(sbGet, acct, {includeTest})  every HCPS location carrying that number: dealers whose own row holds
//                                it + their branches that carry no OTHER number of their own. Inactive dealers left
//                                out; TEST dealers only for a TEST viewer. Unrelated accounts never mix.
//   book(sbGet, acct, opts)      the shared address book: each location's business address (ref loc:<id>, read only),
//                                its existing HCPS ship-to rows (dealer_addresses addr_key ship-*, ref da:<id>:<key>,
//                                read only) and the account's saved Golden ship-to addresses (golden_ship_addresses,
//                                ref gs:<uuid>, dealers add / edit / remove them — no approval).
//   validate(input)              the SAME rules Golden applies to { hcps:{...} } (contract 1.8.0 §4i) — so a saved
//                                address is never one Golden would refuse.
//   goldenShipTo(entry)          the body HCPS sends Golden: { hcps:{ ref, name, address, address2, city, state, zip, phone } }.
//   shipId(entry)                Golden's id for that address (hcps- + 24 hex of SHA-256 over every field), so a place
//                                request can be checked against the address the dealer reviewed.
"use strict";
const crypto = require("crypto");

const GOLDEN_SLUGS = ["golden-technologies", "golden"];
const ACCT_RE = /^[A-Za-z0-9-]{1,20}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const REF_RE = /^(loc:[0-9a-f-]{36}|da:[0-9a-f-]{36}:[a-z0-9_-]{1,40}|gs:[0-9a-f-]{36})$/;
const US_STATES = new Set(("AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR "
  + "PA RI SC SD TN TX UT VT VA WA WV WI WY PR").split(" "));
const KEYS = ["ref", "name", "address", "address2", "city", "state", "zip", "phone"];
const enc = encodeURIComponent;
const normAcct = v => (v == null ? "" : String(v).trim());

async function readArr(sbGet, path){ const r = await sbGet(path); if(!Array.isArray(r)) throw new Error("unreadable"); return r; }

async function accountFor(sbGet, dealerId){
  if(!UUID_RE.test(String(dealerId))) return { ok:false, reason:"dealer_not_found" };
  const d = (await readArr(sbGet, `dealers?id=eq.${enc(dealerId)}&select=id,parent_id,is_test,active`))[0];
  if(!d) return { ok:false, reason:"dealer_not_found" };
  const ids = [d.id].concat(d.parent_id && UUID_RE.test(String(d.parent_id)) ? [d.parent_id] : []);
  const rows = await readArr(sbGet, `dealer_manufacturers?dealer_id=in.(${ids.join(",")})&manufacturer=in.(${GOLDEN_SLUGS.join(",")})&active=eq.true&select=dealer_id,account_ref`);
  for(const owner of ids){
    const nums = [...new Set(rows.filter(r => r.dealer_id === owner).map(r => normAcct(r.account_ref)).filter(Boolean))];
    if(nums.length > 1) return { ok:false, reason:"golden_account_ambiguous" };
    if(nums.length === 1){
      if(!ACCT_RE.test(nums[0])) return { ok:false, reason:"golden_account_invalid" };
      return { ok:true, acct: nums[0], owner, dealer: d };
    }
  }
  return { ok:false, reason:"no_golden_account" };
}

async function locationsFor(sbGet, acct, opts){
  opts = opts || {};
  // Recorded numbers may carry stray spaces: narrow with like, then compare the trimmed value exactly.
  const holders = await readArr(sbGet, `dealer_manufacturers?manufacturer=in.(${GOLDEN_SLUGS.join(",")})&active=eq.true&account_ref=like.*${enc(acct)}*&select=dealer_id,account_ref`);
  const holderIds = [...new Set(holders.filter(r => normAcct(r.account_ref) === acct).map(r => r.dealer_id).filter(x => UUID_RE.test(String(x))))];
  if(!holderIds.length) return [];
  const sel = "id,parent_id,business_name,address,city,state,zip,is_test,active";
  const [own, kids] = await Promise.all([
    readArr(sbGet, `dealers?id=in.(${holderIds.join(",")})&select=${sel}`),
    readArr(sbGet, `dealers?parent_id=in.(${holderIds.join(",")})&select=${sel}`),
  ]);
  // A branch with a Golden number of its own that is NOT this one belongs to that other account.
  const kidIds = kids.map(k => k.id).filter(x => UUID_RE.test(String(x)) && !holderIds.includes(x));
  let other = new Set();
  if(kidIds.length){
    const kr = await readArr(sbGet, `dealer_manufacturers?dealer_id=in.(${kidIds.join(",")})&manufacturer=in.(${GOLDEN_SLUGS.join(",")})&active=eq.true&select=dealer_id,account_ref`);
    other = new Set(kr.filter(r => normAcct(r.account_ref) && normAcct(r.account_ref) !== acct).map(r => r.dealer_id));
  }
  const seen = new Set(), out = [];
  for(const d of own.concat(kids)){
    if(!d || seen.has(d.id) || other.has(d.id)) continue;
    seen.add(d.id);
    if(d.active === false) continue;
    if(d.is_test === true && !opts.includeTest) continue;
    out.push(d);
  }
  return out;
}

const s = (v, n) => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, n) : "");

// Same rules as Golden's hcpsShipTo. → { ok:true, value } | { ok:false, field }
function validate(input){
  const i = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  for(const k of ["name","address","address2","city","state","zip","phone"]) if(i[k] != null && typeof i[k] !== "string") return { ok:false, field:k };
  const clean = k => (typeof i[k] === "string" ? i[k].replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim() : "");
  const v = { name: clean("name"), address: clean("address"), address2: clean("address2"), city: clean("city"), state: clean("state").toUpperCase(), zip: clean("zip"), phone: clean("phone") };
  if(/[<>]/.test(Object.values(v).join(""))) return { ok:false, field:"text" };
  if(v.name.length < 2 || v.name.length > 80) return { ok:false, field:"name" };
  if(v.address.length < 3 || v.address.length > 120) return { ok:false, field:"address" };
  if(v.address2.length > 80) return { ok:false, field:"address2" };
  if(v.city.length < 2 || v.city.length > 60) return { ok:false, field:"city" };
  if(!US_STATES.has(v.state)) return { ok:false, field:"state" };
  if(!/^\d{5}(-\d{4})?$/.test(v.zip)) return { ok:false, field:"zip" };
  const digits = v.phone.replace(/\D/g, "");
  if(v.phone && (!(digits.length === 10 || (digits.length === 11 && digits[0] === "1")) || v.phone.length > 30)) return { ok:false, field:"phone" };
  return { ok:true, value: v };
}

// A stored row → a book entry. A location / legacy address that does not meet Golden's rules is listed as unusable
// (usable:false + the field), never silently "fixed".
function entry(ref, source, raw, extra){
  const v = { name: s(raw.name, 200), address: s(raw.address, 200), address2: s(raw.address2, 200), city: s(raw.city, 200), state: s(raw.state, 10).toUpperCase(), zip: s(raw.zip, 20), phone: s(raw.phone, 40) };
  const chk = validate(v);
  return Object.assign({ ref, source, usable: chk.ok, problem: chk.ok ? null : chk.field }, chk.ok ? chk.value : v, extra || {});
}

async function book(sbGet, acct, opts){
  opts = opts || {};
  const locs = await locationsFor(sbGet, acct, opts);
  const ids = locs.map(l => l.id);
  const [das, saved] = await Promise.all([
    ids.length ? readArr(sbGet, `dealer_addresses?dealer_id=in.(${ids.join(",")})&addr_key=like.ship*&select=dealer_id,addr_key,label,address,city,state,zip`) : [],
    readArr(sbGet, `golden_ship_addresses?account_no=eq.${enc(acct)}&removed_at=is.null&select=id,name,address,address2,city,state,zip,phone,created_dealer,updated_at&order=created_at.asc&limit=200`),
  ]);
  const byId = Object.fromEntries(locs.map(l => [l.id, l]));
  const out = [];
  for(const l of locs) if(l.address) out.push(entry(`loc:${l.id}`, "location", { name: l.business_name, address: l.address, city: l.city, state: l.state, zip: l.zip }, { location: l.business_name || "" }));
  for(const a of das){
    if(!byId[a.dealer_id] || !/^[a-z0-9_-]{1,40}$/.test(String(a.addr_key))) continue;
    out.push(entry(`da:${a.dealer_id}:${a.addr_key}`, "location_ship_to", { name: a.label && a.label !== "Ship-to" ? a.label : byId[a.dealer_id].business_name, address: a.address, city: a.city, state: a.state, zip: a.zip }, { location: byId[a.dealer_id].business_name || "" }));
  }
  for(const g of saved) if(UUID_RE.test(String(g.id))) out.push(entry(`gs:${g.id}`, "saved", g, { editable: true, location: byId[g.created_dealer] ? byId[g.created_dealer].business_name || "" : "" }));
  return { locations: locs.map(l => ({ id: l.id, name: l.business_name || "", city: l.city || "", state: l.state || "" })), entries: out };
}

const goldenShipTo = e => ({ hcps: { ref: e.ref, name: e.name, address: e.address, address2: e.address2 || "", city: e.city, state: e.state, zip: e.zip, phone: e.phone || "" } });
function shipId(e){
  const h = goldenShipTo(e).hcps;
  return "hcps-" + crypto.createHash("sha256").update(JSON.stringify(KEYS.map(k => h[k]))).digest("hex").slice(0, 24);
}

module.exports = { accountFor, locationsFor, book, validate, goldenShipTo, shipId, ACCT_RE, REF_RE, UUID_RE, GOLDEN_SLUGS };
