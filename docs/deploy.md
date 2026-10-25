# Deploying to the internet

About 20 minutes. The result is a permanent HTTPS address your devices can report to.

| Piece | Service | Why |
|---|---|---|
| Web app + device API | **Vercel** (free Hobby plan) | Deploys automatically on every push to GitHub |
| Database | **Neon** PostgreSQL (free plan) | Standard PostgreSQL. You can move to any Postgres host later by changing one setting |

Nothing here is tied to Vercel or Neon. The app is a standard Node.js app with a standard
PostgreSQL database. It can run on Fly.io, Railway, Render, AWS or Azure with the same code.

## Steps

1. **Vercel account:** go to vercel.com and sign up with your GitHub account.
2. **Import the repo:** Vercel dashboard → *Add New… → Project* → pick `vs-lab`.
   - **Root Directory:** `platform` ← important
   - Framework: Next.js (detected automatically)
   - Leave the build settings alone. `platform/vercel.json` already runs database migrations before each build.
   - Don't click Deploy yet if Vercel lets you continue to settings. If it deploys and fails, that's fine. Finish step 3 and redeploy.
3. **Database:** in the Vercel project → *Storage* → *Create Database* → **Neon** → accept the defaults.
   Vercel adds `DATABASE_URL` to the project automatically.
4. **Environment variables:** project → *Settings → Environment Variables*:
   - `PLATFORM_ADMIN_EMAILS` = your email address. **Required.** You sign in with it and set up
     organizations. Without it the build stops with *"No platform admin"*.
   - `RESEND_API_KEY` = from resend.com. **Needed to sign in:** sign-in links are emailed. See [alerts.md](alerts.md).
   - `ALERT_EMAIL_FROM` = e.g. `VS Lab <alerts@veristart.ai>` (a domain verified in Resend)
   - `DEVICE_AUTO_REGISTER` = `true` for now: new devices appear in *Veristart stock* on the Platform page until staff pair them with a machine
   - `APP_TIMEZONE` (optional) = fallback time zone, e.g. `America/Toronto` (the default). Each company's own time zone
     (Settings → Time zone and schedules) is what pages, alerts and daily totals use
   - `CRON_SECRET` = any long random string (e.g. from a password manager). Protects the scheduled jobs: the nightly
     privacy clean-up ([privacy.md](privacy.md)) and the 5-minute tamper watchdog, which needs **Vercel Pro** for its
     schedule ([tamper.md](tamper.md)).
   - `BLOB_READ_WRITE_TOKEN` = set automatically when a **private Blob store** is connected to the project
     (Vercel → Storage → Create → Blob, access *Private*). Needed for checklist photos; without it, photo buttons are
     hidden and required photos aren't enforced. (VS Lab's store is *vs-lab-photos*.)
   - `ALERT_EMAIL_TO` (optional) = addresses that get every organization's alerts
   - `DEVICE_KEY_SECRET` = any long random string: signs commands to devices. Needed before real devices with our
     firmware get commands; see [device-commands.md](device-commands.md). Don't change it once devices are flashed.
5. **Deploy:** *Deployments* → *Redeploy*. When it finishes, open the address Vercel shows
   (e.g. `vs-lab-xyz.vercel.app`) and sign in.
6. **Test with the simulator from your PC:**
   ```powershell
   cd $HOME\Documents\vs-lab\platform
   npm run simulate -- --host https://vs-lab-xyz.vercel.app --once
   ```
   Three machines should appear. To clear test data, use Neon's SQL editor:
   `DELETE FROM devices WHERE id LIKE 'SIM%';`

## Check it worked

1. **One project only.** Vercel dashboard → you should see a single project for `vs-lab`. If you
   see two (e.g. `vs-lab-platform` and `vs-lab-platform-abcd`), the repo was imported twice. Keep the
   one with the Neon database under *Storage*, and delete the other one (*Settings → Advanced → Delete Project*).
2. **Database connected.** Project → *Settings → Environment Variables* → `DATABASE_URL` is listed,
   for **Production and Preview**. If a deployment says *"No database connection"*, the database isn't
   connected to that project. Fix it under *Storage*, then redeploy.
3. **Sign-in set up.** `PLATFORM_ADMIN_EMAILS` and `RESEND_API_KEY` are listed. Opening the site shows
   the **Sign in** page. Enter your email, click the emailed link, press *Sign in to VS Lab*.
   See [organizations-and-users.md](organizations-and-users.md).
4. **App works.** Sign in. An empty Fleet page saying *"No devices have reported yet"* means everything
   is connected. Then run the simulator command above, and machines appear.

From now on, every change pushed to the `main` branch on GitHub deploys automatically. Pushes to
other branches get their own preview address, so you can try a change before it's live.

## Costs and limits

The free tiers are plenty for a few devices reporting every few seconds. Watch for:
- **Neon free storage (0.5 GB):** a device reporting every 5 s adds roughly 15–25 MB per month.
  Data retention or downsampling will be needed before you run dozens of devices.
- **Map tiles:** the map uses OpenStreetMap's free tiles, which are meant for light use.
  Switch to a paid tile provider (e.g. MapTiler) before showing this to many users.
