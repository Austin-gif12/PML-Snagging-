// Sign-in with WorkOS AuthKit. AuthKit shows the sign-in page (email + password, codes, Google etc.,
// whatever is switched on in the WorkOS dashboard). Afterwards the PML Snagging API checks the WorkOS
// login and gives the app its own session (see api/src/app.js → /session).
import { signInWithSession } from "./data.js";
import { WORKOS_CLIENT_ID, API_URL } from "./config.js";

const AUTHKIT_JS = "https://cdn.jsdelivr.net/npm/@workos-inc/authkit-js@0.20.4/dist/index.mjs";

// Where AuthKit sends people back to, e.g. https://austin-gif12.github.io/pml-snagging/
// This exact address must be in WorkOS dashboard → Redirects.
export const APP_URL = new URL("./", location.href).href;
const params = new URLSearchParams(location.search);
export const returningFromSignIn = params.has("code");
// WorkOS "Sign-in endpoint" (APP_URL + "?sign-in"): AuthKit sends people here, e.g. from an invitation email.
export const startSignInRequested = params.has("sign-in");

let client = null;
// Loaded only when needed, so the app still opens with no signal.
async function authkit() {
  if (!client) {
    const { createClient } = await import(AUTHKIT_JS);
    const clientId = WORKOS_CLIENT_ID || (await (await fetch(API_URL + "/config")).json()).workosClientId;
    if (!clientId) throw new Error("WORKOS_CLIENT_ID isn't set in Vercel");
    // devMode keeps the AuthKit session on this device; production mode needs a paid custom domain.
    client = await createClient(clientId, { redirectUri: APP_URL, devMode: true });
  }
  return client;
}

export async function workosSignIn({ signUp = false, invitationToken } = {}) {
  const ak = await authkit();
  const opts = invitationToken ? { invitationToken } : {};
  await (signUp ? ak.signUp(opts) : ak.signIn(opts));
}

// Finishes a sign-in after AuthKit sends the person back here.
export async function finishSignIn() {
  const ak = await authkit();
  let accessToken;
  try { accessToken = await ak.getAccessToken(); }
  catch { throw Object.assign(new Error("Nearly there — tap Sign in to finish."), { code: "signed-out" }); }
  const s = await exchange(accessToken);
  await signInWithSession(s);
  return s;
}

// Gets a fresh app session from the WorkOS session kept on this device, without showing the sign-in page.
// Returns null if that isn't possible (the person then signs in again).
export async function refreshSession() {
  try {
    const ak = await authkit();
    return await exchange(await ak.getAccessToken());
  } catch { return null; }
}

// Signs out of AuthKit too, so the next person on this device has to sign in with their own login.
export async function workosSignOut() {
  try {
    const ak = await authkit();
    ak.signOut({ returnTo: APP_URL }); // goes to WorkOS and comes back to the app
    return true;
  } catch {
    // No signal or no AuthKit session: forget it on this device instead.
    try { Object.keys(localStorage).filter(k => k.startsWith("workos:")).forEach(k => localStorage.removeItem(k)); } catch {}
    return false;
  }
}

async function exchange(accessToken) {
  let r;
  try {
    r = await fetch(API_URL.replace(/\/+$/, "") + "/session", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ accessToken })
    });
  } catch {
    throw Object.assign(new Error("No signal, or the PML Snagging server can't be reached."), { code: "network" });
  }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.error || "Sign-in error " + r.status), { code: j.code });
  return j;
}
