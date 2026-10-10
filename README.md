# PML Snagging

Snagging app with logins, roles, per-job contractors, and a contractor → PML sign-off workflow. It works offline and syncs when signal comes back.

- **Sign-in:** WorkOS AuthKit
- **Database:** PlanetScale Postgres (`pml-snagging`, London)
- **API:** a Cloudflare Worker (`api/`) that sits between the app and the database
- **App:** static files on GitHub Pages

## Roles
| Role | Can do |
|---|---|
| **Admin** | Everything, including **Users & permissions** and deleting jobs. The owner emails in `config.js` / `api/wrangler.toml` are always admin. |
| **Site manager** | Every job: create jobs, upload drawings, add and edit snags, sign off or send back, reports, trades library, main contractor list, and giving contractors access. |
| **Contractor** | Only snags assigned to their company on jobs where their email is listed. Can mark a snag *In progress* or *Completed* (with a note and photos of the fix). Cannot sign off, edit snag details or see anyone else's snags. |

Workflow: **Open → In progress → Awaiting sign-off** (contractor marks completed) → PML either **signs off** (green) or **sends back** with a reason (back to Open).

These permissions are enforced by the API (`api/src/app.js`), not just hidden in the app.

## How it fits together
```
Phone / PC (index.html + data.js)          Cloudflare Worker (api/)            PlanetScale Postgres
  copy of the data on the device   ──►   checks the login, applies    ──►   users, settings, jobs,
  queue of changes to upload       ◄──   the permissions, syncs        ◄──   drawings, drawing_chunks,
                                                                              snags, photos
        │ sign in
        ▼
  WorkOS AuthKit page ──► the API checks the WorkOS login and gives the app a 30-day session
```
- **Sign-in:** the app sends people to the WorkOS AuthKit page. The API checks the WorkOS login (email must be confirmed) and gives the app its own session. Who sees what comes from the app's **Users & permissions** list (the `users` table), not from WorkOS.
- **Offline:** `data.js` keeps everything the person can see on the device and queues their changes. The queue uploads in order when there's signal, and the app checks for other people's changes every 15 seconds. Photos and drawing images are downloaded when opened, then kept on the device.
- **Secrets** (the WorkOS API key and the database password) live only in the Worker's secrets, never in the app or on GitHub.

## Files
| File | What it is |
|---|---|
| `index.html` | The app |
| `data.js` | On-device copy, upload queue and sync with the API |
| `workos-auth.js` | Sign-in with WorkOS AuthKit |
| `config.js` | WorkOS Client ID, API address, owner email |
| `sw.js`, `manifest.webmanifest`, `assets/` | Offline app files, home-screen icon, logos |
| `api/` | The API (Cloudflare Worker). `src/app.js` = permissions and sync, `src/store-postgres.js` = database tables and queries |
| `migrate/export-firestore.mjs` | One-off: copies the old Firebase data out to a file |

## One-time setup

### 1. PlanetScale (database)
The `pml-snagging` Postgres database already exists. Make a login for the API:
```
pscale role create pml-snagging main api --inherited-roles postgres
```
It prints the connection details **once**. Copy the full connection string (`postgresql://…`) somewhere safe for step 3. The API creates its own tables the first time it runs.

### 2. WorkOS (sign-in)
1. https://dashboard.workos.com. **Staging** is fine for testing; use **Production** for real use (it has its own Client ID and API key).
2. **Authentication → Methods**: switch on **Email + Password** (and Magic Auth / Google if wanted). Keep **email verification** on.
3. **Redirects**:
   - **Redirect URI**: `https://austin-gif12.github.io/PML-Snagging-/` (default)
   - **Sign-in endpoint**: `https://austin-gif12.github.io/PML-Snagging-/?sign-in`
   - **Sign-out redirect**: `https://austin-gif12.github.io/PML-Snagging-/`
