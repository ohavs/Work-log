// The launcher icon ("timesheet" design, option ג in tools/icons/options.mjs, picked 17.11.2026): a WORK LOG
// timesheet with a clock badge on orange. Writes the Android launcher icons (adaptive foreground/background and
// the legacy square/round PNGs) and the 512 px Play listing icon.
//   node tools/icons/make.mjs
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FONT_CSS } from './options.mjs';
const { chromium } = createRequire(import.meta.url)('playwright');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const RES = path.join(ROOT, 'android/app/src/main/res');

const hands = (cx, cy, r, w) =>
  `<path d="M${cx} ${cy - r * 0.62} V${cy} L${cx + r * 0.42} ${cy + r * 0.26}" fill="none" stroke="#fff" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"/>`;
const BG = `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#FB923C"/><stop offset="1" stop-color="#EA580C"/></linearGradient></defs>
  <rect width="512" height="512" fill="url(#g)"/>`;
// The artwork spans about x 96-448, y 80-448; centred on (272, 264).
const ART = `<g transform="rotate(-6 231 256)">
    <rect x="96" y="86" width="270" height="340" rx="34" fill="#fff"/>
    <text x="126" y="150" font-family="R" font-weight="900" font-size="40" fill="#0B3B38">WORK LOG</text>
    <g fill="#0D9488"><rect x="126" y="186" width="180" height="20" rx="10" opacity=".9"/><rect x="126" y="232" width="130" height="20" rx="10" opacity=".55"/>
    <rect x="126" y="278" width="160" height="20" rx="10" opacity=".55"/><rect x="126" y="324" width="100" height="20" rx="10" opacity=".55"/></g></g>
  <circle cx="352" cy="352" r="96" fill="#0B3B38"/><circle cx="352" cy="352" r="96" fill="none" stroke="#fff" stroke-width="14"/>
  ${hands(352, 352, 96, 18)}`;
const svg = (body) => `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">${body}</svg>`;
const centred = (scale) => `<g transform="translate(256 256) scale(${scale}) translate(-272 -264)">${ART}</g>`;

export const FULL = svg(BG + centred(1));
const LEGACY = svg(BG + centred(0.9));
// Adaptive: everything inside the 66 dp safe circle of the 108 dp layer.
const FOREGROUND = svg(centred(0.66));
const BACKGROUND = svg(BG);

const b = await chromium.launch();
const p = await b.newPage();
async function png(svgText, size, file, clip = '') {
  await p.setViewportSize({ width: size, height: size });
  await p.setContent(`<style>${FONT_CSS} body{margin:0} svg{width:${size}px;height:${size}px;display:block;${clip}}</style>${svgText}`);
  await p.evaluate(async () => { await document.fonts.load('900 40px R', 'WORK LOG'); });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  await p.screenshot({ path: file, omitBackground: true });
}
const DENS = { ldpi: 0.75, mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };
for (const [d, k] of Object.entries(DENS)) {
  const dir = path.join(RES, `mipmap-${d}`);
  await png(FOREGROUND, Math.round(108 * k), path.join(dir, 'ic_launcher_foreground.png'));
  await png(BACKGROUND, Math.round(108 * k), path.join(dir, 'ic_launcher_background.png'));
  await png(LEGACY, Math.round(48 * k), path.join(dir, 'ic_launcher.png'), 'border-radius:18%');
  await png(LEGACY, Math.round(48 * k), path.join(dir, 'ic_launcher_round.png'), 'border-radius:50%');
}
for (const loc of ['iw-IL', 'en-US']) await png(FULL, 512, path.join(ROOT, 'store/listing', loc, 'images/icon.png'));
await b.close();
console.log('icons written');
