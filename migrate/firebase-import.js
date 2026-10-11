// One-off: reads the old snagging data straight out of Firebase, in the browser, using the owner's old
// Firebase email and password. Used by Users & permissions → "Copy straight from Firebase".
// Only loaded when that button is used. If Firebase refuses (e.g. its security rules were changed),
// use migrate/export-firestore.mjs instead.
const FB = "https://www.gstatic.com/firebasejs/10.13.2/";
const firebaseConfig = {
  apiKey: "AIzaSyBrPlPc7O3kh7kTZb84r_W4d-SK6O_PZzY",
  authDomain: "pml-snagigng.firebaseapp.com",
  projectId: "pml-snagigng",
  storageBucket: "pml-snagigng.firebasestorage.app",
  messagingSenderId: "432831509800",
  appId: "1:432831509800:web:a44434bfb440f1906f8c1d"
};

// Firestore timestamps → milliseconds; everything else as plain JSON.
const plain = v => v && typeof v.toMillis === "function" ? v.toMillis()
  : Array.isArray(v) ? v.map(plain)
  : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plain(x)]))
  : v;

// Returns [{path, data}] for users, settings, jobs, drawings (+ image pieces), snags (+ photos).
export async function readFirebase(email, password, onProgress = () => {}) {
  const { initializeApp, deleteApp } = await import(FB + "firebase-app.js");
  const { getAuth, signInWithEmailAndPassword, signOut } = await import(FB + "firebase-auth.js");
  const { getFirestore, collection, getDocs } = await import(FB + "firebase-firestore.js");
  const app = initializeApp(firebaseConfig, "firebase-import-" + Date.now());
  try {
    const auth = getAuth(app);
    try { await signInWithEmailAndPassword(auth, email, password); }
    catch (e) { throw new Error(e.code === "auth/invalid-credential" ? "Wrong Firebase email or password." : "Firebase sign-in failed: " + (e.code || e.message)); }
    const db = getFirestore(app);
    const docs = [];
    const read = async (...path) => {
      let snap;
      try { snap = await getDocs(collection(db, ...path)); }
      catch (e) { throw new Error(`Firebase wouldn't let this login read ${path.join("/")} (${e.code || e.message}).`); }
      for (const d of snap.docs) docs.push({ path: [...path, d.id].join("/"), data: plain(d.data()) });
      onProgress(docs.length);
      return snap.docs;
    };
    await read("users");
    await read("settings");
    for (const j of await read("jobs")) {
      for (const d of await read("jobs", j.id, "drawings")) await read("jobs", j.id, "drawings", d.id, "chunks");
      for (const s of await read("jobs", j.id, "snags")) await read("jobs", j.id, "snags", s.id, "photos");
    }
    await signOut(auth);
    return docs;
  } finally {
    await deleteApp(app).catch(() => {});
  }
}
