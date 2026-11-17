// Google Play images: phone screenshots (1080x1920 JPEG) and the feature graphic (1024x500 JPEG), into
// store/listing/<locale>/images (fastlane layout).
//
// Style ("panorama", third round, 17.11.2026): one warm, light canvas six screenshots wide, cut into six, so the
// orange and teal ribbons flow from one screenshot into the next when they sit side by side in the store. Each
// screenshot has a dark teal headline with its key words in orange, a short line under it, and a large upright
// phone. Extras only where they say something: the icon on the first, the clock-out reminder as a real
// notification, export file badges on the report, and a light and a dark phone on the last.
// Rejected so far: Currency's brutalist look, and magnified pieces of the screen.
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
const data = (file, type = 'image/png') => `data:${type};base64,` + fs.readFileSync(file).toString('base64');
const shot = (name) => data(path.join(SRC, `${name}.png`));
const ICON = () => data(path.join(OUT, 'iw-IL/images/icon.png'));

const INK = '#0B3B38', ORANGE = '#EA580C', W = 1080, H = 1920, N = 6;

const COPY = {
  'iw-IL': {
    rtl: true,
    app: 'שעון עבודה',
    notif: { app: 'שעון עבודה', when: 'עכשיו', title: 'עדיין בעבודה?', body: 'המשמרת פתוחה כבר מעל 9 שעות. לא שכחת להחתים יציאה?' },
    shots: [
      { img: 'home_active', h: 'כניסה ויציאה\n*בלחיצה אחת*', sub: 'התאריך והשעה נקלטים לבד' },
      { img: 'reports', h: 'השעות והשכר\n*של כל החודש*', sub: 'דוח מוכן לשליחה, ב־PDF או ב־CSV' },
      { img: 'reports_weeks', h: 'יעד שבועי וחודשי\n*תמיד מול העיניים*', sub: 'כמה עשית וכמה נשאר' },
      { img: 'more', h: 'כמה נכנס\n*נטו לבנק*', sub: 'הערכת תלוש, פנסיה ושעות נוספות' },
      { img: 'notes', h: 'כל מה שצריך בעבודה\n*בפנקס אחד*', sub: 'טלפונים, קודים ורשימות משימות' },
      { img: 'home_dark', h: 'בהיר או כהה\n*מסונכרן בענן*', sub: 'ועובד גם בלי אינטרנט' },
    ],
    feature: { h: 'שעות העבודה והשכר שלך\n*בלחיצה אחת*' },
  },
};

const esc = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const headline = (t) => esc(t).replace(/\*([^*]+)\*/g, '<em>$1</em>').replace(/\n/g, '<br>');

// The ribbons: two soft waves across the whole canvas, behind the phones.
function ribbons(width, height) {
  const wave = (y0, amp, len, phase) => {
    let d = `M0 ${y0}`;
    for (let x = 0; x <= width; x += 40) d += ` L${x} ${(y0 + amp * Math.sin((x / len) * 2 * Math.PI + phase)).toFixed(1)}`;
    return d;
  };
  return `<svg class="rib" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
    <defs><linearGradient id="ro" x1="0" x2="1"><stop offset="0" stop-color="#FDBA74"/><stop offset=".5" stop-color="#FB923C"/><stop offset="1" stop-color="#F97316"/></linearGradient>
    <linearGradient id="rt" x1="0" x2="1"><stop offset="0" stop-color="#5EEAD4"/><stop offset="1" stop-color="#14B8A6"/></linearGradient></defs>
    <path d="${wave(height * 0.62, height * 0.09, 2600, 0.6)}" fill="none" stroke="url(#ro)" stroke-width="${height * 0.2}" stroke-linecap="round" opacity=".9"/>
    <path d="${wave(height * 0.8, height * 0.06, 1900, 2.2)}" fill="none" stroke="url(#rt)" stroke-width="${height * 0.07}" stroke-linecap="round" opacity=".8"/>
  </svg>`;
}

