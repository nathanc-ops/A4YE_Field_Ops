'use strict';
// Scheduling (appointments), cost codes & budgets, purchasing (vendors, POs, receiving, pick lists),
// accounting (chart of accounts, journal, bills/AP, financial statements) and the Ply connector.
const D = require('./db');
const C = require('./calc');
const A = require('./accounting');
const Ply = require('./ply');
const Push = require('./push');

const { all, get, run, tx } = D;
const r2 = C.r2;

module.exports = function routesExt(app, db, X) {
  const { wrap, bad, insert, update, mustGet, pick, today, addDays, office, admin, H } = X;

  // ================================================================ appointments
  // A visit belongs to a job or to an estimate (a walkthrough to price the work). Estimate visits come back with the same
  // fields as job visits — job_number / job_title carry the estimate's — plus kind and href, so every schedule view shows both.
  H.appointments = (where, params = []) => all(db, `SELECT a.*, COALESCE(j.number, e.number) job_number,
      CASE WHEN a.estimate_id IS NOT NULL THEN 'Estimate visit: ' || COALESCE(NULLIF(e.title, ''), 'walkthrough') ELSE j.title END job_title,
      j.status job_status, COALESCE(j.priority, 'normal') priority, CASE WHEN a.estimate_id IS NOT NULL THEN 'estimate' ELSE j.job_type END job_type,
      COALESCE(j.customer_id, e.customer_id) customer_id, e.number estimate_number, e.status estimate_status,
      c.name customer_name, c.type customer_type, c.phone customer_phone, l.address, l.city, l.state, l.zip,
      (SELECT GROUP_CONCAT(at.user_id) FROM appointment_techs at WHERE at.appointment_id = a.id) tech_ids,
      (SELECT GROUP_CONCAT(u.name, ', ') FROM appointment_techs at JOIN users u ON u.id = at.user_id WHERE at.appointment_id = a.id) tech_names
    FROM appointments a LEFT JOIN jobs j ON j.id = a.job_id LEFT JOIN estimates e ON e.id = a.estimate_id
    JOIN customers c ON c.id = COALESCE(j.customer_id, e.customer_id) LEFT JOIN locations l ON l.id = COALESCE(j.location_id, e.location_id)
    WHERE ${where} ORDER BY a.start`, ...params).map(a => ({ ...a, tech_ids: a.tech_ids ? String(a.tech_ids).split(',').map(Number) : [],
      kind: a.estimate_id ? 'estimate' : 'job', href: a.estimate_id ? `#/estimates/${a.estimate_id}` : `#/jobs/${a.job_id}`,
      // confirmed by email, then moved: the customer still has the old time
      needs_reconfirm: !!a.confirmed_at && (a.confirmed_start !== a.start || a.confirmed_end !== a.end) && !['done', 'cancelled'].includes(a.status) }));

  const crewOf = apptId => all(db, 'SELECT user_id FROM appointment_techs WHERE appointment_id = ?', apptId).map(r => r.user_id);
  // a visit still ahead (or under way), not finished or cancelled: worth a phone notice
  const live = apptId => { const a = get(db, 'SELECT status, end FROM appointments WHERE id = ?', apptId); return a && !['done', 'cancelled'].includes(a.status) && Date.parse(a.end) > Date.now(); };
  // opts.silent: the caller works out the notices itself (splitting a multi-day visit makes new rows for the same crew)
  function setApptTechs(apptId, jobId, ids, opts = {}) {
    if (!Array.isArray(ids)) return;
    const before = crewOf(apptId), now = [...new Set(ids.map(Number))];
    run(db, 'DELETE FROM appointment_techs WHERE appointment_id = ?', apptId);
    for (const uid of now) {
      run(db, 'INSERT OR IGNORE INTO appointment_techs (appointment_id, user_id) VALUES (?,?)', apptId, uid);
      if (jobId) run(db, 'INSERT OR IGNORE INTO job_techs (job_id, user_id) VALUES (?,?)', jobId, uid); // crew on the job
    }
    if (opts.silent || !live(apptId)) return;
    for (const uid of now) if (!before.includes(uid)) Push.queue({ type: 'assigned', user_id: uid, appt_id: apptId, job_id: jobId });
    for (const uid of before) if (!now.includes(uid)) Push.queue({ type: 'removed', user_id: uid, appt_id: apptId, job_id: jobId });
  }
  // time moved / cancelled: tell the crew who were already on it (anyone just added gets "assigned" instead)
  function noticeChanges(a, crewBefore) {
    const b = get(db, 'SELECT * FROM appointments WHERE id = ?', a.id); if (!b) return;
    const crew = crewOf(a.id).filter(u => crewBefore.includes(u));
    if (b.status === 'cancelled' && a.status !== 'cancelled') { for (const uid of crew) Push.queue({ type: 'cancelled', user_id: uid, appt_id: a.id, job_id: a.job_id }); return; }
    if ((b.start !== a.start || b.end !== a.end) && live(a.id)) for (const uid of crew) Push.queue({ type: 'moved', user_id: uid, appt_id: a.id, job_id: a.job_id });
  }
  // Keep the job's summary window (first start / last end) in line with its appointments.
  function syncJobSchedule(jobId) {
    if (!jobId) return;   // estimate visits don't move a job's schedule
    const w = get(db, "SELECT MIN(start) s, MAX(end) e, COUNT(*) n FROM appointments WHERE job_id = ? AND status != 'cancelled'", jobId);
    const job = get(db, 'SELECT status FROM jobs WHERE id = ?', jobId);
    run(db, 'UPDATE jobs SET scheduled_start = ?, scheduled_end = ? WHERE id = ?', w.s, w.e, jobId);
    if (w.n && job.status === 'unscheduled') run(db, "UPDATE jobs SET status = 'scheduled' WHERE id = ?", jobId);
    if (!w.n && job.status === 'scheduled') run(db, "UPDATE jobs SET status = 'unscheduled' WHERE id = ?", jobId);
  }
  H.syncJobSchedule = syncJobSchedule;
  // Back-compat for the job form's single start/end: create or move the only appointment.
  H.syncSingleAppointment = (jobId, start, end, techIds) => {
    const appts = all(db, "SELECT id FROM appointments WHERE job_id = ? AND status != 'cancelled'", jobId);
    if (appts.length > 1) return syncJobSchedule(jobId); // multi-visit jobs are scheduled per visit
    end = end || new Date(new Date(start).getTime() + 2 * 3600e3).toISOString();
    let id;
    if (appts.length) {
      id = appts[0].id; const old = get(db, 'SELECT * FROM appointments WHERE id = ?', id), crew = crewOf(id);
      run(db, 'UPDATE appointments SET start = ?, end = ? WHERE id = ?', start, end, id); noticeChanges(old, crew);
    }
    else id = insert('appointments', { job_id: jobId, start, end });
    if (Array.isArray(techIds)) setApptTechs(id, jobId, techIds);
    syncJobSchedule(jobId);
  };
  function checkTimes(start, end) {
    if (!start || !end) throw bad('Start and end are required');
    if (new Date(end) <= new Date(start)) throw bad('End must be after start');
  }

  app.get('/api/appointments', wrap((req, res) => {
    const from = req.query.from || C.startOfDay(today()), to = req.query.to || C.endOfDay(today());
    const p = [to, from]; let w = 'a.start < ? AND a.end > ?';
    if (!req.query.include_cancelled) w += " AND a.status != 'cancelled'";
    if (req.user.role === 'tech') { w += ' AND EXISTS (SELECT 1 FROM appointment_techs at WHERE at.appointment_id = a.id AND at.user_id = ?)'; p.push(req.user.id); }
    res.json(H.appointments(w, p));
  }));
  // a visit for a job, or for an estimate (pricing walkthrough); one or the other
  function visitTarget(b) {
    if (b.job_id && b.estimate_id) throw bad('A visit is for a job or for an estimate, not both');
    if (b.job_id) return { job_id: mustGet('jobs', b.job_id).id, estimate_id: null };
    if (b.estimate_id) {
      const e = mustGet('estimates', b.estimate_id);
      if (['cancelled', 'declined', 'expired'].includes(e.status)) throw bad(`That estimate is ${e.status}`);
      return { job_id: null, estimate_id: e.id };
    }
    throw bad('Pick the job or estimate this visit is for');
  }
  app.post('/api/appointments', office, wrap((req, res) => {
    const b = req.body, t = visitTarget(b);
    checkTimes(b.start, b.end);
    const id = insert('appointments', { ...t, start: new Date(b.start).toISOString(), end: new Date(b.end).toISOString(), notes: b.notes || null, status: b.status || 'scheduled' });
    setApptTechs(id, t.job_id, b.tech_ids || []);
    syncJobSchedule(t.job_id);
    res.json({ id, conflicts: conflicts(id) });
  }));
  // a customer wants a price: book the walkthrough and start the (draft) estimate in one step
  app.post('/api/estimate-visits', office, wrap((req, res) => {
    const b = req.body || {}, s = D.settings(db);
    if (!b.customer_id) throw bad('Customer is required');
    const cust = mustGet('customers', b.customer_id);
    if (b.location_id && !get(db, 'SELECT 1 x FROM locations WHERE id = ? AND customer_id = ?', b.location_id, cust.id)) throw bad('That address belongs to another customer');
    checkTimes(b.start, b.end);
    const eid = insert('estimates', { customer_id: cust.id, location_id: b.location_id || null, title: String(b.title || '').trim() || 'Estimate', notes: b.estimate_notes || null,
      number: D.nextNumber(db, 'estimates', 'EST'), public_token: D.token(), created_by: req.user.id, status: 'draft',
      tax_rate: cust.tax_exempt ? 0 : Number(s.default_tax_rate) || 0, terms: s.estimate_terms || null, valid_until: addDays(today(), Number(s.estimate_valid_days) || 30) });
    const id = insert('appointments', { job_id: null, estimate_id: eid, start: new Date(b.start).toISOString(), end: new Date(b.end).toISOString(), notes: b.notes || null, status: 'scheduled' });
    setApptTechs(id, null, b.tech_ids || []);
    res.json({ id, estimate_id: eid, conflicts: conflicts(id) });
  }));
  app.put('/api/appointments/:id', wrap(async (req, res) => {
    const a = mustGet('appointments', req.params.id);
    const onWay = async () => req.body.status === 'en_route' && a.status !== 'en_route'
      ? H.onTheWay(a.id, { eta_min: req.body.eta_min, notify: req.body.notify, user: req.user, gps: H.gps(req.body) }) : null;
    if (req.user.role === 'tech') {
      // techs can only advance the status of their own visits
      if (!get(db, 'SELECT 1 x FROM appointment_techs WHERE appointment_id = ? AND user_id = ?', a.id, req.user.id)) throw bad('Not your appointment', 403);
      const r = tx(db, () => techStatus(a, req.body.status, req.user, H.gps(req.body)));
      return res.json({ ...r, on_the_way: await onWay() });
    }
    const data = pick(req.body, ['start', 'end', 'status', 'notes']);
    for (const k of ['start', 'end']) if (data[k]) data[k] = new Date(data[k]).toISOString();
    checkTimes(data.start || a.start, data.end || a.end);
    tx(db, () => {
      const crewBefore = crewOf(a.id);
      // a job visit moved to another time: logged for the KPI cancellations / reschedules count
      if (data.start && data.start !== a.start && a.job_id && !['done', 'cancelled'].includes(a.status))
        run(db, 'INSERT INTO appointment_moves (appointment_id, job_id, from_start, to_start, user_id) VALUES (?,?,?,?,?)', a.id, a.job_id, a.start, data.start, req.user.id);
      update('appointments', a.id, data);
      setApptTechs(a.id, a.job_id, req.body.tech_ids);
      noticeChanges(a, crewBefore);
      if (data.status === 'dispatched' && a.job_id) run(db, "UPDATE jobs SET status = 'dispatched' WHERE id = ? AND status IN ('scheduled','unscheduled')", a.job_id);
      syncJobSchedule(a.job_id);
    });
    res.json({ ok: true, conflicts: conflicts(a.id), on_the_way: await onWay() });
  }));
  // One day of a multi-day visit (a crew window repeated each day) gets its own crew or hours: that day is split out as
  // its own visit, and the days before and after stay as they were. The browser sends the day's bounds and windows in
  // local time (it knows the time zone the board is drawn in): day_from/day_to = that day's midnights, start/end = the
  // day's new window, before_end = the previous day's window end, after_start = the next day's window start.
  app.post('/api/appointments/:id/day', office, wrap((req, res) => {
    const a = mustGet('appointments', req.params.id), b = req.body || {};
    const iso = (v, name) => { const t = Date.parse(v); if (!v || Number.isNaN(t)) throw bad(`${name} is missing`); return new Date(t).toISOString(); };
    const dayFrom = iso(b.day_from, 'day_from'), dayTo = iso(b.day_to, 'day_to'), start = iso(b.start, 'start'), end = iso(b.end, 'end');
    if (!(a.start < dayTo && a.end > dayFrom)) throw bad('That visit is not on that day');
    checkTimes(start, end);
    if (['done', 'cancelled'].includes(a.status)) throw bad(`That visit is ${a.status}`);
    const crew = Array.isArray(b.tech_ids) ? b.tech_ids.map(Number) : all(db, 'SELECT user_id FROM appointment_techs WHERE appointment_id = ?', a.id).map(r => r.user_id);
    for (const uid of crew) mustGet('users', uid);
    const hasBefore = a.start < dayFrom, hasAfter = a.end > dayTo;
    if (b.remove) {  // take this day off the visit (a weekend, a day the site is shut)
      if (!hasBefore && !hasAfter) throw bad('That is the only day of the visit — delete the visit instead');
      if (get(db, 'SELECT 1 x FROM time_entries WHERE appointment_id = ? AND clock_in >= ? AND clock_in < ?', a.id, dayFrom, dayTo)) throw bad('Someone already clocked time on that day');
    }
    if (!hasBefore && !hasAfter) {  // a single-day visit: just change it
      const before = crewOf(a.id);
      update('appointments', a.id, { start, end }); setApptTechs(a.id, a.job_id, crew); noticeChanges(a, before); syncJobSchedule(a.job_id);
      return res.json({ id: a.id, ids: [a.id], conflicts: conflicts(a.id) });
    }
    const beforeEnd = hasBefore ? iso(b.before_end, 'before_end') : null, afterStart = hasAfter ? iso(b.after_start, 'after_start') : null;
    if (hasBefore && !(beforeEnd > a.start && beforeEnd <= dayFrom)) throw bad('The day before doesn\'t line up with the visit');
    if (hasAfter && !(afterStart >= dayTo && afterStart < a.end)) throw bad('The day after doesn\'t line up with the visit');
    const oldCrew = all(db, 'SELECT user_id FROM appointment_techs WHERE appointment_id = ?', a.id).map(r => r.user_id);
    const base = { job_id: a.job_id, estimate_id: a.estimate_id, status: a.status, notes: a.notes };
    // the customer was told the visit's times; splitting it out doesn't change them unless this day's hours changed
    const told = seg => a.confirmed_at ? { confirmed_at: a.confirmed_at, confirmed_to: a.confirmed_to, confirm_count: a.confirm_count,
      confirmed_start: seg.keep ? seg.start : a.confirmed_start, confirmed_end: seg.keep ? seg.end : a.confirmed_end } : {};
    const segs = [];
    if (hasBefore) segs.push({ start: a.start, end: beforeEnd, crew: oldCrew, keep: true });
    if (!b.remove) segs.push({ start, end, crew, keep: !b.times_changed, day: true });
    if (hasAfter) segs.push({ start: afterStart, end: a.end, crew: oldCrew, keep: true });
    // the original row becomes the first piece (time entries and history already point at it); the rest are new rows
    const ids = segs.map((seg, i) => {
      if (i === 0) { update('appointments', a.id, { start: seg.start, end: seg.end, ...told(seg) }); setApptTechs(a.id, a.job_id, seg.crew, { silent: true }); return a.id; }
      const id = insert('appointments', { ...base, start: seg.start, end: seg.end, ...told(seg) });
      setApptTechs(id, a.job_id, seg.crew, { silent: true }); return id;
    });
    // notices for the one day that changed: added, taken off, or its hours moved
    const di = segs.findIndex(x => x.day);
    if (di >= 0 && live(ids[di])) {
      for (const uid of crew) {
        const type = !oldCrew.includes(uid) ? 'assigned' : b.times_changed ? 'moved' : null;
        if (type) Push.queue({ type, user_id: uid, appt_id: ids[di], job_id: a.job_id });
      }
      for (const uid of oldCrew) if (!crew.includes(uid)) Push.queue({ type: 'removed', user_id: uid, appt_id: ids[di], job_id: a.job_id });
    }
    // clocked time follows the piece of the visit it happened in
    for (const t of all(db, 'SELECT id, clock_in FROM time_entries WHERE appointment_id = ?', a.id)) {
      let k = 0; segs.forEach((seg, i) => { if (Date.parse(seg.start) <= Date.parse(t.clock_in)) k = i; });
      if (ids[k] !== a.id) run(db, 'UPDATE time_entries SET appointment_id = ? WHERE id = ?', ids[k], t.id);
    }
    syncJobSchedule(a.job_id);
    if (b.remove) return res.json({ id: null, ids, removed: true });
    const dayId = ids[segs.findIndex(s => s.day)];
    res.json({ id: dayId, ids, conflicts: conflicts(dayId) });
  }));
  app.delete('/api/appointments/:id', office, wrap((req, res) => {
    const a = mustGet('appointments', req.params.id);
    // the visit is gone by the time the notice goes out, so its wording is made now
    if (live(a.id)) { const msg = Push.message({ type: 'cancelled', appt_id: a.id }); for (const uid of crewOf(a.id)) Push.queue({ type: 'cancelled', user_id: uid, appt_id: a.id, job_id: a.job_id, msg }); }
    run(db, 'DELETE FROM appointments WHERE id = ?', a.id); syncJobSchedule(a.job_id); res.json({ ok: true });
  }));
  // ================================================================ attendance
  // Time off (planned), called in sick, absent (no-call flag), in late and left early, per person and day range.
  // Shown on the schedule, warned about when someone is booked on a day off, and counted by the KPI tracker.
  const ATT_KINDS = ['time_off', 'sick', 'absent', 'late', 'left_early'];
  const OFF_KINDS = ['time_off', 'sick', 'absent'];   // the person isn't available (a full day, or `hours` of it)
  const isDay = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
  const attRows = (where, params) => all(db, `SELECT a.*, u.name user_name, u.role user_role, cb.name created_by_name FROM attendance a JOIN users u ON u.id = a.user_id
    LEFT JOIN users cb ON cb.id = a.created_by WHERE ${where} ORDER BY a.start_date, u.name`, ...params);
  app.get('/api/attendance', wrap((req, res) => {
    const from = isDay(req.query.from) ? req.query.from : '0000-01-01', to = isDay(req.query.to) ? req.query.to : '9999-12-31';
    const w = ['a.start_date <= ?', 'a.end_date >= ?'], p = [to, from];
    const isOff = ['admin', 'manager', 'office'].includes(req.user.role);
    if (!isOff) { w.push('a.user_id = ?'); p.push(req.user.id); }
    else if (req.query.user_id) { w.push('a.user_id = ?'); p.push(+req.query.user_id); }
    const rows = attRows(w.join(' AND '), p);
    if (!isOff) for (const r of rows) delete r.reason;   // the office's note stays with the office
    res.json(rows);
  }));
  function attData(b, prev = {}) {
    const d = pick(b, ['user_id', 'kind', 'start_date', 'end_date', 'hours', 'minutes', 'paid', 'no_call', 'reason']);
    const m = { ...prev, ...d };
    if (!ATT_KINDS.includes(m.kind)) throw bad('Pick time off, sick, absent, in late or left early');
    if (!get(db, 'SELECT 1 FROM users WHERE id = ?', +m.user_id)) throw bad('Pick the employee');
    if (!isDay(m.start_date)) throw bad('Pick the date');
    if (!m.end_date || ['late', 'left_early'].includes(m.kind)) m.end_date = m.start_date;
    if (!isDay(m.end_date) || m.end_date < m.start_date) throw bad('The end date is before the start date');
    if (addDays(m.start_date, 366) < m.end_date) throw bad('That is more than a year');
    const num = v => (v === '' || v == null ? null : Number(v));
    m.hours = OFF_KINDS.includes(m.kind) ? num(m.hours) : null;
    if (m.hours != null && !(m.hours > 0 && m.hours <= 24)) throw bad('Hours off must be between 0 and 24 (leave blank for the full day)');
    m.minutes = ['late', 'left_early'].includes(m.kind) ? num(m.minutes) : null;
    if (['late', 'left_early'].includes(m.kind) && !(m.minutes > 0 && m.minutes <= 720)) throw bad(m.kind === 'late' ? 'How many minutes late?' : 'How many minutes early did they leave?');
    m.paid = ['time_off', 'sick'].includes(m.kind) && m.paid ? 1 : 0;
    m.no_call = m.kind === 'absent' && m.no_call ? 1 : 0;
    m.reason = m.reason ? String(m.reason).trim().slice(0, 500) : null;
    return { user_id: +m.user_id, kind: m.kind, start_date: m.start_date, end_date: m.end_date, hours: m.hours, minutes: m.minutes, paid: m.paid, no_call: m.no_call, reason: m.reason };
  }
  // booked visits that fall on the days off (a warning back to the office, not a stop)
  function attClashes(row) {
    if (!OFF_KINDS.includes(row.kind)) return [];
    return H.appointments(`a.status != 'cancelled' AND EXISTS (SELECT 1 FROM appointment_techs t WHERE t.appointment_id = a.id AND t.user_id = ?) AND a.start < ? AND a.end > ?`,
      [row.user_id, localToUtc(`${addDays(row.end_date, 1)} 00:00`), localToUtc(`${row.start_date} 00:00`)]).map(a => ({ id: a.id, job_number: a.job_number, start: a.start, end: a.end, href: a.href }));
  }
  app.post('/api/attendance', office, wrap((req, res) => {
    const d = attData(req.body);
    const id = insert('attendance', { ...d, created_by: req.user.id });
    res.json({ id, booked: attClashes(d) });
  }));
  app.put('/api/attendance/:id', office, wrap((req, res) => {
    const prev = mustGet('attendance', +req.params.id), d = attData(req.body, prev);
    update('attendance', prev.id, d);
    res.json({ ok: true, booked: attClashes(d) });
  }));
  app.delete('/api/attendance/:id', office, wrap((req, res) => { mustGet('attendance', +req.params.id); run(db, 'DELETE FROM attendance WHERE id = ?', +req.params.id); res.json({ ok: true }); }));
  // company time zone: dates on the schedule are the company's days, not the server's
  const companyTz = () => { const z = (D.settings(db) || {}).timezone || 'America/Boise'; try { new Intl.DateTimeFormat('en-US', { timeZone: z }); return z; } catch { return 'America/Boise'; } };
  const localToUtc = local => require('./kpi').localToUtc(local, companyTz());
  const localDay = iso => { const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: companyTz(), year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(iso)).map(x => [x.type, x.value])); return `${p.year}-${p.month}-${p.day}`; };
  // who on this visit is off (time off / sick / absent) on one of its days
  function offConflicts(apptId) {
    const a = get(db, 'SELECT * FROM appointments WHERE id = ?', apptId); if (!a) return [];
    const d0 = localDay(a.start), d1 = localDay(new Date(Date.parse(a.end) - 1).toISOString());
    return all(db, `SELECT DISTINCT u.name, at.kind, at.start_date, at.end_date, at.hours FROM appointment_techs t JOIN attendance at ON at.user_id = t.user_id JOIN users u ON u.id = t.user_id
      WHERE t.appointment_id = ? AND at.kind IN ('time_off','sick','absent') AND at.start_date <= ? AND at.end_date >= ?`, apptId, d1, d0);
  }

  // Overlaps for any tech on this appointment (double-booking warning, not a hard stop), plus anyone who is off that day.
  function conflicts(apptId) {
    const a = get(db, 'SELECT * FROM appointments WHERE id = ?', apptId);
    const off = offConflicts(apptId).map(o => ({ name: o.name, off: o.kind, job_number: o.kind === 'time_off' ? 'time off' : o.kind === 'sick' ? 'out sick' : 'absent',
      start: o.start_date, end: o.end_date, hours: o.hours }));
    return [...off, ...all(db, `SELECT DISTINCT u.name, a2.id appointment_id, COALESCE(j.number, e.number) job_number, a2.start, a2.end FROM appointment_techs t1
      JOIN appointment_techs t2 ON t2.user_id = t1.user_id AND t2.appointment_id != t1.appointment_id
      JOIN appointments a2 ON a2.id = t2.appointment_id AND a2.status != 'cancelled' JOIN users u ON u.id = t1.user_id
      LEFT JOIN jobs j ON j.id = a2.job_id LEFT JOIN estimates e ON e.id = a2.estimate_id
      WHERE t1.appointment_id = ? AND a2.start < ? AND a2.end > ?`, apptId, a.end, a.start)];
  }
  // En route / on site / done from the field. On site clocks the tech in; done clocks them out.
  function techStatus(a, status, user, g = { lat: null, lng: null, acc: null }) {
    if (!['dispatched', 'en_route', 'on_site', 'done'].includes(status)) throw bad('Invalid status');
    run(db, 'UPDATE appointments SET status = ? WHERE id = ?', status, a.id);
    const now = new Date().toISOString();
    const u = get(db, 'SELECT * FROM users WHERE id = ?', user.id);
    const rate = r2(u.hourly_wage * (1 + (u.burden_pct || 0) / 100));
    if (status === 'en_route' || status === 'on_site') {
      run(db, 'UPDATE time_entries SET clock_out = ?, out_lat = ?, out_lng = ?, out_acc = ? WHERE user_id = ? AND clock_out IS NULL', now, g.lat, g.lng, g.acc, u.id);
      insert('time_entries', { user_id: u.id, job_id: a.job_id, appointment_id: a.id, kind: status === 'en_route' ? 'travel' : 'job', clock_in: now, hourly_cost: rate, hourly_wage: u.hourly_wage,
        in_lat: g.lat, in_lng: g.lng, in_acc: g.acc, notes: a.estimate_id ? `Estimate visit ${(get(db, 'SELECT number FROM estimates WHERE id = ?', a.estimate_id) || {}).number || ''}`.trim() : null });
      if (status === 'on_site') run(db, "UPDATE jobs SET status = 'in_progress' WHERE id = ? AND status IN ('scheduled','dispatched','unscheduled')", a.job_id);
    }
    if (status === 'done') run(db, 'UPDATE time_entries SET clock_out = ?, out_lat = ?, out_lng = ?, out_acc = ? WHERE user_id = ? AND clock_out IS NULL AND (appointment_id = ? OR job_id IS ?)', now, g.lat, g.lng, g.acc, u.id, a.id, a.job_id);
    return { ok: true };
  }

  // Tech availability for the dispatch view: scheduled hours today + what they're clocked into.
  app.get('/api/dispatch', office, wrap((req, res) => {
    const day = req.query.date || today();
    const from = C.startOfDay(day), to = C.endOfDay(day);
    const appts = H.appointments("a.start < ? AND a.end > ? AND a.status != 'cancelled'", [to, from]);
    const techs = all(db, "SELECT id, name, color, title, phone FROM users WHERE active = 1 AND role = 'tech' ORDER BY name").map(u => {
      const mine = appts.filter(a => a.tech_ids.includes(u.id));
      const clock = get(db, `SELECT t.*, j.number job_number FROM time_entries t LEFT JOIN jobs j ON j.id = t.job_id WHERE t.user_id = ? AND t.clock_out IS NULL`, u.id);
      return { ...u, booked_hours: r2(mine.reduce((s, a) => s + C.visitHoursOnDay(a, day), 0)), appointments: mine.length, clock };
    });
    const unscheduled = all(db, `${X.jobSelect} WHERE j.status = 'unscheduled' OR (j.status IN ('scheduled','dispatched','on_hold','in_progress')
      AND NOT EXISTS (SELECT 1 FROM appointments a WHERE a.job_id = j.id AND a.status NOT IN ('cancelled','done') AND a.end > ?)) ORDER BY CASE j.priority WHEN 'emergency' THEN 0 WHEN 'high' THEN 1 ELSE 2 END, j.id`, from).map(X.fixTechs);
    res.json({ date: day, appointments: appts, techs, unscheduled, unassigned: appts.filter(a => !a.tech_ids.length) });
  }));

  // ================================================================ cost codes & budgets
  app.get('/api/cost-codes', wrap((req, res) => res.json(all(db, `SELECT * FROM cost_codes ${req.query.all ? '' : 'WHERE active = 1'} ORDER BY code`))));
  app.post('/api/cost-codes', office, wrap((req, res) => {
    if (!req.body.code || !req.body.name) throw bad('Code and name are required');
    res.json({ id: insert('cost_codes', pick(req.body, ['code', 'name', 'kind', 'active', 'ply_code'])) });
  }));
  app.put('/api/cost-codes/:id', office, wrap((req, res) => { update('cost_codes', req.params.id, pick(req.body, ['code', 'name', 'kind', 'active', 'ply_code'])); res.json({ ok: true }); }));

  function setBudgets(jobId, rows) {
    // keep the % complete already reported on each code when the budget numbers change
    const progress = all(db, 'SELECT cost_code_id, percent_complete FROM job_budgets WHERE job_id = ? AND percent_complete IS NOT NULL', jobId);
    run(db, 'DELETE FROM job_budgets WHERE job_id = ?', jobId);
    for (const b of rows) {
      if (!b.cost_code_id) continue;
      if (!(Number(b.budget_hours) || Number(b.budget_material) || Number(b.budget_other))) continue;
      run(db, `INSERT INTO job_budgets (job_id, cost_code_id, budget_hours, budget_material, budget_other) VALUES (?,?,?,?,?)
        ON CONFLICT(job_id, cost_code_id) DO UPDATE SET budget_hours = budget_hours + excluded.budget_hours, budget_material = budget_material + excluded.budget_material, budget_other = budget_other + excluded.budget_other`,
      jobId, b.cost_code_id, Number(b.budget_hours) || 0, Number(b.budget_material) || 0, Number(b.budget_other) || 0);
    }
    for (const p of progress) run(db, 'UPDATE job_budgets SET percent_complete = ? WHERE job_id = ? AND cost_code_id = ?', p.percent_complete, jobId, p.cost_code_id);
    const t = get(db, 'SELECT SUM(budget_hours) h, SUM(budget_material) m FROM job_budgets WHERE job_id = ?', jobId);
    if (t.h != null) run(db, 'UPDATE jobs SET budget_hours = ?, budget_materials = ? WHERE id = ?', r2(t.h), r2(t.m), jobId);
  }
  // Approved estimate → budget per cost code (flat-rate labor hours and material cost from the price book).
  H.budgetsFromEstimate = (jobId, estimateId) => {
    const chosen = new Set(C.estimateChosenItems(db, estimateId).map(i => i.id));
    const items = all(db, `SELECT ei.*, pb.labor_hours, pb.kind, pb.cost_code_id pb_code FROM estimate_items ei LEFT JOIN pricebook pb ON pb.id = ei.pricebook_id WHERE estimate_id = ?`, estimateId).filter(i => chosen.has(i.id));
    const fallback = get(db, "SELECT id FROM cost_codes WHERE code = '400'");
    const rows = items.map(it => {
      const code = it.cost_code_id || it.pb_code || (fallback && fallback.id);
      const hours = (it.labor_hours || 0) * it.qty;
      const isMat = it.kind === 'material';
      // flat-rate service lines: cost covers material; labor tracked as hours
      return { cost_code_id: code, budget_hours: hours, budget_material: isMat || it.kind === 'service' ? it.unit_cost * it.qty : 0, budget_other: it.kind === 'equipment' ? it.unit_cost * it.qty : 0 };
    });
    setBudgets(jobId, rows);
  };
  app.put('/api/jobs/:id/budgets', office, wrap((req, res) => { mustGet('jobs', req.params.id); setBudgets(Number(req.params.id), req.body.budgets || []); res.json({ ok: true }); }));
  app.get('/api/reports/cost-codes', office, wrap((req, res) => res.json(C.costCodeReport(db, req.query.from || today().slice(0, 8) + '01', req.query.to || today()))));

  // ================================================================ vendors
  const VENDOR_FIELDS = ['name', 'contact', 'email', 'phone', 'address', 'account_number', 'terms_days', 'default_account_id', 'ply_vendor_id', 'active', 'notes'];
  // money on bills (what we owe, what we've spent) only for people who can see accounting
  const seesBills = req => req.user.role === 'admin' || req.can('accounting');
  const yearAgo = () => { const d = new Date(); d.setFullYear(d.getFullYear() - 1); return d.toISOString().slice(0, 10); };
  app.get('/api/vendors', office, wrap((req, res) => {
    const rows = all(db, `SELECT v.*,
      (SELECT COUNT(*) FROM purchase_orders p WHERE p.vendor_id = v.id) po_count,
      (SELECT COUNT(*) FROM purchase_orders p WHERE p.vendor_id = v.id AND p.status IN ('draft','submitted','partial')) open_po_count,
      (SELECT MAX(order_date) FROM purchase_orders p WHERE p.vendor_id = v.id) last_po_date,
      (SELECT COUNT(*) FROM pricebook pb WHERE pb.vendor_id = v.id AND pb.active = 1) item_count
      FROM vendors v ORDER BY active DESC, name COLLATE NOCASE`);
    const cs = all(db, 'SELECT * FROM vendor_contacts ORDER BY sort, id');
    for (const v of rows) v.contacts = cs.filter(c => c.vendor_id === v.id);
    if (req.query.detail && seesBills(req)) {
      const since = yearAgo();
      const bills = all(db, "SELECT * FROM bills WHERE status != 'void'").map(b => A.billTotals(db, b));
      for (const v of rows) {
        const mine = bills.filter(b => b.vendor_id === v.id);
        v.owed = r2(mine.reduce((s, b) => s + b.balance, 0));
        v.overdue = r2(mine.filter(b => b.balance > 0.004 && b.due_date && b.due_date < new Date().toISOString().slice(0, 10)).reduce((s, b) => s + b.balance, 0));
        v.spend_12mo = r2(mine.filter(b => b.bill_date >= since).reduce((s, b) => s + b.total, 0));
      }
    }
    res.json(rows);
  }));
  app.get('/api/vendors/:id', office, wrap((req, res) => {
    const v = mustGet('vendors', req.params.id);
    v.purchase_orders = all(db, `SELECT p.*, j.number job_number FROM purchase_orders p LEFT JOIN jobs j ON j.id = p.job_id WHERE p.vendor_id = ? ORDER BY p.id DESC LIMIT 100`, v.id).map(H.poTotals);
    v.items = all(db, 'SELECT id, code, name, unit_cost, qty_on_hand, reorder_point, active FROM pricebook WHERE vendor_id = ? ORDER BY name COLLATE NOCASE', v.id);
    v.contacts = all(db, 'SELECT * FROM vendor_contacts WHERE vendor_id = ? ORDER BY sort, id', v.id);
    v.sees_bills = seesBills(req);
    if (v.sees_bills) {
      v.bills = all(db, 'SELECT * FROM bills WHERE vendor_id = ? ORDER BY bill_date DESC, id DESC LIMIT 100', v.id).map(b => { const t = A.billTotals(db, b); delete t.lines; delete t.payments; return t; });
      const live = v.bills.filter(b => b.status !== 'void');
      v.owed = r2(live.reduce((s, b) => s + b.balance, 0));
      v.spend_12mo = r2(live.filter(b => b.bill_date >= yearAgo()).reduce((s, b) => s + b.total, 0));
    }
    res.json(v);
  }));
  app.post('/api/vendors', office, wrap((req, res) => {
    const name = String(req.body.name || '').trim(); if (!name) throw bad('Vendor name is required');
    if (get(db, 'SELECT id FROM vendors WHERE name = ? COLLATE NOCASE', name)) throw bad(`${name} is already a vendor`);
    res.json({ id: insert('vendors', { ...pick(req.body, VENDOR_FIELDS), name }) });
  }));
  app.put('/api/vendors/:id', office, wrap((req, res) => {
    mustGet('vendors', req.params.id);
    if ('name' in req.body) {
      const name = String(req.body.name || '').trim(); if (!name) throw bad('Vendor name is required');
      if (get(db, 'SELECT id FROM vendors WHERE name = ? COLLATE NOCASE AND id != ?', name, req.params.id)) throw bad(`${name} is already a vendor`);
    }
    update('vendors', req.params.id, pick(req.body, VENDOR_FIELDS)); res.json({ ok: true });
  }));
  // ---- vendor contacts: as many people per vendor as needed; the first one shows as the vendor's contact
  const CONTACT_FIELDS = ['name', 'role', 'email', 'phone', 'gets_pos', 'notes', 'sort'];
  const cleanContact = b => {
    const o = pick(b, CONTACT_FIELDS);
    for (const k of ['name', 'role', 'email', 'phone', 'notes']) if (k in o) o[k] = String(o[k] ?? '').trim().slice(0, k === 'notes' ? 1000 : 200) || null;
    if ('gets_pos' in o) o.gets_pos = o.gets_pos ? 1 : 0;
    if (o.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(o.email)) throw bad(`"${o.email}" doesn't look like an email address`);
    return o;
  };
  const syncPrimary = vendorId => {
    const c = get(db, 'SELECT * FROM vendor_contacts WHERE vendor_id = ? ORDER BY sort, id LIMIT 1', vendorId);
    run(db, 'UPDATE vendors SET contact = ? WHERE id = ?', c ? c.name : null, vendorId);
  };
  app.post('/api/vendors/:id/contacts', office, wrap((req, res) => {
    const v = mustGet('vendors', req.params.id), o = cleanContact(req.body || {});
    if (!o.name && !o.email && !o.phone) throw bad('Give the contact a name, email or phone');
    const sort = (get(db, 'SELECT MAX(sort) m FROM vendor_contacts WHERE vendor_id = ?', v.id).m ?? -1) + 1;
    const id = insert('vendor_contacts', { ...o, vendor_id: v.id, sort: o.sort ?? sort });
    syncPrimary(v.id); res.json({ id });
  }));
  app.put('/api/vendor-contacts/:id', office, wrap((req, res) => {
    const c = mustGet('vendor_contacts', req.params.id), o = cleanContact(req.body || {});
    const after = { ...c, ...o }; if (!after.name && !after.email && !after.phone) throw bad('Give the contact a name, email or phone');
    update('vendor_contacts', c.id, o); syncPrimary(c.vendor_id); res.json({ ok: true });
  }));
  app.delete('/api/vendor-contacts/:id', office, wrap((req, res) => {
    const c = mustGet('vendor_contacts', req.params.id);
    run(db, 'DELETE FROM vendor_contacts WHERE id = ?', c.id); syncPrimary(c.vendor_id); res.json({ ok: true });
  }));
  // who a PO goes to: contacts marked "gets POs", else the vendor's main email
  H.poEmails = vendorId => {
    const list = all(db, "SELECT email FROM vendor_contacts WHERE vendor_id = ? AND gets_pos = 1 AND COALESCE(email, '') != '' ORDER BY sort, id", vendorId).map(r => r.email);
    if (list.length) return list;
    const v = get(db, 'SELECT email FROM vendors WHERE id = ?', vendorId); return v && v.email ? [v.email] : [];
  };

  // delete only a vendor nothing points at; anything with history is made inactive instead
  app.delete('/api/vendors/:id', office, wrap((req, res) => {
    const v = mustGet('vendors', req.params.id);
    const uses = [['purchase order', 'purchase_orders'], ['bill', 'bills'], ['price book item', 'pricebook'], ['accounting entry', 'journal_lines']]
      .map(([n, t]) => { try { return [n, get(db, `SELECT COUNT(*) n FROM ${t} WHERE vendor_id = ?`, v.id).n]; } catch { return [n, 0]; } }).filter(([, n]) => n);
    if (uses.length) throw bad(`${v.name} has ${uses.map(([n, c]) => `${c} ${n}${c === 1 ? '' : 's'}`).join(', ')} — make it inactive instead, so that history keeps its vendor`, 409);
    run(db, 'DELETE FROM vendors WHERE id = ?', v.id); res.json({ ok: true });
  }));

  // ================================================================ purchase orders
  H.poTotals = po => {
    const lines = all(db, `SELECT pl.*, cc.code cost_code, pb.code sku, pb.qty_on_hand FROM po_lines pl LEFT JOIN cost_codes cc ON cc.id = pl.cost_code_id
      LEFT JOIN pricebook pb ON pb.id = pl.pricebook_id WHERE po_id = ? ORDER BY sort, id`, po.id);
    const subtotal = r2(lines.reduce((s, l) => s + l.qty * l.unit_cost, 0));
    const received_value = r2(lines.reduce((s, l) => s + l.qty_received * l.unit_cost, 0));
    const billed = get(db, "SELECT COUNT(*) n FROM bills WHERE po_id = ? AND status != 'void'", po.id).n > 0;
    return { ...po, lines, subtotal, total: r2(subtotal + (po.tax || 0) + (po.shipping || 0)), received_value, billed };
  };
  function savePOLines(poId, lines) {
    if (!Array.isArray(lines)) return;
    const keep = new Set();
    lines.forEach((l, i) => {
      if (!l.description) return;
      const data = { pricebook_id: l.pricebook_id || null, description: l.description, qty: Number(l.qty) || 0, unit_cost: Number(l.unit_cost) || 0, cost_code_id: l.cost_code_id || null, sort: i };
      if (l.id && get(db, 'SELECT 1 x FROM po_lines WHERE id = ? AND po_id = ?', l.id, poId)) { update('po_lines', l.id, data); keep.add(Number(l.id)); }
      else keep.add(insert('po_lines', { po_id: poId, ...data }));
    });
    for (const l of all(db, 'SELECT id, qty_received FROM po_lines WHERE po_id = ?', poId))
      if (!keep.has(l.id)) { if (l.qty_received > 0) throw bad('Cannot remove a line that has been received'); run(db, 'DELETE FROM po_lines WHERE id = ?', l.id); }
  }
  const PO_FIELDS = ['vendor_id', 'job_id', 'deliver_to', 'order_date', 'expected_date', 'tax', 'shipping', 'notes'];
  app.get('/api/purchase-orders', office, wrap((req, res) => {
    const where = [], p = [];
    if (req.query.status) { where.push(`p.status IN (${req.query.status.split(',').map(() => '?').join(',')})`); p.push(...req.query.status.split(',')); }
    if (req.query.job_id) { where.push('p.job_id = ?'); p.push(req.query.job_id); }
    res.json(all(db, `SELECT p.*, v.name vendor_name, j.number job_number FROM purchase_orders p JOIN vendors v ON v.id = p.vendor_id LEFT JOIN jobs j ON j.id = p.job_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY p.id DESC LIMIT 500`, ...p).map(H.poTotals));
  }));
  app.get('/api/purchase-orders/:id', office, wrap((req, res) => {
    const po = H.poTotals(get(db, `SELECT p.*, v.name vendor_name, v.email vendor_email, j.number job_number, j.title job_title FROM purchase_orders p
      JOIN vendors v ON v.id = p.vendor_id LEFT JOIN jobs j ON j.id = p.job_id WHERE p.id = ?`, req.params.id) || (() => { throw bad('Not found', 404); })());
    po.receipts = all(db, `SELECT r.*, pl.description, u.name user_name FROM po_receipts r JOIN po_lines pl ON pl.id = r.po_line_id LEFT JOIN users u ON u.id = r.user_id WHERE pl.po_id = ? ORDER BY r.id DESC`, po.id);
    po.bills = all(db, 'SELECT * FROM bills WHERE po_id = ? ORDER BY id DESC', po.id).map(b => A.billTotals(db, b));
    po.to_emails = H.poEmails(po.vendor_id);
    res.json(po);
  }));
  app.post('/api/purchase-orders', office, wrap((req, res) => {
    const b = req.body;
    if (!b.vendor_id) throw bad('Vendor is required');
    const id = insert('purchase_orders', { ...pick(b, PO_FIELDS), deliver_to: b.deliver_to || (b.job_id ? 'job' : 'shop'), number: D.nextNumber(db, 'purchase_orders', 'PO'), created_by: req.user.id });
    savePOLines(id, b.lines || []);
    res.json({ id });
  }));
  app.put('/api/purchase-orders/:id', office, wrap((req, res) => {
    const po = mustGet('purchase_orders', req.params.id);
    if (['received', 'cancelled'].includes(po.status) && req.body.lines) throw bad(`PO is ${po.status} — lines are locked`);
    update('purchase_orders', po.id, { ...pick(req.body, PO_FIELDS), ...(req.body.status === 'cancelled' ? { status: 'cancelled' } : {}) });
    savePOLines(po.id, req.body.lines);
    res.json({ ok: true });
  }));
  app.delete('/api/purchase-orders/:id', office, wrap((req, res) => {
    const po = mustGet('purchase_orders', req.params.id);
    if (po.status !== 'draft') throw bad('Only draft POs can be deleted — cancel it instead');
    run(db, 'DELETE FROM purchase_orders WHERE id = ?', po.id); res.json({ ok: true });
  }));
  app.post('/api/purchase-orders/:id/submit', office, wrap(async (req, res) => {
    const po = mustGet('purchase_orders', req.params.id);
    if (!get(db, 'SELECT COUNT(*) n FROM po_lines WHERE po_id = ?', po.id).n) throw bad('PO has no lines');
    if (po.status === 'draft') run(db, "UPDATE purchase_orders SET status = 'submitted', order_date = ? WHERE id = ?", today(), po.id);
    let ply = null;
    if (req.body.send_to_ply) ply = await Ply.pushPO(db, po.id, { createMissing: !!req.body.create_missing });
    res.json({ ok: true, ply });
  }));

  // Receive goods. Job POs become job materials at PO cost; shop POs go into stock (weighted-average cost).
  H.receivePO = (poId, lines, userId, source = 'manual') => {
    const po = mustGet('purchase_orders', poId);
    if (po.status === 'cancelled') throw bad('PO is cancelled');
    for (const r of lines) {
      const qty = Number(r.qty); if (!(qty > 0)) continue;
      const l = get(db, 'SELECT * FROM po_lines WHERE id = ? AND po_id = ?', r.po_line_id, po.id);
      if (!l) throw bad('PO line not found');
      if (l.qty_received + qty > l.qty + 1e-9 && source !== 'ply') throw bad(`Receiving ${qty} of "${l.description}" exceeds the ${l.qty - l.qty_received} still open`);
      run(db, 'UPDATE po_lines SET qty_received = qty_received + ? WHERE id = ?', qty, l.id);
      let jmId = null;
      if (po.job_id && po.deliver_to !== 'shop') {
        const pb = l.pricebook_id ? get(db, 'SELECT unit_price FROM pricebook WHERE id = ?', l.pricebook_id) : null;
        jmId = insert('job_materials', { job_id: po.job_id, pricebook_id: l.pricebook_id, description: l.description, qty, unit_cost: l.unit_cost,
          unit_price: pb ? pb.unit_price : r2(l.unit_cost * 1.5), billable: 1, source: 'po', po_line_id: l.id, cost_code_id: l.cost_code_id, user_id: userId, used_on: today() });
      } else if (l.pricebook_id) {
        const pb = get(db, 'SELECT qty_on_hand, unit_cost FROM pricebook WHERE id = ?', l.pricebook_id);
        const oh = Math.max(0, pb.qty_on_hand);
        const avg = oh + qty > 0 ? r2((oh * pb.unit_cost + qty * l.unit_cost) / (oh + qty)) : l.unit_cost;
        run(db, 'UPDATE pricebook SET qty_on_hand = qty_on_hand + ?, unit_cost = ? WHERE id = ?', qty, avg, l.pricebook_id);
      }
      insert('po_receipts', { po_line_id: l.id, qty, job_material_id: jmId, user_id: userId, source });
    }
    const t = get(db, 'SELECT SUM(qty) q, SUM(MIN(qty_received, qty)) r FROM po_lines WHERE po_id = ?', po.id);
    run(db, 'UPDATE purchase_orders SET status = ? WHERE id = ?', t.r >= t.q - 1e-9 ? 'received' : t.r > 0 ? 'partial' : po.status === 'draft' ? 'submitted' : po.status, po.id);
  };
  app.post('/api/purchase-orders/:id/receive', office, wrap((req, res) => {
    const po = mustGet('purchase_orders', req.params.id);
    const lines = req.body.all
      ? all(db, 'SELECT id po_line_id, qty - qty_received qty FROM po_lines WHERE po_id = ? AND qty > qty_received', po.id)
      : (req.body.lines || []);
    H.receivePO(po.id, lines, req.user.id);
    res.json({ ok: true });
  }));

  // Vendor bill from a PO: job deliveries cost to Job Materials, shop deliveries to Inventory.
  H.billFromPO = (poId, { vendor_invoice, bill_date, total, ply_id } = {}) => {
    const po = H.poTotals(mustGet('purchase_orders', poId));
    const vendor = mustGet('vendors', po.vendor_id);
    const toJob = po.job_id && po.deliver_to !== 'shop';
    const acct = A.accountId(db, toJob ? '5100' : '1300');
    const date = bill_date || today();
    const billId = insert('bills', { vendor_id: vendor.id, po_id: po.id, vendor_invoice: vendor_invoice || null, bill_date: date, due_date: addDays(date, vendor.terms_days || 30), ply_id: ply_id || null, memo: `PO ${po.number}` });
    for (const l of po.lines) {
      const qty = l.qty_received > 0 ? l.qty_received : l.qty;
      insert('bill_lines', { bill_id: billId, account_id: acct, description: `${qty} × ${l.description}`, amount: r2(qty * l.unit_cost), job_id: toJob ? po.job_id : null, cost_code_id: l.cost_code_id });
    }
    if (po.tax) insert('bill_lines', { bill_id: billId, account_id: acct, description: 'Sales tax', amount: po.tax, job_id: toJob ? po.job_id : null });
    if (po.shipping) insert('bill_lines', { bill_id: billId, account_id: acct, description: 'Freight / delivery', amount: po.shipping, job_id: toJob ? po.job_id : null });
    // Supplier invoice total differs from PO? book the difference so AP matches what we actually owe.
    const sum = get(db, 'SELECT SUM(amount) s FROM bill_lines WHERE bill_id = ?', billId).s || 0;
    if (total != null && Math.abs(Number(total) - sum) >= 0.01)
      insert('bill_lines', { bill_id: billId, account_id: acct, description: 'Price variance vs PO', amount: r2(Number(total) - sum), job_id: toJob ? po.job_id : null });
    A.postBill(db, billId);
    return billId;
  };
  app.post('/api/purchase-orders/:id/bill', office, wrap((req, res) => res.json({ id: H.billFromPO(Number(req.params.id), req.body) })));

  // Reorder: one draft PO per vendor for every stocked item at/below its reorder point.
  app.post('/api/purchase-orders/reorder', office, wrap((req, res) => {
    const items = all(db, "SELECT * FROM pricebook WHERE active = 1 AND kind = 'material' AND reorder_point > 0 AND qty_on_hand <= reorder_point");
    const byVendor = new Map();
    for (const it of items) {
      const vid = it.vendor_id || (it.vendor && (get(db, 'SELECT id FROM vendors WHERE name = ?', it.vendor) || {}).id) || req.body.vendor_id;
      if (!vid) continue;
      if (!byVendor.has(vid)) byVendor.set(vid, []);
      // order back up to 2× the reorder point
      byVendor.get(vid).push({ pricebook_id: it.id, description: it.name, qty: Math.max(1, Math.ceil(it.reorder_point * 2 - it.qty_on_hand)), unit_cost: it.unit_cost, cost_code_id: it.cost_code_id });
    }
    const created = [];
    for (const [vid, lines] of byVendor) {
      const id = insert('purchase_orders', { vendor_id: vid, deliver_to: 'shop', number: D.nextNumber(db, 'purchase_orders', 'PO'), created_by: req.user.id, notes: 'Stock reorder' });
      savePOLines(id, lines); created.push(id);
    }
    res.json({ created, skipped_without_vendor: items.length - [...byVendor.values()].reduce((s, l) => s + l.length, 0) });
  }));

  // ================================================================ pick lists
  app.get('/api/pick-lists', wrap((req, res) => {
    const where = [], p = [];
    if (req.query.status) { where.push(`pl.status IN (${req.query.status.split(',').map(() => '?').join(',')})`); p.push(...req.query.status.split(',')); }
    if (req.user.role === 'tech') { where.push('(pl.assigned_to = ? OR EXISTS (SELECT 1 FROM job_techs jt WHERE jt.job_id = pl.job_id AND jt.user_id = ?))'); p.push(req.user.id, req.user.id); }
    res.json(all(db, `SELECT pl.*, j.number job_number, j.title job_title, u.name assigned_name,
      (SELECT COUNT(*) FROM pick_list_lines l WHERE l.pick_list_id = pl.id) line_count FROM pick_lists pl JOIN jobs j ON j.id = pl.job_id LEFT JOIN users u ON u.id = pl.assigned_to
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY CASE pl.status WHEN 'open' THEN 0 WHEN 'picking' THEN 1 ELSE 2 END, COALESCE(pl.needed_by, '9999'), pl.id DESC`, ...p));
  }));
  app.get('/api/pick-lists/:id', wrap((req, res) => {
    const pl = get(db, `SELECT pl.*, j.number job_number, j.title job_title, u.name assigned_name FROM pick_lists pl JOIN jobs j ON j.id = pl.job_id LEFT JOIN users u ON u.id = pl.assigned_to WHERE pl.id = ?`, req.params.id);
    if (!pl) throw bad('Not found', 404);
    pl.lines = all(db, `SELECT l.*, pb.code sku, pb.qty_on_hand, COALESCE(l.unit, pb.unit) unit, COALESCE(l.unit_cost, pb.unit_cost) unit_cost, cc.code cost_code, cc.name cost_code_name, u.name added_by_name
      FROM pick_list_lines l LEFT JOIN pricebook pb ON pb.id = l.pricebook_id LEFT JOIN cost_codes cc ON cc.id = l.cost_code_id LEFT JOIN users u ON u.id = l.added_by
      WHERE pick_list_id = ? ORDER BY l.id`, pl.id);
    pl.can_edit = !['picked', 'delivered', 'cancelled'].includes(pl.status) && (req.user.role !== 'tech' || canTouchPick(req.user, pl));
    res.json(pl);
  }));
  // New pick list for a job. from_estimate pulls material lines off the approved estimate.
  app.post('/api/jobs/:id/pick-lists', office, wrap((req, res) => {
    const job = mustGet('jobs', req.params.id);
    const id = insert('pick_lists', { number: D.nextNumber(db, 'pick_lists', 'PL'), job_id: job.id, needed_by: req.body.needed_by || null, assigned_to: req.body.assigned_to || null, notes: req.body.notes || null });
    let lines = req.body.lines || [];
    if (req.body.from_estimate) {
      const est = get(db, "SELECT id FROM estimates WHERE job_id = ? AND status = 'approved' ORDER BY id DESC LIMIT 1", job.id);
      if (!est) throw bad('This job has no approved estimate to pull materials from');
      const chosen = new Set(C.estimateChosenItems(db, est.id).map(i => i.id));
      // price-book material lines, plus lines typed into the estimate by hand that aren't labor/service/fees
      const LABOR = /\b(labor|labour|hours?|hrs|service call|trip|permit|inspection|mobiliz|travel|fee|warranty|design|engineering|programming|commissioning|testing)\b/i;
      lines = all(db, `SELECT ei.id, ei.pricebook_id, ei.description, ei.qty, ei.unit_cost, COALESCE(ei.cost_code_id, pb.cost_code_id) cost_code_id, pb.kind
        FROM estimate_items ei LEFT JOIN pricebook pb ON pb.id = ei.pricebook_id WHERE ei.estimate_id = ?`, est.id)
        .filter(l => chosen.has(l.id) && (l.pricebook_id ? l.kind === 'material' : !LABOR.test(l.description || '')));
      if (!lines.length) throw bad('The approved estimate has no material lines. Create the pick list without it and add material by hand.');
    }
    for (const l of lines) if (l.description) insert('pick_list_lines', { pick_list_id: id, ...pickLine(l, req.user) });
    res.json({ id, lines: get(db, 'SELECT COUNT(*) n FROM pick_list_lines WHERE pick_list_id = ?', id).n });
  }));
  // A line from the price book (description/unit/cost filled from it) or typed by hand.
  function pickLine(l, user) {
    const pb = l.pricebook_id ? get(db, 'SELECT * FROM pricebook WHERE id = ?', l.pricebook_id) : null;
    const desc = String(l.description || (pb && pb.name) || '').trim().slice(0, 300);
    if (!desc) throw bad('Describe the material');
    const qty = Number(l.qty);
    if (!(qty > 0)) throw bad(`Quantity for "${desc}" must be more than 0`);
    const cost = l.unit_cost === '' || l.unit_cost == null ? null : Number(l.unit_cost);
    return { pricebook_id: pb ? pb.id : null, description: desc, qty, cost_code_id: l.cost_code_id || (pb && pb.cost_code_id) || null,
      unit: l.unit ? String(l.unit).slice(0, 20) : null, unit_cost: Number.isFinite(cost) && cost >= 0 ? cost : null, note: l.note ? String(l.note).slice(0, 300) : null, added_by: user.id };
  }
  // techs can add to pick lists for jobs they're on or lists assigned to them (field requests)
  const canTouchPick = (user, pl) => pl.assigned_to === user.id || !!get(db, 'SELECT 1 x FROM job_techs WHERE job_id = ? AND user_id = ?', pl.job_id, user.id);
  app.put('/api/pick-lists/:id', wrap((req, res) => {
    const pl = mustGet('pick_lists', req.params.id);
    if (['delivered', 'cancelled'].includes(pl.status)) throw bad(`Pick list is ${pl.status}`);
    const tech = req.user.role === 'tech';
    if (tech && !canTouchPick(req.user, pl)) throw bad('Not your pick list', 403);
    if (!tech) update('pick_lists', pl.id, pick(req.body, ['needed_by', 'assigned_to', 'notes', ...(req.body.status === 'cancelled' ? ['status'] : [])]));
    const editable = pl.status !== 'picked';
    for (const id of req.body.remove || []) {
      if (tech) throw bad('Ask the office to remove lines', 403);
      const l = get(db, 'SELECT * FROM pick_list_lines WHERE id = ? AND pick_list_id = ?', id, pl.id);
      if (!l) continue;
      if (l.job_material_id) throw bad(`"${l.description}" was already picked and charged to the job`);
      run(db, 'DELETE FROM pick_list_lines WHERE id = ?', l.id);
    }
    for (const l of req.body.lines || []) {
      if (l.id) {
        const cur = get(db, 'SELECT * FROM pick_list_lines WHERE id = ? AND pick_list_id = ?', l.id, pl.id);
        if (!cur || cur.job_material_id) continue;
        if (l.qty_picked !== undefined) run(db, 'UPDATE pick_list_lines SET qty_picked = ? WHERE id = ?', Math.max(0, Number(l.qty_picked) || 0), cur.id);
        if (!tech && editable && l.qty !== undefined) { const q = Number(l.qty); if (!(q > 0)) throw bad(`Quantity for "${cur.description}" must be more than 0`); run(db, 'UPDATE pick_list_lines SET qty = ? WHERE id = ?', q, cur.id); }
      } else if (l.description || l.pricebook_id) {
        if (!editable) throw bad('This pick list is already picked. Start a new one for more material.');
        insert('pick_list_lines', { pick_list_id: pl.id, ...pickLine(l, req.user), ...(tech ? { unit_cost: null } : {}) });
      }
    }
    if (pl.status === 'open' && (req.body.lines || []).some(l => Number(l.qty_picked) > 0)) run(db, "UPDATE pick_lists SET status = 'picking' WHERE id = ?", pl.id);
    res.json({ ok: true });
  }));
  // Finish picking: everything picked leaves stock and is charged to the job at current cost.
  H.completePickList = (plId, userId) => {
    const pl = mustGet('pick_lists', plId);
    if (['delivered', 'cancelled'].includes(pl.status)) throw bad(`Pick list is ${pl.status}`);
    for (const l of all(db, 'SELECT * FROM pick_list_lines WHERE pick_list_id = ? AND qty_picked > 0 AND job_material_id IS NULL', pl.id)) {
      const pb = l.pricebook_id ? get(db, 'SELECT * FROM pricebook WHERE id = ?', l.pricebook_id) : null;
      const unitCost = l.unit_cost != null ? l.unit_cost : pb ? pb.unit_cost : 0;
      const markup = 1 + (Number(D.settings(db).default_material_markup_pct) || 35) / 100;
      const mid = insert('job_materials', { job_id: pl.job_id, pricebook_id: l.pricebook_id, description: l.description, qty: l.qty_picked, unit_cost: unitCost,
        unit_price: pb ? pb.unit_price : Math.round(unitCost * markup * 100) / 100, billable: 1, source: pb ? 'stock' : 'pick list', cost_code_id: l.cost_code_id || (pb && pb.cost_code_id), user_id: userId, used_on: today() });
      if (pb) run(db, 'UPDATE pricebook SET qty_on_hand = qty_on_hand - ? WHERE id = ?', l.qty_picked, pb.id);
      run(db, 'UPDATE pick_list_lines SET job_material_id = ? WHERE id = ?', mid, l.id);
      A.postJobMaterial(db, mid);
    }
    run(db, "UPDATE pick_lists SET status = 'picked' WHERE id = ?", pl.id);
  };
  app.post('/api/pick-lists/:id/complete', wrap((req, res) => { H.completePickList(Number(req.params.id), req.user.id); res.json({ ok: true }); }));
  app.post('/api/pick-lists/:id/delivered', wrap((req, res) => {
    const pl = mustGet('pick_lists', req.params.id);
    if (pl.status !== 'picked') H.completePickList(pl.id, req.user.id);
    run(db, "UPDATE pick_lists SET status = 'delivered' WHERE id = ?", pl.id); res.json({ ok: true });
  }));
  // Shortages → one draft PO to the chosen vendor, delivered to the job.
  app.post('/api/pick-lists/:id/po-shortages', office, wrap((req, res) => {
    const pl = mustGet('pick_lists', req.params.id);
    const lines = all(db, `SELECT l.*, l.unit_cost line_cost, pb.qty_on_hand, pb.unit_cost, pb.vendor_id FROM pick_list_lines l LEFT JOIN pricebook pb ON pb.id = l.pricebook_id WHERE pick_list_id = ?`, pl.id)
      .map(l => ({ ...l, short: r2(l.qty - Math.max(0, l.qty_on_hand ?? 0)) })).filter(l => l.short > 0);
    if (!lines.length) throw bad('Nothing is short — everything is in stock');
    const vendorId = req.body.vendor_id || lines.find(l => l.vendor_id)?.vendor_id;
    if (!vendorId) throw bad('Pick a vendor for the shortage PO');
    const id = insert('purchase_orders', { vendor_id: vendorId, job_id: pl.job_id, deliver_to: 'job', number: D.nextNumber(db, 'purchase_orders', 'PO'), created_by: req.user.id, notes: `Shortages from ${pl.number}` });
    savePOLines(id, lines.map(l => ({ pricebook_id: l.pricebook_id, description: l.description, qty: l.short, unit_cost: l.line_cost ?? l.unit_cost ?? 0, cost_code_id: l.cost_code_id })));
    res.json({ id });
  }));
  app.post('/api/pick-lists/:id/send-to-ply', office, wrap(async (req, res) => { mustGet('pick_lists', req.params.id); res.json(await Ply.pushPickList(db, Number(req.params.id), { createMissing: !!req.body.create_missing })); }));

  H.setStock = (pricebookId, qty, memo) => {
    const pb = mustGet('pricebook', pricebookId);
    if (qty === pb.qty_on_hand) return;
    run(db, 'UPDATE pricebook SET qty_on_hand = ? WHERE id = ?', qty, pb.id);
    A.postInventoryAdjustment(db, { pricebookId: pb.id, delta: qty - pb.qty_on_hand, unitCost: pb.unit_cost });
  };

  // ================================================================ accounting (admin only)
  app.get('/api/accounts', office, wrap((req, res) => {
    const bal = A.balances(db, { to: req.query.as_of || '9999-12-31' });
    res.json(bal.filter(a => req.query.all || a.active));
  }));
  app.post('/api/accounts', admin, wrap((req, res) => {
    if (!req.body.number || !req.body.name || !req.body.type) throw bad('Number, name and type are required');
    res.json({ id: insert('accounts', pick(req.body, ['number', 'name', 'type', 'subtype', 'description', 'active'])) });
  }));
  app.put('/api/accounts/:id', admin, wrap((req, res) => { update('accounts', req.params.id, pick(req.body, ['number', 'name', 'subtype', 'description', 'active'])); res.json({ ok: true }); }));

  app.get('/api/journal', admin, wrap((req, res) => {
    const from = req.query.from || '0000-01-01', to = req.query.to || '9999-12-31';
    const where = ['je.date >= ?', 'je.date <= ?'], p = [from, to];
    if (req.query.source_type) { where.push('je.source_type = ?'); p.push(req.query.source_type); }
    const entries = all(db, `SELECT je.*, u.name created_by_name, (SELECT SUM(debit) FROM journal_lines WHERE entry_id = je.id) amount FROM journal_entries je
      LEFT JOIN users u ON u.id = je.created_by WHERE ${where.join(' AND ')} ORDER BY je.date DESC, je.id DESC LIMIT 500`, ...p);
    res.json(entries.map(e => ({ ...e, amount: r2(e.amount) })));
  }));
  app.get('/api/journal/:id', admin, wrap((req, res) => {
    const e = mustGet('journal_entries', req.params.id);
    e.lines = all(db, `SELECT jl.*, a.number, a.name account_name, j.number job_number, cc.code cost_code FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id
      LEFT JOIN jobs j ON j.id = jl.job_id LEFT JOIN cost_codes cc ON cc.id = jl.cost_code_id WHERE entry_id = ? ORDER BY jl.id`, e.id);
    res.json(e);
  }));
  app.post('/api/journal', admin, wrap((req, res) => {
    const lines = (req.body.lines || []).map(l => ({ account: l.account_id, debit: Number(l.debit) || 0, credit: Number(l.credit) || 0, memo: l.memo, job_id: l.job_id || null, cost_code_id: l.cost_code_id || null }));
    if (lines.length < 2) throw bad('A journal entry needs at least two lines');
    res.json({ id: A.post(db, { date: req.body.date || today(), memo: req.body.memo, source_type: 'manual', created_by: req.user.id, lines }) });
  }));
  app.delete('/api/journal/:id', admin, wrap((req, res) => {
    const e = mustGet('journal_entries', req.params.id);
    if (e.source_type !== 'manual') throw bad('Automatic entries are removed by changing the source record (invoice, bill, expense…)');
    A.assertOpen(db, e.date);
    A.assertNotReconciled(db, e.id);
    run(db, 'DELETE FROM journal_entries WHERE id = ?', e.id); res.json({ ok: true });
  }));

  // bills (accounts payable)
  app.get('/api/bills', admin, wrap((req, res) => {
    const where = [], p = [];
    if (req.query.status) { where.push(`b.status IN (${req.query.status.split(',').map(() => '?').join(',')})`); p.push(...req.query.status.split(',')); }
    res.json(all(db, `SELECT b.*, v.name vendor_name, po.number po_number FROM bills b JOIN vendors v ON v.id = b.vendor_id LEFT JOIN purchase_orders po ON po.id = b.po_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY b.bill_date DESC, b.id DESC LIMIT 500`, ...p).map(b => A.billTotals(db, b)));
  }));
  app.get('/api/bills/:id', admin, wrap((req, res) => {
    const b = A.billTotals(db, get(db, `SELECT b.*, v.name vendor_name, po.number po_number FROM bills b JOIN vendors v ON v.id = b.vendor_id LEFT JOIN purchase_orders po ON po.id = b.po_id WHERE b.id = ?`, req.params.id) || (() => { throw bad('Not found', 404); })());
    res.json(b);
  }));
  function saveBillLines(billId, lines) {
    for (const l of all(db, 'SELECT job_material_id FROM bill_lines WHERE bill_id = ? AND job_material_id IS NOT NULL', billId)) run(db, 'DELETE FROM job_materials WHERE id = ?', l.job_material_id);
    run(db, 'DELETE FROM bill_lines WHERE bill_id = ?', billId);
    const bill = get(db, 'SELECT * FROM bills WHERE id = ?', billId);
    const matAcct = A.accountId(db, '5100');
    for (const l of lines) {
      if (!l.account_id || !Number(l.amount)) continue;
      let jm = null;
      // non-PO materials billed to a job also show up on that job's material list for job costing
      if (!bill.po_id && l.job_id && Number(l.account_id) === matAcct && l.add_to_job_materials !== false)
        jm = insert('job_materials', { job_id: l.job_id, description: l.description || 'Materials per vendor bill', qty: 1, unit_cost: Number(l.amount), unit_price: 0, billable: 0, source: 'bill', cost_code_id: l.cost_code_id || null, used_on: bill.bill_date });
      insert('bill_lines', { bill_id: billId, account_id: l.account_id, description: l.description || null, amount: Number(l.amount), job_id: l.job_id || null, cost_code_id: l.cost_code_id || null, job_material_id: jm });
    }
  }
  app.post('/api/bills', admin, wrap((req, res) => {
    const b = req.body; const v = mustGet('vendors', b.vendor_id);
    const date = b.bill_date || today();
    const id = insert('bills', { vendor_id: v.id, vendor_invoice: b.vendor_invoice || null, bill_date: date, due_date: b.due_date || addDays(date, v.terms_days || 30), memo: b.memo || null });
    saveBillLines(id, b.lines || []);
    if (!get(db, 'SELECT COUNT(*) n FROM bill_lines WHERE bill_id = ?', id).n) throw bad('Add at least one line with an account and amount');
    A.postBill(db, id);
    res.json({ id });
  }));
  app.put('/api/bills/:id', admin, wrap((req, res) => {
    const b = mustGet('bills', req.params.id);
    A.assertOpen(db, b.bill_date);
    if (req.body.status === 'void') {
      if (get(db, 'SELECT COUNT(*) n FROM bill_payments WHERE bill_id = ?', b.id).n) throw bad('Remove payments before voiding');
      run(db, "UPDATE bills SET status = 'void' WHERE id = ?", b.id); A.postBill(db, b.id); return res.json({ ok: true });
    }
    update('bills', b.id, pick(req.body, ['vendor_invoice', 'bill_date', 'due_date', 'memo']));
    if (req.body.lines) {
      if (b.po_id) throw bad('Lines on a PO bill come from the PO');
      saveBillLines(b.id, req.body.lines);
    }
    A.refreshBillStatus(db, b.id); A.postBill(db, b.id);
    res.json({ ok: true });
  }));
  app.post('/api/bills/:id/payments', admin, wrap((req, res) => {
    const b = A.billTotals(db, mustGet('bills', req.params.id));
    if (b.status === 'void') throw bad('Bill is void');
    const amount = Number(req.body.amount);
    if (!(amount > 0)) throw bad('Amount must be greater than zero');
    if (amount > b.balance + 0.005) throw bad(`Payment is more than the ${b.balance} balance`);
    const id = insert('bill_payments', { bill_id: b.id, amount, paid_at: req.body.paid_at || today(), method: req.body.method || 'check', reference: req.body.reference || null,
      account_id: req.body.account_id || A.accountId(db, D.settings(db).default_paid_from_account || '1000') });
    A.refreshBillStatus(db, b.id); A.postBillPayment(db, id);
    res.json({ id });
  }));
  app.delete('/api/bill-payments/:id', admin, wrap((req, res) => {
    const p = mustGet('bill_payments', req.params.id);
    A.unpost(db, 'bill_payment', p.id); run(db, 'DELETE FROM bill_payments WHERE id = ?', p.id); A.refreshBillStatus(db, p.bill_id); res.json({ ok: true });
  }));

  // labor accrual & payroll
  app.get('/api/accounting/labor', admin, wrap((req, res) => res.json(A.laborStatus(db, req.query.from || addDays(today(), -56), req.query.to || today()))));
  app.post('/api/accounting/labor', admin, wrap((req, res) => {
    const weeks = req.body.weeks || [];
    res.json(weeks.map(w => A.postLaborWeek(db, A.mondayOf(w), req.user.id)));
  }));
  app.post('/api/accounting/payroll-payment', admin, wrap((req, res) => {
    const amt = Number(req.body.amount); if (!(amt > 0)) throw bad('Amount is required');
    res.json({ id: A.post(db, { date: req.body.date || today(), memo: req.body.memo || 'Payroll paid', source_type: 'manual', created_by: req.user.id, lines: [
      { account: '2100', debit: amt }, { account: req.body.account_id || '1000', credit: amt }] }) });
  }));
  app.post('/api/accounting/rebuild', admin, wrap((req, res) => res.json(A.rebuild(db))));
  app.post('/api/accounting/close', admin, wrap((req, res) => {
    const d = req.body.through || '';
    if (d && !/^\d{4}-\d{2}-\d{2}$/.test(d)) throw bad('Date must be YYYY-MM-DD');
    run(db, "INSERT INTO settings (key, value) VALUES ('books_closed_through', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", d);
    res.json({ books_closed_through: d });
  }));
  app.get('/api/accounting/trial-balance', admin, wrap((req, res) => res.json(A.trialBalance(db, req.query.as_of || today()))));
  app.get('/api/accounting/balance-sheet', admin, wrap((req, res) => res.json(A.balanceSheet(db, req.query.as_of || today()))));
  app.get('/api/accounting/income-statement', admin, wrap((req, res) => res.json(A.incomeStatement(db, req.query.from || today().slice(0, 5) + '01-01', req.query.to || today()))));
  app.get('/api/accounting/ledger/:accountId', admin, wrap((req, res) => res.json(A.generalLedger(db, Number(req.params.accountId), req.query.from || today().slice(0, 5) + '01-01', req.query.to || today()))));
  app.get('/api/accounting/ap-aging', admin, wrap((req, res) => res.json(A.apAging(db))));
  app.get('/api/accounting/summary', admin, wrap((req, res) => {
    const t = today();
    const bal = A.balances(db, { to: t });
    const by = n => (bal.find(a => a.number === n) || {}).balance || 0;
    const banks = bal.filter(a => a.subtype === 'bank');
    res.json({ cash: r2(banks.reduce((s, a) => s + a.balance, 0)), banks, ar: by('1200'), ap: by('2000'), inventory: by('1300'), sales_tax: by('2200'), accrued_payroll: by('2100'),
      credit_card: by('2050'), ytd: A.incomeStatement(db, t.slice(0, 5) + '01-01', t), closed_through: A.closedThrough(db),
      labor_out_of_sync: A.laborStatus(db, addDays(t, -56), t).filter(w => !w.in_sync).length });
  }));

  // ================================================================ Ply
  app.get('/api/integrations/ply/log', admin, wrap((req, res) => res.json(all(db, "SELECT * FROM integration_log WHERE provider = 'ply' ORDER BY id DESC LIMIT 100"))));
  app.post('/api/integrations/ply/test', admin, wrap(async (req, res) => {
    const r = await Ply.test(db);
    run(db, "INSERT INTO settings (key, value) VALUES ('ply_locations', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", JSON.stringify(r.locations));
    res.json(r);
  }));
  app.post('/api/integrations/ply/sync', admin, wrap(async (req, res) => res.json(await Ply.syncStatus(db, H))));
  app.post('/api/purchase-orders/:id/send-to-ply', office, wrap(async (req, res) => { mustGet('purchase_orders', req.params.id); res.json(await Ply.pushPO(db, Number(req.params.id), { createMissing: !!req.body.create_missing })); }));
  app.post('/api/integrations/ply/pull-items', admin, wrap(async (req, res) => res.json(await Ply.pullItems(db))));
  app.post('/api/integrations/ply/push-job/:id', office, wrap(async (req, res) => res.json(await Ply.pushJob(db, Number(req.params.id)))));
  app.get('/api/integrations/ply/preview/:kind/:id', admin, wrap((req, res) => {
    const f = { po: Ply.toPlyPO, pick_list: Ply.toPlyPickList, job: Ply.toPlyJob }[req.params.kind];
    if (!f) throw bad('Unknown kind'); res.json(f(db, Number(req.params.id)));
  }));
};

// Ply's public API has no webhooks: changes are pulled (Settings → Ply → Sync now, and hourly).
module.exports.webhook = function plyWebhook(app) {
  app.post('/hooks/ply', (req, res) => res.status(410).json({ error: 'Not used: Field Ops pulls updates from the Ply API instead of receiving webhooks.' }));
};
