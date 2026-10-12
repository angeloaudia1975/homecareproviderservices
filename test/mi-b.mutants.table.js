/* Mutants for the MI Inbox Automation Phase B suites. Each must make its suite FAIL.
   file: a function file (applied in memory by phase0-mock) or 'sql' (a temporary copy of the migration). */
const RC = '_report_capture.js', API = 'mfr-reports-api.js', SH = '_shipto.js', SI = 'sales-import-api.js';
module.exports = {
  // ── capture (test/report-capture.test.js) ──
  // both JavaScript guards gone: the database must still refuse a draft profile (capture_profile_inactive)
  draft_registers: { file: RC, suite: 'report-capture', from: 'if (prof.status !== "active") return { outcome: "classified"', to: 'if (false) return { outcome: "classified"',
    also: { from: 'outcome: prof.auto_register ? "register" : "classified"', to: 'outcome: "register"' } },
  period_ignores_content: { file: RC, suite: 'report-capture', from: 'if (att.date_range) found.content_dates', to: 'if (false) found.content_dates' },
  internal_not_skipped: { file: RC, suite: 'report-capture', from: 'if (who.internal) return true;', to: '' },
  no_progress_guarantee: { file: RC, suite: 'report-capture', from: 'if (watermarkMoved && now() > soft)', to: 'if (now() > soft)' },
  first_email_blocks: { file: RC, suite: 'report-capture', from: 'if (e.code === "budget" && !watermarkMoved)', to: 'if (false && e.code === "budget")' },
  stores_linked_again: { file: RC, suite: 'report-capture', from: 'if (!(have && have[0] && have[0].kind === prof.kind))', to: 'if (true)' },
  unknown_sender_quiet: { file: RC, suite: 'report-capture', from: 'if (!who.slug) return { outcome: "exception", attention: "unknown_sender"', to: 'if (!who.slug) return { outcome: "classified", attention: "unknown_sender"' },
  format_changed_lost: { file: RC, suite: 'report-capture', from: 'return { outcome: "exception", attention: "format_changed",', to: 'return { outcome: "exception", attention: "unidentified_type",' },
  images_recorded: { file: RC, suite: 'report-capture', from: 'if (/^image\\//i.test(a.contentType || "") || (a.isInline && !/fileAttachment/i.test(type))) continue;\n        if (/^image\\//i.test(a.contentType || "")) continue;', to: '' },
  no_relist: { file: RC, suite: 'report-capture', from: 'items: items.map(strip), relist: true', to: 'items: items.map(strip), relist: false' },
  no_body_items: { file: RC, suite: 'report-capture', from: '(bodyProfileFor(who.slug) || !who.slug)', to: '(!who.slug)' },
  any_sender: { file: RC, suite: 'report-capture', from: 'return (s.domains || []).map(x => x.toLowerCase()).includes(dom)', to: 'return true || (s.domains || []).map(x => x.toLowerCase()).includes(dom)' },
  conflict_guessed: { file: RC, suite: 'report-capture', from: 'if (found.file_name && found.content && found.file_name.start !== found.content.start)', to: 'if (false)' },
  checkpoint_from_now: { file: RC, suite: 'report-capture', from: 'if (!stopped && !path) { complete = true; checkpoint = runStart; }', to: 'complete = true; checkpoint = runStart;' },
  // ── API (test/mi-b-api.test.js) ──
  actor_from_request: { file: API, suite: 'mi-b-api', from: 'actor: "staff:" + actor } }', to: 'actor: b.actor || ("staff:" + actor) } }' },
  capture_now_ungated: { file: API, suite: 'mi-b-api', from: 'if (!(await flagOn(sbGet, "mi_report_capture"))) return json(403, { error: "capture_switch_off"', to: 'if (false) return json(403, { error: "capture_switch_off"' },
  inbox_fails_open: { file: API, suite: 'mi-b-api', from: '} catch (x) { return json(503, { error: "unreadable", message: "The capture inbox could not be read just now: "', to: '} catch (x) { msgs = msgs || []; items = items || []; } if (0) { return json(503, { error: "unreadable", message: "' },
  resolve_no_reason: { file: API, suite: 'mi-b-api', from: 'if (!reason || reason.length < 3) return json(422', to: 'if (false) return json(422' },
  // ── Ship-To (test/shipto.test.js) ──
  strict_hq_fallback: { file: SH, suite: 'shipto', from: '  return out(null, null, { review: true, suggestions: sugg,', to: '  return out(hq || cands[0], "hq_fallback", { review: false, suggestions: sugg,' },
  strict_shared_zip_first: { file: SH, suite: 'shipto', from: 'if (zipHits.length > 1) return out(null, null, { review: true, reason: "zip_shared"', to: 'if (zipHits.length > 1) return out(zipHits[0], "zip", { review: false, reason: "zip_shared"' },
  account_only_mapping: { file: SH, suite: 'shipto', from: 'nref(m.account_ref) === ref && m.ship_key === key', to: 'nref(m.account_ref) === ref' },
  retired_mapping_used: { file: SH, suite: 'shipto', from: '!m.retired_at && ', to: '' },
  legacy_unflagged: { file: SH, suite: 'shipto', from: '{ questionable: zipHits.length > 1, suggestions:', to: '{ questionable: false, suggestions:' },
  legacy_hq_unflagged: { file: SH, suite: 'shipto', from: 'return out(hq || cands[0], hq ? "hq_fallback" : "first_fallback", { questionable: true', to: 'return out(hq || cands[0], hq ? "hq_fallback" : "first_fallback", { questionable: false' },
  preview_no_flags: { file: SI, suite: 'shipto', from: 'per_dealer:perDealer.slice(0,500), accounts, ship_to_flags:shipToFlags(rows,details,byId) };', to: 'per_dealer:perDealer.slice(0,500), accounts };' },
  // ── SQL (test/mi-b-capture.pg.test.js) ──
  sql_checkpoint_unchecked: { file: 'sql', from: '    if v_block is not null then', to: '    if false then' },
  sql_draft_registers: { file: 'sql', from: "if v_prof.status <> 'active' or not v_prof.auto_register then", to: 'if false then' },
  sql_any_received_date: { file: 'sql', from: "     or (r->>'received_date')::date is distinct from v_recv\n", to: '' },
  sql_guard_no_marker: { file: 'sql', from: "if coalesce(current_setting('hcps.capture_op', true), '') <> 'on' or current_user <> v_owner then", to: 'if current_user <> v_owner then' },
  sql_switch_unchecked: { file: 'sql', from: "  if p_need_switch and not hcps_mfr_capture_switch_on() then raise exception 'capture_switch_off: phase2_flags.mi_report_capture is not true'; end if;\n  select * into s", to: '  select * into s' },
  sql_retry_forever: { file: 'sql', from: '  if v_n >= 8 then v_retry := false; end if;', to: '' },
  sql_resolve_no_reason: { file: 'sql', from: "if v_reason is null or length(v_reason) < 3 then raise exception 'capture_reason_required'; end if;", to: '' },
  sql_events_editable: { file: 'sql', from: "  if tg_table_name = 'mfr_report_capture_events' and tg_op = 'UPDATE' then", to: '  if false then' },
  sql_service_role_inserts: { file: 'sql', from: "execute format('grant select on public.%I to service_role', t);", to: "execute format('grant select, insert, update, delete on public.%I to service_role', t);" },
  sql_items_replaced: { file: 'sql', from: "if jsonb_typeof(p->'items') = 'array' and not v_listed then", to: "if jsonb_typeof(p->'items') = 'array' then" },
};
