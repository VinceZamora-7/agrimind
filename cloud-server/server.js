const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const path = require("path");
const { WebSocket, WebSocketServer } = require("ws");

function loadEnv(filePath) {
  if (!fs.existsSync(filePath)) return;
  for (const raw of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadEnv(path.join(__dirname, ".env"));
const config = {
  host: process.env.HOST || "0.0.0.0",
  port: Number(process.env.PORT) || 8080,
  deviceId: process.env.AGRIMIND_DEVICE_ID || "",
  deviceToken: process.env.AGRIMIND_DEVICE_TOKEN || "",
  mobileToken: process.env.AGRIMIND_MOBILE_TOKEN || "",
  storageDir: path.resolve(__dirname, process.env.CLOUD_STORAGE_DIR || "storage"),
  maxUploadBytes: Number(process.env.MAX_UPLOAD_BYTES) || 2 * 1024 * 1024,
};

function safeEqual(actual, expected) {
  const left = Buffer.from(String(actual || ""));
  const right = Buffer.from(String(expected || ""));
  return left.length === right.length && left.length > 0 && crypto.timingSafeEqual(left, right);
}

function bearer(req) {
  const value = req.headers.authorization || "";
  return value.startsWith("Bearer ") ? value.slice(7) : "";
}

function json(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Device-ID",
  });
  res.end(`${JSON.stringify(data, null, 2)}\n`);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > config.maxUploadBytes) {
        reject(Object.assign(new Error("Upload is too large"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
      catch { reject(Object.assign(new Error("Invalid JSON"), { status: 400 })); }
    });
    req.on("error", reject);
  });
}

function atomicWrite(filePath, data) {
  const temporary = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, data);
  fs.renameSync(temporary, filePath);
}

function validDeviceId(value) {
  return /^[A-Za-z0-9_-]{3,64}$/.test(value || "");
}

function eventPath(deviceId) { return path.join(config.storageDir, `${deviceId}.json`); }
function imagePath(deviceId) { return path.join(config.storageDir, `${deviceId}.jpg`); }
function slavesPath(deviceId) { return path.join(config.storageDir, deviceId + ".slaves.json"); }
function farmStatusPath(deviceId) { return path.join(config.storageDir, deviceId + ".farm-status.json"); }
function controlSettingsPath(deviceId) { return path.join(config.storageDir, deviceId + ".control-settings.json"); }
const defaultSlaveIds = ["slave-1", "slave-2"];

const pendingCommands = {};

function getPendingCommands(deviceId) {
  return pendingCommands[deviceId] || [];
}

function clearPendingCommands(deviceId, commandIds = []) {
  if (!pendingCommands[deviceId]) return;
  if (!commandIds || !commandIds.length) {
    pendingCommands[deviceId] = [];
  } else {
    pendingCommands[deviceId] = pendingCommands[deviceId].filter((c) => !commandIds.includes(c.command_id));
  }
}

function addPendingCommand(deviceId, command) {
  if (!pendingCommands[deviceId]) pendingCommands[deviceId] = [];
  pendingCommands[deviceId].push(command);
}

function defaultSlaveReading(slaveId) {
  return {
    slave_id: slaveId,
    soil_moisture_percent: null,
    temperature_c: null,
    humidity_percent: null,
    pump_on: false,
    sensor_on: false,
    received_at: null,
    display_name: null,
    relay_command: null,
    soil_moisture_threshold: 50,
  };
}

function publicEnvironment(environment) {
  if (!environment) return null;
  const sampledAt = Date.parse(environment.sampled_at || "");
  const staleMs = Number(environment.stale_after_seconds || 180) * 1000;
  if (environment.status === "online" && (!Number.isFinite(sampledAt) || Date.now() - sampledAt > staleMs)) return { ...environment, status: "stale" };
  return environment;
}

