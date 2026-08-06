// PDF export — renders the styled RTL report to a real downloadable .pdf
// file via jsPDF + html2canvas, loaded from local files (js/vendor/, no CDN
// — a CDN-hosted library, or a CDN-hosted webfont, can fail offline or
// behind stricter network/CSP policies, and is one less thing to debug when
// something goes wrong on a device we can't see). #pdfReport is kept
// in-flow inside a zero-height, overflow-hidden wrapper (.pdf-report-wrap)
// rather than positioned off-screen, since browsers don't reliably paint
// content parked far outside the viewport. Multi-page reports are captured
// one page at a time (see renderToFile) rather than as one giant image
// sliced apart — see the comment on groupRowsByPage for why. Falls back to
// the browser's native print-to-PDF only if file generation itself throws.
import { MONTHS, DOW, TYPE_META, parseDate, workedMinutes, fmtHours, decimalHours, fmtMoney, entryType } from './util.js';
import { payrollOf, rateOf, grossForMonth, travelForMonth } from './finance.js';

function buildReport(el, { entries, settings, year, month }) {
  const p = payrollOf(settings);
  const cur = settings.currency || '₪';
  const sorted = [...entries].sort((a, b) => a.date.localeCompare(b.date) || (a.start || '').localeCompare(b.start || ''));
  let totalMin = 0;
  const days = new Set();
  let vacationDays = 0, sickDays = 0;

  const rows = sorted.map((e) => {
    const d = parseDate(e.date);
    const t = entryType(e);
    const dateCell = `${d.getDate()}/${month + 1} · ${DOW[d.getDay()]}`;
    if (t !== 'work') {
      if (t === 'vacation') {
        vacationDays++;
        return `<tr><td>${dateCell}</td><td colspan="4">${TYPE_META[t].label}</td><td>${(e.note || '').replace(/[<>]/g, '')}</td></tr>`;
      }
      sickDays++;
      const r = rateOf(e, settings);
      const pay = p.sickDayHours * r;
      return `<tr>
        <td>${dateCell}</td><td colspan="2">${TYPE_META[t].label}</td>
        <td>${fmtHours(p.sickDayHours * 60)}</td><td>${r ? fmtMoney(pay, cur) : '—'}</td><td>${(e.note || '').replace(/[<>]/g, '')}</td>
      </tr>`;
    }
    const mins = workedMinutes(e);
    const r = rateOf(e, settings);
    const pay = decimalHours(mins) * r;
    totalMin += mins; days.add(e.date);
    return `<tr>
      <td>${dateCell}</td><td>${e.start}–${e.end}</td><td>${e.breakMin ? e.breakMin + ' דק׳' : '—'}</td>
      <td>${fmtHours(mins)}</td><td>${r ? fmtMoney(pay, cur) : '—'}</td><td>${(e.note || '').replace(/[<>]/g, '')}</td>
    </tr>`;
  }).join('');

  const offParts = [];
  if (vacationDays) offParts.push(`${vacationDays} ימי חופשה`);
  if (sickDays) offParts.push(`${sickDays} ימי מחלה`);
  // Summary total comes from the same central calculation as everywhere
  // else in the app (grossForMonth + travel) — not summed from the rows
  // above — so a global/fixed-salary month shows the fixed salary here too,
  // instead of an hourly-rate estimate that would disagree with it. The
  // per-row "שכר" column stays as an hourly-rate estimate either way (still
  // a useful reference), it's only the total that must match the real payslip.
  const totalPay = grossForMonth(entries, settings, year, month).gross + travelForMonth(entries, settings, year, month).total;
  const anyRate = Number(settings.rate) > 0 || entries.some((e) => e.rate) || totalPay > 0;

  el.innerHTML = `
    <h1>דוח שעות עבודה</h1>
    <p class="pdf-sub">${MONTHS[month]} ${year}${settings.name ? ' · ' + settings.name : ''}</p>
    <div class="pdf-cards">
      <div class="pdf-card"><b>${fmtHours(totalMin)}</b><span>סך שעות</span></div>
      <div class="pdf-card"><b>${days.size}</b><span>ימי עבודה</span></div>
      ${anyRate ? `<div class="pdf-card"><b>${fmtMoney(totalPay, cur)}</b><span>שכר משוער</span></div>` : ''}
      ${offParts.length ? `<div class="pdf-card"><b>${vacationDays + sickDays}</b><span>${offParts.join(' · ')}</span></div>` : ''}
    </div>
    <table>
      <thead><tr><th>תאריך</th><th>שעות</th><th>הפסקה</th><th>סה״כ</th><th>שכר</th><th>הערה</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="6" style="text-align:center;color:#8fb3ad">אין רישומים</td></tr>'}</tbody>
      <tfoot><tr><td colspan="3">סה״כ</td><td>${fmtHours(totalMin)}</td><td>${anyRate ? fmtMoney(totalPay, cur) : '—'}</td><td></td></tr></tfoot>
    </table>
    <p class="pdf-foot">הופק ב‑${new Date().toLocaleDateString('he-IL')} · מעקב שעות עבודה</p>`;

  return `שעות-עבודה-${MONTHS[month]}-${year}`;
}

