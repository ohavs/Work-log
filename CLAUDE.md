# Notes for Claude

## Working with the user
- Reply in Hebrew. Show a screenshot of every visual change before pushing it.
- Don't mention `/clear` in every reply. Only when the conversation is getting long/heavy, say it's a good time
  to `/clear`, and first write what the next session needs into this file and `docs/PLAY_LAUNCH_PLAN.md` (commit + push).
- Do as much as possible yourself (code, CI, store texts and images, privacy pages, uploads through CI).
  The owner only does what needs their accounts: Play Console, Firebase/Google Cloud console, GitHub
  Secrets, their phone, recruiting testers. Write those steps so they can be done from a phone.
- Secrets never go in git: keystores and service-account JSON live in GitHub Secrets; a key generated
  in a session is sent to the owner, not committed. Public ids (Firebase web config) are fine in code.

## Google Play launch (in progress, started 2026-11-12)
- The plan, the decisions and every step: `docs/PLAY_LAUNCH_PLAN.md` (Hebrew). Stage 0 is decided (see the doc). The GitHub APK is frozen at v92: `android.yml` builds only the Play AAB
  (versionCode 1000 + run number, upload key = the existing `ANDROID_KEYSTORE_*` secrets).
- The owner asked: give their steps ONE AT A TIME (one form per message), in Hebrew only, complete in the reply (links, exact text to copy),
  never "see the repo".
- Model: `ohavs/Currency-26` (public, clone read-only to compare), approved for production on 2026-11-12.
  Its `CLAUDE.md`, `docs/PLAY_LAUNCH_PLAN.md`, `.github/workflows/release.yml` and `play-listing.yml` are the
  reference for flavors, the Play upload, fastlane listing and the forms' answers.
- The owner asked: once I have console access (service account, step 4), review everything they filled in App content.
- The public site for privacy/deletion pages is `ohavs/ohavs.github.io` (add it with `add_repo`, access push).

## Releasing a change
Every user-visible change must bump **both** version numbers together, or the app won't update:
- `APP_VERSION` in `js/app.js` (e.g. `'v93'` → `'v94'`) — the Android versionName.
- `CACHE` in `sw.js` (e.g. `'worklog-v93'` → `'worklog-v94'`) — the PWA service worker cache.

Pushing to `claude/hebrew-work-tracker-pwa-m0mv4q` deploys the web app to Firebase Hosting and
builds the signed Play bundle (artifact `work-log-play-bundle`; sent to Play once `PLAY_SERVICE_ACCOUNT_JSON` exists). Changes to `*.md` and `docs/` don't build a bundle, and
are not served by Hosting or packed into the APK.
