// ============================================================
//  הגדרות Firebase
// ------------------------------------------------------------
//  האפליקציה עובדת מיד גם בלי Firebase (שמירה מקומית). כשמחובר
//  פרויקט Firebase — מתאפשרת התחברות עם Google וסנכרון בין מכשירים.
//  הערכים כאן הם מזהים ציבוריים בצד‑הלקוח (לא סוד).
// ============================================================

export const firebaseConfig = {
  apiKey: "AIzaSyB9ixjOMN-oyVPI47bSog8oLW-uThyoGjM",
  // Same-origin as the app (Firebase Hosting) so Google sign-in avoids
  // cross-domain storage issues. Requires the matching redirect URI
  // https://work-ccd39.web.app/__/auth/handler in the OAuth client.
  authDomain: "work-ccd39.web.app",
  projectId: "work-ccd39",
  storageBucket: "work-ccd39.firebasestorage.app",
  messagingSenderId: "116225436709",
  appId: "1:116225436709:web:3e68094d6a8c3a0b87e3cc",
  measurementId: "G-EEG6S7ERH1",
};

export const firebaseEnabled = !!(firebaseConfig && firebaseConfig.apiKey);
