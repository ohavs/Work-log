import { store } from './store.js';
import { VAPID_PUBLIC_KEY } from './config.js';
import { exportPDF } from './pdf.js';
import { exportCSV } from './csv.js';
import { initIcons, svg } from './icons.js';
import { initPickers, openTimePicker, openDatePicker, showConfirm } from './pickers.js';
import {
  DEFAULT_PAYROLL, payrollOf, payslip, pensionForMonth, grossForMonth,
  yearlyByMonth, averages, vacationBalance, recreationAnnual, rateOf, travelForMonth,
} from './finance.js';
import { uid } from './util.js';
import {
  MONTHS, DOW, TYPE_META, parseDate, toISO, todayISO,
  workedMinutes, fmtHours, decimalHours, fmtMoney, inMonth,
  entryType, isWork, weekStartISO, weekLabel,
  rawShiftMinutes, suggestedBreakMinutes, DEFAULT_AUTO_BREAK_MIN,
} from './util.js';

const $ = (id) => document.getElementById(id);
// Bumped alongside sw.js's CACHE constant on every deploy-affecting change —
// shown in Settings so it's possible to confirm exactly which build is
// actually running on a device instead of guessing whether an update landed.
const APP_VERSION = 'v65';
const ACTIVE_KEY = 'wl_active';
const AUTOCLOSE_KEY = 'wl_autoclose'; // id of an auto-closed shift awaiting user review
const MIN_SHIFT_MS = 60000;   // shifts under a minute are treated as an accidental double-tap
// After how many open hours a forgotten shift is capped + closed automatically.
// User-configurable (settings.shiftMaxHours); the 9h "forgot to clock out?"
// reminder is sent by the cron using settings.shiftRemindHours.
function autoCloseMs() { return (Number(store.settings.shiftMaxHours) || 12) * 3600000; }

const now = new Date();
let viewYear = now.getFullYear();
let viewMonth = now.getMonth();
let editingId = null;
let formType = 'work';
let weeklyOpen = false;
let monthlyOpen = false;
let moreOpen = false;
let jobFilter = null;       // null = all workplaces; else jobId
let editingJobId = null;
let tick = null;
let lastCreatedId = null;
let selectMode = false;           // entries list: multi-select mode for bulk deletion
let selectedIds = new Set();      // entry ids currently selected
let reminderPick = '18:00';       // chosen time in the settings picker
let offDaysPick = [];             // chosen non-work weekdays (0=Sunday..6=Saturday) in the settings sheet
let reminderNotifiedFor = '';     // ISO date we already notified for
let reminderDismissedFor = '';    // ISO date the in-app banner was dismissed
let noteFilter = null;            // null = all categories; else category id (or '__none')
let noteQuery = '';               // search text
let editingNoteId = null;
let editingCatId = null;
let noteDraft = { fields: [], checklist: [], tags: [], remind: null }; // working copy while editing
let catPick = 'teal';             // chosen swatch in the category editor
let formSnapshot = '';
let breakManuallySet = false;     // entry form: true once the user picks a break chip this session — blocks the auto-break suggestion from overriding their choice

const TYPE_LABEL = { work: 'עבודה', vacation: 'חופשה', sick: 'מחלה' };

// palette id -> [primary, primary-2, accent, accent-2]
const PALETTES = {
  teal:    ['#0D9488', '#14B8A6', '#EA580C', '#F97316'],
  indigo:  ['#4F46E5', '#6366F1', '#F59E0B', '#FBBF24'],
  violet:  ['#7C3AED', '#8B5CF6', '#EC4899', '#F472B6'],
  blue:    ['#2563EB', '#3B82F6', '#F97316', '#FB923C'],
  rose:    ['#E11D48', '#F43F5E', '#0EA5E9', '#38BDF8'],
  emerald: ['#059669', '#10B981', '#F59E0B', '#FBBF24'],
  amber:   ['#D97706', '#F59E0B', '#7C3AED', '#8B5CF6'],
  slate:   ['#475569', '#64748B', '#0EA5E9', '#38BDF8'],
};

// ------------------------------------------------------------------ theme + palette
function applyPalette(id) {
  const p = PALETTES[id] || PALETTES.teal;
  const r = document.documentElement.style;
  r.setProperty('--brand-p', p[0]); r.setProperty('--brand-p2', p[1]);
  r.setProperty('--brand-a', p[2]); r.setProperty('--brand-a2', p[3]);
}
function applyTheme() {
  const dark = store.settings.theme === 'dark';
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  applyPalette(store.settings.palette);
  const meta = document.querySelector('meta[name="theme-color"]');
  const p = PALETTES[store.settings.palette] || PALETTES.teal;
  if (meta) meta.content = dark ? '#0f1620' : p[0];
  const tt = $('themeToggle');
  if (tt) { tt.innerHTML = svg(dark ? 'sun' : 'moon'); tt.setAttribute('aria-label', dark ? 'מעבר למצב בהיר' : 'מעבר למצב כהה'); }
}
function toggleTheme() {
  const dark = store.settings.theme !== 'dark';
  store.saveSettings({ theme: dark ? 'dark' : 'light' });
  applyTheme();
  const chk = $('sDark'); if (chk) chk.checked = dark; // keep settings switch in sync if open
}

// ------------------------------------------------------------------ active session
function getActive() { try { return JSON.parse(localStorage.getItem(ACTIVE_KEY) || 'null'); } catch { return null; } }
function setActive(v) {
  v ? localStorage.setItem(ACTIVE_KEY, JSON.stringify(v)) : localStorage.removeItem(ACTIVE_KEY);
  // Mirror the open shift into synced settings so the reminder cron can watch
  // for a forgotten clock-out even when the app is fully closed.
  try { store.saveSettings({ activeShift: v ? { start: v.start, jobId: v.jobId || '' } : null }); } catch {}
}

// A shift left open for 12h is capped at 12h and closed automatically; the
// created entry is flagged for review and surfaced via a home-screen banner.
// Runs on launch (catches a shift the app slept through) and live while open.
//
// REENTRANCY GUARD: store.addEntry()/setActive() below both synchronously
// emit a store change, which re-renders the hero, which re-checks whether
// the active shift is still >=12h old — and since setActive(null) hasn't
// run yet at that point, without this guard it would call autoCloseActive()
// again from inside itself, forever, each call creating another duplicate
// entry. This is exactly what happened in production: one stuck shift
// produced 1000+ duplicate entries in seconds before the call stack
// overflowed. Never remove this guard.
let autoClosing = false;
function autoCloseActive(active) {
  if (autoClosing) return null;
  active = active || getActive();
  if (!active) return null;
  autoClosing = true;
  try {
    const startD = new Date(active.start);
    const endD = new Date(active.start + autoCloseMs());
    const breakMin = suggestedBreakMinutes(rawShiftMinutes(hhmm(startD), hhmm(endD)), store.settings);
    const entry = { type: 'work', date: toISO(startD), jobId: active.jobId || '', start: hhmm(startD), end: hhmm(endD), breakMin, rate: '', note: '', autoClosed: true };
    const created = store.addEntry(entry);
    if (!created) {
      // Daily cap already reached (2 work shifts today) — leave the active
      // shift untouched rather than silently discarding it; the user must
      // resolve the existing entries for today before it can be closed.
      toast('לא ניתן לסגור אוטומטית — כבר יש 2 משמרות רשומות היום. ערכו/מחקו רישום קיים כדי לפתור.');
      return null;
    }
    setActive(null);
    try { localStorage.setItem(AUTOCLOSE_KEY, created.id); } catch {}
    viewYear = startD.getFullYear(); viewMonth = startD.getMonth();
    showLocalNotification('המשמרת נסגרה אוטומטית', 'עברו 12 שעות — סגרנו את המשמרת. שכחת יציאה? הקש לתיקון', 'wl-autoclose');
    renderMonth(); renderAll(); renderMore(); renderHero();
    toast('משמרת ארוכה נסגרה אוטומטית אחרי 12 שעות · בדקו אותה');
    return created;
  } finally {
    autoClosing = false;
  }
}

function renderAutoCloseBanner() {
  const b = $('autoCloseBanner');
  if (!b) return;
  const id = (() => { try { return localStorage.getItem(AUTOCLOSE_KEY); } catch { return null; } })();
  const exists = id && store.entries.some((x) => x.id === id);
  if (!exists) { b.hidden = true; if (id) { try { localStorage.removeItem(AUTOCLOSE_KEY); } catch {} } return; }
  b.hidden = false;
}
function clearAutoCloseFlag(id) {
  try { if (id && localStorage.getItem(AUTOCLOSE_KEY) === id) localStorage.removeItem(AUTOCLOSE_KEY); } catch {}
}
function hhmm(d) { return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; }
function longDate(d) { return `יום ${DOW[d.getDay()]} · ${d.getDate()} ב${MONTHS[d.getMonth()]} ${d.getFullYear()}`; }

// ------------------------------------------------------------------ HERO
function todayMinutes() { const t = todayISO(); return store.entries.filter((e) => e.date === t && isWork(e)).reduce((s, e) => s + workedMinutes(e), 0); }
function todayCount() { const t = todayISO(); return store.entries.filter((e) => e.date === t).length; }

function renderHero() {
  const hero = $('hero');
  const d = new Date();
  $('heroDate').textContent = `יום ${DOW[d.getDay()]}, ${d.getDate()} ב${MONTHS[d.getMonth()]}`;
  let active = getActive();
  // A shift the app slept through past the 12h cap: close it before rendering.
  if (active && Date.now() - active.start >= autoCloseMs()) { autoCloseActive(active); active = getActive(); }
  renderAutoCloseBanner();
  if (active) {
    hero.classList.add('running');
    $('timer').hidden = false; $('heroHint').hidden = true; $('heroToday').hidden = true;
    $('punchInner').textContent = 'יציאה';
    $('punchBtn').setAttribute('aria-label', 'יציאה');
    const startD = new Date(active.start);
    const update = () => {
      const diff = Math.max(0, Date.now() - active.start);
      if (diff >= autoCloseMs()) { clearInterval(tick); tick = null; autoCloseActive(active); return; }
      const h = Math.floor(diff / 3600000), m = Math.floor((diff % 3600000) / 60000), s = Math.floor((diff % 60000) / 1000);
      $('timerVal').textContent = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
      $('editStart').textContent = `התחלת ב־${hhmm(startD)} · הקש לשינוי`;
    };
    update(); clearInterval(tick); tick = setInterval(update, 1000);
  } else {
    hero.classList.remove('running');
    $('timer').hidden = true; $('punchInner').textContent = 'כניסה';
    $('punchBtn').setAttribute('aria-label', 'כניסה');
    clearInterval(tick); tick = null;
    const mins = todayMinutes();
    if (mins > 0) { $('heroHint').hidden = true; $('heroToday').hidden = false; $('heroToday').textContent = `היום נרשמו ${fmtHours(mins)} שעות · ${todayCount()} רישומים`; }
    else { $('heroToday').hidden = true; $('heroHint').hidden = false; }
  }
}

function punch() {
  const active = getActive();
  if (active) {
    const startD = new Date(active.start), endD = new Date();
    if (endD - startD < MIN_SHIFT_MS) { // accidental double-tap — discard instead of logging a 0-min shift
      setActive(null); renderHero();
      toast('המשמרת קצרה מדי ולא נשמרה · הקש “כניסה” כשמתחילים באמת');
      return;
    }
    const breakMin = suggestedBreakMinutes(rawShiftMinutes(hhmm(startD), hhmm(endD)), store.settings);
    const entry = { type: 'work', date: toISO(startD), jobId: active.jobId || jobFilter || '', start: hhmm(startD), end: hhmm(endD), breakMin, rate: '', note: '' };
    // Add the entry BEFORE clearing the active shift: clearing it fires a
    // synchronous change event that re-checks the daily reminder, and if the
    // entry didn't exist yet at that instant, it would look like "nothing
    // logged, not clocked in" and fire a false "you forgot to log hours" alert
    // right at clock-out.
    const created = store.addEntry(entry);
    if (!created) {
      // Daily cap reached (2 work shifts already logged today) — keep the
      // active shift running rather than discard the worked time; the user
      // must edit/delete an existing entry for today before clocking out.
      toast('כבר יש 2 משמרות רשומות היום — לא ניתן להוסיף עוד. ערכו/מחקו רישום קיים כדי לצאת.');
      return;
    }
    lastCreatedId = created.id;
    viewYear = startD.getFullYear(); viewMonth = startD.getMonth();
    setActive(null);
    renderMonth(); renderHero();
    toast(`נשמר · ${fmtHours(workedMinutes(entry))} שעות · הקש על הרישום לעריכה`);
  } else {
    setActive({ start: Date.now(), jobId: jobFilter || '' }); renderHero();
  }
}

function openStartEdit() {
  const active = getActive();
  if (!active) return;
  openTimePicker({
    title: 'מתי התחלת?', value: hhmm(new Date(active.start)),
    onConfirm: (v) => {
      const [h, m] = v.split(':').map(Number);
      const d = new Date(active.start); d.setHours(h, m, 0, 0);
      setActive({ start: d.getTime(), jobId: active.jobId || '' }); renderHero();
    },
  });
}

// ------------------------------------------------------------------ month + stats
function renderMonth() {
  const t = `${MONTHS[viewMonth]} ${viewYear}`;
  $('monthName').textContent = t;
  const mo = $('moMonthName'); if (mo) mo.textContent = t;
}
function shiftMonth(delta) {
  if (selectMode) exitSelectMode(); // don't carry a stale selection across months
  viewMonth += delta;
  if (viewMonth < 0) { viewMonth = 11; viewYear--; }
  if (viewMonth > 11) { viewMonth = 0; viewYear++; }
  renderMonth(); renderAll(); renderMore();
}
function jobFilteredEntries() { return jobFilter ? store.entries.filter((e) => (e.jobId || '') === jobFilter) : store.entries; }
function monthEntries() { return jobFilteredEntries().filter((e) => inMonth(e, viewYear, viewMonth)).sort((a, b) => b.date.localeCompare(a.date) || (b.start || '').localeCompare(a.start || '')); }
function effRate(e) { return rateOf(e, store.settings); }
function jobsList() { return Array.isArray(store.settings.jobs) ? store.settings.jobs : []; }
function jobName(id) { const j = jobsList().find((x) => x.id === id); return j ? j.name : ''; }

