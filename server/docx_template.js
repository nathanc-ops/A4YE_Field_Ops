'use strict';
// Read a commercial proposal Word template (.docx) into the proposal's standard text: the closing sentences, the
// standard lists (conditions, exclusions, clarifications, qualifications, terms), the change-order unit rates,
// the acceptance sentence and the signer (name, title, phone, email, signature image).
// Job-specific lines (ones naming sheets, notes, spec sections or panels) are set aside for the user to review.
const { unzip } = require('./xlsx');

const decode = s => s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, e) => e[0] === '#' ? String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : +e.slice(1))
  : { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[e.toLowerCase()]);
const clean = s => decode(s).replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
const textOf = xml => clean((xml.match(/<w:t[^>]*>[^<]*<\/w:t>/g) || []).map(t => t.replace(/<[^>]+>/g, '')).join(''));
const JOB_SPECIFIC = /\bsheets?\s+[A-Z]{0,2}\d|general note|spec(ification)? section|panel\s+'|\bper the referenced\b|\bdrawing set\b.*\bschedules?\b/i;

function parse(buf) {
  const z = unzip(buf);
  const doc = z.text('word/document.xml');
  if (!doc) throw new Error('Not a Word document (.docx)');
  const body = doc.slice(doc.indexOf('<w:body'));
  const els = [];
  for (const m of body.matchAll(/<w:(p|tbl)\b[\s\S]*?<\/w:\1>/g)) {
    const x = m[0];
    if (m[1] === 'tbl') els.push({ t: 'tbl', rows: (x.match(/<w:tr\b[\s\S]*?<\/w:tr>/g) || []).map(r => (r.match(/<w:tc\b[\s\S]*?<\/w:tc>/g) || []).map(textOf)) });
    else els.push({ t: 'p', text: textOf(x), list: /<w:numPr>/.test(x), img: (x.match(/r:embed="([^"]+)"/) || [])[1] || null });
  }
  const H = {
    conditions: /^general conditions/i, exclusions: /^exclusions$/i, clarifications: /^clarifications\s*(&|and)\s*assumptions/i,
    qualifications: /^proposal qualifications/i, terms: /^terms\s*(&|and)\s*acceptance/i, inclusions: /^inclusions$/i,
  };
  const out = { total_line: '', validity: '', closing: '', acceptance: '', conditions: [], exclusions: [], clarifications: [], qualifications: [], terms: [],
    unit_rates: [], signer: { name: '', title: '', phone: '', email: '' }, signature: null, set_aside: [] };
  let section = null;
  for (let i = 0; i < els.length; i++) {
    const e = els[i];
    if (e.t === 'tbl') {
      const head = (e.rows[0] || []).join(' ');
      if (/unit prices? for change orders/i.test(head)) {
        out.unit_rates_title = clean(e.rows[0].join(' '));
        for (const r of e.rows.slice(1)) { const [label, ...rest] = r; if (label) out.unit_rates.push({ label, rate: rest.join(' ').replace(/\s+\//, '/').trim() }); }
      }
      continue;
    }
    const tx = e.text;
    const h = Object.keys(H).find(k => H[k].test(tx));
    if (h && !e.list) { section = h; continue; }
    if (/total amount of our bid is/i.test(tx)) { out.total_line = tx.replace(/\$\s?[\d,]+(\.\d{2})?.*$/, '').trim(); continue; }
    if (/^pricing is valid/i.test(tx)) { out.validity = tx; continue; }
    if (/^our team at/i.test(tx)) { out.closing = tx; continue; }
    if (/^to proceed with this proposal/i.test(tx)) { out.acceptance = tx; section = 'acceptance'; continue; }
    if (/^acknowledg(e)?ment and acceptance/i.test(tx)) { out.acceptance_title = tx.replace(/:$/, ''); continue; }
    if (/^sincerely,?$/i.test(tx)) {
      const rest = els.slice(i + 1).filter(x => x.t === 'p' && x.text).map(x => x.text).slice(0, 4);
      for (const line of rest) {
        if (/@/.test(line)) out.signer.email = line;
        else if (/\d{3}.*\d{4}/.test(line)) out.signer.phone = line;
        else if (!out.signer.name) out.signer.name = line;
        else if (!out.signer.title) out.signer.title = line;
      }
      break;
    }
    if (e.img && section === 'acceptance') out.signature_rid = e.img;
    if (!tx || !e.list || !['conditions', 'exclusions', 'clarifications', 'qualifications', 'terms'].includes(section)) continue;
    if (section !== 'terms' && JOB_SPECIFIC.test(tx)) out.set_aside.push({ list: section, text: tx });
    else out[section].push(tx);
  }
  // the signature: the picture placed in the body just before "Sincerely"
  if (!out.signature_rid) { const sig = [...els].reverse().find(x => x.t === 'p' && x.img); if (sig) out.signature_rid = sig.img; }
  if (out.signature_rid) {
    const rels = z.text('word/_rels/document.xml.rels') || '';
    const m = rels.match(new RegExp(`<Relationship[^>]*Id="${out.signature_rid}"[^>]*Target="([^"]+)"`)) || rels.match(new RegExp(`<Relationship[^>]*Target="([^"]+)"[^>]*Id="${out.signature_rid}"`));
    if (m) {
      const p = 'word/' + m[1].replace(/^\.?\//, '');
      const bin = z.file ? z.file(p) : null;
      if (bin && bin.length < 600 * 1024) {
        const ext = (p.split('.').pop() || 'png').toLowerCase();
        out.signature = `data:image/${ext === 'jpg' ? 'jpeg' : ext};base64,${bin.toString('base64')}`;
      }
    }
  }
  delete out.signature_rid;
  return out;
}

module.exports = { parse, JOB_SPECIFIC };
