# Notes for Claude

## Working with the user
- Reply in Hebrew. Show a screenshot of every visual change before pushing it.
- At the end of every reply that finishes a task, say whether it is safe to run `/clear` now
  (i.e. everything is committed and pushed, nothing pending). If it is not safe, say what is left.
  Before saying so, write what the next session needs into this file and `docs/PLAY_LAUNCH_PLAN.md`.
- Do as much as possible yourself (code, CI, store texts and images, privacy pages, uploads through CI).
  The owner only does what needs their accounts: Play Console, Firebase/Google Cloud console, GitHub
  Secrets, their phone, recruiting testers. Write those steps so they can be done from a phone.
- Secrets never go in git: keystores and service-account JSON live in GitHub Secrets; a key generated
  in a session is sent to the owner, not committed. Public ids (Firebase web config) are fine in code.

## Google Play launch (in progress, started 2026-11-12)
- The plan, the decisions and every step: `docs/PLAY_LAUNCH_PLAN.md` (Hebrew). Next: stage 0, the owner's decisions.
- Model: `ohavs/Currency-26` (public, clone read-only to compare), approved for production on 2026-11-12.
  Its `CLAUDE.md`, `docs/PLAY_LAUNCH_PLAN.md`, `.github/workflows/release.yml` and `play-listing.yml` are the
  reference for flavors, the Play upload, fastlane listing and the forms' answers.
- The public site for privacy/deletion pages is `ohavs/ohavs.github.io` (add it with `add_repo`, access push).

## Releasing a change
Every user-visible change must bump **both** version numbers together, or the app won't update:
- `APP_VERSION` in `js/app.js` (e.g. `'v92'` → `'v93'`) — the Android in-app updater compares this.
- `CACHE` in `sw.js` (e.g. `'worklog-v92'` → `'worklog-v93'`) — the PWA service worker cache.

Pushing to `claude/hebrew-work-tracker-pwa-m0mv4q` deploys the web app to Firebase Hosting and
builds a new APK release (GitHub Actions). Changes to `*.md` and `docs/` don't build an APK, and
are not served by Hosting or packed into the APK.
