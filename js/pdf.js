// PDF export — draws the RTL report natively with jsPDF's own vector text/
// shape API (no html2canvas / browser screenshot involved at all). The old
// approach captured a hidden HTML report with html2canvas and stitched the
// screenshots into a PDF; that depended on the browser having fully painted
// every background color, border, and font swap at the exact instant of
// capture, which turned out to fail unrecoverably on at least one real
// device even after several rounds of capture-timing fixes (settle delays,
// per-page capture, pixel-sampling verify-and-retry). Drawing text/rects/
// lines directly runs the exact same code path on every device — nothing
// to race, nothing to verify after the fact.
//
// jsPDF has its own built-in Unicode bidi engine (a full implementation of
// the bidi algorithm, wired up as a "postProcessText" hook on every
// .text() call) — it must NOT be paired with any additional manual
// reordering of our own, and it must be told the input is logical order
// (the order Hebrew is naturally typed/stored in a JS string) via
// {isInputVisual:false}, since its default assumes the opposite. Passing
// already-visual-order text, or double-reordering with a custom bidi
// function on top of it, is what previously made digit sequences next to
// Hebrew letters render reversed.
import { MONTHS, DOW, TYPE_META, parseDate, workedMinutes, fmtHours, decimalHours, fmtMoney, entryType } from './util.js';
import { payrollOf, rateOf, grossForMonth, travelForMonth } from './finance.js';

const FONT_REGULAR_URL = './fonts/noto-sans-hebrew/pdf-hebrew-400.ttf';
const FONT_BOLD_URL = './fonts/noto-sans-hebrew/pdf-hebrew-700.ttf';

const COLOR = {
  text: [19, 78, 74],
  sub: [95, 128, 123],
  brand: [13, 148, 136],
  cardBorder: [205, 235, 230],
  theadBg: [232, 241, 244],
  rowBorder: [238, 240, 247],
  footBorder: [205, 235, 230],
  foot: [143, 179, 173],
  white: [255, 255, 255],
};

const MARGIN = 40;
// Column order, right-to-left (col 0 = rightmost = first logical column),
// matching the original table's <th> order. "note" takes whatever width is
// left over after the fixed columns, since it's the one free-text field.
const COL_DEFS = [
  { key: 'date', label: 'תאריך', w: 82 },
  { key: 'hours', label: 'שעות', w: 78 },
  { key: 'brk', label: 'הפסקה', w: 55 },
  { key: 'total', label: 'סה״כ', w: 55 },
  { key: 'pay', label: 'שכר', w: 70 },
  { key: 'note', label: 'הערה', w: null },
];
const ROW_PAD_V = 7;
const ROW_PAD_H = 7;
const LINE_H = 12.5;
const HEADER_H = 26;

function computeReportData({ entries, settings, year, month }) {
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
        return [
          { col: 0, span: 1, text: dateCell },
          { col: 1, span: 4, text: TYPE_META[t].label },
          { col: 5, span: 1, text: (e.note || '').trim() },
        ];
      }
      sickDays++;
      const r = rateOf(e, settings);
      const pay = p.sickDayHours * r;
      return [
        { col: 0, span: 1, text: dateCell },
        { col: 1, span: 2, text: TYPE_META[t].label },
        { col: 3, span: 1, text: fmtHours(p.sickDayHours * 60) },
        { col: 4, span: 1, text: r ? fmtMoney(pay, cur) : '—' },
        { col: 5, span: 1, text: (e.note || '').trim() },
      ];
    }
    const mins = workedMinutes(e);
    const r = rateOf(e, settings);
    const pay = decimalHours(mins) * r;
    totalMin += mins; days.add(e.date);
    return [
      { col: 0, span: 1, text: dateCell },
      { col: 1, span: 1, text: `${e.start}–${e.end}` },
      { col: 2, span: 1, text: e.breakMin ? e.breakMin + ' דק׳' : '—' },
      { col: 3, span: 1, text: fmtHours(mins) },
      { col: 4, span: 1, text: r ? fmtMoney(pay, cur) : '—' },
      { col: 5, span: 1, text: (e.note || '').trim() },
    ];
  });

  const offParts = [];
  if (vacationDays) offParts.push(`${vacationDays} ימי חופשה`);
  if (sickDays) offParts.push(`${sickDays} ימי מחלה`);
  // Same central calculation as everywhere else in the app (grossForMonth +
  // travel) — not summed from the rows above — so a global/fixed-salary
  // month's summary total matches the rest of the app (and any shortfall
  // deduction) instead of an hourly-rate estimate that could disagree.
  const totalPay = grossForMonth(entries, settings, year, month).gross + travelForMonth(entries, settings, year, month).total;
  const anyRate = Number(settings.rate) > 0 || entries.some((e) => e.rate) || totalPay > 0;

  const cards = [
    { value: fmtHours(totalMin), label: 'סך שעות' },
    { value: String(days.size), label: 'ימי עבודה' },
  ];
  if (anyRate) cards.push({ value: fmtMoney(totalPay, cur), label: 'שכר משוער' });
  if (offParts.length) cards.push({ value: String(vacationDays + sickDays), label: offParts.join(' · ') });

  return {
    fileBase: `שעות-עבודה-${MONTHS[month]}-${year}`,
    title: 'דוח שעות עבודה',
    subtitle: `${MONTHS[month]} ${year}${settings.name ? ' · ' + settings.name : ''}`,
    cards,
    rows,
    hasRows: rows.length > 0,
    totalHoursText: fmtHours(totalMin),
    totalPayText: anyRate ? fmtMoney(totalPay, cur) : '—',
    footText: `הופק ב-${new Date().toLocaleDateString('he-IL')} · מעקב שעות עבודה`,
  };
}

