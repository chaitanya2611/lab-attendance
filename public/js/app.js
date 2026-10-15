import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signInWithRedirect,
  onAuthStateChanged, signOut, createUserWithEmailAndPassword, signInWithEmailAndPassword,
  sendEmailVerification, sendPasswordResetEmail, updateProfile, reload,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore, doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc, addDoc,
  collection, query, where, writeBatch, serverTimestamp, onSnapshot, Timestamp,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { firebaseConfig, APP_NAME, ORG_NAME, INSTITUTE_DOMAIN } from "./firebase-config.js";

/* ------------------------------------------------------------------ *
 * Basics
 * ------------------------------------------------------------------ */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const app = $("#app");
const sheet = $("#sheet");
const TZ = "Asia/Kolkata";

const DEFAULT_SETTINGS = {
  allowedDomain: "",      // e.g. "iitb.ac.in" — blank allows any Google account
  maxAccuracy: 100,       // metres; GPS fixes worse than this are rejected
  minHours: 0,            // hours in lab needed for a day to count as present (0 = any check-in)
  labDayMode: "activity", // "activity" = days anyone checked in, "weekdays" = every Mon–Fri
  threshold: 75,          // % below which a student is flagged
};

const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const istDate = (d = new Date()) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
const fmtTime = (d) => d
  ? new Intl.DateTimeFormat("en-IN", { timeZone: TZ, hour: "numeric", minute: "2-digit", hour12: true }).format(d)
  : "—";
const fmtDay = (ymd) => {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Intl.DateTimeFormat("en-IN", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" })
    .format(new Date(Date.UTC(y, m - 1, d)));
};
const fmtDur = (ms) => {
  if (ms == null || ms < 0) return "—";
  const m = Math.round(ms / 60000);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
};
const toDate = (ts) => (ts && ts.toDate ? ts.toDate() : null);
const monthStart = () => istDate().slice(0, 8) + "01";

function toast(msg, kind = "ok") {
  const t = $("#toast");
  t.textContent = msg;
  t.dataset.kind = kind;
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.hidden = true), 4200);
}

/* ------------------------------------------------------------------ *
 * Geo — the same flat-earth distance the security rules use,
 * so the app and the server always agree at the fence edge.
 * ------------------------------------------------------------------ */
const M_PER_DEG_LAT = 110574;
const M_PER_DEG_LNG = 111320;
const cosLatOf = (lat) => Math.cos((lat * Math.PI) / 180);
function distanceM(lab, lat, lng) {
  const dy = (lat - lab.lat) * M_PER_DEG_LAT;
  const dx = (lng - lab.lng) * M_PER_DEG_LNG * (lab.cosLat ?? cosLatOf(lab.lat));
  return Math.sqrt(dx * dx + dy * dy);
}

function geoError(e) {
  if (e.code === 1) return "Location permission is off. Allow location for this site in your browser settings, then try again.";
  if (e.code === 3) return "Could not get a GPS fix in time. Step near a window or outside the door and try again.";
  return "Your phone could not find its location. Turn on Location / GPS and try again.";
}

// Watch GPS for a few seconds and keep the most accurate fix.
function getBestPosition({ goodEnough = 25, waitMs = 9000, hardTimeout = 25000 } = {}) {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error("This browser cannot share location. Open the link in Chrome or Safari."));
    let best = null;
    const finish = () => {
      navigator.geolocation.clearWatch(id);
      clearTimeout(t1); clearTimeout(t2);
      best ? resolve(best) : reject(new Error(geoError({ code: 3 })));
    };
    const id = navigator.geolocation.watchPosition(
      (p) => {
        if (!best || p.coords.accuracy < best.coords.accuracy) best = p;
        if (best.coords.accuracy <= goodEnough) finish();
      },
      (e) => { navigator.geolocation.clearWatch(id); clearTimeout(t1); clearTimeout(t2); best ? resolve(best) : reject(new Error(geoError(e))); },
      { enableHighAccuracy: true, maximumAge: 0, timeout: hardTimeout },
    );
    const t1 = setTimeout(() => { if (best) finish(); }, waitMs);
    const t2 = setTimeout(finish, hardTimeout);
  });
}

/* ------------------------------------------------------------------ *
 * Firebase
 * ------------------------------------------------------------------ */
const configured = !String(firebaseConfig.apiKey).includes("REPLACE");
let fb, auth, db;
if (configured) {
  fb = initializeApp(firebaseConfig);
  auth = getAuth(fb);
  db = getFirestore(fb);
}

const S = {
  user: null, profile: null, isAdmin: false,
  labs: [], settings: { ...DEFAULT_SETTINGS },
  unsub: [], tick: null,
  mySessions: [],
  tab: "live",
  photoCache: new Map(),
};

function cleanup() {
  S.unsub.forEach((u) => u());
  S.unsub = [];
  clearInterval(S.tick);
}

async function loadShared() {
  const [labsSnap, setSnap] = await Promise.all([
    getDocs(collection(db, "labs")),
    getDoc(doc(db, "config", "settings")),
  ]);
  S.labs = labsSnap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => a.name.localeCompare(b.name));
  S.settings = { ...DEFAULT_SETTINGS, ...(setSnap.exists() ? setSnap.data() : {}) };
}

async function getPhoto(id) {
  if (S.photoCache.has(id)) return S.photoCache.get(id);
  const p = getDoc(doc(db, "photos", id)).then((s) => (s.exists() ? s.data().img : null)).catch(() => null);
  S.photoCache.set(id, p);
  return p;
}

/* ------------------------------------------------------------------ *
 * Shell
 * ------------------------------------------------------------------ */
function header(extra = "") {
  return `
  <header class="bar">
    <div class="brand">
      <span class="mark" aria-hidden="true"></span>
      <div><strong>${esc(APP_NAME)}</strong><small>${esc(ORG_NAME)}</small></div>
    </div>
    <div class="bar-right">${extra}
      ${S.user ? `<button class="ghost sm" id="signout">Sign out</button>` : ""}
    </div>
  </header>`;
}
function bindHeader() {
  $("#signout")?.addEventListener("click", () => { cleanup(); signOut(auth); });
}

function renderSetupNeeded() {
  app.innerHTML = `${header()}
  <main class="wrap narrow">
    <section class="panel">
      <h1>Almost there</h1>
      <p>This copy of ${esc(APP_NAME)} is not connected to Firebase yet. Paste your web-app config into
      <code>public/js/firebase-config.js</code> and deploy again. The README walks through it.</p>
    </section>
  </main>`;
}

const instituteOk = (email) => !INSTITUTE_DOMAIN || email.toLowerCase().endsWith("@" + INSTITUTE_DOMAIN);

function authError(e) {
  const map = {
    "auth/invalid-credential": "Email or password is wrong. If you are new, choose “Create account”.",
    "auth/wrong-password": "Email or password is wrong.",
    "auth/user-not-found": "No account with this email yet. Choose “Create account”.",
    "auth/email-already-in-use": "An account with this email already exists. Sign in instead, or reset your password.",
    "auth/weak-password": "Use a password of at least 8 characters.",
    "auth/invalid-email": "That email address doesn't look right.",
    "auth/too-many-requests": "Too many attempts. Wait a few minutes and try again.",
    "auth/network-request-failed": "No internet connection. Check your network and try again.",
  };
  return map[e.code] || "Something went wrong (" + (e.code || e.message) + "). Try again.";
}

