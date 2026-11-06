/* C3-07 Stage 5 (D5) — application answers are stored only encrypted: AES-256-GCM with APPLICATIONS_ENC_KEY (32 random
   bytes, base64, a Netlify environment variable that Angelo sets; it is never in the database, the repo or a log).
   blob = base64( 12-byte iv | 16-byte tag | ciphertext ), with a fixed "aad" so a blob from another column can't be swapped
   in. Without the key the applications feature answers "opens shortly" — it never stores clear text instead. */
const crypto = require('crypto');
function key() {
  const k = process.env.APPLICATIONS_ENC_KEY; if (!k) return null;
  const b = Buffer.from(k, 'base64'); return b.length === 32 ? b : null;
}
const available = () => !!key();
function seal(obj, aad) {
  const k = key(); if (!k) { const e = new Error('encryption key not set'); e.code = 'no_key'; throw e; }
  const iv = crypto.randomBytes(12); const c = crypto.createCipheriv('aes-256-gcm', k, iv); c.setAAD(Buffer.from(String(aad || 'hcps-app')));
  const ct = Buffer.concat([c.update(Buffer.from(JSON.stringify(obj), 'utf8')), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
}
function open(blob, aad) {
  if (!blob) return null;
  const k = key(); if (!k) { const e = new Error('encryption key not set'); e.code = 'no_key'; throw e; }
  const b = Buffer.from(String(blob), 'base64'); if (b.length < 29) throw new Error('bad blob');
  const d = crypto.createDecipheriv('aes-256-gcm', k, b.subarray(0, 12)); d.setAAD(Buffer.from(String(aad || 'hcps-app'))); d.setAuthTag(b.subarray(12, 28));
  return JSON.parse(Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8'));
}
module.exports = { seal, open, available };
