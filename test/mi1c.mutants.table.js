/* MI-1c mutants — each must make its suite fail.
   api  → test/mi1c-api.test.js (applied in memory by phase0-mock's loader, helpers included)
   fn   → test/mi1c-parser.test.js (applied to a temporary copy of netlify/functions — MI1C_FN_DIR)
   sql  → test/mi1c-intel.pg.test.js (applied to a temporary copy of the migration — MI1C_SQL) */
const A = 'mfr-intel-api.js', DI = '_dealer_intel.js', S = 'sql';
const REP = '_strongback_report.js', LAY = '_strongback_layout.js', MAT = '_dealer_intel_match.js';
module.exports = {
  // ---- API
  'api: actor taken from the request':            { file: A, from: 'const actor = me.email;', to: 'const actor = b.actor || me.email;' },
  'api: role gate removed':                        { file: A, from: 'if (!ADMIN.has(me.role))', to: 'if (false)' },
  'api: stored file not checked against the register': { file: A, from: 'if (sha256(bytes) !== src.file_sha256)', to: 'if (false)' },
  'api: import without the reviewed preview':      { file: A, from: 'if (!b.preview_hash || b.preview_hash !== body.preview_hash)', to: 'if (false)' },
  'api: parse errors do not block an import':      { file: A, from: 'if (body.errors.length) return json(422', to: 'if (false) return json(422' },
  'api: not-accepted report imported':             { file: A, from: 'if (pb.src.status !== "accepted")', to: 'if (false)' },
  'api: unreadable aliases treated as none':       { file: A, from: 'sbGetAll("dealer_aliases?select=alias_norm,dealer_id", "alias_norm"),', to: 'sbGetAll("dealer_aliases?select=alias_norm,dealer_id", "alias_norm").catch(() => []),' },
  'api: unreadable sales treated as none':         { file: A, from: '&select=customer_name,ship_city,ship_state,dealer_id,amount,period,order_date`, "id"),', to: '&select=customer_name,ship_city,ship_state,dealer_id,amount,period,order_date`, "id").catch(() => []),' },
  'api: dealer search shows TEST dealers':         { file: A, from: '&or=(is_test.is.null,is_test.is.false)', to: '' },
  'api: dealer search query not cleaned':          { file: A, from: '.replace(/[^A-Za-z0-9 \'&.-]/g, " ")', to: '.replace(/[^\\s\\S]/g, " ")' },
  'api: the version a person saw is dropped':      { file: A, from: 'expected_version: b.expected_version == null ? null : parseInt(b.expected_version, 10)', to: 'expected_version: null' },
  'helper: the Wyatt\'s hold is lost':              { file: DI, from: '{ name: "Wyatt\'s Pharmacy Inc",', to: '{ name: "Wyatts Pharmacy",' },
  'helper: observations lose their printed position': { file: DI, from: 'kind: "contact_person", position_key: c.pos,', to: 'kind: "contact_person", position_key: "contact",' },
  'helper: offers stored without "unverified"':    { file: DI, from: 'status: "unverified manufacturer text — no pricing or campaign action"', to: 'status: "offer"' },
  'helper: the report owner proposed as a contact': { file: DI, from: 'review_state: c.role === "dealer_contact" ? "proposed" : null', to: 'review_state: "proposed"' },
  // ---- reader
  'reader: hyphen read as an en dash':             { file: LAY, from: '0xE088: "-"', to: '0xE088: "–"', fn: true },
  'reader: an unknown glyph is let through':       { file: LAY, from: 'if (!(c in PUA)) {', to: 'if (false) {', fn: true },
  'reader: items in a row not ordered left to right': { file: LAY, from: 'for (const it of R.items.sort((a, b) => a.x - b.x)) {', to: 'for (const it of R.items) {', fn: true },
  'reader: chart labels read as text':             { file: REP, from: 'if (l.size < 7) continue;', to: 'if (l.size < 5) continue;', fn: true },
  'reader: tier rule loses its comma guard':       { file: REP, from: '/T([1-4]) from (\\$\\d{1,3}(?:,\\d{3})*)/g', to: '/T([1-4]) from (\\$[\\d,]+)/g', fn: true },
  'reader: "sample sent" read as on display':      { file: REP, from: 'return { text, status: "sample_sent",', to: 'return { text, status: "on_display",', fn: true },
  'reader: wrapped contact entries cut short':     { file: REP, from: 'else if (out.contact_log.length) out.contact_log[out.contact_log.length - 1].parts.push(x.text);', to: 'else if (out.contact_log.length) {}', fn: true },
  'reader: group heading keeps its count':         { file: REP, from: 'group = { heading: gm[1],', to: 'group = { heading: gm[0],', fn: true },
  'reader: city words read as name':               { file: REP, from: 'if (w.size >= 8.9) cur.name.push(w.text); else cur.city.push(w.text);', to: 'if (w.size >= 8.4) cur.name.push(w.text); else cur.city.push(w.text);', fn: true },
  'reader: report owner kept as a dealer contact': { file: REP, from: '? "report_owner" : "dealer_contact"', to: '? "dealer_contact" : "dealer_contact"', fn: true },
  'reader: "Dec 17 2025" dates not recognised':    { file: REP, from: "const re = /\\b([A-Z][a-z]{2,8})\\.? (\\d{1,2}),? (\\d{4})\\b/g;", to: "const re = /(?!)/g;", fn: true },
  // ---- matcher
  'matcher: hold ignored':                         { file: MAT, from: 'if (heldBy.has(n)) {', to: 'if (false) {', fn: true },
  'matcher: city mismatch accepted':               { file: MAT, from: 'if (!cityAgrees && !salesCorroborate)', to: 'if (false)', fn: true },
  'matcher: different name accepted':              { file: MAT, from: 'if (!nameAgrees)', to: 'if (false)', fn: true },
  'matcher: several candidates → first one picked': { file: MAT, from: 'if (ev.size > 1) {', to: 'if (false) {', fn: true },
  'matcher: TEST dealers are candidates':          { file: MAT, from: 'for (const d of D.values()) if (!d.is_test && dnorm(d.business_name) === n)', to: 'for (const d of D.values()) if (dnorm(d.business_name) === n)', fn: true },
  'matcher: distinctive words used alongside exact names': { file: MAT, from: 'if (!ev.size && k) {', to: 'if (k) {', fn: true },
  'matcher: possessive "S" kept':                  { file: MAT, from: 'filter(w => w !== "S" &&', to: 'filter(w => true &&', fn: true },
  'matcher: earlier confirmations ignored':        { file: MAT, from: 'if (prevIds.length === 1) {', to: 'if (false) {', fn: true },
  'matcher: inactive dealers matched':             { file: MAT, from: 'd && !d.is_test && d.active !== false &&', to: 'd && !d.is_test &&', fn: true },
  // ---- SQL
  'sql: guard does not require the owner\'s rights': { file: S, from: 'if current_user <> v_owner then', to: 'if false then' },
  'sql: printed figures may change inside a match': { file: S, from: "     is distinct from (to_jsonb(old) - array['match_status','dealer_id','match_method','match_evidence','match_reason','matched_by','matched_at','match_version']) then", to: "     is distinct from (to_jsonb(new) - array['match_status','dealer_id','match_method','match_evidence','match_reason','matched_by','matched_at','match_version']) then" },
  'sql: rows may be deleted':                      { file: S, from: "if tg_op = 'DELETE' then raise exception 'mi1c_guard: rows of % are never deleted', tg_table_name; end if;", to: '' },
  'sql: another file than the registered one':     { file: S, from: "if v_src.file_sha256 is distinct from lower(p->>'file_sha256') then", to: 'if false then' },
  'sql: a received report imported':               { file: S, from: "if v_src.status <> 'accepted' then raise exception 'mi1c_not_accepted", to: "if false then raise exception 'mi1c_not_accepted" },
  'sql: period not checked':                       { file: S, from: "    raise exception 'mi1c_period_mismatch:", to: "    raise notice 'mi1c_period_mismatch:" },
  'sql: parse errors imported':                    { file: S, from: "if jsonb_array_length(coalesce(p->'errors', '[]'::jsonb)) > 0 then", to: 'if false then' },
  'sql: a different parse taken as the same':      { file: S, from: 'if v_rep.content_hash = v_hash then', to: 'if true then' },
  // The advisory lock and the source-row lock each serialise two imports of one report; removing both must fail.
  'sql: no import lock (advisory + source row)':   { file: S, from: "perform pg_advisory_xact_lock(hashtextextended('mi1c:import:' || coalesce(p->>'source_id', ''), 0));\n  select * into v_src from public.mfr_sources where id = (p->>'source_id')::bigint for update;", to: "select * into v_src from public.mfr_sources where id = (p->>'source_id')::bigint;" },
  'sql: stale decisions accepted':                 { file: S, from: "if (p->>'expected_version') is null or (p->>'expected_version')::int <> v_s.match_version then", to: 'if false then' },
  'sql: decision without a reason':                { file: S, from: "if v_reason is null then raise exception 'mi1c_reason_required", to: "if false then raise exception 'mi1c_reason_required" },
  'sql: closed report still decided':              { file: S, from: "if v_src.status <> 'accepted' then raise exception 'mi1c_source_closed", to: "if false then raise exception 'mi1c_source_closed" },
  'sql: service_role may write':                   { file: S, from: "execute format('grant select on public.%I to service_role', t);", to: "execute format('grant select, insert, update, delete on public.%I to service_role', t);" },
  'sql: anon keeps the default grants':            { file: S, from: "execute format('revoke all on public.%I from public, anon, authenticated, service_role', t);", to: "execute format('revoke all on public.%I from service_role', t);" },
  'sql: RLS not enabled':                          { file: S, from: "execute format('alter table public.%I enable row level security', t);", to: '' },
  'sql: import runs with the caller\'s rights':     { file: S, from: 'returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$\ndeclare\n  v_src', to: 'returns jsonb language plpgsql set search_path = public, pg_temp as $$\ndeclare\n  v_src' },
  'sql: a TEST dealer may be matched':             { file: S, from: "if v_status = 'matched' then\n      if not exists (select 1 from public.dealers x where x.id = v_dealer and coalesce((to_jsonb(x)->>'is_test')::boolean, false) = false) then", to: "if v_status = 'matched' then\n      if not exists (select 1 from public.dealers x where x.id = v_dealer) then" },
};
