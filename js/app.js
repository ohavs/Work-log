import { store } from './store.js';
import { exportPDF } from './pdf.js';
import { exportCSV } from './csv.js';
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
let tick = null;
let formType = 'work';       // current entry-form type
let weeklyOpen = false;      // weekly summary expanded?

// ------------------------------------------------------------------ theme
function applyTheme() {
  document.documentElement.dataset.theme = store.settings.theme === 'dark' ? 'dark' : 'light';
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = store.settings.theme === 'dark' ? '#12131c' : '#6d5efc';
}

// ------------------------------------------------------------------ month nav
function renderMonth() {
  $('monthName').textContent = `${MONTHS[viewMonth]} ${viewYear}`;
}
function shiftMonth(delta) {
  viewMonth += delta;
  if (viewMonth < 0) { viewMonth = 11; viewYear--; }
  if (viewMonth > 11) { viewMonth = 0; viewYear++; }
  renderMonth();
  renderAll();
}

// ------------------------------------------------------------------ render
function monthEntries() {
  return store.entries
    .filter((e) => inMonth(e, viewYear, viewMonth))
    .sort((a, b) => b.date.localeCompare(a.date) || (b.start || '').localeCompare(a.start || ''));
}

function effRate(e) {
  return e.rate != null && e.rate !== '' ? Number(e.rate) : (Number(store.settings.rate) || 0);
}

function renderStats(entries) {
  let totalMin = 0, totalPay = 0;
  const workDays = new Set();
  const vacationDays = new Set();
  const sickDays = new Set();
  entries.forEach((e) => {
    const t = entryType(e);
    if (t === 'vacation') { vacationDays.add(e.date); return; }
    if (t === 'sick') { sickDays.add(e.date); return; }
    const mins = workedMinutes(e);
    totalMin += mins;
    totalPay += decimalHours(mins) * effRate(e);
    workDays.add(e.date);
  });

  $('statHours').textContent = fmtHours(totalMin);
  $('statDays').textContent = workDays.size;

  const rate = Number(store.settings.rate) || 0;
  const anyRate = rate > 0 || entries.some((e) => e.rate);
  $('statPayCard').hidden = !anyRate;
  if (anyRate) $('statPay').textContent = fmtMoney(totalPay, store.settings.currency);

  // off-day pills
  const pills = $('offPills');
  const parts = [];
  if (vacationDays.size) parts.push(`<span class="off-pill">🏖️ <b>${vacationDays.size}</b> ימי חופשה</span>`);
  if (sickDays.size) parts.push(`<span class="off-pill">🤒 <b>${sickDays.size}</b> ימי מחלה</span>`);
  pills.innerHTML = parts.join('');
  pills.hidden = parts.length === 0;

  // goal
  const goal = Number(store.settings.goalHours) || 0;
  const goalCard = $('goalCard');
  if (goal > 0) {
    goalCard.hidden = false;
    const doneH = totalMin / 60;
    const pct = Math.min(100, (doneH / goal) * 100);
    const fill = $('goalFill');
    fill.style.width = pct + '%';
    fill.classList.toggle('done', pct >= 100);
    $('goalNums').textContent = `${fmtHours(totalMin)} / ${goal} שעות`;
  } else {
    goalCard.hidden = true;
  }
}

