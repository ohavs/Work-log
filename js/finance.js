// Pure financial/insight calculations for the "עוד" page.
// All amounts are estimates (משוער). Israeli-style defaults, fully configurable.
import { workedMinutes, decimalHours, entryType, isWork, inMonth, parseDate, MONTHS } from './util.js';

export const DEFAULT_PAYROLL = {
  payMode: 'hourly',      // 'hourly' | 'global' — 'global' pays a fixed monthly salary regardless of hours actually worked
  globalSalary: 0,        // קבוע חודשי (₪), used when payMode === 'global'
  incomeTax: 0,          // מס הכנסה — אחוז אפקטיבי
  socialHealth: 3.5,     // ביטוח לאומי + בריאות (עובד)
  pensionEmployee: 6,    // הפרשת עובד לפנסיה
  pensionEmployer: 6.5,  // הפרשת מעסיק לפנסיה
  severance: 8.33,       // פיצויים (מעסיק)
  overtime: false,       // חישוב שעות נוספות לפי חוק
  otThreshold: 8,        // שעות רגילות ליום
  recreationDayRate: 418,// מחיר יום הבראה (₪)
  recreationDays: 5,     // ימי הבראה בשנה
  annualVacationDays: 12,// ימי חופשה שנתיים
  sickDayHours: 8.4,     // שעות מזוכות ליום מחלה (יום בתשלום) — 8:24
  travelMode: 'none',    // 'none' | 'perDay' | 'monthly' — only one travel calculation is ever active
  travelPerDay: 0,       // החזר נסיעות ליום עבודה (₪), used when travelMode === 'perDay'
  travelMonthly: 0,      // סכום נסיעות חודשי קבוע (₪), used when travelMode === 'monthly'
};

export function payrollOf(settings) {
  const p = { ...DEFAULT_PAYROLL, ...(settings.payroll || {}) };
  // Back-compat: users who set a per-day travel amount before travelMode
  // existed had no way to record a mode — infer 'perDay' so their existing
  // value keeps working exactly as before, without needing to re-select it.
  if (!settings.payroll || settings.payroll.travelMode == null) {
    p.travelMode = p.travelPerDay > 0 ? 'perDay' : 'none';
  }
  return p;
}

export function rateOf(e, settings) {
  if (e.rate != null && e.rate !== '') return Number(e.rate) || 0;
  if (e.jobId && Array.isArray(settings.jobs)) {
    const j = settings.jobs.find((x) => x.id === e.jobId);
    if (j && j.rate !== '' && j.rate != null) return Number(j.rate) || 0;
  }
  return Number(settings.rate) || 0;
}

// --- overtime: split a single day's hours into 100% / 125% / 150% tiers ---
export function splitOvertime(hours, threshold = 8) {
  const reg = Math.min(hours, threshold);
  const t125 = Math.min(Math.max(hours - threshold, 0), 2);
  const t150 = Math.max(hours - threshold - 2, 0);
  return { reg, t125, t150 };
}

// The same workday-aware daily rate the weekly/monthly hour-goal tracking
// elsewhere in the app already uses: weekly goal ÷ actual scheduled workdays
// per week (from settings.offDays), not goal/7 — so a shortfall deduction
// (below) lines up with the same "expected hours" the rest of the app shows.
function dailyHourTargetOf(settings) {
  const goalW = Number(settings.goalWeekHours) || 0;
  if (!goalW) return 0;
  const offDays = Array.isArray(settings.offDays) ? settings.offDays : [];
  const workDaysPerWeek = Math.max(1, 7 - offDays.length);
  return goalW / workDaysPerWeek;
}

// Total hours you're expected to work across calendar month (y, m), given
// the weekly hour goal and which weekdays are marked non-work days. 0 if no
// weekly goal is set (nothing to compare a shortfall against).
function expectedMonthlyHours(settings, y, m) {
  const daily = dailyHourTargetOf(settings);
  if (!daily) return 0;
  const offDays = Array.isArray(settings.offDays) ? settings.offDays : [];
  const daysInMonth = new Date(y, m + 1, 0).getDate();
  let scheduled = 0;
  for (let d = 1; d <= daysInMonth; d++) { if (!offDays.includes(new Date(y, m, d).getDay())) scheduled++; }
  return daily * scheduled;
}

