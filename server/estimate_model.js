'use strict';
// The A4YE electrical quote workbook as code: Cover & Assumptions, the scope tabs (Estimate Import columns A–P),
// Summary build-up, Schedule & Crew and Schedule Options. Pure functions: lines + assumptions in, numbers out.
const r2 = n => Math.round((Number(n) || 0) * 100) / 100;
const r4 = n => Math.round((Number(n) || 0) * 10000) / 10000;

const SCOPES = [
  ['distribution', 'Electrical - Distribution'], ['lighting', 'Electrical - Lighting'], ['power', 'Electrical - Power'],
  ['fire_alarm', 'Fire Alarm'], ['data', 'Data & Telecom'], ['demo', 'Demolition - Electrical'],
];
const PHASES = [
  ['P1', 'P1 Demolition'], ['P2', 'P2 Rough-In'], ['P3', 'P3 Gear & Feeders'], ['P4', 'P4 Trim/Fixtures & Devices'],
  ['P5', 'P5 Equipment Connections'], ['P6', 'P6 Systems'], ['P7', 'P7 Closeout'],
];
const SCOPE_KEYS = SCOPES.map(s => s[0]), PHASE_KEYS = PHASES.map(p => p[0]);
const scopeLabel = k => (SCOPES.find(s => s[0] === k) || [, 'Electrical - Power'])[1];
const phaseLabel = k => (PHASES.find(p => p[0] === k) || [, ''])[1];

// Cover & Assumptions. Percentages are stored as percent (21.95 = 21.95%). Wages are market rates by classification
// (no names): set your own under Estimating → Estimate templates.
const DEFAULTS = {
  commercial: {
    crew: [
      { cls: 'Foreman', base: 46, mix: 9, local: 0 },
      { cls: 'Journeyman electrician', base: 38, mix: 38, local: 0 },
      { cls: 'Apprentice (3rd-4th year)', base: 25, mix: 21, local: 75 },
      { cls: 'Helper / pre-apprentice', base: 19, mix: 32, local: 100 },
    ],
    burden: 1.42, productivity: 0.75, high_rep: 0.65,
    ot_after: 40, ot_mult: 1.5, ot_burden: 1.22, eff_5x12: 0.88, eff_6x10: 0.9,
    days_week: 5, hours_day: 8, availability: 0.94, holidays: 0, crew_size: 4,
    per_diem: 0, pm_rate: 115, pm_hours_week: 10,
    small_tools_pct: 2, trucks: 1, truck_week: 675, scissor_lifts: 0, scissor_week: 385, booms: 0, boom_week: 1485, conex_week: 195,
    safety_pct: 0.5, mob_equip_pct: 3.5, mob_crew_pct: 3.5,
    contingency_pct: 2.5, op_pct: 21.95, tax_pct: 6,
  },
  residential: {
    crew: [
      { cls: 'Journeyman electrician', base: 38, mix: 50, local: 100 },
      { cls: 'Apprentice (3rd-4th year)', base: 25, mix: 50, local: 100 },
    ],
    burden: 1.42, productivity: 1, high_rep: 0.85,
    ot_after: 40, ot_mult: 1.5, ot_burden: 1.22, eff_5x12: 0.88, eff_6x10: 0.9,
    days_week: 5, hours_day: 8, availability: 0.94, holidays: 0, crew_size: 2,
    per_diem: 0, pm_rate: 115, pm_hours_week: 2,
    small_tools_pct: 2, trucks: 1, truck_week: 675, scissor_lifts: 0, scissor_week: 385, booms: 0, boom_week: 1485, conex_week: 0,
    safety_pct: 0.5, mob_equip_pct: 0, mob_crew_pct: 0,
    contingency_pct: 0, op_pct: 25, tax_pct: 6,
  },
};
// The EMT takeoff calculator's derivation ratios
const EMT_DEFAULTS = { derive: true, couplings_per_100: 10, connectors_per_100: 6, straps_per_100: 12, locknuts_per_connector: 0, fitting: 'SS' };

