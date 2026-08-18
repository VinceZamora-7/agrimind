const http = require("http");
const { ensureDirectories } = require("./utils/files");
const { createEventStore } = require("./events/eventStore");
const { createQuotaGate } = require("./ai/quotaGate");
const { createGeminiClassifier } = require("./ai/geminiClassifier");
const { createGeminiPlantAnalyzer } = require("./ai/geminiPlantAnalyzer");
const { createSlaveStore } = require("./plants/slaveStore");
const { createSlavePairingService } = require("./plants/slavePairingService");
const { createWeatherService } = require("./weather/weatherService");
const { createPagasaAlertService } = require("./weather/pagasaAlertService");
const { createWeatherSimulatorClient } = require("./weather/weatherSimulatorClient");
const { createEnvironmentSensor } = require("./hardware/environmentSensor");
const { createSemaphoreSms } = require("./alerts/semaphoreSms");
const { createExpoPush } = require("./alerts/expoPush");
const { createEventService } = require("./events/eventService");
const { createDetector } = require("./events/detector");
const { createCaptureRetention } = require("./events/captureRetention");
const { createCloudSync } = require("./cloud/cloudSync");
const { createWebSocketHub } = require("./realtime/webSocketHub");
const { createPairingService } = require("./pairing/pairingService");
const { createRouter } = require("./api/router");
const { sendJson } = require("./api/responses");

function getLocalIps() {
  const ips = [];
  const interfaces = require("os").networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const net of interfaces[name] || []) {
      if (net.family === "IPv4" && !net.internal) {
        ips.push(net.address);
      }
    }
  }
  return ips;
}

function evaluateZoneEnvironment(environment, profiles, tracker) {
  const zones = [];
  for (const slaveId of ["slave-1", "slave-2"]) {
    const profile = profiles?.[slaveId];
    if (!profile) { zones.push({ slave_id: slaveId, status: "not_configured", capture_recommended: false, issues: [] }); continue; }
    if (environment?.status !== "online" || !Number.isFinite(environment.temperature_c) || !Number.isFinite(environment.humidity_percent)) {
      zones.push({ slave_id: slaveId, crop: profile.crop, status: "sensor_unavailable", capture_recommended: false, issues: [] }); continue;
    }
    const temperatureIssues = [];
    const humidityIssues = [];
    if (environment.temperature_c < profile.temperature_min) temperatureIssues.push({ type: "temperature_low", current: environment.temperature_c, threshold: profile.temperature_min });
    if (environment.temperature_c > profile.temperature_max) temperatureIssues.push({ type: "temperature_high", current: environment.temperature_c, threshold: profile.temperature_max });
    if (environment.humidity_percent < profile.humidity_min) humidityIssues.push({ type: "humidity_low", current: environment.humidity_percent, threshold: profile.humidity_min });
    if (environment.humidity_percent > profile.humidity_max) humidityIssues.push({ type: "humidity_high", current: environment.humidity_percent, threshold: profile.humidity_max });
    const abnormal = temperatureIssues.length > 0 && humidityIssues.length > 0;
    const issues = abnormal ? [...temperatureIssues, ...humidityIssues] : [];
    const previous = tracker[slaveId] || { status: "monitoring", abnormal: 0, normal: 0 };
    const next = {
      status: abnormal && previous.abnormal + 1 >= 3 ? "needs_inspection" : !abnormal && previous.normal + 1 >= 3 ? "normal" : previous.status,
      abnormal: abnormal ? previous.abnormal + 1 : 0, normal: abnormal ? 0 : previous.normal + 1,
    };
    tracker[slaveId] = next;
    zones.push({ slave_id: slaveId, crop: profile.crop, status: next.status, capture_recommended: next.status === "needs_inspection", issues, temperature_c: environment.temperature_c, humidity_percent: environment.humidity_percent, evaluated_at: new Date().toISOString(), confirmations: abnormal ? next.abnormal : next.normal });
  }
  return zones;
}