function renderStats(entries) {
  let totalMin = 0;
  const workDays = new Set(), vac = new Set(), sick = new Set();
  entries.forEach((e) => {
    const t = entryType(e);
    if (t === 'vacation') { vac.add(e.date); return; }
    if (t === 'sick') { sick.add(e.date); return; }
    totalMin += workedMinutes(e); workDays.add(e.date);
  });
  // Pay is computed once, centrally, via grossForMonth()/travelForMonth() —
  // not re-derived here — so this quick total always matches the deeper
  // payslip on the "עוד" page (same rate rules, overtime tiers, sick-day
  // credit, and global/fixed-salary mode all apply identically everywhere).
  const travelPay = travelForMonth(entries, store.settings, viewYear, viewMonth).total;
  const totalPay = grossForMonth(entries, store.settings, viewYear, viewMonth).gross + travelPay;
  $('statHours').textContent = fmtHours(totalMin);
  $('statDays').textContent = workDays.size;
  const rate = Number(store.settings.rate) || 0;
  const anyRate = rate > 0 || entries.some((e) => e.rate) || travelPay > 0 || totalPay > 0;
  $('statPayCard').hidden = !anyRate;
  if (anyRate) $('statPay').textContent = fmtMoney(totalPay, store.settings.currency);

  const parts = [];
  if (vac.size) parts.push(`<span class="off-pill vac">${svg('vacation')}<b>${vac.size}</b> חופשה</span>`);
  if (sick.size) parts.push(`<span class="off-pill sick">${svg('sick')}<b>${sick.size}</b> מחלה</span>`);
  $('offPills').innerHTML = parts.join(''); $('offPills').hidden = parts.length === 0;

  // goal progress rings (weekly + monthly)
  const goalM = Number(store.settings.goalHours) || 0;
  const goalW = Number(store.settings.goalWeekHours) || 0;
  const rings = [];
  // The "השבוע" ring tracks the real current week (currentWeekMinutes() always
  // uses today's date, not the viewed month) — only meaningful while actually
  // viewing the current month. Without this guard it kept showing "this real
  // week" even while browsing a past/future month, silently mismatching
  // whatever period the rest of the page was displaying.
  const today = new Date();
  const isViewingCurrentMonth = viewYear === today.getFullYear() && viewMonth === today.getMonth();
  if (goalW > 0 && isViewingCurrentMonth) { const wk = currentWeekMinutes(); rings.push(ringSVG((wk / 60 / goalW) * 100, 'השבוע', `${fmtHours(wk)} / ${goalW}`, weekLabel(weekStartISO(today)))); }
  if (goalM > 0) { rings.push(ringSVG((totalMin / 60 / goalM) * 100, 'החודש', `${fmtHours(totalMin)} / ${goalM}`, `${MONTHS[viewMonth]} ${viewYear}`)); }
  const gr = $('goalRings');
  gr.innerHTML = rings.join('');
  gr.hidden = rings.length === 0;
  gr.classList.toggle('single', rings.length === 1);
}

function currentWeekMinutes() {
  const wk = weekStartISO(new Date());
  return jobFilteredEntries().reduce((s, e) => (isWork(e) && weekStartISO(parseDate(e.date)) === wk ? s + workedMinutes(e) : s), 0);
}
// A modern progress donut. pct is 0..∞ (clamped for the arc; shown rounded).
function ringSVG(pctRaw, label, sub, caption) {
  const pct = Math.max(0, Math.min(100, pctRaw));
  const done = pctRaw >= 100;
  const r = 42, C = 2 * Math.PI * r;
  const off = C * (1 - pct / 100);
  return `<div class="ring-wrap${done ? ' done' : ''}">
    <svg class="ring" viewBox="0 0 100 100" aria-hidden="true">
      <circle class="ring-bg" cx="50" cy="50" r="${r}"></circle>
      <circle class="ring-fg" cx="50" cy="50" r="${r}" stroke-dasharray="${C.toFixed(1)}" stroke-dashoffset="${off.toFixed(1)}" stroke-linecap="round"></circle>
      <text class="ring-pct" x="50" y="52" text-anchor="middle" dominant-baseline="central">${Math.round(pctRaw)}%</text>
    </svg>
    <span class="ring-label">${label}</span>
    <span class="ring-sub">${sub} ש׳</span>
    ${caption ? `<span class="ring-cap">${caption}</span>` : ''}
  </div>`;
}

// "+2:15" / "−1:40" — a signed hour label for a goal comparison.
function fmtDiff(mins) { return `${mins < 0 ? '−' : '+'}${fmtHours(Math.abs(mins))}`; }

// Hours expected per *scheduled* workday, derived from the weekly goal and
// how many weekdays are actually worked (settings.offDays) — e.g. 44h/week
// over a Sun–Thu schedule (5 workdays, Fri/Sat off) is 8:48/day, not 44/7.
// This is the same "תקן שעות" math a real payslip uses, and — critically —
// it's what makes a week split across a month boundary compare fairly: a
// single weekday is judged against one real day's target, not an arbitrary
// slice of a 7-day week that includes days you never work anyway. Without
// this, a boundary week could show a false "surplus" for a single day that's
// actually a shortfall, just because the old math compared it to 1/7 of the
// full week instead of 1/5 (or however many days you actually work).
function dailyHourTarget() {
  const goalW = Number(store.settings.goalWeekHours) || 0;
  if (!goalW) return 0;
  const offDays = Array.isArray(store.settings.offDays) ? store.settings.offDays : [];
  const workDaysPerWeek = Math.max(1, 7 - offDays.length);
  return goalW / workDaysPerWeek;
}
function isScheduledWorkday(date) {
  const offDays = Array.isArray(store.settings.offDays) ? store.settings.offDays : [];
  return !offDays.includes(date.getDay());
}

// Groups `entries` (already scoped to one month, e.g. via monthEntries()) by
// ISO week and compares each week's actual hours to what was expected —
// counting only the week's *scheduled workdays* that fall inside `y`/`m`,
// each judged at the real daily rate (see dailyHourTarget). Summing every
// week's diffMins this way is mathematically identical to comparing the
// month's total hours against one combined monthly target — no separate
// monthly-only calculation needed, and no boundary-week distortion.
function weeklyGoalBreakdown(entries, y, m) {
  const daily = dailyHourTarget();
  const weeks = new Map();
  entries.forEach((e) => { if (!isWork(e)) return; const wk = weekStartISO(parseDate(e.date)); weeks.set(wk, (weeks.get(wk) || 0) + workedMinutes(e)); });
  return [...weeks.entries()].filter(([, mins]) => mins > 0).sort((a, b) => a[0].localeCompare(b[0])).map(([wk, mins]) => {
    let scheduledDaysInMonth = 0;
    const start = parseDate(wk);
    for (let i = 0; i < 7; i++) {
      const d = new Date(start); d.setDate(start.getDate() + i);
      if (d.getFullYear() === y && d.getMonth() === m && isScheduledWorkday(d)) scheduledDaysInMonth++;
    }
    const hasGoal = daily > 0;
    const goalMins = hasGoal ? Math.round(daily * 60 * scheduledDaysInMonth) : 0;
    const diffMins = hasGoal ? mins - goalMins : 0;
    return { wk, mins, scheduledDaysInMonth, hasGoal, goalMins, diffMins };
  });
}

function renderWeekly(entries) {
  const card = $('weeklyCard'), body = $('weeklyBody');
  const rows = weeklyGoalBreakdown(entries, viewYear, viewMonth);
  if (rows.length < 2) { card.hidden = true; return; }
  card.hidden = false;
  const max = Math.max(...rows.map((r) => r.mins)); // fallback bar scale when no weekly goal is set
  body.innerHTML = rows.map((r) => {
    const pct = r.hasGoal ? Math.min(100, Math.round((r.mins / Math.max(1, r.goalMins)) * 100)) : Math.round((r.mins / max) * 100);
    const diff = r.hasGoal ? `<span class="week-diff ${r.diffMins >= 0 ? 'pos' : 'neg'}">${fmtDiff(r.diffMins)}</span>` : '';
    return `<div class="week-row"><span class="week-name">${weekLabel(r.wk)}</span><span class="week-bar${r.hasGoal ? ' compact' : ''}"><span class="week-bar-fill" style="width:${pct}%"></span></span><span class="week-val">${fmtHours(r.mins)}</span>${diff}</div>`;
  }).join('');
  $('weeklyToggle').setAttribute('aria-expanded', String(weeklyOpen));
  body.hidden = !weeklyOpen;
}

// Monthly report — actual hours worked this month vs. the monthly goal (if
// one is set), salary, and a days breakdown. Same visual language as the
// weekly summary card above it (.week-row / .week-bar), so it reads as a
// matching pair rather than a bolted-on extra.
function renderMonthlyReport(entries) {
  const card = $('monthlyCard'), body = $('monthlyBody');
  if (!entries.length) { card.hidden = true; return; }
  card.hidden = false;

  let totalMin = 0;
  const workDays = new Set(), vac = new Set(), sick = new Set();
  entries.forEach((e) => {
    const t = entryType(e);
    if (t === 'vacation') { vac.add(e.date); return; }
    if (t === 'sick') { sick.add(e.date); return; }
    totalMin += workedMinutes(e); workDays.add(e.date);
  });
  // Same centralized pay source as renderStats() — see its comment.
  const travelPay = travelForMonth(entries, store.settings, viewYear, viewMonth).total;
  const totalPay = grossForMonth(entries, store.settings, viewYear, viewMonth).gross + travelPay;
  const goalM = Number(store.settings.goalHours) || 0;
  const rate = Number(store.settings.rate) || 0;
  const anyRate = rate > 0 || entries.some((e) => e.rate) || travelPay > 0 || totalPay > 0;

  const rows = [];
  if (goalM > 0) {
    const pct = Math.round((totalMin / 60 / goalM) * 100);
    const remainMin = Math.max(0, goalM * 60 - totalMin);
    rows.push(`<div class="week-row"><span class="week-name">שעות</span><span class="week-bar"><span class="week-bar-fill" style="width:${Math.min(100, pct)}%"></span></span><span class="week-val">${fmtHours(totalMin)} / ${goalM}</span></div>`);
    rows.push(`<p class="form-note">${pct >= 100 ? `היעד הושלם ✓ (${pct}%)` : `נותרו ${fmtHours(remainMin)} שעות ליעד החודשי (${pct}%)`}</p>`);
  } else {
    rows.push(`<div class="week-row"><span class="week-name">שעות</span><span class="week-val">${fmtHours(totalMin)}</span></div>`);
  }
  if (anyRate) rows.push(`<div class="week-row"><span class="week-name">שכר${travelPay ? ' (כולל נסיעות)' : ''}</span><span class="week-val">${fmtMoney(totalPay, store.settings.currency)}</span></div>`);
  const weekRows = weeklyGoalBreakdown(entries, viewYear, viewMonth);
  if (weekRows.some((r) => r.hasGoal)) {
    const totalDiff = weekRows.reduce((s, r) => s + r.diffMins, 0);
    rows.push(`<div class="week-row"><span class="week-name">הפרש מהיעד השבועי</span><span class="week-val ${totalDiff >= 0 ? 'pos' : 'neg'}">${fmtDiff(totalDiff)}</span></div>`);
  }
  rows.push(`<div class="week-row"><span class="week-name">ימי עבודה</span><span class="week-val">${workDays.size}</span></div>`);
  if (vac.size) rows.push(`<div class="week-row"><span class="week-name">ימי חופשה</span><span class="week-val">${vac.size}</span></div>`);
  if (sick.size) rows.push(`<div class="week-row"><span class="week-name">ימי מחלה</span><span class="week-val">${sick.size}</span></div>`);

  body.innerHTML = rows.join('');
  $('monthlyToggle').setAttribute('aria-expanded', String(monthlyOpen));
  body.hidden = !monthlyOpen;
}

function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

function renderEntries(entries) {
  const wrap = $('entries'), empty = $('emptyState'); wrap.innerHTML = '';
  if (!entries.length) { empty.hidden = false; $('listCount').textContent = ''; return; }
  empty.hidden = true; $('listCount').textContent = `${entries.length} רישומים`;

  const groups = new Map();
  entries.forEach((e) => { if (!groups.has(e.date)) groups.set(e.date, []); groups.get(e.date).push(e); });

  for (const [date, list] of groups) {
    const d = parseDate(date);
    const dayMin = list.reduce((s, e) => s + workedMinutes(e), 0);
    const group = document.createElement('div');
    group.className = 'day-group';
    const daySelected = selectMode && list.every((e) => selectedIds.has(e.id));
    const daySelHtml = selectMode ? `<span class="sel-check day-sel${daySelected ? ' on' : ''}" data-date="${date}" aria-label="בחירת כל היום">${daySelected ? svg('check') : ''}</span>` : '';
    group.innerHTML = `<div class="day-head">${daySelHtml}<span class="dow">יום ${DOW[d.getDay()]}</span><span>${d.getDate()} ב${MONTHS[d.getMonth()]}</span>${dayMin > 0 ? `<span class="dtotal">${fmtHours(dayMin)} שעות</span>` : ''}</div>`;
    list.forEach((e) => {
      const sw = document.createElement('div'); sw.className = 'swipe-wrap'; sw.dataset.id = e.id;
      if (selectMode) sw.classList.add('select-mode');
      const del = document.createElement('button'); del.className = 'swipe-del'; del.type = 'button'; del.setAttribute('aria-label', 'מחיקה'); del.innerHTML = svg('trash');
      const card = document.createElement('div'); card.dataset.id = e.id;
      const t = entryType(e);
      const jn = e.jobId ? jobName(e.jobId) : '';
      if (t !== 'work') {
        card.className = `entry ${t === 'vacation' ? 'vac' : 'sick'}`;
        const off = jn ? `<span class="entry-job">${escapeHtml(jn)}</span>` : (e.note ? `<span class="note">${escapeHtml(e.note)}</span>` : 'יום מלא');
        card.innerHTML = `<div class="entry-badge">${svg(t)}</div><div class="entry-main"><span class="entry-range">${TYPE_LABEL[t]}</span><span class="entry-meta">${off}</span></div><span class="entry-edit">${svg('pencil')}</span>`;
      } else {
        const mins = workedMinutes(e), r = effRate(e), pay = decimalHours(mins) * r;
        const meta = [];
        if (jn) meta.push(`<span class="entry-job">${escapeHtml(jn)}</span>`);
        if (e.breakMin) meta.push(`הפסקה ${e.breakMin} דק׳`);
        if (e.note) meta.push(`<span class="note">${escapeHtml(e.note)}</span>`);
        card.className = 'entry';
        card.innerHTML = `<div class="entry-time"><span class="big">${fmtHours(mins)}</span><span class="unit">שעות</span></div><div class="entry-main"><span class="entry-range">${e.start} – ${e.end}</span><span class="entry-meta">${meta.join(' · ') || '&nbsp;'}</span></div>${r ? `<span class="entry-pay">${fmtMoney(pay, store.settings.currency)}</span>` : `<span class="entry-edit">${svg('pencil')}</span>`}`;
      }
      if (selectMode) {
        const selected = selectedIds.has(e.id);
        card.classList.toggle('selected', selected);
        const chk = document.createElement('span'); chk.className = `sel-check entry-sel${selected ? ' on' : ''}`; chk.innerHTML = selected ? svg('check') : '';
        sw.appendChild(chk);
      } else {
        sw.appendChild(del);
      }
      sw.appendChild(card);
      group.appendChild(sw);
    });
    wrap.appendChild(group);
  }
  if (lastCreatedId) {
    const el = wrap.querySelector(`.entry[data-id="${lastCreatedId}"]`);
    if (el) { el.classList.add('flash'); el.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
    lastCreatedId = null;
  }
}

function renderAll() { const e = monthEntries(); renderStats(e); renderWeekly(e); renderMonthlyReport(e); renderEntries(e); }

// ------------------------------------------------------------------ bulk selection / delete
function updateSelectBar() {
  $('selectBar').hidden = !selectMode;
  $('bottomNav').hidden = selectMode;
  $('selectCount').textContent = `${selectedIds.size} נבחרו`;
  $('selectDeleteBtn').disabled = selectedIds.size === 0;
  $('selectModeBtn').classList.toggle('on', selectMode);
  $('addBtn').hidden = selectMode;
}
function enterSelectMode() { selectMode = true; selectedIds.clear(); renderAll(); updateSelectBar(); }
function exitSelectMode() { selectMode = false; selectedIds.clear(); closeSwipe(); renderAll(); updateSelectBar(); }
function toggleEntrySelection(id) {
  if (selectedIds.has(id)) selectedIds.delete(id); else selectedIds.add(id);
  renderAll(); updateSelectBar();
}
function toggleDaySelection(date) {
  const ids = monthEntries().filter((e) => e.date === date).map((e) => e.id);
  const allSelected = ids.length > 0 && ids.every((id) => selectedIds.has(id));
  ids.forEach((id) => { if (allSelected) selectedIds.delete(id); else selectedIds.add(id); });
  renderAll(); updateSelectBar();
}
async function deleteSelectedEntries() {
  const n = selectedIds.size;
  if (!n) return;
  const ok = await showConfirm({ title: `למחוק ${n} רישומים?`, message: 'לא ניתן לשחזר לאחר המחיקה.', confirmText: 'מחיקה', danger: true, icon: 'trash' });
  if (!ok) return;
  store.deleteEntries([...selectedIds]);
  const deletedId = (() => { try { return localStorage.getItem(AUTOCLOSE_KEY); } catch { return null; } })();
  if (deletedId && selectedIds.has(deletedId)) clearAutoCloseFlag(deletedId);
  toast(`${n} רישומים נמחקו`);
  exitSelectMode();
}

// ------------------------------------------------------------------ sheets
function openSheet(s) { s.hidden = false; }
function closeSheet(s) { s.hidden = true; }

// ------------------------------------------------------------------ drag-to-dismiss
// Touch-drag a bottom sheet downward to close it. Activates only on a downward
// gesture that starts from the handle/header, or from the body when it's already
// scrolled to the top — so inner scrolling and the time wheels are never hijacked.
const SHEET_BG = 'rgba(4,32,29,.55)';
function enableSheetDrag(backdrop, cfg) {
  const sheet = backdrop.querySelector('.sheet');
  if (!sheet) return;
  let startY = 0, lastY = 0, lastT = 0, dy = 0, tracking = false, active = false, fromTop = false, startScroll = 0;
  const reset = () => { sheet.style.transition = ''; sheet.style.transform = ''; backdrop.style.transition = ''; backdrop.style.background = ''; };

  sheet.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) { tracking = false; return; }
    const t = e.touches[0];
    startY = lastY = t.clientY; lastT = e.timeStamp; dy = 0; active = false;
    startScroll = sheet.scrollTop;
    fromTop = !!e.target.closest('.sheet-handle, .sheet-head');
    // never start a dismiss from a wheel, horizontal scroller or text field
    const blocked = !fromTop && !!e.target.closest('.wheels, .wheel, input, textarea, .job-filter, .chips');
    tracking = !blocked;
  }, { passive: true });

  sheet.addEventListener('touchmove', (e) => {
    if (!tracking) return;
    const t = e.touches[0];
    dy = t.clientY - startY;
    if (!active) {
      if (dy > 6 && (fromTop || startScroll <= 0)) { active = true; sheet.style.transition = 'none'; }
      else if (dy < -2 || startScroll > 0) { tracking = false; return; }
      else return;
    }
    if (dy <= 0) { sheet.style.transform = ''; backdrop.style.background = SHEET_BG; }
    else {
      e.preventDefault();
      sheet.style.transform = `translateY(${dy}px)`;
      backdrop.style.background = `rgba(4,32,29,${Math.max(0, 0.55 - dy / 700).toFixed(3)})`;
    }
    lastY = t.clientY; lastT = e.timeStamp;
  }, { passive: false });

  const finish = (e) => {
    if (!tracking) return; tracking = false;
    if (!active) return; active = false;
    const ct = e.changedTouches && e.changedTouches[0];
    const endY = ct ? ct.clientY : lastY;
    const total = endY - startY;
    const vel = (endY - lastY) / Math.max(1, e.timeStamp - lastT); // px/ms, last segment
    const h = sheet.getBoundingClientRect().height || 400;
    if (total > Math.min(150, h * 0.28) || (vel > 0.5 && total > 40)) dismissSheet(backdrop, sheet, cfg, reset);
    else { sheet.style.transition = ''; sheet.style.transform = ''; backdrop.style.background = SHEET_BG; requestAnimationFrame(() => { backdrop.style.background = ''; }); }
  };
  sheet.addEventListener('touchend', finish);
  sheet.addEventListener('touchcancel', finish);
}
function dismissSheet(backdrop, sheet, cfg, reset) {
  if (cfg.guard && cfg.guard()) { reset(); cfg.guarded(); return; } // e.g. unsaved-changes prompt
  let done = false;
  const finishHide = () => { if (done) return; done = true; sheet.removeEventListener('transitionend', finishHide); cfg.hide(); reset(); };
  sheet.style.transition = 'transform .24s cubic-bezier(.32,.72,0,1)';
  sheet.style.transform = 'translateY(100%)';
  backdrop.style.transition = 'background .24s';
  backdrop.style.background = 'rgba(4,32,29,0)';
  sheet.addEventListener('transitionend', finishHide);
  setTimeout(finishHide, 320);
}

