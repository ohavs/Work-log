// Is a shift still open?
//
// settings.activeShift is a MIRROR of the open shift, kept so the reminder
// senders can watch for a forgotten clock-out while the app is closed. The
// authoritative record is the entries, and a mirror can go stale: a push that
// never landed, an older app version, a settings merge that put a finished
// shift back. Believing the mirror over the record is what woke someone at
// 20:00 to ask about a shift they had ended at 17:00 — twice, and the second
// time a different person.
//
// Shared by both senders (the Cloudflare worker and the GitHub Actions
// script) rather than written twice. They already disagreed about which
// reminders exist; they should not also disagree about whether someone is at
// work. No imports, so it loads in a Worker and in Node alike.

// A closed shift leaves behind a work entry stamped with that shift's own
// start: the app derives the entry's date and start time from it, so an exact
// match on both identifies the shift that was clocked out. Newer app versions
// also record shiftStart on the entry, which says the same thing without
// needing to know the timezone at all.
export function shiftClosedByEntries(entries, startMs, tz) {
  const start = Number(startMs) || 0;
  if (!Array.isArray(entries) || !start) return false;
  const isWorkEntry = (e) => e && (e.type || 'work') === 'work';
  if (entries.some((e) => isWorkEntry(e) && Number(e.shiftStart) === start)) return true;
  // tz is minutes east of UTC. It's written whenever a device subscribes to
  // push, so it's present for exactly the users these senders can reach.
  const d = new Date(start + (Number(tz) || 0) * 60000);
  const pad = (n) => String(n).padStart(2, '0');
  const date = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  const hhmm = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
  return entries.some((e) => isWorkEntry(e) && e.date === date && e.start === hhmm);
}

// The open shift, or null when what the settings claim has already been
// closed. A stale shift doesn't only send a false "did you forget to clock
// out?" — it also suppresses the DAILY reminder, which reads an open shift as
// "already clocked in today". So both senders resolve it through here, once,
// instead of reading settings.activeShift directly.
export function openShiftOf(data, tz) {
  const act = (data && data.settings && data.settings.activeShift) || null;
  if (!act || !Number(act.start)) return null;
  const entries = Array.isArray(data && data.entries) ? data.entries : [];
  return shiftClosedByEntries(entries, act.start, tz) ? null : act;
}
