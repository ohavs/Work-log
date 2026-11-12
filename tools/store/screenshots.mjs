// Google Play images: phone screenshots (1080x1920 JPEG) and the feature graphic (1024x500 JPEG), into
// store/listing/<locale>/images (fastlane layout).
//
// Style ("night shift"): a deep teal night with soft orange and teal glows, a centred headline whose key words are
// orange, an upright phone that runs off the bottom edge, and one piece of its screen lifted out and magnified
// beside it, so the point of each screenshot reads even as a thumbnail. Deliberately unlike Currency's listing.
//
// The app screens come from tools/store/capture.mjs (tools/store/out/*.png, 400x860 CSS px at x2.7).
//
//   node tools/store/capture.mjs && node tools/store/screenshots.mjs
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FONT_CSS } from '../icons/options.mjs';
const { chromium } = createRequire(import.meta.url)('playwright');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SRC = path.join(ROOT, 'tools/store/out');
const OUT = path.join(ROOT, 'store/listing');
const shot = (name) => 'data:image/png;base64,' + fs.readFileSync(path.join(SRC, `${name}.png`)).toString('base64');

const ORANGE = '#FB923C';
// Each screenshot: the capture, a headline (orange words in *stars*), a line under it, and the magnified piece
// (x, y, w, h in the capture's CSS px) with where it floats (top in the page, side).
const COPY = {
  'iw-IL': {
    rtl: true,
    shots: [
      { img: 'home_active', h: 'כניסה ויציאה\n*בלחיצה אחת*', sub: 'התאריך והשעה נקלטים לבד', zoom: [60, 150, 280, 112], at: 1240, side: 'end' },
      { img: 'reports', h: 'השעות והשכר\n*של כל החודש*', sub: 'דוח מוכן, עם ייצוא ל־PDF ול־CSV', zoom: [5, 125, 390, 90], at: 1080, side: 'start' },
      { img: 'reports_weeks', h: 'יעד שבועי וחודשי\n*תמיד מול העיניים*', sub: 'כמה עשית וכמה נשאר', zoom: [15, 298, 370, 74], at: 1160, side: 'end' },
      { img: 'more', h: 'כמה נכנס\n*נטו לבנק*', sub: 'הערכת תלוש, פנסיה ושעות נוספות', zoom: [10, 140, 380, 112], at: 1100, side: 'start' },
      { img: 'notes', h: 'כל מה שצריך בעבודה\n*בפנקס אחד*', sub: 'טלפונים, קודים ורשימות משימות', zoom: [10, 222, 380, 192], at: 1200, side: 'end' },
      { img: 'home_dark', h: 'בהיר או כהה\n*מסונכרן בענן*', sub: 'עובד גם בלי אינטרנט', zoom: null },
    ],
    feature: { h: 'שעות העבודה והשכר שלך\n*בלחיצה אחת*' },
  },
};

const esc = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const headline = (t) => esc(t).replace(/\*([^*]+)\*/g, '<em>$1</em>').replace(/\n/g, '<br>');

const BASE = `${FONT_CSS}
  *{box-sizing:border-box;margin:0}
  body{overflow:hidden;position:relative;color:#fff;font-family:R,sans-serif;font-weight:900;
    background:radial-gradient(900px 700px at 85% 8%, #F9731633, transparent 70%),
      radial-gradient(1000px 900px at 0% 70%, #14B8A640, transparent 70%), linear-gradient(170deg,#0E4F4A,#062523 70%)}
  em{font-style:normal;color:${ORANGE}}`;