function setFormType(type) {
  formType = TYPE_LABEL[type] ? type : 'work';
  $('typeSeg').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.type === formType));
  $('entryForm').classList.toggle('off-mode', formType !== 'work');
}

// field setters (hidden input + display text)
function setFDate(iso) { $('fDate').value = iso; $('fDateText').textContent = longDate(parseDate(iso)); }
function setFStart(v) { $('fStart').value = v; $('fStartText').textContent = v; }
function setFEnd(v) { $('fEnd').value = v; $('fEndText').textContent = v; }
function setFBreak(min) {
  $('fBreak').value = String(min);
  $('breakChips').querySelectorAll('button').forEach((b) => b.classList.toggle('on', Number(b.dataset.min) === Number(min)));
}
// Re-suggest the break after a start/end time change, unless the user has
// already picked a break chip themselves this session (their choice wins).
function applyAutoBreak() {
  if (breakManuallySet) return;
  const raw = rawShiftMinutes($('fStart').value, $('fEnd').value);
  setFBreak(suggestedBreakMinutes(raw, store.settings));
}

function renderJobChips(sel) {
  const jobs = jobsList();
  $('jobField').hidden = jobs.length === 0;
  if (!jobs.length) { $('fJob').value = ''; return; }
  $('jobChips').innerHTML = `<button type="button" data-job="">ללא</button>` +
    jobs.map((j) => `<button type="button" data-job="${j.id}">${escapeHtml(j.name)}</button>`).join('');
  setJobChip(sel || '');
}
function setJobChip(id) {
  $('fJob').value = id;
  $('jobChips').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.job === id));
}

function serializeForm() {
  return JSON.stringify([formType, $('fJob').value, $('fDate').value, $('fStart').value, $('fEnd').value, $('fBreak').value, $('fRate').value, $('fNote').value.trim()]);
}
function isDirty() { return serializeForm() !== formSnapshot; }

function openEntry(id = null) {
  editingId = id;
  breakManuallySet = false;
  const del = $('deleteEntry');
  if (id) {
    const e = store.entries.find((x) => x.id === id);
    if (!e) return;
    $('sheetTitle').textContent = 'עריכת רישום';
    setFDate(e.date); setFStart(e.start || '09:00'); setFEnd(e.end || '17:00'); setFBreak(e.breakMin || 0);
    $('fRate').value = e.rate ?? ''; $('fNote').value = e.note || '';
    renderJobChips(e.jobId || '');
    setFormType(entryType(e)); del.hidden = false;
  } else {
    $('sheetTitle').textContent = 'רישום חדש';
    setFDate(todayISO()); setFStart('09:00'); setFEnd('17:00');
    setFBreak(suggestedBreakMinutes(rawShiftMinutes('09:00', '17:00'), store.settings));
    $('fRate').value = ''; $('fNote').value = '';
    renderJobChips(jobFilter || '');
    setFormType('work'); del.hidden = true;
  }
  setMore(false);
  updateCalc();
  formSnapshot = serializeForm();
  openSheet($('entrySheet'));
}

// Shared "discard unsaved changes?" prompt, reused by every editor sheet.
async function confirmDiscard() {
  return showConfirm({ title: 'לצאת בלי לשמור?', message: 'השינויים שביצעת לא יישמרו.', confirmText: 'צא בלי לשמור', danger: true, icon: 'alert' });
}
async function tryCloseEntry() {
  if (isDirty() && !(await confirmDiscard())) return;
  closeSheet($('entrySheet'));
}

function setMore(open) {
  moreOpen = open;
  $('moreBody').hidden = !open;
  $('moreToggle').setAttribute('aria-expanded', String(open));
}

function updateCalc() {
  const mins = workedMinutes({ start: $('fStart').value, end: $('fEnd').value, breakMin: Number($('fBreak').value) || 0 });
  $('calcHours').textContent = `${fmtHours(mins)} שעות`;
  const rate = rateOf({ rate: $('fRate').value === '' ? '' : Number($('fRate').value), jobId: $('fJob').value }, store.settings);
  $('calcPay').textContent = rate ? fmtMoney(decimalHours(mins) * rate, store.settings.currency) : '';
  const note = $('fBreakNote');
  if (note) note.hidden = formType !== 'work' || rawShiftMinutes($('fStart').value, $('fEnd').value) < 360;
}

function submitEntry(ev) {
  ev.preventDefault();
  const date = $('fDate').value;
  if (!date) return;
  const jobId = $('fJob').value || '';
  let data;
  if (formType === 'work') {
    data = { type: 'work', date, jobId, start: $('fStart').value, end: $('fEnd').value, breakMin: Number($('fBreak').value) || 0, rate: $('fRate').value === '' ? '' : Number($('fRate').value), note: $('fNote').value.trim() };
    if (!data.start || !data.end) { toast('נא לבחור שעת כניסה ויציאה'); return; }
    if (workedMinutes(data) === 0) { toast('משך המשמרת אפס · בדקו את שעות הכניסה והיציאה'); return; }
  } else {
    data = { type: formType, date, jobId, start: '', end: '', breakMin: 0, rate: '', note: $('fNote').value.trim() };
  }
  if (editingId) {
    clearAutoCloseFlag(editingId); store.updateEntry(editingId, data); toast('הרישום עודכן');
  } else {
    const c = store.addEntry(data);
    if (!c) { toast('כבר יש 2 משמרות רשומות בתאריך זה — לא ניתן להוסיף עוד. ערכו/מחקו רישום קיים.'); return; }
    lastCreatedId = c.id; toast('הרישום נוסף');
  }
  const d = parseDate(date); viewYear = d.getFullYear(); viewMonth = d.getMonth();
  renderMonth();
  formSnapshot = serializeForm(); // mark clean so no unsaved prompt
  closeSheet($('entrySheet'));
}

async function deleteCurrentEntry() {
  if (!editingId) return;
  const ok = await showConfirm({ title: 'למחוק את הרישום?', message: 'לא ניתן לשחזר לאחר המחיקה.', confirmText: 'מחיקה', danger: true, icon: 'trash' });
  if (!ok) return;
  clearAutoCloseFlag(editingId);
  store.deleteEntry(editingId);
  formSnapshot = serializeForm();
  closeSheet($('entrySheet'));
  toast('הרישום נמחק');
}

async function deleteEntryById(id) {
  const ok = await showConfirm({ title: 'למחוק את הרישום?', message: 'לא ניתן לשחזר לאחר המחיקה.', confirmText: 'מחיקה', danger: true, icon: 'trash' });
  if (!ok) { closeSwipe(); return; }
  store.deleteEntry(id);
  toast('הרישום נמחק');
}

// ------------------------------------------------------------------ swipe-to-delete
// Slide a shift card sideways to reveal a red trash action on its left (RTL).
function closeSwipe(except) {
  document.querySelectorAll('.swipe-wrap.open').forEach((w) => { if (w !== except) { w.classList.remove('open'); const c = w.querySelector('.entry'); if (c) c.style.transform = ''; } });
}
const SWIPE_W = 76; // width of the revealed delete button
let swipe = null;   // active drag state
let swipeSuppressUntil = 0; // ignore the click that trails a real swipe
function onSwipeStart(ev) {
  if (selectMode) return; // selection mode replaces swipe-to-delete with tap-to-select
  const sw = ev.target.closest('.swipe-wrap');
  if (!sw || ev.target.closest('.swipe-del')) return;
  const t = ev.touches[0];
  swipe = { sw, card: sw.querySelector('.entry'), x0: t.clientX, y0: t.clientY, base: sw.classList.contains('open') ? SWIPE_W : 0, dx: 0, moved: false, axis: null };
}
function onSwipeMove(ev) {
  if (!swipe) return;
  const t = ev.touches[0];
  const dx = t.clientX - swipe.x0, dy = t.clientY - swipe.y0;
  if (!swipe.axis) { // lock the gesture axis on first meaningful movement
    if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return;
    swipe.axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
    if (swipe.axis === 'x') closeSwipe(swipe.sw);
  }
  if (swipe.axis !== 'x') return;
  ev.preventDefault(); // we own the horizontal gesture; stop vertical scroll
  swipe.moved = true;
  const t2 = Math.max(0, Math.min(SWIPE_W, swipe.base + dx)); // reveal only toward the left
  swipe.card.style.transition = 'none';
  swipe.card.style.transform = `translateX(${t2}px)`;
  swipe.dx = t2;
}
function onSwipeEnd() {
  if (!swipe) return;
  const s = swipe; swipe = null;
  if (!s.moved) return;
  s.card.style.transition = '';
  const open = s.dx > SWIPE_W / 2;
  s.card.style.transform = '';
  s.sw.classList.toggle('open', open);
  swipeSuppressUntil = Date.now() + 400;
}

// ------------------------------------------------------------------ settings
let settingsFormSnapshot = '';
// Only the fields deferred to the "שמירה" submit — theme/palette/reminder-toggle/
// reminder-time already save immediately on change, so closing the sheet never
// loses them.
function serializeSettingsForm() {
  return JSON.stringify({ n: $('sName').value, r: $('sRate').value, g: $('sGoal').value, gw: $('sGoalWeek').value, sr: $('sShiftRemind').value, sm: $('sShiftMax').value, ab: $('sAutoBreak').value, od: [...offDaysPick].sort() });
}
function isSettingsDirty() { return serializeSettingsForm() !== settingsFormSnapshot; }
// The "שכחתי לצאת" hours are edited with a −/+ stepper, backed by a hidden
// input (id) that holds the actual value; the visible number lives in #{id}Val.
function setStepper(id, val) { $(id).value = val; $(`${id}Val`).textContent = val; }
function renderOffDaysChips() {
  $('offDaysChips').querySelectorAll('button').forEach((b) => b.classList.toggle('on', offDaysPick.includes(Number(b.dataset.day))));
}
function openSettings() {
  const s = store.settings;
  $('sName').value = s.name || '';
  $('sRate').value = s.rate || 0;
  $('sGoal').value = s.goalHours || 0;
  $('sGoalWeek').value = s.goalWeekHours || 0;
  $('sDark').checked = s.theme === 'dark';
  reminderPick = s.reminderTime || '18:00';
  $('sReminder').checked = !!s.reminder;
  $('sReminderTimeText').textContent = reminderPick;
  $('reminderTimeField').hidden = !s.reminder;
  setStepper('sShiftRemind', s.shiftRemindHours || 9);
  setStepper('sShiftMax', s.shiftMaxHours || 12);
  setStepper('sAutoBreak', s.autoBreakMin != null ? s.autoBreakMin : DEFAULT_AUTO_BREAK_MIN);
  offDaysPick = Array.isArray(s.offDays) ? [...s.offDays] : [];
  renderOffDaysChips();
  renderPaletteRow();
  renderJobsList();
  renderSyncStatus();
  settingsFormSnapshot = serializeSettingsForm();
  openSheet($('settingsSheet'));
}
async function tryCloseSettings() {
  if (isSettingsDirty() && !(await confirmDiscard())) return;
  closeSheet($('settingsSheet'));
}

// ------------------------------------------------------------------ workplaces / jobs
function renderJobFilter() {
  const jobs = jobsList();
  const html = jobs.length
    ? `<button class="${jobFilter === null ? 'on' : ''}" data-job="">הכל</button>` +
      jobs.map((j) => `<button class="${jobFilter === j.id ? 'on' : ''}" data-job="${j.id}">${escapeHtml(j.name)}</button>`).join('')
    : '';
  ['jobFilterR', 'jobFilterM'].forEach((id) => { const el = $(id); if (el) { el.innerHTML = html; el.hidden = jobs.length === 0; } });
}
function setJobFilter(id) { if (selectMode) exitSelectMode(); jobFilter = id || null; renderJobFilter(); renderAll(); renderMore(); }