// ---------------------------------------------------------------- sick pay
// חוק דמי מחלה: within one illness, the first day is unpaid, the second and
// third are paid at half, and from the fourth day on in full.
export const SICK_PAY_LADDER = [0, 0.5, 0.5];
export function sickPayFactor(dayInEpisode) {
  if (!(dayInEpisode >= 1)) return 0;
  return dayInEpisode <= SICK_PAY_LADDER.length ? SICK_PAY_LADDER[dayInEpisode - 1] : 1;
}

// True when nothing but non-working days separates two sick days. Being off
// sick on Thursday and again on Sunday, with Friday and Saturday not worked,
// is one illness — not two first days, each of them unpaid. Any other gap
// means recovering and falling ill again, which the ladder restarts for.
function onlyOffDaysBetween(aISO, bISO, off) {
  const a = parseDate(aISO), b = parseDate(bISO);
  const gap = Math.round((b - a) / 86400000);
  if (gap <= 0) return false;
  if (gap === 1) return true;
  // A long gap is a new illness however the days in it fall — without this,
  // someone whose whole week is off-days would have every sick day they ever
  // record treated as one unbroken illness.
  if (gap > 7) return false;
  for (let i = 1; i < gap; i++) {
    const d = new Date(a); d.setDate(a.getDate() + i);
    if (!off.includes(d.getDay())) return false;
  }
  return true;
}

// Which day of an illness each recorded sick day is.
//
// Deliberately takes ALL entries, not one month's: the ladder counts within
// an illness, so an illness running from the 30th to the 2nd has its fourth
// day in the following month, and a month looked at in isolation would pay
// that day as a first day — unpaid.
export function sickDayIndex(entries, settings) {
  const off = Array.isArray(settings && settings.offDays) ? settings.offDays : [];
  const dates = [...new Set(entries.filter((e) => entryType(e) === 'sick' && e.date).map((e) => e.date))].sort();
  const out = new Map();
  let idx = 0, prev = null;
  for (const d of dates) {
    idx = prev && onlyOffDaysBetween(prev, d, off) ? idx + 1 : 1;
    out.set(d, idx);
    prev = d;
  }
  return out;
}

// One month's sick days, each with the day of the illness it is and what that
// pays — the detail the reports page shows, and the same numbers grossForMonth
// bills from.
export function sickMonth(entries, settings, y, m) {
  const p = payrollOf(settings);
  const idx = sickDayIndex(entries, settings);
  const perDay = Number(p.sickDayHours) || 0;
  const days = entries
    .filter((e) => entryType(e) === 'sick' && inMonth(e, y, m))
    .sort((a, b) => String(a.date).localeCompare(String(b.date)))
    .map((e) => {
      const dayInEpisode = idx.get(e.date) || 1;
      const factor = sickPayFactor(dayInEpisode);
      const rate = p.payMode === 'global' ? 0 : rateOf(e, settings);
      return { date: e.date, dayInEpisode, factor, hours: perDay * factor, pay: perDay * factor * rate };
    });
  return {
    days,
    count: days.length,
    unpaid: days.filter((d) => d.factor === 0).length,
    half: days.filter((d) => d.factor === 0.5).length,
    full: days.filter((d) => d.factor === 1).length,
    paidHours: days.reduce((s, d) => s + d.hours, 0),
    fullHours: perDay * days.length,
    pay: days.reduce((s, d) => s + d.pay, 0),
  };
}

