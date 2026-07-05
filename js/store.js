// Data layer: localStorage by default, Firebase (Firestore + Google auth) when configured.
import { firebaseConfig, firebaseEnabled } from './config.js';
import { uid } from './util.js';

const LS_ENTRIES = 'wl_entries';
const LS_SETTINGS = 'wl_settings';
const LS_NOTES = 'wl_notes';
const LS_CATS = 'wl_notecats';
const LS_TOMB = 'wl_tombstones';
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
};

class Store {
  constructor() {
    this.entries = [];
    this.notes = [];              // [{ id, title, category, body, fields[], checklist[], tags[], pinned, created, updated }]
    this.noteCats = [];           // [{ id, name, color }]
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
  }

  onChange(fn) { this._listeners.add(fn); return () => this._listeners.delete(fn); }
  _emit() { this._listeners.forEach((fn) => fn()); }

  // ---- lifecycle ----
  async init() {
    this._loadLocal();
    this._emit();
    if (firebaseEnabled) {
      try { await this._initFirebase(); } catch (e) { console.warn('Firebase init failed, staying local:', e); }
    }
    return this;
  }

  get cloudAvailable() { return firebaseEnabled; }
  get isCloud() { return this.mode === 'cloud'; }

  // ---- local storage ----
  _loadLocal() {
    try {
      const e = JSON.parse(localStorage.getItem(LS_ENTRIES) || '[]');
      if (Array.isArray(e)) this.entries = e;
    } catch {}
    try {
      const s = JSON.parse(localStorage.getItem(LS_SETTINGS) || 'null');
      if (s) this.settings = { ...DEFAULT_SETTINGS, ...s };
    } catch {}
    try {
      const n = JSON.parse(localStorage.getItem(LS_NOTES) || '[]');
      if (Array.isArray(n)) this.notes = n;
    } catch {}
    try {
      const c = JSON.parse(localStorage.getItem(LS_CATS) || '[]');
      if (Array.isArray(c)) this.noteCats = c;
    } catch {}
    try {
      const t = JSON.parse(localStorage.getItem(LS_TOMB) || 'null');
      if (t && typeof t === 'object') this.tombstones = { e: t.e || {}, n: t.n || {}, c: t.c || {} };
    } catch {}
    try {
      const ts = Number(localStorage.getItem('wl_settings_ts')) || 0;
      this._settingsTs = ts;
    } catch {}
  }

  _saveLocal() {
    localStorage.setItem(LS_ENTRIES, JSON.stringify(this.entries));
    localStorage.setItem(LS_SETTINGS, JSON.stringify(this.settings));
    localStorage.setItem(LS_NOTES, JSON.stringify(this.notes));
    localStorage.setItem(LS_CATS, JSON.stringify(this.noteCats));
    localStorage.setItem(LS_TOMB, JSON.stringify(this.tombstones));
    localStorage.setItem('wl_settings_ts', String(this._settingsTs || 0));
  }

  // ---- firebase ----
  async _initFirebase() {
    const [{ initializeApp }, authMod, fsMod] = await Promise.all([
      import('https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js'),
      import('https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js'),
      import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js'),
    ]);
    const app = initializeApp(firebaseConfig);
    const auth = authMod.getAuth(app);
    const db = fsMod.getFirestore(app);
    this._fb = { auth, db, authMod, fsMod };

    // Complete any redirect-based sign-in started on a previous page load.
    authMod.getRedirectResult(auth).catch((e) => console.warn('redirect sign-in:', e));

    authMod.onAuthStateChanged(auth, (user) => {
      if (user) {
        this.user = { uid: user.uid, name: user.displayName || user.email || '', email: user.email || '', photo: user.photoURL || '' };
        this._attachCloud();
      } else {
        this.user = null;
        this.mode = 'local';
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
      // settings: last-write-wins by timestamp
      const rts = Number(d.settingsTs) || 0;
      if (rts > (this._settingsTs || 0)) { this.settings = { ...DEFAULT_SETTINGS, ...(d.settings || {}) }; this._settingsTs = rts; }
      this._saveLocal(); // keep offline mirror of the merged state
      this._emit();
      // If we merged in local-only changes (or deletes), push the reconciled state up.
      if (this._dirty) this._pushCloud();
    }, (err) => console.warn('Firestore listen error:', err));
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
        settingsTs: this._settingsTs || 0,
        updatedAt: Date.now(),
      });
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
  addEntry(data) {
    const now = Date.now();
    const entry = { id: uid(), created: now, ...data, updated: now };
    this.entries.push(entry);
    this._persist();
    this._emit();
    return entry;
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

  saveSettings(data) {
    this.settings = { ...this.settings, ...data };
    this._settingsTs = Date.now();
    this._persist();
    this._emit();
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
