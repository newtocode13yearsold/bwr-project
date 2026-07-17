# HOWTO — Running BWR without being a coder

This is the plain-English operator manual for **BWR (bwrmaps.com)**. It's written so
that *you* — or anyone you ever hand the site to — can keep it alive, change settings,
and not panic when something breaks. No coding knowledge assumed.

If you only read one thing: **your users and all their data live in Cloudflare, not on
your PC. Back it up (see §7) and you can survive almost any mistake.**

---

## 0. The 60-second mental model

- **The code** lives on your PC and on GitHub. It's the "app".
- **The live site** runs on **Cloudflare** (a company that hosts it worldwide, mostly free).
- **The data** (every user account, path, report, review) lives in **Cloudflare KV** —
  a simple online database. The code cannot recreate this data; only a backup can.
- **The domain** `bwrmaps.com` points visitors at Cloudflare.
- **Deploying** = pushing a new copy of the code to Cloudflare so the live site updates.

You mostly do two things: **change something and deploy it**, or **read/back up the data**.

---

## 1. One-time setup on a new PC

You need these installed once:

1. **Node.js** (LTS version) — from https://nodejs.org . This gives you `node` and `npm`.
2. The project folder (this one). If starting fresh from GitHub:
   `git clone <your-repo-url>` then open the folder.
3. Inside the folder, install the tools the project needs:
   ```
   npm install
   ```
4. Log in to Cloudflare so your PC is allowed to deploy and read data:
   ```
   npx wrangler login
   ```
   A browser opens — click **Allow**. You only do this once per PC.

That's it. You're ready.

---

## 2. Run the site locally (on your own PC)

This runs a private copy on your computer — nobody else can see it. Great for trying
changes before they go live.

```
npm run dev:worker
```

Wait for it to say it's ready, then open **http://localhost:8787** in your browser.

- Stop it with **Ctrl + C** in the terminal.
- This local copy uses a **separate local database**, so you can't damage real user data
  while testing here.
- **Worth doing once** just so you've seen it work. Nothing you do here touches the live site.

---

## 3. Deploy (push changes to the live site)

When you (or Claude) have changed something and it's ready for the world:

**The safe/normal way — via GitHub (recommended):**
You "commit" (save a snapshot of your changes with a note) and "push" (send that
snapshot to GitHub). GitHub then runs the tests and, **if they pass**, deploys to
Cloudflare for you automatically. The three commands, run from the project folder:
```
git add -A                          # stage every changed file
git commit -m "Describe what you changed"   # save a snapshot with a note
git push                            # send it to GitHub (this triggers the deploy)
```
- Then watch the **Actions** tab on GitHub — a green check means it deployed, a red X
  means it failed.
- If the site doesn't update after a push, the deploy step probably failed — check that
  **Actions** tab for a red X, not your browser cache.
- First time only: if `git push` complains there's no remote/branch set, run
  `git push -u origin main` once, then plain `git push` works forever after.
- Reminder: whenever you commit + push, bump the version in `public/changelog.html` first
  so the changelog stays in step with what went live.

**The manual way (from your PC, skips GitHub):**
```
npm test          # always run the tests first
npm run deploy:worker
```
Only use this if GitHub deploys aren't working. It pushes straight to Cloudflare.

> **Golden rule:** run `npm test` before any deploy. If tests are red, don't deploy —
> something is broken. All ~400 tests should pass in a few seconds.

---

## 4. Change a setting / secret key (env vars)

The site uses a few secret keys (for email, routing, etc.). These are **not in the code** —
they live in the Cloudflare dashboard so they stay secret. To change one:

