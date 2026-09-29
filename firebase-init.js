// Connects the app to Firebase. The app only talks to Firebase through the names exported here.
import { initializeApp, deleteApp } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-app.js";
import {
  getAuth, setPersistence, browserLocalPersistence, onAuthStateChanged, signInWithEmailAndPassword,
  signOut, sendPasswordResetEmail, sendEmailVerification, createUserWithEmailAndPassword, reload
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-auth.js";
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  collection, doc, query, where, onSnapshot, getDoc, getDocs, setDoc, updateDoc, deleteDoc, writeBatch
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-firestore.js";
import { firebaseConfig, DATABASE_ID, OWNER_EMAILS } from "./firebase-config.js";

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
setPersistence(auth, browserLocalPersistence); // stay signed in, including offline

// persistentLocalCache = offline mode: reads and writes go to a copy on the device first
// and sync with the server in the background whenever there's signal.
// Long-polling auto-detect helps on networks/VPNs that block Firestore's normal connection.
const opts = {
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
  experimentalAutoDetectLongPolling: true
};
export const db = (DATABASE_ID && DATABASE_ID !== "(default)")
  ? initializeFirestore(app, opts, DATABASE_ID)
  : initializeFirestore(app, opts);

// Creates a login for someone else without signing you out: it uses a temporary second
// connection to Firebase. The new person sets their own password from the reset email.
export async function createAccount(email) {
  const tmp = initializeApp(firebaseConfig, "invite-" + Date.now());
  try {
    const a = getAuth(tmp);
    const pw = crypto.randomUUID() + "Aa1!";
    await createUserWithEmailAndPassword(a, email, pw);
    await signOut(a);
  } finally {
    await deleteApp(tmp);
  }
}
export const reloadUser = user => reload(user);

export {
  OWNER_EMAILS, onAuthStateChanged, signInWithEmailAndPassword, signOut, sendPasswordResetEmail, sendEmailVerification,
  collection, doc, query, where, onSnapshot, getDoc, getDocs, setDoc, updateDoc, deleteDoc, writeBatch
};
