const { readJson, writeJsonAtomic } = require("../utils/files");

function decodeXml(value) {
  return String(value || "")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#([0-9]+);/g, (_, decimal) => String.fromCodePoint(Number(decimal)))
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}
function text(xml, tag) {
  const match = String(xml).match(new RegExp(`<(?:\\w+:)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:\\w+:)?${tag}>`, "i"));
  return match ? decodeXml(match[1].replace(/<[^>]+>/g, "").trim()) : null;
}
function blocks(xml, tag) {
  return [...String(xml).matchAll(new RegExp(`<(?:\\w+:)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:\\w+:)?${tag}>`, "gi"))].map((match) => match[1]);
}
function pointInPolygon(latitude, longitude, polygonText) {
  const points = String(polygonText || "").trim().split(/\s+/).map((pair) => pair.split(",").map(Number)).filter(([lat, lon]) => Number.isFinite(lat) && Number.isFinite(lon));
  if (points.length < 3) return false;
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [yi, xi] = points[i];
    const [yj, xj] = points[j];
    if (((yi > latitude) !== (yj > latitude)) && longitude < ((xj - xi) * (latitude - yi)) / ((yj - yi) || Number.EPSILON) + xi) inside = !inside;
  }
  return inside;
}
function parseSignal(...values) {
  const match = values.filter(Boolean).join(" ").match(/(?:TCWS|Tropical Cyclone Wind Signal|Wind Signal)\s*(?:No\.?|#)?\s*([1-5])/i);
  return match ? Number(match[1]) : null;
}
function parseCap(xml, farm = {}) {
  const info = blocks(xml, "info")[0] || "";
  const event = text(info, "event");
  const headline = text(info, "headline");
  const description = text(info, "description");
  
  const areas = blocks(info, "area").map((area) => ({
    description: text(area, "areaDesc"), polygon: text(area, "polygon"),
    geocodes: blocks(area, "geocode").map((code) => ({ name: text(code, "valueName"), value: text(code, "value") })),
  }));
  const latitude = Number(farm.latitude);
  const longitude = Number(farm.longitude);
  const locationNames = [farm.name, farm.admin1, farm.admin2].filter(Boolean).map((value) => String(value).toLowerCase());
  const matchedAreas = areas.filter((area) => {
    if (Number.isFinite(latitude) && Number.isFinite(longitude) && area.polygon && pointInPolygon(latitude, longitude, area.polygon)) return true;
    const areaName = String(area.description || "").toLowerCase();
    return areaName && locationNames.some((name) => name.length >= 3 && (areaName.includes(name) || name.includes(areaName)));
  });
  const status = text(xml, "status");
  const messageType = text(xml, "msgType");
  const expires = text(info, "expires");
  return {
    identifier: text(xml, "identifier"), status, message_type: messageType,
    category: classifyAlert(event, headline, description),
    active: status === "Actual" && messageType !== "Cancel" && (!expires || new Date(expires).getTime() > Date.now()),
    event, headline, description, instruction: text(info, "instruction"),
    urgency: text(info, "urgency"), severity: text(info, "severity"), certainty: text(info, "certainty"),
    issued_at: text(xml, "sent"), expires_at: expires,
    signal_number: parseSignal(event, headline, description, text(info, "instruction")),
    farm_affected: matchedAreas.length > 0,
    affected_areas: areas.map((area) => area.description).filter(Boolean),
    matched_areas: matchedAreas.map((area) => area.description).filter(Boolean),
  };
}
function parseAtom(xml) {
  return blocks(xml, "entry").map((entry) => {
    const link = entry.match(/<link\b[^>]*\btype=["']application\/cap\+xml["'][^>]*\bhref=["']([^"']+)["'][^>]*\/?\s*>/i)
      || entry.match(/<link\b[^>]*\bhref=["']([^"']+)["'][^>]*\btype=["']application\/cap\+xml["'][^>]*\/?\s*>/i);
    return { id: text(entry, "id"), title: text(entry, "title"), updated: text(entry, "updated"), href: link ? decodeXml(link[1]) : null };
  }).filter((entry) => entry.href);
}
function classifyAlert(...values) {
  const value = values.filter(Boolean).join(" ");
  if (/tropical cyclone|typhoon|TCWS|wind signal/i.test(value)) return "tropical_cyclone";
  if (/storm surge|gale warning|rough sea/i.test(value)) return "coastal";
  if (/thunderstorm/i.test(value)) return "thunderstorm";
  if (/flood|rainfall warning|heavy rain/i.test(value)) return "rainfall_flood";
  return "other";
}
function pageText(html) {
  return decodeXml(String(html || "").replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
}
function productSummary(html, marker) {
  const value = pageText(html);
  const index = value.toLowerCase().lastIndexOf(String(marker).toLowerCase());
  return (index >= 0 ? value.slice(index) : value).slice(0, 1800);
}
async function fetchProduct(url, marker, signal) {
  try {
    const response = await fetch(url, { signal, headers: { Accept: "text/html" } });
    if (!response.ok) throw new Error("HTTP " + response.status);
    return { status: "ready", source_url: url, fetched_at: new Date().toISOString(), summary: productSummary(await response.text(), marker), error: null };
  } catch (error) { return { status: "error", source_url: url, fetched_at: new Date().toISOString(), summary: null, error: error.message }; }
}

function createPagasaAlertService(config, getFarmLocation, onUpdate = null) {
  let timer = null;
  let pending = null;
  let products = {};
  let nextProductRefresh = 0;
  let current = readJson(config.pagasa.storePath, { enabled: config.pagasa.enabled, status: config.pagasa.enabled ? "waiting" : "disabled", provider: "DOST-PAGASA CAP", active: false, farm_affected: false, signal_number: null, alerts: [] });
  async function refresh() {
    if (!config.pagasa.enabled) return current;
    if (pending) return pending;
    pending = (async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), config.pagasa.timeoutMs);
      try {
        const feedResponse = await fetch(config.pagasa.feedUrl, { signal: controller.signal, headers: { Accept: "application/atom+xml, application/xml" } });
        if (!feedResponse.ok) throw new Error(`PAGASA feed HTTP ${feedResponse.status}`);
        const entries = parseAtom(await feedResponse.text()).filter((entry) => /flood|rain|thunder|tropical|cyclone|typhoon|TCWS|wind signal|gale|storm surge|\bGFA\b|\bHRA\b|\bRFW\b|\bTSA\b/i.test(entry.title || "")).slice(0, config.pagasa.maxEntries);
        const farm = getFarmLocation?.() || {};
        if (Date.now() >= nextProductRefresh) {
          const base = "https://www.pagasa.dost.gov.ph";
          const [farmWeather, tenDay, enso] = await Promise.all([
            fetchProduct(base + "/agri-weather", "Farm Weather Forecast", controller.signal),
            fetchProduct(base + "/ten-day-regional-agri-weather", "10 - Day Regional Agri-Weather", controller.signal),
            fetchProduct(base + "/climate/el-nino-la-nina/monitoring", "El Niño", controller.signal),
          ]);
          products = { farm_weather: farmWeather, ten_day_outlook: tenDay, enso_advisory: enso };
          nextProductRefresh = Date.now() + 6 * 60 * 60 * 1000;
        }
        const capAlerts = await Promise.all(entries.map(async (entry) => {
          try {
            const response = await fetch(entry.href, { signal: controller.signal, headers: { Accept: "application/cap+xml, application/xml" } });
            if (!response.ok) return null;
            const parsed = parseCap(await response.text(), farm);
            return parsed ? { ...parsed, source_url: entry.href } : null;
          } catch { return null; }
        }));
        const activeAlerts = capAlerts.filter((alert) => alert?.active);
        const affected = activeAlerts.filter((alert) => alert.farm_affected);
        const cycloneAlerts = activeAlerts.filter((alert) => alert.category === "tropical_cyclone");
        const affectedCyclones = cycloneAlerts.filter((alert) => alert.farm_affected);
        const strongest = [...affectedCyclones].sort((a, b) => (b.signal_number || 0) - (a.signal_number || 0))[0] || null;
        const next = { enabled: true, status: "ready", provider: "DOST-PAGASA CAP", source_url: config.pagasa.feedUrl, fetched_at: new Date().toISOString(), active: cycloneAlerts.length > 0, farm_affected: affectedCyclones.length > 0, signal_number: strongest?.signal_number ?? null, cyclone_name: strongest?.headline || affectedCyclones[0]?.event || cycloneAlerts[0]?.headline || null, current_alert: strongest || affectedCyclones[0] || null, alerts: activeAlerts.slice(0, 50), affected_alerts: affected.slice(0, 50), alert_groups: { rainfall_flood: affected.filter((alert) => alert.category === "rainfall_flood"), thunderstorm: affected.filter((alert) => alert.category === "thunderstorm"), coastal: affected.filter((alert) => alert.category === "coastal"), tropical_cyclone: affectedCyclones }, products, error: null };
        const changed = JSON.stringify([current.current_alert?.identifier, current.signal_number, current.farm_affected, (current.affected_alerts || []).map((alert) => alert.identifier), current.products]) !== JSON.stringify([next.current_alert?.identifier, next.signal_number, next.farm_affected, next.affected_alerts.map((alert) => alert.identifier), next.products]);
        current = next;
        writeJsonAtomic(config.pagasa.storePath, current);
        if (changed) await onUpdate?.(current);
      } catch (error) {
        current = { ...current, status: current.fetched_at ? "stale" : "error", error: error.name === "AbortError" ? "PAGASA request timed out" : error.message };
      } finally { clearTimeout(timeout); pending = null; }
      return current;
    })();
    return pending;
  }
  function start() { refresh(); timer = setInterval(refresh, config.pagasa.refreshMs); timer.unref?.(); }
  function stop() { if (timer) clearInterval(timer); timer = null; }
  return { refresh, snapshot: () => current, start, stop };
}
module.exports = { classifyAlert, createPagasaAlertService, decodeXml, pageText, parseAtom, parseCap, parseSignal, pointInPolygon, productSummary };
