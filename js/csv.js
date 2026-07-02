// CSV export of a month's entries. UTF‑8 BOM so Hebrew opens correctly in Excel.
import { MONTHS, TYPE_META, entryType, workedMinutes, fmtHours, decimalHours } from './util.js';

function esc(v) {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function exportCSV({ entries, settings, year, month }) {
  const rate = Number(settings.rate) || 0;
  const sorted = [...entries].sort(
    (a, b) => a.date.localeCompare(b.date) || (a.start || '').localeCompare(b.start || '')
  );

  const header = ['תאריך', 'סוג', 'התחלה', 'סיום', 'הפסקה (דקות)', 'שעות', 'שכר', 'הערה'];
  const rows = sorted.map((e) => {
    const mins = workedMinutes(e);
    const r = e.rate != null && e.rate !== '' ? Number(e.rate) : rate;
    const pay = decimalHours(mins) * r;
    const isWork = entryType(e) === 'work';
    return [
      e.date,
      TYPE_META[entryType(e)].label,
      isWork ? e.start : '',
      isWork ? e.end : '',
      isWork ? (e.breakMin || 0) : '',
      isWork ? fmtHours(mins) : '',
      isWork && r ? Math.round(pay * 100) / 100 : '',
      e.note || '',
    ].map(esc).join(',');
  });

  const csv = '﻿' + [header.map(esc).join(','), ...rows].join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `שעות-עבודה-${MONTHS[month]}-${year}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
