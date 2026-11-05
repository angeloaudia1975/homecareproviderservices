/* C3-07 Stage 3 — Dealer Account Management Center: the pure rules (no I/O), shared by dealer-tools-api (dealer side)
   and dealers-api (HCPS side) and unit-tested on their own.

   · Locations a login may see (D2, owner 2026-11-05): a head-office login sees its company's authorized locations, a
     branch login ONLY its own. HCPS alone changes that (dealer_user_scope). A branch is never widened, whatever a scope
     row says; a head office may be narrowed to itself or to a list of its own locations.
   · Manufacturer account status: green = HCPS verified the account number; amber = on file / submitted / requested,
     waiting on HCPS; red = none. Verification never grants ordering — `active` (ordering) is a separate fact.
   · A dealer's own edits are REQUESTS: they are validated here and queued for HCPS approval (dealer_change_requests).
   · A logo upload must really be a JPEG or PNG (file signature, not the name), 1 MB at most. */

const MAX_LOGO = 1048576;
const EMAIL_RE = /^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']{2,}$/;
const STATE_RE = /^[A-Za-z]{2}$/;
const ZIP_RE = /^\d{5}(-\d{4})?$/;

const S = (v, n) => String(v == null ? "" : v).replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, n || 200);

/* ---------- locations (D2) ---------- */
// family: the dealer records of the login's company (its head office + direct branches), each {id, parent_id, ...}.
function visibleLocations(selfId, family, scopeRow) {
  const byId = new Map((family || []).map((d) => [String(d.id), d]));
  const self = byId.get(String(selfId));
  if (!self) return [];
  const isHead = !self.parent_id;
  if (!isHead) return [self];                                   // a branch login: its own location, always
  const company = (family || []).filter((d) => String(d.id) === String(self.id) || String(d.parent_id) === String(self.id));
  if (!scopeRow) return company;                                // default: head office sees its company
  if (scopeRow.scope === "own") return [self];
  if (scopeRow.scope === "list") {
    const allow = new Set((scopeRow.locations || []).map(String));
    const out = company.filter((d) => String(d.id) === String(self.id) || allow.has(String(d.id)));
    return out.length ? out : [self];
  }
  return company;                                               // 'company'
}

/* ---------- manufacturer account status ---------- */
// dm: the dealer_manufacturers row for this dealer + line (or null); claim: an open dealer_account_claims row (or null);
// accessOpen: an open dealer_access_requests row exists; goldenStatus: dealers.golden_status (Golden only).
function accountStatus({ slug, dm, claim, verifiedClaim, accessOpen, goldenStatus }) {
  const golden = slug === "golden-technologies" || slug === "golden";
  if (golden) {
    const g = String(goldenStatus || "").toLowerCase();
    if (g === "account") return { status: "verified", label: "Golden account on file", account_ref: null };
    return { status: "none", label: "No Golden account", account_ref: null };
  }
  const ref = dm && dm.account_ref ? String(dm.account_ref) : "";
  const same = (a, b) => String(a || "").trim().toUpperCase() === String(b || "").trim().toUpperCase();
  /* Green only while the number on file is the number HCPS verified (a changed number is no longer verified). */
  if (dm && dm.verified_at && ref && same(dm.verified_ref, ref)) return { status: "verified", label: "Verified by HCPS", account_ref: ref, ordering: dm.active !== false };
  /* A verified claim counts only when no different number is on file. */
  if (verifiedClaim && !claim && (!ref || same(verifiedClaim.account_ref, ref))) return { status: "verified", label: "Verified by HCPS", account_ref: String(verifiedClaim.account_ref || ""), ordering: !!(dm && dm.active !== false) };
  if (claim) return { status: "pending", label: "Submitted — HCPS is verifying", account_ref: String(claim.account_ref || ""), ordering: !!(dm && dm.active !== false) };
  if (dm && ref) return { status: "pending", label: "On file — HCPS verification pending", account_ref: ref, ordering: dm.active !== false };
  if (dm && dm.active !== false) return { status: "pending", label: "Ordering set up — account number not on file", account_ref: null, ordering: true };
  if (accessOpen) return { status: "pending", label: "Access requested — HCPS is reviewing", account_ref: null, ordering: false };
  return { status: "none", label: "No account on file", account_ref: null, ordering: false };
}

