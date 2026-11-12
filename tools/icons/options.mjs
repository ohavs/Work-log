// Draft launcher icon options (512 px, full bleed), rendered side by side for the owner to pick from.
//   node tools/icons/options.mjs  ->  tools/icons/out/options.png
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const { chromium } = createRequire(import.meta.url)('playwright');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const F = path.join(ROOT, 'tools/store/.fonts/rubik/package/files');
const OUT = path.join(ROOT, 'tools/icons/out'); fs.mkdirSync(OUT, { recursive: true });
// Fonts as data URIs: a page made with setContent may not load file:// URLs.
const ff = (w, f) => `@font-face{font-family:R;font-weight:${w};src:url(data:font/woff2;base64,${fs.readFileSync(path.join(F, f)).toString('base64')})}`;
export const FONT_CSS = [ff(900, 'rubik-latin-900-normal.woff2'), ff(900, 'rubik-hebrew-900-normal.woff2'), ff(700, 'rubik-latin-700-normal.woff2'), ff(700, 'rubik-hebrew-700-normal.woff2')].join('\n');
const css = FONT_CSS;

// Clock hands at 9:00-ish -> pointing up and right, like a check mark of time.
const hands = (cx, cy, r, color, w) =>
  `<path d="M${cx} ${cy - r * 0.62} V${cy} L${cx + r * 0.42} ${cy + r * 0.26}" fill="none" stroke="${color}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"/>`;

export const ICONS = {
  // A: the app's punch button: dark teal, a ring of progress in orange, hands inside, the wordmark under them.
  ring: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
    <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#115E59"/><stop offset="1" stop-color="#0B3B38"/></linearGradient>
    <linearGradient id="o" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#FDBA74"/><stop offset="1" stop-color="#EA580C"/></linearGradient></defs>
    <rect width="512" height="512" fill="url(#g)"/>
    <circle cx="256" cy="236" r="150" fill="none" stroke="#ffffff22" stroke-width="34"/>
    <circle cx="256" cy="236" r="150" fill="none" stroke="url(#o)" stroke-width="34" stroke-linecap="round" stroke-dasharray="${2 * Math.PI * 150 * 0.72} 2000" transform="rotate(-90 256 236)"/>
    ${hands(256, 236, 150, '#fff', 30)}
    <text x="256" y="452" text-anchor="middle" font-family="R" font-weight="900" font-size="58" letter-spacing="6" fill="#fff">WORK LOG</text></svg>`,
  // B: the wordmark itself, the O of WORK replaced by an orange clock.
  word: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
    <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#14B8A6"/><stop offset="1" stop-color="#0D9488"/></linearGradient></defs>
    <rect width="512" height="512" fill="url(#g)"/>
    <text x="256" y="250" text-anchor="middle" font-family="R" font-weight="900" font-size="150" fill="#fff" letter-spacing="-4">W<tspan fill="transparent">O</tspan>RK</text>
    <circle cx="208" cy="196" r="52" fill="#F97316"/>${hands(208, 196, 52, '#fff', 13)}
    <text x="256" y="400" text-anchor="middle" font-family="R" font-weight="900" font-size="150" fill="#0B3B38" letter-spacing="-4">LOG</text></svg>`,
  // C: a timesheet card with a clock badge, on orange.
  sheet: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
    <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#FB923C"/><stop offset="1" stop-color="#EA580C"/></linearGradient></defs>
    <rect width="512" height="512" fill="url(#g)"/>
    <rect x="96" y="86" width="270" height="340" rx="34" fill="#fff" transform="rotate(-6 231 256)"/>
    <g transform="rotate(-6 231 256)" fill="#0D9488">
      <text x="126" y="150" font-family="R" font-weight="900" font-size="40" fill="#0B3B38">WORK LOG</text>
      <rect x="126" y="186" width="180" height="20" rx="10" opacity=".9"/><rect x="126" y="232" width="130" height="20" rx="10" opacity=".55"/>
      <rect x="126" y="278" width="160" height="20" rx="10" opacity=".55"/><rect x="126" y="324" width="100" height="20" rx="10" opacity=".55"/></g>
    <circle cx="352" cy="352" r="96" fill="#0B3B38"/><circle cx="352" cy="352" r="96" fill="none" stroke="#fff" stroke-width="14"/>
    ${hands(352, 352, 96, '#fff', 18)}</svg>`,
  // D: Hebrew: the word שעות under a clock, the git icon's teal turned dark with an orange face.
  heb: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
    <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0F766E"/><stop offset="1" stop-color="#0B3B38"/></linearGradient></defs>
    <rect width="512" height="512" fill="url(#g)"/>
    <circle cx="256" cy="200" r="118" fill="#F97316"/><circle cx="256" cy="200" r="118" fill="none" stroke="#FFEDD5" stroke-width="16"/>
    ${hands(256, 200, 118, '#fff', 24)}
    <text x="256" y="432" text-anchor="middle" font-family="R" font-weight="900" font-size="110" fill="#fff">שעות</text></svg>`,
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1200, height: 420 } });
  // Inline SVGs share one document: give each its own gradient ids.
  const uniq = (k, svg) => svg.replace(/id="(\w+)"/g, `id="${k}_$1"`).replace(/url\(#(\w+)\)/g, `url(#${k}_$1)`);
  const cell = (k, svg) => `<div style="text-align:center;font:600 22px sans-serif;color:#333">
    <div style="width:260px;height:260px;border-radius:60px;overflow:hidden;box-shadow:0 6px 18px #0003">${svg.replace('<svg ', '<svg width="260" height="260" ')}</div>
    <div style="margin-top:10px">${k}</div>
    <div style="display:inline-block;margin-top:8px;width:72px;height:72px;border-radius:50%;overflow:hidden">${svg.replace('<svg ', '<svg width="72" height="72" ')}</div></div>`;
  const names = { ring: 'א', word: 'ב', sheet: 'ג', heb: 'ד' };
  await p.setContent(`<style>${css}</style><body style="margin:0;padding:30px;background:#eef2f1;display:flex;gap:30px">${Object.entries(ICONS).map(([k, s]) => cell(names[k], uniq(k, s))).join('')}</body>`);
  await p.evaluate(async () => { await document.fonts.load('900 50px R', 'WORK שעות'); await document.fonts.load('700 50px R'); }); await p.waitForTimeout(300);
  await p.screenshot({ path: path.join(OUT, 'options.png') });
  await b.close();
}
