/* HCPS Academy on Dealer 360 (switch academy_dealer360). Read-only: who at this dealership (and, for a head office, its
   direct branches the viewer may open) is in the HCPS Academy, their course progress, exam passed / not passed with the
   attempt count, and HCPS certificates with their expiry. Never a numeric score, an answer, an email address or a
   revocation reason (decisions D8 / 14:31: reps and Relations see status only). Who may read it = who may open that
   Dealer 360 (crm-api's dealer-scope check) — the caller passes the branch ids that viewer may also open.
   Reads are strict: an unreadable table throws (crm-api answers 5xx), never an empty "nobody is in training". */
const EXPIRING_DAYS = 60;
const idsIn = ids => `in.(${[...new Set(ids.map(String))].map(encodeURIComponent).join(',')})`;
const ID = /^[A-Za-z0-9-]{1,64}$/;

function certStatus(c, now) {
  if (c.status === 'revoked') return 'revoked';
  return c.expires_at && Date.parse(c.expires_at) <= now ? 'expired' : 'valid';
}

/* dealerId: the Dealer 360 being viewed. branchIds: its direct branches that this viewer may open (already scoped). */
async function dealerAcademy(sbGet, dealerId, branchIds, now) {
  now = now || Date.now();
  const did = String(dealerId);
  const dealerIds = [did].concat((branchIds || []).map(String).filter(x => ID.test(x) && x !== did));
  const dealers = await sbGet(`dealers?id=${idsIn(dealerIds)}&select=id,business_name,parent_id,is_test`);
  const dname = Object.fromEntries(dealers.map(d => [String(d.id), d.business_name || 'Dealership']));
  const [mems, invites] = await Promise.all([
    sbGet(`academy_memberships?dealer_id=${idsIn(dealerIds)}&select=id,learner_id,dealer_id,role,access_type,status,started_at,ended_at`),
    sbGet(`academy_invites?dealer_id=${idsIn(dealerIds)}&status=eq.pending&select=dealer_id,expires_at`),
  ]);
  const pendingInvites = invites.filter(i => !i.expires_at || Date.parse(i.expires_at) > now).length;
  const out = { ok: true, enabled: true, dealers: dealerIds.filter(id => dname[id]).map(id => ({ id, name: dname[id], branch: id !== did,
      test: !!(dealers.find(d => String(d.id) === id) || {}).is_test })),
    people: [], summary: { people: 0, training_managers: 0, active: 0, enrolled: 0, passed: 0, certified: 0, expiring_soon: 0, expired: 0, revoked: 0, pending_invites: pendingInvites } };
  if (!mems.length) return out;

  const learners = await sbGet(`academy_learners?id=${idsIn(mems.map(m => m.learner_id))}&select=id,full_name,status`);
  const enr = await sbGet(`academy_enrollments?membership_id=${idsIn(mems.map(m => m.id))}&select=id,learner_id,version_id,membership_id,status,due_on`);
  let vers = [], courses = [], mods = [], lessons = [], prog = [], atts = [], certs = [];
  if (enr.length) {
    const eids = enr.map(e => e.id);
    [vers, prog, atts, certs] = await Promise.all([
      sbGet(`academy_course_versions?id=${idsIn(enr.map(e => e.version_id))}&select=id,course_id,version`),
      sbGet(`academy_progress?enrollment_id=${idsIn(eids)}&status=eq.completed&select=enrollment_id`),
      sbGet(`academy_attempts?enrollment_id=${idsIn(eids)}&select=enrollment_id,passed,submitted_at`),        // never score
      sbGet(`academy_certificates?enrollment_id=${idsIn(eids)}&select=enrollment_id,cert_number,issued_at,expires_at,status`),  // never a reason
    ]);
    if (vers.length) {
      [courses, mods] = await Promise.all([
        sbGet(`academy_courses?id=${idsIn(vers.map(v => v.course_id))}&select=id,title,slug`),
        sbGet(`academy_modules?version_id=${idsIn(vers.map(v => v.id))}&select=id,version_id`),
      ]);
      if (mods.length) lessons = await sbGet(`academy_lessons?module_id=${idsIn(mods.map(m => m.id))}&select=id,module_id`);
    }
  }
  const lessonTotal = vid => { const ms = new Set(mods.filter(m => String(m.version_id) === String(vid)).map(m => String(m.id))); return lessons.filter(l => ms.has(String(l.module_id))).length; };
  const S = out.summary;
  for (const m of mems) {
    const l = learners.find(x => String(x.id) === String(m.learner_id)) || {};
    const active = m.status === 'active' && (l.status || 'active') === 'active';
    const courseRows = enr.filter(e => String(e.membership_id) === String(m.id)).map(e => {
      const v = vers.find(x => String(x.id) === String(e.version_id)) || {};
      const c = courses.find(x => String(x.id) === String(v.course_id)) || {};
      const done = atts.filter(a => String(a.enrollment_id) === String(e.id) && a.submitted_at);
      const cert = certs.find(x => String(x.enrollment_id) === String(e.id));
      let certificate = null;
      if (cert) {
        const st = certStatus(cert, now); const left = cert.expires_at ? Math.floor((Date.parse(cert.expires_at) - now) / 86400000) : null;
        certificate = { cert_number: cert.cert_number, status: st, issued_at: cert.issued_at, expires_at: cert.expires_at,
          expiring_soon: st === 'valid' && left != null && left <= EXPIRING_DAYS };
      }
      return { course: c.title || 'Course', version: v.version || null, test_course: /^test-/.test(String(c.slug || '')), status: e.status, due_on: e.due_on,
        lessons_completed: prog.filter(p => String(p.enrollment_id) === String(e.id)).length, lessons_total: lessonTotal(e.version_id),
        exam: { attempts: done.length, passed: done.some(a => a.passed === true), last_at: done.map(a => a.submitted_at).sort().pop() || null },
        certificate };
    });
    out.people.push({ name: l.full_name || 'Learner', dealer: dname[String(m.dealer_id)] || 'Dealership', dealer_id: m.dealer_id,
      role: m.role, access_type: m.access_type, access: active ? 'active' : 'ended', started_at: m.started_at, ended_at: m.ended_at, courses: courseRows });
    S.people++; if (m.role === 'training_manager') S.training_managers++; if (active) S.active++;
    for (const c of courseRows) {
      if (c.test_course) continue;   // TEST courses are never counted in real figures
      if (c.status !== 'withdrawn') S.enrolled++;
      if (c.exam.passed) S.passed++;
      if (c.certificate) { if (c.certificate.status === 'valid') { S.certified++; if (c.certificate.expiring_soon) S.expiring_soon++; } else if (c.certificate.status === 'expired') S.expired++; else S.revoked++; }
    }
  }
  // active people first, Training Managers first, then by name
  out.people.sort((a, b) => (a.access === b.access ? 0 : a.access === 'active' ? -1 : 1) || (a.role === b.role ? 0 : a.role === 'training_manager' ? -1 : 1) || a.name.localeCompare(b.name));
  return out;
}

module.exports = { dealerAcademy, certStatus, EXPIRING_DAYS };