function publicStatus(record, slaves = [], deviceId = record?.device_id, farmStatus = null) {
  const orangePiLastSyncedAt = farmStatus?.received_at || record?.received_at || null;
  const orangePiSyncTime = Date.parse(orangePiLastSyncedAt || "");
  const orangePiSyncAgeSeconds = Number.isFinite(orangePiSyncTime) ? Math.max(0, Math.round((Date.now() - orangePiSyncTime) / 1000)) : null;
  const deviceOnline = orangePiSyncAgeSeconds != null && orangePiSyncAgeSeconds <= 150;
  const event = record ? {
    ...record.event,
    best_image: {
      filename: record.image.filename,
      url: `/api/devices/${encodeURIComponent(record.device_id)}/latest-image`,
      available: true,
    },
  } : null;
  const controlSettings = readControlSettings(deviceId);
  return {
    app: "Agrimind Cloud Relay",
    mode: "cloud_relay",
    server_time: new Date().toISOString(),
    connection: "cloud",
    device_online: deviceOnline,
    device_status: deviceOnline ? "online" : orangePiLastSyncedAt ? "offline" : "waiting",
    orange_pi_last_synced_at: orangePiLastSyncedAt,
    orange_pi_sync_age_seconds: orangePiSyncAgeSeconds,
    device_id: deviceId,
    last_synced_at: farmStatus?.received_at || record?.received_at || slaves.reduce((latest, item) => item.received_at > latest ? item.received_at : latest, null),
    detection_enabled: farmStatus?.detection_enabled ?? controlSettings.detection_enabled ?? true,
    local_ips: farmStatus?.local_ips || [],
    local_urls: (farmStatus?.local_ips || []).map((ip) => `http://${ip}:5000`),
    is_capturing: false,
    latest_event: event,
    recent_events: event ? [event] : [],
    recent_images: event ? [{ filename: record.image.filename, url: event.best_image.url }] : [],
    slaves,
    weather: farmStatus?.weather || null,
    pagasa: farmStatus?.pagasa || null,
    weather_simulator: farmStatus?.weather_simulator || null,
    local_environment: publicEnvironment(farmStatus?.local_environment),
    zone_environment_status: Array.isArray(farmStatus?.zone_environment_status) ? farmStatus.zone_environment_status : [],
    control_settings: controlSettings,
  };
}

function readRecord(deviceId) {
  try { return JSON.parse(fs.readFileSync(eventPath(deviceId), "utf8")); }
  catch { return null; }
}

function readFarmStatus(deviceId) {
  try { return JSON.parse(fs.readFileSync(farmStatusPath(deviceId), "utf8")); }
  catch { return null; }
}

function readControlSettings(deviceId) {
  try { return { ignore_rain_lock: false, ...JSON.parse(fs.readFileSync(controlSettingsPath(deviceId), "utf8")) }; }
  catch { return { ignore_rain_lock: false }; }
}

function readSlaves(deviceId) {
  let readings = {};
  try {
    const stored = JSON.parse(fs.readFileSync(slavesPath(deviceId), "utf8"));
    if (stored && typeof stored === "object") readings = stored;
  } catch {}
  for (const slaveId of defaultSlaveIds) {
    if (!readings[slaveId]) readings[slaveId] = defaultSlaveReading(slaveId);
  }
  return readings;
}

function rainForecastToday(weather) {
  if (weather?.ignore_rain_lock === true) return false;
  const today = weather?.daily?.[0] || {};
  const probability = Number(today.rain_probability_percent ?? weather?.rain_probability_12h_percent);
  const rainMm = Number(today.rain_sum_mm ?? today.precipitation_sum_mm);
  return (Number.isFinite(probability) && probability >= 60)
    || (Number.isFinite(rainMm) && rainMm >= 1);
}

function relayControlState(reading, weather = null) {
  const command = reading?.relay_command || null;
  const controlMode = command?.control_mode || (command ? "manual" : "automatic");
  if (controlMode === "manual") {
    return {
      control_mode: "manual",
      action: command?.desired_pump_on ? "ON" : "OFF",
      relay: command?.desired_pump_on ? 1 : 0,
      reason: "Controlled from mobile application",
    };
  }
  if (rainForecastToday(weather)) {
    return { control_mode: "automatic", automation: "rain_lock", action: "OFF", relay: 0, reason: "Rain forecast today" };
  }
  const threshold = Number(reading?.soil_moisture_threshold ?? 50);
  const moisture = Number(reading?.soil_moisture_percent);
  const relayOn = Number.isFinite(moisture) && moisture < threshold;
  return {
    control_mode: "automatic",
    automation: "vps_soil_threshold",
    action: relayOn ? "ON" : "OFF",
    relay: relayOn ? 1 : 0,
    threshold,
    reason: relayOn ? "Soil moisture below threshold" : "Soil moisture at or above threshold",
  };
}

