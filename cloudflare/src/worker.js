// Cloudflare Worker — reliable per-minute reminder sender for the work-log PWA.
// Reads each user's Firestore doc and sends Web Push (VAPID + aes128gcm) for
// due test / note / daily reminders. Pure Web Crypto, no npm dependencies.
//
// Secrets (Worker → Settings → Variables):
//   SERVICE_ACCOUNT  – the Firebase service-account JSON (whole file)
//   VAPID_PUBLIC     – public VAPID key (base64url)
//   VAPID_PRIVATE    – private VAPID key (base64url)
//   VAPID_SUBJECT    – e.g. mailto:you@example.com
// Trigger: Cron Triggers → "* * * * *" (every minute).

export default {
  async scheduled(event, env, ctx) { ctx.waitUntil(run(env)); },
  // Visiting the Worker URL runs it once too (handy for a manual test).
  async fetch(req, env) {
    const out = await run(env);
    return new Response(JSON.stringify(out, null, 2), { headers: { 'content-type': 'application/json; charset=utf-8' } });
  },
};

const WINDOW_MIN = 90;
const enc = new TextEncoder();

// ---------- base64url ----------
function b64urlToBytes(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/'); s += '==='.slice((s.length + 3) % 4);
  const bin = atob(s), out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function bytesToB64url(buf) {
  const b = new Uint8Array(buf); let s = '';
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// ---------- Firestore value <-> JS ----------
function decodeValue(v) {
  if (!v || typeof v !== 'object') return v;
  if ('nullValue' in v) return null;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('timestampValue' in v) return v.timestampValue;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(decodeValue);
  if ('mapValue' in v) return decodeFields(v.mapValue.fields || {});
  return null;
}
function decodeFields(f) { const o = {}; for (const k in f) o[k] = decodeValue(f[k]); return o; }
function encodeValue(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'string') return { stringValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(encodeValue) } };
  if (typeof v === 'object') return { mapValue: { fields: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, encodeValue(x)])) } };
  return { stringValue: String(v) };
}
function encodeFields(o) { const f = {}; for (const k in o) f[k] = encodeValue(o[k]); return f; }

// ---------- Google service-account access token (RS256 JWT) ----------
async function getAccessToken(sa) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const claim = { iss: sa.client_email, scope: 'https://www.googleapis.com/auth/datastore', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 };
  const input = bytesToB64url(enc.encode(JSON.stringify(header))) + '.' + bytesToB64url(enc.encode(JSON.stringify(claim)));
  const pem = sa.private_key.replace(/-----BEGIN PRIVATE KEY-----/, '').replace(/-----END PRIVATE KEY-----/, '').replace(/\s+/g, '');
  const der = b64urlToBytes(pem.replace(/\+/g, '-').replace(/\//g, '_'));
  const key = await crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, enc.encode(input));
  const jwt = input + '.' + bytesToB64url(sig);
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=' + jwt,
  });
  const j = await res.json();
  if (!j.access_token) throw new Error('token error: ' + JSON.stringify(j));
  return j.access_token;
}

// ---------- Firestore REST ----------
const FS = (pid) => `https://firestore.googleapis.com/v1/projects/${pid}/databases/(default)/documents`;
async function listMainDocs(token, pid) {
  const res = await fetch(`${FS(pid)}:runQuery`, {
    method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
    body: JSON.stringify({ structuredQuery: { from: [{ collectionId: 'data', allDescendants: true }] } }),
  });
  const rows = await res.json();
  const out = [];
  if (Array.isArray(rows)) for (const r of rows) {
    if (r.document && r.document.name && r.document.name.endsWith('/data/main')) {
      const uid = r.document.name.split('/users/')[1].split('/')[0];
      out.push({ uid, data: decodeFields(r.document.fields || {}) });
    }
  }
  return out;
}
async function getNotif(token, pid, uid) {
  const res = await fetch(`${FS(pid)}/users/${uid}/data/notif`, { headers: { authorization: 'Bearer ' + token } });
  if (res.status === 404) return {};
  const j = await res.json();
  return j.fields ? decodeFields(j.fields) : {};
}
async function putNotif(token, pid, uid, obj) {
  await fetch(`${FS(pid)}/users/${uid}/data/notif`, {
    method: 'PATCH', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
    body: JSON.stringify({ fields: encodeFields(obj) }),
  });
}

