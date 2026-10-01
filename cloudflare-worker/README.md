# Cloudflare Worker for alerts.in.ua

This Worker keeps the `alerts.in.ua` token server-side and exposes only a small public JSON response for the PWA.

## Endpoint

After deployment:

```
https://bespeka-alerts.<your-subdomain>.workers.dev/status
```

Example response:

```json
{
  "active": true,
  "status": "active",
  "text": "Київська область",
  "started_at": "2026-10-02T00:00:00.000Z",
  "updated_at": "2026-10-02T00:01:00.000Z",
  "alert_level": "yellow",
  "threats": ["drones"],
  "source": "alerts.in.ua"
}
```

## Required secret

Cloudflare Worker secret:

`ALERTS_TOKEN`

Do not put the token into JavaScript or GitHub Pages.

## Deploy manually

```bash
npx wrangler secret put ALERTS_TOKEN
npx wrangler deploy
```

The cron trigger runs every minute. The public GET endpoint uses a short cache to reduce upstream requests.