function createApp({ config, camera, pir, startDetector }) {
  ensureDirectories(config);
  const zoneEnvironmentTracker = {};
  const state = { zoneEnvironmentStatus: [], detectionEnabled: true, isCapturing: false, pirState: 0, pirArmed: true, pirLowSince: null, pirLastRearmedAt: null, lastEventAt: 0, suppressedTriggers: 0, lastHardwareError: null, retentionLastRun: null, retentionDeletedFiles: 0, retentionReclaimedBytes: 0 };
  const store = createEventStore(config);
  const quotaGate = createQuotaGate(config, store.usagePath);
  const classifier = createGeminiClassifier(config, quotaGate);
  const plantAnalyzer = createGeminiPlantAnalyzer(config, quotaGate);
  const slaveStore = createSlaveStore(config);
  const slavePairing = createSlavePairingService(config);
  const weather = createWeatherService(config);
  const cloudSync = createCloudSync(config);
  const environmentSensor = createEnvironmentSensor(config);
  const pairing = createPairingService(config);
  const push = createExpoPush({ config, pairing, historyPath: require("path").join(config.logsDir, "push-alerts.json") });
  const alerts = createSemaphoreSms(config, store.alertUsagePath, push);
  const realtime = createWebSocketHub(config, pairing);
  const pagasa = createPagasaAlertService(config, () => weather.location(), async (snapshot) => {
    realtime.broadcast("pagasa_alert_updated", { pagasa: snapshot });
    if (snapshot.farm_affected && snapshot.current_alert) {
      const signal = snapshot.signal_number ? "SIGNAL NUMBER: " + snapshot.signal_number : "TROPICAL CYCLONE WARNING";
      const farmName = weather.snapshot().location_name || weather.location().name || "Agrimind Farm";
      const message = "AGRIMIND TYPHOON ADVISORY\n" + signal + " | Lugar: " + farmName;
      await alerts.sendCategory("TYPHOON_POSSIBLE", message, { pagasa_identifier: snapshot.current_alert.identifier, signal_number: snapshot.signal_number, affected_areas: snapshot.current_alert.matched_areas }, { queueOnCooldown: true, queueOnFailure: true, queueKey: snapshot.current_alert.identifier || "pagasa" });
    }
  });
  const weatherSimulator = createWeatherSimulatorClient(config, async (events, simulatorSnapshot) => {
    const farmName = weather.snapshot().location_name || weather.location().name || "Agrimind Farm";
    for (const event of events) {
      if (event.type === "typhoon") {
        await alerts.sendCategory("TYPHOON_POSSIBLE", "AGRIMIND TYPHOON ADVISORY\n" + String(event.typhoon_name || "UNNAMED TYPHOON").toUpperCase() + "\nSIGNAL NUMBER: " + event.signal_number + " | Lugar: " + farmName + "\nAGRIMIND SIMULATION/DRILL", { simulated: true, simulator_event_id: event.event_id, signal_number: event.signal_number, typhoon_name: event.typhoon_name || null }, { force: true, queueOnFailure: true, queueKey: event.event_id });
      } else if (event.type === "heat") {
        await alerts.sendCategory("HEAT_INDEX_HIGH", "AGRIMIND EXTREME HEAT ADVISORY\nHEAT INDEX: " + event.heat_index_c + "C\nLugar: " + farmName + "\nAGRIMIND SIMULATION/DRILL", { simulated: true, simulator_event_id: event.event_id, heat_index_c: event.heat_index_c }, { force: true, queueOnFailure: true, queueKey: event.event_id });
      } else if (event.type === "rain") {
        const chance = Math.max(0, Math.min(100, Math.round(Number(event.rain_probability_percent) || 0)));
        const intensity = chance <= 20 ? "None/Negligible" : chance <= 50 ? "Light/Scattered" : chance <= 70 ? "Moderate" : "Heavy";
        await alerts.sendCategory("RAIN_FORECAST_HIGH", "AGRIMIND RAIN FORECAST ADVISORY\nCHANCE OF RAIN: " + chance + "% (" + intensity + ") | Lugar: " + farmName + "\nAGRIMIND SIMULATION/DRILL", { simulated: true, simulator_event_id: event.event_id, rain_probability_percent: chance }, { force: true, queueOnFailure: true, queueKey: event.event_id });
      } else if (event.type === "daily") {
        await alerts.sendCategory("DAILY_WEATHER", "AGRIMIND DAILY FORECAST ADVISORY\nSUMMARY: " + event.summary + " | Lugar: " + farmName + "\nAGRIMIND SIMULATION/DRILL", { simulated: true, simulator_event_id: event.event_id, summary: event.summary }, { force: true, queueOnFailure: true, queueKey: event.event_id });
      }
    }
    realtime.broadcast("weather_simulator_updated", { weather_simulator: simulatorSnapshot });
    await cloudSync.syncFarmStatus({ local_environment: environmentSensor.snapshot(), weather: weather.snapshot(), pagasa: pagasa.snapshot(), weather_simulator: simulatorSnapshot, zone_environment_status: state.zoneEnvironmentStatus });
  });
  const eventService = createEventService({ config, store, camera, classifier, alerts, cloudSync, realtime, state });
  const detector = createDetector({ config, pir, eventService, realtime, state });
  const retention = createCaptureRetention(config, state);
  const router = createRouter({ config, store, eventService, state, quotaGate, alerts, cloudSync, pairing, realtime, plantAnalyzer, slaveStore, slavePairing, weather, pagasa, weatherSimulator, environmentSensor, camera });
  const server = http.createServer(async (req, res) => {
    try { await router.route(req, res); }
    catch (error) { console.error(error); if (!res.headersSent) sendJson(res, 500, { ok: false, error: "Internal server error" }); else res.destroy(); }
  });
  realtime.setSnapshotProvider(router.status);
  realtime.attach(server);
  function listen() {
    server.listen(config.port, config.host, () => {
      console.log(`${config.appName} running at http://${config.host}:${config.port}`);
      console.log(`Analysis mode: ${config.analysisMode}; Gemini enabled: ${config.gemini.enabled}; Semaphore enabled: ${config.semaphore.enabled}; Cloud sync enabled: ${config.cloud.enabled}`);
      retention.start();
      weather.start();
      pagasa.start();
      weatherSimulator.start();
      let farmStatusSyncPromise = null;
      const syncFarmStatus = () => {
        if (farmStatusSyncPromise) return farmStatusSyncPromise;
        const localEnvironment = environmentSensor.snapshot();
        const previousZoneStatus = new Map(state.zoneEnvironmentStatus.map((zone) => [zone.slave_id, zone]));
        state.zoneEnvironmentStatus = evaluateZoneEnvironment(localEnvironment, alerts.rules().crop_profiles, zoneEnvironmentTracker);
        for (const zone of state.zoneEnvironmentStatus) {
          if (zone.capture_recommended && !previousZoneStatus.get(zone.slave_id)?.capture_recommended) {
            void alerts.evaluateReading({
              slave_id: zone.slave_id,
              display_name: zone.crop || zone.slave_id,
              sensor_on: true,
              temperature_c: zone.temperature_c,
              humidity_percent: zone.humidity_percent,
            }).catch((error) => console.error("Plant alert evaluation:", error.message));
          }
        }
        realtime.broadcast("zone_environment_updated", { zone_environment_status: state.zoneEnvironmentStatus });

        farmStatusSyncPromise = cloudSync.syncFarmStatus({
          detection_enabled: state.detectionEnabled,
          local_ips: getLocalIps(),
          local_environment: localEnvironment,
          weather: weather.snapshot(),
          pagasa: pagasa.snapshot(),
          weather_simulator: weatherSimulator.snapshot(),
          zone_environment_status: state.zoneEnvironmentStatus,
        })
          .then((res) => {
            if (res && Array.isArray(res.pending_commands)) {
              for (const cmd of res.pending_commands) {
                if (cmd.type === "manual_trigger") {
                  void eventService.capture("manual_trigger").then((evt) => evt && cloudSync.sync(evt));
                } else if (cmd.type === "detection_on") {
                  state.detectionEnabled = true;
                  realtime.broadcast("detection_changed", { detection_enabled: true });
                } else if (cmd.type === "detection_off") {
                  state.detectionEnabled = false;
                  realtime.broadcast("detection_changed", { detection_enabled: false });
                }
              }
            }
            return res;
          })
          .finally(() => { farmStatusSyncPromise = null; });
        return farmStatusSyncPromise;
      };
      environmentSensor.start((localEnvironment) => {
        realtime.broadcast("environment_updated", { local_environment: localEnvironment });
        void syncFarmStatus();
      });
      setTimeout(syncFarmStatus, 5000).unref?.();
      state.farmStatusSyncTimer = setInterval(syncFarmStatus, 30_000);
      state.farmStatusSyncTimer.unref?.();
      alerts.start({ weather, slaveStore });
      Promise.resolve(camera.initialize?.()).catch((error) => console.error("Camera initialization failed:", error));
      if (startDetector) detector.start().catch((error) => { state.lastHardwareError = error.message; console.error("Detector failed:", error); });
    });
  }
  server.on("close", () => { weather.stop(); pagasa.stop(); weatherSimulator.stop(); environmentSensor.stop(); alerts.stop(); if (state.farmStatusSyncTimer) clearInterval(state.farmStatusSyncTimer); });
  return { server, listen, detector, retention, realtime, state, eventService, store, router, weather, pagasa, weatherSimulator, environmentSensor };
}
module.exports = { createApp, evaluateZoneEnvironment };
