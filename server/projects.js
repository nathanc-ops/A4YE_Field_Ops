'use strict';
// Commercial project tracking: a project is a job with is_project = 1. On top of the job's contract, change orders,
// retainage and cost-code budgets it adds: % complete per cost code (earned hours, productivity, forecast at
// completion), crew on site, hours by week, health flags, and daily logs.
const D = require('./db');
const C = require('./calc');
const Bill = require('./billing');
const { all, get, run } = D;
const r2 = n => Math.round((Number(n) || 0) * 100) / 100;
const localDate = d => { const x = new Date(d); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`; };

module.exports = function projectRoutes(app, db, X) {
  const { wrap, bad, insert, update, mustGet, jobSelect, fixTechs } = X;
  const today = () => localDate(new Date());
  const now = () => new Date().toISOString();
  const isOffice = u => u.role === 'admin' || u.role === 'office';
  const onProject = (user, job) => !!get(db, `SELECT 1 x FROM job_techs WHERE job_id = ? AND user_id = ?
      UNION SELECT 1 FROM time_entries WHERE job_id = ? AND user_id = ? AND clock_in > datetime('now', '-14 days')`, job.id, user.id, job.id, user.id)
    || job.foreman_id === user.id;
  const mustProject = id => { const j = mustGet('jobs', id); if (!j.is_project) throw bad('That job is not set up as a commercial project'); return j; };
  // who may see a project: office, or a tech who's on it (assigned, foreman, clocked in lately) or allowed on any project
  const canSee = (req, job) => isOffice(req.user) || onProject(req.user, job) || req.can('any_project');

  // per cost code: budget vs actual, earned hours from % complete, productivity and forecast hours at completion
  function codeRows(job) {
    const pct = new Map(all(db, 'SELECT cost_code_id, percent_complete FROM job_budgets WHERE job_id = ?', job.id).map(r => [r.cost_code_id, r.percent_complete]));
    return C.jobCostCodes(db, job.id).map(r => {
      const p = r.cost_code_id != null && pct.has(r.cost_code_id) ? pct.get(r.cost_code_id) : null;
      const earned = p != null && r.budget_hours ? r2(r.budget_hours * p / 100) : null;
      // forecast from the burn rate once hours are logged; before that, the budget is the best guess
      const forecast = p > 0 && r.hours > 0 ? r2(r.hours / (p / 100)) : r2(Math.max(r.budget_hours || 0, r.hours));
      return { ...r, budgeted: pct.has(r.cost_code_id), percent_complete: p, earned_hours: earned,
        productivity: earned != null && r.hours > 0 ? r2(earned / r.hours) : null,          // >1 ahead of budget, <1 behind
        forecast_hours: forecast, forecast_variance: r.budget_hours ? r2(r.budget_hours - forecast) : null };
    });
  }
  function summary(job) {
    const b = Bill.jobBilling(db, job.id);
    const cost = C.jobCosting(db, job.id);
    const codes = codeRows(job);
    const budgetHours = codes.reduce((s, c) => s + (c.budget_hours || 0), 0) || job.budget_hours || 0;
    const forecastHours = codes.reduce((s, c) => s + (c.budgeted || c.hours ? c.forecast_hours : 0), 0);
    const crewNow = all(db, `SELECT t.user_id, u.name, cc.code cost_code, t.clock_in FROM time_entries t JOIN users u ON u.id = t.user_id
      LEFT JOIN cost_codes cc ON cc.id = t.cost_code_id WHERE t.job_id = ? AND t.clock_out IS NULL ORDER BY u.name`, job.id);
    const lastLog = get(db, 'SELECT MAX(log_date) d FROM daily_logs WHERE job_id = ?', job.id).d;
    const t = today(), fixed = b.billing_type === 'fixed';
    const pctDone = fixed ? b.percent_complete : (job.percent_complete ?? Bill.codesPercent(db, job));
    const flags = [];
    if (budgetHours && cost.hours > budgetHours) flags.push(`Over budgeted hours (${r2(cost.hours)} of ${r2(budgetHours)})`);
    else if (budgetHours && forecastHours > budgetHours * 1.05) flags.push(`Forecast ${r2(forecastHours - budgetHours)} hours over budget`);
    for (const c of codes) if (c.budget_hours && c.percent_complete != null && c.percent_complete < 100 && c.hours > c.budget_hours) flags.push(`${c.code} ${c.name}: hours used up at ${c.percent_complete}% complete`);
    if (job.end_date && job.end_date < t && !['completed', 'invoiced', 'cancelled'].includes(job.status)) flags.push('Past target completion date');
    if (fixed && b.over_under != null && b.over_under < -Math.max(1000, b.contract.total * 0.05)) flags.push(`Under-billed by ${Math.round(-b.over_under).toLocaleString()} — bill for work done`);
    const workedRecently = get(db, "SELECT COUNT(DISTINCT date(clock_in, 'localtime')) n FROM time_entries WHERE job_id = ? AND clock_in > datetime('now', '-3 days')", job.id).n;
    if (workedRecently && (!lastLog || lastLog < localDate(Date.now() - 2 * 864e5))) flags.push('Crew has been on site but no daily log in 2+ days');
    return {
      billing_type: b.billing_type, contract: fixed ? b.contract.total : null, change_orders_total: fixed ? b.contract.change_orders : null,
      billed: fixed ? b.billed_to_date : cost.revenue, billed_pct: fixed ? b.billed_pct : null, retainage_held: fixed ? b.retainage_held : null,
      over_under: fixed ? b.over_under : null, percent_complete: pctDone ?? null, percent_source: fixed ? b.percent_source : null,
      cost_to_date: cost.total_cost, estimated_cost: fixed ? b.estimated_cost : null, projected_margin_pct: fixed ? b.projected_margin_pct : cost.margin_pct,
      projected_profit: fixed ? b.projected_profit : cost.profit,
      hours: cost.hours, budget_hours: r2(budgetHours), forecast_hours: r2(forecastHours), hours_pct: budgetHours ? r2(cost.hours / budgetHours * 100) : null,
      crew_now: crewNow, last_log_date: lastLog, flags,
    };
  }

  // ---------------------------------------------------------------- list
  app.get('/api/projects', wrap((req, res) => {
    const st = req.query.status === 'all' ? '' : req.query.status === 'closed' ? "AND j.status IN ('completed','invoiced','cancelled')" : "AND j.status NOT IN ('completed','invoiced','cancelled')";
    let rows = all(db, `${jobSelect} WHERE j.is_project = 1 ${st} ORDER BY COALESCE(j.end_date, '9999'), j.id DESC`).map(fixTechs);
    if (!isOffice(req.user)) rows = rows.filter(j => canSee(req, j));
    res.json(rows.map(j => ({ ...j, pm_name: (get(db, 'SELECT name FROM users WHERE id = ?', j.project_manager_id) || {}).name || null,
      foreman_name: (get(db, 'SELECT name FROM users WHERE id = ?', j.foreman_id) || {}).name || null, summary: summary(j) })));
  }));

  // ---------------------------------------------------------------- detail
  app.get('/api/projects/:id', wrap((req, res) => {
    const job = mustProject(req.params.id);
    if (!canSee(req, job)) throw bad('Not on this project', 403);
    const t = today();
    // hours by week for the last 10 weeks (Monday start), and today's crew by person and cost code
    const weeks = all(db, `SELECT date(clock_in, 'localtime', 'weekday 1', '-7 days') wk, SUM((julianday(COALESCE(clock_out, ?)) - julianday(clock_in)) * 24) h
      FROM time_entries WHERE job_id = ? AND clock_in > datetime('now', '-70 days') GROUP BY wk ORDER BY wk`, now(), job.id).map(w => ({ week: w.wk, hours: r2(w.h) }));
    const todayCrew = all(db, `SELECT u.name, cc.code, cc.name cost_code_name, SUM((julianday(COALESCE(t.clock_out, ?)) - julianday(t.clock_in)) * 24) h, MAX(t.clock_out IS NULL) on_clock
      FROM time_entries t JOIN users u ON u.id = t.user_id LEFT JOIN cost_codes cc ON cc.id = t.cost_code_id
      WHERE t.job_id = ? AND date(t.clock_in, 'localtime') = ? GROUP BY u.id, t.cost_code_id ORDER BY u.name`, now(), job.id, t).map(r => ({ ...r, h: r2(r.h) }));
    const j = fixTechs(get(db, `${jobSelect} WHERE j.id = ?`, job.id));
    res.json({ job: j, summary: summary(job), cost_codes: codeRows(job), weeks, today_crew: todayCrew,
      users: { pm: get(db, 'SELECT id, name, phone FROM users WHERE id = ?', job.project_manager_id), foreman: get(db, 'SELECT id, name, phone FROM users WHERE id = ?', job.foreman_id) },
      can_edit_progress: req.can('projects') && isOffice(req.user) || job.foreman_id === req.user.id,
      can_log: isOffice(req.user) || req.can('daily_logs') });
  }));

  // % complete per cost code (PM in the office, or the project's foreman in the field)
  app.put('/api/projects/:id/budgets', wrap((req, res) => {
    const job = mustProject(req.params.id);
    if (!(isOffice(req.user) || job.foreman_id === req.user.id)) throw bad('Only the office or this project\'s foreman can update progress', 403);
    for (const c of req.body.codes || []) {
      const p = c.percent_complete === '' || c.percent_complete == null ? null : Math.min(100, Math.max(0, Number(c.percent_complete)));
      if (p != null && !Number.isFinite(p)) throw bad('Percent complete must be a number from 0 to 100');
      const ccId = Number(c.cost_code_id);
      if (!get(db, 'SELECT 1 x FROM cost_codes WHERE id = ?', ccId)) throw bad('Unknown cost code');
      if (get(db, 'SELECT 1 x FROM job_budgets WHERE job_id = ? AND cost_code_id = ?', job.id, ccId)) run(db, 'UPDATE job_budgets SET percent_complete = ? WHERE job_id = ? AND cost_code_id = ?', p, job.id, ccId);
      else insert('job_budgets', { job_id: job.id, cost_code_id: ccId, budget_hours: 0, budget_material: 0, budget_other: 0, percent_complete: p });
    }
    res.json({ ok: true, percent_complete: Bill.codesPercent(db, mustGet('jobs', job.id)) });
  }));

  // ---------------------------------------------------------------- daily logs
  const LOG_FIELDS = ['log_date', 'weather', 'crew_count', 'work_performed', 'delays', 'safety', 'visitors', 'deliveries'];
  const hoursOn = (jobId, date) => all(db, `SELECT u.name, cc.code, SUM((julianday(COALESCE(t.clock_out, ?)) - julianday(t.clock_in)) * 24) h FROM time_entries t
      JOIN users u ON u.id = t.user_id LEFT JOIN cost_codes cc ON cc.id = t.cost_code_id WHERE t.job_id = ? AND date(t.clock_in, 'localtime') = ?
      GROUP BY u.id, t.cost_code_id ORDER BY u.name`, now(), jobId, date).map(r => ({ ...r, h: r2(r.h) }));
  app.get('/api/projects/:id/logs', wrap((req, res) => {
    const job = mustProject(req.params.id);
    if (!canSee(req, job)) throw bad('Not on this project', 403);
    const logs = all(db, `SELECT l.*, u.name user_name FROM daily_logs l LEFT JOIN users u ON u.id = l.user_id WHERE l.job_id = ? ORDER BY l.log_date DESC, l.id DESC LIMIT ?`,
      job.id, Math.min(Number(req.query.limit) || 60, 500));
    res.json(logs.map(l => ({ ...l, time: hoursOn(job.id, l.log_date) })));
  }));
  app.get('/api/projects/:id/hours-on', wrap((req, res) => {
    const job = mustProject(req.params.id);
    if (!canSee(req, job)) throw bad('Not on this project', 403);
    res.json(hoursOn(job.id, String(req.query.date || today()).slice(0, 10)));
  }));
  const mayLog = (req, job) => isOffice(req.user) || (req.can('daily_logs') && canSee(req, job));
  app.post('/api/projects/:id/logs', wrap((req, res) => {
    const job = mustProject(req.params.id);
    if (!mayLog(req, job)) throw bad('You can\'t write daily logs on this project', 403);
    const d = X.pick(req.body, LOG_FIELDS);
    if (!d.log_date) d.log_date = today();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d.log_date)) throw bad('Date must be YYYY-MM-DD');
    if (!String(d.work_performed || '').trim()) throw bad('Describe the work performed');
    res.json({ id: insert('daily_logs', { ...d, job_id: job.id, user_id: req.user.id }) });
  }));
  app.put('/api/daily-logs/:id', wrap((req, res) => {
    const l = mustGet('daily_logs', req.params.id);
    if (!(isOffice(req.user) || l.user_id === req.user.id)) throw bad('Only the author or the office can edit this log', 403);
    update('daily_logs', l.id, { ...X.pick(req.body, LOG_FIELDS), updated_at: now() });
    res.json({ ok: true });
  }));
  app.delete('/api/daily-logs/:id', wrap((req, res) => {
    const l = mustGet('daily_logs', req.params.id);
    if (!(isOffice(req.user) || l.user_id === req.user.id)) throw bad('Only the author or the office can delete this log', 403);
    run(db, 'DELETE FROM daily_logs WHERE id = ?', l.id); res.json({ ok: true });
  }));

  return { summary };
};