const phone = (img, w, extra = '') => {
  const pad = Math.round(w * 0.022), r = Math.round(w * 0.13);
  return `<div class="phone" style="width:${w}px;height:${Math.round(w * 2.16)}px;padding:${pad}px;border-radius:${r}px;${extra}">
    <div class="screen" style="border-radius:${r - pad}px;background-image:url('${shot(img)}');background-size:${w - 2 * pad}px auto"></div>
    <div class="cam" style="top:${pad + w * 0.03}px;width:${w * 0.035}px;height:${w * 0.035}px;margin-left:-${w * 0.0175}px"></div></div>`;
};

function slideExtras(c, i) {
  const n = c.notif;
  if (i === 0) {
    return `<div class="brand"><img src="${ICON()}"><span>${esc(c.app)}</span></div>
      <div class="notif"><div class="nh"><img src="${ICON()}"><b>${esc(n.app)}</b><span>· ${esc(n.when)}</span></div>
      <div class="nt">${esc(n.title)}</div><div class="nb">${esc(n.body)}</div></div>`;
  }
  if (i === 1) return `<div class="file f1">PDF</div><div class="file f2">CSV</div>`;
  return '';
}

function panoramaHtml(c) {
  const slides = c.shots.map((s, i) => {
    const phones = i === N - 1
      ? `<div class="ph" style="left:70px;top:700px;transform:rotate(-8deg)">${phone('home', 600)}</div>
         <div class="ph" style="left:380px;top:600px;transform:rotate(5deg)">${phone(s.img, 630)}</div>`
      : `<div class="ph" style="left:${(W - 720) / 2}px;top:${i === 0 ? 620 : 560}px">${phone(s.img, 720)}</div>`;
    return `<section style="left:${i * W}px">
      <div class="h" style="top:${i === 0 ? 250 : 130}px">${headline(s.h)}</div>
      <div class="sub" style="top:${i === 0 ? 490 : 370}px">${esc(s.sub)}</div>
      ${phones}${slideExtras(c, i)}</section>`;
  }).join('');
  return `<!doctype html><html dir="${c.rtl ? 'rtl' : 'ltr'}"><head><meta charset="utf-8"><style>${FONT_CSS}
  *{box-sizing:border-box;margin:0}
  body{width:${W * N}px;height:${H}px;overflow:hidden;position:relative;font-family:R,sans-serif;font-weight:900;color:${INK};
    background:linear-gradient(180deg,#FFF8F1 0%,#FFF1E3 55%,#FFE8D2 100%)}
  .rib{position:absolute;left:0;top:0}
  section{position:absolute;top:0;width:${W}px;height:${H}px}
  .h{position:absolute;left:70px;right:70px;text-align:center;font-size:100px;line-height:1.08;letter-spacing:-1.5px}
  em{font-style:normal;color:${ORANGE}}
  .sub{position:absolute;left:70px;right:70px;text-align:center;font-size:44px;font-weight:700;color:#3F6461}
  .ph{position:absolute}
  .phone{position:relative;background:#111716;box-shadow:0 0 0 4px #2E3B3A inset, 0 50px 90px -20px #7C2D1255, 0 20px 40px -10px #0006}
  .screen{width:100%;height:100%;background-repeat:no-repeat;background-position:0 0;background-color:#fff}
  .cam{position:absolute;left:50%;border-radius:50%;background:#000;box-shadow:0 0 0 3px #1c2423}
  .brand{position:absolute;top:96px;left:0;right:0;display:flex;justify-content:center;align-items:center;gap:22px;font-size:52px}
  .brand img{width:96px;height:96px;border-radius:26px;box-shadow:0 10px 24px #EA580C44}
  .notif{position:absolute;top:1560px;left:60px;right:60px;background:#FFFFFFF2;border-radius:44px;padding:30px 38px;
    box-shadow:0 30px 70px -10px #0B3B3855;font-weight:700;color:#1F2A29}
  .nh{display:flex;align-items:center;gap:14px;font-size:30px;color:#5B6B69}
  .nh img{width:42px;height:42px;border-radius:12px}.nh b{color:#1F2A29}
  .nt{font-size:42px;font-weight:900;margin-top:14px}.nb{font-size:36px;margin-top:6px;color:#3F4D4C}
  .file{position:absolute;width:190px;height:230px;border-radius:30px;background:#fff;display:flex;align-items:flex-end;justify-content:center;
    padding-bottom:34px;font-size:56px;box-shadow:0 26px 50px -12px #0B3B3866;letter-spacing:1px}
  .file::before{content:'';position:absolute;top:34px;left:36px;right:36px;height:14px;border-radius:7px;background:#E2E8E7;
    box-shadow:0 30px 0 #E2E8E7, 0 60px 0 #E2E8E7}
  .f1{top:1240px;left:30px;color:#DC2626;transform:rotate(-8deg)}
  .f2{top:1420px;left:150px;color:#0D9488;transform:rotate(6deg)}
  </style></head><body>${ribbons(W * N, H)}${slides}</body></html>`;
}

