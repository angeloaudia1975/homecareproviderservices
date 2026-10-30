/* A JavaScript stand-in for supabase/email_learning_p1_capture.sql's two write functions, for the mock world
   (test/phase0-mock.js seed.rpc). Same rules as the SQL (test/email-learning-p1.pg.test.js proves the SQL itself):
   create validates and stores; record_send answers a status, records once, same author, same dealer.
   Synthetic data only. */
const crypto = require('crypto');
const TYPES = ['previsit_headsup', 'visit_followup', 'follow_up', 'dormant_account', 'product_intro', 'reorder_reminder', 'cross_sell', 'portal_activation', 'campaign'];
const sha = (s, b) => crypto.createHash('sha256').update(String(s || '') + '\n\n' + String(b || ''), 'utf8').digest('hex');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function rpc() {
  return {
    hcps_email_draft_create(p, db) {
      const t = db.email_drafts = db.email_drafts || [];
      const s = String(p.subject || '').trim(), b = String(p.body || '');
      if (!s || !b.trim()) return { status: 400, body: { code: 'P0001', message: 'email_draft_bad_request: subject and body are required' } };
      if (p.dealer_id != null && p.dealer_id !== '' && !UUID.test(p.dealer_id)) return { status: 400, body: { code: 'P0001', message: 'email_draft_bad_request: dealer_id is not an id' } };
      if (!TYPES.includes(p.email_type) || !['ai-email-api', 'routes-api', 'campaign-api'].includes(p.generator) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(p.author_email || '') || p.author_email !== String(p.author_email).toLowerCase())
        return { status: 400, body: { code: '23514', message: 'new row violates check constraint' } };
      const row = { id: crypto.randomUUID(), created_at: new Date().toISOString(), author_email: p.author_email, dealer_id: p.dealer_id || null, email_type: p.email_type,
        template: p.template, generator: p.generator, original_subject: s, original_body: b, original_sha256: sha(s, b), sent_at: null, sent_subject: null, sent_body: null,
        sent_sha256: null, edited: null, recipient_count: null, content_expires_at: new Date(Date.now() + 365 * 864e5).toISOString(), content_purged_at: null };
      t.push(row); return { status: 200, body: { ok: true, id: row.id } };
    },
    hcps_email_draft_record_send(p, db) {
      const t = db.email_drafts = db.email_drafts || [];
      const d = t.find(r => r.id === String(p.draft_id || '').toLowerCase());
      const st = s => ({ status: 200, body: { ok: false, status: s } });
      if (!d) return st('not_found');
      if (d.author_email !== String(p.author_email || '').trim().toLowerCase()) return st('author_mismatch');
      if ((d.dealer_id || null) !== (p.dealer_id || null)) return st('dealer_mismatch');
      if (d.sent_at) return st('already_sent');
      if (d.content_purged_at) return st('expired');
      const s = String(p.subject || '').trim(), b = String(p.body || '');
      Object.assign(d, { sent_at: new Date().toISOString(), sent_subject: s, sent_body: b, sent_sha256: sha(s, b), edited: sha(s, b) !== d.original_sha256,
        recipient_count: Math.max(1, Math.min(50, parseInt(p.recipient_count, 10) || 1)) });
      return { status: 200, body: { ok: true, status: 'recorded', edited: d.edited } };
    },
  };
}
module.exports = { rpc, sha };