function simpleSlaveState(reading, weather = null) {
  return {
    ...relayControlState(reading, weather),
    soilmoisture: reading?.soil_moisture_percent ?? null,
  };
}

function parseSlaveId(value) {
  const rawSlaveId = String(value || "").trim().toLowerCase();
  const slaveId = /^[1-9][0-9]*$/.test(rawSlaveId) ? `slave-${rawSlaveId}` : rawSlaveId;
  if (!/^slave-[1-9][0-9]*$/.test(slaveId)) {
    throw Object.assign(new Error("Use slaveid=1, slaveid=2, or slaveid=slave-1"), { status: 400 });
  }
  return slaveId;
}

function parseTelemetry(url) {
  const requestedDeviceId = String(url.searchParams.get("deviceid") || "").trim();
  const deviceId = requestedDeviceId || config.deviceId;
  if (!validDeviceId(deviceId) || deviceId !== config.deviceId) {
    throw Object.assign(new Error("Invalid deviceid"), { status: 400 });
  }
  const slaveId = parseSlaveId(url.searchParams.get("slaveid"));
  const moisture = Number(url.searchParams.get("soilmoisture"));
  if (!Number.isFinite(moisture) || moisture < 0 || moisture > 100) {
    throw Object.assign(new Error("soilmoisture must be between 0 and 100"), { status: 400 });
  }
  const relay = String(url.searchParams.get("relay") || "0").trim().toLowerCase();
  if (!["0", "1", "false", "true", "off", "on"].includes(relay)) {
    throw Object.assign(new Error("relay must be 0, 1, false, true, off, or on"), { status: 400 });
  }
  return {
    deviceId,
    slaveId,
    reading: {
      slave_id: slaveId,
      soil_moisture_percent: moisture,
      temperature_c: null,
      humidity_percent: null,
      pump_on: ["1", "true", "on"].includes(relay),
      sensor_on: true,
      received_at: new Date().toISOString(),
      display_name: null,
    },
  };
}

function createRealtimeHub() {
  const server = new WebSocketServer({ noServer: true });
  const clients = new Set();

  server.on("connection", (client) => {
    clients.add(client);
    const slaves = Object.values(readSlaves(config.deviceId));
    client.send(JSON.stringify({
      type: "connected",
      status: publicStatus(readRecord(config.deviceId), slaves, config.deviceId, readFarmStatus(config.deviceId)),
    }));
    client.on("close", () => clients.delete(client));
  });

  function upgrade(req, socket, head) {
    const url = new URL(req.url, "http://" + (req.headers.host || "localhost"));
    const validPath = url.pathname === "/ws";
    const validToken = safeEqual(url.searchParams.get("token"), config.mobileToken);
    const requestedDeviceId = url.searchParams.get("deviceid") || config.deviceId;
    if (!validPath || !validToken || requestedDeviceId !== config.deviceId) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    server.handleUpgrade(req, socket, head, (client) => server.emit("connection", client, req));
  }

  function broadcast(type, payload) {
    const message = JSON.stringify({ type, ...payload });
    for (const client of clients) {
      if (client.readyState === WebSocket.OPEN) client.send(message);
    }
  }

  function close() {
    for (const client of clients) client.close(1001, "Server shutting down");
    server.close();
  }

  return { upgrade, broadcast, close };
}

