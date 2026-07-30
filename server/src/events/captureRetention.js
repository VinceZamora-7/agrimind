const fs = require("fs");
const path = require("path");

const CAPTURE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".svg"]);

function createCaptureRetention(config, state) {
  function cleanup(now = Date.now()) {
    const cutoff = now - config.retention.captureMs;
    let deleted = 0;
    let reclaimedBytes = 0;
    for (const filename of fs.readdirSync(config.capturesDir)) {
      if (!CAPTURE_EXTENSIONS.has(path.extname(filename).toLowerCase())) continue;
      const filePath = path.join(config.capturesDir, filename);
      const stat = fs.statSync(filePath);
      if (stat.mtimeMs >= cutoff) continue;
      fs.unlinkSync(filePath);
      deleted += 1;
      reclaimedBytes += stat.size;
    }
    state.retentionLastRun = new Date(now).toISOString();
    state.retentionDeletedFiles += deleted;
    state.retentionReclaimedBytes += reclaimedBytes;
    if (deleted) console.log(`Capture retention deleted ${deleted} file(s), reclaimed ${reclaimedBytes} bytes`);
    return { deleted, reclaimedBytes };
  }

  let timer = null;
  function start() {
    cleanup();
    timer = setInterval(() => {
      try { cleanup(); } catch (error) { console.error("Capture retention:", error.message); }
    }, config.retention.cleanupIntervalMs);
    timer.unref();
  }
  function stop() { if (timer) clearInterval(timer); }
  return { cleanup, start, stop };
}

module.exports = { createCaptureRetention };
