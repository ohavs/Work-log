// In-app updates for the Android build.
//
// The app isn't on the Play Store, so there's no store to notice a new
// version and no in-app update API to call. What there is, is the GitHub
// release the build pipeline already publishes: its tag carries the version,
// and its one asset is the signed APK. Checking for an update is therefore
// reading that release; applying one is downloading the asset and handing it
// to the system installer.
//
// Every APK is signed with the same key, so an update installs over the
// existing app and keeps its data. A build signed with a different key would
// be refused by Android rather than replacing anything.

import { downloadFile, installApk, canInstallApk, openInstallSettings } from './platform.js';

export const LATEST_RELEASE_URL = 'https://api.github.com/repos/ohavs/Work-log/releases/latest';

// Versions are a single increasing number everywhere they appear: 'v77' in
// the app, 'android-v77-10' as the release tag, 'work-log-v77.apk' as the
// asset. Reading just that number keeps the comparison honest whichever
// string it came from.
export function versionNumber(s) {
  const m = /v(\d+)/i.exec(String(s || ''));
  return m ? Number(m[1]) : 0;
}

// Turns a GitHub release into the answer to "is there anything newer?".
// Separate from fetching it so the decision can be tested without a network.
export function readRelease(json, currentVersion) {
  const tag = (json && json.tag_name) || '';
  const assets = Array.isArray(json && json.assets) ? json.assets : [];
  const apk = assets.find((a) => a && typeof a.name === 'string' && a.name.toLowerCase().endsWith('.apk'));
  const latest = versionNumber(tag);
  const current = versionNumber(currentVersion);
  // A release with no APK attached is not an update, however new its tag —
  // there would be nothing to install.
  const available = latest > current && !!apk;
  return {
    available,
    latest,
    current,
    version: latest ? `v${latest}` : '',
    name: (json && json.name) || '',
    url: apk ? apk.browser_download_url : '',
    filename: apk ? apk.name : '',
    size: apk ? Number(apk.size) || 0 : 0,
    // Distinguishes "checked, nothing new" from "couldn't tell", so the UI
    // never claims you're up to date when it simply failed to look.
    upToDate: latest > 0 && !available,
    noAsset: latest > current && !apk,
  };
}

export async function checkForUpdate(currentVersion, fetchImpl) {
  const f = fetchImpl || ((...a) => fetch(...a));
  const res = await f(LATEST_RELEASE_URL, {
    headers: { Accept: 'application/vnd.github+json' },
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`GitHub השיב ${res.status}`);
  return readRelease(await res.json(), currentVersion);
}

// Downloads the APK and opens the installer. Resolves once the installer has
// been handed the file — what happens after that is the system's dialog, and
// the app is replaced (and restarted) by it rather than continuing here.
export async function downloadAndInstall(update, { onProgress } = {}) {
  if (!update || !update.url) throw new Error('אין קובץ להורדה');
  // Ask about the install permission BEFORE spending a download on it:
  // without it the installer opens onto a dead end, which looks like the
  // update silently failing.
  if (!(await canInstallApk())) {
    const err = new Error('דרוש אישור להתקנת אפליקציות ממקור זה');
    err.needsPermission = true;
    throw err;
  }
  const path = await downloadFile({
    url: update.url,
    filename: update.filename || 'work-log-update.apk',
    onProgress,
  });
  if (!path) throw new Error('ההורדה הסתיימה בלי קובץ');
  await installApk(path);
  return path;
}

export { canInstallApk, openInstallSettings };

export function fmtSize(bytes) {
  const mb = (Number(bytes) || 0) / (1024 * 1024);
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.round((Number(bytes) || 0) / 1024)} KB`;
}
