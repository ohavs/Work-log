# שולח התראות — Cloudflare Worker

זהו השירות ששולח את ההתראות (תזכורת יומית, תזכורות פנקס, והתראת בדיקה) **גם כשהאפליקציה סגורה לגמרי**.

למה Cloudflare ולא GitHub Actions? ה-cron של GitHub לא אמין — הוא רץ פעם ב-3 שעות במקום כל דקה. ה-Worker של Cloudflare רץ **כל דקה בדיוק**, בחינם, בלי כרטיס אשראי.

הקוד ב-`src/worker.js` הוא עצמאי לחלוטין (Web Crypto בלבד, בלי חבילות npm).

**עדכון:** ה-Worker מחובר ל-Git (Workers Builds) — כל push לענף `claude/hebrew-work-tracker-pwa-m0mv4q` בתיקייה `cloudflare/` נפרס אוטומטית. אין יותר צורך להדביק קוד ידנית בעורך.

---

## התקנה חד-פעמית (5 דקות, בלי כרטיס אשראי)

1. **צור חשבון** ב-<https://dash.cloudflare.com/sign-up> (חינם).
2. בתפריט הצד: **Workers & Pages** → **Create** → **Create Worker** → תן שם `worklog-reminders` → **Deploy**.
3. **Edit code** → מחק את קוד הדוגמה → הדבק את כל התוכן של `cloudflare/src/worker.js` → **Deploy**.
4. **Settings → Variables and Secrets** → הוסף 4 secrets (סוג: *Secret*, לא *Text*):

   | שם | ערך |
   |----|-----|
   | `SERVICE_ACCOUNT` | כל קובץ ה-JSON של חשבון השירות של Firebase (אותו קובץ ששמת ב-GitHub) |
   | `VAPID_PUBLIC` | `BGR9gWrzzQ4QYibp7qpStgjcm5uPRdZ4f4NwiXDdFTi1OxrZb7w03GWmQK6UTAo9PZIev32Fn4StZCD1XNa5W6Y` |
   | `VAPID_PRIVATE` | המפתח הפרטי של VAPID (אותו ערך ששמת ב-GitHub secret `VAPID_PRIVATE_KEY`) |
   | `VAPID_SUBJECT` | `mailto:ohav88@gmail.com` |

   → **Deploy** אחרי ההוספה.
5. **Settings → Triggers → Cron Triggers** → **Add Cron Trigger** → הכנס `* * * * *` → **Add**.

זהו. מרגע זה ההתראות נשלחות אוטומטית כל דקה, בלי שתצטרך לעשות כלום.

---

## בדיקה ידנית

פתח את כתובת ה-Worker בדפדפן (משהו כמו `https://worklog-reminders.<שם-המשתמש>.workers.dev`). זה מריץ את השולח פעם אחת ומחזיר סיכום JSON, למשל:

```json
{ "users": 1, "dailySent": 0, "tests": 1, "noteReminders": 0 }
```

- `users` — כמה משתמשים עם מנוי push פעיל נמצאו.
- `tests` — כמה התראות בדיקה נשלחו הרגע.
- `noteReminders` / `dailySent` — כמה תזכורות פנקס / תזכורות יומיות נשלחו.

כדי לבדוק מקצה לקצה: פתח את האפליקציה, לחץ "שלח התראת בדיקה", ואז טען מחדש את כתובת ה-Worker — אמור להופיע `"tests": 1` ולהגיע התראה למכשיר.

---

## הערות אבטחה

- אף secret לא נשמר ברפו. הם נמצאים רק ב-Cloudflare (ובמקביל ב-GitHub secrets).
- `VAPID_PUBLIC` הוא ציבורי (הוא כבר בקוד הלקוח) — אין בעיה שהוא כאן.
- הגרסה של GitHub Actions (`.github/workflows/reminders.yml`) יכולה להישאר כגיבוי, או אפשר לכבות אותה — Cloudflare מכסה הכול.
