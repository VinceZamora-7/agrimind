const { readJson, writeJsonAtomic } = require("../utils/files");

function sameUtcDay(timestamp, now) {
  return new Date(timestamp).toISOString().slice(0, 10) === now.toISOString().slice(0, 10);
}

function retryDetails(retryAt, now) {
  return {
    retry_after_seconds: Math.max(1, Math.ceil((retryAt.getTime() - now.getTime()) / 1000)),
    retry_at: retryAt.toISOString(),
  };
}

function createQuotaGate(config, usagePath) {
  function entries() { return readJson(usagePath, []).filter((item) => item && item.timestamp); }
  function check() {
    if (!config.gemini.enabled) return { allowed: false, reason: "gemini_disabled" };
    if (!config.gemini.apiKey) return { allowed: false, reason: "gemini_key_missing" };
    const now = new Date();
    const usage = entries();
    const successful = usage.filter((item) => item.status === "success");
    const daily = successful.filter((item) => sameUtcDay(item.timestamp, now));
    const hourly = successful.filter((item) => now - new Date(item.timestamp) < 3_600_000);
    const latest = successful.reduce((current, item) => !current || new Date(item.timestamp) > new Date(current.timestamp) ? item : current, null);
    if (latest && now - new Date(latest.timestamp) < config.gemini.minIntervalMs) {
      return { allowed: false, reason: "minimum_interval", ...retryDetails(new Date(new Date(latest.timestamp).getTime() + config.gemini.minIntervalMs), now) };
    }
    if (hourly.length >= config.gemini.maxPerHour) {
      const oldest = Math.min(...hourly.map((item) => new Date(item.timestamp).getTime()));
      return { allowed: false, reason: "hourly_quota", ...retryDetails(new Date(oldest + 3_600_000), now) };
    }
    const tomorrowUtc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
    if (daily.length >= config.gemini.maxPerDay) return { allowed: false, reason: "daily_quota", ...retryDetails(tomorrowUtc, now) };
    const estimatedSpend = daily.reduce((sum, item) => sum + Number(item.estimated_cost_usd || config.gemini.estimatedRequestUsd), 0);
    if (estimatedSpend + config.gemini.estimatedRequestUsd > config.gemini.dailyBudgetUsd) return { allowed: false, reason: "daily_budget", ...retryDetails(tomorrowUtc, now) };
    return { allowed: true, daily_requests: daily.length, hourly_requests: hourly.length, estimated_daily_cost_usd: estimatedSpend };
  }
  function record(entry) {
    const usage = entries();
    usage.push({ ...entry, timestamp: entry.timestamp || new Date().toISOString() });
    writeJsonAtomic(usagePath, usage.slice(-1000));
  }
  function status() {
    const result = check();
    return { enabled: config.gemini.enabled, configured: Boolean(config.gemini.apiKey), model: config.gemini.model, ...result };
  }
  return { check, record, status };
}
module.exports = { createQuotaGate };
