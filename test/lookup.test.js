'use strict';
// Customer search past the old 500 cap, address lookup (Google + free Census, with the outside services stubbed), permits report.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const D = require('../server/db');
const Geo = require('../server/geo');
const { createApp } = require('../server/app');

let server, base, db, tok;
const realFetch = globalThis.fetch;
const outside = []; // requests that would have left the server
let googleReplies = {};
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.includes('geocoding.geo.census.gov')) {
    outside.push(u);
    const ok = /1600 pennsylvania/i.test(decodeURIComponent(u.replace(/\+/g, ' ')));
    return new Response(JSON.stringify({ result: { addressMatches: ok ? [{ matchedAddress: '1600 PENNSYLVANIA AVE NW, WASHINGTON, DC, 20500', coordinates: { x: -77.0365, y: 38.8977 } }] : [] } }), { status: 200 });
  }
  if (u.includes('places.googleapis.com')) {
    outside.push({ u, key: opts.headers && opts.headers['X-Goog-Api-Key'], body: opts.body });
    const r = u.includes(':autocomplete') ? googleReplies.suggest : googleReplies.details;
    return new Response(JSON.stringify(r.body), { status: r.status || 200 });
  }
  return realFetch(url, opts);
};
async function call(method, p, body, token = tok) {
  const res = await fetch(base + '/api' + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json(), total: res.headers.get('X-Total-Count') };
}

before(async () => {
  db = D.open(':memory:');
  server = createApp(db).listen(0);
  await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  tok = (await call('POST', '/setup', { name: 'Owner', email: 'o@x.com', password: 'longenough' })).data.token;
});
after(() => { server.close(); globalThis.fetch = realFetch; });

test('customer search over 1,200 customers', async () => {
  const ins = db.prepare('INSERT INTO customers (name, company, phone) VALUES (?, ?, ?)');
  const loc = db.prepare('INSERT INTO locations (customer_id, address, city, zip) VALUES (?, ?, ?, ?)');
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  for (let i = 0; i < 1200; i++) {
    const id = ins.run(`${letters[i % 26]}customer ${i}`, null, `208555${String(i).padStart(4, '0')}`).lastInsertRowid;
    loc.run(id, `${100 + i} Oak St`, 'Boise', '83702');
  }
  const zz = ins.run('Smith, Jordan', 'Zephyr Builders LLC', '(208) 555-9876').lastInsertRowid;
  loc.run(zz, '742 Evergreen Terrace', 'Springfield', '62704');

  const all = await call('GET', '/customers?limit=100');
  assert.equal(all.total, '1201'); assert.equal(all.data.length, 100);
  const lastPage = await call('GET', '/customers?limit=100&offset=1200');
  assert.equal(lastPage.data.length, 1); assert.equal(lastPage.data[0].company, 'Zephyr Builders LLC'); // sorted by the name shown (company), so Z is last
  const z = await call('GET', '/customers?letter=Z');
  assert.ok(z.data.some(c => c.id === zz)); assert.ok(z.data.every(c => (c.company || c.name)[0].toUpperCase() === 'Z'));

  for (const q of ['2085559876', '555-9876', '(208) 555 9876', 'evergreen', '742 evergreen springfield', 'jordan smith', 'zephyr', '62704']) {
    const r = await call('GET', '/customers?q=' + encodeURIComponent(q));
    assert.ok(r.data.some(c => c.id === zz), `"${q}" should find Zephyr`);
  }
  assert.equal((await call('GET', '/customers?q=' + encodeURIComponent('evergreen boise'))).data.length, 0); // every word must match
  assert.equal((await call('GET', '/customers?q=' + encodeURIComponent('100%'))).data.length, 0); // % is literal, not a wildcard
});

test('address lookup without a key uses the free Census check and only once a street is typed', async () => {
  outside.length = 0;
  let r = await call('GET', '/address/suggest?q=1600');
  assert.equal(r.data.provider, 'census'); assert.deepEqual(r.data.results, []); assert.equal(outside.length, 0);
  r = await call('GET', '/address/suggest?q=' + encodeURIComponent('1600 Pennsylvania Ave, Washington DC'));
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.results[0], { address: '1600 Pennsylvania Ave NW', city: 'Washington', state: 'DC', zip: '20500', lat: 38.8977, lng: -77.0365, provider: 'census', main: '1600 Pennsylvania Ave NW', secondary: 'Washington, DC, 20500' });
  assert.equal((await call('GET', '/address/details?id=abc')).status, 400);
});