function renderSignIn(msg = "", mode = "signin") {
  const isNew = mode === "signup";
  const dom = INSTITUTE_DOMAIN ? "@" + INSTITUTE_DOMAIN : "";
  app.innerHTML = `${header()}
  <main class="wrap narrow signin">
    <section class="hero">
      <p class="eyebrow">Lab attendance</p>
      <h1>Check in when you arrive.<br>Check out when you leave.</h1>
      <p class="muted">Your phone's location confirms you are inside the lab, and a quick selfie confirms it is you.</p>
    </section>
    <section class="panel auth">
      <div class="seg" role="tablist">
        <button role="tab" id="m-in" aria-selected="${!isNew}">Sign in</button>
        <button role="tab" id="m-up" aria-selected="${isNew}">Create account</button>
      </div>
      <form id="ef" class="form" novalidate>
        <label for="ef-email">Institute email</label>
        <input id="ef-email" type="email" autocomplete="username" required placeholder="rollno${esc(dom)}" inputmode="email">
        <label for="ef-pass">Password</label>
        <input id="ef-pass" type="password" autocomplete="${isNew ? "new-password" : "current-password"}" required minlength="8" placeholder="${isNew ? "At least 8 characters" : ""}">
        ${isNew ? `<label for="ef-pass2">Confirm password</label>
        <input id="ef-pass2" type="password" autocomplete="new-password" required minlength="8">
        <p class="muted small">We'll email a verification link to your ${esc(dom || "institute")} inbox. Your account works after you click it.</p>` : ""}
        <button class="primary lg" type="submit">${isNew ? "Create account" : "Sign in"}</button>
        ${isNew ? "" : `<button type="button" class="link" id="forgot">Forgot password?</button>`}
        <p class="error" id="ef-err" ${msg ? "" : "hidden"}>${esc(msg)}</p>
        <p class="ok-text" id="ef-ok" hidden></p>
      </form>
      <div class="or"><span>or</span></div>
      <button class="ghost lg" id="google"><svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg> Continue with Google</button>
    </section>
  </main>`;
  $("#m-in").addEventListener("click", () => renderSignIn("", "signin"));
  $("#m-up").addEventListener("click", () => renderSignIn("", "signup"));
  const err = (t) => { const el = $("#ef-err"); el.textContent = t; el.hidden = !t; $("#ef-ok").hidden = true; };

  $("#ef").addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = $("#ef-email").value.trim().toLowerCase();
    const pass = $("#ef-pass").value;
    if (!email || !pass) return err("Enter your email and password.");
    if (!instituteOk(email)) return err(`Use your ${dom} email address.`);
    const btn = e.submitter || $("#ef button[type=submit]");
    btn.disabled = true;
    try {
      if (isNew) {
        if (pass.length < 8) { btn.disabled = false; return err("Use a password of at least 8 characters."); }
        if (pass !== $("#ef-pass2").value) { btn.disabled = false; return err("The two passwords don't match."); }
        const cred = await createUserWithEmailAndPassword(auth, email, pass);
        await sendEmailVerification(cred.user).catch(() => {});
      } else {
        await signInWithEmailAndPassword(auth, email, pass);
      }
    } catch (ex) { btn.disabled = false; err(authError(ex)); }
  });

  $("#forgot")?.addEventListener("click", async () => {
    const email = $("#ef-email").value.trim().toLowerCase();
    if (!email) return err("Type your email above first, then tap “Forgot password?”.");
    try {
      await sendPasswordResetEmail(auth, email);
      err(""); const ok = $("#ef-ok"); ok.hidden = false;
      ok.textContent = `If an account exists for ${email}, a reset link is on its way. Check spam too.`;
    } catch (ex) { err(authError(ex)); }
  });

  $("#google").addEventListener("click", async () => {
    const provider = new GoogleAuthProvider();
    provider.setCustomParameters({ prompt: "select_account" });
    try { await signInWithPopup(auth, provider); }
    catch (e) {
      if (e.code === "auth/popup-blocked" || e.code === "auth/operation-not-supported-in-this-environment") {
        await signInWithRedirect(auth, provider);
      } else if (e.code !== "auth/popup-closed-by-user" && e.code !== "auth/cancelled-popup-request") {
        err("Google sign-in failed: " + (e.message || e.code));
      }
    }
  });
}

function renderVerify(note = "") {
  app.innerHTML = `${header()}
  <main class="wrap narrow"><section class="panel">
    <p class="eyebrow">One more step</p>
    <h1>Verify your email</h1>
    <p>We sent a link to <strong>${esc(S.user.email)}</strong>. Open it, then come back and tap the button below.</p>
    <p class="muted small">Not there? Check spam or junk. The mail comes from noreply@${esc(firebaseConfig.authDomain)}.</p>
    <div class="row">
      <button class="primary" id="v-done">I've verified</button>
      <button class="ghost" id="v-resend">Resend link</button>
    </div>
    <p class="${note.startsWith("!") ? "error" : "ok-text"}" id="v-note" ${note ? "" : "hidden"}>${esc(note.replace(/^!/, ""))}</p>
  </section></main>`;
  bindHeader();
  $("#v-done").addEventListener("click", async () => {
    await reload(S.user);
    if (auth.currentUser.emailVerified) {
      await auth.currentUser.getIdToken(true); // refresh so the server sees the verified flag
      boot(auth.currentUser);
    } else renderVerify("!Not verified yet. Open the link in the email first.");
  });
  $("#v-resend").addEventListener("click", async () => {
    try { await sendEmailVerification(S.user); renderVerify("Sent a new link. Check your inbox and spam."); }
    catch (e) { renderVerify("!" + authError(e)); }
  });
}

function renderLoading(text = "Loading…") {
  app.innerHTML = `${header()}<main class="wrap narrow"><p class="muted center pad">${esc(text)}</p></main>`;
  bindHeader();
}

function renderWrongDomain(domain = S.settings.allowedDomain) {
  app.innerHTML = `${header()}
  <main class="wrap narrow"><section class="panel">
    <h1>Use your institute account</h1>
    <p>You signed in as <strong>${esc(S.user.email)}</strong>. This lab only accepts
    <strong>@${esc(domain)}</strong> accounts. Sign out, then sign in or create an account with your institute email.</p>
  </section></main>`;
  bindHeader();
}

/* ------------------------------------------------------------------ *
 * Student: first-time profile
 * ------------------------------------------------------------------ */
function renderOnboarding() {
  app.innerHTML = `${header()}
  <main class="wrap narrow">
    <section class="panel">
      <p class="eyebrow">One-time setup</p>
      <h1>Tell us who you are</h1>
      <p class="muted">Your roll number links every check-in to you. Only a lab manager can change it later.</p>
      <form id="pf" class="form">
        <label for="pf-name">Full name</label>
        <input id="pf-name" required maxlength="80" value="${esc(S.user.displayName || "")}" autocomplete="name">
        <label for="pf-roll">Roll number</label>
        <input id="pf-roll" required maxlength="20" placeholder="e.g. 24M1234" value="${esc(/^[a-z0-9]{4,20}$/i.test((S.user.email||"").split("@")[0]) ? S.user.email.split("@")[0].toUpperCase() : "")}" autocapitalize="characters" pattern="[A-Za-z0-9]{4,20}">
        <button class="primary lg" type="submit">Save and continue</button>
        <p class="error" id="pf-err" hidden></p>
      </form>
    </section>
  </main>`;
  bindHeader();
  $("#pf").addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = $("#pf-name").value.trim();
    const rollNo = $("#pf-roll").value.trim().toUpperCase();
    try {
      await setDoc(doc(db, "users", S.user.uid), {
        uid: S.user.uid, email: S.user.email, name, rollNo, createdAt: serverTimestamp(),
      });
      S.profile = { uid: S.user.uid, email: S.user.email, name, rollNo };
      startStudent();
    } catch (err) {
      const el = $("#pf-err"); el.hidden = false;
      el.textContent = "Could not save your profile. Check the roll number (letters and digits only) and try again.";
      console.error(err);
    }
  });
}

/* ------------------------------------------------------------------ *
 * Student home
 * ------------------------------------------------------------------ */
function startStudent() {
  cleanup();
  const q = query(collection(db, "sessions"), where("uid", "==", S.user.uid));
  S.unsub.push(onSnapshot(q, (snap) => {
    S.mySessions = snap.docs.map((d) => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (toDate(b.inAt)?.getTime() ?? Infinity) - (toDate(a.inAt)?.getTime() ?? Infinity));
    renderStudent();
  }, (err) => { console.error(err); toast("Could not load your attendance. Refresh the page.", "err"); }));
  S.tick = setInterval(() => { const el = $("#elapsed"); if (el) el.textContent = elapsedText(); }, 30000);
  renderStudent();
}

const openToday = () => S.mySessions.find((s) => s.status === "open" && s.date === istDate());
// A check-out forgotten on an earlier day can still be closed (flagged) within this window.
const FORGOT_WINDOW_MS = 36 * 3600 * 1000;
const lateOpen = () => S.mySessions.find((s) => s.status === "open" && s.date !== istDate() &&
  toDate(s.inAt) && Date.now() - toDate(s.inAt).getTime() < FORGOT_WINDOW_MS);
const FLAG_TEXT = {
  outside: "Checked out away from the lab",
  weak_gps: "Weak GPS signal at check-out",
  late: "Checked out after the day ended",
};
const endOf = (s) => toDate(s.leftAt) || toDate(s.outAt);
const flagPill = (s) => s.outFlag ? `<span class="pill warn" title="${esc(FLAG_TEXT[s.outReason] || "Flagged")}">flagged</span>` : "";
const toLocalInput = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
function elapsedText() {
  const s = openToday();
  const t = s && toDate(s.inAt);
  return t ? fmtDur(Date.now() - t.getTime()) : "";
}

function renderStudent() {
  const today = istDate();
  const open = openToday();
  const activeLabs = S.labs.filter((l) => l.active);
  const month = monthStart();
  const monthSessions = S.mySessions.filter((s) => s.date >= month);
  const monthDays = new Set(monthSessions.map((s) => s.date)).size;
  const monthMs = monthSessions.reduce((a, s) => a + sessionMs(s), 0);

  const statusCard = open
    ? `<section class="status in">
         <p class="eyebrow">In the lab</p>
         <p class="big"><span id="elapsed">${elapsedText()}</span></p>
         <p class="muted">${esc(open.labName)} · since ${fmtTime(toDate(open.inAt))}</p>
         <button class="primary lg danger-ish" id="checkout">Check out</button>
       </section>`
    : `<section class="status out">
         <p class="eyebrow">Not checked in</p>
         <p class="big">${fmtDay(today)}</p>
         <p class="muted">${activeLabs.length
           ? "Stand inside the lab, then tap below."
           : "No lab is set up yet. Ask your lab manager."}</p>
         <button class="primary lg" id="checkin" ${activeLabs.length ? "" : "disabled"}>Check in</button>
       </section>`;

  const late = !open && lateOpen();
  const lateCard = late ? `<section class="panel warn-panel">
      <p><strong>You didn't check out on ${fmtDay(late.date)}.</strong> You checked in at ${fmtTime(toDate(late.inAt))} (${esc(late.labName)}).</p>
      <p class="muted small">Check out now and enter the time you left. It will be flagged for your lab manager.</p>
      <button class="ghost" id="late-out">Check out for ${fmtDay(late.date)}</button>
    </section>` : "";

  const rows = S.mySessions.slice(0, 40).map((s) => {
    const inT = toDate(s.inAt), outT = endOf(s);
    const missed = s.status === "open" && s.date !== today;
    return `<li class="hist">
      <div><strong>${fmtDay(s.date)}</strong><small>${esc(s.labName)}</small></div>
      <div class="mono">${fmtTime(inT)} → ${s.status === "closed" ? fmtTime(outT) : missed ? "no check-out" : "now"}</div>
      <div class="mono right">${missed ? `<span class="pill warn">missed</span>` : fmtDur(sessionMs(s))} ${flagPill(s)}</div>
    </li>`;
  }).join("");

  app.innerHTML = `${header()}
  <main class="wrap narrow">
    <p class="hello">Hi ${esc(S.profile.name.split(" ")[0])} <span class="muted mono">${esc(S.profile.rollNo)}</span></p>
    ${statusCard}
    ${lateCard}
    <section class="stats">
      <div><span class="num">${monthDays}</span><span class="lbl">days this month</span></div>
      <div><span class="num">${fmtDur(monthMs)}</span><span class="lbl">time in lab this month</span></div>
    </section>
    <section>
      <h2>Your check-ins</h2>
      ${rows ? `<ul class="list">${rows}</ul>` : `<p class="muted">Nothing yet. Your first check-in will show up here.</p>`}
    </section>
  </main>`;
  bindHeader();
  $("#checkin")?.addEventListener("click", () => runFlow("in"));
  $("#checkout")?.addEventListener("click", () => runFlow("out", open));
  $("#late-out")?.addEventListener("click", () => runFlow("out", late));
}

function sessionMs(s) {
  const a = toDate(s.inAt);
  if (!a) return 0;
  if (s.status === "closed") { const b = endOf(s); return b ? Math.max(0, b - a) : 0; }
  return s.date === istDate() ? Date.now() - a : 0; // forgotten check-outs count as zero time
}

/* ------------------------------------------------------------------ *
 * Check-in / check-out flow: location → selfie → submit
 * ------------------------------------------------------------------ */
let stream = null;
function stopCamera() { stream?.getTracks().forEach((t) => t.stop()); stream = null; }
function closeSheet() { stopCamera(); sheet.hidden = true; sheet.innerHTML = ""; document.body.classList.remove("locked"); }

function openSheet(html) {
  sheet.innerHTML = `<div class="sheet-card" role="dialog" aria-modal="true">${html}</div>`;
  sheet.hidden = false;
  document.body.classList.add("locked");
  $$("[data-close]", sheet).forEach((b) => b.addEventListener("click", closeSheet));
}

function steps(active) {
  const names = ["Location", "Selfie", "Done"];
  return `<ol class="steps">${names.map((n, i) =>
    `<li class="${i < active ? "done" : i === active ? "on" : ""}">${n}</li>`).join("")}</ol>`;
}

async function runFlow(kind, session) {
  const verb = kind === "in" ? "Check in" : "Check out";
  openSheet(`${steps(0)}
    <h3>${verb}: finding your location</h3>
    <div class="spinner" aria-hidden="true"></div>
    <p class="muted center">Getting a precise GPS fix. This takes a few seconds.</p>
    <button class="ghost" data-close>Cancel</button>`);

  let pos;
  try { pos = await getBestPosition(); }
  catch (e) { return flowError(e.message); }
  if (sheet.hidden) return;

  const { latitude: lat, longitude: lng, accuracy } = pos.coords;
  const candidates = kind === "out"
    ? S.labs.filter((l) => l.id === session.labId)
    : S.labs.filter((l) => l.active);
  if (!candidates.length) return flowError("That lab is no longer set up. Ask your lab manager.");
  const ranked = candidates.map((l) => ({ lab: l, d: distanceM(l, lat, lng) })).sort((a, b) => a.d - b.d);
  const { lab, d } = ranked[0];

  let flag = null;
  if (kind === "out") {
    const sameDay = session.date === istDate();
    const inside = d <= lab.radius && accuracy <= S.settings.maxAccuracy;
    if (!sameDay || !inside) {
      const reason = !sameDay ? "late" : accuracy > S.settings.maxAccuracy ? "weak_gps" : "outside";
      const where = reason === "weak_gps" ? `GPS is too weak to confirm you're in the lab (±${Math.round(accuracy)} m).`
        : reason === "outside" ? `You are about ${Math.round(d)} m from ${lab.name}, outside its ${lab.radius} m zone.`
        : `This check-in is from ${fmtDay(session.date)}.`;
      const leftAt = await askLeaveTime(session, where);
      if (!leftAt) return;
      flag = { reason, leftAt };
    }
  }

  if (kind === "in" && accuracy > S.settings.maxAccuracy) {
    return flowError(`GPS signal is too weak (±${Math.round(accuracy)} m; the limit is ±${S.settings.maxAccuracy} m). Turn on precise location, move near a window, and try again.`);
  }
  if (kind === "in" && d > lab.radius) {
    return flowError(`You are about ${Math.round(d)} m from ${lab.name}. You need to be within ${lab.radius} m. Move into the lab and try again.`);
  }

  // Selfie
  openSheet(`${steps(1)}
    <h3>Take a selfie</h3>
    <p class="muted">${flag ? `This check-out will be <strong>flagged</strong> (left at ${fmtTime(flag.leftAt)}).` : `You are at <strong>${esc(lab.name)}</strong> (${Math.round(d)} m from the marked spot, ±${Math.round(accuracy)} m).`}</p>
    <div class="cam"><video id="vid" playsinline muted autoplay></video><img id="shot" alt="Your selfie" hidden></div>
    <div class="row">
      <button class="ghost" data-close>Cancel</button>
      <button class="primary" id="snap">Take photo</button>
      <button class="ghost" id="retake" hidden>Retake</button>
      <button class="primary" id="use" hidden>${verb}</button>
    </div>
    <p class="error" id="flow-err" hidden></p>`);

  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "user", width: { ideal: 720 }, height: { ideal: 720 } }, audio: false,
    });
  } catch {
    return flowError("Camera permission is off. Allow camera for this site in your browser settings, then try again.");
  }
  if (sheet.hidden) return stopCamera();
  const vid = $("#vid");
  vid.srcObject = stream;
  await vid.play().catch(() => {});

  let img = null;
  $("#snap").addEventListener("click", () => {
    img = captureFrame(vid, `${fmtDay(istDate())} · ${fmtTime(new Date())} · ${lab.name}`);
    $("#shot").src = img; $("#shot").hidden = false; vid.hidden = true;
    $("#snap").hidden = true; $("#retake").hidden = false; $("#use").hidden = false;
  });
  $("#retake").addEventListener("click", () => {
    img = null; $("#shot").hidden = true; vid.hidden = false;
    $("#snap").hidden = false; $("#retake").hidden = true; $("#use").hidden = true;
  });
  $("#use").addEventListener("click", async () => {
    const btn = $("#use"); btn.disabled = true; btn.textContent = "Saving…";
    stopCamera();
    try {
      if (kind === "in") await submitIn(lab, lat, lng, accuracy, d, img);
      else await submitOut(session, lat, lng, accuracy, d, img, flag);
      openSheet(`${steps(3)}
        <div class="done-mark" aria-hidden="true">✓</div>
        <h3 class="center">${kind === "in" ? "Checked in" : "Checked out"} at ${fmtTime(flag ? flag.leftAt : new Date())}</h3>
        <p class="muted center">${esc(lab.name)}${flag ? " · flagged for your lab manager" : ""}</p>
        <button class="primary" data-close>Close</button>`);
    } catch (e) {
      console.error(e);
      btn.disabled = false; btn.textContent = verb;
      const el = $("#flow-err"); el.hidden = false;
      el.textContent = e.code === "permission-denied"
        ? "The server rejected this. Check that your phone's date and time are set automatically, then try again."
        : "Could not save. Check your internet connection and try again.";
    }
  });
}