4. **Authentication → Sessions → CORS / Allowed web origins**: add `https://austin-gif12.github.io`.
5. *(Optional)* **Branding**: PML logo and yellow `#FCBF2A`.
6. **API Keys**: note the **Client ID** (`client_…`) and the **API key** (`sk_…`, secret).

### 3. The API (Cloudflare Worker)
Needs Node.js once (`scoop install nodejs-lts`). In PowerShell:
```
cd C:\Users\AustinLeivers\pml-snagging\api
npm install
npx wrangler login
npx wrangler secret put WORKOS_API_KEY
npx wrangler secret put DATABASE_URL
npx wrangler deploy
```
- `wrangler login` opens Cloudflare in the browser (free account).
- Each `secret put` asks you to paste the value: the `sk_…` key, then the connection string from step 1.
- Before deploying, put the WorkOS Client ID in `api/wrangler.toml` (`WORKOS_CLIENT_ID`).

`deploy` prints the API's address, e.g. `https://pml-snagging-api.yourname.workers.dev`. Open it in a browser: it should say `"ok":true` and `"database":"ok"`.

### 4. The app
In `config.js` set `WORKOS_CLIENT_ID` and `API_URL` (the address from step 3). Then upload `index.html`, `config.js`, `data.js`, `workos-auth.js`, `sw.js`, `manifest.webmanifest` and the `assets` folder to the `PML-Snagging-` GitHub repository. **Delete `firebase-init.js` and `firebase-config.js` from the repository**; they're no longer used.

Open `https://austin-gif12.github.io/PML-Snagging-/` → **First time? Create your login** with the owner email.

### 5. Move the old Firebase data across (once)
1. Firebase console → `pml-snagigng` → **Project settings → Service accounts → Generate new private key**. Save the file in the `pml-snagging` folder as `firebase-key.json`.
2. In PowerShell:
   ```
   cd C:\Users\AustinLeivers\pml-snagging
   node migrate/export-firestore.mjs firebase-key.json
   ```
   It writes `firebase-export.json` and says how many jobs, snags and photos it found.
3. **Delete `firebase-key.json`** (it can read everything in Firebase).
4. In the app as the owner: **menu → Users & permissions → Move data across from Firebase → Choose export file…** → pick `firebase-export.json`. Keep the app open until it says *Done*.
5. Check a few jobs, then delete `firebase-export.json`. Once you're happy, the Firebase project can be deleted.

People keep their roles, but each needs a WorkOS login with the **same email**: **Users & permissions → Resend invite**, or they tap *First time? Create your login*.

## Adding people
- **PML staff:** **Users & permissions → Add user**. They get a WorkOS invitation email.
- **Contractors:** open the job → **Contractors** tab → add the contractor with each person's **email** → **Give app access**. They get an invitation and then only see their own snags.
- An invite usually goes to junk if it doesn't arrive. **Resend invite** sends it again, or they can tap *First time? Create your login* with that email. Someone who signs up without being given access sees "No access yet".

## Offline
- Sign in once on each device with signal. After that the app opens and works with no signal: add snags, sign off, take photos.
- Changes made offline show "⏳ to upload" and upload by themselves, in order, when signal returns.
- Drawings download to the device when you open a job with signal. Photos are kept once they've been viewed.
- Signing out clears the device. If changes haven't uploaded yet, the app warns first.
- Signal is needed for: signing in on a new device, giving access / sending invites, deleting a whole job, importing, and uploading a PDF drawing the first time (JPG/PNG work offline).
- When you upload a new version of the app, change `CACHE = 'pml-snagging-v3'` in `sw.js` to `v4`, `v5` and so on, so phones pick it up.

## Costs
- **PlanetScale:** the Postgres database is on a paid plan. Check the plan and storage use in the PlanetScale dashboard. Drawings and photos are stored in the database (photos ~100–250 KB, drawings 1–5 MB each), so storage grows with use.
- **Cloudflare Workers:** free up to 100,000 requests a day. Each open device checks for changes every 15 seconds (about 240 requests an hour).
- **WorkOS AuthKit:** free up to 1 million users a month.