function renderJobsList() {
  const jobs = jobsList(), el = $('jobsList');
  el.innerHTML = jobs.length
    ? jobs.map((j) => `<div class="job-row" data-job="${j.id}"><span class="jn">${escapeHtml(j.name)}</span><span class="jr">₪${j.rate || 0}/שעה</span><span class="jedit">${svg('pencil')}</span></div>`).join('')
    : `<div class="jobs-empty">אין מקומות עבודה. הוסיפו כדי לשייך רישומים ולראות שכר נפרד לכל מקום.</div>`;
}
let jobFormSnapshot = '';
function serializeJobForm() { return JSON.stringify({ n: $('jName').value, r: $('jRate').value }); }
function isJobDirty() { return serializeJobForm() !== jobFormSnapshot; }
function openJob(id) {
  editingJobId = id;
  const del = $('deleteJob');
  if (id) {
    const j = jobsList().find((x) => x.id === id);
    if (!j) return;
    $('jobSheetTitle').textContent = 'עריכת מקום';
    $('jName').value = j.name; $('jRate').value = j.rate ?? '';
    del.hidden = false;
  } else {
    $('jobSheetTitle').textContent = 'מקום עבודה חדש';
    $('jobForm').reset();
    del.hidden = true;
  }
  jobFormSnapshot = serializeJobForm();
  openSheet($('jobSheet'));
}
async function tryCloseJob() {
  if (isJobDirty() && !(await confirmDiscard())) return;
  closeSheet($('jobSheet'));
}
function submitJob(ev) {
  ev.preventDefault();
  const name = $('jName').value.trim();
  if (!name) { toast('נא להזין שם'); return; }
  const rate = $('jRate').value === '' ? 0 : Number($('jRate').value) || 0;
  let jobs = jobsList().slice();
  if (editingJobId) jobs = jobs.map((j) => (j.id === editingJobId ? { ...j, name, rate } : j));
  else jobs.push({ id: uid(), name, rate });
  store.saveSettings({ jobs });
  jobFormSnapshot = serializeJobForm();
  closeSheet($('jobSheet'));
  renderJobsList(); renderJobFilter();
  toast('נשמר');
}
async function deleteCurrentJob() {
  if (!editingJobId) return;
  const ok = await showConfirm({ title: 'למחוק מקום עבודה?', message: 'הרישומים שלו יישארו — אבל בלי שיוך למקום.', confirmText: 'מחיקה', danger: true, icon: 'trash' });
  if (!ok) return;
  const jobs = jobsList().filter((j) => j.id !== editingJobId);
  if (jobFilter === editingJobId) jobFilter = null;
  store.saveSettings({ jobs });
  jobFormSnapshot = serializeJobForm();
  closeSheet($('jobSheet'));
  renderJobsList(); renderJobFilter(); renderAll(); renderMore();
  toast('נמחק');
}
function renderPaletteRow() {
  const row = $('paletteRow');
  const cur = store.settings.palette || 'teal';
  row.innerHTML = Object.entries(PALETTES).map(([id, c]) =>
    `<button type="button" class="swatch ${id === cur ? 'on' : ''}" data-pal="${id}" aria-label="${id}" style="--sw-p:${c[0]};--sw-a:${c[2]}"></button>`
  ).join('');
}
function selectPalette(id) {
  store.saveSettings({ palette: id });
  applyTheme();
  renderPaletteRow();
}
let lastSyncState = null;
function renderSyncStatus() {
  const el = $('syncStatus'), btn = $('authBtn'), acc = $('settingsBtn');
  const setDot = (state) => { if (acc) { acc.classList.toggle('sync-pending', state === 'pending' || state === 'offline'); } };
  if (!store.cloudAvailable) { el.textContent = 'מצב שמירה: מקומי במכשיר'; el.dataset.state = 'local'; btn.hidden = true; setDot('local'); return; }
  btn.hidden = false;
  if (!store.user) { el.textContent = 'מצב שמירה: מקומי · התחברו לסנכרון בענן'; el.dataset.state = 'local'; btn.textContent = 'התחברות לחשבון Google'; setDot('local'); return; }
  btn.textContent = 'התנתקות';
  const who = store.user.email || store.user.name || 'מחובר';
  const state = store.syncState;
  el.dataset.state = state;
  el.textContent = {
    synced: `מסונכרן בענן · ${who}`,
    pending: 'מעלה שינויים לענן…',
    offline: 'אופליין — הנתונים שמורים במכשיר ויסונכרנו כשהחיבור יחזור',
  }[state] || `מסונכרן בענן · ${who}`;
  setDot(state);
  // confirm only after genuinely reconnecting from offline — routine online
  // saves (pending→synced) stay silent.
  if (lastSyncState === 'offline' && state === 'synced') toast('הכל סונכרן לענן ✓');
  lastSyncState = state;
}

// signed-in indicator: show the user's avatar (with a synced ring) on the
// top-bar button, and toast once when a sign-in actually completes.
function updateAccountUI() {
  const btn = $('settingsBtn'), u = store.user;
  if (u) {
    btn.classList.add('synced');
    btn.setAttribute('aria-label', 'החשבון שלי — ' + (u.name || ''));
    btn.innerHTML = u.photo
      ? `<img class="avatar" src="${u.photo}" referrerpolicy="no-referrer" alt="">`
      : `<span class="avatar-initial">${escapeHtml((u.name || '?').trim().charAt(0) || '?')}</span>`;
    if (sessionStorage.getItem('wl_signin_pending')) {
      sessionStorage.removeItem('wl_signin_pending');
      toast(`מחובר כ${u.name} · הנתונים מסונכרנים ☁`);
    }
  } else {
    btn.classList.remove('synced');
    btn.setAttribute('aria-label', 'הגדרות');
    btn.innerHTML = svg('settings');
  }
}
// Read + sanitize the forgotten-clock-out hours: reminder in 1..23, auto-close
// in 2..24 and always strictly greater than the reminder.
function shiftHoursFromForm() {
  let remind = Math.round(Number($('sShiftRemind').value)) || 9;
  let max = Math.round(Number($('sShiftMax').value)) || 12;
  remind = Math.min(23, Math.max(1, remind));
  max = Math.min(24, Math.max(2, max));
  if (max <= remind) max = Math.min(24, remind + 1);
  return { shiftRemindHours: remind, shiftMaxHours: max };
}

function submitSettings(ev) {
  ev.preventDefault();
  store.saveSettings({
    name: $('sName').value.trim(), rate: Number($('sRate').value) || 0,
    goalHours: Number($('sGoal').value) || 0, goalWeekHours: Number($('sGoalWeek').value) || 0,
    theme: $('sDark').checked ? 'dark' : 'light',
    reminder: $('sReminder').checked, reminderTime: reminderPick,
    offDays: [...offDaysPick].sort(),
    autoBreakMin: Math.min(120, Math.max(0, Math.round(Number($('sAutoBreak').value)) || 0)),
    ...shiftHoursFromForm(),
  });
  applyTheme();
  settingsFormSnapshot = serializeSettingsForm();
  closeSheet($('settingsSheet')); toast('ההגדרות נשמרו');
  reminderNotifiedFor = ''; refreshReminder();
}

// ------------------------------------------------------------------ daily reminder
// A local reminder: while the app is open, once the reminder time has passed and
// no hours were logged today, show an in-app banner (always) and a system
// notification (if permission was granted). No backend / push — works when the
// app is open in the foreground.
function reminderDue() {
  const s = store.settings;
  if (!s.reminder) return false;
  if (todayCount() > 0 || getActive()) return false; // already logged / clocked in
  const now = new Date();
  if (Array.isArray(s.offDays) && s.offDays.includes(now.getDay())) return false; // marked as a non-work day
  const [h, m] = (s.reminderTime || '18:00').split(':').map(Number);
  return now.getHours() * 60 + now.getMinutes() >= (h || 0) * 60 + (m || 0);
}
// Notifications in an installed PWA must be shown by the service worker —
// `new Notification()` fails silently on mobile (and always on iOS).
async function showLocalNotification(title, body, tag = 'wl-daily') {
  if (!('Notification' in window) || Notification.permission !== 'granted') return false;
  const opts = { body, tag, renotify: true, icon: './icons/icon-192.png', badge: './icons/icon-192.png', dir: 'rtl', lang: 'he' };
  try {
    if ('serviceWorker' in navigator && navigator.serviceWorker.ready) {
      const reg = await navigator.serviceWorker.ready;
      await reg.showNotification(title, opts);
      return true;
    }
  } catch (_) { /* fall through to the legacy API */ }
  try { new Notification(title, opts); return true; } catch (_) { return false; }
}
function refreshReminder() {
  const banner = $('reminderBanner');
  if (!banner) return;
  const today = todayISO();
  const show = reminderDue() && reminderDismissedFor !== today;
  banner.hidden = !show;
  if (show && reminderNotifiedFor !== today) {
    reminderNotifiedFor = today;
    showLocalNotification('שעון עבודה', 'עוד לא רשמת שעות היום — הקש כדי להזין');
  }
}
function startReminderLoop() {
  refreshReminder();
  setInterval(refreshReminder, 60000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshReminder(); });
  // keep this device's push subscription fresh & stored whenever reminders are on
  if (store.settings.reminder && 'Notification' in window && Notification.permission === 'granted') subscribePush();
}
// Returns 'granted' | 'denied' | 'default' | 'unsupported'.
async function requestNotifyPermission() {
  if (!('Notification' in window)) return 'unsupported';
  let perm = Notification.permission;
  if (perm === 'default') { try { perm = await Notification.requestPermission(); } catch (_) {} }
  return perm;
}
// ---- web push: subscribe this device so reminders arrive when the app is closed ----
function urlB64ToUint8Array(base64) {
  const pad = '='.repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + pad).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64), arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}
async function subscribePush() {
  try {
    if (!('serviceWorker' in navigator) || !('PushManager' in window) || !VAPID_PUBLIC_KEY) return false;
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToUint8Array(VAPID_PUBLIC_KEY) });
    store.addPushSub(sub.toJSON());
    const tz = -new Date().getTimezoneOffset(); // minutes east of UTC → server sends at local time
    if (store.settings.tz !== tz) store.saveSettings({ tz });
    return true;
  } catch (e) { console.warn('push subscribe failed', e); return false; }
}
async function unsubscribePush() {
  try {
    if (!('serviceWorker' in navigator)) return;
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) { store.removePushSub(sub.endpoint); await sub.unsubscribe().catch(() => {}); }
  } catch (_) {}
}
// Queues an immediate background push so the user can close the app and
// confirm notifications arrive. Fires on the next server run (bypasses the
// reminder-time and already-logged checks). No time picker — that only created
// a race where the workflow ran before the chosen time.
async function sendTestReminder() {
  const perm = await requestNotifyPermission();
  if (perm !== 'granted') { toast(perm === 'denied' ? 'ההתראות חסומות — יש לאפשר אותן בהגדרות המכשיר' : 'צריך לאשר התראות תחילה'); return; }
  const ok = await subscribePush();
  if (!ok) { toast('לא ניתן לרשום את המכשיר להתראות'); return; }
  store.saveSettings({ pushTestAt: Date.now() });
  toast('בקשת בדיקה נרשמה ✓ — סגור את האפליקציה, וההתראה תגיע תוך כדקה');
}
async function enableReminderFlow() {
  const perm = await requestNotifyPermission();
  if (perm === 'granted') {
    const pushed = await subscribePush(); // background delivery when app is closed
    const shown = await showLocalNotification('התזכורות פעילות ✓', pushed ? 'נשלח לך תזכורת יומית גם כשהאפליקציה סגורה' : 'נשלח לך תזכורת יומית בשעה שבחרת', 'wl-test');
    toast(shown ? 'התזכורות הופעלו — שלחנו התראת בדיקה' : 'התזכורת הופעלה');
  } else if (perm === 'denied') {
    toast('ההתראות חסומות — יש לאפשר אותן בהגדרות הדפדפן/המכשיר');
  } else if (perm === 'unsupported') {
    toast('המכשיר לא תומך בהתראות מערכת');
  } else {
    toast('התזכורת הופעלה');
  }
}

async function handleAuth() {
  try {
    if (store.user) { await store.signOut(); toast('התנתקת'); }
    else { sessionStorage.setItem('wl_signin_pending', '1'); await store.signIn(); }
  } catch (e) { sessionStorage.removeItem('wl_signin_pending'); toast('ההתחברות נכשלה'); console.warn(e); }
}

// ------------------------------------------------------------------ export
function openExport() { if (!monthEntries().length) { toast('אין רישומים לייצוא בחודש זה'); return; } openSheet($('exportSheet')); }
async function runExportPdf() {
  closeSheet($('exportSheet'));
  toast('מכין PDF…');
  try {
    const res = await exportPDF({ entries: monthEntries(), settings: store.settings, year: viewYear, month: viewMonth });
    toast(res.method === 'file' ? 'קובץ ה‑PDF הורד' : 'בחרו "שמירה כ‑PDF" בחלון ההדפסה');
  } catch (e) { console.error(e); toast('שגיאה בייצוא ה‑PDF'); }
}
function runExportCsv() { closeSheet($('exportSheet')); try { exportCSV({ entries: monthEntries(), settings: store.settings, year: viewYear, month: viewMonth }); toast('קובץ ה‑CSV הורד'); } catch (e) { console.error(e); toast('שגיאה בייצוא ה‑CSV'); } }

// ------------------------------------------------------------------ toast
let toastTimer = null;
function toast(msg) {
  const t = $('toast'); t.textContent = msg; t.hidden = false;
  requestAnimationFrame(() => t.classList.add('show'));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.classList.remove('show'); setTimeout(() => { t.hidden = true; }, 250); }, 2600);
}

// ------------------------------------------------------------------ "עוד" page
function hoursLbl(dec) { return fmtHours(Math.round(dec * 60)); }
function money(n) { return fmtMoney(n, '₪'); }