const NUM_KEYS = Object.keys(DEFAULTS.commercial).filter(k => k !== 'crew');
function cleanAssumptions(a, base) {
  const out = { ...base };
  if (!a) return out;
  for (const k of NUM_KEYS) if (a[k] !== undefined && a[k] !== '' && a[k] !== null) { const n = Number(a[k]); if (Number.isFinite(n) && n >= 0) out[k] = n; }
  if (Array.isArray(a.crew)) out.crew = a.crew.slice(0, 12).map(c => ({ cls: String(c.cls || '').slice(0, 60) || 'Crew', base: Math.max(0, Number(c.base) || 0), mix: Math.max(0, Number(c.mix) || 0), local: Math.min(100, Math.max(0, Number(c.local) || 0)) }))
    .filter(c => c.mix > 0 || c.base > 0);
  if (!out.crew.length) out.crew = base.crew;
  if (!(out.productivity > 0)) out.productivity = base.productivity;
  if (!(out.availability > 0)) out.availability = base.availability;
  if (!(out.crew_size >= 1)) out.crew_size = base.crew_size;
  return out;
}
function cleanEmt(e, base = EMT_DEFAULTS) {
  const out = { ...base };
  if (!e) return out;
  for (const k of ['couplings_per_100', 'connectors_per_100', 'straps_per_100', 'locknuts_per_connector']) if (e[k] !== undefined && e[k] !== '') { const n = Number(e[k]); if (Number.isFinite(n) && n >= 0) out[k] = n; }
  if (e.fitting !== undefined) out.fitting = e.fitting === 'COMP' ? 'COMP' : 'SS';
  if (e.derive !== undefined) out.derive = !!e.derive && e.derive !== '0';
  return out;
}

// blended burdened field rate, blended base wage, travelled share (Cover rows 27–44)
function rates(A) {
  const mix = A.crew.reduce((s, c) => s + c.mix, 0) || 1;
  const blended = A.crew.reduce((s, c) => s + c.base * A.burden * c.mix, 0) / mix;
  const base = A.crew.reduce((s, c) => s + c.base * c.mix, 0) / mix;
  const travelled = A.crew.reduce((s, c) => s + c.mix * (1 - c.local / 100), 0) / mix;
  return { blended: r4(blended), base: r4(base), travelled: r4(travelled), ot: r4(base * (A.burden + (A.ot_mult - 1) * A.ot_burden)) };
}
// productivity factor for a line: engineering / testing / closeout get no reduction; repeated identical work the high-rep factor
function factorFor(l, A) {
  if (l.factor_override != null && l.factor_override !== '') return Number(l.factor_override);
  const code = String(l.phase_code || '');
  if (/^(01|50)/.test(code)) return 1;
  return l.high_repetition ? A.high_rep : A.productivity;
}

