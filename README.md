# PML Snagging

Snagging app with logins, roles, per-job contractors, and a contractor → PML sign-off workflow. It works offline and syncs when signal comes back.

- **Sign-in:** WorkOS AuthKit
- **Database:** PlanetScale Postgres (`pml-snagging`, London)
- **Hosting:** Vercel (`pml-snagging.vercel.app`) serves both the app and its API (`/api`). Every push to `main` deploys.

## Roles
| Role | Can do |
|---|---|
| **Admin** | Everything, including **Users & permissions** and deleting jobs. The owner email (`OWNER_EMAILS`, default `austin@planningmanager.co.uk`) is always admin. |
| **Site manager** | Every job: create jobs, upload drawings, add and edit snags, sign off or send back, reports, trades library, main contractor list, and giving contractors access. |
| **Contractor** | Only snags assigned to their company on jobs where their email is listed. Can mark a snag *In progress* or *Completed* (with a note and photos of the fix). Cannot sign off, edit snag details or see anyone else's snags. |

Workflow: **Open → In progress → Awaiting sign-off** (contractor marks completed) → PML either **signs off** (green) or **sends back** with a reason (back to Open).

These permissions are enforced by the API (`lib/app.js`), not just hidden in the app.

## How it fits together
```
Phone / PC (index.html + data.js)        Vercel /api (api/index.js + lib/)       PlanetScale Postgres
  copy of the data on the device   ──►   checks the login, applies    ──►   users, settings, jobs,
  queue of changes to upload       ◄──   the permissions, syncs        ◄──   drawings, drawing_chunks,
                                                                              snags, photos
        │ sign in
        ▼
  WorkOS AuthKit page ──► /api checks the WorkOS login and gives the app a 30-day session
```
- **Sign-in:** the app sends people to the WorkOS AuthKit page. The API checks the WorkOS login (email must be confirmed) and gives the app its own session. Who sees what comes from the app's **Users & permissions** list (the `users` table), not from WorkOS.
- **Offline:** `data.js` keeps everything the person can see on the device and queues their changes. The queue uploads in order when there's signal, and the app checks for other people's changes every 15 seconds. Photos and drawing images are downloaded when opened, then kept on the device.
- **Secrets** (the WorkOS API key and the database connection string) live only in Vercel's environment variables, never in the code.

## Files
| File | What it is |
|---|---|
| `index.html` | The app |
| `data.js` | On-device copy, upload queue and sync with the API |
| `workos-auth.js` | Sign-in with WorkOS AuthKit |
| `config.js` | API address and owner email (the WorkOS Client ID comes from Vercel) |
| `sw.js`, `manifest.webmanifest`, `assets/` | Offline app files, home-screen icon, logos |
| `api/index.js` | The Vercel function behind every `/api/…` address (`vercel.json` routes them) |
| `lib/app.js` | Sign-in, permissions, sync and invitations |
| `lib/store-postgres.js` | Database tables and queries |
| `db/schema.sql` | The tables, for creating them by hand if the API's login is read/write only |
| `migrate/` | One-off tools to copy the old Firebase data across |

## Setup

### Vercel → Project → Settings → Environment Variables
| Name | Value |
|---|---|
| `WORKOS_CLIENT_ID` | WorkOS `client_…` |
| `WORKOS_API_KEY` | WorkOS `sk_…` (secret) |
| `DATABASE_URL` | PlanetScale connection string (`postgresql://…`) |
| `OWNER_EMAILS` | *(optional)* defaults to `austin@planningmanager.co.uk` |

After changing a variable, **Deployments → ⋯ → Redeploy**.

Check it: open **https://pml-snagging.vercel.app/api**. It should say `"ok":true` and `"database":"ok"`.

### Database tables
The API creates its tables the first time it runs, **if** its PlanetScale login is allowed to create tables (e.g. a role with `--inherited-roles postgres`).

If the login is read/write only (`pg_read_all_data,pg_write_all_data`), `/api` will say the tables are missing. Create them once by running `db/schema.sql`. You can do that in the PlanetScale dashboard's query console, or briefly use an admin login in `DATABASE_URL`, open `/api`, then switch back to the read/write login.

