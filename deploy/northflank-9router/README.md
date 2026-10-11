# 9router on Northflank (free, no card, always on)

Hosts the user's existing 9router (official Docker image) on Northflank's free
Developer Sandbox: 2 always-on services, no sleep, no credit card. State
(SQLite) is mirrored to Cloudflare R2 free tier so deploys and 9router image
updates never lose provider accounts or quota tracking.

## Layout

- `Dockerfile`: FROM decolua/9router:latest + our sync entrypoint
- `entrypoint.sh`: pull data.sqlite from R2 on boot, run 9router, push back
  every SYNC_INTERVAL seconds and on shutdown (SIGTERM/SIGINT)

## One-time setup (user)

1. Cloudflare dashboard (same account as the agent worker):
   - R2 Object Storage: enable (free tier, no card)
   - R2 -> Manage API tokens: create token, Object Read & Write, scope to the
     `9router-state` bucket. Save access_key_id + secret + account id.
2. Northflank: sign up with GitHub, create a project, generate a Personal
   Access Token (Project scope) and hand it to Claude.
3. Hand over: R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, CLOUDFLARE_ACCOUNT_ID.

## Deploy (Claude drives via Northflank API once PAT arrives)

1. Push this repo to GitHub, connect it in Northflank, service type:
   Dockerfile build. Path: `deploy/northflank-9router`.
2. Service settings:
   - Port: 20128 (9router default; confirm via first logs)
   - Env: DATA_DIR=/app/data, R2_ACCOUNT_ID, R2_ACCESS_KEY_ID,
     R2_SECRET_ACCESS_KEY, R2_OBJECT=data.sqlite, SYNC_INTERVAL=180
   - Image tag for base: decolua/9router:latest
3. Seed state: upload local `%APPDATA%/9router/db/data.sqlite` to the R2
   bucket as `data.sqlite` before first boot (wrangler r2 object put).
4. First boot logs should show "[9router-sync] state restored" then 9router live.

## 9router updates (it releases often)

- The Dockerfile pins FROM decolua/9router:latest.
- To take a new version: redeploy with force rebuild on Northflank. The sync
  entrypoint is OUR build layer, so it survives; state comes back from R2.
- Inside the container 9router's self-updater is disabled (image-based
  deploys replace the whole container; self-update would fight that).

## Wiring the agent brain

After the service has a public URL:

- Worker env ROUTER_URL = https://<service-url>/v1/chat/completions
- Worker secret ROUTER_KEY = API key from the 9router dashboard
  (migrate the existing key from the local dashboard, or create a new one)

## Fallbacks if Northflank account has issues

- Azure for Students (no card, needs university email)
- Cash-bought physical prepaid card -> Oracle Always Free
- Second Northflank service slot is reserved for the agent tool-runner
  (terminal + files) in a later phase
