# Notes for Claude

## Working with the user
- Reply in Hebrew.
- At the end of every reply that finishes a task, say whether it is safe to run `/clear` now
  (i.e. everything is committed and pushed, nothing pending). If it is not safe, say what is left.

## Releasing a change
Every user-visible change must bump **both** version numbers together, or the app won't update:
- `APP_VERSION` in `js/app.js` (e.g. `'v92'` → `'v93'`) — the Android in-app updater compares this.
- `CACHE` in `sw.js` (e.g. `'worklog-v92'` → `'worklog-v93'`) — the PWA service worker cache.

Pushing to `claude/hebrew-work-tracker-pwa-m0mv4q` deploys the web app to Firebase Hosting and
builds a new APK release (GitHub Actions).
