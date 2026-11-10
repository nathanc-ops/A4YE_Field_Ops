'use strict';
// Per-employee permissions.
// Each person has a role (admin / office / tech) that sets their starting permissions; the owner can then
// switch individual permissions on or off per person (users.permissions holds only those overrides, as JSON).
// Admins always have everything, so the owner can't lock themselves out. Team, Settings and Import stay admin-only.

const PERMS = [
  // office areas
  { key: 'customers', label: 'Customers: add and edit', roles: ['office'] },
  { key: 'jobs', label: 'Jobs and schedule: book, edit, dispatch, cancel, permits, service plans', roles: ['office'] },
  { key: 'projects', label: 'Commercial projects: budgets, % complete, cost codes', roles: ['office'] },
  { key: 'estimates', label: 'Estimates: create, send, approve', roles: ['office'] },
  { key: 'invoices', label: 'Invoices and payments', roles: ['office'] },
  { key: 'purchasing', label: 'Purchasing: POs, pick lists, vendors', roles: ['office'] },
  { key: 'pricebook', label: 'Price book and inventory', roles: ['office'] },
  { key: 'expenses', label: 'Expenses', roles: ['office'] },
  { key: 'timesheets', label: "Timesheets: edit anyone's time, payroll report", roles: ['office'] },
  { key: 'reports', label: 'Business reports: P&L, A/R, job costing, dashboard money figures', roles: ['office'] },
  { key: 'accounting', label: 'Accounting, vendor bills and banking', roles: ['office'] },
  // both
  { key: 'see_costs', label: 'See costs, wages and margins', roles: ['office', 'tech'] },
  // field
  { key: 'field_estimates', label: 'Build estimates and change orders in the field', roles: ['tech'] },
  { key: 'daily_logs', label: 'Write daily logs on commercial projects', roles: ['tech'] },
  { key: 'any_project', label: 'Clock in on any open commercial project (not just assigned ones)', roles: ['tech'] },
];
const KEYS = PERMS.map(p => p.key);

function defaults(role, settings = {}) {
  if (role === 'admin') return Object.fromEntries(KEYS.map(k => [k, true]));
  if (role === 'office') return Object.fromEntries(KEYS.map(k => [k, k !== 'accounting']));
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
  R('*', /^\/api\/projects\/\d+\/(sov|pay-apps)(\/|$)/, 'invoices'),
  R('*', /^\/api\/pay-apps\//, 'invoices'),
  R('POST', /^\/api\/projects\/\d+\/change-orders$/, 'estimates'),
  R('PUT', /^\/api\/change-orders\//, 'estimates'),
  R('POST,PUT,DELETE', /^\/api\/projects\/\d+\/(rfis|safety|milestones)$/, 'projects'),
  R('PUT,DELETE', /^\/api\/(rfis|safety|milestones)\/\d+$/, 'projects'),
  R('POST,PUT,DELETE', /^\/api\/cost-codes(\/|$)/, 'projects'),
  R('POST', /^\/api\/jobs\/\d+\/(invoice|bill-fixed|bill-tm|milestones)$/, 'invoices'),
  R('POST', /^\/api\/jobs\/\d+\/pick-lists$/, 'purchasing'),
  R('POST,PUT,DELETE', /^\/api\/jobs(\/\d+)?(\/(cancel|reopen))?$/, 'jobs'),
  R('POST,PUT,DELETE', /^\/api\/(appointments|agreements|permits|form-templates)(\/|$)/, 'jobs'),
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