// Off-site or late check-out: the student says when they actually left. Resolves to a Date, or null if cancelled.
function askLeaveTime(session, where) {
  return new Promise((resolve) => {
    const inT = toDate(session.inAt), now = new Date();
    const def = session.date === istDate() ? toLocalInput(now) : ""; // a forgotten day: make them pick the real time
    openSheet(`<h3>Check out from outside the lab?</h3>
      <p class="error-box">${esc(where)}</p>
      <p>You can still check out, but it will be <strong>flagged</strong> for your lab manager to review.</p>
      <form id="lt" class="form">
        <label for="lt-time">When did you leave the lab?</label>
        <input id="lt-time" type="datetime-local" required min="${toLocalInput(inT)}" max="${toLocalInput(now)}" value="${def}">
        <small class="muted">Between ${fmtTime(inT)} on ${fmtDay(session.date)} and now.</small>
        <p class="error" id="lt-err" hidden></p>
        <div class="row"><button type="button" class="ghost" id="lt-cancel">Cancel</button>
          <button class="primary" type="submit">Continue to selfie</button></div>
      </form>`);
    $("#lt-cancel").addEventListener("click", () => { closeSheet(); resolve(null); });
    $("#lt").addEventListener("submit", (e) => {
      e.preventDefault();
      const t = new Date($("#lt-time").value);
      if (isNaN(t) || t < inT || t > new Date()) {
        const el = $("#lt-err"); el.hidden = false; el.textContent = "Pick a time between your check-in and now."; return;
      }
      resolve(t);
    });
  });
}

