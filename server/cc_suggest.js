'use strict';
// Cost code suggestions for a material line (PO lines, and anywhere else a material gets coded). Ranked by:
//   1. the code set on the price-book item;
//   2. how the same item / the same words were coded before (PO lines, job materials, pick lists, vendor bills);
//   3. electrical trade words in the description pointing at a code (EMT, THHN, GFCI, strut, wall pack…);
//   4. words shared with the code's name and description;
//   5. a small nudge for codes in the job's budget.
// Only codes that can carry material (material / both / other) are suggested. Each comes with a short reason.
const D = require('./db');
const { all, get } = D;

const STOP = new Set(['and', 'the', 'for', 'with', 'per', 'box', 'ea', 'each', 'ft', 'pcs', 'pack', 'pk', 'roll', 'new', 'misc', 'inch', 'in', 'set', 'white', 'black', 'red', 'blue', 'green', 'gray', 'grey', 'ivory', 'brown', 'pull', 'install']);
const words = s => String(s || '').toLowerCase().replace(/[^a-z0-9#\/.\- ]+/g, ' ').split(/[\s\-\/]+/).map(w => w.replace(/^[.#]+|[.]+$/g, '')).filter(w => w.length >= 3 && !STOP.has(w) && !/^\d+(\.\d+)?$/.test(w));
const norm = s => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();

// trade words → which code they point at (matched against the code's name/description)
const TRADE = [
  [/\bemt\b|set ?screw|compression (connector|coupling)/, /^emt$/],
  [/\b(rigid|rmc|imc|grc)\b/, /rigid/],
  [/\bpvc\b|sch(edule)? ?(40|80)/, /^pvc$/],
  [/\b(flex|lfmc|fmc|sealtite|liquidtite|whip)\b/, /flex/],
  [/\b(mc|ac) ?cable\b|\bmc\b|\bbx\b/, /mc cable/],
  [/\b(tray|wireway|ladder rack)\b/, /tray|wireway/],
  [/\b(box(es)?|strap|strut|unistrut|hanger|beam clamp|mud ring|plaster ring|all ?thread|threaded rod|caddy|kindorf)\b/, /^boxes, fittings/],
  [/firestop|fire stop|\bsleeve|core drill/, /firestop/],
  [/\b(thhn|thwn|xhhw|romex|nm-?b|wire)\b|#1[02]\b|\b1[024] ?awg/, /^branch wire/],
  [/wire ?nut|\bwago\b|\blugs?\b|splice|\bpolaris\b|lever nut/, /^terminations/],
  [/\b(receptacle|outlet|duplex|gfci|gfi|usb)\b/, /^receptacles/],
  [/\b(switch|dimmer|3-?way|4-?way|toggle|decora)\b/, /^switches/],
  [/\b(cover ?plate|wall ?plate|blank plate)\b/, /^plates/],
  [/\b(floor box|poke-?thru)\b/, /^floor boxes/],
  [/\b(panel|loadcenter|load center|breaker|panelboard)\b/, /^panelboards/],
  [/\b(disconnect|safety switch|fused|enclosed breaker)\b/, /^disconnects/],
  [/\b(switchboard|switchgear|mdp)\b/, /^switchgear/],
  [/\b(transformer|xfmr)\b/, /^transformers/],
  [/\b(meter|ct can|ct cabinet)\b/, /metering/],
  [/\b(troffer|fixture|luminaire|downlight|recessed|can light|strip light|high ?bay)\b/, /^interior fixtures/],
  [/\b(wall ?pack|pole|bollard|flood ?light|area light)\b/, /^exterior/],
  [/\b(exit|emergency light|em head|bug ?eye)\b/, /^emergency/],
  [/\b(occupancy|vacancy|photocell|daylight|sensor)\b/, /^occupancy/],
  [/\b(relay panel|time ?clock|lighting control)\b/, /^relay panels/],
  [/\b(ground rod|ufer|gec|grounding electrode)\b/, /^ground electrode/],
  [/\b(bond|bonding|ground clamp)\b/, /^equipment bonding/],
  [/\b(cat ?6a?|cat ?5e|fiber|keystone|rj45|data jack)\b/, /^cable pull/],
  [/\b(patch panel|rack|backboard)\b/, /^racks/],
  [/\b(evse|ev charger|chargepoint)\b|\bev\b/, /^ev chargers/],
  [/\bgenerator\b|\bgenset\b/, /^generator$/],
  [/\b(ats|transfer switch)\b/, /transfer switch/],
  [/\b(smoke|horn|strobe|facp|pull station|fire alarm)\b/, /^fa devices/],
  [/\b(camera|nvr|cctv)\b/, /^cctv/],
  [/\b(card reader|door strike|access control)\b/, /^access control/],
  [/\b(trench|backfill|warning tape|duct bank)\b/, /^trenching/],
  [/\b(handhole|vault|pull box)\b/, /^vaults/],
  [/\b(label|labels|panel schedule)\b/, /labeling/],
  // taking things out (only when the line says remove / demo: demolition codes are left out otherwise)
  [/(remov|demo|tear ?out).*\b(troffer|fixture|light)|\b(troffer|fixture|light).*(remov|demo)/, /^fixture removal/],
  [/(remov|demo).*\b(receptacle|switch|device|wiring|outlet)|\b(receptacle|switch|device|wiring|outlet).*(remov|demo)/, /^device & wiring removal/],
  [/(remov|demo).*\b(panel|disconnect|transformer|gear)|\b(panel|disconnect|transformer|gear).*(remov|demo)/, /^panel & gear removal/],
];

function suggest(db, { description = '', pricebook_id = null, job_id = null, limit = 3 } = {}) {
  // demolition codes only when the line is about taking something out
  const demo = /\b(remov|demo|tear ?out|salvage)/i.test(description);
  const codes = all(db, "SELECT id, code, name, kind, details, division FROM cost_codes WHERE active = 1 AND kind != 'labor'").filter(c => demo || c.division !== '04');
  if (!codes.length) return [];
  const score = new Map(), why = new Map();
  const add = (id, pts, reason) => { if (!id) return; score.set(id, (score.get(id) || 0) + pts); if (reason && !(why.get(id) || []).includes(reason)) why.set(id, [...(why.get(id) || []), reason]); };
  const valid = new Set(codes.map(c => c.id));
  const desc = norm(description);
  // 1. the price-book item's own code
  if (pricebook_id) { const pb = get(db, 'SELECT cost_code_id FROM pricebook WHERE id = ?', pricebook_id); if (pb && valid.has(pb.cost_code_id)) add(pb.cost_code_id, 100, 'set on the price-book item'); }
  // 2. how it was coded before: same price-book item, or the same description
  if (pricebook_id || desc) {
    const past = all(db, `SELECT cost_code_id, COUNT(*) n FROM (
        SELECT cost_code_id, pricebook_id, description FROM po_lines UNION ALL SELECT cost_code_id, pricebook_id, description FROM job_materials
        UNION ALL SELECT cost_code_id, pricebook_id, description FROM pick_list_lines UNION ALL SELECT cost_code_id, NULL, description FROM bill_lines
      ) WHERE cost_code_id IS NOT NULL AND ((? IS NOT NULL AND pricebook_id = ?) OR (? != '' AND lower(trim(description)) = ?)) GROUP BY cost_code_id ORDER BY n DESC LIMIT 5`,
      pricebook_id, pricebook_id, desc, desc);
    for (const p of past) if (valid.has(p.cost_code_id)) add(p.cost_code_id, 30 + 8 * Math.min(p.n, 5), `coded this way ${p.n} time${p.n === 1 ? '' : 's'} before`);
  }
  // 3. trade words
  for (const [inDesc, inCode] of TRADE) if (inDesc.test(desc)) for (const c of codes) if (inCode.test(c.name.toLowerCase())) add(c.id, 25, 'matches the item type');
  // 4. shared words with the code's name / description
  const dw = new Set(words(desc));
  if (dw.size) for (const c of codes) {
    const hit = words(`${c.name} ${c.details || ''}`).filter(w => dw.has(w) || dw.has(w.replace(/s$/, '')) || dw.has(w + 's'));
    if (hit.length) add(c.id, 8 * new Set(hit).size, `“${[...new Set(hit)].slice(0, 2).join('”, “')}” in the code`);
  }
  // 5. the job's budget
  if (job_id && score.size) for (const b of all(db, 'SELECT cost_code_id FROM job_budgets WHERE job_id = ?', job_id)) if (score.has(b.cost_code_id)) add(b.cost_code_id, 6, "in this job's budget");
  return [...score.entries()].filter(([, s]) => s >= 8).sort((a, b) => b[1] - a[1]).slice(0, limit)
    .map(([id, s]) => { const c = codes.find(x => x.id === id); return { id, code: c.code, name: c.name, score: s, why: (why.get(id) || []).join('; ') }; });
}

module.exports = function ccSuggestRoutes(app, db, { wrap, office }) {
  app.get('/api/cost-codes/suggest', office, wrap((req, res) => res.json(suggest(db, {
    description: String(req.query.description || '').slice(0, 300), pricebook_id: req.query.pricebook_id ? +req.query.pricebook_id : null, job_id: req.query.job_id ? +req.query.job_id : null,
  }))));
  // several lines at once (a PO opened with lines that have no code yet)
  app.post('/api/cost-codes/suggest', office, wrap((req, res) => res.json((Array.isArray(req.body.lines) ? req.body.lines.slice(0, 200) : []).map(l => suggest(db, {
    description: String(l.description || '').slice(0, 300), pricebook_id: l.pricebook_id ? +l.pricebook_id : null, job_id: req.body.job_id ? +req.body.job_id : null,
  })))));
};
module.exports.suggest = suggest;
