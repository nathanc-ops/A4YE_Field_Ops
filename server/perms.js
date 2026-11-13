'use strict';
// Per-employee permissions.
// Each person has a role (admin / office / tech) that sets their starting permissions; the owner can then
// switch individual permissions on or off per person (users.permissions holds only those overrides, as JSON).
// Admins always have everything, so the owner can't lock themselves out. Team, Settings and Import stay admin-only.
// Managers start with every office permission plus the company-wide KPI views; office staff start with less.

const PERMS = [
  // office areas
  { key: 'customers', label: 'Customers: add and edit', roles: ['office', 'manager'] },
  { key: 'jobs', label: 'Jobs and schedule: book, edit, dispatch, cancel, permits, service plans', roles: ['office', 'manager'] },
  { key: 'projects', label: 'Commercial projects: budgets, % complete, cost codes', roles: ['office', 'manager'] },
  { key: 'estimates', label: 'Estimates: create, send, approve', roles: ['office', 'manager'] },
  { key: 'invoices', label: 'Invoices and payments', roles: ['office', 'manager'] },
  { key: 'purchasing', label: 'Purchasing: POs, pick lists, vendors', roles: ['office', 'manager'] },
  { key: 'pricebook', label: 'Price book and inventory', roles: ['office', 'manager'] },
  { key: 'expenses', label: 'Expenses', roles: ['office', 'manager'] },
  { key: 'timesheets', label: "Timesheets: edit anyone's time, payroll report", roles: ['office', 'manager'] },
  // off for office staff and managers until the owner switches it on for them; admins always have it
  { key: 'payroll_export', label: 'Payroll export: download hours, pay rates and gross pay for payroll', roles: ['office', 'manager'], off: true, offAll: true },
  { key: 'reports', label: 'Business reports: P&L, A/R, job costing, dashboard money figures', roles: ['office', 'manager'] },
  { key: 'accounting', label: 'Accounting, vendor bills and banking', roles: ['office', 'manager'] },
  // both
  { key: 'see_costs', label: 'See costs, wages and margins', roles: ['office', 'manager', 'tech'] },
  // field
  { key: 'field_estimates', label: 'Build estimates and change orders in the field', roles: ['tech'] },
  { key: 'daily_logs', label: 'Write daily logs on commercial projects', roles: ['tech'] },
  { key: 'any_project', label: 'Clock in on any open commercial project (not just assigned ones)', roles: ['tech'] },
  // weekly KPIs (office, managers and admins only): everyone fills in their own page; these two widen it
  // (the KPI sheet's MASTER_VIEWERS and ADMINS). On for managers, off for office until switched on.
  { key: 'kpi_view_all', label: "KPIs: see everyone's numbers and the company scorecard", roles: ['office', 'manager'], off: true },
  { key: 'kpi_edit_all', label: "KPIs: fill in or correct anyone's page, set targets", roles: ['office', 'manager'], off: true },
];
const OFF_BY_DEFAULT = new Set(PERMS.filter(p => p.off).map(p => p.key));
const KEYS = PERMS.map(p => p.key);

function defaults(role, settings = {}) {
  if (role === 'admin') return Object.fromEntries(KEYS.map(k => [k, true]));
  // manager: every office area (accounting included) and the company-wide KPI views; admin can still switch any off
  if (role === 'manager') return Object.fromEntries(PERMS.filter(p => p.roles.includes('manager')).map(p => [p.key, !p.offAll]));
  if (role === 'office') return Object.fromEntries(KEYS.map(k => [k, k !== 'accounting' && !OFF_BY_DEFAULT.has(k)]));
  return { // tech: the company-wide field settings are the starting point
    field_estimates: settings.tech_estimates !== '0', see_costs: settings.tech_see_costs === '1',
    daily_logs: true, any_project: settings.project_clock_any !== '0',
  };
}
function parse(json) { try { const o = JSON.parse(json || '{}'); return o && typeof o === 'object' ? o : {}; } catch { return {}; } }
// What this person can actually do.
function effective(user, settings) {
  const base = defaults(user.role, settings);
  if (user.role === 'admin') return base;
  const own = parse(user.permissions);
  const out = {};
  for (const p of PERMS) if (p.roles.includes(user.role)) out[p.key] = typeof own[p.key] === 'boolean' ? own[p.key] : !!base[p.key];
  return out;
}
// Store only the switches that differ from the role's defaults, so changing a company setting still flows through.
function overridesFrom(role, wanted, settings) {
  if (role === 'admin' || !wanted || typeof wanted !== 'object') return null;
  const base = defaults(role, settings), out = {};
  for (const p of PERMS) if (p.roles.includes(role) && typeof wanted[p.key] === 'boolean' && wanted[p.key] !== !!base[p.key]) out[p.key] = wanted[p.key];
  return Object.keys(out).length ? JSON.stringify(out) : null;
}

