const fs = require("fs");

function createCloudSync(config) {
  async function sync(event) {
    if (!config.cloud.enabled) return { synced: false, skipped: true, reason: "cloud_sync_disabled" };
    if (!config.cloud.baseUrl || !config.cloud.deviceToken) {
      return { synced: false, skipped: true, reason: "cloud_sync_not_configured" };
    }
    if (!event.best_image?.path || !fs.existsSync(event.best_image.path)) {
      return { synced: false, skipped: true, reason: "capture_unavailable" };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.cloud.timeoutMs);
    try {
      const image = fs.readFileSync(event.best_image.path);
      const payload = {
        device_id: config.cloud.deviceId,
        event: {
          event_id: event.event_id,
          timestamp: event.timestamp,
          trigger: event.trigger,
          status: event.status,
          duplicate: event.duplicate,
          ai_result: event.ai_result,
          alert: event.alert,
        },
        image: {
          filename: event.best_image.filename,
          content_type: "image/jpeg",
          data_base64: image.toString("base64"),
        },
      };
      const response = await fetch(`${config.cloud.baseUrl}/api/device/events/latest`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Device-ID": config.cloud.deviceId,
          Authorization: `Bearer ${config.cloud.deviceToken}`,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || `Cloud HTTP ${response.status}`);
      return { synced: true, synced_at: new Date().toISOString() };
    } catch (error) {
      return {
        synced: false,
        failed_at: new Date().toISOString(),
        error: error.name === "AbortError" ? "cloud_sync_timeout" : error.message,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  function status() {
    return {
      enabled: config.cloud.enabled,
      configured: Boolean(config.cloud.baseUrl && config.cloud.deviceToken),
      device_id: config.cloud.deviceId,
      base_url: config.cloud.baseUrl || null,
    };
  }

  return { sync, status };
}

module.exports = { createCloudSync };