function renderMore() {
  const box = $('moreCards');
  if (!box) return;
  const entries = jobFilteredEntries(), s = store.settings;
  const p = payrollOf(s);
  const ps = payslip(entries, s, viewYear, viewMonth);
  const hasData = ps.gross > 0;

  // --- payslip card ---
  let html = `
  <div class="fcard">
    <div class="fcard-head"><span class="fic">${svg('csv')}</span><span class="fcard-title">תלוש נטו משוער</span><span class="fcard-sub">${MONTHS[viewMonth]}</span></div>
    ${hasData ? `
      <div class="fbig primary">${money(ps.net)}</div>
      <div class="fbig-label">נטו להערכה · ${hoursLbl(ps.hours)} שעות</div>
      <div class="frows">
        <div class="frow"><span class="fk">ברוטו</span><span class="fv">${money(ps.gross)}</span></div>
        ${ps.incomeTax ? `<div class="frow minus"><span class="fk">מס הכנסה (${p.incomeTax}%)</span><span class="fv">−${money(ps.incomeTax)}</span></div>` : ''}
        ${ps.socialHealth ? `<div class="frow minus"><span class="fk">ביטוח לאומי + בריאות (${p.socialHealth}%)</span><span class="fv">−${money(ps.socialHealth)}</span></div>` : ''}
        ${ps.pension ? `<div class="frow minus"><span class="fk">פנסיה עובד (${p.pensionEmployee}%)</span><span class="fv">−${money(ps.pension)}</span></div>` : ''}
        ${ps.travel ? `<div class="frow plus"><span class="fk">נסיעות</span><span class="fv">+${money(ps.travel)}</span></div>` : ''}
        <div class="frow total"><span class="fk">נטו</span><span class="fv">${money(ps.net)}</span></div>
      </div>` : `<div class="hint-row">אין שעות עבודה בחודש זה. הגדירו שכר לשעה כדי לראות הערכה.</div>`}
  </div>`;

  // --- pension card ---
  if (hasData) {
    const pen = pensionForMonth(entries, s, viewYear, viewMonth);
    html += `
    <div class="fcard">
      <div class="fcard-head"><span class="fic">${svg('chart')}</span><span class="fcard-title">פנסיה — נצבר החודש</span></div>
      <div class="fbig primary">${money(pen.total)}</div>
      <div class="frows">
        <div class="frow"><span class="fk">הפרשת עובד (${p.pensionEmployee}%)</span><span class="fv">${money(pen.employee)}</span></div>
        <div class="frow"><span class="fk">הפרשת מעסיק (${p.pensionEmployer}%)</span><span class="fv">${money(pen.employer)}</span></div>
        <div class="frow"><span class="fk">פיצויים (${p.severance}%)</span><span class="fv">${money(pen.severance)}</span></div>
      </div>
    </div>`;
  }

  // --- overtime card ---
  if (p.overtime && hasData) {
    const otg = grossForMonth(entries, s, viewYear, viewMonth);
    const flat = grossForMonth(entries, { ...s, payroll: { ...p, overtime: false } }, viewYear, viewMonth);
    const extra = otg.gross - flat.gross;
    html += `
    <div class="fcard">
      <div class="fcard-head accent"><span class="fic">${svg('clock')}</span><span class="fcard-title">שעות נוספות</span></div>
      <div class="fgrid">
        <div class="fg"><b>${hoursLbl(otg.ot125)}</b><span>ב‑125%</span></div>
        <div class="fg"><b>${hoursLbl(otg.ot150)}</b><span>ב‑150%</span></div>
        <div class="fg"><b class="">${money(extra)}</b><span>תוספת שכר</span></div>
      </div>
    </div>`;
  } else if (!p.overtime) {
    html += `<div class="fcard"><div class="fcard-head accent"><span class="fic">${svg('clock')}</span><span class="fcard-title">שעות נוספות</span></div><div class="hint-row">הפעילו חישוב שעות נוספות (125%/150%) ב‑⚙ הגדרות שכר.</div></div>`;
  }

  // --- yearly chart ---
  const yr = yearlyByMonth(entries, s, viewYear);
  const maxH = Math.max(1, ...yr.map((r) => r.hours));
  const totalH = yr.reduce((a, r) => a + r.hours, 0);
  const totalG = yr.reduce((a, r) => a + r.gross, 0);
  html += `
  <div class="fcard">
    <div class="fcard-head"><span class="fic">${svg('chart')}</span><span class="fcard-title">סיכום שנתי</span>
      <span class="year-switch fcard-sub" style="margin-inline-start:auto"><button data-yr="-1" aria-label="שנה קודמת">${svg('chevRight')}</button><b>${viewYear}</b><button data-yr="1" aria-label="שנה הבאה">${svg('chevLeft')}</button></span>
    </div>
    <svg class="ychart-svg" viewBox="0 0 120 100" preserveAspectRatio="none" aria-hidden="true">
      ${yr.map((r, i) => { const bh = Math.max(2, (r.hours / maxH) * 100); const cls = r.month === viewMonth ? 'sbar cur' : (r.hours === 0 ? 'sbar empty' : 'sbar'); return `<rect class="${cls}" x="${i * 10 + 2}" y="${(100 - bh).toFixed(1)}" width="6" height="${bh.toFixed(1)}" rx="1.4"><title>${r.label}: ${hoursLbl(r.hours)}</title></rect>`; }).join('')}
    </svg>
    <div class="ychart-labels">${yr.map((r) => `<span>${r.label.slice(0, 3)}</span>`).join('')}</div>
    <div class="ychart-foot"><span class="fbig-label">סה״כ ${hoursLbl(totalH)} שעות</span><span class="fbig-label">${money(totalG)}</span></div>
  </div>`;

  // --- averages ---
  const av = averages(entries, s, viewYear, viewMonth);
  html += `
  <div class="fcard">
    <div class="fcard-head"><span class="fic">${svg('chart')}</span><span class="fcard-title">ממוצעים</span><span class="fcard-sub">${MONTHS[viewMonth]}</span></div>
    <div class="fgrid">
      <div class="fg"><b>${hoursLbl(av.avgDay)}</b><span>ממוצע ליום</span></div>
      <div class="fg"><b>${hoursLbl(av.avgWeek)}</b><span>ממוצע לשבוע</span></div>
      <div class="fg"><b>${av.busiestDow >= 0 ? DOW[av.busiestDow] : '—'}</b><span>היום העמוס</span></div>
    </div>
  </div>`;

  // --- vacation balance ---
  const vb = vacationBalance(entries, s, viewYear);
  const vpct = vb.entitled ? Math.min(100, (vb.used / vb.entitled) * 100) : 0;
  html += `
  <div class="fcard">
    <div class="fcard-head accent"><span class="fic">${svg('vacation')}</span><span class="fcard-title">חופשה ${viewYear}</span><span class="fcard-sub">${vb.sick} ימי מחלה</span></div>
    <div class="vac-track"><div class="vac-fill" style="width:${vpct}%"></div></div>
    <div class="frow" style="border:none;padding-top:2px"><span class="fk">נוצלו ${vb.used} מתוך ${vb.entitled}</span><span class="fv">נותרו ${vb.remaining} ימים</span></div>
    <button type="button" class="btn ghost-line" id="markVacBtn" style="margin-top:10px">+ סימון חופשה שנוצלה</button>
  </div>`;

  // --- recreation ---
  const rc = recreationAnnual(s);
  html += `
  <div class="fcard">
    <div class="fcard-head"><span class="fic">${svg('vacation')}</span><span class="fcard-title">דמי הבראה (שנתי)</span></div>
    <div class="fbig accent">${money(rc.total)}</div>
    <div class="fbig-label">${rc.days} ימים × ${money(rc.rate)}</div>
  </div>`;

  box.innerHTML = html;
}

// ------------------------------------------------------------------ payroll settings
let payrollFormSnapshot = '';
let payrollTravelMode = 'none'; // 'none' | 'perDay' | 'monthly' — chosen in the travel seg control
let payrollPayMode = 'hourly'; // 'hourly' | 'global' — chosen in the pay-type seg control
function serializePayrollForm() {
  const vals = ['pOvertime', 'pIncomeTax', 'pSocialHealth', 'pPensionEmp', 'pPensionEr', 'pSeverance', 'pVacDays', 'pRecDays', 'pRecRate', 'pSickHours', 'pGlobalSalary', 'pTravelDay', 'pTravelMonth']
    .map((id) => ($(id).type === 'checkbox' ? $(id).checked : $(id).value));
  return JSON.stringify([...vals, payrollTravelMode, payrollPayMode]);
}
function isPayrollDirty() { return serializePayrollForm() !== payrollFormSnapshot; }
function renderTravelMode() {
  $('pTravelMode').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.mode === payrollTravelMode));
  $('pTravelPerDayField').hidden = payrollTravelMode !== 'perDay';
  $('pTravelMonthlyField').hidden = payrollTravelMode !== 'monthly';
}
// A "global" (fixed monthly salary) employee doesn't earn overtime tiers or
// per-entry pay the way an hourly employee does — hide the fields that only
// make sense for hourly pay so the form doesn't imply they still apply.
function renderPayMode() {
  const isGlobal = payrollPayMode === 'global';
  $('pPayMode').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.mode === payrollPayMode));
  $('pGlobalSalaryField').hidden = !isGlobal;
  $('pPayModeNote').hidden = !isGlobal;
  $('pOvertimeField').hidden = isGlobal;
}
function openPayroll() {
  const p = payrollOf(store.settings);
  $('pOvertime').checked = !!p.overtime;
  $('pIncomeTax').value = p.incomeTax;
  $('pSocialHealth').value = p.socialHealth;
  $('pPensionEmp').value = p.pensionEmployee;
  $('pPensionEr').value = p.pensionEmployer;
  $('pSeverance').value = p.severance;
  $('pVacDays').value = p.annualVacationDays;
  $('pRecDays').value = p.recreationDays;
  $('pRecRate').value = p.recreationDayRate;
  $('pSickHours').value = p.sickDayHours;
  $('pGlobalSalary').value = p.globalSalary;
  $('pTravelDay').value = p.travelPerDay;
  $('pTravelMonth').value = p.travelMonthly;
  payrollTravelMode = p.travelMode;
  payrollPayMode = p.payMode;
  renderTravelMode();
  renderPayMode();
  payrollFormSnapshot = serializePayrollForm();
  openSheet($('payrollSheet'));
}
async function tryClosePayroll() {
  if (isPayrollDirty() && !(await confirmDiscard())) return;
  closeSheet($('payrollSheet'));
}
function submitPayroll(ev) {
  ev.preventDefault();
  const num = (id, def) => { const v = Number($(id).value); return Number.isFinite(v) ? v : def; };
  store.saveSettings({ payroll: {
    payMode: payrollPayMode,
    globalSalary: num('pGlobalSalary', 0),
    overtime: $('pOvertime').checked,
    otThreshold: DEFAULT_PAYROLL.otThreshold,
    incomeTax: num('pIncomeTax', 0),
    socialHealth: num('pSocialHealth', 0),
    pensionEmployee: num('pPensionEmp', 0),
    pensionEmployer: num('pPensionEr', 0),
    severance: num('pSeverance', 0),
    annualVacationDays: num('pVacDays', 0),
    recreationDays: num('pRecDays', 0),
    recreationDayRate: num('pRecRate', 0),
    sickDayHours: num('pSickHours', DEFAULT_PAYROLL.sickDayHours),
    travelMode: payrollTravelMode,
    travelPerDay: num('pTravelDay', 0),
    travelMonthly: num('pTravelMonth', 0),
  } });
  payrollFormSnapshot = serializePayrollForm();
  closeSheet($('payrollSheet'));
  renderMore();
  toast('הגדרות השכר נשמרו');
}

// ------------------------------------------------------------------ quick vacation-days entry
let vqDate = todayISO();
function fmtDateShort(iso) { const d = parseDate(iso); return `${d.getDate()} ב${MONTHS[d.getMonth()]}`; }
// Walks forward from startISO collecting `days` calendar dates, optionally
// skipping weekdays marked as non-work (settings.offDays) — a vacation day
// only "counts" on a day you'd otherwise have worked. Capped at a 90-day
// lookahead so an all-days-off configuration can't loop forever.
function computeVacDates(startISO, days, skipOff) {
  const offDays = Array.isArray(store.settings.offDays) ? store.settings.offDays : [];
  const dates = [];
  let d = parseDate(startISO), guard = 0;
  while (dates.length < days && guard < 90) {
    if (!(skipOff && offDays.includes(d.getDay()))) dates.push(toISO(d));
    d = new Date(d); d.setDate(d.getDate() + 1);
    guard++;
  }
  return dates;
}
function renderVacQuickPreview() {
  const days = Number($('vqDays').value) || 1;
  const dates = computeVacDates(vqDate, days, $('vqSkipOff').checked);
  $('vqPreview').textContent = dates.length
    ? `יתווספו ${dates.length} ימי חופשה: ${fmtDateShort(dates[0])} – ${fmtDateShort(dates[dates.length - 1])}`
    : 'לא נמצאו ימים מתאימים';
}
function openVacQuick() {
  vqDate = todayISO();
  $('vqDateText').textContent = fmtDateShort(vqDate);
  setStepper('vqDays', 1);
  $('vqSkipOff').checked = true;
  renderVacQuickPreview();
  openSheet($('vacQuickSheet'));
}
function submitVacQuick(ev) {
  ev.preventDefault();
  const days = Number($('vqDays').value) || 1;
  const dates = computeVacDates(vqDate, days, $('vqSkipOff').checked);
  if (!dates.length) { toast('לא נמצאו ימים מתאימים'); return; }
  const alreadyTaken = new Set(store.entries.map((e) => e.date));
  const toAdd = dates.filter((iso) => !alreadyTaken.has(iso)).map((date) => ({ type: 'vacation', date, jobId: '', start: '', end: '', breakMin: 0, rate: '', note: '' }));
  if (!toAdd.length) { toast('כל הימים שנבחרו כבר קיימים ברישום'); return; }
  const created = store.addEntries(toAdd);
  const skipped = dates.length - toAdd.length;
  const d0 = parseDate(dates[0]); viewYear = d0.getFullYear(); viewMonth = d0.getMonth();
  closeSheet($('vacQuickSheet'));
  renderMonth(); renderAll(); renderMore();
  toast(skipped ? `נוספו ${created.length} ימי חופשה (${skipped} דולגו — כבר קיים רישום)` : `נוספו ${created.length} ימי חופשה`);
}

// ------------------------------------------------------------------ tabs
// ============================================================ פנקס / NOTES
const CAT_COLORS = {
  teal: '#0D9488', blue: '#2563EB', violet: '#7C3AED', rose: '#E11D48',
  amber: '#D97706', emerald: '#059669', orange: '#EA580C', slate: '#475569',
};
function noteCats() { return Array.isArray(store.noteCats) ? store.noteCats : []; }
function notesAll() { return Array.isArray(store.notes) ? store.notes : []; }
function catById(id) { return noteCats().find((c) => c.id === id) || null; }
function catColor(id) { const c = catById(id); return c ? (CAT_COLORS[c.color] || c.color || CAT_COLORS.teal) : 'var(--border)'; }
function catName(id) { const c = catById(id); return c ? c.name : ''; }
function relTime(ts) {
  if (!ts) return '';
  const d = new Date(ts), now = new Date();
  const days = Math.floor((now - d) / 86400000);
  if (days <= 0 && d.toDateString() === now.toDateString()) return 'היום';
  if (days <= 1) return 'אתמול';
  if (days < 7) return `לפני ${days} ימים`;
  return `${d.getDate()} ב${MONTHS[d.getMonth()]}`;
}

function noteMatches(n, q) {
  if (!q) return true;
  const hay = [n.title, n.body, ...(n.tags || []), ...(n.fields || []).flatMap((f) => [f.label, f.value]), ...(n.checklist || []).map((c) => c.text)].join(' ').toLowerCase();
  return hay.includes(q);
}
function filteredNotes() {
  const q = noteQuery.trim().toLowerCase();
  return notesAll().filter((n) => {
    if (noteFilter === '__none') { if (n.category) return false; }
    else if (noteFilter && n.category !== noteFilter) return false;
    return noteMatches(n, q);
  }).sort((a, b) => (b.pinned - a.pinned) || (b.updated || 0) - (a.updated || 0));
}

function renderNoteCatFilter() {
  const cats = noteCats();
  const el = $('noteCatFilter');
  const chip = (id, label, active, dot) => `<button class="${active ? 'on' : ''}" data-cat="${id}">${dot ? `<span class="cat-dot" style="background:${dot}"></span>` : ''}${escapeHtml(label)}</button>`;
  let html = chip('', 'הכל', noteFilter === null, '');
  html += cats.map((c) => chip(c.id, c.name, noteFilter === c.id, CAT_COLORS[c.color] || c.color)).join('');
  if (notesAll().some((n) => !n.category)) html += chip('__none', 'ללא קטגוריה', noteFilter === '__none', '');
  el.innerHTML = html;
  el.hidden = cats.length === 0;
}
function setNoteFilter(id) { noteFilter = id === '' ? null : id; renderNoteCatFilter(); renderNotes(); }

