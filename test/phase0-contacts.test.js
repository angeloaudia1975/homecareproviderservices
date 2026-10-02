/* Phase 0H: contact safety. Imports merge by default and a blank never erases a stored value;
   "replace" touches only the dealers in the file, and only after a preview and a confirmation.
   Real handlers (dealers-api, crm-api) against the fake database; _upsert.js directly. */
const assert = require('assert');
const { createWorld, load, call, standardSeed, t, done, BASE } = require('./phase0-mock');

function seed() {
  return standardSeed({
    dealer_contacts: [
      { id: 'c1', dealer_id: 'd-greg', email: 'bryant@glasgow.test', name: 'Bryant', title: 'Pharmacist', phone: '270-111', cell: '270-999' },
      { id: 'c2', dealer_id: 'd-ang', email: 'buyer@rms.test', name: 'RMS Buyer', title: 'Owner', phone: '615-222' },
    ],
    dealer_addresses: [
      { dealer_id: 'd-greg', addr_key: 'K1', address: '1 Main', city: 'Glasgow', state: 'KY', zip: '42141', label: 'Main', pri: 1 },
      { dealer_id: 'd-ang', addr_key: 'K2', address: '9 Elm', city: 'Nashville', state: 'TN', zip: '37201', label: 'HQ', pri: 3 },
    ],
    dealer_manufacturers: [{ dealer_id: 'd-greg', manufacturer: 'golden', active: true, account_ref: 'GOLD-123' }],
    dealer_aliases: [],
  });
}
// One file row for Glasgow: the contact has a name but no phone/title; the line has no account #.
const FILE = [{ company: 'Glasgow Prescription Center', contact: 'Bryant', email: 'bryant@glasgow.test', phone: '',
  contacts: [{ email: 'bryant@glasgow.test', name: 'Bryant Smith' }, { email: 'new@glasgow.test', name: 'New Person', phone: '270-333' }],
  addresses: [], lines: [{ slug: 'golden' }] }];
const imp = (m, extra) => call(m, Object.assign({ action: 'import_contacts', rows: FILE, create: false }, extra || {}), { token: 'pres' });
const contact = (w, email) => w.db.dealer_contacts.find(c => c.email === email);

(async () => {
  await t('0H an import merges by default and a blank never erases a stored value', async () => {
    const w = createWorld(seed()); const m = load('dealers-api.js', w);
    const r = await imp(m);
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    const c = contact(w, 'bryant@glasgow.test');
    assert.strictEqual(c.name, 'Bryant Smith', 'the new value is taken');
    assert.strictEqual(c.phone, '270-111', 'blank phone erased the stored one');
    assert.strictEqual(c.title, 'Pharmacist'); assert.strictEqual(c.cell, '270-999');
    assert.ok(contact(w, 'new@glasgow.test'), 'new contact added');
    assert.ok(contact(w, 'buyer@rms.test'), 'another dealer\'s contact was removed');
    assert.strictEqual(w.db.dealer_addresses.length, 2, 'addresses were removed by a merge');
  });
  await t('0H a line with no account number keeps the one on file', async () => {
    const w = createWorld(seed()); const m = load('dealers-api.js', w);
    await imp(m);
    assert.strictEqual(w.db.dealer_manufacturers.find(x => x.dealer_id === 'd-greg' && x.manufacturer === 'golden').account_ref, 'GOLD-123');
  });
  await t('0H replace without confirmation is refused and nothing is deleted', async () => {
    const w = createWorld(seed()); const m = load('dealers-api.js', w);
    const r = await imp(m, { replace: true });
    assert.strictEqual(r.status, 400);
    assert.ok(!w.writes.some(x => x.kind === 'delete'), 'something was deleted');
  });
  await t('0H the preview reports the replace and writes nothing', async () => {
    const w = createWorld(seed()); const m = load('dealers-api.js', w);
    const before = w.writes.length;
    const r = await imp(m, { replace: true, preview: true });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    const p = r.body.preview;
    assert.strictEqual(p.dealers_in_file, 1); assert.strictEqual(p.contacts_to_remove, 1); assert.strictEqual(p.addresses_to_remove, 1);
    assert.strictEqual(p.contacts_in_file, 2);
    assert.strictEqual(w.writes.length, before, 'the preview wrote: ' + JSON.stringify(w.writes.slice(before)));
  });
  await t('0H a confirmed replace clears ONLY the dealers in the file', async () => {
    const w = createWorld(seed()); const m = load('dealers-api.js', w);
    const r = await imp(m, { replace: true, confirm_replace: true });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.ok(contact(w, 'buyer@rms.test'), 'a dealer outside the file lost its contacts');
    assert.ok(w.db.dealer_addresses.some(a => a.dealer_id === 'd-ang'), 'a dealer outside the file lost its address');
    assert.ok(!w.db.dealer_addresses.some(a => a.dealer_id === 'd-greg'), 'the file\'s dealer was not cleared');
    assert.strictEqual(contact(w, 'bryant@glasgow.test').phone, undefined, 'replace starts the file\'s dealers fresh');
  });
  await t('0H quick-add of an existing contact keeps their phone and title', async () => {
    const w = createWorld(seed()); const m = load('crm-api.js', w);
    const r = await call(m, { action: 'save_contact', dealer_id: 'd-greg', email: 'bryant@glasgow.test', name: 'Bryant S.' }, { token: 'greg' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    const c = contact(w, 'bryant@glasgow.test');
    assert.strictEqual(c.name, 'Bryant S.'); assert.strictEqual(c.phone, '270-111'); assert.strictEqual(c.title, 'Pharmacist');
  });
  await t('0H editing a contact by id can still clear a field on purpose', async () => {
    const w = createWorld(seed()); const m = load('crm-api.js', w);
    await call(m, { action: 'save_contact', id: 'c1', dealer_id: 'd-greg', email: 'bryant@glasgow.test', name: 'Bryant', title: 'Pharmacist', phone: '' }, { token: 'greg' });
    assert.strictEqual(contact(w, 'bryant@glasgow.test').phone, null);
  });
  await t('0H the upsert helper sends same-shaped groups and drops blanks', async () => {
    const w = createWorld(seed()); const UP = load('_upsert.js', w);
    const sbSend = async (m, p, b, x) => { const r = await w.fetch(BASE + '/rest/v1/' + p, { method: m, headers: x, body: JSON.stringify(b) }); if (!r.ok) throw new Error(await r.text()); return null; };
    const r = await UP.upsertKeepingValues(sbSend, 'dealer_contacts?on_conflict=dealer_id,email', [
      { dealer_id: 'd-greg', email: 'a@x.test', name: 'A', phone: '' }, { dealer_id: 'd-greg', email: 'b@x.test', name: 'B', phone: '1' }, { dealer_id: 'd-greg', email: 'bryant@glasgow.test', name: null, title: '  ' }]);
    assert.deepStrictEqual(r.errors, []); assert.strictEqual(r.written, 3);
    assert.strictEqual(contact(w, 'bryant@glasgow.test').name, 'Bryant'); assert.strictEqual(contact(w, 'a@x.test').phone, undefined);
  });

  done('0H contact safety');
})();
