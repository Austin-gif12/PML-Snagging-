// ── 1. WorkOS AuthKit (sign-in) ──
// WorkOS dashboard → API Keys → Client ID (starts with client_). This one is safe to publish.
// Never put the API key (sk_…) here — it goes only in the API's secrets.
export const WORKOS_CLIENT_ID = "client_YOUR-WORKOS-CLIENT-ID";

// ── 2. The PML Snagging API ──
// The Cloudflare Worker address shown by `npx wrangler deploy` in the api folder,
// e.g. https://pml-snagging-api.yourname.workers.dev
export const API_URL = "https://pml-snagging-api.YOUR-SUBDOMAIN.workers.dev";

// ── 3. Owner (always an admin) ──
// Must match OWNER_EMAILS in api/wrangler.toml.
export const OWNER_EMAILS = ["austin@planningmanager.co.uk"];
