const fs = require("fs");
const path = require("path");
const { sendJson, sendText } = require("./responses");

function contentType(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  return { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".svg": "image/svg+xml" }[extension] || "application/octet-stream";
}

function bearer(req) {
  const value = req.headers.authorization || "";
  return value.startsWith("Bearer ") ? value.slice(7) : req.headers["x-api-key"] || "";
}

function readJsonBody(req, maximumBytes = 16_384) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maximumBytes) return reject(Object.assign(new Error("Request is too large"), { status: 413 }));
      chunks.push(chunk);
    });
    req.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
      catch { reject(Object.assign(new Error("Invalid JSON"), { status: 400 })); }
    });
    req.on("error", reject);
  });
}

function legacySlaveTelemetry(url) {
  const rawId = String(url.searchParams.get("slaveid") || "").trim().toLowerCase();
  const slaveId = /^[1-9][0-9]*$/.test(rawId) ? `slave-${rawId}` : rawId;
  if (!/^slave-[1-9][0-9]*$/.test(slaveId)) {
    throw Object.assign(new Error("Use slaveid=1, slaveid=2, or slaveid=slave-1"), { status: 400 });
  }
  const moisture = Number(url.searchParams.get("soilmoisture"));
  if (!Number.isFinite(moisture) || moisture < 0 || moisture > 100) {
    throw Object.assign(new Error("soilmoisture must be between 0 and 100"), { status: 400 });
  }
  const relay = String(url.searchParams.get("relay") || "0").toLowerCase();
  if (!["0", "1", "false", "true", "off", "on"].includes(relay)) {
    throw Object.assign(new Error("relay must be 0, 1, false, true, off, or on"), { status: 400 });
  }
  const sensor = String(url.searchParams.get("sensor") || "1").toLowerCase();
  return {
    slaveId,
    reading: {
      soil_moisture_percent: moisture,
      pump_on: ["1", "true", "on"].includes(relay),
      sensor_on: !["0", "false", "off"].includes(sensor),
    },
  };
}

function plantAnalysisError(error, requestId) {
  const code = error.code || (error.status === 413 ? "image_too_large" : error.status === 400 ? "invalid_request" : error.status === 503 ? "gemini_unavailable" : "plant_analysis_failed");
  const messages = {
    minimum_interval: "Gemini is cooling down after a recent analysis.",
    hourly_quota: "The hourly Gemini request limit has been reached.",
    daily_quota: "The daily Gemini request limit has been reached.",
    daily_budget: "The configured daily Gemini budget has been reached.",
    gemini_disabled: "Gemini analysis is disabled.",
    gemini_key_missing: "The Gemini API key is not configured.",
    gemini_unavailable: "Gemini analysis is not configured or currently unavailable.",
    gemini_timeout: "Gemini took too long to respond.",
    image_too_large: "The plant image is too large to upload.",
    invalid_request: error.message,
    plant_analysis_failed: "Gemini could not analyze the plant image.",
  };
  return {
    ok: false,
    error: messages[code] || messages.plant_analysis_failed,
    code,
    detail: ["plant_analysis_failed", "gemini_timeout"].includes(code) ? error.message : undefined,
    retry_after_seconds: error.retry_after_seconds,
    retry_at: error.retry_at,
    breadcrumb: {
      request_id: requestId,
      operation: "plant_analysis",
      reason: code,
      timestamp: new Date().toISOString(),
    },
  };
}