function renderEntries(entries) {
  const wrap = $('entries');
  const empty = $('emptyState');
  wrap.innerHTML = '';

  if (!entries.length) {
    empty.hidden = false;
    $('listCount').textContent = '';
    return;
  }
  empty.hidden = true;
  $('listCount').textContent = `${entries.length} רישומים`;

  // group by date
  const groups = new Map();
  entries.forEach((e) => {
    if (!groups.has(e.date)) groups.set(e.date, []);
    groups.get(e.date).push(e);
  });

  for (const [date, list] of groups) {
    const d = parseDate(date);
    const dayMin = list.reduce((s, e) => s + workedMinutes(e), 0);
    const group = document.createElement('div');
    group.className = 'day-group';
    group.innerHTML = `
      <div class="day-head">
        <span class="dow">יום ${DOW[d.getDay()]}</span>
        <span>${d.getDate()} ב${MONTHS[d.getMonth()]}</span>
        ${dayMin > 0 ? `<span class="dtotal">${fmtHours(dayMin)} שעות</span>` : ''}
      </div>`;

    list.forEach((e) => {
      const card = document.createElement('div');
      card.dataset.id = e.id;
      const t = entryType(e);

      if (t !== 'work') {
        const meta = TYPE_META[t];
        card.className = 'entry off';
        card.innerHTML = `
          <div class="entry-badge">${meta.emoji}</div>
          <div class="entry-main">
            <span class="entry-range">${meta.label}</span>
            <span class="entry-meta">${e.note ? `<span class="note">${escapeHtml(e.note)}</span>` : 'יום מלא'}</span>
          </div>`;
        group.appendChild(card);
        return;
      }

      const mins = workedMinutes(e);
      const r = effRate(e);
      const pay = decimalHours(mins) * r;
      const meta = [];
      if (e.breakMin) meta.push(`הפסקה ${e.breakMin} דק׳`);
      if (e.note) meta.push(`<span class="note">${escapeHtml(e.note)}</span>`);
      card.className = 'entry';
      card.innerHTML = `
        <div class="entry-time">
          <span class="big">${fmtHours(mins)}</span>
          <span class="unit">שעות</span>
        </div>
        <div class="entry-main">
          <span class="entry-range">${e.start} – ${e.end}</span>
          <span class="entry-meta">${meta.join(' · ') || '&nbsp;'}</span>
        </div>
        ${r ? `<span class="entry-pay">${fmtMoney(pay, store.settings.currency)}</span>` : ''}
      `;
      group.appendChild(card);
    });
    wrap.appendChild(group);
  }
}

function renderWeekly(entries) {
  const card = $('weeklyCard');
  const body = $('weeklyBody');

  // sum worked minutes per week (Sun–Sat)
  const weeks = new Map();
  entries.forEach((e) => {
    if (!isWork(e)) return;
    const wk = weekStartISO(parseDate(e.date));
    weeks.set(wk, (weeks.get(wk) || 0) + workedMinutes(e));
  });

  const rows = [...weeks.entries()].filter(([, m]) => m > 0).sort((a, b) => a[0].localeCompare(b[0]));
  if (rows.length < 2) { card.hidden = true; return; } // only useful with multiple weeks
  card.hidden = false;

  const max = Math.max(...rows.map(([, m]) => m));
  body.innerHTML = rows.map(([wk, mins]) => `
    <div class="week-row">
      <span class="week-name">${weekLabel(wk)}</span>
      <span class="week-bar"><span class="week-bar-fill" style="width:${Math.round((mins / max) * 100)}%"></span></span>
      <span class="week-val">${fmtHours(mins)}</span>
    </div>`).join('');

  $('weeklyToggle').setAttribute('aria-expanded', String(weeklyOpen));
  body.hidden = !weeklyOpen;
}

function renderAll() {
  const entries = monthEntries();
  renderStats(entries);
  renderWeekly(entries);
  renderEntries(entries);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ------------------------------------------------------------------ live clock-in
function getActive() {
  try { return JSON.parse(localStorage.getItem(ACTIVE_KEY) || 'null'); } catch { return null; }
}
function setActive(v) {
  if (v) localStorage.setItem(ACTIVE_KEY, JSON.stringify(v));
  else localStorage.removeItem(ACTIVE_KEY);
}

function renderClock() {
  const card = $('clockCard');
  const active = getActive();
  if (active) {
    card.classList.add('running');
    $('clockBtnText').textContent = 'סיום';
    const startD = new Date(active.start);
    const update = () => {
      const diff = Math.max(0, Date.now() - active.start);
      const h = Math.floor(diff / 3600000);
      const m = Math.floor((diff % 3600000) / 60000);
      const s = Math.floor((diff % 60000) / 1000);
      $('clockTitle').textContent = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
      $('clockSub').textContent = `התחלת ב‑${String(startD.getHours()).padStart(2, '0')}:${String(startD.getMinutes()).padStart(2, '0')}`;
    };
    update();
    clearInterval(tick);
    tick = setInterval(update, 1000);
  } else {
    card.classList.remove('running');
    clearInterval(tick);
    tick = null;
    $('clockTitle').textContent = 'מוכן להתחיל?';
    $('clockSub').textContent = 'לחצו כדי להתחיל למדוד את זמן העבודה';
    $('clockBtnText').textContent = 'התחלת עבודה';
  }
}

function toggleClock() {
  const active = getActive();
  if (active) {
    // stop -> create entry
    const startD = new Date(active.start);
    const endD = new Date();
    const entry = {
      date: toISO(startD),
      start: `${String(startD.getHours()).padStart(2, '0')}:${String(startD.getMinutes()).padStart(2, '0')}`,
      end: `${String(endD.getHours()).padStart(2, '0')}:${String(endD.getMinutes()).padStart(2, '0')}`,
      breakMin: 0,
      note: '',
      rate: '',
    };
    setActive(null);
    renderClock();
    // jump to the month of the created entry so the user sees it
    viewYear = startD.getFullYear();
    viewMonth = startD.getMonth();
    renderMonth();
    store.addEntry(entry);
    toast('נרשם! ' + fmtHours(workedMinutes(entry)) + ' שעות');
  } else {
    setActive({ start: Date.now() });
    renderClock();
    toast('מדידת הזמן החלה');
  }
}

// ------------------------------------------------------------------ entry sheet
function openSheet(sheet) { sheet.hidden = false; }
function closeSheet(sheet) { sheet.hidden = true; }

function setFormType(type) {
  formType = TYPE_META[type] ? type : 'work';
  $('typeSeg').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.type === formType));
  $('entryForm').classList.toggle('off-mode', formType !== 'work');
}

