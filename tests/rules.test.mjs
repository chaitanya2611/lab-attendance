import { initializeTestEnvironment, assertSucceeds, assertFails } from "@firebase/rules-unit-testing";
import { doc, setDoc, getDoc, getDocs, updateDoc, collection, query, where, writeBatch, serverTimestamp, Timestamp } from "firebase/firestore";
import { readFileSync } from "node:fs";

const env = await initializeTestEnvironment({
  projectId: "labmark-test",
  firestore: { rules: readFileSync(new URL("../firestore.rules", import.meta.url), "utf8"), host: "127.0.0.1", port: 8080 },
});

const LAB = { name: "BB653 Lab", lat: 19.1334, lng: 72.9133, radius: 50, active: true };
LAB.cosLat = Math.cos(LAB.lat * Math.PI / 180);
const istDate = (d = new Date()) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);

await env.withSecurityRulesDisabled(async (c) => {
  const db = c.firestore();
  await setDoc(doc(db, "admins/boss@iitb.ac.in"), { x: 1 });
  await setDoc(doc(db, "labs/lab1"), LAB);
  await setDoc(doc(db, "config/settings"), { allowedDomain: "iitb.ac.in" });
});

const stu = env.authenticatedContext("u1", { email: "stu@iitb.ac.in", email_verified: true }).firestore();
const other = env.authenticatedContext("u2", { email: "x@gmail.com", email_verified: true }).firestore();
const boss = env.authenticatedContext("b1", { email: "boss@iitb.ac.in", email_verified: true }).firestore();
const img = "data:image/jpeg;base64," + "A".repeat(30000);
let pass = 0, fail = 0;
async function t(name, p) { try { await p; console.log("ok  ", name); pass++; } catch (e) { console.log("FAIL", name, e.message.split("\n")[0]); fail++; } }

await t("wrong domain cannot create profile", assertFails(setDoc(doc(other, "users/u2"), { uid: "u2", email: "x@gmail.com", name: "X", rollNo: "24M0001", createdAt: serverTimestamp() })));
const unverified = env.authenticatedContext("u7", { email: "new@iitb.ac.in", email_verified: false }).firestore();
await t("unverified email cannot create profile", assertFails(setDoc(doc(unverified, "users/u7"), { uid: "u7", email: "new@iitb.ac.in", name: "N", rollNo: "24M0007", createdAt: serverTimestamp() })));
await t("student creates profile", assertSucceeds(setDoc(doc(stu, "users/u1"), { uid: "u1", email: "stu@iitb.ac.in", name: "Stu Dent", rollNo: "24M1234", createdAt: serverTimestamp() })));
await t("student cannot change roll no", assertFails(updateDoc(doc(stu, "users/u1"), { rollNo: "24M9999" })));
await t("student reads own admin doc (absent)", assertSucceeds(getDoc(doc(stu, "admins/stu@iitb.ac.in"))));
await t("student cannot list admins", assertFails(getDocs(collection(stu, "admins"))));
await t("student cannot make self admin", assertFails(setDoc(doc(stu, "admins/stu@iitb.ac.in"), { x: 1 })));
await t("student reads labs+settings", assertSucceeds(getDoc(doc(stu, "labs/lab1"))));
await t("student cannot edit lab", assertFails(updateDoc(doc(stu, "labs/lab1"), { radius: 5000 })));

const base = (lat, lng, extra = {}) => ({
  uid: "u1", email: "stu@iitb.ac.in", name: "Stu Dent", rollNo: "24M1234", labId: "lab1", labName: "BB653 Lab",
  date: istDate(), inAt: serverTimestamp(), inLat: lat, inLng: lng, inAcc: 12, inDist: 5, status: "open", ua: "test", ...extra,
});
function checkIn(db, id, data) {
  const b = writeBatch(db);
  b.set(doc(db, "sessions", id), data);
  b.set(doc(db, "photos", id + "_in"), { uid: "u1", sessionId: id, kind: "in", img, at: serverTimestamp() });
  return b.commit();
}
await t("check-in 400 m away is rejected", assertFails(checkIn(stu, "s0", base(19.1370, 72.9133))));
await t("check-in with client-made time rejected", assertFails(checkIn(stu, "s0", base(19.1334, 72.9133, { inAt: Timestamp.fromDate(new Date(Date.now() - 3600e3)) }))));
await t("check-in with wrong date rejected", assertFails(checkIn(stu, "s0", base(19.1334, 72.9133, { date: "2020-01-01" }))));
await t("check-in with someone else's roll rejected", assertFails(checkIn(stu, "s0", base(19.1334, 72.9133, { rollNo: "24M0000" }))));
await t("check-in 30 m away succeeds", assertSucceeds(checkIn(stu, "s1", base(19.13367, 72.9133))));
await t("other user cannot read the session", assertFails(getDoc(doc(other, "sessions/s1"))));
await t("other user cannot read the photo", assertFails(getDoc(doc(other, "photos/s1_in"))));
await t("student reads own sessions by query", assertSucceeds(getDocs(query(collection(stu, "sessions"), where("uid", "==", "u1")))));
await t("student cannot list all sessions", assertFails(getDocs(collection(stu, "sessions"))));
await t("student cannot overwrite photo", assertFails(setDoc(doc(stu, "photos/s1_in"), { uid: "u1", sessionId: "s1", kind: "in", img, at: serverTimestamp() })));
await t("student cannot backdate check-in", assertFails(updateDoc(doc(stu, "sessions/s1"), { inAt: Timestamp.fromDate(new Date(Date.now() - 7200e3)) })));

function checkOut(db, lat, lng) {
  const b = writeBatch(db);
  b.update(doc(db, "sessions/s1"), { status: "closed", outAt: serverTimestamp(), outLat: lat, outLng: lng, outAcc: 10, outDist: 3 });
  b.set(doc(db, "photos/s1_out"), { uid: "u1", sessionId: "s1", kind: "out", img, at: serverTimestamp() });
  return b.commit();
}
await t("check-out from far away rejected", assertFails(checkOut(stu, 19.14, 72.92)));
await t("check-out inside succeeds", assertSucceeds(checkOut(stu, 19.1334, 72.9134)));
await t("cannot check out twice", assertFails(updateDoc(doc(stu, "sessions/s1"), { outAt: serverTimestamp() })));

await t("manager lists sessions by date", assertSucceeds(getDocs(query(collection(boss, "sessions"), where("date", ">=", "2026-01-01"), where("date", "<=", "2099-01-01")))));
await t("manager reads photos", assertSucceeds(getDoc(doc(boss, "photos/s1_in"))));
await t("manager lists users", assertSucceeds(getDocs(collection(boss, "users"))));
await t("manager edits lab", assertSucceeds(setDoc(doc(boss, "labs/lab2"), { ...LAB, name: "Wet lab" })));
await t("manager adds admin", assertSucceeds(setDoc(doc(boss, "admins/ta@iitb.ac.in"), { addedBy: "boss" })));

console.log(`\n${pass} passed, ${fail} failed`);
await env.cleanup();
process.exit(fail ? 1 : 0);
