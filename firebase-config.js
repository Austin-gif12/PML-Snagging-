// ── 1. Your Firebase project ──
// Firebase Console → Project settings (gear icon) → General → Your apps → Web app → "SDK setup and configuration".
// Copy the values from the firebaseConfig block shown there into the matching lines below.
export const firebaseConfig = {
  apiKey: "AIzaSyBrPlPc7O3kh7kTZb84r_W4d-SK6O_PZzY",
  authDomain: "pml-snagigng.firebaseapp.com",
  projectId: "pml-snagigng",
  storageBucket: "pml-snagigng.firebasestorage.app",
  messagingSenderId: "432831509800",
  appId: "1:432831509800:web:a44434bfb440f1906f8c1d"
};

// ── 2. Firestore database ID ──
// Shown at the top of the Firestore Database page. Normally "(default)".
// (Your RIA project's database was called "default" without brackets — check this one.)
export const DATABASE_ID = "(default)";

// ── 3. Owner (always an admin) ──
// This email can always sign in as admin, even before any users are set up.
// Must match the list at the top of firestore.rules.
export const OWNER_EMAILS = ["austin@planningmanager.co.uk"];
