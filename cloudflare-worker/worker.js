export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }

    if (url.pathname !== "/status" && url.pathname !== "/") {
      return json({ error: "not_found" }, 404);
    }

    try {
      const status = await getStatus(env);
      return json(status, 200, {
        "Cache-Control": "public, max-age=20, s-maxage=20"
      });
    } catch (e) {
      return json({
        active: null,
        status: "unknown",
        text: "Київська область",
        updated_at: new Date().toISOString(),
        error: "upstream_unavailable"
      }, 503);
    }
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil(getStatus(env, true));
  }
};

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...corsHeaders(),
      ...extra,
    },
  });
}

async function getStatus(env, force = false) {
  const cache = caches.default;
  const cacheKey = new Request("https://cache.bespeka.local/kyiv-oblast-alert");

  if (!force) {
    const cached = await cache.match(cacheKey);
    if (cached) return await cached.json();
  }

  if (!env.ALERTS_TOKEN) throw new Error("ALERTS_TOKEN missing");

  const res = await fetch("https://api.alerts.in.ua/v1/alerts/active.json", {
    headers: { Authorization: `Bearer ${env.ALERTS_TOKEN}` },
    cf: { cacheTtl: 0, cacheEverything: false },
  });

  if (!res.ok) throw new Error(`alerts.in.ua HTTP ${res.status}`);
  const data = await res.json();
  const alerts = Array.isArray(data?.alerts) ? data.alerts : [];

  const oblastAlerts = alerts.filter(a =>
    a.location_oblast === "Київська область" ||
    a.location_title === "Київська область"
  );

  const airRaid = oblastAlerts.find(a => a.alert_type === "air_raid");
  const threats = [...new Set(oblastAlerts.flatMap(a =>
    Array.isArray(a.threats) ? a.threats.map(t => t?.threat_type).filter(Boolean) : []
  ))];

  const result = {
    active: Boolean(airRaid),
    status: airRaid ? "active" : "safe",
    text: "Київська область",
    started_at: airRaid?.started_at || null,
    updated_at: new Date().toISOString(),
    alert_level: airRaid?.alert_level || null,
    threats,
    source: "alerts.in.ua"
  };

  const cachedResponse = json(result, 200, {
    "Cache-Control": "public, max-age=45"
  });

  ctxWait(cache.put(cacheKey, cachedResponse.clone()));
  return result;
}

function ctxWait(promise) {
  promise.catch(() => {});
}
