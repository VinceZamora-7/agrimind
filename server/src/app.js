const http = require("http");
const { ensureDirectories } = require("./utils/files");
const { createEventStore } = require("./events/eventStore");
const { createQuotaGate } = require("./ai/quotaGate");
const { createGeminiClassifier } = require("./ai/geminiClassifier");
const { createGeminiPlantAnalyzer } = require("./ai/geminiPlantAnalyzer");
const { createSlaveStore } = require("./plants/slaveStore");
const { createSlavePairingService } = require("./plants/slavePairingService");
const { createWeatherService } = require("./weather/weatherService");
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

function createApp({ config, camera, pir, startDetector }) {
  ensureDirectories(config);
  const state = { detectionEnabled: true, isCapturing: false, pirState: 0, pirArmed: true, pirLowSince: null, pirLastRearmedAt: null, lastEventAt: 0, suppressedTriggers: 0, lastHardwareError: null, retentionLastRun: null, retentionDeletedFiles: 0, retentionReclaimedBytes: 0 };
  const store = createEventStore(config);
  const quotaGate = createQuotaGate(config, store.usagePath);
  const classifier = createGeminiClassifier(config, quotaGate);
  const plantAnalyzer = createGeminiPlantAnalyzer(config, quotaGate);
  const slaveStore = createSlaveStore(config);
  const slavePairing = createSlavePairingService(config);
  const weather = createWeatherService(config);
  const cloudSync = createCloudSync(config);
  const pairing = createPairingService(config);
  const push = createExpoPush({ config, pairing, historyPath: require("path").join(config.logsDir, "push-alerts.json") });
  const alerts = createSemaphoreSms(config, store.alertUsagePath, push);
  const realtime = createWebSocketHub(config, pairing);
  const eventService = createEventService({ config, store, camera, classifier, alerts, cloudSync, realtime, state });
  const detector = createDetector({ config, pir, eventService, realtime, state });
  const retention = createCaptureRetention(config, state);
  const router = createRouter({ config, store, eventService, state, quotaGate, alerts, cloudSync, pairing, realtime, plantAnalyzer, slaveStore, slavePairing, weather, camera });
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
      alerts.start({ weather, slaveStore });
      Promise.resolve(camera.initialize?.()).catch((error) => console.error("Camera initialization failed:", error));
      if (startDetector) detector.start().catch((error) => { state.lastHardwareError = error.message; console.error("Detector failed:", error); });
    });
  }
  server.on("close", () => { weather.stop(); alerts.stop(); });
  return { server, listen, detector, retention, realtime, state, eventService, store, router, weather };
}
module.exports = { createApp };