async function fetchBase64(url) {
  const buf = await (await fetch(url)).arrayBuffer();
  const bytes = new Uint8Array(buf);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  return btoa(binary);
}

async function loadFonts(pdf) {
  const [regular, bold] = await Promise.all([fetchBase64(FONT_REGULAR_URL), fetchBase64(FONT_BOLD_URL)]);
  pdf.addFileToVFS('NotoHeb-Regular.ttf', regular);
  pdf.addFont('NotoHeb-Regular.ttf', 'Heb', 'normal');
  pdf.addFileToVFS('NotoHeb-Bold.ttf', bold);
  pdf.addFont('NotoHeb-Bold.ttf', 'Heb', 'bold');
}

// Always draw Hebrew/mixed text through this — jsPDF's built-in bidi
// engine (see file header comment) needs isInputVisual:false on every call,
// and this is the one place that's set.
function T(pdf, text, x, y, opts) {
  pdf.text(text == null ? '' : String(text), x, y, { ...opts, isInputVisual: false });
}

function layoutColumns(contentW) {
  const fixed = COL_DEFS.filter((c) => c.w != null).reduce((s, c) => s + c.w, 0);
  const widths = COL_DEFS.map((c) => c.w != null ? c.w : contentW - fixed);
  const rightEdge = []; // right edge (x) of each column
  let acc = 0;
  for (let i = 0; i < widths.length; i++) { rightEdge.push(MARGIN + contentW - acc); acc += widths[i]; }
  const cellBox = (col, span) => {
    const right = rightEdge[col];
    const w = widths.slice(col, col + span).reduce((s, x) => s + x, 0);
    return { right, left: right - w, w };
  };
  return { widths, cellBox };
}

// Wraps a cell's text to its box width and returns the line count needed —
// used in a first pass (no drawing yet) to compute each row's real height
// before deciding page breaks, so a break only ever falls between rows.
function wrapLines(pdf, text, w) {
  if (!text) return [''];
  const usable = Math.max(10, w - ROW_PAD_H * 2);
  return pdf.splitTextToSize(text, usable);
}

function rowHeight(pdf, row, cellBox) {
  let maxLines = 1;
  for (const cell of row) {
    const { w } = cellBox(cell.col, cell.span);
    const lines = wrapLines(pdf, cell.text, w).length;
    if (lines > maxLines) maxLines = lines;
  }
  return maxLines * LINE_H + ROW_PAD_V * 2;
}

// Splits rows into page-groups by their real (pre-measured) heights so a
// page break only ever falls between rows, never through one. Page 1 has
// less room (title/subtitle/cards sit above the table); every later page
// gets a repeated header row instead. The last group is re-checked against
// the space the totals row + closing line need and rows are pushed onto a
// fresh trailing page if it doesn't fit — exact, since heights are known
// up front (no DOM/screenshot timing involved).
function paginateRows(heights, contentH, introH, tailH) {
  const groups = [[]];
  let used = 0, budget = contentH - introH;
  for (let i = 0; i < heights.length; i++) {
    const h = heights[i];
    if (groups[groups.length - 1].length && used + h > budget) {
      groups.push([]);
      used = 0;
      budget = contentH - HEADER_H;
    }
    groups[groups.length - 1].push(i);
    used += h;
  }
  while (groups.length) {
    const last = groups[groups.length - 1];
    if (last.length <= 1) break;
    const usedLast = last.reduce((s, i) => s + heights[i], 0);
    const headH = groups.length === 1 ? introH : HEADER_H;
    if (usedLast + headH + tailH > contentH) groups.push([last.pop()]);
    else break;
  }
  return groups;
}

