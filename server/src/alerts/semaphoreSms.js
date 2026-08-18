const { readJson, writeJsonAtomic } = require("../utils/files");

const CATEGORIES = [
  "DAILY_WEATHER", "PLANT_ABNORMAL", "HEAT_INDEX_HIGH", "RAIN_FORECAST_HIGH",
  "TYPHOON_POSSIBLE", "SECURITY_HUMAN", "SECURITY_ANIMAL",
  "SYSTEM_LOW_SMS_BALANCE", "SYSTEM_SENSOR_OFFLINE", "TEST_SMS",
];

function normalizeNumber(value) {
  const digits = String(value || "").replace(/[^0-9]/g, "");
  if (/^09\d{9}$/.test(digits)) return `63${digits.slice(1)}`;
  if (/^639\d{9}$/.test(digits)) return digits;
  throw Object.assign(new Error(`Invalid Philippine mobile number: ${value}`), { status: 400 });
}

function maskNumber(number) { return String(number).replace(/.(?=.{4})/g, "*"); }
function localDay(date = new Date()) { return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`; }

function rainForecastLabel(value) {
  const chance = Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
  if (chance <= 20) return "None/Negligible";
  if (chance <= 50) return "Light/Scattered";
  if (chance <= 70) return "Moderate";
  return "Heavy";
}
function dailyForecastSummary(condition) {
  const text = String(condition || "").toLowerCase();
  if (text.includes("severe") || text.includes("hail")) return "Stormy Weather";
  if (text.includes("thunder")) return "Cloudy with Scattered Thunderstorms";
  if (text.includes("rain") || text.includes("drizzle")) return "Monsoon Rains";
  if (text.includes("partly")) return "Partly Cloudy";
  if (text.includes("overcast") || text.includes("cloud") || text.includes("fog")) return "Mostly Cloudy";
  return "Sunny / Clear";
}

function createSemaphoreSms(config, usagePath, push = null) {
  const settingsPath = config.semaphore.settingsPath;
  const queuePath = settingsPath + ".queue.json";
  let timer = null;
  let queueTimer = null;
  let queueProcessing = false;

  function defaultSettings() {
    return {
      sms_alerts_enabled: config.semaphore.enabled,
      recipients: config.semaphore.recipients,
      enabled_categories: {
        DAILY_WEATHER: config.semaphore.dailyWeatherEnabled,
        PLANT_ABNORMAL: config.semaphore.plantAlertEnabled,
        HEAT_INDEX_HIGH: config.semaphore.heatAlertEnabled,
        RAIN_FORECAST_HIGH: config.semaphore.rainAlertEnabled,
        TYPHOON_POSSIBLE: config.semaphore.typhoonAlertEnabled,
        SECURITY_HUMAN: true,
        SECURITY_ANIMAL: true,
        SYSTEM_LOW_SMS_BALANCE: true,
        SYSTEM_SENSOR_OFFLINE: true,
        TEST_SMS: true,
      },
      crop_profiles: {},
    };
  }
  function settings() {
    const saved = readJson(settingsPath, {});
    const defaults = defaultSettings();
    return {
      ...defaults, ...saved,
      recipients: Array.isArray(saved.recipients) ? saved.recipients : defaults.recipients,
      enabled_categories: { ...defaults.enabled_categories, ...(saved.enabled_categories || {}) },
      crop_profiles: saved.crop_profiles || {},
    };
  }
  function saveSettings(next) { writeJsonAtomic(settingsPath, next); return next; }
  function history() {
    return readJson(usagePath, []).filter((entry) => entry?.timestamp).map((entry) => {
      const malformedProviderResponse = entry.sent === true
        && Array.isArray(entry.provider_messages)
        && entry.provider_messages.length > 0
        && entry.provider_messages.every((item) => !item?.message_id);
      return malformedProviderResponse ? { ...entry, sent: false, error: "Semaphore did not accept this message" } : entry;
    });
  }
  function saveRecord(record) { const records = history(); records.push(record); writeJsonAtomic(usagePath, records.slice(-1000)); return record; }
  function queuedAlerts() { return readJson(queuePath, []).filter((item) => item?.queue_id && item?.category); }
  function saveQueue(items) { writeJsonAtomic(queuePath, items.slice(-100)); return items; }
  function enqueue(category, message, context, retryAfterSeconds = 60, queueKey = "default") {
    const key = category + ":" + queueKey;
    const item = {
      queue_id: "queued_" + Date.now() + "_" + Math.random().toString(16).slice(2),
      key, category, message: String(message).slice(0, 900), context,
      queued_at: new Date().toISOString(),
      send_after: new Date(Date.now() + Math.max(1, Number(retryAfterSeconds) || 60) * 1000).toISOString(),
      attempts: 0,
    };
    saveQueue([...queuedAlerts().filter((current) => current.key !== key), item]);
    return item;
  }
  function updateQueued(queueId, update) {
    const current = queuedAlerts();
    const item = current.find((entry) => entry.queue_id === queueId);
    if (!item) return;
    const next = update(item);
    saveQueue(next ? current.map((entry) => entry.queue_id === queueId ? next : entry) : current.filter((entry) => entry.queue_id !== queueId));
  }
  function balance() {
    const creditsUsed = history().filter((entry) => entry.sent === true).reduce((sum, entry) => sum + Number(entry.credits_charged || entry.provider_messages?.length || 1), 0);
    const remaining = Math.max(0, config.semaphore.projectCreditLimit - creditsUsed);
    return {
      credit_limit: config.semaphore.projectCreditLimit,
      credits_used: creditsUsed,
      credit_balance: remaining,
      low_balance_threshold: config.semaphore.lowBalanceCredits,
      low_balance: remaining <= config.semaphore.lowBalanceCredits,
      exhausted: remaining <= 0,
      source: "agrimind_project_allocation",
      fetched_at: new Date().toISOString(),
    };
  }
  function cooldownMs(category) { return config.semaphore.categoryCooldownMs[category] ?? config.semaphore.minIntervalMs; }
  function gate(category, { force = false } = {}) {
    const current = settings();
    if (!config.semaphore.enabled) return { allowed: false, reason: "semaphore_disabled" };
    if (!current.sms_alerts_enabled) return { allowed: false, reason: "sms_alerts_disabled" };
    if (!config.semaphore.apiKey || !current.recipients.length) return { allowed: false, reason: "semaphore_not_configured" };
    if (current.enabled_categories[category] === false) return { allowed: false, reason: "category_disabled" };
    const now = new Date();
    const sent = history().filter((entry) => entry.sent === true);
    const daily = sent.filter((entry) => localDay(new Date(entry.timestamp)) === localDay(now));
    if (daily.length >= config.semaphore.maxPerDay) return { allowed: false, reason: "alert_daily_quota" };
    if (!force) {
      const latest = sent.filter((entry) => entry.category === category).at(-1);
      const wait = cooldownMs(category) - (latest ? now - new Date(latest.timestamp) : cooldownMs(category));
      if (wait > 0) return { allowed: false, reason: "category_cooldown", retry_after_seconds: Math.ceil(wait / 1000) };
    }
    return { allowed: true, sent_today: daily.length, max_per_day: config.semaphore.maxPerDay };
  }

  async function sendCategory(category, message, context = {}, options = {}) {
    if (!CATEGORIES.includes(category)) throw Object.assign(new Error("Unknown SMS category"), { status: 400 });
    let pushResult = null;
    if (push && !options.skipPush) {
      try {
        pushResult = await push.send(category, message, context, {
          force: options.force,
          categoryEnabled: settings().enabled_categories[category] !== false,
        });
      } catch (error) {
        console.error(`Push alert ${category}:`, error.message);
        pushResult = { sent: false, error: error.message };
      }
    }
    const check = gate(category, options);
    if (!check.allowed) {
      if (check.reason === "category_cooldown" && options.queueOnCooldown && !options.fromQueue) {
        const queued = enqueue(category, message, context, check.retry_after_seconds, options.queueKey);
        return { sent: false, queued: true, queue_id: queued.queue_id, send_after: queued.send_after, channel: "sms", category, skip_reason: check.reason, retry_after_seconds: check.retry_after_seconds, push: pushResult };
      }
      return { sent: false, channel: "sms", category, skip_reason: check.reason, retry_after_seconds: check.retry_after_seconds, push: pushResult };
    }
    const current = settings();
    const smsMessage = String(message).slice(0, 900);
    const creditsRequired = current.recipients.length * Math.max(1, Math.ceil(smsMessage.length / 160));
    const projectBalance = balance();
    if (creditsRequired > projectBalance.credit_balance) return { sent: false, channel: "sms", category, skip_reason: "project_credit_limit", credits_required: creditsRequired, balance: projectBalance, push: pushResult };
    const body = new URLSearchParams({ apikey: config.semaphore.apiKey, number: current.recipients.join(","), message: smsMessage });
    if (config.semaphore.senderName) body.set("sendername", config.semaphore.senderName);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.semaphore.timeoutMs);
    const timestamp = new Date().toISOString();
    try {
      const response = await fetch("https://api.semaphore.co/api/v4/messages", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body, signal: controller.signal });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw Object.assign(new Error(payload?.message || `Semaphore HTTP ${response.status}`), { status: response.status });
      const messages = Array.isArray(payload) ? payload : [payload].filter(Boolean);
      const accepted = messages.length > 0 && messages.every((item) => item?.message_id && item?.recipient && item?.status && !["Failed", "Refunded"].includes(item.status));
      if (!accepted) {
        const providerMessage = messages.map((item) => item?.message || item?.error).filter(Boolean).join("; ");
        throw Object.assign(new Error(providerMessage || "Semaphore did not return an accepted message record"), { status: 502 });
      }
      const record = saveRecord({
        alert_id: `sms_${Date.now()}`, timestamp, category, message: smsMessage, sent: accepted, credits_charged: creditsRequired,
        recipients: current.recipients.map(maskNumber), context,
        provider: "semaphore", provider_messages: messages.map((item) => ({ message_id: item?.message_id, recipient: maskNumber(item?.recipient || ""), status: item?.status, network: item?.network, updated_at: item?.updated_at })),
      });
      return { sent: accepted, channel: "sms", category, credits_charged: creditsRequired, balance: balance(), recipients: record.recipients, provider_messages: record.provider_messages, push: pushResult };
    } catch (error) {
      saveRecord({ alert_id: `sms_${Date.now()}`, timestamp, category, message, sent: false, recipients: current.recipients.map(maskNumber), context, provider: "semaphore", error: error.name === "AbortError" ? "Semaphore request timed out" : error.message });
      if (options.queueOnFailure && !options.fromQueue) {
        const queued = enqueue(category, message, context, 60, options.queueKey);
        return { sent: false, queued: true, queue_id: queued.queue_id, send_after: queued.send_after, channel: "sms", category, error: error.message, push: pushResult };
      }
      throw error;
    } finally { clearTimeout(timeout); }
  }

  async function processQueue() {
    if (queueProcessing) return;
    queueProcessing = true;
    try {
      const due = queuedAlerts().filter((item) => Date.parse(item.send_after) <= Date.now());
      for (const item of due) {
        try {
          const result = await sendCategory(item.category, item.message, item.context, { fromQueue: true, skipPush: true });
          if (result.sent) {
            updateQueued(item.queue_id, () => null);
          } else {
            const retrySeconds = result.retry_after_seconds || 60;
            updateQueued(item.queue_id, (current) => ({ ...current, attempts: current.attempts + 1, send_after: new Date(Date.now() + retrySeconds * 1000).toISOString(), last_error: result.skip_reason || result.error || "not_sent" }));
          }
        } catch (error) {
          updateQueued(item.queue_id, (current) => ({ ...current, attempts: current.attempts + 1, send_after: new Date(Date.now() + 60_000).toISOString(), last_error: error.message }));
        }
      }
    } finally { queueProcessing = false; }
  }

  function updateRecipients(values) {
    if (!Array.isArray(values) || values.length < 1 || values.length > 10) throw Object.assign(new Error("Enter 1 to 10 recipients"), { status: 400 });
    const current = settings();
    return saveSettings({ ...current, recipients: [...new Set(values.map(normalizeNumber))] });
  }
  function updateRules(input) {
    const current = settings();
    const next = { ...current };
    if (typeof input.sms_alerts_enabled === "boolean") next.sms_alerts_enabled = input.sms_alerts_enabled;
    if (input.enabled_categories) next.enabled_categories = { ...current.enabled_categories, ...Object.fromEntries(Object.entries(input.enabled_categories).filter(([key, value]) => CATEGORIES.includes(key) && typeof value === "boolean")) };
    if (input.crop_profiles) {
      next.crop_profiles = { ...current.crop_profiles };
      for (const [slaveId, profile] of Object.entries(input.crop_profiles)) {
        if (!/^slave-[1-9][0-9]*$/.test(slaveId)) continue;
        const values = ["temperature_min", "temperature_max", "humidity_min", "humidity_max"].map((key) => Number(profile[key]));
        if (!String(profile.crop || "").trim() || values.some((value) => !Number.isFinite(value))) throw Object.assign(new Error(`Invalid crop profile for ${slaveId}`), { status: 400 });
        next.crop_profiles[slaveId] = { crop: String(profile.crop).trim().slice(0, 60), temperature_min: values[0], temperature_max: values[1], humidity_min: values[2], humidity_max: values[3] };
      }
    }
    return saveSettings(next);
  }

  async function sendSecurity(event) {
    const label = event.ai_result?.label;
    if (!['human', 'animal'].includes(label)) return { sent: false, channel: null, skip_reason: "classification_nothing" };
    const category = label === "human" ? "SECURITY_HUMAN" : "SECURITY_ANIMAL";
    return sendCategory(category, `AGRIMIND SECURITY ALERT\n${label === "human" ? "Human" : "Animal"} detected at the farm. Confidence: ${event.ai_result.confidence || 0}%. Check the Agrimind app.`, { event_id: event.event_id });
  }
  async function evaluateReading(reading) {
    const profile = settings().crop_profiles[reading.slave_id];
    if (!profile || reading.sensor_on === false) return { sent: false, skip_reason: profile ? "sensor_off" : "crop_profile_missing" };
    const temperatureIssues = [];
    const humidityIssues = [];
    if (reading.temperature_c < profile.temperature_min) temperatureIssues.push("temperature too low");
    if (reading.temperature_c > profile.temperature_max) temperatureIssues.push("temperature too high");
    if (reading.humidity_percent < profile.humidity_min) humidityIssues.push("humidity too low");
    if (reading.humidity_percent > profile.humidity_max) humidityIssues.push("humidity too high");
    if (!temperatureIssues.length || !humidityIssues.length) return { sent: false, skip_reason: "reading_normal" };
    const issues = [...temperatureIssues, ...humidityIssues];
    return sendCategory("PLANT_ABNORMAL", `AGRIMIND PLANT ALERT\n${reading.display_name || reading.slave_id} (${profile.crop}): ${issues.join(", ")}. Temp ${reading.temperature_c}C, humidity ${reading.humidity_percent}%. Check crops and irrigation.`, { slave_id: reading.slave_id, crop: profile.crop, issues }, { queueOnCooldown: true, queueOnFailure: true, queueKey: reading.slave_id });
  }
  async function evaluateWeather(weather, { daily = false } = {}) {
    if (!weather || !["ready", "stale"].includes(weather.status)) return [];
    const results = [];
    const today = weather.daily?.[0] || {};
    if (daily) results.push(await sendCategory("DAILY_WEATHER", "AGRIMIND DAILY FORECAST ADVISORY\nSUMMARY: " + dailyForecastSummary(today.condition) + " | Lugar: " + weather.location_name, { forecast_date: today.date }));
    if (Number(weather.apparent_temperature_c) >= config.semaphore.heatIndexThresholdC) results.push(await sendCategory("HEAT_INDEX_HIGH", "AGRIMIND EXTREME HEAT ADVISORY\nHEAT INDEX: " + Math.round(weather.apparent_temperature_c) + "C\nLugar: " + weather.location_name, { apparent_temperature_c: weather.apparent_temperature_c }));
    if (Number(today.rain_probability_percent) >= config.semaphore.rainProbabilityThreshold || Number(today.precipitation_sum_mm) >= config.semaphore.rainMmThreshold) results.push(await sendCategory("RAIN_FORECAST_HIGH", "AGRIMIND RAIN FORECAST ADVISORY\nCHANCE OF RAIN: " + Math.round(today.rain_probability_percent || 0) + "% (" + rainForecastLabel(today.rain_probability_percent) + ") | Lugar: " + weather.location_name, { forecast_date: today.date }));
    return results;
  }
  function start({ weather, slaveStore }) {
    let lastDailyDay = null;
    let lastBalanceCheckAt = 0;
    async function tick() {
      try {
        const now = new Date();
        const time = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
        const day = localDay(now);
        const snapshot = await weather.refresh();
        const dailyDue = config.semaphore.dailyWeatherEnabled && time === config.semaphore.dailyWeatherTime && lastDailyDay !== day;
        if (dailyDue) lastDailyDay = day;
        await evaluateWeather(snapshot, { daily: dailyDue });
        if (config.semaphore.enabled && Date.now() - lastBalanceCheckAt >= 60 * 60 * 1000) {
          lastBalanceCheckAt = Date.now();
          const account = balance();
          if (Number.isFinite(account.credit_balance) && account.credit_balance <= config.semaphore.lowBalanceCredits) {
            await sendCategory("SYSTEM_LOW_SMS_BALANCE", `AGRIMIND SYSTEM ALERT\nYour Agrimind SMS balance is low: ${account.credit_balance} of ${account.credit_limit} credits remaining. Contact provider to add more limit.`, { credit_balance: account.credit_balance, credit_limit: account.credit_limit, low_balance_threshold: config.semaphore.lowBalanceCredits });
          }
        }
        for (const reading of slaveStore.list()) {
          if (reading.received_at && Date.now() - new Date(reading.received_at) >= config.semaphore.sensorOfflineMs) {
            await sendCategory("SYSTEM_SENSOR_OFFLINE", `AGRIMIND SENSOR ALERT\n${reading.display_name || reading.slave_id} has been offline for more than ${Math.round(config.semaphore.sensorOfflineMs / 60000)} minutes. Check its power and Wi-Fi.`, { slave_id: reading.slave_id });
          }
        }
      } catch (error) { console.error("SMS automation:", error.message); }
    }
    tick();
    timer = setInterval(tick, 60_000); timer.unref?.();
    void processQueue();
    queueTimer = setInterval(processQueue, 5_000); queueTimer.unref?.();
  }
  function stop() { if (timer) clearInterval(timer); if (queueTimer) clearInterval(queueTimer); timer = null; queueTimer = null; }
  function status() { const current = settings(); return { enabled: config.semaphore.enabled, sms_alerts_enabled: current.sms_alerts_enabled, configured: Boolean(config.semaphore.apiKey && current.recipients.length), recipients: current.recipients.map(maskNumber), sender_name: config.semaphore.senderName || null, project_balance: balance(), queued_alerts: queuedAlerts().length, ...gate("TEST_SMS", { force: true }) }; }

  return { balance, evaluateReading, evaluateWeather, history: (limit = 50) => history().slice(-limit).reverse(), recipients: () => settings().recipients, rules: settings, send: sendSecurity, sendCategory, start, status, stop, updateRecipients, updateRules };
}

module.exports = { CATEGORIES, createSemaphoreSms, normalizeNumber };