function featureHtml(c) {
  return `<!doctype html><html dir="${c.rtl ? 'rtl' : 'ltr'}"><head><meta charset="utf-8"><style>${FONT_CSS}
  *{box-sizing:border-box;margin:0}
  body{width:1024px;height:500px;overflow:hidden;position:relative;font-family:R,sans-serif;font-weight:900;color:${INK};
    background:linear-gradient(180deg,#FFF8F1,#FFE8D2)}
  .rib{position:absolute;left:0;top:0}
  em{font-style:normal;color:${ORANGE}}
  .t{position:absolute;top:0;bottom:0;${c.rtl ? 'right' : 'left'}:56px;width:640px;display:flex;flex-direction:column;justify-content:center;gap:26px}
  .brand{display:flex;align-items:center;gap:16px;font-size:34px}
  .brand img{width:64px;height:64px;border-radius:18px}
  .h{font-size:52px;line-height:1.14;letter-spacing:-1px}
  .ph{position:absolute;top:56px;${c.rtl ? 'left' : 'right'}:110px;transform:rotate(${c.rtl ? -6 : 6}deg)}
  .phone{position:relative;background:#111716;box-shadow:0 0 0 2px #2E3B3A inset, 0 26px 50px -12px #0007}
  .screen{width:100%;height:100%;background-repeat:no-repeat;background-position:0 0}
  .cam{position:absolute;left:50%;border-radius:50%;background:#000}
    .rib{opacity:.45}
  </style></head><body>${ribbons(1024, 500)}
  <div class="ph">${phone('home_active', 250)}</div>
  <div class="t"><div class="brand"><img src="${ICON()}"><span>${esc(c.app)}</span></div><div class="h">${headline(c.feature.h)}</div></div>
  </body></html>`;
}

const browser = await chromium.launch();
const page = await browser.newPage({ deviceScaleFactor: 1 });
const ready = () => page.evaluate(async () => { await document.fonts.load('900 50px R', 'אבג'); await document.fonts.load('700 50px R', 'אבג'); });
for (const [locale, c] of Object.entries(COPY)) {
  const dir = path.join(OUT, locale, 'images');
  fs.rmSync(path.join(dir, 'phoneScreenshots'), { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, 'phoneScreenshots'), { recursive: true });
  await page.setViewportSize({ width: W * N, height: H });
  await page.setContent(panoramaHtml(c), { waitUntil: 'load' });
  await ready();
  // RTL: the story reads right to left, but the store lays screenshots out left to right, so the panorama
  // is cut in canvas order either way and the first slide is the leftmost.
  for (let i = 0; i < N; i++) {
    await page.screenshot({ path: path.join(dir, 'phoneScreenshots', `${i + 1}.jpg`), type: 'jpeg', quality: 92,
      clip: { x: i * W, y: 0, width: W, height: H } });
  }
  await page.setViewportSize({ width: 1024, height: 500 });
  await page.setContent(featureHtml(c), { waitUntil: 'load' });
  await ready();
  await page.screenshot({ path: path.join(dir, 'featureGraphic.jpg'), type: 'jpeg', quality: 92 });
}
await browser.close();
console.log('saved to', OUT);
