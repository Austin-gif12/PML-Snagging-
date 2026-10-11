// ── 1. The PML Snagging API ──
// The API runs on the same Vercel site as the app (api/index.js), so this is just "/api".
export const API_URL = "/api";

// ── 2. WorkOS AuthKit (sign-in) ──
// Leave empty: the app reads the Client ID from the WORKOS_CLIENT_ID setting in Vercel.
export const WORKOS_CLIENT_ID = "";

// ── 3. Owner (always an admin) ──
// Must match OWNER_EMAILS in Vercel (if set; it defaults to this address).
export const OWNER_EMAILS = ["austin@planningmanager.co.uk"];