function flowError(msg) {
  stopCamera();
  openSheet(`<h3>Not marked yet</h3>
    <p class="error-box">${esc(msg)}</p>
    <button class="primary" data-close>OK</button>`);
}

// Square, 360 px, JPEG — about 20–30 KB, small enough to keep inside Firestore.
function captureFrame(video, stamp) {
  const size = 360;
  const c = document.createElement("canvas");
  c.width = size; c.height = size;
  const g = c.getContext("2d");
  const vw = video.videoWidth, vh = video.videoHeight, s = Math.min(vw, vh);
  g.drawImage(video, (vw - s) / 2, (vh - s) / 2, s, s, 0, 0, size, size);
  g.fillStyle = "rgba(0,0,0,.55)";
  g.fillRect(0, size - 26, size, 26);
  g.fillStyle = "#fff";
  g.font = "600 13px system-ui, sans-serif";
  g.fillText(stamp, 8, size - 9);
  return c.toDataURL("image/jpeg", 0.7);
}

async function submitIn(lab, lat, lng, acc, dist, img) {
  if (openToday()) throw new Error("already open");
  const ref = doc(collection(db, "sessions"));
  const b = writeBatch(db);
  b.set(ref, {
    uid: S.user.uid, email: S.user.email, name: S.profile.name, rollNo: S.profile.rollNo,
    labId: lab.id, labName: lab.name, date: istDate(),
    inAt: serverTimestamp(), inLat: lat, inLng: lng, inAcc: Math.round(acc), inDist: Math.round(dist),
    status: "open", ua: navigator.userAgent.slice(0, 200),
  });
  b.set(doc(db, "photos", ref.id + "_in"), { uid: S.user.uid, sessionId: ref.id, kind: "in", img, at: serverTimestamp() });
  await b.commit();
}

