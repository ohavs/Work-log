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

// ---- durable storage ----
// Capacitor Preferences, which on Android is SharedPreferences: a real file
// in the app's private data directory. That matters because the WebView's
// localStorage — where everything lived until now — is treated by Android as
// cache. It can be evicted when the device runs low on space, and "clear
// cache" in system settings takes it with it. Neither touches this.
//
// Returns null on the web, and also if the plugin somehow isn't there, so the
// caller keeps the localStorage driver rather than starting with no storage
// at all.
export function nativeStorageDriver() {
  if (!isNative()) return null;
  const p = plugin('Preferences');
  if (!p) return null;
  return {
    name: 'native',
    async get(key) {
      const res = await p.get({ key });
      // The plugin reports a missing key as value:null; keep that distinct
      // from the empty string, which is a value someone deliberately stored.
      return res && res.value != null ? res.value : null;
    },
    async set(key, value) { await p.set({ key, value }); },
    async remove(key) { await p.remove({ key }); },
  };
}

// ---- in-app updates ----
// Downloading through the native Filesystem plugin rather than fetch() is not
// an optimisation: GitHub redirects a release asset to a storage host that
// sends no CORS headers, so a fetch from the WebView's origin is refused
// outright. The native side has no such rule. It also keeps a 6MB binary off
// the JS bridge entirely, and gives real progress events.
export async function downloadFile({ url, filename, onProgress }) {
  const fs = plugin('Filesystem');
  if (!fs) throw new Error('הורדה אינה זמינה במכשיר הזה');
  let listener = null;
  if (onProgress && fs.addListener) {
    try {
      listener = await fs.addListener('progress', (e) => {
        if (e && e.contentLength) onProgress(e.bytes / e.contentLength);
      });
    } catch { /* progress is a nicety; the download still works without it */ }
  }
  try {
    const res = await fs.downloadFile({
      url, path: filename, directory: 'CACHE', progress: !!onProgress, recursive: true,
    });
    return res && res.path ? res.path : null;
  } finally {
    if (listener && listener.remove) { try { await listener.remove(); } catch {} }
  }
}

