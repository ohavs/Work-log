// What the app should notify about, and when.
//
// On the web this can only happen while something is running: a tab that's
// open, or the Cloudflare worker pushing to a service worker. The Android
// build doesn't need either — Android's alarm manager will wake the app at a
// time agreed in advance, with the app closed and the phone offline. That is
// the single biggest thing a real app buys over a web page here.
//
// The catch is that the alarm is agreed in ADVANCE, so conditions the system
// can't evaluate ("only if no hours were logged that day") have to be decided
// when the schedule is built. So the schedule is rebuilt from scratch every
// time the data changes or the app comes back to the foreground, and it
// reaches far enough ahead (30 days) that an app left unopened still gets its
// reminders.
//
// plan() is pure — no plugin, no clock, no storage — so every rule below can
// be checked without a phone.

export const PLAN_DAYS = 30;

const pad2 = (n) => String(n).padStart(2, '0');
const iso = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const hhmm = (s, fallback) => {
  const [h, m] = String(s || fallback).split(':').map(Number);
  return { h: Number.isFinite(h) ? h : 0, m: Number.isFinite(m) ? m : 0 };
};

// A stable 31-bit id per notification key. Stable matters: rebuilding the
// schedule has to land on the same ids, or every rebuild would stack a second
// copy of the same reminder on top of the first.
export function idFor(key) {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = ((h << 5) - h + key.charCodeAt(i)) | 0;
  return Math.abs(h) % 2147483647 || 1;
}

function at(date, { h, m }) {
  const d = new Date(date);
  d.setHours(h, m, 0, 0);
  return d.getTime();
}

export function plan({ settings = {}, entries = [], notes = [], activeShift = null, now = Date.now(), days = PLAN_DAYS } = {}) {
  const out = [];
  const nowMs = typeof now === 'number' ? now : new Date(now).getTime();
  const today = new Date(nowMs);
  const push = (key, when, title, body) => {
    // Nothing in the past: Android fires a past-dated alarm immediately,
    // which would mean a burst of stale reminders on every rebuild.
    if (when <= nowMs) return;
    out.push({ id: idFor(key), key, at: when, title, body });
  };

  // ---- 1. the daily "you haven't logged anything today" reminder ----
  if (settings.reminder) {
    const time = hhmm(settings.reminderTime, '18:00');
    const offDays = Array.isArray(settings.offDays) ? settings.offDays : [];
    const datesWithEntries = new Set(entries.filter((e) => e && e.date).map((e) => e.date));
    for (let i = 0; i <= days; i++) {
      const d = new Date(today);
      d.setDate(today.getDate() + i);
      if (offDays.includes(d.getDay())) continue;
      const dISO = iso(d);
      // Already logged that day — the reminder would be nagging about work
      // that's already recorded. Only ever true for today and the past, but
      // stated as a rule rather than a special case.
      if (datesWithEntries.has(dISO)) continue;
      // Clocked in right now means today is handled, whatever the clock says.
      if (i === 0 && activeShift) continue;
      push(`daily-${dISO}`, at(d, time), 'שעון עבודה', 'עוד לא רשמת שעות היום — הקש כדי להזין');
    }
  }

  // ---- 2. an open shift that's gone on too long ----
  if (activeShift && activeShift.start) {
    const start = new Date(activeShift.start).getTime();
    if (Number.isFinite(start)) {
      const remindH = Number(settings.shiftRemindHours) || 9;
      const maxH = Number(settings.shiftMaxHours) || 12;
      push(`shift-remind-${start}`, start + remindH * 3600000,
        'עדיין בעבודה?', `המשמרת פתוחה כבר מעל ${remindH} שעות — לא שכחת להחתים יציאה?`);
      push(`shift-max-${start}`, start + maxH * 3600000,
        'המשמרת נסגרה אוטומטית', `עברו ${maxH} שעות — סגרנו את המשמרת. פתח את האפליקציה לבדיקה ותיקון`);
    }
  }

  // ---- 3. note reminders ----
  const horizon = nowMs + days * 86400000;
  for (const nt of notes) {
    if (!nt || !nt.id) continue;
    const title = String(nt.title || '').trim() || 'תזכורת';
    const body = String(nt.body || '').trim() || 'יש לך תזכורת בפנקס';

    // one-off
    const once = Number(nt.remindAt) || 0;
    if (once) push(`note-${nt.id}-${once}`, once, title, body);

    // weekly, on chosen weekdays at a chosen time
    const r = nt.remind;
    if (r && r.mode === 'weekly' && Array.isArray(r.days) && r.days.length && r.time) {
      const time = hhmm(r.time, '09:00');
      for (let i = 0; i <= days; i++) {
        const d = new Date(today);
        d.setDate(today.getDate() + i);
        if (!r.days.includes(d.getDay())) continue;
        const when = at(d, time);
        if (when > horizon) break;
        push(`noteweekly-${nt.id}-${iso(d)}`, when, title, body);
      }
    }
  }

  return out.sort((a, b) => a.at - b.at);
}
