# LabMark — lab attendance with GPS + selfie

A SAFE-style attendance web app for labs. Students open a link on their phone, sign in with Google,
and tap **Check in** when they arrive and **Check out** when they leave. Each tap needs:

1. **GPS inside the lab's geofence** (default 50 m), checked on the phone *and* again by the server rules.
2. **A live selfie** from the front camera (no gallery uploads), stamped with date, time and lab name.

Lab managers get four tabs: **Today** (who is in the lab right now, with photos), **Records** (every
check-in with times, distance from the lab, GPS accuracy and both selfies), **Students** (attendance %
per student, flagged below your threshold) and **Settings** (labs, rules, managers). Both the session
log and the attendance summary export to CSV, which opens directly in Excel.

Everything runs on Firebase's free Spark plan: Google sign-in, Firestore, and Firebase Hosting.

---

## Setup (about 20 minutes)

### 1. Create the Firebase project
1. Go to <https://console.firebase.google.com> → **Add project** (Google Analytics not needed).
2. **Build → Authentication → Get started → Sign-in method → Google → Enable.**
3. **Build → Firestore Database → Create database** → location **asia-south1 (Mumbai)** → *production mode*.
4. **Project settings (gear) → Your apps → Web (`</>`)** → register an app → copy the `firebaseConfig`
   object into `public/js/firebase-config.js`. You can also change `APP_NAME` and `ORG_NAME` there.

### 2. Deploy
```bash
npm install -g firebase-tools
firebase login
cd lab-attendance
firebase use --add            # pick your project
firebase deploy               # uploads the security rules and the website
```
Your app is now live at `https://<project-id>.web.app`.

> **Prefer GitHub Pages?** Push the `public/` folder to a repo and enable Pages. Then add
> `<your-user>.github.io` under **Authentication → Settings → Authorized domains**. You still need
> `firebase deploy --only firestore:rules` once, because the rules are what keep the data safe.
> GPS and camera only work over HTTPS; both Firebase Hosting and GitHub Pages provide it.

### 3. Make yourself the first lab manager
In the Firebase console: **Firestore → Start collection** → ID `admins` → Document ID = **your Google
email, exactly, in lowercase** (e.g. `chaitanya@iitb.ac.in`) → add any field (e.g. `role` = `manager`) → Save.
After this, add other managers from the app's **Settings** tab.

### 4. Mark the lab
Open the app on your phone, go to **Settings → Add lab**, stand in the middle of the lab and tap
**Use my location**. Start with a 50 m radius, then try a check-in yourself from a corner of the room.
Indoor GPS drifts 10–40 m; widen the radius if genuine students are getting rejected.

In **Attendance rules** you can also set:
| Setting | What it does |
|---|---|
| Allowed email domain | e.g. `iitb.ac.in` — blocks personal Gmail accounts (enforced by the server too) |
| Worst GPS accuracy accepted | Rejects fuzzy fixes (default ±100 m) |
| Hours needed for a day to count | 0 = any check-in counts; e.g. 4 = only days with ≥ 4 h in the lab |
| Lab days are | *Days anyone checked in* (good for irregular labs) or *every Mon–Fri* (good for daily research-lab attendance) |
| Flag students below | Highlights low attendance in the Students tab (default 75 %) |

### 5. Share the link
Send students the URL. On first sign-in they enter their name and roll number once (only a manager can
change the roll number later). Tip: ask them to use **Add to Home screen** so it opens like an app.

---

## How attendance % is calculated
`Attendance % = days present ÷ lab days` in the date range you pick.
A day is *present* when the student checked in that day (and, if set, spent the minimum hours).
A check-in without a check-out still counts the day, but adds 0 hours and shows under *Missed check-outs*.

## What stops proxy attendance
- Server-side checks: the rules reject a check-in whose GPS point is outside the lab radius, whose
  timestamp is not the server's own clock, whose date is not today (IST), or whose roll number does not
  match the signed-in student. Students cannot read anyone else's records or edit past ones.
- Live selfie with a burned-in timestamp, reviewable by managers next to each check-in and check-out.
- Each record stores GPS accuracy, distance from the lab and the device type.

**Honest limit:** a determined student with a rooted/developer-mode Android phone can fake GPS with a
mock-location app. The selfie is the backstop, so spot-check the *Today* tab occasionally. SAFE closes
this gap with Bluetooth beacons; a browser app cannot scan Bluetooth on iPhones.

## Free-tier capacity
Spark plan: 1 GiB Firestore storage, 50 k reads and 20 k writes per day. Each selfie is about 25–40 KB,
so 60 students checking in and out daily for a full year uses roughly 1 GiB. Export the CSV each semester
and delete old records (or upgrade to the pay-as-you-go plan, which costs very little at this size).

## Testing the security rules (optional)
Needs Java 11+.
```bash
cd tests && npm install && npm test
```
It runs 27 checks against the local Firestore emulator: far-away check-ins, backdated times, someone
else's roll number, reading other students' photos, self-promotion to manager, and so on.

## Files
```
public/index.html          page shell
public/js/app.js           the whole app (student + manager views)
public/js/firebase-config.js   ← paste your Firebase config here
public/css/styles.css      styles (light + dark)
firestore.rules            server-side security rules
firebase.json              hosting + rules deploy config
tests/                     rules test suite
```
