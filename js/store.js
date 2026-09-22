// Data layer: device storage by default (see storage.js), Firebase (Firestore
// + Google auth) when configured.
import { firebaseConfig, firebaseEnabled } from './config.js';
import { storage } from './storage.js';
import { uid, isWork } from './util.js';

// Hard safety cap: a runaway bug (or any other malfunction) must never be
// able to flood a single day with duplicate shifts again. No legitimate
// workflow needs a 3rd work shift on the same date — enforced centrally
// here so every entry-creation path (manual entry, clock-out, auto-close)
// is covered without relying on each call site to remember to check.
const MAX_WORK_ENTRIES_PER_DAY = 2;

const LS_ENTRIES = 'wl_entries';
const LS_SETTINGS = 'wl_settings';
const LS_NOTES = 'wl_notes';
const LS_CATS = 'wl_notecats';
const LS_TOMB = 'wl_tombstones';
const LS_PUSH = 'wl_pushsubs';
const LS_SETTINGS_TS = 'wl_settings_ts';
const LS_USER = 'wl_user';
const TOMB_TTL = 90 * 86400000; // keep delete markers 90 days

// --- conflict-free merge helpers (exported for tests) ---
// Union two collections by id; for a shared id keep the newer `updated`.
// Then drop any id whose tombstone is newer than its last edit (a real delete).
export function mergeCollection(local, remote, tomb = {}) {
  const byId = new Map();
  (Array.isArray(remote) ? remote : []).forEach((x) => { if (x && x.id != null) byId.set(x.id, x); });
  (Array.isArray(local) ? local : []).forEach((x) => {
    if (!x || x.id == null) return;
    const r = byId.get(x.id);
    if (!r || (x.updated || 0) >= (r.updated || 0)) byId.set(x.id, x);
  });
  const out = [];
  for (const x of byId.values()) {
    const del = tomb[x.id] || 0;
    if (del && del >= (x.updated || 0)) continue; // deleted after its last edit → stays deleted
    out.push(x);
  }
  return out;
}
// Merge two tombstone maps (newest timestamp per id), pruning expired markers.
export function mergeTombstones(a = {}, b = {}) {
  const out = {};
  const cutoff = Date.now() - TOMB_TTL;
  for (const src of [a, b]) for (const k in src) { const t = Math.max(out[k] || 0, src[k] || 0); if (t >= cutoff) out[k] = t; }
  return out;
}

export const DEFAULT_SETTINGS = {
  name: '',
  rate: 0,
  currency: '₪',
  goalHours: 0,       // יעד שעות חודשי
  goalWeekHours: 0,   // יעד שעות שבועי
  theme: 'light',
  palette: 'teal',
  jobs: [], // [{ id, name, rate }]
  reminder: false,     // תזכורת יומית להזין שעות
  reminderTime: '18:00',
  noteLayout: 'detailed', // 'detailed' | 'compact'
  entryLayout: 'detailed', // 'detailed' | 'compact' — רישומים: כרטיסים מלאים או רשת אריחים
  activeShift: null,   // { start, jobId } while clocked in — synced so the cron can watch for a forgotten clock-out
  shiftRemindHours: 9, // שכחתי-לצאת: אחרי כמה שעות פתוחות לשלוח תזכורת
  shiftMaxHours: 12,   // שכחתי-לצאת: אחרי כמה שעות לסגור אוטומטית (ולהגביל את המשמרת)
  offDays: [],         // ימים בשבוע (0=ראשון..6=שבת) בהם לא נשלחת תזכורת יומית
};

class Store {
  constructor() {
    this.entries = [];
    this.notes = [];              // [{ id, title, category, body, fields[], checklist[], tags[], pinned, created, updated }]
    this.noteCats = [];           // [{ id, name, color }]
    this.pushSubs = [];           // web-push subscriptions, one per device (merged by endpoint)
    this.tombstones = { e: {}, n: {}, c: {} }; // deleted-id → timestamp, per collection
    this._dirty = false;          // local changes not yet confirmed on the server
    this._settingsTs = 0;         // last local settings change (for last-write-wins)
    this.settings = { ...DEFAULT_SETTINGS };
    this.mode = 'local';          // 'local' | 'cloud'
    this.user = null;             // { uid, name } when signed in
    this._listeners = new Set();
    this._fb = null;              // firebase handles
    this._unsub = null;           // firestore snapshot unsubscribe
    this._saveTimer = null;
    this._writeChain = Promise.resolve(); // serialises local writes; see _saveLocal
  }

