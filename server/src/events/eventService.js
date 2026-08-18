const { eventId } = require("../utils/ids");
const { publicImage } = require("../utils/files");
const { selectBestImage } = require("../hardware/camera");
const { fingerprint, hammingDistance } = require("../ai/imageFingerprint");

function createEventService({ config, store, camera, classifier, alerts, cloudSync, realtime, state }) {
  async function finalize(event) {
    const completed = store.save(event);
    realtime.broadcast("event_completed", { event: sanitize(completed) });
    event.cloud_sync = await cloudSync.sync(event);
    return store.save(event);
  }

  async function analyze(event, forceManual = false) {
    if (!event.best_image?.path && event.best_image?.filename) event.best_image.path = require("path").join(config.capturesDir, event.best_image.filename);
    if (!forceManual && config.analysisMode !== "automatic_analysis") {
      event.status = config.analysisMode === "manual_analysis" ? "captured_pending_manual_analysis" : "captured_only";
      event.ai_skip_reason = config.analysisMode;
      return store.save(event);
    }
    let result;
    try {
      result = await classifier.classify(event.best_image.path, event.event_id, event.timestamp);
    } catch (error) {
      event.status = "analysis_failed";
      event.ai_error = error.message;
      store.save(event);
      throw error;
    }
    if (result.skipped) {
      event.status = "captured_not_analyzed";
      event.ai_skip_reason = result.reason;
      return store.save(event);
    }
    event.ai_result = result;
    event.status = "analyzed";
    if (["human", "animal"].includes(result.label)) {
      try { event.alert = await alerts.send(event); } catch (error) { event.alert = { sent: false, channel: "sms", error: error.message }; }
    } else event.alert = { sent: false, channel: null, skip_reason: "classification_nothing" };
    return store.save(event);
  }

  async function capture(trigger) {
    if (state.isCapturing) return null;
    state.isCapturing = true;
    try {
      const id = eventId();
      const triggeredAt = new Date();
      console.log(`Capture started: ${id} (${trigger})`);
      realtime.broadcast("capture_started", { event_id: id, trigger });
      const images = await camera.captureBurst(id);
      const best = selectBestImage(images);
      let hash = null;
      try { if (best.path.endsWith(".jpg")) hash = await fingerprint(best.path); } catch (error) { console.warn("Fingerprint skipped:", error.message); }
      const latest = store.latest();
      const duplicateDistance = hash && latest?.image_fingerprint ? hammingDistance(hash, latest.image_fingerprint) : null;
      const duplicate = Boolean(config.duplicate.enabled && latest && Date.now() - new Date(latest.timestamp).getTime() < config.duplicate.windowMs && duplicateDistance <= config.duplicate.maxHammingDistance);
      const event = {
        event_id: id, timestamp: triggeredAt.toISOString(), trigger, mode: config.mode,
        capture_cooldown_seconds: Math.max(config.pir.cooldownMs, config.pir.groupingMs) / 1000,
        next_capture_at: new Date(triggeredAt.getTime() + Math.max(config.pir.cooldownMs, config.pir.groupingMs)).toISOString(),
        camera_device: config.camera.device, resolution: config.camera.resolution,
        best_image: best, captured_images: images, image_fingerprint: hash,
        duplicate: duplicate ? { of_event_id: latest.event_id, hamming_distance: duplicateDistance } : null,
        ai_result: null, alert: { sent: false, channel: null }, status: duplicate ? "captured_duplicate" : "captured",
      };
      store.save(event);
      if (duplicate) {
        event.ai_skip_reason = "duplicate_image";
        if (latest.ai_result) {
          event.ai_result = { ...latest.ai_result, reused_from_event_id: latest.event_id };
          event.status = "duplicate_reused_analysis";
        }
        const saved = store.save(event);
        console.log(`Event saved: ${id} status=${saved.status} duplicate_of=${latest.event_id}`);
        return finalize(saved);
      }
      let saved;
      try {
        saved = await analyze(event, false);
      } catch (error) {
        saved = store.get(id) || event;
        console.error(`Analysis failed for ${id}:`, error.message);
      }
      console.log(`Event saved: ${id} status=${saved.status} frames=${images.length} best=${best.filename}`);
      return finalize(saved);
    } finally { state.isCapturing = false; }
  }

  async function analyzeById(id) {
    const event = store.get(id);
    if (!event) return null;
    if (event.ai_result) return event;
    const analyzed = await analyze(event, true);
    return finalize(analyzed);
  }

  function sanitize(event) {
    if (!event) return null;
    const sanitizeImage = (image) => {
      const safe = publicImage(image);
      if (!safe) return null;
      if (store.existsImage(safe.filename)) return { ...safe, available: true };
      return { ...safe, url: null, available: false, expired: true };
    };
    return { ...event, best_image: sanitizeImage(event.best_image), captured_images: (event.captured_images || []).map(sanitizeImage) };
  }
  return { capture, analyzeById, sanitize };
}
module.exports = { createEventService };
