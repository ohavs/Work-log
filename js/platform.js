// Platform abstraction — the one place that knows whether we're running as a
// web page or inside the Android shell, and what each capability means there.
//
// Native capabilities are reached through window.Capacitor.Plugins rather
// than by importing plugin packages. That matters: the app has no build step,
// and bare module specifiers like '@capacitor/share' don't resolve in a
// browser or in a Capacitor WebView without a bundler. The Plugins object is
// injected at runtime, so it works with plain ES modules and keeps the web
// build completely free of native dependencies.
//
// Every function here falls back to the existing web behaviour, so adding the
// Android shell changes what these do without changing any caller.

const cap = () => (typeof window !== 'undefined' ? window.Capacitor : null);

export function isNative() {
  const c = cap();
  return !!(c && typeof c.isNativePlatform === 'function' && c.isNativePlatform());
}
export function platformName() {
  const c = cap();
  return (c && c.getPlatform && c.getPlatform()) || 'web';
}
function plugin(name) {
  const c = cap();
  return (c && c.Plugins && c.Plugins[name]) || null;
}

// ---- files ----
function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onerror = () => reject(r.error);
    // result is a data: URL — the payload after the comma is what the native
    // Filesystem plugin wants.
    r.onload = () => resolve(String(r.result).split(',')[1] || '');
    r.readAsDataURL(blob);
  });
}

// Hands the user a file they asked for. On the web that's a download. On
// Android it's written to the app's documents directory and offered through
// the system share sheet — the difference between "it's in Downloads
// somewhere" and "send it to my manager", which is what the file is usually
// for. Falls back to a download if anything about the native path fails.
export async function saveFile({ blob, filename, title }) {
  if (isNative()) {
    const fs = plugin('Filesystem');
    const share = plugin('Share');
    if (fs && share) {
      try {
        const data = await blobToBase64(blob);
        const written = await fs.writeFile({ path: filename, data, directory: 'CACHE', recursive: true });
        await share.share({ title: title || filename, url: written.uri, dialogTitle: title || filename });
        return { method: 'share', uri: written.uri };
      } catch (e) {
        console.warn('native share failed, falling back to download:', e);
      }
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  // Keep the anchor connected briefly rather than removing it in the same
  // tick — the click may happen after an await (when the native path above
  // failed and we fell through), and a disconnected anchor is a documented
  // way to lose a download.
  setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 1000);
  return { method: 'download' };
}

// ---- notifications ----
// One shown by the app itself, right now — not a scheduled reminder. Native
// scheduling (which is what makes reminders work with the app closed) lands
// with the Android build; this keeps the immediate case working everywhere.
export async function notify({ title, body, tag = 'wl' }) {
  if (isNative()) {
    const ln = plugin('LocalNotifications');
    if (ln) {
      try {
        await ln.schedule({
          notifications: [{
            // A stable numeric id per tag so re-notifying replaces rather than
            // stacks, matching how the web build uses tag+renotify.
            id: Math.abs(hashCode(tag)) % 2147483647,
            title, body,
            smallIcon: 'ic_stat_icon',
          }],
        });
        return true;
      } catch (e) { console.warn('native notify failed:', e); }
    }
  }
  if (!('Notification' in window) || Notification.permission !== 'granted') return false;
  const opts = { body, tag, renotify: true, icon: './icons/icon-192.png', badge: './icons/icon-192.png', dir: 'rtl', lang: 'he' };
  try {
    if ('serviceWorker' in navigator && navigator.serviceWorker.ready) {
      const reg = await navigator.serviceWorker.ready;
      await reg.showNotification(title, opts);
      return true;
    }
  } catch (_) { /* fall through to the legacy API */ }
  try { new Notification(title, opts); return true; } catch (_) { return false; }
}

function hashCode(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) { h = ((h << 5) - h + s.charCodeAt(i)) | 0; }
  return h;
}

// ---- haptics ----
// Deliberately silent on the web: the Vibration API is ignored or outright
// removed in most desktop and iOS browsers, and buzzing a laptop isn't the
// intent anyway. Clocking in and out should feel physical on a phone.
export async function haptic(style = 'medium') {
  if (!isNative()) return false;
  const h = plugin('Haptics');
  if (!h) return false;
  try { await h.impact({ style: style.toUpperCase() }); return true; }
  catch { return false; }
}

// ---- lifecycle ----
// Fires when the app stops being visible — the moment to flush pending
// writes. The web has two events for this and neither fires reliably alone,
// so both are used; the native shell has one that actually does.
export function onAppPause(fn) {
  if (isNative()) {
    const app = plugin('App');
    if (app && app.addListener) {
      app.addListener('appStateChange', ({ isActive }) => { if (!isActive) fn(); });
      app.addListener('pause', fn);
      return;
    }
  }
  document.addEventListener('visibilitychange', () => { if (document.hidden) fn(); });
  window.addEventListener('pagehide', fn);
}