  onChange(fn) { this._listeners.add(fn); return () => this._listeners.delete(fn); }
  _emit() { this._listeners.forEach((fn) => fn()); }

  // ---- lifecycle ----
  async init() {
    await this._loadLocal();
    this._emit();
    // When the network returns, flush anything still pending to the cloud.
    if (typeof window !== 'undefined') {
      window.addEventListener('online', () => { this._flush(); this._emit(); });
      window.addEventListener('offline', () => this._emit());
    }
    if (firebaseEnabled) {
      try { await this._initFirebase(); } catch (e) { console.warn('Firebase init failed, staying local:', e); }
    }
    return this;
  }

  get cloudAvailable() { return firebaseEnabled; }
  get isCloud() { return this.mode === 'cloud'; }
  get online() { return typeof navigator === 'undefined' ? true : navigator.onLine !== false; }
  // 'local' (no account) | 'offline' | 'pending' | 'synced'
  get syncState() {
    if (this.mode !== 'cloud') return 'local';
    if (!this.online) return 'offline';
    return this._dirty ? 'pending' : 'synced';
  }
  // Best-effort push of pending local changes (called on reconnect).
  _flush() { if (this._docRef && this._dirty) this._pushCloud().then(() => this._emit()).catch(() => {}); }

  // ---- local storage ----
  async _loadLocal() {
    const [e, s, n, c, t, ps, ts, u] = await Promise.all([
      storage.getJSON(LS_ENTRIES, []),
      storage.getJSON(LS_SETTINGS, null),
      storage.getJSON(LS_NOTES, []),
      storage.getJSON(LS_CATS, []),
      storage.getJSON(LS_TOMB, null),
      storage.getJSON(LS_PUSH, []),
      storage.get(LS_SETTINGS_TS),
      // Optimistically restore the signed-in account so the avatar paints
      // immediately instead of flashing the signed-out state until Firebase
      // auth finishes restoring asynchronously.
      storage.getJSON(LS_USER, null),
    ]);
    if (Array.isArray(e)) this.entries = e;
    if (s) this.settings = { ...DEFAULT_SETTINGS, ...s };
    if (Array.isArray(n)) this.notes = n;
    if (Array.isArray(c)) this.noteCats = c;
    if (t && typeof t === 'object') this.tombstones = { e: t.e || {}, n: t.n || {}, c: t.c || {} };
    if (Array.isArray(ps)) this.pushSubs = ps;
    this._settingsTs = Number(ts) || 0;
    if (u && u.uid) this.user = u;
  }

  // Writes are chained rather than fired in parallel so two rapid mutations
  // can't land out of order. Each save writes the whole current state, so
  // whichever lands last is by definition the newest — and a queued save
  // serialises at the moment it runs, not when it was queued.
  _saveLocal() {
    this._writeChain = this._writeChain
      .then(() => Promise.all([
        storage.setJSON(LS_ENTRIES, this.entries),
        storage.setJSON(LS_SETTINGS, this.settings),
        storage.setJSON(LS_NOTES, this.notes),
        storage.setJSON(LS_CATS, this.noteCats),
        storage.setJSON(LS_TOMB, this.tombstones),
        storage.setJSON(LS_PUSH, this.pushSubs),
        storage.set(LS_SETTINGS_TS, String(this._settingsTs || 0)),
      ]))
      .catch((err) => { console.warn('local save failed:', err); });
    return this._writeChain;
  }

  // Await every queued write — used before the app is backgrounded or closed
  // so a mutation made a moment earlier is definitely on disk.
  flush() { return this._writeChain; }

