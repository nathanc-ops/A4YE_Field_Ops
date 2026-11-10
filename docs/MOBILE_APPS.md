# Phone apps (App Store and Google Play)

Field Ops reaches phones three ways. They all run the same app from **https://ops.all4youelectrical.com**, so every
server update reaches every phone at once, with no app update needed.

| Way | Cost | Time to set up | What the crew does |
|---|---|---|---|
| **1. Install from the browser** (works today) | $0 | none | Open the site, then *Add to Home Screen* (iPhone, Safari → Share) or *Install app* (Android, Chrome ⋮ menu). It opens full-screen with its own icon. |
| **2. Google Play** | $25 once | 1–3 days | Install from Play (a private or internal listing). |
| **3. Apple App Store** | $99 / year | 1–3 weeks, Mac needed | Install from the App Store (unlisted or private). |

**Start with 1.** It gives the crew an icon, full screen, the camera, GPS clock-in and offline start-up for free, today.
Go to the stores when you want a store install link, or when a phone management (MDM) setup needs one.

---

## Read this before paying Apple

- **Apple rejects apps that are "just a website."** App Review guideline 4.2 (minimum functionality) is the most common
  reason wrapped web apps are turned down. Field Ops has a real case: camera job photos, GPS on clock-in and clock-out,
  sign-in, and work data. But approval is not guaranteed on the first try. The usual fix if rejected is adding a native
  feature such as push notifications for new dispatches (not built yet).
- **This app is for employees, not the public.** Apple's intended route is **private distribution**:
  - *Unlisted app*: a normal App Store app that only people with the link can find. You request it from Apple after the first approval.
  - *Custom app* via **Apple Business Manager**: free, and pushes the app to company-owned phones.
  Both still go through App Review. Both need an **Organization** developer account, which needs a **D-U-N-S number** for
  All 4 You Electrical (free from Dun & Bradstreet, takes a few days to two weeks).
- **App Review needs a sign-in to test with.** You must give Apple a working username and password. They will see what that
  account sees **on the live server**. Create a **Tech** account named "App Review" with one made-up job on its schedule.
  A Tech sees only their own work, not customers' billing or other jobs. Turn it off after approval.
- **A Mac with Xcode is required to build the iPhone app.** Without a Mac, use a cloud Mac service (Codemagic, Ionic Appflow,
  or a GitHub Actions macOS runner). Apple has no other way.

## Google Play notes

- A **personal** Play developer account created recently must run a **closed test with at least 12 testers for 14 days**
  before it can publish to production. An **organization** account (D-U-N-S again) skips that.
- For a crew this size, the **Internal testing** track may be all you need. Add up to 100 people by email. It has no
  12-tester rule and no review wait. They install from a Play link like any app.
- Or publish as a **private app** through Managed Google Play, if you use Google Workspace or an MDM.

---

## What's in `mobile/`

| Path | What it is |
|---|---|
| `capacitor.config.json` | App ID `com.all4youelectrical.fieldops`, name **A4YE Field Ops**, and the server address. **Change `server.url` here if the address ever changes**, then rebuild. |
| `android/` | The Android Studio project, ready to open |
| `ios/` | The Xcode project, ready to open on a Mac. No CocoaPods; it uses Swift Package Manager. |
| `www/offline.html` | Shown when the phone can't reach the server (no signal, server down) |
| `assets/` | Icon and splash sources. Regenerate with `python3 mobile/make_icons.py`. |
| `store/play-icon-512.png` | The 512 × 512 icon Play Console asks for |
| `scripts/configure-native.js` | Adds the camera, photo and location permission text (Apple rejects without it) |

**About the icon:** the logo mark in `public/brand/a4y-mark.png` is only 250 px wide, so the 1024 px store icon is a
little soft. Put a sharper or vector version of the mark there, run `python3 mobile/make_icons.py`, then `cd mobile && npm run assets`.

## Build for Android (Windows or Mac)

1. Install **Node.js 22+** and **Android Studio**.
2. In the project folder:
   ```
   cd mobile
   npm install
   npm run native
   npm run open:android
   ```
3. In Android Studio: **Build → Generate Signed App Bundle / APK → Android App Bundle**. Create a new keystore when asked.
   - Store the keystore file and its passwords in your password manager and an off-site backup.
   - **Never put them in this repository; it is public.**
   - With *Play App Signing* (the default), a lost upload key can be reset through Google support, but it costs days.
4. In **Play Console**: create the app, then upload the `.aab` to **Internal testing**. Then fill in:
   - Privacy policy: `https://ops.all4youelectrical.com/privacy.html`
   - App access: the App Review sign-in
   - Data safety: data collected = name, email, phone, precise location (at clock-in only), photos, customer info; not shared for advertising; encrypted in transit
   - Content rating questionnaire (business app, no user-generated public content)
   - Target audience: 18+

For each new version, raise `versionCode` (and `versionName`) in `android/app/build.gradle`. Only needed when the
*native shell* changes. Changes to Field Ops itself reach the app through the server.

## Build for iPhone (Mac)

1. Install **Xcode** from the Mac App Store and **Node.js 22+**. Enroll in the **Apple Developer Program** as an organization.
2. In the project folder:
   ```
   cd mobile
   npm install
   npm run native
   npm run open:ios
   ```
3. In Xcode, select the **App** target → *Signing & Capabilities*. Choose your team; the bundle ID is `com.all4youelectrical.fieldops`.
4. Choose **Any iOS Device**, then **Product → Archive**, then **Distribute App → App Store Connect**.
5. In **App Store Connect**:
   - Create the app with the same bundle ID.
   - Add screenshots: 6.9" iPhone at minimum, plus iPad if you leave iPad support on.
   - Add the privacy policy URL, and fill in *App Privacy* (same data as above; nothing used for tracking).
   - Add the App Review sign-in and a note:
     > Field Ops is the internal work app for All 4 You Electrical's electricians. Accounts are issued by our office.
     > The demo account is a technician: it shows today's schedule, clock in/out (uses location), and job photos (uses the camera).
   - Ask for **Unlisted** distribution after approval, or set it up as a Custom App in Apple Business Manager.
6. For testing before review, use **TestFlight**. Builds expire after 90 days.

To ship a new native build, raise *Version* or *Build* in Xcode (General tab).

## Inside the native app (worth testing before submitting)

These work in the browser, but phone app web views handle them differently. Check each one on a real phone:

- **Job photos** (camera and library): should ask for permission the first time.
- **Clock in/out**: should ask for location permission the first time.
- **Customer view / print buttons** that open a new tab: these may open in the phone's browser instead.
- **CSV exports and "Download" buttons**: on iPhone these may do nothing inside the app. Use the browser for exports.
- **No signal**: the offline page should show, and *Try again* should reconnect.

## Removing the browser install later

Nothing to do. The browser install and the store apps can be used side by side; both talk to the same server.
