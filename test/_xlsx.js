'use strict';
// Test helper: a minimal .xlsx writer (stored zip entries) — enough for server/xlsx.js to read.
const zlib = require('node:zlib');
// ---- a minimal .xlsx writer (stored zip entries) — enough for the reader under test
function zip(files) {
  const parts = [], dir = []; let off = 0;
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text, 'utf8'), nm = Buffer.from(name), crc = zlib.crc32(data);
    const h = Buffer.alloc(30); h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt32LE(crc, 14); h.writeUInt32LE(data.length, 18); h.writeUInt32LE(data.length, 22); h.writeUInt16LE(nm.length, 26);
    parts.push(h, nm, data);
    const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt32LE(crc, 16); c.writeUInt32LE(data.length, 20); c.writeUInt32LE(data.length, 24);
    c.writeUInt16LE(nm.length, 28); c.writeUInt32LE(off, 42); dir.push(c, nm);
    off += 30 + nm.length + data.length;
  }
  const cd = Buffer.concat(dir), e = Buffer.alloc(22);
  e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(Object.keys(files).length, 8); e.writeUInt16LE(Object.keys(files).length, 10); e.writeUInt32LE(cd.length, 12); e.writeUInt32LE(off, 16);
  return Buffer.concat([...parts, cd, e]);
}
const xmlEsc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function xlsx(sheets) {
  const names = Object.keys(sheets), files = {};
  files['xl/workbook.xml'] = `<?xml version="1.0"?><workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${names.map((n, i) => `<sheet name="${xmlEsc(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`;
  files['xl/_rels/workbook.xml.rels'] = `<?xml version="1.0"?><Relationships>${names.map((n, i) => `<Relationship Id="rId${i + 1}" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}</Relationships>`;
  names.forEach((n, i) => {
    const byRow = {};
    for (const [ref, v] of Object.entries(sheets[n])) { const r = +ref.match(/\d+/)[0]; (byRow[r] = byRow[r] || []).push([ref, v]); }
    const cell = (ref, v) => {
      const f = v && typeof v === 'object' && 'f' in v, val = f ? v.v : v;
      const fx = f ? `<f>${xmlEsc(v.f)}</f>` : '';
      if (val == null) return `<c r="${ref}">${fx}</c>`;
      if (typeof val === 'number') return `<c r="${ref}">${fx}<v>${val}</v></c>`;
      return f ? `<c r="${ref}" t="str">${fx}<v>${xmlEsc(val)}</v></c>` : `<c r="${ref}" t="inlineStr"><is><t>${xmlEsc(val)}</t></is></c>`;
    };
    files[`xl/worksheets/sheet${i + 1}.xml`] = `<?xml version="1.0"?><worksheet><sheetData>${Object.keys(byRow).sort((a, b) => a - b).map(r => `<row r="${r}">${byRow[r].map(([ref, v]) => cell(ref, v)).join('')}</row>`).join('')}</sheetData></worksheet>`;
  });
  return zip(files);
}
module.exports = { xlsx, zip };