  // ---- firebase ----
  async _initFirebase() {
    // Bundled locally (js/vendor/firebase.js) rather than pulled from
    // gstatic at runtime. Sync needs the network anyway, but loading the SDK
    // itself over the network doesn't help: it delays startup on a slow
    // connection, and the Android build runs from a localhost origin where
    // fetching third-party scripts is one more thing that can fail. The
    // bundle is tree-shaken to just the calls below — see
    // scripts/firebase-bundle-entry.js for how it's regenerated.
    const { appMod, authMod, fsMod } = await import('./vendor/firebase.js');
    const app = appMod.initializeApp(firebaseConfig);
    const auth = authMod.getAuth(app);
    const db = fsMod.getFirestore(app);
    this._fb = { auth, db, authMod, fsMod };

    // Complete any redirect-based sign-in started on a previous page load.
    authMod.getRedirectResult(auth).catch((e) => console.warn('redirect sign-in:', e));

    authMod.onAuthStateChanged(auth, (user) => {
      if (user) {
        this.user = { uid: user.uid, name: user.displayName || user.email || '', email: user.email || '', photo: user.photoURL || '' };
        storage.setJSON(LS_USER, this.user);
        this._attachCloud();
      } else {
        this.user = null;
        this.mode = 'local';
        storage.remove(LS_USER);
        if (this._unsub) { this._unsub(); this._unsub = null; }
      }
      this._emit();
    });
  }

  _attachCloud() {
    const { db, fsMod } = this._fb;
    const ref = fsMod.doc(db, 'users', this.user.uid, 'data', 'main');
    this._docRef = ref;
    if (this._unsub) this._unsub();
    this._unsub = fsMod.onSnapshot(ref, (snap) => {
      this.mode = 'cloud';
      if (!snap.exists()) { this._pushCloud(); return; } // first login → seed cloud from local
      const d = snap.data();
      // MERGE remote into local — never blindly overwrite, so a shift saved
      // locally before the cloud finished attaching is never lost.
      const rt = d.tombstones || {};
      this.tombstones = {
        e: mergeTombstones(this.tombstones.e, rt.e),
        n: mergeTombstones(this.tombstones.n, rt.n),
        c: mergeTombstones(this.tombstones.c, rt.c),
      };
      this.entries = mergeCollection(this.entries, d.entries, this.tombstones.e);
      this.notes = mergeCollection(this.notes, d.notes, this.tombstones.n);
      this.noteCats = mergeCollection(this.noteCats, d.noteCats, this.tombstones.c);
      // push subscriptions: union across devices by endpoint
      { const m = new Map(); [...(Array.isArray(d.pushSubs) ? d.pushSubs : []), ...this.pushSubs].forEach((s) => { if (s && s.endpoint) m.set(s.endpoint, s); }); this.pushSubs = [...m.values()]; }
      // settings: last-write-wins by timestamp
      const rts = Number(d.settingsTs) || 0;
      if (rts > (this._settingsTs || 0)) { this.settings = { ...DEFAULT_SETTINGS, ...(d.settings || {}) }; this._settingsTs = rts; }
      this._saveLocal(); // keep offline mirror of the merged state
      this._emit();
      // Push the reconciled state up if we hold anything the server doesn't —
      // covers offline edits whose in-memory "dirty" flag was lost on reload.
      if (this._dirty || this._hasUnpushed(d)) this._pushCloud().catch(() => {});
    }, (err) => console.warn('Firestore listen error:', err));
  }

  // True when local holds an entry/note/cat/setting the server snapshot lacks
  // or that is newer locally, or a delete the server hasn't applied yet.
  _hasUnpushed(d) {
    const newer = (local, remote) => {
      const rmap = new Map((Array.isArray(remote) ? remote : []).map((x) => [x.id, x.updated || 0]));
      return (Array.isArray(local) ? local : []).some((x) => { const ru = rmap.get(x.id); return ru === undefined || (x.updated || 0) > ru; });
    };
    const pendingDelete = (remote, tomb) => { const ids = new Set((Array.isArray(remote) ? remote : []).map((x) => x.id)); return Object.keys(tomb || {}).some((id) => ids.has(id)); };
    if (newer(this.entries, d.entries) || pendingDelete(d.entries, this.tombstones.e)) return true;
    if (newer(this.notes, d.notes) || pendingDelete(d.notes, this.tombstones.n)) return true;
    if (newer(this.noteCats, d.noteCats) || pendingDelete(d.noteCats, this.tombstones.c)) return true;
    if ((this._settingsTs || 0) > (Number(d.settingsTs) || 0)) return true;
    return false;
  }

