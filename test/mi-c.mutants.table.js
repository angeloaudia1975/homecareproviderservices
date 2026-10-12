/* Mutants for the Phase C (Ship-To review) suites. Each must make its suite FAIL.
   file: a function file (applied in memory by phase0-mock) or 'sql' (a temporary copy of supabase/mi_c_shipto.sql). */
const RV = '_shipto_review.js', RR = '_report_rows.js', SH = '_shipto.js', API = 'shipto-review-api.js';
module.exports = {
  // ── review (test/shipto-review.test.js) ──
  mixed_lines_ignored: { file: RV, suite: 'review', from: 'if (mixed) return Object.assign(base, { status: "needs_review", reason: "mixed_lines"', to: 'if (false) return Object.assign(base, { status: "needs_review", reason: "mixed_lines"' },
  stale_correction_applied: { file: RV, suite: 'review', from: 'if (cor.order_fingerprint !== fp)', to: 'if (false)' },
  oldest_correction_wins: { file: RV, suite: 'review', from: 'if (!p || c.version > p.version) latest.set', to: 'if (!p || c.version < p.version) latest.set' },
  held_not_whole: { file: RV, suite: 'review', from: 'status: !orders.length ? "empty" : counts.needs_review ? "held" : "ready"', to: 'status: !orders.length ? "empty" : counts.resolved ? "ready" : "held"' },
  lines_not_grouped: { file: RV, suite: 'review', from: 'const key = on ? "o:" + on : "l:" + r.line;', to: 'const key = "l:" + r.line;' },
  export_touches_original: { file: RV, suite: 'review', from: 'const raw = headers.map((_, i) => r.raw[i] == null ? "" : r.raw[i]);', to: 'const raw = headers.map((_, i) => String(r.raw[i] == null ? "" : r.raw[i]).trim().toUpperCase());' },
  shadow_hides_different: { file: RV, suite: 'review', from: 'else { res.different++; row.outcome = "different"; }', to: 'else { res.same++; row.outcome = "same"; }' },
  // ── reader ──
  zip_as_number: { file: RR, suite: 'review', from: 'raw: false });', to: 'raw: true });' },
  page_pattern_drift: { file: RR, suite: 'review', from: 'qty: /line item quantity|^quantity$|^qty$/i,', to: 'qty: /quantity|^qty$/i,' },
  no_ship_street: { file: RR, suite: 'review', from: 'ship_address: /^(shipping|ship to|ship-to|ship) ?(street|address)( ?1| line 1)?$/i,', to: 'ship_address: /^never$/,' },
  // ── resolver additions ──
  state_names_ignored: { file: SH, suite: 'review', from: 'return STATES[u] || u;', to: 'return u;' },
  zipmap_any_corporate: { file: SH, suite: 'review', from: 'if (c0 ? roots.has(c0) : ids.has(d0))', to: 'if (true)' },
  zipmap_in_legacy: { file: SH, suite: 'review', from: 'if (mode === "strict" && opts.zipmap && typeof opts.zipmap === "object") {', to: 'if (opts.zipmap && typeof opts.zipmap === "object") {' },
  matcher_name_ignored: { file: SH, suite: 'review', from: 'const candidates = row => (p.nameFirst ? (byName(row) || byRef(row)) : (byRef(row) || byName(row))) || [];', to: 'const candidates = row => byRef(row) || [];' },
  // ── API ──
  actor_from_request: { file: API, suite: 'review', from: 'const actor = "staff:" + me.email;', to: 'const actor = b.actor || ("staff:" + me.email);' },
  reps_allowed: { file: API, suite: 'review', from: 'if (!ADMIN.has(me.role)) return json(403', to: 'if (false) return json(403' },
  sha_not_checked: { file: API, suite: 'review', from: 'if (sha256(bytes) !== src.file_sha256)', to: 'if (false)' },
  fingerprint_from_request: { file: API, suite: 'review', from: 'order_fingerprint: o.fingerprint, reported: o.reported,', to: 'order_fingerprint: b.order_fingerprint || o.fingerprint, reported: b.reported || o.reported,' },
  ship_key_from_request: { file: API, suite: 'review', from: 'mapping_ship_key: o.ship_key || "" };', to: 'mapping_ship_key: b.mapping_ship_key || o.ship_key || "" };' },
  outside_family_unconfirmed: { file: API, suite: 'review', from: 'if (!inFamily && b.confirm_outside_family !== true)', to: 'if (false)' },
  test_dealer_allowed: { file: API, suite: 'review', from: 'if (!dealer || dealer.is_test === true) return json(422', to: 'if (!dealer) return json(422' },
  read_fails_open: { file: API, suite: 'review', from: '    sbGetAll("dealer_aliases?select=alias_norm,dealer_id", "alias_norm"),', to: '    sbGetAll("dealer_aliases?select=alias_norm,dealer_id", "alias_norm").catch(() => []),' },
  test_dealers_matched: { file: API, suite: 'review', from: 'const real = dealers.filter(d => d.is_test !== true);', to: 'const real = dealers;' },
  // ── SQL (test/mi-c-shipto.pg.test.js) ──
  sql_no_stale_check: { file: 'sql', from: '  if coalesce(v_cur.version, 0) <> v_exp then', to: '  if false then' },
  sql_guard_no_marker: { file: 'sql', from: "if coalesce(current_setting('hcps.shipto_op', true), '') <> 'on' or current_user <> v_owner then", to: 'if current_user <> v_owner then' },
  sql_corrections_editable: { file: 'sql', from: "  if tg_op = 'UPDATE' and tg_table_name in ('mfr_shipto_corrections','mfr_shipto_events') then", to: '  if false then' },
  sql_mapping_repointable: { file: 'sql', from: "    if old.retired_at is not null or new.retired_at is null", to: '    if false' },
  sql_conflict_silent: { file: 'sql', from: "        if not coalesce((p->>'replace_mapping')::boolean, false) then", to: '        if false then' },
  sql_test_dealer: { file: 'sql', from: "  if v_d.is_test then raise exception", to: "  if false then raise exception" },
  sql_service_role_writes: { file: 'sql', from: "    execute format('grant select on public.%I to service_role', t);", to: "    execute format('grant select, insert, update on public.%I to service_role', t);" },
  sql_any_report: { file: 'sql', from: "v_src.kind not in ('sales_export','commission_statement')", to: 'false' },
  sql_no_key_remembered: { file: 'sql', from: "    if v_sk !~ '^(id:.+|addr:.+\\|\\d{5})$' then", to: '    if false then' },
};
