'use strict';
// The quote-workbook model checked against the workbook's own Cover & Assumptions numbers.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const M = require('../server/estimate_model');

const A = M.cleanAssumptions({}, M.DEFAULTS.commercial);
const pb = new Map([['emt-1"', { id: 1, code: 'EMT-1"', name: '1" EMT', unit: 'ft', unit_cost: 1.67, labor_hours: 0.05 }]]);
const codes = new Map([['0810', { id: 1, code: '0810', name: 'EMT' }], ['5010', { id: 2, code: '5010', name: 'Testing' }]]);

test('crew rates match the workbook (Cover B34, B48, B52, E44)', () => {
  const R = M.rates(A);
  assert.equal(R.blended, 42.4722);   // BLENDED FIELD LABOR RATE
  assert.equal(R.base, 29.91);        // blended base wage
  assert.equal(R.ot, 60.7173);        // blended overtime rate
  assert.equal(R.travelled, 0.5225);  // travelled share
});

test('lines: NECA hours x productivity; testing gets no reduction; high repetition its own factor', () => {
  const L = M.priceLines([
    { phase_code: '0810', scope: 'power', phase: 'P2', description: '1" EMT', qty: 100, unit: 'FT', pricebook_code: 'EMT-1"' },
    { phase_code: '5010', scope: 'distribution', phase: 'P7', description: 'Megger', qty: 1, unit: 'LOT', neca_hours: 8, material_unit: 0 },
    { phase_code: '0810', scope: 'lighting', phase: 'P4', description: 'Troffer', qty: 200, unit: 'EA', neca_hours: 1, material_unit: 90, high_repetition: true },
  ], A, { ...M.EMT_DEFAULTS, derive: false }, { pricebook: pb, codes });
  assert.equal(L[0].adj_hours, 0.0375); assert.equal(L[0].material_unit, 1.67); assert.equal(L[0].ext_hours, 3.75);
  assert.equal(L[1].factor, 1); assert.equal(L[1].ext_hours, 8);
  assert.equal(L[2].factor, 0.65); assert.equal(L[2].ext_hours, 130);
});

test('Summary build-up follows the workbook: indirects, PM, contingency on direct, O&P after contingency, tax on material', () => {
  const B = { ...A, crew_size: 2, per_diem: 0 };
  const L = M.priceLines([{ phase_code: '0810', scope: 'power', phase: 'P2', description: 'Work', qty: 100, unit: 'EA', neca_hours: 1, material_unit: 10 }], B, M.EMT_DEFAULTS, { pricebook: pb, codes });
  const E = M.buildUp(L, B);
  const R = M.rates(B), hours = 75, material = 1000, labor = hours * R.blended;
  assert.equal(E.subtotal.hours, 75); assert.equal(E.schedule.weeks, Math.ceil(75 / (2 * 40 * 0.94)));
  const weeks = E.schedule.weeks;
  const ind = (material + labor) * 0.02 + weeks * 675 + weeks * 195 + labor * 0.005 + (material + labor) * 0.035 * 2;
  const pm = weeks * 10 * 115, direct = material + labor + ind + pm;
  const total = (direct * 1.025) * 1.2195 + material * 0.06;
  assert.ok(Math.abs(E.build.indirects_total - ind) < 0.05, `${E.build.indirects_total} vs ${ind}`);
  assert.ok(Math.abs(E.build.total - total) < 0.1, `${E.build.total} vs ${total}`);
  // productivity exposure: 25 hours removed by the 0.75 factor, marked up
  assert.equal(E.productivity.removed, 25);
  // 5 x 12 costs more than 5 x 8 (overtime + efficiency loss)
  assert.ok(E.options[1].add > 0 && E.options[2].add > 0);
});
