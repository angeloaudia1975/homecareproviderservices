/* A JavaScript stand-in for supabase/email_learning_p2_rules.sql's functions, for the mock world (test/phase0-mock.js seed.rpc).
   Same rules as the SQL (test/email-learning-p2.pg.test.js proves the SQL itself). Synthetic data only. */
const crypto = require('crypto');
function rpc() {
  const ver = db => (db.email_learning_profiles || []).reduce((m, p) => Math.max(m, p.version), 0);
  const pres = (db, e) => { const em = String(e || '').trim().toLowerCase(); const u = (db.staff_users || []).find(s => String(s.email).toLowerCase() === em);
    return u && String(u.role).toLowerCase() === 'president' && u.active !== false ? em : null; };
  const snap = db => (db.email_learning_rules || []).filter(r => r.status === 'approved')
    .sort((a, b) => (a.email_type + a.kind + a.id).localeCompare(b.email_type + b.kind + b.id)).map(r => ({ id: r.id, email_type: r.email_type, kind: r.kind, instruction: r.instruction }));
  const ok = b => ({ status: 200, body: b });
  const ev = (db, o) => { (db.email_learning_rule_events = db.email_learning_rule_events || []).push(Object.assign({ id: (db.email_learning_rule_events.length + 1), at: new Date().toISOString() }, o)); };
  return {
    hcps_email_rule_note(p, db) {
      const t = db.email_learning_rules = db.email_learning_rules || [];
      if (/[0-9@]/.test(JSON.stringify(p.pattern || {}) + JSON.stringify(p.examples || [])) || /@/.test(p.instruction || '')
          || /\d/.test(String(p.instruction || '').replace(/\d{1,3}%/g, '')))
        return { status: 400, body: { code: '23514', message: 'violates check constraint "email_learning_rules_masked_ck"' } };
      if (!/^[0-9a-f]{32}$/.test(String(p.pattern_key || '')) || !Array.isArray(p.draft_ids)) return ok({ ok: false, status: 'bad_request' });
      // Counted here, as the SQL does: sent, edited drafts of the active President only (the caller's counts are ignored).
      const ids = new Set(p.draft_ids.map(String));
      const presidents = new Set((db.staff_users || []).filter(u => String(u.role).toLowerCase() === 'president' && u.active !== false).map(u => String(u.email).toLowerCase()));
      const ev2 = (db.email_drafts || []).filter(d => ids.has(String(d.id)) && d.sent_at && d.edited === true && presidents.has(String(d.author_email).toLowerCase()));
      p = Object.assign({}, p, { sends: ev2.length, dealers: new Set(ev2.map(d => d.dealer_id).filter(Boolean)).size });
      const r = t.find(x => x.rule_key === p.rule_key);
      if (!r) {
        if (!(p.sends >= 3 && p.dealers >= 2)) return ok({ ok: false, status: 'below_threshold' });
        if (t.some(x => x.pattern_key === p.pattern_key)) return ok({ ok: false, status: 'sibling_exists' });
        const row = { id: crypto.randomUUID(), rule_key: p.rule_key, pattern_key: p.pattern_key, email_type: p.email_type, kind: p.kind, pattern: p.pattern, instruction: p.instruction,
          suggested_instruction: p.instruction, examples: p.examples || [], sends: p.sends, dealers: p.dealers, first_seen: p.first_seen, last_seen: p.last_seen,
          status: 'suggested', decided_at: null, decided_by: null, decision_reason: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
        t.push(row); ev(db, { rule_id: row.id, action: 'suggested', by_email: 'system:email-learning' });
        return ok({ ok: true, status: 'inserted', id: row.id });
      }
      const before = JSON.stringify([r.sends, r.dealers, r.examples, r.suggested_instruction]);
      r.sends = Math.max(r.sends, p.sends); r.dealers = Math.min(r.sends, Math.max(r.dealers, p.dealers)); r.examples = p.examples || []; r.suggested_instruction = p.instruction;
      return ok({ ok: true, status: before === JSON.stringify([r.sends, r.dealers, r.examples, r.suggested_instruction]) ? 'unchanged' : 'updated', id: r.id, rule_status: r.status });
    },
    hcps_email_rule_decide(p, db) {
      const by = pres(db, p.by); if (!by) return ok({ ok: false, status: 'president_only' });
      const reason = String(p.reason || '').trim(); if (reason.length < 3 || reason.length > 500) return ok({ ok: false, status: 'reason_required' });
      const cur = ver(db); if (Number(p.expected_version) !== cur) return ok({ ok: false, status: 'version_conflict', version: cur });
      const r = (db.email_learning_rules || []).find(x => x.id === p.rule_id); if (!r) return ok({ ok: false, status: 'not_found' });
      if (String(p.expected_status || '') !== r.status) return ok({ ok: false, status: 'version_conflict', version: cur, rule_status: r.status });
      const ins = p.instruction ? String(p.instruction).trim() : null;
      if (ins && (ins.length < 3 || ins.length > 300 || /@/.test(ins) || /\d/.test(ins.replace(/\d{1,3}%/g, '')))) return ok({ ok: false, status: 'bad_instruction' });
      const to = { approve: ['suggested', 'rejected', 'retired'].includes(r.status) && 'approved', reject: r.status === 'suggested' && 'rejected',
        retire: r.status === 'approved' && 'retired', edit: r.status === 'approved' && ins && ins !== r.instruction && 'approved' }[p.decision];
      if (!to) return ok({ ok: false, status: 'not_allowed', rule_status: r.status });
      Object.assign(r, { status: to, instruction: ins || r.instruction, decided_at: new Date().toISOString(), decided_by: by, decision_reason: reason });
      let v = cur;
      if (p.decision !== 'reject') { v = cur + 1; (db.email_learning_profiles = db.email_learning_profiles || []).push({ version: v, created_at: new Date().toISOString(),
        created_by: by, action: p.decision, reason, rule_id: r.id, from_version: cur, rules: snap(db) }); }
      ev(db, { rule_id: r.id, action: p.decision, by_email: by, reason });
      return ok({ ok: true, status: 'decided', rule_status: r.status, version: v });
    },
    hcps_email_profile_rollback(p, db) {
      const by = pres(db, p.by); if (!by) return ok({ ok: false, status: 'president_only' });
      const reason = String(p.reason || '').trim(); if (reason.length < 3) return ok({ ok: false, status: 'reason_required' });
      const cur = ver(db); if (Number(p.expected_version) !== cur) return ok({ ok: false, status: 'version_conflict', version: cur });
      const to = Number(p.to_version); if (!(to >= 0 && to < cur)) return ok({ ok: false, status: 'not_found' });
      const s = to === 0 ? [] : ((db.email_learning_profiles || []).find(x => x.version === to) || {}).rules; if (!s) return ok({ ok: false, status: 'not_found' });
      for (const r of db.email_learning_rules || []) { const w = s.find(x => x.id === r.id);
        if (w) Object.assign(r, { status: 'approved', instruction: w.instruction }); else if (r.status === 'approved') r.status = 'retired'; }
      db.email_learning_profiles.push({ version: cur + 1, created_at: new Date().toISOString(), created_by: by, action: to === 0 ? 'reset' : 'rollback', reason, from_version: to, rules: snap(db) });
      return ok({ ok: true, status: to === 0 ? 'reset' : 'rolled_back', version: cur + 1 });
    },
  };
}
module.exports = { rpc };
