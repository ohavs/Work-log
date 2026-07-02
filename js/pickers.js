// Custom time wheel, calendar date picker, and confirm dialog.
// No native date/time inputs — nothing shows a "default" placeholder.
import { MONTHS, parseDate, toISO } from './util.js';
import { svg } from './icons.js';

const $ = (id) => document.getElementById(id);
const ITEM_H = 44; // must match CSS .wheel-item height
const pad2 = (n) => String(n).padStart(2, '0');

// ---------------------------------------------------------------- time wheel
let timeState = { onConfirm: null };

function buildWheel(el, count, fmt) {
  const spacer = '<div class="wheel-pad"></div>';
  let html = spacer;
  for (let i = 0; i < count; i++) html += `<div class="wheel-item" data-i="${i}">${fmt(i)}</div>`;
  html += spacer;
  el.innerHTML = html;
  el.querySelectorAll('.wheel-item').forEach((it) => {
    it.addEventListener('click', () => scrollToIndex(el, Number(it.dataset.i)));
  });
}
function scrollToIndex(el, i) { el.scrollTo({ top: i * ITEM_H, behavior: 'smooth' }); }
function setIndex(el, i) { el.scrollTop = i * ITEM_H; }
function readIndex(el, max) { return Math.max(0, Math.min(max, Math.round(el.scrollTop / ITEM_H))); }

function markActive(el, max) {
  const i = readIndex(el, max);
  el.querySelectorAll('.wheel-item').forEach((it) => it.classList.toggle('active', Number(it.dataset.i) === i));
}

export function openTimePicker({ title, value, onConfirm }) {
  const sheet = $('timePicker');
  $('timePickerTitle').textContent = title || 'בחירת שעה';
  const wh = $('wheelH'), wm = $('wheelM');
  buildWheel(wh, 24, pad2);
  buildWheel(wm, 60, pad2);
  const [h, m] = (value || '09:00').split(':').map(Number);
  timeState.onConfirm = onConfirm;

  sheet.hidden = false;
  requestAnimationFrame(() => {
    setIndex(wh, h || 0); setIndex(wm, m || 0);
    markActive(wh, 23); markActive(wm, 59);
  });
  const onScrollH = () => markActive(wh, 23);
  const onScrollM = () => markActive(wm, 59);
  wh.onscroll = onScrollH; wm.onscroll = onScrollM;
}

function closeTime() { $('timePicker').hidden = true; }

// ---------------------------------------------------------------- calendar
let dateState = { y: 0, m: 0, selISO: null, onConfirm: null };

function renderCal() {
  $('dpTitle').textContent = `${MONTHS[dateState.m]} ${dateState.y}`;
  const first = new Date(dateState.y, dateState.m, 1).getDay(); // 0=Sun
  const days = new Date(dateState.y, dateState.m + 1, 0).getDate();
  const today = toISO(new Date());
  const grid = $('dpGrid');
  let html = '';
  for (let i = 0; i < first; i++) html += '<span class="cal-cell empty"></span>';
  for (let d = 1; d <= days; d++) {
    const iso = `${dateState.y}-${pad2(dateState.m + 1)}-${pad2(d)}`;
    const cls = ['cal-cell'];
    if (iso === dateState.selISO) cls.push('sel');
    if (iso === today) cls.push('today');
    html += `<button type="button" class="${cls.join(' ')}" data-iso="${iso}">${d}</button>`;
  }
  grid.innerHTML = html;
}

export function openDatePicker({ valueISO, onConfirm }) {
  const d = valueISO ? parseDate(valueISO) : new Date();
  dateState = { y: d.getFullYear(), m: d.getMonth(), selISO: valueISO || toISO(new Date()), onConfirm };
  renderCal();
  $('datePicker').hidden = false;
}
function shiftCal(delta) {
  dateState.m += delta;
  if (dateState.m < 0) { dateState.m = 11; dateState.y--; }
  if (dateState.m > 11) { dateState.m = 0; dateState.y++; }
  renderCal();
}
function closeDate() { $('datePicker').hidden = true; }

// ---------------------------------------------------------------- confirm
let confirmResolve = null;
export function showConfirm({ title, message, confirmText = 'אישור', cancelText = 'ביטול', danger = false, icon = 'alert' }) {
  const modal = $('confirmModal');
  $('confirmTitle').textContent = title || '';
  $('confirmMsg').textContent = message || '';
  $('confirmOk').textContent = confirmText;
  $('confirmCancel').textContent = cancelText;
  $('confirmOk').classList.toggle('danger', !!danger);
  $('confirmIcon').className = 'dialog-ic' + (danger ? ' danger' : '');
  $('confirmIcon').innerHTML = svg(icon);
  modal.hidden = false;
  return new Promise((resolve) => { confirmResolve = resolve; });
}
function resolveConfirm(v) {
  $('confirmModal').hidden = true;
  if (confirmResolve) { confirmResolve(v); confirmResolve = null; }
}

// ---------------------------------------------------------------- wiring
export function initPickers() {
  $('timeCancel').onclick = closeTime;
  $('timeConfirm').onclick = () => {
    const h = readIndex($('wheelH'), 23), m = readIndex($('wheelM'), 59);
    closeTime();
    if (timeState.onConfirm) timeState.onConfirm(`${pad2(h)}:${pad2(m)}`);
  };

  $('dpPrev').onclick = () => shiftCal(-1);
  $('dpNext').onclick = () => shiftCal(1);
  $('dateCancel').onclick = closeDate;
  $('dpToday').onclick = () => { const iso = toISO(new Date()); closeDate(); if (dateState.onConfirm) dateState.onConfirm(iso); };
  $('dpGrid').addEventListener('click', (e) => {
    const cell = e.target.closest('.cal-cell[data-iso]');
    if (!cell) return;
    const iso = cell.dataset.iso;
    closeDate();
    if (dateState.onConfirm) dateState.onConfirm(iso);
  });

  $('confirmCancel').onclick = () => resolveConfirm(false);
  $('confirmOk').onclick = () => resolveConfirm(true);

  // backdrop taps: pickers cancel; confirm modal cancels
  [['timePicker', closeTime], ['datePicker', closeDate]].forEach(([id, fn]) => {
    $(id).addEventListener('click', (e) => { if (e.target.id === id) fn(); });
  });
  $('confirmModal').addEventListener('click', (e) => { if (e.target.id === 'confirmModal') resolveConfirm(false); });
}
