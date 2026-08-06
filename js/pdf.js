// PDF export — renders the styled RTL report to a real downloadable .pdf
// file via jsPDF + html2canvas, loaded from local files (js/vendor/, no CDN
// — the earlier CDN-based version could fail offline or behind stricter
// network/CSP policies). The previous blank-PDF bug was html2canvas
// capturing #pdfReport while it was parked off-screen at -9999px, which
// browsers don't reliably paint; it's now kept in-flow inside a
// zero-height, overflow-hidden wrapper instead (see .pdf-report-wrap).
// Falls back to the browser's native print-to-PDF only if the file
// generation itself throws.
import { MONTHS, DOW, TYPE_META, parseDate, workedMinutes, fmtHours, decimalHours, fmtMoney, entryType } from './util.js';

function buildReport(el, { entries, settings, year, month }) {
  const rate = Number(settings.rate) || 0;
  const cur = settings.currency || '₪';
  const sorted = [...entries].sort((a, b) => a.date.localeCompare(b.date) || (a.start || '').localeCompare(b.start || ''));
  let totalMin = 0, totalPay = 0;
  const days = new Set();
  let vacationDays = 0, sickDays = 0;

  const rows = sorted.map((e) => {
    const d = parseDate(e.date);
    const t = entryType(e);
    const dateCell = `${d.getDate()}/${month + 1} · ${DOW[d.getDay()]}`;
    if (t !== 'work') {
      if (t === 'vacation') vacationDays++; else sickDays++;
      return `<tr><td>${dateCell}</td><td colspan="4">${TYPE_META[t].label}</td><td>${(e.note || '').replace(/[<>]/g, '')}</td></tr>`;
    }
    const mins = workedMinutes(e);
    const r = e.rate != null && e.rate !== '' ? Number(e.rate) : rate;
    const pay = decimalHours(mins) * r;
    totalMin += mins; totalPay += pay; days.add(e.date);
    return `<tr>
      <td>${dateCell}</td><td>${e.start}–${e.end}</td><td>${e.breakMin ? e.breakMin + ' דק׳' : '—'}</td>
      <td>${fmtHours(mins)}</td><td>${r ? fmtMoney(pay, cur) : '—'}</td><td>${(e.note || '').replace(/[<>]/g, '')}</td>
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
      <thead><tr><th>תאריך</th><th>שעות</th><th>הפסקה</th><th>סה״כ</th><th>שכר</th><th>הערה</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="6" style="text-align:center;color:#8fb3ad">אין רישומים</td></tr>'}</tbody>
      <tfoot><tr><td colspan="3">סה״כ</td><td>${fmtHours(totalMin)}</td><td>${rate ? fmtMoney(totalPay, cur) : '—'}</td><td></td></tr></tfoot>
    </table>
    <p class="pdf-foot">הופק ב‑${new Date().toLocaleDateString('he-IL')} · מעקב שעות עבודה</p>`;

  return `שעות-עבודה-${MONTHS[month]}-${year}`;
}

async function renderToFile(el, fileBase) {
  const jsPDF = window.jspdf && window.jspdf.jsPDF;
  const html2canvas = window.html2canvas;
  if (!jsPDF || !html2canvas) throw new Error('PDF libraries not loaded (js/vendor/ scripts missing or blocked)');
  const canvas = await html2canvas(el, { scale: 2, backgroundColor: '#ffffff', useCORS: true, logging: false });
  const img = canvas.toDataURL('image/jpeg', 0.95);
  const pdf = new jsPDF({ unit: 'pt', format: 'a4' });
  const pageW = pdf.internal.pageSize.getWidth();
  const pageH = pdf.internal.pageSize.getHeight();
  const imgH = (canvas.height * pageW) / canvas.width;
  let remaining = imgH, position = 0;
  pdf.addImage(img, 'JPEG', 0, position, pageW, imgH, undefined, 'FAST');
  remaining -= pageH;
  while (remaining > 0) { position -= pageH; pdf.addPage(); pdf.addImage(img, 'JPEG', 0, position, pageW, imgH, undefined, 'FAST'); remaining -= pageH; }
  pdf.save(`${fileBase}.pdf`);
}

function printFallback(el, fileBase) {
  const prevTitle = document.title;
  document.title = fileBase; // becomes the suggested filename in "Save as PDF"
  const cleanup = () => { document.title = prevTitle; el.innerHTML = ''; window.removeEventListener('afterprint', cleanup); };
  window.addEventListener('afterprint', cleanup);
  window.print();
  setTimeout(cleanup, 60000); // safety net if afterprint never fires (e.g. dialog dismissed oddly)
}

export async function exportPDF({ entries, settings, year, month }) {
  const el = document.getElementById('pdfReport');
  const fileBase = buildReport(el, { entries, settings, year, month });
  try {
    await renderToFile(el, fileBase);
    el.innerHTML = '';
    return { method: 'file' };
  } catch (e) {
    console.warn('PDF file generation failed, falling back to print:', e);
    printFallback(el, fileBase);
    return { method: 'print' };
  }
}