function createRouter({ config, store, eventService, state, quotaGate, alerts, cloudSync, pairing, realtime, plantAnalyzer, slaveStore, slavePairing, weather, camera }) {
  function authenticate(req) {
    const token = bearer(req);
    if (config.apiToken && token === config.apiToken) return { authorized: true, client: { client_id: "legacy_api", role: "admin" } };
    const client = pairing.authorize(token);
    if (client) return { authorized: true, client };
    return { authorized: !config.pairing.enforceAuth, client: null };
  }
  function status() {
    const latest = eventService.sanitize(store.latest());
    return {
      app: config.appName, mode: config.mode, server_time: new Date().toISOString(),
      detection_enabled: state.detectionEnabled, is_capturing: state.isCapturing,
      analysis_mode: config.analysisMode,
      protections: {
        debounce_readings: config.pir.debounceReadings,
        rearm_low_seconds: config.pir.rearmLowMs / 1000,
        cooldown_seconds: config.pir.cooldownMs / 1000,
        grouping_seconds: config.pir.groupingMs / 1000,
        duplicate_detection_enabled: config.duplicate.enabled,
        suppressed_triggers: state.suppressedTriggers,
      },
      retention: {
        capture_hours: config.retention.captureMs / 3_600_000,
        cleanup_interval_minutes: config.retention.cleanupIntervalMs / 60_000,
        last_cleanup: state.retentionLastRun,
        deleted_files_since_start: state.retentionDeletedFiles,
        reclaimed_bytes_since_start: state.retentionReclaimedBytes,
      },
      pir: { gpio_chip: config.pir.chip, gpio_line: config.pir.line, previous_state: state.pirState, armed: state.pirArmed, low_since: state.pirLowSince, last_rearmed_at: state.pirLastRearmedAt, last_error: state.lastHardwareError },
      camera: camera.status ? camera.status() : { configured_device: config.camera.device, active_device: config.camera.device, resolution: config.camera.resolution, burst_count: config.camera.burstCount },
      gemini: quotaGate.status(), semaphore: alerts.status(), cloud: cloudSync.status(),
      realtime: { websocket_path: "/ws", connected_clients: realtime.connectedClients() },
      pairing: pairing.info(),
      latest_event: latest, recent_images: store.images(12), recent_events: store.list(10).map(eventService.sanitize),
      slaves: slaveStore.list(),
      weather: weather.snapshot(),
    };
  }

  async function route(req, res) {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    if (req.method === "OPTIONS") return sendJson(res, 204, {});
    if (req.method === "GET" && url.pathname === "/api/slave-telemetry") {
      try {
        const parsed = legacySlaveTelemetry(url);
        const reading = slaveStore.update(parsed.slaveId, parsed.reading);
        realtime.broadcast("slave_telemetry", { reading });
        alerts.evaluateReading(reading).catch((error) => console.error("Plant alert evaluation:", error.message));
        return sendJson(res, 200, { ok: true, accepted_via: "get_compatibility", reading });
      } catch (error) { return sendJson(res, error.status || 500, { ok: false, error: error.message }); }
    }
    const telemetryMatch = url.pathname.match(/^\/api\/slaves\/(slave-[1-9][0-9]*)\/telemetry$/);
    if (req.method === "POST" && telemetryMatch) {
      const validEsp = (config.slaves.apiToken && bearer(req) === config.slaves.apiToken)
        || slavePairing.authorize(telemetryMatch[1], bearer(req));
      const normalAuth = Boolean(authenticate(req).client);
      if (!validEsp && !normalAuth) return sendJson(res, 401, { ok: false, error: "ESP8266 authentication required" });
      try {
        const reading = slaveStore.update(telemetryMatch[1], await readJsonBody(req));
        realtime.broadcast("slave_telemetry", { reading });
        alerts.evaluateReading(reading).catch((error) => console.error("Plant SMS evaluation:", error.message));
        return sendJson(res, 200, { ok: true, reading });
      } catch (error) { return sendJson(res, error.status || 500, { ok: false, error: error.message }); }
    }
    if (req.method === "POST" && url.pathname === "/api/slaves/pairing/claim") {
      try {
        const credentials = slavePairing.claim(await readJsonBody(req));
        slaveStore.updateName(credentials.slave_id, credentials.display_name);
        realtime.broadcast("slave_paired", { slave_id: credentials.slave_id, display_name: credentials.display_name });
        return sendJson(res, 201, { ok: true, credentials });
      } catch (error) { return sendJson(res, error.status || 500, { ok: false, error: error.status ? error.message : "Slave pairing failed" }); }
    }
    if (req.method === "GET" && url.pathname === "/api/pairing/info") return sendJson(res, 200, pairing.info());
    if (req.method === "POST" && url.pathname === "/api/pairing/claim") {
      try {
        const credentials = pairing.claim(await readJsonBody(req));
        return sendJson(res, 201, { ok: true, credentials });
      } catch (error) {
        return sendJson(res, error.status || 500, { ok: false, error: error.status ? error.message : "Pairing failed" });
      }
    }
    const authentication = authenticate(req);
    if (!authentication.authorized) return sendJson(res, 401, { ok: false, error: "Pairing required" });
    if (req.method === "POST" && url.pathname === "/api/pairing/window") {
      try {
        const body = await readJsonBody(req).catch(() => ({}));
        const pairingOpenUntil = pairing.openWindow(authentication.client, body.seconds);
        realtime.broadcast("pairing_window_changed", { pairable: true, pairing_open_until: pairingOpenUntil });
        return sendJson(res, 200, { ok: true, pairing_open_until: pairingOpenUntil });
      } catch (error) { return sendJson(res, error.status || 500, { ok: false, error: error.message }); }
    }
    if (req.method === "DELETE" && url.pathname === "/api/pairing/window") {
      try {
        pairing.closeWindow(authentication.client);
        realtime.broadcast("pairing_window_changed", { pairable: false, pairing_open_until: null });
        return sendJson(res, 200, { ok: true });
      } catch (error) { return sendJson(res, error.status || 500, { ok: false, error: error.message }); }
    }
    if (req.method === "GET" && url.pathname === "/api/paired-devices") {
      if (authentication.client?.role !== "admin") return sendJson(res, 403, { ok: false, error: "Administrator access required" });
      return sendJson(res, 200, pairing.list());
    }
    if (req.method === "PUT" && url.pathname === "/api/push-token") {
      try {
        const registered = pairing.registerPushToken(authentication.client?.client_id, await readJsonBody(req));
        return sendJson(res, 200, { ok: true, ...registered });
      } catch (error) { return sendJson(res, error.status || 500, { ok: false, error: error.message }); }
    }
    const revokeMatch = url.pathname.match(/^\/api\/paired-devices\/(client_[A-Za-z0-9]+)$/);
    if (req.method === "DELETE" && revokeMatch) {
      try {
        const revoked = pairing.revoke(revokeMatch[1], authentication.client);
        return sendJson(res, revoked ? 200 : 404, revoked ? { ok: true } : { ok: false, error: "Paired device not found" });
      } catch (error) { return sendJson(res, error.status || 500, { ok: false, error: error.message }); }
    }
    if (req.method === "GET" && url.pathname === "/api/status") return sendJson(res, 200, status());
    if (req.method === "GET" && url.pathname === "/api/events") return sendJson(res, 200, store.list(30).map(eventService.sanitize));
    if (req.method === "GET" && url.pathname === "/api/images") return sendJson(res, 200, store.images(50));
    if (req.method === "GET" && url.pathname === "/api/slaves") return sendJson(res, 200, { slaves: slaveStore.list() });
    if (req.method === "GET" && url.pathname === "/api/slaves/paired") {
      if (authentication.client?.role !== "admin") return sendJson(res, 403, { ok: false, error: "Administrator access required" });
      return sendJson(res, 200, { devices: slavePairing.list() });
    }
    if (req.method === "POST" && url.pathname === "/api/slaves/pairing/window") {
      if (authentication.client?.role !== "admin") return sendJson(res, 403, { ok: false, error: "Administrator access required" });
      try {
        const body = await readJsonBody(req);
        const session = slavePairing.openWindow(body.slave_id, body.display_name);
        const requestUrl = `http://${req.headers.host || `orangepione.local:${config.port}`}`;
        const serverUrls = [...new Set([requestUrl, ...config.pairing.localUrls])];
        return sendJson(res, 201, { ok: true, session: { ...session, orange_pi_urls: serverUrls } });
      } catch (error) { return sendJson(res, error.status || 500, { ok: false, error: error.message }); }
    }
    if (req.method === "GET" && url.pathname === "/api/alerts/history") return sendJson(res, 200, { alerts: alerts.history(Number(url.searchParams.get("limit")) || 50) });
    if (req.method === "GET" && url.pathname === "/api/alerts/balance") {
      try { return sendJson(res, 200, { ok: true, balance: await alerts.balance() }); }
      catch (error) { return sendJson(res, error.status || 502, { ok: false, error: error.message }); }
    }
    if (req.method === "POST" && url.pathname === "/api/alerts/test-sms") {
      if (authentication.client?.role !== "admin") return sendJson(res, 403, { ok: false, error: "Administrator access required" });
      try {
        const body = await readJsonBody(req).catch(() => ({}));
        const result = await alerts.sendCategory("TEST_SMS", String(body.message || "AGRIMIND SMS CHECK\nYour farm alert connection is working."), { requested_by: authentication.client?.client_id || "legacy_admin" }, { force: true });
        return sendJson(res, result.sent ? 200 : 409, { ok: result.sent, result, error: result.sent ? undefined : result.skip_reason });
      } catch (error) { return sendJson(res, error.status || 502, { ok: false, error: error.message }); }
    }
    if (req.method === "GET" && url.pathname === "/api/settings/alert-recipients") return sendJson(res, 200, { recipients: alerts.recipients() });
    if (req.method === "POST" && url.pathname === "/api/settings/alert-recipients") {
      if (authentication.client?.role !== "admin") return sendJson(res, 403, { ok: false, error: "Administrator access required" });
      try { const saved = alerts.updateRecipients((await readJsonBody(req)).recipients); return sendJson(res, 200, { ok: true, recipients: saved.recipients }); }
      catch (error) { return sendJson(res, error.status || 500, { ok: false, error: error.message }); }
    }
    if (req.method === "GET" && url.pathname === "/api/rules/alert-thresholds") return sendJson(res, 200, { ...alerts.rules(), typhoon_source: { connected: false, provider: null, note: "Official PAGASA advisory adapter not connected" } });
    if (req.method === "POST" && url.pathname === "/api/rules/alert-thresholds") {
      if (authentication.client?.role !== "admin") return sendJson(res, 403, { ok: false, error: "Administrator access required" });
      try { return sendJson(res, 200, { ok: true, rules: alerts.updateRules(await readJsonBody(req)) }); }
      catch (error) { return sendJson(res, error.status || 500, { ok: false, error: error.message }); }
    }
    if (req.method === "GET" && url.pathname === "/api/weather/daily") { await weather.refresh(); return sendJson(res, 200, { weather: weather.snapshot(), daily: weather.snapshot().daily || [] }); }
    if (req.method === "POST" && url.pathname === "/api/weather/send-daily-sms") {
      if (authentication.client?.role !== "admin") return sendJson(res, 403, { ok: false, error: "Administrator access required" });
      try { const snapshot = await weather.refresh(); return sendJson(res, 200, { ok: true, results: await alerts.evaluateWeather(snapshot, { daily: true }) }); }
      catch (error) { return sendJson(res, error.status || 502, { ok: false, error: error.message }); }
    }
    if (req.method === "GET" && url.pathname === "/api/sensors/status") return sendJson(res, 200, { sensors: slaveStore.list().map((reading) => ({ ...reading, offline: !reading.received_at || Date.now() - new Date(reading.received_at) >= config.semaphore.sensorOfflineMs })) });
    const slaveSettingsMatch = url.pathname.match(/^\/api\/slaves\/(slave-[1-9][0-9]*)$/);
    if (req.method === "PUT" && slaveSettingsMatch) {
      if (authentication.client?.role !== "admin") return sendJson(res, 403, { ok: false, error: "Administrator access required" });
      try {
        const body = await readJsonBody(req);
        const slave = slaveStore.updateName(slaveSettingsMatch[1], body.display_name);
        realtime.broadcast("slave_updated", { slave });
        return sendJson(res, 200, { ok: true, slave });
      } catch (error) { return sendJson(res, error.status || 500, { ok: false, error: error.message }); }
    }
    if (req.method === "GET" && url.pathname === "/api/weather") {
      await weather.refresh();
      return sendJson(res, 200, weather.snapshot());
    }
    if (req.method === "GET" && url.pathname === "/api/weather/locations") {
      try {
        return sendJson(res, 200, { results: await weather.searchLocations(url.searchParams.get("q")) });
      } catch (error) { return sendJson(res, error.status || 502, { ok: false, error: error.message }); }
    }
    if (req.method === "PUT" && url.pathname === "/api/weather/location") {
      if (authentication.client?.role !== "admin") return sendJson(res, 403, { ok: false, error: "Administrator access required" });
      try {
        const updated = await weather.updateLocation(await readJsonBody(req));
        realtime.broadcast("weather_updated", { weather: updated });
        return sendJson(res, 200, { ok: true, weather: updated });
      } catch (error) { return sendJson(res, error.status || 502, { ok: false, error: error.message }); }
    }
    if (req.method === "POST" && url.pathname === "/api/plants/analyze") {
      const requestId = `plant_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      try {
        const body = await readJsonBody(req, 8_000_000);
        if (!/^slave-[1-9][0-9]*$/.test(body.slave_id || "")) throw Object.assign(new Error("Invalid slave ID"), { status: 400 });
        if (!["image/jpeg", "image/png"].includes(body.mime_type)) throw Object.assign(new Error("Only JPEG or PNG images are supported"), { status: 400 });
        if (typeof body.image_base64 !== "string" || body.image_base64.length < 1000 || body.image_base64.length > 7_500_000 || !/^[A-Za-z0-9+/=]+$/.test(body.image_base64)) {
          throw Object.assign(new Error("Invalid plant image"), { status: 400 });
        }
        const result = await plantAnalyzer.analyze({
          imageBase64: body.image_base64,
          mimeType: body.mime_type,
          slaveId: body.slave_id,
          telemetry: slaveStore.get(body.slave_id),
          requestId,
        });
        realtime.broadcast("plant_analysis_completed", { slave_id: body.slave_id, result });
        return sendJson(res, 200, { ok: true, result, availability: quotaGate.status() });
      } catch (error) {
        const response = plantAnalysisError(error, requestId);
        console.warn("Plant analysis error", response.breadcrumb, error.message);
        return sendJson(res, error.status || 502, response);
      }
    }

    if (req.method === "GET" && url.pathname.startsWith("/captures/")) {
      let filename;
      try { filename = decodeURIComponent(url.pathname.slice("/captures/".length)); } catch { return sendText(res, 400, "Invalid filename"); }
      if (!filename || filename !== path.basename(filename)) return sendText(res, 400, "Invalid filename");
      const filePath = path.join(config.capturesDir, filename);
      if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return sendText(res, 404, "Capture not found");
      res.writeHead(200, { "Content-Type": contentType(filePath), "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" });
      return fs.createReadStream(filePath).pipe(res);
    }

    if (req.method === "POST" && url.pathname === "/api/detection/on") { state.detectionEnabled = true; realtime.broadcast("detection_changed", { detection_enabled: true }); return sendJson(res, 200, { ok: true, detection_enabled: true }); }
    if (req.method === "POST" && url.pathname === "/api/detection/off") { state.detectionEnabled = false; realtime.broadcast("detection_changed", { detection_enabled: false }); return sendJson(res, 200, { ok: true, detection_enabled: false }); }
    if (req.method === "POST" && url.pathname === "/api/manual-trigger") {
      if (!state.detectionEnabled) return sendJson(res, 400, { ok: false, error: "Detection is turned off." });
      const event = await eventService.capture("manual_trigger");
      if (!event) return sendJson(res, 409, { ok: false, error: "A capture is already running." });
      return sendJson(res, 200, { ok: true, event: eventService.sanitize(event) });
    }
    const analyzeMatch = url.pathname.match(/^\/api\/events\/(event_[A-Za-z0-9_-]+)\/analyze$/);
    if (req.method === "POST" && analyzeMatch) {
      try {
        const event = await eventService.analyzeById(analyzeMatch[1]);
        if (!event) return sendJson(res, 404, { ok: false, error: "Event not found." });
        return sendJson(res, 200, { ok: true, event: eventService.sanitize(event) });
      } catch (error) {
        return sendJson(res, 502, { ok: false, error: "Gemini analysis failed", detail: error.message });
      }
    }
    return sendJson(res, 404, { ok: false, error: "Route not found" });
  }
  return { route, status };
}
module.exports = { createRouter, legacySlaveTelemetry };
