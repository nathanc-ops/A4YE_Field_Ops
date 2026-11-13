'use strict';
// Spoken scope → estimate lines. A tech or estimator says (or types) what the customer wants; Claude turns it into
// lines from the company's price book, priced at the price book's prices. Anything the price book doesn't have comes
// back as a custom line with Claude's suggested price, flagged for a person to check. Nothing is saved here: the
// lines go into the estimate editor, where the person reviews them and presses Save as usual.
const D = require('./db');
const { all, get } = D;

const MODEL = 'claude-opus-5-5';
let makeClient = apiKey => { const A = require('@anthropic-ai/sdk'); const Anthropic = A.default || A; return new Anthropic({ apiKey }); };

const SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['title', 'summary', 'lines', 'assumptions', 'questions'],
  properties: {
    title: { type: 'string', description: 'A short estimate title, e.g. "Add 2 GFCI circuits in garage"' },
    summary: { type: 'string', description: 'One or two plain sentences: what the work is' },
    lines: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['pricebook_id', 'description', 'qty', 'unit_price', 'why'],
      properties: {
        pricebook_id: { type: ['integer', 'null'], description: 'The id of the price book item, or null when nothing in the price book fits' },
        description: { type: 'string', description: 'The line as the customer reads it' },
        qty: { type: 'number' },
        unit_price: { type: ['number', 'null'], description: 'Only for lines with no price book item: a fair residential price per unit in USD. null for price book lines' },
        why: { type: 'string', description: 'Which part of what was said this line covers, in a few words' },
      } } },
    assumptions: { type: 'array', items: { type: 'string' } },
    questions: { type: 'array', items: { type: 'string', description: 'Something the person should confirm with the customer before sending' } },
  },
};

function systemPrompt(db) {
  const s = D.settings(db);
  const items = all(db, "SELECT id, code, name, unit, unit_price, kind, labor_hours, category FROM pricebook WHERE active = 1 ORDER BY category, name");
  const catalog = items.map(p => `${p.id}|${p.code || ''}|${p.name}|${p.unit || 'ea'}|${Number(p.unit_price || 0).toFixed(2)}|${p.kind || ''}${p.labor_hours ? `|${p.labor_hours}h` : ''}`).join('\n');
  return `You write residential electrical service estimates for ${s.company_name || 'an electrical contractor'}. An electrician or estimator has just walked the job and described, in their own words (often dictated, so expect misheard words, missing punctuation and trade shorthand), what the customer wants. Turn it into estimate lines.

How to build the lines:
- Use the company's price book below. Prefer price book items: flat-rate tasks first (they include labor and material), otherwise the material items plus labor. Set pricebook_id to the item's id and unit_price to null; the app uses the price book price.
- Quantities: count what was said ("three outlets in the garage" = 3). When a quantity wasn't said but the work needs it, pick the usual amount and list it under assumptions.
- Include what the job needs to be complete and to code even when it wasn't spelled out (a permit when the work needs one, a new breaker for a new circuit, a box for a new device) if the price book has it, and say so in assumptions.
- Only when nothing in the price book fits, add a custom line: pricebook_id null, a clear description, and a fair residential price in unit_price. Don't invent price book ids.
- Don't add anything the person didn't ask for beyond what the work requires. Don't add tax or discounts.
- Dictation errors: read through them ("gee eff eye" = GFCI, "twenty amp" = 20A, "can lights" = recessed lights). If something is genuinely unclear, ask in questions instead of guessing a big item.
- Write descriptions for the homeowner: plain, short, no jargon dumps.

Price book (id|code|name|unit|price|kind|labor hours):
${catalog || '(the price book is empty: every line is a custom line)'}`;
}