// lines → priced lines (+ EMT fittings derived from conduit footage)
function priceLines(lines, A, emt, { pricebook, codes }) {
  const R = rates(A);
  const one = (l, i) => {
    const qty = Number(l.qty) || 0;
    const item = l.pricebook_code ? pricebook.get(String(l.pricebook_code).toLowerCase()) : null;
    const material_unit = l.material_override != null ? Number(l.material_override) : item ? Number(item.unit_cost) || 0 : Number(l.material_unit) || 0;
    const hours_unit = l.hours_override != null ? Number(l.hours_override) : item && Number(item.labor_hours) > 0 ? Number(item.labor_hours) : Number(l.neca_hours) || 0;
    const priced_from = l.derived ? 'price book' : l.material_override != null || l.hours_override != null ? 'edited' : item ? 'price book' : (Number(l.material_unit) || Number(l.neca_hours)) ? 'AI suggestion' : 'not priced';
    const factor = factorFor(l, A);
    const adj_hours = r4(hours_unit * factor), labor_unit = r2(adj_hours * R.blended);
    const scope = SCOPE_KEYS.includes(l.scope) ? l.scope : 'power';
    const phase = PHASE_KEYS.includes(l.phase) ? l.phase : 'P2';
    const cc = codes.get(String(l.phase_code || ''));
    return { ...l, row: i, scope, phase, area: l.area ?? (PHASE_KEYS.includes(l.phase) ? '' : l.phase || ''), include: l.include !== false, qty,
      pricebook_id: item ? item.id : null, pricebook_name: item ? item.name : null,
      material_unit: r2(material_unit), hours_unit, factor, adj_hours, labor_unit, total_unit: r2(material_unit + labor_unit),
      ext_material: r2(qty * material_unit), neca_hours_ext: r2(qty * hours_unit), ext_hours: r2(qty * adj_hours), ext_labor: r2(qty * labor_unit),
      ext_cost: r2(qty * material_unit + qty * labor_unit), cost_code_ok: !!cc, cost_code_name: cc ? cc.name : null, priced_from };
  };
  const out = lines.map(one);
  if (emt && emt.derive) {
    const n = out.length;
    for (let i = 0; i < n; i++) {
      const l = out[i];
      const m = l.include && l.pricebook_code && /^EMT-(.+)$/i.exec(l.pricebook_code);
      if (!m || !/^(lf|ft|feet|foot)$/i.test(String(l.unit || '').trim())) continue;
      const size = m[1], lf = l.qty;
      const pick = (pref, alt) => [pref, alt].map(p => p && `${p}-${size}`).find(c => c && pricebook.has(c.toLowerCase()));
      const conn = Math.round(lf * emt.connectors_per_100 / 100);
      const adds = [
        [pick(emt.fitting === 'COMP' ? 'CCPLG' : 'SSCPLG', 'SSCPLG'), Math.round(lf * emt.couplings_per_100 / 100), 'couplings'],
        [pick(emt.fitting === 'COMP' ? 'CCONN' : 'SSCONN', 'SSCONN'), conn, 'connectors'],
        [pick('STRAP'), Math.round(lf * emt.straps_per_100 / 100), 'straps'],
        [pick('LOCKNUT'), Math.round(conn * emt.locknuts_per_connector), 'locknuts'],
      ];
      for (const [code, qty, what] of adds) {
        if (!code || !qty) continue;
        const item = pricebook.get(code.toLowerCase());
        out.push(one({ derived: true, derived_from: i, phase_code: l.phase_code, area: l.area, scope: l.scope, phase: l.phase, tag: l.tag, description: item.name,
          qty, unit: item.unit || 'EA', pricebook_code: item.code, high_repetition: l.high_repetition, factor_override: l.factor_override,
          confidence: l.confidence, source: `${what} for ${lf} LF of ${l.pricebook_code}`, notes: 'Derived from the EMT ratios' }, out.length));
      }
    }
  }
  return out;
}

