const fs = require("fs");
const path = require("path");

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  for (const rawLine of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

function bool(name, fallback = false) {
  const value = process.env[name];
  if (value === undefined) return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function number(name, fallback) {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function createConfig(serverDir, mode) {
  const projectDir = path.join(serverDir, "..");
  loadEnvFile(path.join(projectDir, ".env"));
  const analysisMode = process.env.ANALYSIS_MODE || "capture_only";
  if (!["capture_only", "manual_analysis", "automatic_analysis"].includes(analysisMode)) {
    throw new Error(`Invalid ANALYSIS_MODE: ${analysisMode}`);
  }
  return {
    appName: mode.startsWith("orange_pi") ? "Agrimind Orange Pi Server" : "Agrimind Local Test Server",
    mode,
    projectDir,
    host: process.env.HOST || "0.0.0.0",
    port: number("PORT", 5000),
    apiToken: process.env.AGRIMIND_API_TOKEN || "",
    capturesDir: path.join(projectDir, "storage", "captures"),
    logsDir: path.join(projectDir, "storage", "logs"),
    camera: {
      device: process.env.CAMERA_DEVICE || "/dev/video0",
      autoDiscovery: bool("CAMERA_AUTO_DISCOVERY", true),
      resolution: process.env.CAMERA_RESOLUTION || "640x480",
      burstCount: number("CAPTURE_BURST_COUNT", 3),
      burstIntervalMs: number("CAPTURE_BURST_INTERVAL_MS", 350),
      minimumBytes: number("CAPTURE_MINIMUM_BYTES", 5000),
      discoveryRetryMs: number("CAMERA_DISCOVERY_RETRY_SECONDS", 10) * 1000,
    },
    pir: {
      chip: process.env.GPIO_CHIP || "gpiochip0",
      line: number("GPIO_LINE", 6),
      pollMs: number("PIR_POLL_MS", 500),
      debounceReadings: number("PIR_DEBOUNCE_READINGS", 2),
      rearmLowMs: number("PIR_REARM_LOW_SECONDS", 5) * 1000,
      cooldownMs: number("DETECTION_COOLDOWN_SECONDS", 15) * 1000,
      groupingMs: number("EVENT_GROUPING_SECONDS", 15) * 1000,
    },
    duplicate: {
      enabled: bool("DUPLICATE_DETECTION_ENABLED", true),
      maxHammingDistance: number("DUPLICATE_HASH_DISTANCE", 5),
      windowMs: number("DUPLICATE_WINDOW_SECONDS", 300) * 1000,
    },
    retention: {
      captureMs: number("CAPTURE_RETENTION_HOURS", 2) * 60 * 60 * 1000,
      cleanupIntervalMs: number("CAPTURE_CLEANUP_INTERVAL_MINUTES", 10) * 60 * 1000,
    },
    analysisMode,
    gemini: {
      enabled: bool("GEMINI_ENABLED", false),
      apiKey: process.env.GEMINI_API_KEY || "",
      model: process.env.GEMINI_MODEL || "gemini-3.1-flash-lite",
      minIntervalMs: number("GEMINI_MIN_INTERVAL_SECONDS", 15) * 1000,
      maxPerHour: number("GEMINI_MAX_REQUESTS_PER_HOUR", 30),
      maxPerDay: number("GEMINI_MAX_REQUESTS_PER_DAY", 100),
      maxRetries: number("GEMINI_MAX_FAILURE_RETRIES", 1),
      dailyBudgetUsd: number("GEMINI_DAILY_BUDGET_USD", 0.25),
      estimatedRequestUsd: number("GEMINI_ESTIMATED_COST_PER_REQUEST_USD", 0.002),
      timeoutMs: number("GEMINI_TIMEOUT_SECONDS", 30) * 1000,
    },
    semaphore: {
      enabled: bool("SMS_ALERTS_ENABLED", bool("SEMAPHORE_ENABLED", false)),
      apiKey: process.env.SEMAPHORE_API_KEY || "",
      recipients: (process.env.ALERT_RECIPIENTS || process.env.SEMAPHORE_RECIPIENT || "").split(",").map((value) => value.trim()).filter(Boolean),
      senderName: process.env.SEMAPHORE_SENDER_NAME || "",
      maxPerDay: number("SEMAPHORE_MAX_MESSAGES_PER_DAY", 20),
      minIntervalMs: number("SMS_COOLDOWN_SECONDS", number("SEMAPHORE_MIN_INTERVAL_SECONDS", 300)) * 1000,
      timeoutMs: number("SEMAPHORE_TIMEOUT_SECONDS", 15) * 1000,
      dailyWeatherEnabled: bool("DAILY_WEATHER_SMS_ENABLED", true),
      dailyWeatherTime: process.env.DAILY_WEATHER_SMS_TIME || "06:00",
      heatAlertEnabled: bool("HEAT_INDEX_ALERT_ENABLED", true),
      rainAlertEnabled: bool("RAIN_ALERT_ENABLED", true),
      typhoonAlertEnabled: bool("TYPHOON_ALERT_ENABLED", false),
      plantAlertEnabled: bool("PLANT_ABNORMAL_ALERT_ENABLED", true),
      heatIndexThresholdC: number("HEAT_INDEX_ALERT_THRESHOLD_C", 42),
      rainProbabilityThreshold: number("RAIN_ALERT_PROBABILITY_PERCENT", 80),
      rainMmThreshold: number("RAIN_ALERT_MM", 20),
      sensorOfflineMs: number("SENSOR_OFFLINE_MINUTES", 30) * 60 * 1000,
      projectCreditLimit: number("SMS_PROJECT_CREDIT_LIMIT", 50),
      lowBalanceCredits: number("SMS_LOW_BALANCE_CREDITS", 20),
      settingsPath: path.join(projectDir, "storage", "logs", "sms-settings.json"),
      categoryCooldownMs: {
        SECURITY_HUMAN: number("SECURITY_SMS_COOLDOWN_SECONDS", 300) * 1000,
        SECURITY_ANIMAL: number("SECURITY_SMS_COOLDOWN_SECONDS", 300) * 1000,
        PLANT_ABNORMAL: number("PLANT_SMS_COOLDOWN_SECONDS", 1800) * 1000,
        HEAT_INDEX_HIGH: number("WEATHER_SMS_COOLDOWN_SECONDS", 7200) * 1000,
        RAIN_FORECAST_HIGH: number("WEATHER_SMS_COOLDOWN_SECONDS", 7200) * 1000,
        TYPHOON_POSSIBLE: number("TYPHOON_SMS_COOLDOWN_SECONDS", 3600) * 1000,
        SYSTEM_SENSOR_OFFLINE: number("SENSOR_OFFLINE_SMS_COOLDOWN_SECONDS", 1800) * 1000,
        SYSTEM_LOW_SMS_BALANCE: number("LOW_BALANCE_SMS_COOLDOWN_SECONDS", 86400) * 1000,
        DAILY_WEATHER: 20 * 60 * 60 * 1000,
        TEST_SMS: 0,
      },
    },
    cloud: {
      enabled: bool("CLOUD_SYNC_ENABLED", false),
      baseUrl: (process.env.CLOUD_API_BASE_URL || "").replace(/\/$/, ""),
      deviceId: process.env.CLOUD_DEVICE_ID || "agrimind-farm-001",
      deviceToken: process.env.CLOUD_DEVICE_TOKEN || "",
      timeoutMs: number("CLOUD_SYNC_TIMEOUT_SECONDS", 15) * 1000,
    },
    pairing: {
      enabled: bool("PAIRING_ENABLED", true),
      enforceAuth: bool("PAIRING_ENFORCE_AUTH", false),
      deviceId: process.env.PAIRING_DEVICE_ID || process.env.CLOUD_DEVICE_ID || "agrimind-farm-001",
      deviceName: process.env.PAIRING_DEVICE_NAME || "Agrimind Farm",
      localUrls: (process.env.PAIRING_LOCAL_URLS || "http://orangepione.local:5000,http://192.168.18.5:5000").split(",").map((value) => value.trim().replace(/\/$/, "")).filter(Boolean),
      storePath: path.join(projectDir, "storage", "logs", "pairing.json"),
    },
    slaves: {
      apiToken: process.env.ESP8266_API_TOKEN || "",
      storePath: path.join(projectDir, "storage", "logs", "slave-readings.json"),
      pairingStorePath: path.join(projectDir, "storage", "logs", "slave-pairing.json"),
      pairingWindowMs: number("SLAVE_PAIRING_WINDOW_MINUTES", 15) * 60 * 1000,
    },
    weather: {
      latitude: number("FARM_LATITUDE", null),
      longitude: number("FARM_LONGITUDE", null),
      locationName: process.env.FARM_LOCATION_NAME || "Farm",
      refreshMs: number("WEATHER_REFRESH_MINUTES", 10) * 60 * 1000,
      timeoutMs: number("WEATHER_TIMEOUT_SECONDS", 12) * 1000,
      storePath: path.join(projectDir, "storage", "logs", "weather-location.json"),
    },
  };
}

module.exports = { createConfig };
