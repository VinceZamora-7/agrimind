const { readJson, writeJsonAtomic } = require("../utils/files");

const EXCLUDED_CATEGORIES = new Set(["HEAT_INDEX_HIGH", "RAIN_FORECAST_HIGH", "TEST_SMS"]);
const TITLES = {
  DAILY_WEATHER: "Agrimind Daily Weather",
  PLANT_ABNORMAL: "Plant Condition Alert",
  TYPHOON_POSSIBLE: "Severe Weather Alert",
  SECURITY_HUMAN: "Human Detected",
  SECURITY_ANIMAL: "Animal Detected",
  SYSTEM_LOW_SMS_BALANCE: "SMS Credit Alert",
  SYSTEM_SENSOR_OFFLINE: "Sensor Offline",
};

function notificationBody(message) {
  return String(message || "")
    .split("\n")
    .slice(1)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}

function createExpoPush({ config, pairing, historyPath }) {
  function history() { return readJson(historyPath, []).filter((item) => item?.timestamp); }
  function save(record) {
    const records = history();
    records.push(record);
    writeJsonAtomic(historyPath, records.slice(-500));
    return record;
  }
  function latestSent(category) {
    return history().filter((item) => item.category === category && item.sent).at(-1);
  }
  function cooldownMs(category) {
    return config.semaphore.categoryCooldownMs[category] ?? config.semaphore.minIntervalMs;
  }

  async function send(category, message, context = {}, { force = false, categoryEnabled = true } = {}) {
    if (EXCLUDED_CATEGORIES.has(category)) return { sent: false, skip_reason: "push_category_excluded" };
    if (!categoryEnabled) return { sent: false, skip_reason: "category_disabled" };
    const recipients = pairing.pushRecipients();
    if (!recipients.length) return { sent: false, skip_reason: "no_push_recipients" };
    if (!force) {
      const latest = latestSent(category);
      const remaining = latest ? cooldownMs(category) - (Date.now() - new Date(latest.timestamp).getTime()) : 0;
      if (remaining > 0) return { sent: false, skip_reason: "push_cooldown", retry_after_seconds: Math.ceil(remaining / 1000) };
    }
    const payload = recipients.map((recipient) => ({
      to: recipient.token,
      sound: "default",
      channelId: category.startsWith("SECURITY_") ? "security-alerts" : "farm-alerts",
      title: TITLES[category] || "Agrimind Alert",
      body: notificationBody(message),
      data: { category, ...context },
      priority: category.startsWith("SECURITY_") ? "high" : "default",
    }));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    const timestamp = new Date().toISOString();
    try {
      const response = await fetch("https://exp.host/--/api/v2/push/send", {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      const result = await response.json().catch(() => null);
      if (!response.ok) throw new Error(result?.errors?.[0]?.message || `Expo Push HTTP ${response.status}`);
      const tickets = Array.isArray(result?.data) ? result.data : [result?.data].filter(Boolean);
      const accepted = tickets.filter((ticket) => ticket?.status === "ok");
      const errors = tickets.filter((ticket) => ticket?.status === "error");
      const record = save({
        push_id: `push_${Date.now()}`, timestamp, category, sent: accepted.length > 0,
        recipient_count: recipients.length, accepted_count: accepted.length,
        ticket_ids: accepted.map((ticket) => ticket.id), errors: errors.map((ticket) => ticket.message),
        context,
      });
      return { sent: record.sent, recipient_count: recipients.length, accepted_count: accepted.length, errors: record.errors };
    } catch (error) {
      save({ push_id: `push_${Date.now()}`, timestamp, category, sent: false, recipient_count: recipients.length, error: error.name === "AbortError" ? "Expo Push request timed out" : error.message, context });
      throw error;
    } finally { clearTimeout(timer); }
  }

  return { history, send };
}

module.exports = { EXCLUDED_CATEGORIES, createExpoPush, notificationBody };
