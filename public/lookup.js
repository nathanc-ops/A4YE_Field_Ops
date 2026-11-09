'use strict';
/* Search-as-you-type fields:
 *  - type: 'customer' → find a customer by name, company, phone, email or address (no list size limit)
 *  - type: 'address'  → look the address up (Google Places when a key is set in Settings, otherwise the free
 *                       US Census geocoder), fill city/state/ZIP, and mark it verified with map coordinates.
 * Both render plain inputs, so readForm()/form.elements keep working; picking a result fires 'change'. */

// ------------------------------------------------------------ generic suggestion list
function suggestBox(input, { search, render, pick, minChars = 1, delay = 200, emptyText = 'No matches' }) {
  const list = document.createElement('div');
  list.className = 'sugg'; list.hidden = true; list.setAttribute('role', 'listbox');
  input.after(list);
  input.setAttribute('autocomplete', 'off'); input.setAttribute('aria-autocomplete', 'list');
  let items = [], at = -1, timer, seq = 0;
  const close = () => { list.hidden = true; at = -1; };
  const highlight = i => { at = i; $$('.sugg-i', list).forEach((el, k) => el.classList.toggle('on', k === i)); };
  const choose = i => { const it = items[i]; if (!it) return; close(); pick(it); };
  const show = html => { list.innerHTML = html; list.hidden = false; };
  const run = async () => {
    const q = input.value.trim(); const my = ++seq;
    if (q.length < minChars) return close();
    show('<div class="sugg-note">Searching…</div>');
    try {
      const r = await search(q);
      if (my !== seq) return; // a newer keystroke won
      items = r.items || r;
      if (!items.length) return show(`<div class="sugg-note">${esc(r.empty || emptyText)}</div>`);
      show(items.map((it, k) => `<div class="sugg-i" role="option" data-k="${k}">${render(it)}</div>`).join('') + (r.note ? `<div class="sugg-note">${r.note}</div>` : ''));
      highlight(0);
    } catch (e) { if (my === seq) show(`<div class="sugg-note bad">${esc(e.message)}</div>`); }
  };
  input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(run, delay); });
  input.addEventListener('focus', () => { if (input.value.trim().length >= minChars && list.hidden && input.dataset.picked !== '1') run(); });
  input.addEventListener('blur', () => setTimeout(close, 150));
  input.addEventListener('keydown', e => {
    if (list.hidden) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); highlight(Math.min(at + 1, items.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); highlight(Math.max(at - 1, 0)); }
    else if (e.key === 'Enter' && at >= 0 && items.length) { e.preventDefault(); choose(at); }
    else if (e.key === 'Escape') { e.stopPropagation(); close(); }
  });
  list.addEventListener('mousedown', e => { const el = e.target.closest('.sugg-i'); if (el) { e.preventDefault(); choose(Number(el.dataset.k)); } });
  return { close, run };
}

// ------------------------------------------------------------ customer picker
const custLabel = c => c.company ? `${c.company} (${c.name})` : c.name;
function customerFieldHtml(f, val) {
  const id = 'f_' + f.name;
  setTimeout(initLookups);
  return `<label class="f ${f.full ? 'full' : ''}" for="${id}"><span>${esc(f.label)}</span>
    <div class="lk" data-lk="customer"><input type="hidden" name="${f.name}" value="${esc(val)}">
    <input id="${id}" type="text" class="lk-q" placeholder="Type a name, phone, address or email" ${f.disabled ? 'disabled' : ''}></div></label>`;
}
function initCustomerPicker(box) {
  const hidden = $('input[type=hidden]', box), q = $('.lk-q', box);
  const set = (id, text) => { hidden.value = id; q.value = text; q.dataset.picked = id ? '1' : ''; hidden.dispatchEvent(new Event('change')); };
  if (hidden.value) GET('/customers/' + hidden.value).then(c => { q.value = custLabel(c); q.dataset.picked = '1'; }).catch(() => {});
  q.addEventListener('input', () => { if (hidden.value) { hidden.value = ''; q.dataset.picked = ''; hidden.dispatchEvent(new Event('change')); } });
  suggestBox(q, {
    search: async text => {
      const r = await GET('/customers' + qs({ q: text, limit: 12 }));
      return { items: r, note: r.total > r.length ? `${r.total - r.length} more — keep typing to narrow it down` : '', empty: 'No customer matches. Check the spelling, or add them under Customers.' };
    },
    render: c => `<b>${esc(custLabel(c))}</b><div class="small muted">${esc([c.primary_address, c.phone, c.email].filter(Boolean).join(' · '))}</div>`,
    pick: c => set(c.id, custLabel(c)),
  });
}

