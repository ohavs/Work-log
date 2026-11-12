// Google Play images: phone screenshots (1080x1920 JPEG), the feature graphic (1024x500 JPEG) and the icon
// (512 PNG), into store/listing/<locale>/images (fastlane layout), for iw-IL and en-US.
//
// Style: the brutalist look of ohavs/Currency-26's listing, in this app's colours: one flat colour per
// screenshot, a dark ink for frames and hard offset shadows, a giant headline whose payoff sits in a solid block,
// a tilted phone and a sticker with a fact that is true for the app today.
//
// The app screens come from tools/store/capture.mjs (tools/store/out/*.png). Fonts come from npm (@fontsource)
// into tools/store/.fonts.
//
//   node tools/store/capture.mjs && node tools/store/screenshots.mjs
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const { chromium } = createRequire(import.meta.url)('playwright');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SRC = path.join(ROOT, 'tools/store/out');
const OUT = path.join(ROOT, 'store/listing');
const FONTS = path.join(ROOT, 'tools/store/.fonts');

function fontsource(pkg) {
  const dir = path.join(FONTS, pkg);
  if (!fs.existsSync(path.join(dir, 'package'))) {
    fs.mkdirSync(dir, { recursive: true });
    const tgz = execSync(`npm pack @fontsource/${pkg} --silent`, { cwd: dir }).toString().trim().split('\n').pop();
    execSync(`tar xzf ${tgz} && rm ${tgz}`, { cwd: dir });
  }
  return path.join(dir, 'package/files');
}
const font = (family, file, weight) => `@font-face{font-family:'${family}';font-weight:${weight};src:url('file://${file}') format('woff2')}`;
const FONT_CSS = (() => {
  const so = fontsource('secular-one'), ru = fontsource('rubik');
  return [
    font('Head', `${so}/secular-one-hebrew-400-normal.woff2`, 400), font('Head', `${so}/secular-one-latin-400-normal.woff2`, 400),
    font('Body', `${ru}/rubik-hebrew-800-normal.woff2`, 800), font('Body', `${ru}/rubik-latin-800-normal.woff2`, 800),
  ].join('\n');
})();

const uri = (file, type = 'image/png') => `data:${type};base64,` + fs.readFileSync(file).toString('base64');
const shot = (name) => uri(path.join(SRC, `${name}.png`));

const INK = '#0F2A2A';
// Teal and orange are the app's default palette (js/app.js PALETTES.teal); cream and the darks sit beside them.
const LOOKS = [
  { bg: '#14B8A6', fg: INK, blockBg: INK, blockFg: '#D7F7F1', sticker: '#FDBA74' },
  { bg: '#FDBA74', fg: INK, blockBg: '#0D9488', blockFg: '#FFFFFF', sticker: '#FFFFFF' },
  { bg: '#FFF4E6', fg: INK, blockBg: '#EA580C', blockFg: '#FFFFFF', sticker: '#5EEAD4' },
  { bg: '#0D9488', fg: '#FFFFFF', blockBg: '#FDBA74', blockFg: INK, sticker: '#FFFFFF' },
  { bg: '#99F6E4', fg: INK, blockBg: INK, blockFg: '#99F6E4', sticker: '#FDBA74' },
  { bg: INK, fg: '#FFFFFF', blockBg: '#14B8A6', blockFg: INK, sticker: '#FDBA74' },
];

// Headlines are two beats: plain words, then the payoff in a block. Stickers are facts that are true today.
const COPY = {
  'iw-IL': {
    rtl: true,
    shots: [
      { img: 'home_active', h: ['כניסה ויציאה', 'בלחיצה אחת.'], st: 'השעה נקלטת לבד' },
      { img: 'reports', h: ['כל השעות והשכר', 'בדוח אחד.'], st: 'ייצוא ל־PDF ו־CSV' },
      { img: 'reports_weeks', h: ['יעד שבועי וחודשי.', 'תמיד מול העיניים.'], st: 'חופשה ומחלה נספרות' },
      { img: 'more', h: ['נטו, פנסיה ושעות נוספות.', 'מחושב לבד.'], st: 'הערכה לפי החוק בישראל' },
      { img: 'notes', h: ['כל מה שצריך בעבודה.', 'בפנקס אחד.'], st: 'טלפונים, קודים, משימות' },
      { img: 'home_dark', h: ['בהיר או כהה.', 'מסונכרן בענן.'], st: 'גם בלי אינטרנט' },
    ],
    feature: ['שעות העבודה והשכר שלך.', 'בלחיצה אחת.'],
  },
  'en-US': {
    rtl: false,
    shots: [
      { img: 'home_active', h: ['Clock in and out', 'with one tap.'], st: 'Time is logged for you' },
      { img: 'reports', h: ['Every hour, every shekel.', 'One report.'], st: 'Export to PDF and CSV' },
      { img: 'reports_weeks', h: ['Weekly and monthly goals.', 'Always in view.'], st: 'Vacation and sick days count' },
      { img: 'more', h: ['Net pay, pension, overtime.', 'Calculated for you.'], st: 'Estimated per Israeli law' },
      { img: 'notes', h: ['All your work notes.', 'One notebook.'], st: 'Phones, codes, checklists' },
      { img: 'home_dark', h: ['Light or dark.', 'Cloud synced.'], st: 'Works offline' },
    ],
    feature: ['Your work hours and pay.', 'One tap.'],
  },
};

const esc = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;');