async function submitOut(session, lat, lng, acc, dist, img, flag) {
  const b = writeBatch(db);
  b.update(doc(db, "sessions", session.id), {
    status: "closed", outAt: serverTimestamp(), outLat: lat, outLng: lng,
    outAcc: Math.round(acc), outDist: Math.round(dist),
    outFlag: !!flag,
    ...(flag ? { outReason: flag.reason, leftAt: Timestamp.fromDate(flag.leftAt) } : {}),
  });
  b.set(doc(db, "photos", session.id + "_out"), { uid: S.user.uid, sessionId: session.id, kind: "out", img, at: serverTimestamp() });
  await b.commit();
}

/* ------------------------------------------------------------------ *
 * Lab manager
 * ------------------------------------------------------------------ */
const TABS = [
  ["live", "Today"], ["records", "Records"], ["students", "Students"], ["settings", "Settings"],
];

function startAdmin() {
  cleanup();
  renderAdmin();
}

function renderAdmin() {
  cleanup();
  app.innerHTML = `${header(`<span class="pill">Lab manager</span>`)}
  <nav class="tabs wrap" role="tablist">
    ${TABS.map(([k, n]) => `<button role="tab" data-tab="${k}" aria-selected="${S.tab === k}">${n}</button>`).join("")}
  </nav>
  <main class="wrap" id="pane"></main>`;
  bindHeader();
  $$("[data-tab]").forEach((b) => b.addEventListener("click", () => { S.tab = b.dataset.tab; renderAdmin(); }));
  ({ live: paneLive, records: paneRecords, students: paneStudents, settings: paneSettings })[S.tab]();
}

