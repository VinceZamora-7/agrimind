const fs = require("fs");
const WEATHER_CODES = {
  0: "Clear sky", 1: "Mainly clear", 2: "Partly cloudy", 3: "Overcast",
  45: "Fog", 48: "Rime fog", 51: "Light drizzle", 53: "Drizzle",
  55: "Heavy drizzle", 56: "Freezing drizzle", 57: "Heavy freezing drizzle",
  61: "Light rain", 63: "Rain", 65: "Heavy rain", 66: "Freezing rain",
  67: "Heavy freezing rain", 71: "Light snow", 73: "Snow", 75: "Heavy snow",
  77: "Snow grains", 80: "Light rain showers", 81: "Rain showers",
  82: "Heavy rain showers", 85: "Snow showers", 86: "Heavy snow showers",
  95: "Thunderstorm", 96: "Thunderstorm with hail", 99: "Severe thunderstorm with hail",
};

function createWeatherService(config) {
  let location = {
    latitude: config.weather.latitude,
    longitude: config.weather.longitude,
    name: config.weather.locationName,
    admin1: null,
    country: null,
  };
  try {
    const stored = JSON.parse(fs.readFileSync(config.weather.storePath, "utf8"));
    if (Number.isFinite(stored.latitude) && Number.isFinite(stored.longitude)) location = stored;
  } catch { /* Environment coordinates remain the fallback. */ }
  let current = {
    configured: Number.isFinite(location.latitude) && Number.isFinite(location.longitude),
    status: "waiting",
    location_name: location.name,
  };
  let timer = null;
  let pending = null;

  async function refresh() {
    if (!current.configured) {
      current = { ...current, status: "location_not_configured", error: "Set FARM_LATITUDE and FARM_LONGITUDE" };
      return current;
    }
    if (pending) return pending;
    pending = (async () => {
      const query = new URLSearchParams({
        latitude: String(location.latitude),
        longitude: String(location.longitude),
        current: "temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,rain,weather_code,cloud_cover,wind_speed_10m,wind_gusts_10m",
        hourly: "precipitation_probability",
        daily: "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum,rain_sum,et0_fao_evapotranspiration,wind_gusts_10m_max",
        timezone: "auto",
        forecast_days: "3",
      });
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), config.weather.timeoutMs);
      try {
        const response = await fetch(`https://api.open-meteo.com/v1/forecast?${query}`, { signal: controller.signal });
        if (!response.ok) throw new Error(`Weather API HTTP ${response.status}`);
        const data = await response.json();
        const hourlyIndex = (data.hourly?.time || []).findIndex((time) => time >= data.current?.time);
        const nextHours = (data.hourly?.precipitation_probability || []).slice(Math.max(0, hourlyIndex), Math.max(0, hourlyIndex) + 12);
        const rainChance12h = nextHours.length ? Math.max(...nextHours.filter(Number.isFinite)) : null;
        const code = data.current?.weather_code;
        const gust = data.current?.wind_gusts_10m;
        const todayRainChance = data.daily?.precipitation_probability_max?.[0] ?? rainChance12h;
        const todayPrecipitation = data.daily?.precipitation_sum?.[0] ?? data.daily?.rain_sum?.[0] ?? 0;
        const todayEt0 = data.daily?.et0_fao_evapotranspiration?.[0] ?? null;
        let irrigationOutlook;
        if (Number(todayRainChance) >= 60 || Number(todayPrecipitation) >= 5) {
          irrigationOutlook = { level: "hold", title: "Rain likely — hold watering", reason: `${Math.round(todayRainChance || 0)}% rain chance with ${Number(todayPrecipitation).toFixed(1)} mm expected today.` };
        } else if (Number(data.current?.apparent_temperature) >= 35 || Number(todayEt0) >= 5) {
          irrigationOutlook = { level: "high_demand", title: "Higher water demand", reason: `Hot or drying conditions are forecast with only ${Math.round(todayRainChance || 0)}% rain chance.` };
        } else {
          irrigationOutlook = { level: "normal", title: "Normal watering conditions", reason: `No substantial rain or high drying demand is forecast today.` };
        }
        current = {
          configured: true,
          status: "ready",
          provider: "Open-Meteo",
          location_name: location.name,
          location: { ...location },
          latitude: data.latitude,
          longitude: data.longitude,
          timezone: data.timezone,
          observed_at: data.current?.time,
          fetched_at: new Date().toISOString(),
          temperature_c: data.current?.temperature_2m ?? null,
          humidity_percent: data.current?.relative_humidity_2m ?? null,
          apparent_temperature_c: data.current?.apparent_temperature ?? null,
          condition: WEATHER_CODES[code] || "Unknown",
          weather_code: code ?? null,
          rain_mm: data.current?.rain ?? data.current?.precipitation ?? null,
          rain_probability_12h_percent: Number.isFinite(rainChance12h) ? rainChance12h : null,
          wind_speed_kmh: data.current?.wind_speed_10m ?? null,
          wind_gust_kmh: gust ?? null,
          cloud_cover_percent: data.current?.cloud_cover ?? null,
          irrigation_outlook: irrigationOutlook,
          daily: (data.daily?.time || []).map((date, index) => ({
            date,
            condition: WEATHER_CODES[data.daily.weather_code?.[index]] || "Unknown",
            temperature_max_c: data.daily.temperature_2m_max?.[index] ?? null,
            temperature_min_c: data.daily.temperature_2m_min?.[index] ?? null,
            rain_probability_percent: data.daily.precipitation_probability_max?.[index] ?? null,
            rain_sum_mm: data.daily.rain_sum?.[index] ?? null,
            precipitation_sum_mm: data.daily.precipitation_sum?.[index] ?? null,
            evapotranspiration_mm: data.daily.et0_fao_evapotranspiration?.[index] ?? null,
            wind_gust_kmh: data.daily.wind_gusts_10m_max?.[index] ?? null,
          })),
        };
      } catch (error) {
        current = { ...current, status: current.fetched_at ? "stale" : "error", error: error.name === "AbortError" ? "Weather request timed out" : error.message };
      } finally { clearTimeout(timeout); pending = null; }
      return current;
    })();
    return pending;
  }

  function start() {
    refresh();
    timer = setInterval(refresh, config.weather.refreshMs);
    timer.unref?.();
  }
  function stop() { if (timer) clearInterval(timer); }
  async function searchLocations(query) {
    const name = String(query || "").trim();
    if (name.length < 2 || name.length > 100) throw Object.assign(new Error("Enter at least two characters"), { status: 400 });
    const params = new URLSearchParams({ name, count: "8", language: "en", format: "json" });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.weather.timeoutMs);
    try {
      const response = await fetch(`https://geocoding-api.open-meteo.com/v1/search?${params}`, { signal: controller.signal });
      if (!response.ok) throw new Error(`Location search HTTP ${response.status}`);
      const payload = await response.json();
      return (payload.results || []).map((item) => ({
        id: item.id,
        name: item.name,
        latitude: item.latitude,
        longitude: item.longitude,
        admin1: item.admin1 || null,
        admin2: item.admin2 || null,
        country: item.country || null,
        timezone: item.timezone || null,
        label: [item.name, item.admin2, item.admin1, item.country].filter(Boolean).join(", "),
      }));
    } finally { clearTimeout(timeout); }
  }
  async function updateLocation(input) {
    const latitude = Number(input.latitude);
    const longitude = Number(input.longitude);
    if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90 || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
      throw Object.assign(new Error("Invalid farm coordinates"), { status: 400 });
    }
    location = {
      latitude,
      longitude,
      name: String(input.name || "Farm").trim().slice(0, 100) || "Farm",
      admin1: input.admin1 ? String(input.admin1).slice(0, 100) : null,
      country: input.country ? String(input.country).slice(0, 100) : null,
    };
    const temporary = `${config.weather.storePath}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(location, null, 2), { mode: 0o600 });
    fs.renameSync(temporary, config.weather.storePath);
    current = { configured: true, status: "waiting", location_name: location.name, location: { ...location } };
    await refresh();
    return current;
  }
  return { location: () => ({ ...location }), refresh, searchLocations, snapshot: () => current, start, stop, updateLocation };
}

module.exports = { createWeatherService, WEATHER_CODES };
