# Share this app with teammates (Cloudflare Tunnel + Cloudflare Access)

This project runs locally on `http://127.0.0.1:8000`. To let teammates access it on your domain (e.g. `yuookie.qzz.io`) without opening router ports, use **Cloudflare Tunnel**, and protect it with **Cloudflare Access (Email PIN)**.

## 0) What you get / important notes

- Teammates will be accessing **your machine's** running app.
- By default, the app runs in **multi-user DB mode**: each teammate gets their **own SQLite database file** based on their Cloudflare Access email, so records won’t mix.
- Access control uses **Cloudflare Access** (recommended). As an optional fallback, the app also supports **HTTP Basic Auth** via `.env`.

## 1) One-shot setup (recommended)

Run:

- `powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\\tools\\cf_full_setup.ps1`

Defaults used by the script:
- `CLOUDFLARED_TUNNEL_NAME=vocabulary-study`
- `CLOUDFLARED_HOSTNAME=yuookie.qzz.io`
- `CLOUDFLARED_SERVICE=http://127.0.0.1:8000`

Override (optional):

```powershell
$env:CLOUDFLARED_TUNNEL_NAME="vocabulary-study"
$env:CLOUDFLARED_HOSTNAME="yuookie.qzz.io"
$env:CLOUDFLARED_SERVICE="http://127.0.0.1:8000"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\\tools\\cf_full_setup.ps1
```

The script will:
- Install `cloudflared` via winget if missing
- Open a browser for `cloudflared tunnel login` (one-time)
- Create the tunnel (if missing)
- Create/overwrite the DNS route for your hostname
- Write `%USERPROFILE%\\.cloudflared\\vocabulary-study.yml`

If `cloudflared` says it failed to write `cert.pem` and your browser downloaded it instead, copy the downloaded `cert.pem` to:
- `%USERPROFILE%\\.cloudflared\\cert.pem`
then rerun `tools\\cf_full_setup.ps1`.

## 2) Start the app + start the tunnel

Option A (single command): starts the app and then runs the tunnel:
- `powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\\tools\\share.ps1`

Option B (two terminals):

Terminal A (app):
- `powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\\run.ps1`

Terminal B (tunnel):
- `cloudflared tunnel --config %USERPROFILE%\\.cloudflared\\vocabulary-study.yml run`

Now teammates can open:
- `https://yuookie.qzz.io`

## 3) Add login protection via Cloudflare Access (Email PIN)

Cloudflare dashboard steps:

- Go to **Zero Trust** → **Access** → **Applications** → **Add an application**
- Choose **Self-hosted**
- Application name: `Vocabulary Study`
- Domain: `yuookie.qzz.io`

Identity / login method:
- Go to **Zero Trust** → **Settings** → **Authentication**
- Ensure **One-time PIN** (Email) is enabled (this is the Email PIN login)

Policy (who can access):
- In the application **Policies**, create a policy like:
  - **Action**: Allow
  - **Include**: Emails → add your teammates' email addresses (QQ/163/company email are fine)
  - Save

After this, anyone who visits `https://yuookie.qzz.io` will be asked to verify via email PIN before seeing the site.

## 3.1) Verify per-user separation

With Access enabled, each user is identified by `Cf-Access-Authenticated-User-Email`, and the app stores their data in a separate SQLite DB file under `data/userdb/` (configurable via `.env`).

Local dev without Access:
- Set `APP_DEV_USER_EMAIL=someone@example.com` in `.env` to simulate a user.
- Or set `APP_MULTIUSER_BY_EMAIL=0` to keep the old single-DB behavior.

## 4) (Optional) App-level Basic Auth (simple password gate)

If you prefer the app to enforce a password (independent from Cloudflare Access), set in `.env`:

```env
APP_BASIC_AUTH_USER=dev
APP_BASIC_AUTH_PASS=change-me
```

Then restart the server. Browsers will prompt for username/password.
