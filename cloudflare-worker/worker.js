const KYIV_OFFICIAL = "https://gisserver.kyivcity.gov.ua/mayno/rest/services/KYIV_API/Public_protection/MapServer/0/query?where=1%3D1&outFields=*&returnGeometry=true&f=geojson&outSR=4326";
const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter"
];
const KYIV_OBLAST_AREA = 3600071248;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders() });

    try {
      if (url.pathname === "/" || url.pathname === "/status") {
        const alerts = await getAlerts(env);
        return json(summarizeKyiv(alerts), 200, { "Cache-Control": "public, max-age=20" });
      }
      if (url.pathname === "/alerts") {
        const alerts = await getAlerts(env);
        return json({ alerts, updated_at: new Date().toISOString(), source: "alerts.in.ua" }, 200, {
          "Cache-Control": "public, max-age=20"
        });
      }
      if (url.pathname === "/shelters") {
        const payload = await getShelters();
        return json(payload, 200, { "Cache-Control": "public, max-age=900, s-maxage=900" });
      }
      return json({ error: "not_found" }, 404);
    } catch (e) {
      return json({ error: "upstream_unavailable", message: String(e?.message || e) }, 503);
    }
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil(getAlerts(env, true));
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
    headers: { "Content-Type": "application/json; charset=utf-8", ...corsHeaders(), ...extra }
  });
}

async function getAlerts(env, force = false) {
  if (!env.ALERTS_TOKEN) throw new Error("ALERTS_TOKEN missing");
  const cache = caches.default;
  const key = new Request("https://cache.bespeka.local/alerts");

  if (!force) {
    const cached = await cache.match(key);
    if (cached) return (await cached.json()).alerts || [];
  }

  const res = await fetch("https://api.alerts.in.ua/v1/alerts/active.json", {
    headers: { Authorization: `Bearer ${env.ALERTS_TOKEN}` },
    cf: { cacheTtl: 0, cacheEverything: false },
  });
  if (!res.ok) throw new Error(`alerts.in.ua HTTP ${res.status}`);

  const data = await res.json();
  const alerts = (Array.isArray(data?.alerts) ? data.alerts : []).map(a => ({
    id: a.id ?? null,
    location_title: a.location_title || "",
    location_type: a.location_type || "",
    location_uid: a.location_uid || "",
    location_oblast: a.location_oblast || "",
    location_oblast_uid: a.location_oblast_uid || "",
    location_raion: a.location_raion || "",
    alert_type: a.alert_type || "",
    alert_level: a.alert_level || "",
    started_at: a.started_at || null,
    updated_at: a.updated_at || null,
    notes: a.notes || "",
    threats: Array.isArray(a.threats) ? a.threats.map(t => ({
      threat_type: t?.threat_type || "",
      level: t?.level || "",
      started_at: t?.started_at || null
    })).filter(t => t.threat_type) : []
  }));

  await cache.put(key, json({ alerts }, 200, { "Cache-Control": "public, max-age=45" }));
  return alerts;
}

function summarizeKyiv(alerts) {
  const relevant = alerts.filter(a =>
    a.location_oblast === "Київська область" ||
    a.location_title === "Київська область"
  );
  const threats = [...new Set(relevant.flatMap(a => a.threats.map(t => t.threat_type)))];
  const types = [...new Set(relevant.map(a => a.alert_type).filter(Boolean))];
  const starts = relevant.map(a => a.started_at).filter(Boolean).sort();

  return {
    active: relevant.length > 0,
    status: relevant.length ? "active" : "safe",
    text: "Київська область",
    started_at: starts[0] || null,
    updated_at: new Date().toISOString(),
    alert_level: relevant.some(a => a.alert_level === "red") ? "red" : relevant[0]?.alert_level || null,
    alert_types: types,
    threats,
    active_locations: relevant.map(a => ({
      title: a.location_title,
      type: a.location_type,
      raion: a.location_raion,
      alert_type: a.alert_type,
      started_at: a.started_at
    })),
    source: "alerts.in.ua"
  };
}