function roundedRect(pdf, x, y, w, h, r, style) {
  pdf.roundedRect(x, y, w, h, r, r, style);
}

function drawCards(pdf, cards, y, contentW) {
  const gap = 12;
  const w = (contentW - gap * (cards.length - 1)) / cards.length;
  const h = 62;
  cards.forEach((c, i) => {
    // RTL: card 0 is rightmost.
    const x = MARGIN + contentW - w - i * (w + gap);
    pdf.setDrawColor(...COLOR.cardBorder);
    pdf.setLineWidth(1);
    roundedRect(pdf, x, y, w, h, 8, 'S');
    pdf.setFont('Heb', 'bold');
    pdf.setFontSize(17);
    pdf.setTextColor(...COLOR.brand);
    T(pdf, c.value, x + w / 2, y + 27, { align: 'center' });
    pdf.setFont('Heb', 'normal');
    pdf.setFontSize(9.5);
    pdf.setTextColor(...COLOR.sub);
    T(pdf, c.label, x + w / 2, y + 44, { align: 'center' });
  });
  return y + h;
}

function drawHeaderRow(pdf, y, contentW, cellBox) {
  pdf.setFillColor(...COLOR.theadBg);
  roundedRect(pdf, MARGIN, y, contentW, HEADER_H, 6, 'F');
  pdf.setFont('Heb', 'bold');
  pdf.setFontSize(10.5);
  pdf.setTextColor(...COLOR.text);
  COL_DEFS.forEach((c, i) => {
    const { right } = cellBox(i, 1);
    T(pdf, c.label, right - ROW_PAD_H, y + HEADER_H / 2 + 3.5, { align: 'right' });
  });
  return y + HEADER_H;
}

function drawRow(pdf, row, y, h, cellBox) {
  pdf.setFont('Heb', 'normal');
  pdf.setFontSize(10);
  pdf.setTextColor(...COLOR.text);
  for (const cell of row) {
    const { right, w } = cellBox(cell.col, cell.span);
    const lines = wrapLines(pdf, cell.text, w);
    lines.forEach((line, li) => {
      T(pdf, line, right - ROW_PAD_H, y + ROW_PAD_V + LINE_H * (li + 0.75), { align: 'right' });
    });
  }
  pdf.setDrawColor(...COLOR.rowBorder);
  pdf.setLineWidth(0.75);
  pdf.line(MARGIN, y + h, MARGIN + (cellBox(0, 1).right - MARGIN), y + h);
  return y + h;
}

function drawTotalsRow(pdf, data, y, cellBox) {
  const h = HEADER_H;
  pdf.setDrawColor(...COLOR.footBorder);
  pdf.setLineWidth(1.5);
  pdf.line(MARGIN, y, MARGIN + cellBox(0, 1).right - MARGIN, y);
  pdf.setFont('Heb', 'bold');
  pdf.setFontSize(10.5);
  pdf.setTextColor(...COLOR.text);
  const labelBox = cellBox(0, 3);
  T(pdf, 'סה״כ', labelBox.right - ROW_PAD_H, y + h / 2 + 3.5, { align: 'right' });
  const totalBox = cellBox(3, 1);
  T(pdf, data.totalHoursText, totalBox.right - ROW_PAD_H, y + h / 2 + 3.5, { align: 'right' });
  const payBox = cellBox(4, 1);
  T(pdf, data.totalPayText, payBox.right - ROW_PAD_H, y + h / 2 + 3.5, { align: 'right' });
  return y + h;
}

function buildNativePdf(data) {
  const jsPDFCtor = window.jspdf && window.jspdf.jsPDF;
  if (!jsPDFCtor) throw new Error('jsPDF not loaded (js/vendor/ script missing or blocked)');
  const pdf = new jsPDFCtor({ unit: 'pt', format: 'a4' });
  return pdf;
}