function screenshotHtml(c, s, look, i) {
  const rtl = c.rtl, side = rtl ? 'right' : 'left', other = rtl ? 'left' : 'right';
  const tilt = (i % 2 ? 1 : -1) * 3;
  const long = Math.max(...s.h.map((t) => t.length));
  const size = rtl ? (long > 22 ? 84 : long > 17 ? 96 : 112) : (long > 24 ? 76 : long > 17 ? 86 : 100);
  return `<!doctype html><html dir="${rtl ? 'rtl' : 'ltr'}"><head><meta charset="utf-8"><style>${FONT_CSS}
  *{box-sizing:border-box;margin:0}
  body{width:1080px;height:1920px;overflow:hidden;background:${look.bg};color:${look.fg};font-family:${rtl ? "'Head'" : "'Body'"},sans-serif;font-weight:${rtl ? 400 : 800};position:relative}
  .h{position:absolute;top:110px;${side}:80px;${other}:60px;font-size:${size}px;line-height:1.12;text-align:start}
  .h span{display:block}
  .h .block{display:inline-block;margin-top:14px;padding:4px 30px 14px;background:${look.blockBg};color:${look.blockFg};border:6px solid ${INK};
    box-shadow:${rtl ? -12 : 12}px 12px 0 ${INK};transform:rotate(${rtl ? 1.5 : -1.5}deg)}
  .phone{position:absolute;top:560px;left:50%;width:720px;margin-left:-360px;transform:rotate(${tilt}deg);background:${INK};border:10px solid ${INK};
    padding:14px;border-radius:70px;box-shadow:26px 26px 0 ${look.fg === INK ? INK : '#000'}}
  .screen{border-radius:48px;overflow:hidden;height:1500px;background:#fff}
  .screen img{width:100%;display:block}
  .sticker{position:absolute;top:500px;${other}:40px;z-index:2;font-family:'Body','Head',sans-serif;font-weight:800;font-size:44px;padding:18px 30px;
    background:${look.sticker};color:${INK};border:5px solid ${INK};border-radius:999px;box-shadow:8px 8px 0 ${INK};transform:rotate(${rtl ? -6 : 6}deg);white-space:nowrap}
  </style></head><body>
  <div class="h"><span>${esc(s.h[0])}</span><span class="block">${esc(s.h[1])}</span></div>
  <div class="sticker">${esc(s.st)}</div>
  <div class="phone"><div class="screen"><img src="${shot(s.img)}"></div></div>
  </body></html>`;
}

function featureHtml(c) {
  const rtl = c.rtl, side = rtl ? 'right' : 'left';
  const icon = uri(path.join(ROOT, 'icons/icon-512.png'));
  return `<!doctype html><html dir="${rtl ? 'rtl' : 'ltr'}"><head><meta charset="utf-8"><style>${FONT_CSS}
  *{box-sizing:border-box;margin:0}
  body{width:1024px;height:500px;overflow:hidden;background:#14B8A6;color:${INK};font-family:${rtl ? "'Head'" : "'Body'"},sans-serif;font-weight:${rtl ? 400 : 800};position:relative}
  .t{position:absolute;top:0;bottom:0;${side}:64px;width:540px;font-size:58px;line-height:1.15;display:flex;flex-direction:column;justify-content:center;align-items:flex-start}
  .t .block{display:inline-block;margin-top:14px;padding:2px 24px 10px;background:${INK};color:#D7F7F1;border:5px solid ${INK};
    box-shadow:${rtl ? -10 : 10}px 10px 0 #0D5E57;transform:rotate(${rtl ? 1.5 : -1.5}deg)}
  .icon{position:absolute;top:110px;${rtl ? 'left' : 'right'}:90px;width:270px;height:270px;border:8px solid ${INK};border-radius:72px;
    box-shadow:18px 18px 0 ${INK};transform:rotate(${rtl ? -6 : 6}deg);background:url('${icon}') center/112% no-repeat}
  </style></head><body>
  <div class="t"><span>${esc(c.feature[0])}</span><span class="block">${esc(c.feature[1])}</span></div>
  <div class="icon"></div>
  </body></html>`;
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1080, height: 1920 }, deviceScaleFactor: 1 });
for (const [locale, c] of Object.entries(COPY)) {
  const dir = path.join(OUT, locale, 'images');
  fs.rmSync(path.join(dir, 'phoneScreenshots'), { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, 'phoneScreenshots'), { recursive: true });
  for (const [i, s] of c.shots.entries()) {
    await page.setViewportSize({ width: 1080, height: 1920 });
    await page.setContent(screenshotHtml(c, s, LOOKS[i], i), { waitUntil: 'load' });
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: path.join(dir, 'phoneScreenshots', `${i + 1}.jpg`), type: 'jpeg', quality: 92 });
  }
  await page.setViewportSize({ width: 1024, height: 500 });
  await page.setContent(featureHtml(c), { waitUntil: 'load' });
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: path.join(dir, 'featureGraphic.jpg'), type: 'jpeg', quality: 92 });
}
// The icon: full bleed (Play rounds the corners itself), the clock a little larger than in the maskable icon.
await page.setViewportSize({ width: 512, height: 512 });
await page.setContent(`<body style="margin:0;width:512px;height:512px;background:url('${uri(path.join(ROOT, 'icons/icon-maskable-512.png'))}') center/122% no-repeat">`);
for (const locale of Object.keys(COPY)) await page.screenshot({ path: path.join(OUT, locale, 'images/icon.png') });
await browser.close();
console.log('saved to', OUT);
