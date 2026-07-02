// Hebrew names & date/time helpers

export const MONTHS = [
  'ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני',
  'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר'
];

export const DOW = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];

// Entry types
export const TYPE_META = {
  work:     { label: 'עבודה', emoji: '💼' },
  vacation: { label: 'חופשה', emoji: '🏖️' },
  sick:     { label: 'מחלה', emoji: '🤒' },
};
export function entryType(e) { return e.type && TYPE_META[e.type] ? e.type : 'work'; }
export function isWork(e) { return entryType(e) === 'work'; }

// "2026-07-02" -> local Date (noon, avoids TZ edge cases)
export function parseDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d, 12, 0, 0);
}

export function toISO(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function todayISO() {
  return toISO(new Date());
}

// "HH:MM" -> minutes since midnight
export function timeToMin(t) {
  if (!t) return null;
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

// minutes since midnight -> "HH:MM"
export function minToTime(mins) {
  const m = ((mins % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

// Worked minutes for an entry (handles crossing midnight + break)
export function workedMinutes(entry) {
  if (entry.type && entry.type !== 'work') return 0; // vacation / sick = no worked hours
  const s = timeToMin(entry.start);
  let e = timeToMin(entry.end);
  if (s == null || e == null) return 0;
  if (e < s) e += 1440; // overnight shift (equal times = 0, not 24h)
  const net = e - s - (Number(entry.breakMin) || 0);
  return Math.max(0, net);
}

// minutes -> "7:30" style hours label
export function fmtHours(mins) {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${h}:${String(m).padStart(2, '0')}`;
}

// minutes -> decimal hours (for pay), e.g. 90 -> 1.5
export function decimalHours(mins) {
  return mins / 60;
}

export function fmtMoney(amount, currency = '₪') {
  const rounded = Math.round(amount * 100) / 100;
  const str = Number.isInteger(rounded) ? rounded.toLocaleString('he-IL')
    : rounded.toLocaleString('he-IL', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${currency}${str}`;
}

export function monthKey(year, month) {
  return `${year}-${String(month + 1).padStart(2, '0')}`;
}

// entry belongs to given year/month?
export function inMonth(entry, year, month) {
  return entry.date.startsWith(monthKey(year, month));
}

export function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// ISO date of the Sunday that starts the week containing `date` (week: Sun–Sat)
export function weekStartISO(date) {
  const d = new Date(date);
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() - d.getDay()); // back to Sunday
  return toISO(d);
}

// "6–12 ביולי" style label for a week starting at Sunday `iso`
export function weekLabel(iso) {
  const start = parseDate(iso);
  const end = new Date(start);
  end.setDate(end.getDate() + 6);
  if (start.getMonth() === end.getMonth()) {
    return `${start.getDate()}–${end.getDate()} ב${MONTHS[start.getMonth()]}`;
  }
  return `${start.getDate()} ב${MONTHS[start.getMonth()]} – ${end.getDate()} ב${MONTHS[end.getMonth()]}`;
}