module.exports = function voiceEstimate(app, db, { wrap, bad }) {
  app.post('/api/estimates/voice-draft', wrap(async (req, res) => {
    const tech = req.user.role === 'tech';
    if (tech ? !req.can('field_estimates') : !(req.can('estimates') || req.user.role === 'admin')) throw bad('You don\'t have permission to build estimates', 403);
    const key = D.settings(db).anthropic_api_key;
    if (!key) throw bad('Add the Anthropic API key in Settings → Plan takeoff (Claude) first');
    const scope = String(req.body.scope || '').trim();
    if (scope.length < 10) throw bad('Say a bit more about the work first');
    if (scope.length > 8000) throw bad('That is a lot — split it into two estimates, or trim it to the work being priced');
    const cust = req.body.customer_id ? get(db, 'SELECT name, type FROM customers WHERE id = ?', +req.body.customer_id) : null;
    const job = req.body.job_id ? get(db, 'SELECT number, title FROM jobs WHERE id = ?', +req.body.job_id) : null;
    const already = Array.isArray(req.body.existing) ? req.body.existing.filter(Boolean).slice(0, 60).map(x => `- ${String(x).slice(0, 200)}`).join('\n') : '';
    const client = makeClient(key);
    let msg;
    try {
      const stream = client.beta.messages.stream({
        model: MODEL, max_tokens: 16000,
        betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default',
        thinking: { type: 'adaptive' },
        output_config: { effort: 'medium', format: { type: 'json_schema', schema: SCHEMA } },
        system: [{ type: 'text', text: systemPrompt(db), cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: [{ type: 'text', text: [
          cust ? `Customer: ${cust.name} (${cust.type || 'residential'}).` : '', job ? `Job ${job.number}: ${job.title || ''}.` : '',
          already ? `Lines already on the estimate (don't repeat them):\n${already}` : '',
          `What they said about the work:\n<scope>\n${scope}\n</scope>`,
        ].filter(Boolean).join('\n\n') }] }],
      });
      msg = await stream.finalMessage();
    } catch (e) {
      const A = (() => { try { const m = require('@anthropic-ai/sdk'); return m.default || m; } catch { return null; } })();
      if (A && e instanceof A.AuthenticationError) throw bad('The Anthropic API key was rejected — check it in Settings', 502);
      if (A && e instanceof A.RateLimitError) throw bad('Claude is busy right now — try again in a minute', 503);
      throw bad(`Couldn't reach Claude: ${e.message}`, 502);
    }
    if (msg.stop_reason === 'refusal') throw bad('Claude declined this one — build it by hand', 422);
    if (msg.stop_reason === 'max_tokens') throw bad('That scope is too long for one estimate — split it', 422);
    let out; try { out = JSON.parse(msg.content.filter(b => b.type === 'text').map(b => b.text).join('')); } catch { throw bad('Claude returned something that was not an estimate — try again', 502); }
    // price book lines take the price book's price; ids Claude made up become custom lines
    const lines = (out.lines || []).map(l => {
      const pb = l.pricebook_id ? get(db, 'SELECT * FROM pricebook WHERE id = ? AND active = 1', l.pricebook_id) : null;
      const qty = Number(l.qty) > 0 ? Number(l.qty) : 1;
      if (pb) return { pricebook_id: pb.id, description: pb.name, qty, unit_price: pb.unit_price, unit_cost: tech && !req.can('see_costs') ? undefined : pb.unit_cost, taxable: pb.taxable, cost_code_id: pb.cost_code_id, why: l.why, from_book: true };
      return { pricebook_id: null, description: String(l.description || '').slice(0, 300), qty, unit_price: Math.max(0, Math.round((Number(l.unit_price) || 0) * 100) / 100), unit_cost: 0, taxable: 1, why: l.why, from_book: false };
    }).filter(l => l.description);
    res.json({ title: out.title || '', summary: out.summary || '', lines, assumptions: out.assumptions || [], questions: out.questions || [], model: msg.model || MODEL });
  }));
};
module.exports.setClientFactory = f => { makeClient = f; };
module.exports.SCHEMA = SCHEMA;