// Gross for a month. With overtime on, tiers are paid 125%/150%.
// Sick days (יום מחלה) are paid days off — credited at a fixed hours/day
// (settings.payroll.sickDayHours, default 8.4h) and taxed like regular income, but
// excluded from the overtime split since no actual shift was worked.
//
// A "global" (משכורת גלובלית) employee is paid a fixed monthly salary that
// doesn't scale UP with extra hours — but a real shortfall below the
// expected monthly hours (weekly goal × scheduled workdays) typically DOES
// reduce pay proportionally, at an hourly-equivalent rate derived from the
// fixed salary itself. Vacation days count as fully "covered" (not a
// shortfall) at that same daily rate, since they're excused, not missed.
// With no weekly goal configured there's nothing to measure a shortfall
// against, so the full fixed amount is paid regardless of hours.
export function grossForMonth(entries, settings, y, m) {
  const p = payrollOf(settings);
  // Sick days are billed from the ladder, not at a flat day's pay — see
  // sickMonth(). Computed from ALL entries so an illness that started last
  // month keeps counting into this one.
  const sick = sickMonth(entries, settings, y, m);
  let hours = 0, vacationDays = 0;
  const sickGross = p.payMode === 'global' ? 0 : sick.pay;
  const dayHours = new Map();
  const dayPayFlat = new Map();
  entries.forEach((e) => {
    if (!inMonth(e, y, m)) return;
    if (isWork(e)) {
      const h = decimalHours(workedMinutes(e));
      hours += h;
      dayHours.set(e.date, (dayHours.get(e.date) || 0) + h);
      if (p.payMode !== 'global') {
        const r = rateOf(e, settings);
        dayPayFlat.set(e.date, (dayPayFlat.get(e.date) || 0) + h * r);
      }
    } else if (entryType(e) === 'sick') {
      // The hours a sick day credits are reported in full — it's a day off
      // that was taken, whatever share of it was paid. What the ladder scales
      // is the money, and (below) how much of the month a global salary
      // counts as covered.
      hours += Number(p.sickDayHours) || 0;
    } else if (entryType(e) === 'vacation') {
      vacationDays++;
    }
  });

  let ot125 = 0, ot150 = 0;
  if (p.overtime) {
    for (const h of dayHours.values()) {
      const { t125, t150 } = splitOvertime(h, p.otThreshold);
      ot125 += t125; ot150 += t150;
    }
  }
  if (p.payMode === 'global') {
    const base = Number(p.globalSalary) || 0; // the cap — gross never exceeds this, no bonus for extra hours
    const expected = expectedMonthlyHours(settings, y, m);
    const dailyTarget = dailyHourTargetOf(settings);
    // Worked + vacation (excused, not a shortfall) + the PAID share of the
    // sick days. A fixed salary is docked for a shortfall, so billing the
    // ladder here is the same thing as paying it: an unpaid first sick day
    // leaves a full day uncovered, a half-paid one leaves half.
    const coveredHours = hours - sick.fullHours + sick.paidHours + vacationDays * dailyTarget;
    const rate = Number(settings.rate) || 0; // the actual configured hourly rate — not a derived salary/hours ratio
    let gross = base;
    if (expected > 0 && coveredHours < expected && rate > 0) {
      gross = Math.max(0, base - (expected - coveredHours) * rate);
    }
    return { gross, hours, ot125, ot150, sick };
  }

  let gross = sickGross;
  for (const [date, h] of dayHours) {
    const flatPay = dayPayFlat.get(date) || 0;
    const avgRate = h > 0 ? flatPay / h : 0;
    if (p.overtime) {
      const { reg, t125, t150 } = splitOvertime(h, p.otThreshold);
      gross += (reg + t125 * 1.25 + t150 * 1.5) * avgRate;
    } else {
      gross += flatPay;
    }
  }
  return { gross, hours, ot125, ot150, sick };
}

