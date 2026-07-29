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
    dow: d.getUTCDay(),
  };
}

async function sendAll(subs, payloadObj) {
  const payload = JSON.stringify(payloadObj);
  let ok = 0;
  for (const sub of subs) {
    try { await webpush.sendNotification(sub, payload); ok++; }
    catch (err) { console.warn('push failed', err && err.statusCode, (sub.endpoint || '').slice(0, 40)); }
  }
  return ok;
}

async function run() {
  const snap = await db.collectionGroup('data').get();
  const mains = snap.docs.filter((d) => d.ref.id === 'main');
  let sent = 0, tested = 0;
  console.log(`found ${mains.length} user doc(s); now=${new Date().toISOString()}`);

  for (const doc of mains) {
    const data = doc.data() || {};
    const s = data.settings || {};
    const subs = Array.isArray(data.pushSubs) ? data.pushSubs : [];
    const testAt = Number(s.pushTestAt) || 0;
    // diagnostics (no secrets / endpoints)
    console.log(`- user: subs=${subs.length} reminder=${!!s.reminder} time=${s.reminderTime || '?'} tz=${s.tz ?? '?'} testAt=${testAt ? new Date(testAt).toISOString() : 'none'} entries=${Array.isArray(data.entries) ? data.entries.length : 0}`);
    if (subs.length === 0) { console.log('  → skip: no push subscription synced (open the app while signed in, enable the reminder)'); continue; }

    const notifRef = doc.ref.parent.doc('notif');
    const notif = (await notifRef.get()).data() || {};
    const { date, minutes, dow } = localParts(s.tz);

    // 1) explicit test push requested from the app — bypasses time/logged checks
    if (testAt && Date.now() >= testAt && notif.testSent !== testAt) {
      const ok = await sendAll(subs, { title: 'בדיקת התראה ✓', body: 'ההתראות עובדות — גם כשהאפליקציה סגורה', tag: 'wl-test-' + testAt });
      console.log(`  → test push sent to ${ok}/${subs.length} device(s)`);
      if (ok > 0) { await notifRef.set({ testSent: testAt }, { merge: true }); tested++; }
    } else if (testAt) {
      console.log(`  → test pending: due=${Date.now() >= testAt} alreadySent=${notif.testSent === testAt}`);
    }

    // 2) per-note reminders (independent of the daily-reminder toggle)
    const notes = Array.isArray(data.notes) ? data.notes : [];
    const noteState = notif.noteReminders || {};
    for (const nt of notes) {
      const at = Number(nt && nt.remindAt) || 0;
      if (!at || Date.now() < at || noteState[nt.id] === at) continue; // not due / already sent
      const title = (nt.title || '').trim() || 'תזכורת';
      const body = (nt.body || '').trim() || 'יש לך תזכורת בפנקס';
      const ok = await sendAll(subs, { title, body, tag: 'wl-note-' + nt.id + '-' + at });
      console.log(`  → note reminder "${title.slice(0, 20)}" sent to ${ok}/${subs.length}`);
      if (ok > 0) { await notifRef.set({ noteReminders: { [nt.id]: at } }, { merge: true }); sent++; }
    }

    // 2b) per-note reminders — weekly recurring (same send window/dedup style as the daily reminder)
    const noteWeekly = notif.noteWeekly || {};
    for (const nt of notes) {
      const r = nt && nt.remind;
      if (!r || r.mode !== 'weekly' || !Array.isArray(r.days) || !r.days.length || !r.time) continue;
      if (!r.days.includes(dow) || noteWeekly[nt.id] === date) continue;
      const [rh2, rm2] = String(r.time).split(':').map(Number);
      const target2 = (rh2 || 0) * 60 + (rm2 || 0);
      if (minutes < target2 || minutes >= target2 + WINDOW_MIN) continue;
      const title = (nt.title || '').trim() || 'תזכורת';
      const body = (nt.body || '').trim() || 'יש לך תזכורת בפנקס';
      const ok = await sendAll(subs, { title, body, tag: 'wl-noteweekly-' + nt.id + '-' + date });
      console.log(`  → weekly note reminder "${title.slice(0, 20)}" sent to ${ok}/${subs.length}`);
      if (ok > 0) { await notifRef.set({ noteWeekly: { [nt.id]: date } }, { merge: true }); sent++; }
    }

    // 3) the daily reminder
    if (!s.reminder) continue;
    const [rh, rm] = String(s.reminderTime || '18:00').split(':').map(Number);
    const target = (rh || 0) * 60 + (rm || 0);
    if (minutes < target || minutes >= target + WINDOW_MIN) continue; // not in the send window
    if (s.activeShift && Number(s.activeShift.start)) continue;      // already clocked in
    if (Array.isArray(s.offDays) && s.offDays.includes(dow)) continue; // marked as a non-work day
    const entries = Array.isArray(data.entries) ? data.entries : [];
    if (entries.some((e) => e && e.date === date)) continue;        // already logged today
    if (notif.lastSent === date) continue;                          // once per day

    const ok = await sendAll(subs, { title: 'שעון עבודה', body: 'עוד לא רשמת שעות היום — הקש כדי להזין', tag: 'wl-daily-' + date });
    if (ok > 0) { await notifRef.set({ lastSent: date }, { merge: true }); sent++; }
  }
  console.log(`reminders: sent ${sent}, tests ${tested}`);
}

run().catch((e) => { console.error(e); process.exit(1); });
