// Storage adapter — every persistent read/write in the app goes through here.
//
// The web build is backed by localStorage, exactly as before. The Android
// build swaps in native storage at startup, because a WebView's localStorage
// is not a safe place to keep the only copy of someone's data: Android can
// evict it when the device is low on space, and clearing the app's "cache"
// from system settings can take it with it. Native key/value storage isn't
// subject to either.
//
// The interface is async because the native side genuinely is (it's an IPC
// hop, not a memory read). Making it async now — while localStorage still
// answers instantly underneath — means swapping the driver later touches
// this file only, instead of every call site a second time.

// Last-resort mirror. If localStorage throws (private mode, storage blocked
// by policy, quota) the app still works for the session instead of losing
// writes silently — and reads stay consistent with what was written.
const memory = new Map();

const localDriver = {
  name: 'local',
  async get(key) {
    try {
      const v = localStorage.getItem(key);
      return v === null && memory.has(key) ? memory.get(key) : v;
    } catch { return memory.has(key) ? memory.get(key) : null; }
  },
  async set(key, value) {
    memory.set(key, value);
    try { localStorage.setItem(key, value); } catch {}
  },
  async remove(key) {
    memory.delete(key);
    try { localStorage.removeItem(key); } catch {}
  },
};

let driver = localDriver;

// Called by the native build before store.init(), so the very first read
// already comes from native storage.
export function setStorageDriver(d) { driver = d; }
export function storageDriverName() { return driver.name; }
export { localDriver };

// Moves what's already on the device into a new driver, once.
//
// The first native launch after an update is the only chance to do this: the
// user's data is sitting in the WebView's localStorage, and from here on the
// app reads from native storage, which is empty. Miss it and the app opens
// to a blank slate — the data isn't gone, but nothing would ever look at it
// again.
//
// Only ever copies INTO an empty destination. If native storage already holds
// something, it is by definition the newer copy (localStorage stopped being
// written the moment the driver was swapped), and overwriting it with a
// months-old WebView copy would be the one genuinely destructive outcome
// here. The source is left untouched either way: a copy that costs nothing
// to keep is worth keeping until the new one has proven itself.
export async function migrateStorage({ from, to, keys, flagKey }) {
  const done = await to.get(flagKey);
  if (done) return { migrated: false, reason: 'already done', keys: [] };

  const existing = [];
  for (const k of keys) if ((await to.get(k)) != null) existing.push(k);
  if (existing.length) {
    // Nothing to do, but record it so this doesn't re-check on every launch.
    await to.set(flagKey, String(Date.now()));
    return { migrated: false, reason: 'destination not empty', keys: existing };
  }

  const copied = [];
  for (const k of keys) {
    const v = await from.get(k);
    if (v == null) continue;
    await to.set(k, v);
    copied.push(k);
  }
  await to.set(flagKey, String(Date.now()));
  return { migrated: true, reason: 'copied', keys: copied };
}

export const storage = {
  get: (key) => driver.get(key),
  set: (key, value) => driver.set(key, value),
  remove: (key) => driver.remove(key),

  // JSON helpers — a corrupt or truncated value falls back instead of
  // throwing, so one bad key can never stop the app from starting.
  async getJSON(key, fallback = null) {
    try {
      const raw = await driver.get(key);
      if (raw == null) return fallback;
      const v = JSON.parse(raw);
      return v == null ? fallback : v;
    } catch { return fallback; }
  },
  setJSON(key, value) { return driver.set(key, JSON.stringify(value)); },
};