function openEntry(id = null) {
  editingId = id;
  const sheet = $('entrySheet');
  const del = $('deleteEntry');
  if (id) {
    const e = store.entries.find((x) => x.id === id);
    if (!e) return;
    $('sheetTitle').textContent = 'עריכת רישום';
    $('fDate').value = e.date;
    $('fStart').value = e.start || '09:00';
    $('fEnd').value = e.end || '17:00';
    $('fBreak').value = e.breakMin || 0;
    $('fRate').value = e.rate ?? '';
    $('fNote').value = e.note || '';
    setFormType(entryType(e));
    del.hidden = false;
  } else {
    $('sheetTitle').textContent = 'רישום חדש';
    $('entryForm').reset();
    $('fDate').value = todayISO();
    $('fStart').value = '09:00';
    $('fEnd').value = '17:00';
    $('fBreak').value = 0;
    setFormType('work');
    del.hidden = true;
  }
  updateCalc();
  openSheet(sheet);
}

function updateCalc() {
  const e = {
    start: $('fStart').value,
    end: $('fEnd').value,
    breakMin: Number($('fBreak').value) || 0,
  };
  const mins = workedMinutes(e);
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
    data = {
      type: 'work',
      date,
      start: $('fStart').value,
      end: $('fEnd').value,
      breakMin: Number($('fBreak').value) || 0,
      rate: $('fRate').value === '' ? '' : Number($('fRate').value),
      note: $('fNote').value.trim(),
    };
    if (!data.start || !data.end) { toast('נא למלא שעת התחלה וסיום'); return; }
  } else {
    data = { type: formType, date, start: '', end: '', breakMin: 0, rate: '', note: $('fNote').value.trim() };
  }

  if (editingId) {
    store.updateEntry(editingId, data);
    toast('הרישום עודכן');
  } else {
    store.addEntry(data);
    toast('הרישום נוסף');
  }
  // follow the entry's month
  const d = parseDate(data.date);
  viewYear = d.getFullYear(); viewMonth = d.getMonth();
  renderMonth();
  closeSheet($('entrySheet'));
}

function deleteCurrentEntry() {
  if (!editingId) return;
  if (!confirm('למחוק את הרישום?')) return;
  store.deleteEntry(editingId);
  closeSheet($('entrySheet'));
  toast('הרישום נמחק');
}

// ------------------------------------------------------------------ settings sheet
function openSettings() {
  const s = store.settings;
  $('sName').value = s.name || '';
  $('sRate').value = s.rate || 0;
  $('sCurrency').value = s.currency || '₪';
  $('sGoal').value = s.goalHours || 0;
  $('sDark').checked = s.theme === 'dark';
  renderSyncStatus();
  openSheet($('settingsSheet'));
}

function renderSyncStatus() {
  const el = $('syncStatus');
  const btn = $('authBtn');
  if (!store.cloudAvailable) {
    el.textContent = 'מצב שמירה: מקומי במכשיר';
    btn.hidden = true;
    return;
  }
  btn.hidden = false;
  if (store.user) {
    el.textContent = `מסונכרן בענן · ${store.user.name || 'מחובר'}`;
    btn.textContent = 'התנתקות';
  } else {
    el.textContent = 'מצב שמירה: מקומי · התחברו לסנכרון בענן';
    btn.textContent = 'התחברות לחשבון Google';
  }
}

