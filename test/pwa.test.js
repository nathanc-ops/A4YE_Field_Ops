'use strict';
// Installable app pieces: manifest, icons, service worker (never cached by the browser), privacy page; mobile shell config.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const D = require('../server/db');
const { createApp } = require('../server/app');

let server, base;
before(async () => {
  server = createApp(D.open(':memory:')).listen(0); await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

test('manifest, icons, service worker and privacy page are served', async () => {
  const m = await fetch(base + '/manifest.webmanifest');
  assert.equal(m.status, 200);
  const man = await m.json();
  assert.equal(man.display, 'standalone'); assert.equal(man.start_url, '/');
  for (const i of man.icons) assert.equal((await fetch(base + i.src)).status, 200, i.src);
  assert.ok(man.icons.some(i => i.purpose === 'maskable'));
  const sw = await fetch(base + '/sw.js');
  assert.equal(sw.status, 200); assert.equal(sw.headers.get('cache-control'), 'no-cache');
  const swText = await sw.text();
  for (const f of swText.match(/'\/[^']*'/g).map(s => s.slice(1, -1)).filter(f => /\.(js|css|png|webmanifest)$/.test(f)))
    assert.equal((await fetch(base + f)).status, 200, `shell file ${f} exists`);
  assert.match(swText, /\/api\//, 'API calls are left alone');
  const html = await (await fetch(base + '/')).text();
  assert.match(html, /rel="manifest"/); assert.match(html, /apple-touch-icon/); assert.match(html, /viewport-fit=cover/);
  assert.equal((await fetch(base + '/privacy.html')).status, 200);
});

test('mobile shell points at the live server over HTTPS, with the permission strings Apple requires', () => {
  const root = path.join(__dirname, '..', 'mobile');
  const cfg = JSON.parse(fs.readFileSync(path.join(root, 'capacitor.config.json'), 'utf8'));
  assert.match(cfg.server.url, /^https:\/\//); assert.equal(cfg.server.cleartext, false);
  assert.ok(fs.existsSync(path.join(root, 'www', cfg.server.errorPath)));
  const plist = fs.readFileSync(path.join(root, 'ios/App/App/Info.plist'), 'utf8');
  for (const k of ['NSCameraUsageDescription', 'NSPhotoLibraryUsageDescription', 'NSLocationWhenInUseUsageDescription']) assert.match(plist, new RegExp(`<key>${k}</key>`));
  const man = fs.readFileSync(path.join(root, 'android/app/src/main/AndroidManifest.xml'), 'utf8');
  for (const p of ['CAMERA', 'ACCESS_FINE_LOCATION']) assert.match(man, new RegExp(`android.permission.${p}`));
  assert.match(fs.readFileSync(path.join(root, 'android/app/build.gradle'), 'utf8'), /applicationId "com\.all4youelectrical\.fieldops"/);
});