// Travel/commute reimbursement for a month — either a fixed ₪ amount per day
// actually worked, or one fixed ₪ amount for the whole month (mutually
// exclusive, per travelMode). Kept separate from gross — untaxed, not
// pensionable — and added straight to net, matching how travel reimbursement
// works in Israeli payroll.
export function travelForMonth(entries, settings, y, m) {
  const p = payrollOf(settings);
  const days = new Set();
  entries.forEach((e) => { if (inMonth(e, y, m) && isWork(e)) days.add(e.date); });
  if (p.travelMode === 'monthly') {
    return { days: days.size, perDay: 0, total: Number(p.travelMonthly) || 0 };
  }
  if (p.travelMode === 'perDay') {
    const perDay = Number(p.travelPerDay) || 0;
    return { days: days.size, perDay, total: days.size * perDay };
  }
  return { days: days.size, perDay: 0, total: 0 };
}

// Estimated payslip: gross → deductions → net (+ untaxed travel reimbursement).
export function payslip(entries, settings, y, m) {
  const p = payrollOf(settings);
  const { gross, hours, ot125, ot150, sick } = grossForMonth(entries, settings, y, m);
  const incomeTax = gross * (p.incomeTax / 100);
  const socialHealth = gross * (p.socialHealth / 100);
  const pension = gross * (p.pensionEmployee / 100);
  const deductions = incomeTax + socialHealth + pension;
  const travel = travelForMonth(entries, settings, y, m).total;
  const net = Math.max(0, gross - deductions) + travel;
  return { gross, hours, ot125, ot150, sick, incomeTax, socialHealth, pension, deductions, travel, net };
}

// Pension accrual for a month (employee + employer + severance).
export function pensionForMonth(entries, settings, y, m) {
  const p = payrollOf(settings);
  const { gross } = grossForMonth(entries, settings, y, m);
  const employee = gross * (p.pensionEmployee / 100);
  const employer = gross * (p.pensionEmployer / 100);
  const severance = gross * (p.severance / 100);
  return { employee, employer, severance, total: employee + employer + severance };
}

// Per-month hours & gross for a whole year → for the yearly chart.
export function yearlyByMonth(entries, settings, y) {
  const rows = [];
  for (let m = 0; m < 12; m++) {
    const { gross, hours } = grossForMonth(entries, settings, y, m);
    rows.push({ month: m, label: MONTHS[m], hours, gross });
  }
  return rows;
}

// Averages for a month (work days only).
export function averages(entries, settings, y, m) {
  const dayHours = new Map();
  entries.forEach((e) => {
    if (!inMonth(e, y, m) || !isWork(e)) return;
    dayHours.set(e.date, (dayHours.get(e.date) || 0) + decimalHours(workedMinutes(e)));
  });
  const days = dayHours.size;
  const totalH = [...dayHours.values()].reduce((s, h) => s + h, 0);
  const avgDay = days ? totalH / days : 0;
  // busiest weekday (0=Sun)
  const byDow = new Array(7).fill(0);
  for (const [date, h] of dayHours) byDow[parseDate(date).getDay()] += h;
  let busiest = -1, max = 0;
  byDow.forEach((h, i) => { if (h > max) { max = h; busiest = i; } });
  const weeks = days ? totalH / Math.max(1, Math.ceil(days / 5)) : 0; // rough weekly avg
  return { days, totalH, avgDay, avgWeek: weeks, busiestDow: busiest };
}

// Vacation balance for a year: entitlement vs used (from vacation entries).
export function vacationBalance(entries, settings, y) {
  const p = payrollOf(settings);
  let used = 0, sick = 0;
  entries.forEach((e) => {
    if (parseDate(e.date).getFullYear() !== y) return;
    const t = entryType(e);
    if (t === 'vacation') used++;
    else if (t === 'sick') sick++;
  });
  const entitled = Number(p.annualVacationDays) || 0;
  return { entitled, used, sick, remaining: Math.max(0, entitled - used) };
}

// Annual recreation pay (דמי הבראה).
export function recreationAnnual(settings) {
  const p = payrollOf(settings);
  const days = Number(p.recreationDays) || 0;
  const rate = Number(p.recreationDayRate) || 0;
  return { days, rate, total: days * rate };
}
