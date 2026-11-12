// Raw app screens for the Play listing: serves the web app, seeds believable sample data, and saves
// 400x860 (x2.7) captures into tools/store/out/. tools/store/screenshots.mjs frames them.
//   node tools/store/capture.mjs
import { createRequire } from 'node:module';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const { chromium } = createRequire(import.meta.url)('playwright');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = path.join(ROOT, 'tools/store/out');
fs.mkdirSync(OUT, { recursive: true });

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.woff2': 'font/woff2', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.ttf': 'font/ttf' };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  const f = path.join(ROOT, p);
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
}).listen(0);
const URL = `http://localhost:${server.address().port}/`;

// "Today" for every capture: Tuesday 17.11.2026, 13:42.
const NOW = new Date(2026, 10, 17, 13, 42, 0); // the dates; the clock is set in Israel time below
const NOW_MS = Date.UTC(2026, 10, 17, 11, 42);
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

function seed() {
  const entries = [];
  let n = 0;
  const starts = ['08:00', '08:15', '07:45', '08:30', '09:00', '08:05', '07:55'];
  const ends = ['16:45', '17:10', '16:30', '17:30', '18:05', '16:55', '17:20'];
  for (let d = new Date(2026, 9, 1); d < NOW; d.setDate(d.getDate() + 1)) {
    const dow = d.getDay();
    if (dow === 5 || dow === 6) continue;
    if (iso(d) === iso(NOW)) continue;
    n++;
    const e = { id: 'e' + n, type: 'work', date: iso(d), jobId: '', start: starts[n % 7], end: ends[(n * 3) % 7], breakMin: 30,
      rate: '', note: '', payPct: 100, created: 1, updated: NOW_MS };
    if (iso(d) === '2026-11-05') Object.assign(e, { type: 'vacation', start: '', end: '', breakMin: 0 });
    if (iso(d) === '2026-10-20') Object.assign(e, { type: 'sick', start: '', end: '', breakMin: 0 });
    if (iso(d) === '2026-11-12') e.note = 'ישיבת צוות + הדרכה';
    if (iso(d) === '2026-11-16') { e.end = '19:30'; e.note = 'סגירת חודש'; }
    entries.push(e);
  }
  const settings = { name: 'נועה', rate: 58, currency: '₪', goalHours: 182, goalWeekHours: 42, theme: 'light', palette: 'teal',
    jobs: [], reminder: true, reminderTime: '18:00', offDays: [5, 6], holidaysOff: true,
    activeShift: null };
  const cats = [{ id: 'c1', name: 'עבודה', color: '#0D9488' }, { id: 'c2', name: 'אנשי קשר', color: '#EA580C' }];
  const notes = [
    { id: 'n1', title: 'מנהלת משמרת', category: 'c2', body: '', fields: [{ label: 'שם', value: 'דנה כהן' }, { label: 'טלפון', value: '050-1234567' }], checklist: [], tags: [], pinned: true, created: 1, updated: NOW_MS - 3 * 864e5 },
    { id: 'n2', title: 'לפני סגירת חודש', category: 'c1', body: '', fields: [], checklist: [{ text: 'לשלוח דוח שעות', done: true }, { text: 'לבדוק את התלוש', done: false }, { text: 'להגיש קבלות נסיעה', done: false }], tags: [], pinned: false, created: 1, updated: NOW_MS - 864e5 },
    { id: 'n3', title: 'קוד לדלת האחורית', category: 'c1', body: '4821#', fields: [], checklist: [], tags: [], pinned: false, created: 1, updated: NOW_MS - 864e5 },
    { id: 'n4', title: 'רעיונות לשיפור', category: 'c1', body: 'לסדר את המחסן לפי קטגוריות, ולהזמין מדפים חדשים לפני החגים.', fields: [], checklist: [], tags: [], pinned: false, created: 1, updated: NOW_MS - 864e5 },
  ];
  return { entries, settings, cats, notes };
}

const browser = await chromium.launch();
async function page(theme = 'light', active = false) {
  const ctx = await browser.newContext({ viewport: { width: 400, height: 860 }, deviceScaleFactor: 2.7, locale: 'he-IL', timezoneId: 'Asia/Jerusalem', serviceWorkers: 'block' });
  const data = seed();
  data.settings.theme = theme;
  // 08:04 in Israel (UTC+2 in November).
  if (active) data.settings.activeShift = { start: Date.UTC(2026, 10, 17, 6, 4), jobId: '' };
  await ctx.addInitScript(({ data, now }) => {
    const Real = Date; const off = now - Real.now();
    // A fixed clock that still ticks, so the shift timer runs.
    globalThis.Date = class extends Real { constructor(...a) { a.length ? super(...a) : super(Real.now() + off); } static now() { return Real.now() + off; } };
    localStorage.setItem('wl_entries', JSON.stringify(data.entries));
    localStorage.setItem('wl_settings', JSON.stringify(data.settings));
    localStorage.setItem('wl_notes', JSON.stringify(data.notes));
    localStorage.setItem('wl_notecats', JSON.stringify(data.cats));
    localStorage.setItem('wl_settings_ts', String(now));
    if (data.settings.activeShift) localStorage.setItem('wl_active', JSON.stringify(data.settings.activeShift));
  }, { data, now: NOW_MS });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => console.error('pageerror', e.message));
  await p.goto(URL);
  await p.waitForTimeout(1500);
  return p;
}
const snap = (p, name) => p.screenshot({ path: path.join(OUT, name + '.png') });
const tab = async (p, view) => { await p.click(`.nav-item[data-view="${view}"]`); await p.waitForTimeout(700); };

let p = await page('light', true); await snap(p, 'home_active');
await tab(p, 'viewReports'); await snap(p, 'reports');
await p.click('#reportTabs [data-tab="weeks"]').catch(() => {}); await p.waitForTimeout(400); await snap(p, 'reports_weeks');
await tab(p, 'viewMore'); await snap(p, 'more');
await tab(p, 'viewNotes'); await snap(p, 'notes');
p = await page('light'); await snap(p, 'home');
p = await page('dark', true); await snap(p, 'home_dark');
await tab(p, 'viewReports'); await snap(p, 'reports_dark');
await browser.close(); server.close();
console.log('saved to', OUT);