### WorkOS (dashboard.workos.com)
1. **Authentication → Methods**: switch on **Email + Password** (and Magic Auth / Google if wanted). Keep **email verification** on.
2. **Redirects** (use your own domain instead if you add one):
   - **Redirect URI**: `https://pml-snagging.vercel.app/` (default)
   - **Sign-in endpoint**: `https://pml-snagging.vercel.app/?sign-in`
   - **Sign-out redirect**: `https://pml-snagging.vercel.app/`
3. **Authentication → Sessions → CORS / Allowed web origins**: `https://pml-snagging.vercel.app`
4. *(Optional)* **Branding**: PML logo and yellow `#FCBF2A`.

**Own domain:** if you point a domain at the Vercel project (e.g. a subdomain whose DNS is on Cloudflare: add it in Vercel → Domains, then add the record Vercel shows in Cloudflare DNS with the proxy turned **off**/grey cloud), add that address to WorkOS too.

### Email reminders (Resend)
Contractors can be emailed their outstanding snags daily, every 2 days or weekly (job → **Contractors** → **Email reminders**). Vercel runs `/api/cron/reminders` every morning at 06:00 UTC (`vercel.json` → `crons`); see `lib/reminders.js`.
1. Sign up at **resend.com** → **Domains → Add domain** `pml-snagging.com` → add the DNS records it shows in **Cloudflare DNS** (proxy off) → wait for *Verified*.
2. **API Keys → Create** (sending access).
3. In Vercel add:

| Name | Value |
|---|---|
| `RESEND_API_KEY` | Resend `re_…` (secret) |
| `REMINDER_FROM` | `PML Snagging <snagging@pml-snagging.com>` |
| `CRON_SECRET` | any long random text (Vercel sends it with each scheduled run) |
| `REMINDER_REPLY_TO` | *(optional)* e.g. `austin@planningmanager.co.uk` |

Then redeploy. `/api` shows `"email":"ok"` when it's all set. **Send now** on a contractor emails them straight away, which is a good test.

### First sign-in
Open the site → **First time? Create your login** with the owner email. You're in as Admin.

## Moving the old Firebase data across (once)
**Users & permissions → Move data across from Firebase**:
- **Copy straight from Firebase…**: sign in with your **old** Firebase app email and password. It reads everything from Firebase in the browser, then copies it in. Keep the app open until it says *Done*.
- If Firebase refuses, use the export file instead:
  1. Firebase console → Project settings → Service accounts → **Generate new private key** → save it in this folder as `firebase-key.json`.
  2. Run `node migrate/export-firestore.mjs firebase-key.json`. It writes `firebase-export.json`.
  3. **Delete `firebase-key.json`**, then use **Choose export file…** in the app.

Only run the import once: running it again puts the Firebase copies back over any changes made since.

People keep their roles, but each needs a WorkOS login with the **same email**: **Users & permissions → Resend invite**, or they tap *First time? Create your login*.

## Adding people
- **PML staff:** **Users & permissions → Add user**. They get a WorkOS invitation email.
- **Contractors:** open the job → **Contractors** tab → add the contractor with each person's **email** → **Give app access**. They then only see their own snags.
- Invites often land in junk. **Resend invite** sends it again, or they can tap *First time? Create your login* with that email. Someone who signs up without being given access sees "No access yet".

## Offline
- Sign in once on each device with signal. After that the app opens and works with no signal: add snags, sign off, take photos.
- Changes made offline show "⏳ to upload" and upload by themselves, in order, when signal returns.
- Drawings download to the device when you open a job with signal. Photos are kept once they've been viewed.
- Signing out clears the device. If changes haven't uploaded yet, the app warns first.
- Signal is needed for: signing in on a new device, giving access / sending invites, deleting a whole job, importing, and uploading a PDF drawing the first time (JPG/PNG work offline).
- When you change the app, bump `CACHE = 'pml-snagging-v4'` in `sw.js` (`v5`, `v6`…) so phones pick it up.

## Costs
- **PlanetScale:** Postgres is a paid plan. Drawings and photos are stored in the database (photos ~100–250 KB, drawings 1–5 MB each), so storage grows with use. Check usage in the PlanetScale dashboard.
- **Vercel:** the API is a few small function calls per device. Each open device checks for changes every 15 seconds.
- **WorkOS AuthKit:** free up to 1 million users a month.
