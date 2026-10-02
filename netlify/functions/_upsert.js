// HCPS — upserts that never erase what is already on file (Phase 0H).
//
// A PostgREST upsert with "resolution=merge-duplicates" overwrites EVERY column present in the
// payload. So an import row, a Zoho record or a quick-add form that simply left the phone or the
// title blank used to wipe the value already stored for that contact. These helpers drop blank
// fields row by row before sending. Because a bulk insert must give every row the same keys
// (PostgREST PGRST102), rows are sent in groups that share the same set of fields.
//
// This is for CREATE / MERGE paths only. Editing a contact by its id still sends blanks on
// purpose — that is how someone deliberately clears a field.

const isBlank = v => v === null || v === undefined || (typeof v === "string" && v.trim() === "");

// A copy of the row without blank fields. `keep` names fields to send even when blank.
function stripBlank(row, keep){
  const out = {};
  for(const [k, v] of Object.entries(row || {})) if((keep || []).includes(k) || !isBlank(v)) out[k] = v;
  return out;
}

// Rows grouped so every group has an identical set of keys.
function groupByShape(rows){
  const m = new Map();
  for(const r of (rows || [])){ const sig = Object.keys(r).sort().join(","); if(!m.has(sig)) m.set(sig, []); m.get(sig).push(r); }
  return [...m.values()];
}

// Upsert `rows` into `path` (which carries its own ?on_conflict=…) without erasing stored values.
// Returns { written, errors } and keeps going past a failed chunk, like the callers always did.
async function upsertKeepingValues(sbSend, path, rows, opts){
  opts = opts || {};
  const size = opts.size || 500; let written = 0; const errors = [];
  for(const group of groupByShape((rows || []).map(r => stripBlank(r, opts.keep)))){
    for(let i = 0; i < group.length; i += size){
      const part = group.slice(i, i + size);
      try{ await sbSend("POST", path, part, { Prefer: "resolution=merge-duplicates,return=minimal" }); written += part.length; }
      catch(e){ errors.push(String(e && e.message || e)); }
    }
  }
  return { written, errors };
}

// Write `body`; if the database doesn't have one of the `optional` columns yet (PostgREST
// PGRST204), write it again without them. Lets code ship before its migration has been run —
// e.g. dealer_tasks.completed_by (supabase/phase0_task_owner_email.sql).
async function sendTolerant(sbSend, method, path, body, optional, headers){
  const h = headers || { Prefer: "return=minimal" };
  try{ return await sbSend(method, path, body, h); }
  catch(e){
    if(!/PGRST204|Could not find the '[^']*' column/i.test(String(e && e.message || e))) throw e;
    const strip = r => { const o = { ...r }; for(const k of (optional || [])) delete o[k]; return o; };
    return await sbSend(method, path, Array.isArray(body) ? body.map(strip) : strip(body), h);
  }
}

module.exports = { isBlank, stripBlank, groupByShape, upsertKeepingValues, sendTolerant };
