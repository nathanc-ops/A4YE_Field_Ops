'use strict';
// Phone notifications ("you're on a new job", "your visit moved") — the device side.
//  - In the App Store / Google Play app: the native push plugin (Apple / Firebase).
//  - In a browser or the home-screen app: Web Push through the service worker (sw.js).
// Permission can only be asked from a tap, so nothing here asks on its own; it offers a button.

const nativePush = () => (window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform()
  && window.Capacitor.Plugins && window.Capacitor.Plugins.PushNotifications) || null;
const isIOS = () => /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

// what this device can do: 'native' | 'web' | 'ios-install' (iPhone in Safari: must be added to the Home Screen first) | 'none'
function pushMode() {
  if (nativePush()) return 'native';
  if ('serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window && window.isSecureContext) return 'web';
  if (isIOS() && !isStandalone()) return 'ios-install';
  return 'none';
}
const b64ToBytes = s => { const p = '='.repeat((4 - s.length % 4) % 4), b = atob((s + p).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from(b, c => c.charCodeAt(0)); };
const devicePlatform = () => nativePush() ? window.Capacitor.getPlatform() : isIOS() ? 'ios-web' : /Android/.test(navigator.userAgent) ? 'android-web' : 'desktop-web';

// the permissions API first (some browsers report Notification.permission oddly until asked), then the classic property
async function notifPerm() {
  try { const q = await navigator.permissions.query({ name: 'notifications' }); return q.state === 'prompt' ? 'default' : q.state; } catch { return Notification.permission; }
}
async function webSubscription() {
  if (!('serviceWorker' in navigator)) return null;
  const reg = await navigator.serviceWorker.getRegistration('/'); if (!reg) return null;
  return reg.pushManager.getSubscription();
}
// is this device signed up? ('on' | 'off' | 'blocked')
async function pushState() {
  const m = pushMode();
  if (m === 'native') { const p = await nativePush().checkPermissions(); return p.receive === 'granted' ? (localStorage.getItem('fo_push_native') ? 'on' : 'off') : p.receive === 'denied' ? 'blocked' : 'off'; }
  if (m !== 'web') return 'off';
  const perm = await notifPerm();
  if (perm === 'denied') return 'blocked';
  return perm === 'granted' && await webSubscription() ? 'on' : 'off';
}

let nativeWired = false;
function wireNative() {
  const P = nativePush(); if (!P || nativeWired) return; nativeWired = true;
  P.addListener('registration', async t => {
    try { await POST('/push/devices', { kind: window.Capacitor.getPlatform() === 'ios' ? 'apns' : 'fcm', token: t.value, platform: window.Capacitor.getPlatform() }); localStorage.setItem('fo_push_native', '1'); }
    catch (e) { toast('Couldn\'t save this phone for notifications: ' + e.message, true); }
  });
  P.addListener('registrationError', e => toast('Notifications couldn\'t be set up: ' + (e.error || 'unknown'), true));
  // tapped a notification: open what it is about
  P.addListener('pushNotificationActionPerformed', a => { const u = (a.notification && a.notification.data && a.notification.data.url) || ''; if (u.startsWith('#/')) location.hash = u.slice(1); });
  // arrived while the app is open: show it in the app
  P.addListener('pushNotificationReceived', n => { toast(`🔔 ${n.title || ''}${n.body ? ' — ' + n.body : ''}`); if (typeof route === 'function' && /^#\/(my-day|schedule|dashboard)?$/.test(location.hash || '#/')) route(); });
}

async function enablePush() {
  const m = pushMode();
  if (m === 'ios-install') throw new Error('On iPhone, add Field Ops to your Home Screen first (Share → Add to Home Screen), open it from there, then turn notifications on.');
  if (m === 'none') throw new Error('This browser can\'t receive notifications.');
  if (m === 'native') {
    wireNative();
    const p = await nativePush().requestPermissions();
    if (p.receive !== 'granted') throw new Error('Notifications are turned off for Field Ops in this phone\'s Settings.');
    await nativePush().register();   // the token arrives in the 'registration' listener
    return;
  }
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error(perm === 'denied' ? 'Notifications are blocked for this site. Allow them in the browser\'s site settings, then try again.' : 'Notifications weren\'t allowed.');
  const cfg = await GET('/push/config');
  const reg = await navigator.serviceWorker.register('/sw.js');
  await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  // a subscription made with an older server key can't be used: start over
  if (sub && sub.options && sub.options.applicationServerKey) {
    const k = btoa(String.fromCharCode(...new Uint8Array(sub.options.applicationServerKey))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    if (k !== cfg.web_key) { await sub.unsubscribe(); sub = null; }
  }
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(cfg.web_key) });
  await POST('/push/devices', { kind: 'web', subscription: sub.toJSON(), platform: devicePlatform() });
}
async function disablePush() {
  if (pushMode() === 'native') {
    localStorage.removeItem('fo_push_native');
    const cfg = await GET('/push/config');
    for (const d of cfg.devices.filter(d => d.kind !== 'web')) await api('DELETE', '/push/devices', { id: d.id }).catch(() => null);
    await nativePush().unregister().catch(() => null);
    return;
  }
  const sub = await webSubscription();
  if (sub) { await api('DELETE', '/push/devices', { subscription: { endpoint: sub.endpoint } }).catch(() => null); await sub.unsubscribe(); }
}
// on sign-in: keep this device tied to whoever is signed in now, and refresh a token the phone may have rotated
async function refreshPush() {
  try {
    const m = pushMode();
    if (m === 'native') { wireNative(); const p = await nativePush().checkPermissions(); if (p.receive === 'granted' && localStorage.getItem('fo_push_native')) await nativePush().register(); return; }
    if (m === 'web' && await notifPerm() === 'granted') {
      const sub = await webSubscription();
      if (sub) await POST('/push/devices', { kind: 'web', subscription: sub.toJSON(), platform: devicePlatform() });
    }
  } catch { /* best effort */ }
}

// "Notifications on this phone" — Settings, for everyone
async function pushCard(el) {
  const m = pushMode(), st = await pushState().catch(() => 'off');
  const line = { on: '<b style="color:var(--good)">On</b> — you get a notice when you\'re put on a job or a visit changes.',
    off: 'Off on this device.', blocked: '<b style="color:var(--bad)">Blocked</b> in this phone or browser\'s settings for Field Ops. Allow notifications there, then come back.' }[st];
  el.innerHTML = m === 'ios-install' ? '<p class="small">On iPhone, notifications work in the Home Screen app: in Safari tap <b>Share → Add to Home Screen</b>, open Field Ops from the new icon, and turn them on here.</p>'
    : m === 'none' ? '<p class="small muted">This browser can\'t receive notifications.</p>'
      : `<p class="small">${line}</p><div class="row" style="gap:8px;flex-wrap:wrap">
        ${st === 'on' ? '<button class="btn" id="pushtest">Send me a test</button><button class="btn" id="pushoff">Turn off</button>' : st === 'off' ? '<button class="btn primary" id="pushon">🔔 Turn on notifications</button>' : ''}</div>`;
  const on = $('#pushon', el), off = $('#pushoff', el), t = $('#pushtest', el);
  if (on) on.onclick = async () => { on.disabled = true; try { await enablePush(); toast('Notifications are on for this device'); } catch (e) { toast(e.message, true); } setTimeout(() => pushCard(el), 800); };
  if (off) off.onclick = async () => { await disablePush().catch(e => toast(e.message, true)); toast('Notifications turned off on this device'); pushCard(el); };
  if (t) t.onclick = async () => { try { const r = await POST('/push/test'); toast(r.sent ? `Test sent to ${r.sent} device${r.sent > 1 ? 's' : ''}` : `Not delivered: ${r.errors.join('; ')}`, !r.sent); } catch (e) { toast(e.message, true); } };
}
// techs' My Day: one nudge until they turn it on (or say not now)
async function pushNag(el) {
  if (!el) return;
  try { if (localStorage.getItem('fo_push_nag') === 'no') return; } catch { /* private mode */ }
  const m = pushMode(); if (m === 'none') return;
  if (m !== 'ios-install' && await pushState().catch(() => 'off') !== 'off') return;
  el.innerHTML = `<div class="alert info" style="margin-bottom:12px"><b>🔔 Get a notice when you're put on a job</b> or a visit's time changes.
    ${m === 'ios-install' ? '<br><span class="small">On iPhone: Share → <b>Add to Home Screen</b>, open Field Ops from the icon, then turn notifications on in Settings.</span>' : ''}
    <div class="row" style="gap:8px;margin-top:8px">${m === 'ios-install' ? '' : '<button class="btn primary sm" id="nagon">Turn on</button>'}<button class="btn sm" id="nagno">Not now</button></div></div>`;
  if ($('#nagon', el)) $('#nagon', el).onclick = async () => { try { await enablePush(); toast('Notifications are on'); el.innerHTML = ''; } catch (e) { toast(e.message, true); } };
  $('#nagno', el).onclick = () => { try { localStorage.setItem('fo_push_nag', 'no'); } catch { /* private mode */ } el.innerHTML = ''; toast('You can turn them on any time from 🔔 Notifications in the menu'); };
}

// Settings (admin): the store apps' push keys, who has notifications on, what was sent
async function pushAdmin(el) {
  const p = await GET('/push/admin');
  const ok = b => b ? '<span class="pill good">set up</span>' : '<span class="pill">not set up</span>';
  el.innerHTML = `<p class="small"><b>Browser & Home Screen app</b> <span class="pill good">ready</span> — nothing to set up.<br>
      <b>App Store iPhone app</b> ${ok(p.apns)} &nbsp; <b>Google Play Android app</b> ${ok(p.fcm)} — only needed once the store apps are published (see docs/MOBILE_APPS.md).</p>
    <details style="margin:8px 0"><summary class="small"><b>Apple (APNs) key</b></summary><form id="apnsf" class="form-grid" style="margin-top:8px">
      ${fieldHtml({ name: 'apns_key_p8', label: p.apns ? '.p8 key (saved — paste a new one to replace)' : 'Contents of the .p8 key file', type: 'textarea', full: true })}
      ${fieldHtml({ name: 'apns_key_id', label: 'Key ID' }, p.apns_key_id)}${fieldHtml({ name: 'apns_team_id', label: 'Team ID' }, p.apns_team_id)}
      ${fieldHtml({ name: 'apns_bundle_id', label: 'Bundle ID' }, p.apns_bundle_id)}
      ${fieldHtml({ name: 'apns_env', label: 'Builds', type: 'select', blank: false, options: [['production', 'App Store / TestFlight'], ['sandbox', 'Run from Xcode (development)']] }, p.apns_env)}
      <div class="full"><button class="btn primary sm">Save Apple key</button></div></form></details>
    <details style="margin:8px 0"><summary class="small"><b>Firebase (Android) service account</b>${p.fcm_project ? ` — project ${esc(p.fcm_project)}` : ''}</summary><form id="fcmf" class="form-grid" style="margin-top:8px">
      ${fieldHtml({ name: 'fcm_service_account', label: p.fcm ? 'Service-account JSON (saved — paste a new one to replace)' : 'Service-account JSON (Firebase → Project settings → Service accounts → Generate new private key)', type: 'textarea', full: true })}
      <div class="full"><button class="btn primary sm">Save Firebase key</button></div></form></details>
    <h3 style="margin-top:12px">Who has notifications on</h3>${table([{ label: 'Person', key: 'name' }, { label: 'Kind', get: d => ({ web: 'Browser / Home Screen', apns: 'iPhone app', fcm: 'Android app' }[d.kind]) },
      { label: 'Devices', key: 'n', num: true }, { label: 'Last delivered', get: d => d.last_ok ? fmtDT(d.last_ok) : '—' }], p.devices, { empty: 'Nobody yet — each person turns it on from their phone: 🔔 Notifications in the menu.' })}
    <h3 style="margin-top:12px">Recent notices</h3>${table([{ label: 'When', get: l => fmtDT(l.created_at) }, { label: 'To', key: 'name' }, { label: 'Notice', html: l => `${esc(l.title)}<div class="small muted">${esc(l.body || '')}</div>` },
      { label: 'Delivered', html: l => l.sent ? `${l.sent}/${l.devices}` : `<span style="color:var(--bad)">0/${l.devices}</span>${l.error ? `<div class="small" style="color:var(--bad)">${esc(l.error)}</div>` : ''}` }], p.log, { empty: 'Nothing sent yet' })}`;
  $('#apnsf', el).onsubmit = async e => { e.preventDefault(); const f = e.target;
    await act(() => PUT('/push/admin', { apns_key_p8: f.apns_key_p8.value, apns_key_id: f.apns_key_id.value, apns_team_id: f.apns_team_id.value, apns_bundle_id: f.apns_bundle_id.value, apns_env: f.apns_env.value }), 'Apple key saved').catch(() => null); pushAdmin(el); };
  $('#fcmf', el).onsubmit = async e => { e.preventDefault();
    await act(() => PUT('/push/admin', { fcm_service_account: e.target.fcm_service_account.value }), 'Firebase key saved').catch(() => null); pushAdmin(el); };
}

// 🔔 Notifications (menu, everyone): turn them on for this phone, test, and — for admins — the store-app set-up
async function viewNotifications() {
  $('#view').innerHTML = setTop('Notifications') + `<div class="grid g2"><div class="card"><h2>This phone or computer</h2><div id="pushme"><div class="muted small">Loading…</div></div>
      <p class="small muted" style="margin-top:12px">You get a notice when you're put on a job or visit, when its time changes, or when you're taken off it or it's cancelled.
      Turn it on on each phone you use. Changes you make yourself don't notify you.</p></div>
    ${isAdmin() ? '<div class="card"><h2>Push notifications (everyone)</h2><div id="pushadmin"><div class="muted small">Loading…</div></div></div>' : ''}</div>`;
  pushCard($('#pushme'));
  if ($('#pushadmin')) pushAdmin($('#pushadmin'));
}
