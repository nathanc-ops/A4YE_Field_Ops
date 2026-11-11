'use strict';
// A small, dependency-free .xlsx reader: enough to pull cell values out of a workbook.
// An .xlsx file is a zip of XML parts. We read the zip's central directory, inflate the parts we need with zlib,
// and take each cell's stored value (for a formula cell that is the value Excel last calculated).
// Every cell also says whether it held a formula, so an importer can tell a typed number from a calculated one.
const zlib = require('node:zlib');

const MAX_PART = 60 * 1024 * 1024;   // per inflated part
const MAX_TOTAL = 200 * 1024 * 1024; // all parts together — refuses zip bombs

function unzip(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 22) throw new Error('Not an .xlsx file');
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 66000); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('Not an .xlsx file (no zip directory) — save it from Excel as .xlsx');
  const count = buf.readUInt16LE(eocd + 10), dirOff = buf.readUInt32LE(eocd + 16);
  if (count > 5000) throw new Error('Too many parts in that file');
  const files = new Map();
  let p = dirOff, total = 0;
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new Error('Damaged .xlsx file');
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20), usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32), lho = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nlen);
    p += 46 + nlen + xlen + clen;
    files.set(name, () => {
      if (usize > MAX_PART) throw new Error(`Part ${name} is too large`);
      total += usize; if (total > MAX_TOTAL) throw new Error('That workbook is too large to import');
      if (buf.readUInt32LE(lho) !== 0x04034b50) throw new Error('Damaged .xlsx file');
      const start = lho + 30 + buf.readUInt16LE(lho + 26) + buf.readUInt16LE(lho + 28);
      const raw = buf.subarray(start, start + csize);
      if (method === 0) return raw;
      if (method === 8) return zlib.inflateRawSync(raw, { maxOutputLength: MAX_PART });
      throw new Error(`Unsupported compression in ${name}`);
    });
  }
  return { has: n => files.has(n), text: n => { const f = files.get(n); return f ? f().toString('utf8') : null; }, file: n => { const f = files.get(n); return f ? f() : null; } };
}

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decode = s => s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, e) => e[0] === '#' ? String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : +e.slice(1)) : ENT[e.toLowerCase()]);
const attr = (tag, a) => { const m = tag.match(new RegExp(`\\s${a}="([^"]*)"`)); return m ? decode(m[1]) : null; };
const texts = xml => { let out = ''; const re = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>|<t\s*\/>/g; let m; while ((m = re.exec(xml))) out += m[1] ? decode(m[1]) : ''; return out; };
const colNum = letters => { let n = 0; for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64); return n; };
const colName = n => { let s = ''; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; };

// → { sheetNames: [...], sheet(name) → { cell(ref|row,col), rows: Map(row → Map(col → cell)), maxRow } }
// cell = { v: string|number|boolean|null, f: true when the cell held a formula, err: '#VALUE!' etc }
function read(buf) {
  const z = unzip(buf);
  const wbXml = z.text('xl/workbook.xml');
  if (!wbXml) throw new Error('Not an Excel workbook');
  const rels = new Map();
  for (const m of (z.text('xl/_rels/workbook.xml.rels') || '').matchAll(/<Relationship\b[^>]*>/g)) rels.set(attr(m[0], 'Id'), attr(m[0], 'Target'));
  const sheets = [];
  for (const m of wbXml.matchAll(/<sheet\b[^>]*\/?>/g)) {
    let target = rels.get(attr(m[0], 'r:id')) || '';
    target = target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`;
    sheets.push({ name: attr(m[0], 'name'), path: target });
  }
  const shared = [];
  const ss = z.text('xl/sharedStrings.xml');
  if (ss) for (const m of ss.matchAll(/<si>([\s\S]*?)<\/si>/g)) shared.push(texts(m[1].replace(/<rPh\b[\s\S]*?<\/rPh>/g, '')));
  const cache = new Map();
  function sheet(name) {
    const s = sheets.find(x => x.name === name);
    if (!s) return null;
    if (cache.has(name)) return cache.get(name);
    const xml = z.text(s.path) || '';
    const rows = new Map(); let maxRow = 0;
    for (const m of xml.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const ref = attr(` ${m[1]}`, 'r'); if (!ref) continue;
      const rm = ref.match(/^([A-Z]+)(\d+)$/); if (!rm) continue;
      const r = +rm[2], c = colNum(rm[1]), t = attr(` ${m[1]}`, 't'), inner = m[2] || '';
      const f = /<f[\s>/]/.test(inner);
      const vm = inner.match(/<v>([\s\S]*?)<\/v>/);
      let v = vm ? decode(vm[1]) : null, err = null;
      if (t === 's') v = v == null ? null : shared[+v] ?? null;
      else if (t === 'inlineStr') v = texts(inner);
      else if (t === 'b') v = v === '1';
      else if (t === 'e') { err = v; v = null; }
      else if (t === 'str') v = v ?? '';
      else if (v != null && v !== '') v = Number(v);
      if (v === '' && !f) v = null;
      if (!rows.has(r)) rows.set(r, new Map());
      rows.get(r).set(c, { v, f, err });
      if (r > maxRow) maxRow = r;
    }
    const api = {
      rows, maxRow,
      cell(a, b) { let r = a, c = b; if (typeof a === 'string') { const x = a.match(/^([A-Z]+)(\d+)$/); r = +x[2]; c = colNum(x[1]); } const row = rows.get(r); return (row && row.get(c)) || { v: null, f: false, err: null }; },
      val(a, b) { return this.cell(a, b).v; },
    };
    cache.set(name, api);
    return api;
  }
  return { sheetNames: sheets.map(s => s.name), sheet };
}

// Excel stores dates as days since 1899-12-30 (the 1900 leap-year bug is baked into that epoch)
const serialToIso = n => new Date(Math.round((n - 25569) * 864e5)).toISOString();
const dateOf = v => {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return v > 0 && v < 2958466 ? serialToIso(v).slice(0, 10) : null;
  const s = String(v).trim(); let m;
  if ((m = s.match(/^(\d{4})-(\d{2})-(\d{2})/))) return `${m[1]}-${m[2]}-${m[3]}`;
  if ((m = s.match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/))) { const y = +m[3] < 100 ? 2000 + +m[3] : +m[3]; return `${y}-${String(m[1]).padStart(2, '0')}-${String(m[2]).padStart(2, '0')}`; }
  return null;
};
// a wall-clock "YYYY-MM-DD HH:MM" (no time zone) from a date-time serial or text
const dateTimeOf = v => {
  if (v == null || v === '') return null;
  if (typeof v === 'number') { const iso = serialToIso(v); return `${iso.slice(0, 10)} ${iso.slice(11, 16)}`; }
  return String(v).trim();
};

module.exports = { read, unzip, dateOf, dateTimeOf, colNum, colName };