// Summary + Schedule & Crew + Schedule Options
function buildUp(priced, A) {
  const R = rates(A), inc = priced.filter(l => l.include);
  const sum = (list, k) => r2(list.reduce((s, l) => s + (l[k] || 0), 0));
  const scopes = SCOPES.map(([key, label]) => { const L = inc.filter(l => l.scope === key);
    return { key, label, lines: L.length, hours: sum(L, 'ext_hours'), neca_hours: sum(L, 'neca_hours_ext'), material: sum(L, 'ext_material'), labor: sum(L, 'ext_labor'), total: sum(L, 'ext_cost') }; });
  const material = sum(inc, 'ext_material'), earned = sum(inc, 'ext_hours'), neca = sum(inc, 'neca_hours_ext'), estLabor = sum(inc, 'ext_labor');
  const phases = PHASES.map(([key, label]) => ({ key, label, hours: sum(inc.filter(l => l.phase === key), 'ext_hours') }));
  // schedule at the chosen crew size, 5 x 8
  const hpw = A.days_week * A.hours_day, perWorkerWeek = hpw * A.availability;
  const weeks = earned > 0 ? Math.max(1, Math.ceil(earned / (A.crew_size * perWorkerWeek))) : 0;
  const netDays = Math.max(0, weeks * A.days_week - A.holidays);
  const option = (label, days, hours, eff) => {
    const h = days * hours, paid = eff ? earned / eff : 0;
    const st = h ? paid * Math.min(h, A.ot_after) / h : 0, ot = paid - st;
    const labor = st * R.blended + ot * R.ot;
    const optWeeks = weeks;   // same duration (as the workbook compares): fewer workers on longer weeks
    const optDays = Math.max(0, optWeeks * days - A.holidays);
    const manDays = hours ? paid / A.availability / hours : 0;
    const perDiem = (manDays * R.travelled + (earned > 0 ? optDays : 0)) * A.per_diem;
    const crew = optWeeks ? Math.ceil(paid / (optWeeks * h * A.availability)) : 0;
    const ind = indirects(material, labor, optWeeks);
    const pm = optWeeks * A.pm_hours_week * A.pm_rate;
    const direct = material + labor + perDiem + ind.total + pm;
    const cont = direct * A.contingency_pct / 100, op = (direct + cont) * A.op_pct / 100, tax = material * A.tax_pct / 100;
    return { label, days, hours, efficiency: eff, paid_hours: r2(paid), st_hours: r2(st), ot_hours: r2(ot), labor: r2(labor), per_diem: r2(perDiem), man_days: r2(manDays),
      crew, weeks: optWeeks, indirects: r2(ind.total), pm: r2(pm), direct: r2(direct), contingency: r2(cont), op: r2(op), tax: r2(tax), total: r2(direct + cont + op + tax) };
  };
  function indirects(mat, labor, wk) {
    const lines = [
      ['Small tools & consumables', (mat + labor) * A.small_tools_pct / 100],
      ['Service trucks & fuel', wk * A.trucks * A.truck_week],
      ['Scissor lift rental', wk * A.scissor_lifts * A.scissor_week],
      ['Articulating boom lift', wk * A.booms * A.boom_week],
      ['Jobsite conex, trailer & utilities', wk * A.conex_week],
      ['Safety, PPE & fall protection', labor * A.safety_pct / 100],
      ['Mobilization - equipment haul', (mat + estLabor) * A.mob_equip_pct / 100],
      ['Mobilization - crew travel', (mat + estLabor) * A.mob_crew_pct / 100],
    ].map(([label, v]) => ({ label, value: r2(v) }));
    return { lines, total: r2(lines.reduce((s, x) => s + x.value, 0)) };
  }
  const base = option('Base: 5 x 8 (40 hr)', A.days_week, A.hours_day, 1);
  const ind = indirects(material, base.labor, weeks);
  const alt = [option('Acceleration 1: 5 x 12 (60 hr)', 5, 12, A.eff_5x12), option('Acceleration 2: 6 x 10 (60 hr)', 6, 10, A.eff_6x10)]
    .map(o => ({ ...o, add: r2(o.total - base.total) }));
  // labor productivity: what it costs if the crew only performs at NECA normal
  const extraHours = Math.max(0, neca - earned), extraLabor = extraHours * R.blended;
  const extraTools = extraLabor * A.small_tools_pct / 100, extraPerDiem = A.hours_day ? extraHours / A.availability / A.hours_day * R.travelled * A.per_diem : 0;
  const exposure = (extraLabor + extraTools + extraPerDiem) * (1 + A.contingency_pct / 100) * (1 + A.op_pct / 100);
  const peakWeeklyCrew = weeks ? Math.ceil(earned / (weeks * perWorkerWeek)) : 0;
  return {
    rates: R, scopes, phases,
    subtotal: { hours: earned, neca_hours: neca, material, labor: estLabor, total: r2(material + estLabor) },
    schedule: { crew_size: A.crew_size, weeks, net_days: netDays, hours_per_week: hpw, availability: A.availability, peak_crew: peakWeeklyCrew,
      man_days: base.man_days, travelled_share: R.travelled },
    build: { material, labor: base.labor, per_diem: base.per_diem, indirects: ind.lines, indirects_total: ind.total, pm: base.pm, pm_hours: r2(weeks * A.pm_hours_week),
      direct: base.direct, contingency_pct: A.contingency_pct, contingency: base.contingency, after_contingency: r2(base.direct + base.contingency),
      op_pct: A.op_pct, op: base.op, before_tax: r2(base.direct + base.contingency + base.op), tax_pct: A.tax_pct, tax: base.tax, total: base.total },
    productivity: { neca_hours: neca, bid_hours: earned, removed: r2(extraHours), factor_achieved: neca ? r4(earned / neca) : null,
      extra_labor: r2(extraLabor), exposure: r2(exposure), exposure_share: base.total ? r4(exposure / base.total) : null, op_left: r2(base.op - exposure) },
    options: [base, ...alt],
  };
}

module.exports = { SCOPES, PHASES, SCOPE_KEYS, PHASE_KEYS, DEFAULTS, EMT_DEFAULTS, cleanAssumptions, cleanEmt, rates, priceLines, buildUp, scopeLabel, phaseLabel, r2 };
