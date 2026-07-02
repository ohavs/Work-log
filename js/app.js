import { store } from './store.js';
import { exportPDF } from './pdf.js';
import { exportCSV } from './csv.js';
import { initIcons, svg } from './icons.js';
import { initPickers, openTimePicker, openDatePicker, showConfirm } from './pickers.js';
import {
  MONTHS, DOW, TYPE_META, parseDate, toISO, todayISO,
  workedMinutes, fmtHours, decimalHours, fmtMoney, inMonth,
  entryType, isWork, weekStartISO, weekLabel,
} from './util.js';

const $ = (id) => document.getElementById(id);
const ACTIVE_KEY = 'wl_active';

const now = new Date();
let viewYear = now.getFullYear();
let viewMonth = now.getMonth();
let editingId = null;
let formType = 'work';
let weeklyOpen = false;
let moreOpen = false;
let tick = null;
let lastCreatedId = null;
let formSnapshot = '';

const TYPE_LABEL = { work: 'עבודה', vacation: 'חופשה', sick: 'מחלה' };

// ------------------------------------------------------------------ theme
function applyTheme() {
  document.documentElement.dataset.theme = store.settings.theme === 'dark' ? 'dark' : 'light';
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = store.settings.theme === 'dark' ? '#071a17' : '#0D9488';
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
    const entry = { type: 'work', date: toISO(startD), start: hhmm(startD), end: hhmm(endD), breakMin: 0, rate: '', note: '' };
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
function renderMonth() { $('monthName').textContent = `${MONTHS[viewMonth]} ${viewYear}`; }
function shiftMonth(delta) {
  viewMonth += delta;
  if (viewMonth < 0) { viewMonth = 11; viewYear--; }
  if (viewMonth > 11) { viewMonth = 0; viewYear++; }
  renderMonth(); renderAll();
}
function monthEntries() { return store.entries.filter((e) => inMonth(e, viewYear, viewMonth)).sort((a, b) => b.date.localeCompare(a.date) || (b.start || '').localeCompare(a.start || '')); }
function effRate(e) { return e.rate != null && e.rate !== '' ? Number(e.rate) : (Number(store.settings.rate) || 0); }

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

  const goal = Number(store.settings.goalHours) || 0;
  const gc = $('goalCard');
  if (goal > 0) {
    gc.hidden = false;
    const pct = Math.min(100, (totalMin / 60 / goal) * 100);
    const fill = $('goalFill'); fill.style.width = pct + '%'; fill.classList.toggle('done', pct >= 100);
    $('goalNums').textContent = `${fmtHours(totalMin)} / ${goal} שעות`;
  } else gc.hidden = true;
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
      const card = document.createElement('div'); card.dataset.id = e.id;
      const t = entryType(e);
      if (t !== 'work') {
        card.className = `entry ${t === 'vacation' ? 'vac' : 'sick'}`;
        card.innerHTML = `<div class="entry-badge">${svg(t)}</div><div class="entry-main"><span class="entry-range">${TYPE_LABEL[t]}</span><span class="entry-meta">${e.note ? `<span class="note">${escapeHtml(e.note)}</span>` : 'יום מלא'}</span></div><span class="entry-edit">${svg('pencil')}</span>`;
      } else {
        const mins = workedMinutes(e), r = effRate(e), pay = decimalHours(mins) * r;
        const meta = [];
        if (e.breakMin) meta.push(`הפסקה ${e.breakMin} דק׳`);
        if (e.note) meta.push(`<span class="note">${escapeHtml(e.note)}</span>`);
        card.className = 'entry';
        card.innerHTML = `<div class="entry-time"><span class="big">${fmtHours(mins)}</span><span class="unit">שעות</span></div><div class="entry-main"><span class="entry-range">${e.start} – ${e.end}</span><span class="entry-meta">${meta.join(' · ') || '&nbsp;'}</span></div>${r ? `<span class="entry-pay">${fmtMoney(pay, store.settings.currency)}</span>` : `<span class="entry-edit">${svg('pencil')}</span>`}`;
      }
      group.appendChild(card);
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

function serializeForm() {
  return JSON.stringify([formType, $('fDate').value, $('fStart').value, $('fEnd').value, $('fBreak').value, $('fRate').value, $('fNote').value.trim()]);
}
function isDirty() { return serializeForm() !== formSnapshot; }

function openEntry(id = null) {
  editingId = id;
  const del = $('deleteEntry');
  $('rateCurr').textContent = store.settings.currency || '₪';
  if (id) {
    const e = store.entries.find((x) => x.id === id);
    if (!e) return;
    $('sheetTitle').textContent = 'עריכת רישום';
    setFDate(e.date); setFStart(e.start || '09:00'); setFEnd(e.end || '17:00'); setFBreak(e.breakMin || 0);
    $('fRate').value = e.rate ?? ''; $('fNote').value = e.note || '';
    setFormType(entryType(e)); del.hidden = false;
  } else {
    $('sheetTitle').textContent = 'רישום חדש';
    setFDate(todayISO()); setFStart('09:00'); setFEnd('17:00'); setFBreak(0);
    $('fRate').value = ''; $('fNote').value = '';
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
  const rate = $('fRate').value !== '' ? Number($('fRate').value) : (Number(store.settings.rate) || 0);
  $('calcPay').textContent = rate ? fmtMoney(decimalHours(mins) * rate, store.settings.currency) : '';
}

function submitEntry(ev) {
  ev.preventDefault();
  const date = $('fDate').value;
  if (!date) return;
  let data;
  if (formType === 'work') {
    data = { type: 'work', date, start: $('fStart').value, end: $('fEnd').value, breakMin: Number($('fBreak').value) || 0, rate: $('fRate').value === '' ? '' : Number($('fRate').value), note: $('fNote').value.trim() };
    if (!data.start || !data.end) { toast('נא לבחור שעת כניסה ויציאה'); return; }
  } else {
    data = { type: formType, date, start: '', end: '', breakMin: 0, rate: '', note: $('fNote').value.trim() };
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

// ------------------------------------------------------------------ settings
function openSettings() {
  const s = store.settings;
  $('sName').value = s.name || '';
  $('sRate').value = s.rate || 0;
  setCurrency(s.currency || '₪');
  $('sGoal').value = s.goalHours || 0;
  $('sDark').checked = s.theme === 'dark';
  renderSyncStatus();
  openSheet($('settingsSheet'));
}
function setCurrency(cur) {
  $('sCurrency').value = cur;
  $('currChips').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.cur === cur));
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
  store.saveSettings({ name: $('sName').value.trim(), rate: Number($('sRate').value) || 0, currency: $('sCurrency').value, goalHours: Number($('sGoal').value) || 0, theme: $('sDark').checked ? 'dark' : 'light' });
  applyTheme(); closeSheet($('settingsSheet')); toast('ההגדרות נשמרו');
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

// ------------------------------------------------------------------ wire up
function bind() {
  $('punchBtn').onclick = punch;
  $('editStart').onclick = openStartEdit;

  $('prevMonth').onclick = () => shiftMonth(-1);
  $('nextMonth').onclick = () => shiftMonth(1);
  $('monthLabel').onclick = () => { viewYear = new Date().getFullYear(); viewMonth = new Date().getMonth(); renderMonth(); renderAll(); };

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
  $('moreToggle').onclick = () => setMore(!moreOpen);

  $('weeklyToggle').onclick = () => { weeklyOpen = !weeklyOpen; $('weeklyToggle').setAttribute('aria-expanded', String(weeklyOpen)); $('weeklyBody').hidden = !weeklyOpen; };

  $('settingsBtn').onclick = openSettings;
  $('closeSettings').onclick = () => closeSheet($('settingsSheet'));
  $('settingsForm').onsubmit = submitSettings;
  $('currChips').addEventListener('click', (e) => { const b = e.target.closest('button[data-cur]'); if (b) setCurrency(b.dataset.cur); });
  $('authBtn').onclick = handleAuth;
  $('sDark').addEventListener('change', () => { store.saveSettings({ theme: $('sDark').checked ? 'dark' : 'light' }); applyTheme(); });

  $('exportBtn').onclick = openExport;
  $('closeExport').onclick = () => closeSheet($('exportSheet'));
  $('doExportPdf').onclick = runExportPdf;
  $('doExportCsv').onclick = runExportCsv;

  $('entries').addEventListener('click', (e) => { const card = e.target.closest('.entry'); if (card) openEntry(card.dataset.id); });

  // backdrop taps: entry sheet uses unsaved guard; others close directly
  $('entrySheet').addEventListener('click', (e) => { if (e.target.id === 'entrySheet') tryCloseEntry(); });
  ['settingsSheet', 'exportSheet'].forEach((id) => $(id).addEventListener('click', (e) => { if (e.target.id === id) closeSheet($(id)); }));

  document.addEventListener('visibilitychange', () => { if (!document.hidden) renderHero(); });
}

async function main() {
  initIcons();
  initPickers();
  bind();
  store.onChange(() => { applyTheme(); renderHero(); renderAll(); renderSyncStatus(); updateAccountUI(); });
  await store.init();
  applyTheme(); renderMonth(); renderHero(); renderAll(); updateAccountUI();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
}
main();