test('address lookup with a Google key: suggestions, then details; key never reaches the browser', async () => {
  await call('PUT', '/settings', { google_maps_api_key: 'AIzaTESTKEY' });
  const me = await call('GET', '/me');
  assert.equal(me.data.settings.google_maps_api_key, ''); assert.equal(me.data.settings.google_maps_api_key_set, '1');
  googleReplies = {
    suggest: { body: { suggestions: [{ placePrediction: { placeId: 'ChIJabc123def456', text: { text: '742 Evergreen Terrace, Springfield, IL, USA' }, structuredFormat: { mainText: { text: '742 Evergreen Terrace' }, secondaryText: { text: 'Springfield, IL, USA' } } } }] } },
    details: { body: { formattedAddress: '742 Evergreen Terrace Unit 2, Springfield, IL 62704, USA', location: { latitude: 39.78, longitude: -89.65 }, addressComponents: [
      { longText: '742', shortText: '742', types: ['street_number'] }, { longText: 'Evergreen Terrace', shortText: 'Evergreen Terrace', types: ['route'] }, { longText: '2', shortText: '2', types: ['subpremise'] },
      { longText: 'Springfield', shortText: 'Springfield', types: ['locality', 'political'] }, { longText: 'Illinois', shortText: 'IL', types: ['administrative_area_level_1'] },
      { longText: '62704', shortText: '62704', types: ['postal_code'] }] } },
  };
  outside.length = 0;
  const s = await call('GET', '/address/suggest?q=' + encodeURIComponent('742 everg') + '&session=s1');
  assert.equal(s.data.provider, 'google'); assert.equal(s.data.results[0].id, 'ChIJabc123def456'); assert.equal(s.data.results[0].secondary, 'Springfield, IL, USA');
  assert.equal(outside[0].key, 'AIzaTESTKEY'); assert.equal(JSON.parse(outside[0].body).sessionToken, 's1');
  const d = await call('GET', '/address/details?id=ChIJabc123def456&session=s1');
  assert.deepEqual({ ...d.data, formatted: undefined }, { address: '742 Evergreen Terrace #2', city: 'Springfield', state: 'IL', zip: '62704', lat: 39.78, lng: -89.65, provider: 'google', formatted: undefined });
  assert.equal((await call('GET', '/address/details?id=' + encodeURIComponent('../../evil'))).status, 400);
  // Google refusing (bad key, billing off) comes back as a readable message, not a crash
  googleReplies.suggest = { status: 403, body: { error: { message: 'API key not valid' } } };
  const bad = await call('GET', '/address/suggest?q=' + encodeURIComponent('742 everg'));
  assert.equal(bad.status, 502); assert.match(bad.data.error, /API key not valid/);
  await call('PUT', '/settings', { google_maps_api_key_clear: '1' });
  assert.equal((await call('GET', '/me')).data.settings.google_maps_api_key_set, '');
});

test('service addresses keep their map coordinates and verified time', async () => {
  const r = await call('POST', '/customers', { name: 'Pat', location: { address: '1 Elm St', city: 'Boise', state: 'ID', zip: '83702', lat: 43.61, lng: -116.2, verified_at: '2026-11-09T10:00:00Z' } });
  const c = (await call('GET', `/customers/${r.data.id}`)).data;
  assert.equal(c.locations[0].lat, 43.61); assert.equal(c.locations[0].verified_at, '2026-11-09T10:00:00Z');
  await call('PUT', `/locations/${c.locations[0].id}`, { address: '2 Elm St', lat: null, lng: null, verified_at: null });
  assert.equal(db.prepare('SELECT verified_at FROM locations WHERE id = ?').get(c.locations[0].id).verified_at, null);
});

test('permits report: date type, status groups, jurisdiction, and attention flags', async () => {
  const cust = (await call('POST', '/customers', { name: 'Permit Pat', location: { address: '5 Main St' } })).data.id;
  const job = (await call('POST', '/jobs', { customer_id: cust, title: 'Service change' })).data.id;
  const job2 = (await call('POST', '/jobs', { customer_id: cust, title: 'EV charger' })).data.id;
  await call('PUT', `/jobs/${job2}`, { status: 'completed' });
  const add = b => call('POST', '/permits', b);
  await add({ job_id: job, permit_type: 'Service change', jurisdiction: 'Boise', status: 'passed', applied_date: '2026-10-02', issued_date: '2026-10-05', inspection_date: '2026-10-20', fee: 150 });
  await add({ job_id: job, permit_type: 'Rough-in', jurisdiction: 'Boise', status: 'rough_scheduled', applied_date: '2026-10-10', inspection_date: '2026-10-15', fee: 90 });
  await add({ job_id: job2, permit_type: 'EVSE', jurisdiction: 'Meridian', status: 'failed', applied_date: '2026-10-12', fee: 75 });
  await add({ job_id: job2, permit_type: 'Old', jurisdiction: 'Meridian', status: 'issued', applied_date: '2026-08-01', fee: 60 });

  let r = (await call('GET', '/reports/permits?from=2026-10-01&to=2026-10-31')).data;
  assert.equal(r.summary.count, 3); assert.equal(r.summary.fees, 315); assert.equal(r.summary.open, 2); assert.equal(r.summary.passed, 1);
  assert.deepEqual(r.summary.by_jurisdiction.map(x => [x.jurisdiction, x.count, x.fees]), [['Boise', 2, 240], ['Meridian', 1, 75]]);
  assert.deepEqual(r.summary.jurisdictions, ['Boise', 'Meridian']);
  const rough = r.rows.find(x => x.permit_type === 'Rough-in');
  assert.match(rough.flags.join(), /Inspection date passed/);
  assert.match(r.rows.find(x => x.permit_type === 'EVSE').flags.join(), /Failed inspection.*Job finished but permit not closed/);
  assert.equal(r.rows.find(x => x.permit_type === 'Service change').flags.length, 0);
  assert.equal(r.rows.find(x => x.permit_type === 'Service change').days_open, 18);

  r = (await call('GET', '/reports/permits?from=2026-10-01&to=2026-10-31&status=attention')).data;
  assert.deepEqual(r.rows.map(x => x.permit_type).sort(), ['EVSE', 'Rough-in']);
  r = (await call('GET', '/reports/permits?from=2026-10-01&to=2026-10-31&jurisdiction=Meridian')).data;
  assert.deepEqual(r.rows.map(x => x.permit_type), ['EVSE']);
  r = (await call('GET', '/reports/permits?from=2026-10-14&to=2026-10-16&by=inspection')).data;
  assert.deepEqual(r.rows.map(x => x.permit_type), ['Rough-in']);
  r = (await call('GET', '/reports/permits?from=2026-01-01&to=2026-12-31&status=passed,closed')).data;
  assert.deepEqual(r.rows.map(x => x.permit_type), ['Service change']);
  assert.equal((await call('POST', '/login', { email: 'x', password: 'y' }, null)).status, 401);
});