/* ---- Today (live) ---- */
function paneLive() {
  const pane = $("#pane");
  pane.innerHTML = `<p class="muted pad">Loading today's check-ins…</p>`;
  const q = query(collection(db, "sessions"), where("date", "==", istDate()));
  S.unsub.push(onSnapshot(q, (snap) => {
    const all = snap.docs.map((d) => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (toDate(b.inAt)?.getTime() ?? 0) - (toDate(a.inAt)?.getTime() ?? 0));
    const inside = all.filter((s) => s.status === "open");
    const left = all.filter((s) => s.status === "closed");
    const card = (s) => `
      <button class="person" data-sid="${s.id}">
        <img data-photo="${s.id}_in" alt="" class="thumb">
        <span class="pmeta"><strong>${esc(s.name)}</strong>
          <small class="mono">${esc(s.rollNo)} · ${esc(s.labName)}</small>
          <small class="mono">${fmtTime(toDate(s.inAt))} → ${s.status === "closed" ? fmtTime(endOf(s)) : "in lab"} ${flagPill(s)}
          ${s.status === "closed" ? " · " + fmtDur(sessionMs(s)) : ""}</small></span>
      </button>`;
    pane.innerHTML = `
      <div class="pane-head"><h1>${fmtDay(istDate())}</h1>
        <p class="muted">${inside.length} in the lab now · ${new Set(all.map((s) => s.uid)).size} students came in today</p></div>
      ${S.labs.length ? "" : `<p class="error-box">No lab is set up yet. Go to Settings and add your lab's location so students can check in.</p>`}
      <h2><span class="dot in"></span>In the lab now</h2>
      ${inside.length ? `<div class="grid">${inside.map(card).join("")}</div>` : `<p class="muted">Nobody is checked in right now.</p>`}
      <h2><span class="dot out"></span>Checked out</h2>
      ${left.length ? `<div class="grid">${left.map(card).join("")}</div>` : `<p class="muted">No check-outs yet today.</p>`}`;
    const byId = Object.fromEntries(all.map((s) => [s.id, s]));
    $$("[data-sid]", pane).forEach((b) => b.addEventListener("click", () => openSession(byId[b.dataset.sid])));
    fillPhotos(pane);
  }, (e) => { console.error(e); pane.innerHTML = `<p class="error-box">Could not load today's data.</p>`; }));
}

const NO_PHOTO = "data:image/svg+xml," + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120"><rect width="120" height="120" fill="#8a9a96" fill-opacity=".15"/>' +
  '<text x="60" y="66" text-anchor="middle" font-family="system-ui,sans-serif" font-size="13" fill="#5b6d68">No photo</text></svg>');
function fillPhotos(root) {
  $$("img[data-photo]", root).forEach(async (img) => {
    const src = await getPhoto(img.dataset.photo);
    img.src = src || NO_PHOTO;
  });
}

/* ---- Session detail ---- */
async function openSession(s) {
  const inT = toDate(s.inAt), outT = toDate(s.outAt);
  const map = (la, ln) => la != null ? `<a href="https://www.google.com/maps?q=${la},${ln}" target="_blank" rel="noopener">map</a>` : "";
  openSheet(`
    <div class="sheet-head"><div><h3>${esc(s.name)}</h3><p class="muted mono">${esc(s.rollNo)} · ${esc(s.email)}</p></div>
      <button class="ghost sm" data-close>Close</button></div>
    <div class="pair">
      <figure><img data-photo="${s.id}_in" alt="Check-in selfie"><figcaption>In · ${fmtTime(inT)}</figcaption></figure>
      <figure><img data-photo="${s.id}_out" alt="Check-out selfie"><figcaption>Out · ${s.status === "closed" ? fmtTime(endOf(s)) : "—"}</figcaption></figure>
    </div>
    <dl class="kv">
      <dt>Lab</dt><dd>${esc(s.labName)}</dd>
      <dt>Date</dt><dd>${fmtDay(s.date)}</dd>
      <dt>Time in lab</dt><dd>${s.status === "closed" ? fmtDur(sessionMs(s)) : s.date === istDate() ? "still in lab" : "no check-out"}</dd>
      <dt>Check-in spot</dt><dd class="mono">${s.inDist} m from lab · ±${s.inAcc} m ${map(s.inLat, s.inLng)}</dd>
      ${s.outFlag ? `<dt>Flag</dt><dd><span class="pill warn">flagged</span> ${esc(FLAG_TEXT[s.outReason] || "")}.
        Says they left at <strong>${fmtTime(toDate(s.leftAt))}</strong>${toDate(s.leftAt) && istDate(toDate(s.leftAt)) !== s.date ? " (" + fmtDay(istDate(toDate(s.leftAt))) + ")" : ""};
        submitted at ${fmtTime(toDate(s.outAt))}${toDate(s.outAt) && istDate(toDate(s.outAt)) !== s.date ? " on " + fmtDay(istDate(toDate(s.outAt))) : ""}.</dd>` : ""}
      <dt>Check-out spot</dt><dd class="mono">${s.status === "closed" ? `${s.outDist} m from lab · ±${s.outAcc} m ${map(s.outLat, s.outLng)}` : "—"}</dd>
      <dt>Device</dt><dd class="small">${esc(s.ua || "")}</dd>
    </dl>
    <div class="row end">
      <button class="ghost danger" id="del">Delete this record</button>
      <span id="delc" hidden>Delete permanently?
        <button class="ghost sm" id="deln">Keep</button><button class="danger sm" id="dely">Delete</button></span>
    </div>`);
  fillPhotos(sheet);
  $("#del").addEventListener("click", () => { $("#del").hidden = true; $("#delc").hidden = false; });
  $("#deln").addEventListener("click", () => { $("#del").hidden = false; $("#delc").hidden = true; });
  $("#dely").addEventListener("click", async () => {
    try {
      const b = writeBatch(db);
      b.delete(doc(db, "sessions", s.id));
      b.delete(doc(db, "photos", s.id + "_in"));
      b.delete(doc(db, "photos", s.id + "_out"));
      await b.commit();
      closeSheet(); toast("Record deleted");
      if (S.tab !== "live") renderAdmin();
    } catch (e) { console.error(e); toast("Could not delete the record.", "err"); }
  });
}

/* ---- Records ---- */
async function fetchRange(from, to) {
  const q = query(collection(db, "sessions"), where("date", ">=", from), where("date", "<=", to));
  const snap = await getDocs(q);
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

function rangeControls(id, from, to, extra = "") {
  return `<form class="filters" id="${id}">
    <label>From <input type="date" id="${id}-from" value="${from}"></label>
    <label>To <input type="date" id="${id}-to" value="${to}"></label>
    ${S.labs.length > 1 ? `<label>Lab <select id="${id}-lab"><option value="">All labs</option>
      ${S.labs.map((l) => `<option value="${l.id}">${esc(l.name)}</option>`).join("")}</select></label>` : ""}
    ${extra}
    <button class="ghost" type="submit">Show</button>
  </form>`;
}

async function paneRecords() {
  const pane = $("#pane");
  S.rec ??= { from: monthStart(), to: istDate(), lab: "", q: "" };
  pane.innerHTML = `<div class="pane-head"><h1>Records</h1>
      <button class="primary" id="exp-log">Export session log (CSV)</button></div>
    ${rangeControls("rf", S.rec.from, S.rec.to, `<label class="grow">Search <input id="rf-q" placeholder="Name or roll number" value="${esc(S.rec.q)}"></label>`)}
    <div id="rec-out"><p class="muted pad">Loading…</p></div>`;
  if ($("#rf-lab")) $("#rf-lab").value = S.rec.lab;
  $("#rf").addEventListener("submit", (e) => {
    e.preventDefault();
    S.rec = { from: $("#rf-from").value, to: $("#rf-to").value, lab: $("#rf-lab")?.value || "", q: $("#rf-q").value.trim() };
    paneRecords();
  });

  let rows;
  try { rows = await fetchRange(S.rec.from, S.rec.to); }
  catch (e) { console.error(e); $("#rec-out").innerHTML = `<p class="error-box">Could not load records.</p>`; return; }
  const ql = S.rec.q.toLowerCase();
  rows = rows.filter((s) => (!S.rec.lab || s.labId === S.rec.lab) &&
    (!ql || s.name.toLowerCase().includes(ql) || s.rollNo.toLowerCase().includes(ql)))
    .sort((a, b) => (toDate(b.inAt)?.getTime() ?? 0) - (toDate(a.inAt)?.getTime() ?? 0));
  const today = istDate();
  $("#rec-out").innerHTML = rows.length ? `
    <p class="muted">${rows.length} check-ins</p>
    <div class="table-wrap"><table>
      <thead><tr><th>Date</th><th>Student</th><th>Roll no.</th><th>Lab</th><th>In</th><th>Out</th><th class="right">Time</th></tr></thead>
      <tbody>${rows.map((s) => {
        const missed = s.status === "open" && s.date !== today;
        return `<tr data-sid="${s.id}" tabindex="0">
          <td class="mono">${fmtDay(s.date)}</td><td>${esc(s.name)}</td><td class="mono">${esc(s.rollNo)}</td>
          <td>${esc(s.labName)}</td><td class="mono">${fmtTime(toDate(s.inAt))}</td>
          <td class="mono">${s.status === "closed" ? fmtTime(endOf(s)) + " " + flagPill(s) : missed ? `<span class="pill warn">missed</span>` : `<span class="pill in">in lab</span>`}</td>
          <td class="mono right">${s.status === "closed" ? fmtDur(sessionMs(s)) : "—"}</td></tr>`;
      }).join("")}</tbody></table></div>` : `<p class="muted pad">No check-ins in this range.</p>`;
  const byId = Object.fromEntries(rows.map((s) => [s.id, s]));
  $$("tr[data-sid]").forEach((tr) => {
    const open = () => openSession(byId[tr.dataset.sid]);
    tr.addEventListener("click", open);
    tr.addEventListener("keydown", (e) => { if (e.key === "Enter") open(); });
  });
  $("#exp-log").addEventListener("click", () => {
    const out = [["Date", "Roll No", "Name", "Email", "Lab", "Check-in", "Check-out", "Minutes in lab", "Status", "Check-out flag", "Check-out submitted at",
      "Check-in distance (m)", "Check-in GPS accuracy (m)", "Check-out distance (m)", "Check-out GPS accuracy (m)"]];
    rows.slice().reverse().forEach((s) => {
      const closed = s.status === "closed";
      out.push([s.date, s.rollNo, s.name, s.email, s.labName, fmtTime(toDate(s.inAt)),
        closed ? fmtTime(endOf(s)) : "",
        closed ? Math.round(sessionMs(s) / 60000) : "",
        closed ? (s.outFlag ? "Flagged" : "Complete") : s.date === today ? "In lab" : "No check-out",
        s.outFlag ? FLAG_TEXT[s.outReason] || "Flagged" : "",
        s.outFlag ? istDate(toDate(s.outAt)) + " " + fmtTime(toDate(s.outAt)) : "",
        s.inDist, s.inAcc, closed ? s.outDist : "", closed ? s.outAcc : ""]);
    });
    downloadCSV(`lab-sessions_${S.rec.from}_to_${S.rec.to}.csv`, out);
  });
}

/* ---- Students (attendance %) ---- */
function weekdaysBetween(from, to) {
  const out = [];
  const [y1, m1, d1] = from.split("-").map(Number), [y2, m2, d2] = to.split("-").map(Number);
  for (let t = Date.UTC(y1, m1 - 1, d1); t <= Date.UTC(y2, m2 - 1, d2); t += 86400000) {
    const dt = new Date(t), wd = dt.getUTCDay();
    if (wd !== 0 && wd !== 6) out.push(dt.toISOString().slice(0, 10));
  }
  return out;
}

function summarize(users, sessions, from, to) {
  const today = istDate();
  const end = to > today ? today : to;
  const labDays = S.settings.labDayMode === "weekdays"
    ? weekdaysBetween(from, end)
    : [...new Set(sessions.map((s) => s.date))].sort();
  const labDaySet = new Set(labDays);
  const minMs = (Number(S.settings.minHours) || 0) * 3600000;

  const byUid = new Map(users.map((u) => [u.uid, { ...u, perDay: new Map(), totalMs: 0, missed: 0, flagged: 0 }]));
  for (const s of sessions) {
    if (!byUid.has(s.uid)) byUid.set(s.uid, { uid: s.uid, name: s.name, rollNo: s.rollNo, email: s.email, perDay: new Map(), totalMs: 0, missed: 0, flagged: 0 });
    const r = byUid.get(s.uid);
    const ms = sessionMs(s);
    r.totalMs += ms;
    if (s.status === "open" && s.date !== today) r.missed++;
    if (s.outFlag) r.flagged++;
    r.perDay.set(s.date, (r.perDay.get(s.date) ?? 0) + ms);
  }
  const rows = [...byUid.values()].map((r) => {
    let present = 0;
    for (const [day, ms] of r.perDay) if (labDaySet.has(day) && (minMs === 0 || ms >= minMs)) present++;
    const pct = labDays.length ? Math.round((present / labDays.length) * 1000) / 10 : 0;
    return { ...r, present, pct };
  }).sort((a, b) => String(a.rollNo).localeCompare(String(b.rollNo)));
  return { rows, labDays: labDays.length };
}

async function paneStudents() {
  const pane = $("#pane");
  S.stu ??= { from: monthStart(), to: istDate(), lab: "" };
  pane.innerHTML = `<div class="pane-head"><h1>Students</h1>
      <button class="primary" id="exp-sum">Export attendance % (CSV)</button></div>
    ${rangeControls("sf", S.stu.from, S.stu.to)}
    <div id="stu-out"><p class="muted pad">Loading…</p></div>`;
  if ($("#sf-lab")) $("#sf-lab").value = S.stu.lab;
  $("#sf").addEventListener("submit", (e) => {
    e.preventDefault();
    S.stu = { from: $("#sf-from").value, to: $("#sf-to").value, lab: $("#sf-lab")?.value || "" };
    paneStudents();
  });

  let users, sessions;
  try {
    [users, sessions] = await Promise.all([
      getDocs(collection(db, "users")).then((s) => s.docs.map((d) => ({ uid: d.id, ...d.data() }))),
      fetchRange(S.stu.from, S.stu.to),
    ]);
  } catch (e) { console.error(e); $("#stu-out").innerHTML = `<p class="error-box">Could not load students.</p>`; return; }
  if (S.stu.lab) sessions = sessions.filter((s) => s.labId === S.stu.lab);
  const { rows, labDays } = summarize(users, sessions, S.stu.from, S.stu.to);
  const th = Number(S.settings.threshold) || 75;
  const rule = S.settings.labDayMode === "weekdays" ? "every Monday–Friday up to today" : "days on which anyone checked in";
  const minRule = Number(S.settings.minHours) > 0 ? `, and a day counts only after ${S.settings.minHours} h in the lab` : "";
  const low = rows.filter((r) => r.pct < th).length;

  $("#stu-out").innerHTML = `
    <p class="muted">${labDays} lab days in this range (${rule}${minRule}). ${low ? `<strong class="warn-text">${low} below ${th}%</strong>.` : ""}
      Change these rules in Settings.</p>
    ${rows.length ? `<div class="table-wrap"><table>
      <thead><tr><th>Roll no.</th><th>Name</th><th class="right">Days present</th><th>Attendance</th><th class="right">Time in lab</th><th class="right">Missed check-outs</th><th class="right">Flagged check-outs</th></tr></thead>
      <tbody>${rows.map((r) => `<tr>
        <td class="mono">${esc(r.rollNo)}</td><td>${esc(r.name)}</td>
        <td class="mono right">${r.present} / ${labDays}</td>
        <td><div class="meter ${r.pct < th ? "low" : ""}"><span style="width:${Math.min(100, r.pct)}%"></span></div>
            <span class="mono ${r.pct < th ? "warn-text" : ""}">${r.pct}%</span></td>
        <td class="mono right">${fmtDur(r.totalMs)}</td>
        <td class="mono right">${r.missed || ""}</td>
        <td class="mono right ${r.flagged ? "warn-text" : ""}">${r.flagged || ""}</td></tr>`).join("")}</tbody></table></div>`
      : `<p class="muted pad">No students have signed up yet. Share the app link with them.</p>`}`;

  $("#exp-sum").addEventListener("click", () => {
    const out = [["Roll No", "Name", "Email", "Days present", "Lab days", "Attendance %", `Below ${th}%`, "Hours in lab", "Missed check-outs", "Flagged check-outs", "From", "To"]];
    rows.forEach((r) => out.push([r.rollNo, r.name, r.email, r.present, labDays, r.pct, r.pct < th ? "Yes" : "No",
      (r.totalMs / 3600000).toFixed(2), r.missed, r.flagged, S.stu.from, S.stu.to]));
    downloadCSV(`lab-attendance_${S.stu.from}_to_${S.stu.to}.csv`, out);
  });
}

function downloadCSV(name, rows) {
  const cell = (v) => {
    let s = v == null ? "" : String(v);
    if (/^[=+\-@]/.test(s)) s = "'" + s;           // stop spreadsheet formula injection
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const text = "﻿" + rows.map((r) => r.map(cell).join(",")).join("\r\n"); // BOM so Excel reads UTF-8
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
  a.download = name;
  document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
  toast(`Downloaded ${name}`);
}

/* ---- Settings ---- */
async function paneSettings() {
  const pane = $("#pane");
  const st = S.settings;
  let admins = [];
  try { admins = (await getDocs(collection(db, "admins"))).docs.map((d) => d.id).sort(); } catch (e) { console.error(e); }

  pane.innerHTML = `
    <div class="pane-head"><h1>Settings</h1></div>
    <section class="panel">
      <div class="pane-head"><h2>Labs</h2><button class="primary sm" id="add-lab">Add lab</button></div>
      <p class="muted">Students can check in only within the radius of an active lab. Stand in the middle of the lab and tap
        “Use my location” to mark it. A radius of 30–60 m suits most rooms; indoor GPS can drift, so test it with your own phone.</p>
      <div id="lab-list">${S.labs.length ? S.labs.map((l) => `
        <div class="lab-row">
          <div><strong>${esc(l.name)}</strong> ${l.active ? `<span class="pill in">active</span>` : `<span class="pill">paused</span>`}
            <small class="mono">${l.lat.toFixed(6)}, ${l.lng.toFixed(6)} · ${l.radius} m radius
            · <a href="https://www.google.com/maps?q=${l.lat},${l.lng}" target="_blank" rel="noopener">map</a></small></div>
          <button class="ghost sm" data-edit="${l.id}">Edit</button>
        </div>`).join("") : `<p class="muted">No labs yet.</p>`}</div>
    </section>

    <section class="panel">
      <h2>Attendance rules</h2>
      <form id="rules" class="form two">
        <label for="st-domain">Allowed email domain</label>
        <div><input id="st-domain" placeholder="iitb.ac.in" value="${esc(st.allowedDomain)}">
          <small class="muted">Leave blank to allow any Google account.</small></div>
        <label for="st-acc">Worst GPS accuracy accepted (m)</label>
        <input id="st-acc" type="number" min="10" max="1000" value="${st.maxAccuracy}">
        <label for="st-min">Hours needed for a day to count</label>
        <div><input id="st-min" type="number" min="0" max="24" step="0.5" value="${st.minHours}">
          <small class="muted">0 means any check-in counts as present.</small></div>
        <label for="st-mode">Lab days are</label>
        <select id="st-mode">
          <option value="activity" ${st.labDayMode === "activity" ? "selected" : ""}>Days on which anyone checked in</option>
          <option value="weekdays" ${st.labDayMode === "weekdays" ? "selected" : ""}>Every Monday to Friday</option>
        </select>
        <label for="st-th">Flag students below (%)</label>
        <input id="st-th" type="number" min="0" max="100" value="${st.threshold}">
        <span></span><button class="primary" type="submit">Save rules</button>
      </form>
    </section>

    <section class="panel">
      <h2>Lab managers</h2>
      <p class="muted">Managers see everyone's records and photos and can change these settings. Add their Google email.</p>
      <ul class="list">${admins.map((e) => `<li class="hist"><span>${esc(e)}</span><span></span>
        ${e === S.user.email ? `<small class="muted right">you</small>` : `<button class="ghost sm right" data-rm="${esc(e)}">Remove</button>`}</li>`).join("")}</ul>
      <form id="add-admin" class="row">
        <input id="ad-email" type="email" required placeholder="name@iitb.ac.in" class="grow">
        <button class="ghost" type="submit">Add manager</button>
      </form>
    </section>`;

  $("#add-lab").addEventListener("click", () => editLab(null));
  $$("[data-edit]").forEach((b) => b.addEventListener("click", () => editLab(S.labs.find((l) => l.id === b.dataset.edit))));

  $("#rules").addEventListener("submit", async (e) => {
    e.preventDefault();
    const next = {
      allowedDomain: $("#st-domain").value.trim().replace(/^@/, "").toLowerCase(),
      maxAccuracy: Number($("#st-acc").value) || DEFAULT_SETTINGS.maxAccuracy,
      minHours: Number($("#st-min").value) || 0,
      labDayMode: $("#st-mode").value,
      threshold: Number($("#st-th").value) || DEFAULT_SETTINGS.threshold,
    };
    try { await setDoc(doc(db, "config", "settings"), next); S.settings = { ...DEFAULT_SETTINGS, ...next }; toast("Rules saved"); }
    catch (err) { console.error(err); toast("Could not save the rules.", "err"); }
  });

  $("#add-admin").addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = $("#ad-email").value.trim().toLowerCase();
    try { await setDoc(doc(db, "admins", email), { addedBy: S.user.email, at: serverTimestamp() }); toast(`${email} is now a lab manager`); paneSettings(); }
    catch (err) { console.error(err); toast("Could not add that manager.", "err"); }
  });
  $$("[data-rm]").forEach((b) => b.addEventListener("click", async () => {
    try { await deleteDoc(doc(db, "admins", b.dataset.rm)); toast("Manager removed"); paneSettings(); }
    catch (err) { console.error(err); toast("Could not remove that manager.", "err"); }
  }));
}

function editLab(lab) {
  openSheet(`
    <div class="sheet-head"><h3>${lab ? "Edit lab" : "Add a lab"}</h3><button class="ghost sm" data-close>Close</button></div>
    <form id="lf" class="form">
      <label for="lf-name">Lab name</label>
      <input id="lf-name" required maxlength="60" value="${esc(lab?.name || "")}" placeholder="e.g. BB653 Electronics Lab">
      <div class="row">
        <label class="grow">Latitude <input id="lf-lat" type="number" step="any" required value="${lab?.lat ?? ""}"></label>
        <label class="grow">Longitude <input id="lf-lng" type="number" step="any" required value="${lab?.lng ?? ""}"></label>
      </div>
      <button type="button" class="ghost" id="lf-here">Use my location</button>
      <small class="muted" id="lf-hint">Stand in the middle of the lab first.</small>
      <label for="lf-r">Radius (m)</label>
      <input id="lf-r" type="number" min="10" max="2000" required value="${lab?.radius ?? 50}">
      <label class="check"><input type="checkbox" id="lf-active" ${lab?.active === false ? "" : "checked"}> Accept check-ins at this lab</label>
      <button class="primary" type="submit">Save lab</button>
    </form>`);
  $("#lf-here").addEventListener("click", async () => {
    const hint = $("#lf-hint");
    hint.textContent = "Getting a precise fix…";
    try {
      const p = await getBestPosition({ goodEnough: 10, waitMs: 12000 });
      $("#lf-lat").value = p.coords.latitude.toFixed(7);
      $("#lf-lng").value = p.coords.longitude.toFixed(7);
      hint.textContent = `Marked with ±${Math.round(p.coords.accuracy)} m accuracy.` +
        (p.coords.accuracy > 40 ? " That is rough; try again near a window, or set a larger radius." : "");
    } catch (e) { hint.textContent = e.message; }
  });
  $("#lf").addEventListener("submit", async (e) => {
    e.preventDefault();
    const lat = Number($("#lf-lat").value), lng = Number($("#lf-lng").value);
    const data = {
      name: $("#lf-name").value.trim(), lat, lng, cosLat: cosLatOf(lat),
      radius: Math.round(Number($("#lf-r").value)), active: $("#lf-active").checked,
    };
    try {
      if (lab) await updateDoc(doc(db, "labs", lab.id), data);
      else await addDoc(collection(db, "labs"), data);
      await loadShared();
      closeSheet(); toast("Lab saved"); paneSettings();
    } catch (err) { console.error(err); toast("Could not save the lab.", "err"); }
  });
}

/* ------------------------------------------------------------------ *
 * Boot
 * ------------------------------------------------------------------ */
sheet.addEventListener("click", (e) => { if (e.target === sheet) closeSheet(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !sheet.hidden) closeSheet(); });

if (!configured) {
  renderSetupNeeded();
} else {
  onAuthStateChanged(auth, (user) => boot(user));
}

async function boot(user) {
    cleanup();
    S.user = user; S.profile = null; S.isAdmin = false;
    if (!user) return renderSignIn();
    const email = (user.email || "").toLowerCase();
    const isPassword = user.providerData.some((p) => p.providerId === "password");
    if (isPassword && !user.emailVerified) return renderVerify();
    renderLoading();
    try {
      const [adminSnap] = await Promise.all([getDoc(doc(db, "admins", email)), loadShared()]);
      S.isAdmin = adminSnap.exists();
      if (S.isAdmin) return startAdmin();
      const domain = S.settings.allowedDomain || INSTITUTE_DOMAIN;
      if (domain && !email.endsWith("@" + domain)) return renderWrongDomain(domain);
      const prof = await getDoc(doc(db, "users", user.uid));
      if (!prof.exists()) return renderOnboarding();
      S.profile = prof.data();
      startStudent();
    } catch (e) {
      console.error(e);
      app.innerHTML = `${header()}<main class="wrap narrow"><p class="error-box">Could not load the app (${esc(e.code || e.message)}).
        If you just set up Firebase, check that the security rules are deployed.</p></main>`;
      bindHeader();
    }
}