  async _pushCloud() {
    if (!this._docRef) return;
    const { fsMod } = this._fb;
    this._dirty = false; // optimistic; a mutation during the await re-sets it
    try {
      await fsMod.setDoc(this._docRef, {
        entries: this.entries,
        settings: this.settings,
        notes: this.notes,
        noteCats: this.noteCats,
        tombstones: this.tombstones,
        pushSubs: this.pushSubs,
        settingsTs: this._settingsTs || 0,
        updatedAt: Date.now(),
      });
      this._emit(); // reflect 'synced' in the UI
    } catch (e) {
      this._dirty = true; // push failed — keep trying on the next change/snapshot
      throw e;
    }
  }

  async signIn() {
    if (!this._fb) return;
    const { auth, authMod } = this._fb;
    const provider = new authMod.GoogleAuthProvider();
    // Popups are unreliable inside installed PWAs / some mobile browsers —
    // fall back to a full-page redirect when a popup can't be used.
    const standalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone;
    if (standalone) { await authMod.signInWithRedirect(auth, provider); return; }
    try {
      await authMod.signInWithPopup(auth, provider);
    } catch (e) {
      const code = e && e.code || '';
      if (/popup|operation-not-supported|cancelled-popup|web-storage/.test(code)) {
        await authMod.signInWithRedirect(auth, provider);
      } else { throw e; }
    }
  }

  async signOut() {
    if (!this._fb) return;
    await this._fb.authMod.signOut(this._fb.auth);
  }

  // ---- persistence dispatch ----
  // Every mutation writes to the device immediately and marks state dirty; the
  // cloud push is best-effort and retried on the next change or snapshot.
  _persist() {
    this._dirty = true;
    this._saveLocal();
    if (this.mode === 'cloud') {
      clearTimeout(this._saveTimer);
      this._saveTimer = setTimeout(() => this._pushCloud().catch(console.warn), 300);
    }
  }

  // ---- mutations ----
  // Returns the created entry, or null if it was refused by the daily cap
  // (MAX_WORK_ENTRIES_PER_DAY) — callers must handle the null case.
  addEntry(data) {
    if (isWork(data)) {
      const sameDay = this.entries.filter((e) => e.date === data.date && isWork(e)).length;
      if (sameDay >= MAX_WORK_ENTRIES_PER_DAY) return null;
    }
    const now = Date.now();
    const entry = { id: uid(), created: now, ...data, updated: now };
    this.entries.push(entry);
    this._persist();
    this._emit();
    return entry;
  }

  // Batched multi-add (e.g. "mark N vacation days used at once") — a single
  // persist+emit instead of one per entry. Returns the created entries;
  // any item that would breach the daily work-entry cap is silently skipped
  // (checked against both existing entries and earlier items in this same
  // batch, so the cap can't be bypassed by batching around it).
  addEntries(dataArray) {
    const now = Date.now();
    const created = [];
    dataArray.forEach((data) => {
      if (isWork(data)) {
        const sameDay = this.entries.filter((e) => e.date === data.date && isWork(e)).length
          + created.filter((e) => e.date === data.date && isWork(e)).length;
        if (sameDay >= MAX_WORK_ENTRIES_PER_DAY) return;
      }
      const entry = { id: uid(), created: now, ...data, updated: now };
      this.entries.push(entry);
      created.push(entry);
    });
    if (created.length) { this._persist(); this._emit(); }
    return created;
  }

  updateEntry(id, data) {
    const i = this.entries.findIndex((e) => e.id === id);
    if (i === -1) return;
    this.entries[i] = { ...this.entries[i], ...data, id, updated: Date.now() };
    this._persist();
    this._emit();
  }

  deleteEntry(id) {
    this.entries = this.entries.filter((e) => e.id !== id);
    this.tombstones.e[id] = Date.now();
    this._persist();
    this._emit();
  }

  // Batched multi-delete (e.g. "select several shifts / a whole day and
  // remove them") — a single persist+emit instead of one per id.
  deleteEntries(ids) {
    const set = new Set(ids);
    if (!set.size) return;
    const now = Date.now();
    this.entries = this.entries.filter((e) => !set.has(e.id));
    set.forEach((id) => { this.tombstones.e[id] = now; });
    this._persist();
    this._emit();
  }

  saveSettings(data) {
    this.settings = { ...this.settings, ...data };
    this._settingsTs = Date.now();
    this._persist();
    this._emit();
  }

