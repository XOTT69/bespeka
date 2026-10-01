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

async function getShelters(force = false) {
  const cache = caches.default;
  const key = new Request("https://cache.bespeka.local/shelters-v3");
  if (!force) {
    const cached = await cache.match(key);
    if (cached) return await cached.json();
  }

  const [city, dsns] = await Promise.allSettled([fetchKyivOfficial(), fetchDsnsKyiv()]);
  const cityItems = city.status === "fulfilled" ? city.value : [];
  let dsnsItems = dsns.status === "fulfilled" ? dsns.value : [];

  // Prefer Kyiv's own frequently-updated municipal dataset for the city itself.
  if (cityItems.length) {
    dsnsItems = dsnsItems.filter(s => !isKyivCityName(s.region));
  }

  const shelters = dedupe([...cityItems, ...dsnsItems]);
  if (!shelters.length) throw new Error("No official shelter source available");

  const payload = {
    shelters,
    counts: {
      total: shelters.length,
      kyiv_official: cityItems.length,
      dsns: dsnsItems.length,
      oblast_dsns: dsnsItems.filter(s => !isKyivCityName(s.region)).length
    },
    partial: city.status !== "fulfilled" || dsns.status !== "fulfilled",
    sources: ["КМДА", "ДСНС"],
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
    const item = normalizeShelter(f.properties || {}, lat, lng, "kyiv_official", "kyiv:" + (f.id || i));
    item.region = "м. Київ";
    return item;
  }).filter(Boolean);
}

async function fetchDsnsKyiv() {
  const regionIds = await getDsnsKyivRegionIds();
  const out = [];
  const limit = 1000;
  const maxPages = regionIds.length ? 8 : 25;

  for (let page = 0; page < maxPages; page++) {
    const body = {
      search: "",
      versiyaId: null,
      yeVyklyuchenoyu: null,
      format: "json",
      sortBy: "",
      sortOrder: "",
      dataProvedennyaOtsinkyStanuHotovnosti: "",
      formaVlasnostiId: [],
      isMinimumInfo: false,
      katehoriyaNaselennyaId: [],
      limit,
      maxMistkist: null,
      maxPloshcha: null,
      maxRikVvedennyaVEkspluatatsiyu: null,
      minMistkist: null,
      minPloshcha: null,
      minRikVvedennyaVEkspluatatsiyu: null,
      nayavniZasobyZvyazkuId: [],
      nayavnistDostupuMalomobilnykhVerstvNaselennya: null,
      nayavnistYERODV: null,
      nazvaBalansoutrymuvacha: "",
      nazvaNaselenohoPunktuId: [],
      nazvaRayonuMistaId: [],
      nebezpechniZonyId: [],
      oblikovyyNomerMistyt: "",
      osnovnyjVydEkonDiyalnostiId: [],
      rayonId: [],
      rehionId: regionIds,
      reyestrovyyNomerSporudy: "",
      rezhymyFiltroventylyatsiyiId: [],
      searchOnlyFields: [],
      skip: page * limit,
      stanHotovnostiId: [],
      statusProvedennyaInventaryzatsiyi: null,
      terytorialnaHromadaId: [],
      typSporudyId: [],
      vydSporudyId: [],
      yurydychnaAdresaBalansoutrymuvacha: "",
      zakhysniVlastyvostiId: []
    };

    const res = await fetch("https://shelters.dsns.gov.ua/api/v1/public/ukryttya/get", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    if (!res.ok) throw new Error(`DSNS shelters HTTP ${res.status}`);

    const payload = await res.json();
    const items = Array.isArray(payload?.data?.items) ? payload.data.items : [];
    if (!items.length) break;

    for (const x of items) {
      if (x?.yeVyklyuchenoyu === true) continue;
      const region = nestedName(x?.Rehion);
      if (!regionIds.length && !isKyivRegionName(region)) continue;

      const lat = Number(x?.shyrota);
      const lng = Number(x?.dovhota);
      if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) continue;

      const place = nestedName(x?.NazvaNaselenohoPunktu);
      const address = [place, x?.nazvaVulytsi, x?.inshiRekvizytyAdresy].filter(Boolean).join(", ") || "Адресу не вказано";
      const kind = nestedName(x?.VydSporudy) || nestedName(x?.TypSporudy) || x?.imya || x?.naimenuvanniaMistsiaDliaUkryttia || "Укриття";
      const ready = nestedName(x?.StanHotovnosti);
      const accessValue = x?.nayavnistDostupuMalomobilnykhVerstvNaselennya;
      const accessible = accessValue === true || /так|yes|наяв|доступ/i.test(String(accessValue || ""));

      out.push({
        id: "dsns:" + String(x?.id ?? x?.oblikovyyNomer ?? lat + "," + lng),
        lat, lng,
        source: "dsns",
        type: /найпрост/i.test(kind) ? "simple" : "shelter",
        name: x?.naimenuvanniaMistsiaDliaUkryttia || kind,
        address,
        city: place,
        region,
        district: nestedName(x?.Rayon),
        community: nestedName(x?.TerytorialnaHromada),
        accessible,
        hours: "",
        photo: "",
        capacity: x?.mistkistOsib ?? "",
        readiness: ready,
        registry_number: x?.oblikovyyNomer || "",
        updated_at: x?.updatedAt || null
      });
    }

    if (items.length < limit) break;
  }

  return out;
}

async function getDsnsKyivRegionIds() {
  try {
    const res = await fetch("https://shelters.dsns.gov.ua/api/v1/public/katootth/regions");
    if (!res.ok) return [];
    const raw = await res.json();
    const list = Array.isArray(raw) ? raw : Array.isArray(raw?.data) ? raw.data : [];
    return list
      .filter(r => isKyivRegionName(String(r?.name || r?.nazva || r?.imya || "")))
      .map(r => r?.id)
      .filter(v => v !== undefined && v !== null);
  } catch {
    return [];
  }
}

function nestedName(v) {
  return String(v?.imya || v?.name || v?.nazva || "").trim();
}

function isKyivRegionName(name) {
  const n = String(name || "").toLowerCase().replace(/’/g, "'");
  return n.includes("київська") || n === "м. київ" || n === "київ" || n.includes("kyiv oblast") || n === "kyiv";
}

function isKyivCityName(name) {
  const n = String(name || "").toLowerCase().trim();
  return n === "м. київ" || n === "київ" || n === "kyiv";
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
