/* Mutants for Smart Email Learning Phase 1. Each must make its suite FAIL (CONTROL must pass).
   file: a function file (applied in memory by phase0-mock's loader) or 'sql' (a temporary copy of the migration). */
const EL = '_email_learning.js', MAIL = 'email-sync-api.js', RT = 'routes-api.js', AI = 'ai-email-api.js', API = 'email-learning-api.js';
module.exports = {
  CONTROL: { file: EL, suite: 'js', control: true, from: 'const MAX_SUBJECT = 300, MAX_BODY = 20000;', to: 'const MAX_SUBJECT = 300, MAX_BODY = 20000; /* control */' },
  // who / when
  capture_everyone: { file: EL, suite: 'js', from: 'return me && String(me.role || "").toLowerCase() === "president" &&', to: 'return me &&' },
  ignore_switch_on_draft: { file: EL, suite: 'js', from: '    if(!(await flagOn(sbGet, SWITCH))) return null;', to: '    ;' },
  ignore_switch_on_send: { file: EL, suite: 'js', from: '    if(!(await flagOn(sbGet, SWITCH))) return "switch_off";', to: '    ;' },
  // never break a draft or a send
  draft_capture_throws: { file: EL, suite: 'js', from: '    return out && out.ok && uuidOrNull(out.id) ? out.id : null;\n  }catch(e){ return null; }', to: '    return out && out.ok && uuidOrNull(out.id) ? out.id : null;\n  }catch(e){ throw e; }',
    also: { from: 'return withTimeout(draftWork(sbGet, me, d, rpc).catch(() => null), null);', to: 'return withTimeout(draftWork(sbGet, me, d, rpc), null);' } },
  send_capture_throws: { file: EL, suite: 'js', from: '  }catch(e){ return "error"; }', to: '  }catch(e){ throw e; }',
    also: { from: 'return withTimeout(sendWork(sbGet, me, s, rpc).catch(() => "error"), "timeout");', to: 'return withTimeout(sendWork(sbGet, me, s, rpc), "timeout");' } },
  record_before_outlook_answers: { file: MAIL, suite: 'js', from: '      if(sendErr) return json(200,{ok:false,fallback:true,to,...sendErr});',
    to: '      if(b.draft_id) await EL.recordSend(sbGet, me, {draft_id:b.draft_id, dealer_id:dealerId, subject, body:bodyText, recipient_count:1});\n      if(sendErr) return json(200,{ok:false,fallback:true,to,...sendErr});' },
  // what is kept
  original_without_signature: { file: EL, suite: 'js', from: '  return s ? `${b}\\n\\n${s}` : b;', to: '  return b;' },
  sent_text_not_what_was_sent: { file: MAIL, suite: 'js', from: 'subject, body:bodyText, recipient_count:1+cc.length});', to: 'subject, body:bodyText.trim(), recipient_count:1+cc.length});' },
  junk_draft_id_passed_through: { file: EL, suite: 'js', from: 'return UUID_RE.test(s) ? s.toLowerCase() : null;', to: 'return s ? s.toLowerCase() : null;' },
  heads_up_drops_draft_id: { file: RT, suite: 'js', from: '      return json(200,{ok:true, draft_id, to:String(d.email||""), subject, body, signature, warnings});', to: '      return json(200,{ok:true, to:String(d.email||""), subject, body, signature, warnings});' },
  ai_draft_drops_draft_id: { file: AI, suite: 'js', from: '    return json(200,{ok:true, draft_id, subject, body, html, signature,', to: '    return json(200,{ok:true, subject, body, html, signature,' },
  saved_followup_forgets_draft: { file: RT, suite: 'js', from: 'draft_id:Object.prototype.hasOwnProperty.call(e,"draft_id")?EL.uuidOrNull(e.draft_id):EL.uuidOrNull(prev.draft_id)};', to: 'draft_id:EL.uuidOrNull(e.draft_id)};' },
  saved_followup_keeps_stale_draft: { file: RT, suite: 'js', from: 'draft_id:Object.prototype.hasOwnProperty.call(e,"draft_id")?EL.uuidOrNull(e.draft_id):EL.uuidOrNull(prev.draft_id)};', to: 'draft_id:EL.uuidOrNull(e.draft_id)||EL.uuidOrNull(prev.draft_id)};' },
  capture_waits_forever: { file: EL, suite: 'js', from: '  return Promise.race([work.finally(() => clearTimeout(timer)), new Promise(res => { timer = setTimeout(() => res(onTimeout), captureMs()); })]);', to: '  return work;' },
  cursor_skips_ties: { file: API, suite: 'js', from: 'filt.push(`or=(created_at.lt.${at},and(created_at.eq.${at},id.lt.${cid}))`); }', to: 'filt.push(`created_at=lt.${at}`); }' },
  error_leaks_database_text: { file: API, suite: 'js', from: 'return json(500, { error: "server_error", message: "Email Learning couldn\'t load just now." }); }', to: 'return json(500, { error: String(e.message) }); }' },
  // owner page
  page_open_to_reps: { file: API, suite: 'js', from: 'if(String(me.role).toLowerCase() !== "president") return json(403,', to: 'if(false) return json(403,' },
  page_list_leaks_text: { file: API, suite: 'js', from: 'select=${COLS},original_subject,sent_subject&${filt.join', to: 'select=${COLS},original_subject,sent_subject,original_body,sent_body&${filt.join',
    also: { from: 'purged: !!r.content_purged_at, subject:', to: 'purged: !!r.content_purged_at, original_body: r.original_body, sent_body: r.sent_body, subject:' } },
  // SQL (real Postgres)
  sql_any_author: { file: 'sql', suite: 'pg', from: "  if d.author_email <> lower(btrim(coalesce(p->>'author_email', ''))) then return jsonb_build_object('ok', false, 'status', 'author_mismatch'); end if;", to: '' },
  sql_any_dealer: { file: 'sql', suite: 'pg', from: "  if d.dealer_id is distinct from v_dealer then return jsonb_build_object('ok', false, 'status', 'dealer_mismatch'); end if;", to: '' },
  sql_purge_early: { file: 'sql', suite: 'pg', from: '   where content_purged_at is null and content_expires_at <= now();', to: '   where content_purged_at is null;' },
  sql_server_may_insert: { file: 'sql', suite: 'pg', from: 'grant select on table public.email_drafts to service_role;', to: 'grant select, insert, update on table public.email_drafts to service_role;' },
  sql_create_not_definer: { file: 'sql', suite: 'pg', from: "create or replace function public.hcps_email_draft_create(p jsonb)\nreturns jsonb language plpgsql security definer", to: "create or replace function public.hcps_email_draft_create(p jsonb)\nreturns jsonb language plpgsql security invoker" },
  sql_send_may_change_original: { file: 'sql', suite: 'pg', from: "    if (to_jsonb(new) - v_keep) <> (to_jsonb(old) - v_keep) then raise exception 'email_draft_guard: recording a send changes only the sent fields'; end if;", to: '' },
  sql_edited_wrong: { file: 'sql', suite: 'pg', from: '         edited = (v_sha <> d.original_sha256), recipient_count = v_n', to: '         edited = true, recipient_count = v_n' },
  sql_rls_off: { file: 'sql', suite: 'pg', from: 'alter table public.email_drafts enable row level security;', to: '' },
};