  // ---- backup file ----
  // Everything the app stores, in one plain-JSON object.
  exportBackup() {
    return {
      app: 'work-log',
      format: 1,
      exportedAt: new Date().toISOString(),
      entries: this.entries,
      settings: this.settings,
      settingsTs: this._settingsTs || 0,
      notes: this.notes,
      noteCats: this.noteCats,
      tombstones: this.tombstones,
    };
  }

  // Restore MERGES rather than replaces, through the exact same conflict-free
  // rules as cloud sync: union by id, newest `updated` wins a shared id, and a
  // delete only sticks when its tombstone is newer than the record's last edit.
  // So importing an old backup can never destroy newer data already on the
  // device — worst case it adds back records that were deleted since, which is
  // what someone restoring a backup is asking for anyway. Settings follow the
  // same last-write-wins timestamp rule the cloud uses.
  importBackup(data) {
    const before = { entries: this.entries.length, notes: this.notes.length, noteCats: this.noteCats.length };
    const rt = data.tombstones || {};
    this.tombstones = {
      e: mergeTombstones(this.tombstones.e, rt.e),
      n: mergeTombstones(this.tombstones.n, rt.n),
      c: mergeTombstones(this.tombstones.c, rt.c),
    };
    this.entries = mergeCollection(this.entries, data.entries, this.tombstones.e);
    this.notes = mergeCollection(this.notes, data.notes, this.tombstones.n);
    this.noteCats = mergeCollection(this.noteCats, data.noteCats, this.tombstones.c);
    const bts = Number(data.settingsTs) || 0;
    if (data.settings && bts > (this._settingsTs || 0)) {
      this.settings = { ...DEFAULT_SETTINGS, ...data.settings };
      this._settingsTs = bts;
    }
    this._persist();
    this._emit();
    return {
      entries: this.entries.length - before.entries,
      notes: this.notes.length - before.notes,
      noteCats: this.noteCats.length - before.noteCats,
    };
  }

  // ---- web-push subscriptions (for background reminders) ----
  addPushSub(sub) {
    if (!sub || !sub.endpoint) return;
    if (!this.pushSubs.some((s) => s.endpoint === sub.endpoint)) { this.pushSubs.push(sub); this._persist(); this._emit(); }
  }
  removePushSub(endpoint) {
    const n = this.pushSubs.length;
    this.pushSubs = this.pushSubs.filter((s) => s.endpoint !== endpoint);
    if (this.pushSubs.length !== n) { this._persist(); this._emit(); }
  }

  // ---- notes ----
  addNote(data) {
    const now = Date.now();
    const note = { id: uid(), title: '', category: '', body: '', fields: [], checklist: [], tags: [], pinned: false, created: now, updated: now, ...data };
    this.notes.unshift(note);
    this._persist();
    this._emit();
    return note;
  }
  updateNote(id, data) {
    const i = this.notes.findIndex((n) => n.id === id);
    if (i === -1) return;
    this.notes[i] = { ...this.notes[i], ...data, id, updated: Date.now() };
    this._persist();
    this._emit();
  }
  deleteNote(id) {
    this.notes = this.notes.filter((n) => n.id !== id);
    this.tombstones.n[id] = Date.now();
    this._persist();
    this._emit();
  }

  // ---- note categories ----
  addNoteCat(data) {
    const now = Date.now();
    const cat = { id: uid(), name: '', color: 'teal', ...data, updated: now };
    this.noteCats.push(cat);
    this._persist();
    this._emit();
    return cat;
  }
  updateNoteCat(id, data) {
    const i = this.noteCats.findIndex((c) => c.id === id);
    if (i === -1) return;
    this.noteCats[i] = { ...this.noteCats[i], ...data, id, updated: Date.now() };
    this._persist();
    this._emit();
  }
  deleteNoteCat(id) {
    const now = Date.now();
    this.noteCats = this.noteCats.filter((c) => c.id !== id);
    this.tombstones.c[id] = now;
    // orphaned notes fall back to uncategorized (mark them edited so the change syncs)
    this.notes = this.notes.map((n) => (n.category === id ? { ...n, category: '', updated: now } : n));
    this._persist();
    this._emit();
  }
}

export const store = new Store();