async function renderToFile(data) {
  const pdf = buildNativePdf(data);
  await loadFonts(pdf);
  // Row-height measurement below (wrapLines/splitTextToSize) depends on
  // whatever font/size is active at the time — it must match what drawRow
  // actually uses to draw row text, or wrap widths would be computed
  // against the wrong metrics.
  pdf.setFont('Heb', 'normal');
  pdf.setFontSize(10);

  const pageW = pdf.internal.pageSize.getWidth();
  const pageH = pdf.internal.pageSize.getHeight();
  const contentW = pageW - MARGIN * 2;
  const contentH = pageH - MARGIN * 2;
  const { cellBox } = layoutColumns(contentW);

  const introH = 100 + (data.cards.length ? 78 : 0); // title + subtitle + cards block, roughly
  const tailH = HEADER_H + 34; // totals row + closing line

  const heights = data.rows.map((r) => rowHeight(pdf, r, cellBox));
  const groups = data.hasRows ? paginateRows(heights, contentH, introH, tailH) : [[]];

  groups.forEach((group, gi) => {
    if (gi > 0) pdf.addPage();
    let y = MARGIN;
    if (gi === 0) {
      pdf.setFont('Heb', 'bold');
      pdf.setFontSize(21);
      pdf.setTextColor(...COLOR.text);
      T(pdf, data.title, MARGIN + contentW, y + 18, { align: 'right' });
      y += 26;
      pdf.setFont('Heb', 'normal');
      pdf.setFontSize(11);
      pdf.setTextColor(...COLOR.sub);
      T(pdf, data.subtitle, MARGIN + contentW, y + 4, { align: 'right' });
      y += 24;
      if (data.cards.length) { y = drawCards(pdf, data.cards, y, contentW) + 18; }
      else y += 10;
    }
    y = drawHeaderRow(pdf, y, contentW, cellBox);
    if (!data.hasRows) {
      pdf.setFont('Heb', 'normal');
      pdf.setFontSize(10.5);
      pdf.setTextColor(...COLOR.foot);
      T(pdf, 'אין רישומים', MARGIN + contentW / 2, y + 24, { align: 'center' });
      y += 40;
    } else {
      for (const idx of group) {
        y = drawRow(pdf, data.rows[idx], y, heights[idx], cellBox);
      }
    }
    const isLast = gi === groups.length - 1;
    if (isLast) {
      y += 4;
      y = drawTotalsRow(pdf, data, y, cellBox);
      y += 20;
      pdf.setFont('Heb', 'normal');
      pdf.setFontSize(8.5);
      pdf.setTextColor(...COLOR.foot);
      T(pdf, data.footText, MARGIN + contentW / 2, y, { align: 'center' });
    }
  });

  pdf.save(`${data.fileBase}.pdf`);
}

// Print fallback keeps using the old hidden-HTML + browser-native print
// path (no html2canvas involved there either) — only used if native PDF
// generation itself throws.
function buildPrintReport(el, data) {
  const rowsHtml = data.rows.map((cells) => {
    const byCol = new Map(cells.map((c) => [c.col, c]));
    const tds = [];
    for (let i = 0; i < COL_DEFS.length; i++) {
      const c = byCol.get(i);
      if (!c) continue;
      tds.push(`<td${c.span > 1 ? ` colspan="${c.span}"` : ''}>${(c.text || '').replace(/[<>]/g, '')}</td>`);
    }
    return `<tr>${tds.join('')}</tr>`;
  }).join('');

  el.innerHTML = `
    <h1>${data.title}</h1>
    <p class="pdf-sub">${data.subtitle}</p>
    <div class="pdf-cards">
      ${data.cards.map((c) => `<div class="pdf-card"><b>${c.value}</b><span>${c.label}</span></div>`).join('')}
    </div>
    <table>
      <thead><tr>${COL_DEFS.map((c) => `<th>${c.label}</th>`).join('')}</tr></thead>
      <tbody>${rowsHtml || '<tr><td colspan="6" style="text-align:center;color:#8fb3ad">אין רישומים</td></tr>'}</tbody>
      <tfoot><tr><td colspan="3">סה״כ</td><td>${data.totalHoursText}</td><td>${data.totalPayText}</td><td></td></tr></tfoot>
    </table>
    <p class="pdf-foot">${data.footText}</p>`;
}

function printFallback(el, data) {
  buildPrintReport(el, data);
  const prevTitle = document.title;
  document.title = data.fileBase; // becomes the suggested filename in "Save as PDF"
  const cleanup = () => { document.title = prevTitle; el.innerHTML = ''; window.removeEventListener('afterprint', cleanup); };
  window.addEventListener('afterprint', cleanup);
  window.print();
  setTimeout(cleanup, 60000); // safety net if afterprint never fires (e.g. dialog dismissed oddly)
}

export async function exportPDF({ entries, settings, year, month }) {
  const data = computeReportData({ entries, settings, year, month });
  try {
    await renderToFile(data);
    return { method: 'file' };
  } catch (e) {
    console.warn('PDF file generation failed, falling back to print:', e);
    const el = document.getElementById('pdfReport');
    printFallback(el, data);
    return { method: 'print' };
  }
}
