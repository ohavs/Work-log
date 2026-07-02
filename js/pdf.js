// PDF export — builds a styled RTL Hebrew report and uses the browser's
// native "Save as PDF" (print). No external libraries, works fully offline,
// and renders Hebrew as real selectable text.
import { MONTHS, DOW, TYPE_META, parseDate, workedMinutes, fmtHours, decimalHours, fmtMoney, entryType } from './util.js';

function buildReport(el, { entries, settings, year, month }) {
  const rate = Number(settings.rate) || 0;
  const cur = settings.currency || '₪';

  const sorted = [...entries].sort(
    (a, b) => a.date.localeCompare(b.date) || (a.start || '').localeCompare(b.start || '')
  );
  let totalMin = 0, totalPay = 0;
  const days = new Set();
  let vacationDays = 0, sickDays = 0;

  const rows = sorted.map((e) => {
    const d = parseDate(e.date);
    const t = entryType(e);
    const dateCell = `${d.getDate()}/${month + 1} · ${DOW[d.getDay()]}`;
    if (t !== 'work') {
      if (t === 'vacation') vacationDays++; else sickDays++;
      return `<tr>
        <td>${dateCell}</td>
        <td colspan="4">${TYPE_META[t].label}</td>
        <td>${(e.note || '').replace(/[<>]/g, '')}</td>
      </tr>`;
    }
    const mins = workedMinutes(e);
    const r = e.rate != null && e.rate !== '' ? Number(e.rate) : rate;
    const pay = decimalHours(mins) * r;
    totalMin += mins; totalPay += pay; days.add(e.date);
    return `<tr>
      <td>${dateCell}</td>
      <td>${e.start}–${e.end}</td>
      <td>${e.breakMin ? e.breakMin + ' דק׳' : '—'}</td>
      <td>${fmtHours(mins)}</td>
      <td>${r ? fmtMoney(pay, cur) : '—'}</td>
      <td>${(e.note || '').replace(/[<>]/g, '')}</td>
    </tr>`;
  }).join('');

  const offParts = [];
  if (vacationDays) offParts.push(`${vacationDays} ימי חופשה`);
  if (sickDays) offParts.push(`${sickDays} ימי מחלה`);

  el.innerHTML = `
    <h1>דוח שעות עבודה</h1>
    <p class="pdf-sub">${MONTHS[month]} ${year}${settings.name ? ' · ' + settings.name : ''}</p>
    <div class="pdf-cards">
      <div class="pdf-card"><b>${fmtHours(totalMin)}</b><span>סך שעות</span></div>
      <div class="pdf-card"><b>${days.size}</b><span>ימי עבודה</span></div>
      ${rate ? `<div class="pdf-card"><b>${fmtMoney(totalPay, cur)}</b><span>שכר משוער</span></div>` : ''}
      ${offParts.length ? `<div class="pdf-card"><b>${vacationDays + sickDays}</b><span>${offParts.join(' · ')}</span></div>` : ''}
    </div>
    <table>
      <thead><tr>
        <th>תאריך</th><th>שעות</th><th>הפסקה</th><th>סה״כ</th><th>שכר</th><th>הערה</th>
      </tr></thead>
      <tbody>${rows || '<tr><td colspan="6" style="text-align:center;color:#9a9ec0">אין רישומים</td></tr>'}</tbody>
      <tfoot><tr>
        <td colspan="3">סה״כ</td>
        <td>${fmtHours(totalMin)}</td>
        <td>${rate ? fmtMoney(totalPay, cur) : '—'}</td>
        <td></td>
      </tr></tfoot>
    </table>
    <p class="pdf-foot">הופק ב‑${new Date().toLocaleDateString('he-IL')} · מעקב שעות עבודה</p>
  `;
}

export async function exportPDF({ entries, settings, year, month }) {
  const el = document.getElementById('pdfReport');
  buildReport(el, { entries, settings, year, month });

  // Set a print-friendly document title (becomes the default PDF filename).
  const prevTitle = document.title;
  document.title = `שעות עבודה - ${MONTHS[month]} ${year}`;

  const cleanup = () => {
    document.title = prevTitle;
    el.innerHTML = '';
    window.removeEventListener('afterprint', cleanup);
  };
  window.addEventListener('afterprint', cleanup);

  // Give the layout a frame to settle, then open the print dialog.
  await new Promise((r) => setTimeout(r, 60));
  window.print();

  // Fallback cleanup for browsers that don't fire afterprint.
  setTimeout(cleanup, 60000);
}