// ------------------------------------------------------------ address lookup
// f.fill maps parts to sibling field names, e.g. { city: 'loc_city', state: 'loc_state', zip: 'loc_zip', lat: 'loc_lat', lng: 'loc_lng', verified: 'loc_verified_at' }
function addressFieldHtml(f, val) {
  const id = 'f_' + f.name;
  setTimeout(initLookups);
  return `<label class="f ${f.full ? 'full' : ''}" for="${id}"><span>${esc(f.label)} <span class="lk-status" data-for="${f.name}"></span></span>
    <div class="lk" data-lk="address" data-fill='${esc(JSON.stringify(f.fill || {}))}'>
      <div class="row" style="gap:6px;flex-wrap:nowrap"><input id="${id}" type="text" name="${f.name}" class="lk-q" value="${esc(val)}" ${f.required ? 'required' : ''}
        placeholder="Start typing the street address"><a class="btn sm lk-map" target="_blank" rel="noopener" title="Open in Google Maps to check it">Map ↗</a></div>
    </div></label>`;
}
const mapsUrl = text => 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(text);
function initAddressField(box) {
  const form = box.closest('form'); const q = $('.lk-q', box); const fill = JSON.parse(box.dataset.fill || '{}');
  const el = k => fill[k] && form && form.elements[fill[k]];
  const status = form && $(`.lk-status[data-for="${q.name}"]`, form);
  const full = () => [q.value, el('city')?.value, el('state')?.value, el('zip')?.value].filter(Boolean).join(', ');
  const mapLink = $('.lk-map', box);
  const refresh = () => {
    mapLink.href = mapsUrl(full() || 'United States');
    const v = el('verified')?.value;
    if (status) status.innerHTML = v ? '<span class="pill good">✓ Verified</span>' : q.value.trim() ? '<span class="pill warn" title="Pick a suggestion, or open the map to check it">Not verified</span>' : '';
  };
  const unverify = () => { for (const k of ['lat', 'lng', 'verified']) if (el(k)) el(k).value = ''; refresh(); };
  q.addEventListener('input', unverify);
  for (const k of ['city', 'state', 'zip']) el(k)?.addEventListener('input', unverify);
  let session = '';
  q.addEventListener('focus', () => { if (!session) session = crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2); });
  suggestBox(q, {
    minChars: 4, delay: 350,
    search: async text => {
      const r = await GET('/address/suggest' + qs({ q: [text, el('city')?.value && !/,/.test(text) ? el('city').value : '', el('state')?.value && !/,/.test(text) ? el('state').value : ''].filter(Boolean).join(', '), session }));
      return { items: r.results, empty: r.provider === 'census' ? 'No exact match yet. Type the full street address with house number (and city), or check it on the map.' : 'No matching address found',
        note: r.provider === 'census' ? 'Free US Census lookup. Add a Google Maps key in Settings for type-ahead suggestions.' : '' };
    },
    render: a => `<b>${esc(a.main || a.text)}</b>${a.secondary ? `<div class="small muted">${esc(a.secondary)}</div>` : ''}`,
    pick: async a => {
      try {
        const d = a.address ? a : await GET('/address/details' + qs({ id: a.id, session }));
        session = '';
        q.value = d.address;
        for (const k of ['city', 'state', 'zip', 'lat', 'lng']) if (el(k) && d[k] != null) el(k).value = d[k];
        if (el('verified')) el('verified').value = new Date().toISOString();
        q.dataset.picked = '1'; refresh();
        q.dispatchEvent(new Event('change'));
      } catch (e) { toast(e.message, true); }
    },
  });
  refresh();
}
function initLookups() {
  for (const box of $$('.lk:not([data-ready])')) {
    box.dataset.ready = '1';
    if (box.dataset.lk === 'customer') initCustomerPicker(box); else initAddressField(box);
  }
}
