// Daily work-hours reminder sender — runs on a GitHub Actions schedule.
// For each user with reminders on, sends a Web Push when their local reminder
// time has passed and they haven't logged anything today (once per day).
//
// Env: FIREBASE_SERVICE_ACCOUNT (JSON), VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT
import admin from 'firebase-admin';
import webpush from 'web-push';

const svc = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');
if (!svc.project_id) { console.error('Missing FIREBASE_SERVICE_ACCOUNT'); process.exit(1); }
admin.initializeApp({ credential: admin.credential.cert(svc) });
const db = admin.firestore();

webpush.setVapidDetails(
  process.env.VAPID_SUBJECT || 'mailto:reminders@example.com',
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY,
);

const WINDOW_MIN = 90; // send within this many minutes after the target time
const pad = (n) => String(n).padStart(2, '0');

function localParts(tzMinutes) {
  const d = new Date(Date.now() + (Number(tzMinutes) || 0) * 60000);
  return {
    date: `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`,
    minutes: d.getUTCHours() * 60 + d.getUTCMinutes(),
  };
}

async function run() {
  const snap = await db.collectionGroup('data').get();
  const mains = snap.docs.filter((d) => d.ref.id === 'main');
  let sent = 0, checked = 0;

  for (const doc of mains) {
    const data = doc.data() || {};
    const s = data.settings || {};
    const subs = Array.isArray(data.pushSubs) ? data.pushSubs : [];
    if (!s.reminder || subs.length === 0) continue;
    checked++;

    const [rh, rm] = String(s.reminderTime || '18:00').split(':').map(Number);
    const target = (rh || 0) * 60 + (rm || 0);
    const { date, minutes } = localParts(s.tz);
    if (minutes < target || minutes >= target + WINDOW_MIN) continue; // not in the send window

    // already logged something today?
    const entries = Array.isArray(data.entries) ? data.entries : [];
    if (entries.some((e) => e && e.date === date)) continue;

    // once per day: dedupe via a cron-owned sibling doc
    const notifRef = doc.ref.parent.doc('notif');
    const notif = (await notifRef.get()).data() || {};
    if (notif.lastSent === date) continue;

    const payload = JSON.stringify({ title: 'שעון עבודה', body: 'עוד לא רשמת שעות היום — הקש כדי להזין' });
    let ok = 0;
    for (const sub of subs) {
      try { await webpush.sendNotification(sub, payload); ok++; }
      catch (err) { console.warn('push failed', err && err.statusCode, (sub.endpoint || '').slice(0, 40)); }
    }
    if (ok > 0) { await notifRef.set({ lastSent: date }, { merge: true }); sent++; }
  }
  console.log(`reminders: checked ${checked} user(s), sent ${sent}`);
}

run().catch((e) => { console.error(e); process.exit(1); });
