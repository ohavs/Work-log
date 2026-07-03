import { store } from './store.js';
import { exportPDF } from './pdf.js';
import { exportCSV } from './csv.js';
import { initIcons, svg } from './icons.js';
import { initPickers, openTimePicker, openDatePicker, showConfirm } from './pickers.js';
import {
  DEFAULT_PAYROLL, payrollOf, payslip, pensionForMonth, grossForMonth,
  yearlyByMonth, averages, vacationBalance, recreationAnnual, rateOf,
} from './finance.js';
import { uid } from './util.js';
import {
  MONTHS, DOW, TYPE_META, parseDate, toISO, todayISO,
  workedMinutes, fmtHours, decimalHours, fmtMoney, inMonth,
  entryType, isWork, weekStartISO, weekLabel,
} from './util.js';

const $ = (id) => document.getElementById(id);
const ACTIVE_KEY = 'wl_active';
const MIN_SHIFT_MS = 60000; // shifts under a minute are treated as an accidental double-tap

const now = new Date();
let viewYear = now.getFullYear();
let viewMonth = now.getMonth();
let editingId = null;
let formType = 'work';
let weeklyOpen = false;
let moreOpen = false;
let jobFilter = null;       // null = all workplaces; else jobId
let editingJobId = null;
let tick = null;
let lastCreatedId = null;
let reminderPick = '18:00';       // chosen time in the settings picker
let reminderNotifiedFor = '';     // ISO date we already notified for
let reminderDismissedFor = '';    // ISO date the in-app banner was dismissed
let formSnapshot = '';

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
function setActive(v) { v ? localStorage.setItem(ACTIVE_KEY, JSON.stringify(v)) : localStorage.removeItem(ACTIVE_KEY); }
function hhmm(d) { return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; }
function longDate(d) { return `יום ${DOW[d.getDay()]} · ${d.getDate()} ב${MONTHS[d.getMonth()]} ${d.getFullYear()}`; }

// ------------------------------------------------------------------ HERO
function todayMinutes() { const t = todayISO(); return store.entries.filter((e) => e.date === t && isWork(e)).reduce((s, e) => s + workedMinutes(e), 0); }
function todayCount() { const t = todayISO(); return store.entries.filter((e) => e.date === t).length; }