// Group table rows into pages by their real rendered height, so a page
// break only ever falls BETWEEN rows, never through one. Page 1 has less
// room for rows than later pages (the title/subtitle/summary cards sit
// above the table there); every later page instead starts with a cloned
// header row, so column labels are never missing.
//
// Earlier attempts captured the WHOLE report as one tall canvas and then
// either (a) sliced/repositioned that single image per page — jsPDF's
// clip()/saveGraphicsState() silently failed to restrict drawing at all in
// this bundled build, leaving the image bleeding past every margin — or
// (b) pre-cropped per-page canvases from that one giant capture, which
// fixed the bleeding but turned out to depend on a single very large,
// complex html2canvas() capture that unreliably dropped background colors/
// borders (cards + header shading) on some runs while leaving text intact —
// consistent with a known html2canvas limitation on large/complex captures.
// Capturing each page separately (by hiding every row that doesn't belong
// to it) keeps every individual html2canvas() call small and simple, which
// resolved that reliability problem in testing.
function groupRowsByPage(el, table, pageHeightPx) {
  const intro = [...el.children].filter((c) => c !== table && !c.classList.contains('pdf-foot'));
  const theadRow = table.querySelector('thead tr');
  const tbody = table.querySelector('tbody');
  const rows = [...tbody.querySelectorAll('tr')];
  const elRect = el.getBoundingClientRect();
  // Measured as position deltas, not summed element heights — an element's
  // own getBoundingClientRect().height is its border box only and excludes
  // margin entirely, so summing individual heights silently drops every
  // margin gap between them (e.g. the summary cards' margin-bottom, the
  // closing line's margin-top). Position deltas capture the true rendered
  // space regardless of what's creating the gap.
  const introHeight = table.getBoundingClientRect().top - elRect.top;
  const theadH = theadRow.getBoundingClientRect().height;
  // tfoot + the closing "generated on <date>" line only ever render on the
  // last page, but WHICH page ends up last isn't known while grouping rows
  // — so their height is reserved out of every page's budget uniformly.
  // Slightly conservative (a little unused space on non-final pages) but
  // guarantees the actual last page always has room for them.
  const tailHeight = elRect.bottom - tbody.getBoundingClientRect().bottom;
  const groups = [[]];
  let used = 0, budget = pageHeightPx - introHeight - tailHeight;
  for (const row of rows) {
    const h = row.getBoundingClientRect().height;
    if (groups[groups.length - 1].length && used + h > budget) {
      groups.push([]);
      used = 0;
      budget = pageHeightPx - theadH - tailHeight;
    }
    groups[groups.length - 1].push(row);
    used += h;
  }
  return { intro, theadRow, rows, groups };
}

async function renderToFile(el, fileBase) {
  const jsPDF = window.jspdf && window.jspdf.jsPDF;
  const html2canvas = window.html2canvas;
  if (!jsPDF || !html2canvas) throw new Error('PDF libraries not loaded (js/vendor/ scripts missing or blocked)');

  // Wait for the report's webfont to actually finish loading before
  // measuring/capturing it — html2canvas has to rasterize with whatever
  // font is active at that instant, and capturing mid-swap (fallback font
  // still showing) can throw off row-height measurements.
  if (document.fonts && document.fonts.ready) { try { await document.fonts.ready; } catch {} }

  // Export is triggered from a real click that just closed the export-choice
  // sheet (a .2s CSS transition) — capturing while that's still settling was
  // caught intermittently losing background colors and borders (cards, table
  // header shading) while text still rendered fine. Reproduced reliably when
  // triggered by an actual dispatched click event, never when the same
  // export function was called directly (i.e. with no pending sheet
  // transition) — two animation frames wasn't enough to fix it, only a real
  // wait past the transition's duration was.
  await new Promise((r) => setTimeout(r, 350));

  const pdf = new jsPDF({ unit: 'pt', format: 'a4' });
  const pageW = pdf.internal.pageSize.getWidth();
  const pageH = pdf.internal.pageSize.getHeight();
  const margin = 30; // real page margins on every side, every page — not edge-to-edge image bleed
  const contentW = pageW - margin * 2;
  const contentH = pageH - margin * 2;
  const elWidthPx = el.getBoundingClientRect().width || 794;
  const pageHeightPx = contentH * (elWidthPx / contentW); // one page's height, in the report's own CSS-px coordinate space

  const table = el.querySelector('table');
  const thead = table.querySelector('thead');
  const tbody = table.querySelector('tbody');
  const tfoot = table.querySelector('tfoot');
  const foot = el.querySelector('.pdf-foot');
  const { intro, theadRow, rows, groups } = groupRowsByPage(el, table, pageHeightPx);

  const hideAllRows = () => rows.forEach((r) => { r.style.display = 'none'; });

  let clonedHead = null, first = true;
  for (let i = 0; i < groups.length; i++) {
    const isLast = i === groups.length - 1;
    hideAllRows();
    groups[i].forEach((r) => { r.style.display = ''; });
    intro.forEach((n) => { n.style.display = i === 0 ? '' : 'none'; });
    // The original <thead> only makes sense on page 1 (right above its own
    // rows) — every later page gets a cloned header row inserted into tbody
    // instead, positioned right above THAT page's first row.
    thead.style.display = i === 0 ? '' : 'none';
    if (i > 0) {
      clonedHead = theadRow.cloneNode(true);
      tbody.insertBefore(clonedHead, groups[i][0]);
    }
    if (tfoot) tfoot.style.display = isLast ? '' : 'none';
    if (foot) foot.style.display = isLast ? '' : 'none';

    const canvas = await html2canvas(el, { scale: 2, backgroundColor: '#ffffff', useCORS: true, logging: false });
    const img = canvas.toDataURL('image/png');
    const drawH = Math.min(contentH, (canvas.height * contentW) / canvas.width);
    if (!first) pdf.addPage();
    pdf.addImage(img, 'PNG', margin, margin, contentW, drawH);
    first = false;

    if (clonedHead) { clonedHead.remove(); clonedHead = null; }
  }
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
