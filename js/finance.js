// Pure financial/insight calculations for the "עוד" page.
// All amounts are estimates (משוער). Israeli-style defaults, fully configurable.
import { workedMinutes, decimalHours, entryType, isWork, inMonth, parseDate, MONTHS } from './util.js';

export const DEFAULT_PAYROLL = {
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
};

export function payrollOf(settings) {
  return { ...DEFAULT_PAYROLL, ...(settings.payroll || {}) };
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

// Gross for a month. With overtime on, tiers are paid 125%/150%.
export function grossForMonth(entries, settings, y, m) {
  const p = payrollOf(settings);
  let gross = 0, hours = 0, ot125 = 0, ot150 = 0;
  // accumulate per (date) using an effective rate = weighted by entries' rates
  const dayHours = new Map();
  const dayPayFlat = new Map();
  entries.forEach((e) => {
    if (!inMonth(e, y, m) || !isWork(e)) return;
    const h = decimalHours(workedMinutes(e));
    const r = rateOf(e, settings);
    hours += h;
    dayHours.set(e.date, (dayHours.get(e.date) || 0) + h);
    dayPayFlat.set(e.date, (dayPayFlat.get(e.date) || 0) + h * r);
  });
  for (const [date, h] of dayHours) {
    const flatPay = dayPayFlat.get(date) || 0;
    const avgRate = h > 0 ? flatPay / h : 0;
    if (p.overtime) {
      const { reg, t125, t150 } = splitOvertime(h, p.otThreshold);
      gross += (reg + t125 * 1.25 + t150 * 1.5) * avgRate;
      ot125 += t125; ot150 += t150;
    } else {
      gross += flatPay;
    }
  }
  return { gross, hours, ot125, ot150 };
}

// Estimated payslip: gross → deductions → net.
export function payslip(entries, settings, y, m) {
  const p = payrollOf(settings);
  const { gross, hours, ot125, ot150 } = grossForMonth(entries, settings, y, m);
  const incomeTax = gross * (p.incomeTax / 100);
  const socialHealth = gross * (p.socialHealth / 100);
  const pension = gross * (p.pensionEmployee / 100);
  const deductions = incomeTax + socialHealth + pension;
  const net = Math.max(0, gross - deductions);
  return { gross, hours, ot125, ot150, incomeTax, socialHealth, pension, deductions, net };
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