function submitSettings(ev) {
  ev.preventDefault();
  store.saveSettings({
    name: $('sName').value.trim(),
    rate: Number($('sRate').value) || 0,
    currency: $('sCurrency').value,
    goalHours: Number($('sGoal').value) || 0,
    theme: $('sDark').checked ? 'dark' : 'light',
  });
  applyTheme();
  closeSheet($('settingsSheet'));
  toast('ההגדרות נשמרו');
}

async function handleAuth() {
  try {
    if (store.user) await store.signOut();
    else await store.signIn();
  } catch (e) {
    toast('ההתחברות נכשלה');
    console.warn(e);
  }
}

// ------------------------------------------------------------------ export
function openExport() {
  if (!monthEntries().length) { toast('אין רישומים לייצוא בחודש זה'); return; }
  openSheet($('exportSheet'));
}

async function runExportPdf() {
  closeSheet($('exportSheet'));
  const entries = monthEntries();
  toast('פתחו את חלון ההדפסה ובחרו "שמירה כ‑PDF"');
  try {
    await exportPDF({ entries, settings: store.settings, year: viewYear, month: viewMonth });
  } catch (e) {
    console.error(e);
    toast('שגיאה בייצוא ה‑PDF');
  }
}

function runExportCsv() {
  closeSheet($('exportSheet'));
  try {
    exportCSV({ entries: monthEntries(), settings: store.settings, year: viewYear, month: viewMonth });
    toast('קובץ ה‑CSV הורד');
  } catch (e) {
    console.error(e);
    toast('שגיאה בייצוא ה‑CSV');
  }
}

// ------------------------------------------------------------------ toast
let toastTimer = null;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  requestAnimationFrame(() => t.classList.add('show'));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    t.classList.remove('show');
    setTimeout(() => { t.hidden = true; }, 250);
  }, 2200);
}

// ------------------------------------------------------------------ wire up
function bind() {
  $('prevMonth').onclick = () => shiftMonth(-1);
  $('nextMonth').onclick = () => shiftMonth(1);
  $('monthLabel').onclick = () => { viewYear = now.getFullYear(); viewMonth = now.getMonth(); renderMonth(); renderAll(); };

  $('clockBtn').onclick = toggleClock;

  $('addBtn').onclick = () => openEntry(null);
  $('closeSheet').onclick = () => closeSheet($('entrySheet'));
  $('entryForm').onsubmit = submitEntry;
  $('deleteEntry').onclick = deleteCurrentEntry;
  ['fStart', 'fEnd', 'fBreak', 'fRate'].forEach((id) => $(id).addEventListener('input', updateCalc));
  $('typeSeg').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-type]');
    if (b) setFormType(b.dataset.type);
  });

  $('weeklyToggle').onclick = () => {
    weeklyOpen = !weeklyOpen;
    $('weeklyToggle').setAttribute('aria-expanded', String(weeklyOpen));
    $('weeklyBody').hidden = !weeklyOpen;
  };

  $('settingsBtn').onclick = openSettings;
  $('closeSettings').onclick = () => closeSheet($('settingsSheet'));
  $('settingsForm').onsubmit = submitSettings;
  $('authBtn').onclick = handleAuth;
  $('sDark').addEventListener('change', () => {
    store.settings.theme = $('sDark').checked ? 'dark' : 'light';
    applyTheme();
  });

  $('exportBtn').onclick = openExport;
  $('closeExport').onclick = () => closeSheet($('exportSheet'));
  $('doExportPdf').onclick = runExportPdf;
  $('doExportCsv').onclick = runExportCsv;

  // tap an entry to edit
  $('entries').addEventListener('click', (e) => {
    const card = e.target.closest('.entry');
    if (card) openEntry(card.dataset.id);
  });

  // close sheet on backdrop tap
  document.querySelectorAll('.sheet-backdrop').forEach((bd) => {
    bd.addEventListener('click', (e) => { if (e.target === bd) closeSheet(bd); });
  });
}

// ------------------------------------------------------------------ init
async function main() {
  bind();
  store.onChange(() => { applyTheme(); renderAll(); renderSyncStatus(); });
  await store.init();
  applyTheme();
  renderMonth();
  renderClock();
  renderAll();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
}

main();