function noteLayout() { return store.settings.noteLayout === 'compact' ? 'compact' : 'detailed'; }
function toggleNoteLayout() {
  store.saveSettings({ noteLayout: noteLayout() === 'detailed' ? 'compact' : 'detailed' });
  updateLayoutToggle();
  renderNotes();
}
function updateLayoutToggle() {
  const btn = $('layoutToggle'); if (!btn) return;
  const compact = noteLayout() === 'compact';
  btn.innerHTML = svg(compact ? 'rows' : 'grid'); // show the layout you'll switch TO
  btn.setAttribute('aria-label', compact ? 'תצוגה מפורטת' : 'תצוגה קומפקטית');
}

function copyBtn(v) { return v ? `<button type="button" class="nf-copy" data-copy="${escapeHtml(v)}" aria-label="העתקה">${svg('copy')}</button>` : ''; }

function cardDetailed(n) {
  const col = catColor(n.category);
  const done = (n.checklist || []).filter((c) => c.done).length, total = (n.checklist || []).length;
  const fields = (n.fields || []).filter((f) => f.label || f.value).slice(0, 4).map((f) =>
    `<div class="nf-row"><span class="nf-label">${escapeHtml(f.label || '')}</span><span class="nf-val${f.secret ? ' masked' : ''}">${f.secret ? '••••••' : escapeHtml(f.value || '')}</span>${copyBtn(f.value)}</div>`).join('');
  const tags = (n.tags || []).slice(0, 6).map((t) => `<span class="ntag">#${escapeHtml(t)}</span>`).join('');
  const pct = total ? Math.round((done / total) * 100) : 0;
  return `<article class="note-card detailed" data-id="${n.id}" style="--cat:${col}">
    <div class="note-head">
      ${n.category ? `<span class="note-cat-pill" style="--cat:${col}">${escapeHtml(catName(n.category))}</span>` : '<span></span>'}
      ${n.pinned ? `<span class="note-pin">${svg('pin')}</span>` : ''}
    </div>
    <h4 class="note-title">${escapeHtml(n.title || 'ללא כותרת')}</h4>
    ${n.body ? `<p class="note-snippet">${escapeHtml(n.body)}</p>` : ''}
    ${fields ? `<div class="note-fields">${fields}</div>` : ''}
    ${total ? `<div class="note-progress"><div class="np-track"><div class="np-fill" style="width:${pct}%"></div></div><span class="np-label">${svg('check')} ${done}/${total}</span></div>` : ''}
    ${tags ? `<div class="note-tags">${tags}</div>` : ''}
    <div class="note-foot">${effectiveRemindAt(n) > Date.now() ? `<span class="note-remind">${svg('bell')}${fmtRemindRule(n)}</span>` : '<span></span>'}<span class="note-date">עודכן ${relTime(n.updated)}</span></div>
  </article>`;
}
function cardCompact(n) {
  const col = catColor(n.category);
  const done = (n.checklist || []).filter((c) => c.done).length, total = (n.checklist || []).length;
  const badges = [];
  if (effectiveRemindAt(n) > Date.now()) badges.push(`<span class="nb remind">${svg('bell')}</span>`);
  if ((n.fields || []).length) badges.push(`<span class="nb">${svg('copy')}${(n.fields || []).length}</span>`);
  if (total) badges.push(`<span class="nb">${svg('check')}${done}/${total}</span>`);
  const sub = n.body ? escapeHtml(n.body) : (n.fields || []).map((f) => (f.secret ? '••••' : f.value)).filter(Boolean).join(' · ');
  return `<article class="note-card compact" data-id="${n.id}" style="--cat:${col}">
    <div class="note-head">
      <span class="cat-dot" style="background:${n.category ? col : 'var(--border)'}"></span>
      ${n.pinned ? `<span class="note-pin">${svg('pin')}</span>` : ''}
    </div>
    <h4 class="note-title">${escapeHtml(n.title || 'ללא כותרת')}</h4>
    ${sub ? `<p class="note-snippet">${sub}</p>` : ''}
    <div class="note-foot">${badges.length ? `<span class="note-badges">${badges.join('')}</span>` : '<span></span>'}<span class="note-date">${relTime(n.updated)}</span></div>
  </article>`;
}
function grid(notes) {
  const layout = noteLayout();
  const card = layout === 'compact' ? cardCompact : cardDetailed;
  return `<div class="notes-grid ${layout}">${notes.map(card).join('')}</div>`;
}

function renderNotes() {
  renderNoteCatFilter();
  updateLayoutToggle();
  const wrap = $('notesWrap'), empty = $('notesEmpty');
  const list = filteredNotes();
  if (!notesAll().length) { wrap.innerHTML = ''; empty.hidden = false; return; }
  empty.hidden = true;
  if (!list.length) { wrap.innerHTML = `<div class="notes-noresult">לא נמצאו פתקים${noteQuery ? ` עבור “${escapeHtml(noteQuery)}”` : ''}</div>`; return; }

  const pinned = list.filter((n) => n.pinned);
  const rest = list.filter((n) => !n.pinned);
  let html = '';

  // upcoming reminders overview (only in the default, unfiltered view)
  if (noteFilter === null && !noteQuery.trim()) {
    const upcoming = notesAll()
      .map((n) => ({ n, at: effectiveRemindAt(n) }))
      .filter((x) => x.at && x.at > Date.now())
      .sort((a, b) => a.at - b.at)
      .map((x) => x.n);
    if (upcoming.length) {
      html += `<div class="notes-section"><div class="notes-sec-head">${svg('bell')}<span>תזכורות קרובות</span></div><div class="upcoming-list">` +
        upcoming.map((n) => `<button type="button" class="upcoming-item" data-id="${n.id}">${svg('bell')}<span class="up-title">${escapeHtml(n.title || 'ללא כותרת')}</span><span class="up-time">${fmtRemindRule(n)}</span></button>`).join('') +
        `</div></div>`;
    }
  }
  if (pinned.length) html += `<div class="notes-section"><div class="notes-sec-head">${svg('pin')}<span>נעוצים</span></div>${grid(pinned)}</div>`;

  // detailed view catalogs by category; compact stays a dense flat grid
  const grouped = noteLayout() === 'detailed' && noteFilter === null && !noteQuery.trim();
  if (grouped) {
    noteCats().forEach((c) => {
      const items = rest.filter((n) => n.category === c.id);
      if (items.length) html += `<div class="notes-section"><div class="notes-sec-head"><span class="cat-dot" style="background:${CAT_COLORS[c.color] || c.color}"></span><span>${escapeHtml(c.name)}</span></div>${grid(items)}</div>`;
    });
    const uncat = rest.filter((n) => !n.category);
    if (uncat.length) html += `<div class="notes-section">${noteCats().length ? '<div class="notes-sec-head"><span>ללא קטגוריה</span></div>' : ''}${grid(uncat)}</div>`;
  } else if (rest.length) {
    html += grid(rest);
  }
  wrap.innerHTML = html;
}

// ---- note view (read) ----
let viewingNoteId = null;
function openNoteView(id) {
  const n = notesAll().find((x) => x.id === id);
  if (!n) return;
  viewingNoteId = id;
  const col = catColor(n.category);
  $('nvCat').innerHTML = n.category ? `<span class="nv-cat-pill" style="--cat:${col}">${escapeHtml(catName(n.category))}</span>` : '';
  const fields = (n.fields || []).filter((f) => f.label || f.value).map((f) => {
    const eye = f.secret ? `<button type="button" class="nf-eye" data-reveal data-val="${escapeHtml(f.value || '')}" aria-label="הצגה">${svg('eye')}</button>` : '';
    return `<div class="nv-field"><span class="nv-flabel">${escapeHtml(f.label || '')}${f.secret ? ` <span class="nv-lock">${svg('eyeOff')}</span>` : ''}</span><div class="nv-fval-row"><span class="nv-fval${f.secret ? ' masked' : ''}">${f.secret ? '••••••••' : escapeHtml(f.value || '')}</span>${eye}${copyBtn(f.value)}</div></div>`;
  }).join('');
  const checklist = (n.checklist || []).map((c, i) =>
    `<button type="button" class="nv-check ${c.done ? 'on' : ''}" data-vtoggle="${i}"><span class="nv-check-box">${c.done ? svg('check') : ''}</span><span class="nv-check-text">${escapeHtml(c.text || '')}</span></button>`).join('');
  const tags = (n.tags || []).map((t) => `<span class="ntag">#${escapeHtml(t)}</span>`).join('');
  $('noteViewBody').innerHTML = `
    <div class="nv-titlerow"><h2 class="nv-title">${escapeHtml(n.title || 'ללא כותרת')}</h2>${n.pinned ? `<span class="note-pin">${svg('pin')}</span>` : ''}</div>
    ${n.body ? `<p class="nv-body">${escapeHtml(n.body)}</p>` : ''}
    ${fields ? `<div class="nv-fields">${fields}</div>` : ''}
    ${checklist ? `<div class="nv-checklist">${checklist}</div>` : ''}
    ${tags ? `<div class="note-tags nv-tags">${tags}</div>` : ''}
    ${effectiveRemindAt(n) > Date.now() ? `<div class="nv-remind">${svg('bell')}<span>תזכורת: ${fmtRemindRule(n)}</span></div>` : ''}
    <div class="nv-meta">עודכן ${relTime(n.updated)}${n.created && n.created !== n.updated ? ` · נוצר ${relTime(n.created)}` : ''}</div>`;
  openSheet($('noteViewSheet'));
}

// ---- note editor ----
function renderNoteCatChips(sel) {
  const cats = noteCats();
  $('nCatChips').innerHTML =
    `<button type="button" data-cat="" class="${!sel ? 'on' : ''}">ללא</button>` +
    cats.map((c) => `<button type="button" data-cat="${c.id}" class="${sel === c.id ? 'on' : ''}" style="--cat:${CAT_COLORS[c.color] || c.color}"><span class="cat-dot" style="background:${CAT_COLORS[c.color] || c.color}"></span>${escapeHtml(c.name)}</button>`).join('') +
    `<button type="button" class="chip-add" id="newCatChip">+ קטגוריה</button>`;
}
function setNoteCat(id) { $('nCatChips').dataset.sel = id || ''; renderNoteCatChips(id || ''); }
function currentNoteCat() { return $('nCatChips').dataset.sel || ''; }

function renderNoteFields() {
  $('nFields').innerHTML = noteDraft.fields.map((f, i) =>
    `<div class="nfield-row" data-i="${i}">
      <input type="text" class="nfield-label" data-i="${i}" placeholder="תווית" value="${escapeHtml(f.label || '')}" />
      <input type="text" class="nfield-value" data-i="${i}" placeholder="ערך" value="${escapeHtml(f.value || '')}" />
      <button type="button" class="fld-secret ${f.secret ? 'on' : ''}" data-secret="${i}" aria-label="${f.secret ? 'שדה מוסתר' : 'הצגה גלויה'}" title="הסתרה — יוצג רק בלחיצה">${svg(f.secret ? 'eyeOff' : 'eye')}</button>
      <button type="button" class="row-del" data-del-field="${i}" aria-label="הסרה">${svg('trash')}</button>
    </div>`).join('');
}
function renderNoteChecklist() {
  $('nChecklist').innerHTML = noteDraft.checklist.map((c, i) =>
    `<div class="ncheck-row" data-i="${i}">
      <button type="button" class="ncheck-box ${c.done ? 'on' : ''}" data-toggle="${i}" aria-label="סימון">${c.done ? svg('check') : ''}</button>
      <input type="text" class="ncheck-text ${c.done ? 'done' : ''}" data-i="${i}" placeholder="משימה" value="${escapeHtml(c.text || '')}" />
      <button type="button" class="row-del" data-del-check="${i}" aria-label="הסרה">${svg('trash')}</button>
    </div>`).join('');
}
function renderNoteTags() {
  const wrap = $('nTagsWrap');
  wrap.querySelectorAll('.ntag-chip').forEach((x) => x.remove());
  const input = $('nTagInput');
  noteDraft.tags.forEach((t, i) => {
    const chip = document.createElement('span');
    chip.className = 'ntag-chip';
    chip.innerHTML = `#${escapeHtml(t)}<button type="button" data-del-tag="${i}" aria-label="הסרה">×</button>`;
    wrap.insertBefore(chip, input);
  });
}