test('title case keeps directions and ordinals readable', () => {
  assert.equal(Geo.titleCase('1600 PENNSYLVANIA AVE NW'), '1600 Pennsylvania Ave NW');
  assert.equal(Geo.titleCase('200 W 21ST ST'), '200 W 21st St');
});

test('customers file A–Z by last name; companies and business names by name', async () => {
  const { customerSortKey: k } = D;
  assert.equal(k('Jordan Smith'), 'smith jordan'); assert.equal(k('Smith, Jordan'), 'smith jordan'); assert.equal(k('Jordan Smith Jr.'), 'smith jordan');
  assert.equal(k('Mary Ann Van Dyke'), 'van dyke mary ann'); assert.equal(k('Luis De La Cruz'), 'de la cruz luis');
  assert.equal(k('Pat Home', 'Acme Corp'), 'acme corp'); assert.equal(k('Riverside Plaza LLC'), 'riverside plaza llc'); assert.equal(k('The Oaks HOA'), 'oaks hoa');
  const id = (await call('POST', '/customers', { name: 'Quentin Aardvark' })).data.id;
  const a = await call('GET', '/customers?letter=A&limit=1000');
  assert.ok(a.data.some(c => c.id === id), 'last name A');
  assert.ok(!(await call('GET', '/customers?letter=Q&limit=1000')).data.some(c => c.id === id));
  assert.ok((await call('GET', '/customers?letter=Q&sort=first&limit=1000')).data.some(c => c.id === id), 'first-name mode files under Q');
});

test('booking a T&M job from the form (fixed-price boxes blanked) saves', async () => {
  const cust = (await call('POST', '/customers', { name: 'Form Test' })).data.id;
  const form = { customer_id: cust, location_id: null, title: 'Outlet', job_type: 'service', priority: 'normal', scheduled_start: null, scheduled_end: null, lead_source: null,
    billing_type: 'tm', contract_amount: null, retainage_pct: null, labor_rate: null, material_markup_pct: null, trip_charge: null, nte_amount: null, bill_travel: 1,
    po_number: null, budget_hours: null, budget_materials: null, description: null, tech_ids: [] };
  const r = await call('POST', '/jobs', form);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const fixed = await call('PUT', `/jobs/${r.data.id}`, { ...form, billing_type: 'fixed', contract_amount: 5000, retainage_pct: 10, bill_travel: null });
  assert.equal(fixed.status, 200, JSON.stringify(fixed.data));
  const j = db.prepare('SELECT retainage_pct, bill_travel FROM jobs WHERE id = ?').get(r.data.id);
  assert.equal(j.retainage_pct, 10); assert.equal(j.bill_travel, 1);
});

test('booked hours: a multi-day visit counts its daily window, not every hour in between', () => {
  const C = require('../server/calc');
  const at = (d, h) => new Date(`${d}T${String(h).padStart(2, '0')}:00:00`).toISOString();
  const long = { start: at('2026-11-02', 7), end: at('2026-11-20', 15) };
  assert.equal(C.visitHoursOnDay(long, '2026-11-09'), 8);
  assert.equal(C.visitHoursOnDay(long, '2026-11-21'), 0);
  assert.equal(C.visitHoursOnDay({ start: at('2026-11-09', 9), end: at('2026-11-09', 11) }, '2026-11-09'), 2);
  assert.equal(C.visitHoursOnDay({ start: at('2026-11-09', 22), end: at('2026-11-10', 2) }, '2026-11-10'), 2); // overnight call: just the 2 hours after midnight
});
