'use strict';
// Sales pipeline (Salesforce-style): a board of every deal from lead to paid, with probability-weighted forecast,
// owner, next step and close date; and a "path" bar at the top of each customer, estimate and job.
/* global S, $, $$, esc, GET, PUT, POST, toast, go, route, setTop, qs, hashParams, money0, fmtDate, formModal, label, isOffice, kpi, ROUTES */

const PIPE_KIND = { lead: 'Lead', estimate: 'Estimate', job: 'Job', invoice: 'Invoice' };
const ownerOptions = () => S.users.filter(u => u.active && u.role !== 'tech').map(u => [u.id, u.name]);

async function viewPipeline() {
  const { params } = hashParams();
  const f = { owner_id: params.get('owner_id') || '', type: params.get('type') || '', q: params.get('q') || '', lost: params.get('lost') || '' };
  const d = await GET('/pipeline' + qs(f));
  const T = d.totals;
  const keep = o => '#/pipeline' + qs({ ...f, ...o });
  $('#view').innerHTML = setTop('Pipeline', `<button class="btn primary" id="newlead">+ Lead</button><a class="btn" href="#/estimates/new">+ Estimate</a>`,
    'Every deal from lead to paid — each customer, estimate, job and invoice shows once, where it is now') + `
    <div class="grid g4">
      ${kpi('Open pipeline', money0(T.open), `${money0(T.weighted)} weighted by stage probability`)}
      ${kpi('Booked (won, not billed)', money0(T.booked), 'won → in progress → to invoice')}
      ${kpi('Awaiting payment', money0(T.billed), 'sent invoices, unpaid balance')}
      ${kpi('Win rate (90 days)', T.win_rate == null ? '—' : T.win_rate + '%', `${T.decided} estimate(s) decided${T.overdue_steps ? ` · <span class="bad">${T.overdue_steps} next step(s) overdue</span>` : ''}`)}
    </div>
    <div class="pipe-path" role="list">${d.stages.map(s => `<a role="listitem" href="#pipe-${s.key}" class="pp pp-${s.key}"><b>${esc(s.label)}</b><span>${s.count} · ${money0(s.amount)}</span></a>`).join('')}</div>
    <form id="pf" class="row no-print" style="gap:8px;flex-wrap:wrap;margin:10px 0">
      <input name="q" placeholder="Search customer, title, number" value="${esc(f.q)}" style="width:240px">
      <select name="owner_id" style="width:auto"><option value="">All owners</option><option value="none" ${f.owner_id === 'none' ? 'selected' : ''}>No owner</option>${ownerOptions().map(([v, l]) => `<option value="${v}" ${String(v) === f.owner_id ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>
      <select name="type" style="width:auto"><option value="">Residential & commercial</option><option value="residential" ${f.type === 'residential' ? 'selected' : ''}>Residential</option><option value="commercial" ${f.type === 'commercial' ? 'selected' : ''}>Commercial</option></select>
      <label class="small"><input type="checkbox" name="lost" value="1" ${f.lost ? 'checked' : ''}> Show lost</label>
      <button class="btn">Apply</button></form>
    <div class="pipe-board">${d.stages.map(s => {
      const list = d.cards.filter(c => c.stage === s.key).sort((a, b) => (b.overdue - a.overdue) || (b.amount - a.amount));
      return `<section class="pipe-col" id="pipe-${s.key}"><header><b>${esc(s.label)}</b><span class="small muted">${s.count} · ${money0(s.amount)}${s.group === 'open' ? ` · ${s.prob}%` : ''}</span></header>
        ${list.map(c => `<article class="pcard ${c.overdue ? 'late' : ''}" data-card="${c.kind}:${c.id}" tabindex="0">
          <div class="row spread"><b>${esc(c.customer_name)}</b><span>${money0(c.amount)}</span></div>
          <div class="small">${c.number ? `<span class="muted">${esc(PIPE_KIND[c.kind])} ${esc(c.number)}</span> ` : `<span class="muted">${esc(label(c.lead_status || 'new'))} lead</span> `}${esc(c.title || '')}</div>
          ${c.next_step ? `<div class="small ${c.overdue ? 'bad' : ''}">→ ${esc(c.next_step)}${c.next_step_date ? ` · ${fmtDate(c.next_step_date)}` : ''}</div>` : ['lead', 'estimating', 'proposal', 'won'].includes(c.stage) ? '<div class="small muted">No next step</div>' : ''}
          ${c.flag ? `<div class="small warn">${esc(c.flag)}</div>` : ''}${c.lost_reason ? `<div class="small muted">Lost: ${esc(c.lost_reason)}</div>` : ''}
          <div class="row spread small muted"><span>${c.owner_name ? esc(c.owner_name) : 'No owner'}</span><span>${c.age_days != null ? `${c.age_days}d in stage` : ''}</span></div>
        </article>`).join('') || '<div class="small muted" style="padding:8px">Nothing here</div>'}</section>`;
    }).join('')}</div>`;
  $('#pf').onsubmit = e => { e.preventDefault(); const v = Object.fromEntries(new FormData(e.target)); go(keep({ q: v.q, owner_id: v.owner_id, type: v.type, lost: v.lost ? '1' : '' })); };
  $('#newlead').onclick = () => leadForm();
  const byKey = Object.fromEntries(d.cards.map(c => [`${c.kind}:${c.id}`, c]));
  $$('[data-card]').forEach(el => { const open = () => dealPanel(byKey[el.dataset.card]); el.onclick = open; el.onkeydown = e => { if (e.key === 'Enter') open(); }; });
}

function leadForm() {
  formModal({ title: 'New lead', okLabel: 'Add lead', values: { type: 'residential', owner_id: S.user.id },
    fields: [{ name: 'name', label: 'Contact name', required: true }, { name: 'company', label: 'Company (commercial)' }, { name: 'phone', label: 'Phone', type: 'tel' }, { name: 'email', label: 'Email', type: 'email' },
      { name: 'type', label: 'Type', type: 'select', blank: false, options: [['residential', 'Residential'], ['commercial', 'Commercial']] }, { name: 'lead_source', label: 'Lead source', placeholder: 'Google, referral, GC bid list…' },
      { name: 'est_value', label: 'Rough value $', type: 'number' }, { name: 'owner_id', label: 'Owner', type: 'select', options: ownerOptions() },
      { name: 'next_step', label: 'Next step', full: true, placeholder: 'e.g. Call back to book a walkthrough' }, { name: 'next_step_date', label: 'Next step date', type: 'date' },
      { name: 'notes', label: 'What they need', type: 'textarea', full: true }],
    submit: async v => { const r = await POST('/customers', { ...v, lead_status: 'new' }); toast('Lead added'); go('#/customers/' + r.id); } });
}

// the deal's quick view: owner, next step, close date, and the action that moves it on
function dealPanel(c) {
  if (!c) return;
  const kindTable = { lead: 'lead', estimate: 'estimate', job: 'job' }[c.kind];
  const fields = kindTable ? [{ name: 'owner_id', label: 'Owner', type: 'select', options: ownerOptions() },
    { name: 'next_step', label: 'Next step', full: true, placeholder: 'e.g. Follow up on the proposal' }, { name: 'next_step_date', label: 'Next step date', type: 'date' },
    ...(c.kind === 'estimate' ? [{ name: 'close_date', label: 'Expected decision date', type: 'date' }] : []),
    ...(c.kind === 'lead' ? [{ name: 'lead_status', label: 'Lead status', type: 'select', blank: false, options: [['new', 'New'], ['contacted', 'Contacted'], ['qualified', 'Qualified']] }, { name: 'est_value', label: 'Rough value $', type: 'number' }] : [])] : [];
  const acts = {
    lead: `<a class="btn primary" href="#/estimates/new?customer_id=${c.id}">+ Estimate</a><button type="button" class="btn danger" id="dp-lost">Unqualified…</button>`,
    estimating: `<a class="btn primary" href="${c.href}">Finish the estimate</a><button type="button" class="btn danger" id="dp-lost">Lost…</button>`,
    proposal: `<a class="btn go" href="${c.href}">Won → mark approved</a><button type="button" class="btn danger" id="dp-lost">Lost…</button>`,
    won: c.kind === 'estimate' ? `<a class="btn primary" href="${c.href}">Convert to job</a>` : `<a class="btn primary" href="${c.href}">Schedule it</a>`,
    in_progress: `<a class="btn" href="${c.href}">Open job</a>`, to_invoice: `<a class="btn primary" href="#/jobs/${c.id}?tab=billing">Bill job</a>`,
    invoiced: `<a class="btn primary" href="${c.href}">Open invoice</a>`, paid: `<a class="btn" href="${c.href}">Open invoice</a>`, lost: `<a class="btn" href="${c.href}">Open</a>`,
  }[c.stage] || '';
  const m = formModal({ title: `${c.customer_name} — ${money0(c.amount)}`, okLabel: 'Save', values: { ...c, lead_status: c.lead_status || 'new' }, fields,
    extra: `<div class="small" style="margin:6px 0">${esc(PIPE_KIND[c.kind])} ${esc(c.number || '')} ${esc(c.title || '')} · <b>${esc(label(c.stage))}</b>${c.age_days != null ? ` for ${c.age_days} day(s)` : ''}${c.close_date ? ` · ${c.kind === 'invoice' ? 'due' : 'close'} ${fmtDate(c.close_date)}` : ''}${c.flag ? ` · <span class="warn">${esc(c.flag)}</span>` : ''}</div>
      <div class="row" style="gap:6px;flex-wrap:wrap;margin:8px 0">${acts}<a class="btn" href="${c.href}">Open ${esc(PIPE_KIND[c.kind].toLowerCase())}</a></div>`,
    submit: async v => { if (!kindTable) return; await PUT(`/pipeline/${kindTable}/${c.id}`, v); toast('Saved'); route(); } });
  if (!kindTable) { const ok = $('button.primary[type=submit], .actions button.primary', m.el); if (ok) ok.style.display = 'none'; }
  $$('a.btn', m.el).forEach(a => a.addEventListener('click', () => m.close()));
  const lost = $('#dp-lost', m.el);
  if (lost) lost.onclick = () => { m.close(); formModal({ title: c.kind === 'lead' ? 'Lead unqualified' : `Lost: ${c.number}`, okLabel: 'Mark lost',
    fields: [{ name: 'lost_reason', label: 'Why?', required: true, full: true, list: 'lostreasons', placeholder: 'Price, went with another contractor, project cancelled, no response…' }],
    extra: '<datalist id="lostreasons"><option value="Price too high"><option value="Went with another contractor"><option value="Project cancelled or postponed"><option value="No response"><option value="Not a fit for us"></datalist>',
    submit: async v => {
      if (c.kind === 'lead') await PUT(`/pipeline/lead/${c.id}`, { lead_status: 'unqualified', lost_reason: v.lost_reason });
      else { await PUT(`/estimates/${c.id}`, { status: 'declined' }); await PUT(`/pipeline/estimate/${c.id}`, { lost_reason: v.lost_reason }); }
      toast('Marked lost'); route();
    } }); };
}

// the Salesforce "path": where this record is, at the top of its page
async function pipelinePath(kind, id) {
  if (!isOffice()) return;
  let r; try { r = await GET('/pipeline/path' + qs({ kind, id })); } catch { return; }
  if (!r.card) return;
  const top = $('#view .topbar'); if (!top || $('#view .rec-path')) return;
  const order = r.stages.map(s => s.key).filter(k => k !== 'lost'), at = order.indexOf(r.card.stage), lost = r.card.stage === 'lost';
  top.insertAdjacentHTML('afterend', `<div class="rec-path no-print" title="Pipeline stage">${order.map((k, i) => `<span class="${lost ? '' : i < at ? 'done' : i === at ? 'now' : ''}">${esc(r.stages.find(s => s.key === k).label)}</span>`).join('')}
    ${lost ? `<span class="now lost">Lost${r.card.lost_reason ? `: ${esc(r.card.lost_reason)}` : ''}</span>` : ''}
    <a class="small" href="#/pipeline">Pipeline ›</a>${r.card.next_step ? `<span class="small ${r.card.overdue ? 'bad' : 'muted'} nstep">Next: ${esc(r.card.next_step)}${r.card.next_step_date ? ` · ${fmtDate(r.card.next_step_date)}` : ''}</span>` : ''}</div>`);
}

ROUTES.unshift([/^\/pipeline$/, () => viewPipeline()]);