let noteFormSnapshot = '';
function serializeNoteForm() { return JSON.stringify({ t: $('nTitle').value, b: $('nBody').value, p: $('nPin').checked, c: currentNoteCat(), d: noteDraft }); }
function isNoteDirty() { return serializeNoteForm() !== noteFormSnapshot; }
function openNote(id = null) {
  editingNoteId = id;
  const del = $('deleteNote');
  if (id) {
    const n = notesAll().find((x) => x.id === id);
    if (!n) return;
    $('noteSheetTitle').textContent = 'עריכת פתק';
    $('nTitle').value = n.title || '';
    $('nBody').value = n.body || '';
    $('nPin').checked = !!n.pinned;
    // remind: { mode:'once', at } | { mode:'weekly', days:[0-6], time:'HH:MM' } | null.
    // Older notes only have a plain remindAt timestamp — treat that as a one-time rule.
    const remind = n.remind || (n.remindAt ? { mode: 'once', at: n.remindAt } : null);
    noteDraft = { fields: (n.fields || []).map((f) => ({ ...f })), checklist: (n.checklist || []).map((c) => ({ ...c })), tags: [...(n.tags || [])], remind: remind ? { ...remind, days: remind.days ? [...remind.days] : undefined } : null };
    setNoteCat(n.category || '');
    del.hidden = false;
  } else {
    $('noteSheetTitle').textContent = 'פתק חדש';
    $('nTitle').value = ''; $('nBody').value = ''; $('nPin').checked = false;
    noteDraft = { fields: [], checklist: [], tags: [], remind: null };
    setNoteCat(noteFilter && noteFilter !== '__none' ? noteFilter : '');
    del.hidden = true;
  }
  renderNoteFields(); renderNoteChecklist(); renderNoteTags(); renderNoteRemind();
  autoGrow($('nBody'));
  noteFormSnapshot = serializeNoteForm();
  openSheet($('noteSheet'));
}
async function tryCloseNote() {
  if (isNoteDirty() && !(await confirmDiscard())) return;
  closeSheet($('noteSheet'));
}
// "3 ביולי, 14:30" — or "היום 14:30" / "מחר 14:30"
function fmtRemind(ts) {
  const d = new Date(ts), now = new Date();
  const t = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const sameDay = (a, b) => a.toDateString() === b.toDateString();
  const tom = new Date(now); tom.setDate(now.getDate() + 1);
  if (sameDay(d, now)) return `היום ${t}`;
  if (sameDay(d, tom)) return `מחר ${t}`;
  return `${d.getDate()} ב${MONTHS[d.getMonth()]}, ${t}`;
}
// Next future Date a weekly rule (days 0-6 + "HH:MM") fires, or null if no days chosen.
function nextRecurrence(days, time) {
  if (!Array.isArray(days) || !days.length || !time) return null;
  const [h, m] = time.split(':').map(Number);
  const now = new Date();
  for (let i = 0; i < 8; i++) {
    const d = new Date(now); d.setDate(now.getDate() + i); d.setHours(h, m, 0, 0);
    if (days.includes(d.getDay()) && d.getTime() > now.getTime()) return d;
  }
  return null;
}
// A note's reminder rule, normalized — reads either the new `remind` object
// or falls back to a legacy plain `remindAt` timestamp as a one-time rule.
function remindRuleOf(n) { return n.remind || (n.remindAt ? { mode: 'once', at: n.remindAt } : null); }
// The single timestamp used for display/sorting/badges: the note's own time
// for a one-time reminder, or its next upcoming occurrence for a weekly one.
function effectiveRemindAt(n) {
  const r = remindRuleOf(n);
  if (!r) return null;
  if (r.mode === 'once') return r.at || null;
  if (r.mode === 'weekly') { const d = nextRecurrence(r.days, r.time); return d ? d.getTime() : null; }
  return null;
}
function dayShort(d) { return ['א׳', 'ב׳', 'ג׳', 'ד׳', 'ה׳', 'ו׳', 'ש׳'][d]; }
// Display text for a note's reminder, wherever it's shown (card/badge/view/upcoming list).
function fmtRemindRule(n) {
  const r = remindRuleOf(n);
  if (!r) return '';
  if (r.mode === 'once') return r.at ? fmtRemind(r.at) : '';
  if (r.mode === 'weekly' && Array.isArray(r.days) && r.days.length) return `${[...r.days].sort().map(dayShort).join(',')} · ${r.time}`;
  return '';
}
function renderNoteRemind() {
  const r = noteDraft.remind;
  const mode = r ? r.mode : 'none';
  $('nRemindMode').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.mode === mode));
  $('nRemindOnce').hidden = mode !== 'once';
  $('nRemindWeekly').hidden = mode !== 'weekly';
  if (mode === 'once') {
    $('nRemindText').textContent = r.at ? fmtRemind(r.at) : 'בחירת תאריך ושעה';
  } else if (mode === 'weekly') {
    $('nRemindDays').querySelectorAll('button').forEach((b) => b.classList.toggle('on', (r.days || []).includes(Number(b.dataset.day))));
    $('nRemindWeeklyTimeText').textContent = r.time || '18:00';
    const next = nextRecurrence(r.days, r.time);
    $('nRemindWeeklyNext').textContent = next ? `התזכורת הבאה: ${fmtRemind(next.getTime())}` : 'בחרו לפחות יום אחד';
  }
}
async function setNoteRemindMode(mode) {
  if (noteDraft.remind && noteDraft.remind.mode === mode) return;
  if (mode === 'none') { noteDraft.remind = null; renderNoteRemind(); return; }
  const perm = await requestNotifyPermission();
  if (perm !== 'granted') { toast(perm === 'denied' ? 'ההתראות חסומות — יש לאפשר אותן בהגדרות המכשיר' : 'צריך לאשר התראות תחילה'); return; }
  subscribePush(); // register this device so the reminder can be delivered
  noteDraft.remind = mode === 'once' ? { mode: 'once', at: null } : { mode: 'weekly', days: [], time: '18:00' };
  renderNoteRemind();
}
function toggleNoteRemindDay(day) {
  if (!noteDraft.remind || noteDraft.remind.mode !== 'weekly') return;
  const days = noteDraft.remind.days || [];
  noteDraft.remind.days = days.includes(day) ? days.filter((d) => d !== day) : [...days, day];
  renderNoteRemind();
}
function pickNoteReminderWeeklyTime() {
  openTimePicker({
    title: 'שעת התזכורת',
    value: (noteDraft.remind && noteDraft.remind.time) || '18:00',
    onConfirm: (v) => { noteDraft.remind.time = v; renderNoteRemind(); },
  });
}
function collectNote() {
  const r = noteDraft.remind;
  const valid = r && ((r.mode === 'once' && r.at) || (r.mode === 'weekly' && r.days && r.days.length));
  return {
    title: $('nTitle').value.trim(),
    category: currentNoteCat(),
    body: $('nBody').value.trim(),
    pinned: $('nPin').checked,
    fields: noteDraft.fields.filter((f) => (f.label || '').trim() || (f.value || '').trim()),
    checklist: noteDraft.checklist.filter((c) => (c.text || '').trim()),
    tags: noteDraft.tags,
    remind: valid ? r : null,
    // Kept in sync for one-time reminders so the existing display/Worker code
    // that reads a plain remindAt timestamp keeps working unchanged.
    remindAt: valid && r.mode === 'once' ? r.at : null,
  };
}
function pickNoteReminder() {
  const p2 = (n) => String(n).padStart(2, '0');
  const base = (noteDraft.remind && noteDraft.remind.at) ? new Date(noteDraft.remind.at) : new Date(Date.now() + 3600000);
  openDatePicker({
    title: 'תאריך התזכורת',
    valueISO: `${base.getFullYear()}-${p2(base.getMonth() + 1)}-${p2(base.getDate())}`,
    onConfirm: (iso) => openTimePicker({
      title: 'שעת התזכורת',
      value: `${p2(base.getHours())}:${p2(base.getMinutes())}`,
      onConfirm: (v) => {
        const [h, m] = v.split(':').map(Number);
        const d = parseDate(iso); d.setHours(h, m, 0, 0);
        if (d.getTime() <= Date.now()) { toast('הזמן שנבחר כבר עבר'); return; }
        noteDraft.remind = { mode: 'once', at: d.getTime() };
        renderNoteRemind();
      },
    }),
  });
}
function submitNote(ev) {
  ev.preventDefault();
  const data = collectNote();
  if (!data.title && !data.body && !data.fields.length && !data.checklist.length) { toast('הפתק ריק — הוסיפו כותרת או תוכן'); return; }
  if (editingNoteId) { store.updateNote(editingNoteId, data); toast('הפתק נשמר'); }
  else { store.addNote(data); toast('פתק נוסף'); }
  noteFormSnapshot = serializeNoteForm();
  closeSheet($('noteSheet'));
  renderNotes();
}
async function deleteCurrentNote() {
  if (!editingNoteId) return;
  const ok = await showConfirm({ title: 'למחוק את הפתק?', message: 'לא ניתן לשחזר לאחר המחיקה.', confirmText: 'מחיקה', danger: true, icon: 'trash' });
  if (!ok) return;
  store.deleteNote(editingNoteId);
  noteFormSnapshot = serializeNoteForm();
  closeSheet($('noteSheet'));
  renderNotes();
  toast('הפתק נמחק');
}

// ---- categories management ----
function renderCatManageList() {
  const cats = noteCats(), el = $('catManageList');
  el.innerHTML = cats.length
    ? cats.map((c) => `<div class="cat-row" data-cat="${c.id}"><span class="cat-dot" style="background:${CAT_COLORS[c.color] || c.color}"></span><span class="cat-row-name">${escapeHtml(c.name)}</span><span class="cat-count">${notesAll().filter((n) => n.category === c.id).length}</span><span class="jedit">${svg('pencil')}</span></div>`).join('')
    : `<div class="jobs-empty">אין קטגוריות עדיין. הוסיפו כדי לקטלג פתקים.</div>`;
}
function openCatManage() { renderCatManageList(); openSheet($('catManageSheet')); }
function renderSwatches(sel) {
  $('cSwatches').innerHTML = Object.entries(CAT_COLORS).map(([k, v]) =>
    `<button type="button" class="cat-swatch ${sel === k ? 'on' : ''}" data-swatch="${k}" style="background:${v}" aria-label="${k}"></button>`).join('');
}
let catFormSnapshot = '';
function serializeCatForm() { return JSON.stringify({ n: $('cName').value, c: catPick }); }
function isCatDirty() { return serializeCatForm() !== catFormSnapshot; }
function openCat(id = null) {
  editingCatId = id;
  const del = $('deleteCat');
  if (id) {
    const c = catById(id); if (!c) return;
    $('catSheetTitle').textContent = 'עריכת קטגוריה';
    $('cName').value = c.name || ''; catPick = c.color || 'teal';
    del.hidden = false;
  } else {
    $('catSheetTitle').textContent = 'קטגוריה חדשה';
    $('cName').value = '';
    const used = new Set(noteCats().map((c) => c.color));
    catPick = Object.keys(CAT_COLORS).find((k) => !used.has(k)) || 'teal';
    del.hidden = true;
  }
  renderSwatches(catPick);
  catFormSnapshot = serializeCatForm();
  openSheet($('catSheet'));
}
async function tryCloseCat() {
  if (isCatDirty() && !(await confirmDiscard())) return;
  closeSheet($('catSheet'));
}
function submitCat(ev) {
  ev.preventDefault();
  const name = $('cName').value.trim();
  if (!name) { toast('נא להזין שם קטגוריה'); return; }
  if (editingCatId) store.updateNoteCat(editingCatId, { name, color: catPick });
  else { const c = store.addNoteCat({ name, color: catPick }); if (!editingNoteId && $('noteSheet').hidden === false) {} }
  catFormSnapshot = serializeCatForm();
  closeSheet($('catSheet'));
  renderCatManageList();
  if ($('noteSheet').hidden === false) renderNoteCatChips(currentNoteCat());
  renderNotes();
  toast('הקטגוריה נשמרה');
}
async function deleteCurrentCat() {
  if (!editingCatId) return;
  const cnt = notesAll().filter((n) => n.category === editingCatId).length;
  const ok = await showConfirm({ title: 'למחוק את הקטגוריה?', message: cnt ? `${cnt} פתקים יעברו ל"ללא קטגוריה".` : 'הקטגוריה תוסר.', confirmText: 'מחיקה', danger: true, icon: 'trash' });
  if (!ok) return;
  store.deleteNoteCat(editingCatId);
  if (noteFilter === editingCatId) noteFilter = null;
  catFormSnapshot = serializeCatForm();
  closeSheet($('catSheet'));
  renderCatManageList(); renderNotes();
  if ($('noteSheet').hidden === false) renderNoteCatChips(currentNoteCat());
  toast('הקטגוריה נמחקה');
}

function autoGrow(ta) { ta.style.height = 'auto'; ta.style.height = Math.min(300, ta.scrollHeight) + 'px'; }

async function copyText(text) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) await navigator.clipboard.writeText(text);
    else { const t = document.createElement('textarea'); t.value = text; t.style.position = 'fixed'; t.style.opacity = '0'; document.body.appendChild(t); t.select(); document.execCommand('copy'); t.remove(); }
    toast('הועתק');
  } catch { toast('ההעתקה נכשלה'); }
}

function switchView(id) {
  ['viewHome', 'viewReports', 'viewMore', 'viewNotes'].forEach((v) => { $(v).hidden = v !== id; });
  document.querySelectorAll('.nav-item').forEach((b) => b.classList.toggle('on', b.dataset.view === id));
  if (id === 'viewMore') renderMore();
  if (id === 'viewNotes') renderNotes();
  window.scrollTo(0, 0);
}

