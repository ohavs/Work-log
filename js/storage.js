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