/* ---------- validation of a dealer's change request ---------- */
function addr(a) {
  if (!a || typeof a !== "object") return { error: "address missing" };
  const o = { label: S(a.label, 40), address: S(a.address, 120), city: S(a.city, 60), state: S(a.state, 10).toUpperCase(), zip: S(a.zip, 12) };
  if (!o.address || !o.city || !o.state || !o.zip) return { error: "Enter the street, city, state and ZIP." };
  if (!STATE_RE.test(o.state)) return { error: "State must be the 2-letter code." };
  if (!ZIP_RE.test(o.zip)) return { error: "ZIP must be 5 digits (or ZIP+4)." };
  return { value: o };
}
function contact(c) {
  if (!c || typeof c !== "object") return { error: "contact missing" };
  const o = { name: S(c.name, 80), title: S(c.title, 80), email: S(c.email, 120).toLowerCase(), phone: S(c.phone, 30) };
  if (c.id != null && c.id !== "") { o.id = S(c.id, 40); if (!/^[0-9a-f-]{8,40}$/i.test(o.id)) return { error: "Unknown contact." }; }
  if (c.remove === true) { if (!o.id) return { error: "Unknown contact." }; return { value: { id: o.id, remove: true, name: o.name } }; }
  if (!o.name) return { error: "Each contact needs a name." };
  if (!o.id) o.new_id = require("crypto").randomUUID();                                   // fixed when queued (approve is repeatable)
  if (o.email && !EMAIL_RE.test(o.email)) return { error: "Enter a valid email for " + o.name + "." };
  if (o.phone && !/^[0-9+().\-\s x]{7,30}$/i.test(o.phone)) return { error: "Enter a valid phone for " + o.name + "." };
  return { value: o };
}
// Returns {changes} (a JSON object to queue) or {error}. Only the fields the dealer actually sent are included.
function validateChanges(input) {
  const c = input && typeof input === "object" ? input : {};
  const out = {};
  if (c.company && typeof c.company === "object") {
    const co = {};
    if (c.company.contact_name != null) co.contact_name = S(c.company.contact_name, 80);
    if (c.company.phone != null) { co.phone = S(c.company.phone, 30); if (co.phone && !/^[0-9+().\-\s x]{7,30}$/i.test(co.phone)) return { error: "Enter a valid phone number." }; }
    if (c.company.email != null) { co.email = S(c.company.email, 120).toLowerCase(); if (co.email && !EMAIL_RE.test(co.email)) return { error: "Enter a valid email address." }; }
    if (c.company.website != null) {
      co.website = S(c.company.website, 200);
      if (co.website && !/^https?:\/\/[a-z0-9.-]+\.[a-z]{2,}(\/[^\s<>"']*)?$/i.test(co.website)) return { error: "Website must start with https:// (for example https://yourstore.com)." };
    }
    if (Object.keys(co).length) out.company = co;
  }
  if (c.business) { const r = addr(c.business); if (r.error) return { error: "Business address: " + r.error }; out.business = r.value; }
  if (c.billing) { const r = addr(c.billing); if (r.error) return { error: "Billing address: " + r.error }; out.billing = r.value; }
  if (Array.isArray(c.ship_to)) {
    if (c.ship_to.length > 10) return { error: "At most 10 ship-to addresses per request." };
    const list = [];
    for (const a of c.ship_to) {
      const r = addr(a); if (r.error) return { error: "Ship-to address: " + r.error };
      if (a && a.key != null && a.key !== "") { const k = S(a.key, 40); if (!/^ship-[a-z0-9_-]{1,34}$/i.test(k)) return { error: "Unknown address." }; r.value.key = k; }
      else r.value.key = "ship-" + require("crypto").randomBytes(4).toString("hex");   // fixed when queued: approving twice never duplicates
      list.push(r.value);
    }
    if (list.length) out.ship_to = list;
  }
  if (Array.isArray(c.contacts)) {
    if (c.contacts.length > 10) return { error: "At most 10 contacts per request." };
    const list = [];
    for (const x of c.contacts) { const r = contact(x); if (r.error) return { error: r.error }; list.push(r.value); }
    if (list.length) out.contacts = list;
  }
  if (!Object.keys(out).length) return { error: "No changes to submit." };
  return { changes: out };
}

/* ---------- account number a dealer submits ---------- */
function validAccountRef(v) {
  const s = S(v, 41);
  return /^[A-Za-z0-9][A-Za-z0-9 ./#-]{0,39}$/.test(s) ? s : null;
}

/* ---------- logo upload ---------- */
// buf: Buffer of the decoded upload. Returns {ext, type} for a real JPEG/PNG within the size limit, else {error}.
function sniffLogo(buf) {
  if (!buf || !buf.length) return { error: "No file received." };
  if (buf.length > MAX_LOGO) return { error: "The logo must be 1 MB or smaller." };
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { ext: "jpg", type: "image/jpeg" };
  if (buf.length > 8 && buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { ext: "png", type: "image/png" };
  return { error: "The logo must be a JPEG or PNG image." };
}

/* ---------- default ship-to ---------- */
// keys: the address keys the dealer has on file ('main' = the business address on the dealer record).
function validDefaultShip(key, keys) {
  const k = S(key, 40);
  if (/^bill/i.test(k)) return null;                                                       // a billing address is never the ship-to
  return (k && (keys || []).includes(k)) ? k : null;
}

module.exports = { visibleLocations, accountStatus, validateChanges, validAccountRef, sniffLogo, validDefaultShip, MAX_LOGO };