function screenshotHtml(c, s) {
  const PHONE_W = 700, SCREEN_W = PHONE_W - 2 * 18, k = SCREEN_W / 400; // capture CSS px -> page px inside the phone
  let zoom = '';
  if (s.zoom) {
    const [x, y, w, h] = s.zoom, z = 2.15, side = (s.side === 'start') === c.rtl ? 'right' : 'left';
    // The lifted piece: the same capture, scaled up and clipped to the rectangle.
    zoom = `<div class="zoom" style="${side}:46px;top:${s.at}px;width:${w * z}px;height:${h * z}px;
      background:url('${shot(s.img)}') ${-x * z}px ${-y * z}px/${400 * z}px auto no-repeat"></div>`;
  }
  return `<!doctype html><html dir="${c.rtl ? 'rtl' : 'ltr'}"><head><meta charset="utf-8"><style>${BASE}
  body{width:1080px;height:1920px}
  .h{position:absolute;top:120px;left:60px;right:60px;text-align:center;font-size:104px;line-height:1.1;letter-spacing:-1px}
  .sub{position:absolute;top:385px;left:60px;right:60px;text-align:center;font-size:44px;font-weight:700;color:#CCFBF1;opacity:.9}
  .phone{position:absolute;top:520px;left:50%;margin-left:-${PHONE_W / 2}px;width:${PHONE_W}px;height:1600px;background:#0A0F0F;border-radius:92px;padding:18px;
    box-shadow:0 0 0 3px #2B4B48, 0 40px 120px #000a, 0 0 140px #14B8A630}
  .screen{width:100%;height:100%;border-radius:76px;overflow:hidden;background:url('${shot(s.img)}') 0 0/${SCREEN_W}px auto no-repeat}
  .zoom{position:absolute;z-index:2;border-radius:34px;background-color:#fff;box-shadow:0 30px 70px #000b, 0 0 0 8px #ffffff22;outline:4px solid ${ORANGE};outline-offset:10px}
  </style></head><body>
  <div class="h">${headline(s.h)}</div>
  <div class="sub">${esc(s.sub)}</div>
  <div class="phone"><div class="screen"></div></div>
  ${zoom}
  </body></html>`;
}

function featureHtml(c) {
  return `<!doctype html><html dir="${c.rtl ? 'rtl' : 'ltr'}"><head><meta charset="utf-8"><style>${BASE}
  body{width:1024px;height:500px}
  .h{position:absolute;top:0;bottom:0;${c.rtl ? 'right' : 'left'}:70px;width:560px;display:flex;align-items:center;font-size:64px;line-height:1.15}
  .phone{position:absolute;top:70px;${c.rtl ? 'left' : 'right'}:90px;width:280px;height:600px;background:#0A0F0F;border-radius:40px;padding:9px;
    box-shadow:0 0 0 2px #2B4B48, 0 20px 60px #000a;transform:rotate(${c.rtl ? -8 : 8}deg)}
  .screen{width:100%;height:100%;border-radius:32px;overflow:hidden;background:url('${shot('home_active')}') 0 0/262px auto no-repeat}
  </style></head><body><div class="h"><div>${headline(c.feature.h)}</div></div><div class="phone"><div class="screen"></div></div></body></html>`;
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1080, height: 1920 }, deviceScaleFactor: 1 });
const render = async (html, w, h, file) => {
  await page.setViewportSize({ width: w, height: h });
  await page.setContent(html, { waitUntil: 'load' });
  await page.evaluate(async () => { await document.fonts.load('900 50px R', 'אבג'); await document.fonts.load('700 50px R', 'abc'); });
  await page.screenshot({ path: file, type: 'jpeg', quality: 92 });
};
for (const [locale, c] of Object.entries(COPY)) {
  const dir = path.join(OUT, locale, 'images');
  fs.rmSync(path.join(dir, 'phoneScreenshots'), { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, 'phoneScreenshots'), { recursive: true });
  for (const [i, s] of c.shots.entries()) await render(screenshotHtml(c, s), 1080, 1920, path.join(dir, 'phoneScreenshots', `${i + 1}.jpg`));
  await render(featureHtml(c), 1024, 500, path.join(dir, 'featureGraphic.jpg'));
}
await browser.close();
console.log('saved to', OUT);