// ------------------------------------------------------------------ wire up
function bind() {
  $('punchBtn').onclick = punch;
  $('editStart').onclick = openStartEdit;

  $('prevMonth').onclick = () => shiftMonth(-1);
  $('nextMonth').onclick = () => shiftMonth(1);
  // tapping the month name opens the calendar to jump to any month
  $('monthLabel').onclick = () => openDatePicker({
    title: 'מעבר לחודש',
    valueISO: `${viewYear}-${String(viewMonth + 1).padStart(2, '0')}-01`,
    onConfirm: (iso) => { const d = parseDate(iso); viewYear = d.getFullYear(); viewMonth = d.getMonth(); renderMonth(); renderAll(); },
  });

  // bottom-nav tabs
  document.getElementById('bottomNav').addEventListener('click', (e) => {
    const b = e.target.closest('.nav-item[data-view]'); if (b) switchView(b.dataset.view);
  });

  // "עוד" page: month nav, payroll settings, year switch
  $('moPrev').onclick = () => shiftMonth(-1);
  $('moNext').onclick = () => shiftMonth(1);
  $('moLabel').onclick = () => openDatePicker({
    title: 'מעבר לחודש',
    valueISO: `${viewYear}-${String(viewMonth + 1).padStart(2, '0')}-01`,
    onConfirm: (iso) => { const d = parseDate(iso); viewYear = d.getFullYear(); viewMonth = d.getMonth(); renderMonth(); renderAll(); renderMore(); },
  });
  $('payrollBtn').onclick = openPayroll;
  $('closePayroll').onclick = tryClosePayroll;
  $('payrollForm').onsubmit = submitPayroll;
  $('pTravelMode').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-mode]'); if (!b) return;
    payrollTravelMode = b.dataset.mode;
    renderTravelMode();
  });
  $('pPayMode').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-mode]'); if (!b) return;
    payrollPayMode = b.dataset.mode;
    renderPayMode();
  });
  $('moreCards').addEventListener('click', (e) => {
    const y = e.target.closest('button[data-yr]');
    if (y) { viewYear += Number(y.dataset.yr); renderMonth(); renderAll(); renderMore(); return; }
    if (e.target.closest('#markVacBtn')) openVacQuick();
  });
  $('closeVacQuick').onclick = () => closeSheet($('vacQuickSheet'));
  $('vacQuickForm').onsubmit = submitVacQuick;
  $('vqDateBtn').onclick = () => openDatePicker({
    title: 'תאריך התחלה',
    valueISO: vqDate,
    onConfirm: (iso) => { vqDate = iso; $('vqDateText').textContent = fmtDateShort(iso); renderVacQuickPreview(); },
  });
  $('vqSkipOff').addEventListener('change', renderVacQuickPreview);
  $('vacQuickForm').addEventListener('click', (e) => {
    const btn = e.target.closest('.stepper-btn'); if (!btn) return;
    const wrap = btn.closest('.stepper');
    const id = wrap.dataset.target;
    const min = Number(wrap.dataset.min), max = Number(wrap.dataset.max);
    const v = Math.min(max, Math.max(min, Number($(id).value) + Number(btn.dataset.step)));
    setStepper(id, v);
    renderVacQuickPreview();
  });

  $('addBtn').onclick = () => openEntry(null);
  $('closeSheet').onclick = tryCloseEntry;
  $('entryForm').onsubmit = submitEntry;
  $('deleteEntry').onclick = deleteCurrentEntry;

  // custom picker fields
  $('fDateBtn').onclick = () => openDatePicker({ valueISO: $('fDate').value, onConfirm: (iso) => setFDate(iso) });
  $('fStartBtn').onclick = () => openTimePicker({ title: 'שעת כניסה', value: $('fStart').value, onConfirm: (v) => { setFStart(v); applyAutoBreak(); updateCalc(); } });
  $('fEndBtn').onclick = () => openTimePicker({ title: 'שעת יציאה', value: $('fEnd').value, onConfirm: (v) => { setFEnd(v); applyAutoBreak(); updateCalc(); } });

  $('fRate').addEventListener('input', updateCalc);
  $('breakChips').addEventListener('click', (e) => { const b = e.target.closest('button[data-min]'); if (!b) return; breakManuallySet = true; setFBreak(b.dataset.min); updateCalc(); });
  $('typeSeg').addEventListener('click', (e) => { const b = e.target.closest('button[data-type]'); if (b) setFormType(b.dataset.type); });
  $('jobChips').addEventListener('click', (e) => { const b = e.target.closest('button[data-job]'); if (b) { setJobChip(b.dataset.job); updateCalc(); } });
  $('moreToggle').onclick = () => setMore(!moreOpen);

  // job filters (Reports + עוד) and management
  ['jobFilterR', 'jobFilterM'].forEach((id) => $(id).addEventListener('click', (e) => { const b = e.target.closest('button[data-job]'); if (b) setJobFilter(b.dataset.job); }));
  $('addJobBtn').onclick = () => openJob(null);
  $('jobsList').addEventListener('click', (e) => { const r = e.target.closest('.job-row[data-job]'); if (r) openJob(r.dataset.job); });
  $('closeJob').onclick = tryCloseJob;
  $('jobForm').onsubmit = submitJob;
  $('deleteJob').onclick = deleteCurrentJob;

  // ---- פנקס / notes ----
  $('addNoteBtn').onclick = () => openNote(null);
  $('layoutToggle').onclick = toggleNoteLayout;
  $('noteSearch').addEventListener('input', (e) => { noteQuery = e.target.value; renderNotes(); });
  $('noteCatFilter').addEventListener('click', (e) => { const b = e.target.closest('button[data-cat]'); if (b) setNoteFilter(b.dataset.cat); });
  $('notesWrap').addEventListener('click', (e) => {
    const cp = e.target.closest('.nf-copy');
    if (cp) { e.stopPropagation(); copyText(cp.dataset.copy); return; }
    const up = e.target.closest('.upcoming-item[data-id]');
    if (up) { openNoteView(up.dataset.id); return; }
    const card = e.target.closest('.note-card[data-id]');
    if (card) openNoteView(card.dataset.id);
  });
  // note view (read) sheet
  $('nvClose').onclick = () => closeSheet($('noteViewSheet'));
  $('nvEdit').onclick = () => { const id = viewingNoteId; closeSheet($('noteViewSheet')); openNote(id); };
  $('noteViewBody').addEventListener('click', (e) => {
    const cp = e.target.closest('.nf-copy');
    if (cp) { copyText(cp.dataset.copy); return; }
    const rev = e.target.closest('[data-reveal]');
    if (rev) {
      const val = rev.closest('.nv-field').querySelector('.nv-fval');
      const masked = val.classList.toggle('masked'); // true when now hidden
      val.textContent = masked ? '••••••••' : rev.dataset.val;
      rev.innerHTML = svg(masked ? 'eye' : 'eyeOff');
      return;
    }
    const tog = e.target.closest('[data-vtoggle]');
    if (tog && viewingNoteId) {
      const n = notesAll().find((x) => x.id === viewingNoteId); if (!n) return;
      const cl = (n.checklist || []).map((c) => ({ ...c }));
      const i = Number(tog.dataset.vtoggle); cl[i].done = !cl[i].done;
      store.updateNote(viewingNoteId, { checklist: cl });
      openNoteView(viewingNoteId); // re-render the view in place
    }
  });
  $('manageCatsLink').onclick = openCatManage;
  $('closeNote').onclick = tryCloseNote;
  $('noteForm').onsubmit = submitNote;
  $('deleteNote').onclick = deleteCurrentNote;
  $('nBody').addEventListener('input', (e) => autoGrow(e.target));
  $('nRemindBtn').onclick = pickNoteReminder;
  $('nRemindWeeklyTime').onclick = pickNoteReminderWeeklyTime;
  $('nRemindDays').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-day]'); if (b) toggleNoteRemindDay(Number(b.dataset.day));
  });
  $('nRemindMode').addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-mode]'); if (!b) return;
    const mode = b.dataset.mode;
    const r = noteDraft.remind;
    if (mode === 'none' && r) {
      const hasContent = (r.mode === 'once' && r.at) || (r.mode === 'weekly' && r.days && r.days.length);
      if (hasContent) {
        const ok = await showConfirm({ title: 'להסיר את התזכורת?', message: 'התזכורת שנקבעה לפתק זה תבוטל.', confirmText: 'הסרה', danger: true, icon: 'trash' });
        if (!ok) return;
      }
    }
    setNoteRemindMode(mode);
  });
  $('nCatChips').addEventListener('click', (e) => {
    if (e.target.closest('#newCatChip')) { openCat(null); return; }
    const b = e.target.closest('button[data-cat]'); if (b) setNoteCat(b.dataset.cat);
  });
  // custom fields
  $('addField').onclick = () => { noteDraft.fields.push({ label: '', value: '' }); renderNoteFields(); };
  $('nFields').addEventListener('input', (e) => {
    const i = Number(e.target.dataset.i);
    if (e.target.classList.contains('nfield-label')) noteDraft.fields[i].label = e.target.value;
    else if (e.target.classList.contains('nfield-value')) noteDraft.fields[i].value = e.target.value;
  });
  $('nFields').addEventListener('click', async (e) => {
    const sec = e.target.closest('[data-secret]');
    if (sec) { const i = Number(sec.dataset.secret); noteDraft.fields[i].secret = !noteDraft.fields[i].secret; renderNoteFields(); return; }
    const b = e.target.closest('[data-del-field]');
    if (b) {
      const i = Number(b.dataset.delField);
      const f = noteDraft.fields[i];
      if ((f.label || '').trim() || (f.value || '').trim()) {
        const ok = await showConfirm({ title: 'להסיר את השדה?', message: 'השדה והערך שלו יימחקו.', confirmText: 'הסרה', danger: true, icon: 'trash' });
        if (!ok) return;
      }
      noteDraft.fields.splice(i, 1); renderNoteFields();
    }
  });
  // checklist
  $('addCheck').onclick = () => { noteDraft.checklist.push({ text: '', done: false }); renderNoteChecklist(); };
  $('nChecklist').addEventListener('input', (e) => { if (e.target.classList.contains('ncheck-text')) noteDraft.checklist[Number(e.target.dataset.i)].text = e.target.value; });
  $('nChecklist').addEventListener('click', async (e) => {
    const tog = e.target.closest('[data-toggle]');
    if (tog) { const i = Number(tog.dataset.toggle); noteDraft.checklist[i].done = !noteDraft.checklist[i].done; renderNoteChecklist(); return; }
    const del = e.target.closest('[data-del-check]');
    if (del) {
      const i = Number(del.dataset.delCheck);
      if ((noteDraft.checklist[i].text || '').trim()) {
        const ok = await showConfirm({ title: 'למחוק את הפריט?', message: 'הפריט ברשימה יימחק.', confirmText: 'מחיקה', danger: true, icon: 'trash' });
        if (!ok) return;
      }
      noteDraft.checklist.splice(i, 1); renderNoteChecklist();
    }
  });
  // tags
  $('nTagInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      const v = e.target.value.trim().replace(/^#/, '');
      if (v && !noteDraft.tags.includes(v)) { noteDraft.tags.push(v); renderNoteTags(); }
      e.target.value = '';
    } else if (e.key === 'Backspace' && !e.target.value && noteDraft.tags.length) {
      noteDraft.tags.pop(); renderNoteTags();
    }
  });
  $('nTagsWrap').addEventListener('click', (e) => { const b = e.target.closest('[data-del-tag]'); if (b) { noteDraft.tags.splice(Number(b.dataset.delTag), 1); renderNoteTags(); } });
  // category management (opened from the note editor's "ניהול" link)
  $('closeCatManage').onclick = () => closeSheet($('catManageSheet'));
  $('addCatBtn').onclick = () => openCat(null);
  $('catManageList').addEventListener('click', (e) => { const r = e.target.closest('.cat-row[data-cat]'); if (r) openCat(r.dataset.cat); });
  $('closeCat').onclick = tryCloseCat;
  $('catForm').onsubmit = submitCat;
  $('deleteCat').onclick = deleteCurrentCat;
  $('cSwatches').addEventListener('click', (e) => { const b = e.target.closest('[data-swatch]'); if (b) { catPick = b.dataset.swatch; renderSwatches(catPick); } });

  $('weeklyToggle').onclick = () => { weeklyOpen = !weeklyOpen; $('weeklyToggle').setAttribute('aria-expanded', String(weeklyOpen)); $('weeklyBody').hidden = !weeklyOpen; };
  $('monthlyToggle').onclick = () => { monthlyOpen = !monthlyOpen; $('monthlyToggle').setAttribute('aria-expanded', String(monthlyOpen)); $('monthlyBody').hidden = !monthlyOpen; };

  $('settingsBtn').onclick = openSettings;
  $('themeToggle').onclick = toggleTheme;
  $('closeSettings').onclick = tryCloseSettings;
  $('settingsForm').onsubmit = submitSettings;
  $('paletteRow').addEventListener('click', (e) => { const b = e.target.closest('button[data-pal]'); if (b) selectPalette(b.dataset.pal); });
  $('authBtn').onclick = handleAuth;
  $('sDark').addEventListener('change', () => { store.saveSettings({ theme: $('sDark').checked ? 'dark' : 'light' }); applyTheme(); });
  $('sReminder').addEventListener('change', () => { const on = $('sReminder').checked; $('reminderTimeField').hidden = !on; if (on) enableReminderFlow(); else unsubscribePush(); });
  // כפתור בדיקת התראה מוסתר מה-UI (הקוד נשמר); מקשרים רק אם הוא קיים.
  { const b = $('testReminderBtn'); if (b) b.onclick = sendTestReminder; }
  // Saves immediately on confirm (like the theme/reminder toggles beside it) —
  // no need to also press "שמירה" below for this field, so there's no
  // ambiguity about whether the picked time was kept.
  $('sReminderTime').onclick = () => openTimePicker({
    title: 'שעת התזכורת', value: reminderPick,
    onConfirm: (v) => {
      reminderPick = v; $('sReminderTimeText').textContent = v;
      store.saveSettings({ reminderTime: v });
      settingsFormSnapshot = serializeSettingsForm();
      toast('שעת התזכורת עודכנה ✓');
    },
  });
  $('offDaysChips').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-day]'); if (!b) return;
    const d = Number(b.dataset.day);
    offDaysPick = offDaysPick.includes(d) ? offDaysPick.filter((x) => x !== d) : [...offDaysPick, d];
    renderOffDaysChips();
  });
  // "שכחתי לצאת" −/+ steppers: each keeps its own min/max, and the pair stays
  // consistent (close-after always ends up strictly greater than remind-after).
  $('settingsForm').addEventListener('click', (e) => {
    const btn = e.target.closest('.stepper-btn'); if (!btn) return;
    const wrap = btn.closest('.stepper');
    const id = wrap.dataset.target;
    const min = Number(wrap.dataset.min), max = Number(wrap.dataset.max);
    const v = Math.min(max, Math.max(min, Number($(id).value) + Number(btn.dataset.step)));
    setStepper(id, v);
    if (id === 'sShiftRemind' && v >= Number($('sShiftMax').value)) setStepper('sShiftMax', Math.min(24, v + 1));
    if (id === 'sShiftMax' && v <= Number($('sShiftRemind').value)) setStepper('sShiftRemind', Math.max(1, v - 1));
  });
  $('reminderDismiss').onclick = () => { reminderDismissedFor = todayISO(); $('reminderBanner').hidden = true; };
  $('reminderBanner').addEventListener('click', (e) => { if (e.target.id !== 'reminderDismiss') openEntry(null); });
  $('autoCloseDismiss').onclick = (e) => { e.stopPropagation(); try { localStorage.removeItem(AUTOCLOSE_KEY); } catch {} $('autoCloseBanner').hidden = true; };
  $('autoCloseBanner').addEventListener('click', (e) => { if (e.target.id === 'autoCloseDismiss') return; const id = (() => { try { return localStorage.getItem(AUTOCLOSE_KEY); } catch { return null; } })(); if (id) openEntry(id); });

  $('exportBtn').onclick = openExport;
  $('closeExport').onclick = () => closeSheet($('exportSheet'));
  $('doExportPdf').onclick = runExportPdf;
  $('doExportCsv').onclick = runExportCsv;

  const entriesEl = $('entries');
  entriesEl.addEventListener('click', (e) => {
    if (selectMode) {
      const daySel = e.target.closest('.day-sel');
      if (daySel) { toggleDaySelection(daySel.dataset.date); return; }
      const wrap = e.target.closest('.swipe-wrap');
      if (wrap) toggleEntrySelection(wrap.dataset.id);
      return;
    }
    const delBtn = e.target.closest('.swipe-del');
    if (delBtn) { const sw = delBtn.closest('.swipe-wrap'); if (sw) deleteEntryById(sw.dataset.id); return; }
    if (Date.now() < swipeSuppressUntil) return;      // trailing click after a swipe
    const openWrap = e.target.closest('.swipe-wrap.open');
    if (openWrap) { closeSwipe(); return; }           // first tap just closes the revealed action
    const card = e.target.closest('.entry');
    if (card) openEntry(card.dataset.id);
  });
  $('selectModeBtn').onclick = () => { selectMode ? exitSelectMode() : enterSelectMode(); };
  $('selectCancel').onclick = exitSelectMode;
  $('selectDeleteBtn').onclick = deleteSelectedEntries;
  entriesEl.addEventListener('touchstart', onSwipeStart, { passive: true });
  entriesEl.addEventListener('touchmove', onSwipeMove, { passive: false });
  entriesEl.addEventListener('touchend', onSwipeEnd);
  entriesEl.addEventListener('touchcancel', onSwipeEnd);

  // backdrop taps: editor sheets with deferred fields use the unsaved-changes
  // guard; read-only / action sheets (export, note view, category list) close
  // directly since they hold nothing that can be lost.
  const SHEET_GUARDS = {
    entrySheet: { isDirty, tryClose: tryCloseEntry },
    settingsSheet: { isDirty: isSettingsDirty, tryClose: tryCloseSettings },
    payrollSheet: { isDirty: isPayrollDirty, tryClose: tryClosePayroll },
    jobSheet: { isDirty: isJobDirty, tryClose: tryCloseJob },
    noteSheet: { isDirty: isNoteDirty, tryClose: tryCloseNote },
    catSheet: { isDirty: isCatDirty, tryClose: tryCloseCat },
  };
  const DIRECT_CLOSE_SHEETS = ['exportSheet', 'noteViewSheet', 'catManageSheet', 'vacQuickSheet'];
  Object.entries(SHEET_GUARDS).forEach(([id, g]) => $(id).addEventListener('click', (e) => { if (e.target.id === id) g.tryClose(); }));
  DIRECT_CLOSE_SHEETS.forEach((id) => $(id).addEventListener('click', (e) => { if (e.target.id === id) closeSheet($(id)); }));

  // drag-down-to-dismiss on every bottom sheet
  Object.entries(SHEET_GUARDS).forEach(([id, g]) => enableSheetDrag($(id), { guard: g.isDirty, guarded: g.tryClose, hide: () => closeSheet($(id)) }));
  [...DIRECT_CLOSE_SHEETS, 'timePicker', 'datePicker'].forEach((id) => enableSheetDrag($(id), { hide: () => { $(id).hidden = true; } }));

  document.addEventListener('visibilitychange', () => { if (!document.hidden) renderHero(); });
}

async function main() {
  initIcons();
  initPickers();
  bind();
  const av = $('appVersion'); if (av) av.textContent = `גרסה ${APP_VERSION}`;
  store.onChange(() => { applyTheme(); renderHero(); renderJobFilter(); renderAll(); renderMore(); renderNotes(); renderSyncStatus(); updateAccountUI(); refreshReminder(); });
  await store.init();
  applyTheme(); renderMonth(); renderHero(); renderJobFilter(); renderAll(); updateAccountUI();
  startReminderLoop();
  if ('serviceWorker' in navigator) initUpdateChecking();
}
main();

// A new SW installs and activates itself automatically in the background
// (sw.js calls skipWaiting()+clients.claim() unconditionally) — but the
// already-loaded page's HTML/JS stay exactly as they were until reloaded,
// so there was previously no way to tell whether you were actually on the
// latest version. navigator.serviceWorker.oncontrollerchange fires the
// moment a new worker takes over an open tab; the only wrinkle is that it
// ALSO fires once on a page's very first-ever load (uncontrolled → controlled),
// which isn't a real "update" — guarded against below by only reacting once
// this tab already had a controller.
function initUpdateChecking() {
  navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' }).then((reg) => {
    // Re-check for a newer sw.js whenever the app is brought back to the
    // foreground, not just on the browser's own (less predictable) schedule
    // — this is exactly the "reopened the app, is it current?" moment.
    document.addEventListener('visibilitychange', () => { if (!document.hidden) reg.update().catch(() => {}); });
  }).catch(() => {});

  const hadController = !!navigator.serviceWorker.controller;
  let shown = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || shown) return;
    shown = true;
    $('updateBanner').hidden = false;
  });
  $('updateBannerBtn').onclick = () => location.reload();
}
