// ============================================================
//  הגדרות Firebase
// ------------------------------------------------------------
//  האפליקציה עובדת מיד גם בלי Firebase — הנתונים נשמרים מקומית
//  במכשיר (localStorage). כדי לסנכרן בין מכשירים ולשמור בענן:
//
//  1. היכנסו ל‑https://console.firebase.google.com וצרו פרויקט.
//  2. הוסיפו אפליקציית Web וקבלו את אובייקט ההגדרות.
//  3. הדביקו אותו כאן למטה במקום ה‑null.
//  4. ב‑Firebase הפעילו: Firestore Database + Authentication (Google).
//
//  לדוגמה:
//  export const firebaseConfig = {
//    apiKey: "AIza...",
//    authDomain: "my-app.firebaseapp.com",
//    projectId: "my-app",
//    storageBucket: "my-app.appspot.com",
//    messagingSenderId: "1234567890",
//    appId: "1:1234:web:abcd"
//  };
// ============================================================

export const firebaseConfig = null;

export const firebaseEnabled = !!(firebaseConfig && firebaseConfig.apiKey);