1. Go to https://dash.cloudflare.com → **Workers & Pages** → **bwr-worker**.
2. Open **Settings → Variables and Secrets**.
3. Add/edit the value, click **Save**. Changes apply on the next deploy (or immediately
   for secrets, depending on Cloudflare's UI — re-deploy if unsure).

The keys that matter (all covered again in the cost list, §9):

| Key | What it's for | If it's missing… |
|-----|---------------|------------------|
| `RESEND_API_KEY` | Sending emails (sign-up verification, password reset, notifications) | No emails go out. Sign-ups can't verify. |
| `RESEND_FROM` | The "from" address on those emails, e.g. `BWR <noreply@bwrmaps.com>` | Emails fail or look wrong. |
| `ORS_KEY` | Nicer route planning (OpenRouteService) | Site still works — falls back to a free router automatically. |

You can set secrets from the command line too:
`npx wrangler secret put RESEND_API_KEY` (it prompts for the value).

---

## 5. Add an admin (or change someone's plan)

**Change a plan (Free / Silver / Gold):** easy — log in as admin, go to the
**Panneau admin** page, find the member, and change their plan there. No code needed.

**Make someone an admin:** there's no button for this (on purpose — admins are powerful).
The **first** admin was created once via the site's `/api/setup` page on first launch.
To make an *additional* admin, you edit that user's record in the database:

1. Find their user ID (visible in the admin members list, or in a KV backup).
2. In the Cloudflare dashboard → **Workers & Pages → KV → BWR_KV**, find the key
   `user:<their-id>`, and in the JSON change `"role":"free"` (or whatever) to
   `"role":"admin"`. Save.
3. They may need to log out and back in.

If in doubt, ask Claude to do this step with you — it's fiddly but not dangerous if you
only touch the one `role` field.

---

## 6. Where the user data lives

Everything users create is in **Cloudflare KV**, namespace **BWR_KV**
(id `da878110f87d4dc6975a6bf3e44cd7ed`). You can browse it in the Cloudflare dashboard
under **Workers & Pages → KV → BWR_KV**. Key examples (there are more in `CLAUDE.md`):

- `user:<id>` — a person's account
- `uemail:<email>` — email → account lookup
- `path:<id>` — a forest path
- `report:<id>` — a reported problem (fallen tree, etc.)
- `review:<id>` — a site rating/comment
- `session:<token>` — a logged-in session

**You rarely need to touch these directly.** The main reason to look is to back them up.

---

## 7. Back up your data (do this regularly!)

This is the single most important habit. If KV is ever wiped or corrupted, **the code
alone cannot bring your users back** — only a backup can.

**Make a backup** (from the project folder, logged in to Cloudflare):
```
node scripts/backup-kv.mjs
```
This downloads *everything* into a timestamped file under `backups/`. Copy that file
somewhere safe (cloud drive, USB stick). Do this before any risky change, and on a
routine (e.g. monthly).

**Restore a backup** (puts the data back):
```
node scripts/backup-kv.mjs --restore backups/<the-file>.json
```
Restore only **adds/overwrites** keys — it never deletes. Safe to run.

---

## 8. What breaks the site (and what to check first)

| Symptom | Most likely cause | First thing to check |
|---------|-------------------|----------------------|
| Site didn't update after a change | Deploy failed | GitHub **Actions** tab for a red X (§3), not browser cache |
| Sign-up / password-reset emails not arriving | Email key expired or out of quota | `RESEND_API_KEY` valid? Resend dashboard quota (§9)? |
| "Accès refusé" everywhere / can't log in | Wrong account, or you're not admin | Log in with the admin account |
| Route planning worse than usual | ORS key issue | Site auto-falls-back to free router — usually self-heals. Check `ORS_KEY` |
| Whole site down / error page | Bad deploy | Re-deploy the last known-good version, or check Cloudflare dashboard status |
| Domain `bwrmaps.com` not resolving | Domain lapsed or DNS | Cloudflare **Registrar** — is the domain still paid/active? (§9) |
| Tests fail (`npm test`) | A change broke something | **Do not deploy.** Fix or revert first |

**When in real trouble:** the two things that save you are (a) a recent **backup** (§7),
and (b) **not deploying** when tests are red. Almost everything else is recoverable.

---

## 9. Monthly / yearly running costs

Check these so nothing lapses and quietly takes the site down. As of **July 2026** the
site runs almost entirely on free tiers — the domain is the only guaranteed bill.

| Service | What it does | Cost | Where to check / renew |
|---------|--------------|------|------------------------|
| **Domain `bwrmaps.com`** | Your web address | **~$10.46 / year** (Cloudflare Registrar, at cost) | dash.cloudflare.com → Registrar. **Turn on auto-renew.** This is the one bill that will kill the site if missed. |
| **Cloudflare Workers + KV** | Hosts the site & database | **Free tier** (100k requests/day; generous KV) — likely $0 at current traffic | Cloudflare dashboard → Workers & Pages → usage. Only pay if you get very popular. |
| **Cloudflare Workers AI** | AI text in the admin panel | **Free tier** (daily allowance) | Same dashboard. Rarely a cost at your scale. |
| **Resend** (email) | Verification / reset / notification emails | **Free tier** (~3,000 emails/month, 100/day) — $0 unless you send a lot | resend.com dashboard → usage. If emails stop, check quota here first. |
| **OpenRouteService** (`ORS_KEY`) | Nicer route planning | **Free** (developer plan, daily quota) — optional | openrouteservice.org dashboard. If it lapses the site auto-falls-back; no outage. |
| **Other map/data services** | OSM tiles, Nominatim search, OSRM routing, Open-Meteo weather, Open-Elevation, ntfy.sh push | **Free**, no account/key needed | Nothing to renew. They're public services the site just calls. |

**Bottom line:** budget **~$10–11/year for the domain**, and expect **$0/month** for
everything else until traffic grows a lot. The only thing that *must not* lapse is the
domain — enable auto-renew and keep a card on file at Cloudflare.

---

## 10. Handy command cheat-sheet

```
npm install                 # one-time: install tools
npx wrangler login          # one-time: connect this PC to Cloudflare
npm run dev:worker          # run the site locally at http://localhost:8787
npm test                    # run all tests (do this before deploying)
git add -A                  # stage your changes
git commit -m "message"     # save a snapshot with a note
git push                    # send to GitHub -> auto-runs tests & deploys
npm run deploy:worker       # (only if needed) manually deploy, skipping GitHub
node scripts/backup-kv.mjs  # back up ALL user data to backups/
node scripts/backup-kv.mjs --restore backups/<file>.json   # restore a backup
```

Keep this file up to date if costs or keys change. When in doubt, make a backup first —
it's the reset button that always works.