// ---------- Web Push (RFC 8291 aes128gcm + VAPID) ----------
async function vapidHeader(endpoint, env) {
  const aud = new URL(endpoint).origin;
  const now = Math.floor(Date.now() / 1000);
  const header = bytesToB64url(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const payload = bytesToB64url(enc.encode(JSON.stringify({ aud, exp: now + 12 * 3600, sub: env.VAPID_SUBJECT })));
  const pub = b64urlToBytes(env.VAPID_PUBLIC); // 65 bytes 0x04||x||y
  const jwk = { kty: 'EC', crv: 'P-256', d: env.VAPID_PRIVATE, x: bytesToB64url(pub.slice(1, 33)), y: bytesToB64url(pub.slice(33, 65)), ext: true };
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(header + '.' + payload));
  const jwt = header + '.' + payload + '.' + bytesToB64url(sig);
  return `vapid t=${jwt}, k=${env.VAPID_PUBLIC}`;
}
async function hkdf(ikm, salt, info, bytes) {
  const key = await crypto.subtle.importKey('raw', ikm, { name: 'HKDF' }, false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, bytes * 8));
}
function concat(...arrs) {
  let len = 0; for (const a of arrs) len += a.length;
  const out = new Uint8Array(len); let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
}
async function sendWebPush(sub, payloadObj, env) {
  const uaPublic = b64urlToBytes(sub.keys.p256dh);
  const authSecret = b64urlToBytes(sub.keys.auth);
  const asPair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', asPair.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, asPair.privateKey, 256));
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const keyInfo = concat(enc.encode('WebPush: info\0'), uaPublic, asPublic);
  const ikm = await hkdf(ecdh, authSecret, keyInfo, 32);
  const cek = await hkdf(ikm, salt, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(ikm, salt, enc.encode('Content-Encoding: nonce\0'), 12);
  const plaintext = concat(enc.encode(JSON.stringify(payloadObj)), new Uint8Array([0x02]));
  const aesKey = await crypto.subtle.importKey('raw', cek, { name: 'AES-GCM' }, false, ['encrypt']);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, tagLength: 128 }, aesKey, plaintext));
  const rs = new Uint8Array([0, 0, 0x10, 0]); // record size 4096
  const body = concat(salt, rs, new Uint8Array([asPublic.length]), asPublic, ct);
  const res = await fetch(sub.endpoint, {
    method: 'POST',
    headers: {
      'content-encoding': 'aes128gcm', 'content-type': 'application/octet-stream',
      ttl: '86400', authorization: await vapidHeader(sub.endpoint, env),
    },
    body,
  });
  return res.status;
}
async function sendAll(subs, payload, env) {
  let ok = 0;
  for (const sub of subs) {
    try { const st = await sendWebPush(sub, payload, env); if (st >= 200 && st < 300) ok++; else console.log('push status', st); }
    catch (e) { console.log('push error', String(e)); }
  }
  return ok;
}