async function route(req, res, realtime) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  if (req.method === "OPTIONS") return json(res, 204, {});
  if (req.method === "GET" && url.pathname === "/health") return json(res, 200, { ok: true });

  if (req.method === "GET" && url.pathname === "/api/slave-telemetry") {
    try {
      const telemetry = parseTelemetry(url);
      const readings = readSlaves(telemetry.deviceId);
      const farmWeather = readFarmStatus(telemetry.deviceId)?.weather || null;
      const weather = farmWeather ? { ...farmWeather, ignore_rain_lock: readControlSettings(telemetry.deviceId).ignore_rain_lock } : null;
      const previousReading = readings[telemetry.slaveId] || defaultSlaveReading(telemetry.slaveId);
      telemetry.reading.soil_moisture_threshold = Number(previousReading.soil_moisture_threshold ?? 50);
      const previousCommand = previousReading.relay_command || null;
      const controlMode = previousCommand?.control_mode || (previousCommand ? "manual" : "automatic");
      const rainLocked = controlMode === "automatic" && rainForecastToday(weather);
      const desiredPumpOn = controlMode === "manual"
        ? previousCommand.desired_pump_on === true
        : rainLocked ? false : telemetry.reading.soil_moisture_percent < telemetry.reading.soil_moisture_threshold;
      const commandMatchesTelemetry = desiredPumpOn == null
        || desiredPumpOn === telemetry.reading.pump_on;
      telemetry.reading.relay_command = {
        ...(previousCommand || {}),
        command_id: previousCommand?.command_id || "auto_" + telemetry.slaveId,
        control_mode: controlMode,
        desired_pump_on: desiredPumpOn,
        automation: controlMode === "automatic" ? (rainLocked ? "rain_lock" : "vps_soil_threshold") : null,
        reason: controlMode === "manual"
          ? "Controlled from mobile application"
          : rainLocked ? "Rain forecast today" : "VPS applied the configured soil moisture threshold",
        status: commandMatchesTelemetry ? "confirmed" : "pending",
        confirmed_at: desiredPumpOn != null && commandMatchesTelemetry
          ? previousCommand?.confirmed_at || new Date().toISOString()
          : null,
      };
      readings[telemetry.slaveId] = telemetry.reading;
      atomicWrite(slavesPath(telemetry.deviceId), `${JSON.stringify(readings, null, 2)}\n`);
      realtime.broadcast("slave_telemetry", { device_id: telemetry.deviceId, reading: telemetry.reading });
      return json(res, 200, {
        ok: true,
        accepted_via: "get_compatibility",
        device_id: telemetry.deviceId,
        reading: telemetry.reading,
        action: relayControlState(telemetry.reading, weather).action,
        state: simpleSlaveState(telemetry.reading, weather),
        [telemetry.slaveId]: simpleSlaveState(telemetry.reading, weather),
        command: telemetry.reading.relay_command?.status === "pending" ? {
          command_id: telemetry.reading.relay_command.command_id,
          relay: telemetry.reading.relay_command.desired_pump_on ? 1 : 0,
        } : null,
      });
    } catch (error) {
      return json(res, error.status || 500, { ok: false, error: error.message });
    }
  }

  if (req.method === "GET" && url.pathname === "/api/slave-state") {
    try {
      const readings = readSlaves(config.deviceId);
      const farmWeather = readFarmStatus(config.deviceId)?.weather || null;
      const weather = farmWeather ? { ...farmWeather, ignore_rain_lock: readControlSettings(config.deviceId).ignore_rain_lock } : null;
      const requestedId = url.searchParams.get("slaveid");
      if (requestedId) {
        const slaveId = parseSlaveId(requestedId);
        return json(res, 200, { [slaveId]: simpleSlaveState(readings[slaveId], weather) });
      }
      const states = {};
      for (const [slaveId, reading] of Object.entries(readings)) states[slaveId] = simpleSlaveState(reading, weather);
      return json(res, 200, states);
    } catch (error) {
      return json(res, error.status || 500, { ok: false, error: error.message });
    }
  }

  if (req.method === "GET" && url.pathname === "/api/relay-command") {
    try {
      const slaveId = parseSlaveId(url.searchParams.get("slaveid"));
      const mode = String(url.searchParams.get("mode") || "manual").trim().toLowerCase();
      if (!["manual", "automatic"].includes(mode)) {
        return json(res, 400, { ok: false, error: "mode must be manual or automatic" });
      }
      const relay = String(url.searchParams.get("relay") || "").trim().toLowerCase();
      if (mode === "manual" && !["0", "1", "false", "true", "off", "on"].includes(relay)) {
        return json(res, 400, { ok: false, error: "manual mode requires relay=0 or relay=1" });
      }
      const readings = readSlaves(config.deviceId);
      const current = readings[slaveId] || defaultSlaveReading(slaveId);
      const now = new Date().toISOString();
      const desiredPumpOn = mode === "manual" ? ["1", "true", "on"].includes(relay) : null;
      const command = {
        command_id: "cmd_" + Date.now().toString(36) + "_" + crypto.randomBytes(5).toString("hex"),
        control_mode: mode,
        desired_pump_on: desiredPumpOn,
        automation: mode === "automatic" ? "awaiting_weather_evaluation" : null,
        reason: mode === "manual" ? "Controlled from mobile application" : "Automatic control enabled",
        status: mode === "automatic" ? "active" : current.pump_on === desiredPumpOn ? "confirmed" : "pending",
        requested_at: now,
        confirmed_at: mode === "manual" && current.pump_on === desiredPumpOn ? now : null,
      };
      readings[slaveId] = { ...current, relay_command: command };
      atomicWrite(slavesPath(config.deviceId), JSON.stringify(readings, null, 2) + "\n");
      realtime.broadcast("relay_command", { device_id: config.deviceId, reading: readings[slaveId] });
      const farmWeather = readFarmStatus(config.deviceId)?.weather || null;
      const weather = farmWeather ? { ...farmWeather, ignore_rain_lock: readControlSettings(config.deviceId).ignore_rain_lock } : null;
      return json(res, 200, { ok: true, [slaveId]: simpleSlaveState(readings[slaveId], weather) });
    } catch (error) {
      return json(res, error.status || 500, { ok: false, error: error.message });
    }
  }

  if (req.method === "GET" && url.pathname === "/api/slave-command") {
    try {
      const slaveId = parseSlaveId(url.searchParams.get("slaveid"));
      const reading = readSlaves(config.deviceId)[slaveId] || null;
      return json(res, 200, {
        ok: true,
        slave_id: slaveId,
        command: reading?.relay_command ? {
          command_id: reading.relay_command.command_id,
          relay: reading.relay_command.desired_pump_on ? 1 : 0,
          status: reading.relay_command.status,
          requested_at: reading.relay_command.requested_at,
        } : null,
      });
    } catch (error) {
      return json(res, error.status || 500, { ok: false, error: error.message });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/devices/" + config.deviceId + "/control-settings") {
    if (!safeEqual(bearer(req), config.mobileToken)) return json(res, 401, { ok: false, error: "Unauthorized" });
    const body = await readBody(req);
    if (typeof body.ignore_rain_lock !== "boolean") return json(res, 400, { ok: false, error: "ignore_rain_lock must be boolean" });
    const settings = { ignore_rain_lock: body.ignore_rain_lock, updated_at: new Date().toISOString() };
    atomicWrite(controlSettingsPath(config.deviceId), JSON.stringify(settings, null, 2) + "\n");
    realtime.broadcast("control_settings", { device_id: config.deviceId, control_settings: settings });
    return json(res, 200, { ok: true, control_settings: settings });
  }

  const thresholdMatch = url.pathname.match(/^\/api\/devices\/([A-Za-z0-9_-]+)\/slaves\/(slave-[1-9][0-9]*)\/moisture-threshold/);
  if (req.method === "POST" && thresholdMatch) {
    if (!safeEqual(bearer(req), config.mobileToken)) return json(res, 401, { ok: false, error: "Unauthorized" });
    const [deviceId, slaveId] = thresholdMatch.slice(1);
    if (deviceId !== config.deviceId) return json(res, 404, { ok: false, error: "Device not found" });
    const body = await readBody(req);
    const threshold = Number(body.threshold);
    if (!Number.isFinite(threshold) || threshold < 1 || threshold > 99) return json(res, 400, { ok: false, error: "threshold must be between 1 and 99" });
    const readings = readSlaves(deviceId);
    readings[slaveId] = { ...(readings[slaveId] || defaultSlaveReading(slaveId)), soil_moisture_threshold: Math.round(threshold) };
    atomicWrite(slavesPath(deviceId), JSON.stringify(readings, null, 2) + "\n");
    realtime.broadcast("relay_threshold", { device_id: deviceId, reading: readings[slaveId] });
    return json(res, 200, { ok: true, slave_id: slaveId, soil_moisture_threshold: readings[slaveId].soil_moisture_threshold });
  }

  const relayCommandMatch = url.pathname.match(/^\/api\/devices\/([A-Za-z0-9_-]+)\/slaves\/(slave-[1-9][0-9]*)\/relay-command$/);
  if (req.method === "POST" && relayCommandMatch) {
    if (!safeEqual(bearer(req), config.mobileToken)) return json(res, 401, { ok: false, error: "Unauthorized" });
    const [deviceId, slaveId] = relayCommandMatch.slice(1);
    if (deviceId !== config.deviceId) return json(res, 404, { ok: false, error: "Device not found" });
    const body = await readBody(req);
    if (![0, 1, false, true].includes(body.relay)) {
      return json(res, 400, { ok: false, error: "relay must be 0, 1, false, or true" });
    }
    const desiredPumpOn = body.relay === 1 || body.relay === true;
    const readings = readSlaves(deviceId);
    const current = readings[slaveId] || {
      slave_id: slaveId,
      soil_moisture_percent: null,
      temperature_c: null,
      humidity_percent: null,
      pump_on: null,
      sensor_on: false,
      received_at: null,
      display_name: null,
    };
    const command = {
      command_id: "cmd_" + Date.now().toString(36) + "_" + crypto.randomBytes(5).toString("hex"),
      desired_pump_on: desiredPumpOn,
      status: current.pump_on === desiredPumpOn ? "confirmed" : "pending",
      requested_at: new Date().toISOString(),
      confirmed_at: current.pump_on === desiredPumpOn ? new Date().toISOString() : null,
    };
    readings[slaveId] = { ...current, relay_command: command };
    atomicWrite(slavesPath(deviceId), `${JSON.stringify(readings, null, 2)}\n`);
    realtime.broadcast("relay_command", { device_id: deviceId, reading: readings[slaveId] });
    return json(res, 202, { ok: true, slave_id: slaveId, command });
  }

  if (req.method === "POST" && url.pathname === "/api/devices/" + config.deviceId + "/manual-trigger") {
    if (!safeEqual(bearer(req), config.mobileToken)) return json(res, 401, { ok: false, error: "Unauthorized" });
    const cmd = { command_id: "cmd_" + Date.now().toString(36), type: "manual_trigger", created_at: new Date().toISOString() };
    addPendingCommand(config.deviceId, cmd);
    realtime.broadcast("manual_trigger_queued", { device_id: config.deviceId, command: cmd });
    return json(res, 202, { ok: true, message: "Manual trigger requested", command: cmd });
  }

  if (req.method === "POST" && url.pathname === "/api/devices/" + config.deviceId + "/detection/on") {
    if (!safeEqual(bearer(req), config.mobileToken)) return json(res, 401, { ok: false, error: "Unauthorized" });
    const cmd = { command_id: "cmd_" + Date.now().toString(36), type: "detection_on", created_at: new Date().toISOString() };
    addPendingCommand(config.deviceId, cmd);
    const existing = readControlSettings(config.deviceId);
    atomicWrite(controlSettingsPath(config.deviceId), JSON.stringify({ ...existing, detection_enabled: true }, null, 2) + "\n");
    realtime.broadcast("detection_changed", { device_id: config.deviceId, detection_enabled: true });
    return json(res, 200, { ok: true, detection_enabled: true });
  }

  if (req.method === "POST" && url.pathname === "/api/devices/" + config.deviceId + "/detection/off") {
    if (!safeEqual(bearer(req), config.mobileToken)) return json(res, 401, { ok: false, error: "Unauthorized" });
    const cmd = { command_id: "cmd_" + Date.now().toString(36), type: "detection_off", created_at: new Date().toISOString() };
    addPendingCommand(config.deviceId, cmd);
    const existing = readControlSettings(config.deviceId);
    atomicWrite(controlSettingsPath(config.deviceId), JSON.stringify({ ...existing, detection_enabled: false }, null, 2) + "\n");
    realtime.broadcast("detection_changed", { device_id: config.deviceId, detection_enabled: false });
    return json(res, 200, { ok: true, detection_enabled: false });
  }

  if (req.method === "POST" && url.pathname === "/api/device/farm-status") {
    const deviceId = req.headers["x-device-id"];
    if (!safeEqual(deviceId, config.deviceId) || !safeEqual(bearer(req), config.deviceToken)) return json(res, 401, { ok: false, error: "Invalid device credentials" });
    const body = await readBody(req);
    if (!validDeviceId(body.device_id) || body.device_id !== deviceId || !body.local_environment || !body.weather) return json(res, 400, { ok: false, error: "Invalid farm status payload" });
    const farmStatus = {
      device_id: deviceId,
      received_at: new Date().toISOString(),
      detection_enabled: typeof body.detection_enabled === "boolean" ? body.detection_enabled : undefined,
      local_ips: Array.isArray(body.local_ips) ? body.local_ips : [],
      local_environment: body.local_environment,
      weather: body.weather,
      pagasa: body.pagasa || null,
      weather_simulator: body.weather_simulator || null,
      zone_environment_status: Array.isArray(body.zone_environment_status) ? body.zone_environment_status : [],
    };
    atomicWrite(farmStatusPath(deviceId), JSON.stringify(farmStatus, null, 2) + "\n");
    realtime.broadcast("environment_updated", { device_id: deviceId, local_environment: farmStatus.local_environment, weather: farmStatus.weather, pagasa: farmStatus.pagasa, weather_simulator: farmStatus.weather_simulator, zone_environment_status: farmStatus.zone_environment_status });
    const commandsToReturn = getPendingCommands(deviceId);
    clearPendingCommands(deviceId);
    return json(res, 200, { ok: true, received_at: farmStatus.received_at, pending_commands: commandsToReturn });
  }

  if (req.method === "POST" && url.pathname === "/api/device/events/latest") {
    const deviceId = req.headers["x-device-id"];
    if (!safeEqual(deviceId, config.deviceId) || !safeEqual(bearer(req), config.deviceToken)) {
      return json(res, 401, { ok: false, error: "Invalid device credentials" });
    }
    const body = await readBody(req);
    if (!validDeviceId(body.device_id) || body.device_id !== deviceId || !body.event?.event_id || !body.image?.data_base64) {
      return json(res, 400, { ok: false, error: "Invalid event payload" });
    }
    const image = Buffer.from(body.image.data_base64, "base64");
    if (!image.length || image.length > config.maxUploadBytes) return json(res, 400, { ok: false, error: "Invalid image" });
    const record = {
      device_id: body.device_id,
      received_at: new Date().toISOString(),
      event: body.event,
      image: { filename: path.basename(body.image.filename || "capture.jpg"), content_type: "image/jpeg", bytes: image.length },
    };
    atomicWrite(imagePath(deviceId), image);
    atomicWrite(eventPath(deviceId), `${JSON.stringify(record, null, 2)}\n`);
    return json(res, 200, { ok: true, event_id: record.event.event_id, received_at: record.received_at });
  }

  const statusMatch = url.pathname.match(/^\/api\/devices\/([A-Za-z0-9_-]+)\/status$/);
  const eventsMatch = url.pathname.match(/^\/api\/devices\/([A-Za-z0-9_-]+)\/events$/);
  const imageMatch = url.pathname.match(/^\/api\/devices\/([A-Za-z0-9_-]+)\/latest-image$/);
  if (statusMatch || eventsMatch || imageMatch) {
    if (!safeEqual(bearer(req), config.mobileToken)) return json(res, 401, { ok: false, error: "Unauthorized" });
    const deviceId = (statusMatch || eventsMatch || imageMatch)[1];
    const record = readRecord(deviceId);
    const slaves = Object.values(readSlaves(deviceId));
    const farmStatus = readFarmStatus(deviceId);
    if (!record && !slaves.length && !farmStatus) return json(res, 404, { ok: false, error: "Device has not synchronized data" });
    if (statusMatch) return json(res, 200, publicStatus(record, slaves, deviceId, farmStatus));
    if (eventsMatch) return json(res, 200, publicStatus(record, slaves, deviceId, farmStatus).recent_events);
    const filePath = imagePath(deviceId);
    if (!fs.existsSync(filePath)) return json(res, 404, { ok: false, error: "Image not found" });
    res.writeHead(200, { "Content-Type": "image/jpeg", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" });
    return fs.createReadStream(filePath).pipe(res);
  }
  return json(res, 404, { ok: false, error: "Route not found" });
}

function createServer() {
  fs.mkdirSync(config.storageDir, { recursive: true });
  if (!config.deviceId || !config.deviceToken || !config.mobileToken) {
    throw new Error("AGRIMIND_DEVICE_ID, AGRIMIND_DEVICE_TOKEN, and AGRIMIND_MOBILE_TOKEN are required");
  }
  const realtime = createRealtimeHub();
  const server = http.createServer((req, res) => route(req, res, realtime).catch((error) => {
    console.error(error);
    if (!res.headersSent) json(res, error.status || 500, { ok: false, error: error.status ? error.message : "Internal server error" });
  }));
  server.on("upgrade", realtime.upgrade);
  server.on("close", realtime.close);
  return server;
}

if (require.main === module) {
  createServer().listen(config.port, config.host, () => console.log(`Agrimind Cloud Relay listening on ${config.host}:${config.port}`));
}

module.exports = { createServer, config, publicStatus, safeEqual, createRealtimeHub, rainForecastToday, relayControlState };
