const { readJson, writeJsonAtomic } = require("../utils/files");
function createWeatherSimulatorClient(config, onEvents = null) {
  let timer = null, pending = null;
  let current = { enabled: config.weatherSimulator.enabled, status: config.weatherSimulator.enabled ? "waiting" : "disabled", source_url: config.weatherSimulator.url || null, typhoon: { active: false }, heat: { active: false }, rain: { active: false }, daily: { active: false } };
  let processed = readJson(config.weatherSimulator.storePath, { typhoon: null, heat: null, rain: null, daily: null });
  async function refresh() {
    if (!config.weatherSimulator.enabled || !config.weatherSimulator.url) return current;
    if (pending) return pending;
    pending = (async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), config.weatherSimulator.timeoutMs);
      try {
        const response = await fetch(config.weatherSimulator.url.replace(/\/$/, "") + "/api/state", { signal: controller.signal });
        if (!response.ok) throw new Error("Simulator HTTP " + response.status);
        const state = await response.json();
        const events = [];
        for (const type of ["typhoon", "heat", "rain", "daily"]) {
          const event = state[type] || { active: false };
          if (event.active && event.event_id && processed[type] !== event.event_id) {
            processed[type] = event.event_id;
            events.push({ type, ...event });
          }
        }
        const changed = current.updated_at !== (state.updated_at || null);
        current = { enabled: true, status: "online", test_mode: true, source_url: config.weatherSimulator.url, fetched_at: new Date().toISOString(), updated_at: state.updated_at || null, typhoon: state.typhoon || { active: false }, heat: state.heat || { active: false }, rain: state.rain || { active: false }, daily: state.daily || { active: false }, error: null };
        if (events.length) writeJsonAtomic(config.weatherSimulator.storePath, processed);
        if (changed) await onEvents?.(events, current);
      } catch (error) { current = { ...current, status: current.fetched_at ? "stale" : "offline", error: error.name === "AbortError" ? "Simulator request timed out" : error.message }; }
      finally { clearTimeout(timeout); pending = null; }
      return current;
    })();
    return pending;
  }
  function start() { refresh(); timer = setInterval(refresh, config.weatherSimulator.pollMs); timer.unref?.(); }
  function stop() { if (timer) clearInterval(timer); timer = null; }
  return { refresh, snapshot: () => current, start, stop };
}
module.exports = { createWeatherSimulatorClient };
