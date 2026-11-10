#!/usr/bin/env node
'use strict';
// After `cap add ios` / `cap add android`: add what Field Ops uses on the phone, so the app asks properly instead of
// failing silently (or being rejected by Apple for a missing purpose string).
//  - Camera: job photos ("Take photo" on a job)
//  - Photo library: picking existing photos for a job
//  - Location: the clock-in/clock-out stamp and "on my way"
// Safe to run again; it only adds what's missing.
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
let changed = 0;

// ---------- iOS: Info.plist purpose strings (Apple shows these in the permission prompt and checks them in review)
const plist = path.join(root, 'ios/App/App/Info.plist');
const IOS_KEYS = {
  NSCameraUsageDescription: 'Field Ops uses the camera to take job photos that are saved to the job.',
  NSPhotoLibraryUsageDescription: 'Field Ops lets you choose photos from your library to add to a job.',
  NSPhotoLibraryAddUsageDescription: 'Field Ops can save job photos to your library.',
  NSLocationWhenInUseUsageDescription: 'Field Ops records where you clock in and out on a job, while you are using the app.',
};
if (fs.existsSync(plist)) {
  let s = fs.readFileSync(plist, 'utf8');
  for (const [k, v] of Object.entries(IOS_KEYS)) {
    if (s.includes(`<key>${k}</key>`)) continue;
    s = s.replace(/<dict>/, `<dict>\n\t<key>${k}</key>\n\t<string>${v}</string>`); changed++;
  }
  // no encryption beyond HTTPS: answers App Store Connect's export-compliance question up front
  if (!s.includes('<key>ITSAppUsesNonExemptEncryption</key>')) { s = s.replace(/<dict>/, '<dict>\n\t<key>ITSAppUsesNonExemptEncryption</key>\n\t<false/>'); changed++; }
  fs.writeFileSync(plist, s);
  console.log(`iOS Info.plist: ${changed} added`);
} else console.log('iOS: no ios/ folder yet (run `npm run add:ios` on a Mac) — skipped');

// ---------- Android: permissions the web view needs for the camera and location
const manifest = path.join(root, 'android/app/src/main/AndroidManifest.xml');
const PERMS = ['android.permission.CAMERA', 'android.permission.ACCESS_COARSE_LOCATION', 'android.permission.ACCESS_FINE_LOCATION'];
if (fs.existsSync(manifest)) {
  let s = fs.readFileSync(manifest, 'utf8'), n = 0;
  for (const p of PERMS) {
    if (s.includes(`"${p}"`)) continue;
    s = s.replace(/(\s*)<\/manifest>/, `\n    <uses-permission android:name="${p}" />$1</manifest>`); n++;
  }
  // the camera is optional: phones without one can still install the app
  if (!s.includes('android.hardware.camera"')) { s = s.replace(/(\s*)<\/manifest>/, `\n    <uses-feature android:name="android.hardware.camera" android:required="false" />$1</manifest>`); n++; }
  fs.writeFileSync(manifest, s);
  console.log(`Android manifest: ${n} added`);
} else console.log('Android: no android/ folder yet (run `npm run add:android`) — skipped');