// Android 8 and up gate installing packages behind a per-app system setting.
// Asking first turns "nothing happened" into a screen the user can act on.
export async function canInstallApk() {
  const p = plugin('ApkInstaller');
  if (!p) return false;
  try { const r = await p.canInstall(); return !!(r && r.granted); }
  catch { return false; }
}
export async function openInstallSettings() {
  const p = plugin('ApkInstaller');
  if (!p) return false;
  try { await p.openInstallSettings(); return true; } catch { return false; }
}
export async function installApk(path) {
  const p = plugin('ApkInstaller');
  if (!p) throw new Error('התקנה אינה זמינה במכשיר הזה');
  await p.install({ path });
  return true;
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

// ---- scheduled reminders (native) ----
// Android wakes the app at a time agreed in advance, so these arrive with the
// app closed and the phone offline — no tab open, no server, no push.
export async function notificationPermission() {
  if (isNative()) {
    const ln = plugin('LocalNotifications');
    if (!ln) return 'unsupported';
    try {
      let s = await ln.checkPermissions();
      if (!s || s.display === 'prompt' || s.display === 'prompt-with-rationale') s = await ln.requestPermissions();
      return s && s.display === 'granted' ? 'granted' : (s && s.display === 'denied' ? 'denied' : 'default');
    } catch { return 'default'; }
  }
  if (!('Notification' in window)) return 'unsupported';
  let perm = Notification.permission;
  if (perm === 'default') { try { perm = await Notification.requestPermission(); } catch {} }
  return perm;
}

// Replaces the whole pending schedule with `items`.
//
// Everything pending is cancelled first rather than diffed. The app is the
// only thing scheduling notifications here, so "what's pending" and "what the
// app wants" should be the same set — and rebuilding is one call against a
// list we already have, where diffing would be a second source of truth about
// what's on the device, able to drift from the first.
export async function syncScheduledNotifications(items) {
  if (!isNative()) return { scheduled: 0, cancelled: 0, reason: 'web' };
  const ln = plugin('LocalNotifications');
  if (!ln) return { scheduled: 0, cancelled: 0, reason: 'unsupported' };

  let cancelled = 0;
  try {
    const pending = await ln.getPending();
    const list = (pending && pending.notifications) || [];
    if (list.length) {
      await ln.cancel({ notifications: list.map((n) => ({ id: n.id })) });
      cancelled = list.length;
    }
  } catch (e) { console.warn('could not read pending notifications:', e); }

  if (!items.length) return { scheduled: 0, cancelled };
  try {
    await ln.schedule({
      notifications: items.map((n) => ({
        id: n.id,
        title: n.title,
        body: n.body,
        smallIcon: 'ic_stat_icon',
        // allowWhileIdle gets the alarm through Doze, which is exactly the
        // state a phone is in at the times these fire.
        schedule: { at: new Date(n.at), allowWhileIdle: true },
      })),
    });
    return { scheduled: items.length, cancelled };
  } catch (e) {
    console.warn('could not schedule notifications:', e);
    return { scheduled: 0, cancelled, error: String((e && e.message) || e) };
  }
}

export async function cancelAllScheduled() {
  return syncScheduledNotifications([]);
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

// ---- launcher shortcuts ----
// A long-press on the launcher icon starts the app with a worklog:// URI.
// Two ways in, because they're genuinely different situations: the app was
// launched by the shortcut (getLaunchUrl), or it was already running and got
// the intent handed to it (appUrlOpen).
export async function launchUrl() {
  if (!isNative()) return '';
  const app = plugin('App');
  if (!app || !app.getLaunchUrl) return '';
  try { const r = await app.getLaunchUrl(); return (r && r.url) || ''; }
  catch { return ''; }
}
export function onLaunchUrl(fn) {
  if (!isNative()) return false;
  const app = plugin('App');
  if (!app || !app.addListener) return false;
  app.addListener('appUrlOpen', (e) => { if (e && e.url) fn(e.url); });
  return true;
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

// Android's hardware/gesture back button, which the shell delivers as its own
// event rather than as a history navigation. The handler returns false when
// nothing is left to close, and the app exits — which is what a back press at
// the root of an app should do. Returns false on the web so the caller knows
// to fall back to history-based handling.
export function onBackButton(handler) {
  if (!isNative()) return false;
  const app = plugin('App');
  if (!app || !app.addListener) return false;
  app.addListener('backButton', () => {
    try { if (!handler()) app.exitApp(); }
    catch (e) { console.warn('back handler:', e); }
  });
  return true;
}

// ---- authentication ----
// The browser's redirect sign-in can't work inside the shell: the WebView's
// origin is localhost, not the site's domain, so Firebase won't accept the
// redirect back. Android instead signs in through Google Play Services and
// hands back an ID token, which the caller exchanges for an ordinary web-SDK
// session — that keeps every Firestore call in store.js unchanged.
//
// Two flows, tried in order. The plugin defaults to Android's Credential
// Manager, which is the modern one-tap path but refuses in a number of
// ordinary device states (no account added yet, a previously dismissed
// prompt, an older Play Services). The legacy account picker always shows a
// chooser and is far less particular, so it's the fallback rather than the
// default — when Credential Manager works it's the better experience.
//
// skipNativeAuth:true means the plugin hands back the Google ID token
// without signing into the native Firebase SDK first. That native step is
// pure overhead here — the session that matters is the web SDK's, which the
// caller creates from this token — and it's a step that can fail on its own,
// taking a sign-in down that had already succeeded.
//
// Returns null on the web, or when the native side isn't configured yet
// (google-services.json missing), so the caller can fall back or explain.
export async function nativeGoogleSignIn() {
  if (!isNative()) return null;
  const fa = plugin('FirebaseAuthentication');
  if (!fa) return null;

  const attempt = async (useCredentialManager) => {
    const res = await fa.signInWithGoogle({ skipNativeAuth: true, useCredentialManager });
    const idToken = res && res.credential && res.credential.idToken;
    if (!idToken) throw new Error('sign-in returned no ID token');
    return idToken;
  };

  try {
    return await attempt(true);
  } catch (first) {
    console.warn('Credential Manager sign-in failed, trying the account picker:', first);
    try {
      return await attempt(false);
    } catch (second) {
      // Report the fallback's error — it's the one from the flow that shows
      // a UI, so it describes what the user actually saw.
      second.firstAttempt = String((first && first.message) || first);
      throw second;
    }
  }
}

export async function nativeSignOut() {
  if (!isNative()) return false;
  const fa = plugin('FirebaseAuthentication');
  if (!fa) return false;
  try { await fa.signOut(); return true; } catch { return false; }
}

// ---- native shell startup ----
// Called once the first render is on screen. The splash is configured not to
// auto-hide (launchAutoHide:false) so it stays up until there's something
// real behind it — otherwise the app flashes an empty screen while the
// entries load. Everything here is a no-op on the web.
export async function initNativeShell({ dark }) {
  if (!isNative()) return;
  document.documentElement.classList.add('native');
  try {
    const sb = plugin('StatusBar');
    if (sb) {
      // Style is the CONTENT colour, so a light app bar needs dark icons.
      await sb.setStyle({ style: dark ? 'DARK' : 'LIGHT' });
      await sb.setBackgroundColor({ color: dark ? '#0f1a1d' : '#F0FDFA' });
    }
  } catch (e) { console.warn('status bar:', e); }
  try {
    const splash = plugin('SplashScreen');
    if (splash) await splash.hide();
  } catch (e) { console.warn('splash hide:', e); }
}

// Keeps the system bars in step with the in-app theme toggle.
export async function setStatusBarTheme(dark) {
  if (!isNative()) return;
  try {
    const sb = plugin('StatusBar');
    if (!sb) return;
    await sb.setStyle({ style: dark ? 'DARK' : 'LIGHT' });
    await sb.setBackgroundColor({ color: dark ? '#0f1a1d' : '#F0FDFA' });
  } catch {}
}