// ---------- main ----------
function localParts(tz) {
  const d = new Date(Date.now() + (Number(tz) || 0) * 60000);
  const pad = (n) => String(n).padStart(2, '0');
  return { date: `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`, minutes: d.getUTCHours() * 60 + d.getUTCMinutes(), dow: d.getUTCDay() };
}
async function run(env) {
  const sa = JSON.parse(env.SERVICE_ACCOUNT);
  const pid = sa.project_id;
  const token = await getAccessToken(sa);
  const users = await listMainDocs(token, pid);
  let sent = 0, tests = 0, notes = 0, shifts = 0;

  for (const { uid, data } of users) {
    const s = data.settings || {};
    const subs = Array.isArray(data.pushSubs) ? data.pushSubs.filter((x) => x && x.endpoint && x.keys) : [];
    if (!subs.length) continue;
    const notif = await getNotif(token, pid, uid);
    let changed = false;

    // 1) explicit test
    const testAt = Number(s.pushTestAt) || 0;
    if (testAt && Date.now() >= testAt && notif.testSent !== testAt) {
      const ok = await sendAll(subs, { title: 'בדיקת התראה ✓', body: 'ההתראות עובדות — גם כשהאפליקציה סגורה', tag: 'wl-test-' + testAt }, env);
      if (ok > 0) { notif.testSent = testAt; changed = true; tests++; }
    }

    // 2) forgotten clock-out: an open shift synced from the app (settings.activeShift).
    //    9h → gentle "still counting" reminder; 12h → "auto-closed" notice. Deduped per shift.
    const act = s.activeShift;
    if (act && Number(act.start)) {
      const hrs = (Date.now() - Number(act.start)) / 3600000;
      const remindH = Math.min(23, Math.max(1, Math.round(Number(s.shiftRemindHours) || 9)));   // user-configurable
      let maxH = Math.min(24, Math.max(2, Math.round(Number(s.shiftMaxHours) || 12)));
      if (maxH <= remindH) maxH = Math.min(24, remindH + 1);
      let st = notif.activeShift;
      if (!st || st.start !== act.start) { st = { start: act.start }; notif.activeShift = st; changed = true; } // new shift → reset
      if (hrs >= remindH && !st.remind9) {
        const ok = await sendAll(subs, { title: 'עדיין בעבודה?', body: `המשמרת פתוחה כבר מעל ${remindH} שעות — לא שכחת להחתים יציאה?`, tag: 'wl-shift9-' + act.start }, env);
        if (ok > 0) { st.remind9 = true; changed = true; shifts++; }
      }
      if (hrs >= maxH && !st.close12) {
        const ok = await sendAll(subs, { title: 'המשמרת נסגרה אוטומטית', body: `עברו ${maxH} שעות — סגרנו את המשמרת. פתח את האפליקציה לבדיקה ותיקון`, tag: 'wl-shift12-' + act.start }, env);
        if (ok > 0) { st.close12 = true; changed = true; shifts++; }
      }
    } else if (notif.activeShift) { delete notif.activeShift; changed = true; } // shift ended → clear dedup

    // 3) per-note reminders
    const noteState = notif.noteReminders || {};
    for (const nt of (Array.isArray(data.notes) ? data.notes : [])) {
      const at = Number(nt && nt.remindAt) || 0;
      if (!at || Date.now() < at || noteState[nt.id] === at) continue;
      const title = (nt.title || '').trim() || 'תזכורת';
      const body = (nt.body || '').trim() || 'יש לך תזכורת בפנקס';
      const ok = await sendAll(subs, { title, body, tag: 'wl-note-' + nt.id + '-' + at }, env);
      if (ok > 0) { noteState[nt.id] = at; notif.noteReminders = noteState; changed = true; notes++; }
    }

    // 4) daily reminder
    if (s.reminder) {
      const [rh, rm] = String(s.reminderTime || '18:00').split(':').map(Number);
      const target = (rh || 0) * 60 + (rm || 0);
      const { date, minutes, dow } = localParts(s.tz);
      const logged = (Array.isArray(data.entries) ? data.entries : []).some((e) => e && e.date === date);
      const clockedIn = act && Number(act.start); // an open shift = already clocked in; the daily nag is only to remind clocking IN
      const offDay = Array.isArray(s.offDays) && s.offDays.includes(dow); // user marked this weekday as a non-work day
      if (minutes >= target && minutes < target + WINDOW_MIN && !logged && !clockedIn && !offDay && notif.lastSent !== date) {
        const ok = await sendAll(subs, { title: 'שעון עבודה', body: 'עוד לא רשמת שעות היום — הקש כדי להזין', tag: 'wl-daily-' + date }, env);
        if (ok > 0) { notif.lastSent = date; changed = true; sent++; }
      }
    }

    if (changed) await putNotif(token, pid, uid, notif);
  }
  const summary = { users: users.length, dailySent: sent, tests, noteReminders: notes, shiftAlerts: shifts };
  console.log('reminders', JSON.stringify(summary));
  return summary;
}
