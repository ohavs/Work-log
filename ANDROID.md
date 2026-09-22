# אפליקציית אנדרואיד — הקמה ותחזוקה

האפליקציה היא אותו קוד web בדיוק, עטוף ב-[Capacitor](https://capacitorjs.com).
אין גרסה נפרדת ואין פיצול: `index.html` + `js/` + `css/` משרתים גם את האתר
וגם את ה-APK.

## איך זה בנוי

```
scripts/build-web.mjs   מעתיק את שורש הריפו ל-www/ (מה ש-Capacitor אורז)
capacitor.config.json   מזהה האפליקציה, שם, והגדרות פלאגינים
android/                פרויקט אנדרואיד — מנוהל בגיט, כדי שהבנייה תהיה משוחזרת
.github/workflows/android.yml   בונה APK בכל push ומפרסם אותו כ-Release
```

מזהה החבילה הוא `app.worklog.hours`. **הוא קבוע לנצח** — שינוי שלו הופך את
האפליקציה לאפליקציה אחרת לגמרי מבחינת אנדרואיד.

## מה עובד אחרת באפליקציה מול האתר

| | אתר | אפליקציה |
|---|---|---|
| עלייה ראשונה | דורשת אינטרנט | הקבצים בתוך ה-APK |
| כפתור "חזור" | היסטוריית דפדפן | אירוע מערכת אמיתי |
| ייצוא PDF/CSV | הורדה | תפריט שיתוף של המערכת |
| Service Worker | כן | לא — מיותר, הקבצים כבר מקומיים |
| רטט | לא | כן |

## הקמה חד-פעמית

### 1. מפתח חתימה

בלי חנות Play, **אתה** מחזיק את מפתח החתימה היחיד. שתי עובדות שחייבים להבין:

- אפליקציה חתומה במפתח א׳ **לא יכולה** להתעדכן במקום ע"י אפליקציה חתומה
  במפתח ב׳. צריך להסיר ולהתקין מחדש.
- אובדן המפתח = אי אפשר לעדכן את האפליקציה במקום, לעולם. **גבה אותו.**

יצירה:

```bash
keytool -genkeypair -v \
  -keystore work-log-release.jks \
  -alias work-log \
  -keyalg RSA -keysize 4096 -validity 10000 \
  -storetype PKCS12
```

ואז להמיר ל-base64 כדי לשמור כ-secret:

```bash
base64 -w0 work-log-release.jks > work-log-release.jks.base64
```

### 2. Secrets בריפו

Settings → Secrets and variables → Actions → New repository secret:

| שם | ערך |
|---|---|
| `ANDROID_KEYSTORE_BASE64` | תוכן הקובץ `.jks.base64` |
| `ANDROID_KEYSTORE_PASSWORD` | הסיסמה שבחרת |
| `ANDROID_KEY_ALIAS` | `work-log` |
| `ANDROID_KEY_PASSWORD` | הסיסמה שבחרת |

כל עוד ה-secrets לא קיימים, ה-CI בונה APK חתום ב-debug — מתקין ועובד,
אבל זמני.

### 3. התחברות Google

זה החלק שאי אפשר לדלג עליו: זרימת ההתחברות של הדפדפן **לא עובדת** מתוך
WebView, כי המקור הוא `https://localhost` ולא הדומיין של האתר. צריך
התחברות נייטיבית, ולשם כך Firebase צריך להכיר את האפליקציה.

א. להוציא את טביעת האצבע של המפתח:

```bash
keytool -list -v -keystore work-log-release.jks -alias work-log | grep SHA1
```

ב. [Firebase Console](https://console.firebase.google.com) → הפרויקט
`work-ccd39` → Project settings → Add app → Android:

- Package name: `app.worklog.hours`
- SHA-1: מה שקיבלת בסעיף א׳

ג. להוריד את `google-services.json` ולשים אותו ב-`android/app/`.

> בלי השלב הזה האפליקציה עובדת — אבל מקומית בלבד, בלי סנכרון לענן.
> אפשר לראות את הנתונים בינתיים דרך **הגדרות → שחזור מקובץ**.

## שחרור גרסה

```
push לענף  →  CI בונה  →  Release חדש עם ה-APK
```

`versionCode` נלקח ממספר ההרצה, כי אנדרואיד מסרב להתקין גרסה שהמספר שלה
לא גבוה מהמותקנת. `versionName` נלקח מ-`APP_VERSION` ב-`js/app.js`, כך
שמה שכתוב בהגדרות זה מה שמותקן.

## בנייה מקומית (לא נדרש בדרך כלל)

```bash
npm ci
npm run apk:debug      # android/app/build/outputs/apk/debug/
```

דורש Android SDK ו-Java 21.
