// Copies the web app into www/ for Capacitor to bundle into the APK.
//
// The app is served from the repo root (that's what Firebase Hosting deploys),
// but Capacitor needs a directory containing only the web assets — pointing it
// at the root would sweep in .git, android/ and node_modules. So this mirrors
// the root into www/, excluding the same things firebase.json ignores.
//
// Exclusion-based rather than an explicit file list on purpose: a new asset
// added to the app is picked up automatically here and by Firebase Hosting,
// instead of silently missing from the APK until someone remembers a list.
//
//   node scripts/build-web.mjs
import { cp, rm, mkdir, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'www');

// Not part of the shipped web app.
const EXCLUDE = new Set([
  'www', 'android', 'ios', 'node_modules', '.git', '.github', '.claude',
  'scripts', 'cloudflare', 'design-system',
  'firebase.json', 'firestore.rules', 'README.md', 'package.json',
  'package-lock.json', 'capacitor.config.json', '.gitignore',
]);

// The service worker is deliberately left out of the APK: the assets are
// already on the device, so a network-first cache in front of them adds a
// layer that can only get in the way — and the in-app updater replaces what
// it was for. app.js skips registering it on native anyway; not shipping the
// file means a stale one can never be picked up either.
const EXCLUDE_NATIVE = new Set(['sw.js']);

const out = [];
await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });
for (const name of await readdir(ROOT)) {
  if (EXCLUDE.has(name) || EXCLUDE_NATIVE.has(name) || name.startsWith('.')) continue;
  await cp(join(ROOT, name), join(OUT, name), { recursive: true });
  out.push(name);
}

if (!existsSync(join(OUT, 'index.html'))) {
  console.error('build-web: index.html missing from www/ — refusing to produce an empty bundle');
  process.exit(1);
}

// Stamped so a build can be traced back to a commit, and so the in-app
// updater has something to compare against later.
await writeFile(join(OUT, 'build-info.json'), JSON.stringify({
  builtAt: new Date().toISOString(),
  commit: process.env.GITHUB_SHA || '',
  ref: process.env.GITHUB_REF_NAME || '',
}, null, 2));

console.log(`build-web: copied ${out.length} entries into www/ →`, out.join(', '));