async function getShelters() {
  const cache = caches.default;
  const key = new Request("https://cache.bespeka.local/shelters-v2");
  const cached = await cache.match(key);
  if (cached) return await cached.json();

  const [city, oblast] = await Promise.allSettled([fetchKyivOfficial(), fetchOblastOsm()]);
  const cityItems = city.status === "fulfilled" ? city.value : [];
  const oblastItems = oblast.status === "fulfilled" ? oblast.value : [];
  const shelters = dedupe([...cityItems, ...oblastItems]);

  if (!shelters.length) throw new Error("No shelter source available");

  const payload = {
    shelters,
    counts: { total: shelters.length, kyiv_official: cityItems.length, oblast_osm: oblastItems.length },
    partial: city.status !== "fulfilled" || oblast.status !== "fulfilled",
    updated_at: new Date().toISOString()
  };
  await cache.put(key, json(payload, 200, { "Cache-Control": "public, max-age=21600" }));
  return payload;
}

async function fetchKyivOfficial() {
  const res = await fetch(KYIV_OFFICIAL, { cf: { cacheTtl: 3600 } });
  if (!res.ok) throw new Error(`Kyiv shelters HTTP ${res.status}`);
  const gj = await res.json();
  return (gj.features || []).map((f, i) => {
    if (f?.geometry?.type !== "Point") return null;
    const [lng, lat] = f.geometry.coordinates || [];
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    return normalizeShelter(f.properties || {}, lat, lng, "kyiv_official", "kyiv:" + (f.id || i));
  }).filter(Boolean);
}

async function fetchOblastOsm() {
  const query = `[out:json][timeout:55];area(${KYIV_OBLAST_AREA})->.a;(nwr["amenity"="shelter"](area.a);nwr["emergency"="shelter"](area.a);nwr["shelter_type"](area.a);nwr["military"="bunker"]["bunker_type"="civil_defense"](area.a););out center tags qt;`;
  let lastError;

  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
        body: "data=" + encodeURIComponent(query)
      });
      if (!res.ok) throw new Error(`Overpass HTTP ${res.status}`);
      const data = await res.json();
      return (data.elements || []).map(e => {
        const lat = e.lat ?? e.center?.lat;
        const lng = e.lon ?? e.center?.lon;
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
        return normalizeShelter(e.tags || {}, lat, lng, "osm", `osm:${e.type}:${e.id}`);
      }).filter(Boolean);
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError || new Error("Overpass unavailable");
}

function normalizeShelter(p, lat, lng, source, id) {
  const typeRaw = [p.type_building, p.type, p.shelter_type, p.description, p.name].filter(Boolean).join(" ").toLowerCase();
  const type = typeRaw.includes("найпрост") || typeRaw.includes("simple") ? "simple" : "shelter";
  const address = first(p, "address", "full_address", "adress", "addr") ||
    [first(p, "addr:city", "city", "settlement"), [first(p, "addr:street", "street", "street_name"), first(p, "addr:housenumber", "house", "building_num")].filter(Boolean).join(", ")].filter(Boolean).join(", ") ||
    "Адресу не вказано";
  const directPhoto = first(p, "image", "photo", "image_url");
  const commons = first(p, "wikimedia_commons");
  const photo = /^https?:\/\//i.test(directPhoto) ? directPhoto :
    commons ? "https://commons.wikimedia.org/wiki/Special:Redirect/file/" + encodeURIComponent(commons.replace(/^File:/i, "").trim()) : "";
  const accessRaw = [p.disabled, p.accessibility, p.wheelchair, p.invalid, p.mgn].filter(Boolean).join(" ").toLowerCase();

  return {
    id, lat, lng, source, type,
    name: first(p, "name", "title", "type_building") || (type === "simple" ? "Найпростіше укриття" : "Укриття"),
    address,
    city: first(p, "addr:city", "city", "settlement"),
    accessible: ["yes", "так", "true", "доступ"].some(x => accessRaw.includes(x)),
    hours: first(p, "opening_hours", "work_time", "working_hours", "hours") || "",
    photo,
    capacity: first(p, "capacity", "people_capacity"),
  };
}

function first(p, ...keys) {
  for (const key of keys) {
    const v = p?.[key];
    if (v !== undefined && v !== null && String(v).trim()) return String(v).trim();
  }
  return "";
}

function dedupe(items) {
  const seen = new Set(), out = [];
  for (const s of items) {
    const key = Math.round(s.lat * 10000) + "|" + Math.round(s.lng * 10000);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}