function renderHero() {
  const hero = $('hero');
  const d = new Date();
  $('heroDate').textContent = `יום ${DOW[d.getDay()]}, ${d.getDate()} ב${MONTHS[d.getMonth()]}`;
  const active = getActive();
  if (active) {
    hero.classList.add('running');
    $('timer').hidden = false; $('heroHint').hidden = true; $('heroToday').hidden = true;
    $('punchInner').textContent = 'יציאה';
    $('punchBtn').setAttribute('aria-label', 'יציאה');
    const startD = new Date(active.start);
    const update = () => {
      const diff = Math.max(0, Date.now() - active.start);
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
    const entry = { type: 'work', date: toISO(startD), jobId: jobFilter || '', start: hhmm(startD), end: hhmm(endD), breakMin: 0, rate: '', note: '' };
    setActive(null);
    viewYear = startD.getFullYear(); viewMonth = startD.getMonth();
    const created = store.addEntry(entry); lastCreatedId = created.id;
    renderMonth(); renderHero();
    toast(`נשמר · ${fmtHours(workedMinutes(entry))} שעות · הקש על הרישום לעריכה`);
  } else {
    setActive({ start: Date.now() }); renderHero();
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
      setActive({ start: d.getTime() }); renderHero();
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
  let totalMin = 0, totalPay = 0;
  const workDays = new Set(), vac = new Set(), sick = new Set();
  entries.forEach((e) => {
    const t = entryType(e);
    if (t === 'vacation') { vac.add(e.date); return; }
    if (t === 'sick') { sick.add(e.date); return; }
    const mins = workedMinutes(e); totalMin += mins; totalPay += decimalHours(mins) * effRate(e); workDays.add(e.date);
  });
  $('statHours').textContent = fmtHours(totalMin);
  $('statDays').textContent = workDays.size;
  const rate = Number(store.settings.rate) || 0;
  const anyRate = rate > 0 || entries.some((e) => e.rate);
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
  if (goalW > 0) { const wk = currentWeekMinutes(); rings.push(ringSVG((wk / 60 / goalW) * 100, 'השבוע', `${fmtHours(wk)} / ${goalW}`)); }
  if (goalM > 0) { rings.push(ringSVG((totalMin / 60 / goalM) * 100, 'החודש', `${fmtHours(totalMin)} / ${goalM}`)); }
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
function ringSVG(pctRaw, label, sub) {
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
  </div>`;
}

function renderWeekly(entries) {
  const card = $('weeklyCard'), body = $('weeklyBody');
  const weeks = new Map();
  entries.forEach((e) => { if (!isWork(e)) return; const wk = weekStartISO(parseDate(e.date)); weeks.set(wk, (weeks.get(wk) || 0) + workedMinutes(e)); });
  const rows = [...weeks.entries()].filter(([, m]) => m > 0).sort((a, b) => a[0].localeCompare(b[0]));
  if (rows.length < 2) { card.hidden = true; return; }
  card.hidden = false;
  const max = Math.max(...rows.map(([, m]) => m));
  body.innerHTML = rows.map(([wk, mins]) => `<div class="week-row"><span class="week-name">${weekLabel(wk)}</span><span class="week-bar"><span class="week-bar-fill" style="width:${Math.round((mins / max) * 100)}%"></span></span><span class="week-val">${fmtHours(mins)}</span></div>`).join('');
  $('weeklyToggle').setAttribute('aria-expanded', String(weeklyOpen));
  body.hidden = !weeklyOpen;
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
    group.innerHTML = `<div class="day-head"><span class="dow">יום ${DOW[d.getDay()]}</span><span>${d.getDate()} ב${MONTHS[d.getMonth()]}</span>${dayMin > 0 ? `<span class="dtotal">${fmtHours(dayMin)} שעות</span>` : ''}</div>`;
    list.forEach((e) => {
      const sw = document.createElement('div'); sw.className = 'swipe-wrap'; sw.dataset.id = e.id;
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
      sw.appendChild(del); sw.appendChild(card);
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

function renderAll() { const e = monthEntries(); renderStats(e); renderWeekly(e); renderEntries(e); }

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
    setFDate(todayISO()); setFStart('09:00'); setFEnd('17:00'); setFBreak(0);
    $('fRate').value = ''; $('fNote').value = '';
    renderJobChips(jobFilter || '');
    setFormType('work'); del.hidden = true;
  }
  setMore(false);
  updateCalc();
  formSnapshot = serializeForm();
  openSheet($('entrySheet'));
}

async function tryCloseEntry() {
  if (isDirty()) {
    const ok = await showConfirm({ title: 'לצאת בלי לשמור?', message: 'השינויים שביצעת לא יישמרו.', confirmText: 'צא בלי לשמור', danger: true, icon: 'alert' });
    if (!ok) return;
  }
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
  if (editingId) { store.updateEntry(editingId, data); toast('הרישום עודכן'); }
  else { const c = store.addEntry(data); lastCreatedId = c.id; toast('הרישום נוסף'); }
  const d = parseDate(date); viewYear = d.getFullYear(); viewMonth = d.getMonth();
  renderMonth();
  formSnapshot = serializeForm(); // mark clean so no unsaved prompt
  closeSheet($('entrySheet'));
}

async function deleteCurrentEntry() {
  if (!editingId) return;
  const ok = await showConfirm({ title: 'למחוק את הרישום?', message: 'לא ניתן לשחזר לאחר המחיקה.', confirmText: 'מחיקה', danger: true, icon: 'trash' });
  if (!ok) return;
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
  renderPaletteRow();
  renderJobsList();
  renderSyncStatus();
  openSheet($('settingsSheet'));
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
function setJobFilter(id) { jobFilter = id || null; renderJobFilter(); renderAll(); renderMore(); }

function renderJobsList() {
  const jobs = jobsList(), el = $('jobsList');
  el.innerHTML = jobs.length
    ? jobs.map((j) => `<div class="job-row" data-job="${j.id}"><span class="jn">${escapeHtml(j.name)}</span><span class="jr">₪${j.rate || 0}/שעה</span><span class="jedit">${svg('pencil')}</span></div>`).join('')
    : `<div class="jobs-empty">אין מקומות עבודה. הוסיפו כדי לשייך רישומים ולראות שכר נפרד לכל מקום.</div>`;
}
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
  openSheet($('jobSheet'));
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
function renderSyncStatus() {
  const el = $('syncStatus'), btn = $('authBtn');
  if (!store.cloudAvailable) { el.textContent = 'מצב שמירה: מקומי במכשיר'; btn.hidden = true; return; }
  btn.hidden = false;
  if (store.user) { el.textContent = `☁ מסונכרן בענן · ${store.user.email || store.user.name || 'מחובר'}`; btn.textContent = 'התנתקות'; }
  else { el.textContent = 'מצב שמירה: מקומי · התחברו לסנכרון בענן'; btn.textContent = 'התחברות לחשבון Google'; }
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
function submitSettings(ev) {
  ev.preventDefault();
  store.saveSettings({
    name: $('sName').value.trim(), rate: Number($('sRate').value) || 0,
    goalHours: Number($('sGoal').value) || 0, goalWeekHours: Number($('sGoalWeek').value) || 0,
    theme: $('sDark').checked ? 'dark' : 'light',
    reminder: $('sReminder').checked, reminderTime: reminderPick,
  });
  applyTheme(); closeSheet($('settingsSheet')); toast('ההגדרות נשמרו');
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
  const [h, m] = (s.reminderTime || '18:00').split(':').map(Number);
  const now = new Date();
  return now.getHours() * 60 + now.getMinutes() >= (h || 0) * 60 + (m || 0);
}
function refreshReminder() {
  const banner = $('reminderBanner');
  if (!banner) return;
  const today = todayISO();
  const show = reminderDue() && reminderDismissedFor !== today;
  banner.hidden = !show;
  if (show && reminderNotifiedFor !== today && 'Notification' in window && Notification.permission === 'granted') {
    reminderNotifiedFor = today;
    try {
      new Notification('שעון עבודה', { body: 'עוד לא רשמת שעות היום — הקש כדי להזין', tag: 'wl-daily', icon: './icons/icon-192.png' });
    } catch (_) {}
  }
}
function startReminderLoop() {
  refreshReminder();
  setInterval(refreshReminder, 60000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshReminder(); });
}
async function requestNotifyPermission() {
  if (!('Notification' in window)) return;
  if (Notification.permission === 'default') { try { await Notification.requestPermission(); } catch (_) {} }
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
    if (res && res.method === 'file') toast('קובץ ה‑PDF הורד');
    else toast('בחרו "שמירה כ‑PDF" בחלון ההדפסה');
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
  openSheet($('payrollSheet'));
}
function submitPayroll(ev) {
  ev.preventDefault();
  const num = (id, def) => { const v = Number($(id).value); return Number.isFinite(v) ? v : def; };
  store.saveSettings({ payroll: {
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
  } });
  closeSheet($('payrollSheet'));
  renderMore();
  toast('הגדרות השכר נשמרו');
}

// ------------------------------------------------------------------ tabs
function switchView(id) {
  ['viewHome', 'viewReports', 'viewMore'].forEach((v) => { $(v).hidden = v !== id; });
  document.querySelectorAll('.nav-item').forEach((b) => b.classList.toggle('on', b.dataset.view === id));
  if (id === 'viewMore') renderMore();
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
  $('closePayroll').onclick = () => closeSheet($('payrollSheet'));
  $('payrollForm').onsubmit = submitPayroll;
  $('moreCards').addEventListener('click', (e) => {
    const y = e.target.closest('button[data-yr]');
    if (y) { viewYear += Number(y.dataset.yr); renderMonth(); renderAll(); renderMore(); }
  });

  $('addBtn').onclick = () => openEntry(null);
  $('closeSheet').onclick = tryCloseEntry;
  $('entryForm').onsubmit = submitEntry;
  $('deleteEntry').onclick = deleteCurrentEntry;

  // custom picker fields
  $('fDateBtn').onclick = () => openDatePicker({ valueISO: $('fDate').value, onConfirm: (iso) => setFDate(iso) });
  $('fStartBtn').onclick = () => openTimePicker({ title: 'שעת כניסה', value: $('fStart').value, onConfirm: (v) => { setFStart(v); updateCalc(); } });
  $('fEndBtn').onclick = () => openTimePicker({ title: 'שעת יציאה', value: $('fEnd').value, onConfirm: (v) => { setFEnd(v); updateCalc(); } });

  $('fRate').addEventListener('input', updateCalc);
  $('breakChips').addEventListener('click', (e) => { const b = e.target.closest('button[data-min]'); if (!b) return; setFBreak(b.dataset.min); updateCalc(); });
  $('typeSeg').addEventListener('click', (e) => { const b = e.target.closest('button[data-type]'); if (b) setFormType(b.dataset.type); });
  $('jobChips').addEventListener('click', (e) => { const b = e.target.closest('button[data-job]'); if (b) { setJobChip(b.dataset.job); updateCalc(); } });
  $('moreToggle').onclick = () => setMore(!moreOpen);

  // job filters (Reports + עוד) and management
  ['jobFilterR', 'jobFilterM'].forEach((id) => $(id).addEventListener('click', (e) => { const b = e.target.closest('button[data-job]'); if (b) setJobFilter(b.dataset.job); }));
  $('addJobBtn').onclick = () => openJob(null);
  $('jobsList').addEventListener('click', (e) => { const r = e.target.closest('.job-row[data-job]'); if (r) openJob(r.dataset.job); });
  $('closeJob').onclick = () => closeSheet($('jobSheet'));
  $('jobForm').onsubmit = submitJob;
  $('deleteJob').onclick = deleteCurrentJob;

  $('weeklyToggle').onclick = () => { weeklyOpen = !weeklyOpen; $('weeklyToggle').setAttribute('aria-expanded', String(weeklyOpen)); $('weeklyBody').hidden = !weeklyOpen; };

  $('settingsBtn').onclick = openSettings;
  $('themeToggle').onclick = toggleTheme;
  $('closeSettings').onclick = () => closeSheet($('settingsSheet'));
  $('settingsForm').onsubmit = submitSettings;
  $('paletteRow').addEventListener('click', (e) => { const b = e.target.closest('button[data-pal]'); if (b) selectPalette(b.dataset.pal); });
  $('authBtn').onclick = handleAuth;
  $('sDark').addEventListener('change', () => { store.saveSettings({ theme: $('sDark').checked ? 'dark' : 'light' }); applyTheme(); });
  $('sReminder').addEventListener('change', () => { const on = $('sReminder').checked; $('reminderTimeField').hidden = !on; if (on) requestNotifyPermission(); });
  $('sReminderTime').onclick = () => openTimePicker({ title: 'שעת התזכורת', value: reminderPick, onConfirm: (v) => { reminderPick = v; $('sReminderTimeText').textContent = v; } });
  $('reminderDismiss').onclick = () => { reminderDismissedFor = todayISO(); $('reminderBanner').hidden = true; };
  $('reminderBanner').addEventListener('click', (e) => { if (e.target.id !== 'reminderDismiss') openEntry(null); });

  $('exportBtn').onclick = openExport;
  $('closeExport').onclick = () => closeSheet($('exportSheet'));
  $('doExportPdf').onclick = runExportPdf;
  $('doExportCsv').onclick = runExportCsv;

  const entriesEl = $('entries');
  entriesEl.addEventListener('click', (e) => {
    const delBtn = e.target.closest('.swipe-del');
    if (delBtn) { const sw = delBtn.closest('.swipe-wrap'); if (sw) deleteEntryById(sw.dataset.id); return; }
    if (Date.now() < swipeSuppressUntil) return;      // trailing click after a swipe
    const openWrap = e.target.closest('.swipe-wrap.open');
    if (openWrap) { closeSwipe(); return; }           // first tap just closes the revealed action
    const card = e.target.closest('.entry');
    if (card) openEntry(card.dataset.id);
  });
  entriesEl.addEventListener('touchstart', onSwipeStart, { passive: true });
  entriesEl.addEventListener('touchmove', onSwipeMove, { passive: false });
  entriesEl.addEventListener('touchend', onSwipeEnd);
  entriesEl.addEventListener('touchcancel', onSwipeEnd);

  // backdrop taps: entry sheet uses unsaved guard; others close directly
  $('entrySheet').addEventListener('click', (e) => { if (e.target.id === 'entrySheet') tryCloseEntry(); });
  ['settingsSheet', 'exportSheet', 'payrollSheet', 'jobSheet'].forEach((id) => $(id).addEventListener('click', (e) => { if (e.target.id === id) closeSheet($(id)); }));

  // drag-down-to-dismiss on every bottom sheet
  enableSheetDrag($('entrySheet'), { guard: isDirty, guarded: tryCloseEntry, hide: () => closeSheet($('entrySheet')) });
  ['settingsSheet', 'exportSheet', 'payrollSheet', 'jobSheet', 'timePicker', 'datePicker'].forEach((id) => enableSheetDrag($(id), { hide: () => { $(id).hidden = true; } }));

  document.addEventListener('visibilitychange', () => { if (!document.hidden) renderHero(); });
}

async function main() {
  initIcons();
  initPickers();
  bind();
  store.onChange(() => { applyTheme(); renderHero(); renderJobFilter(); renderAll(); renderMore(); renderSyncStatus(); updateAccountUI(); refreshReminder(); });
  await store.init();
  applyTheme(); renderMonth(); renderHero(); renderJobFilter(); renderAll(); updateAccountUI();
  startReminderLoop();
  if ('serviceWorker' in navigator) {
    // Auto-reload once when a new service worker takes control (new version).
    let refreshing = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (refreshing) return; refreshing = true; location.reload();
    });
    // updateViaCache:'none' → always fetch a fresh sw.js to detect updates.
    navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' }).catch(() => {});
  }
}
main();
