// Which days are work days, and how many hours a given month really asks for.
//
// A monthly target like 182 hours is an *average*: 42h/week × 52 weeks ÷ 12
// months. No real month is average — some have 23 work days, some 19, and a
// month with Rosh Hashana and Sukkot in it has fewer still. Comparing every
// month against the same flat 182 shows a false shortfall in short months and
// a false surplus in long ones.
//
// So the target is built bottom-up instead: one day's hours (from the weekly
// or monthly goal, see dailyHourTargetOf) × the days in that specific month
// that are actually work days — not an off weekday (settings.offDays) and not
// an Israeli public holiday. Everything that asks "is this a work day?" or
// "what's the target?" — the report, the weekly breakdown, the global-salary
// shortfall, vacation marking, reminders — asks here, so they can't disagree.
//
// Holidays come from the device's own Hebrew calendar (Intl), not a list
// someone has to keep updating: it's right for any year, past or future.

import { toISO } from './util.js';

// Public holidays on which work is not done by law (חוק שעות עבודה ומנוחה /
// פקודת סדרי השלטון והמשפט), as [Hebrew month, day, name]. Yom HaAtzmaut moves
// around a weekend, so it's handled on its own below.
const FIXED_HOLIDAYS = [
  ['Tishri', 1, 'ראש השנה'],
  ['Tishri', 2, 'ראש השנה ב׳'],
  ['Tishri', 10, 'יום כיפור'],
  ['Tishri', 15, 'סוכות'],
  ['Tishri', 22, 'שמיני עצרת'],
  ['Nisan', 15, 'פסח'],
  ['Nisan', 21, 'שביעי של פסח'],
  ['Sivan', 6, 'שבועות'],
];

let hebFmt = null;
// { month: 'Tishri', day: 1 } for a Gregorian date. English month names on
// purpose: they're ICU's stable identifiers, unlike the localised Hebrew ones.
function hebrewDate(date) {
  if (!hebFmt) hebFmt = new Intl.DateTimeFormat('en-u-ca-hebrew', { month: 'long', day: 'numeric' });
  let month = '', day = 0;
  for (const p of hebFmt.formatToParts(date)) {
    if (p.type === 'month') month = p.value;
    else if (p.type === 'day') day = Number(p.value);
  }
  return { month, day };
}

const yearCache = new Map();
// Map of ISO date → holiday name for every holiday in Gregorian year `y`.
export function israeliHolidays(y) {
  if (yearCache.has(y)) return yearCache.get(y);
  const out = new Map();
  try {
    let iyar5 = null;
    for (let d = new Date(y, 0, 1, 12); d.getFullYear() === y; d.setDate(d.getDate() + 1)) {
      const h = hebrewDate(d);
      const hit = FIXED_HOLIDAYS.find(([mo, day]) => mo === h.month && day === h.day);
      if (hit) out.set(toISO(d), hit[2]);
      if (h.month === 'Iyar' && h.day === 5) iyar5 = new Date(d);
    }
    // Yom HaAtzmaut is 5 Iyar, moved so it never touches Shabbat: Friday or
    // Saturday → the Thursday before; Monday → Tuesday (so the Memorial Day
    // before it isn't on a Sunday, right after Shabbat).
    if (iyar5) {
      const shift = { 5: -1, 6: -2, 1: 1 }[iyar5.getDay()] || 0;
      iyar5.setDate(iyar5.getDate() + shift);
      out.set(toISO(iyar5), 'יום העצמאות');
    }
  } catch {
    // No Hebrew calendar on this device (very old WebView): fall back to
    // weekdays only rather than breaking every report.
  }
  yearCache.set(y, out);
  return out;
}

export function holidayName(date) { return israeliHolidays(date.getFullYear()).get(toISO(date)) || ''; }

function offDaysOf(settings) { return Array.isArray(settings && settings.offDays) ? settings.offDays : []; }
// Holidays count as days off unless turned off in the settings (e.g. for
// someone whose job runs on holidays). On by default.
function holidaysOff(settings) { return !(settings && settings.holidaysOff === false); }

// A day you're expected to work: not an off weekday, not a public holiday.
export function isWorkday(date, settings) {
  if (offDaysOf(settings).includes(date.getDay())) return false;
  if (holidaysOff(settings) && holidayName(date)) return false;
  return true;
}

// Hours expected on one work day. From the weekly goal when there is one
// (44h over Sun–Thu = 8:48/day); otherwise from the monthly goal, read as the
// average month it is — 182h × 12 ÷ 52 = 42h/week, ÷ 5 days = 8.4h/day.
export function dailyHourTargetOf(settings) {
  const perWeek = Math.max(1, 7 - offDaysOf(settings).length);
  const goalW = Number(settings && settings.goalWeekHours) || 0;
  if (goalW) return goalW / perWeek;
  const goalM = Number(settings && settings.goalHours) || 0;
  if (goalM) return (goalM * 12) / 52 / perWeek;
  return 0;
}

// Everything about month (y, m)'s target: its work days, the holidays that
// fell on what would have been a work day, the daily rate, and the total.
// The monthly goal (settings.goalHours), when set, is a ceiling: a short
// month asks for its real work days' worth, a long one never more than it.
// With no monthly goal the month's own work days are the target.
export function monthQuota(settings, y, m) {
  const daily = dailyHourTargetOf(settings);
  const off = offDaysOf(settings);
  const days = new Date(y, m + 1, 0).getDate();
  let workdays = 0;
  const holidays = [];
  for (let d = 1; d <= days; d++) {
    const date = new Date(y, m, d, 12);
    if (off.includes(date.getDay())) continue;
    const name = holidaysOff(settings) ? holidayName(date) : '';
    if (name) holidays.push({ date: toISO(date), name });
    else workdays++;
  }
  const full = daily * workdays;
  const ceiling = Number(settings && settings.goalHours) || 0;
  const capped = ceiling > 0 && full > ceiling;
  // factor scales per-week goals so the weeks still add up to the month.
  return { daily, workdays, holidays, hours: capped ? ceiling : full, capped, ceiling, factor: capped && full ? ceiling / full : 1 };
}
