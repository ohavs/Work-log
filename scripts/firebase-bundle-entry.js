// Entry point used to build js/vendor/firebase.js.
//
// The app has no build step — this is the one exception, run by hand when the
// Firebase SDK needs updating, with the bundled output committed to the repo.
//
//   npm install firebase@10.12.2 esbuild
//   npx esbuild scripts/firebase-bundle-entry.js --bundle --format=esm \
//       --minify --target=es2020 --legal-comments=none \
//       --outfile=js/vendor/firebase.js
//
// Only the calls store.js actually makes are imported, so esbuild can drop
// the rest — that's the difference between ~650KB of CDN bundles and ~320KB.
// signInWithCredential is included ahead of the Android build, where native
// Google Sign-In hands back a credential to exchange for a web-SDK session.
import { initializeApp } from 'firebase/app';
import {
  getAuth, onAuthStateChanged, GoogleAuthProvider,
  signInWithPopup, signInWithRedirect, getRedirectResult,
  signInWithCredential, signOut,
} from 'firebase/auth';
import { getFirestore, doc, onSnapshot, setDoc } from 'firebase/firestore';

export const appMod = { initializeApp };
export const authMod = {
  getAuth, onAuthStateChanged, GoogleAuthProvider,
  signInWithPopup, signInWithRedirect, getRedirectResult,
  signInWithCredential, signOut,
};
export const fsMod = { getFirestore, doc, onSnapshot, setDoc };