// Which permission each office-side request needs. First match wins; unmatched routes keep their role check.
const R = (methods, re, perm) => ({ methods: methods === '*' ? null : methods.split(','), re, perm });
const RULES = [
  R('POST,PUT,DELETE', /^\/api\/(customers|locations)(\/|$)/, 'customers'),
  R('PUT', /^\/api\/jobs\/\d+\/budgets$/, 'projects'),
  R('*', /^\/api\/projects\/\d+\/(settings|budgets)$/, 'projects'),
  R('PUT', /^\/api\/projects\/\d+\/progress$/, 'projects'),
  R('PUT,POST', /^\/api\/projects\/\d+\/biweekly(\/issue|\/email)?$/, 'projects'),
  R('POST', /^\/api\/project-reports\/\d+\/reopen$/, 'projects'),
  R('POST,DELETE', /^\/api\/projects\/\d+\/quote-import(\/|$)/, 'projects'),
  R('*', /^\/api\/projects\/\d+\/(sov|pay-apps)(\/|$)/, 'invoices'),
  R('*', /^\/api\/pay-apps\//, 'invoices'),
  R('POST', /^\/api\/projects\/\d+\/change-orders$/, 'estimates'),
  R('PUT', /^\/api\/change-orders\//, 'estimates'),
  R('POST,PUT,DELETE', /^\/api\/projects\/\d+\/(rfis|safety|milestones|schedule|schedule\/build|schedule-start)$/, 'projects'),
  R('PUT,DELETE', /^\/api\/(rfis|safety|milestones|schedule)\/\d+$/, 'projects'),
  R('POST,PUT,DELETE', /^\/api\/cost-codes(\/|$)/, 'projects'),
  R('POST', /^\/api\/jobs\/\d+\/(invoice|bill-fixed|bill-tm|milestones)$/, 'invoices'),
  R('POST', /^\/api\/jobs\/\d+\/pick-lists$/, 'purchasing'),
  R('POST,PUT,DELETE', /^\/api\/jobs(\/\d+)?(\/(cancel|reopen))?$/, 'jobs'),
  R('POST,PUT,DELETE', /^\/api\/(appointments|agreements|permits|form-templates)(\/|$)/, 'jobs'),
  R('POST', /^\/api\/estimate-visits$/, 'jobs'),
  R('GET', /^\/api\/dispatch$/, 'jobs'),
  R('*', /^\/api\/estimates-review/, 'estimates'),
  R('*', /^\/api\/estimates(\/|$)/, 'estimates'),
  R('*', /^\/api\/(invoices|payments|milestones)(\/|$)/, 'invoices'),
  R('*', /^\/api\/(purchase-orders|pick-lists)(\/|$)/, 'purchasing'),
  R('POST,PUT,DELETE', /^\/api\/vendors(\/|$)/, 'purchasing'),
  R('POST', /^\/api\/integrations\/ply\/push-job\//, 'purchasing'),
  R('POST', /^\/api\/integrations\/ply\/sync$/, 'purchasing'),
  R('POST,PUT,DELETE', /^\/api\/pricebook(\/|$)/, 'pricebook'),
  R('*', /^\/api\/expenses(\/|$)/, 'expenses'),
  R('POST', /^\/api\/time$/, 'timesheets'),
  R('*', /^\/api\/timeclock\//, 'timesheets'),
  R('PUT,DELETE', /^\/api\/time\/\d+$/, 'timesheets'),
  R('*', /^\/api\/payroll-export(\/|$)/, 'payroll_export'),
  R('GET', /^\/api\/reports\/(payroll|hours-by-job)$/, 'timesheets'),
  R('GET', /^\/api\/reports\/permits$/, 'jobs'),
  R('GET', /^\/api\/reports\//, 'reports'),
  R('*', /^\/api\/(accounting|journal|bills|bill-payments|banking|reconciliations)(\/|$)/, 'accounting'),
  R('POST,PUT,DELETE', /^\/api\/accounts(\/|$)/, 'accounting'),
];
const LABEL = Object.fromEntries(PERMS.map(p => [p.key, p.label.split(':')[0]]));
function ruleFor(method, path) {
  return RULES.find(r => (!r.methods || r.methods.includes(method)) && r.re.test(path)) || null;
}

module.exports = { PERMS, KEYS, defaults, effective, overridesFrom, ruleFor, LABEL };
