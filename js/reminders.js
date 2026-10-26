// What the app should notify about, and when.
//
// On the web this can only happen while a tab of ours is open — see
// dueNotes() at the bottom, which the foreground loop polls. The Android
// build doesn't need anything running: Android's alarm manager wakes the app
// at a time agreed in advance, with the app closed and the phone offline.
// That is the single biggest thing a real app buys over a web page here.
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

// The two alarm ids belonging to one shift. Exported so clocking out can take
// them back directly, by id, instead of waiting for a whole-schedule rebuild
// to notice the shift is gone — see setActive() in app.js.
export function shiftAlarmIds(start) {
  const t = new Date(start).getTime();
  if (!Number.isFinite(t)) return [];
  return [idFor(`shift-remind-${t}`), idFor(`shift-max-${t}`)];
}

function at(date, { h, m }) {
  const d = new Date(date);
  d.setHours(h, m, 0, 0);
  return d.getTime();
}

// A note's title and body as a notification would word them.
function noteText(nt) {
  return {
    title: String(nt.title || '').trim() || 'תזכורת',
    body: String(nt.body || '').trim() || 'יש לך תזכורת בפנקס',
  };
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
    const { title, body } = noteText(nt);

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

// The note reminders that came due in (after, until] — what the web build
// shows, since nothing there can wake a closed tab. The foreground loop calls
// this every minute with the time of its previous call.
//
// A tab that was asleep (laptop lid, background tab) comes back with a window
// hours wide, so the catch-up is capped: a reminder older than that is stale
// enough that announcing it would be noise, not news.
export const MAX_CATCH_UP_MS = 6 * 3600000;

export function dueNotes({ notes = [], after = 0, until = Date.now(), maxCatchUp = MAX_CATCH_UP_MS } = {}) {
  const out = [];
  const from = Math.max(Number(after) || 0, until - maxCatchUp);
  if (!(until > from)) return out;
  const due = (t) => t > from && t <= until;

  for (const nt of notes) {
    if (!nt || !nt.id) continue;
    const { title, body } = noteText(nt);

    const once = Number(nt.remindAt) || 0;
    if (once && due(once)) out.push({ id: idFor(`note-${nt.id}-${once}`), key: `note-${nt.id}-${once}`, at: once, title, body });

    const r = nt.remind;
    if (r && r.mode === 'weekly' && Array.isArray(r.days) && r.days.length && r.time) {
      const time = hhmm(r.time, '09:00');
      // Walk the days the window touches — usually one, more only after a
      // long sleep. Start a day early so a window that opens just after
      // midnight still sees yesterday evening's reminder.
      for (let d = new Date(from - 86400000); d.getTime() <= until + 86400000; d.setDate(d.getDate() + 1)) {
        if (!r.days.includes(d.getDay())) continue;
        const when = at(d, time);
        if (!due(when)) continue;
        const key = `noteweekly-${nt.id}-${iso(d)}`;
        out.push({ id: idFor(key), key, at: when, title, body });
      }
    }
  }

  return out.sort((a, b) => a.at - b.at);
}
